// The CLI's real launch path with the server's libraries installed: which
// interpreter it picks, that the board it starts answers on the port, that a
// stop by PID and a second launch bring the same saved board back with its
// revision moved on, and that the one-line status reads it. The launch is
// driven through the CLI's own ensure_server, never cmd_run, so no app window
// is ever opened; the fixture's .venv is the repository's own, linked in. The
// suite never touches port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { access, copyFile, mkdtemp, readFile, realpath, rm, symlink, writeFile } = require("node:fs/promises");
const { constants } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

let fixtureDir;
let port;

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

function loadCli() {
  return [
    "import importlib.machinery, importlib.util, json, os, signal, subprocess, sys, time, types",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(fixtureDir, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

async function probe(code, extraEnv = {}) {
  return execFileAsync("python3", ["-c", `${loadCli()}\n${code}`], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs"), ...extraEnv },
    timeout: 60000,
  });
}

async function portFree() {
  try {
    await fetch(`http://127.0.0.1:${port}/state`);
    return false;
  } catch {
    return true;
  }
}

// a launch through the CLI's own function; the child's pid comes back so
// the test can stop exactly what it started, and never anything else
async function launch() {
  const { stdout } = await probe([
    "started = {}",
    "real_popen = cli.subprocess.Popen",
    "def popen(argv, **kw):",
    "    child = real_popen(argv, **kw)",
    "    started['pid'] = child.pid",
    "    started['argv'] = list(argv)",
    "    return child",
    "cli.subprocess.Popen = popen",
    `cli.ensure_server(${port}, False)`,
    "print(json.dumps(started))",
  ].join("\n"));
  const lines = stdout.trim().split("\n");
  return { said: lines.slice(0, -1), ...JSON.parse(lines.at(-1)) };
}

async function stopByPid(pid) {
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + 8000;
  while (!(await portFree())) {
    assert.ok(Date.now() < deadline, "the board did not free its port after SIGTERM");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

before(async () => {
  // the CLI resolves its own place, and a temporary folder here is reached
  // through a link, so the fixture is named by its real path from the start
  fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-cli-launch-")));
  port = await freePort();
  await copyFile(path.join(ROOT, "facilitator"), path.join(fixtureDir, "facilitator"));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ port, lanes: [] }));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "cli launch fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  // the repository's own installed libraries, linked in as the fixture's .venv
  await access(path.join(ROOT, ".venv", "bin", "python3"), constants.X_OK);
  await symlink(path.join(ROOT, ".venv"), path.join(fixtureDir, ".venv"));
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the CLI runs the server with the .venv beside it, and its own interpreter without one", async () => {
  const withVenv = (await probe("print(cli.server_python())")).stdout.trim();
  assert.equal(withVenv, path.join(fixtureDir, ".venv", "bin", "python3"));
  const bare = await mkdtemp(path.join(tmpdir(), "facilitator-cli-bare-"));
  try {
    await copyFile(path.join(ROOT, "facilitator"), path.join(bare, "facilitator"));
    const { stdout } = await execFileAsync("python3", ["-c", [
      "import importlib.machinery, importlib.util, sys",
      `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(bare, "facilitator"))})`,
      "spec = importlib.util.spec_from_loader(loader.name, loader)",
      "cli = importlib.util.module_from_spec(spec)",
      "loader.exec_module(cli)",
      "print(cli.server_python() == sys.executable)",
    ].join("\n")], { cwd: bare });
    assert.equal(stdout.trim(), "True");
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
  const dry = await probe(`cli.ensure_server(${port}, True)`);
  assert.match(dry.stdout, /^server: would start .*server\.py$/m);
  assert.equal(await portFree(), true, "a dry run started the server");
});

test("a launch brings the board up on the port, a stop by pid frees it, and a relaunch keeps the saved board", async () => {
  const first = await launch();
  try {
    assert.equal(first.argv[0], path.join(fixtureDir, ".venv", "bin", "python3"), first.argv.join(" "));
    assert.match(first.argv[1], /server\.py$/);
    assert.deepEqual(first.said, [`server: started on ${port}`]);
    const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
    assert.equal(state.title, "cli launch fixture");
    const revBefore = state.rev;
    assert.equal((await fetch(`http://127.0.0.1:${port}/send?box=0`, { method: "POST", body: "kept across the restart" })).status, 200);
    const status = await probe("cli.cmd_status()");
    assert.match(status.stdout, /^server up, \d+ boxes, 1 queued \| facilitator: last heard/m, status.stdout);
    const again = await probe(`cli.ensure_server(${port}, False)`);
    assert.match(again.stdout, /^server: already up on/m, "a second launch started a second server");

    await stopByPid(first.pid);
    const second = await launch();
    try {
      assert.deepEqual(second.said, [`server: started on ${port}`]);
      const back = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
      assert.deepEqual(back.boxes.find(b => b.id === "0").pendingTexts, ["kept across the restart"], "the restart lost the queued message");
      assert.ok(back.rev > revBefore, "the revision did not carry across the restart");
      const saved = JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
      assert.equal(saved.rev, back.rev);
      assert.deepEqual(saved.ops, {});
      const down = await probe("cli.cmd_status()").then(() => null, error => error);
      assert.equal(down, null, "status could not read the relaunched board");
    } finally {
      await stopByPid(second.pid);
    }
    const gone = await probe("cli.cmd_status()").then(() => null, error => error);
    assert.ok(gone && /server: DOWN/.test(gone.stderr), "status did not say the stopped board is down");
  } finally {
    await stopByPid(first.pid);
  }
});
