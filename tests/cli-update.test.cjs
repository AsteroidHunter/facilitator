// facilitator update, tested against throwaway bare-repo worlds with a fake uv and a stubbed restart.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:net");
const { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const dirs = [];
const RELOAD_LINE = "Reload the board in your browser and reopen the phone app.";

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function run(file, args, { cwd, env }) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, env, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
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

// A fake uv that logs its arguments. Its venv makes a .venv on Python 3.14
// whose python3 hands over to the real one, so .py steps really run on it;
// with failSync the package sync fails the way a missing package would. It
// says it is version when asked.
const REAL_PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const VENV_CALL = "venv --clear --managed-python --python 3.14 .venv";
const ENV_CALLS = ["--version", "python install --no-bin 3.14", VENV_CALL, "pip sync --require-hashes --python .venv/bin/python requirements.txt"];
function fakeUv({ failSync = false, version = "0.11.18" } = {}) {
  return [
    "#!/bin/sh",
    'echo "$@" >> "$UV_LOG"',
    `if [ "$1" = --version ]; then echo "uv ${version} (fake)"; exit 0; fi`,
    'if [ "$1" = venv ]; then',
    "  mkdir -p .venv/bin",
    "  printf 'home = /fake\\nversion_info = 3.14.0\\n' > .venv/pyvenv.cfg",
    `  printf '#!/bin/sh\\nexec "%s" "$@"\\n' ${JSON.stringify(REAL_PYTHON)} > .venv/bin/python3`,
    "  cp .venv/bin/python3 .venv/bin/python",
    "  chmod +x .venv/bin/python .venv/bin/python3",
    "fi",
    failSync
      ? 'if [ "$1" = pip ]; then echo "no matching distribution for nothing" >&2; exit 2; fi'
      : 'echo "uv noise" >&2',
    "exit 0",
    "",
  ].join("\n");
}

// A world: origin (bare), user (the checkout under test) and dev (a second clone that pushes).
async function makeWorld({ seedSteps = {} } = {}) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-update-")));
  dirs.push(base);
  const world = {
    base,
    origin: path.join(base, "origin.git"),
    user: path.join(base, "user", "facilitator"),
    dev: path.join(base, "dev"),
    bin: path.join(base, "bin"),
    marker: path.join(base, "marker.txt"),
    flag: path.join(base, "flag"),
    uvLog: path.join(base, "uv-calls.txt"),
  };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  world.env = {
    ...env,
    PATH: `${world.bin}${path.delimiter}${process.env.PATH}`,
    HOME: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    FACILITATOR_LOG_DIR: path.join(base, "logs"),
    UV_LOG: world.uvLog,
    UPDATE_TEST_MARKER: world.marker,
  };
  delete world.env.FACILITATOR_INTERNAL_UPDATE;

  await mkdir(world.bin);
  await writeFile(path.join(world.bin, "uv"), fakeUv());
  await chmod(path.join(world.bin, "uv"), 0o755);

  world.git = (cwd, ...args) => run("git", args, { cwd, env: world.env });
  world.mustGit = async (cwd, ...args) => {
    const result = await world.git(cwd, ...args);
    assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };

  await world.mustGit(base, "init", "--bare", "-b", "main", world.origin);
  const seed = path.join(base, "seed");
  await world.mustGit(base, "clone", world.origin, seed);
  await world.mustGit(seed, "branch", "-M", "main");
  await copyFile(path.join(ROOT, "facilitator"), path.join(seed, "facilitator"));
  await copyFile(path.join(ROOT, ".gitignore"), path.join(seed, ".gitignore"));
  await mkdir(path.join(seed, "updates"));
  await copyFile(path.join(ROOT, "updates", "README.md"), path.join(seed, "updates", "README.md"));
  await writeFile(path.join(seed, "index.html"), '<html><body><span id="npversion">v0.2.1</span></body></html>\n');
  await writeFile(path.join(seed, "requirements.txt"), "\n");
  for (const [name, text] of Object.entries(seedSteps)) {
    await writeFile(path.join(seed, "updates", name), text);
  }
  await world.mustGit(seed, "add", "-A");
  await world.mustGit(seed, "commit", "-m", "Seed");
  await world.mustGit(seed, "push", "origin", "main");

  await mkdir(path.dirname(world.user));
  await world.mustGit(base, "clone", world.origin, world.user);
  await world.mustGit(base, "clone", world.origin, world.dev);
  world.port = await freePort();
  await writeFile(path.join(world.user, "run.config.json"), JSON.stringify({ port: world.port, lanes: [] }));
  world.cli = path.join(world.user, "facilitator");

  // the maintainer's side: write files in dev, commit and push
  world.push = async (files, message = "Update") => {
    await world.mustGit(world.dev, "pull", "--ff-only");
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(world.dev, name)), { recursive: true });
      await writeFile(path.join(world.dev, name), text);
    }
    await world.mustGit(world.dev, "add", "-A");
    await world.mustGit(world.dev, "commit", "-m", message);
    await world.mustGit(world.dev, "push", "origin", "main");
    return world.mustGit(world.dev, "rev-parse", "HEAD");
  };
  world.head = () => world.mustGit(world.user, "rev-parse", "HEAD");
  // from a folder that is not the checkout: the command finds its own folder
  world.update = (extraEnv = {}, ...args) =>
    run("python3", [world.cli, "update", ...args], { cwd: base, env: { ...world.env, ...extraEnv } });
  world.uvCalls = async () => (existsSync(world.uvLog) ? (await readFile(world.uvLog, "utf8")).trim().split("\n") : []);
  world.markers = async () => (existsSync(world.marker) ? (await readFile(world.marker, "utf8")).trim().split("\n") : []);
  world.record = async () => JSON.parse(await readFile(path.join(world.user, ".facilitator-updates.json"), "utf8"));
  return world;
}

