const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let fixtureDir;
let origin;

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

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-note-state-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "state test",
    items: [{ id: "m1", bucket: "meta", title: "State test", owner: "facilitator" }],
  }));

  origin = `http://127.0.0.1:${port}`;
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
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("note is a claim-releasing progress state and quiet replies are gone", async () => {
  let result = await api("/send?box=m1", { method: "POST", body: "Start the work" });
  assert.equal(result.status, 200);
  await claim();

  result = await api("/send?box=m1", { method: "POST", body: "Follow-up while claimed" });
  assert.equal(result.status, 200);
  result = await api("/note?box=m1", { method: "POST", body: "Work is continuing" });
  assert.equal(result.status, 200);

  let state = await boxState();
  assert.equal(state.box.state, "note");
  assert.equal(state.box.ball, "me");
  assert.equal(state.box.bg, true);
  assert.equal(state.box.writing, false);
  assert.equal(state.box.pending, 1);
  assert.equal(state.board.busy.facilitator, null);

  const unread = await api("/unread?owner=facilitator");
  assert.deepEqual(unread.body, { queued: 1, claimed: 0 });
  const followUp = await claim();
  assert.deepEqual(followUp.messages, ["Follow-up while claimed"]);
  result = await api("/note?box=m1", { method: "POST", body: "Still working" });
  assert.equal(result.status, 200);

  result = await api("/reply?box=m1&quiet=1", { method: "POST", body: "Legacy progress" });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /quiet replies were removed/);
  state = await boxState();
  assert.equal(state.box.state, "note");
  assert.equal(state.box.reply, "Still working");
  assert.equal(state.box.ball, "me");
  const thread = await api("/thread?box=m1&n=20");
  assert.deepEqual(
    thread.body.messages.filter(message => message.kind === "note").map(message => message.text),
    ["Work is continuing", "Still working"],
  );

  result = await api("/working?box=m1&v=0", { method: "POST" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.equal(state.box.state, "queued", "an ended note rests grey, not yellow");
  assert.equal(state.box.ball, "me");

  result = await api("/note?box=m1", { method: "POST", body: "Final checks" });
  assert.equal(result.status, 200);

  result = await api("/reply?box=m1", { method: "POST", body: "Finished" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.equal(state.box.state, "working", "a final reply waits under the live heartbeat");
  assert.equal(state.box.ball, "me");

  result = await api("/working?box=m1&v=0", { method: "POST" });
  assert.equal(result.status, 200);
  state = await boxState();
  assert.equal(state.box.state, "yours");
  assert.equal(state.box.ball, "you");
});

// the board keeps its cardState in the shared card-logic.js; the page view keeps its own
for (const [pageName, file] of [["index.html", "card-logic.js"], ["page.html", "page.html"]]) {
  test(`${pageName} paints the note state as working green`, async () => {
    const html = await readFile(path.join(ROOT, file), "utf8");
    const start = html.indexOf("function cardState(b){");
    const end = html.indexOf("\n// the queue panel", start);
    assert.ok(start >= 0 && end > start, "cardState source was not found");
    const cardState = new Function(`${html.slice(start, end)}; return cardState;`)();
    assert.equal(cardState({ state: "note", pending: 0 }), "working");
  });
}
