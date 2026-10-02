// A whole board in a temporary folder, for the tests of where the board
// listens and where its settings live: the server, the CLI and the bridge
// files copied as they are (the server reads its port from the folder's own
// run.config.json, nothing is swapped), its own log folder, and the fake
// tailscale first on PATH, so neither the copied server nor the copied CLI
// can reach a real Tailscale. Every port comes from the operating system.
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const HOST = "fixture.tail0000.ts.net";
const CONNECTED = { BackendState: "Running", CertDomains: [HOST], Self: { DNSName: HOST + "." } };

// the folder the board lives in is one level down, so the sibling
// facilitator-internal/ the server writes into stays inside the sandbox
function sandbox(name, { config = {}, seed } = {}) {
  const outer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `facilitator-${name}-`)));
  const app = path.join(outer, "facilitator");
  fs.mkdirSync(app);
  for (const file of ["server.py", "facilitator", "qr.py", "index.html", "page.html", "card-logic.js",
                      "card-markdown.js", "card-report.js", "card-tokens.css", "compose-format.js",
                      "cm-markdown.js", "manifest.json", "sw.js", "board-settings.js"])
    if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  copyBridgeFiles(app);
  fs.writeFileSync(path.join(app, "seed.json"), JSON.stringify(seed || {
    title: "sandbox board",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));
  if (config !== null) writeConfig(app, { lanes: [], ...config });
  const bin = path.join(outer, "bin");
  const fake = path.join(outer, "fake-tailscale");
  fs.mkdirSync(bin);
  fs.mkdirSync(fake);
  fs.copyFileSync(path.join(ROOT, "tests", "fixtures", "fake-tailscale.py"), path.join(bin, "tailscale"));
  fs.chmodSync(path.join(bin, "tailscale"), 0o755);
  const place = { outer, app, bin, fake, logs: path.join(outer, "logs"), children: [] };
  setTailscale(place, {});
  return place;
}

function writeConfig(app, value) {
  fs.writeFileSync(path.join(app, "run.config.json"), JSON.stringify(value, null, 2) + "\n");
}

function readConfig(place) {
  return JSON.parse(fs.readFileSync(path.join(place.app, "run.config.json"), "utf8"));
}

// what the fake tailscale answers: connected or not, and the Serve config
function setTailscale(place, { status = CONNECTED, serve = {}, control = {} }) {
  fs.writeFileSync(path.join(place.fake, "status.json"), JSON.stringify(status));
  fs.writeFileSync(path.join(place.fake, "serve.json"), JSON.stringify(serve));
  fs.writeFileSync(path.join(place.fake, "control.json"), JSON.stringify(control));
}

function serveState(place) {
  return JSON.parse(fs.readFileSync(path.join(place.fake, "serve.json"), "utf8"));
}

function tailscaleCalls(place) {
  try {
    return fs.readFileSync(path.join(place.fake, "calls.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

// the environment every process in the sandbox runs with; the test seam
// FACILITATOR_TEST_PORT is never set, so the server reads the config
function env(place, extra = {}) {
  const out = { ...process.env, PATH: place.bin + path.delimiter + process.env.PATH,
                TS_FAKE_DIR: place.fake, FACILITATOR_LOG_DIR: place.logs, ...extra };
  delete out.FACILITATOR_TEST_PORT;
  if (extra.FACILITATOR_TEST_PORT) out.FACILITATOR_TEST_PORT = extra.FACILITATOR_TEST_PORT;
  return out;
}

function launch(place, extra = {}) {
  const run = { child: spawn(PYTHON, [path.join(place.app, "server.py")],
                             { cwd: place.app, env: env(place, extra), stdio: ["ignore", "pipe", "pipe"] }),
                output: "" };
  for (const stream of [run.child.stdout, run.child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { run.output += chunk; });
  }
  place.children.push(run.child);
  return run;
}

async function waitReady(run, port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (run && run.child.exitCode !== null) throw new Error(`the sandbox server exited:\n${run.output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/state`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`the sandbox server did not answer on ${port}:\n${run ? run.output : ""}`);
}

async function waitFree(port, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/state`); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`port ${port} is still answering`);
}

function events(place) {
  if (!fs.existsSync(place.logs)) return [];
  const out = [];
  for (const name of fs.readdirSync(place.logs).sort()) {
    if (!name.startsWith("server-")) continue;
    for (const line of fs.readFileSync(path.join(place.logs, name), "utf8").split("\n"))
      if (line) out.push(JSON.parse(line));
  }
  return out;
}

// something that is not this board, holding a port: a plain listener
async function foreign(port) {
  const server = net.createServer(socket => socket.end("not a board\n"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

// every server a test started, and any it started through the CLI (named in
// the folder's lock), is stopped; then the folder goes
async function cleanup(place) {
  const pids = new Set(place.children.filter(c => c.exitCode === null).map(c => c.pid));
  try {
    const held = JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8"));
    if (Number.isInteger(held.pid) && held.pid > 1) pids.add(held.pid);
  } catch {}
  for (const pid of pids) {
    // only a process still running this sandbox's own server.py is signalled
    if (!ownServer(place, pid)) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  for (const child of place.children) if (child.exitCode === null) await once(child, "exit").catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 150));
  fs.rmSync(place.outer, { recursive: true, force: true });
}

function ownServer(place, pid) {
  const { execFileSync } = require("node:child_process");
  try {
    const line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return line.includes(path.join(place.app, "server.py"));
  } catch { return false; }
}

module.exports = {
  ROOT, PYTHON, HOST, CONNECTED, sandbox, writeConfig, readConfig, setTailscale, serveState,
  tailscaleCalls, env, launch, waitReady, waitFree, events, foreign, closeServer, cleanup,
  freePortPair,
};
