// What `facilitator stop` is allowed to touch, and in what order.
//
// The command ends one process, then closes at most the windows that show
// nothing but the board, so nearly every test here is about what it does NOT
// do: it does not signal a foreign listener, a second listener or a pid whose
// identity changed; it does not reach for SIGKILL unless --force was given and
// the polite wait has run out; it does not call a stop done while a port is
// held or cannot be read; it does not close a window after a refused or failed
// stop; it does not close a window that shows anything besides the board; it
// does not start Chrome; and it does not touch a saved file or the phone link.
//
// Most tests drive the CLI's own functions against a deterministic model of a
// process table, a listing, a clock and Chrome. The last two are the real thing
// on an ephemeral pair of ports in a nested temporary folder, with Chrome and
// the phone link stubbed; they clean up only what they started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:net");
const { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } =
  require("node:fs/promises");
const { constants } = require("node:fs");
const { access } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const DARWIN = process.platform === "darwin";
const TERM = 15;
const KILL = 9;

let nestDir;      // the fixture's parent, so the server's sibling folders land inside it
let fixtureDir;   // a copy of the CLI, so nothing here touches the real one
let cliPath;
let port;         // ephemeral, never 8877; port + 1 is free as well

function listenOn(number) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(number, "127.0.0.1", () => resolve(server));
  });
}

async function canBind(number) {
  try {
    const server = await listenOn(number);
    await new Promise(resolve => server.close(resolve));
    return true;
  } catch {
    return false;
  }
}

// a port whose neighbour above it is free too, because the board holds both
async function freePair() {
  for (let tries = 0; tries < 50; tries += 1) {
    const probeServer = await listenOn(0);
    const chosen = probeServer.address().port;
    await new Promise(resolve => probeServer.close(resolve));
    if (chosen < 65000 && await canBind(chosen + 1)) return chosen;
  }
  throw new Error("no free pair of ports");
}

function loadCli(where) {
  return [
    "import importlib.machinery, importlib.util, json, os, pathlib, signal, subprocess, sys, time, types",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(where)})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

async function probe(code, { dir = fixtureDir, cli = cliPath, env = {}, timeout = 60000 } = {}) {
  return execFileAsync("python3", ["-c", `${loadCli(cli)}\n${code}`], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_LOG_DIR: path.join(nestDir, "logs"), ...env },
    timeout,
  });
}

const lastJson = stdout => JSON.parse(String(stdout).trim().split("\n").at(-1));

const DEFAULTS = {
  listen: { 0: [4242], 1: [4242] },  // port offset -> pids listening there
  command: "OURS",                   // what the table says they are: OURS, FOREIGN, UNREADABLE
  listing: "OK",                     // OK, or UNREADABLE for an lsof that cannot answer
  listingUnknownAfter: null,         // the listing goes unreadable after this many looks
  unreadableOffset: null,            // this port's listing is never readable
  unreadableAfterDeathOffset: null,  // this port's listing is unreadable once the server is gone
  ignoresTerm: false,                // a server that will not go at all
  ignoresKill: false,                // one that does not even go for SIGKILL
  termDenied: false,                 // SIGTERM is not allowed
  killDenied: false,                 // SIGKILL is not allowed
  livesOn: false,                    // lets go of the socket but keeps running
  reusedAfterTerm: false,            // its number is taken by another listener
  reusedOffPort: false,              // its number is taken by a non-listener
  unreadableAfterTerm: false,        // still on the port and no longer readable
  portStaysHeld: false,              // goes, but its socket is still listed
  phoneTaken: false,                 // something else takes the phone's port when it goes
  driftAt: null,                     // seconds into the wait at which the identity changes
  statePwd: "HERE",                  // what an answering board names as its folder
  bindBlocked: [],                   // port offsets a bind cannot take
  chrome: [],                        // [[window id, [tab urls]]], or null for unknown
  closeAnswers: {},                  // window id -> CLOSED, GONE, CHANGED or null
  config: null,                      // stands in for run.config.json when set
  lockOffset: null,                  // writes server.lock naming port + this offset
  bridge: "NONE",                    // NONE, NOTE, RAISES or REAL (through a fake tailscale)
  serve: {},                         // what the fake tailscale says its Serve config is
  trap: false,                       // record every file the CLI opens
};

