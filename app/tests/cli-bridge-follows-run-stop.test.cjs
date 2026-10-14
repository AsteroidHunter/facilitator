// The phone bridge follows `facilitator run` and `facilitator stop`. On a
// checkout with a phone password, run leaves the link on once the board
// answers and stop takes it off once the server is gone, each through the code
// and checks of `facilitator bridge on` and `off`, silently when all goes well
// and in one line when it cannot. A checkout with no password is left alone.
//
// Every board here is a sandbox copy on ports the operating system handed out,
// Tailscale is tests/fixtures/fake-tailscale.py, first on PATH, and the CLI is
// driven through its own functions with the window and Chrome stubbed out, so
// nothing real is signalled, opened or served.
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
const ROOT = box.ROOT;

const up = port => [`Board up on http://127.0.0.1:${port}`, "Facilitator is live!"];
const ON_LINE = why => `The phone link is off (${why}). Run facilitator bridge on when that is fixed.`;
const OFF_LINE = why => `The phone link could not be taken off (${why}). Run facilitator bridge off when that is fixed.`;
const NOTE = "A phone bridge is active. Turn it off with: facilitator bridge off";
const MOVED = (old, next) => `Board moved to port ${next}: something else is using ${old} or ${old + 1}. ` +
  `It stays on ${next}, and run.config.json now says so.`;

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

// other people's Serve entries, none of which run or stop may touch: another
// path on the same endpoint, another port with its own root and Funnel, and a
// named Service
const OTHER_SERVE = {
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    [`${box.HOST}:443`]: { Handlers: { "/docs": { Proxy: "http://127.0.0.1:9" } } },
    [`${box.HOST}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } },
  },
  AllowFunnel: { [`${box.HOST}:8443`]: true },
  Services: { "svc:docs": { TCP: { "443": { HTTPS: true } } } },
};

function rootTarget(place) {
  const web = box.serveState(place).Web || {};
  const root = web[`${box.HOST}:443`]?.Handlers?.["/"];
  return root ? root.Proxy : null;
}

function mutations(place) {
  return box.tailscaleCalls(place).filter(c => c[0] === "serve" && c[1] !== "status");
}

function bridgeLog(place) {
  if (!fs.existsSync(place.logs)) return [];
  return fs.readdirSync(place.logs).filter(name => name.startsWith("bridge-"))
    .flatMap(name => fs.readFileSync(path.join(place.logs, name), "utf8").split("\n").filter(Boolean).map(JSON.parse));
}

// a sandbox board that is not running, on a pair of its own; a password makes
// it a checkout whose phone client is set up
async function board(name, { password = true, serve = {}, status, control, port } = {}) {
  port = port || await box.freePortPair();
  const place = box.sandbox(name, { config: { port } });
  if (password) {
    execFileSync(box.PYTHON, ["-c", `import bridge_auth; bridge_auth.set_password(${JSON.stringify(PASS)})`],
                 { cwd: place.app });
  }
  box.setTailscale(place, { status, serve, control });
  return { place, port };
}

// the CLI loaded as a module in a sandbox, with the window and Chrome stubbed:
// every page it would open is recorded instead. change_bridge is watched: each
// Serve change is written down with whether the board answered at that moment
async function cli(place, port, lines, extra = {}) {
  const code = [
    "import importlib.machinery, importlib.util, json, sys",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(place.app, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
    "WINDOWS = []",
    "SEEN = []",
    "cli.open_app = lambda cfg, dry: WINDOWS.append(cli.window_url(cfg))",
    "cli.chrome_windows = lambda: []",
    "_change = cli.change_bridge",
    "def _watched(ts, command, action):",
    "    SEEN.append([action, cli.state(PORT) is not None])",
    "    return _change(ts, command, action)",
    "cli.change_bridge = _watched",
    `PORT = ${port}`,
    "try:",
    ...lines.map(line => "    " + line),
    "finally:",
    "    sys.stdout.flush()",
    "    print('WINDOWS ' + json.dumps(WINDOWS))",
    "    print('SEEN ' + json.dumps(SEEN))",
  ].join("\n");
  const done = await execFileAsync(box.PYTHON, ["-c", code], { cwd: place.app, env: box.env(place, extra), timeout: 90000 })
    .then(ok => ({ code: 0, ...ok }), error => error);
  const all = String(done.stdout || "").split("\n");
  const take = prefix => {
    const at = all.findIndex(line => line.startsWith(prefix));
    return at === -1 ? [] : JSON.parse(all[at].slice(prefix.length));
  };
  return { code: done.code, stderr: String(done.stderr || ""),
           said: all.filter(line => line && !line.startsWith("WINDOWS ") && !line.startsWith("SEEN ")),
           windows: take("WINDOWS "), seen: take("SEEN ") };
}

const run = (place, port, flags = []) => cli(place, port, [`cli.cmd_run(${JSON.stringify(["run", ...flags])})`]);
const stop = (place, port, flags = [], extra = []) =>
  cli(place, port, [...extra, `cli.cmd_stop(${JSON.stringify(["stop", ...flags])})`]);

function serverPid(place) {
  return JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8")).pid;
}

// a sandbox's own server, ended for certain even when it ignores SIGTERM
function killOwnServer(place) {
  try {
    const pid = serverPid(place);
    const line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (line.includes(path.join(place.app, "server.py"))) process.kill(pid, "SIGKILL");
  } catch {}
}

async function answers(port) {
  return fetch(`http://127.0.0.1:${port}/state`).then(() => true, () => false);
}

test("run leaves the phone link on once the board answers, and says nothing more", async () => {
  const { place, port } = await board("follow-run-on");
  try {
    const first = await run(place, port);
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.said, up(port), "run printed more than it always has (a code, a line)");
    assert.deepEqual(first.windows, [`http://127.0.0.1:${port}`]);
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    assert.deepEqual(first.seen, [["on", true]], "the link was changed before the board answered");
    assert.equal(mutations(place).length, 1);
    assert.deepEqual(bridgeLog(place).filter(entry => entry.kind === "shareon").map(entry => entry.port), [port]);

    const again = await run(place, port);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(again.said, up(port));
    assert.deepEqual(again.seen, [], "a link that was already on was changed");
    assert.equal(mutations(place).length, 1);
  } finally {
    await box.cleanup(place);
  }
});

