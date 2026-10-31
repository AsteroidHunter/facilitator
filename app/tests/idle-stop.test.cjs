// The idle stop on a real board of its own. TEMPORARY: the three-day timer is
// a temporary fix for the Chrome-window version and will not be in the native
// Mac app; this file goes with it.
//
// Every board here is a sandbox copy (board-sandbox.cjs) on ports the
// operating system handed out, with its three days shortened to IDLE seconds
// in the copy and a phone password set. Tailscale is
// tests/fixtures/fake-tailscale.py, first on PATH, and a fake osascript beside
// it writes down every call, so Chrome is never asked, and the CLI is driven
// through its own functions with the window stubbed. Nothing real is
// signalled, opened or served.
//
//   - a board with only a listening agent stops itself after IDLE, the way
//     facilitator stop does: the server goes, both ports are free, the phone
//     link is taken off, Chrome is asked nothing, one idlestop line is
//     written and the marker is left. The next run says "The board stopped
//     itself after three days unused." before its two lines and takes the
//     marker away, and the run after it says nothing of it. A page reading the
//     board keeps it up past IDLE; once the page goes, the board stops itself
//     again, and status says so once
//   - a restart is a fresh start of the three days
//
// The kinds of activity one by one are tests/test_idle_stop.py.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const box = require("./board-sandbox.cjs");

const execFileAsync = promisify(execFile);
const IDLE = 5;   // seconds with no activity before a sandbox board stops itself
const LINE = "The board stopped itself after three days unused.";
const PASS = "correct-horse-7!";
const up = port => [`Board up on http://127.0.0.1:${port}`, "Facilitator is live!"];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const places = [];

after(async () => {
  for (const place of places) await box.cleanup(place);
});

async function canBind(port) {
  const probe = net.createServer();
  return new Promise(resolve => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

const running = pid => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitGone(pid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!running(pid)) return true;
    await sleep(100);
  }
  return !running(pid);
}

// a sandbox board that is not running: IDLE seconds in place of three days,
// a phone password, and the fake osascript first on PATH. Its data/.venv is
// the tests' own, linked, so the board runs on it as a real one runs on its
// own, and the stop the board starts knows the server for this folder's
async function board(name) {
  const port = await box.freePortPair();
  const place = box.sandbox(name, { config: { port } });
  places.push(place);
  fs.symlinkSync(path.dirname(path.dirname(box.PYTHON)), path.join(place.data, ".venv"));
  const server = path.join(place.app, "server.py");
  const source = fs.readFileSync(server, "utf8");
  const constant = /^IDLE_STOP_AFTER = 3 \* 86400\.0 /m;
  assert.match(source, constant, "the idle stop's constant is not where this test shortens it");
  fs.writeFileSync(server, source.replace(constant, `IDLE_STOP_AFTER = ${IDLE}.0 `));
  execFileSync(box.PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`],
               { cwd: place.app });
  place.osascript = path.join(place.outer, "osascript-calls.txt");
  fs.writeFileSync(path.join(place.bin, "osascript"),
                   `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(place.osascript)}\nexit 1\n`, { mode: 0o755 });
  return { place, port, marker: path.join(place.data, "idle-stop.json") };
}

// the CLI loaded as a module in the sandbox, with the window stubbed: every
// page it would open is recorded instead, and a restart finds its tab
async function cli(place, lines) {
  const code = [
    "import importlib.machinery, importlib.util, json, sys",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(place.app, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
    "WINDOWS = []",
    "cli.open_app = lambda cfg, dry: WINDOWS.append(cli.window_url(cfg))",
    "cli.relaunch_board_tabs = lambda cfg: 1",
    "try:",
    ...lines.map(line => "    " + line),
    "finally:",
    "    sys.stdout.flush()",
    "    print('WINDOWS ' + json.dumps(WINDOWS))",
  ].join("\n");
  const done = await execFileAsync(box.PYTHON, ["-c", code], { cwd: place.app, env: box.env(place), timeout: 90000 })
    .then(ok => ({ code: 0, ...ok }), error => error);
  const all = String(done.stdout || "").split("\n");
  const at = all.findIndex(line => line.startsWith("WINDOWS "));
  return { code: done.code, stderr: String(done.stderr || ""),
           said: all.filter(line => line && !line.startsWith("WINDOWS ")),
           windows: at === -1 ? [] : JSON.parse(all[at].slice("WINDOWS ".length)) };
}

const run = place => cli(place, ["cli.cmd_run(['run'])"]);
const status = place => cli(place, ["cli.cmd_status()"]);

function serverPid(place) {
  return JSON.parse(fs.readFileSync(path.join(place.data, "server.lock"), "utf8")).pid;
}

function rootTarget(place) {
  const web = box.serveState(place).Web || {};
  const root = web[`${box.HOST}:443`]?.Handlers?.["/"];
  return root ? root.Proxy : null;
}

const kinds = (place, kind) => box.events(place).filter(event => event.kind === kind);
const osascriptCalls = place => (fs.existsSync(place.osascript) ? fs.readFileSync(place.osascript, "utf8") : "");

// an agent that only listens, as the agents' listen does: the board read
// with the key, then a /wait that comes back idle, until the board is gone
async function listenUntilGone(port, place, pid, ms) {
  const key = box.keyed(place);
  const deadline = Date.now() + ms;
  let idle = 0;
  while (running(pid) && Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/state`, { headers: key });
      const waited = await fetch(`http://127.0.0.1:${port}/wait?owner=facilitator&timeout=1&agent=claude`,
                                 { headers: key });
      if (waited.ok && (await waited.json()).idle) idle += 1;
    } catch {
      await sleep(100);
    }
  }
  return idle;
}