// A model, not a machine. A process table (pid -> the identity the kernel would
// give back), the pids listening on each port, a clock that only moves and a
// Chrome that is a list. os.kill is the one way anything dies, and every read
// is recorded, so a test can say not only what happened but what was looked at
// before it happened.
function harness(options) {
  const opts = JSON.stringify(JSON.stringify({ ...DEFAULTS, port, ...options }));
  return String.raw`
OPTS = json.loads(__OPTS__)
PORT = OPTS['port']
PHONE = PORT + 1
EVENTS = []
ACCEPTED = sys.executable
SERVER = str(cli.HERE / 'server.py')
TERM = int(signal.SIGTERM)
KILL = int(signal.SIGKILL)

def ident(pid, ours=True, drift=0):
    return ((1757000000 + pid + drift, pid), ACCEPTED,
            (ACCEPTED, SERVER if ours else '/somewhere/else/other.py'))

LISTEN = {PORT + int(k): set(v) for k, v in OPTS['listen'].items()}
ALIVE = set()
PROCS = {}
DIED = []
for _pids in LISTEN.values():
    for _p in _pids:
        ALIVE.add(_p)
        if OPTS['command'] != 'UNREADABLE':
            PROCS[_p] = ident(_p, OPTS['command'] == 'OURS')

class Clock:
    def __init__(self):
        self.now = 1000.0
    def monotonic(self):
        return self.now
    def time(self):
        return self.now
    def sleep(self, seconds):
        self.now += seconds
        EVENTS.append(['sleep', round(seconds, 3)])
        if OPTS['driftAt'] is not None and self.now - 1000.0 >= OPTS['driftAt']:
            OPTS['driftAt'] = None
            for _p in list(PROCS):
                if _p in ALIVE:
                    PROCS[_p] = ident(_p, drift=7777)
cli.time = Clock()

def die(pid):
    ALIVE.discard(pid)
    PROCS.pop(pid, None)
    for _held in LISTEN.values():
        _held.discard(pid)
    DIED.append(pid)
    if OPTS['phoneTaken']:
        LISTEN.setdefault(PHONE, set()).add(777)
        ALIVE.add(777)
        PROCS[777] = ident(777, False)

class OsProxy:
    def __getattr__(self, name):
        return getattr(os, name)
osp = OsProxy()

def fake_kill(pid, sig):
    EVENTS.append(['kill', pid, int(sig)])
    if int(sig) == 0:
        if pid not in ALIVE:
            raise ProcessLookupError(pid)
        return
    if int(sig) not in (TERM, KILL):
        raise AssertionError('the CLI sent a signal other than SIGTERM or SIGKILL')
    if int(sig) == KILL:
        if OPTS['killDenied']:
            raise PermissionError(pid)
        if not OPTS['ignoresKill']:
            die(pid)
        return
    if OPTS['termDenied']:
        raise PermissionError(pid)
    if OPTS['ignoresTerm']:
        return
    if OPTS['reusedAfterTerm']:
        PROCS[pid] = ident(pid, drift=9999)
        return
    if OPTS['reusedOffPort']:
        for _held in LISTEN.values():
            _held.discard(pid)
        PROCS[pid] = ident(pid, ours=False, drift=9999)
        return
    if OPTS['unreadableAfterTerm']:
        PROCS.pop(pid, None)
        return
    if OPTS['livesOn']:
        for _held in LISTEN.values():
            _held.discard(pid)
        return
    if OPTS['portStaysHeld']:
        ALIVE.discard(pid)
        PROCS.pop(pid, None)
        return
    die(pid)
osp.kill = fake_kill
cli.os = osp

LOOKS = {'n': 0}
def fake_listener_pids(p):
    LOOKS['n'] += 1
    EVENTS.append(['listener_pids', p])
    if OPTS['listing'] == 'UNREADABLE':
        return None
    if OPTS['listingUnknownAfter'] is not None and LOOKS['n'] > OPTS['listingUnknownAfter']:
        return None
    if p - PORT == OPTS['unreadableOffset']:
        return None
    if DIED and p - PORT == OPTS['unreadableAfterDeathOffset']:
        return None
    return set(LISTEN.get(p, ()))
cli.listener_pids = fake_listener_pids

def fake_process_identity(pid):
    EVENTS.append(['process_identity', pid])
    return PROCS.get(pid)
cli.process_identity = fake_process_identity
cli.probed_runtime = lambda interpreter: None

def fake_port_binds(p):
    EVENTS.append(['port_binds', p])
    return (p - PORT) not in OPTS['bindBlocked']
cli.port_binds = fake_port_binds

def fake_state(p, timeout=2):
    EVENTS.append(['state', p])
    if not any(q in ALIVE for q in LISTEN.get(p, ())):
        return None
    st = {'boxes': [], 'queued': 0, 'listening': {}, 'busy': {}, 'listenerGap': {}}
    if OPTS['statePwd'] == 'HERE':
        st['pwd'] = str(cli.HERE)
    elif OPTS['statePwd'] == 'OTHER':
        st['pwd'] = '/some/other/checkout'
    return st
cli.state = fake_state

def fake_windows():
    EVENTS.append(['chrome_windows'])
    if OPTS['chrome'] is None:
        return None
    return [(w[0], list(w[1])) for w in OPTS['chrome']]
def fake_close(wid, urls):
    EVENTS.append(['close', wid, list(urls)])
    return OPTS['closeAnswers'].get(str(wid), 'CLOSED')
def fake_page_urls():
    EVENTS.append(['chrome_page_urls'])
    return []
def fake_open_app(cfg, dry):
    EVENTS.append(['open_app', dry])
cli.chrome_windows = fake_windows
cli.close_chrome_window = fake_close
cli.chrome_page_urls = fake_page_urls
cli.open_app = fake_open_app

def fake_run(argv, **kw):
    EVENTS.append(['run', list(argv)])
    if argv and argv[0] == '/fake/tailscale':
        rest = list(argv[1:])
        if rest == ['status', '--json']:
            return types.SimpleNamespace(returncode=0, stderr='',
                stdout=json.dumps({'Self': {'DNSName': 'box.example.ts.net.'}}))
        if rest == ['serve', 'status', '--json']:
            return types.SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(OPTS['serve']))
    return types.SimpleNamespace(returncode=1, stdout='', stderr='')
def fake_popen(argv, **kw):
    EVENTS.append(['popen', list(argv)])
    raise OSError('stop starts nothing')
cli.subprocess = types.SimpleNamespace(run=fake_run, Popen=fake_popen,
                                       DEVNULL=subprocess.DEVNULL, STDOUT=subprocess.STDOUT,
                                       PIPE=subprocess.PIPE,
                                       SubprocessError=subprocess.SubprocessError,
                                       TimeoutExpired=subprocess.TimeoutExpired)

def fake_bridge(p):
    EVENTS.append(['bridge_note', p])
    if OPTS['bridge'] == 'NOTE':
        return 'A phone bridge is active. Turn it off with: facilitator bridge off'
    if OPTS['bridge'] == 'RAISES':
        raise RuntimeError('the phone link fell over')
    return None
if OPTS['bridge'] == 'REAL':
    cli.find_tailscale = lambda: '/fake/tailscale'
else:
    cli.bridge_note = fake_bridge

if OPTS['config'] is not None:
    cli.load_config = lambda: dict(OPTS['config'])

if OPTS.get('lockFile'):
    with open(OPTS['lockFile'], 'w') as _lock:
        json.dump({'pid': 4242, 'port': PORT + OPTS['lockOffset']}, _lock)
    cli.SERVER_LOCK = pathlib.Path(OPTS['lockFile'])

TOUCHED = []
if OPTS['trap']:
    import builtins
    _open = builtins.open
    def traced_open(file, mode='r', *a, **k):
        TOUCHED.append(['open', str(file), str(mode)])
        return _open(file, mode, *a, **k)
    builtins.open = traced_open
    def wrap(name):
        original = getattr(pathlib.Path, name)
        def traced(self, *a, **k):
            mode = k.get('mode', a[0] if a and isinstance(a[0], str) else 'r') if name == 'open' else ''
            TOUCHED.append(['Path.' + name, str(self), str(mode)])
            return original(self, *a, **k)
        setattr(pathlib.Path, name, traced)
    for _name in ('read_text', 'read_bytes', 'write_text', 'write_bytes', 'open', 'touch',
                  'unlink', 'rename', 'replace', 'mkdir', 'rmdir'):
        wrap(_name)

def say(extra=None):
    print('EVENTS ' + json.dumps({'events': EVENTS, 'touched': TOUCHED, **(extra or {})}))
`.replace("__OPTS__", opts);
}

function readEvents(stdout) {
  const lines = String(stdout || "").trim().split("\n");
  const marker = lines.findIndex(line => line.startsWith("EVENTS "));
  assert.notEqual(marker, -1, `no EVENTS line in output:\n${stdout}`);
  return { said: lines.slice(0, marker), ...JSON.parse(lines[marker].slice("EVENTS ".length)) };
}

const kinds = events => events.map(event => event[0]).filter(kind => kind !== "sleep");
const signalsIn = events => events.filter(e => e[0] === "kill" && e[2] !== 0);
const sentTo = events => signalsIn(events).map(e => [e[1], e[2]]);
const slept = events => events.reduce((sum, e) => sum + (e[0] === "sleep" ? e[1] : 0), 0);
const askedChrome = events => events.some(e => e[0] === "chrome_windows" || e[0] === "close");

let sequence = 0;
async function stop(options = {}, args = ["stop"], { dir = fixtureDir, cli = cliPath } = {}) {
  const settings = { ...options };
  if (options.lockOffset !== undefined && options.lockOffset !== null) {
    const lockDir = path.join(nestDir, `lock-${sequence += 1}`);
    await mkdir(lockDir);
    settings.lockFile = path.join(lockDir, "server.lock");
  }
  const done = await probe([
    harness(settings),
    "try:",
    `    cli.cmd_stop(${JSON.stringify(args)})`,
    "finally:",
    "    say()",
  ].join("\n"), { dir, cli }).then(ok => ({ ok: true, ...ok }), error => ({ ok: false, ...error }));
  return { ...done, ...readEvents(done.stdout) };
}

// the board's own page, as Chrome would report it
const boardAt = number => `http://127.0.0.1:${number}`;

// nothing was signalled, nothing was printed to stdout, Chrome was never asked
// and nothing was started
function assertUntouched(run, why) {
  assert.equal(run.ok, false, `${why}: the stop went ahead`);
  assert.equal(run.code, 1, why);
  assert.deepEqual(signalsIn(run.events), [], `${why}: something was signalled`);
  assert.equal(askedChrome(run.events), false, `${why}: Chrome was asked`);
  assert.equal(kinds(run.events).includes("bridge_note"), false, `${why}: the phone link was looked at`);
  assert.equal(kinds(run.events).includes("popen"), false, `${why}: something was started`);
  assert.deepEqual(run.said, [], `${why}: something was printed as if it worked`);
}