function sectionTitles(text) {
  return text.split("\n").filter(line => /^\d\. \S/.test(line));
}

function assertNoPullOrEnvironmentOutput(text) {
  for (const gone of ["2. Pull", "3. Python environment", "pulls only forward", "syncs the .venv",
    "Moved forward", "No new commits upstream", "uv found", "Environment found", "Environment created",
    "Creating the environment", "Syncing packages", "Packages synced", "uv noise"]) {
    assert.ok(!text.includes(gone), `${gone} is not printed:\n${text}`);
  }
}

const STEP_SH = word => `echo ${word} >> "$UPDATE_TEST_MARKER"\n`;
const STEP_PY = word => `import os\nwith open(os.environ["UPDATE_TEST_MARKER"], "a") as f:\n    f.write("${word}\\n")\n`;

async function newVersionAndCli(world, extra = {}) {
  const cli = await readFile(path.join(world.dev, "facilitator"), "utf8");
  const changed = cli.replace(RELOAD_LINE, `${RELOAD_LINE} (from the pulled code)`);
  assert.notEqual(changed, cli, "the reload line is in the CLI");
  return {
    facilitator: changed,
    "index.html": '<html><body><span id="npversion">v0.2.2</span></body></html>\n',
    ...extra,
  };
}

test("a clean pull runs the new steps once, from the pulled code, and not again", async () => {
  const world = await makeWorld();
  const pushed = await world.push(await newVersionAndCli(world, {
    "updates/0001-mark.sh": STEP_SH("sh"),
    "updates/0002-mark.py": STEP_PY("py"),
  }));
  const link = path.join(world.base, "installed-bin", "facilitator");
  await mkdir(path.dirname(link));
  await symlink(world.cli, link);

  const first = await run("python3", [link, "update"], { cwd: world.base, env: world.env });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Branch main follows origin\/main\./);
  assert.deepEqual(sectionTitles(first.stdout), ["1. Checkout", "2. Update steps", "3. Board"]);
  assertNoPullOrEnvironmentOutput(first.stdout);
  assert.ok(!first.stderr.includes("uv noise"), "uv's own output is held back on success");
  assert.match(first.stdout, /0001-mark\.sh done\./);
  assert.match(first.stdout, /0002-mark\.py done\./);
  assert.match(first.stdout, /Old version: v0\.2\.1\nNew version: v0\.2\.2\n/);
  assert.ok(first.stdout.includes(`${RELOAD_LINE} (from the pulled code)`),
    "the hand-over ran the pulled code's own text, not the old code's");
  assert.match(first.stdout, /The board is not running on port \d+, so it was not started\./);
  assert.equal(await world.head(), pushed);
  assert.deepEqual(await world.markers(), ["sh", "py"]);
  assert.deepEqual(Object.keys((await world.record()).ran), ["0001-mark.sh", "0002-mark.py"]);
  assert.deepEqual(await world.uvCalls(), ENV_CALLS);
  assert.equal(await world.mustGit(world.user, "status", "--porcelain"), "", "the record and .venv are ignored");

  await world.push({ "updates/0003-mark.sh": STEP_SH("three") });
  const second = await world.update();
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(await world.markers(), ["sh", "py", "three"], "only the new step ran");
  assert.deepEqual(Object.keys((await world.record()).ran), ["0001-mark.sh", "0002-mark.py", "0003-mark.sh"]);
});

