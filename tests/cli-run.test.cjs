// How the CLI starts the server. It used to hand the child an append handle on
// a file in /tmp and fold its standard error into it, which meant every event
// was written twice: once as JSON in the dated file the server keeps itself,
// once as text in a file nothing rotated and nobody read. Now the child's
// output goes nowhere and the dated file is the only stream, so the one thing
// left to check here is that the launch opens no file at all, and that the one
// failure no file can hold, a child gone before its logger exists, still
// reaches the terminal in a sentence.
//
// This drives the CLI's own function with a stand-in for Popen rather than
// starting anything: no server, no window, no port.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

let fixtureDir;   // a copy of the CLI, so nothing here touches the real one
let cliPath;

// the CLI is a command with no .py on the end, so it is loaded by name and
// path rather than imported; from there it is an ordinary module to poke at
function loadCli() {
  return [
    "import importlib.machinery, importlib.util, json, subprocess, types",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(cliPath)})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
  ].join("\n");
}

async function probe(code) {
  return execFileAsync("python3", ["-c", `${loadCli()}\n${code}`], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-cli-run-"));
  cliPath = path.join(fixtureDir, "facilitator");
  await copyFile(path.join(ROOT, "facilitator"), cliPath);
  await writeFile(path.join(fixtureDir, "run.config.json"),
    JSON.stringify({ port: 8899, lanes: [] }));
});

after(async () => {
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the launch sends the server's output nowhere and opens no file of its own", async () => {
  const { stdout } = await probe([
    "opened = []",
    "import builtins",
    "real = builtins.open",
    "builtins.open = lambda *a, **kw: (opened.append(str(a[0])), real(*a, **kw))[1]",
    "launched = {}",
    "class Fake:",
    "    def __init__(self, argv, **kw):",
    "        launched.update(argv=list(argv), stdout=kw.get('stdout'), stderr=kw.get('stderr'),",
    "                        session=kw.get('start_new_session'))",
    "    def poll(self):",
    "        return None",
    "cli.subprocess = types.SimpleNamespace(Popen=Fake, DEVNULL=subprocess.DEVNULL,",
    "                                       STDOUT=subprocess.STDOUT, PIPE=subprocess.PIPE)",
    "answers = [None, {'boxes': []}]",
    "cli.state = lambda port, timeout=2: answers.pop(0)",
    "cli.ensure_server(8899, False)",
    "builtins.open = real",
    "print(json.dumps({**launched, 'opened': opened, 'devnull': subprocess.DEVNULL,",
    "                  'to_stdout': subprocess.STDOUT}))",
  ].join("\n"));

  const seen = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(seen.argv.length, 2);
  assert.match(seen.argv[1], /server\.py$/, seen.argv[1]);
  assert.equal(seen.stdout, seen.devnull, "the server's output is still being caught");
  assert.equal(seen.stderr, seen.devnull, "the server's errors are still being caught");
  assert.notEqual(seen.stderr, seen.to_stdout, "the two streams are still being merged");
  assert.equal(seen.session, true, "the server no longer outlives the terminal that started it");
  assert.deepEqual(seen.opened, [], `the launch opened a file: ${seen.opened.join(", ")}`);

  // and the path that file used to have is gone from the command altogether
  const source = await readFile(cliPath, "utf8");
  assert.doesNotMatch(source, /\/tmp\//, "the command still names a file in /tmp");
});

test("a child that is gone at once is said in one sentence, since no file can hold it", async () => {
  const failed = await probe([
    "class Dead:",
    "    def __init__(self, argv, **kw):",
    "        pass",
    "    def poll(self):",
    "        return 1",
    "cli.subprocess = types.SimpleNamespace(Popen=Dead, DEVNULL=subprocess.DEVNULL,",
    "                                       STDOUT=subprocess.STDOUT, PIPE=subprocess.PIPE)",
    "cli.state = lambda port, timeout=2: None",
    "cli.ensure_server(8899, False)",
  ].join("\n")).then(() => null, error => error);

  assert.ok(failed, "a start that died at once was reported as a start");
  assert.equal(failed.code, 1);
  const said = failed.stderr.trim().split("\n").at(-1);
  assert.match(said, /^the server did not start; run python3 .*server\.py by hand to see why$/, said);
});