before(async () => {
  nestDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-stop-")));
  fixtureDir = path.join(nestDir, "board");
  await mkdir(fixtureDir);
  cliPath = path.join(fixtureDir, "facilitator");
  port = await freePair();
  await copyFile(path.join(ROOT, "facilitator"), cliPath);
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ port, lanes: [] }));
});

const liveNests = [];
const owned = new Set();

after(async () => {
  // only pids this file started, and only those still running
  for (const pid of owned) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (const live of liveNests) await rm(live, { recursive: true, force: true });
  if (nestDir) await rm(nestDir, { recursive: true, force: true });
});

test("stop is a command of its own, in the usage and in the dispatch", async () => {
  const source = await readFile(cliPath, "utf8");
  assert.match(source, /^ {2}facilitator stop \[--dry-run\] \[--force\]$/m, "stop is not in the usage");
  assert.match(source, /elif cmd == "stop":\n\s+cmd_stop\(args\)/, "stop is not dispatched");

  const unknown = await execFileAsync("python3", [cliPath, "nonsense"], { cwd: fixtureDir })
    .then(() => null, error => error);
  assert.ok(unknown, "an unknown command was accepted");
  assert.match(unknown.stderr, /facilitator stop \[--dry-run\] \[--force\]/);
});

test("stop refuses words it does not know instead of borrowing run's", async () => {
  const cases = [
    [["--attach"], "--attach"], [["--spawn"], "--spawn"], [["--kill"], "--kill"],
    [["on"], "on"], [["--forced"], "--forced"],
    [["--dry-run", "--nope"], "--nope"], [["--force", "now"], "now"],
  ];
  for (const [words, extra] of cases) {
    const refused = await execFileAsync("python3", [cliPath, "stop", ...words], { cwd: fixtureDir })
      .then(() => null, error => error);
    assert.ok(refused, `stop accepted ${words.join(" ")}`);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /stop takes --dry-run, --force and nothing else; got /, refused.stderr);
    assert.ok(refused.stderr.trim().endsWith(`got ${extra}`), refused.stderr);
  }
});

// --- refusals: what is not plainly this folder's server is never touched ----

test("a server that is not plainly this folder's is refused, with and without --force", async () => {
  const cases = [
    ["a foreign listener", { command: "FOREIGN" },
      /stop: pid 4242 is listening on \d+ and it is not .*server\.py; refusing to signal it/],
    ["two listeners", { listen: { 0: [4242, 909], 1: [4242] } },
      /stop: 2 processes are listening on \d+ \(909, 4242\); refusing to guess which one is the board/],
    ["an unreadable listing", { listing: "UNREADABLE" },
      /stop: cannot read what is listening on \d+; nothing was stopped/],
    ["an unreadable identity", { command: "UNREADABLE" },
      /stop: cannot read what process 4242 is; refusing to signal it/],
  ];
  for (const flags of [[], ["--force"]]) {
    for (const [name, options, message] of cases) {
      const run = await stop(options, ["stop", ...flags]);
      assertUntouched(run, `${name} ${flags.join(" ")}`);
      assert.match(run.stderr, message, run.stderr);
    }
  }
});

test("a changed identity under the same number gets no signal, even with --force", async () => {
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
      `refusal = cli.stop_board(owner, ${port}, True)`,
      "say({'refusal': refusal})",
    ].join("\n"));
    const seen = readEvents(stdout);
    assert.deepEqual(signalsIn(seen.events), [], `a signal was sent after ${name}`);
    assert.match(String(seen.refusal), /pid 4242 is not the process that was read a moment ago/,
      `stop_board did not refuse ${name}: ${seen.refusal}`);
    assert.match(String(seen.refusal), /nothing was signalled/);
  }
});

test("a pid that is no longer the one listener, or a listing gone unreadable, gets no signal", async () => {
  const moved = await probe([
    harness({}),
    `owner, _ = cli.server_process(${port})`,
    "LISTEN[PORT] = {909}",
    "PROCS[909] = ident(909)",
    "gone = cli.stop_board(owner, PORT, False)",
    "LISTEN[PORT] = {4242, 909}",
    "both = cli.stop_board(owner, PORT, False)",
    "say({'gone': gone, 'both': both})",
  ].join("\n"));
  const seen = readEvents(moved.stdout);
  assert.deepEqual(signalsIn(seen.events), [], "something was signalled after the listener changed");
  assert.match(seen.gone, /pid 4242 is no longer the one listener on \d+ \(909 is\); nothing was signalled/);
  assert.match(seen.both, /pid 4242 is no longer the one listener on \d+ \(909, 4242 is\); nothing was signalled/);

  const unreadable = await probe([
    harness({ listingUnknownAfter: 1 }),
    `owner, refusal = cli.server_process(${port})`,
    "assert refusal is None, refusal",
    "refusal = cli.stop_board(owner, PORT, False)",
    "say({'refusal': refusal})",
  ].join("\n"));
  const gone = readEvents(unreadable.stdout);
  assert.deepEqual(signalsIn(gone.events), [], "a signal went out on an unreadable listing");
  assert.match(String(gone.refusal), /cannot read what is listening on \d+ any more; nothing was signalled/);
});

// --- nothing running, and a board that is running on another pair ----------

test("with nothing listening, stop says so, signals no one and starts nothing", async () => {
  const run = await stop({ listen: {} });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board was not running."]);
  assert.deepEqual(signalsIn(run.events), []);
  assert.equal(kinds(run.events).includes("bridge_note"), false, "the phone link was mentioned for a stop that stopped nothing");
  assert.equal(kinds(run.events).filter(k => k === "run" || k === "popen" || k === "open_app").length, 0);

  const orphan = await stop({ listen: {}, chrome: [[5, [boardAt(port)]]] });
  assert.equal(orphan.ok, true, orphan.stderr);
  assert.deepEqual(orphan.said, ["Board was not running.", "Window closed."]);
  assert.deepEqual(signalsIn(orphan.events), []);
});

test("a board running on the pair server.lock names is stopped when it reads back as this folder's", async () => {
  const there = port - 20;
  const run = await stop({
    listen: { [-20]: [4242], [-19]: [4242] },
    lockOffset: -20,
    chrome: [[1, [boardAt(there)]], [2, [boardAt(port)]]],
  });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped.", "Window closed."]);
  assert.deepEqual(sentTo(run.events), [[4242, TERM]]);
  assert.ok(run.events.some(e => e[0] === "listener_pids" && e[1] === there + 1),
    "the phone's port on that pair was never looked at");
  assert.deepEqual(run.events.filter(e => e[0] === "close").map(e => e[1]), [1],
    "a window on the configured port, where nothing ran, was closed");
  assert.deepEqual(run.events.filter(e => e[0] === "bridge_note"), [["bridge_note", there]]);
});

test("a lock that points at nothing of this folder's changes nothing", async () => {
  for (const [name, options] of [
    ["another folder's board", { listen: { [-20]: [4242], [-19]: [4242] }, lockOffset: -20, statePwd: "OTHER" }],
    ["a board that names no folder", { listen: { [-20]: [4242], [-19]: [4242] }, lockOffset: -20, statePwd: "NONE" }],
    ["the configured port itself", { listen: {}, lockOffset: 0 }],
    ["a port nothing answers on", { listen: {}, lockOffset: -20 }],
  ]) {
    const run = await stop(options);
    assert.equal(run.ok, true, `${name}: ${run.stderr}`);
    assert.deepEqual(run.said, ["Board was not running."], name);
    assert.deepEqual(signalsIn(run.events), [], `${name}: something was signalled`);
  }
});