test("a link already on and pointing at this board is left exactly as it is", async () => {
  const port = await box.freePortPair();
  const { place } = await board("follow-run-already", { port, serve: servingRule(port + 1) });
  try {
    const before = box.serveState(place);
    const started = await run(place, port);
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(started.said, up(port));
    assert.deepEqual(mutations(place), []);
    assert.deepEqual(box.serveState(place), before);
    assert.equal(bridgeLog(place).length, 0, "an unchanged link was written down as a change");
  } finally {
    await box.cleanup(place);
  }
});

test("run keeps other Serve entries, whatever it does to the root", async () => {
  const { place, port } = await board("follow-run-others", { serve: OTHER_SERVE });
  try {
    const started = await run(place, port);
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(started.said, up(port));
    const serve = box.serveState(place);
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    assert.deepEqual(serve.Web[`${box.HOST}:443`].Handlers["/docs"], { Proxy: "http://127.0.0.1:9" });
    assert.deepEqual(serve.Web[`${box.HOST}:8443`], OTHER_SERVE.Web[`${box.HOST}:8443`]);
    assert.deepEqual(serve.AllowFunnel, OTHER_SERVE.AllowFunnel);
    assert.deepEqual(serve.Services, OTHER_SERVE.Services);
  } finally {
    await box.cleanup(place);
  }
});

