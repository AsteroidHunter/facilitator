// The agent's hand-off, now that the answer is sent after the lock is let go:
// a claim rolled back because its listener was gone can only undo the claim
// its own token was minted for, never a later ack and never a claim made
// since; a listener that hangs up while waiting claims nothing; a card handed
// to a listener that never reads comes back on the ack clock with its token
// stale; and the lane's queue is still handed out in order. The guard is
// driven directly through the patched module, the rest through a real
// fixture server on a free port. The suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const net = require("node:net");
const { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const ACK_GRACE_S = 1.5;   // ACK_GRACE in this fixture

let outer;
let app;
let logs;
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
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs, FACILITATOR_LOG_LEVEL: "debug" },
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

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function post(route, body) {
  return api(route, { method: "POST", body });
}

async function events() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

async function stateUntil(check, ms = 5000, why = "the board never reached the expected state") {
  const deadline = Date.now() + ms;
  for (;;) {
    const state = (await api("/state")).body;
    if (check(state)) return state;
    assert.ok(Date.now() < deadline, why);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// one run of python against the patched module, in its own folder, so the
// guard can be driven straight without a socket
async function probe(code) {
  const dir = await mkdtemp(path.join(outer, "probe-"));
  await writeFile(path.join(dir, "server.py"), await readFile(path.join(app, "server.py"), "utf8"));
  const { stdout } = await execFileAsync("python3", ["-c", code], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: "1", FACILITATOR_LOG_DIR: path.join(dir, "logs") },
  });
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

const GUARD_SETUP = [
  "import json, server",
  "server._state = server._seed_state()",
  "server._state['boxes'].append({'id': 'm1', 'bucket': 'meta', 'title': 'Held', 'reply': '', 'pending': [{'mid': 1, 'text': 'waiting', 'ts': 1}],",
  "    'done': False, 'parked': False, 'replies': 0, 'owner': 'facilitator'})",
  "server._migrate()",
  "st = server._state",
  "st['busy']['facilitator'] = 'm1'",
  "st['claimed']['facilitator'] = [1]",
  "st['ack']['facilitator'] = {'box': 'm1', 'token': 'tok-a', 'ts': 0, 'confirmed': False}",
  "st['inbox'] = []",
].join("\n");

function report() {
  return [
    "print(json.dumps({'rolled': rolled, 'busy': st['busy']['facilitator'], 'claimed': st['claimed']['facilitator'],",
    "    'ack': st['ack']['facilitator'], 'inbox': st['inbox']}))",
  ].join("\n");
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-claims-"));
  app = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(app);
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = patch(source, "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  source = patch(source, "ACK_GRACE = 90.0", `ACK_GRACE = ${ACK_GRACE_S}`);
  source = patch(source, "WRITE_STALL_TIMEOUT = 30.0", "WRITE_STALL_TIMEOUT = 1.0");
  await writeFile(path.join(app, "server.py"), source);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "claims fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "m1", bucket: "meta", title: "First", owner: "facilitator" },
      { id: "m2", bucket: "meta", title: "Second", owner: "facilitator" },
      { id: "m3", bucket: "meta", title: "Third", owner: "facilitator" },
    ],
  }));
  await startServer();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("the rollback undoes only the claim its token was minted for", async () => {
  // the claim this token names, unconfirmed: rolled back, box to the front
  let seen = await probe(`${GUARD_SETUP}\nrolled = server._rollback_claim('facilitator', 'm1', 'tok-a')\n${report()}`);
  assert.equal(seen.rolled, true);
  assert.equal(seen.busy, null);
  assert.deepEqual(seen.claimed, []);
  assert.equal(seen.ack, null);
  assert.deepEqual(seen.inbox, ["m1"], "the rolled back box did not go to the front of its queue");

  // an ack beat the rollback: the listener did get the card, and it keeps it
  seen = await probe(`${GUARD_SETUP}\nst['ack']['facilitator']['confirmed'] = True\nrolled = server._rollback_claim('facilitator', 'm1', 'tok-a')\n${report()}`);
  assert.equal(seen.rolled, false);
  assert.equal(seen.busy, "m1");
  assert.deepEqual(seen.claimed, [1]);
  assert.equal(seen.ack.confirmed, true);
  assert.deepEqual(seen.inbox, []);

  // a claim made since carries another token: somebody else's claim stands
  seen = await probe(`${GUARD_SETUP}\nst['ack']['facilitator']['token'] = 'tok-b'\nrolled = server._rollback_claim('facilitator', 'm1', 'tok-a')\n${report()}`);
  assert.equal(seen.rolled, false);
  assert.equal(seen.busy, "m1");
  assert.equal(seen.ack.token, "tok-b");

  // the lane has moved on to another box under the same record: nothing to undo
  seen = await probe(`${GUARD_SETUP}\nst['busy']['facilitator'] = '0'\nrolled = server._rollback_claim('facilitator', 'm1', 'tok-a')\n${report()}`);
  assert.equal(seen.rolled, false);
  assert.equal(seen.busy, "0");

  // and a lane holding nothing at all
  seen = await probe(`${GUARD_SETUP}\nst['busy']['facilitator'] = None\nst['ack']['facilitator'] = None\nrolled = server._rollback_claim('facilitator', 'm1', 'tok-a')\n${report()}`);
  assert.equal(seen.rolled, false);
  assert.equal(seen.busy, null);
  assert.deepEqual(seen.inbox, []);
});

