// What `facilitator restart` is allowed to touch, and in what order.
//
// The command stops one process and, at most, opens one window, so nearly
// every test here is about what it does NOT do: it does not signal a browser's
// connection, a second listener, a foreign script that merely carries this
// folder's server.py as one of its arguments, or a pid whose identity changed
// between being read and being signalled; it does not sleep and hope the port
// is free; it does not reach for SIGKILL; it does not hand out a pid to kill;
// it does not call a restart done because something, anything, answered on the
// port; and it does not read an unknown as an absence.
//
// Most tests drive the CLI's own functions against a deterministic model of a
// process table, a listing and a clock. Two read the real kernel identity of
// this test's own python process, which is a read and nothing else. The last
// is the real thing on an ephemeral port in a nested temporary folder, with
// the browser stubbed; it cleans up only what it started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { access, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } =
  require("node:fs/promises");
const { constants } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const DARWIN = process.platform === "darwin";

let nestDir;      // the fixture's parent, so the server's sibling folders land inside it
let fixtureDir;   // a copy of the CLI, so nothing here touches the real one
let cliPath;
let spacedDir;    // a second copy under a folder whose name has a space in it
let spacedCli;
let port;         // ephemeral, never 8877

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

// the CLI is a command with no .py on the end, so it is loaded by name and
// path rather than imported; from there it is an ordinary module to poke at
function loadCli(where) {
  return [
    "import importlib.machinery, importlib.util, json, os, signal, subprocess, sys, time, types",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(where)})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

async function probe(code, { dir = fixtureDir, cli = cliPath, env = {}, timeout = 30000 } = {}) {
  return execFileAsync("python3", ["-c", `${loadCli(cli)}\n${code}`], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_LOG_DIR: path.join(nestDir, "logs"), ...env },
    timeout,
  });
}

const lastJson = stdout => JSON.parse(String(stdout).trim().split("\n").at(-1));

// A model, not a machine. There is a process table (pid -> the identity the
// kernel would give back: start time, executable, argument vector), a set of
// pids listening on the port, and a clock that only moves. os.kill is the one
// way anything dies or changes, and every read is recorded, so a test can say
// not only what happened but what was looked at before it happened.
//
// The identity of "our" processes is built from this interpreter's own real
// path, so the CLI's real is_server_argv, which compares files rather than
// names, accepts it without anything being stubbed out from under it.
function harness({
  listeners = [4242],         // pids holding the listening socket at the start
  command = "OURS",           // what the table says they are: OURS, FOREIGN, UNREADABLE
  listing = "OK",             // OK, or UNREADABLE for an lsof that cannot answer
  listingUnknownAfter = null, // the listing goes unreadable after this many looks
  ignoresTerm = false,        // a server that will not go at all
  livesOnAfterTerm = false,   // one that lets go of the socket but keeps running
  reusedAfterTerm = false,    // one whose number is taken by another listener
  reusedOffPort = false,      // one whose number is taken by a non-listener
  unreadableAfterTerm = false,// one still on the port that can no longer be read
  portStaysHeld = false,      // one that goes but whose socket does not
  childExit = null,           // what poll() says about the launched child
  answers = true,             // whether the port answers once the child is launched
  stateShape = "GOOD",        // GOOD, NOT_DICT or WRONG_KEYS
  newListener = 5150,         // which pid ends up on the port after the launch
  newListenerOurs = true,     // and whether it reads back as this folder's server
  chrome = [],                // URLs Chrome is showing, or null for unknown
  openApp = "STUB",           // STUB records the call; REAL runs the real function
  openFails = null,           // what `open` says to stderr, when it exits non-zero
} = {}) {
  return [
    "EVENTS = []",
    "CHILD_PID = 5150",
    "ACCEPTED = sys.executable",                 // an interpreter the CLI can prove
    "SERVER = str(cli.HERE / 'server.py')",
    "def ident(pid, ours=True, drift=0):",
    "    return ((1757000000 + pid + drift, pid), ACCEPTED,",
    "            (ACCEPTED, SERVER if ours else '/somewhere/else/other.py'))",
    `LISTENERS = set(${JSON.stringify(listeners)})`,
    "ALIVE = set(LISTENERS)",
    "PROCS = {}",
    command === "UNREADABLE"
      ? "# the listener cannot be read at all: it is simply not in the table"
      : `for _p in LISTENERS:\n    PROCS[_p] = ident(_p, ${command === "OURS" ? "True" : "False"})`,
    `UNREADABLE = ${listing === "OK" ? "False" : "True"}`,
    `UNKNOWN_AFTER = ${listingUnknownAfter === null ? "None" : String(listingUnknownAfter)}`,
    `IGNORES_TERM = ${ignoresTerm ? "True" : "False"}`,
    `LIVES_ON = ${livesOnAfterTerm ? "True" : "False"}`,
    `REUSED = ${reusedAfterTerm ? "True" : "False"}`,
    `REUSED_OFF_PORT = ${reusedOffPort ? "True" : "False"}`,
    `UNREADABLE_AFTER = ${unreadableAfterTerm ? "True" : "False"}`,
    `PORT_STAYS_HELD = ${portStaysHeld ? "True" : "False"}`,
    `CHILD_EXIT = ${childExit === null ? "None" : String(childExit)}`,
    `ANSWERS = ${answers ? "True" : "False"}`,
    `STATE_SHAPE = ${JSON.stringify(stateShape)}`,
    `NEW_LISTENER = ${newListener === null ? "None" : String(newListener)}`,
    `NEW_LISTENER_OURS = ${newListenerOurs ? "True" : "False"}`,
    `CHROME = ${chrome === null ? "None" : JSON.stringify(chrome)}`,
    "STARTED = []",
    "",
    "class Clock:",
    "    def __init__(self):",
    "        self.now = 1000.0",
    "    def monotonic(self):",
    "        return self.now",
    "    def time(self):",
    "        return self.now",
    "    def sleep(self, seconds):",
    "        self.now += seconds",
    "        EVENTS.append(['sleep', round(seconds, 3)])",
    "cli.time = Clock()",
    "",
    "class OsProxy:",
    "    def __getattr__(self, name):",
    "        return getattr(os, name)",
    "osp = OsProxy()",
    "def fake_kill(pid, sig):",
    "    EVENTS.append(['kill', pid, int(sig)])",
    "    if int(sig) == 0:",
    "        if pid not in ALIVE:",
    "            raise ProcessLookupError(pid)",
    "        return",
    "    if int(sig) != int(signal.SIGTERM):",
    "        raise AssertionError('the CLI sent something other than SIGTERM')",
    "    if IGNORES_TERM:",
    "        return",
    "    if REUSED:",           // the number outlives the process, still listening
    "        PROCS[pid] = ident(pid, drift=9999)",
    "        return",
    "    if REUSED_OFF_PORT:",   // the number is handed to something not on the port
    "        LISTENERS.discard(pid)",
    "        PROCS[pid] = ident(pid, ours=False, drift=9999)",
    "        return",
    "    if UNREADABLE_AFTER:",  // still on the port, no longer readable at all
    "        PROCS.pop(pid, None)",
    "        return",
    "    if LIVES_ON:",         // socket released, process still there, unchanged
    "        LISTENERS.discard(pid)",
    "        return",
    "    ALIVE.discard(pid)",
    "    PROCS.pop(pid, None)",
    "    if not PORT_STAYS_HELD:",
    "        LISTENERS.discard(pid)",
    "osp.kill = fake_kill",
    "cli.os = osp",
    "",
    "class FakeChild:",
    "    def __init__(self, argv, **kw):",
    "        EVENTS.append(['popen', list(argv), kw.get('start_new_session'),",
    "                       kw.get('stdout') == subprocess.DEVNULL,",
    "                       kw.get('stderr') == subprocess.DEVNULL])",
    "        STARTED.append(True)",
    "        self.pid = CHILD_PID",
    "        ALIVE.add(CHILD_PID)",
    "        PROCS[CHILD_PID] = ident(CHILD_PID)",
    "        if NEW_LISTENER is not None:",
    "            LISTENERS.add(NEW_LISTENER)",
    "            ALIVE.add(NEW_LISTENER)",
    "            PROCS[NEW_LISTENER] = ident(NEW_LISTENER, NEW_LISTENER_OURS)",
    "    def poll(self):",
    "        return CHILD_EXIT",
    `OPEN_FAILS = ${openFails === null ? "None" : JSON.stringify(openFails)}`,
    "def fake_run(argv, **kw):",
    "    EVENTS.append(['run', list(argv)])",
    "    if OPEN_FAILS is not None and argv[0] == 'open':",
    "        return types.SimpleNamespace(returncode=1, stdout='', stderr=OPEN_FAILS + '\\n')",
    "    return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "cli.subprocess = types.SimpleNamespace(Popen=FakeChild, run=fake_run,",
    "                                       DEVNULL=subprocess.DEVNULL, STDOUT=subprocess.STDOUT,",
    "                                       PIPE=subprocess.PIPE,",
    "                                       SubprocessError=subprocess.SubprocessError)",
    "",
    "LOOKS = {'listing': 0}",
    "def fake_listener_pids(port):",
    "    LOOKS['listing'] += 1",
    "    EVENTS.append(['listener_pids', LOOKS['listing']])",
    "    if UNREADABLE or (UNKNOWN_AFTER is not None and LOOKS['listing'] > UNKNOWN_AFTER):",
    "        return None",
    "    return set(LISTENERS)",
    "cli.listener_pids = fake_listener_pids",
    "",
    "def fake_process_identity(pid):",
    "    EVENTS.append(['process_identity', pid])",
    "    return PROCS.get(pid)",
    "cli.process_identity = fake_process_identity",
    // the model answers for the process table; the runtime probe is a real
    // launch of a real interpreter and has no business inside it
    "cli.probed_runtime = lambda interpreter: None",
    "",
    "OLD_PIDS = set(LISTENERS)",
    "def fake_state(port, timeout=2):",
    // before the launch, the old server answers for as long as it is alive and listening
    "    up = ANSWERS if STARTED else any(p in LISTENERS and p in ALIVE for p in OLD_PIDS)",
    "    EVENTS.append(['state', up])",
    "    if not up:",
    "        return None",
    "    if STATE_SHAPE == 'NOT_DICT':",
    "        return 3",
    "    if STATE_SHAPE == 'WRONG_KEYS':",
    "        return {'boxes': [], 'listening': [], 'busy': {}, 'listenerGap': {}}",
    "    return {'boxes': [], 'queued': 0, 'listening': {}, 'busy': {}, 'listenerGap': {}}",
    "cli.state = fake_state",
    "",
    "def fake_chrome():",
    "    EVENTS.append(['chrome'])",
    "    return CHROME",
    "cli.chrome_page_urls = fake_chrome",
    "",
    openApp === "STUB"
      ? "cli.open_app = lambda cfg, dry: EVENTS.append(['open_app', dry])"
      : "# the real open_app runs, through the recording subprocess.run above",
    "",
    "def say(extra=None):",
    "    print('EVENTS ' + json.dumps({'events': EVENTS, **(extra or {})}))",
  ].join("\n");
}

function readEvents(stdout) {
  const lines = String(stdout || "").trim().split("\n");
  const marker = lines.findIndex(line => line.startsWith("EVENTS "));
  assert.notEqual(marker, -1, `no EVENTS line in output:\n${stdout}`);
  return { said: lines.slice(0, marker), ...JSON.parse(lines[marker].slice("EVENTS ".length)) };
}

const kinds = events => events.map(event => event[0]).filter(kind => kind !== "sleep");
const signalsIn = events => events.filter(e => e[0] === "kill" && e[2] !== 0);

async function restart(options, args = "['restart']") {
  const done = await probe([
    harness(options),
    "try:",
    `    cli.cmd_restart(${args})`,
    "finally:",
    "    say()",
  ].join("\n")).then(ok => ({ ok: true, ...ok }), error => ({ ok: false, ...error }));
  return { ...done, ...readEvents(done.stdout) };
}

before(async () => {
  nestDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-restart-")));
  fixtureDir = path.join(nestDir, "board");
  await mkdir(fixtureDir);
  cliPath = path.join(fixtureDir, "facilitator");
  port = await freePort();
  await copyFile(path.join(ROOT, "facilitator"), cliPath);
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ port, lanes: [] }));

  // a second copy whose folder name contains a space, because the recognition
  // works on paths and either of them may have spaces in
  spacedDir = path.join(nestDir, "board with a space");
  await mkdir(spacedDir);
  spacedCli = path.join(spacedDir, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), spacedCli);
  await writeFile(path.join(spacedDir, "run.config.json"), JSON.stringify({ port, lanes: [] }));
});

