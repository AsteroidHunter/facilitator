const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

let child;
let fixtureDir;
let serverDir;
let origin;
let markdownFile;
let serverSource;

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

async function runCaptured(command, args, options = {}) {
  const proc = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", chunk => { stdout += chunk; });
  proc.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  const [code, signal] = await once(proc, "exit");
  clearTimeout(timer);
  return { code, signal, stdout, stderr };
}

async function failingServer(name, { config, seed, state }) {
  const dir = path.join(fixtureDir, name);
  await mkdir(dir, { recursive: true });
  const port = await freePort();
  const patched = serverSource.replace(
    "PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])",
  );
  await writeFile(path.join(dir, "server.py"), patched);
  const cfg = config || { lanes: [{ owner: "pastureland", dir }] };
  await writeFile(path.join(dir, "run.config.json"), JSON.stringify(cfg));
  if (seed !== undefined) await writeFile(path.join(dir, "seed.json"), JSON.stringify(seed));
  let stateText = null;
  if (state !== undefined) {
    stateText = JSON.stringify(state, null, 1);
    await writeFile(path.join(dir, "state.json"), stateText);
  }
  const result = await runCaptured("python3", [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
  });
  return { dir, result, stateText };
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-owner-hard-cut-"));
  serverDir = path.join(fixtureDir, "facilitator");
  const projectDir = path.join(fixtureDir, "pastureland");
  const internalDir = path.join(projectDir, "pastureland-internal");
  const wikiDir = path.join(projectDir, "pastureland-wiki");
  await mkdir(serverDir);
  await mkdir(internalDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });
  markdownFile = path.join(internalDir, "fixture.md");
  await writeFile(markdownFile, "# Pastureland\n");

  const port = await freePort();
  serverSource = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = serverSource.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, serverSource, "test server port was not patched");
  await writeFile(path.join(serverDir, "server.py"), patched);
  await writeFile(path.join(serverDir, "run.config.json"), JSON.stringify({
    lanes: [
      { owner: "facilitator", dir: serverDir },
      { owner: "pastureland", dir: projectDir },
    ],
  }));
  await writeFile(path.join(serverDir, "seed.json"), JSON.stringify({
    title: "owner hard cut",
    items: [{ id: "p1", bucket: "now", title: "Default owner" }],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(serverDir, "server.py")], {
    cwd: serverDir,
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

test("pastureland is the built-in project owner and triage is unknown", async () => {
  let result = await api("/state");
  assert.equal(result.status, 200);
  assert.equal(result.body.boxes.find(box => box.id === "p1").owner, "pastureland",
    "an ownerless seed item did not take the new built-in default");
  for (const field of ["busy", "pwds", "agents", "workspaces", "listening",
    "listenerGap"]) {
    assert.ok(Object.hasOwn(result.body[field], "pastureland"), `${field} lacks pastureland`);
    assert.ok(!Object.hasOwn(result.body[field], "triage"), `${field} still exposes triage`);
  }
  assert.ok(!Object.hasOwn(result.body.everListened, "triage"),
    "everListened still exposes triage");
  assert.ok(result.body.boxes.every(box => box.owner !== "triage"));
  assert.ok(result.body.projects.every(project => project.id !== "triage"));

  result = await api("/project?name=triage", { method: "POST" });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "reserved owner" });

  const rejected = [
    ["/worktrees?owner=triage", {}],
    ["/unread?owner=triage", {}],
    ["/wait?owner=triage&timeout=0", {}],
    ["/fresh?owner=triage", {}],
    ["/ack?owner=triage&token=stale", { method: "POST" }],
    ["/create?owner=triage", { method: "POST", body: "Old owner" }],
    ["/ws/goal?owner=triage&ws=w1", { method: "POST", body: "Old goal" }],
    ["/ws/task?owner=triage&ws=w1", { method: "POST", body: "Old task" }],
    ["/ws/current?owner=triage&ws=w1&id=t1", { method: "POST" }],
  ];
  for (const [route, options] of rejected) {
    result = await api(route, options);
    assert.equal(result.status, 400, `${route} accepted the removed owner`);
    assert.deepEqual(result.body, { error: "unknown owner" });
  }
  result = await api("/laneimg/triage/panel.png");
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "not found" });

  const persisted = JSON.parse(await readFile(path.join(serverDir, "state.json"), "utf8"));
  assert.ok(persisted.boxes.every(box => box.owner !== "triage"));
  assert.ok(persisted.projects.every(project => project.id !== "triage"));
  for (const field of ["busy", "claimed", "busy_ts", "ack", "workspaces", "ever_listened"])
    assert.ok(!Object.hasOwn(persisted[field], "triage"), `${field} persisted triage`);

  result = await api("/create?owner=pastureland", { method: "POST", body: "New owner" });
  assert.equal(result.status, 200, "the new owner could not create a card");
  const created = result.body.id;
  result = await api("/state");
  assert.equal(result.body.boxes.find(box => box.id === created).owner, "pastureland");

  result = await api("/send?box=p1", { method: "POST", body: "Explicit route" });
  assert.equal(result.status, 200);
  let delivery = await api("/wait?owner=pastureland&timeout=1&agent=test");
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.box, "p1");
  result = await api("/unread");
  assert.deepEqual(result.body, { queued: 0, claimed: 1 },
    "ownerless /unread did not default to pastureland");
  result = await api("/fresh");
  assert.equal(result.status, 200);
  assert.equal(result.body.box, "p1", "ownerless /fresh did not default to pastureland");
  result = await api(`/ack?token=${delivery.body.ack}`, { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/reply?box=p1", { method: "POST", body: "Explicit route worked" });
  assert.equal(result.status, 200);

  result = await api("/send?box=p1", { method: "POST", body: "Default route" });
  assert.equal(result.status, 200);
  delivery = await api("/wait?timeout=1&agent=test");
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.box, "p1", "ownerless /wait did not default to pastureland");
  result = await api(`/ack?owner=pastureland&token=${delivery.body.ack}`, { method: "POST" });
  assert.equal(result.status, 200);
  result = await api("/reply?box=p1", { method: "POST", body: "Default route worked" });
  assert.equal(result.status, 200);
});

