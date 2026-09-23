// A project lane stays isolated when facilitator is the only built-in owner.
// The lane joins from run.config.json and a saved card, an owner no data names
// is refused everywhere, and the file navigator mounts only the configured
// lanes and fences one lane out of another's folders. Invented lane names only.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PROJECT = "orchard";    // a project lane, given by run.config.json and a saved card
const STRANGER = "almanac";   // a lane no config, card or seed names

let child;
let fixtureDir;
let serverDir;
let markdownFile;
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

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-owner-hard-cut-"));
  serverDir = path.join(fixtureDir, "facilitator");
  const projectDir = path.join(fixtureDir, PROJECT);
  const internalDir = path.join(projectDir, PROJECT + "-internal");
  const wikiDir = path.join(projectDir, PROJECT + "-wiki");
  await mkdir(serverDir);
  await mkdir(internalDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });
  markdownFile = path.join(internalDir, "fixture.md");
  await writeFile(markdownFile, "# Notes\n");

  const port = await freePort();
  const serverSource = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = serverSource.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, serverSource, "test server port was not patched");
  await writeFile(path.join(serverDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(serverDir, "server.py")));
  await writeFile(path.join(serverDir, "run.config.json"), JSON.stringify({
    lanes: [
      { owner: "facilitator", dir: serverDir },
      { owner: PROJECT, dir: projectDir },
    ],
    navigator_lanes: [PROJECT],
  }));
  await writeFile(path.join(serverDir, "seed.json"), JSON.stringify({
    title: "owner hard cut",
    items: [
      { id: "0", bucket: "meta", owner: "facilitator", title: "Tool standing" },
      { id: "p1", bucket: "now", title: "Ownerless card" },
      { id: "c1", bucket: "now", owner: PROJECT, title: "Project card" },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(serverDir, "server.py")], {
    cwd: serverDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: serverDir },
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

test("a configured lane is a full owner and an unnamed lane is refused", async () => {
  let result = await api("/state");
  assert.equal(result.status, 200);
  assert.equal(result.body.boxes.find(box => box.id === "p1").owner, "facilitator",
    "an ownerless seed item did not default to the tool lane");
  assert.equal(result.body.boxes.find(box => box.id === "c1").owner, PROJECT);

  for (const field of ["busy", "pwds", "agents", "workspaces", "listening", "listenerGap"]) {
    assert.ok(Object.hasOwn(result.body[field], PROJECT), `${field} lacks the configured lane`);
    assert.ok(Object.hasOwn(result.body[field], "facilitator"), `${field} lacks facilitator`);
    assert.ok(!Object.hasOwn(result.body[field], STRANGER), `${field} exposed an unnamed lane`);
  }

  const rejected = [
    ["/worktrees?owner=" + STRANGER, {}],
    ["/unread?owner=" + STRANGER, {}],
    ["/wait?owner=" + STRANGER + "&timeout=0", {}],
    ["/fresh?owner=" + STRANGER, {}],
    ["/ack?owner=" + STRANGER + "&token=stale", { method: "POST" }],
    ["/create?owner=" + STRANGER, { method: "POST", body: "No lane" }],
    ["/ws/goal?owner=" + STRANGER + "&ws=w1", { method: "POST", body: "No goal" }],
    ["/ws/task?owner=" + STRANGER + "&ws=w1", { method: "POST", body: "No task" }],
    ["/ws/current?owner=" + STRANGER + "&ws=w1&id=t1", { method: "POST" }],
  ];
  for (const [route, options] of rejected) {
    result = await api(route, options);
    assert.equal(result.status, 400, `${route} accepted an unnamed lane`);
    assert.deepEqual(result.body, { error: "unknown owner" });
  }
  result = await api("/laneimg/" + STRANGER + "/panel.png");
  assert.equal(result.status, 404);

  // the configured lane routes its own card end to end
  result = await api("/create?owner=" + PROJECT, { method: "POST", body: "Made by the lane" });
  assert.equal(result.status, 200, "the configured lane could not create a card");

  result = await api("/send?box=c1", { method: "POST", body: "Explicit route" });
  assert.equal(result.status, 200);
  let delivery = await api("/wait?owner=" + PROJECT + "&timeout=1&agent=test");
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.box, "c1", "the lane's queued card did not claim on its own lane");
  result = await api("/ack?owner=" + PROJECT + "&token=" + delivery.body.ack, { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/reply?box=c1", { method: "POST", body: "Answered" });
  assert.equal(result.status, 200);

  // an ownerless call is the tool lane's, never a project's
  result = await api("/send?box=p1", { method: "POST", body: "Default route" });
  assert.equal(result.status, 200);
  delivery = await api("/wait?timeout=1&agent=test");
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.box, "p1", "ownerless /wait did not default to facilitator");
  result = await api("/unread");
  assert.deepEqual(result.body, { queued: 0, claimed: 1 }, "ownerless /unread did not default to facilitator");
  result = await api("/fresh");
  assert.equal(result.body.box, "p1", "ownerless /fresh did not default to facilitator");
  result = await api("/ack?token=" + delivery.body.ack, { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/reply?box=p1", { method: "POST", body: "Default route worked" });
  assert.equal(result.status, 200);
});

test("navigator routes mount the configured lane and fence others out", async () => {
  let result = await api("/navfiles?lane=" + PROJECT);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.roots.map(root => [root.kind, root.root]), [
    ["internal", PROJECT + "-internal"],
    ["wiki", PROJECT + "-wiki"],
  ]);
  assert.deepEqual(result.body.roots[0].files.map(file => file.rel), ["fixture.md"]);

  // facilitator is a real owner but is not a navigator lane, so it has no folders
  result = await api("/navfiles?lane=facilitator");
  assert.deepEqual(result.body, { roots: [] }, "a lane off the navigator list still has folders");
  const unknown = await api("/navfiles?lane=" + STRANGER);
  assert.deepEqual(unknown.body, { roots: [] });

  result = await api("/navfile?lane=" + PROJECT + "&root=" + PROJECT + "-internal&rel=fixture.md");
  assert.equal(result.status, 200);
  assert.equal(result.body.text, "# Notes\n");
  const stamp = result.body.mtime;

  // no other lane can reach this lane's folders
  result = await api("/navfile?lane=facilitator&root=" + PROJECT + "-internal&rel=fixture.md");
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "outside the navigator folders" });

  result = await api(
    "/navsave?lane=" + PROJECT + "&root=" + PROJECT + "-internal&rel=fixture.md&mtime=" + stamp,
    { method: "POST", body: "# Updated\n" });
  assert.equal(result.status, 200);
  result = await api("/navsave?lane=facilitator&root=" + PROJECT + "-internal&rel=fixture.md",
    { method: "POST", body: "# Reached across\n" });
  assert.equal(result.status, 400);
  assert.equal(await readFile(markdownFile, "utf8"), "# Updated\n",
    "a fenced-out save changed the file");
});

test("shipped source and examples carry no built-in project owner", async () => {
  const server = await readFile(path.join(ROOT, "server.py"), "utf8");
  assert.match(server, /BUILTIN_OWNERS = \("facilitator",\)/);
  assert.match(server, /NAV_LANES = _navigator_lanes\(\)/);
  assert.doesNotMatch(server, /RETIRED_OWNERS/);
  assert.doesNotMatch(server, /OwnerMigrationRequired/);
  assert.doesNotMatch(server, /pastureland|qchat/);

  const runConfig = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  assert.deepEqual(runConfig.lanes.map(lane => lane.owner), ["facilitator", "example"]);
  assert.ok(Array.isArray(runConfig.navigator_lanes));
  assert.ok(runConfig.lanes[1].prompt.includes("owner=example"));

  const seed = JSON.parse(await readFile(path.join(ROOT, "seed.example.json"), "utf8"));
  assert.ok(seed.items.some(item => item.bucket === "meta" && item.owner === "facilitator"),
    "the example seed has no neutral standing card");
  assert.ok(seed.items.every(item => item.owner !== "pastureland"));

  for (const page of ["index.html", "page.html", "m.html"]) {
    const html = await readFile(path.join(ROOT, page), "utf8");
    assert.doesNotMatch(html, /pastureland/, `${page} still names a project lane`);
  }
});