after(async () => {
  if (nestDir) await rm(nestDir, { recursive: true, force: true });
});

test("restart is a command of its own, in the usage and in the dispatch", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.match(source, /^ {2}facilitator restart \[--dry-run\]$/m, "restart is not in the usage");
  assert.match(source, /elif cmd == "restart":\n\s+cmd_restart\(args\)/, "restart is not dispatched");

  const unknown = await execFileAsync("python3", [cliPath, "nonsense"], { cwd: fixtureDir })
    .then(() => null, error => error);
  assert.ok(unknown, "an unknown command was accepted");
  assert.match(unknown.stderr, /facilitator restart \[--dry-run\]/);
});

test("restart refuses words it does not know instead of borrowing run's", async () => {
  for (const flag of ["--attach", "--spawn", "--force", "--kill", "on"]) {
    const refused = await execFileAsync("python3", [cliPath, "restart", flag], { cwd: fixtureDir })
      .then(() => null, error => error);
    assert.ok(refused, `restart accepted ${flag}`);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /restart takes --dry-run and nothing else; got /, refused.stderr);
    assert.match(refused.stderr, new RegExp(flag.replace(/-/g, "\\-") + "$", "m"));
  }
});

// --- gap 1: recognition is an argument vector, not the end of a line -------

test("recognition takes exactly two arguments and an interpreter it can prove", async () => {
  const { stdout } = await probe([
    "s = str(cli.HERE / 'server.py')",
    "me = sys.executable",
    "cases = {",
    "  'ours': (me, [me, s]),",
    // the two lines root's probe got through: a foreign script carrying our
    // path as an argument, and an interpreter accepted on the strength of its
    // name alone
    "  'helper_with_our_path_as_argument': (me, [me, '/unrelated/python-helper.py', s]),",
    "  'python_anything_by_name': ('/foreign/python-anything', ['/foreign/python-anything', s]),",
    "  'real_binary_that_is_not_our_python': ('/bin/sh', ['/bin/sh', s]),",
    "  'suffix': (me, [me, s + '.unrelated']),",
    "  'prefix': (me, [me, s[:-3]]),",
    "  'option_before': (me, [me, '-u', s]),",
    "  'argument_after': (me, [me, s, '--port', '9']),",
    "  'interpreter_only': (me, [me]),",
    "  'empty_vector': (me, []),",
    "  'script_as_argv0_only': (me, [s]),",
    "  'path_inside_one_argument': (me, [me, '--label=' + s]),",
    "}",
    "print(json.dumps({k: cli.is_server_argv(v[0], v[1]) for k, v in cases.items()}))",
  ].join("\n"));
  assert.deepEqual(lastJson(stdout), {
    ours: true,
    helper_with_our_path_as_argument: false,
    python_anything_by_name: false,
    real_binary_that_is_not_our_python: false,
    suffix: false,
    prefix: false,
    option_before: false,
    argument_after: false,
    interpreter_only: false,
    empty_vector: false,
    script_as_argv0_only: false,
    path_inside_one_argument: false,
  });
});