test("a dirty checkout is refused and nothing is changed", async () => {
  const world = await makeWorld();
  const before = await world.head();
  const edited = path.join(world.user, "index.html");
  await writeFile(edited, "<html>edited by hand</html>\n");
  await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /This checkout has uncommitted changes\./);
  assert.match(result.stderr, /index\.html/);
  assert.match(result.stderr, /Nothing was changed\./);
  assert.equal(await world.head(), before);
  assert.equal(await readFile(edited, "utf8"), "<html>edited by hand</html>\n");
  assert.equal(existsSync(path.join(world.user, "updates", "0001-mark.sh")), false);
  assert.equal(existsSync(path.join(world.user, ".facilitator-updates.json")), false);
  assert.deepEqual(await world.markers(), []);
  assert.deepEqual(await world.uvCalls(), []);
});

test("an untracked file does not block the update and is left alone", async () => {
  const world = await makeWorld();
  const notes = path.join(world.user, "notes.txt");
  await writeFile(notes, "mine\n");
  await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await readFile(notes, "utf8"), "mine\n");
  assert.deepEqual(await world.markers(), ["sh"]);
});

test("a history that cannot fast-forward is refused, and no merge or rebase happens", async () => {
  const world = await makeWorld();
  await world.mustGit(world.user, "config", "pull.rebase", "true");
  await writeFile(path.join(world.user, "local.txt"), "local\n");
  await world.mustGit(world.user, "add", "local.txt");
  await world.mustGit(world.user, "commit", "-m", "Local work");
  const before = await world.head();
  await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot be moved forward on its own/);
  assert.match(result.stderr, /Nothing was changed\./);
  assert.equal(await world.head(), before);
  assert.equal(await world.mustGit(world.user, "rev-list", "--merges", "HEAD"), "");
  assert.equal(await world.mustGit(world.user, "log", "-1", "--format=%s"), "Local work");
  assert.equal(await readFile(path.join(world.user, "local.txt"), "utf8"), "local\n");
  assert.deepEqual(await world.markers(), []);
  assert.deepEqual(await world.uvCalls(), []);
});

test("a failing step stops the update, is not recorded, and runs again next time", async () => {
  const world = await makeWorld();
  await world.push({
    "updates/0001-flaky.sh": '[ -e "$UPDATE_TEST_FLAG" ] || { echo "flaky step failing" >&2; exit 3; }\n' + STEP_SH("flaky"),
    "updates/0002-after.sh": STEP_SH("after"),
  });

  const first = await world.update({ UPDATE_TEST_FLAG: world.flag });
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /flaky step failing/);
  assert.match(first.stderr, /Update step 0001-flaky\.sh failed\./);
  assert.match(first.stderr, /runs again next time/);
  assert.match(first.stderr, /The board was not restarted\. Once the update goes through, run: facilitator restart/);
  assert.deepEqual(await world.markers(), [], "the step after the failing one waited");
  assert.equal(existsSync(path.join(world.user, ".facilitator-updates.json")), false);

  await writeFile(world.flag, "");
  const second = await world.update({ UPDATE_TEST_FLAG: world.flag });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assertNoPullOrEnvironmentOutput(second.stdout);
  assert.match(second.stdout, /0001-flaky\.sh done\./);
  assert.deepEqual(await world.markers(), ["flaky", "after"]);
  assert.deepEqual(Object.keys((await world.record()).ran), ["0001-flaky.sh", "0002-after.sh"]);
});

test("a pull that fails still prints its error and what to do", async () => {
  const world = await makeWorld();
  await rm(world.origin, { recursive: true, force: true });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /git could not pull origin\/main\./);
  assert.match(result.stderr, /Nothing was changed\./);
  assert.match(result.stderr, /Fix that, then run facilitator update again\./);
  assert.deepEqual(sectionTitles(result.stdout), ["1. Checkout"]);
  assert.deepEqual(await world.uvCalls(), []);
});

test("an environment sync that fails still prints uv's output, the error and what to do", async () => {
  const world = await makeWorld();
  await writeFile(path.join(world.bin, "uv"), fakeUv({ failSync: true }));
  const pushed = await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no matching distribution for nothing/);
  assert.match(result.stderr, /uv could not sync requirements\.txt\./);
  assert.match(result.stderr, /See the output above, then run \.\/install\.sh again\./);
  assert.match(result.stderr, /The board was not restarted\. Once the update goes through, run: facilitator restart/);
  assert.deepEqual(sectionTitles(result.stdout), ["1. Checkout"]);
  assert.equal(await world.head(), pushed, "the pull still ran");
  assert.deepEqual(await world.markers(), [], "no step ran after the failed sync");
});

