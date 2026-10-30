// What `facilitator run` prints. A real run says the board is up and is live,
// two lines, and names no lane; nothing about the window unless it failed to
// open; --dry-run keeps its longer account. It never types into or starts an
// agent's session, and a lane's tmux, instruction and prompt, left from older
// versions, are not read. A broken run.config.json is one plain line naming
// the file, for every command that reads it.
//
// The CLI is driven in-process with stand-ins for the board's answer, the
// browser launcher and Popen, so no server starts, no window opens and no port
// is used. The config-file cases run the real command and end before anything
// is started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { chmod, copyFile, mkdtemp, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { appFolder, dataOf } = require("./fixture-auth.cjs");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PORT = 8899;
const BOARD = `http://127.0.0.1:${PORT}`;
const UP = ["Board up on " + BOARD, "Facilitator is live!"];
const INSTRUCTIONS = {
  facilitator: "Attach your board listener: run the RUNBOOK listen loop with owner=facilitator and answer claims per doctrine. Server is already running.",
  example: "Attach to the facilitator board: read the facilitator repo's RUNBOOK.md, then run the listen loop with owner=example and answer claims per doctrine. Server is already running.",
};
// lanes as older versions had them, with the tmux, instruction and prompt
// that run no longer reads
const LANES = [
  { owner: "facilitator", tmux: "my-facilitator-session", dir: "/tmp/facilitator-lane", instruction: INSTRUCTIONS.facilitator, prompt: "You are the facilitator agent." },
  { owner: "example", tmux: "my-project-session", dir: "/tmp/example-lane", instruction: INSTRUCTIONS.example, prompt: "You are the second agent." },
];

let fixtureDir;
let cliPath;

before(async () => {
  fixtureDir = await realpath(appFolder("facilitator-cli-quiet-"));
  cliPath = path.join(fixtureDir, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), cliPath);
  await copyFile(path.join(ROOT, "data_folder.py"), path.join(path.dirname(cliPath), "data_folder.py"));
});

after(async () => {
  if (fixtureDir) await rm(path.dirname(fixtureDir), { recursive: true, force: true });
});

async function writeConfig(config) {
  await rm(path.join(dataOf(fixtureDir), "run.config.json"), { recursive: true, force: true });
  await writeFile(path.join(dataOf(fixtureDir), "run.config.json"),
    typeof config === "string" || Buffer.isBuffer(config) ? config : JSON.stringify(config));
}

function loadCli() {
  return [
    "import importlib.machinery, importlib.util, json, subprocess, sys, time, types",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(cliPath)})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