test("recognition holds up with spaces in the script path and in the interpreter path", async () => {
  const { stdout } = await probe([
    "s = str(cli.HERE / 'server.py')",
    "assert ' ' in s, 'the spaced fixture is not spaced'",
    // a second name for this very interpreter, under a path with a space in
    // it: the same file, so it must be accepted, which is also the shape of
    // the framework build's Python.app/Contents/MacOS/Python
    "link = str(cli.HERE / 'py env link')",
    "os.path.exists(link) or os.symlink(sys.executable, link)",
    "out = {",
    "  'spaced_script': cli.is_server_argv(sys.executable, [sys.executable, s]),",
    "  'spaced_interpreter': cli.is_server_argv(link, [link, s]),",
    "  'spaced_script_split_up': cli.is_server_argv(sys.executable, [sys.executable] + s.split(' ')),",
    "  'spaced_label': cli.is_server_argv(sys.executable, [sys.executable, '/o/a.py', s]),",
    "  'same_file': cli.same_file_as(link, [sys.executable]),",
    "}",
    "print(json.dumps(out))",
  ].join("\n"), { dir: spacedDir, cli: spacedCli });
  const got = lastJson(stdout);
  assert.equal(got.spaced_script, true, "a script path with a space in it was not recognised");
  assert.equal(got.spaced_interpreter, true,
    "another name for the same interpreter binary was not recognised");
  assert.equal(got.same_file, true, "same_file_as compares names rather than files");
  assert.equal(got.spaced_script_split_up, false,
    "a spaced path split into separate arguments was accepted as one");
  assert.equal(got.spaced_label, false);
});

