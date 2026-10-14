// Every refusal the board sends, written down once, by the one door they all
// leave through. A refusal is the server working correctly and saying no, so
// the line is INFO and carries the route, the card the query named, the code
// and the sentence the page was given. One fixture server on a free port; the
// suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let outer;
let fixtureDir;
let logs;
let origin;

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

async function events() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

// the refusal lines written since the last time this was called
let read = 0;
async function refusalsSince() {
  const all = await events();
  const fresh = all.slice(read);
  read = all.length;
  return fresh.filter(event => event.kind === "refusal");
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-refusals-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "refusals fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));

  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await refusalsSince();   // the start line and the seed's own events are not refusals
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("one refusal from each family writes one line naming route, card, code and reason", async () => {
  const cases = [
    { name: "an owner this board does not have",
      call: () => fetch(origin + "/wait?owner=nobody&timeout=1"),
      route: "/wait", box: "", code: 400, reason: "unknown owner" },
    { name: "a card this board does not have",
      call: () => fetch(origin + "/reply?box=nosuchbox", { method: "POST", body: "an answer" }),
      route: "/reply", box: "nosuchbox", code: 400, reason: "bad box" },
    { name: "a context strip past its cap",
      call: () => fetch(`${origin}/reply?box=0&ctx=${encodeURIComponent("word ".repeat(60))}`,
        { method: "POST", body: "an answer" }),
      route: "/reply", box: "0", code: 400, reason: "context strip over 50 words" },
    { name: "a token no claim was minted for",
      call: () => fetch(origin + "/ack?owner=facilitator&token=deadbeef", { method: "POST" }),
      route: "/ack", box: "", code: 409, reason: "unknown or stale token" },
    { name: "a route nobody serves",
      call: () => fetch(origin + "/nosuchroute?box=0"),
      route: "/nosuchroute", box: "0", code: 404, reason: "not found" },
  ];

  for (const one of cases) {
    const response = await one.call();
    assert.equal(response.status, one.code, one.name);
    const written = await refusalsSince();
    assert.equal(written.length, 1, `${one.name}: ${written.length} refusal lines`);
    const line = written[0];
    assert.equal(line.level, "info", "a refusal is the server working correctly, not an error");
    assert.equal(line.route, one.route, one.name);
    assert.equal(line.code, one.code, one.name);
    assert.equal(line.reason, one.reason, one.name);
    assert.equal(line.box || "", one.box, one.name);
  }
});

test("an answer the board meant to give writes no refusal line at all", async () => {
  for (const call of [
    () => fetch(origin + "/state"),
    () => fetch(origin + "/reply?box=0", { method: "POST", body: "a good answer" }),
    () => fetch(origin + "/send?box=0", { method: "POST", body: "a good message" }),
    () => fetch(origin + "/unread?owner=facilitator"),
  ]) {
    const response = await call();
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(await refusalsSince(), []);
});

test("a refusal line carries no part of what was sent", async () => {
  const phrase = "sextant-lozenge-7731";
  const refused = await fetch(`${origin}/context?box=0`,
    { method: "POST", body: `${phrase} ` + "word ".repeat(60) });
  assert.equal(refused.status, 400);
  const written = await refusalsSince();
  assert.equal(written.length, 1);
  assert.equal(written[0].reason, "context strip over 50 words");
  for (const event of await events()) {
    assert.ok(!JSON.stringify(event).includes(phrase), "a refused body reached the log");
  }
});