// One run of cmd_run with everything outside the CLI stood in for. `board` is
// what the port answers (null for nothing yet, then a board once the launch
// has been made), `open` is "ok" or the message `open` prints when it fails.
async function run(args, { config = { port: PORT, lanes: LANES }, board = "uncovered",
                          open = "ok", booting = false } = {}) {
  await writeConfig(config);
  const states = {
    uncovered: { boxes: [], queued: 0, listening: { facilitator: false, example: false }, busy: {}, listenerGap: { facilitator: 99999, example: 99999 } },
    covered: { boxes: [], queued: 0, listening: { facilitator: true, example: false }, busy: {}, listenerGap: { facilitator: 0, example: 720 } },
    partial: { boxes: [], queued: 0, listening: { facilitator: true, example: false }, busy: {}, listenerGap: { facilitator: 0, example: 99999 } },
    midclaim: { boxes: [], queued: 0, listening: { facilitator: false, example: false }, busy: { facilitator: "b7" }, listenerGap: { facilitator: 99999, example: 99999 } },
  };
  const { code, stdout, stderr } = await execFileAsync("python3", ["-c", [
    loadCli(),
    `STATE = json.loads(${JSON.stringify(JSON.stringify(states[board]))})`,
    `OPEN = ${JSON.stringify(open)}`,
    "CALLS = []",
    "def fake_run(argv, **kw):",
    "    CALLS.append(list(argv))",
    "    ok = types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[0] == 'open' and OPEN != 'ok':",
    "        return types.SimpleNamespace(returncode=1, stdout='', stderr=OPEN + '\\n')",
    "    return ok",
    "class Child:",
    "    def __init__(self, argv, **kw):",
    "        CALLS.append(['popen'] + list(argv))",
    "    def poll(self):",
    "        return None",
    "cli.subprocess = types.SimpleNamespace(run=fake_run, Popen=Child, DEVNULL=subprocess.DEVNULL,",
    "                                       STDOUT=subprocess.STDOUT, PIPE=subprocess.PIPE,",
    "                                       SubprocessError=subprocess.SubprocessError)",
    "cli.time = types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time)",
    "cli.shutil = types.SimpleNamespace(which=lambda name: '/usr/bin/' + name)",
    `ANSWERS = [None] if ${booting ? "True" : "False"} else []`,
    "def fake_state(port, timeout=2):",
    "    return ANSWERS.pop(0) if ANSWERS else STATE",
    "cli.state = fake_state",
    `cli.cmd_run(${JSON.stringify(args)})`,
    "sys.stdout.flush()",
    "print('CALLS ' + json.dumps(CALLS))",
  ].join("\n")], { cwd: fixtureDir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") } })
    .then(done => ({ code: 0, ...done }), error => error);
  const lines = String(stdout).split("\n");
  const marker = lines.findIndex(line => line.startsWith("CALLS "));
  return {
    code, stderr, stdout: String(stdout),
    said: marker === -1 ? lines.filter(Boolean) : lines.slice(0, marker),
    calls: marker === -1 ? [] : JSON.parse(lines[marker].slice("CALLS ".length)),
  };
}

const opened = calls => calls.filter(c => c[0] === "open");

test("a run with every lane covered says the board is up and nothing else", async () => {
  const done = await run(["run"], { board: "covered", config: { port: PORT, lanes: [LANES[0]] } });
  assert.deepEqual(done.said, UP, done.stderr);
  assert.deepEqual(opened(done.calls), [["open", "-na", "Google Chrome", "--args", `--app=${BOARD}`]]);
  assert.equal(done.stderr, "");
});

test("a run that has to start the board says the same two lines", async () => {
  const done = await run(["run"], { board: "covered", booting: true, config: { port: PORT, lanes: [LANES[0]] } });
  assert.deepEqual(done.said, UP, done.stderr);
  assert.equal(done.calls.filter(c => c[0] === "popen").length, 1, "the board was not started");
});

test("a run says the same two lines whatever the lanes are doing, and names no lane", async () => {
  for (const board of ["covered", "partial", "uncovered", "midclaim"]) {
    const done = await run(["run"], { board });
    assert.deepEqual(done.said, UP, `${board}: ${done.stderr}`);
    assert.equal(done.stderr, "");
    assert.deepEqual(done.calls.filter(c => c[0] === "tmux"), [], `${board}: a plain run touched tmux`);
  }
});

test("an app_url in the config changes the window, not the address the board is said to be on", async () => {
  const done = await run(["run"], { board: "covered", config: { port: PORT, app_url: "http://127.0.0.1:9/", lanes: [LANES[0]] } });
  assert.deepEqual(done.said, UP);
  assert.deepEqual(opened(done.calls), [["open", "-na", "Google Chrome", "--args", "--app=http://127.0.0.1:9/"]]);
});

test("app_fullscreen true starts the window in full screen, and no other value changes the launch", async () => {
  const full = await run(["run"], { board: "covered", config: { port: PORT, app_fullscreen: true, lanes: [LANES[0]] } });
  assert.deepEqual(full.said, UP, full.stderr);
  assert.deepEqual(opened(full.calls), [["open", "-na", "Google Chrome", "--args", `--app=${BOARD}`, "--start-fullscreen"]]);
  for (const value of [false, "true", 1, null]) {
    const same = await run(["run"], { board: "covered", config: { port: PORT, app_fullscreen: value, lanes: [LANES[0]] } });
    assert.deepEqual(opened(same.calls), [["open", "-na", "Google Chrome", "--args", `--app=${BOARD}`]],
      `app_fullscreen ${JSON.stringify(value)} changed the launch`);
  }
});

test("a dry run says when the window would be full screen", async () => {
  const full = await run(["run", "--dry-run"], { board: "covered", config: { port: PORT, app_fullscreen: true, lanes: [LANES[0]] } });
  assert.ok(full.said.includes(`window: would open ${BOARD} as a chromeless full-screen app window`), full.said.join("\n"));
  assert.deepEqual(opened(full.calls), [], "a dry run opened a window");
});

test("a window that fails to open is one plain line, and is never reported as opened", async () => {
  const done = await run(["run"], {
    board: "covered", open: "Unable to find application named 'Google Chrome'", config: { port: PORT, lanes: [LANES[0]] },
  });
  assert.deepEqual(done.said, [
    ...UP,
    `could not open Chrome (Unable to find application named 'Google Chrome'); open ${BOARD} yourself`,
  ]);
  assert.ok(!done.said.some(line => /opened/.test(line)), "a window that failed was called opened");
});

test("--dry-run keeps its own account, line for line, and names no lane", async () => {
  const idle = await run(["run", "--dry-run"], { board: "uncovered", config: { port: PORT, lanes: LANES }, booting: true });
  assert.deepEqual(idle.said, [
    `server: would start ${path.join(fixtureDir, "server.py")}`,
    `window: would open ${BOARD} as a chromeless app window`,
  ]);
  assert.deepEqual(opened(idle.calls), [], "a dry run opened a window");
  assert.equal(idle.calls.filter(c => c[0] === "popen").length, 0, "a dry run started the board");

  for (const board of ["covered", "partial", "uncovered", "midclaim"]) {
    const up = await run(["run", "--dry-run"], { board });
    assert.deepEqual(up.said, [
      `server: already up on ${PORT}`,
      `window: would open ${BOARD} as a chromeless app window`,
    ], `${board}: ${up.stderr}`);
  }
});

// --- run.config.json that cannot be used ---------------------------------

const BROKEN = {
  "is not valid JSON": { content: '{\n  "port": 8899,\n  "lanes": [\n', says: /^run\.config\.json is not valid JSON: .+/ },
  "is empty": { content: "", says: /^run\.config\.json is empty/ },
  "is not text": { content: Buffer.from([0x7b, 0x22, 0x70, 0xff, 0xfe, 0x22, 0x7d]), says: /^run\.config\.json is not UTF-8 text/ },
  "holds a list": { content: "[1, 2]", says: /^run\.config\.json must hold one JSON object, not a list/ },
  "holds a string": { content: '"x"', says: /^run\.config\.json must hold one JSON object, not a string/ },
  "has no port": { content: JSON.stringify({ lanes: [] }), says: /^run\.config\.json has no "port"/ },
  "has a null port": { content: JSON.stringify({ port: null, lanes: [] }), says: /^run\.config\.json: "port" must be a whole number, not null/ },
  "has a port of text": { content: JSON.stringify({ port: "http", lanes: [] }), says: /^run\.config\.json: "port" must be a whole number, not "http"/ },
  "has lanes that are not a list": { content: JSON.stringify({ port: 8899, lanes: 3 }), says: /^run\.config\.json: "lanes" must be a list, not a number/ },
};

test("a config that cannot be used is one plain line, for run, restart and status alike", async () => {
  for (const [what, { content, says }] of Object.entries(BROKEN)) {
    await writeConfig(content);
    for (const command of ["run", "restart", "status"]) {
      const done = await execFileAsync("python3", [cliPath, command], {
        cwd: fixtureDir, env: { ...process.env, FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
      }).then(() => null, error => error);
      assert.ok(done, `${command} accepted a config that ${what}`);
      assert.equal(done.code, 1, `${command}, config ${what}`);
      assert.equal(done.stdout, "", `${command}, config ${what}: something was printed before the error`);
      assert.doesNotMatch(done.stderr, /Traceback/, `${command}, config ${what}: ${done.stderr}`);
      assert.equal(done.stderr.trim().split("\n").length, 1, `${command}, config ${what}: ${done.stderr}`);
      assert.match(done.stderr, says, `${command}, config ${what}: ${done.stderr}`);
    }
  }
});

test("a config that cannot be read is one plain line, for run, restart and status alike", async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip("root reads files whatever their mode");
  const file = path.join(dataOf(fixtureDir), "run.config.json");
  await writeConfig(JSON.stringify({ port: PORT, lanes: [] }));
  await chmod(file, 0o000);
  try {
    for (const command of ["run", "restart", "status"]) {
      const done = await execFileAsync("python3", [cliPath, command], { cwd: fixtureDir })
        .then(() => null, error => error);
      assert.ok(done, `${command} read an unreadable config`);
      assert.doesNotMatch(done.stderr, /Traceback/, done.stderr);
      assert.match(done.stderr, /^run\.config\.json cannot be read: Permission denied$/m, done.stderr);
    }
  } finally {
    await chmod(file, 0o600);
  }
});

test("run stops on lanes it cannot use before it starts anything", async () => {
  const cases = {
    "has no lanes": [{ port: PORT }, /^run\.config\.json has no "lanes"/],
    "has a lane that is not an object": [{ port: PORT, lanes: ["facilitator"] }, /^run\.config\.json: lane 1 must be an object, not a string/],
    "has a lane with no owner": [{ port: PORT, lanes: [{ tmux: "x" }] }, /^run\.config\.json: lane 1 has no "owner"/],
  };
  for (const [what, [config, says]] of Object.entries(cases)) {
    const done = await run(["run"], { config });
    assert.equal(done.calls.length, 0, `config ${what}: something was started or opened first`);
    assert.equal(done.stdout, "", `config ${what}: ${done.stdout}`);
    assert.doesNotMatch(done.stderr, /Traceback/, done.stderr);
    assert.match(done.stderr, says, `config ${what}: ${done.stderr}`);
  }
});

test("lanes from older versions still work: their tmux, instruction and prompt are not read", async () => {
  // an agent's session would be reached through tmux, or through Terminal by osascript
  const reached = calls => calls.filter(c => c[0] === "tmux"
    || (c[0] === "osascript" && c.some(word => String(word).includes('application "Terminal"'))));
  for (const args of [["run"], ["run", "--attach"], ["run", "--spawn"], ["run", "--force", "--attach"]]) {
    const done = await run(args, { config: { port: PORT, lanes: LANES } });
    assert.deepEqual(done.said, UP, `${args.join(" ")}: ${done.stderr}`);
    assert.equal(done.stderr, "", args.join(" "));
    assert.deepEqual(reached(done.calls), [], `${args.join(" ")} reached an agent's session`);
  }
  const bare = [{ owner: "facilitator" }, { owner: "example", tmux: "my-project-session" }];
  for (const args of [["run"], ["run", "--attach"], ["run", "--spawn"]]) {
    const done = await run(args, { config: { port: PORT, lanes: bare } });
    assert.equal(done.code, 0, `${args.join(" ")}: ${done.stderr}`);
    assert.deepEqual(done.said, UP, `${args.join(" ")}: ${done.stderr}`);
    assert.equal(done.stderr, "", args.join(" "));
  }
});

test("a config that works is read exactly as before", async () => {
  await writeConfig({ port: "8899", lanes: [{ owner: "facilitator" }] });
  const code = `${loadCli()}\nprint(json.dumps(cli.load_config()))`;
  const { stdout } = await execFileAsync("python3", ["-c", code], { cwd: fixtureDir });
  assert.deepEqual(JSON.parse(stdout), { port: "8899", lanes: [{ owner: "facilitator" }] });
  await writeConfig({ port: 8899 });
  const bare = await execFileAsync("python3", ["-c", code], { cwd: fixtureDir });
  assert.deepEqual(JSON.parse(bare.stdout), { port: 8899 });
});
