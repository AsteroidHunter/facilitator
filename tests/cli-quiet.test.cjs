// What `facilitator run` prints. A real run says the board is up and, for each
// lane nobody is listening on, one line; nothing about the window unless it
// failed to open; --dry-run keeps its longer account. A broken run.config.json
// is one plain line naming the file, for every command that reads it.
//
// The CLI is driven in-process with stand-ins for the board's answer, tmux, the
// browser launcher and Popen, so no server starts, no window opens, no tmux
// session is touched and no port is used. The config-file cases run the real
// command and end before anything is started.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { chmod, copyFile, mkdtemp, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PORT = 8899;
const BOARD = `http://127.0.0.1:${PORT}`;
const UP = ["Board up on " + BOARD, "Facilitator is live!"];
const NO_LISTENER = lane => `lane ${lane}: no listener (run with --attach to wake its tmux session)`;
const INSTRUCTIONS = {
  facilitator: "Attach your board listener: run the RUNBOOK listen loop with owner=facilitator and answer claims per doctrine. Server is already running.",
  example: "Attach to the facilitator board: read the facilitator repo's RUNBOOK.md, then run the listen loop with owner=example and answer claims per doctrine. Server is already running.",
};
const LANES = [
  { owner: "facilitator", tmux: "my-facilitator-session", dir: "/tmp/facilitator-lane", instruction: INSTRUCTIONS.facilitator, prompt: "You are the facilitator agent." },
  { owner: "example", tmux: "my-project-session", dir: "/tmp/example-lane", instruction: INSTRUCTIONS.example, prompt: "You are the second agent." },
];

let fixtureDir;
let cliPath;

