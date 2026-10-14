// A save that cannot happen. The write used to be unguarded, inside the lock
// that wraps the whole POST dispatch, so a full or unwritable disk raised out
// of the handler with no response ever written: the page's fetch hung until the
// socket closed and the composer sat disabled with no way to know why. This is
// about answering instead. One fixture server on a free port; the suite never
// touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
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

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-savefail-"));
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
    title: "save failure fixture",
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
});

after(async () => {
  // the folder is put back the way it was, or nothing can clear it away
  await chmod(fixtureDir, 0o700).catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a save that cannot be written answers 500, says which step failed, and keeps the board up", async () => {
  const before = (await events()).length;
  await chmod(fixtureDir, 0o500);   // no new file may be made beside state.json
  let refused;
  try {
    const started = Date.now();
    refused = await Promise.race([
      fetch(origin + "/send?box=0", { method: "POST", body: "a message that cannot be saved" })
        .then(async response => ({ status: response.status, body: await response.json() })),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("the request hung")), 3000)),
    ]);
    assert.ok(Date.now() - started < 3000, "the request took longer than a page would wait");
  } finally {
    await chmod(fixtureDir, 0o700);
  }

  assert.equal(refused.status, 500);
  assert.equal(refused.body.error, "the board could not save its state");
  // the answer says what happened and nothing about where the board lives
  const said = JSON.stringify(refused.body);
  assert.ok(!said.includes("/"), `the answer carries a path: ${said}`);

  const failures = (await events()).slice(before).filter(event => event.kind === "savefail");
  assert.ok(failures.length >= 1, "a save that failed wrote no line");
  assert.equal(failures[0].level, "error");
  assert.equal(failures[0].step, "write", "the line does not name the step that failed");
  assert.ok(failures[0].reason, "the line does not say why");
  for (const failure of failures) {
    assert.ok(!JSON.stringify(failure).includes(fixtureDir), "the line carries the path it could not write");
  }

  // and the board is still there: it answers, and the next save works
  const state = await (await fetch(origin + "/state")).json();
  assert.ok(Array.isArray(state.boxes) && state.boxes.length > 0);
  const kept = await fetch(origin + "/send?box=0", { method: "POST", body: "a message that saves" });
  assert.equal(kept.status, 200);
  const saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
  assert.ok(saved.boxes.find(box => box.id === "0").pending.length > 0,
    "the board could not write its state once the folder was writable again");
});
