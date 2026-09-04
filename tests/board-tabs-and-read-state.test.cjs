// The two records the board keeps for both of its pages: which project tabs
// the bar shows and in what order, and how many of each card's replies have
// been read. Both live in state.json rather than in one browser, so the board
// and the phone show the same bar and the same read marks. Server side only:
// the round trips, the refusals, and what survives a restart.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
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

async function settle(ms = 25) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function state() {
  return (await fetch(origin + "/state")).json();
}

async function seenOf(id) {
  return (await state()).boxes.find(box => box.id === id).seen;
}

// every line the board has written, in order
async function events() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

// the overwrite notices written since the last time this was called
let readSoFar = 0;
async function overwritesSince() {
  const all = await events();
  const fresh = all.slice(readSoFar);
  readSoFar = all.length;
  return fresh.filter(event => event.kind === "overwrite");
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
  const deadline = Date.now() + 5000;
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

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tabs-seen-"));
  logs = path.join(fixtureDir, "logs");
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await copyFile(path.join(ROOT, "m-manifest.json"), path.join(fixtureDir, "m-manifest.json"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Tabs And Read State",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland" },
    ],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a board with no saved arrangement hands out an empty tab record", async () => {
  assert.deepEqual((await state()).tabs, { order: [], closed: [] });
});

test("every card starts with no replies read", async () => {
  for (const box of (await state()).boxes) assert.equal(box.seen, 0);
});

test("the tab record goes round: what is written comes back on the next read", async () => {
  const written = await post("/tabs", JSON.stringify({
    order: ["pastureland", "facilitator"], closed: ["qchat"],
  }));
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.tabs, { order: ["pastureland", "facilitator"], closed: ["qchat"] });
  assert.deepEqual((await state()).tabs, { order: ["pastureland", "facilitator"], closed: ["qchat"] });
});

test("a tab named twice is stored once, in the place it was first named", async () => {
  const written = await post("/tabs", JSON.stringify({
    order: ["facilitator", "pastureland", "facilitator"], closed: [],
  }));
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.tabs.order, ["facilitator", "pastureland"]);
});

test("a tab record naming a lane this board does not have is refused whole", async () => {
  const before = (await state()).tabs;
  for (const bad of [
    { order: ["facilitator", "no-such-lane"], closed: [] },
    { order: [], closed: ["no-such-lane"] },
    { order: [7], closed: [] },
  ]) {
    const refused = await post("/tabs", JSON.stringify(bad));
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "unknown owner");
  }
  assert.deepEqual((await state()).tabs, before, "a refused record changed the stored one");
});

test("a tab record of the wrong shape is refused", async () => {
  const before = (await state()).tabs;
  for (const bad of ['{"order":"facilitator","closed":[]}', '{"closed":[]}',
                     '{"order":[]}', '["facilitator"]', "not json", ""]) {
    const refused = await post("/tabs", bad);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "bad tab record");
  }
  assert.deepEqual((await state()).tabs, before);
});

test("read counts go round: several cards in one write, each on its own box", async () => {
  const written = await post("/seen", JSON.stringify({ "0": 3, "1.1": 1 }));
  assert.equal(written.status, 200);
  assert.deepEqual(written.body.seen, { "0": 3, "1.1": 1 });
  assert.equal(await seenOf("0"), 3);
  assert.equal(await seenOf("1.1"), 1);
  const again = await post("/seen", JSON.stringify({ "0": 5 }));
  assert.equal(again.status, 200);
  assert.equal(await seenOf("0"), 5);
  assert.equal(await seenOf("1.1"), 1, "one card's mark moved another card's");
});

test("a count that is not a whole number, or is below zero, is refused", async () => {
  const before = await seenOf("0");
  for (const bad of [-1, 1.5, true, null, "2"]) {
    const refused = await post("/seen", JSON.stringify({ "0": bad }));
    assert.equal(refused.status, 400, `${bad} was accepted as a count`);
    assert.equal(refused.body.error, "bad count");
  }
  assert.equal(await seenOf("0"), before);
});

test("a read count for a card this board does not have is refused whole", async () => {
  const before = await seenOf("0");
  const refused = await post("/seen", JSON.stringify({ "0": 9, "no-such-box": 1 }));
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "bad box");
  assert.equal(await seenOf("0"), before, "a refused write landed on the good half");
});

test("an empty or misshapen read record is refused", async () => {
  for (const bad of ["{}", "[]", '"3"', "not json", ""]) {
    const refused = await post("/seen", bad);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "bad seen record");
  }
});