test("a foreign process on the lock's port is refused and never signalled", async () => {
  const run = await stop({
    listen: { [-20]: [4242], [-19]: [4242] }, lockOffset: -20, command: "FOREIGN",
  });
  assertUntouched(run, "a foreign process behind the lock");
  assert.match(run.stderr, /stop: pid 4242 is listening on \d+ and it is not .*server\.py; refusing to signal it/);
});

// --- stopping ----------------------------------------------------------------

test("a stop is one SIGTERM and liveness probes, then both ports read, then the windows", async () => {
  const run = await stop({ chrome: [[7, [boardAt(port)]]] });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped.", "Window closed."]);
  assert.deepEqual(sentTo(run.events), [[4242, TERM]], "the stop sent something other than one SIGTERM");

  const order = kinds(run.events);
  const term = order.indexOf("kill");
  const before = order.slice(0, term);
  assert.equal(before.filter(k => k === "process_identity").length, 2,
    "the identity was not read twice before the signal");
  assert.equal(before.at(-1), "process_identity", "the signal did not follow straight on from an identity read");
  assert.equal(before.at(-2), "listener_pids", "the listening pid was not re-read before the signal");
  assert.equal(order.includes("chrome_windows"), true);
  assert.ok(order.indexOf("chrome_windows") > order.lastIndexOf("listener_pids"),
    "Chrome was read before the ports were");
  assert.ok(run.events.some((e, i) => e[0] === "listener_pids" && e[1] === port + 1
    && i > run.events.findIndex(x => x[0] === "kill" && x[2] === TERM)),
  "the phone's port was not read after the signal");
  assert.equal(order.at(-1), "bridge_note", "the phone link was looked at before the windows were done");
});

test("a stop that succeeds needs the pid gone and both ports free; unreadable is never free", async () => {
  const cases = [
    ["the phone's port cannot be read", { unreadableAfterDeathOffset: 1 },
      /stop: the board on \d+ has stopped, but port \d+, the one above it, could not be read\. Nothing was closed/],
    ["something else takes the phone's port", { phoneTaken: true },
      /stop: the board on \d+ has stopped, but port \d+, the one above it, is still held by something\. Nothing was closed/],
    ["the phone's port cannot be bound", { bindBlocked: [1] },
      /stop: the board on \d+ has stopped, but port \d+, the one above it, is still held by something\. Nothing was closed/],
  ];
  for (const [name, options, message] of cases) {
    const run = await stop({ ...options, chrome: [[7, [boardAt(port)]]] });
    assert.equal(run.ok, false, `${name}: reported as a clean stop`);
    assert.equal(run.code, 1, name);
    assert.match(run.stderr, message, `${name}: ${run.stderr}`);
    assert.deepEqual(run.said, [], `${name}: "Board stopped." was printed`);
    assert.equal(askedChrome(run.events), false, `${name}: a window was touched`);
    assert.deepEqual(sentTo(run.events), [[4242, TERM]]);
  }

  // the configured port itself cannot be read after the server went: that is
  // a wait that runs out, and it says so, and it does not escalate by itself
  const run = await stop({ unreadableAfterDeathOffset: 0 });
  assert.equal(run.ok, false);
  assert.match(run.stderr,
    /stop: port \d+ could not be read 10s after the server was asked to stop\. Nothing was closed\. Try again, or use: facilitator stop --force/,
    run.stderr);
  assert.deepEqual(sentTo(run.events), [[4242, TERM]], "an unreadable port led to a second signal");
  assert.equal(askedChrome(run.events), false);

  // and --force does not kill a process that is already gone because its port could not be read
  const forced = await stop({ unreadableAfterDeathOffset: 0 }, ["stop", "--force"]);
  assert.equal(forced.ok, false);
  assert.deepEqual(sentTo(forced.events), [[4242, TERM]], "a process that had already gone was killed");
  assert.match(forced.stderr, /it was not ended\. Nothing was closed/, forced.stderr);
});

// --- a server that will not go: the timeout names what was established -----

const RETRY = /\. Nothing was closed\. Try again, or use: facilitator stop --force$/;

test("a stop that times out reports the condition it established, closes nothing and never escalates", async () => {
  const cases = [
    ["the server ignores SIGTERM", { ignoresTerm: true },
      /stop: the server on \d+ had not let go 10s after SIGTERM and is still the same process; it was left alone/],
    ["the number is taken by another listener", { reusedAfterTerm: true },
      /stop: port \d+ is still held under the same number by a different process from the one that was signalled; nothing else was signalled/],
    ["the server lets go of the socket but keeps running", { livesOn: true },
      /stop: the server let go of port \d+ but was still running 10s after SIGTERM/],
    ["the number is taken by something off the port", { reusedOffPort: true },
      /stop: a different process with the same number let go of port \d+ but was still running 10s after SIGTERM/],
    ["what is left on the port cannot be read", { unreadableAfterTerm: true },
      /stop: port \d+ is still held under the same number and what that process is now could not be read; nothing else was signalled/],
    ["the process goes but its socket does not", { portStaysHeld: true },
      /stop: port \d+ is still held under the same number and what that process is now could not be read; nothing else was signalled/],
  ];
  for (const [name, options, message] of cases) {
    const run = await stop({ ...options, chrome: [[7, [boardAt(port)]]] });
    assert.equal(run.ok, false, `${name} was called a stop`);
    assert.equal(run.code, 1, name);
    assert.match(run.stderr, message, `${name}: ${run.stderr}`);
    assert.match(run.stderr.trim(), RETRY, `${name}: ${run.stderr}`);
    assert.doesNotMatch(run.stderr, /started|restart|kill \d+/, `${name}: the wording of a restart or a pid to kill: ${run.stderr}`);
    assert.deepEqual(sentTo(run.events), [[4242, TERM]], `${name}: the stop escalated or signalled twice`);
    assert.equal(askedChrome(run.events), false, `${name}: a window was touched`);
    assert.equal(kinds(run.events).includes("bridge_note"), false, `${name}: the phone link was mentioned`);
    assert.deepEqual(run.said, [], `${name}: "Board stopped." was printed`);
    assert.ok(slept(run.events) >= 9.9, `${name}: the wait was ${slept(run.events)}s`);
    assert.ok(run.events.filter(e => e[0] === "kill" && e[2] === 0).length > 10,
      `${name}: the process was not polled while the wait ran`);
  }
  // once the process is gone, the socket is what the wait is polling
  const lingering = await stop({ portStaysHeld: true });
  assert.ok(lingering.events.filter(e => e[0] === "listener_pids").length > 10,
    "the socket was not polled while the wait ran");
});

// --- --force: one SIGKILL, to the same process, after the wait --------------

test("--force ends a server that ignores SIGTERM with one SIGKILL, after the wait, to the same pid", async () => {
  const run = await stop({ ignoresTerm: true, chrome: [[7, [boardAt(port)]]] }, ["stop", "--force"]);
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped.", "Window closed."]);
  assert.deepEqual(sentTo(run.events), [[4242, TERM], [4242, KILL]]);

  const at = run.events.findIndex(e => e[0] === "kill" && e[2] === KILL);
  assert.ok(slept(run.events.slice(0, at)) >= 9.9, "the SIGKILL came before the polite wait ran out");
  assert.equal(run.events[at - 1][0], "process_identity",
    "the SIGKILL did not follow straight on from a third identity read");
  assert.equal(run.events.slice(0, at).filter(e => e[0] === "process_identity").length >= 3, true,
    "the identity was not read three times before the SIGKILL");
  assert.ok(run.events.findIndex(e => e[0] === "chrome_windows") > at, "Chrome was asked before the server was gone");
});

