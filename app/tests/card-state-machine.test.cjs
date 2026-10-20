const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { appFolder, dataOf } = require("./fixture-auth.cjs");
const { saveNotes } = require("./saved-notes.cjs");

const ROOT = path.resolve(__dirname, "..");
const REFUSAL = "notes were removed; send progress as a normal /reply under /working";
const PROGRESS_REFUSAL = "progress updates were removed; send progress as a normal /reply under /working";

let child;
let fixtureDir;
let origin;
let port;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function boxState() {
  const { status, body } = await api("/state");
  assert.equal(status, 200);
  return { board: body, box: body.boxes.find(box => box.id === "m1") };
}

async function claim() {
  const delivery = await api("/wait?owner=facilitator&timeout=1&agent=test");
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.box, "m1");
  const ack = await api(`/ack?owner=facilitator&token=${delivery.body.ack}`, { method: "POST" });
  assert.equal(ack.status, 200);
  return delivery.body;
}

async function startServer() {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

// what a card saved before /note was removed holds, written while the board is down
async function restartWithNotes(texts, options) {
  await stopServer();
  saveNotes(dataOf(fixtureDir), "m1", texts, options);
  await startServer();
}

before(async () => {
  fixtureDir = appFolder("facilitator-note-state-");
  port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await writeFile(path.join(dataOf(fixtureDir), "seed.json"), JSON.stringify({
    title: "state test",
    items: [{ id: "m1", bucket: "meta", title: "State test", owner: "facilitator" }],
  }));

  origin = `http://127.0.0.1:${port}`;
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(path.dirname(fixtureDir), { recursive: true, force: true });
});

// everything a page draws a card from that a note used to move
const SHOWN = ["state", "ball", "bg", "writing", "pending", "pendingTexts", "pendingStates", "notedTexts",
  "reply", "replyFull", "replyShort", "replies", "olderReplies", "replyKind", "replyId", "replyTs",
  "answered", "agentTs", "ts"];
const shown = box => Object.fromEntries(SHOWN.map(field => [field, box[field]]));

test("a stale /note is refused and leaves the card, its claim and its messages as they were", async () => {
  let result = await api("/send?box=m1", { method: "POST", body: "Start the work" });
  assert.equal(result.status, 200);
  await claim();
  const before = await boxState();
  const threadBefore = (await api("/thread?box=m1&n=20")).body.messages;

  result = await api("/note?box=m1", { method: "POST", body: "Work is continuing" });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: REFUSAL });
  result = await api("/note?box=m1&ctx=progress", { method: "POST", body: "" });
  assert.deepEqual([result.status, result.body], [400, { error: REFUSAL }], "an empty note was not refused the same way");

  const after = await boxState();
  assert.deepEqual(shown(after.box), shown(before.box), "a refused note changed what the card shows");
  assert.equal(after.board.busy.facilitator, "m1", "a refused note let the claim go");
  assert.equal(after.board.rev, before.board.rev, "a refused note saved the board");
  assert.deepEqual((await api("/thread?box=m1&n=20")).body.messages, threadBefore,
    "a refused note wrote a row into the card's history");
  assert.deepEqual((await api("/unread?owner=facilitator")).body, { queued: 0, claimed: 1 });

  // the older removed path now points at the same answer
  result = await api("/reply?box=m1&quiet=1", { method: "POST", body: "Legacy progress" });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "quiet replies were removed; send progress as a normal /reply under /working" });

  result = await api("/reply?box=m1", { method: "POST", body: "Finished" });
  assert.equal(result.status, 200);
  const answered = await boxState();
  assert.equal(answered.box.state, "yours");
  assert.equal(answered.box.ball, "you");
  // a seeded card's first answer cannot name its batch (the upgrade rule for
  // answered batches), so the queue emptying is what says it was answered here
  assert.deepEqual(answered.box.pendingTexts, []);
  assert.equal(answered.board.busy.facilitator, null);
});

