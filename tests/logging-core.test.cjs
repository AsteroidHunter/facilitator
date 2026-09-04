// The server's own log: where the folder lands, what one line looks like, which
// lines the level lets through, that a file can neither grow without a bound nor
// pile up without one, and above all that nothing anybody said ever reaches it.
// Most of it drives the logger directly, by importing a patched copy of the
// server in a temporary folder, so it runs in a second and binds no socket; the
// keep-out proof runs a real fixture server on a free port. The suite never
// touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile, spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
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

// the same run with a terminal on the other end of standard output, which is
// the whole of what decides whether the human mirror is attached at all. Node
// cannot hand a child a terminal, so the run makes its own: python forks behind
// one, the child does the work with its output going into it, and the parent
// reads what came out and passes it on down its own plain pipe.
async function ttyProbe(code, env = {}) {
  const { stdout } = await probe([
    "import os, pty, sys",
    "pid, fd = pty.fork()",
    "if pid == 0:",
    ...code.split("\n").map(line => "    " + line),
    "    sys.exit(0)",
    "seen = b''",
    "while True:",
    "    try:",
    "        chunk = os.read(fd, 4096)",
    "    except OSError:",
    "        break",
    "    if not chunk:",
    "        break",
    "    seen += chunk",
    "os.waitpid(pid, 0)",
    "sys.stdout.buffer.write(seen)",
  ].join("\n"), env);
  return stdout.replace(/\r/g, "");   // a terminal ends its lines with both
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

test("with a terminal watching, the same event reaches it in a short human form", async () => {
  const dir = await freshLogDir("mirror");
  const stdout = await ttyProbe(
    "import server; server._info('refusal', 'm3', route='/reply', code=400, reason='bad box')",
    { FACILITATOR_LOG_DIR: dir });
  assert.match(stdout, /^\d{2}:\d{2}:\d{2} +refusal +\[m3\] +route=\/reply code=400 reason=bad box$/m);
  assert.doesNotMatch(stdout, /[{}]/, "the terminal was handed JSON");
  // a kind longer than the column still keeps its gap, which the padded print
  // this replaces did not: workdone[m366] went out with no separator at all
  const long = await ttyProbe(
    "import server; server._info('workdone', 'm366')", { FACILITATOR_LOG_DIR: dir });
  assert.match(long, /workdone +\[m366\]/);
});

test("with nobody watching there is no mirror at all, and the file still has every line", async () => {
  const dir = await freshLogDir("nomirror");
  // a pipe is not a terminal, which is what a server started by the CLI has:
  // its output goes nowhere and the dated file is the only place the events land
  const { stdout, stderr } = await probe([
    "import server",
    "server._info('start', port=1234, boxes=2)",
    "server._info('refusal', 'm3', route='/reply', code=400, reason='bad box')",
    "server._error('savefail', step='write', reason='Permission denied')",
  ].join("\n"), { FACILITATOR_LOG_DIR: dir });

  assert.equal(stdout, "", `standard output was written to: ${stdout}`);
  assert.equal(stderr, "", `standard error was written to: ${stderr}`);
  assert.deepEqual((await eventsIn(dir)).map(event => event.kind),
    ["start", "refusal", "savefail"], "the file lost what the terminal stopped getting");
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

// ---- the keep-out proof ------------------------------------------------------
// A message and a reply, each carrying a phrase that could not occur by
// accident, and a lane creation, which is the one event a folder path passes
// through. Every line of every file in the log folder is then read: neither
// phrase is there, no path from the fixture is there, and the transcript still
// carries both phrases exactly as it always did, which is what says the proof
// is proving something rather than passing on an empty folder.
const SAID = "quokka-vestibule-1198";
const ANSWERED = "marzipan-hydrofoil-4471";

async function startBoard(dir, logs, extra = {}) {
  const chosen = await freePort();
  const child = spawn("python3", [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(chosen), FACILITATOR_LOG_DIR: logs, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const origin = `http://127.0.0.1:${chosen}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return { child, origin, out: () => output };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

async function stopBoard(board) {
  if (board && board.child.exitCode === null) {
    board.child.kill("SIGTERM");
    await once(board.child, "exit");
  }
}

test("no message text and no path ever reaches a log line; the transcript keeps both", async () => {
  const wrapper = path.join(outer, "keepout");
  const app = path.join(wrapper, "app");
  const logs = path.join(wrapper, "logs");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(app, "server.py"), await readFile(path.join(appDir, "server.py")));
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "keep out",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));

  let board;
  try {
    board = await startBoard(app, logs);
    const post = (route, body) => fetch(board.origin + route, { method: "POST", body })
      .then(async response => ({ status: response.status, body: await response.json() }));
    const transcriptPath = path.join(app, "transcript.jsonl");
    const before = (await readFile(transcriptPath, "utf8")).split("\n").filter(Boolean).length;

    assert.equal((await post("/send?box=0", `Please look at ${SAID} before tomorrow`)).status, 200);
    assert.equal((await post("/reply?box=0", `Looked: ${ANSWERED} is where it went`)).status, 200);
    const lane = await post(`/project?name=${encodeURIComponent("Keep Out Lane")}`, homedir());
    assert.equal(lane.status, 200, JSON.stringify(lane.body));

    // every line of every file in the folder, whatever their names
    const written = [];
    for (const name of await readdir(logs)) {
      for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
        if (line !== "") written.push(line);
      }
    }
    assert.ok(written.length >= 3, "the log folder was empty, so this proves nothing");
    for (const line of written) {
      assert.ok(!line.includes(SAID), `a message reached the log: ${line}`);
      assert.ok(!line.includes(ANSWERED), `a reply reached the log: ${line}`);
      assert.ok(!line.includes(app), `a fixture path reached the log: ${line}`);
      assert.ok(!line.includes(wrapper), `a fixture path reached the log: ${line}`);
      assert.ok(!line.includes(homedir()), `the home directory reached the log: ${line}`);
      JSON.parse(line);
    }
    // what it does carry: the kind, the card, and how long the text was
    const events = written.map(line => JSON.parse(line));
    const said = events.find(event => event.kind === "user");
    assert.equal(said.box, "0");
    assert.equal(said.chars, `Please look at ${SAID} before tomorrow`.length);
    assert.equal(said.text, undefined, "the log line carries a text field");
    // the lane's folder is named, and only named
    const made = events.find(event => event.kind === "project");
    assert.equal(made.folder, path.basename(homedir()));
    assert.ok(!String(made.folder).includes("/"), "the folder field carries a path");

    // and the transcript is exactly what it always was: both phrases in it, one
    // row per event, and no field the log invented
    const rows = (await readFile(transcriptPath, "utf8")).split("\n").filter(Boolean);
    assert.equal(rows.length, before + 3, "the transcript did not get one row per event");
    const parsed = rows.map(row => JSON.parse(row));
    assert.ok(parsed.some(row => row.kind === "user" && row.text.includes(SAID)));
    assert.ok(parsed.some(row => row.kind === "agent" && row.text.includes(ANSWERED)));
    const last = parsed.at(-1);
    assert.equal(last.kind, "project");
    assert.deepEqual(Object.keys(last).sort(), ["box", "kind", "text", "ts"]);
    assert.ok(last.text.includes(homedir()), "the transcript stopped recording where the lane is");

    // GET /log tails the day's file, in the shape it always answered in
    const tailed = await (await fetch(board.origin + "/log?lines=5")).json();
    assert.ok(Array.isArray(tailed.lines) && tailed.lines.length > 0);
    assert.equal(JSON.parse(tailed.lines.at(-1)).kind, "project");
  } finally {
    await stopBoard(board);
  }
});

// ---- the noise you switch on while hunting -----------------------------------
// The request line, the claim, the ack and the bounce are all DEBUG, because at
// INFO the polls alone would be 22 MB a day of nothing going wrong. Switched
// on, they are what says which request was slow and where a hand-off went.

async function boardFolder(name, level) {
  const wrapper = path.join(outer, name);
  const app = path.join(wrapper, "app");
  const logs = path.join(wrapper, "logs");
  await rm(wrapper, { recursive: true, force: true });
  await mkdir(app, { recursive: true });
  // a claim nobody confirms comes back after ninety seconds, which no test can
  // wait for: this copy gives up after one
  const source = await readFile(path.join(appDir, "server.py"), "utf8");
  const quick = source.replace("ACK_GRACE = 90.0", "ACK_GRACE = 1.0");
  assert.notEqual(quick, source, "the unconfirmed claim's clock was not patched");
  await writeFile(path.join(app, "server.py"), quick);
  await writeFile(path.join(app, "seed.json"), JSON.stringify({
    title: "debug fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  return { app, logs, level };
}

async function boardEvents(logs) {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

test("at the default level a hundred polls write no request line at all", async () => {
  const place = await boardFolder("quiet");
  let board;
  try {
    board = await startBoard(place.app, place.logs);
    for (let n = 0; n < 100; n++) await (await fetch(board.origin + "/state")).json();
    const written = await boardEvents(place.logs);
    assert.equal(written.filter(event => event.kind === "request").length, 0);
    assert.ok(written.some(event => event.kind === "start"), "the board wrote nothing at all");
  } finally {
    await stopBoard(board);
  }
});

test("with debug on, every request writes one line with its status and its milliseconds", async () => {
  const place = await boardFolder("loud");
  let board;
  try {
    board = await startBoard(place.app, place.logs, { FACILITATOR_LOG_LEVEL: "debug" });
    const before = (await boardEvents(place.logs)).filter(e => e.kind === "request").length;
    for (let n = 0; n < 10; n++) await (await fetch(board.origin + "/state")).json();
    await fetch(board.origin + "/send?box=0", { method: "POST", body: "a message" });

    const lines = (await boardEvents(place.logs)).filter(event => event.kind === "request");
    const polls = lines.filter(line => line.route === "/state");
    assert.equal(polls.length, before + 10, "a poll went unlogged, or was logged twice");
    for (const line of lines) {
      assert.equal(line.level, "debug");
      assert.equal(typeof line.status, "number");
      assert.equal(typeof line.ms, "number");
      assert.ok(line.ms >= 0 && line.ms < 60000, `a strange duration: ${line.ms}`);
      assert.ok(["GET", "POST"].includes(line.method));
    }
    const sent = lines.find(line => line.route === "/send");
    assert.equal(sent.method, "POST");
    assert.equal(sent.status, 200);
    assert.equal(sent.box, "0", "the request line does not name the card");
  } finally {
    await stopBoard(board);
  }
});

test("a claim, its ack and a hand-off nobody confirmed each write one line, and no token", async () => {
  const place = await boardFolder("handoff");
  let board;
  try {
    board = await startBoard(place.app, place.logs, { FACILITATOR_LOG_LEVEL: "debug" });
    const post = (route, body) => fetch(board.origin + route, { method: "POST", body })
      .then(async response => ({ status: response.status, body: await response.json() }));

    assert.equal((await post("/send?box=0", "please answer this")).status, 200);
    const claimed = await (await fetch(board.origin + "/wait?owner=facilitator&timeout=3")).json();
    assert.equal(claimed.box, "0");
    assert.equal((await post(`/ack?owner=facilitator&token=${claimed.ack}`)).status, 200);

    let written = await boardEvents(place.logs);
    const claims = written.filter(event => event.kind === "claim");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].box, "0");
    assert.equal(claims[0].owner, "facilitator");
    assert.equal(claims[0].token, true, "the line does not say a receipt was minted");
    const acks = written.filter(event => event.kind === "ackok");
    assert.equal(acks.length, 1);
    assert.equal(acks[0].box, "0");
    assert.equal(acks[0].owner, "facilitator");

    // a second hand-off, left unconfirmed, comes back on its own clock
    assert.equal((await post("/reply?box=0", "answered")).status, 200);
    assert.equal((await post("/send?box=0", "and one more thing")).status, 200);
    const dropped = await (await fetch(board.origin + "/wait?owner=facilitator&timeout=3")).json();
    assert.equal(dropped.box, "0");
    const deadline = Date.now() + 5000;
    let bounces = [];
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      await (await fetch(board.origin + "/state")).json();   // the clock is swept here
      bounces = (await boardEvents(place.logs)).filter(event => event.kind === "bounce");
      if (bounces.length) break;
    }
    assert.equal(bounces.length, 1, "an unconfirmed hand-off came back with no line");
    assert.equal(bounces[0].box, "0");
    assert.equal(bounces[0].owner, "facilitator");

    // and at no level, in no line, is the receipt itself written down
    written = await boardEvents(place.logs);
    for (const event of written) {
      const line = JSON.stringify(event);
      assert.ok(!line.includes(claimed.ack), `a token reached the log: ${line}`);
      assert.ok(!line.includes(dropped.ack), `a token reached the log: ${line}`);
    }
  } finally {
    await stopBoard(board);
  }
});
