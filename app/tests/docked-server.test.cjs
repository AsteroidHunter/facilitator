// Real HTTP and durable state, on a copied server and adjacent free loopback ports.
// FACILITATOR_TEST_SERVER_SOURCE permits checking these assertions against an
// isolated baseline without changing the shared checkout or the live board.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, fixtureDir, origin, output = "";

async function api(route, body) {
  const response = await fetch(origin + route, body === undefined ? {} : { method: "POST", body });
  const raw = await response.text();
  let answer;
  try { answer = JSON.parse(raw); } catch { answer = raw; }
  return { status: response.status, body: answer };
}
async function post(route, body = "") {
  const answer = await api(route, body);
  assert.equal(answer.status, 200, `${route}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}
const make = async title => (await post("/create?owner=facilitator", title)).id;
const desk = async id => (await api("/state")).body.boxes.find(b => b.id === id);
const phone = async id => (await api("/m/state?since=")).body.boxes.find(b => b.id === id);
const saved = async id => JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8")).boxes.find(b => b.id === id);
const flags = card => [card.docked, card.parked, card.done];
const stamps = card => [card.dockedTs, card.parkedTs, card.doneTs];

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-docked-server-"));
  const port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(process.env.FACILITATOR_TEST_SERVER_SOURCE || path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace("def _tailscale_command() -> str | None:", "def _tailscale_command() -> str | None:\n    return None  # isolated fixture");
  assert.notEqual(patched, source);
  assert.match(patched, /return None  # isolated fixture/);
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Docked fixture", items: [{ id: "seed", bucket: "now", title: "Seed card", owner: "facilitator" }],
  }));
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await pause(25);
  }
  throw new Error(`fixture did not start:\n${output}`);
});
after(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("seeded and newly created cards start in Doing with Docked false and no time", async () => {
  const result = await post("/create?owner=facilitator", "Created card");
  assert.equal(result.card.docked, false, "create's immediate card includes docked");
  assert.equal(result.card.dockedTs, 0);
  for (const id of ["seed", result.id]) {
    for (const read of [desk, phone]) {
      assert.deepEqual(flags(await read(id)), [false, false, false]);
      assert.deepEqual(stamps(await read(id)), [0, 0, 0]);
    }
    assert.equal((await saved(id)).docked, false);
    assert.ok(!("docked_ts" in await saved(id)));
  }
});

test("dock and undock retain, remove and replace their time and write transcript rows", async () => {
  const id = await make("Dock times");
  const first = await post(`/dock?box=${id}&v=1`);
  assert.deepEqual(flags(first), [true, false, false]);
  assert.ok(first.dockedTs > 0);
  assert.equal(first.dockedTs, (await saved(id)).docked_ts);
  assert.equal((await post(`/dock?box=${id}&v=1`)).dockedTs, first.dockedTs, "repeated dock keeps its place");
  const off = await post(`/dock?box=${id}&v=0`);
  assert.deepEqual(flags(off), [false, false, false]);
  assert.deepEqual(stamps(off), [0, 0, 0]);
  assert.ok(!("docked_ts" in await saved(id)));
  await pause(15);
  const again = await post(`/dock?box=${id}`);
  assert.ok(again.dockedTs > first.dockedTs);
  const rows = (await readFile(path.join(fixtureDir, "transcript.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.filter(r => r.box === id && ["dock", "undock"].includes(r.kind)).map(r => r.kind),
    ["dock", "dock", "undock", "dock"]);
});

test("Docked keeps work and reply colors, and a page that ignores docked sees Doing", async () => {
  const id = await make("Normal colors");
  await post(`/working?box=${id}&v=1`);
  await post(`/dock?box=${id}&v=1`);
  for (const read of [desk, phone]) {
    const card = await read(id);
    assert.equal(card.docked, true);
    assert.equal(card.state, "working", "working green is retained");
    const { docked, dockedTs, ...legacyCard } = card;
    assert.deepEqual([legacyCard.done, legacyCard.parked], [false, false], "old pages put the card in Doing");
  }
  await post(`/working?box=${id}&v=0`);
  await post(`/reply?box=${id}`, "An answer is waiting.");
  for (const read of [desk, phone]) {
    assert.equal((await read(id)).docked, true, "agent reply does not undock");
    assert.equal((await read(id)).state, "yours", "reply color is retained");
  }
});

test("docking, Deferred, Done, close and owner messages clear the other section and its time", async () => {
  const id = await make("Section moves");
  await post(`/park?box=${id}&v=1`);
  const dock = await post(`/dock?box=${id}&v=1`);
  assert.deepEqual(flags(dock), [true, false, false]);
  assert.equal(dock.parkedTs, 0);
  const park = await post(`/park?box=${id}&v=1`);
  assert.deepEqual(flags(park), [false, true, false]);
  assert.equal(park.dockedTs, 0);
  assert.ok(!("docked_ts" in await saved(id)));
  await post(`/dock?box=${id}&v=1`);
  await post(`/done?box=${id}&v=1`);
  assert.deepEqual(flags(await desk(id)), [false, false, true]);
  assert.equal((await desk(id)).dockedTs, 0);
  assert.ok(!("docked_ts" in await saved(id)));
  const fromDone = await post(`/dock?box=${id}&v=1`);
  assert.deepEqual(flags(fromDone), [true, false, false]);
  assert.equal(fromDone.doneTs, 0);
  await post(`/send?box=${id}`, "Resume this card.");
  assert.deepEqual(flags(await desk(id)), [false, false, false]);
  assert.deepEqual(stamps(await desk(id)), [0, 0, 0]);
  assert.equal((await desk(id)).state, "queued");
  assert.ok(!("docked_ts" in await saved(id)));
  await post(`/dock?box=${id}&v=1`);
  assert.equal((await post(`/close?box=${id}`)).action, "done");
  assert.deepEqual(flags(await desk(id)), [false, false, true]);
  assert.equal((await desk(id)).dockedTs, 0);
});

test("phone lean readings include docking and the owner message's return to Doing", async () => {
  const id = await make("Lean docking");
  const held = (await api("/m/state?since=")).body;
  await post(`/dock?box=${id}&v=1`);
  const lean = (await api(`/m/state?since=${held.rev}&delta=${held.epoch}`)).body;
  assert.equal(lean.delta, held.rev);
  const card = lean.boxes.find(b => b.id === id);
  assert.deepEqual(flags(card), [true, false, false]);
  assert.ok(card.dockedTs > 0);
  assert.equal(card.dockedTs, (await desk(id)).dockedTs);
  await post(`/send?box=${id}`, "Back to Doing.");
  const next = (await api(`/m/state?since=${lean.rev}&delta=${lean.epoch}`)).body;
  assert.equal(next.delta, lean.rev);
  const moved = next.boxes.find(b => b.id === id);
  assert.deepEqual(flags(moved), [false, false, false]);
  assert.equal(moved.dockedTs, 0);
});

test("the dock guard rejects stale messages, malformed orders and missing cards", async () => {
  const id = await make("Dock guard");
  await post(`/send?box=${id}`, "A newer owner message.");
  const refused = await post(`/dock?box=${id}&v=1&after=1&sid=page&seq=2`);
  assert.equal(refused.stale, "message");
  assert.deepEqual(flags(refused), [false, false, false]);
  assert.deepEqual(stamps(refused), [0, 0, 0]);
  assert.equal((await post(`/dock?box=${id}&v=1&sid=page&seq=1`)).stale, "superseded");
  assert.equal((await post(`/dock?box=${id}&v=1`)).ok, true, "old pages may omit the basis and order");
  assert.equal((await post(`/dock?box=${id}&v=0&after=1`)).ok, true, "a message never blocks undock");
  assert.equal((await post(`/dock?box=${id}&v=1&after=invalid`)).ok, true);
  for (const query of ["sid=page", "seq=1", "sid=page&seq=-1", "sid=page&seq=1.5", "sid=bad%20name&seq=1"]) {
    const result = await api(`/dock?box=${id}&${query}`, "");
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "bad dock order");
  }
  assert.equal((await api("/dock?box=missing", "")).status, 400);
});

test("one page's newer section command wins across Docked, Deferred, Done and close", async () => {
  for (const last of ["dock", "park", "done", "close"]) {
    const id = await make(`Order ${last}`);
    await post(`/send?box=${id}`, "A conversation worth keeping.");
    await post(`/${last}?box=${id}&v=1&sid=pageA&seq=4`);
    const desired = flags(await desk(id));
    for (const older of ["dock", "park", "done", "close"]) {
      const refused = await post(`/${older}?box=${id}&v=1&sid=pageA&seq=3`);
      assert.equal(refused.stale, "superseded", `${older} must not undo ${last}`);
      assert.deepEqual(flags(refused), desired);
      assert.deepEqual(flags(await desk(id)), desired);
    }
    const other = await post(`/dock?box=${id}&v=0&sid=pageB&seq=1`);
    assert.equal(other.ok, true, "another page keeps its own order");
    assert.equal((await post(`/dock?box=${id}&v=1&sid=pageA&seq=2`)).stale, "superseded",
      "another page must not erase this page's newest command");
  }
});
