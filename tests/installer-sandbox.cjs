// A throwaway home and a throwaway copy of the checkout for running ./install.sh,
// with fake claude, codex, mdfind, open, uv and brew on PATH. PATH holds the
// fakes, then /usr/bin and /bin only, so no real Chrome lookup, uv, brew, node or
// download can be reached. Every fake that is called writes a line to calls.log.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const COPIED = ["facilitator", "shell_integration.py", "install.sh", "bridge_auth.py", "requirements.txt",
  "run.config.example.json", "seed.example.json", "claude-statusline.py"];

// answers questions on a pseudo terminal: each step is [text to wait for, keys to send]
const DRIVER = `import json, os, pty, re, select, signal, sys, time
job = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(job["cwd"])
    os.execvpe(job["argv"][0], job["argv"], job["env"])
seen, consumed, pending = b"", 0, list(job["steps"])
deadline = time.time() + 90
while True:
    if time.time() > deadline:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        print(json.dumps({"code": -9, "text": seen.decode("utf-8", "replace"), "unsent": pending}))
        sys.exit(0)
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
    if pending and pending[0][0].encode() in seen[consumed:]:
        consumed = len(seen)
        time.sleep(0.3)
        os.write(fd, pending.pop(0)[1].encode())
code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
text = seen.decode("utf-8", "replace").replace("\\r\\n", "\\n")
if not job.get("color"):
    text = re.sub(r"\\x1b\\[[0-9;?]*[A-Za-z]", "", text)
print(json.dumps({"code": code, "text": text, "unsent": pending}))
`;

let goodPython;
async function pythonPath() {
  goodPython ||= process.env.FACILITATOR_TEST_PYTHON
    || (await exec("python3", ["-c", "import sys; print(sys.executable)"])).stdout.trim();
  return goodPython;
}

async function script(file, text) {
  await fs.writeFile(file, text);
  await fs.chmod(file, 0o755);
}