test("markdown routes mount pastureland and fence out triage", async () => {
  let result = await api("/mdfiles?lane=pastureland");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.roots.map(root => [root.kind, root.root]), [
    ["internal", "pastureland-internal"],
    ["wiki", "pastureland-wiki"],
  ]);
  assert.deepEqual(result.body.roots[0].files.map(file => file.rel), ["fixture.md"]);

  result = await api("/mdfiles?lane=triage");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { roots: [] }, "removed lane still has markdown roots");
  const unknown = await api("/mdfiles?lane=arbitrary-unknown-lane");
  assert.equal(unknown.status, 200);
  assert.deepEqual(result.body, unknown.body,
    "the retired markdown listing differs from a generic unmounted lane");

  result = await api("/mdfile?lane=pastureland&root=pastureland-internal&rel=fixture.md");
  assert.equal(result.status, 200);
  assert.equal(result.body.text, "# Pastureland\n");
  const stamp = result.body.mtime;

  result = await api("/mdfile?lane=triage&root=pastureland-internal&rel=fixture.md");
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "outside the markdown folders" });

  result = await api(
    `/mdsave?lane=pastureland&root=pastureland-internal&rel=fixture.md&mtime=${stamp}`,
    { method: "POST", body: "# Updated\n" },
  );
  assert.equal(result.status, 200);
  result = await api(
    "/mdsave?lane=triage&root=pastureland-internal&rel=fixture.md",
    { method: "POST", body: "# Old owner wrote this\n" },
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: "outside the markdown folders" });
  assert.equal(await readFile(markdownFile, "utf8"), "# Updated\n",
    "a rejected triage save changed the file");
});

test("stale project registration and every stale state owner location fail startup", async () => {
  const projectState = {
    boxes: [], projects: [{ id: "triage", name: "Old project", dir: fixtureDir }],
    inbox: [], busy: {}, claimed: {}, busy_ts: {}, ack: {}, workspaces: {},
    ever_listened: {}, end: false, paused: false, next_mid: 1, next_bid: 1,
  };
  let fixture = await failingServer("stale-project", { state: projectState });
  assert.notEqual(fixture.result.code, 0);
  assert.match(fixture.result.stderr, /startup refused: state\.json requires owner migration/);
  assert.match(fixture.result.stderr, /projects\[0\]\.id='triage'/);
  assert.equal(await readFile(path.join(fixture.dir, "state.json"), "utf8"), fixture.stateText,
    "stale project state was changed before refusal");

  const staleState = {
    title: "stale owner",
    boxes: [
      { id: "t0", bucket: "meta", title: "Standing", owner: "triage", pending: [] },
      { id: "1", bucket: "now", title: "Ordinary", owner: "triage",
        pending: [{ mid: 7, text: "Preserve this", ts: 1 }] },
    ],
    projects: [], inbox: ["1"],
    busy: { pastureland: null, triage: "1" },
    claimed: { pastureland: [], triage: [7] },
    busy_ts: { pastureland: 0, triage: 123 },
    ack: { pastureland: null, triage: { box: "1", token: "old", ts: 1, confirmed: true } },
    workspaces: {
      pastureland: [{ id: "w1", name: "main", tasks: [], current: null }],
      triage: [{ id: "w1", name: "old", goal: "Keep this", tasks: [], current: null }],
    },
    ever_listened: { pastureland: true, triage: true },
    end: false, paused: false, next_mid: 8, next_bid: 2,
  };
  fixture = await failingServer("stale-modern-state", { state: staleState });
  assert.notEqual(fixture.result.code, 0);
  const error = fixture.result.stderr;
  for (const location of ["boxes[0].owner='triage'", "boxes[1].owner='triage'",
    "busy['triage']", "claimed['triage']", "busy_ts['triage']", "ack['triage']",
    "workspaces['triage']", "ever_listened['triage']"])
    assert.ok(error.includes(location), `startup error omitted ${location}`);
  assert.equal(await readFile(path.join(fixture.dir, "state.json"), "utf8"), fixture.stateText,
    "stale modern state was changed before refusal");
});

