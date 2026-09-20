// A project's view pages, server side: the list every project is given on its
// first migration, the two routes that add and remove one, what they refuse,
// and what a deletion is guaranteed not to touch. The distinction this suite
// exists for is the one between a project that has never been migrated and a
// project whose pages have all been deleted: the first is given its board
// page, the second is left empty and stays empty across a restart.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let fixtureDir;
let logs;
let origin;
let port;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const chosen = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return chosen;
}

const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, options) {
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}

async function post(route) {
  return api(route, { method: "POST" });
}

async function state() {
  return (await fetch(origin + "/state")).json();
}

async function pagesOf(owner) {
  return (await state()).pages[owner];
}

async function persisted() {
  return JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
}

async function startServer() {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    await settle();
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
}

// stop, start again, and answer from the state file the restart read back
async function restart() {
  await stopServer();
  await startServer();
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pages-"));
  logs = path.join(fixtureDir, "logs");
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  await copyFile(path.join(ROOT, "m-manifest.json"), path.join(fixtureDir, "m-manifest.json"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [
      { id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" },
      { id: "n1", bucket: "now", title: "Rope ladder, second rung", owner: "pastureland" },
      { id: "q", bucket: "meta", title: "Quick chat", owner: "qchat" },
    ],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("every project is migrated onto one board page and nothing else", async () => {
  const pages = (await state()).pages;
  for (const owner of ["facilitator", "pastureland", "qchat"]) {
    assert.deepEqual(pages[owner].map(p => p.kind), ["board"], `${owner} did not open on one board page`);
    assert.equal(pages[owner][0].id, "pg1");
    assert.equal(typeof pages[owner][0].created, "number");
  }
});

test("the plus adds a blank page to that project alone", async () => {
  const others = (await state()).pages.pastureland;
  const made = await post("/pages/new?owner=facilitator");
  assert.equal(made.status, 200);
  assert.equal(made.body.ok, true);
  assert.match(made.body.id, /^pg\d+$/);
  assert.deepEqual(made.body.pages.map(p => p.kind), ["board", "blank"]);
  assert.deepEqual((await pagesOf("facilitator")).map(p => p.id), ["pg1", made.body.id]);
  assert.deepEqual((await state()).pages.pastureland, others,
    "adding a page to one project changed another's");
});

test("page ids are never reused, so a stale selection cannot land on a new page", async () => {
  const first = (await post("/pages/new?owner=pastureland")).body.id;
  const second = (await post("/pages/new?owner=pastureland")).body.id;
  assert.notEqual(first, second);
  assert.equal((await post(`/pages/del?owner=pastureland&id=${first}`)).status, 200);
  const third = (await post("/pages/new?owner=pastureland")).body.id;
  assert.notEqual(third, first, "a deleted page's id came back");
  assert.notEqual(third, second);
  assert.equal((await post(`/pages/del?owner=pastureland&id=${second}`)).status, 200);
  assert.equal((await post(`/pages/del?owner=pastureland&id=${third}`)).status, 200);
  assert.deepEqual((await pagesOf("pastureland")).map(p => p.id), ["pg1"]);
});

test("a lane nobody has heard of, a page nobody has, and a missing id are all refused", async () => {
  const before = (await state()).pages;
  for (const route of ["/pages/new?owner=no-such-lane", "/pages/new?owner=", "/pages/new"]) {
    const refused = await post(route);
    assert.equal(refused.status, 400, `${route} was accepted`);
    assert.deepEqual(refused.body, { error: "unknown owner" });
  }
  for (const route of ["/pages/del?owner=no-such-lane&id=pg1", "/pages/del?id=pg1"]) {
    const refused = await post(route);
    assert.equal(refused.status, 400, `${route} was accepted`);
    assert.deepEqual(refused.body, { error: "unknown owner" });
  }
  for (const route of ["/pages/del?owner=facilitator&id=pg999",
                       "/pages/del?owner=facilitator&id=",
                       "/pages/del?owner=facilitator"]) {
    const refused = await post(route);
    assert.equal(refused.status, 400, `${route} was accepted`);
    assert.deepEqual(refused.body, { error: "unknown page" });
  }
  assert.deepEqual((await state()).pages, before, "a refused call still changed the stored pages");
});

test("a project cannot be filled with more pages than the switcher can show", async () => {
  const room = 24 - (await pagesOf("qchat")).length;
  const made = [];
  for (let i = 0; i < room; i++) {
    const answer = await post("/pages/new?owner=qchat");
    assert.equal(answer.status, 200);
    made.push(answer.body.id);
  }
  const refused = await post("/pages/new?owner=qchat");
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: "too many pages" });
  assert.equal((await pagesOf("qchat")).length, 24);
  for (const id of made) assert.equal((await post(`/pages/del?owner=qchat&id=${id}`)).status, 200);
  assert.deepEqual((await pagesOf("qchat")).map(p => p.id), ["pg1"]);
});

test("deleting a page keeps every card, every message and every workspace", async () => {
  const sent = await api("/send?box=n1", { method: "POST", body: "the rung is the third one" });
  assert.equal(sent.status, 200);
  assert.equal((await api("/ws/goal?owner=pastureland&ws=w1",
    { method: "POST", body: "finish the ladder" })).status, 200);
  assert.equal((await api("/ws/task?owner=pastureland&ws=w1",
    { method: "POST", body: "cut the rungs" })).status, 200);
  const before = await state();
  const extra = (await post("/pages/new?owner=pastureland")).body.id;
  assert.equal((await post(`/pages/del?owner=pastureland&id=${extra}`)).status, 200);
  const after = await state();
  assert.deepEqual(after.boxes.map(b => b.id), before.boxes.map(b => b.id));
  assert.deepEqual(after.boxes.find(b => b.id === "n1").pendingTexts,
    before.boxes.find(b => b.id === "n1").pendingTexts);
  assert.deepEqual(after.workspaces, before.workspaces);
  assert.deepEqual(after.projects, before.projects);
});

test("the board page itself may go, and the project is then left with no pages", async () => {
  const ids = (await pagesOf("facilitator")).map(p => p.id);
  assert.ok(ids.includes("pg1"), "the board page had already gone");
  let last;
  for (const id of ids) {
    last = await post(`/pages/del?owner=facilitator&id=${id}`);
    assert.equal(last.status, 200, `${id} could not be removed`);
  }
  assert.deepEqual(last.body.pages, []);
  assert.deepEqual(await pagesOf("facilitator"), []);
  assert.ok((await state()).boxes.some(b => b.owner === "facilitator"),
    "a project with no pages lost its cards");
});

test("an emptied project stays empty over a restart; only an unmigrated one is given a page", async () => {
  assert.deepEqual(await pagesOf("facilitator"), []);
  await restart();
  assert.deepEqual(await pagesOf("facilitator"), [],
    "the restart handed a deleted page back");
  assert.deepEqual((await pagesOf("pastureland")).map(p => p.id), ["pg1"]);

  // the same file with the whole record taken out is a board from before pages
  // existed, and that one is migrated onto its board page
  await stopServer();
  const saved = await persisted();
  delete saved.pages;
  delete saved.next_pgid;
  await writeFile(path.join(fixtureDir, "state.json"), JSON.stringify(saved));
  await startServer();
  const pages = (await state()).pages;
  for (const owner of ["facilitator", "pastureland", "qchat"])
    assert.deepEqual(pages[owner].map(p => p.kind), ["board"], `${owner} was not migrated`);
});

test("a page added to a project outlives the restart, in the order it was added", async () => {
  const one = (await post("/pages/new?owner=facilitator")).body.id;
  const two = (await post("/pages/new?owner=facilitator")).body.id;
  await restart();
  assert.deepEqual((await pagesOf("facilitator")).map(p => p.id), ["pg1", one, two]);
  assert.deepEqual((await pagesOf("facilitator")).map(p => p.kind), ["board", "blank", "blank"]);
  for (const id of [one, two]) assert.equal((await post(`/pages/del?owner=facilitator&id=${id}`)).status, 200);
});

test("a new project lane opens on its own board page, separate from every other", async () => {
  const made = await api(`/project?name=${encodeURIComponent("Lantern Shed")}`,
    { method: "POST", body: homedir() });
  assert.equal(made.status, 200);
  const lane = made.body.id;
  assert.deepEqual((await pagesOf(lane)).map(p => p.kind), ["board"]);
  const added = await post(`/pages/new?owner=${lane}`);
  assert.equal(added.status, 200);
  assert.equal((await pagesOf(lane)).length, 2);
  assert.equal((await pagesOf("pastureland")).length, 1,
    "a page added to the new lane reached an older one");
  await restart();
  assert.equal((await pagesOf(lane)).length, 2, "the new lane's pages did not survive the restart");
});

test("the log says a page was added and removed, and a page has no words to leak", async () => {
  const lines = [];
  for (const name of (await readdir(logs)).filter(n => n.startsWith("server-")).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n"))
      if (line !== "") lines.push(JSON.parse(line));
  }
  const added = lines.filter(l => l.kind === "page+");
  const gone = lines.filter(l => l.kind === "page-");
  assert.ok(added.length > 0 && gone.length > 0, "no page event was written");
  for (const event of [...added, ...gone]) {
    assert.match(event.box, /^pg\d+$/);
    assert.equal(event.chars, 0, "a page event counted characters it cannot have");
    assert.ok(!("text" in event), "a page event carried text into the log");
  }
});