test("--force on a server that goes politely sends no SIGKILL at all", async () => {
  const run = await stop({}, ["stop", "--force"]);
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(sentTo(run.events), [[4242, TERM]]);
});

test("--force on a server that lets go of the socket but keeps running ends that same process", async () => {
  const run = await stop({ livesOn: true }, ["stop", "--force"]);
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped."]);
  assert.deepEqual(sentTo(run.events), [[4242, TERM], [4242, KILL]]);
});

test("--force sends no SIGKILL when the process is no longer the one that was asked", async () => {
  const cases = [
    ["the number was reused by another listener", { reusedAfterTerm: true }],
    ["the number was reused by something off the port", { reusedOffPort: true }],
    ["what is there can no longer be read", { unreadableAfterTerm: true }],
    ["the process went but its socket did not", { portStaysHeld: true }],
    ["the identity changed during the wait", { ignoresTerm: true, driftAt: 4 }],
  ];
  for (const [name, options] of cases) {
    const run = await stop({ ...options, chrome: [[7, [boardAt(port)]]] }, ["stop", "--force"]);
    assert.equal(run.ok, false, name);
    assert.equal(run.code, 1, name);
    assert.deepEqual(sentTo(run.events), [[4242, TERM]], `${name}: a SIGKILL was sent`);
    assert.match(run.stderr,
      /stop: pid 4242 is no longer the process that was asked to stop, or can no longer be read; it was not ended\. Nothing was closed/,
      `${name}: ${run.stderr}`);
    assert.equal(askedChrome(run.events), false, `${name}: a window was touched`);
  }
});

test("--force that cannot end the server says so and closes nothing", async () => {
  const stuck = await stop({ ignoresTerm: true, ignoresKill: true, chrome: [[7, [boardAt(port)]]] },
    ["stop", "--force"]);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.code, 1);
  assert.match(stuck.stderr,
    /stop: the server on \d+ was still there 10s after it was ended outright\. Nothing was closed/, stuck.stderr);
  assert.deepEqual(sentTo(stuck.events), [[4242, TERM], [4242, KILL]], "the SIGKILL was repeated");
  assert.equal(askedChrome(stuck.events), false);

  const denied = await stop({ ignoresTerm: true, killDenied: true }, ["stop", "--force"]);
  assert.equal(denied.ok, false);
  assert.match(denied.stderr, /stop: not allowed to end pid 4242; nothing was changed\. Nothing was closed/, denied.stderr);
  assert.equal(askedChrome(denied.events), false);

  const termDenied = await stop({ termDenied: true }, ["stop", "--force"]);
  assert.equal(termDenied.ok, false);
  assert.match(termDenied.stderr, /stop: not allowed to stop pid 4242; nothing was changed/, termDenied.stderr);
  assert.deepEqual(sentTo(termDenied.events), [[4242, TERM]], "a SIGKILL followed a refused SIGTERM");
});

test("the firm step reads the identity again and leaves a process that went by itself alone", async () => {
  const gone = await probe([
    harness({}),
    "owner, refusal = cli.server_process(PORT)",
    "assert refusal is None, refusal",
    "die(4242)",
    "answer = cli.end_server(owner, PORT)",
    "say({'answer': answer})",
  ].join("\n"));
  const seen = readEvents(gone.stdout);
  assert.equal(seen.answer, null, "a process that had gone by itself was not called gone");
  assert.deepEqual(signalsIn(seen.events), [], "a process that had gone was signalled");

  const changed = await probe([
    harness({}),
    "owner, refusal = cli.server_process(PORT)",
    "assert refusal is None, refusal",
    "PROCS[4242] = ident(4242, drift=5000)",
    "answer = cli.end_server(owner, PORT)",
    "say({'answer': answer})",
  ].join("\n"));
  const other = readEvents(changed.stdout);
  assert.deepEqual(signalsIn(other.events), [], "a process that changed was signalled");
  assert.match(other.answer, /no longer the process that was asked to stop/);
});

// --- --dry-run ----------------------------------------------------------------

test("--dry-run signals nothing, closes nothing and says what a stop would do", async () => {
  const board = boardAt(port);
  const head = `stop (dry run): would stop the board on port ${port} (pid 4242)`;
  const cases = [
    ["one board window", { chrome: [[1, [board]]] }, [], [`${head} and close 1 window.`]],
    ["no board window", { chrome: [] }, [], [`${head} and close no window.`]],
    ["two board windows", { chrome: [[1, [board]], [2, [`${board}/`]]] }, [], [`${head} and close 2 windows.`]],
    ["Chrome that cannot be asked", { chrome: null }, [],
      [`${head}; Chrome cannot be asked, so a window may be left open.`]],
    ["a board tab among other tabs", { chrome: [[1, [board, "https://example.com/"]]] }, [],
      [`${head} and close no window.`,
        "stop (dry run): a board tab in a window with other tabs would be left open."]],
    ["--force", { chrome: [] }, ["--force"],
      [`${head} and close no window.`,
        "stop (dry run): with --force the server would be ended outright if it is still there after 10s."]],
    ["nothing running", { listen: {}, chrome: [[1, [board]]] }, ["--force"],
      [`stop (dry run): the board is not running on port ${port}; would close 1 window.`]],
  ];
  for (const [name, options, flags, want] of cases) {
    const run = await stop(options, ["stop", "--dry-run", ...flags]);
    assert.equal(run.ok, true, `${name}: ${run.stderr}`);
    assert.deepEqual(run.said, want, name);
    assert.equal(kinds(run.events).includes("kill"), false, `${name}: the process was signalled or probed`);
    assert.equal(kinds(run.events).includes("close"), false, `${name}: a window was closed`);
    assert.equal(kinds(run.events).includes("bridge_note"), false, `${name}: the phone link was looked at`);
    assert.equal(slept(run.events), 0, `${name}: the dry run waited`);
    assert.equal(kinds(run.events).filter(k => k === "run" || k === "popen" || k === "open_app").length, 0);
  }

  const refused = await stop({ command: "FOREIGN" }, ["stop", "--dry-run"]);
  assertUntouched(refused, "a dry run on a foreign listener");
  assert.match(refused.stderr, /refusing to signal it/);
});

// --- closing: only windows that show nothing but the board -------------------

test("only windows whose every tab is the board's own page are closed, by id", async () => {
  const board = boardAt(port);
  const windows = [
    [11, [board]],
    [12, [`http://localhost:${port}/?card=3`]],
    [13, [`http://127.0.0.1:${port + 1}/`]],
    [14, [`${board}/m`]],
    [15, [`${board}/page`]],
    [16, ["https://example.com/"]],
    [17, [board, "https://example.com/"]],
    [18, []],
    [19, [board, `${board}/`]],
    [20, [boardAt(port + 7)]],
  ];
  const run = await stop({ chrome: windows });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.events.filter(e => e[0] === "close"),
    [["close", 11, [board]], ["close", 12, [`http://localhost:${port}/?card=3`]], ["close", 19, [board, `${board}/`]]]);
  assert.deepEqual(run.said, [
    "Board stopped.",
    "3 windows closed.",
    "A board tab is still open in a window with other tabs; close it yourself.",
  ]);
  const order = kinds(run.events);
  assert.ok(order.indexOf("close") > order.lastIndexOf("listener_pids"), "a window was closed before the ports were read");
  assert.ok(run.events.findIndex(e => e[0] === "kill") < run.events.findIndex(e => e[0] === "chrome_windows"));
});

