// What `./install.sh` makes and what `facilitator uninstall` takes back.
//
// install turns a fresh checkout into a running board in one command, and is
// safe to run again; uninstall removes exactly what install made and keeps the
// board's data unless --wipe is given. The heavy steps (uv and npm) are stubbed
// with fakes that create the same files those tools would, so the test checks
// the orchestration and the file set before and after rather than downloading
// anything. state is stubbed too, so nothing here ever touches a real port.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const UV = "/fake/uv";
const NPM = "/fake/npm";
const dirs = [];

// a pristine clone: only the tracked files install needs. The gitignored
// artifacts (.venv, node_modules, run.config.json, seed.json) are absent, the
// same as a real `git clone`.
async function freshClone() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-install-")));
  dirs.push(dir);
  for (const name of ["facilitator", "shell_integration.py", "run.config.example.json", "seed.example.json", "requirements.txt"]) {
    await copyFile(path.join(ROOT, name), path.join(dir, name));
  }
  return dir;
}

// the board's data, as if it had once run: kept without --wipe, gone with it
async function fabricateData(dir) {
  await writeFile(path.join(dir, "state.json"), "{}");
  await writeFile(path.join(dir, "transcript.jsonl"), "\n");
  await writeFile(path.join(dir, "vapid-key.pem"), "key");
  await mkdir(path.join(dir, "uploads"), { recursive: true });
  await writeFile(path.join(dir, "uploads", "keep.png"), "img");
  await mkdir(path.join(dir, "logs"), { recursive: true });
  await writeFile(path.join(dir, "logs", "server-20260915.log"), "line");
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
function stubs({ uv = true, node = true, brew = false, up = false } = {}) {
  return [
    `UV = ${JSON.stringify(UV)}`,
    `NPM = ${JSON.stringify(NPM)}`,
    "BREW = '/fake/brew'",
    `WHICH = {'uv': ${uv ? "UV" : "None"}, 'node': ${node ? "'/fake/node'" : "None"}, 'npm': ${node ? "NPM" : "None"}, 'brew': ${brew ? "BREW" : "None"}, 'curl': '/fake/curl'}`,
    "cli.shutil.which = lambda name: WHICH.get(name)",
    `UVSTATE = {'uv': ${uv ? "UV" : "None"}}`,
    "cli.find_uv = lambda: UVSTATE['uv']",
    "CALLS = []",
    "SH = {'no_modify': None}",
    "def fake_run(argv, **kw):",
    "    argv = list(argv)",
    "    CALLS.append(argv)",
    "    here = cli.HERE",
    "    if argv[:2] == [UV, 'venv']:",
    "        (here/'.venv'/'bin').mkdir(parents=True, exist_ok=True)",
    "        (here/'.venv'/'bin'/'python').write_text('x')",
    "        (here/'.venv'/'bin'/'python3').write_text('x')",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[:3] == [UV, 'pip', 'sync']:",
    "        return types.SimpleNamespace(returncode=0, stdout='Audited', stderr='')",
    "    if argv[:2] == [NPM, 'install']:",
    "        (here/'node_modules'/'puppeteer-core').mkdir(parents=True, exist_ok=True)",
    "        (here/'package.json').write_text('{}')",
    "        (here/'package-lock.json').write_text('{}')",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv[:2] == [BREW, 'install']:",
    "        UVSTATE['uv'] = UV",
    "        return types.SimpleNamespace(returncode=0, stdout='', stderr='')",
    "    if argv and argv[0] == 'curl':",
    "        return types.SimpleNamespace(returncode=0, stdout='#!/bin/sh\\ntrue\\n', stderr='')",
    "    if argv and argv[0] == 'sh':",
    "        UVSTATE['uv'] = UV",
    "        SH['no_modify'] = (kw.get('env') or {}).get('INSTALLER_NO_MODIFY_PATH')",
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
    "  'node_modules': ex(here/'node_modules'/'puppeteer-core'),",
    "  'package_json': ex(here/'package.json'),",
    "  'package_lock': ex(here/'package-lock.json'),",
    "  'run_config': ex(here/'run.config.json'),",
    "  'seed': ex(here/'seed.json'),",
    "  'state': ex(here/'state.json'),",
    "  'transcript': ex(here/'transcript.jsonl'),",
    "  'uploads': ex(here/'uploads'),",
    "  'logs': ex(cli.LOG_DIR),",
    "  'vapid': ex(here/'vapid-key.pem'),",
    "}",
    "print('RESULT ' + json.dumps({'out': buf.getvalue(), 'exit': result_exit, 'files': files, 'calls': CALLS, 'sh_no_modify': SH['no_modify']}))",
  ].join("\n");
}

async function run(dir, body, env = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("python3", ["-c", `${loadCli(dir)}\n${body}`], {
      cwd: dir,
      env: { ...process.env, HOME: path.join(dir, "home"), FACILITATOR_LOG_DIR: path.join(dir, "logs"), ...env },
      timeout: 30000,
    }));
  } catch (problem) {
    throw new Error(`python failed:\n${problem.stdout || ""}\n${problem.stderr || ""}`);
  }
  const line = stdout.trim().split("\n").find(l => l.startsWith("RESULT "));
  assert.ok(line, `no RESULT line:\n${stdout}`);
  return JSON.parse(line.slice("RESULT ".length));
}

