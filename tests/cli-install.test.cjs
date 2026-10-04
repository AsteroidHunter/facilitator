// What `./install.sh` makes and what `facilitator uninstall` takes back.
//
// install turns a fresh checkout into a running board in one command, and is
// safe to run again; uninstall removes exactly what install made and keeps the
// board's data, always. The heavy steps (uv and npm) are stubbed
// with fakes that create the same files those tools would, so the test checks
// the orchestration and the file set before and after rather than downloading
// anything. state is stubbed too, so nothing here ever touches a real port.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile } = require("node:child_process");
const { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const UV = "/fake/uv";
const NPM = "/fake/npm";
const dirs = [];

// a pristine clone: only the tracked files install needs. The gitignored
// artifacts (.venv, tests/node_modules, run.config.json, seed.json) are absent, the
// same as a real `git clone`. The clone sits one level down in its own temp
// folder, so the sibling facilitator-internal/ it reads is private to the test.
async function freshClone() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-install-")));
  dirs.push(base);
  const dir = path.join(base, "facilitator");
  await mkdir(dir);
  for (const name of ["facilitator", "shell_integration.py", "claude-statusline.py", "run.config.example.json", "seed.example.json", "requirements.txt"]) {
    await copyFile(path.join(ROOT, name), path.join(dir, name));
  }
  await cp(path.join(ROOT, '.agents'), path.join(dir, '.agents'), { recursive: true });
  await mkdir(path.join(dir, "tests"));
  for (const name of ["package.json", "package-lock.json"]) {
    await copyFile(path.join(ROOT, "tests", name), path.join(dir, "tests", name));
  }
  return dir;
}

// the board's data, as if it had once run: uninstall always keeps it
async function fabricateData(dir) {
  await writeFile(path.join(dir, "state.json"), "{}");
  await writeFile(path.join(dir, "transcript.jsonl"), "\n");
  await writeFile(path.join(dir, "vapid-key.pem"), "key");
  await writeFile(path.join(dir, "bridge-auth.json"), "{}");
  await writeFile(path.join(dir, "bridge-auth.lock"), "");
  await mkdir(path.join(dir, "uploads"), { recursive: true });
  await writeFile(path.join(dir, "uploads", "keep.png"), "img");
  // where the server saves attachments now, beside other internal files
  await mkdir(internalUploads(dir), { recursive: true });
  await writeFile(path.join(internalUploads(dir), "card.png"), "img");
  await writeFile(path.join(dir, "..", "facilitator-internal", "notes.txt"), "mine");
  await mkdir(path.join(dir, "logs"), { recursive: true });
  await writeFile(path.join(dir, "logs", "server-20260915.log"), "line");
}

