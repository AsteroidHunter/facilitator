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
// uv runs in data/, where .venv is made; the requirements come from app/
const VENV_CALL = "venv --clear --managed-python --python 3.14 .venv";
const envCalls = world => ["--version", "python install --no-bin 3.14", VENV_CALL,
  `pip sync --require-hashes --python .venv/bin/python ${path.join(world.user, "app", "requirements.txt")}`];
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

// A throwaway signing key made in the world's own folder, never a real one,
// and its line for a signers file.
async function makeKey(world, name) {
  const file = path.join(world.keys, name);
  const made = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", file],
    { cwd: world.base, env: world.env });
  assert.equal(made.code, 0, made.stderr);
  const pub = (await readFile(`${file}.pub`, "utf8")).trim();
  return { name, file, line: `${name} namespaces="git" ${pub}` };
}

// A world: origin (bare), user (the checkout under test) and dev (a second
// clone that pushes, signing with the maintainer's throwaway key). listed:
// the keys made and put in the seed's signers file; signers: that file's text
// instead (null: no file); cli: the command's text instead of this one.
async function makeWorld({ seedSteps = {}, listed = ["maintainer"], signers, cli } = {}) {
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
    keys: path.join(base, "keys"),
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
  // signing reads the key file itself and never asks an agent
  delete world.env.SSH_AUTH_SOCK;

  await mkdir(world.bin);
  await mkdir(world.keys);
  world.keyed = {};
  for (const name of listed) world.keyed[name] = await makeKey(world, name);
  world.key = world.keyed.maintainer;
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
  // laid out as the repository is: the launcher and .gitignore at the top, the
  // command and what it reads in app/
  await mkdir(path.join(seed, "app", "updates"), { recursive: true });
  await copyFile(path.join(ROOT, "..", "facilitator"), path.join(seed, "facilitator"));
  if (cli === undefined) await copyFile(path.join(ROOT, "facilitator"), path.join(seed, "app", "facilitator"));
  else await writeFile(path.join(seed, "app", "facilitator"), cli);
  await copyFile(path.join(ROOT, "data_folder.py"), path.join(seed, "app", "data_folder.py"));
  await copyFile(path.join(ROOT, "..", ".gitignore"), path.join(seed, ".gitignore"));
  const signersText = signers === undefined ? Object.values(world.keyed).map(key => key.line + "\n").join("") : signers;
  if (signersText !== null) await writeFile(path.join(seed, "app", "update-signers"), signersText);
  await copyFile(path.join(ROOT, "updates", "README.md"), path.join(seed, "app", "updates", "README.md"));
  await writeFile(path.join(seed, "app", "index.html"), '<html><body><span id="npversion">v0.2.1</span></body></html>\n');
  await writeFile(path.join(seed, "app", "requirements.txt"), "\n");
  for (const [name, text] of Object.entries(seedSteps)) {
    await writeFile(path.join(seed, "app", "updates", name), text);
  }
  await world.mustGit(seed, "add", "-A");
  await world.mustGit(seed, "commit", "-m", "Seed");
  await world.mustGit(seed, "push", "origin", "main");

  await mkdir(path.dirname(world.user));
  await world.mustGit(base, "clone", world.origin, world.user);
  await world.mustGit(base, "clone", world.origin, world.dev);
  if (world.key) {
    await world.mustGit(world.dev, "config", "gpg.format", "ssh");
    await world.mustGit(world.dev, "config", "user.signingkey", world.key.file);
    await world.mustGit(world.dev, "config", "commit.gpgsign", "true");
  }
  world.port = await freePort();
  await mkdir(path.join(world.user, "data"));
  await writeFile(path.join(world.user, "data", "run.config.json"), JSON.stringify({ port: world.port, lanes: [] }));
  // the launcher at the top, which the command link and an older update run
  world.cli = path.join(world.user, "facilitator");
  world.appCli = path.join(world.user, "app", "facilitator");

  // the maintainer's side: write files in dev, commit and push. Signed with
  // the maintainer's key unless key names another one, or is null: unsigned
  world.push = async (files, message = "Update", { key } = {}) => {
    await world.mustGit(world.dev, "pull", "--ff-only");
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(world.dev, name)), { recursive: true });
      await writeFile(path.join(world.dev, name), text);
    }
    await world.mustGit(world.dev, "add", "-A");
    const signer = key ? ["-c", `user.signingkey=${key.file}`] : [];
    const unsigned = key === null ? ["--no-gpg-sign"] : [];
    await world.mustGit(world.dev, ...signer, "commit", ...unsigned, "-m", message);
    await world.mustGit(world.dev, "push", "origin", "main");
    return world.mustGit(world.dev, "rev-parse", "HEAD");
  };
  world.head = () => world.mustGit(world.user, "rev-parse", "HEAD");
  // from a folder that is not the checkout: the command finds its own folder
  world.update = (extraEnv = {}, ...args) =>
    run("python3", [world.cli, "update", ...args], { cwd: base, env: { ...world.env, ...extraEnv } });
  world.uvCalls = async () => (existsSync(world.uvLog) ? (await readFile(world.uvLog, "utf8")).trim().split("\n") : []);
  world.markers = async () => (existsSync(world.marker) ? (await readFile(world.marker, "utf8")).trim().split("\n") : []);
  world.record = async () => JSON.parse(await readFile(path.join(world.user, "data", ".facilitator-updates.json"), "utf8"));
  return world;
}

