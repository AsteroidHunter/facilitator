// The board a stranger meets on a first-ever start, and the board a saved state
// puts back. Server side only: the owner set is built from data (run.config.json
// lanes, saved cards, stored projects), no lane or standing card is named in
// code, and a fresh start seeds only what seed.json says.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let baseDir;
let serverSource;
let seq = 0;

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

async function api(origin, route, options = {}) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

// A server of its own in a scratch directory, on a free port, with only the
// files the case gives it. Every lane directory below points inside that same
// scratch directory, so no case ever reaches out of it.
async function startServer({ config, seed, state } = {}) {
  const dir = path.join(baseDir, "srv-" + (++seq));
  await mkdir(dir, { recursive: true });
  const port = await require('./fixture-auth.cjs').freePortPair();
  const patched = serverSource.replace(
    "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  await writeFile(path.join(dir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(dir, "server.py")));
  if (config !== undefined) {
    const withDirs = {
      ...config,
      lanes: (config.lanes || []).map(lane => ({ dir, ...lane })),
    };
    await writeFile(path.join(dir, "run.config.json"), JSON.stringify(withDirs));
  }
  if (seed !== undefined) await writeFile(path.join(dir, "seed.json"), JSON.stringify(seed));
  if (state !== undefined) await writeFile(path.join(dir, "state.json"), JSON.stringify(state, null, 1));

  const origin = `http://127.0.0.1:${port}`;
  const child = spawn("python3", [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) {
        return {
          origin, dir,
          async stop() {
            if (child.exitCode === null) {
              child.kill("SIGTERM");
              await once(child, "exit");
            }
          },
        };
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  child.kill("SIGKILL");
  throw new Error(`server did not start:\n${output}`);
}

before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "facilitator-first-run-"));
  serverSource = await readFile(path.join(ROOT, "server.py"), "utf8");
});