test("a configured app address counts as the board's page as well as the stopped port's own", async () => {
  const run = await stop({
    config: { port, lanes: [], app_url: "https://board.example.com/" },
    chrome: [
      [1, ["https://board.example.com/"]],
      [2, [boardAt(port)]],
      [3, ["https://board.example.com/m"]],
      [4, [boardAt(port + 1)]],
    ],
  });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.events.filter(e => e[0] === "close").map(e => e[1]), [1, 2]);
  assert.deepEqual(run.said, ["Board stopped.", "2 windows closed."]);
});

test("Chrome that is not running, or shows no board, means nothing is closed and nothing is said", async () => {
  const none = await stop({ chrome: [] });
  assert.equal(none.ok, true, none.stderr);
  assert.deepEqual(none.said, ["Board stopped."]);
  assert.equal(none.events.filter(e => e[0] === "close").length, 0);
  assert.equal(kinds(none.events).filter(k => k === "run" || k === "popen" || k === "open_app").length, 0,
    "Chrome was started");

  const elsewhere = await stop({ chrome: [[1, ["https://example.com/"]], [2, [boardAt(port + 3)]]] });
  assert.deepEqual(elsewhere.said, ["Board stopped."]);
  assert.equal(elsewhere.events.filter(e => e[0] === "close").length, 0);
});

test("Chrome that cannot be asked is one line, and the stop still succeeded", async () => {
  const unknown = await stop({ chrome: null });
  assert.equal(unknown.ok, true, unknown.stderr);
  assert.deepEqual(unknown.said, ["Board stopped.", "Could not ask Chrome; close the board window yourself."]);

  const refused = await stop({
    chrome: [[11, [boardAt(port)]], [12, [boardAt(port)]]],
    closeAnswers: { 11: null },
  });
  assert.equal(refused.ok, true, refused.stderr);
  assert.deepEqual(refused.events.filter(e => e[0] === "close").map(e => e[1]), [11, 12],
    "a refused window stopped the others from being tried");
  assert.deepEqual(refused.said, [
    "Board stopped.", "Window closed.", "Could not ask Chrome; close the board window yourself.",
  ]);
});

test("a window that is gone or has changed by the time it is closed is left alone, quietly", async () => {
  const run = await stop({
    chrome: [[11, [boardAt(port)]], [12, [boardAt(port)]]],
    closeAnswers: { 11: "GONE", 12: "CHANGED" },
  });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped."]);
});

test("one window is 'Window closed.' and the phone link is mentioned last", async () => {
  const run = await stop({ chrome: [[11, [boardAt(port)]]], bridge: "NOTE" });
  assert.deepEqual(run.said, [
    "Board stopped.", "Window closed.", "A phone bridge is active. Turn it off with: facilitator bridge off",
  ]);
  assert.equal(kinds(run.events).at(-1), "bridge_note");
});

// --- the two Chrome functions themselves, with osascript faked ----------------

async function chromeCases(cases) {
  const { stdout } = await probe([
    `CASES = json.loads(${JSON.stringify(JSON.stringify(cases))})`,
    "out = []",
    "for case in CASES:",
    "    RUNS = []",
    "    def fake(argv, _case=case, **kw):",
    "        RUNS.append([list(argv), kw.get('timeout')])",
    "        if _case.get('raises') == 'timeout':",
    "            raise subprocess.TimeoutExpired(argv, 10)",
    "        if _case.get('raises') == 'os':",
    "            raise OSError('no osascript')",
    "        return types.SimpleNamespace(returncode=_case.get('rc', 0), stdout=_case.get('out', ''), stderr='')",
    "    cli.subprocess = types.SimpleNamespace(run=fake, SubprocessError=subprocess.SubprocessError,",
    "                                           TimeoutExpired=subprocess.TimeoutExpired)",
    "    cli.shutil = types.SimpleNamespace(which=lambda name, _case=case: None if _case.get('missing') else '/fake/osascript')",
    "    got = cli.chrome_windows() if case['fn'] == 'windows' else cli.close_chrome_window(*case['args'])",
    "    out.append({'got': got, 'runs': RUNS})",
    "print(json.dumps({'results': out, 'script': cli.CLOSE_WINDOW_SCRIPT}))",
  ].join("\n"));
  return lastJson(stdout);
}

test("the window walk reads ids and tabs, and treats a refusal as unknown and Chrome off as empty", async () => {
  const rows = "12\thttp://a.example/\thttp://b.example/\n13\thttp://c.example/\n14\nnot a window\thttp://x/\n";
  const { results } = await chromeCases([
    { fn: "windows", out: rows },
    { fn: "windows", out: "NOTRUNNING\n" },
    { fn: "windows", out: "", rc: 1 },
    { fn: "windows", raises: "timeout" },
    { fn: "windows", raises: "os" },
    { fn: "windows", missing: true },
    { fn: "windows", out: "   15\t http://d.example/ \n" },
  ]);
  assert.deepEqual(results[0].got, [[12, ["http://a.example/", "http://b.example/"]], [13, ["http://c.example/"]], [14, []]]);
  assert.deepEqual(results[1].got, [], "Chrome being off was read as unknown");
  assert.equal(results[2].got, null, "a refusal was read as an empty Chrome");
  assert.equal(results[3].got, null, "a timeout was read as an empty Chrome");
  assert.equal(results[4].got, null);
  assert.equal(results[5].got, null);
  assert.equal(results[5].runs.length, 0, "osascript was run when it is not there");
  assert.deepEqual(results[6].got, [[15, ["http://d.example/"]]]);

  const [argv, timeout] = results[0].runs[0];
  assert.equal(results[0].runs.length, 1);
  assert.deepEqual(argv.slice(0, 2), ["/fake/osascript", "-e"]);
  assert.equal(timeout, 10, "the walk is not bounded");
  assert.ok(argv[2].includes('exists process "Google Chrome"'));
});

test("a window is closed by id, with the id and the pages handed over as arguments", async () => {
  const hostile = 'http://x.example/"; do shell script "touch /nope';
  const urls = [`http://127.0.0.1:${port}/`, hostile];
  const { results, script } = await chromeCases([
    { fn: "close", args: [12, urls], out: "CLOSED\n" },
    { fn: "close", args: [12, urls], out: "GONE\n" },
    { fn: "close", args: [12, urls], out: "CHANGED\n" },
    { fn: "close", args: [12, urls], out: "something else\n" },
    { fn: "close", args: [12, urls], out: "", rc: 1 },
    { fn: "close", args: [12, urls], raises: "timeout" },
    { fn: "close", args: [12, urls], raises: "os" },
    { fn: "close", args: [12, urls], missing: true },
  ]);
  assert.deepEqual(results.map(r => r.got), ["CLOSED", "GONE", "CHANGED", null, null, null, null, null]);
  const [argv, timeout] = results[0].runs[0];
  assert.deepEqual(argv, ["/fake/osascript", "-e", script, "12", ...urls],
    "the id and the pages are not arguments of their own after the script");
  assert.ok(!script.includes(hostile) && !script.includes("12"), "page text or the id is pasted into the script");
  assert.equal(timeout, 10);
  assert.equal(results[7].runs.length, 0);
});