before(async () => {
  fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-quiet-")));
  cliPath = path.join(fixtureDir, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), cliPath);
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function writeConfig(config) {
  await rm(path.join(fixtureDir, "run.config.json"), { recursive: true, force: true });
  await writeFile(path.join(fixtureDir, "run.config.json"),
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
// has been made), `tmux` is live, shell or none, `open` is "ok" or the message
// `open` prints when it fails.
async function run(args, { config = { port: PORT, lanes: LANES }, board = "uncovered", tmux = "none",
                          hasTmux = true, open = "ok", booting = false, sessionExists = false, lands = true } = {}) {
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
    `TMUX = ${JSON.stringify(tmux)}`,
    `OPEN = ${JSON.stringify(open)}`,
    `SESSION_EXISTS = ${sessionExists ? "True" : "False"}`,
    `LANDS = ${lands ? "True" : "False"}`,
    "CALLS = []",
    "def fake_run(argv, **kw):",
    "    CALLS.append(list(argv))",
    "    ok = types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[0] == 'open' and OPEN != 'ok':",
    "        return types.SimpleNamespace(returncode=1, stdout='', stderr=OPEN + '\\n')",
    "    if argv[0] == 'tmux' and argv[1] == 'list-panes':",
    "        if TMUX == 'none':",
    "            return types.SimpleNamespace(returncode=1, stdout='', stderr='no server')",
    "        return types.SimpleNamespace(returncode=0, stdout='%1 ' + ('claude' if TMUX == 'live' else 'zsh') + '\\n', stderr='')",
    "    if argv[0] == 'tmux' and argv[1] == 'capture-pane':",
    "        return types.SimpleNamespace(returncode=0, stdout=' '.join(INSTRUCTIONS.values()) if LANDS else '', stderr='')",
    "    if argv[0] == 'tmux' and argv[1] == 'has-session':",
    "        return types.SimpleNamespace(returncode=0 if SESSION_EXISTS else 1, stdout='', stderr='')",
    "    return ok",
    `INSTRUCTIONS = ${JSON.stringify(INSTRUCTIONS)}`,
    "class Child:",
    "    def __init__(self, argv, **kw):",
    "        CALLS.append(['popen'] + list(argv))",
    "    def poll(self):",
    "        return None",
    "cli.subprocess = types.SimpleNamespace(run=fake_run, Popen=Child, DEVNULL=subprocess.DEVNULL,",
    "                                       STDOUT=subprocess.STDOUT, PIPE=subprocess.PIPE,",
    "                                       SubprocessError=subprocess.SubprocessError)",
    "cli.time = types.SimpleNamespace(sleep=lambda s: None, monotonic=time.monotonic, time=time.time)",
    `cli.shutil = types.SimpleNamespace(which=lambda name: ${hasTmux ? "'/usr/bin/' + name" : "None"})`,
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

test("a lane with no listener gets one line, and a covered or mid-claim lane gets none", async () => {
  const all = await run(["run"], { board: "covered" });
  assert.deepEqual(all.said, UP, "a lane heard from a few minutes ago was reported");
  const some = await run(["run"], { board: "partial" });
  assert.deepEqual(some.said, [...UP, NO_LISTENER("example")], some.stderr);
  const both = await run(["run"], { board: "uncovered" });
  assert.deepEqual(both.said, [...UP, NO_LISTENER("facilitator"), NO_LISTENER("example")]);
  const busy = await run(["run"], { board: "midclaim" });
  assert.deepEqual(busy.said, [...UP, NO_LISTENER("example")]);
});

test("an app_url in the config changes the window, not the address the board is said to be on", async () => {
  const done = await run(["run"], { board: "covered", config: { port: PORT, app_url: "http://127.0.0.1:9/", lanes: [LANES[0]] } });
  assert.deepEqual(done.said, UP);
  assert.deepEqual(opened(done.calls), [["open", "-na", "Google Chrome", "--args", "--app=http://127.0.0.1:9/"]]);
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

test("--attach: one line per lane, whether the instruction typed or not", async () => {
  const typed = await run(["run", "--attach"], { tmux: "live" });
  assert.deepEqual(typed.said, [
    ...UP,
    "lane facilitator: instructed the claude in tmux my-facilitator-session (pane %1)",
    "lane example: instructed the claude in tmux my-project-session (pane %1)",
  ]);
  assert.equal(typed.calls.filter(c => c[0] === "tmux" && c[1] === "send-keys").length, 4, "typing and Enter, twice");

  const missing = await run(["run", "--attach"], { tmux: "none" });
  assert.deepEqual(missing.said, [
    ...UP,
    `lane facilitator: tmux session my-facilitator-session not found; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.facilitator}`,
    `lane example: tmux session my-project-session not found; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.example}`,
  ]);

  const shell = await run(["run", "--attach"], { tmux: "shell" });
  assert.deepEqual(shell.said, [
    ...UP,
    `lane facilitator: no claude pane inside tmux my-facilitator-session; not typing into shells; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.facilitator}`,
    `lane example: no claude pane inside tmux my-project-session; not typing into shells; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.example}`,
  ]);
  assert.equal(shell.calls.filter(c => c[0] === "tmux" && c[1] === "send-keys").length, 0, "typed into a shell");

  const noTmux = await run(["run", "--attach"], { hasTmux: false });
  assert.deepEqual(noTmux.said, [
    ...UP,
    `lane facilitator: tmux session my-facilitator-session not found; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.facilitator}`,
    `lane example: tmux session my-project-session not found; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.example}`,
  ]);
});

test("--attach: text that did not land is said, Enter is not pressed, and the paste line follows", async () => {
  const done = await run(["run", "--attach"], { tmux: "live", lands: false, config: { port: PORT, lanes: [LANES[0]] } });
  assert.deepEqual(done.said, [
    ...UP,
    "lane facilitator: instruction did not land in pane %1; Enter NOT pressed",
    `lane facilitator: no reachable session; paste this into its claude, or rerun with --spawn: ${INSTRUCTIONS.facilitator}`,
  ]);
  assert.equal(done.calls.filter(c => c[0] === "tmux" && c[1] === "send-keys" && c.includes("Enter")).length, 0, "Enter was pressed");
});

test("--spawn: one line per lane, and no 'not found' line before it", async () => {
  const inTmux = await run(["run", "--spawn"], { tmux: "none" });
  assert.deepEqual(inTmux.said, [
    ...UP,
    "lane facilitator: spawned NEW session (tmux facil-facilitator)",
    "lane example: spawned NEW session (tmux facil-example)",
  ]);
  const noTmux = await run(["run", "--spawn"], { hasTmux: false });
  assert.deepEqual(noTmux.said, [
    ...UP,
    "lane facilitator: spawned NEW session (terminal window)",
    "lane example: spawned NEW session (terminal window)",
  ]);
  const there = await run(["run", "--spawn"], { tmux: "shell", sessionExists: true });
  assert.deepEqual(there.said, [
    ...UP,
    "lane facilitator: tmux session facil-facilitator already exists; attach with: tmux attach -t facil-facilitator",
    "lane example: tmux session facil-example already exists; attach with: tmux attach -t facil-example",
  ]);
});

test("--force and --attach together still say one line per lane that is not reached", async () => {
  const done = await run(["run", "--force", "--attach"], { board: "covered", tmux: "live", config: { port: PORT, lanes: [LANES[0]] } });
  assert.deepEqual(done.said, [...UP, "lane facilitator: instructed the claude in tmux my-facilitator-session (pane %1)"]);
});

test("--dry-run keeps its own account, line for line", async () => {
  const idle = await run(["run", "--dry-run"], { board: "uncovered", config: { port: PORT, lanes: LANES }, booting: true });
  assert.deepEqual(idle.said, [
    `server: would start ${path.join(fixtureDir, "server.py")}`,
    `window: would open ${BOARD} as a chromeless app window`,
    `listener facilitator: not attached. Tell that agent to start listening, or\n  rerun with --attach to type the instruction into its tmux session:\n  ${INSTRUCTIONS.facilitator}`,
    `listener example: not attached. Tell that agent to start listening, or\n  rerun with --attach to type the instruction into its tmux session:\n  ${INSTRUCTIONS.example}`,
  ].join("\n").split("\n"));
  assert.deepEqual(opened(idle.calls), [], "a dry run opened a window");
  assert.equal(idle.calls.filter(c => c[0] === "popen").length, 0, "a dry run started the board");

  const heard = await run(["run", "--dry-run"], { board: "covered" });
  assert.deepEqual(heard.said.slice(2), [
    "listener facilitator: lane covered (attached right now)",
    "listener example: lane covered (heard 12 min ago)",
  ]);

  const up = await run(["run", "--dry-run"], { board: "partial" });
  assert.deepEqual(up.said.slice(0, 3), [
    `server: already up on ${PORT}`,
    `window: would open ${BOARD} as a chromeless app window`,
    "listener facilitator: lane covered (attached right now)",
  ]);
  assert.match(up.said[3], /^listener example: not attached\. Tell that agent to start listening, or$/);

  const attach = await run(["run", "--dry-run", "--attach"], { board: "uncovered", tmux: "live" });
  assert.deepEqual(attach.said, [
    `server: already up on ${PORT}`,
    `window: would open ${BOARD} as a chromeless app window`,
    "listener facilitator: would send the attach instruction to tmux my-facilitator-session pane %1",
    "listener example: would send the attach instruction to tmux my-project-session pane %1",
  ]);

  const missing = await run(["run", "--dry-run", "--attach"], { board: "uncovered", tmux: "none" });
  assert.deepEqual(missing.said.slice(2, 5), [
    "listener facilitator: tmux session my-facilitator-session not found",
    "listener facilitator: no reachable session. Paste this into the right claude yourself,",
    "  or rerun with --spawn to create a fresh session:",
  ]);

  const spawn = await run(["run", "--dry-run", "--spawn"], { board: "uncovered", tmux: "none" });
  assert.deepEqual(spawn.said.slice(2, 4), [
    "listener facilitator: tmux session my-facilitator-session not found",
    "listener facilitator: would spawn a NEW claude session in /tmp/facilitator-lane",
  ]);
  assert.equal(spawn.calls.filter(c => c[0] === "tmux" && c[1] !== "list-panes").length, 0, "a dry run touched tmux");
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
  const file = path.join(fixtureDir, "run.config.json");
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

test("a lane missing the key a flag needs is one plain line, not a traceback", async () => {
  const noInstruction = [{ owner: "facilitator", tmux: "my-facilitator-session" }];
  const attach = await run(["run", "--attach"], { tmux: "live", config: { port: PORT, lanes: noInstruction } });
  assert.doesNotMatch(attach.stderr, /Traceback/, attach.stderr);
  assert.match(attach.stderr, /^run\.config\.json: lane facilitator has no "instruction"$/m, attach.stderr);

  const noDir = [{ owner: "facilitator", instruction: "go", prompt: "p" }];
  const spawn = await run(["run", "--spawn"], { config: { port: PORT, lanes: noDir } });
  assert.doesNotMatch(spawn.stderr, /Traceback/, spawn.stderr);
  assert.match(spawn.stderr, /^run\.config\.json: lane facilitator has no "dir"$/m, spawn.stderr);
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
