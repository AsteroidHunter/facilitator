// Protocol tests for the ready-to-test marker route and its lifecycle, against a
// real throwaway board server (a copied server.py on an ephemeral loopback port,
// its own temp data and credentials, never the live board). Exercises eligibility,
// the desktop and phone snapshots, clearing on feedback / done, the op-receipt
// idempotency boundary, restart persistence, and that a mark touches nothing else.
// Also that the fold is ephemeral: a raised marker lowered by any path leaves the
// card as it would be had it never been folded, in both snapshots and on disk.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";

let child, fixtureDir, origin, port;

const { freePortPair } = require("./fixture-auth.cjs");
const settle = (ms = 25) => new Promise(r => setTimeout(r, ms));

async function post(route, body) {
  const r = await fetch(origin + route, { method: "POST", body: body ?? "" });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const state = async () => (await fetch(origin + "/state")).json();
const mstate = async () => (await fetch(origin + "/m/state")).json();
const boxOf = async id => (await state()).boxes.find(b => b.id === id);

async function startServer() {
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", c => { out += c; });
  child.stderr.on("data", c => { out += c; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited:\n" + out);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await settle();
  }
  throw new Error("server did not start:\n" + out);
}
async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(r => child.once("exit", r));
}
// drive a fresh card to the reader's turn (a completed reply, no live job)
async function makeYours(title) {
  const made = await post("/create?owner=facilitator", title);
  assert.equal(made.status, 200, "create");
  const id = made.body.id;
  const rep = await post("/reply?box=" + id, "delivered, please try it");
  assert.equal(rep.status, 200, "reply");
  assert.equal((await boxOf(id)).state, "yours", "card is awaiting the reader");
  return id;
}
// claim queued cards the real way (the agent's long poll hands out the claim)
// and answer them, draining older queued cards until the target is reached, so
// its pending message is consumed and it returns to the reader's turn
async function claimAndReply(id, text) {
  for (let i = 0; i < 12; i++) {
    const w = await fetch(origin + "/wait?owner=facilitator&timeout=3");
    const wj = await w.json();
    if (wj.idle) throw new Error("no queued card to claim for " + id);
    assert.equal((await post("/ack?owner=facilitator&token=" + encodeURIComponent(wj.ack))).status, 200);
    const rep = await post("/reply?box=" + wj.box, wj.box === id ? text : "drained");
    assert.equal(rep.status, 200, "reply after claim");
    if (wj.box === id) return;
  }
  throw new Error("target card " + id + " was never claimed");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-testmark-"));
  port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  let src = await readFile(path.join(ROOT, "server.py"), "utf8");
  src = src.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.ok(src.includes("FACILITATOR_TEST_PORT"), "port rebind anchor");
  await writeFile(path.join(fixtureDir, "server.py"), src);
  require(path.join(ROOT, "tests", "fixture-auth.cjs")).copyBridgeFiles(fixtureDir);
  await copyFile(path.join(ROOT, "m-manifest.json"), path.join(fixtureDir, "m-manifest.json"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Test-ready fixture",
    items: [{ id: "0", bucket: "meta", owner: "facilitator", title: "Standing meta" }],
  }));
  await startServer();
});
after(async () => { await stopServer(); if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true }); });

test("existing cards default to not-testing in both snapshots", async () => {
  const b = await boxOf("0");
  assert.equal(b.testing, false);
  const mb = (await mstate()).boxes.find(x => x.id === "0");
  assert.equal(mb.testing, false);
});

test("marking is refused on a card that is not awaiting the reader", async () => {
  const made = await post("/create?owner=facilitator", "Fresh card");
  const id = made.body.id;
  assert.equal((await boxOf(id)).state, "new");
  const r = await post("/testing?box=" + id + "&v=1");
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "card is not awaiting the reader");
  assert.equal((await boxOf(id)).testing, false, "nothing changed");
});

test("an awaiting-reader card can be marked, and both snapshots show it", async () => {
  const id = await makeYours("Ready card");
  const r = await post("/testing?box=" + id + "&v=1");
  assert.equal(r.status, 200);
  assert.equal(r.body.testing, true);
  assert.equal((await boxOf(id)).testing, true);
  assert.equal((await mstate()).boxes.find(x => x.id === id).testing, true);
});

test("re-marking an already-marked card changes no revision", async () => {
  const id = await makeYours("Idempotent mark");
  assert.equal((await post("/testing?box=" + id + "&v=1")).body.testing, true);
  const rev1 = (await state()).rev;
  const again = await post("/testing?box=" + id + "&v=1");
  assert.equal(again.body.unchanged, true);
  assert.equal((await state()).rev, rev1, "no revision bump for a no-op mark");
});