test("the close script closes one window, by id, after Chrome is known to run and its tabs still match", async () => {
  const { script } = await chromeCases([]);
  for (const verb of ["activate", "quit", "make new", "delete", "set URL", "reload", "open location",
    "do shell script", "run script", "keystroke"]) {
    assert.ok(!script.includes(verb), `the close script can ${verb}`);
  }
  assert.equal(script.split("\n").filter(line => /^\s*close\b/.test(line)).length, 1, "more than one close");
  const at = text => {
    const found = script.indexOf(text);
    assert.notEqual(found, -1, `the close script has no ${text}`);
    return found;
  };
  assert.ok(at('exists process "Google Chrome"') < at('tell application "Google Chrome"'),
    "Chrome is spoken to before it is known to be running, which can start it");
  assert.ok(at("every window whose id is wanted") < at("close win"));
  assert.ok(at('if (count of candidates) is not 1 then return "GONE"') < at("close win"));
  assert.ok(at("considering case") < at("seen = expected"));
  assert.ok(at("seen = expected") < at('return "CHANGED"'));
  assert.ok(at('return "CHANGED"') < at("close win"), "the window is closed before its tabs are compared");
  assert.ok(at("(item 1 of argv) as integer") < at("every window whose id is wanted"));
  assert.ok(at("rest of argv") < at("seen = expected"));
  assert.ok(at('if (count of argv) < 2 then return "BADARGS"') < at("close win"));
});

test("the tab comparison is exact, in order and case-sensitive", { skip: !DARWIN }, async () => {
  const { script } = await chromeCases([]);
  const lines = script.split("\n");
  const from = lines.findIndex(line => line.includes("set agreed to false"));
  const to = lines.findIndex(line => line.includes("end considering"));
  assert.ok(from !== -1 && to > from, "the comparison is not where it was");
  // the comparison lines themselves, run with no application addressed
  const small = [
    "on run argv",
    "  set expected to rest of argv",
    '  set seen to {"http://127.0.0.1:9/", "HTTP://X.example/Path"}',
    ...lines.slice(from, to + 1),
    "  return agreed as text",
    "end run",
  ].join("\n");
  const answer = async rest => (await execFileAsync("osascript", ["-e", small, ...rest], { timeout: 20000 })).stdout.trim();
  assert.equal(await answer(["77", "http://127.0.0.1:9/", "HTTP://X.example/Path"]), "true");
  assert.equal(await answer(["77", "http://127.0.0.1:9/", "http://x.example/path"]), "false", "case was ignored");
  assert.equal(await answer(["77", "HTTP://X.example/Path", "http://127.0.0.1:9/"]), "false", "order was ignored");
  assert.equal(await answer(["77", "http://127.0.0.1:9/"]), "false", "a missing tab was ignored");
  assert.equal(await answer(["77", "http://127.0.0.1:9/", "HTTP://X.example/Path", "http://z/"]), "false",
    "an extra tab was ignored");
  assert.equal(await answer(["77"]), "false", "no pages at all matched");
});

// --- side effects: the phone link, saved files, anything started ---------------

test("the phone link is read through Tailscale's status commands only and left on", async () => {
  const active = {
    TCP: { 443: { HTTPS: true } },
    Web: { "box.example.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${port + 1}` } } } },
  };
  const run = await stop({ bridge: "REAL", serve: active, chrome: [[1, [boardAt(port)]]] });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, [
    "Board stopped.", "Window closed.", "A phone bridge is active. Turn it off with: facilitator bridge off",
  ]);
  const calls = run.events.filter(e => e[0] === "run").map(e => e[1]);
  const tailscale = calls.filter(argv => argv[0] === "/fake/tailscale").map(argv => argv.slice(1).join(" "));
  assert.ok(tailscale.length >= 1, "the real note never asked Tailscale, so this proves nothing");
  for (const call of tailscale) {
    assert.ok(["status --json", "serve status --json"].includes(call), `Tailscale was asked: ${call}`);
  }
  assert.equal(calls.length, tailscale.length, `something besides Tailscale was run: ${JSON.stringify(calls)}`);

  const quiet = await stop({ bridge: "REAL", serve: {} });
  assert.deepEqual(quiet.said, ["Board stopped."]);
});

test("a phone-link check that fails never fails the stop or holds up the windows", async () => {
  const run = await stop({ bridge: "RAISES", chrome: [[1, [boardAt(port)]]] });
  assert.equal(run.ok, true, run.stderr);
  assert.deepEqual(run.said, ["Board stopped.", "Window closed."]);
  const order = kinds(run.events);
  assert.ok(order.indexOf("bridge_note") > order.indexOf("close"),
    "the phone link was looked at before the windows were closed");

  // the note is for a stop that stopped something
  const refused = await stop({ bridge: "NOTE", ignoresTerm: true });
  assert.equal(refused.ok, false);
  assert.equal(kinds(refused.events).includes("bridge_note"), false);
});

test("no saved file is opened, written or changed, and only the config and the lock are read", async () => {
  const dir = path.join(nestDir, "trap-board");
  await mkdir(dir);
  const trapCli = path.join(dir, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), trapCli);
  await writeFile(path.join(dir, "run.config.json"), JSON.stringify({ port, lanes: [] }));
  const saved = {
    "state.json": '{"rev": 3}',
    "settings.json": '{"theme": "dark"}',
    "bridge-auth.json": '{"salt": "x"}',
    "transcript.jsonl": '{"line": 1}\n',
  };
  const snapshot = async () => {
    const seen = {};
    for (const name of Object.keys(saved)) {
      const info = await stat(path.join(dir, name));
      seen[name] = [await readFile(path.join(dir, name), "utf8"), info.mtimeMs, info.size];
    }
    return seen;
  };
  for (const [name, text] of Object.entries(saved)) await writeFile(path.join(dir, name), text);
  const before = await snapshot();

  const readers = ["run.config.json", "server.lock"];
  const forbidden = /write|touch|unlink|rename|replace|mkdir|rmdir/;
  for (const options of [
    { trap: true, chrome: [[1, [boardAt(port)]]] },
    { trap: true, listen: { [-20]: [4242], [-19]: [4242] }, lockOffset: -20 },
  ]) {
    const run = await stop(options, ["stop"], { dir, cli: trapCli });
    assert.equal(run.ok, true, run.stderr);
    const inside = run.touched.filter(([, where]) => String(where).startsWith(nestDir));
    assert.ok(inside.some(([, where]) => path.basename(where) === "run.config.json"),
      "the trap saw no file at all, so it proves nothing");
    for (const [how, where, mode] of inside) {
      assert.ok(readers.includes(path.basename(where)), `${how} touched ${where}`);
      assert.doesNotMatch(how, forbidden, `${how} on ${where}`);
      assert.doesNotMatch(String(mode), /[wax+]/, `${where} opened for writing`);
    }
  }
  assert.deepEqual(await snapshot(), before, "a saved file changed");
});