test("stale run configuration and seed owners fail clearly in server and CLI", async () => {
  let fixture = await failingServer("stale-run-config", {
    config: { lanes: [{ owner: "triage", dir: fixtureDir }] },
    seed: { title: "config failure", items: [] },
  });
  assert.notEqual(fixture.result.code, 0);
  assert.match(fixture.result.stderr,
    /startup refused: run\.config\.json requires owner migration: retired owner 'triage'/);
  assert.equal(await readFile(path.join(fixture.dir, "state.json"), "utf8").catch(() => null), null,
    "stale run configuration created state before refusal");

  fixture = await failingServer("stale-seed", {
    seed: { title: "seed failure",
      items: [{ id: "1", bucket: "now", title: "Old seed", owner: "triage" }] },
  });
  assert.notEqual(fixture.result.code, 0);
  assert.match(fixture.result.stderr, /startup refused: seed\.json requires owner migration/);
  assert.match(fixture.result.stderr, /boxes\[0\]\.owner='triage'/);
  assert.equal(await readFile(path.join(fixture.dir, "state.json"), "utf8").catch(() => null), null,
    "stale seed created state before refusal");

  const direct = await runCaptured("python3", ["-c", "import server; server._register_owner('triage')"], {
    cwd: fixture.dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: "1" },
  });
  assert.notEqual(direct.code, 0);
  assert.match(direct.stderr, /OwnerMigrationRequired: owner registration refused retired owner 'triage'/);

  const cliDir = path.join(fixtureDir, "stale-cli-config");
  await mkdir(cliDir);
  await writeFile(path.join(cliDir, "facilitator"),
    await readFile(path.join(ROOT, "facilitator"), "utf8"));
  await writeFile(path.join(cliDir, "run.config.json"), JSON.stringify({
    port: 1, lanes: [{ owner: "triage", dir: fixtureDir }],
  }));
  const cli = await runCaptured("python3", [path.join(cliDir, "facilitator"), "--dry-run"], {
    cwd: cliDir,
  });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr,
    /run\.config\.json requires owner migration: retired owner 'triage' is not allowed/);
});

test("UI owner maps, denylist, and shipped examples enforce the new owner key", async () => {
  for (const pageName of ["index.html", "page.html"]) {
    const html = await readFile(path.join(ROOT, pageName), "utf8");
    assert.match(html,
      /const METAS = \[\["toolmeta", "facilitator"\], \["triagemeta", "pastureland"\]\];/);
    assert.match(html, /pastureland: "pastureland agent"/);
    assert.match(html, /const RETIRED_OWNERS = new Set\(\["triage"\]\);/);
    assert.match(html, /function purgeRetiredOwnerStorage\(\)/);
    assert.match(html, /function validateActiveOwner\(state\)/);
  }

  const index = await readFile(path.join(ROOT, "index.html"), "utf8");
  assert.match(index, /const C3_LANE = "pastureland";/);
  assert.match(index, /pastureland:\s+\{ box: "magic4", stub: "magic box 4" \}/);

  const server = await readFile(path.join(ROOT, "server.py"), "utf8");
  assert.match(server, /OWNERS = \("facilitator", "pastureland", "qchat"\)/);
  assert.match(server, /MD_LANES = \("website", "pastureland"\)/);
  assert.match(server, /RETIRED_OWNERS = frozenset\(\{"triage"\}\)/);
  assert.match(server, /if ow in RETIRED_OWNERS:/);
  assert.match(server, /def _validate_persisted_owners\(st: dict, source: str\)/);

  const runConfig = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  assert.deepEqual(runConfig.lanes.map(lane => lane.owner), ["facilitator", "pastureland"]);
  assert.ok(runConfig.lanes[1].instruction.includes("owner=pastureland"));
  assert.ok(runConfig.lanes[1].prompt.includes("owner=pastureland"));

  const seed = JSON.parse(await readFile(path.join(ROOT, "seed.example.json"), "utf8"));
  assert.equal(seed.title, "Example project triage");
  assert.ok(seed.items.length > 0);
  assert.ok(seed.items.every(item => item.owner === "pastureland"));
});