test("a mark touches only the flag: no reply, seen, move or turn change", async () => {
  const id = await makeYours("Untouched card");
  const before = await boxOf(id);
  assert.equal((await post("/testing?box=" + id + "&v=1")).body.testing, true);
  const after = await boxOf(id);
  assert.equal(after.testing, true);
  for (const k of ["replies", "seen", "ball", "state", "bucket", "done", "parked", "title", "pending"])
    assert.deepEqual(after[k], before[k], `mark changed ${k}`);
});

test("fresh feedback on the card clears the marker", async () => {
  const id = await makeYours("Feedback clears");
  await post("/testing?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, true);
  const sent = await post("/send?box=" + id + "&op=feedbackop01", "here is my feedback");
  assert.equal(sent.status, 200);
  assert.equal((await boxOf(id)).testing, false, "feedback lowered the marker");
});

test("a deduplicated retry of an accepted send does NOT clear a later fresh marker", async () => {
  const id = await makeYours("Dedup keeps mark");
  // first accepted send under op X clears any marker and commits its receipt
  await post("/testing?box=" + id + "&v=1");
  const first = await post("/send?box=" + id + "&op=dedupretry01", "feedback body");
  assert.equal(first.status, 200);
  assert.notEqual(first.body.replayed, true, "first send is fresh");
  assert.equal((await boxOf(id)).testing, false);
  // the agent claims that feedback, answers it, and re-marks: card is yours again
  await claimAndReply(id, "delivered again");
  assert.equal((await boxOf(id)).state, "yours");
  await post("/testing?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, true);
  // the SAME op with the SAME payload replays and must not touch the fresh marker
  const retry = await post("/send?box=" + id + "&op=dedupretry01", "feedback body");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true, "retry is a replay");
  assert.equal((await boxOf(id)).testing, true, "the fresh marker survived the replay");
});

test("marking done clears the marker; v=0 clears safely too", async () => {
  const id = await makeYours("Done clears");
  await post("/testing?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, true);
  await post("/done?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, false);
  await post("/done?box=" + id + "&v=0");   // undone, still not testing
  const cleared = await post("/testing?box=" + id + "&v=0");
  assert.equal(cleared.body.testing, false);
});

// the cross, backspace and the done keys on every page post /close, never /done,
// so this is the path by which marking a folded card done unfolds it
test("closing a marked card marks it done and clears the marker in both snapshots", async () => {
  const id = await makeYours("Close clears");
  await post("/testing?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, true);
  assert.equal((await post("/close?box=" + id)).status, 200);
  const closed = await boxOf(id);
  assert.equal(closed.done, true, "a card with a reply is marked done, not removed");
  assert.equal(closed.testing, false, "closing lowered the marker");
  assert.equal((await mstate()).boxes.find(x => x.id === id).testing, false);
  await post("/done?box=" + id + "&v=0");   // back to doing, and still not marked
  assert.equal((await boxOf(id)).testing, false);
});

test("an unknown card is refused", async () => {
  const r = await post("/testing?box=no-such-box&v=1");
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "bad box");
});

test("active work, queued feedback, held claims and done cards cannot be marked", async () => {
  const id = await makeYours("Eligibility boundaries");
  await post("/working?box=" + id + "&v=1");
  assert.equal((await post("/testing?box=" + id + "&v=1")).status, 409);
  await post("/working?box=" + id + "&v=0");
  await post("/send?box=" + id, "another pass");
  assert.equal((await post("/testing?box=" + id + "&v=1")).status, 409);
  const claim = await (await fetch(origin + "/wait?owner=facilitator&timeout=3")).json();
  assert.equal(claim.box, id);
  assert.equal((await post("/ack?owner=facilitator&token=" + encodeURIComponent(claim.ack))).status, 200);
  assert.equal((await post("/testing?box=" + id + "&v=1")).status, 409);
  assert.equal((await state()).busy.facilitator, id, "refusal preserves the claim");
  await post("/reply?box=" + id, "finished again");
  await post("/done?box=" + id + "&v=1");
  assert.equal((await post("/testing?box=" + id + "&v=1")).status, 409);
  assert.equal((await boxOf(id)).testing, false);
});

test("the marker survives a server restart", async () => {
  const id = await makeYours("Persistent mark");
  await post("/testing?box=" + id + "&v=1");
  assert.equal((await boxOf(id)).testing, true);
  const saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
  assert.equal(saved.boxes.find(b => b.id === id).testing, true, "written to disk");
  await stopServer();
  await startServer();
  assert.equal((await boxOf(id)).testing, true, "restored after restart");
});


test("a shelved awaiting-reader card can be marked and survives restart", async () => {
  const id = await makeYours("Shelved acceptance check");
  assert.equal((await post("/park?box=" + id + "&v=1")).status, 200);
  const before = await boxOf(id);
  assert.equal(before.parked, true);
  assert.equal((await post("/testing?box=" + id + "&v=1")).status, 200);
  const marked = await boxOf(id);
  assert.equal(marked.testing, true);
  for (const key of ["parked", "state", "bucket", "turnTs", "replies", "seen"])
    assert.deepEqual(marked[key], before[key], `mark changed ${key}`);
  await stopServer();
  await startServer();
  const restored = await boxOf(id);
  assert.equal(restored.parked, true);
  assert.equal(restored.testing, true);
  assert.equal((await mstate()).boxes.find(b => b.id === id).testing, true);
});

// ---- the fold leaves nothing behind -------------------------------------------
// the marker is the fold's whole state, so a card whose marker is lowered reads
// as it would had the fold never gone up: the desktop snapshot, the phone's and
// the saved card alike
const both = async id => [await boxOf(id), (await mstate()).boxes.find(b => b.id === id)];
const saved = async () => JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
const onDisk = async id => (await saved()).boxes.find(b => b.id === id);
const views = async id => [...(await both(id)), await onDisk(id)];
const fieldsOf = async id => (await views(id)).map(b => Object.keys(b).sort());
// the fields that differ between two readings of one card
const changed = (was, now) => Object.keys({ ...was, ...now })
  .filter(k => JSON.stringify(was[k]) !== JSON.stringify(now[k])).sort();

test("unfolding leaves the card exactly as it was before the fold went up", async () => {
  const id = await makeYours("Unfold me");
  const unmarked = await both(id), unmarkedOnDisk = await onDisk(id);
  await post("/testing?box=" + id + "&v=1");
  for (const b of await both(id)) assert.equal(b.testing, true);
  const r = await post("/testing?box=" + id + "&v=0");
  assert.equal(r.status, 200);
  assert.equal(r.body.testing, false);
  assert.deepEqual(await both(id), unmarked, "a snapshot kept something of the fold");
  assert.deepEqual(await onDisk(id), unmarkedOnDisk, "the saved card kept something of the fold");
  // a second lowering is no change at all
  const rev = (await state()).rev;
  assert.equal((await post("/testing?box=" + id + "&v=0")).body.unchanged, true);
  assert.equal((await state()).rev, rev);
});

test("feedback, done and close each lower the marker and leave nothing of the fold", async () => {
  // each path taken twice, on a folded card and on one never folded: from
  // before the fold went up, the two must end with the same fields changed, in
  // both snapshots and on disk
  const paths = {
    feedback: id => post("/send?box=" + id, "tried it, one more thing"),
    done: id => post("/done?box=" + id + "&v=1"),
    close: id => post("/close?box=" + id),
  };
  for (const [how, take] of Object.entries(paths)) {
    const folded = await makeYours(how + " while folded"), plain = await makeYours(how + " never folded");
    const was = { folded: await views(folded), plain: await views(plain) };
    await post("/testing?box=" + folded + "&v=1");
    await take(folded);
    await take(plain);
    const now = { folded: await views(folded), plain: await views(plain) };
    for (const b of now.folded) assert.equal(b.testing, false, `${how} left the marker up`);
    now.folded.forEach((b, i) => assert.deepEqual(changed(was.folded[i], b), changed(was.plain[i], now.plain[i]),
      `${how} left something of the fold behind`));
  }
});

test("a board saved with the retired crease flag loads cleanly and drops it", async () => {
  const kept = await makeYours("Saved creased");
  const board = await saved();
  // the flag as the crease wrote it, on every card, and raised on one
  for (const b of board.boxes) b.creased = b.id === kept;
  await stopServer();
  await writeFile(path.join(fixtureDir, "state.json"), JSON.stringify(board));
  await startServer();
  const plain = await makeYours("Made after the load");
  assert.deepEqual((await fieldsOf(kept)).slice(0, 2), (await fieldsOf(plain)).slice(0, 2),
    "a snapshot carries the retired flag");
  // the next save writes the board without it
  assert.equal((await post("/testing?box=" + kept + "&v=1")).status, 200);
  for (const b of (await saved()).boxes) assert.ok(!("creased" in b), `card ${b.id} was saved with the retired flag`);
  await post("/testing?box=" + kept + "&v=0");
  assert.deepEqual(await fieldsOf(kept), await fieldsOf(plain), "the loaded card differs from a fresh one");
});