test("a framework launcher and the runtime it hands over to are different files, and both count",
  async () => {
    // An ordinary macOS framework install: bin/python3.X and
    // Python.app/Contents/MacOS/Python are two separate binaries, not links to
    // each other. What is configured is the first; what the kernel reports is
    // the second. Comparing them as files says they differ, correctly, so the
    // relationship between them has to be derived instead.
    const fw = path.join(nestDir, "fw");
    const version = path.join(fw, "Example.framework", "Versions", "3.13");
    const runtimeDir = path.join(version, "Resources", "Python.app", "Contents", "MacOS");
    await mkdir(path.join(version, "bin"), { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const launcher = path.join(version, "bin", "python3.13");
    const runtime = path.join(runtimeDir, "Python");
    await writeFile(launcher, "launcher, a real and separate file\n");
    await writeFile(runtime, "runtime, a real and separate file\n");

    // a second framework, to be sure the derivation is not "any Python.app"
    const otherDir = path.join(fw, "Other.framework", "Versions", "3.13",
      "Resources", "Python.app", "Contents", "MacOS");
    await mkdir(otherDir, { recursive: true });
    await writeFile(path.join(otherDir, "Python"), "somebody else's runtime\n");
    // and a lookalike outside any framework at all
    const looseDir = path.join(fw, "loose", "Python.app", "Contents", "MacOS");
    await mkdir(looseDir, { recursive: true });
    await writeFile(path.join(looseDir, "Python"), "not in a framework\n");

    const { stdout } = await probe([
      "s = str(cli.HERE / 'server.py')",
      `launcher = ${JSON.stringify(launcher)}`,
      `runtime = ${JSON.stringify(runtime)}`,
      `other = ${JSON.stringify(path.join(otherDir, "Python"))}`,
      `loose = ${JSON.stringify(path.join(looseDir, "Python"))}`,
      // the configured interpreter is the launcher, and only the launcher
      "cli.server_interpreters = lambda: [launcher]",
      "cli.probed_runtime = lambda interpreter: None",
      "print(json.dumps({",
      "  'really_distinct': cli.same_file_as(launcher, [runtime]),",
      "  'derived': cli.framework_runtime(launcher) == runtime,",
      "  'launcher_argv': cli.is_server_argv(launcher, [launcher, s]),",
      "  'runtime_argv': cli.is_server_argv(runtime, [runtime, s]),",
      "  'runtime_argv_launcher_argv0': cli.is_server_argv(runtime, [launcher, s]),",
      "  'other_framework': cli.is_server_argv(other, [other, s]),",
      "  'loose_lookalike': cli.is_server_argv(loose, [loose, s]),",
      "  'runtime_wrong_script': cli.is_server_argv(runtime, [runtime, s + '.unrelated']),",
      "  'runtime_extra_argument': cli.is_server_argv(runtime, [runtime, '/o/a.py', s]),",
      "  'derived_from_runtime': cli.framework_runtime(runtime),",
      "}))",
    ].join("\n"));
    const got = lastJson(stdout);
    assert.equal(got.really_distinct, false,
      "the fixture's two binaries are the same file, so this proves nothing");
    assert.equal(got.derived, true, "the runtime was not derived from the launcher");
    assert.equal(got.launcher_argv, true, "the configured interpreter itself was rejected");
    assert.equal(got.runtime_argv, true,
      "the normal framework server was rejected: the kernel reports the runtime, not the launcher");
    assert.equal(got.runtime_argv_launcher_argv0, true,
      "the executable is what is judged, and argv[0] is not it");
    assert.equal(got.other_framework, false, "another framework's runtime was accepted");
    assert.equal(got.loose_lookalike, false, "a Python.app outside any framework was accepted");
    assert.equal(got.runtime_wrong_script, false);
    assert.equal(got.runtime_extra_argument, false);
    assert.equal(got.derived_from_runtime, null, "the derivation runs backwards as well as forwards");
  });

test("the kernel identity reader reads this test's own process, and refuses elsewhere", async () => {
  // a read and nothing more, of the one process this test owns: its own
  const { stdout } = await probe([
    "me = os.getpid()",
    "read = cli.process_argv(me)",
    "started = cli.process_started(me)",
    "print(json.dumps({",
    "  'platform': sys.platform,",
    "  'argv': read[1] if read else None,",
    "  'started': started,",
    "  'identity': cli.process_identity(me) is not None,",
    "  'is_our_server': cli.is_our_server(me),",
    "  'is_server_argv': bool(read) and cli.is_server_argv(read[0], read[1]),",
    // the executable the kernel actually reports for a live process of the
    // supported interpreter, given the vector our server would have: this is
    // the recognition the whole command rests on, and a framework install
    // reports a different file here from the one that is configured
    "  'synthetic_server_argv': bool(read) and cli.is_server_argv(",
    "      read[0], [read[1][0], str(cli.HERE / 'server.py')]),",
    "  'executable_trusted': bool(read) and cli.is_trusted_executable(read[0]),",
    "  'executable_is_configured_file': bool(read) and cli.same_file_as(",
    "      read[0], cli.server_interpreters()),",
    "  'probe': cli.probed_runtime(sys.executable),",
    "}))",
  ].join("\n"));
  const got = lastJson(stdout);
  if (!DARWIN) {
    assert.equal(got.argv, null, "an unsupported platform must refuse, not guess");
    assert.equal(got.identity, false);
    assert.equal(got.is_our_server, null, "an unreadable identity was not refused");
    return;
  }
  assert.ok(Array.isArray(got.argv), "the argument vector could not be read at all");
  assert.equal(got.argv.length, 3, `argv was ${JSON.stringify(got.argv)}`);
  assert.equal(got.argv[1], "-c");
  assert.ok(got.argv[2].includes("\n"),
    "the code argument came back split up, so the vector is not being read whole");
  assert.ok(Array.isArray(got.started) && got.started[0] > 1500000000,
    `the start time reads as ${JSON.stringify(got.started)}`);
  assert.equal(got.identity, true);
  // a real python, running real code, that is not this folder's server
  assert.equal(got.is_our_server, false, "any python at all was accepted as this board's server");
  assert.equal(got.is_server_argv, false);

  // and the same real interpreter, with the vector our server would have,
  // must be recognised however the kernel names its executable
  assert.equal(got.synthetic_server_argv, true,
    "the supported interpreter running this very test is not recognised as able to be our server");
  assert.equal(got.executable_trusted, true);
  // on a framework install these two differ; on others they do not. Either
  // way recognition above must hold, which is the point of the assertion.
  assert.equal(typeof got.executable_is_configured_file, "boolean");
  assert.ok(got.probe === null || typeof got.probe === "string",
    "the bounded runtime probe returned something other than a path or nothing");
});

test("a foreign listener is refused and never signalled", async () => {
  const run = await restart({ command: "FOREIGN" });
  assert.equal(run.ok, false, "a foreign process on the port was restarted anyway");
  assert.match(run.stderr,
    /restart: pid 4242 is listening on \d+ and it is not .*server\.py; refusing to signal it/, run.stderr);
  assert.deepEqual(kinds(run.events).filter(k => k === "kill" || k === "popen"), []);
  assert.equal(kinds(run.events).includes("open_app"), false);
});

test("two listeners are an ambiguity, and an ambiguity changes nothing", async () => {
  const run = await restart({ listeners: [4242, 909] });
  assert.equal(run.ok, false, "restart guessed which of two listeners was the board");
  assert.match(run.stderr, /2 processes are listening on \d+ \(909, 4242\); refusing to guess/, run.stderr);
  assert.deepEqual(kinds(run.events).filter(k => k === "kill" || k === "popen"), []);
});

test("an unreadable identity is refused, not assumed to be ours", async () => {
  const run = await restart({ command: "UNREADABLE" });
  assert.equal(run.ok, false, "an unreadable process was signalled");
  assert.match(run.stderr, /cannot read what process 4242 is; refusing to signal it/, run.stderr);
  assert.deepEqual(kinds(run.events).filter(k => k === "kill" || k === "popen"), []);
});

test("a listing that cannot be read stops the command before any signal", async () => {
  const run = await restart({ listing: "UNREADABLE" });
  assert.equal(run.ok, false, "restart carried on without knowing who was listening");
  assert.match(run.stderr, /cannot read what is listening on \d+; nothing was stopped/, run.stderr);
  assert.deepEqual(kinds(run.events).filter(k => k === "kill" || k === "popen"), []);
});

// --- gap 2: the whole identity, compared again before the signal -----------

test("a changed identity under the same number and start time gets no signal", async () => {
  for (const [name, becomes] of [
    ["a different script under the same interpreter",
      "(PROCS[4242][0], ACCEPTED, (ACCEPTED, '/somewhere/else/other.py'))"],
    ["a different executable running the same vector",
      "(PROCS[4242][0], '/bin/sh', PROCS[4242][2])"],
    ["an extra argument on the same vector",
      "(PROCS[4242][0], ACCEPTED, PROCS[4242][2] + ('--extra',))"],
    ["a different start time on the same number", "ident(4242, drift=5000)"],
    ["nothing readable at all", "None"],
  ]) {
    const { stdout } = await probe([
      harness({}),
      `owner, refusal = cli.server_process(${port})`,
      "assert refusal is None and owner is not None, (owner, refusal)",
      becomes === "None" ? "PROCS.pop(4242, None)" : `PROCS[4242] = ${becomes}`,
      `refusal = cli.stop_server(owner, ${port})`,
      "say({'refusal': refusal})",
    ].join("\n"));
    const seen = readEvents(stdout);
    assert.equal(signalsIn(seen.events).length, 0, `SIGTERM was sent after ${name}`);
    assert.match(String(seen.refusal), /pid 4242 is not the process that was read a moment ago/,
      `stop_server did not refuse ${name}: ${seen.refusal}`);
    assert.match(String(seen.refusal), /nothing was signalled/);
  }
});

test("the identity carried through is the whole of it, not just the number and the time", async () => {
  // the mocked comparison root ran: same pid, same start, different command
  const { stdout } = await probe([
    harness({}),
    `owner, _ = cli.server_process(${port})`,
    "changed = (owner[0], (owner[1][0], ACCEPTED, (ACCEPTED, '/somewhere/else/other.py')))",
    "print(json.dumps({'carries_command': owner != changed,",
    "                  'identity_parts': len(owner[1])}))",
  ].join("\n"));
  const got = lastJson(stdout);
  assert.equal(got.carries_command, true,
    "two different commands under the same pid and start time compare equal");
  assert.equal(got.identity_parts, 3, "the identity is not (started, executable, argv)");
});

test("a pid that is no longer the one listener gets no signal either", async () => {
  const { stdout } = await probe([
    harness({}),
    `owner, _ = cli.server_process(${port})`,
    "LISTENERS.clear()",
    "LISTENERS.add(909)",
    "PROCS[909] = ident(909)",
    `gone = cli.stop_server(owner, ${port})`,
    "LISTENERS.add(4242)",
    `both = cli.stop_server(owner, ${port})`,
    "say({'gone': gone, 'both': both})",
  ].join("\n"));
  const seen = readEvents(stdout);
  assert.equal(signalsIn(seen.events).length, 0, "something was signalled after the listener changed");
  assert.match(seen.gone, /pid 4242 is no longer the one listener on \d+ \(909 is\); nothing was signalled/);
  assert.match(seen.both, /pid 4242 is no longer the one listener on \d+ \(909, 4242 is\); nothing was signalled/);
});

test("a listing that goes unreadable between the look and the signal gets no signal", async () => {
  const { stdout } = await probe([
    harness({ listingUnknownAfter: 1 }),
    `owner, refusal = cli.server_process(${port})`,
    "assert refusal is None, refusal",
    `refusal = cli.stop_server(owner, ${port})`,
    "say({'refusal': refusal})",
  ].join("\n"));
  const seen = readEvents(stdout);
  assert.equal(signalsIn(seen.events).length, 0, "a signal went out on an unreadable listing");
  assert.match(String(seen.refusal), /cannot read what is listening on \d+ any more; nothing was signalled/);
});

test("the identity is read twice, and the second read is the last thing before the signal", async () => {
  const run = await restart({});
  assert.equal(run.ok, true, run.stderr);
  const order = kinds(run.events);
  const reads = order.slice(0, order.indexOf("kill"));
  assert.equal(reads.filter(k => k === "process_identity").length, 2,
    `the identity was read ${reads.filter(k => k === "process_identity").length} times before the signal`);
  assert.equal(reads.at(-1), "process_identity", "the signal did not follow straight on from an identity read");
  assert.equal(reads.at(-2), "listener_pids", "the listening pid was not re-read before the signal");
});

// --- gap 3: the timeout says what was established, and hands out no pids ---

test("no message anywhere hands the reader a pid to kill", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /kill \{pid\}|kill \{owner|\(kill /,
    "the CLI prints a pid to kill by hand again");

  for (const options of [{ ignoresTerm: true }, { reusedAfterTerm: true },
                         { livesOnAfterTerm: true }, { portStaysHeld: true },
                         { reusedOffPort: true }, { unreadableAfterTerm: true }]) {
    const run = await restart(options);
    assert.equal(run.ok, false, `${JSON.stringify(options)} was called a restart`);
    assert.doesNotMatch(run.stderr, /kill \d+/, `kill advice for ${JSON.stringify(options)}: ${run.stderr}`);
    assert.equal(kinds(run.events).includes("popen"), false,
      `a replacement was started for ${JSON.stringify(options)}`);
    assert.equal(signalsIn(run.events).length, 1, "the stop escalated or signalled twice");
  }
});

test("a stop that times out reports the condition it actually established", async () => {
  const stuck = await restart({ ignoresTerm: true });
  assert.match(stuck.stderr,
    /the server on \d+ had not let go 10s after SIGTERM and is still the same process; it was left alone/,
    stuck.stderr);

  // the number outlived the process and now belongs to another listener: that
  // is known to be different, and must not be called the server
  const reused = await restart({ reusedAfterTerm: true });
  assert.match(reused.stderr,
    /port \d+ is still held under the same number by a different process from the one that was signalled/,
    reused.stderr);
  assert.doesNotMatch(reused.stderr, /the server on \d+ had not let go/,
    "a different process under the same number was called the server");

  // still on the port, but nothing can be read about it: that is unknown, not
  // proved different
  const unreadable = await restart({ unreadableAfterTerm: true });
  assert.match(unreadable.stderr,
    /port \d+ is still held under the same number and what that process is now could not be read/,
    unreadable.stderr);
  assert.doesNotMatch(unreadable.stderr, /a different process/,
    "an unreadable identity was reported as a proved change");

  // the socket went but the process did not: it must not be called gone
  const living = await restart({ livesOnAfterTerm: true });
  assert.match(living.stderr,
    /the server let go of port \d+ but was still running 10s after SIGTERM; nothing was started, because a restart waits for the old server to finish leaving/,
    living.stderr);
  assert.doesNotMatch(living.stderr, /is no longer there|has gone|is gone/,
    "a process that is still running was reported as gone");

  // the number was reused by something that is not on the port at all: still
  // alive, but it is not the server and must not be described as one
  const elsewhere = await restart({ reusedOffPort: true });
  assert.match(elsewhere.stderr,
    /a different process with the same number let go of port \d+ but was still running 10s after SIGTERM/,
    elsewhere.stderr);
  assert.doesNotMatch(elsewhere.stderr, /^restart: the server /m,
    "a reused number was called the server");

  // the process went but the socket did not, and it can no longer be read
  const lingering = await restart({ portStaysHeld: true });
  assert.match(lingering.stderr,
    /port \d+ is still held under the same number and what that process is now could not be read/,
    lingering.stderr);
  assert.ok(lingering.events.filter(e => e[0] === "listener_pids").length > 10,
    "the socket was not polled while the wait ran");
});

test("a port taken over by another pid during the stop is named as such", async () => {
  const { stdout } = await probe([
    harness({}),
    `owner, _ = cli.server_process(${port})`,
    "LISTENERS.clear()",
    "LISTENERS.add(909)",
    "PROCS[909] = ident(909)",
    `refusal = cli.stop_timeout_reason(owner, ${port}, 10.0)`,
    "say({'refusal': refusal})",
  ].join("\n"));
  const seen = readEvents(stdout);
  assert.match(String(seen.refusal),
    /port \d+ is listened on by 909 now, which is not the process that was signalled; nothing was started and nothing else was signalled/,
    String(seen.refusal));
  assert.doesNotMatch(String(seen.refusal), /kill \d+/);
  assert.equal(signalsIn(seen.events).length, 0);
});

// --- gap 4: readiness is a board state from the exact replacement ----------

test("an answer that is not JSON is no answer, and raises nothing", async () => {
  const { stdout } = await probe([
    "import io",
    "class Answer:",
    "    def __init__(self, body):",
    "        self.body = body",
    "    def __enter__(self):",
    "        return io.StringIO(self.body)",
    "    def __exit__(self, *rest):",
    "        return False",
    "def serve(body):",
    "    cli.urllib = types.SimpleNamespace(",
    "        request=types.SimpleNamespace(urlopen=lambda *a, **kw: Answer(body)))",
    "out = {}",
    "serve('<html>not this board at all</html>')",
    `out['html'] = cli.state(${port})`,
    "serve('{\"boxes\": [], \"listening\": {}, \"busy\": {}, \"listenerGap\": {}}')",
    `out['good'] = cli.board_state(${port}) is not None`,
    "serve('3')",
    `out['bare_number'] = cli.board_state(${port})`,
    "serve('[]')",
    `out['list'] = cli.board_state(${port})`,
    "serve('{\"boxes\": [], \"listening\": [], \"busy\": {}, \"listenerGap\": {}}')",
    `out['wrong_shape'] = cli.board_state(${port})`,
    "serve('{\"ok\": true}')",
    `out['other_service'] = cli.board_state(${port})`,
    "print(json.dumps(out))",
  ].join("\n"));
  const got = lastJson(stdout);
  assert.equal(got.html, null, "a non-JSON answer was not read as no answer");
  assert.equal(got.good, true, "a real board state was rejected");
  assert.equal(got.bare_number, null, "a bare JSON number passed as a board");
  assert.equal(got.list, null);
  assert.equal(got.wrong_shape, null, "a state with the wrong shapes passed as a board");
  assert.equal(got.other_service, null, "another service's JSON passed as a board");
});

test("a wrong-shaped answer keeps readiness pending and never reports a restart", async () => {
  for (const stateShape of ["NOT_DICT", "WRONG_KEYS"]) {
    const run = await restart({ stateShape });
    assert.equal(run.ok, false, `${stateShape} was accepted as a started board`);
    assert.doesNotMatch(run.stderr, /Traceback/, `a traceback escaped for ${stateShape}: ${run.stderr}`);
    assert.match(run.stderr,
      /the replacement \(pid 5150\) did not answer on \d+ with a board state within 20s/, run.stderr);
    assert.equal(kinds(run.events).includes("open_app"), false, "a window was opened for a bad answer");
    assert.equal(run.events.filter(e => e[0] === "popen").length, 1, "a second child was started");
    assert.deepEqual(run.said, [], "a restart was reported for an answer that is not a board");
  }
});

test("a port answered by something else is a refusal, and that process is never signalled", async () => {
  const run = await restart({ newListener: 7777, newListenerOurs: false });
  assert.equal(run.ok, false, "a foreign answer on the port was called a restart");
  assert.match(run.stderr,
    /restart: \d+ is answered by 7777, not by the replacement \(pid 5150\); the restart stopped here and nothing was signalled/,
    run.stderr);
  assert.deepEqual(signalsIn(run.events).map(e => e[1]), [4242], "something else was signalled");
  assert.equal(run.events.some(e => e[0] === "kill" && e[1] === 7777), false,
    "the foreign process on the port was signalled");
  assert.equal(kinds(run.events).includes("open_app"), false);
  assert.equal(run.events.filter(e => e[0] === "popen").length, 1);
});

test("a takeover is refused whether the replacement is alive or has already exited", async () => {
  const run = await restart({ newListener: 7777, newListenerOurs: false, childExit: 1 });
  assert.equal(run.ok, false, "a dead child plus a foreign answer was called a restart");
  assert.match(run.stderr, /is answered by 7777, not by the replacement \(pid 5150\)/, run.stderr);
  assert.equal(run.events.some(e => e[0] === "kill" && e[1] === 7777), false,
    "the foreign process on the port was signalled");
});

test("a replacement that exited while the port answers is a refusal", async () => {
  const run = await restart({ childExit: 3 });
  assert.equal(run.ok, false, "an exited replacement was called a restart");
  assert.match(run.stderr,
    /the replacement \(pid 5150\) has exited even though \d+ still answers; the restart stopped here/, run.stderr);
  assert.equal(kinds(run.events).includes("open_app"), false);
});

test("a listener that does not read back as this folder's server is a refusal", async () => {
  const run = await restart({ newListenerOurs: false });
  assert.equal(run.ok, false, "a listener with a foreign identity was accepted as the replacement");
  assert.match(run.stderr, /pid 5150 holds \d+ but does not read back as .*server\.py; the restart stopped here/,
    run.stderr);
  assert.equal(kinds(run.events).includes("open_app"), false);
});

test("an answer nobody is listed as listening for is a refusal", async () => {
  const run = await restart({ newListener: null });
  assert.equal(run.ok, false, "an unattributable answer was accepted");
  assert.match(run.stderr, /is answered by nothing, not by the replacement \(pid 5150\)/, run.stderr);
});

test("an unreadable listing at the moment of confirmation is a refusal, not a success", async () => {
  const run = await restart({ listingUnknownAfter: 4 });
  assert.equal(run.ok, false, "the confirmation accepted an answer it could not attribute");
  assert.match(run.stderr,
    /something is answering on \d+ but what is listening could not be read; the restart stopped here and nothing was signalled/,
    run.stderr);
  assert.equal(kinds(run.events).includes("open_app"), false);
});

test("port_free is three answers, and an unreadable listing is never free", async () => {
  const { stdout } = await probe([
    "answers = []",
    "cli.listener_pids = lambda port: answers.pop(0)",
    "out = {}",
    "answers.append(None)",
    `out['unknown'] = cli.port_free(${port})`,
    "answers.append(set())",
    `out['empty'] = cli.port_free(${port})`,
    "answers.append({4242})",
    `out['held'] = cli.port_free(${port})`,
    "print(json.dumps(out))",
  ].join("\n"));
  const got = lastJson(stdout);
  assert.equal(got.unknown, null, "an unreadable listing was called free because a bind succeeded");
  assert.equal(got.empty, true);
  assert.equal(got.held, false);
});

test("a listing that goes unreadable after the stop starts nothing", async () => {
  const run = await restart({ listingUnknownAfter: 3 });
  assert.equal(run.ok, false, "a child was started over a port nothing could read");
  assert.match(run.stderr, /restart: cannot read what is listening on \d+; nothing new was started/, run.stderr);
  assert.equal(kinds(run.events).includes("popen"), false);
  assert.deepEqual(run.said, [], "a restart that failed printed progress lines");
  assert.match(run.stderr, /The board is down now; start it with: facilitator run/, run.stderr);
});

// --- the ordinary path, and everything around it --------------------------

test("the order is stop, wait for the socket, start, confirm the child, then the window", async () => {
  const run = await restart({ chrome: [] });
  assert.equal(run.ok, true, run.stderr);

  const signals = signalsIn(run.events);
  assert.equal(signals.length, 1, `more than one signal was sent: ${JSON.stringify(signals)}`);
  assert.deepEqual(signals[0].slice(1), [4242, 15], "the stop was not one SIGTERM to the one pid");

  assert.deepEqual(kinds(run.events), [
    "listener_pids", "process_identity",      // who is listening, and what it is
    "listener_pids", "process_identity",      // both read again, right before
    "kill",                                   // one SIGTERM
    "kill",                                   // the liveness probe in the wait
    "listener_pids",                          // the port, polled, not slept on
    "listener_pids",                          // and read once more before launching
    "popen",
    "state",                                  // a board state answers
    "listener_pids", "process_identity",      // and it is the child, and it is ours
    "chrome",
    "open_app",
  ], "the lifecycle no longer reads what it is about to act on");

  const launched = run.events.find(e => e[0] === "popen");
  assert.match(launched[1][1], /server\.py$/, launched[1].join(" "));
  assert.equal(launched[2], true, "the replacement does not outlive the terminal that started it");
  assert.equal(launched[3], true, "the replacement's output is being caught again");
  assert.equal(launched[4], true, "the replacement's errors are being caught again");

  assert.deepEqual(run.said, ["Board restarted."]);
});

// one top-level Python function's code, from its def to the line before the next
// top-level statement, with docstrings and comments taken out
const pySource = (source, name) => {
  const found = source.match(new RegExp(`^def ${name}\\([\\s\\S]*?\\n(?=\\S)`, "m"));
  assert.ok(found, `${name} is not in the CLI`);
  return found[0].replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "");
};

test("the only signals the CLI can send are one SIGTERM, one liveness probe and, for stop --force alone, one SIGKILL",
  async () => {
    const source = await readFile(cliPath, "utf8");
    const calls = [...source.matchAll(/os\.kill\(([^)]*)\)/g)].map(m => m[1].trim()).sort();
    assert.deepEqual(calls, ["pid, 0", "pid, signal.SIGKILL", "pid, signal.SIGTERM"],
      `the CLI signals something else now: ${calls.join(" | ")}`);
    assert.doesNotMatch(source, /killpg|getpgid|pkill|killall/,
      "the CLI can now reach a whole process group");

    // the SIGKILL has one home, and one caller that only reaches it under --force
    assert.ok(pySource(source, "end_server").includes("os.kill(pid, signal.SIGKILL)"),
      "the SIGKILL is no longer in end_server");
    assert.equal([...source.matchAll(/\bend_server\(/g)].length, 2,
      "end_server has a caller other than stop_board");
    const board = pySource(source, "stop_board");
    const gate = board.indexOf("if not force:");
    const call = board.indexOf("end_server(");
    assert.ok(gate !== -1 && call > gate && board.slice(gate, call).includes("return"),
      "stop_board reaches the SIGKILL without --force");
    for (const polite of ["stop_server", "signal_server", "wait_for_exit", "cmd_restart"]) {
      assert.doesNotMatch(pySource(source, polite), /SIGKILL|end_server/,
        `${polite} can now reach the SIGKILL`);
    }
  });

test("only the listening socket's owner is ever looked at, never a connection", async () => {
  const { stdout } = await probe([
    "asked = []",
    "def fake_run(argv, **kw):",
    "    asked.append(list(argv))",
    "    return types.SimpleNamespace(returncode=0, stdout='4242\\n', stderr='')",
    "cli.subprocess = types.SimpleNamespace(run=fake_run, SubprocessError=subprocess.SubprocessError)",
    `print(json.dumps({'pids': sorted(cli.listener_pids(${port})), 'asked': asked}))`,
  ].join("\n"));
  const seen = lastJson(stdout);
  assert.deepEqual(seen.pids, [4242]);
  const argv = seen.asked.at(-1);
  assert.ok(argv.includes("-sTCP:LISTEN"), `lsof was not limited to listeners: ${argv.join(" ")}`);
  assert.ok(argv.includes(`-iTCP:${port}`), argv.join(" "));
  assert.ok(argv.includes("-t"), argv.join(" "));
});

test("a complaining lsof is an unknown, not an empty port", async () => {
  const { stdout } = await probe([
    "def bad(argv, **kw):",
    "    return types.SimpleNamespace(returncode=1, stdout='', stderr='lsof: no pwd entry')",
    "cli.subprocess = types.SimpleNamespace(run=bad, SubprocessError=subprocess.SubprocessError)",
    `print(json.dumps({'unknown': cli.listener_pids(${port}) is None}))`,
  ].join("\n"));
  assert.equal(lastJson(stdout).unknown, true);
});

test("a replacement that dies at once is said plainly, and no window follows", async () => {
  const run = await restart({ childExit: 1, answers: false, newListener: null });
  assert.equal(run.ok, false, "a replacement that died was reported as a restart");
  assert.match(run.stderr, /restart: the replacement did not start; run .* .*server\.py by hand to see why/,
    run.stderr);
  assert.equal(run.events.filter(e => e[0] === "popen").length, 1, "it tried again after a dead child");
  assert.equal(kinds(run.events).includes("open_app"), false);
});

test("a replacement that never answers times out, and nothing is opened or started twice", async () => {
  const run = await restart({ answers: false, newListener: null });
  assert.equal(run.ok, false, "a server that never answered was called up");
  assert.match(run.stderr,
    /the replacement \(pid 5150\) did not answer on \d+ with a board state within 20s; it was left alone/,
    run.stderr);
  assert.equal(run.events.filter(e => e[0] === "popen").length, 1);
  assert.equal(kinds(run.events).includes("open_app"), false);
  const waited = run.events.filter(e => e[0] === "sleep").reduce((sum, e) => sum + e[1], 0);
  assert.ok(waited > 19.5 && waited < 20.6, `the start deadline was ${waited}s, not twenty`);
});

test("a page that is already there is left alone and named for reloading", async () => {
  // NOTE: these URLs stand in for what Chrome reports. A tab-shaped URL is not
  // proof that a native chromeless --app window appears in the inventory; that
  // check is the coordinator's and is not made here. What is proved here is
  // the decision made once the URLs are in.
  for (const url of [`http://127.0.0.1:${port}/?card=12`, `http://localhost:${port}`]) {
    const run = await restart({ chrome: ["chrome://newtab/", "https://example.com/", url] });
    assert.equal(run.ok, true, run.stderr);
    assert.equal(kinds(run.events).includes("open_app"), false, `a second window was opened over ${url}`);
    assert.deepEqual(run.said, ["Board restarted.", "Reload the board (command + R)."]);
    assert.deepEqual(run.events.filter(e => e[0] === "run"), [], "something was said to the page itself");
  }
});

test("no page anywhere means exactly one new app window, through the usual opening", async () => {
  const run = await restart({
    chrome: [`http://127.0.0.1:${port + 1}/`, "https://example.com/"], openApp: "REAL",
  });
  assert.equal(run.ok, true, run.stderr);
  const opened = run.events.filter(e => e[0] === "run" && e[1][0] === "open");
  assert.equal(opened.length, 1, `the window was opened ${opened.length} times`);
  assert.deepEqual(opened[0][1], ["open", "-na", "Google Chrome", "--args", `--app=http://127.0.0.1:${port}`]);
  assert.deepEqual(run.said, ["Board restarted."], "a window that opened was announced");
});

test("a window that fails to open is said in one line, never reported as opened", async () => {
  const run = await restart({
    chrome: [], openApp: "REAL", openFails: "Unable to find application named 'Google Chrome'",
  });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, [
    "Board restarted.",
    `could not open Chrome (Unable to find application named 'Google Chrome'); open http://127.0.0.1:${port} yourself`,
  ]);
});