test("both records are still there after the server is restarted", async () => {
  await post("/tabs", JSON.stringify({ order: ["pastureland", "facilitator"], closed: ["qchat"] }));
  await post("/seen", JSON.stringify({ "0": 4, "1.1": 2 }));
  const saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
  assert.deepEqual(saved.tabs, { order: ["pastureland", "facilitator"], closed: ["qchat"] });
  assert.equal(saved.boxes.find(box => box.id === "0").seen, 4);

  await stopServer();
  await startServer();

  const back = await state();
  assert.deepEqual(back.tabs, { order: ["pastureland", "facilitator"], closed: ["qchat"] });
  assert.equal(back.boxes.find(box => box.id === "0").seen, 4);
  assert.equal(back.boxes.find(box => box.id === "1.1").seen, 2);
});

test("a card made after the records existed carries a read count of its own", async () => {
  const made = await post("/create?owner=facilitator", "A card made later");
  assert.equal(made.status, 200);
  assert.equal(await seenOf(made.body.id), 0);
  assert.equal((await post("/seen", JSON.stringify({ [made.body.id]: 1 }))).status, 200);
  assert.equal(await seenOf(made.body.id), 1);
});

test("the phone app's name is the saved board title, and nothing else moves", async () => {
  const written = JSON.parse(await readFile(path.join(ROOT, "m-manifest.json"), "utf8"));
  const served = await fetch(origin + "/m-manifest.json");
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /manifest\+json/);
  const body = await served.json();
  assert.equal(body.name, "Tabs And Read State");
  assert.equal(body.short_name, "Tabs And Read State");
  assert.equal(body.name, (await state()).title, "the app's name and the board's title differ");
  // one name, and the file keeps every other word it was written with
  for (const field of Object.keys(written)) {
    if (field === "name" || field === "short_name") continue;
    assert.deepEqual(body[field], written[field], field);
  }
  assert.deepEqual(Object.keys(body).sort(), Object.keys(written).sort());
});

// ---- the overwrite notice --------------------------------------------------
// Both routes replace a record whole, and each page holds its own write on top
// of the server's answer for three seconds, so a second write inside that
// window throws the first one away and the losing page never learns it lost.
// The board cannot say which device lost, since neither route carries any
// identity; it says that it happened, what changed, and how far apart.

test("two different tab orders inside the window leave one notice with the gap", async () => {
  await overwritesSince();
  assert.equal((await post("/tabs", JSON.stringify({
    order: ["facilitator", "pastureland"], closed: [],
  }))).status, 200);
  await settle(200);
  assert.equal((await post("/tabs", JSON.stringify({
    order: ["pastureland", "facilitator"], closed: [],
  }))).status, 200);

  const notices = await overwritesSince();
  assert.equal(notices.length, 1, `${notices.length} notices for one overwrite`);
  assert.equal(notices[0].level, "info");
  assert.equal(notices[0].record, "tabs");
  assert.equal(notices[0].field, "order");
  assert.ok(notices[0].ms >= 150 && notices[0].ms < 3000, `the gap reads ${notices[0].ms} ms`);
  assert.equal(notices[0].box, undefined, "the tab bar is not one card's record");
});

test("the same tab order written twice overwrites nothing and says nothing", async () => {
  const same = JSON.stringify({ order: ["facilitator", "pastureland"], closed: [] });
  assert.equal((await post("/tabs", same)).status, 200);
  await overwritesSince();
  await settle(150);
  assert.equal((await post("/tabs", same)).status, 200);
  assert.deepEqual(await overwritesSince(), []);
});

test("two different read marks on one card inside the window leave a notice", async () => {
  assert.equal((await post("/seen", JSON.stringify({ "1.1": 1 }))).status, 200);
  await overwritesSince();
  await settle(150);
  assert.equal((await post("/seen", JSON.stringify({ "1.1": 2 }))).status, 200);

  const notices = await overwritesSince();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].record, "seen");
  assert.equal(notices[0].field, "count");
  assert.equal(notices[0].box, "1.1", "the notice does not name the card");
  assert.ok(notices[0].ms >= 100 && notices[0].ms < 3000);
});

test("writes far enough apart are two arrangements, not one overwriting another", async () => {
  assert.equal((await post("/tabs", JSON.stringify({
    order: ["facilitator", "pastureland"], closed: [],
  }))).status, 200);
  await overwritesSince();
  await settle(4000);
  assert.equal((await post("/tabs", JSON.stringify({
    order: ["pastureland", "facilitator"], closed: ["qchat"],
  }))).status, 200);
  assert.deepEqual(await overwritesSince(), []);
});
