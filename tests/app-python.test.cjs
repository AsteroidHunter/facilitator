// The Python the board runs on: .venv stands on one Python, 3.14, that uv
// manages itself, and install and update rebuild a .venv that is missing,
// broken or on any other Python. A board running on the old .venv is stopped
// before the rebuild, and only when it is this folder's own.
//
// Each test drives the CLI's own functions in a throwaway copy of the
// checkout, with uv faked by a stand-in for subprocess.run that makes the
// files uv would make. Every board lookup is stubbed, so nothing here asks a
// real port, installs a Python or touches a real .venv.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const UV = "/fake/uv";
const dirs = [];

after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

// a checkout with only what ensure_env reads, one level down in its own folder
async function checkout() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-app-python-")));
  dirs.push(base);
  const dir = path.join(base, "facilitator");
  await fs.mkdir(dir);
  for (const name of ["facilitator", "requirements.txt"]) await fs.copyFile(path.join(ROOT, name), path.join(dir, name));
  return dir;
}

// a .venv as a past install left it: python3 is "exec" (a real executable
// file), "missing", "dangling" (a link to nothing) or "plain" (not executable)
async function makeVenv(dir, { version = "3.10.16", key = "version_info", python3 = "exec" } = {}) {
  const bin = path.join(dir, ".venv", "bin");
  await fs.mkdir(bin, { recursive: true });
  if (version !== null) await fs.writeFile(path.join(dir, ".venv", "pyvenv.cfg"), `home = /old\n${key} = ${version}\n`);
  const py = path.join(bin, "python3");
  if (python3 === "exec" || python3 === "plain") {
    await fs.writeFile(py, "#!/bin/sh\n");
    await fs.chmod(py, python3 === "exec" ? 0o755 : 0o644);
  } else if (python3 === "dangling") {
    await fs.symlink(path.join(dir, "no-such-python"), py);
  }
  await fs.writeFile(path.join(dir, ".venv", "old-marker"), "the old .venv");
}

const SETUP = String.raw`
import contextlib, importlib.machinery, importlib.util, io, json, os, shutil, sys, types
loader = importlib.machinery.SourceFileLoader("facilitator_cli", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)
UV = "/fake/uv"
CALLS, EVENTS, FAIL, MAKE = [], [], set(), ["3.14.0"]
def fake_run(argv, **kw):
    argv = [str(part) for part in argv]
    CALLS.append(argv)
    EVENTS.append(" ".join(argv[1:3]))
    if argv[0] != UV:
        raise AssertionError("unexpected subprocess: " + " ".join(argv))
    if argv[1] in FAIL:
        return types.SimpleNamespace(returncode=2, stdout="", stderr="uv failed at " + argv[1] + "\n")
    if argv[1] == "venv":
        venv = cli.HERE / ".venv"
        if venv.exists():
            shutil.rmtree(venv)
        (venv / "bin").mkdir(parents=True)
        (venv / "pyvenv.cfg").write_text("home = /managed\nversion_info = " + MAKE[0] + "\n")
        for name in ("python", "python3"):
            (venv / "bin" / name).write_text("#!/bin/sh\n")
            os.chmod(venv / "bin" / name, 0o755)
    return types.SimpleNamespace(returncode=0, stdout="", stderr="")
cli.subprocess.run = fake_run
def never(*args, **kwargs):
    raise AssertionError("asked a real port")
cli.state = never
def finish(call):
    out = io.StringIO()
    code, value = None, None
    try:
        with contextlib.redirect_stdout(out):
            value = call()
    except SystemExit as stop:
        code = stop.code
    venv = cli.HERE / ".venv"
    cfg = venv / "pyvenv.cfg"
    print("RESULT " + json.dumps({"out": out.getvalue(), "exit": code, "value": value, "calls": CALLS,
        "events": EVENTS, "cfg": cfg.read_text() if cfg.exists() else None,
        "old": (venv / "old-marker").exists(), "stopped_flag": cli.env_stopped_board}))
`;

async function drive(dir, body) {
  const code = `${SETUP}\n${body}`;
  const env = { ...process.env, HOME: path.join(dir, "home"), FACILITATOR_LOG_DIR: path.join(dir, "logs") };
  const { stdout } = await exec(PYTHON, ["-c", code, path.join(dir, "facilitator")], { cwd: dir, env, timeout: 30000 })
    .catch(problem => { throw new Error(`python failed:\n${problem.stdout}\n${problem.stderr}`); });
  const line = stdout.trim().split("\n").find(l => l.startsWith("RESULT "));
  assert.ok(line, stdout);
  return JSON.parse(line.slice("RESULT ".length));
}

const VENV_CALL = `${UV} venv --clear --managed-python --python 3.14 .venv`;
const INSTALL_CALL = `${UV} python install --no-bin 3.14`;
const SYNC_CALL = `${UV} pip sync --require-hashes --python .venv/bin/python requirements.txt`;
const lines = res => res.calls.map(c => c.join(" "));