test("progress is a normal reply under /working: green with the message answered, then handed over", async () => {
  let result = await api("/working?box=m1&v=1", { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/send?box=m1", { method: "POST", body: "Carry on with the next part" });
  assert.equal(result.status, 200);
  await claim();
  result = await api("/reply?box=m1", { method: "POST", body: "Halfway there" });
  assert.equal(result.status, 200);

  let state = await boxState();
  assert.equal(state.box.state, "working", "a reply under the live flag did not stay green");
  assert.equal(state.box.ball, "me");
  assert.equal(state.box.bg, true);
  assert.equal(state.box.pending, 0, "the message the reply answered still waits at the bottom");
  assert.deepEqual(state.box.answered.map(m => m.text), ["Carry on with the next part"]);
  assert.equal(state.box.replyKind, "agent");
  assert.equal(state.board.busy.facilitator, null);

  result = await api("/working?box=m1&v=0", { method: "POST" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.equal(state.box.state, "yours");
  assert.equal(state.box.ball, "you");
});

test("a card saved in the note state loads in it and leaves it as it always did", async () => {
  // a live note over a follow-up still queued: green, and grey once its work ends
  let result = await api("/send?box=m1", { method: "POST", body: "A follow-up the note left queued" });
  assert.equal(result.status, 200);
  await restartWithNotes(["Still working"]);
  let state = await boxState();
  assert.equal(state.box.state, "note");
  assert.equal(state.box.ball, "me");
  assert.equal(state.box.bg, true);
  assert.equal(state.box.pending, 1);
  assert.equal(state.box.reply, "Still working");
  assert.equal(state.box.replyKind, "note");
  assert.equal(state.box.olderReplies, 2, "the note hid a completed reply beneath it");
  assert.deepEqual((await api("/history?box=m1")).body.replies, ["Finished", "Halfway there"]);
  const thread = await api("/thread?box=m1&n=20");
  assert.deepEqual(thread.body.messages.filter(message => message.kind === "note").map(message => message.text),
    ["Still working"]);
  result = await api("/working?box=m1&v=0", { method: "POST" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.equal(state.box.state, "queued", "an ended note rests grey, not yellow");
  assert.equal(state.box.ball, "me");
  await claim();
  result = await api("/reply?box=m1", { method: "POST", body: "Answered the follow-up" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.deepEqual([state.box.state, state.box.ball], ["yours", "you"]);
  assert.deepEqual(state.box.answered.map(m => m.text), ["A follow-up the note left queued"]);

  // a note whose heartbeat ran out while the board was down rests at the first reading
  await restartWithNotes(["Checking one more thing"], { hb: Date.now() / 1000 - 600 });
  state = await boxState();
  assert.deepEqual([state.box.state, state.box.ball, state.box.bg], ["queued", "me", false]);
  assert.equal(state.box.reply, "Checking one more thing");

  // and the next event moves a live one on: a message keeps the green, the reply
  // under it waits, and the heartbeat ending hands the turn over
  await restartWithNotes(["Reading the logs"]);
  assert.equal((await boxState()).box.state, "note");
  result = await api("/send?box=m1", { method: "POST", body: "Another question" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.deepEqual([state.box.state, state.box.ball], ["working", "me"]);
  await claim();
  result = await api("/reply?box=m1", { method: "POST", body: "The answer to it" });
  assert.equal(result.status, 200);
  assert.deepEqual([(await boxState()).box.state, (await boxState()).box.ball], ["working", "me"]);
  result = await api("/working?box=m1&v=0", { method: "POST" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.deepEqual([state.box.state, state.box.ball], ["yours", "you"]);
});

test("a stale /progress is refused and leaves the card, its claim, its messages and the steal timer as they were", async () => {
  let result = await api("/send?box=m1", { method: "POST", body: "Check the logs again" });
  assert.equal(result.status, 200);
  await claim();
  const before = await boxState();
  const threadBefore = (await api("/thread?box=m1&n=50")).body.messages;
  // the claim's clock, the steal timer, is saved with the rest of the board
  const savedBefore = await readFile(path.join(dataOf(fixtureDir), "state.json"), "utf8");

  result = await api("/progress?box=m1", { method: "POST", body: "Halfway through" });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: PROGRESS_REFUSAL });

  const after = await boxState();
  assert.deepEqual(shown(after.box), shown(before.box), "a refused progress update changed what the card shows");
  assert.equal(after.board.busy.facilitator, "m1", "a refused progress update let the claim go");
  assert.equal(after.board.rev, before.board.rev, "a refused progress update saved the board");
  assert.deepEqual((await api("/thread?box=m1&n=50")).body.messages, threadBefore);
  assert.deepEqual((await api("/unread?owner=facilitator")).body, { queued: 0, claimed: 1 });
  const savedAfter = await readFile(path.join(dataOf(fixtureDir), "state.json"), "utf8");
  assert.equal(savedAfter, savedBefore, "a refused progress update wrote the board's file");
  assert.ok(JSON.parse(savedAfter).busy_ts.facilitator > 0, "the claim's steal timer was not running");

  result = await api("/reply?box=m1", { method: "POST", body: "Checked: nothing new in them" });
  assert.equal(result.status, 200);
  const answered = await boxState();
  assert.deepEqual([answered.box.state, answered.box.ball], ["yours", "you"]);
  assert.deepEqual(answered.box.answered.map(m => m.text), ["Check the logs again"]);
  assert.equal(answered.board.busy.facilitator, null);
});

// the board keeps its cardState in the shared card-logic.js; the page view keeps its own
for (const [pageName, file] of [["index.html", "card-logic.js"], ["page.html", "page.html"]]) {
  test(`${pageName} paints a saved note state as working green`, async () => {
    const html = await readFile(path.join(ROOT, file), "utf8");
    const start = html.indexOf("function cardState(b){");
    const end = html.indexOf("\n// the queue panel", start);
    assert.ok(start >= 0 && end > start, "cardState source was not found");
    const cardState = new Function(`${html.slice(start, end)}; return cardState;`)();
    assert.equal(cardState({ state: "note", pending: 0 }), "working");
  });
}