function sectionTitles(text) {
  return text.split("\n").filter(line => /^\d\. \S/.test(line));
}

function assertNoPullOrEnvironmentOutput(text) {
  for (const gone of ["2. Pull", "3. Python environment", "pulls only forward", "syncs the .venv",
    "Moved forward", "No new commits upstream", "uv found", "Environment found", "Environment created",
    "Creating the environment", "Syncing packages", "Packages synced", "Setting up the Python 3.14 environment",
    "Python 3.14 environment ready", "Installing the packages Facilitator needs", "Packages installed", "uv noise"]) {
    assert.ok(!text.includes(gone), `${gone} is not printed:\n${text}`);
  }
}

const STEP_SH = word => `echo ${word} >> "$UPDATE_TEST_MARKER"\n`;
const STEP_PY = word => `import os\nwith open(os.environ["UPDATE_TEST_MARKER"], "a") as f:\n    f.write("${word}\\n")\n`;

async function newVersionAndCli(world, extra = {}) {
  const cli = await readFile(path.join(world.dev, "app", "facilitator"), "utf8");
  const changed = cli.replace(RELOAD_LINE, `${RELOAD_LINE} (from the pulled code)`);
  assert.notEqual(changed, cli, "the reload line is in the CLI");
  return {
    "app/facilitator": changed,
    "app/index.html": '<html><body><span id="npversion">v0.2.2</span></body></html>\n',
    ...extra,
  };
}

