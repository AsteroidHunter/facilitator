// `facilitator password set`, and the installer's password step, run on the
// Python of .venv: the python3 macOS ships has no scrypt, which the app
// password is hashed with. The command hands itself over by running again
// under .venv/bin/python3, once. Everything else, above all the commands that
// repair or remove .venv, stays on the Python it started on.
//
// The hand-over is recorded with os.execve stubbed, in a throwaway copy of
// the checkout; one run on the real /usr/bin/python3 shows it end to end on a
// pseudo terminal. Board lookups are stubbed, so no real port is asked.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PASS = "Handover-pass-2026!";
const dirs = [];

after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

async function checkout() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-password-env-")));
  dirs.push(base);
  const dir = path.join(base, "facilitator");
  await fs.mkdir(dir);
  for (const name of ["facilitator", "bridge_auth.py", "shell_integration.py"]) {
    await fs.copyFile(path.join(ROOT, name), path.join(dir, name));
  }
  await fs.mkdir(path.join(base, "home"));
  return dir;
}

// .venv/bin/python3 as "exec" (an executable file), "plain" (not executable),
// "dangling" (a link to nothing), "garbage" (executable but not a program)
async function venvPython(dir, kind) {
  const bin = path.join(dir, ".venv", "bin");
  await fs.mkdir(bin, { recursive: true });
  const py = path.join(bin, "python3");
  if (kind === "dangling") return fs.symlink(path.join(dir, "no-such-python"), py);
  await fs.writeFile(py, kind === "garbage" ? "\x00\x01 not a program\n" : "#!/bin/sh\n");
  await fs.chmod(py, kind === "plain" ? 0o644 : 0o755);
}

// main() with these words, os.execve recorded instead of run, and
// cmd_password recorded instead of asking for anything
async function dispatch(dir, words, { env = {}, prefix = null } = {}) {
  const code = String.raw`
import contextlib, importlib.machinery, importlib.util, io, json, os, sys
loader = importlib.machinery.SourceFileLoader("facilitator_cli", sys.argv[1])
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)
EXECS, PASSWORDS = [], []
class Exec(Exception):
    pass
def fake_execve(path, argv, env):
    EXECS.append({"path": path, "argv": argv, "marker": env.get("FACILITATOR_APP_ENV"),
                  "install": env.get("FACILITATOR_INTERNAL_INSTALL")})
    raise Exec()
cli.os.execve = fake_execve
cli.cmd_password = lambda args, installer=False: PASSWORDS.append({"args": args, "installer": installer})
cli.state = lambda port, timeout=2: None
cli.find_tailscale = lambda: None
if sys.argv[2] != "-":
    sys.prefix = sys.argv[2]
sys.argv = [str(cli.HERE / "facilitator")] + json.loads(sys.argv[3])
out, err = io.StringIO(), io.StringIO()
code = None
try:
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        cli.main()
except Exec:
    code = "exec"
except SystemExit as stop:
    code = stop.code
print("RESULT " + json.dumps({"code": code, "execs": EXECS, "passwords": PASSWORDS, "out": out.getvalue()}))
`;
  const environment = { ...process.env, HOME: path.join(path.dirname(dir), "home"),
    FACILITATOR_LOG_DIR: path.join(path.dirname(dir), "logs"), ...env };
  for (const name of ["FACILITATOR_APP_ENV", "FACILITATOR_INTERNAL_INSTALL", "CLAUDE_CONFIG_DIR", "ZDOTDIR"]) {
    if (!(name in env)) delete environment[name];
  }
  const { stdout } = await exec(PYTHON, ["-c", code, path.join(dir, "facilitator"), prefix || "-", JSON.stringify(words)],
    { cwd: dir, env: environment, timeout: 30000 })
    .catch(problem => { throw new Error(`python failed:\n${problem.stdout}\n${problem.stderr}`); });
  const line = stdout.trim().split("\n").find(l => l.startsWith("RESULT "));
  assert.ok(line, stdout);
  return JSON.parse(line.slice("RESULT ".length));
}

test("password set and the installer's password step run again on .venv's python, once, with the same words", async () => {
  const dir = await checkout();
  await venvPython(dir, "exec");
  const venv = path.join(dir, ".venv", "bin", "python3");

  const set = await dispatch(dir, ["password", "set"]);
  assert.equal(set.code, "exec");
  assert.deepEqual(set.execs, [{ path: venv, argv: [venv, path.join(dir, "facilitator"), "password", "set"],
    marker: "1", install: null }]);
  assert.deepEqual(set.passwords, [], "the password was asked for on the wrong python");

  const setup = await dispatch(dir, ["_password-setup"], { env: { FACILITATOR_INTERNAL_INSTALL: "1" } });
  assert.equal(setup.code, "exec");
  assert.deepEqual(setup.execs, [{ path: venv, argv: [venv, path.join(dir, "facilitator"), "_password-setup"],
    marker: "1", install: "1" }], "the installer's own variable did not go along");
});

test("on .venv's python, marked or not, the password is asked for there and nothing runs again", async () => {
  const dir = await checkout();
  await venvPython(dir, "exec");
  const marked = await dispatch(dir, ["password", "set"], { env: { FACILITATOR_APP_ENV: "1" } });
  assert.deepEqual(marked.execs, []);
  assert.deepEqual(marked.passwords, [{ args: ["password", "set"], installer: false }]);

  const inside = await dispatch(dir, ["password", "set"], { prefix: path.join(dir, ".venv") });
  assert.deepEqual(inside.execs, []);
  assert.deepEqual(inside.passwords, [{ args: ["password", "set"], installer: false }]);

  const setup = await dispatch(dir, ["_password-setup"], { env: { FACILITATOR_INTERNAL_INSTALL: "1", FACILITATOR_APP_ENV: "1" } });
  assert.deepEqual(setup.passwords, [{ args: ["_password-setup"], installer: true }]);
});

