// A command that names an operation id lands once. The receipt is written in
// the same rename as the effect, so a retry after a lost reply, a burst of the
// same id at once, a restart in between, all answer the first try's result and
// change nothing; the same id under other words is refused; a receipt past its
// window is forgotten and the board says so. Callers that name no id, the
// desktop and the agents, land exactly as they always did. The fixture's
// retention and receipt count are patched down so the suite runs in seconds.
// The suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const net = require("node:net");
const { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const RETENTION_S = 4;      // OP_RETENTION in this fixture
const EVICT_FLOOR_S = 1.2;  // OP_EVICT_FLOOR in this fixture: a receipt younger than this is never count-evicted
const KEEP = 5;             // OP_KEEP in this fixture

let outer;
let app;
let port;
let origin;
let child;

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const chosen = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return chosen;
}

function patch(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `fixture patch did not apply: ${from}`);
  return out;
}

async function startServer() {
  child = spawn("python3", [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 8000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function post(route, body) {
  return api(route, { method: "POST", body });
}

async function state() {
  return (await api("/state")).body;
}

async function pendingOn(id) {
  return (await state()).boxes.find(b => b.id === id).pendingTexts;
}

async function stateFile() {
  return JSON.parse(await readFile(path.join(app, "state.json"), "utf8"));
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-ops-"));
  app = path.join(outer, "app");
  await mkdir(app);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "OP_RETENTION = 7 * 86400", `OP_RETENTION = ${RETENTION_S}`);
  source = patch(source, "OP_EVICT_FLOOR = 2 * 86400", `OP_EVICT_FLOOR = ${EVICT_FLOOR_S}`);
  source = patch(source, "OP_KEEP = 4000", `OP_KEEP = ${KEEP}`);
  await writeFile(path.join(app, "server.py"), source);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "operations fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a send sent twice under one id lands once and answers the same result", async () => {
  const first = await post("/send?box=0&op=send-twice-0001", "the same words");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(typeof first.body.mid, "number");
  assert.equal(typeof first.body.rev, "number");
  assert.equal(first.body.replayed, undefined);
  const second = await post("/send?box=0&op=send-twice-0001", "the same words");
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true, "the retry was not answered from the receipt");
  assert.equal(second.body.mid, first.body.mid);
  assert.deepEqual(await pendingOn("0"), ["the same words"]);
  // the receipt is in the same file as the message
  const saved = await stateFile();
  assert.equal(saved.ops["send-twice-0001"].kind, "send");
  assert.deepEqual(saved.ops["send-twice-0001"].result, { ok: true, mid: first.body.mid, box: "0" });
  assert.ok(!JSON.stringify(saved.ops["send-twice-0001"]).includes("the same words"), "the receipt carries the words");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the same id under other words is refused and nothing is stored", async () => {
  assert.equal((await post("/send?box=0&op=send-mismatch-01", "first words")).status, 200);
  const other = await post("/send?box=0&op=send-mismatch-01", "other words");
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "operation id reused with a different payload");
  assert.deepEqual(await pendingOn("0"), ["first words"]);
  // a bad id is refused before anything is looked at
  assert.equal((await post("/send?box=0&op=short", "words")).status, 400);
  assert.equal((await post("/send?box=0&op=has%20space%20in%20it", "words")).status, 400);
  assert.equal((await post("/create?owner=facilitator&op=x", "Bad id")).status, 400);
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a burst of one create id at once makes one card, and every answer names it", async () => {
  const before = (await state()).boxes.length;
  const answers = await Promise.all(Array.from({ length: 12 }, () =>
    post("/create?owner=facilitator&op=create-burst-001", "Made in a burst")));
  assert.ok(answers.every(a => a.status === 200), answers.map(a => a.status).join(","));
  const ids = new Set(answers.map(a => a.body.id));
  assert.equal(ids.size, 1, `a burst made ${ids.size} cards: ${[...ids].join(",")}`);
  assert.equal(answers.filter(a => !a.body.replayed).length, 1, "more than one answer was a fresh one");
  assert.ok(answers.every(a => a.body.card && a.body.card.id === a.body.id), "an answer came without the card");
  assert.equal((await state()).boxes.length, before + 1);
});