after(async () => {
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

const OWNER_MAPS = ["pwds", "busy", "workspaces", "pages", "listening", "listenerGap", "agents"];

test("saved cards keep lane owners that no config or project names", async () => {
  const invented = ["orchard", "almanac", "beacon"];
  const state = {
    title: "saved board",
    boxes: [
      { id: "0", bucket: "meta", title: "Tool standing", owner: "facilitator",
        pending: [], replies: 0, done: false, ball: "you", reply: "", state: "new" },
      { id: "m10", bucket: "meta", title: "Orchard note", owner: "orchard",
        pending: [], replies: 0, done: false, ball: "you", reply: "", state: "new" },
      { id: "m11", bucket: "now", title: "Almanac task", owner: "almanac",
        pending: [{ mid: 5, text: "queued", ts: 1 }], replies: 0, done: false,
        ball: "me", reply: "", state: "queued" },
      { id: "m12", bucket: "meta", title: "Beacon note", owner: "beacon",
        pending: [], replies: 0, done: false, ball: "you", reply: "", state: "new" },
    ],
    projects: [], inbox: ["m11"],
    busy: {}, claimed: {}, busy_ts: {}, ack: {}, workspaces: {}, pages: {},
    ever_listened: {}, next_mid: 6, next_bid: 13, rev: 1,
  };
  const server = await startServer({ state });
  try {
    const st = await api(server.origin, "/state");
    assert.equal(st.status, 200);
    for (const ow of invented)
      for (const field of OWNER_MAPS)
        assert.ok(Object.hasOwn(st.body[field], ow), `${field} lacks the saved owner ${ow}`);

    for (const ow of invented) {
      assert.equal((await api(server.origin, `/worktrees?owner=${ow}`)).status, 200,
        `/worktrees refused the saved owner ${ow}`);
      assert.equal((await api(server.origin, `/unread?owner=${ow}`)).status, 200,
        `/unread refused the saved owner ${ow}`);
      const created = await api(server.origin, `/create?owner=${ow}`, { method: "POST", body: "New card" });
      assert.equal(created.status, 200, `/create refused the saved owner ${ow}`);
    }

    const delivery = await api(server.origin, "/wait?owner=almanac&timeout=1&agent=test");
    assert.equal(delivery.status, 200);
    assert.equal(delivery.body.box, "m11", "the queued card did not route on its own lane");

    const owners = new Set((await api(server.origin, "/state")).body.boxes.map(b => b.owner));
    for (const ow of invented) assert.ok(owners.has(ow), `a saved card lost its owner ${ow}`);
  } finally {
    await server.stop();
  }
});

test("a saved paused flag from an older board is dropped on start", async () => {
  const state = {
    title: "saved board",
    boxes: [
      { id: "0", bucket: "meta", title: "Tool standing", owner: "facilitator",
        pending: [], replies: 0, done: false, ball: "you", reply: "", state: "new" },
    ],
    projects: [], inbox: [],
    busy: {}, claimed: {}, busy_ts: {}, ack: {}, workspaces: {}, pages: {},
    ever_listened: {}, paused: true, next_mid: 1, next_bid: 1, rev: 1,
  };
  const server = await startServer({ state });
  try {
    const st = await api(server.origin, "/state");
    assert.equal(st.status, 200);
    assert.ok(!Object.hasOwn(st.body, "paused"), "/state still carries a paused flag");
    const wait = await api(server.origin, "/wait?owner=facilitator&timeout=1&agent=test");
    assert.equal(wait.status, 200);
    assert.deepEqual(wait.body, { idle: true }, "a saved paused flag still changed the wait answer");
    const created = await api(server.origin, "/create?owner=facilitator", { method: "POST", body: "New card" });
    assert.equal(created.status, 200);
    const saved = JSON.parse(await readFile(path.join(server.dir, "state.json"), "utf8"));
    assert.ok(!Object.hasOwn(saved, "paused"), "state.json still carries the paused flag after a save");
  } finally {
    await server.stop();
  }
});

test("a saved end flag from an older board is dropped on start", async () => {
  const state = {
    title: "saved board",
    boxes: [
      { id: "0", bucket: "meta", title: "Tool standing", owner: "facilitator",
        pending: [], replies: 0, done: false, ball: "you", reply: "", state: "new" },
    ],
    projects: [], inbox: [],
    busy: {}, claimed: {}, busy_ts: {}, ack: {}, workspaces: {}, pages: {},
    ever_listened: {}, end: true, next_mid: 1, next_bid: 1, rev: 1,
  };
  const server = await startServer({ state });
  try {
    const st = await api(server.origin, "/state");
    assert.equal(st.status, 200);
    assert.ok(!Object.hasOwn(st.body, "end"), "/state still carries an end flag");
    const wait = await api(server.origin, "/wait?owner=facilitator&timeout=1&agent=test");
    assert.equal(wait.status, 200);
    assert.deepEqual(wait.body, { idle: true }, "a saved end flag still changed the wait answer");
    const ended = await api(server.origin, "/end", { method: "POST" });
    assert.equal(ended.status, 404, "the board still answers a POST to /end");
    const created = await api(server.origin, "/create?owner=facilitator", { method: "POST", body: "New card" });
    assert.equal(created.status, 200);
    const saved = JSON.parse(await readFile(path.join(server.dir, "state.json"), "utf8"));
    assert.ok(!Object.hasOwn(saved, "end"), "state.json still carries the end flag after a save");
  } finally {
    await server.stop();
  }
});

test("a fresh start shows only facilitator and any config lane", async () => {
  const config = { lanes: [{ owner: "facilitator" }, { owner: "example" }] };
  const seed = {
    title: "Fresh board",
    items: [{ id: "0", bucket: "meta", title: "Tool standing card", owner: "facilitator" }],
  };
  const server = await startServer({ config, seed });
  try {
    const st = await api(server.origin, "/state");
    assert.equal(st.status, 200);
    assert.deepEqual(Object.keys(st.body.pwds).sort(), ["example", "facilitator"],
      "a fresh board exposed a lane the seed and config did not name");
    for (const ow of ["pastureland", "qchat", "triage"])
      assert.ok(!Object.hasOwn(st.body.pwds, ow), `a fresh board exposed the lane ${ow}`);
    for (const field of OWNER_MAPS)
      assert.ok(Object.hasOwn(st.body[field], "example"), `${field} lacks the config lane example`);
    assert.equal(
      (await api(server.origin, "/create?owner=example", { method: "POST", body: "Card" })).status,
      200, "the config lane example is not an accepted owner");
    assert.deepEqual(st.body.boxes.map(b => b.id).sort(), ["0"],
      "a fresh board carries a card the seed did not name");
    assert.ok(st.body.boxes.every(b => b.owner === "facilitator"),
      "a fresh card is owned by a project lane");
    assert.ok(!st.body.boxes.some(b => /pastureland|release/i.test(b.title)),
      "a standing card names a project");
  } finally {
    await server.stop();
  }
});