test("stop starts nothing, opens nothing and speaks to no tmux or lane", async () => {
  const source = await readFile(cliPath, "utf8");
  const body = source.slice(source.indexOf("def stop_target("), source.indexOf("def cmd_status("))
    .replace(/"""[\s\S]*?"""/g, "").replace(/#[^\n]*/g, "");
  assert.ok(body.includes("def cmd_stop("), "the stop code is not where it was");
  for (const word of ["Popen", "ensure_server", "start_server", "open_app", "chrome_page_urls", "tmux",
    "send-keys", "write_text", "write_bytes", "os.remove", "unlink", "rmtree", "tailscale serve"]) {
    assert.ok(!body.includes(word), `the stop code reaches ${word}`);
  }
  const run = await stop({ chrome: [[1, [boardAt(port)]]] });
  assert.equal(run.ok, true, run.stderr);
  assert.equal(kinds(run.events).filter(k => k === "run" || k === "popen" || k === "open_app" || k === "chrome_page_urls").length, 0);
});

// ---------------------------------------------------------------------------
// The real thing: a board of its own on an ephemeral pair of ports, stopped
// through the CLI's own command, with the real kernel identity reader and the
// real signals. Only Chrome and the phone link are stubbed. Every pid touched
// is one this file started, from a throwaway copy of the site files, and the
// whole fixture, including the folders the server makes beside itself, lives
// under one temporary folder that goes at the end whether or not the
// assertions passed. No window is involved: Chrome is addressed by name, so a
// real window cannot be isolated from the person's own.

async function buildLive(ignoreTerm) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-stop-live-")));
  liveNests.push(root);
  const board = path.join(root, "board");
  await mkdir(board);
  const live = { root, board, port: await freePair(), server: path.join(board, "server.py") };
  await copyFile(path.join(ROOT, "facilitator"), path.join(board, "facilitator"));
  let source = await readFile(path.join(ROOT, "server.py"), "utf8");
  if (ignoreTerm) {
    const handlers = "    for stopper in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):\n"
      + "        signal.signal(stopper, stopping)\n";
    assert.ok(source.includes(handlers), "the server's signal handlers are not where this test patches them");
    source = source.replace(handlers, () => "    for stopper in (signal.SIGINT, signal.SIGHUP):\n"
      + "        signal.signal(stopper, stopping)\n    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n");
  }
  await writeFile(live.server, source);
  require("./fixture-auth.cjs").copyBridgeFiles(board);
  await writeFile(path.join(board, "run.config.json"), JSON.stringify({ port: live.port, lanes: [] }));
  await writeFile(path.join(board, "seed.json"), JSON.stringify({
    title: "cli stop fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  // a tree with a .venv uses it, as the real launch would; one without falls back to this interpreter
  const venv = path.join(ROOT, ".venv");
  if (await access(path.join(venv, "bin", "python3"), constants.X_OK).then(() => true, () => false)) {
    await symlink(venv, path.join(board, ".venv"));
  }
  return live;
}

function liveProbe(live, code) {
  return execFileAsync("python3", ["-c", `${loadCli(path.join(live.board, "facilitator"))}\n${code}`], {
    cwd: live.board,
    env: {
      ...process.env,
      FACILITATOR_TEST_PORT: String(live.port),
      FACILITATOR_LOG_DIR: path.join(live.root, "logs"),
    },
    timeout: 90000,
  });
}

async function startLive(live) {
  const done = await liveProbe(live, [
    "started = {}",
    "real_popen = cli.subprocess.Popen",
    "def popen(argv, **kw):",
    "    child = real_popen(argv, **kw)",
    "    started['pid'] = child.pid",
    "    return child",
    "cli.subprocess.Popen = popen",
    "try:",
    `    cli.ensure_server(${live.port}, False)`,
    "finally:",
    "    print(json.dumps(started))",
  ].join("\n")).then(ok => ok, error => error);
  const pid = (() => {
    try { return lastJson(done.stdout).pid; } catch { return undefined; }
  })();
  if (pid) owned.add(pid);
  assert.ok(!(done instanceof Error), `the throwaway server did not start: ${done.stderr || done.message}`);
  assert.ok(pid > 0);
  return pid;
}

async function runLiveStop(live, flags) {
  const done = await liveProbe(live, [
    "asked = []",
    "def windows():",
    "    asked.append(True)",
    "    return []",
    "cli.chrome_windows = windows",
    "cli.bridge_note = lambda port: None",
    "try:",
    `    cli.cmd_stop(${JSON.stringify(["stop", ...flags])})`,
    "finally:",
    "    print('CHROME_ASKED ' + str(len(asked)))",
  ].join("\n")).then(ok => ({ ok: true, ...ok }), error => ({ ok: false, ...error }));
  const lines = String(done.stdout || "").trim().split("\n");
  const marker = lines.at(-1) || "";
  assert.match(marker, /^CHROME_ASKED \d+$/, `no marker in ${done.stdout}`);
  return { ...done, said: lines.slice(0, -1), asked: Number(marker.split(" ")[1]) };
}

const running = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function assertGone(live, pid, why) {
  assert.equal(running(pid), false, `${why}: the server is still running`);
  assert.equal(await canBind(live.port), true, `${why}: port ${live.port} is still held`);
  assert.equal(await canBind(live.port + 1), true, `${why}: the phone's port is still held`);
  const answered = await fetch(`http://127.0.0.1:${live.port}/state`).then(() => true, () => false);
  assert.equal(answered, false, `${why}: the board still answers`);
  const lock = await liveProbe(live, [
    "import fcntl",
    "fd = os.open(str(cli.HERE / 'server.lock'), os.O_RDWR | os.O_CREAT)",
    "fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "print('lock taken')",
  ].join("\n"));
  assert.match(lock.stdout, /lock taken/, `${why}: the folder's lock is still held`);
}

test("a real stop: the server goes, both ports free, the lock is released, the saved board is intact",
  async () => {
    const live = await buildLive(false);
    const pid = await startLive(live);
    const before = await (await fetch(`http://127.0.0.1:${live.port}/state`)).json();
    assert.equal(before.title, "cli stop fixture");
    assert.equal(await canBind(live.port), false, "the board does not hold its port");
    assert.equal(await canBind(live.port + 1), false, "the board does not hold the phone's port");

    const stopped = await runLiveStop(live, []);
    assert.equal(stopped.ok, true, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped."]);
    assert.equal(stopped.asked, 1, "Chrome was asked once, after the server was gone");
    await assertGone(live, pid, "after the stop");
    owned.delete(pid);

    const saved = JSON.parse(await readFile(path.join(live.board, "state.json"), "utf8"));
    assert.ok(saved.rev >= before.rev, "the stop lost the saved board");

    const again = await runLiveStop(live, []);
    assert.equal(again.ok, true, again.stderr);
    assert.deepEqual(again.said, ["Board was not running."]);
  });

test("a real stop of a server that ignores SIGTERM: left alone, then ended outright with --force",
  async () => {
    const live = await buildLive(true);
    const pid = await startLive(live);

    const polite = await runLiveStop(live, []);
    assert.equal(polite.ok, false, "a server that ignores SIGTERM was called stopped");
    assert.equal(polite.code, 1);
    assert.match(polite.stderr,
      /stop: the server on \d+ had not let go 10s after SIGTERM and is still the same process; it was left alone\. Nothing was closed\. Try again, or use: facilitator stop --force/,
      polite.stderr);
    assert.equal(polite.asked, 0, "Chrome was asked after a stop that failed");
    assert.equal(running(pid), true, "the polite stop ended the server by itself");
    const answered = await fetch(`http://127.0.0.1:${live.port}/state`).then(() => true, () => false);
    assert.equal(answered, true, "the board stopped answering after a refused stop");

    const forced = await runLiveStop(live, ["--force"]);
    assert.equal(forced.ok, true, forced.stderr);
    assert.deepEqual(forced.said, ["Board stopped."]);
    assert.equal(forced.asked, 1);
    await assertGone(live, pid, "after --force");
    owned.delete(pid);
  });