test("a browser that could not be asked is an unknown: no window and nothing said about it", async () => {
  const run = await restart({ chrome: null });
  assert.equal(run.ok, true, run.stderr);
  assert.equal(kinds(run.events).includes("open_app"), false,
    "a browser that could not be read was treated as a browser with nothing open");
  assert.deepEqual(run.said, ["Board restarted."]);
});

test("the matching rule: loopback spellings and cards yes, other ports and sites no", async () => {
  const board = `http://127.0.0.1:${port}`;
  const cases = {
    [`http://127.0.0.1:${port}`]: true,
    [`http://127.0.0.1:${port}/`]: true,
    [`http://localhost:${port}/`]: true,
    [`http://127.0.0.2:${port}/`]: true,
    [`HTTP://LOCALHOST:${port}/`]: true,
    [`http://[::1]:${port}/`]: true,
    [`http://127.0.0.1:${port}/?card=17`]: true,
    [`http://127.0.0.1:${port}/#box-3`]: true,
    [`http://127.0.0.1:${port}/?card=17#note`]: true,
    [`http://127.0.0.1:${port + 1}/`]: false,
    [`http://127.0.0.1:${port}/m`]: false,
    [`https://127.0.0.1:${port}/`]: false,
    [`http://example.com:${port}/`]: false,
    [`http://board.example.com/?port=${port}`]: false,
    "chrome://newtab/": false,
    "about:blank": false,
    "": false,
  };
  const { stdout } = await probe([
    `board = ${JSON.stringify(board)}`,
    `urls = ${JSON.stringify(Object.keys(cases))}`,
    "print(json.dumps({u: cli.same_board_page(u, board) for u in urls}))",
  ].join("\n"));
  const got = lastJson(stdout);
  for (const [url, want] of Object.entries(cases)) {
    assert.equal(got[url], want, `${JSON.stringify(url)} should ${want ? "" : "not "}match the board`);
  }
});