function internalUploads(dir) {
  return path.join(dir, "..", "facilitator-internal", "uploads");
}

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// the CLI is a command with no .py on the end, so it is loaded by name and path
function loadCli(dir) {
  return [
    "import importlib.machinery, importlib.util, io, json, os, subprocess, sys, types, contextlib",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(dir, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

// fakes for uv and npm that create the files those tools create, so the file
// set is real even though nothing is downloaded; state and the tailnet are
// stubbed so nothing touches a port or Tailscale.
// installer: what astral.sh hands back for the uv installer: "good" is the text
// the fingerprint in this checkout is made to match, "tampered" is other text
// and "empty" is a download that came to nothing. sha256sum and shasum: the
// path of that checking command on this machine, or null when it is missing.
// npmFails: npm ci stops partway, after it has made the folder.
function stubs({ uv = true, node = true, brew = false, up = false, uvSays = "uv 0.11.18 (fake)",
  installer = "good", sha256sum = "/fake/sha256sum", shasum = null, npmFails = false } = {}) {
  const served = { good: "INSTALLER", tampered: "b'#!/bin/sh\\necho changed\\n'", empty: "b''" }[installer];
  const tool = path => path ? JSON.stringify(path) : "None";
  return [
    "import hashlib",
    `UV = ${JSON.stringify(UV)}`,
    `NPM = ${JSON.stringify(NPM)}`,
    "BREW = '/fake/brew'",
    `WHICH = {'uv': ${uv ? "UV" : "None"}, 'node': ${node ? "'/fake/node'" : "None"}, 'npm': ${node ? "NPM" : "None"}, 'brew': ${brew ? "BREW" : "None"}, 'curl': '/fake/curl', 'sha256sum': ${tool(sha256sum)}, 'shasum': ${tool(shasum)}}`,
    "cli.shutil.which = lambda name: WHICH.get(name)",
    `UVSTATE = {'uv': ${uv ? "UV" : "None"}}`,
    "cli.find_uv = lambda: UVSTATE['uv']",
    "INSTALLER = b'#!/bin/sh\\ntrue\\n'",
    "cli.UV_INSTALL_SHA256 = hashlib.sha256(INSTALLER).hexdigest()",
    "REAL_RUN = subprocess.run",
    "CALLS = []",
    "SH = {'no_modify': None}",
    "NPMRUN = {}",
    "def fake_run(argv, **kw):",
    "    argv = list(argv)",
    "    CALLS.append(argv)",
    "    here = cli.HERE",
    "    if argv[:2] == [UV, 'venv']:",
    "        (here/'.venv'/'bin').mkdir(parents=True, exist_ok=True)",
    "        (here/'.venv'/'pyvenv.cfg').write_text('home = /fake\\nversion_info = 3.14.0\\n')",
    "        for name in ('python', 'python3'):",
    "            (here/'.venv'/'bin'/name).write_text('#!/bin/sh\\n')",
    "            os.chmod(here/'.venv'/'bin'/name, 0o755)",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[:3] == [UV, 'python', 'install']:",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv == [UV, '--version']:",
    `        return types.SimpleNamespace(returncode=0, stdout=${JSON.stringify(uvSays + "\n")}, stderr='')`,
    "    if argv[:3] == [UV, 'pip', 'sync']:",
    "        return types.SimpleNamespace(returncode=0, stdout='Audited', stderr='')",
    "    if argv[:2] == [NPM, 'ci']:",
    "        NPMRUN['cwd'] = str(kw.get('cwd'))",
    "        package = here/'tests'/'node_modules'/'puppeteer-core'",
    "        package.mkdir(parents=True, exist_ok=True)",
    `        if ${npmFails ? "True" : "False"}:`,
    "            return types.SimpleNamespace(returncode=1, stdout='', stderr='')",
    "        pinned = json.loads((here/'tests'/'package.json').read_text())['dependencies']['puppeteer-core']",
    "        (package/'package.json').write_text(json.dumps({'name': 'puppeteer-core', 'version': pinned}))",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[:2] == [BREW, 'install']:",
    "        UVSTATE['uv'] = UV",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv and argv[0] == 'curl':",
    `        return types.SimpleNamespace(returncode=0, stdout=${served}, stderr=b'')`,
    "    if argv and argv[0] == 'sh':",
    "        UVSTATE['uv'] = UV",
    "        env = kw.get('env') or {}",
    "        SH['no_modify'] = env.get('INSTALLER_NO_MODIFY_PATH')",
    "        SH['input'] = kw.get('input')",
    "        first = (env.get('PATH') or '').split(os.pathsep)[0]",
    "        shim = os.path.join(first, 'sha256sum')",
    "        if first and os.path.isfile(shim):",
    "            probe = os.path.join(here, 'probe.txt')",
    "            open(probe, 'wb').write(b'x')",
    "            SH['shim'] = open(shim).read()",
    "            SH['shim_says'] = REAL_RUN([shim, '-b', probe], capture_output=True, text=True).stdout",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    raise AssertionError('unexpected subprocess: ' + ' '.join(map(str, argv)))",
    "cli.subprocess.run = fake_run",
    up
      ? "cli.state = lambda port, timeout=2: {'boxes': [], 'listening': {}, 'busy': {}, 'listenerGap': {}}"
      : "cli.state = lambda port, timeout=2: None",
    "cli.find_tailscale = lambda: None",
  ].join("\n");
}

// run one command with stdout captured, then report the file set and the calls
function snapshot(callLine) {
  return [
    "buf = io.StringIO()",
    "result_exit = None",
    "try:",
    "    with contextlib.redirect_stdout(buf):",
    `        ${callLine}`,
    "except SystemExit as problem:",
    "    result_exit = problem.code",
    "here = cli.HERE",
    "def ex(p):",
    "    return os.path.exists(str(p))",
    "files = {",
    "  'venv': ex(here/'.venv'/'bin'/'python'),",
    "  'node_modules': ex(here/'tests'/'node_modules'),",
    "  'root_node_modules': ex(here/'node_modules'),",
    "  'package_json': ex(here/'package.json'),",
    "  'package_lock': ex(here/'package-lock.json'),",
    "  'run_config': ex(here/'run.config.json'),",
    "  'seed': ex(here/'seed.json'),",
    "  'state': ex(here/'state.json'),",
    "  'transcript': ex(here/'transcript.jsonl'),",
    "  'uploads': ex(here/'uploads'),",
    "  'internal_uploads': ex(here.parent/'facilitator-internal'/'uploads'),",
    "  'internal_notes': ex(here.parent/'facilitator-internal'/'notes.txt'),",
    "  'logs': ex(cli.LOG_DIR),",
    "  'vapid': ex(here/'vapid-key.pem'),",
    "}",
    "sh = {k: (v.decode() if isinstance(v, bytes) else v) for k, v in SH.items()}",
    "print('RESULT ' + json.dumps({'out': buf.getvalue(), 'exit': result_exit, 'files': files, 'calls': CALLS, 'npm_cwd': NPMRUN.get('cwd'), 'sh_no_modify': SH['no_modify'], 'sh': sh}))",
  ].join("\n");
}

async function run(dir, body, env = {}) {
  let stdout;
  const isolatedEnv = { ...process.env, HOME: path.join(dir, "home"), FACILITATOR_LOG_DIR: path.join(dir, "logs") };
  for (const name of ["ZDOTDIR", "BASH_ENV", "ENV"]) delete isolatedEnv[name];
  try {
    ({ stdout } = await execFileAsync("python3", ["-c", `${loadCli(dir)}\n${body}`], {
      cwd: dir,
      env: { ...isolatedEnv, ...env },
      timeout: 30000,
    }));
  } catch (problem) {
    throw new Error(`python failed:\n${problem.stdout || ""}\n${problem.stderr || ""}`);
  }
  const line = stdout.trim().split("\n").find(l => l.startsWith("RESULT "));
  assert.ok(line, `no RESULT line:\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length));
}

const installed = files => files.venv && files.run_config && files.seed;
const NPM_CI = [NPM, "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
const npmRuns = calls => calls.filter(c => c[0] === NPM);

test("install uses the script while uninstall remains a command", async () => {
  const dir = await freshClone();
  const source = await readFile(path.join(dir, "facilitator"), "utf8");
  assert.doesNotMatch(source, /^ {2}facilitator install$/m);
  assert.match(source, /^ {2}facilitator uninstall \[--keep-attachments \| --remove-attachments\]$/m, "uninstall is not in the usage");
  assert.match(source, /elif cmd == "_install" and os\.environ\.get\("FACILITATOR_INTERNAL_INSTALL"\)/);
  assert.match(source, /elif cmd == "uninstall":\n\s+cmd_uninstall\(args\)/, "uninstall is not dispatched");

  const unknown = await execFileAsync("python3", [path.join(dir, "facilitator"), "nonsense"], { cwd: dir })
    .then(() => null, error => error);
  assert.ok(unknown, "an unknown command was accepted");
  assert.doesNotMatch(unknown.stderr, /facilitator install/);
  assert.match(unknown.stderr, /facilitator uninstall \[--keep-attachments \| --remove-attachments\]/);
  assert.doesNotMatch(source, /wipe/i, "the facilitator command still mentions wipe");
});

test("install creates the environment and the config in one run, and no test packages", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  assert.equal(res.exit, null, res.out);
  assert.ok(installed(res.files), JSON.stringify(res.files));
  assert.equal(npmRuns(res.calls).length, 0, "a normal install ran npm: " + JSON.stringify(npmRuns(res.calls)));
  assert.deepEqual([res.files.node_modules, res.files.root_node_modules, res.files.package_json, res.files.package_lock],
    [false, false, false, false], "a normal install left test packages behind");
  assert.doesNotMatch(res.out, /npm|puppeteer|[Tt]est packages/, res.out);
  assert.equal(res.files.state, false, "install fabricated board data");

  assert.match(res.out, /✓ Python \d+\.\d+\.\d+ runs this setup\./, res.out);
  assert.match(res.out, /✓ uv found\./);
  assert.match(res.out, /Creating the environment in \.venv on Python 3\.14\.\n✓ Environment created\./);
  assert.match(res.out, /Syncing packages to requirements\.txt\.\n✓ Packages synced\./);
  assert.match(res.out, /✓ Wrote run\.config\.json from run\.config\.example\.json\./);
  assert.match(res.out, /✓ Wrote seed\.json from seed\.example\.json\./);
  assert.match(res.out, /✓ Board installed\.\n\nConfig lives beside this command: run\.config\.json \(edit it\)\nand seed\.json\.\n$/);
  assert.doesNotMatch(res.out, /Start it with/, "install.sh ends with the next steps, so the board step does not repeat them");
  assert.doesNotMatch(res.out, /\n\n\n/, "two blank lines in a row");

  const kinds = res.calls.map(c => `${c[0]} ${c[1]}`);
  assert.ok(kinds.includes(`${UV} venv`) && kinds.includes(`${UV} pip`), kinds.join(" | "));
  // the app's Python comes from uv and nowhere else, before the environment
  // that stands on it, which stands before the packages go in
  const lines = res.calls.map(c => c.join(" "));
  const at = line => lines.indexOf(line);
  assert.ok(at(`${UV} python install --no-bin 3.14`) >= 0, lines.join(" | "));
  assert.ok(at(`${UV} python install --no-bin 3.14`) < at(`${UV} venv --clear --managed-python --python 3.14 .venv`), lines.join(" | "));
  assert.ok(at(`${UV} venv --clear --managed-python --python 3.14 .venv`) < at(`${UV} pip sync --require-hashes --python .venv/bin/python requirements.txt`), lines.join(" | "));
});

test("every requirement is one exact version with the fingerprint of each of its files, and the sync demands them", async () => {
  const dir = await freshClone();
  const text = await readFile(path.join(dir, "requirements.txt"), "utf8");
  const entries = text.replace(/\\\n/g, " ").split("\n").filter(line => line.trim() && !line.startsWith("#"));
  assert.ok(entries.length >= 11, `only ${entries.length} requirements`);
  for (const entry of entries) {
    const parts = entry.trim().split(/\s+/);
    assert.match(parts[0], /^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9_.!+-]*$/, `not an exact version: ${entry.slice(0, 60)}`);
    const hashes = parts.slice(1);
    assert.ok(hashes.length >= 1, `${parts[0]} has no fingerprint`);
    for (const hash of hashes) assert.match(hash, /^--hash=sha256:[0-9a-f]{64}$/, `${parts[0]}: ${hash}`);
    assert.equal(new Set(hashes).size, hashes.length, `${parts[0]} lists a fingerprint twice`);
  }
  assert.doesNotMatch(text, /^\s*-(?!-hash=)/m, "an option line (index, link, editable) is in the requirements");
  assert.doesNotMatch(text, /@\s*(git\+|https?:|file:)/, "a requirement comes from an address");

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const sync = res.calls.find(c => c[0] === UV && c[1] === "pip" && c[2] === "sync");
  assert.deepEqual(sync, [UV, "pip", "sync", "--require-hashes", "--python", ".venv/bin/python", "requirements.txt"]);
});

test("uv is found before the Python is checked, so a missing Python can be left to uv", async () => {
  const dir = await freshClone();
  const order = [
    "FIND, CHECK = cli.find_uv, cli.check_python",
    "cli.find_uv = lambda: (CALLS.append(['order', 'uv']), FIND())[1]",
    "cli.check_python = lambda: (CALLS.append(['order', 'python']), CHECK())[1]",
  ].join("\n");
  const res = await run(dir, stubs() + "\n" + order + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  const seen = res.calls.filter(c => c[0] === "order").map(c => c[1]);
  assert.deepEqual(seen.slice(0, 2), ["uv", "python"], seen.join(" "));
});

test("a second install changes nothing and says so", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  assert.equal(again.exit, null, again.out);
  assert.ok(installed(again.files));
  assert.match(again.out, /✓ Environment found in \.venv \(Python 3\.14\)\./);
  assert.match(again.out, /✓ run\.config\.json found\./);
  assert.match(again.out, /✓ seed\.json found\./);

  // the environment is not rebuilt; only the idempotent sync runs again
  assert.equal(again.calls.some(c => c[0] === UV && c[1] === "venv"), false, "the .venv was rebuilt");
  assert.equal(npmRuns(again.calls).length, 0, "npm ran");
  assert.ok(again.calls.some(c => c[0] === UV && c[1] === "pip"), "the sync did not run");
});

test("install --dev adds the test packages from the lockfile, without running any package's scripts", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));

  assert.equal(res.exit, null, res.out);
  assert.ok(installed(res.files) && res.files.node_modules, JSON.stringify(res.files));
  assert.deepEqual(npmRuns(res.calls), [NPM_CI], "npm was run some other way: " + JSON.stringify(npmRuns(res.calls)));
  assert.equal(res.npm_cwd, path.join(dir, "tests"), "npm ci did not run against tests/package.json");
  assert.deepEqual([res.files.root_node_modules, res.files.package_json, res.files.package_lock], [false, false, false],
    "the test packages went into the checkout's root");
  assert.match(res.out, /Syncing packages to requirements\.txt\.\n✓ Packages synced\.\n[^]*Installing the test packages from tests\/package-lock\.json\.\n✓ Test packages installed\.\n✓ Board installed\./, res.out);
  const lines = res.calls.map(c => c.join(" "));
  assert.ok(lines.indexOf(NPM_CI.join(" ")) > lines.findIndex(line => line.startsWith(`${UV} pip sync`)), "the test packages came before the board's own");
});

test("a second install --dev keeps the packages, and moves them when the pinned version moves", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  assert.equal(again.exit, null, again.out);
  assert.match(again.out, /✓ Test packages found\./);
  assert.equal(npmRuns(again.calls).length, 0, "npm ran again for packages that were already there");

  const manifest = path.join(dir, "tests", "package.json");
  const moved = JSON.parse(await readFile(manifest, "utf8"));
  moved.dependencies["puppeteer-core"] = "99.0.0";
  await writeFile(manifest, JSON.stringify(moved));
  const third = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  assert.deepEqual(npmRuns(third.calls), [NPM_CI], "a new pinned version was not installed");
});

test("a normal install after a --dev one keeps the test packages and does not touch them", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(again.exit, null, again.out);
  assert.equal(again.files.node_modules, true, "a normal install removed the test packages");
  assert.equal(npmRuns(again.calls).length, 0);
});

test("install --dev without node or npm stops before anything is built", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ node: false }) + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  assert.equal(String(res.exit).trim(), "⚠ --dev needs node and npm, and they were not found.\n  Install Node.js, then run ./install.sh --dev again.");
  assert.equal(res.calls.length, 0, "something ran before the check: " + JSON.stringify(res.calls));
  assert.deepEqual([res.files.venv, res.files.run_config, res.files.seed, res.files.node_modules], [false, false, false, false]);
});

test("a failed npm ci in a --dev install is said plainly, and uninstall still takes back what it left", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ npmFails: true }) + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  assert.equal(String(res.exit).trim(), "⚠ npm could not install the test packages.\n  See the output above, then run ./install.sh --dev again.");
  assert.ok(res.files.venv && res.files.node_modules, "the board's own install did not stand");
  const gone = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(gone.files.node_modules, false, "the partial packages stayed");
  assert.match(gone.out, /✓ Removed tests\/node_modules\./);
});

test("a tests/node_modules that was there before install --dev is used, and uninstall leaves it alone", async () => {
  const dir = await freshClone();
  const own = path.join(dir, "tests", "node_modules", "puppeteer-core");
  await mkdir(own, { recursive: true });
  const pinned = JSON.parse(await readFile(path.join(dir, "tests", "package.json"), "utf8")).dependencies["puppeteer-core"];
  await writeFile(path.join(own, "package.json"), JSON.stringify({ name: "puppeteer-core", version: pinned }));
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /✓ Test packages found\./);
  assert.equal(npmRuns(res.calls).length, 0);
  const gone = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.match(gone.out, /⊘ Kept tests\/node_modules: it is not recorded as installer-owned\./);
  assert.equal(gone.files.node_modules, true, "uninstall removed packages the install did not make");
});

test("install takes --dev and nothing else", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--nonsense'])"));
  assert.match(String(res.exit), /^install takes only --dev; got --nonsense\nusage: \.\/install\.sh \[--dev\]\n/);
  assert.equal(res.calls.length, 0);
  const help = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--help'])"));
  assert.equal(help.exit, null);
  assert.match(help.out, /^usage: \.\/install\.sh \[--dev\]\n/);
  assert.match(help.out, /--dev also installs the packages only the tests need[^]*tests\/package-lock\.json[^]*npm ci/);
  assert.doesNotMatch(help.out, /when node is present/);
  assert.equal(help.calls.length, 0);
});

test("the test packages are one exact version, locked with a fingerprint on every file, and kept out of git", async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "tests", "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(ROOT, "tests", "package-lock.json"), "utf8"));
  const wanted = Object.entries(manifest.dependencies);
  assert.ok(wanted.length >= 1 && !manifest.devDependencies && !manifest.optionalDependencies && !manifest.scripts, "an unexpected section in tests/package.json");
  for (const [name, version] of wanted) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not one exact version: ${version}`);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies, "the lockfile was made for other packages");
  for (const [place, entry] of Object.entries(lock.packages)) {
    if (!place) continue;
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `${place} has no sha512 fingerprint`);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\/[^?#]+\.tgz$/, `${place} does not come from the npm registry by name`);
    assert.match(entry.version, /^\d+\.\d+\.\d+$/, `${place} is not one exact version`);
    assert.ok(!entry.hasInstallScript, `${place} runs a script when installed`);
  }
  for (const [name, version] of wanted) assert.equal(lock.packages[`node_modules/${name}`].version, version);
  const ignored = await readFile(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignored, /^\/tests\/node_modules\/$/m, "tests/node_modules is not ignored");
  assert.doesNotMatch(ignored, /^(\/?tests\/)?package(-lock)?\.json$/m, "the pinned files are ignored, so they would never be committed");
});

test("a user's own config is left untouched by install", async () => {
  const dir = await freshClone();
  await writeFile(path.join(dir, "run.config.json"), JSON.stringify({ port: 9001, lanes: [], mine: true }));
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.match(res.out, /✓ run\.config\.json found\./);
  const kept = JSON.parse(await readFile(path.join(dir, "run.config.json"), "utf8"));
  assert.equal(kept.mine, true, "install overwrote a config the user had already written");
});

test("uninstall preserves a preexisting config and an edited generated seed", async () => {
  const dir = await freshClone();
  await writeFile(path.join(dir, "run.config.json"), '{"mine":true}');
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await writeFile(path.join(dir, "seed.json"), '{"edited":true}');
  const result = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(await readFile(path.join(dir, "run.config.json"), "utf8"), '{"mine":true}');
  assert.equal(await readFile(path.join(dir, "seed.json"), "utf8"), '{"edited":true}');
  assert.match(result.out, /⊘ Kept run\.config\.json: it is not recorded as installer-owned\./);
  assert.match(result.out, /⊘ Kept seed\.json: it has changed since install\./);
});

test("a normal install needs no node and says nothing about it", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ node: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.node_modules, false);
  assert.equal(res.files.package_json, false);
  assert.ok(res.files.venv && res.files.run_config && res.files.seed);
  assert.doesNotMatch(res.out, /node|npm|test packages/i);
});

