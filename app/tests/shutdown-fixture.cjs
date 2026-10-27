// A locked fixture board for the shut down's tests (shutdown.test.cjs and
// shutdown-browser.test.cjs), with the command copied beside it as on an
// install, so POST /shutdown runs the real facilitator stop: run.config.json
// names the board's port, data/.venv is the interpreter the command accepts as
// the server's, osascript is a stand-in that only writes down that it was
// called, and tailscale is tests/fixtures/fake-tailscale.py, connected with no
// Serve rule. Nothing here reaches Chrome, Tailscale or port 8877.
const assert = require("node:assert/strict");
const { request } = require("node:http");
const { createServer } = require("node:net");
const { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } = require("node:fs/promises");
const { existsSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { ROOT, startBoard } = require("./board-fixture.cjs");

// the command stops only a server whose script is its own folder's, read as
// facilitator run starts it, from the folder's real path. macOS reaches the
// temporary folder through a link (/var is /private/var), so the copies are
// made under its real path, or the command would rightly refuse them
process.env.TMPDIR = realpathSync(tmpdir());

// the .venv the copies' server runs on, which the command accepts as the
// board's own interpreter once it sits in the copy's data/
const PYTHON = process.env.FACILITATOR_TEST_PYTHON;
const VENV = PYTHON ? path.dirname(path.dirname(PYTHON)) : path.join(ROOT, "..", "data", ".venv");

// the board, started; end() stops it if it still runs and removes its folders
async function shutdownBoard() {
  const bin = await mkdtemp(path.join(tmpdir(), "facilitator-shutdown-bin-"));
  const calls = path.join(bin, "calls.txt");
  await writeFile(path.join(bin, "osascript"), `#!/bin/sh\necho "osascript $*" >> "${calls}"\nexit 1\n`);
  await chmod(path.join(bin, "osascript"), 0o755);
  // Tailscale connected with no Serve rule, so the phone's door answers as usual
  const fake = path.join(bin, "fake-tailscale");
  await mkdir(fake);
  await copyFile(path.join(ROOT, "tests", "fixtures", "fake-tailscale.py"), path.join(bin, "tailscale"));
  await chmod(path.join(bin, "tailscale"), 0o755);
  const host = "fixture.tail0000.ts.net";
  await writeFile(path.join(fake, "status.json"),
    JSON.stringify({ BackendState: "Running", CertDomains: [host], Self: { DNSName: host + "." } }));
  await writeFile(path.join(fake, "serve.json"), "{}");
  await writeFile(path.join(fake, "control.json"), "{}");
  const board = await startBoard({
    lock: true, extra: ["facilitator"],
    env: { PATH: bin + path.delimiter + process.env.PATH, TS_FAKE_DIR: fake },
    prepare: async ({ data }) => {
      if (existsSync(path.join(VENV, "pyvenv.cfg"))) await symlink(VENV, path.join(data, ".venv"));
    },
  });
  await writeFile(path.join(board.data, "run.config.json"), JSON.stringify({ port: board.port, lanes: [] }));
  Object.assign(board, { bin, calls, async end() { await board.stop(); await rm(bin, { recursive: true, force: true }); } });
  return board;
}

// one request on a port with exactly these headers and no others
function raw(board, method, route, { headers = {}, port = board.port } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: route,
      headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
const key = board => ({ Authorization: `Bearer ${board.key()}` });
const page = board => ({ Origin: board.origin, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors",
                         "Sec-Fetch-Dest": "empty" });
const OPEN = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };

// the window's cookie, got the way the window facilitator run opens gets it:
// a launch code asked for with the key, opened as a page
async function cookieOf(board) {
  const asked = await raw(board, "POST", "/window/launch", { headers: key(board) });
  assert.equal(asked.status, 200, asked.text);
  const code = JSON.parse(asked.text).code;
  const opened = await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: board.port, path: `/?launch=${code}`,
      headers: { Host: `127.0.0.1:${board.port}`, ...OPEN } }, resolve);
    req.on("error", reject);
    req.end();
  });
  opened.resume();
  assert.equal(opened.statusCode, 303);
  return opened.headers["set-cookie"][0].split(";")[0];
}

function canBind(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function events(board) {
  const names = (await readdir(board.logs).catch(() => [])).filter(n => n.startsWith("server-")).sort();
  const lines = [];
  for (const name of names)
    for (const line of (await readFile(path.join(board.logs, name), "utf8")).split("\n")) if (line) lines.push(JSON.parse(line));
  return lines;
}

async function called(board) {
  return (await readFile(board.calls, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

module.exports = { shutdownBoard, raw, key, page, OPEN, cookieOf, canBind, events, called };