test("the browser is only ever read: nothing in the script drives it", async () => {
  const source = await readFile(cliPath, "utf8");
  const start = source.indexOf('tell application "System Events"');
  const end = source.indexOf("return found as text");
  assert.ok(start !== -1 && end > start, "the browser script is not where it was");
  const script = source.slice(start, end);
  for (const verb of ["activate", "reload", "close", "delete", "set URL", "make new", "open location"]) {
    assert.ok(!script.includes(verb), `the browser script can ${verb} a page: ${script}`);
  }
  assert.ok(script.includes("every window") && script.includes("every tab of w"),
    "the browser script no longer walks every window's tabs, so app windows can be missed");
  assert.ok(script.includes('exists process "Google Chrome"'),
    "Chrome is spoken to before it is known to be running, which can start it");

  // stop's window walk reads in the same way, and only the close script closes
  const walk = pySource(source, "chrome_windows");
  for (const verb of ["activate", "reload", "close", "delete", "set URL", "make new", "open location"]) {
    assert.ok(!walk.includes(verb), `the window walk can ${verb} a page: ${walk}`);
  }
  assert.ok(walk.includes("every window") && walk.includes("every tab of w"),
    "the window walk no longer reads every window's tabs");
  assert.ok(walk.includes('exists process "Google Chrome"'),
    "the window walk speaks to Chrome before it is known to be running");

  // the one script that closes sits after both reading scripts, in a constant of its own
  const closer = source.indexOf("CLOSE_WINDOW_SCRIPT = ");
  assert.ok(closer > end, "the close script is inside the reading slice");
  assert.equal(source.split("close win").length - 1, 1, "more than one place closes a window");
  assert.ok(source.indexOf("close win") > closer, "a window is closed outside the close script");
  for (const reader of ["chrome_page_urls", "chrome_windows", "board_page_open"]) {
    assert.ok(!pySource(source, reader).includes("CLOSE_WINDOW_SCRIPT"),
      `${reader} can reach the close script`);
  }
});