test("the Python .venv is on is read from pyvenv.cfg, and a python3 that cannot run reads as none", async () => {
  const cases = [
    [{ version: "3.14.0" }, "3.14"],
    [{ version: "3.10.16", key: "version" }, "3.10"],
    [{ version: "3.9.6" }, "3.9"],
    [{ version: null }, null],
    [{ version: "3.14.0", python3: "missing" }, null],
    [{ version: "3.14.0", python3: "dangling" }, null],
    [{ version: "3.14.0", python3: "plain" }, null],
  ];
  for (const [venv, want] of cases) {
    const dir = await checkout();
    await makeVenv(dir, venv);
    const res = await drive(dir, "finish(cli.env_python)");
    assert.equal(res.value, want, JSON.stringify(venv));
  }
  const bare = await checkout();
  assert.equal((await drive(bare, "finish(cli.env_python)")).value, null, "no .venv at all");
});

test("a .venv on another Python is rebuilt on 3.14 after uv installs it, and says so even when quiet", async () => {
  for (const [venv, why] of [
    [{ version: "3.10.16" }, "it was on Python 3.10"],
    [{ version: "3.13.5" }, "it was on Python 3.13"],
    [{ version: "3.14.0", python3: "dangling" }, "its Python is missing or broken"],
  ]) {
    const dir = await checkout();
    await makeVenv(dir, venv);
    const res = await drive(dir, `finish(lambda: cli.ensure_env(UV, quiet=True))`);
    assert.equal(res.exit, null, res.out);
    assert.equal(res.value, false, "nothing was running, so nothing was stopped");
    assert.equal(res.out, `Rebuilding .venv on Python 3.14: ${why}.\n`);
    assert.deepEqual(lines(res), [INSTALL_CALL, VENV_CALL, SYNC_CALL]);
    assert.equal(res.cfg, "home = /managed\nversion_info = 3.14.0\n");
    assert.equal(res.old, false, "the old .venv was not cleared");
  }
});

test("a .venv already on 3.14 is kept and only synced, wherever its Python came from", async () => {
  for (const version of ["3.14.0", "3.14.2"]) {
    const dir = await checkout();
    await makeVenv(dir, { version });
    const loud = await drive(dir, "finish(lambda: cli.ensure_env(UV))");
    assert.equal(loud.exit, null, loud.out);
    assert.match(loud.out, /^✓ Environment found in \.venv \(Python 3\.14\)\.\nInstalling the packages Facilitator needs\.\n✓ Packages installed\.\n$/);
    assert.deepEqual(lines(loud), [SYNC_CALL]);
    assert.equal(loud.old, true, "a .venv on 3.14 was rebuilt");
    const quiet = await drive(dir, "finish(lambda: cli.ensure_env(UV, quiet=True))");
    assert.equal(quiet.out, "", "a quiet sync of a good .venv printed something");
  }
});

test("a missing .venv is made quietly on update and named on install", async () => {
  const dir = await checkout();
  const quiet = await drive(dir, "finish(lambda: cli.ensure_env(UV, quiet=True))");
  assert.equal(quiet.out, "");
  assert.deepEqual(lines(quiet), [INSTALL_CALL, VENV_CALL, SYNC_CALL]);
  const other = await checkout();
  const loud = await drive(other, "finish(lambda: cli.ensure_env(UV))");
  assert.match(loud.out, /^Setting up the Python 3\.14 environment\.\n✓ Python 3\.14 environment ready\.\n/);
});