test("when uv is missing and Homebrew is here, install uses brew then continues", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, brew: true }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /uv is not installed\. Installing it with Homebrew\.\n✓ uv installed\./);
  assert.ok(res.calls.some(c => c[0] === "/fake/brew" && c[1] === "install"), "brew was not used");
  assert.equal(res.calls.some(c => c[0] === "sh"), false, "the astral installer ran with brew present");
  assert.ok(installed(res.files), "the install did not continue after uv was installed");
});

test("when uv is missing and there is no brew, install uses the astral.sh script without touching a profile", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, brew: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /uv is not installed\. Installing it with the astral\.sh installer\ninto your home\.\n✓ uv installed\./);
  assert.ok(res.calls.some(c => c[0] === "curl"), "the installer was not downloaded");
  assert.ok(res.calls.some(c => c[0] === "sh"), "the installer script was not run");
  assert.equal(res.sh_no_modify, "1", "the installer was allowed to change a shell profile");
  assert.equal(res.calls.some(c => c[0] === "/fake/brew"), false);
  assert.ok(installed(res.files), "the install did not continue after uv was installed");
});

const UV_PIN = "0.12.22";
const UV_PIN_SHA256 = "58488ae8dbd0773134c92c85e901430e33f99d975bd7f929d26aa9ab0c2f9390";