test("a clean pull runs the new steps once, from the pulled code, and not again", async () => {
  const world = await makeWorld();
  const pushed = await world.push(await newVersionAndCli(world, {
    "app/updates/0001-mark.sh": STEP_SH("sh"),
    "app/updates/0002-mark.py": STEP_PY("py"),
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
  assert.deepEqual(await world.uvCalls(), envCalls(world));
  assert.equal(await world.mustGit(world.user, "status", "--porcelain"), "", "the record and .venv are ignored");

  await world.push({ "app/updates/0003-mark.sh": STEP_SH("three") });
  const second = await world.update();
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(await world.markers(), ["sh", "py", "three"], "only the new step ran");
  assert.deepEqual(Object.keys((await world.record()).ran), ["0001-mark.sh", "0002-mark.py", "0003-mark.sh"]);
});

test("a dirty checkout is refused and nothing is changed", async () => {
  const world = await makeWorld();
  const before = await world.head();
  const edited = path.join(world.user, "app", "index.html");
  await writeFile(edited, "<html>edited by hand</html>\n");
  await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /This checkout has uncommitted changes\./);
  assert.match(result.stderr, /index\.html/);
  assert.match(result.stderr, /Nothing was changed\./);
  assert.equal(await world.head(), before);
  assert.equal(await readFile(edited, "utf8"), "<html>edited by hand</html>\n");
  assert.equal(existsSync(path.join(world.user, "app", "updates", "0001-mark.sh")), false);
  assert.equal(existsSync(path.join(world.user, "data", ".facilitator-updates.json")), false);
  assert.deepEqual(await world.markers(), []);
  assert.deepEqual(await world.uvCalls(), []);
});

test("an untracked file does not block the update and is left alone", async () => {
  const world = await makeWorld();
  const notes = path.join(world.user, "notes.txt");
  await writeFile(notes, "mine\n");
  await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

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
  await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

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
    "app/updates/0001-flaky.sh": '[ -e "$UPDATE_TEST_FLAG" ] || { echo "flaky step failing" >&2; exit 3; }\n' + STEP_SH("flaky"),
    "app/updates/0002-after.sh": STEP_SH("after"),
  });

  const first = await world.update({ UPDATE_TEST_FLAG: world.flag });
  assert.notEqual(first.code, 0);
  assert.match(first.stderr, /flaky step failing/);
  assert.match(first.stderr, /Update step 0001-flaky\.sh failed\./);
  assert.match(first.stderr, /runs again next time/);
  assert.match(first.stderr, /The board was not restarted\. Once the update goes through, run: facilitator restart/);
  assert.deepEqual(await world.markers(), [], "the step after the failing one waited");
  assert.equal(existsSync(path.join(world.user, "data", ".facilitator-updates.json")), false);

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
  const pushed = await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

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
  const pushed = await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.ok(result.stderr.includes("⚠ uv 0.8.19 is too old to install Python 3.14: upgrade it to 0.9.0 or newer "
    + "(uv self update), then run ./install.sh again.\n"), result.stderr);
  assert.match(result.stderr, /The board was not restarted\. Once the update goes through, run: facilitator restart/);
  assert.equal(await world.head(), pushed, "the pull still ran");
  assert.deepEqual(await world.uvCalls(), ["--version"], "uv was used anyway");
  assert.equal(existsSync(path.join(world.user, "data", ".venv")), false);
  assert.deepEqual(await world.markers(), [], "no step ran");
});

test("a branch with no upstream is refused and the command to set one is named", async () => {
  const world = await makeWorld();
  await world.mustGit(world.user, "branch", "--unset-upstream");
  const before = await world.head();
  await world.push({ "app/updates/0001-mark.sh": STEP_SH("sh") });

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
  // a copy laid out as a checkout, with no git behind it
  const loose = path.join(world.base, "loose");
  await mkdir(path.join(loose, "app"), { recursive: true });
  await copyFile(path.join(ROOT, "..", "facilitator"), path.join(loose, "facilitator"));
  await copyFile(path.join(ROOT, "facilitator"), path.join(loose, "app", "facilitator"));
  await copyFile(path.join(ROOT, "data_folder.py"), path.join(loose, "app", "data_folder.py"));
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
  assert.deepEqual(await world.uvCalls(), envCalls(world), "the environment sync still ran");
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
  await writeFile(path.join(world.user, "data", ".facilitator-updates.json"), "not json");
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
loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(world.appCli)})
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