const installed = files => files.venv && files.node_modules && files.run_config && files.seed;

test("install uses the script while uninstall remains a command", async () => {
  const dir = await freshClone();
  const source = await readFile(path.join(dir, "facilitator"), "utf8");
  assert.doesNotMatch(source, /^ {2}facilitator install$/m);
  assert.match(source, /^ {2}facilitator uninstall \[--wipe\]$/m, "uninstall is not in the usage");
  assert.match(source, /elif cmd == "_install" and os\.environ\.get\("FACILITATOR_INTERNAL_INSTALL"\)/);
  assert.match(source, /elif cmd == "uninstall":\n\s+cmd_uninstall\(args\)/, "uninstall is not dispatched");

  const unknown = await execFileAsync("python3", [path.join(dir, "facilitator"), "nonsense"], { cwd: dir })
    .then(() => null, error => error);
  assert.ok(unknown, "an unknown command was accepted");
  assert.doesNotMatch(unknown.stderr, /facilitator install/);
  assert.match(unknown.stderr, /facilitator uninstall \[--wipe\]/);
});

test("install creates the environment, the config and the test deps in one run", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  assert.equal(res.exit, null, res.out);
  assert.ok(installed(res.files), JSON.stringify(res.files));
  assert.ok(res.files.package_json && res.files.package_lock);
  assert.equal(res.files.state, false, "install fabricated board data");

  assert.match(res.out, /python: \d+\.\d+\.\d+ meets the 3\.9 minimum/, res.out);
  assert.match(res.out, /uv: found/);
  assert.match(res.out, /environment: creating \.venv/);
  assert.match(res.out, /packages: syncing to requirements\.txt/);
  assert.match(res.out, /config: wrote run\.config\.json from run\.config\.example\.json/);
  assert.match(res.out, /config: wrote seed\.json from seed\.example\.json/);
  assert.match(res.out, /node packages: installing puppeteer-core for the tests/);
  assert.match(res.out, /Board installed\. Start it with:/);
  assert.match(res.out, /facilitator run/);
  assert.match(res.out, /run\.config\.json \(edit it\)/);

  const kinds = res.calls.map(c => `${c[0]} ${c[1]}`);
  assert.ok(kinds.includes(`${UV} venv`) && kinds.includes(`${UV} pip`) && kinds.includes(`${NPM} install`), kinds.join(" | "));
});

test("a second install changes nothing and says so", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  assert.equal(again.exit, null, again.out);
  assert.ok(installed(again.files));
  assert.match(again.out, /environment: \.venv present/);
  assert.match(again.out, /config: run\.config\.json present/);
  assert.match(again.out, /config: seed\.json present/);
  assert.match(again.out, /node packages: present \(for the tests\)/);

  // the environment is not rebuilt and the test deps are not reinstalled; only
  // the idempotent sync runs again
  assert.equal(again.calls.some(c => c[0] === UV && c[1] === "venv"), false, "the .venv was rebuilt");
  assert.equal(again.calls.some(c => c[0] === NPM && c[1] === "install"), false, "npm ran again");
  assert.ok(again.calls.some(c => c[0] === UV && c[1] === "pip"), "the sync did not run");
});