test("the uv installer is one exact version, fetched over https only and run only as downloaded", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  const curl = res.calls.find(c => c[0] === "curl");
  assert.deepEqual(curl, ["curl", "--proto", "=https", "--tlsv1.2", "-LsSf", `https://astral.sh/uv/${UV_PIN}/install.sh`]);
  assert.equal(res.sh.input, "#!/bin/sh\ntrue\n", "what ran is not what was checked");

  const source = await readFile(path.join(dir, "facilitator"), "utf8");
  assert.match(source, new RegExp(`^UV_PIN = "${UV_PIN.replace(/\./g, "\\.")}"$`, "m"));
  assert.match(source, new RegExp(`^UV_INSTALL_SHA256 = "${UV_PIN_SHA256}"$`, "m"));
  assert.doesNotMatch(source, /astral\.sh\/uv\/install\.sh/, "the unpinned address is still there");
});

test("a uv installer that does not match its fingerprint is refused and never run", async () => {
  for (const installer of ["tampered", "empty"]) {
    const dir = await freshClone();
    const res = await run(dir, stubs({ uv: false, installer }) + "\n" + snapshot("cli.cmd_install(['install'])"));
    assert.ok(typeof res.exit === "string", `${installer}: the install went on`);
    assert.equal(res.calls.some(c => c[0] === "sh"), false, `${installer}: the downloaded script ran`);
    assert.doesNotMatch(res.out, /✓ uv installed\./);
    assert.equal(res.files.venv, false, `${installer}: the environment was made`);
  }
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, installer: "tampered" }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit.trim(), "⚠ The uv installer from astral.sh is not the one this checkout expects.\n  Nothing was run. Install uv yourself, then run ./install.sh again.");
});