// the command's own functions, loaded from a world's checkout, with the body
// run after them; its last line printed as JSON is the answer
async function drive(world, body, extraEnv = {}) {
  const code = `
import contextlib, importlib.machinery, importlib.util, io, json, os, sys, types
loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(world.appCli)})
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)
${body}
`;
  const result = await run("python3", ["-c", code], { cwd: world.user, env: { ...world.env, ...extraEnv } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test("the board's own code is its Python in app/ and its requirements, and nothing else", async () => {
  const world = await makeWorld();
  const paths = {
    "app/server.py": true, "app/usage_counts.py": true, "app/updates/0007-tool.py": true,
    "app/requirements.txt": true, "app/requirements-search.txt": true,
    "app/index.html": false, "app/m.html": false, "app/card-logic.js": false, "app/card-tokens.css": false,
    "app/facilitator": false, "app/updates/README.md": false, "app/updates/0008-tool.sh": false,
    "app/tests/test_update_check.py": false, "app/tools/readme-header/generate.py": false,
    ".agents/skills/facilitator/scripts/link.py": false, "facilitator": false, "install.sh": false,
    "docs/install.md": false, "README.md": false,
  };
  const r = await drive(world, `
paths = ${JSON.stringify(Object.keys(paths))}
print(json.dumps({
    "files": {p: cli.server_file(p) for p in paths},
    "pages": cli.restart_needed(["app/index.html", "app/card-logic.js"], []),
    "server": cli.restart_needed(["app/index.html", "app/server.py"], []),
    "steps": cli.restart_needed(["app/index.html"], ["0007-tool.sh"]),
    "unknown": cli.restart_needed(None, []),
    "nothing": cli.restart_needed([], []),
}))`);
  assert.deepEqual(r.files, paths);
  assert.equal(r.pages, false, "a page-only pull restarts the board");
  assert.equal(r.server, true);
  assert.equal(r.steps, true, "steps that ran change what the board runs with");
  assert.equal(r.unknown, true, "changes that cannot be read must count as changed");
  assert.equal(r.nothing, false);
});

test("a pull that changed only pages leaves the board running, and one that changed its code restarts it", async () => {
  const world = await makeWorld();
  await world.push({ "app/index.html": '<html><body><span id="npversion">v0.2.2</span></body></html>\n',
                     "app/card-logic.js": "// new page code\n" });
  const pages = await world.update();
  assert.equal(pages.code, 0, pages.stdout + pages.stderr);
  assert.match(pages.stdout, /⊘ The board's own code did not change, so it was not restarted\./);
  assert.doesNotMatch(pages.stdout, /is not running on port|Restarting it/);
  assert.match(pages.stdout, /Old version: v0\.2\.1\nNew version: v0\.2\.2\n/);
  assert.ok(pages.stdout.includes(RELOAD_LINE), "the reminder to reload goes");
  assert.doesNotMatch(pages.stdout, /@stage/, "a terminal update printed the board's stage lines");

  for (const changed of [{ "app/server.py": "# the server, changed\n" }, { "app/requirements.txt": "# one more\n" }]) {
    await world.push(changed);
    const code = await world.update();
    assert.equal(code.code, 0, code.stdout + code.stderr);
    assert.match(code.stdout, /The board is not running on port \d+, so it was not started\./,
      `${Object.keys(changed)[0]} did not count as the board's code`);
    assert.doesNotMatch(code.stdout, /own code did not change/);
  }
});

test("an update the board started writes its stages in order, and the same with a running board restarts it", async () => {
  const world = await makeWorld();
  await world.push({ "app/index.html": '<html><body><span id="npversion">v0.2.2</span></body></html>\n' });
  const result = await world.update({ FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const stages = result.stdout.split("\n").filter(line => line.startsWith("@stage "));
  assert.deepEqual(stages, ["@stage downloading", "@stage setting-up"], "a page-only update said it restarts");

  const refused = await world.update({ FACILITATOR_UPDATE_FROM_BOARD: "1" }, "--force");
  assert.notEqual(refused.code, 0, "update took an option");

  // the steps half with the board running and a pull that changed its code
  const before = await world.head();
  const after = await world.push({ "app/server.py": "# the server, changed\n" });
  await world.mustGit(world.user, "pull", "--ff-only");
  const r = await drive(world, `
calls = []
cli.ensure_uv = lambda quiet=False: "/fake/uv"
cli.ensure_env = lambda uv, quiet=False: False
cli.board_running = lambda port: True
def fake_restart(args):
    calls.append("restart")
    print("Board restarted.")
cli.cmd_restart = fake_restart
out = io.StringIO()
with contextlib.redirect_stdout(out):
    cli.cmd_update_steps(["_update-steps", "--from-version", "v0.2.1", "--pulled", "--from-commit", ${JSON.stringify(before)}])
print(json.dumps({"calls": calls, "out": out.getvalue()}))`, { FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.notEqual(before, after);
  assert.deepEqual(r.calls, ["restart"]);
  assert.deepEqual(r.out.split("\n").filter(line => line.startsWith("@stage ")), ["@stage restarting"]);
  assert.ok(r.out.indexOf("@stage restarting") < r.out.indexOf("Board restarted."), "the stage came after the restart");
});

test("a restart for an update the board started asks Chrome only with macOS's leave, opens a window only for a board that let none in, and the board it starts is not marked", async () => {
  const world = await makeWorld();
  const harness = (fromBoard, allowed = true, kept = true) => `
calls = []
cli.FROM_BOARD = ${fromBoard ? "True" : "False"}
cli.load_config = lambda: {"port": 9, "lanes": []}
cli.server_process = lambda port: ((4242, "server"), None)
cli.board_elsewhere = lambda port: None
cli.stop_server = lambda owner, port: None
cli.port_free = lambda port: True
cli.start_and_confirm = lambda port: (None, None)
cli.chrome_allowed = lambda: calls.append("asked macOS") or ${allowed ? "True" : "False"}
cli.chrome_tabs = lambda: calls.append("read chrome") or [(1, ["http://127.0.0.1:9/"])]
cli.launch_url = lambda cfg, url: url + "?launch=CODE"
cli.send_tab = lambda wid, place, expected, goal: calls.append(["sent", place, expected, goal]) or "SENT"
cli.window_key_kept = lambda: ${kept ? "True" : "False"}
cli.open_app = lambda cfg, dry: calls.append("opened a window")
out = io.StringIO()
with contextlib.redirect_stdout(out):
    cli.cmd_restart(["restart"])
seen = {}
class Child:
    def __init__(self, argv, **kw):
        seen["env"] = kw.get("env")
os.environ[cli.FROM_BOARD_VARIABLE] = "1"
cli.subprocess = types.SimpleNamespace(Popen=Child, DEVNULL=-3)
cli.start_server()
print(json.dumps({"calls": calls, "out": out.getvalue(), "marked": cli.FROM_BOARD_VARIABLE in seen["env"],
                  "env": bool(seen["env"])}))`;
  const sent = ["sent", 1, "http://127.0.0.1:9/", "http://127.0.0.1:9/?launch=CODE"];
  const terminal = await drive(world, harness(false));
  assert.deepEqual(terminal.calls, ["read chrome", sent], "a restart from the terminal did not send the board's tab on");
  assert.equal(terminal.out, "Board restarted.\n", "a restart from the terminal still asks for a reload");
  const board = await drive(world, harness(true));
  assert.deepEqual(board.calls, ["asked macOS", "read chrome", sent], "an update the board started skipped its tab");
  assert.equal(board.out, "Board restarted.\n");
  assert.equal(board.marked, false, "the board started by the update carries its mark");
  assert.equal(board.env, true);
  // macOS would ask the person: Chrome is not asked, and a window opens only
  // when the board has let no window in, so the page that said yes is refused
  const unasked = await drive(world, harness(true, false, true));
  assert.deepEqual(unasked.calls, ["asked macOS"], "Chrome was asked without macOS's leave");
  const opened = await drive(world, harness(true, false, false));
  assert.deepEqual(opened.calls, ["asked macOS", "opened a window"]);
});

// ---- signed updates: an update moves only to a commit on main that a key in
// app/update-signers signed, as that file stands in the version installed

const UNSIGNED = "⚠ The newest version is not signed by Facilitator's maintainer, so nothing was changed.";
const NO_KEY = "⚠ No release signing key is listed yet in app/update-signers, so no update can be checked "
  + "and nothing was changed.";
const WAITS = "⊘ 1 newer commit on main is not signed by Facilitator's maintainer, so it waits for the next signed version.";
// the last commit before the check: an update from it is done by its own code
const PRE_CHECK = "31c42d77e0980c8826d95910317ca9ff68b1ee92";
const page = version => `<html><body><span id="npversion">${version}</span></body></html>\n`;
// the first refusal line, the one the board shows when an update it started stops
const firstRefusal = text => text.split("\n").find(line => line.startsWith("⚠ "));

// one update that must refuse with that line and change nothing: the
// checkout, its files, uv and the steps all as they were just before it
async function assertRefused(world, line, extraEnv = {}) {
  const before = await world.head();
  const uv = await world.uvCalls();
  const marked = await world.markers();
  const result = await world.update(extraEnv);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  assert.equal(firstRefusal(result.stderr), line, result.stderr);
  assert.deepEqual(sectionTitles(result.stdout), ["1. Checkout"]);
  assert.equal(await world.head(), before, "the checkout moved");
  assert.equal(await world.mustGit(world.user, "status", "--porcelain"), "");
  assert.deepEqual(await world.uvCalls(), uv, "the update went on after refusing");
  assert.deepEqual(await world.markers(), marked);
  return result;
}

test("a signed tip updates and the check adds nothing to what is printed", async () => {
  const world = await makeWorld();
  const signed = await world.push({ "app/index.html": page("v0.2.2"), "app/updates/0001-mark.sh": STEP_SH("sh") });
  const result = await world.update();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await world.head(), signed);
  assert.match(result.stdout, /New version: v0\.2\.2\n/);
  assert.deepEqual(await world.markers(), ["sh"]);
  assert.doesNotMatch(result.stdout + result.stderr, /signed|signing/);
});

test("an unsigned tip over a signed commit moves to the signed one, and the unsigned one rides along with the next", async () => {
  const world = await makeWorld();
  const signed = await world.push({ "app/index.html": page("v0.2.2"), "app/updates/0001-mark.sh": STEP_SH("sh") }, "Release");
  await world.push({ "README.md": "edited on GitHub's website\n" }, "Update README.md", { key: null });

  const first = await world.update();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(await world.head(), signed);
  assert.ok(first.stdout.includes(WAITS + "\n"), first.stdout);
  assert.match(first.stdout, /New version: v0\.2\.2\n/);
  assert.deepEqual(await world.markers(), ["sh"]);
  assert.equal(existsSync(path.join(world.user, "README.md")), false);

  // the same version upstream, only not signed: nothing to refuse, nothing taken
  const again = await world.update();
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(await world.head(), signed);
  assert.ok(again.stdout.includes(WAITS + "\n"), again.stdout);
  assert.match(again.stdout, /Already up to date \(v0\.2\.2\)\./);

  const next = await world.push({ "app/index.html": page("v0.2.3") }, "Release");
  const third = await world.update();
  assert.equal(third.code, 0, third.stdout + third.stderr);
  assert.equal(await world.head(), next);
  assert.equal(await readFile(path.join(world.user, "README.md"), "utf8"), "edited on GitHub's website\n");
  assert.doesNotMatch(third.stdout, /not signed/);
});

test("with nothing newer signed and a newer version upstream it refuses and changes nothing", async () => {
  const world = await makeWorld();
  await world.push({ "app/index.html": page("v0.2.2"), "app/updates/0001-mark.sh": STEP_SH("sh") }, "Unsigned", { key: null });
  await assertRefused(world, UNSIGNED);
  assert.equal(existsSync(path.join(world.user, "app", "updates", "0001-mark.sh")), false);
  assert.equal(await readFile(path.join(world.user, "app", "index.html"), "utf8"), page("v0.2.1"));
});

test("a commit signed by a key not on the list is refused", async () => {
  const world = await makeWorld();
  const stranger = await makeKey(world, "stranger");
  await world.push({ "app/index.html": page("v0.2.2") }, "Signed by a stranger", { key: stranger });
  await assertRefused(world, UNSIGNED);
});

test("an unsigned commit that adds a key to the list is refused, and the key it adds is not trusted after it", async () => {
  const world = await makeWorld();
  const stranger = await makeKey(world, "stranger");
  await world.push({ "app/update-signers": `${world.key.line}\n${stranger.line}\n`, "app/index.html": page("v0.2.2") },
    "Add a key", { key: null });
  await assertRefused(world, UNSIGNED);

  await world.push({ "app/index.html": page("v0.2.3") }, "Signed by the added key", { key: stranger });
  await assertRefused(world, UNSIGNED);
  assert.equal(await readFile(path.join(world.user, "app", "update-signers"), "utf8"), `${world.key.line}\n`);
});

test("a signed commit that changes the list is accepted, and the next update uses the new list", async () => {
  const world = await makeWorld();
  const next = await makeKey(world, "next");
  const handed = await world.push({ "app/update-signers": `${next.line}\n` }, "Hand releases to the next key");
  const first = await world.update();
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(await world.head(), handed);

  // the old key is off the list now
  await world.push({ "app/index.html": page("v0.2.2") }, "Signed by the old key");
  await assertRefused(world, UNSIGNED);

  const signed = await world.push({ "app/index.html": page("v0.2.3") }, "Signed by the new key", { key: next });
  const last = await world.update();
  assert.equal(last.code, 0, last.stdout + last.stderr);
  assert.equal(await world.head(), signed);
});

test("a key taken off the list is refused after that commit, within the same update", async () => {
  const world = await makeWorld({ listed: ["maintainer", "spare"] });
  const removed = await world.push({ "app/update-signers": `${world.key.line}\n` }, "Take the spare off the list");
  await world.push({ "app/index.html": page("v0.2.2") }, "Signed by the spare", { key: world.keyed.spare });
  const result = await world.update();
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await world.head(), removed, "a key the list had dropped was still taken");
  assert.ok(result.stdout.includes(WAITS + "\n"), result.stdout);
});

test("a rewritten history is refused as before, even when signed", async () => {
  const world = await makeWorld();
  const first = await world.push({ "app/index.html": page("v0.2.2") }, "Release");
  assert.equal((await world.update()).code, 0);
  assert.equal(await world.head(), first);

  await world.mustGit(world.dev, "reset", "--hard", "HEAD~1");
  await writeFile(path.join(world.dev, "app", "index.html"), page("v0.2.3"));
  await world.mustGit(world.dev, "commit", "-am", "Another history, signed");
  await world.mustGit(world.dev, "push", "--force", "origin", "main");

  const result = await world.update();
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /This checkout cannot be moved forward on its own\./);
  assert.match(result.stderr, /or the upstream's history was rewritten\./);
  assert.equal(await world.head(), first);
});

test("the person's own git settings do not change the answer: another ssh program, list, format, gpg or trust level", async () => {
  const world = await makeWorld();
  const stranger = await makeKey(world, "stranger");
  const ran = path.join(world.base, "programs-ran.txt");
  const fakeSsh = path.join(world.bin, "accept-ssh");
  await writeFile(fakeSsh, `#!/bin/sh\necho ssh >> ${JSON.stringify(ran)}\n`
    + 'echo \'Good "git" signature for stranger with ED25519 key SHA256:x\'\nexit 0\n');
  const fakeGpg = path.join(world.bin, "accept-gpg");
  await writeFile(fakeGpg, `#!/bin/sh\necho gpg >> ${JSON.stringify(ran)}\n`
    + 'echo "[GNUPG:] NEWSIG"\necho "[GNUPG:] GOODSIG ABCDEF0123456789 Someone"\n'
    + 'echo "[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2023-01-01 1700000000 0 4 0 1 10 00 '
    + '0123456789ABCDEF0123456789ABCDEF01234567"\necho "[GNUPG:] TRUST_ULTIMATE 0 pgp"\nexit 0\n');
  await chmod(fakeSsh, 0o755);
  await chmod(fakeGpg, 0o755);
  const theirs = path.join(world.base, "their-signers");
  await writeFile(theirs, `${stranger.line}\n`);
  for (const [name, value] of [["gpg.format", "openpgp"], ["gpg.ssh.program", fakeSsh],
    ["gpg.ssh.allowedSignersFile", theirs], ["gpg.program", fakeGpg], ["gpg.minTrustLevel", "ultimate"]]) {
    await world.mustGit(world.user, "config", name, value);
  }

  await world.push({ "app/index.html": page("v0.2.2") }, "Signed by a stranger", { key: stranger });
  await assertRefused(world, UNSIGNED);

  // a commit carrying a PGP signature their gpg would call good
  await world.mustGit(world.dev, "pull", "--ff-only");
  const tree = await world.mustGit(world.dev, "rev-parse", "HEAD^{tree}");
  const parent = await world.mustGit(world.dev, "rev-parse", "HEAD");
  const object = path.join(world.base, "pgp-commit");
  await writeFile(object, `tree ${tree}\nparent ${parent}\nauthor Test <test@example.com> 1700000000 +0000\n`
    + "committer Test <test@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n"
    + " iQEzBAABCAAdFiEEnotarealsignature\n -----END PGP SIGNATURE-----\n\nSigned with PGP\n");
  const pgp = await world.mustGit(world.dev, "hash-object", "-t", "commit", "-w", object);
  await world.mustGit(world.dev, "reset", "--hard", pgp);
  await world.mustGit(world.dev, "push", "origin", "main");
  await assertRefused(world, UNSIGNED);
  assert.equal(existsSync(ran), false, "one of their programs was asked");

  // and their trust level does not turn the maintainer's signature away
  const signed = await world.push({ "app/index.html": page("v0.2.3") }, "Release");
  const good = await world.update();
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.equal(await world.head(), signed);
  assert.equal(existsSync(ran), false, "one of their programs was asked");
});

test("a signers file with no key refuses with its plain line, and a git too old to check names the version needed", async () => {
  const world = await makeWorld({ signers: "# no key is listed\n" });
  await world.push({ "app/index.html": page("v0.2.2") }, "Release");
  await assertRefused(world, NO_KEY);

  const old = await makeWorld();
  const kept = await old.head();
  await old.push({ "app/index.html": page("v0.2.2") }, "Release");
  const r = await drive(old, `
real = cli.run_git
def run_git(*args, env=None):
    if args == ("version",):
        return cli.subprocess.CompletedProcess(args, 0, "git version 2.30.1 (Apple Git-130)\\n", "")
    return real(*args, env=env)
cli.run_git = run_git
try:
    cli.pull_forward("origin", "main")
    said = None
except SystemExit as stop:
    said = stop.code
print(json.dumps({"said": said}))`);
  assert.equal(firstRefusal(r.said), "⚠ git 2.30.1 cannot check signed updates: Facilitator needs git 2.34 or newer.");
  assert.match(r.said, /Nothing was changed\./);
  assert.equal(await old.head(), kept);
});

test("an update the board started is checked the same way, and its refusal is the line the board shows", async () => {
  const world = await makeWorld();
  await world.push({ "app/index.html": page("v0.2.2") }, "Unsigned", { key: null });
  const refused = await assertRefused(world, UNSIGNED, { FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.deepEqual(refused.stdout.split("\n").filter(line => line.startsWith("@stage ")), ["@stage downloading"]);

  const signed = await world.push({ "app/index.html": page("v0.2.3") }, "Release");
  const result = await world.update({ FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(await world.head(), signed);
  assert.deepEqual(result.stdout.split("\n").filter(line => line.startsWith("@stage ")),
    ["@stage downloading", "@stage setting-up"]);
});

test("an update from a version before the check installs this version unchecked, and every update after it is checked", async t => {
  const shown = await run("git", ["-C", ROOT, "show", `${PRE_CHECK}:app/facilitator`], { cwd: ROOT, env: process.env });
  if (shown.code !== 0) {
    t.skip("the version before the check is not in this clone's history");
    return;
  }
  assert.doesNotMatch(shown.stdout, /verify-commit/, "that version already checks");
  const world = await makeWorld({ cli: shown.stdout, signers: null });
  // the version carrying the check, unsigned here: the old code does not look
  const release = await world.push({
    "app/facilitator": await readFile(path.join(ROOT, "facilitator"), "utf8"),
    "app/update-signers": `${world.key.line}\n`,
    "app/index.html": page("v0.2.2"),
  }, "Signed updates", { key: null });
  const first = await world.update({ FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(await world.head(), release);
  assert.match(first.stdout, /Old version: v0\.2\.1\nNew version: v0\.2\.2\n/);

  await world.push({ "app/index.html": page("v0.2.3") }, "Unsigned", { key: null });
  const second = await world.update({ FACILITATOR_UPDATE_FROM_BOARD: "1" });
  assert.notEqual(second.code, 0);
  assert.equal(firstRefusal(second.stderr), UNSIGNED);
  assert.equal(await world.head(), release);

  const signed = await world.push({ "app/index.html": page("v0.2.4") }, "Release");
  const third = await world.update();
  assert.equal(third.code, 0, third.stdout + third.stderr);
  assert.equal(await world.head(), signed);
  assert.match(third.stdout, /New version: v0\.2\.4\n/);
});