test("a listener that hangs up while waiting claims nothing, and the next one gets the card", async () => {
  // a raw wait, closed before anything is queued: the board sees the peer go
  const gone = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /wait?owner=facilitator&timeout=20&agent=ghost HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 150);
    socket.on("close", () => resolve(true));
  });
  assert.equal(gone, true);
  await stateUntil(s => s.listening.facilitator === false, 3000, "the board still counts the dead listener as listening");
  const claims = (await events()).filter(e => e.kind === "claim").length;
  assert.equal((await post("/send?box=m1", "for whoever is really there")).status, 200);
  const live = await api("/wait?owner=facilitator&timeout=3&agent=real");
  assert.equal(live.body.box, "m1", JSON.stringify(live.body));
  assert.equal((await post(`/ack?owner=facilitator&token=${live.body.ack}`)).status, 200);
  assert.equal((await post("/reply?box=m1", "answered by the real one")).status, 200);
  assert.equal((await events()).filter(e => e.kind === "claim").length, claims + 1, "the dead listener took a claim");
  assert.equal((await events()).filter(e => e.kind === "bounce").length, 0, "a card bounced that was never handed to a dead listener");
});

test("a card handed to a listener that never reads comes back, and its token goes stale", async () => {
  // a claim too large for the socket to swallow: the listener never reads, the
  // send stalls and is cut, and the hand-off sits unconfirmed until the ack
  // clock brings the card back
  const big = "y".repeat(300 * 1024);
  assert.equal((await post("/send?box=m2", big)).status, 200);
  const stalled = await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.once("connect", () => {
      socket.pause();
      socket.write("GET /wait?owner=facilitator&timeout=20&agent=deaf HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", error => error ? reject(error) : resolve(socket));
    });
  });
  const claimed = await stateUntil(s => s.busy.facilitator === "m2", 3000, "the deaf listener was never handed the card");
  assert.equal(claimed.boxes.find(b => b.id === "m2").state, "working");
  const back = await stateUntil(s => s.busy.facilitator === null && s.boxes.find(b => b.id === "m2").queuePos === 1,
    (ACK_GRACE_S + 6) * 1000, "the unconfirmed hand-off never came back");
  assert.equal(back.boxes.find(b => b.id === "m2").state, "queued", "the card came back yellow or green rather than queued grey");
  stalled.destroy();
  const bounced = (await events()).filter(e => e.kind === "bounce");
  assert.equal(bounced.length, 1);
  assert.equal(bounced[0].box, "m2");
  // the next listener gets it, and the old hand-off's token is refused
  const live = await api("/wait?owner=facilitator&timeout=3&agent=real");
  assert.equal(live.body.box, "m2");
  assert.equal(live.body.messages[0].length, big.length);
  assert.equal((await post("/ack?owner=facilitator&token=000000000000")).status, 409);
  assert.equal((await post(`/ack?owner=facilitator&token=${live.body.ack}`)).status, 200);
  assert.equal((await post("/reply?box=m2", "answered after the bounce")).status, 200);
});

test("the lane's queue is handed out in order, one claim at a time, through acks and replies", async () => {
  for (const [id, text] of [["m1", "one"], ["m2", "two"], ["m3", "three"]]) {
    assert.equal((await post(`/send?box=${id}`, text)).status, 200);
  }
  const order = [];
  for (let n = 0; n < 3; n++) {
    const claim = await api("/wait?owner=facilitator&timeout=3&agent=orderly");
    order.push(claim.body.box);
    assert.equal(claim.body.queued_after, 2 - n);
    // a second listener on the same lane waits while the first holds the claim
    const other = await api("/wait?owner=facilitator&timeout=1&agent=second");
    assert.deepEqual(other.body, { idle: true }, "a second listener was handed a card while the lane was busy");
    assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 200);
    assert.equal((await post(`/ack?owner=facilitator&token=${claim.body.ack}`)).status, 200, "a resent ack was refused");
    assert.equal((await post(`/reply?box=${claim.body.box}`, `answered ${claim.body.box}`)).status, 200);
  }
  assert.deepEqual(order, ["m1", "m2", "m3"]);
  assert.deepEqual((await api("/wait?owner=facilitator&timeout=1&agent=orderly")).body, { idle: true });
});

test("a first-ever wait whose save fails leaves no listener counted and writes no crash line", async () => {
  // the pastureland lane has not listened in this run, so its first wait records
  // ever_listened and saves. With the folder read-only that save fails, and the
  // count must not be left showing a listener that never really arrived
  const before = (await api("/state")).body.listening.pastureland;
  assert.equal(before, false, "the lane was already listening before the test");
  const crashesBefore = (await events()).filter(e => e.kind === "crash").length;
  await chmod(app, 0o500);
  let answer;
  try {
    answer = await api("/wait?owner=pastureland&timeout=1&agent=firstlisten");
    // the count did not move, and the failure is a plain 500, not a crash
    const listening = (await api("/state")).body.listening.pastureland;
    assert.equal(listening, false, "a failed first wait left the lane counted as listening");
  } finally {
    await chmod(app, 0o700);
  }
  assert.equal(answer.status, 500, "a save that failed on the first wait was not answered 500");
  assert.deepEqual(answer.body, { error: "the board could not save its state" });
  const crashes = (await events()).filter(e => e.kind === "crash");
  assert.equal(crashes.length, crashesBefore, "the failed wait wrote a crash line instead of a plain refusal");
  const savefail = (await events()).filter(e => e.kind === "savefail");
  assert.ok(savefail.length >= 1, "the failed save wrote no savefail line");

  // once the folder is writable the lane listens and leaves cleanly, and the
  // count is not stuck from the earlier failure
  const clean = await api("/wait?owner=pastureland&timeout=1&agent=firstlisten");
  assert.deepEqual(clean.body, { idle: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await api("/state")).body.listening.pastureland, false, "the lane stayed counted as listening after a clean wait");
  assert.equal((await api("/state")).body.everListened.pastureland, true, "the clean wait did not record ever_listened");
});