test("with nothing listening, restart simply starts the server and signals no one", async () => {
  const run = await restart({ listeners: [] });
  assert.equal(run.ok, true, run.stderr);
  assert.equal(signalsIn(run.events).length, 0, "something was signalled");
  assert.equal(run.events.filter(e => e[0] === "popen").length, 1);
  assert.deepEqual(run.said, ["Board started."]);
  assert.deepEqual(run.events.filter(e => e[0] === "open_app"), [["open_app", false]]);
});

test("a start that fails when nothing was listening does not claim the board went down", async () => {
  const run = await restart({ listeners: [], childExit: 1, answers: false, newListener: null });
  assert.equal(run.ok, false);
  assert.match(run.stderr, /restart: the replacement did not start/, run.stderr);
  assert.doesNotMatch(run.stderr, /board is down/i, "a board that was never up was said to have gone down");
});

test("a restart that stopped the old server and could not start the new one says the board is down", async () => {
  const cases = {
    "the replacement dies at once": { childExit: 1, answers: false, newListener: null },
    "the replacement never answers": { answers: false, newListener: null },
    "the port stays held after the stop": { portStaysHeld: true },
  };
  for (const [name, options] of Object.entries(cases)) {
    const run = await restart(options);
    assert.equal(run.ok, false, name);
    assert.doesNotMatch(run.stderr, /Traceback/, run.stderr);
    assert.match(run.stderr, /^restart: .*\. The board is down now; start it with: facilitator run\n?$/m,
      `${name}: ${run.stderr}`);
    assert.deepEqual(run.said, [], `${name}: progress lines were printed`);
  }
});

test("a restart that left the old server running does not say the board is down", async () => {
  const run = await restart({ ignoresTerm: true });
  assert.equal(run.ok, false);
  assert.match(run.stderr, /had not let go 10s after SIGTERM/, run.stderr);
  assert.doesNotMatch(run.stderr, /board is down/i, "a board that is still serving was said to be down");
});

test("--dry-run signals nothing, starts nothing and opens nothing", async () => {
  const running = await restart({ chrome: [] }, "['restart', '--dry-run']");
  assert.equal(running.ok, true, running.stderr);
  assert.deepEqual(kinds(running.events).filter(k => ["kill", "popen", "open_app", "run"].includes(k)), [],
    `a dry run did something: ${JSON.stringify(running.events)}`);
  assert.match(running.said[0], new RegExp(`^restart: would SIGTERM pid 4242 on ${port}, wait up to 10s`));
  assert.match(running.said[1], /would open one app window$/);

  const idle = await restart({ listeners: [], chrome: [`http://127.0.0.1:${port}/`] },
    "['restart', '--dry-run']");
  assert.equal(idle.ok, true, idle.stderr);
  assert.deepEqual(kinds(idle.events).filter(k => ["kill", "popen", "open_app", "run"].includes(k)), []);
  assert.match(idle.said[0], new RegExp(`^restart: nothing is listening on ${port}; would start `));
  assert.match(idle.said[1], /is already open; would leave it alone$/);
});