test("a uv too old to install Python 3.14 stops the update in one line, before .venv is touched", async () => {
  const world = await makeWorld();
  await writeFile(path.join(world.bin, "uv"), fakeUv({ version: "0.8.19" }));
  const pushed = await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("⚠ uv 0.8.19 is too old to install Python 3.14: upgrade it to 0.9.0 or newer "
    + "(brew upgrade uv, or uv self update), then run ./install.sh again.\n"), result.stderr);
  assert.match(result.stderr, /The board was not restarted\. Once the update goes through, run: facilitator restart/);
  assert.equal(await world.head(), pushed, "the pull still ran");
  assert.deepEqual(await world.uvCalls(), ["--version"], "uv was used anyway");
  assert.equal(existsSync(path.join(world.user, ".venv")), false);
  assert.deepEqual(await world.markers(), [], "no step ran");
});

test("a branch with no upstream is refused and the command to set one is named", async () => {
  const world = await makeWorld();
  await world.mustGit(world.user, "branch", "--unset-upstream");
  const before = await world.head();
  await world.push({ "updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Branch main has no upstream/);
  assert.match(result.stderr, /git branch --set-upstream-to=origin\/main/);
  assert.equal(await world.head(), before);
  assert.deepEqual(await world.markers(), []);
  assert.deepEqual(await world.uvCalls(), []);
});

test("a checkout that is not on a branch is refused", async () => {
  const world = await makeWorld();
  await world.mustGit(world.user, "checkout", "--detach");
  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not on a branch/);
  assert.deepEqual(await world.uvCalls(), []);
});

test("a folder that is not a git checkout is refused", async () => {
  const world = await makeWorld();
  const loose = path.join(world.base, "loose");
  await mkdir(loose);
  await copyFile(path.join(ROOT, "facilitator"), path.join(loose, "facilitator"));
  const result = await run("python3", [path.join(loose, "facilitator"), "update"], { cwd: world.base, env: world.env });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /This folder is not a git checkout/);
  assert.deepEqual(await world.uvCalls(), []);
});

test("with nothing to pull it still runs pending steps once, and does not restart", async () => {
  const world = await makeWorld({ seedSteps: { "0001-mark.sh": STEP_SH("sh") } });
  const before = await world.head();

  const first = await world.update();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assertNoPullOrEnvironmentOutput(first.stdout);
  assert.deepEqual(await world.uvCalls(), ENV_CALLS, "the environment sync still ran");
  assert.match(first.stdout, /0001-mark\.sh done\./);
  assert.match(first.stdout, /Nothing was pulled, so the board was left as it is\./);
  assert.match(first.stdout, /Already up to date \(v0\.2\.1\)\./);
  assert.ok(!first.stdout.includes(RELOAD_LINE));
  assert.ok(!first.stdout.includes("Old version"));
  assert.equal(await world.head(), before);
  assert.deepEqual(await world.markers(), ["sh"]);

  const second = await world.update();
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /No new update steps\./);
  assert.deepEqual(await world.markers(), ["sh"], "the step did not run again");
});

test("a record file that cannot be read stops the update before any step runs", async () => {
  const world = await makeWorld({ seedSteps: { "0001-mark.sh": STEP_SH("sh") } });
  await writeFile(path.join(world.user, ".facilitator-updates.json"), "not json");
  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /\.facilitator-updates\.json is invalid\./);
  assert.deepEqual(await world.markers(), []);
});

test("files in updates that are not numbered steps are ignored, and steps run in name order", async () => {
  const world = await makeWorld({
    seedSteps: {
      "0010-last.sh": STEP_SH("ten"),
      "0002-first.sh": STEP_SH("two"),
      "notes.sh": STEP_SH("never"),
      "003-short.sh": STEP_SH("never"),
      "0004-wrong.txt": "never\n",
    },
  });
  const result = await world.update();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(await world.markers(), ["two", "ten"]);
});

test("update takes no options and the help text lists the command", async () => {
  const world = await makeWorld();
  const refused = await world.update({}, "--force");
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /update takes no options; got --force\./);
  assert.deepEqual(await world.uvCalls(), []);

  const help = await world.update({}, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: facilitator update/);

  const listed = await run("python3", [world.cli, "help"], { cwd: world.base, env: world.env });
  assert.match(listed.stderr, /facilitator update\n/);
});