test("uv's installer checks its own downloads on a Mac, which has shasum and no sha256sum", {
  skip: !require("node:fs").existsSync("/usr/bin/shasum") && "no shasum here",
}, async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, sha256sum: null, shasum: "/usr/bin/shasum" }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.sh.shim, /shasum/, "no sha256sum was provided to the installer");
  // the same line a sha256sum prints for the file holding one letter
  assert.equal(res.sh.shim_says.split(" ")[0], require("node:crypto").createHash("sha256").update("x").digest("hex"));
  assert.match(res.sh.shim_says, / \*.*probe\.txt\n$/, "the shim did not answer in sha256sum's format");
});

test("where sha256sum already exists the installer is given no stand-in, and with no way to check at all it is not run", async () => {
  const dir = await freshClone();
  const have = await run(dir, stubs({ uv: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(have.exit, null, have.out);
  assert.equal(have.sh.shim, undefined, "a stand-in hid the real sha256sum");

  const none = await run(dir, stubs({ uv: false, sha256sum: null, shasum: null }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(none.exit.trim(), "⚠ Cannot check what the uv installer downloads: neither sha256sum nor shasum is here.\n  Nothing was run. Install uv yourself, then run ./install.sh again.");
  assert.equal(none.calls.some(c => c[0] === "sh"), false);
});

test("a uv older than 0.9.0, or one that cannot say its version, stops install in one line before anything is made", async () => {
  const TAIL = " is too old to install Python 3.14: upgrade it to 0.9.0 or newer (brew upgrade uv, or uv self update), then run ./install.sh again.";
  for (const [label, options, who] of [
    ["found", { uvSays: "uv 0.8.19 (Homebrew 2025-09-19)" }, "uv 0.8.19"],
    ["just installed", { uv: false, brew: true, uvSays: "uv 0.8.19" }, "uv 0.8.19"],
    ["unreadable", { uvSays: "something else" }, `The uv at ${UV}, whose version could not be read,`],
  ]) {
    const dir = await freshClone();
    const res = await run(dir, stubs(options) + "\n" + snapshot("cli.cmd_install(['install'])"));
    assert.ok(typeof res.exit === "string" && res.exit.trim() === `⚠ ${who}${TAIL}`, `${label}: ${JSON.stringify(res.exit)}`);
    assert.doesNotMatch(res.out, /✓ uv (found|installed)\./, label);
    assert.equal(res.files.venv, false, label);
    assert.equal(res.files.run_config, false, label);
    assert.equal(res.calls.some(c => c[0] === UV && c[1] !== "--version"), false, `${label}: uv was used anyway`);
  }
  // 0.9.0 itself is enough, and 0.10 is newer than 0.9
  for (const uvSays of ["uv 0.9.0", "uv 0.10.2 (Homebrew)"]) {
    const dir = await freshClone();
    const res = await run(dir, stubs({ uvSays }) + "\n" + snapshot("cli.cmd_install(['install'])"));
    assert.equal(res.exit, null, `${uvSays}: ${res.out}`);
  }
});

test("find_uv prefers a uv on PATH", async () => {
  const dir = await freshClone();
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "uv"), "#!/bin/sh\n");
  await import("node:fs/promises").then(fs => fs.chmod(path.join(bin, "uv"), 0o755));
  const { stdout } = await execFileAsync("python3", ["-c", `${loadCli(dir)}\nprint(cli.find_uv())`],
    { cwd: dir, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  assert.equal(stdout.trim(), path.join(bin, "uv"));
});

test("uninstall removes the environment, test packages and config, and keeps the board's data", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install', '--dev'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  // gone: exactly what install made
  assert.equal(res.files.venv, false);
  assert.equal(res.files.node_modules, false);
  assert.equal(res.files.run_config, false);
  assert.equal(res.files.seed, false);
  // kept: the board's data, and the files that ship in the checkout
  assert.ok(res.files.state && res.files.transcript && res.files.uploads && res.files.internal_uploads
    && res.files.logs && res.files.vapid, JSON.stringify(res.files));
  for (const name of ["package.json", "package-lock.json"]) {
    await readFile(path.join(dir, "tests", name), "utf8");
  }

  assert.match(res.out, /✓ Removed \.venv\./);
  assert.match(res.out, /✓ Removed tests\/node_modules\./);
  assert.match(res.out, /✓ Removed run\.config\.json\./);
  assert.doesNotMatch(res.out, /Kept (state|transcript|logs|vapid|bridge-auth)|Kept card attachments in|not present|are kept/);
  assert.doesNotMatch(res.out, /package(-lock)?\.json/, "uninstall mentioned the pinned files that ship in the checkout");
});

test("uninstall still takes back test packages that an older install put in the checkout's root", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const manifest = '{"dependencies":{"puppeteer-core":"^25.5.0"}}';
  const lock = '{"lockfileVersion":3}';
  await mkdir(path.join(dir, "node_modules", "puppeteer-core"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), manifest);
  await writeFile(path.join(dir, "package-lock.json"), lock);
  const sum = text => require("node:crypto").createHash("sha256").update(text).digest("hex");
  const recordPath = path.join(dir, ".facilitator-install.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  Object.assign(record, { node_modules: "directory", "package.json": sum(manifest), "package-lock.json": sum(lock) });
  await writeFile(recordPath, JSON.stringify(record));

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.deepEqual([res.files.root_node_modules, res.files.package_json, res.files.package_lock, res.files.venv], [false, false, false, false]);
  assert.match(res.out, /✓ Removed node_modules\.\n✓ Removed package\.json\.\n✓ Removed package-lock\.json\./);
});

test("uninstall keeps only the attachments section, then check-mark lines and the finish", async () => {
  const dir = await freshClone();
  const home = path.join(dir, "home");
  await mkdir(home);
  const env = { SHELL: "/bin/zsh" };
  const setup = ["import shell_integration", "shell_integration.install()",
    stubs(), snapshot("cli.cmd_install(['install'])")].join("\n");
  assert.equal((await run(dir, setup, env)).exit, null);
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"), env);
  assert.equal(res.exit, null, res.out);
  const lines = res.out.split("\n");
  const at = lines.indexOf("Card attachments");
  assert.ok(at > 0, res.out);
  assert.equal(lines[at - 1], "", "no blank line before the section title");
  assert.equal(lines[at + 1], "─".repeat("Card attachments".length), "the rule under the title");
  assert.equal(lines[at + 2], "", "no blank line after the rule");
  assert.deepEqual(lines.filter(line => /^─+$/.test(line)).length, 1, "more than one section");
  assert.doesNotMatch(res.out, /\d\. |Command and skill|Board files|Board data/);
  assert.doesNotMatch(res.out, /\n\n\n/, "two blank lines in a row");
  const tail = res.out.slice(res.out.indexOf("Pass --remove-attachments to remove them.\n"));
  assert.equal(tail, [
    "Pass --remove-attachments to remove them.",
    "",
    "✓ facilitator command and agent skill removed",
    "✓ Removed .venv.",
    "✓ Removed run.config.json.",
    "✓ Removed seed.json.",
    "",
    "✦ Uninstall finished.",
    "",
    "This folder was left in place.",
    "",
  ].join("\n"));
});

test("uninstall keeps attachments with no terminal to ask on", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.ok(res.files.uploads && res.files.internal_uploads, "attachments went without a clear no");
  assert.doesNotMatch(res.out, /Keep your card attachments/, "a noninteractive run was asked");
  assert.match(res.out, /⊘ Keeping your card attachments: there is no terminal to ask on\.\nPass --remove-attachments to remove them\./);
});

test("uninstall --wipe is refused like any unknown option and deletes no board data", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + answering("n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--wipe'])"));
  assert.match(String(res.exit), /^\n⚠ Unknown option: --wipe\.\n  uninstall takes --keep-attachments or --remove-attachments\./);
  assert.doesNotMatch(res.out, /Keep your card attachments|uninstaller/, "a refused run asked or showed the banner");
  assert.ok(installed(res.files) && res.files.uploads && res.files.internal_uploads, JSON.stringify(res.files));
  assert.ok(res.files.state && res.files.transcript && res.files.logs && res.files.vapid, JSON.stringify(res.files));
  assert.equal(await readFile(path.join(dir, "bridge-auth.json"), "utf8"), "{}");
  assert.equal(await readFile(path.join(dir, "bridge-auth.lock"), "utf8"), "");

  const real = await execFileAsync("python3", [path.join(dir, "facilitator"), "uninstall", "--wipe"], { cwd: dir })
    .then(() => null, error => error);
  assert.ok(real, "uninstall accepted --wipe");
  assert.equal(real.code, 1);
  assert.match(real.stderr, /⚠ Unknown option: --wipe\./);
  assert.match(real.stderr, /usage: facilitator uninstall \[--keep-attachments \| --remove-attachments\]/);
});

test("uninstall --remove-attachments removes both attachment folders and nothing above them", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--remove-attachments'])"));
  assert.equal(res.exit, null, res.out);
  for (const key of ["venv", "uploads", "internal_uploads"]) {
    assert.equal(res.files[key], false, `${key} survived --remove-attachments`);
  }
  assert.ok(res.files.state && res.files.transcript && res.files.logs && res.files.vapid, "board data went with the attachments");
  assert.equal(res.files.internal_notes, true, "the internal folder's other files went too");
  assert.doesNotMatch(res.out, /Keep your card attachments/, "the flag did not answer the question");
  assert.match(res.out, /✓ Removed card attachments folder .*facilitator-internal\/uploads\./);
  assert.match(res.out, /✓ Removed card attachments folder .*facilitator\/uploads\./);
});

