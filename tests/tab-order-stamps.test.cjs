// When a card was deferred and when it was marked done, kept by the board.
//
// The Deferred tab lists cards by when each was deferred and the Done tab by
// when each was marked done, most recent first, so the board stamps a card the
// moment either happens (parked_ts and done_ts in state.json, parkedTs and
// doneTs on the wire), drops the stamp when the card leaves that section, and
// sends both on the desktop reading and on the phone's whole and lean readings.
// Cards saved before the board stamped them are filled once at start from the
// latest park or done row the transcript holds for the card, else from the
// card's own ts, and a start never touches a stamp that is already there.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { appendFile, copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

let child, fixtureDir, origin, port, serverOutput = "";

async function get(route) {
  const response = await fetch(origin + route);
  return { status: response.status, body: await response.json() };
}

async function post(route, body = "") {
  const response = await fetch(origin + route, { method: "POST", body });
  const answer = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(answer)}`);
  return answer;
}

async function startServer() {
  serverOutput = "";
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { serverOutput += chunk; });
  child.stderr.on("data", chunk => { serverOutput += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${serverOutput}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await pause(25);
  }
  throw new Error(`fixture server did not start:\n${serverOutput}`);
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

const statePath = () => path.join(fixtureDir, "state.json");
const transcriptPath = () => path.join(fixtureDir, "transcript.jsonl");
const readState = async () => JSON.parse(await readFile(statePath(), "utf8"));
const writeState = state => writeFile(statePath(), JSON.stringify(state, null, 1));
const readTranscript = async () =>
  (await readFile(transcriptPath(), "utf8")).trim().split("\n").map(line => JSON.parse(line));

const make = async title => (await post("/create?owner=facilitator", title)).id;
const desk = async id => (await get("/state")).body.boxes.find(b => b.id === id);
const phone = async id => (await get("/m/state?since=")).body.boxes.find(b => b.id === id);
const saved = async id => (await readState()).boxes.find(b => b.id === id);

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tab-stamps-"));
  port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["index.html", "manifest.json", "sw.js", "card-markdown.js", "card-tokens.css", "card-logic.js",
                      "card-report.js", "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "tab stamps",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "" }],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a card is stamped when it is deferred and when it is marked done, on every reading", async () => {
  const deferred = [await make("Deferred one"), await make("Deferred two"), await make("Deferred three")];
  const done = [await make("Done one"), await make("Done two"), await make("Done three")];
  const open = await make("Still open");
  const before = Date.now() / 1000;
  for (const id of deferred) { await post(`/park?box=${id}&v=1`); await pause(15); }
  for (const id of done) { await post(`/done?box=${id}&v=1`); await pause(15); }
  const after = Date.now() / 1000;

  for (const read of [desk, phone]) {
    const name = read === desk ? "the desktop reading" : "the phone's reading";
    const stamps = [];
    for (const id of deferred) {
      const card = await read(id);
      assert.equal(card.parked, true, `${name}: ${id} is deferred`);
      assert.ok(card.parkedTs >= before && card.parkedTs <= after, `${name}: ${id} parkedTs ${card.parkedTs} is not the time it was deferred`);
      assert.equal(card.doneTs, 0, `${name}: a deferred card carries a doneTs`);
      stamps.push(card.parkedTs);
    }
    assert.ok(stamps[0] < stamps[1] && stamps[1] < stamps[2], `${name}: parkedTs does not follow the order the cards were deferred in`);
    const closed = [];
    for (const id of done) {
      const card = await read(id);
      assert.equal(card.done, true, `${name}: ${id} is done`);
      assert.ok(card.doneTs >= before && card.doneTs <= after, `${name}: ${id} doneTs ${card.doneTs} is not the time it was marked done`);
      assert.equal(card.parkedTs, 0, `${name}: a done card carries a parkedTs`);
      closed.push(card.doneTs);
    }
    assert.ok(closed[0] < closed[1] && closed[1] < closed[2], `${name}: doneTs does not follow the order the cards were marked done in`);
    const idle = await read(open);
    assert.deepEqual([idle.parkedTs, idle.doneTs], [0, 0], `${name}: a card in neither section carries a stamp`);
  }
  assert.deepEqual((await desk(deferred[1])).parkedTs, (await phone(deferred[1])).parkedTs,
    "the two readings disagree about when a card was deferred");

  // the stamp sits on the card in state.json too, and only on a card that is in the section
  const file = await readState();
  for (const id of deferred) assert.equal(file.boxes.find(b => b.id === id).parked_ts, (await desk(id)).parkedTs);
  for (const id of done) assert.equal(file.boxes.find(b => b.id === id).done_ts, (await desk(id)).doneTs);
  const idle = file.boxes.find(b => b.id === open);
  assert.ok(!("parked_ts" in idle) && !("done_ts" in idle), "a card in neither section was stamped");

  // and each stamp is the time of the transcript row the same move wrote
  const rows = await readTranscript();
  for (const id of deferred) {
    const row = rows.filter(r => r.kind === "park" && r.box === id).pop();
    assert.ok(Math.abs(row.ts - (await desk(id)).parkedTs) < 1, `${id}: the stamp and the park row are far apart`);
  }
  for (const id of done) {
    const row = rows.filter(r => r.kind === "done" && r.box === id).pop();
    assert.ok(Math.abs(row.ts - (await desk(id)).doneTs) < 1, `${id}: the stamp and the done row are far apart`);
  }
});

test("a stamp follows its flag: dropped when the card leaves, new when it comes back, kept when asked twice", async () => {
  const a = await make("Moves a");
  const b = await make("Moves b");
  const c = await make("Moves c");
  await post(`/park?box=${a}&v=1`); await pause(15);
  await post(`/park?box=${b}&v=1`); await pause(15);
  const first = (await desk(a)).parkedTs;
  const second = (await desk(b)).parkedTs;
  assert.ok(first < second);

  // asked again while it stands deferred: the same stamp, not a new one
  await post(`/park?box=${a}&v=1`);
  assert.equal((await desk(a)).parkedTs, first, "deferring a deferred card moved it");

  // undeferred: the stamp goes; deferred again: a new one, later than every other
  await post(`/park?box=${a}&v=0`);
  const gone = await desk(a);
  assert.equal(gone.parked, false);
  assert.equal(gone.parkedTs, 0, "an undeferred card kept its parkedTs");
  assert.ok(!("parked_ts" in await saved(a)), "an undeferred card kept parked_ts in state.json");
  await pause(15);
  await post(`/park?box=${a}&v=1`);
  const again = (await desk(a)).parkedTs;
  assert.ok(again > second, "a card deferred a second time did not take a later stamp");

  // done and deferred are one move apart: each takes its own stamp and drops the other
  await post(`/done?box=${a}&v=1`);
  let card = await desk(a);
  assert.equal(card.parkedTs, 0, "marking a deferred card done left its parkedTs");
  assert.ok(card.doneTs >= again, "marking a card done did not stamp it");
  const closedAt = card.doneTs;
  await post(`/done?box=${a}&v=1`);
  assert.equal((await desk(a)).doneTs, closedAt, "marking a done card done moved it");
  await pause(15);
  await post(`/park?box=${a}&v=1`);
  card = await desk(a);
  assert.equal(card.done, false);
  assert.equal(card.doneTs, 0, "deferring a done card left its doneTs");
  assert.ok(card.parkedTs > closedAt);

  // undone: the stamp goes
  await post(`/done?box=${c}&v=1`);
  assert.ok((await desk(c)).doneTs > 0);
  await post(`/done?box=${c}&v=0`);
  assert.equal((await desk(c)).doneTs, 0, "an undone card kept its doneTs");
  assert.ok(!("done_ts" in await saved(c)), "an undone card kept done_ts in state.json");

  // a message to a deferred card brings it back to Doing, so it leaves Deferred
  await post(`/send?box=${b}`, "A message to a deferred card.");
  card = await desk(b);
  assert.equal(card.parked, false);
  assert.equal(card.parkedTs, 0, "a card brought back by a message kept its parkedTs");
  assert.ok(!("parked_ts" in await saved(b)));

  // closing a card that holds a conversation marks it done, and stamps it
  const closing = await make("Closed with words");
  await post(`/send?box=${closing}`, "Something to keep.");
  assert.equal((await post(`/close?box=${closing}`)).action, "done");
  assert.ok((await desk(closing)).doneTs > 0, "a closed card was not stamped");
  assert.ok((await phone(closing)).doneTs > 0, "a closed card was not stamped on the phone's reading");
});

test("the phone's lean reading carries the stamp of a card that changed", async () => {
  const id = await make("Read lean");
  const held = (await get("/m/state?since=")).body;
  assert.ok(held.epoch, "the whole reading names its run");
  await post(`/park?box=${id}&v=1`);
  const lean = (await get(`/m/state?since=${held.rev}&delta=${held.epoch}`)).body;
  assert.equal(lean.delta, held.rev, "the reading was not lean");
  const card = lean.boxes.find(b => b.id === id);
  assert.ok(card, "the changed card was not in the lean reading");
  assert.ok(card.parkedTs > 0, "the lean reading left out parkedTs");
  const parkedAt = card.parkedTs;

  const next = (await get(`/m/state?since=${lean.rev}`)).body;
  await post(`/park?box=${id}&v=0`);
  await post(`/done?box=${id}&v=1`);
  const later = (await get(`/m/state?since=${next.rev}&delta=${next.epoch}`)).body;
  const moved = later.boxes.find(b => b.id === id);
  assert.deepEqual([moved.parkedTs, moved.done], [0, true]);
  assert.ok(moved.doneTs >= parkedAt, "the lean reading left out doneTs");
});

// ---- cards saved before the board stamped them ----------------------------------------
const STAMPS = ["parked_ts", "done_ts"];
const withoutStamps = state => {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.rev;
  for (const box of copy.boxes) for (const key of STAMPS) delete box[key];
  return copy;
};
const withoutRev = state => { const copy = JSON.parse(JSON.stringify(state)); delete copy.rev; return copy; };

test("a board saved before the stamps is filled once from its transcript, and a start never moves a stamp", async () => {
  const names = ["P1", "P2", "D1", "D2", "PX", "DX", "C1", "C2", "O"];
  const id = {};
  for (const name of names) id[name] = await make("Backfill " + name);

  // one start first, so the defaults the board adds to a new card on its next start are already
  // in the file and the comparison below sees only what the fill does
  await stopServer();
  await startServer();
  await stopServer();
  const old = await readState();
  const flags = {
    P1: { parked: true }, P2: { parked: true }, D1: { done: true }, D2: { done: true },
    PX: { parked: true }, DX: { done: true }, C1: { parked: true }, C2: { done: true }, O: {},
  };
  names.forEach((name, n) => {
    const box = old.boxes.find(b => b.id === id[name]);
    Object.assign(box, { parked: false, done: false }, flags[name]);
    box.ts = 900.5 + n;
    for (const key of STAMPS) delete box[key];
  });
  await writeState(old);

  // what the transcript holds: P1 was deferred twice (the later row stands), P2 deferred,
  // let go and deferred again, D2 closed, reopened and closed again. PX and DX have no row at
  // all. C1 is deferred but only has a done row, and C2 is done but only has a park row, so a row
  // of the other kind must not stand in. The rest is noise a reader has to step over
  const rows = [
    { ts: 500, kind: "park", box: id.P1, text: "" },
    { ts: 1000.25, kind: "park", box: id.P1, text: "" },
    { ts: 2000, kind: "park", box: id.P2, text: "" },
    { ts: 2100, kind: "unpark", box: id.P2, text: "" },
    { ts: 3000.5, kind: "park", box: id.P2, text: "" },
    { ts: 4000, kind: "done", box: id.D1, text: "" },
    { ts: 5000, kind: "done", box: id.D2, text: "" },
    { ts: 5100, kind: "undone", box: id.D2, text: "" },
    { ts: 6000.75, kind: "done", box: id.D2, text: "" },
    { ts: 7000, kind: "done", box: id.C1, text: "" },
    { ts: 7100, kind: "park", box: id.C2, text: "" },
    { ts: "late", kind: "park", box: id.PX, text: "" },
    { kind: "done", box: id.DX, text: "" },
  ];
  await appendFile(transcriptPath(), "this line is not json\n" + rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  const transcriptBefore = await readFile(transcriptPath(), "utf8");
  const before = withoutStamps(old);

  await startServer();
  const first = await readState();
  const want = {
    P1: ["parked_ts", 1000.25], P2: ["parked_ts", 3000.5], D1: ["done_ts", 4000], D2: ["done_ts", 6000.75],
    PX: ["parked_ts", 900.5 + 4], DX: ["done_ts", 900.5 + 5], C1: ["parked_ts", 900.5 + 6], C2: ["done_ts", 900.5 + 7],
  };
  for (const [name, [key, time]] of Object.entries(want)) {
    const box = first.boxes.find(b => b.id === id[name]);
    assert.equal(box[key], time, `${name}: ${key}`);
    const other = STAMPS.find(k => k !== key);
    assert.ok(!(other in box), `${name} was given a ${other} it has no flag for`);
  }
  const plain = first.boxes.find(b => b.id === id.O);
  assert.ok(!STAMPS.some(k => k in plain), "a card in neither section was stamped");

  // the stamps are what the readings send
  assert.equal((await desk(id.P2)).parkedTs, 3000.5);
  assert.equal((await phone(id.D2)).doneTs, 6000.75);

  // the fill changed nothing else in the state and wrote nothing to the transcript
  assert.deepEqual(withoutStamps(first), before, "the fill changed something other than the stamps");
  assert.equal(await readFile(transcriptPath(), "utf8"), transcriptBefore, "the fill wrote to the transcript");

  // a second start changes nothing, even with newer rows in the transcript
  await stopServer();
  await appendFile(transcriptPath(), JSON.stringify({ ts: 9000, kind: "park", box: id.P2, text: "" }) + "\n");
  await startServer();
  assert.deepEqual(withoutRev(await readState()), withoutRev(first), "a second start changed the state");

  // only a missing stamp is filled: with one gone, it takes the latest row and the others stay
  await stopServer();
  const partial = await readState();
  delete partial.boxes.find(b => b.id === id.P2).parked_ts;
  await writeState(partial);
  await startServer();
  const third = await readState();
  assert.equal(third.boxes.find(b => b.id === id.P2).parked_ts, 9000, "the missing stamp was not filled from the latest row");
  for (const name of ["P1", "D1", "D2", "PX", "DX", "C1", "C2"]) {
    const [key, time] = want[name];
    assert.equal(third.boxes.find(b => b.id === id[name])[key], time, `${name} was refilled`);
  }
});

test("a board with no transcript at all falls back to each card's own ts", async () => {
  await stopServer();
  const state = await readState();
  const parked = state.boxes.find(b => b.title === "Backfill PX");
  const closed = state.boxes.find(b => b.title === "Backfill DX");
  for (const box of [parked, closed]) for (const key of STAMPS) delete box[key];
  parked.ts = 111.5;
  closed.ts = 222.5;
  await writeState(state);
  await rm(transcriptPath(), { force: true });
  await startServer();
  const after = await readState();
  assert.equal(after.boxes.find(b => b.id === parked.id).parked_ts, 111.5);
  assert.equal(after.boxes.find(b => b.id === closed.id).done_ts, 222.5);
});