test("the restart is only through the safe restart, only when pulled and running, and never after a failed step", async () => {
  const world = await makeWorld();
  const code = `
import contextlib, importlib.machinery, importlib.util, io, json, sys
loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(world.cli)})
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)

calls = []
def never(*a, **k):
    raise AssertionError("touched a real server")
cli.state = never
cli.start_server = never
cli.stop_server = never
cli.ensure_uv = lambda quiet=False: "/fake/uv"
STOPPED = [False]   # whether the .venv rebuild stopped the board, as ensure_env reports it
def fake_env(uv, quiet=False):
    calls.append("env")
    cli.env_stopped_board = STOPPED[0]
    return STOPPED[0]
cli.ensure_env = fake_env
RUNNING = [True]
cli.board_running = lambda port: RUNNING[0]
REFUSE = [None]
def fake_restart(args):
    calls.append(args)
    if REFUSE[0]:
        raise SystemExit(REFUSE[0])
    print("Board restarted.")
cli.cmd_restart = fake_restart

def scenario(pulled, running, refuse=None, stopped=False):
    del calls[:]
    RUNNING[0] = running
    REFUSE[0] = refuse
    STOPPED[0] = stopped
    cli.env_stopped_board = False
    out, err = io.StringIO(), io.StringIO()
    exit_code = None
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            cli.cmd_update_steps(["_update-steps", "--from-version", "v0.2.1"] + (["--pulled"] if pulled else []))
        except SystemExit as stop:
            exit_code = stop.code
    return {"calls": list(calls), "out": out.getvalue(), "err": err.getvalue(), "exit": exit_code}

results = {
    "pulled_running": scenario(True, True),
    "pulled_down": scenario(True, False),
    "current_running": scenario(False, True),
    "refused": scenario(True, True, "restart: port 1 is still held by something; nothing new was started"),
    "rebuilt_current": scenario(False, False, stopped=True),
    "rebuilt_pulled": scenario(True, False, stopped=True),
}
step = cli.UPDATES_DIR / "0001-fails.sh"
step.write_text("exit 7\\n")
results["failed_step"] = scenario(True, True)
results["rebuilt_failed_step"] = scenario(False, False, stopped=True)
print(json.dumps(results))
`;
  const result = await run("python3", ["-c", code], { cwd: world.user, env: world.env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const r = JSON.parse(result.stdout.trim().split("\n").at(-1));

  assert.deepEqual(r.pulled_running.calls, ["env", ["restart"]]);
  assert.equal(r.pulled_running.exit, null);
  assert.equal(r.pulled_running.out.split("Board restarted.").length - 1, 1,
    "the restart was announced more than once: " + r.pulled_running.out);
  assert.match(r.pulled_running.out, /Old version: v0\.2\.1\nNew version: v0\.2\.1\n/);

  assert.deepEqual(r.pulled_down.calls, ["env"]);
  assert.match(r.pulled_down.out, /The board is not running on port \d+, so it was not started\./);
  assert.match(r.pulled_down.out, /Start it with: facilitator run/);

  assert.deepEqual(r.current_running.calls, ["env"]);
  assert.match(r.current_running.out, /Nothing was pulled, so the board was left as it is\./);

  assert.deepEqual(r.refused.calls, ["env", ["restart"]]);
  assert.equal(r.refused.exit, 1);
  assert.match(r.refused.err, /The board was not restarted\./);
  assert.match(r.refused.err, /restart: port 1 is still held by something/);
  assert.match(r.refused.err, /Restart it yourself with: facilitator restart/);
  assert.match(r.refused.out, /Facilitator updated\./, "the rest of the report is still printed");

  assert.deepEqual(r.failed_step.calls, ["env"], "no restart after a failed step");
  assert.match(String(r.failed_step.exit), /Update step 0001-fails\.sh failed\./);
  assert.match(String(r.failed_step.exit), /The board was not restarted\./);

  // a board the .venv rebuild stopped is started again, pulled or not, and
  // never after a failed step, which then says the board is down
  for (const name of ["rebuilt_current", "rebuilt_pulled"]) {
    assert.deepEqual(r[name].calls, ["env", ["restart"]], name);
    assert.equal(r[name].exit, null, name);
    assert.match(r[name].out, /The board was stopped to rebuild \.venv\. Starting it again\.\n/, name);
    assert.doesNotMatch(r[name].out, /Nothing was pulled|is not running on port/, name);
  }
  assert.deepEqual(r.rebuilt_failed_step.calls, ["env"], "no start after a failed step");
  assert.match(String(r.rebuilt_failed_step.exit),
    /The board was not restarted\. Once the update goes through, run: facilitator restart/);
});