test("a Python install that fails leaves .venv as it was, and a .venv uv makes on another Python is refused", async () => {
  const dir = await checkout();
  await makeVenv(dir, { version: "3.10.16" });
  const failed = await drive(dir, `FAIL.add("python")\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.match(String(failed.exit), /⚠ uv could not install Python 3\.14\.\n  Nothing in \.venv was changed\.\n/);
  assert.deepEqual(lines(failed), [INSTALL_CALL], "uv went on after the failed install");
  assert.equal(failed.old, true);
  assert.equal(failed.cfg, "home = /old\nversion_info = 3.10.16\n");

  const wrong = await checkout();
  const made = await drive(wrong, `MAKE[0] = "3.13.5"\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.match(String(made.exit), /⚠ uv made \.venv on Python 3\.13, not on Python 3\.14\./);
  assert.equal(made.calls.some(c => c[1] === "pip"), false, "packages went into the wrong Python");
});

test("a .venv that is a link is never cleared through it", async () => {
  const dir = await checkout();
  const elsewhere = path.join(path.dirname(dir), "elsewhere");
  await makeVenv(elsewhere, { version: "3.10.16" });
  await fs.symlink(path.join(elsewhere, ".venv"), path.join(dir, ".venv"));
  const res = await drive(dir, "finish(lambda: cli.ensure_env(UV, quiet=True))");
  assert.match(String(res.exit), /⚠ \.venv is a link, and it is not on Python 3\.14\./);
  assert.deepEqual(res.calls, [], "uv was asked anyway");
  assert.equal(await fs.readFile(path.join(elsewhere, ".venv", "old-marker"), "utf8"), "the old .venv");
});

// the board as the stubs describe it: where server.lock points, what answers
// there, and what the safe stop finds and does
function board({ pwd = "HERE", refuse = null, stopRefuse = null, listening = true } = {}) {
  return [
    "cli.lock_port = lambda: 9100",
    `cli.board_state = lambda port: (EVENTS.append("state " + str(port)), {"pwd": ${pwd === "HERE" ? "str(cli.HERE)" : JSON.stringify(pwd)}, "boxes": []})[1]`,
    `cli.server_process = lambda port: (${listening ? "(4242, 'identity')" : "None"}, ${JSON.stringify(refuse)})`,
    `cli.stop_server = lambda owner, port: (EVENTS.append("stop " + str(port)), ${JSON.stringify(stopRefuse)})[1]`,
  ].join("\n").replace(/\bnull\b/g, "None");
}

test("this folder's board on the old .venv is stopped before uv touches .venv, and only then", async () => {
  const dir = await checkout();
  await makeVenv(dir, { version: "3.10.16" });
  const res = await drive(dir, `${board()}\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.equal(res.exit, null, res.out);
  assert.equal(res.value, true);
  assert.equal(res.stopped_flag, true);
  assert.deepEqual(res.events, ["python install", "state 9100", "stop 9100", "venv --clear", "pip sync"]);
  assert.equal(res.out, "Rebuilding .venv on Python 3.14: it was on Python 3.10.\n"
    + "Stopped the board on port 9100, which was running on the old .venv.\n");

  // another checkout's board on that port runs on its own .venv
  const other = await checkout();
  await makeVenv(other, { version: "3.10.16" });
  const theirs = await drive(other, `${board({ pwd: "/some/other/checkout" })}\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.equal(theirs.value, false);
  assert.deepEqual(theirs.events, ["python install", "state 9100", "venv --clear", "pip sync"]);

  // a board answering with nothing listening any more has nothing to stop
  const gone = await checkout();
  await makeVenv(gone, { version: "3.10.16" });
  const none = await drive(gone, `${board({ listening: false })}\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.equal(none.value, false);
  assert.equal(none.events.includes("stop 9100"), false);

  // a .venv already on 3.14 never asks after the board at all
  const good = await checkout();
  await makeVenv(good, { version: "3.14.0" });
  const kept = await drive(good, `${board()}\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
  assert.deepEqual(kept.events, ["pip sync"]);
});

test("a board that cannot be stopped safely stops the run with .venv unchanged", async () => {
  for (const options of [
    { refuse: "pid 4242 is listening on 9100 and it is not server.py; refusing to signal it" },
    { stopRefuse: "the server on 9100 had not let go 8s after SIGTERM and is still the same process; it was left alone and nothing was started" },
  ]) {
    const dir = await checkout();
    await makeVenv(dir, { version: "3.10.16" });
    const res = await drive(dir, `${board(options)}\nfinish(lambda: cli.ensure_env(UV, quiet=True))`);
    const why = options.refuse || options.stopRefuse;
    assert.ok(String(res.exit).includes(`⚠ The board could not be stopped to rebuild .venv: ${why}.\n`
      + "  Nothing in .venv was changed. Stop the board, then run ./install.sh again."), String(res.exit));
    assert.equal(res.events.includes("venv --clear"), false, "uv rebuilt .venv anyway");
    assert.equal(res.old, true);
  }
});

test("with no server.lock and no run.config.json, no port is asked", async () => {
  const dir = await checkout();
  await makeVenv(dir, { version: "3.10.16" });
  // board_state is left as it is, so asking it would reach the stubbed state(), which raises
  const res = await drive(dir, "finish(lambda: cli.ensure_env(UV, quiet=True))");
  assert.equal(res.exit, null, res.out);
  assert.deepEqual(res.events, ["python install", "venv --clear", "pip sync"]);
});

test("an install that fails after stopping the board says the board is down", async () => {
  const dir = await checkout();
  await makeVenv(dir, { version: "3.10.16" });
  const body = [
    board(),
    'FAIL.add("pip")',
    "cli.check_python = lambda: None",
    "cli.ensure_uv = lambda quiet=False: UV",
    "finish(lambda: cli.cmd_install(['install']))",
  ].join("\n");
  const res = await drive(dir, body);
  assert.match(String(res.exit), /⚠ uv could not sync requirements\.txt\./);
  assert.match(String(res.exit), /\n  The board was stopped to rebuild \.venv and is down\. Once this is fixed, start it with: facilitator run$/);
});

test("the server refuses a Python older than 3.11 in one sentence and one log line, before its libraries load", async () => {
  const dir = await checkout();
  await fs.copyFile(path.join(ROOT, "server.py"), path.join(dir, "server.py"));
  const logs = path.join(dir, "logs");
  // the standard library the server imports is loaded first, on the real
  // version; then the version is made 3.10 and the server's own code runs, as
  // a module and not as __main__, so nothing could start even if it went on
  const code = String.raw`
import json, runpy, sys
import asyncio, base64, contextlib, fcntl, gzip, hashlib, logging, logging.handlers, os, re, random
import secrets, shutil, signal, socket, stat, struct, subprocess, tempfile, threading, time, traceback
import urllib.error, urllib.request, urllib.parse, pathlib
sys.version_info = (3, 10, 4, "final", 0)
try:
    runpy.run_path(sys.argv[1], run_name="server_floor_check")
    print("RESULT " + json.dumps({"exit": "it went on", "libraries": "starlette" in sys.modules}))
except SystemExit as stop:
    print("RESULT " + json.dumps({"exit": str(stop.code), "libraries": "starlette" in sys.modules}))
`;
  const { stdout } = await exec(PYTHON, ["-c", code, path.join(dir, "server.py")],
    { cwd: dir, env: { ...process.env, FACILITATOR_LOG_DIR: logs }, timeout: 30000 });
  const res = JSON.parse(stdout.trim().split("\n").find(l => l.startsWith("RESULT ")).slice("RESULT ".length));
  assert.equal(res.exit, "facilitator's server needs Python 3.11 or newer and this is 3.10.4. Start it with "
    + "facilitator run, which uses the Python 3.14 in .venv, or run ./install.sh to rebuild .venv.");
  assert.equal(res.libraries, false, "starlette was imported before the refusal");
  const written = [];
  for (const name of await fs.readdir(logs)) {
    for (const line of (await fs.readFile(path.join(logs, name), "utf8")).split("\n")) if (line) written.push(JSON.parse(line));
  }
  const refused = written.filter(event => event.kind === "startuprefused");
  assert.equal(refused.length, 1, JSON.stringify(written));
  assert.equal(refused[0].reason, "python is older than 3.11");
});

test("the pin is one Python and one uv, named the same in the command and the installer", async () => {
  const cli = await fs.readFile(path.join(ROOT, "facilitator"), "utf8");
  const sh = await fs.readFile(path.join(ROOT, "install.sh"), "utf8");
  assert.match(cli, /^APP_PYTHON = "3\.14"/m);
  assert.match(sh, /^MANAGED_PYTHON='3\.14'/m);
  const [, major, minor, patch] = cli.match(/^UV_MIN = \((\d+), (\d+), (\d+)\)/m);
  assert.match(sh, new RegExp(`^UV_MIN='${major}\\.${minor}\\.${patch}'`, "m"));
  // every environment uv makes is made on the pinned, uv-managed Python
  const made = cli.match(/\[uv, "venv"[^\]]*\]/g);
  assert.ok(made && made.length > 0);
  for (const call of made) assert.equal(call, '[uv, "venv", "--clear", "--managed-python", "--python", APP_PYTHON, ".venv"]');
  // no .python-version: it would change what python3 means here for pyenv users
  await assert.rejects(fs.access(path.join(ROOT, ".python-version")));
});

test("the command itself still runs on the python3 macOS ships", { skip: !require("node:fs").existsSync("/usr/bin/python3") }, async t => {
  const { stdout: said } = await exec("/usr/bin/python3", ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"]);
  if (said.trim() !== "3.9") return t.skip(`/usr/bin/python3 is ${said.trim()}, not 3.9`);
  const dir = await checkout();
  await fs.copyFile(path.join(ROOT, "shell_integration.py"), path.join(dir, "shell_integration.py"));
  const cli = path.join(dir, "facilitator");
  const run = args => exec("/usr/bin/python3", [cli, ...args], { cwd: dir }).then(ok => ({ code: 0, ...ok }), error => error);
  const nonsense = await run(["nonsense"]);
  assert.equal(nonsense.code, 1);
  assert.match(nonsense.stderr, /facilitator update/);
  for (const [args, usage] of [[["update", "--help"], /usage: facilitator update/], [["uninstall", "--help"], /usage: facilitator uninstall/]]) {
    const done = await run(args);
    assert.equal(done.code, 0, `${args.join(" ")}: ${done.stderr}`);
    assert.match(done.stdout, usage);
  }
  const integration = await exec("/usr/bin/python3", [path.join(dir, "shell_integration.py")], { cwd: dir })
    .then(() => null, error => error);
  assert.match(integration.stderr, /usage: shell_integration\.py/);
});