// the board's own window reading it, as the Mac board does, until stopped
function pageReader(place, port, cookie) {
  let on = true;
  let reads = 0;
  const loop = (async () => {
    while (on) {
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/state`, { headers: { Cookie: cookie } });
        if (answer.ok) reads += 1;
        await answer.arrayBuffer();
      } catch {}
      await sleep(600);
    }
  })();
  return { stop: async () => { on = false; await loop; return reads; } };
}

// the server is gone the way facilitator stop ends it, and the board said why
async function assertStoppedItself(place, port, pid, why) {
  assert.equal(running(pid), false, `${why}: the server is still running`);
  assert.equal(await canBind(port), true, `${why}: port ${port} is still held`);
  assert.equal(await canBind(port + 1), true, `${why}: the phone's port is still held`);
  // the stop takes the phone link off last, once the server is gone
  const deadline = Date.now() + 15000;
  while (rootTarget(place) !== null && Date.now() < deadline) await sleep(100);
  assert.equal(rootTarget(place), null,
    `${why}: the phone link was not taken off; tailscale was asked ${JSON.stringify(box.tailscaleCalls(place))}`);
  assert.equal(osascriptCalls(place), "", `${why}: Chrome was asked`);
  const stops = box.events(place).filter(event => event.kind === "stop");
  assert.equal(stops.at(-1).reason, "SIGTERM", `${why}: the board was not ended with one SIGTERM`);
}

test("an unused board stops itself the way facilitator stop does, and run and status say so once", async () => {
  const { place, port, marker } = await board("idle-stop");
  const first = await run(place);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.said, up(port), "a board that never stopped itself was said to");
  assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`, "run did not leave the phone link on");
  const pid = serverPid(place);

  // an agent listening the whole time does not keep the board up
  const listens = await listenUntilGone(port, place, pid, (IDLE + 15) * 1000);
  assert.ok(await waitGone(pid, 5000), "the unused board did not stop itself");
  assert.ok(listens >= 2, `the agent did not really listen (${listens} idle listens)`);
  await assertStoppedItself(place, port, pid, "the first idle stop");
  const [start] = kinds(place, "start");
  const idle = kinds(place, "idlestop");
  assert.equal(idle.length, 1, JSON.stringify(idle));
  assert.equal(idle[0].level, "info");
  assert.equal(idle[0].days, IDLE / 86400);
  const waited = Date.parse(idle[0].ts) - Date.parse(start.ts);
  assert.ok(waited >= IDLE * 1000 - 50, `the board stopped itself after ${waited} ms, before its ${IDLE} s`);
  assert.ok(waited <= (IDLE + 6) * 1000, `the board took ${waited} ms to stop itself`);
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).days, IDLE / 86400);
  const saved = JSON.parse(fs.readFileSync(path.join(place.data, "state.json"), "utf8"));
  assert.equal(saved.title, "sandbox board", "the stop lost the saved board");

  // the next run says so first, once, and takes the marker away
  const again = await run(place);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(again.said, [LINE, ...up(port)]);
  assert.equal(fs.existsSync(marker), false, "run left the marker to be said again");
  assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`, "run did not turn the phone link back on");
  const second = serverPid(place);
  assert.notEqual(second, pid);

  // the board's window reading it keeps it up; the run after says nothing of it
  const reader = pageReader(place, port, await box.windowCookie(place, port));
  const third = await run(place);
  assert.equal(third.code, 0, third.stderr);
  assert.deepEqual(third.said, up(port), "the line was said twice");
  await sleep((IDLE * 2 + 1) * 1000);
  const reads = await reader.stop();
  assert.ok(reads >= IDLE, `the page hardly read the board (${reads} readings)`);
  assert.equal(running(second), true, "a board its window was reading stopped itself");
  assert.equal(kinds(place, "idlestop").length, 1, "a board its window was reading stopped itself");

  // once the window goes, so does the board, and status says so once
  assert.ok(await waitGone(second, (IDLE + 8) * 1000), "the board did not stop itself once its window went");
  await assertStoppedItself(place, port, second, "the second idle stop");
  assert.ok(fs.existsSync(marker), "the second idle stop left no marker");
  const down = await status(place);
  assert.equal(down.code, 1);
  assert.deepEqual(down.said, [LINE]);
  assert.match(down.stderr, new RegExp(`server: DOWN \\(port ${port}\\)`));
  assert.equal(fs.existsSync(marker), false, "status left the marker to be said again");
  const later = await status(place);
  assert.equal(later.code, 1);
  assert.deepEqual(later.said, [], "status said the line twice");
  assert.deepEqual([...first.windows, ...again.windows, ...third.windows].length, 3,
    "run did not open the window once each time");
});

test("a restart is a fresh start of the three days", async () => {
  const { place, port, marker } = await board("idle-restart");
  const first = await run(place);
  assert.equal(first.code, 0, first.stderr);
  const old = serverPid(place);
  await sleep((IDLE - 3) * 1000);   // part of the first board's time used up

  const restarted = await cli(place, ["cli.cmd_restart(['restart'])"]);
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.deepEqual(restarted.said, ["Board restarted."]);
  const pid = serverPid(place);
  assert.notEqual(pid, old);
  assert.equal(running(old), false);

  // past the first board's own time, the restarted one is still up
  await sleep(3000);
  const starts = kinds(place, "start");
  assert.equal(starts.length, 2);
  assert.ok(Date.now() > Date.parse(starts[0].ts) + IDLE * 1000, "the check came before the first board's time ran out");
  assert.equal(running(pid), true, "the restarted board stopped on the first board's time");
  assert.equal(kinds(place, "idlestop").length, 0, "a board stopped itself before its time");

  assert.ok(await waitGone(pid, (IDLE + 8) * 1000), "the restarted board did not stop itself");
  await assertStoppedItself(place, port, pid, "the idle stop after a restart");
  const idle = kinds(place, "idlestop");
  assert.equal(idle.length, 1);
  const waited = Date.parse(idle[0].ts) - Date.parse(starts[1].ts);
  assert.ok(waited >= IDLE * 1000 - 50, `the restarted board stopped itself ${waited} ms after its start`);
  assert.ok(fs.existsSync(marker));
});
