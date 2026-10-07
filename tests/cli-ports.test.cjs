// Where `facilitator run` puts the board. The board stays on its pair (the
// port in run.config.json and the one above it) until something else holds
// it; then run moves it to the next free pair, writes the port into the
// config, says so in one line, and points the phone's Tailscale link at the
// new pair when that link was this board's own. It stays there even once the
// old pair is free again. This folder's own board is never something else.
// The commands that follow the config (restart, status, update's restart,
// uninstall, the bridge and the agent skill's helper) follow the move.
//
// Every board here is a sandbox copy on ports the operating system handed
// out, "something else" is a plain listener this test owns, and Tailscale is
// tests/fixtures/fake-tailscale.py, first on PATH. No window is ever opened:
// the CLI is driven through its own functions with the window stubbed out.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const box = require("./board-sandbox.cjs");

const execFileAsync = promisify(execFile);
const PASS = "correct-horse-7!";

async function canBind(port) {
  const probe = net.createServer();
  return new Promise(resolve => {
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// a run of n ports that can all be bound right now
async function freeBlock(n) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = await box.freePortPair();
    if (base + n > 65535) continue;
    let all = true;
    for (let p = base; p < base + n && all; p++) all = await canBind(p);
    if (all) return base;
  }
  throw new Error(`no ${n} free ports in a row`);
}

// something else serving the web on a port: not a board
async function webApp(port) {
  const server = http.createServer((req, res) => res.end("<html>another program</html>"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

function servingRule(phonePort) {
  return { TCP: { "443": { HTTPS: true } },
           Web: { [`${box.HOST}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${phonePort}` } } } } };
}

function rootTarget(place) {
  const web = box.serveState(place).Web || {};
  const root = web[`${box.HOST}:443`]?.Handlers?.["/"];
  return root ? root.Proxy : null;
}

// the CLI loaded as a module in a sandbox, with the window stubbed: every page
// it would open is recorded instead, and a restart is told the board is showing
async function cli(place, lines, extra = {}) {
  const code = [
    "import importlib.machinery, importlib.util, json, sys",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(place.app, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
    "WINDOWS = []",
    "cli.open_app = lambda cfg, dry: WINDOWS.append(cli.window_url(cfg))",
    "cli.board_page_open = lambda cfg: True",
    "try:",
    ...lines.map(line => "    " + line),
    "finally:",
    "    sys.stdout.flush()",
    "    print('WINDOWS ' + json.dumps(WINDOWS))",
  ].join("\n");
  const done = await execFileAsync(box.PYTHON, ["-c", code], { cwd: place.app, env: box.env(place, extra), timeout: 90000 })
    .then(ok => ({ code: 0, ...ok }), error => error);
  const all = String(done.stdout || "").split("\n");
  const marker = all.findIndex(line => line.startsWith("WINDOWS "));
  return { code: done.code, stderr: String(done.stderr || ""),
           said: all.slice(0, marker === -1 ? all.length : marker).filter(Boolean),
           windows: marker === -1 ? [] : JSON.parse(all[marker].slice("WINDOWS ".length)) };
}

// the CLI as the command it is, for the subcommands that open no window
async function command(place, args, extra = {}) {
  return execFileAsync(box.PYTHON, [path.join(place.app, "facilitator"), ...args],
                       { cwd: place.app, env: box.env(place, extra), timeout: 60000 })
    .then(ok => ({ code: 0, ...ok }), error => ({ code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" }));
}

function held(place) {
  return JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8"));
}

function bridgeLog(place) {
  if (!fs.existsSync(place.logs)) return [];
  return fs.readdirSync(place.logs).filter(name => name.startsWith("bridge-"))
    .flatMap(name => fs.readFileSync(path.join(place.logs, name), "utf8").split("\n").filter(Boolean).map(JSON.parse));
}

async function stopBoard(place, port) {
  const pid = held(place).pid;
  process.kill(pid, "SIGTERM");
  await box.waitFree(port);
}

const up = port => [`Board up on http://127.0.0.1:${port}`, "Facilitator is live!"];

test("something else on the pair: run moves to the next free pair, writes it, says so once, and stays there", async () => {
  const base = await freeBlock(8);
  const place = box.sandbox("ports-move", { config: { port: base, app_url: "" } });
  const other = await webApp(base);
  try {
    const before = fs.readFileSync(path.join(place.app, "run.config.json"), "utf8");
    const moved = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.equal(moved.code, 0, moved.stderr);
    const next = base + 2;
    assert.deepEqual(moved.said, [
      `Board moved to port ${next}: something else is using ${base} or ${base + 1}. It stays on ${next}, and run.config.json now says so.`,
      ...up(next),
    ]);
    assert.deepEqual(moved.windows, [`http://127.0.0.1:${next}`], "the window was opened at the old address");
    // only the port changed, the file's own text and every other key kept
    assert.equal(fs.readFileSync(path.join(place.app, "run.config.json"), "utf8"),
                 before.replace(`"port": ${base}`, `"port": ${next}`));
    const st = await (await fetch(`http://127.0.0.1:${next}/state`)).json();
    assert.equal(st.pwd, place.app, "the board on the new pair is not this folder's");
    assert.equal(held(place).port, next);
    assert.equal(await (await fetch(`http://127.0.0.1:${base}/`)).text(), "<html>another program</html>",
                 "the other program was disturbed");

    // already up where the config says: the two usual lines and nothing started
    const pid = held(place).pid;
    const again = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.deepEqual(again.said, up(next));
    assert.equal(held(place).pid, pid, "a second server was started beside the first");

    // the old pair comes free and the board stops: the next run stays on the new pair
    await box.closeServer(other);
    await stopBoard(place, next);
    assert.equal(await canBind(base), true);
    const back = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.equal(back.code, 0, back.stderr);
    assert.deepEqual(back.said, up(next), "the board went back to the old pair");
    assert.equal(box.readConfig(place).port, next);
    assert.equal((await (await fetch(`http://127.0.0.1:${next}/state`)).json()).pwd, place.app);
    assert.equal(await canBind(base), true, "something took the old pair");

    // the commands that read the config follow the move
    const status = await command(place, ["status"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^server up, \d+ boxes, \d+ queued/);
    const firstPid = held(place).pid;
    const restarted = await cli(place, ["cli.cmd_restart(['restart'])"]);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.deepEqual(restarted.said, ["Board restarted.", "Reload the board (command + R)."]);
    assert.notEqual(held(place).pid, firstPid, "restart did not replace the server");
    assert.equal(held(place).port, next, "restart moved the board");
    const secondPid = held(place).pid;
    const updated = await cli(place, ["print(cli.restart_board(True))"]);
    assert.equal(updated.code, 0, updated.stderr);
    assert.deepEqual(updated.said, ["The board is running. Restarting it onto the new code.",
                                    "Board restarted.", "Reload the board (command + R).", "True"]);
    assert.notEqual(held(place).pid, secondPid, "update's restart did not reach the moved board");
    const home = path.join(place.outer, "home");
    fs.mkdirSync(home);
    const uninstall = await command(place, ["uninstall", "--keep-attachments"], { HOME: home });
    assert.equal(uninstall.code, 1);
    assert.match(uninstall.stderr, new RegExp(`The board is up on port ${next}\\.`));
  } finally {
    if (other.listening) await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("this folder's board already up on another pair: run starts nothing and brings the config to it", async () => {
  const base = await freeBlock(4);
  const place = box.sandbox("ports-elsewhere", { config: { port: base + 2 } });
  try {
    const run = box.launch(place);
    await box.waitReady(run, base + 2);
    box.writeConfig(place.app, { port: base, lanes: [] });
    // restart keeps its pair and does not start a second server beside it
    const refused = await cli(place, ["cli.cmd_restart(['restart'])"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`^restart: this board is running on port ${base + 2}, not on ${base} from run\\.config\\.json; run facilitator run to bring the two together, then restart`, "m"));
    const found = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.equal(found.code, 0, found.stderr);
    assert.deepEqual(found.said, [`This board was already running on port ${base + 2}; run.config.json now says ${base + 2}.`,
                                  ...up(base + 2)]);
    assert.equal(box.readConfig(place).port, base + 2);
    assert.equal(held(place).pid, run.child.pid, "a second server was started");
    assert.equal(await canBind(base), true, "something was started on the configured pair");
    assert.equal(await canBind(base + 1), true);
  } finally {
    await box.cleanup(place);
  }
});

test("the pair picker steps by two past busy ports and Tailscale Serve targets", async () => {
  const base = await freeBlock(10);
  const place = box.sandbox("ports-picker", { config: { port: base } });
  const busy = await box.foreign(base + 3);   // the phone port of the first pair above
  try {
    // a rule of someone else's points at the next pair's phone port
    box.setTailscale(place, { serve: { TCP: { "443": { HTTPS: true } },
      Web: { [`${box.HOST}:443`]: { Handlers: { "/docs": { Proxy: `http://127.0.0.1:${base + 5}` } } } } } });
    const picked = await cli(place, [
      `print(cli.pick_pair(${base + 2}))`,
      `print(cli.pick_pair(${base + 2}, serve=False))`,
      `print(sorted(cli.serve_targets()))`,
    ]);
    assert.equal(picked.code, 0, picked.stderr);
    assert.deepEqual(picked.said, [String(base + 6), String(base + 4), `[${base + 5}]`]);
    // and a move goes there
    const other = await box.foreign(base);
    try {
      const moved = await cli(place, ["cli.cmd_run(['run'])"]);
      assert.equal(moved.code, 0, moved.stderr);
      assert.match(moved.said[0], new RegExp(`^Board moved to port ${base + 6}: something else is using ${base} or ${base + 1}\\.`));
      assert.equal(box.readConfig(place).port, base + 6);
    } finally { await box.closeServer(other); }
  } finally {
    await box.closeServer(busy);
    await box.cleanup(place);
  }
});

test("a move points this board's own Serve rule at the new pair, and bridge on and off know it", async () => {
  const base = await freeBlock(6);
  const place = box.sandbox("ports-bridge", { config: { port: base } });
  execFileSync(box.PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: place.app });
  box.setTailscale(place, { serve: servingRule(base + 1) });
  const other = await webApp(base);
  try {
    const moved = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.equal(moved.code, 0, moved.stderr);
    assert.equal(moved.said[0], `Board moved to port ${base + 2}: something else is using ${base} or ${base + 1}. ` +
                 `It stays on ${base + 2}, and run.config.json now says so. The phone link points there too.`);
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 3}`);
    const line = bridgeLog(place).find(entry => entry.kind === "sharemoved");
    assert.ok(line, "the move was not written down");
    assert.equal(line.port, base + 2);
    assert.equal(line.previous, base);
    assert.equal("moved_from" in box.readConfig(place), false, "a finished move left moved_from behind");

    const mutations = () => box.tailscaleCalls(place).filter(c => c[0] === "serve" && c[1] !== "status").length;
    const count = mutations();
    const on = await command(place, ["bridge", "on"]);
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /Scan the QR code/);
    assert.equal(mutations(), count, "bridge on changed a rule that was already this board's");
    const off = await command(place, ["bridge", "off"]);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /^Bridge is off\.$/m);
    assert.equal(rootTarget(place), null);
  } finally {
    await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("a move that cannot point the link says so, and bridge on or off finishes it later", async () => {
  const base = await freeBlock(6);
  const place = box.sandbox("ports-bridge-later", { config: { port: base } });
  execFileSync(box.PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`], { cwd: place.app });
  box.setTailscale(place, { status: { ...box.CONNECTED, BackendState: "Stopped" }, serve: servingRule(base + 1) });
  const other = await webApp(base);
  try {
    const moved = await cli(place, ["cli.cmd_run(['run'])"]);
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(moved.said, [
      `Board moved to port ${base + 2}: something else is using ${base} or ${base + 1}. It stays on ${base + 2}, and run.config.json now says so.`,
      `The phone link was not moved (tailscale: not connected; no changes made); if it was on, it still points at port ${base + 1}. ` +
      `Run facilitator bridge on to point it at ${base + 3}.`,
      ...up(base + 2),
    ]);
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 1}`, "the rule changed although nothing could be checked");
    assert.equal(box.readConfig(place).moved_from, base);

    // Tailscale is back: bridge on moves the old rule across
    box.setTailscale(place, { serve: box.serveState(place) });
    const on = await command(place, ["bridge", "on"]);
    assert.equal(on.code, 0, on.stderr);
    assert.match(on.stdout, /Scan the QR code/);
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 3}`);
    assert.equal("moved_from" in box.readConfig(place), false);
    assert.equal(box.readConfig(place).port, base + 2);

    // the same left-behind rule, and off takes it away instead
    box.setTailscale(place, { serve: servingRule(base + 1) });
    box.writeConfig(place.app, { port: base + 2, lanes: [], moved_from: base });
    const dry = await command(place, ["bridge", "off", "--dry-run"]);
    assert.match(dry.stdout, new RegExp(`^bridge: would take the phone link off port ${base + 1}$`, "m"));
    const off = await command(place, ["bridge", "off"]);
    assert.equal(off.code, 0, off.stderr);
    assert.match(off.stdout, /^Bridge is off\.$/m);
    assert.equal(rootTarget(place), null);
    assert.equal("moved_from" in box.readConfig(place), false);
  } finally {
    await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("install writes the default pair when it is free and the next free pair when it is not", async () => {
  const base = await freeBlock(4);
  const place = box.sandbox("ports-install", { config: null });
  for (const name of ["run.config.example.json", "seed.example.json"])
    fs.copyFileSync(path.join(box.ROOT, name), path.join(place.app, name));
  const example = fs.readFileSync(path.join(place.app, "run.config.example.json"), "utf8");
  const target = path.join(place.app, "run.config.json");
  try {
    const free = await cli(place, [`cli.DEFAULT_PORT = ${base}`, "cli.ensure_config()"]);
    assert.equal(free.code, 0, free.stderr);
    assert.ok(free.said.some(line => line.endsWith("Board settings created.")), free.said.join("\n"));
    assert.ok(!free.said.some(line => /in use/.test(line)), "a free default pair was called in use");
    assert.equal(fs.readFileSync(target, "utf8"), example.replace('"port": 8877', `"port": ${base}`));

    fs.rmSync(target);
    const other = await box.foreign(base + 1);
    try {
      const busy = await cli(place, [`cli.DEFAULT_PORT = ${base}`, "cli.ensure_config()"]);
      assert.equal(busy.code, 0, busy.stderr);
      assert.ok(busy.said.some(line => line.endsWith("Board settings created.")), busy.said.join("\n"));
      assert.ok(!busy.said.some(line => /in use/.test(line)), "the install announced the move to other ports");
      assert.equal(fs.readFileSync(target, "utf8"), example.replace('"port": 8877', `"port": ${base + 2}`));
      // a config that is already there is never touched
      fs.writeFileSync(target, '{"port": 1234, "lanes": []}');
      const kept = await cli(place, [`cli.DEFAULT_PORT = ${base}`, "cli.ensure_config()"]);
      assert.equal(kept.code, 0, kept.stderr);
      assert.equal(fs.readFileSync(target, "utf8"), '{"port": 1234, "lanes": []}');
    } finally { await box.closeServer(other); }
  } finally {
    await box.cleanup(place);
  }
});

test("the agent skill's helper follows the port the config names, on every call", async () => {
  const base = await freeBlock(6);
  const mine = box.sandbox("ports-onboard", { config: { port: base } });
  const theirs = box.sandbox("ports-onboard-other", { config: { port: base + 2 } });
  fs.cpSync(path.join(box.ROOT, ".agents"), path.join(mine.app, ".agents"), { recursive: true });
  const helper = path.join(mine.app, ".agents", "skills", "facilitator", "scripts", "onboard.py");
  const inspect = async () => JSON.parse((await execFileAsync(box.PYTHON, [helper, "inspect", "--board", "facilitator"],
                                                             { cwd: mine.app, env: box.env(mine) })).stdout);
  try {
    const myPort = box.readConfig(mine).port, theirPort = box.readConfig(theirs).port;
    const first = box.launch(mine);
    await box.waitReady(first, myPort);
    await box.waitReady(box.launch(theirs), theirPort);
    let seen = await inspect();
    assert.equal(seen.status, "ready", JSON.stringify(seen));
    assert.equal(seen.port, myPort);
    // the board moved: the next call reads the new port
    first.child.kill("SIGTERM");
    await box.waitFree(myPort);
    const moved = base + 4;
    box.writeConfig(mine.app, { port: moved, lanes: [] });
    seen = await inspect();
    assert.equal(seen.status, "down");
    assert.equal(seen.port, moved);
    await box.waitReady(box.launch(mine), moved);
    seen = await inspect();
    assert.equal(seen.status, "ready", JSON.stringify(seen));
    assert.equal(seen.port, moved);
    // a port where another folder's board answers is never taken for this one
    box.writeConfig(mine.app, { port: theirPort, lanes: [] });
    seen = await inspect();
    assert.equal(seen.status, "different_board");
    assert.equal(seen.port, theirPort);
  } finally {
    await box.cleanup(mine);
    await box.cleanup(theirs);
  }
});
