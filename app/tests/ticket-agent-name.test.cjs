// The agent a ticket names, against a real throwaway board server (a copied
// server.py on an ephemeral loopback port, its own temp data, never the live
// board and never port 8877): a card remembers the class name of the agent
// whose claim its reply landed on, in both snapshots, and keeps it through a
// restart. The class-name rules themselves (agent_names.agent_class) are
// checked in the same file, straight from the module.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const { freePortPair } = require("./fixture-auth.cjs");
const { appFolder, dataOf } = require("./fixture-auth.cjs");

let child, fixtureDir, origin, port;
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

// the agent called `name` takes the lane's next claim, which must be the card
// `id` (the lane's older cards are answered first), and answers it
async function answerAs(name, id, text = "an invented answer") {
  for (let i = 0; i < 12; i++) {
    const wait = await (await fetch(`${origin}/wait?owner=facilitator&timeout=3&agent=${encodeURIComponent(name)}`)).json();
    if (wait.idle) throw new Error("no queued card to claim for " + id);
    assert.equal((await post("/ack?owner=facilitator&token=" + encodeURIComponent(wait.ack))).status, 200);
    assert.equal((await post("/reply?box=" + wait.box, wait.box === id ? text : "drained")).status, 200);
    if (wait.box === id) return;
  }
  throw new Error("card " + id + " was never claimed");
}
const create = async title => (await post("/create?owner=facilitator", title)).body.id;
// a card with a message waiting for the lane's agent
const ask = async title => {
  const id = await create(title);
  assert.equal((await post("/send?box=" + id, "an invented question")).status, 200);
  return id;
};

before(async () => {
  fixtureDir = appFolder("facilitator-agentname-");
  port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  let src = await readFile(path.join(ROOT, "server.py"), "utf8");
  src = src.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.ok(src.includes("FACILITATOR_TEST_PORT"), "port rebind anchor");
  await writeFile(path.join(fixtureDir, "server.py"), src);
  require(path.join(ROOT, "tests", "fixture-auth.cjs")).copyBridgeFiles(fixtureDir);
  await copyFile(path.join(ROOT, "m-manifest.json"), path.join(fixtureDir, "m-manifest.json"));
  await copyFile(path.join(ROOT, "agent_names.py"), path.join(fixtureDir, "agent_names.py"));
  await writeFile(path.join(dataOf(fixtureDir), "seed.json"), JSON.stringify({
    title: "Agent name fixture",
    items: [{ id: "0", bucket: "meta", owner: "facilitator", title: "Standing meta" }],
  }));
  await startServer();
});
after(async () => { await stopServer(); if (fixtureDir) await rm(path.dirname(fixtureDir), { recursive: true, force: true }); });

test("a card nobody has answered names no agent", async () => {
  const id = await create("Unanswered");
  assert.equal((await boxOf(id)).agent, "");
  assert.equal((await mstate()).boxes.find(b => b.id === id).agent, "");
});

test("a reply credits the class of the agent that took the claim, in both snapshots", async () => {
  const id = await ask("Opus card");
  await answerAs("claude-opus-4", id);
  assert.equal((await boxOf(id)).agent, "opus");
  assert.equal((await mstate()).boxes.find(b => b.id === id).agent, "opus");
});

test("each card keeps its own agent when the lane's listener changes", async () => {
  const first = await ask("First card");
  const second = await ask("Second card");
  await answerAs("astra", first);
  await answerAs("Sonnet 4.6", second);
  assert.equal((await boxOf(first)).agent, "astra", "the first card took on the lane's later agent");
  assert.equal((await boxOf(second)).agent, "sonnet");
});

test("a name that says no class stays as given, and a progress note changes nothing", async () => {
  const id = await ask("Plain card");
  const wait = await (await fetch(`${origin}/wait?owner=facilitator&timeout=3&agent=claude-code`)).json();
  assert.equal(wait.box, id);
  assert.equal((await post("/ack?owner=facilitator&token=" + encodeURIComponent(wait.ack))).status, 200);
  assert.equal((await post("/progress?box=" + id, "working on it")).status, 200);
  assert.equal((await boxOf(id)).agent, "", "a progress note is not a reply");
  // another agent arrives on the lane before the reply lands: the claim's agent is credited
  await fetch(`${origin}/wait?owner=facilitator&timeout=1&agent=astra`);
  assert.equal((await post("/reply?box=" + id, "done now")).status, 200);
  assert.equal((await boxOf(id)).agent, "claude-code");
});

test("the agent a card names survives a restart", async () => {
  const id = await ask("Kept card");
  await answerAs("gpt-5", id);
  assert.equal((await boxOf(id)).agent, "codex");
  await stopServer();
  await startServer();
  assert.equal((await boxOf(id)).agent, "codex");
});

test("class names: opus, sonnet, astra, haiku and codex are found in the name; the rest stay", async () => {
  const code = [
    "import json, sys; sys.path.insert(0, sys.argv[1]); import agent_names as a",
    "print(json.dumps([a.agent_class(n) for n in json.loads(sys.argv[2])]))",
  ].join("\n");
  const names = ["opus", "Claude-Opus", "claude-opus-4-7", "sonnet", "Claude Sonnet 4.6", "astra", "Astra-2", "haiku",
    "claude-haiku", "codex", "gpt-5", "GPT", "claude", "claude-code", "fable", "", null];
  const { stdout } = await execFileAsync(PYTHON, ["-c", code, ROOT, JSON.stringify(names)]);
  assert.deepEqual(JSON.parse(stdout), ["opus", "opus", "opus", "sonnet", "sonnet", "astra", "astra", "haiku",
    "haiku", "codex", "codex", "codex", "claude", "claude-code", "fable", "", ""]);
});
