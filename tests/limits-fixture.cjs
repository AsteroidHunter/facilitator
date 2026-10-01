// Shared pieces for the limits box's checks: a fake `codex` that speaks the
// app server's two calls the way the real one does (and can hang, fail or count
// its starts), the numbers Codex and Claude Code hand over, and a small runner
// for the Python module. Nothing here starts a real codex or reads a real log.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = execFileSync(process.env.FACILITATOR_TEST_PYTHON || "python3",
  ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();

const FAKE_CODEX = `#!${PYTHON}
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))

def note(name, text):
    with open(os.path.join(here, name), "a") as f:
        f.write(text + "\\n")

note("starts.txt", str(os.getpid()))
if sys.argv[1:] != ["app-server"]:
    sys.exit(2)
mode = open(os.path.join(here, "mode.txt")).read().strip()
if mode == "hang":
    time.sleep(600)
for line in sys.stdin:
    try:
        message = json.loads(line)
    except ValueError:
        continue
    method = message.get("method")
    note("calls.txt", str(method))
    if method == "initialize":
        print(json.dumps({"id": message["id"], "result": {"userAgent": "fake"}}), flush=True)
    elif method == "account/rateLimits/read":
        if mode == "error":
            print(json.dumps({"id": message["id"], "error": {"code": -32600, "message": "not signed in"}}), flush=True)
        else:
            reply = json.load(open(os.path.join(here, "reply.json")))
            print(json.dumps({"id": message["id"], "result": reply}), flush=True)
`;

// a fake codex in binDir. reply is the result of account/rateLimits/read
function installCodex(binDir, { reply = codexReply(), mode = "ok" } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, "codex");
  fs.writeFileSync(file, FAKE_CODEX);
  fs.chmodSync(file, 0o755);
  const at = name => path.join(binDir, name);
  const lines = name => fs.existsSync(at(name)) ? fs.readFileSync(at(name), "utf8").split("\n").filter(Boolean) : [];
  const codex = {
    setReply(value) { fs.writeFileSync(at("reply.json"), JSON.stringify(value)); },
    setMode(value) { fs.writeFileSync(at("mode.txt"), value); },
    starts: () => lines("starts.txt").length,
    pids: () => lines("starts.txt").map(Number),
    calls: () => lines("calls.txt"),
    reset() { for (const name of ["starts.txt", "calls.txt"]) fs.rmSync(at(name), { force: true }); },
  };
  codex.setReply(reply);
  codex.setMode(mode);
  return codex;
}

const snapshot = (limitId, primary, secondary) => ({ limitId, limitName: null, primary, secondary, credits: null, planType: "plus" });
const windowOf = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });

// the account/rateLimits/read result: the account's own bucket, and a model's
// beside it that must never be read
function codexReply({ five = windowOf(32, 300, 4102444800), week = windowOf(61, 10080, 4102444800) } = {}) {
  const own = snapshot("codex", five, week);
  return {
    rateLimits: own,
    rateLimitsByLimitId: {
      codex: own,
      codex_bengalfox: snapshot("codex_bengalfox", windowOf(99, 300, 4102444800), windowOf(98, 10080, 4102444800)),
    },
  };
}

// a token_count line of a Codex session log, with the limits it carries
function logLine(stamp, limitId, primary, secondary) {
  const win = w => w && { used_percent: w[0], window_minutes: w[1], resets_at: w[2] };
  return JSON.stringify({
    timestamp: stamp, type: "event_msg",
    payload: { type: "token_count", info: null,
               rate_limits: { limit_id: limitId, limit_name: null, primary: win(primary), secondary: win(secondary),
                              credits: null, plan_type: "plus" } },
  });
}

// the Python module under test, run from the repo's own folder; the code
// prints one JSON value
function py(code, env = {}) {
  const out = execFileSync(PYTHON, ["-c", code], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30000,
  });
  return JSON.parse(out);
}

const FAKE_TAILSCALE = `#!/bin/sh
case "$*" in
  *"serve status"*) echo '{}' ;;
  *"status"*) echo '{"BackendState":"Stopped"}' ;;
  *) : ;;
esac
exit 0
`;

// a board of its own on a spare port: its own folder, its own HOME, and a PATH
// that holds a fake tailscale and, when asked for, a fake codex, and nothing else
async function serve({ codex = null, claude = null, level = "info" } = {}) {
  const { spawn } = require("node:child_process");
  const { tmpdir } = require("node:os");
  const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "facilitator-limits-")));
  const home = path.join(dir, "home"), bin = path.join(dir, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "tailscale"), FAKE_TAILSCALE);
  fs.chmodSync(path.join(bin, "tailscale"), 0o755);
  const source = fs.readFileSync(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
             'TAILSCALE_APP = "/nonexistent/tailscale"');
  if (!patched.includes("FACILITATOR_TEST_PORT")) throw new Error("the server's port anchor moved");
  fs.writeFileSync(path.join(dir, "server.py"), patched);
  copyBridgeFiles(dir);
  for (const name of ["tokens.py", "limits.py", "m-manifest.json", "home-widgets.js", "home-widgets.css"])
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  fs.writeFileSync(path.join(dir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [{ id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" }],
  }));
  if (claude) fs.writeFileSync(path.join(dir, "claude-limits.json"), JSON.stringify(claude));
  const board = {
    dir, home, bin, child: null,
    codex: codex ? installCodex(bin, codex) : null,
    origin: `http://127.0.0.1:${await freePortPair()}`,
    claudeFile: path.join(dir, "claude-limits.json"),
    cacheFile: path.join(dir, "tokens-cache.json"),
    async start() {
      const env = { ...process.env, HOME: home, TZ: "UTC", PATH: bin, FACILITATOR_LOG_LEVEL: level,
                    FACILITATOR_TEST_PORT: new URL(board.origin).port, FACILITATOR_LOG_DIR: path.join(dir, "logs") };
      delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
      board.child = spawn(PYTHON, [path.join(dir, "server.py")], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      for (const s of [board.child.stdout, board.child.stderr]) { s.setEncoding("utf8"); s.on("data", c => { output += c; }); }
      const deadline = Date.now() + 15000;
      for (;;) {
        if (board.child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
        try { if ((await fetch(board.origin + "/state")).ok) return board; } catch {}
        if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
        await new Promise(r => setTimeout(r, 25));
      }
    },
    async stop() {
      if (!board.child || board.child.exitCode !== null) return;
      board.child.kill("SIGTERM");
      await new Promise(resolve => board.child.once("exit", resolve));
    },
    async get(route) {
      const response = await fetch(board.origin + route);
      return { status: response.status, body: await response.json() };
    },
    async limits() {
      const { status, body } = await board.get("/limits");
      if (status !== 200) throw new Error(`/limits answered ${status}`);
      return body;
    },
    logLines() {
      const folder = path.join(dir, "logs");
      if (!fs.existsSync(folder)) return [];
      return fs.readdirSync(folder).filter(n => /^server-.*\.log$/.test(n))
        .flatMap(n => fs.readFileSync(path.join(folder, n), "utf8").split("\n").filter(Boolean));
    },
    async remove() {
      await board.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return board;
}

module.exports = { ROOT, PYTHON, installCodex, codexReply, windowOf, logLine, py, serve };