test("run is untouched: still server, window, and no tmux without being asked", async () => {
  const laneConfig = JSON.stringify({
    port, lanes: [{ owner: "facilitator", instruction: "go and listen" }],
  });
  const { stdout } = await probe([
    harness({ listeners: [], chrome: null }),
    `cli.load_config = lambda: json.loads(${JSON.stringify(laneConfig)})`,
    "def boom(*a, **kw):",
    "    raise AssertionError('run touched tmux on its own')",
    "cli.instruct = boom",
    "cli.spawn = boom",
    "cli.cmd_run(['run'])",
    "say()",
  ].join("\n"));
  const { said, events } = readEvents(stdout);
  assert.deepEqual(events.filter(e => e[0] === "open_app"), [["open_app", false]],
    "run no longer opens its window, or opens it twice");
  assert.equal(events.filter(e => e[0] === "popen").length, 1, "run no longer starts the server");
  assert.deepEqual(said, [
    `Board up on http://127.0.0.1:${port}`,
    "Facilitator is live!",
  ]);
  assert.equal(events.filter(e => e[0] === "kill").length, 0, "run signalled something");
  // run confirms a start the way it always did, by asking /state; neither the
  // listener checks nor the stricter readiness belong to it
  assert.equal(events.filter(e => e[0] === "listener_pids").length, 0,
    "run now depends on the process listing");
  assert.equal(events.filter(e => e[0] === "process_identity").length, 0,
    "run now depends on reading process identities");
});

// ---------------------------------------------------------------------------
// The real thing: a board of its own on an ephemeral port, restarted through
// the CLI's own command, with the real kernel identity reader doing the
// recognising. Only the browser is stubbed. Every pid this test touches is one
// it started, and the whole fixture, including the folders the server makes
// beside itself, lives under one temporary folder that goes at the end whether
// the assertions passed or not.
const owned = new Set();
let liveNest;
let livePort;

async function liveProbe(code) {
  return execFileAsync("python3", ["-c", `${loadCli(path.join(liveNest, "board", "facilitator"))}\n${code}`], {
    cwd: path.join(liveNest, "board"),
    env: {
      ...process.env,
      FACILITATOR_TEST_PORT: String(livePort),
      FACILITATOR_LOG_DIR: path.join(liveNest, "logs"),
    },
    timeout: 90000,
  });
}

async function livePortFree() {
  try {
    await fetch(`http://127.0.0.1:${livePort}/state`);
    return false;
  } catch {
    return true;
  }
}

async function stopOwned(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

after(async () => {
  for (const pid of owned) await stopOwned(pid);
  if (liveNest) await rm(liveNest, { recursive: true, force: true });
});

test("a real restart: the old server goes, the port frees, the new one answers with the same board",
  async () => {
    await access(path.join(ROOT, ".venv", "bin", "python3"), constants.X_OK);
    liveNest = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-restart-live-")));
    const board = path.join(liveNest, "board");
    await mkdir(board);
    livePort = await freePort();
    await copyFile(path.join(ROOT, "facilitator"), path.join(board, "facilitator"));
    const source = await readFile(path.join(ROOT, "server.py"), "utf8");
    const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
    assert.notEqual(patched, source, "test server port was not patched");
    await writeFile(path.join(board, "server.py"), patched);
    require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(board, "server.py")));
    await writeFile(path.join(board, "run.config.json"), JSON.stringify({ port: livePort, lanes: [] }));
    await writeFile(path.join(board, "seed.json"), JSON.stringify({
      title: "cli restart fixture",
      items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
    }));
    await symlink(path.join(ROOT, ".venv"), path.join(board, ".venv"));

    try {
      const launched = await liveProbe([
        "started = {}",
        "real_popen = cli.subprocess.Popen",
        "def popen(argv, **kw):",
        "    child = real_popen(argv, **kw)",
        "    started['pid'] = child.pid",
        "    return child",
        "cli.subprocess.Popen = popen",
        `cli.ensure_server(${livePort}, False)`,
        "print(json.dumps(started))",
      ].join("\n"));
      const first = JSON.parse(launched.stdout.trim().split("\n").at(-1));
      owned.add(first.pid);
      assert.ok(first.pid > 0);

      const before = await (await fetch(`http://127.0.0.1:${livePort}/state`)).json();
      assert.equal(before.title, "cli restart fixture");
      assert.equal((await fetch(`http://127.0.0.1:${livePort}/send?box=0`,
        { method: "POST", body: "kept across the restart" })).status, 200);

      // the real reader against a real process: the vector the fixture server
      // is actually running, and the board state readiness will look for
      const identity = await liveProbe([
        `read = cli.process_argv(${first.pid})`,
        "print(json.dumps({",
        "  'argv': read[1] if read else None,",
        `  'started': cli.process_started(${first.pid}),`,
        `  'ours': cli.is_our_server(${first.pid}),`,
        `  'owner': cli.server_process(${livePort})[0],`,
        `  'board_state': cli.board_state(${livePort}) is not None,`,
        "}))",
      ].join("\n"));
      const read = JSON.parse(identity.stdout.trim().split("\n").at(-1));
      assert.ok(Array.isArray(read.argv), "the kernel would not give up the server's argument vector");
      assert.equal(read.argv.length, 2, `the server's vector was ${JSON.stringify(read.argv)}`);
      assert.equal(read.argv[1], path.join(board, "server.py"));
      assert.ok(Array.isArray(read.started) && read.started[0] > 1500000000);
      assert.equal(read.ours, true, "the running server did not read back as this folder's server");
      assert.equal(read.owner[0], first.pid, "the owner of the port is not the process that was started");
      assert.deepEqual(read.owner[1][2], read.argv, "the owner identity does not carry the vector");
      assert.equal(read.board_state, true, "the running board's state did not pass the readiness check");

      // the restart itself: only the browser is stood in for. Whatever
      // happens, the last line says which pid is on the port now, so the
      // cleanup below owns the replacement even when an assertion fails.
      const restarted = await liveProbe([
        "cli.chrome_page_urls = lambda: []",
        "opened = []",
        "cli.open_app = lambda cfg, dry: opened.append(dry)",
        "def owner_pid():",
        `    owner = cli.server_process(${livePort})[0]`,
        "    return owner[0] if owner else None",
        "out = {'before': None, 'after': None, 'opened': opened}",
        "try:",
        "    out['before'] = owner_pid()",
        "    cli.cmd_restart(['restart'])",
        "finally:",
        "    try:",
        "        out['after'] = owner_pid()",
        "    except Exception:",
        "        pass",
        "    print(json.dumps(out))",
      ].join("\n")).then(done => done, error => error);
      const seen = JSON.parse(String(restarted.stdout || "").trim().split("\n").at(-1));
      if (seen.after) owned.add(seen.after);
      assert.ok(!(restarted instanceof Error), `the restart itself failed: ${restarted.stderr || ""}`);

      assert.equal(seen.before, first.pid, "restart found a different process than the one started");
      assert.ok(seen.after > 0, "no server is listening after the restart");
      assert.notEqual(seen.after, first.pid, "the old process is still the one on the port");
      assert.deepEqual(seen.opened, [false], "the window was not opened exactly once for an empty browser");

      const said = restarted.stdout.trim().split("\n");
      assert.equal(said[0], "Board restarted.");
      assert.equal(said.length, 2, "the restart said more than the one line: " + restarted.stdout);

      let oldStillThere = true;
      try { process.kill(first.pid, 0); } catch { oldStillThere = false; }
      assert.equal(oldStillThere, false, "the old server is still running after the restart");

      const back = await (await fetch(`http://127.0.0.1:${livePort}/state`)).json();
      assert.equal(back.title, "cli restart fixture");
      assert.deepEqual(back.boxes.find(b => b.id === "0").pendingTexts, ["kept across the restart"],
        "the restart lost the queued message");
      assert.ok(back.rev > before.rev, "the revision did not carry across the restart");
      const saved = JSON.parse(await readFile(path.join(board, "state.json"), "utf8"));
      assert.equal(saved.rev, back.rev);

      const status = await liveProbe("cli.cmd_status()");
      assert.match(status.stdout, /^server up, \d+ boxes, 1 queued/m, status.stdout);

      const logDir = path.join(liveNest, "logs");
      const files = await readdir(logDir).catch(() => []);
      const logged = (await Promise.all(files.map(name =>
        readFile(path.join(logDir, name), "utf8").catch(() => "")))).join("");
      if (logged.includes("\"stop\"") || logged.includes("'stop'")) {
        assert.match(logged, /SIGTERM/, "the stop was not the graceful one the server writes down");
      }
    } finally {
      for (const pid of owned) await stopOwned(pid);
      const deadline = Date.now() + 8000;
      while (!(await livePortFree()) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  });