// a terminal on stdin that answers the attachments question with the given text
function answering(text) {
  return [
    "class Tty(io.StringIO):",
    "    def isatty(self):",
    "        return True",
    `cli.sys.stdin = Tty(${JSON.stringify(text)})`,
  ].join("\n");
}

test("the attachments question comes right after the banner, before anything is removed", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + answering("\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  const title = res.out.indexOf("uninstaller");
  const question = res.out.indexOf("Keep your card attachments (pictures and files you attached to cards)? [Y/n] ");
  const removed = res.out.indexOf("✓ Removed ");
  assert.ok(title >= 0 && res.out.slice(0, title).includes("█████"), res.out);
  assert.ok(title < question && question < removed, res.out);
  assert.doesNotMatch(res.out.slice(title, question), /✓ Removed|⊘ Kept/, "something was done before the question");
});

for (const [said, name] of [["\n", "Enter"], ["maybe\n", "an unclear answer"], ["", "end of input"]]) {
  test(`${name} at the attachments question keeps them`, async () => {
    const dir = await freshClone();
    await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
    await fabricateData(dir);

    const res = await run(dir, stubs() + "\n" + answering(said) + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
    assert.equal(res.exit, null, res.out);
    assert.match(res.out, /Keep your card attachments/);
    assert.ok(res.files.uploads && res.files.internal_uploads, `${name} removed attachments`);
    assert.equal(await readFile(path.join(internalUploads(dir), "card.png"), "utf8"), "img");
    assert.equal(res.files.state, true, "uninstall removed the board's data");
  });
}

for (const said of ["n\n", " No \n"]) {
  test(`a clear no (${JSON.stringify(said)}) removes exactly the attachment folders`, async () => {
    const dir = await freshClone();
    await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
    await fabricateData(dir);

    const res = await run(dir, stubs() + "\n" + answering(said) + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
    assert.equal(res.exit, null, res.out);
    assert.equal(res.files.internal_uploads, false, "the server's attachments folder survived a no");
    assert.equal(res.files.uploads, false, "the old in-repo attachments folder survived a no");
    // the folder above and the rest of the board's data stay
    assert.equal(res.files.internal_notes, true, "the internal folder's other files went");
    assert.ok(res.files.state && res.files.transcript && res.files.logs && res.files.vapid, JSON.stringify(res.files));
    assert.match(res.out, /✓ Removed card attachments folder .*facilitator-internal\/uploads\./);
    assert.doesNotMatch(res.out, /Kept state\.json/);
  });
}

test("a clear no never follows a link out of the attachments folder", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  const outside = path.join(dir, "..", "elsewhere");
  await mkdir(path.join(outside, "pictures"), { recursive: true });
  await writeFile(path.join(outside, "pictures", "precious.png"), "img");
  await writeFile(path.join(outside, "file.png"), "img");
  // a linked folder and a linked file inside the server's folder, and the old
  // in-repo folder itself replaced by a link
  await symlink(path.join(outside, "pictures"), path.join(internalUploads(dir), "linked"));
  await symlink(path.join(outside, "file.png"), path.join(internalUploads(dir), "linked.png"));
  await rm(path.join(dir, "uploads"), { recursive: true });
  await symlink(path.join(outside, "pictures"), path.join(dir, "uploads"));

  const res = await run(dir, stubs() + "\n" + answering("no\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.internal_uploads, false, "the attachments folder with links inside was not removed");
  assert.equal(await readFile(path.join(outside, "pictures", "precious.png"), "utf8"), "img");
  assert.equal(await readFile(path.join(outside, "file.png"), "utf8"), "img");
  assert.ok((await lstat(path.join(dir, "uploads"))).isSymbolicLink(), "the linked old folder was removed");
  assert.match(res.out, /⊘ Kept card attachments link .*facilitator\/uploads\.\nA link is not followed\. Remove it by hand\./);
  assert.equal(res.files.internal_notes, true, "the internal folder's other files went");
});

test("no attachment folders means no question", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const res = await run(dir, stubs() + "\n" + answering("n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.doesNotMatch(res.out, /Keep your card attachments/);
  assert.match(res.out, /No card attachments found\./);
});

// another copy of the board beside this one: it reads the same internal folder
async function addCopy(dir, name = "facilitator-second") {
  const copy = path.join(dir, "..", name);
  await mkdir(copy, { recursive: true });
  await writeFile(path.join(copy, "server.py"), "");
  await writeFile(path.join(copy, "facilitator"), "");
  return copy;
}

const SHARED_QUESTION = "Remove it for them as well? [y/N] ";

test("a no with another copy beside this one asks again, and Enter keeps the shared folder", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await addCopy(dir);

  const res = await run(dir, stubs() + "\n" + answering("n\n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.internal_uploads, true, "the folder another copy uses was removed on one answer");
  assert.equal(await readFile(path.join(internalUploads(dir), "card.png"), "utf8"), "img");
  assert.equal(res.files.uploads, false, "this copy's own attachments folder stayed");
  assert.match(res.out, /Another copy of the board uses .*facilitator-internal\/uploads: facilitator-second\./);
  assert.ok(res.out.includes(SHARED_QUESTION), res.out);
  assert.match(res.out, /⊘ Keeping .*facilitator-internal\/uploads for the other copies\./);
  assert.doesNotMatch(res.out, /Removed card attachments folder .*facilitator-internal/);
  assert.match(res.out, /✓ Removed card attachments folder .*facilitator\/uploads\./);
});

test("the second question comes before anything is removed, and names every other copy", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await addCopy(dir, "facilitator-worktree-a");
  await addCopy(dir, "facilitator-worktree-b");

  const res = await run(dir, stubs() + "\n" + answering("n\n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  const first = res.out.indexOf("Keep your card attachments");
  const second = res.out.indexOf(SHARED_QUESTION);
  const removed = res.out.indexOf("✓ Removed ");
  assert.ok(first >= 0 && first < second && second < removed, res.out);
  assert.match(res.out, /: facilitator-worktree-a, facilitator-worktree-b\./);
});

test("a yes at the second question removes the shared folder and nothing above it", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  const copy = await addCopy(dir);

  const res = await run(dir, stubs() + "\n" + answering("n\ny\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.internal_uploads, false, "a yes did not remove the shared folder");
  assert.equal(res.files.uploads, false);
  assert.equal(res.files.internal_notes, true, "the internal folder's other files went");
  assert.equal(await readFile(path.join(copy, "server.py"), "utf8"), "", "the other copy was touched");
  assert.match(res.out, /✓ Removed card attachments folder .*facilitator-internal\/uploads\./);
});

test("a keep at the first question does not ask about the shared folder", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await addCopy(dir);

  const res = await run(dir, stubs() + "\n" + answering("\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.ok(!res.out.includes(SHARED_QUESTION), "kept attachments were asked about again");
  assert.ok(res.files.uploads && res.files.internal_uploads);
});

test("--remove-attachments with no terminal still keeps the folder another copy uses", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await addCopy(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--remove-attachments'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.internal_uploads, true, "the shared folder went with nobody to ask");
  assert.equal(res.files.uploads, false, "this copy's own folder stayed");
  assert.match(res.out, /⊘ Keeping .*facilitator-internal\/uploads for the other copies: there is no terminal to ask on\./);
});

test("--remove-attachments on a terminal still asks before removing the shared folder", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await addCopy(dir);

  const no = await run(dir, stubs() + "\n" + answering("\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--remove-attachments'])"));
  assert.equal(no.exit, null, no.out);
  assert.ok(no.out.includes(SHARED_QUESTION), no.out);
  assert.doesNotMatch(no.out, /Keep your card attachments/, "the flag did not answer the first question");
  assert.equal(no.files.internal_uploads, true);

  const yes = await run(dir, stubs() + "\n" + answering("yes\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--remove-attachments'])"));
  assert.equal(yes.exit, null, yes.out);
  assert.equal(yes.files.internal_uploads, false);
});

test("an unclear answer or end of input at the second question keeps the shared folder", async () => {
  for (const said of ["n\nmaybe\n", "n\n"]) {
    const dir = await freshClone();
    await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
    await fabricateData(dir);
    await addCopy(dir);

    const res = await run(dir, stubs() + "\n" + answering(said) + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
    assert.equal(res.exit, null, res.out);
    assert.equal(res.files.internal_uploads, true, `${JSON.stringify(said)} removed the shared folder`);
  }
});

test("folders beside this one that are not copies of the board do not count", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);
  await mkdir(path.join(dir, "..", "facilitator-wiki"));
  await writeFile(path.join(dir, "..", "facilitator-wiki", "page.md"), "x");
  await mkdir(path.join(dir, "..", "facilitator-halfway"));
  await writeFile(path.join(dir, "..", "facilitator-halfway", "server.py"), "");
  await writeFile(path.join(dir, "..", "stray-file"), "x");

  const res = await run(dir, stubs() + "\n" + answering("n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.ok(!res.out.includes(SHARED_QUESTION), "a folder that is no copy was treated as one");
  assert.equal(res.files.internal_uploads, false);
});

test("--keep-attachments keeps them without asking, and both flags together are refused", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const both = await run(dir, stubs() + "\n" + answering("n\n") + "\n"
    + snapshot("cli.cmd_uninstall(['uninstall', '--keep-attachments', '--remove-attachments'])"));
  assert.match(String(both.exit), /^\n⚠ Both --keep-attachments and --remove-attachments were given\.\n  Give one of them, not both\.$/);
  assert.ok(installed(both.files) && both.files.internal_uploads, "a refused run removed something");

  const res = await run(dir, stubs() + "\n" + answering("n\n") + "\n"
    + snapshot("cli.cmd_uninstall(['uninstall', '--keep-attachments'])"));
  assert.equal(res.exit, null, res.out);
  assert.doesNotMatch(res.out, /Keep your card attachments/, "the flag did not answer the question");
  assert.ok(res.files.uploads && res.files.internal_uploads, "--keep-attachments removed attachments");
  assert.equal(res.files.state, true, "uninstall removed the board's data");
});

test("uninstall has no dry run: --dry-run is refused before anything is asked or removed", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + answering("n\n") + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--dry-run'])"));
  assert.match(String(res.exit), /^\n⚠ Unknown option: --dry-run\.\n  uninstall takes --keep-attachments or --remove-attachments\./);
  assert.doesNotMatch(res.out, /Keep your card attachments|uninstaller/, "a refused run asked or showed the banner");
  assert.ok(installed(res.files) && res.files.uploads && res.files.internal_uploads, JSON.stringify(res.files));
});

test("uninstall removes owned skill links but keeps another personal skill", async () => {
  const dir = await freshClone();
  const home = path.join(dir, 'home');
  await mkdir(home);
  const env = { SHELL: '/bin/zsh' };
  const setup = [
    'import shell_integration',
    'shell_integration.install()',
    stubs(),
    snapshot("cli.cmd_install(['install'])"),
  ].join('\n');
  const installed = await run(dir, setup, env);
  assert.equal(installed.exit, null, installed.out);
  const other = path.join(home, '.agents/skills/other');
  await mkdir(other);
  await writeFile(path.join(other, 'SKILL.md'), 'mine');
  await fabricateData(dir);
  const removed = await run(dir, stubs() + '\n' + snapshot("cli.cmd_uninstall(['uninstall'])"), env);
  assert.equal(removed.exit, null, removed.out);
  for (const host of ['.claude', '.agents'])
    await assert.rejects(lstat(path.join(home, host, 'skills/facilitator')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(other, 'SKILL.md'), 'utf8'), 'mine');
  assert.equal(await readFile(path.join(dir, '.agents/skills/facilitator/SKILL.md'), 'utf8').then(Boolean), true);
});

test("uninstall takes back a Claude limits entry an older install added to the Claude Code settings", async () => {
  const dir = await freshClone();
  const home = path.join(dir, "home");
  await mkdir(home);
  const env = { SHELL: "/bin/zsh" };
  const setup = ["import shell_integration", "shell_integration.install()",
    stubs(), snapshot("cli.cmd_install(['install'])")].join("\n");
  const first = await run(dir, setup, env);
  assert.equal(first.exit, null, first.out);
  const settings = path.join(home, ".claude", "settings.json");
  await assert.rejects(lstat(settings), { code: "ENOENT" }, "install must not add the entry any more");

  const older = require("./fixtures/older-statusline-installs.json")["made from nothing"];
  const fill = text => text.split("@SCRIPT@").join(path.join(dir, "claude-statusline.py")).split("@SETTINGS@").join(settings);
  await writeFile(settings, fill(older.after));
  await writeFile(path.join(dir, ".facilitator-statusline.json"), fill(older.record));
  const removed = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"), env);
  assert.equal(removed.exit, null, removed.out);
  assert.match(removed.out, /✓ facilitator command and agent skill removed/);
  assert.doesNotMatch(removed.out, /settings\.json|Claude limits entry/);
  await assert.rejects(lstat(settings), { code: "ENOENT" });
});

test("a second uninstall is harmless and prints no removal lines", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(again.exit, null, again.out);
  assert.doesNotMatch(again.out, /not present|✓ /);
  assert.match(again.out, /✦ Uninstall finished\./);
});

test("uninstall refuses while the board answers on the port, and removes nothing", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  const res = await run(dir, stubs({ up: true }) + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(typeof res.exit, "string", "a running board did not stop the uninstall");
  assert.match(res.exit, /^\n⚠ The board is up on port \d+\.\n  Stop that server first, then run uninstall again\.$/, res.exit);
  assert.doesNotMatch(res.out, /Keep your card attachments/, "a refused uninstall asked about attachments");
  // nothing was removed
  assert.ok(installed(res.files), "files were removed while the board was up");
});

test("uninstall prints the bridge-off command when a bridge is active", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const active = [
    "cli.find_tailscale = lambda: '/fake/ts'",
    "cli.tailscale_status = lambda ts: {}",
    "cli.tailnet_name = lambda status: 'host'",
    "cli.analyze_bridge = lambda ts, name, port: ({}, {'active': True, 'removable': True, 'on': True, 'enable_blocked': False, 'why': ''})",
  ].join("\n");
  const res = await run(dir, stubs() + "\n" + active + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /A phone bridge is active\. Turn it off with: facilitator bridge off/, res.out);
  // the bridge itself is only read, never changed: no tmux, serve or off call
  assert.equal(res.files.venv, false, "the uninstall did not proceed past the note");
});

test("uninstall refuses unknown options before it touches anything", async () => {
  const dir = await freshClone();
  const refused = await execFileAsync("python3", [path.join(dir, "facilitator"), "uninstall", "--bogus"], { cwd: dir })
    .then(() => null, error => error);
  assert.ok(refused, "uninstall accepted an unknown option");
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /⚠ Unknown option: --bogus\.\n  uninstall takes --keep-attachments or --remove-attachments\./, refused.stderr);
});