// agents: which of claude and codex exist. chrome: "spotlight" (mdfind knows it),
// "launchservices" (only open -Ra does) or "none". python: "system" (a good
// python3), "missing" (python3 fails), "old" (python3 fails the version
// check) or "apple" (python3 is the /usr/bin/python3 macOS ships, which has no
// scrypt).
// uv: "present", "brew" (a fake brew installs it), "curl" (a fake curl hands
// back an installer that puts it in the home folder), "curl-tampered" (the
// same, but what it hands back is not what the checkout expects), "curl-fails"
// (the installer it hands back prints a line and exits with an error) or "absent". The fake's
// venv writes a pyvenv.cfg naming venvPython, and a .venv/bin/python3 that
// hands over to the real python, so what runs on .venv really runs. It says
// it is uvVersion when asked. node: true puts a fake node and a fake npm on
// PATH; npm ci makes tests/node_modules/puppeteer-core at the pinned version.
// hang: "sync" makes the fake uv's package sync run for a minute, so a test can
// press Ctrl+C in the middle of it.
async function sandbox({ agents = ["claude"], chrome = "spotlight", python = "system", uv = "present",
  venvPython = "3.14.0", uvVersion = "0.11.18", node = false, hang = "" } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-installer-")));
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const tools = path.join(dir, "tools");
  const log = path.join(dir, "calls.log");
  for (const folder of [home, repo, tools]) await fs.mkdir(folder);
  await fs.writeFile(log, "");
  for (const file of COPIED) await fs.copyFile(path.join(root, file), path.join(repo, file));
  await fs.chmod(path.join(repo, "install.sh"), 0o755);
  await fs.cp(path.join(root, ".agents"), path.join(repo, ".agents"), { recursive: true });
  await fs.mkdir(path.join(repo, "tests"));
  for (const name of ["package.json", "package-lock.json"]) {
    await fs.copyFile(path.join(root, "tests", name), path.join(repo, "tests", name));
  }

  if (node) {
    await script(path.join(tools, "node"), "#!/bin/sh\nexit 0\n");
    await script(path.join(tools, "npm"), `#!/bin/sh
echo "npm $*" >> "${log}"
echo "npm ran in $PWD" >> "${log}"
if [ "$1" = ci ]; then
  mkdir -p node_modules/puppeteer-core
  pinned="$(sed -n 's/.*"puppeteer-core": *"\\([^"]*\\)".*/\\1/p' package.json)"
  printf '{"name":"puppeteer-core","version":"%s"}' "$pinned" > node_modules/puppeteer-core/package.json
fi
`);
  }

  for (const name of agents) await script(path.join(tools, name), "#!/bin/sh\nexit 0\n");
  await script(path.join(tools, "mdfind"), `#!/bin/sh\necho "mdfind $*" >> "${log}"\n`
    + (chrome === "spotlight" ? 'echo "/Applications/Google Chrome.app"\n' : "exit 0\n"));
  await script(path.join(tools, "open"), `#!/bin/sh\necho "open $*" >> "${log}"\n`
    + (chrome === "launchservices" ? "exit 0\n" : "echo 'Unable to find application' >&2\nexit 1\n"));

  const real = await pythonPath();
  const wrappers = {
    system: `#!/bin/sh\nexec "${real}" "$@"\n`,
    missing: `#!/bin/sh\necho "python3 $*" >> "${log}"\nexit 1\n`,
    old: `#!/bin/sh\ncase "$*" in *version_info*) echo "python3 too old" >> "${log}"; exit 1;; esac\nexec "${real}" "$@"\n`,
    apple: `#!/bin/sh\necho "apple python3 $1" >> "${log}"\nexec /usr/bin/python3 "$@"\n`,
  };
  await script(path.join(tools, "python3"), wrappers[python]);

  const syncStep = hang === "sync" ? 'echo "syncing (fake uv)"; sleep 60' : ":";
  const fakeUv = `#!/bin/sh
echo "uv $*" >> "${log}"
case "$1" in
  --version) echo "uv ${uvVersion} (fake)" ;;
  pip) ${syncStep} ;;
  venv)
    mkdir -p .venv/bin
    printf 'home = /fake\\nversion_info = ${venvPython}\\n' > .venv/pyvenv.cfg
    printf '#!/bin/sh\\nexec "%s" "$@"\\n' "${real}" > .venv/bin/python3
    cp .venv/bin/python3 .venv/bin/python
    chmod +x .venv/bin/python .venv/bin/python3 ;;
  python)
    case "$2" in
      install) echo "Installed Python ${venvPython} (fake uv)" ;;  # stdout keeps a piped run's text in order
      find) echo "${real}" ;;
    esac ;;
esac
`;
  if (uv === "present") await script(path.join(tools, "uv"), fakeUv);
  if (uv === "brew") {
    const target = path.join(home, ".local", "bin", "uv");
    await script(path.join(tools, "brew"), `#!/bin/sh
echo "brew $*" >> "${log}"
mkdir -p "${path.dirname(target)}"
cat > "${target}" <<'FAKE'
${fakeUv}FAKE
chmod +x "${target}"
`);
  }

  if (uv === "curl" || uv === "curl-tampered" || uv === "curl-fails") {
    // the installer the fake curl hands back, and the fingerprint this copy of
    // the checkout is made to expect for it: "curl-tampered" serves something
    // else under that fingerprint, and "curl-fails" serves an installer that
    // prints its lines and then stops with an error. Like the real one it
    // prints progress lines of its own. The installer's own check is probed too.
    const installer = uv === "curl-fails" ? `echo "installing to $HOME/.local/bin"
echo "the fake uv installer could not write uv" >&2
exit 1
` : `echo "uv installer ran with INSTALLER_NO_MODIFY_PATH=$INSTALLER_NO_MODIFY_PATH" >> "${log}"
echo "downloading uv 0.12.22 (fake installer)"
echo "installing to $HOME/.local/bin"
printf x > "$HOME/probe.txt"
echo "uv installer checks with $(sha256sum -b "$HOME/probe.txt" | awk '{printf $1}')" >> "${log}"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/uv" <<'FAKE'
${fakeUv}FAKE
chmod +x "$HOME/.local/bin/uv"
`;
    const served = uv === "curl-tampered" ? `echo "a changed uv installer ran" >> "${log}"\n` : installer;
    await fs.writeFile(path.join(dir, "served-installer.sh"), served);
    await script(path.join(tools, "curl"), `#!/bin/sh
echo "curl $*" >> "${log}"
out=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then out="$2"; shift; fi
  shift
done
if [ -n "$out" ]; then cat "${path.join(dir, "served-installer.sh")}" > "$out"; else cat "${path.join(dir, "served-installer.sh")}"; fi
`);
    const sum = crypto.createHash("sha256").update(installer).digest("hex");
    for (const [file, line, pin] of [
      ["facilitator", /^UV_INSTALL_SHA256 = "[0-9a-f]{64}"$/m, `UV_INSTALL_SHA256 = "${sum}"`],
      ["install.sh", /^UV_INSTALL_SHA256='[0-9a-f]{64}'$/m, `UV_INSTALL_SHA256='${sum}'`],
    ]) {
      const text = await fs.readFile(path.join(repo, file), "utf8");
      if (line.test(text)) await fs.writeFile(path.join(repo, file), text.replace(line, pin));
    }
  }

  const env = { HOME: home, SHELL: "/bin/zsh", TERM: "xterm-256color", LANG: "en_US.UTF-8",
    PATH: `${tools}:/usr/bin:/bin` };
  const calls = async () => (await fs.readFile(log, "utf8")).split("\n").filter(Boolean);
  return {
    dir, home, repo, tools, env, calls,
    clean: () => fs.rm(dir, { recursive: true, force: true }),
    has: file => fs.access(file).then(() => true, () => false),
    // no terminal: stdin and stdout are pipes
    async piped(args = []) {
      const done = await exec("bash", [path.join(repo, "install.sh"), ...args], { cwd: repo, env }).then(
        ({ stdout, stderr }) => ({ code: 0, text: stdout + stderr }),
        error => ({ code: error.code, text: error.stdout + error.stderr }));
      return done;
    },
    // a terminal: steps are [text to wait for, keys to send]; colour codes are
    // stripped from the text unless color is set
    async terminal(steps, args = [], { color = false } = {}) {
      const job = JSON.stringify({ argv: ["bash", path.join(repo, "install.sh"), ...args], cwd: repo, env, steps, color });
      const { stdout } = await exec("python3", ["-c", DRIVER, job], { env: process.env, timeout: 120000, maxBuffer: 1 << 24 });
      return JSON.parse(stdout);
    },
  };
}

module.exports = { sandbox, root };
