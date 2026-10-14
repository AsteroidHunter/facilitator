// Server contract for Omni creation. The fixture runs the shipped server on an
// ephemeral loopback port with a synthetic HOME, never the live board ports.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON ||
  path.resolve(ROOT, "..", "facilitator", ".venv", "bin", "python3");
let outer, app, port, origin, child;

async function startServer(){
  child = spawn(PYTHON, [path.join(app, "server.py")], {
    cwd: app,
    env: { ...process.env, HOME: outer, FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: path.join(outer, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]){
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 8000;
  for (;;){
    if (child.exitCode !== null) throw new Error("fixture server exited:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error("fixture server did not start:\n" + output);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function stopServer(){
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
}

async function api(route, options = {}){
  const response = await fetch(origin + route, options);
  return { status: response.status, body: await response.json() };
}
const post = (route, body = "") => api(route, { method: "POST", body });
const state = async () => (await api("/state")).body;
const lane = (snapshot, owner) => snapshot.boxes.filter(box => box.owner === owner);

before(async () => {
  outer = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-omni-")));
  app = path.join(outer, "app");
  await mkdir(app);
  port = await require("./fixture-auth.cjs").freePortPair();
  origin = `http://127.0.0.1:${port}`;
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  source = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.match(source, /FACILITATOR_TEST_PORT/, "fixture port patch did not apply");
  await writeFile(path.join(app, "server.py"), source);
  require("./fixture-auth.cjs").copyBridgeFiles(app);
  await mkdir(path.join(app, "assets"));
  for (let number = 1; number <= 3; number++)
    await copyFile(path.join(ROOT, "assets", `ticket-${number}.webp`),
      path.join(app, "assets", `ticket-${number}.webp`));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "Omni fixture",
    items: [{ id: "0", bucket: "meta", title: "Ordinary standing card", owner: "facilitator" }],
  }));
  await startServer();
});

after(async () => {
  await stopServer();
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("creation, rename, lane scope, replay and project defaults share one contract", async () => {
  const burst = await Promise.all(Array.from({ length: 8 }, () =>
    post("/create?owner=facilitator&op=omni-burst-0001", "  OmNi  \nignored")));
  assert.ok(burst.every(answer => answer.status === 200), JSON.stringify(burst));
  assert.equal(new Set(burst.map(answer => answer.body.id)).size, 1, "one operation created multiple cards");
  assert.equal(burst.filter(answer => !answer.body.replayed).length, 1);

  const second = await post("/create?owner=facilitator&op=omni-create-0002", "omni");
  const ordinary = await post("/create?owner=facilitator", "omnibus maintenance");
  const blank = await post("/create?owner=facilitator", "");
  assert.equal(second.status, 200);
  assert.equal(ordinary.status, 200);
  assert.equal(blank.status, 200);
  const renamed = await post("/title?box=" + blank.body.id, " omni ");
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.title, "Omni Ticket #3");

  let snapshot = await state();
  const facilitatorTitles = lane(snapshot, "facilitator").map(box => box.title);
  assert.ok(facilitatorTitles.includes("Omni Ticket #1"));
  assert.ok(facilitatorTitles.includes("Omni Ticket #2"));
  assert.ok(facilitatorTitles.includes("Omni Ticket #3"));
  assert.ok(facilitatorTitles.includes("omnibus maintenance"), "partial ordinary word was normalized");
  const created = snapshot.boxes.find(box => box.id === burst[0].body.id);
  assert.match(created.id, /^m\d+$/);
  assert.equal(created.bucket, "meta");
  assert.equal(created.state, "new");

  const parallel = await Promise.all([4, 5, 6].map(number =>
    post(`/create?owner=facilitator&op=omni-parallel-000${number}`, "omni")));
  assert.ok(parallel.every(answer => answer.status === 200), JSON.stringify(parallel));
  snapshot = await state();
  assert.deepEqual(
    parallel.map(answer => snapshot.boxes.find(box => box.id === answer.body.id).title).sort(),
    ["Omni Ticket #4", "Omni Ticket #5", "Omni Ticket #6"],
    "concurrent creates reused or skipped a lane number");

  const alphaDir = path.join(outer, "alpha");
  const betaDir = path.join(outer, "beta");
  const alphaTwinDir = path.join(outer, "alpha-twin");
  await mkdir(alphaDir); await mkdir(betaDir); await mkdir(alphaTwinDir);
  const alpha = await post("/project?name=Alpha", alphaDir);
  const beta = await post("/project?name=Beta", betaDir);
  const alphaTwin = await post("/project?name=Alpha", alphaTwinDir);
  assert.equal(alpha.status, 200);
  assert.equal(beta.status, 200);
  assert.equal(alphaTwin.status, 200);
  assert.equal(alphaTwin.body.id, "alpha-2", "repeated project creation lost its existing slug semantics");
  snapshot = await state();
  for (const owner of [alpha.body.id, beta.body.id, alphaTwin.body.id]){
    const boxes = lane(snapshot, owner);
    assert.equal(boxes.length, 1, `${owner} did not start with exactly one card`);
    assert.equal(boxes[0].title, "Omni Ticket #1");
    assert.match(boxes[0].id, /^m\d+$/, "default Omni card lost the normal id contract");
  }

  const alphaSecond = await post("/create?owner=" + alpha.body.id + "&op=alpha-omni-0002", "OMNI");
  assert.equal(alphaSecond.status, 200);
  snapshot = await state();
  assert.deepEqual(lane(snapshot, alpha.body.id).map(box => box.title).sort(),
    ["Omni Ticket #1", "Omni Ticket #2"]);
  assert.deepEqual(lane(snapshot, beta.body.id).map(box => box.title), ["Omni Ticket #1"]);

  await stopServer();
  await startServer();
  const replay = await post("/create?owner=" + alpha.body.id + "&op=alpha-omni-0002", "OMNI");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.id, alphaSecond.body.id);
  snapshot = await state();
  assert.equal(lane(snapshot, alpha.body.id).filter(box => box.title === "Omni Ticket #1").length, 1,
    "restart duplicated the initial project card");
  assert.equal(lane(snapshot, alpha.body.id).filter(box => box.title === "Omni Ticket #2").length, 1,
    "operation replay duplicated the second Omni card");
  assert.equal(lane(snapshot, beta.body.id).length, 1, "restart changed another project lane");
  assert.equal(lane(snapshot, alphaTwin.body.id).length, 1,
    "restart duplicated the repeated project's initial card");
});

test("the product asset routes return the exact optimized artwork bytes", async () => {
  for (let number = 1; number <= 3; number++){
    const response = await fetch(`${origin}/assets/ticket-${number}.webp`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    const routed = Buffer.from(await response.arrayBuffer());
    const shipped = await readFile(path.join(ROOT, "assets", `ticket-${number}.webp`));
    assert.deepEqual(routed, shipped, `ticket-${number} route changed the asset bytes`);
  }
});