const CANNOT = [
  ["Tailscale not connected", { status: { ...box.CONNECTED, BackendState: "Stopped" } }, {},
    ON_LINE("tailscale: not connected; no changes made")],
  ["HTTPS certificates off", { status: { ...box.CONNECTED, CertDomains: [] } }, {},
    ON_LINE("Tailscale HTTPS is off for this tailnet: switch on HTTPS certificates under DNS in the Tailscale " +
            "admin console, then run facilitator bridge again.")],
  ["another service on the root", {}, {
    TCP: { "443": { HTTPS: true } },
    Web: { [`${box.HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9" } } } } },
    ON_LINE("tailscale: another service owns the HTTPS root on port 443; no changes made")],
  ["Funnel on the endpoint", {}, { AllowFunnel: { [`${box.HOST}:443`]: true } },
    ON_LINE("tailscale: Funnel is using HTTPS port 443; no changes made")],
];

for (const [name, tailscale, serve, line] of CANNOT) {
  test(`run says in one line that the phone link is off when ${name}, and the board is up all the same`, async () => {
    const { place, port } = await board("follow-run-cannot", { status: tailscale.status, serve });
    try {
      const before = box.serveState(place);
      const started = await run(place, port);
      assert.equal(started.code, 0, started.stderr);
      assert.deepEqual(started.said, [...up(port), line]);
      assert.equal(await answers(port), true, "the board is not up");
      assert.deepEqual(mutations(place), [], "something was changed although the checks failed");
      assert.deepEqual(box.serveState(place), before);
    } finally {
      await box.cleanup(place);
    }
  });
}

test("with no Tailscale installed, run says the link is off and stop has nothing to take off", async () => {
  const { place, port } = await board("follow-no-tailscale");
  const none = "cli.find_tailscale = lambda: None";
  try {
    const started = await cli(place, port, [none, "cli.cmd_run(['run'])"]);
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(started.said, [...up(port),
      ON_LINE("tailscale: not found on PATH or at /Applications/Tailscale.app/Contents/MacOS/Tailscale")]);
    assert.equal(await answers(port), true);

    const stopped = await stop(place, port, [], [none]);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped."]);
  } finally {
    await box.cleanup(place);
  }
});

test("run on a checkout with no phone password touches nothing and says nothing about the bridge", async () => {
  // the one call left is the server's own, a read of the Serve rules before it binds
  for (const [label, status] of [["connected", undefined], ["stopped", { ...box.CONNECTED, BackendState: "Stopped" }]]) {
    const { place, port } = await board("follow-run-nopass", { password: false, status });
    try {
      const started = await run(place, port);
      assert.equal(started.code, 0, `${label}: ${started.stderr}`);
      assert.deepEqual(started.said, up(port), label);
      assert.deepEqual(box.tailscaleCalls(place), [["serve", "status", "--json"]], `${label}: the command asked tailscale`);

      // a password file that is not one is no password
      fs.writeFileSync(path.join(place.app, "bridge-auth.json"), "{}");
      const again = await run(place, port);
      assert.deepEqual(again.said, up(port), label);
      assert.deepEqual(box.tailscaleCalls(place), [["serve", "status", "--json"]], `${label}: the command asked tailscale`);
    } finally {
      await box.cleanup(place);
    }
  }
});

test("run after a move points the link at the new pair, and that is all it does", async () => {
  const base = await freeBlock(6);
  const place = (await board("follow-run-moved", { port: base })).place;
  box.setTailscale(place, { serve: servingRule(base + 1) });
  const other = await webApp(base);
  try {
    const moved = await run(place, base);
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(moved.said, [MOVED(base, base + 2) + " The phone link points there too.", ...up(base + 2)]);
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 3}`);
    assert.deepEqual(moved.seen.map(([action]) => action), ["off", "on"],
      "run changed the link beyond the move");
    assert.equal(mutations(place).length, 2);
  } finally {
    await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("run after a move with the link off puts it on at the new pair", async () => {
  const base = await freeBlock(6);
  const place = (await board("follow-run-moved-off", { port: base })).place;
  const other = await webApp(base);
  try {
    const moved = await run(place, base);
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(moved.said, [MOVED(base, base + 2), ...up(base + 2)]);
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 3}`);
    assert.deepEqual(moved.seen.map(([action]) => action), ["on"]);
    assert.equal(mutations(place).length, 1);
  } finally {
    await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("a move that could not point the link gets no second line, and the next run finishes it silently", async () => {
  const base = await freeBlock(6);
  const place = (await board("follow-run-moved-later", { port: base })).place;
  box.setTailscale(place, { status: { ...box.CONNECTED, BackendState: "Stopped" }, serve: servingRule(base + 1) });
  const other = await webApp(base);
  try {
    const moved = await run(place, base);
    assert.equal(moved.code, 0, moved.stderr);
    assert.deepEqual(moved.said, [
      MOVED(base, base + 2),
      `The phone link was not moved (tailscale: not connected; no changes made); if it was on, it still points at ` +
        `port ${base + 1}. Run facilitator bridge on to point it at ${base + 3}.`,
      ...up(base + 2),
    ]);
    assert.equal(box.readConfig(place).moved_from, base);

    box.setTailscale(place, { serve: box.serveState(place) });
    const later = await run(place, base + 2);
    assert.equal(later.code, 0, later.stderr);
    assert.deepEqual(later.said, up(base + 2));
    assert.equal(rootTarget(place), `http://127.0.0.1:${base + 3}`);
    assert.equal("moved_from" in box.readConfig(place), false, "the finished move left moved_from behind");
  } finally {
    await box.closeServer(other);
    await box.cleanup(place);
  }
});

test("stop takes the link off once the server is gone, keeps every other Serve entry, and says nothing more", async () => {
  const { place, port } = await board("follow-stop-on", { serve: OTHER_SERVE });
  try {
    const started = await run(place, port);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);

    const stopped = await stop(place, port);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped."], "stop printed a line about the link, or the old note");
    assert.deepEqual(stopped.seen, [["off", false]], "the link came off while the server was still answering");
    assert.equal(rootTarget(place), null);
    assert.deepEqual(box.serveState(place), OTHER_SERVE, "stop changed more than this board's root handler");
    assert.deepEqual(bridgeLog(place).filter(entry => entry.kind === "shareoff").map(entry => entry.port), [port]);
    assert.equal(await answers(port), false);
  } finally {
    await box.cleanup(place);
  }
});

test("stop says nothing about a link that is already off", async () => {
  const { place, port } = await board("follow-stop-off", { status: { ...box.CONNECTED, BackendState: "Stopped" } });
  try {
    const started = await run(place, port);
    assert.equal(started.said.length, 3, "run did not say the link is off");
    box.setTailscale(place, {});
    const before = mutations(place).length;

    const stopped = await stop(place, port);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped."]);
    assert.equal(mutations(place).length, before);
    assert.equal(rootTarget(place), null);
  } finally {
    await box.cleanup(place);
  }
});

test("a board that was not running still has its link taken off by stop", async () => {
  const { place, port } = await board("follow-stop-idle");
  box.setTailscale(place, { serve: servingRule(port + 1) });
  try {
    const stopped = await stop(place, port);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board was not running."]);
    assert.equal(rootTarget(place), null);
    assert.deepEqual(stopped.seen, [["off", false]]);
  } finally {
    await box.cleanup(place);
  }
});

test("a link that cannot be read is one line from stop, and the board still stops", async () => {
  const { place, port } = await board("follow-stop-blind");
  try {
    const started = await run(place, port);
    assert.deepEqual(started.said, up(port));
    box.setTailscale(place, { serve: box.serveState(place), control: { status_mode: "fail" } });

    const stopped = await stop(place, port);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped.", OFF_LINE("tailscale: status failed; no changes made")]);
    assert.equal(await answers(port), false);
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`, "a link that could not be checked was changed");
  } finally {
    await box.cleanup(place);
  }
});

test("a stop that leaves the server running leaves the link as it is, and asks nothing of Tailscale", async () => {
  const { place, port } = await board("follow-stop-refused");
  const handlers = "    for stopper in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):\n"
    + "        signal.signal(stopper, stopping)\n";
  const source = fs.readFileSync(path.join(place.app, "server.py"), "utf8");
  assert.ok(source.includes(handlers), "the server's signal handlers are not where this test patches them");
  fs.writeFileSync(path.join(place.app, "server.py"), source.replace(handlers, () =>
    "    for stopper in (signal.SIGINT, signal.SIGHUP):\n        signal.signal(stopper, stopping)\n"
    + "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"));
  try {
    const started = await run(place, port);
    assert.deepEqual(started.said, up(port));
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    const asked = box.tailscaleCalls(place).length;

    const refused = await stop(place, port, [], ["cli.STOP_WAIT = 1.0"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /stop: .*left alone\..*facilitator stop --force/);
    assert.deepEqual(refused.said, [], "a refused stop printed something on stdout");
    assert.equal(await answers(port), true, "the board stopped answering after a refused stop");
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    assert.equal(box.tailscaleCalls(place).length, asked, "a refused stop asked Tailscale something");
    assert.deepEqual(refused.seen, []);
  } finally {
    killOwnServer(place);
    await box.cleanup(place);
  }
});

test("on a checkout with no phone password stop keeps its old note and changes no rule", async () => {
  const { place, port } = await board("follow-stop-nopass", { password: false });
  box.setTailscale(place, { serve: servingRule(port + 1) });
  try {
    const started = await run(place, port);
    assert.deepEqual(started.said, up(port));

    const stopped = await stop(place, port);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.deepEqual(stopped.said, ["Board stopped.", NOTE]);
    assert.deepEqual(mutations(place), []);
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    assert.deepEqual(stopped.seen, []);
  } finally {
    await box.cleanup(place);
  }
});

test("run --dry-run names the bridge step and changes nothing", async () => {
  const { place, port } = await board("follow-dry-run");
  try {
    const dry = await run(place, port, ["--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.said.at(-1), "bridge: would leave the phone link on, as facilitator bridge on does; " +
                                  "nothing changes when it already is");
    assert.equal(dry.said.length, 2, dry.said.join("\n"));
    assert.deepEqual(box.tailscaleCalls(place), [], "a dry run asked Tailscale something");
    assert.equal(await answers(port), false, "a dry run started the board");
    assert.equal(rootTarget(place), null);
  } finally {
    await box.cleanup(place);
  }

  const bare = await board("follow-dry-run-nopass", { password: false });
  try {
    const dry = await run(bare.place, bare.port, ["--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.said.length, 1, dry.said.join("\n"));
    assert.doesNotMatch(dry.said.join("\n"), /bridge|phone/);
  } finally {
    await box.cleanup(bare.place);
  }
});

test("stop --dry-run names the bridge step and changes nothing", async () => {
  const { place, port } = await board("follow-dry-stop");
  try {
    const started = await run(place, port);
    assert.deepEqual(started.said, up(port));
    const asked = box.tailscaleCalls(place).length;

    const dry = await stop(place, port, ["--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.said.length, 2, dry.said.join("\n"));
    assert.match(dry.said[0], /^stop \(dry run\): would stop the board on port \d+ \(pid \d+\)/);
    assert.equal(dry.said[1], "stop (dry run): once the server is gone, the phone link would be taken off, " +
                              "as facilitator bridge off does.");
    assert.equal(await answers(port), true, "a dry run stopped the board");
    assert.equal(rootTarget(place), `http://127.0.0.1:${port + 1}`);
    assert.equal(box.tailscaleCalls(place).length, asked, "a dry run asked Tailscale something");
  } finally {
    await box.cleanup(place);
  }

  const bare = await board("follow-dry-stop-nopass", { password: false });
  try {
    const started = await run(bare.place, bare.port);
    assert.deepEqual(started.said, up(bare.port));
    const dry = await stop(bare.place, bare.port, ["--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.said.length, 1, dry.said.join("\n"));
    assert.doesNotMatch(dry.said.join("\n"), /phone link/);
  } finally {
    await box.cleanup(bare.place);
  }
});

test("restart still touches no bridge, and the usage says what run and stop now do", () => {
  const source = fs.readFileSync(path.join(ROOT, "facilitator"), "utf8");
  const restart = source.slice(source.indexOf("def cmd_restart("), source.indexOf("def stop_target("));
  assert.ok(restart.includes("def cmd_restart("), "the restart code is not where it was");
  for (const word of ["follow_bridge", "switch_bridge", "bridge_set_up", "bridge_note", "repoint_bridge"])
    assert.ok(!restart.includes(word), `restart reaches ${word}`);

  const opening = source.indexOf('"""');
  const usage = source.slice(opening, source.indexOf('"""', opening + 3));
  const part = (from, to) => usage.slice(usage.indexOf(from), usage.indexOf(to));
  const runUsage = part("  facilitator run ", "  facilitator restart ");
  const restartUsage = part("  facilitator restart ", "  facilitator stop ");
  const stopUsage = part("  facilitator stop ", "  facilitator status");
  assert.match(runUsage.replace(/\s+/g, " "), /leaves the phone bridge on/);
  assert.match(restartUsage.replace(/\s+/g, " "), /no bridge/);
  assert.match(stopUsage.replace(/\s+/g, " "), /the phone bridge is taken off/);
  assert.doesNotMatch(stopUsage.replace(/\s+/g, " "), /no bridge/);
});