test("a user's own config is left untouched by install", async () => {
  const dir = await freshClone();
  await writeFile(path.join(dir, "run.config.json"), JSON.stringify({ port: 9001, lanes: [], mine: true }));
  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.match(res.out, /config: run\.config\.json present/);
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
  assert.match(result.out, /kept run\.config\.json/);
  assert.match(result.out, /kept changed seed\.json/);
});

test("without node, the test deps are skipped and named as such", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ node: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.equal(res.files.node_modules, false);
  assert.equal(res.files.package_json, false);
  assert.ok(res.files.venv && res.files.run_config && res.files.seed);
  assert.match(res.out, /node packages: node not found; skipped \(needed only to run the tests\)/);
});

test("when uv is missing and Homebrew is here, install uses brew then continues", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, brew: true }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /uv: not found; installing with Homebrew/);
  assert.ok(res.calls.some(c => c[0] === "/fake/brew" && c[1] === "install"), "brew was not used");
  assert.equal(res.calls.some(c => c[0] === "sh"), false, "the astral installer ran with brew present");
  assert.ok(installed(res.files), "the install did not continue after uv was installed");
});

test("when uv is missing and there is no brew, install uses the astral.sh script without touching a profile", async () => {
  const dir = await freshClone();
  const res = await run(dir, stubs({ uv: false, brew: false }) + "\n" + snapshot("cli.cmd_install(['install'])"));
  assert.equal(res.exit, null, res.out);
  assert.match(res.out, /uv: not found; installing with the astral\.sh installer into your home/);
  assert.ok(res.calls.some(c => c[0] === "curl"), "the installer was not downloaded");
  assert.ok(res.calls.some(c => c[0] === "sh"), "the installer script was not run");
  assert.equal(res.sh_no_modify, "1", "the installer was allowed to change a shell profile");
  assert.equal(res.calls.some(c => c[0] === "/fake/brew"), false);
  assert.ok(installed(res.files), "the install did not continue after uv was installed");
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

test("uninstall removes the environment, node deps and config, and keeps the board's data", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(res.exit, null, res.out);
  // gone: exactly what install made
  assert.equal(res.files.venv, false);
  assert.equal(res.files.node_modules, false);
  assert.equal(res.files.package_json, false);
  assert.equal(res.files.package_lock, false);
  assert.equal(res.files.run_config, false);
  assert.equal(res.files.seed, false);
  // kept: the board's data
  assert.ok(res.files.state && res.files.transcript && res.files.uploads && res.files.logs && res.files.vapid,
    JSON.stringify(res.files));

  assert.match(res.out, /removed \.venv/);
  assert.match(res.out, /removed node_modules/);
  assert.match(res.out, /removed run\.config\.json/);
  assert.match(res.out, /kept state\.json/);
  assert.match(res.out, /kept transcript\.jsonl/);
  assert.match(res.out, /kept uploads/);
  assert.match(res.out, /kept logs/);
  assert.match(res.out, /kept vapid-key\.pem/);
});

test("uninstall --wipe removes the board's data too", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await fabricateData(dir);

  const res = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall', '--wipe'])"));
  assert.equal(res.exit, null, res.out);
  for (const key of ["venv", "node_modules", "run_config", "seed", "state", "transcript", "uploads", "logs", "vapid"]) {
    assert.equal(res.files[key], false, `${key} survived --wipe`);
  }
  assert.match(res.out, /removed state\.json/);
  assert.match(res.out, /removed transcript\.jsonl/);
  assert.match(res.out, /removed uploads/);
  assert.match(res.out, /removed logs/);
  assert.match(res.out, /removed vapid-key\.pem/);
});

test("a second uninstall is harmless and says nothing is present", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  const again = await run(dir, stubs() + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(again.exit, null, again.out);
  assert.match(again.out, /\.venv not present/);
  assert.match(again.out, /run\.config\.json not present/);
});

test("uninstall refuses while the board answers on the port, and removes nothing", async () => {
  const dir = await freshClone();
  await run(dir, stubs() + "\n" + snapshot("cli.cmd_install(['install'])"));

  const res = await run(dir, stubs({ up: true }) + "\n" + snapshot("cli.cmd_uninstall(['uninstall'])"));
  assert.equal(typeof res.exit, "string", "a running board did not stop the uninstall");
  assert.match(res.exit, /the board is up on port \d+; stop that server first, then run uninstall again/, res.exit);
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
  assert.match(refused.stderr, /uninstall takes --wipe and nothing else; got --bogus/, refused.stderr);
});