test("a reply lost on the wire is answered from the receipt, and the message is there once", async () => {
  // the request goes out as bytes and the socket is closed before the answer
  // can come back: the board commits, and nobody hears it
  await new Promise((resolve, reject) => {
    const body = "words whose reply was lost";
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`POST /send?box=0&op=send-lost-reply-1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        () => socket.destroy());
    });
    socket.on("close", resolve);
    socket.on("error", reject);
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    if ((await pendingOn("0")).includes("words whose reply was lost")) break;
    assert.ok(Date.now() < deadline, "the send whose reply was lost never landed");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const retry = await post("/send?box=0&op=send-lost-reply-1", "words whose reply was lost");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.deepEqual(await pendingOn("0"), ["words whose reply was lost"]);
  const asked = await api("/op?id=send-lost-reply-1");
  assert.equal(asked.body.status, "applied");
  assert.equal(asked.body.kind, "send");
  assert.equal(asked.body.box, "0");
  assert.equal(asked.body.result.mid, retry.body.mid);
});

test("a restart keeps the receipts: the retry after it answers the old result and lands nothing", async () => {
  const first = await post("/send?box=0&op=send-across-restart", "sent before the restart");
  assert.equal(first.status, 200);
  const revBefore = (await state()).rev;
  await stopServer();
  await startServer();
  const retry = await post("/send?box=0&op=send-across-restart", "sent before the restart");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true, "the receipt did not survive the restart");
  assert.equal(retry.body.mid, first.body.mid);
  const texts = await pendingOn("0");
  assert.equal(texts.filter(t => t === "sent before the restart").length, 1);
  assert.ok((await state()).rev > revBefore, "the revision went backwards across the restart");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a receipt past its window is forgotten, and a repeat after it lands again", async () => {
  assert.equal((await post("/send?box=0&op=send-that-expires-1", "words that expire")).status, 200);
  assert.equal((await api("/op?id=send-that-expires-1")).body.status, "applied");
  const deadline = Date.now() + (RETENTION_S + 4) * 1000;
  for (;;) {
    if ((await api("/op?id=send-that-expires-1")).body.status === "unknown") break;
    assert.ok(Date.now() < deadline, "the receipt never expired");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // this is the edge of the promise: past the window the same id is a new
  // command, which is why a phone gives up long before it
  const again = await post("/send?box=0&op=send-that-expires-1", "words that expire");
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, undefined);
  assert.deepEqual(await pendingOn("0"), ["words that expire", "words that expire"]);
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the count cap never evicts a receipt a phone could still be retrying, so its retry never lands twice", async () => {
  // the reviewer's scenario: more sends than the cap, all fresh. None may be
  // evicted, because a phone could still be retrying any of them; a retry of
  // the oldest must answer from its receipt, not land a second copy
  const ids = [];
  for (let n = 0; n < KEEP + 3; n++) {
    const id = `send-fresh-${String(n).padStart(4, "0")}`;
    ids.push(id);
    assert.equal((await post(`/send?box=0&op=${id}`, `fresh ${n}`)).status, 200);
  }
  // every one, including the oldest, is still known although the count is over
  // the cap (receipts from earlier tests share the store, and it is those, all
  // older than the floor, that the cap trims instead of any of these)
  for (const id of ids) {
    assert.equal((await api(`/op?id=${id}`)).body.status, "applied", `${id} was evicted while still fresh`);
  }
  const retry = await post(`/send?box=0&op=${ids[0]}`, "fresh 0");
  assert.equal(retry.body.replayed, true, "the oldest fresh id re-executed instead of replaying");
  assert.equal((await pendingOn("0")).filter(t => t === "fresh 0").length, 1, "the retry landed a second copy");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the count cap does trim receipts older than the floor, to bound memory", async () => {
  // three receipts left to age past the floor, then a burst of fresh ones over
  // the cap: the cap trims the aged ones and keeps every fresh one
  const old = [];
  for (let n = 0; n < 3; n++) {
    const id = `send-aged-${n}`;
    old.push(id);
    assert.equal((await post(`/send?box=0&op=${id}`, `aged ${n}`)).status, 200);
  }
  await new Promise(resolve => setTimeout(resolve, EVICT_FLOOR_S * 1000 + 300));   // now older than the floor
  const fresh = [];
  for (let n = 0; n < KEEP; n++) {
    const id = `send-new-${n}`;
    fresh.push(id);
    assert.equal((await post(`/send?box=0&op=${id}`, `new ${n}`)).status, 200);
  }
  // the store was over the cap with three receipts past the floor: those are trimmed
  for (const id of old) assert.equal((await api(`/op?id=${id}`)).body.status, "unknown", `${id} outlived the cap`);
  for (const id of fresh) assert.equal((await api(`/op?id=${id}`)).body.status, "applied", `${id} was trimmed while fresh`);
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a failed save never confirms an operation: the retry re-fails and the receipt stays unknown", async () => {
  const revBefore = (await state()).rev;
  await chmod(app, 0o500);   // no new file may be written beside state.json
  let first, retry, opDuring, diskRev, memRev;
  try {
    first = await post("/send?box=0&op=send-under-fail-1", "words the disk refused");
    retry = await post("/send?box=0&op=send-under-fail-1", "words the disk refused");
    opDuring = (await api("/op?id=send-under-fail-1")).body.status;
    const disk = await stateFile();
    diskRev = disk.rev;
    memRev = (await state()).rev;
    assert.equal(disk.ops["send-under-fail-1"], undefined, "a failed save left its receipt on disk");
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(first.status, 500, "a failed save did not answer 500");
  assert.equal(retry.status, 500, "the retry of an unsaved operation was falsely confirmed");
  assert.equal(retry.body.replayed, undefined, "the retry replayed a receipt the disk never held");
  assert.equal(opDuring, "unknown", "an unsaved operation reported applied");
  assert.equal(diskRev, revBefore, "a failed save advanced the durable revision");
  assert.equal(memRev, revBefore, "memory ran ahead of the disk after a failed save");
  // once the disk is writable the same id lands, once, as a fresh command
  const landed = await post("/send?box=0&op=send-under-fail-1", "words the disk refused");
  assert.equal(landed.status, 200);
  assert.equal(landed.body.replayed, undefined, "the recovery was answered from a receipt that never committed");
  assert.deepEqual(await pendingOn("0"), ["words the disk refused"]);
  // and the transcript never recorded a row for the message the board did not keep
  const rows = (await readFile(path.join(app, "transcript.jsonl"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(rows.filter(r => r.kind === "user" && r.text === "words the disk refused").length, 1,
    "the transcript kept a phantom row for the unsaved message");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a failed save consumes no revision, so a phone's since check stays honest across a restart", async () => {
  const before = (await state()).rev;
  await chmod(app, 0o500);
  try {
    for (let n = 0; n < 3; n++) assert.equal((await post("/send?box=0", `failed ${n}`)).status, 500);
  } finally {
    await chmod(app, 0o700);
  }
  const diskRev = (await stateFile()).rev;
  assert.equal(diskRev, before, "three failed saves moved the durable revision");
  // a real send advances by exactly one from the durable revision
  const sent = await post("/send?box=0", "the real one");
  assert.equal(sent.body.rev, before + 1, "the revision jumped over the failed saves' numbers");
  // a phone holding the pre-failure revision is told the board changed, not that it is current
  const ask = await api(`/m/state?since=${before}`);
  assert.equal(ask.body.changed, true, "a stale reading was served as current after failed saves");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("a send with no id lands every time, as it always did", async () => {
  assert.equal((await post("/send?box=0", "plain send")).status, 200);
  assert.equal((await post("/send?box=0", "plain send")).status, 200);
  assert.deepEqual(await pendingOn("0"), ["plain send", "plain send"]);
  const plain = await post("/send?box=0", "plain send");
  assert.equal(plain.body.ok, true);
  assert.equal(plain.body.replayed, undefined);
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the transcript row carries the id, and a row written twice is read once", async () => {
  assert.equal((await post("/send?box=0&op=send-in-transcript-1", "in the transcript")).status, 200);
  const transcriptPath = path.join(app, "transcript.jsonl");
  const rows = (await readFile(transcriptPath, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const row = rows.find(r => r.kind === "user" && r.text === "in the transcript");
  assert.equal(row.op, "send-in-transcript-1", "the transcript row does not carry the operation id");
  // the one duplicate the design allows: a crash between the transcript append
  // and the save makes the retry append the row again
  await appendFile(transcriptPath, JSON.stringify({ ...row, ts: row.ts + 1 }) + "\n");
  const thread = await api("/thread?box=0&n=50");
  assert.equal(thread.body.messages.filter(m => m.kind === "user" && m.text === "in the transcript").length, 1,
    "a duplicated transcript row was read twice");
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the revision moves with every saved change, and the phone's reading says when nothing did", async () => {
  const first = await state();
  const revA = first.rev;
  const unchanged = await api(`/m/state?since=${revA}`);
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.changed, false);
  assert.equal(unchanged.body.rev, revA);
  assert.equal(unchanged.body.boxes, undefined, "an unchanged reading carried the cards");
  assert.ok(unchanged.body.live && unchanged.body.live.agents, "an unchanged reading lacks the live section");
  assert.ok(JSON.stringify(unchanged.body).length < 2000, "an unchanged reading is not small");

  const sent = await post("/send?box=0&op=send-moves-rev-01", "moves the revision");
  assert.ok(sent.body.rev > revA);
  const changed = await api(`/m/state?since=${revA}`);
  assert.equal(changed.body.changed, true);
  assert.equal(changed.body.rev, sent.body.rev);
  const card = changed.body.boxes.find(b => b.id === "0");
  assert.deepEqual(card.pendingTexts, ["moves the revision"]);
  assert.deepEqual(card.pendingOps, ["send-moves-rev-01"], "the reading does not say which id a message was sent under");
  assert.equal(card.replyShort, undefined, "the phone's reading carries fields the phone never draws");
  assert.equal(card.context, undefined);
  assert.equal(typeof card.replyFull, "string");
  assert.equal(typeof card.state, "string");
  // a reading that names no revision, or a revision the board never had, is whole
  assert.equal((await api("/m/state")).body.changed, true);
  assert.equal((await api("/m/state?since=999999")).body.changed, true);
  assert.equal((await api("/m/state?since=abc")).status, 400);
  // the same reading answers after pending operations, applied or unknown
  const asked = await api(`/m/state?since=${sent.body.rev}&ops=send-moves-rev-01,never-sent-0001,bad%20id`);
  assert.equal(asked.body.changed, false);
  assert.equal(asked.body.ops["send-moves-rev-01"].status, "applied");
  assert.equal(asked.body.ops["send-moves-rev-01"].result.mid, sent.body.mid);
  assert.equal(asked.body.ops["never-sent-0001"].status, "unknown");
  assert.equal(asked.body.ops["bad id"], undefined);
  assert.equal((await api("/op?id=bad%20id")).status, 400);
  assert.equal((await post("/dismiss?box=0")).status, 200);
});

test("the first start with receipts keeps a copy of the old state file beside it", async () => {
  const dir = path.join(outer, "legacy");
  await mkdir(dir);
  const source = await readFile(path.join(app, "server.py"), "utf8");
  await writeFile(path.join(dir, "server.py"), source);
  const legacy = {
    title: "older board", boxes: [{ id: "0", bucket: "meta", title: "Old standing card", owner: "facilitator",
      reply: "kept", pending: [{ mid: 1, text: "still queued", ts: 1 }], done: false, replies: 1 }],
    inbox: ["0"], busy: {}, claimed: {}, busy_ts: {}, ack: {}, end: false, paused: false, next_mid: 2, next_bid: 1,
  };
  await writeFile(path.join(dir, "state.json"), JSON.stringify(legacy));
  const legacyPort = await freePort();
  const legacyLogs = path.join(outer, "legacy-logs");
  const run = spawn("python3", [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(legacyPort), FACILITATOR_LOG_DIR: legacyLogs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const deadline = Date.now() + 8000;
    for (;;) {
      assert.equal(run.exitCode, null, "the legacy start died");
      try {
        if ((await fetch(`http://127.0.0.1:${legacyPort}/state`)).ok) break;
      } catch {}
      assert.ok(Date.now() < deadline, "the legacy start never answered");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const upgraded = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    assert.equal(typeof upgraded.rev, "number");
    assert.deepEqual(upgraded.ops, {});
    assert.equal(upgraded.boxes[0].pending[0].text, "still queued", "the upgrade lost a queued message");
    const { readdir } = require("node:fs/promises");
    const kept = (await readdir(dir)).filter(name => name.startsWith("state.json.bak-"));
    assert.equal(kept.length, 1, `expected one backup, saw ${kept.join(",")}`);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, kept[0]), "utf8")), legacy, "the backup is not the old file byte for byte");
    const lines = [];
    for (const name of await readdir(legacyLogs)) {
      for (const line of (await readFile(path.join(legacyLogs, name), "utf8")).split("\n")) if (line) lines.push(JSON.parse(line));
    }
    const noted = lines.find(l => l.kind === "backup");
    assert.ok(noted, "the backup wrote no line");
    assert.equal(noted.kept, kept[0]);
    assert.ok(!noted.kept.includes("/"), "the backup line carries a path");
  } finally {
    if (run.exitCode === null) {
      run.kill("SIGTERM");
      await once(run, "exit");
    }
  }
});
