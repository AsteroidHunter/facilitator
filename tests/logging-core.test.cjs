// The server's own log: where the folder lands, what one line looks like, which
// lines the level lets through, and that a file can neither grow without a
// bound nor pile up without one. The logger is driven directly, by importing a
// patched copy of the server in a temporary folder, so these run in a second
// and no socket is ever bound. The suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const MAX_BYTES = 5 * 1024 * 1024;

let outer;        // the fixture's wrapper: the sibling internal folder lands here
let appDir;       // the copy of the server, one level in, exactly as the real one sits
let port;

function today() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}`;
}

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

// one run of python against the patched server module: it imports the file and
// calls into the logger, and never starts a server
async function probe(code, env = {}) {
  const clean = { ...process.env, FACILITATOR_TEST_PORT: String(port) };
  delete clean.FACILITATOR_LOG_LEVEL;
  delete clean.FACILITATOR_LOG_DIR;
  return execFileAsync("python3", ["-c", code], {
    cwd: appDir,
    env: { ...clean, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function freshLogDir(name) {
  const dir = path.join(outer, name);
  await rm(dir, { recursive: true, force: true });
  return dir;
}

async function linesIn(dir, file = `server-${today()}.log`) {
  const text = await readFile(path.join(dir, file), "utf8");
  return text.split("\n").filter(line => line !== "");
}

async function eventsIn(dir, file) {
  return (await linesIn(dir, file)).map(line => JSON.parse(line));
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-logging-core-"));
  appDir = path.join(outer, "app");
  await mkdir(appDir);
  port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(appDir, "server.py"), patched);
});

after(async () => {
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("the folder is the fixture's own sibling internal folder and nowhere else", async () => {
  await probe("import server; server._info('probe', 'm1', n=1)");
  const derived = path.join(outer, "facilitator-internal", "logs");
  const files = await readdir(derived);
  assert.deepEqual(files, [`server-${today()}.log`]);
  assert.equal((await eventsIn(derived))[0].kind, "probe");
  await assert.rejects(readdir(path.join(appDir, "facilitator-internal")),
    "the log folder was made inside the server's own folder");
  await assert.rejects(readdir(path.join(appDir, "logs")));
});

test("every line is one JSON object with a dated UTC stamp, a level and a kind", async () => {
  const dir = await freshLogDir("shape");
  await probe([
    "import server",
    "server._info('start', port=1234, boxes=2)",
    "server._info('user', 'm7', chars=41)",
    "server._error('savefail', step='write', reason='Permission denied')",
  ].join("\n"), { FACILITATOR_LOG_DIR: dir });

  const events = await eventsIn(dir);
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // the stamp is UTC and is this moment, not a local clock read
    assert.ok(Math.abs(Date.parse(event.ts) - Date.now()) < 60000, `stale stamp ${event.ts}`);
    assert.ok(["info", "debug", "error"].includes(event.level), event.level);
    assert.ok(event.kind && typeof event.kind === "string");
  }
  assert.deepEqual(events[0], { ...events[0], level: "info", kind: "start", port: 1234, boxes: 2 });
  assert.equal(events[0].box, undefined, "an event that belongs to no card carries a box");
  assert.equal(events[1].box, "m7");
  assert.equal(events[2].level, "error");
});

test("the same event reaches the terminal in a short human form, never as JSON", async () => {
  const dir = await freshLogDir("mirror");
  const { stdout } = await probe(
    "import server; server._info('refusal', 'm3', route='/reply', code=400, reason='bad box')",
    { FACILITATOR_LOG_DIR: dir });
  assert.match(stdout, /^\d{2}:\d{2}:\d{2} +refusal +\[m3\] +route=\/reply code=400 reason=bad box$/m);
  assert.doesNotMatch(stdout, /[{}]/, "the terminal was handed JSON");
  // a kind longer than the column still keeps its gap, which the padded print
  // this replaces did not: workdone[m366] went out with no separator at all
  const { stdout: long } = await probe(
    "import server; server._info('workdone', 'm366')", { FACILITATOR_LOG_DIR: dir });
  assert.match(long, /workdone +\[m366\]/);
});

test("the default level is info: debug is not written, info and error are", async () => {
  const dir = await freshLogDir("default");
  await probe([
    "import server",
    "server._debug('request', route='/state')",
    "server._info('user', 'm1', chars=3)",
    "server._error('savefail', step='write')",
  ].join("\n"), { FACILITATOR_LOG_DIR: dir });
  assert.deepEqual((await eventsIn(dir)).map(e => e.kind), ["user", "savefail"]);
});

test("the environment variable raises the level to debug and lowers it to error", async () => {
  const write = [
    "import server",
    "server._debug('request', route='/state')",
    "server._info('user', 'm1', chars=3)",
    "server._error('savefail', step='write')",
  ].join("\n");

  const debugDir = await freshLogDir("debug");
  await probe(write, { FACILITATOR_LOG_DIR: debugDir, FACILITATOR_LOG_LEVEL: "debug" });
  assert.deepEqual((await eventsIn(debugDir)).map(e => e.kind), ["request", "user", "savefail"]);

  const errorDir = await freshLogDir("error");
  await probe(write, { FACILITATOR_LOG_DIR: errorDir, FACILITATOR_LOG_LEVEL: "error" });
  assert.deepEqual((await eventsIn(errorDir)).map(e => e.kind), ["savefail"]);
});

test("the level comes from the config file, and the environment variable beats it", async () => {
  const config = path.join(appDir, "run.config.json");
  const write = "import server; server._debug('request', route='/state'); server._info('user', 'm1')";
  try {
    await writeFile(config, JSON.stringify({ port: 1, log_level: "debug", lanes: [] }));
    const fromConfig = await freshLogDir("config");
    await probe(write, { FACILITATOR_LOG_DIR: fromConfig });
    assert.deepEqual((await eventsIn(fromConfig)).map(e => e.kind), ["request", "user"]);

    const overridden = await freshLogDir("override");
    await probe(write, { FACILITATOR_LOG_DIR: overridden, FACILITATOR_LOG_LEVEL: "error" });
    assert.deepEqual(await eventsIn(overridden), [],
      "the variable did not beat the config file");
  } finally {
    await rm(config, { force: true });
  }
});

test("a level nobody has heard of falls back to info instead of failing to start", async () => {
  const config = path.join(appDir, "run.config.json");
  try {
    const fromEnv = await freshLogDir("badenv");
    const run = await probe(
      "import server; print(server.LOG_LEVEL); server._debug('request'); server._info('user', 'm1')",
      { FACILITATOR_LOG_DIR: fromEnv, FACILITATOR_LOG_LEVEL: "chatty" });
    assert.match(run.stdout, /^info$/m);
    assert.deepEqual((await eventsIn(fromEnv)).map(e => e.kind), ["user"]);

    await writeFile(config, "{ not json at all");
    const broken = await freshLogDir("badconfig");
    const second = await probe("import server; print(server.LOG_LEVEL); server._info('user', 'm1')",
      { FACILITATOR_LOG_DIR: broken });
    assert.match(second.stdout, /^info$/m);
    assert.deepEqual((await eventsIn(broken)).map(e => e.kind), ["user"]);
  } finally {
    await rm(config, { force: true });
  }
});

test("a multi-line traceback is one line in the file and is still whole", async () => {
  const dir = await freshLogDir("trace");
  const { stdout } = await probe([
    "import server, traceback",
    "try:",
    "    raise ValueError('the board tripped')",
    "except ValueError:",
    "    server._error('boom', trace=traceback.format_exc())",
  ].join("\n"), { FACILITATOR_LOG_DIR: dir });

  const lines = await linesIn(dir);
  assert.equal(lines.length, 1, "a traceback broke one event into several lines");
  const event = JSON.parse(lines[0]);
  assert.ok(event.trace.split("\n").length > 2, "the traceback was flattened away");
  assert.match(event.trace, /ValueError: the board tripped/);
  // and it stays out of the terminal, which is what keeps a losing start quiet
  assert.doesNotMatch(stdout, /Traceback/);
});

test("a file rolls at the cap, and the newest file holds the newest event", async () => {
  const dir = await freshLogDir("rotate");
  await probe([
    "import server",
    "for n in range(60000):",
    "    server._info('request', 'm1', route='/state', code=200, ms=3, n=n)",
    "server._info('last', 'm1', marker='the newest event')",
  ].join("\n"), { FACILITATOR_LOG_DIR: dir });

  const files = (await readdir(dir)).sort();
  assert.ok(files.length > 1, `one file held every line: ${files.join(", ")}`);
  for (const name of files) {
    const size = (await stat(path.join(dir, name))).size;
    assert.ok(size <= MAX_BYTES + 4096, `${name} passed the cap by more than one line (${size})`);
  }
  // the plain name is the day's first file; a roll on the same day appends .1,
  // so the highest roll is the newest
  const newest = files.filter(name => /\.\d+\.log$/.test(name)).sort().at(-1);
  const events = await eventsIn(dir, newest);
  assert.equal(events.at(-1).kind, "last");
  assert.equal(events.at(-1).marker, "the newest event");
});

test("a roll leaves thirty files and deletes the rest, oldest first", async () => {
  const dir = await freshLogDir("prune");
  await mkdir(dir, { recursive: true });
  const old = [];
  for (let day = 1; day <= 35; day++) {
    const name = `server-202607${String(day).padStart(2, "0")}.log`;
    old.push(name);
    await writeFile(path.join(dir, name), JSON.stringify({ kind: "old", day }) + "\n");
  }
  // the day's own file already stands at the cap, so the next line rolls
  await writeFile(path.join(dir, `server-${today()}.log`), Buffer.alloc(MAX_BYTES, "x"));

  await probe("import server; server._info('fresh', 'm1', marker='after the roll')",
    { FACILITATOR_LOG_DIR: dir });

  const left = (await readdir(dir)).sort();
  assert.equal(left.length, 30, `thirty kept, saw ${left.length}`);
  // seven had to go, and they are the seven oldest by the date in the name
  for (const gone of old.slice(0, 7)) assert.ok(!left.includes(gone), `${gone} outlived the prune`);
  for (const kept of old.slice(7)) assert.ok(left.includes(kept), `${kept} was deleted out of turn`);
  assert.ok(left.includes(`server-${today()}.log`), "the day's full file was deleted");
  const rolled = left.find(name => /\.\d+\.log$/.test(name));
  assert.equal((await eventsIn(dir, rolled))[0].marker, "after the roll");
});