test("with no working .venv, password set says to run ./install.sh and writes nothing", async () => {
  for (const kind of [null, "plain", "dangling", "garbage"]) {
    const dir = await checkout();
    if (kind) await venvPython(dir, kind);
    const res = kind === "garbage"
      ? await dispatchReal(dir)
      : await dispatch(dir, ["password", "set"]);
    assert.ok(String(res.code).includes("⚠ The app's environment in .venv is missing or broken.\n"
      + `  Run ./install.sh in ${dir} to rebuild it, then try again.`), `${kind}: ${JSON.stringify(res)}`);
    assert.deepEqual(res.passwords || [], [], kind);
    await assert.rejects(fs.access(path.join(dir, "bridge-auth.json")), `${kind}: a password file was written`);
  }
});

// the real os.execve, against a .venv/bin/python3 the system refuses to run
async function dispatchReal(dir) {
  const done = await exec(PYTHON, [path.join(dir, "facilitator"), "password", "set"], {
    cwd: dir, env: { ...process.env, FACILITATOR_APP_ENV: "" }, timeout: 30000,
  }).then(() => ({ code: 0 }), error => ({ code: error.stderr.trim() }));
  return done;
}

test("a mistyped password command is answered here, without .venv", async () => {
  const dir = await checkout();
  const res = await dispatch(dir, ["password"]);
  assert.deepEqual(res.execs, []);
  assert.deepEqual(res.passwords, [{ args: ["password"], installer: false }], "the usage check moved");
});

test("update, uninstall, bridge, status and help never move to .venv, and uninstall works with no .venv", async () => {
  const dir = await checkout();
  await venvPython(dir, "exec");
  for (const words of [["update", "--help"], ["uninstall", "--help"], ["bridge", "--help"], ["status"], ["nonsense"]]) {
    const res = await dispatch(dir, words);
    assert.deepEqual(res.execs, [], words.join(" "));
  }
  const bare = await checkout();
  const gone = await dispatch(bare, ["uninstall", "--keep-attachments"]);
  assert.equal(gone.code, null, gone.out);
  assert.deepEqual(gone.execs, []);
  assert.match(gone.out, /Uninstall finished\./);
});

// the python3 macOS ships: 3.9, without the scrypt the app password is hashed with
const APPLE_PYTHON = (() => {
  try {
    return execFileSync("/usr/bin/python3", ["-c",
      "import hashlib, sys; print(sys.version_info[:2] == (3, 9) and not hasattr(hashlib, 'scrypt'))"],
      { encoding: "utf8" }).trim() === "True";
  } catch {
    return false;
  }
})();

// answers prompts on a pseudo terminal: each step is [text to wait for, keys to send]
const DRIVER = String.raw`import json, os, pty, select, signal, sys, time
job = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(job["cwd"])
    os.execvpe(job["argv"][0], job["argv"], job["env"])
seen, pending = b"", list(job["steps"])
deadline = time.time() + 60
while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        break
    ready, _, _ = select.select([fd], [], [], 0.2)
    if not ready:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    seen += data
    if pending and pending[0][0].encode() in seen:
        time.sleep(0.2)
        os.write(fd, pending.pop(0)[1].encode())
        seen = b""
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.waitstatus_to_exitcode(status), "unsent": pending}))
`;

test("on the python3 macOS ships, password set works by running on .venv's python", { skip: !APPLE_PYTHON && "no /usr/bin/python3 3.9 without scrypt here" }, async () => {
  const dir = await checkout();
  // the repository's own .venv, linked in and only run
  await fs.access(path.join(ROOT, ".venv", "bin", "python3"));
  await fs.symlink(path.join(ROOT, ".venv"), path.join(dir, ".venv"));
  const env = { HOME: path.join(path.dirname(dir), "home"), PATH: "/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8" };
  const job = extra => ({ argv: ["/usr/bin/python3", path.join(dir, "facilitator"), "password", "set"], cwd: dir,
    env: { ...env, ...extra },
    steps: [["App password (input hidden): ", PASS + "\n"], ["Confirm app password (input hidden): ", PASS + "\n"]] });
  const typed = async extra => JSON.parse((await exec(PYTHON, ["-c", DRIVER, JSON.stringify(job(extra))], { timeout: 90000 }))
    .stdout.trim().split("\n").at(-1));

  // the control: kept on Apple's python by the marker, the same run fails
  const stayed = await typed({ FACILITATOR_APP_ENV: "1" });
  assert.notEqual(stayed.code, 0, "Apple's python3 set the password itself, so this test proves nothing");
  await assert.rejects(fs.access(path.join(dir, "bridge-auth.json")));

  const done = await typed({});
  assert.equal(done.code, 0, JSON.stringify(done));
  assert.deepEqual(done.unsent, []);
  const auth = JSON.parse(await fs.readFile(path.join(dir, "bridge-auth.json"), "utf8"));
  assert.match(auth.password, /^[0-9a-f]{128}$/, "no scrypt hash was written");
  // and it is the hash of what was typed: checked with the same module
  const { stdout: verdict } = await exec(PYTHON, ["-c",
    `import bridge_auth; print(bridge_auth.login(${JSON.stringify(PASS)})[0])`], { cwd: dir });
  assert.equal(verdict.trim(), "ok");
});
