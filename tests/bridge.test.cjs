// The persistent bridge command against a stateful fake Tailscale binary.
// Every server and file is invented, and the OS assigns every port. These
// tests never query or mutate the machine's real Tailscale state.
const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const {
  chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const HOST = "fixture.tail0000.ts.net";
const HOST_PORT = `${HOST}:443`;
const CONNECTED = {
  BackendState: "Running",
  CertDomains: [HOST],
  Self: { DNSName: HOST + "." },
};

let board;
let gate;
let gateConfigured = true;
let boardPort;
let fixtureDir;
let binDir;
let fakeDir;
let cli;
let logsDir;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boardProxy(port = boardPort + 1) {
  return `http://127.0.0.1:${port}`;
}

function servingBoard(extraHandlers = {}) {
  return {
    TCP: { "443": { HTTPS: true } },
    Web: {
      [HOST_PORT]: {
        Handlers: { "/": { Proxy: boardProxy() }, ...clone(extraHandlers) },
      },
    },
  };
}

function unrelatedConfig() {
  return {
    TCP: {
      "443": { HTTPS: true },
      "8443": { HTTPS: true },
      "2222": { TCPForward: "127.0.0.1:22" },
    },
    Web: {
      [HOST_PORT]: {
        Handlers: { "/docs": { Proxy: "http://127.0.0.1:9101" } },
      },
      [`${HOST}:8443`]: {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9102" } },
      },
    },
    AllowFunnel: { [`${HOST}:8443`]: true },
    Services: {
      "svc:notes": {
        TCP: { "443": { HTTPS: true } },
        Web: {
          "notes.tail0000.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9103" } },
          },
        },
      },
    },
    Foreground: {
      "invented-session": {
        TCP: { "9443": { HTTPS: true } },
        Web: {
          [`${HOST}:9443`]: {
            Handlers: { "/": { Proxy: "http://127.0.0.1:9104" } },
          },
        },
      },
    },
  };
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value));
}

async function resetFake({ status = CONNECTED, serve = {}, control = {} } = {}) {
  gateConfigured = true;
  await rm(fakeDir, { recursive: true, force: true });
  await mkdir(fakeDir, { recursive: true });
  await writeJson(path.join(fakeDir, "status.json"), status);
  await writeJson(path.join(fakeDir, "serve.json"), serve);
  await writeJson(path.join(fakeDir, "control.json"), control);
  await rm(logsDir, { recursive: true, force: true });
  await writeJson(path.join(fixtureDir, "run.config.json"), { port: boardPort, lanes: [] });
}

async function fakeCalls() {
  try {
    return (await readFile(path.join(fakeDir, "calls.jsonl"), "utf8"))
      .trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function mutations(calls) {
  return calls.filter(args => args[0] === "serve" && args[1] !== "status");
}

async function serveState() {
  return JSON.parse(await readFile(path.join(fakeDir, "serve.json"), "utf8"));
}

async function bridgeLogs() {
  try {
    const names = (await readdir(logsDir)).filter(name => name.startsWith("bridge-")).sort();
    const lines = [];
    for (const name of names) {
      const text = await readFile(path.join(logsDir, name), "utf8");
      lines.push(...text.split("\n").filter(Boolean).map(JSON.parse));
    }
    return lines;
  } catch {
    return [];
  }
}

async function bridge(args = [], options = {}) {
  const env = {
    ...process.env,
    PATH: binDir + path.delimiter + process.env.PATH,
    TS_FAKE_DIR: fakeDir,
    FACILITATOR_LOG_DIR: logsDir,
    ...options.env,
  };
  const started = Date.now();
  try {
    const result = await run(PYTHON, [options.cli || cli, "bridge", ...args], {
      cwd: fixtureDir,
      env,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, ...result, elapsed: Date.now() - started };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      elapsed: Date.now() - started,
    };
  }
}

async function expectedEnableOutput() {
  const rendered = await run(PYTHON, ["-c", [
    "import qr, sys",
    "for line in qr.render(qr.encode(sys.argv[1])):",
    "    print('  ' + line)",
  ].join("\n"), `https://${HOST}/m`], { cwd: fixtureDir });
  return rendered.stdout +
    "\nScan the QR code to access facilitator on your phone 🦑\n" +
    "\nRun `facilitator bridge off` to sever the phone session.\n";
}

function assertPrivateOutputHidden(result) {
  assert.doesNotMatch(result.stdout + result.stderr,
    /PRIVATE_(?:STATUS|SERVE_STATUS|MUTATION|SUCCESS)/);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-bridge-toggle-"));
  binDir = path.join(fixtureDir, "bin");
  fakeDir = path.join(fixtureDir, "fake-state");
  logsDir = path.join(fixtureDir, "logs");
  cli = path.join(fixtureDir, "facilitator");
  await mkdir(binDir);
  await copyFile(path.join(ROOT, "facilitator"), cli);
  await copyFile(path.join(ROOT, "qr.py"), path.join(fixtureDir, "qr.py"));
  const fake = path.join(binDir, "tailscale");
  await copyFile(path.join(ROOT, "tests", "fixtures", "fake-tailscale.py"), fake);
  await chmod(fake, 0o755);

  board = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ boxes: [], queued: 0, listening: {}, listenerGap: {}, busy: {} }));
  });
  gate = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ authenticated: false, configured: gateConfigured }));
  });
  for (;;) {
    await new Promise((resolve, reject) => {
      board.once("error", reject);
      board.listen(0, "127.0.0.1", resolve);
    });
    boardPort = board.address().port;
    try {
      await new Promise((resolve, reject) => {
        gate.once("error", reject);
        gate.listen(boardPort + 1, "127.0.0.1", resolve);
      });
      break;
    } catch {
      await new Promise(resolve => board.close(resolve));
    }
  }
});

beforeEach(async () => {
  await resetFake();
});

after(async () => {
  if (board) await new Promise(resolve => board.close(resolve));
  if (gate) await new Promise(resolve => gate.close(resolve));
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("toggle from off enables persistently, preserves unrelated config, and prints only the requested QR card", async () => {
  const original = unrelatedConfig();
  await resetFake({ serve: original });

  const result = await bridge();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.elapsed < 5000, "the persistent bridge command held the terminal open");
  assert.equal(result.stdout, await expectedEnableOutput());
  assert.doesNotMatch(result.stdout, /https:\/\//, "the private address was printed outside the QR");
  assertPrivateOutputHidden(result);

  const after = await serveState();
  const expected = clone(original);
  expected.Web[HOST_PORT].Handlers["/"] = { Proxy: boardProxy() };
  assert.deepEqual(after, expected,
    "enabling changed unrelated Serve, Funnel, foreground, or Service config");
  assert.deepEqual(mutations(await fakeCalls()), [
    ["serve", "--bg", "--https=443", "--set-path=/", boardProxy()],
  ]);
  const logs = await bridgeLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, "shareon");
  assert.equal(logs[0].port, boardPort);
  assert.ok(!("reason" in logs[0]));

  // The process is gone but the fake daemon still holds the mapping. A
  // repeated `on` is read-only and prints the same way in.
  const again = await bridge(["on"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, await expectedEnableOutput());
  assert.deepEqual(await serveState(), expected);
  assert.equal(mutations(await fakeCalls()).length, 1, "repeated on mutated Serve again");
  assert.equal((await bridgeLogs()).length, 1, "repeated on logged another transition");
});

test("old unguarded Serve root must be removed before the protected bridge can start", async () => {
  const legacy = servingBoard();
  legacy.Web[HOST_PORT].Handlers["/"].Proxy = boardProxy(boardPort);
  await resetFake({ serve: legacy });
  const enable = await bridge(["on"]);
  assert.equal(enable.code, 1);
  assert.match(enable.stderr, /old unguarded bridge.*bridge off/);
  assert.deepEqual(mutations(await fakeCalls()), []);
  const disable = await bridge(["off"]);
  assert.equal(disable.code, 0, disable.stderr);
  assert.equal((await serveState()).Web?.[HOST_PORT]?.Handlers?.["/"], undefined);
});

test("an unconfigured password gate refuses Serve enablement", async () => {
  gateConfigured = false;
  const enable = await bridge(["on"]);
  assert.equal(enable.code, 1);
  assert.match(enable.stderr, /facilitator password set/);
  assert.deepEqual(mutations(await fakeCalls()), []);
});

test("toggle from on removes only facilitator's root and explicit off is idempotent", async () => {
  const original = unrelatedConfig();
  original.Web[HOST_PORT].Handlers["/"] = { Proxy: boardProxy() };
  await resetFake({ serve: original });

  let result = await bridge();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Bridge is off.\n");
  assert.equal(result.stderr, "");
  const expected = unrelatedConfig();
  assert.deepEqual(await serveState(), expected,
    "off changed another path, port, Funnel route, foreground session, or named Service");
  assert.deepEqual(mutations(await fakeCalls()), [
    ["serve", "--https=443", "--set-path=/", "off"],
  ]);
  assert.deepEqual((await bridgeLogs()).map(line => line.kind), ["shareoff"]);

  result = await bridge(["off"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Bridge is off.\n");
  assert.deepEqual(await serveState(), expected);
  assert.equal(mutations(await fakeCalls()).length, 1, "repeated off mutated Serve again");
  assert.deepEqual((await bridgeLogs()).map(line => line.kind), ["shareoff"]);
});

test("turning off the only root removes its unused listener without touching other ports", async () => {
  const original = servingBoard();
  original.TCP["2222"] = { TCPForward: "127.0.0.1:22" };
  original.AllowFunnel = { [`${HOST}:8443`]: true };
  original.Services = unrelatedConfig().Services;
  await resetFake({ serve: original });
  const result = await bridge(["off"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Bridge is off.\n");
  assert.deepEqual(await serveState(), {
    TCP: { "2222": { TCPForward: "127.0.0.1:22" } },
    AllowFunnel: { [`${HOST}:8443`]: true },
    Services: original.Services,
  });
});

test("dry runs inspect state, help is side-effect free, and both changes are shown narrowly", async () => {
  const original = unrelatedConfig();
  await resetFake({ serve: original });
  let result = await bridge(["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout,
    new RegExp(`^bridge: would run .*tailscale serve --bg --https=443 --set-path=/ http://127\\.0\\.0\\.1:${boardPort + 1}\\n$`));
  assert.equal(mutations(await fakeCalls()).length, 0);
  assert.deepEqual(await serveState(), original);

  const on = clone(original);
  on.Web[HOST_PORT].Handlers["/"] = { Proxy: boardProxy() };
  await resetFake({ serve: on });
  result = await bridge(["off", "--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout,
    /^bridge: would run .*tailscale serve --https=443 --set-path=\/ off\n$/);
  assert.equal(mutations(await fakeCalls()).length, 0);
  assert.deepEqual(await serveState(), on);

  await resetFake();
  result = await bridge(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^usage: facilitator bridge \[on\|off\] \[--dry-run\]$/m);
  assert.match(result.stdout, /`on` and `off` are idempotent/);
  assert.deepEqual(await fakeCalls(), [], "help queried Tailscale");
});

test("missing Tailscale, disconnected state, and a missing identity fail before mutation", async () => {
  const source = await readFile(cli, "utf8");
  const missing = source.replace(
    'TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
    'TAILSCALE_APP = "/invented/missing/Tailscale"');
  assert.notEqual(missing, source, "the missing-binary fixture did not patch the fallback");
  const missingCli = path.join(fixtureDir, "facilitator-no-tailscale");
  await writeFile(missingCli, missing);
  let result = await bridge(["on"], {
    cli: missingCli,
    env: { PATH: "/usr/bin:/bin" },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^tailscale: not found on PATH or at \/invented\/missing\/Tailscale$/m);
  assert.deepEqual(await fakeCalls(), []);

  await resetFake({ status: { ...CONNECTED, BackendState: "Stopped" } });
  result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "tailscale: not connected; no changes made\n");
  assert.equal(mutations(await fakeCalls()).length, 0);

  await resetFake({ status: { BackendState: "Running", CertDomains: [HOST], Self: {} } });
  result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /has no tailnet name yet/);
  assert.equal(mutations(await fakeCalls()).length, 0);
});

test("off can sever an existing bridge while disconnected or while HTTPS is unavailable", async () => {
  for (const status of [
    { ...CONNECTED, BackendState: "Stopped" },
    { ...CONNECTED, CertDomains: [] },
  ]) {
    await resetFake({ status, serve: servingBoard() });
    const result = await bridge(["off"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "Bridge is off.\n");
    assert.deepEqual(await serveState(), {});
  }
});

test("failed and malformed status responses never mutate config or leak private output", async () => {
  const cases = [
    {
      name: "status command failure",
      prepare: () => resetFake({ control: { status_mode: "fail" } }),
      message: /tailscale: status failed; no changes made/,
    },
    {
      name: "malformed status JSON",
      prepare: async () => {
        await resetFake();
        await writeFile(path.join(fakeDir, "status.json"), "not json");
      },
      message: /tailscale: status returned malformed JSON; no changes made/,
    },
    {
      name: "Serve status command failure",
      prepare: () => resetFake({ control: { serve_status_fail_calls: [1] } }),
      message: /tailscale: serve status failed; no changes made/,
    },
    {
      name: "malformed Serve status JSON",
      prepare: async () => {
        await resetFake();
        await writeFile(path.join(fakeDir, "serve.json"), "not json");
      },
      message: /tailscale: serve status returned malformed JSON; no changes made/,
    },
    {
      name: "malformed Serve shape",
      prepare: () => resetFake({ serve: { TCP: [], Web: {} } }),
      message: /tailscale: serve status is malformed; no changes made/,
    },
  ];
  for (const item of cases) {
    await item.prepare();
    const before = await readFile(path.join(fakeDir, "serve.json"), "utf8");
    const result = await bridge(["on"]);
    assert.equal(result.code, 1, item.name);
    assert.match(result.stderr, item.message, item.name);
    assert.equal(result.stdout, "", item.name);
    assertPrivateOutputHidden(result);
    assert.equal(mutations(await fakeCalls()).length, 0, item.name);
    assert.equal(await readFile(path.join(fakeDir, "serve.json"), "utf8"), before, item.name);
    assert.deepEqual(await bridgeLogs(), [], item.name);
  }
});

test("HTTPS disabled and board down are actionable refusals with no Serve mutation", async () => {
  await resetFake({ status: { ...CONNECTED, CertDomains: [] } });
  let result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr,
    "Tailscale HTTPS is off for this tailnet: switch on HTTPS certificates under DNS in the Tailscale admin console, then run facilitator bridge again.\n");
  assert.equal(mutations(await fakeCalls()).length, 0);

  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const unused = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await resetFake();
  await writeJson(path.join(fixtureDir, "run.config.json"), { port: unused, lanes: [] });
  result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, `server: DOWN (port ${unused}); run facilitator run first\n`);
  assert.equal(mutations(await fakeCalls()).length, 0);
});

test("permission failures and false Tailscale successes never print or log success", async () => {
  const original = unrelatedConfig();
  await resetFake({ serve: original, control: { mutation_mode: "fail" } });
  let result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr,
    /tailscale: could not turn the bridge on; inspect `tailscale serve status`/);
  assert.equal(result.stdout, "");
  assertPrivateOutputHidden(result);
  assert.deepEqual(await serveState(), original);
  assert.deepEqual(await bridgeLogs(), []);

  await resetFake({ serve: original, control: { mutation_mode: "noop" } });
  result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bridge is not safely on after Tailscale reported success/);
  assert.equal(result.stdout, "");
  assert.deepEqual(await serveState(), original);
  assert.deepEqual(await bridgeLogs(), []);

  await resetFake({ serve: servingBoard(), control: { mutation_mode: "noop" } });
  result = await bridge(["off"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bridge is still on after Tailscale reported success/);
  assert.doesNotMatch(result.stdout, /Bridge is off/);
  assert.deepEqual(await bridgeLogs(), []);
});

test("root, same-endpoint Funnel, foreground, and enhanced-handler conflicts are untouched", async () => {
  const foreignRoot = {
    TCP: { "443": { HTTPS: true } },
    Web: { [HOST_PORT]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9201" } } } },
  };
  const sameFunnel = {
    TCP: { "443": { HTTPS: true } },
    Web: { [HOST_PORT]: { Handlers: { "/docs": { Proxy: "http://127.0.0.1:9202" } } } },
    AllowFunnel: { [HOST_PORT]: true },
  };
  const ownedRootWithFunnel = servingBoard();
  ownedRootWithFunnel.AllowFunnel = { [HOST_PORT]: true };
  const foreground = {
    Foreground: {
      session: {
        TCP: { "443": { HTTPS: true } },
        Web: { [HOST_PORT]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9203" } } } },
      },
    },
  };
  const enhancedBoard = servingBoard();
  enhancedBoard.Web[HOST_PORT].Handlers["/"] = {
    Proxy: boardProxy(),
    AcceptAppCaps: ["example.test/capability"],
  };
  const unusualListener = servingBoard();
  unusualListener.TCP["443"].ExtraBehavior = true;
  const cases = [
    ["foreign root", foreignRoot, ["on"], /another service owns the HTTPS root/],
    ["same endpoint Funnel", sameFunnel, ["on"], /Funnel is using HTTPS port 443/],
    ["owned root plus Funnel toggle", ownedRootWithFunnel, [], /Funnel is using HTTPS port 443/],
    ["owned root plus Funnel off", ownedRootWithFunnel, ["off"], /Funnel is using HTTPS port 443/],
    ["owned root plus Funnel toggle dry run", ownedRootWithFunnel, ["--dry-run"], /Funnel is using HTTPS port 443/],
    ["owned root plus Funnel off dry run", ownedRootWithFunnel, ["off", "--dry-run"], /Funnel is using HTTPS port 443/],
    ["foreground session", foreground, ["on"], /foreground Serve session is using HTTPS port 443/],
    ["enhanced board handler on", enhancedBoard, ["on"], /configuration facilitator does not own/],
    ["enhanced board handler off", enhancedBoard, ["off"], /configuration facilitator does not own/],
    ["unusual listener", unusualListener, ["off"], /configuration facilitator does not own/],
  ];
  for (const [name, config, args, message] of cases) {
    await resetFake({ serve: config });
    const result = await bridge(args);
    assert.equal(result.code, 1, name);
    assert.match(result.stderr, message, name);
    assert.equal(result.stdout, "", name);
    assert.deepEqual(await serveState(), config, name);
    assert.equal(mutations(await fakeCalls()).length, 0, name);
    assert.deepEqual(await bridgeLogs(), [], name);
  }
});

test("a second board proxy at another mount is recognized as unowned and never cleared", async () => {
  const config = unrelatedConfig();
  config.Web[HOST_PORT].Handlers["/other-board"] = { Proxy: boardProxy() };
  await resetFake({ serve: config });
  for (const args of [["on"], ["off"], []]) {
    const result = await bridge(args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration facilitator does not own/);
    assert.deepEqual(await serveState(), config);
    assert.equal(mutations(await fakeCalls()).length, 0);
  }
});

test("precondition and post-mutation races abort without false success", async () => {
  const raced = {
    TCP: { "443": { HTTPS: true } },
    Web: { [HOST_PORT]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9301" } } } },
  };
  await resetFake({ control: { serve_status_replacements: { "2": raced } } });
  let result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr,
    "tailscale: serve configuration changed; no changes made, try again\n");
  assert.equal(result.stdout, "");
  assert.deepEqual(await serveState(), raced);
  assert.equal(mutations(await fakeCalls()).length, 0);
  assert.deepEqual(await bridgeLogs(), []);

  const other = {
    BackendState: "Running",
    CertDomains: ["other.tail0000.ts.net"],
    Self: { DNSName: "other.tail0000.ts.net." },
  };
  await resetFake({ control: { after_mutation_status: other } });
  result = await bridge(["on"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /tailnet identity changed while enabling the bridge/);
  assert.equal(result.stdout, "");
  assert.equal(mutations(await fakeCalls()).length, 1);
  assert.deepEqual(await bridgeLogs(), []);
});

// Apple's Vision decoder read this symbol when the dependency-free encoder
// was introduced. Reproducing it guards all encoded data and correction bits.
const KNOWN = [
  "11111110101001001111101111111", "10000010110010001100001000001",
  "10111010000111110011001011101", "10111010101110000100001011101",
  "10111010010001110001001011101", "10000010011110101011001000001",
  "11111110101010101010101111111", "00000000100101101100000000000",
  "10110111000111100101101001011", "10100100011010001001101110001",
  "11001010111110101100100000110", "00011101101001100000101110001",
  "01001110110100010111000001100", "01111100000101011111101000111",
  "11010010000100101001110100111", "01110101011111001011010010010",
  "00010010110010010000110111010", "01110101001001010010100101110",
  "10011110101110010010100010100", "00101001000100011100110110100",
  "01110110011101011101111111100", "00000000100101100000100011111",
  "11111110101011001101101011010", "10000010111110011000100011011",
  "10111010001010111110111110100", "10111010111000111001100011001",
  "10111010110000001110100100101", "10000010001100011010101111010",
  "11111110111101101011110000010",
];

function qr(text) {
  return run(PYTHON, ["-c",
    "import json, qr, sys; print(json.dumps(qr.encode(sys.argv[1])))", text],
  { cwd: ROOT }).then(result => JSON.parse(result.stdout));
}

test("the QR encoder reproduces the known decodable symbol", async () => {
  const matrix = await qr("https://example-mac.tail0000.ts.net/m");
  assert.deepEqual(matrix.map(row => row.map(value => value ? "1" : "0").join("")), KNOWN);
});

function bch(value, poly, total) {
  const top = poly.toString(2).length - 1;
  for (let i = total - 1; i >= top; i--) {
    if (value & (1 << i)) value ^= poly << (i - top);
  }
  return value;
}

test("every QR size carries valid finders, timing, format, and version fields", async () => {
  for (const [text, version] of [["A", 1], ["x".repeat(120), 7], ["y".repeat(200), 10]]) {
    const matrix = await qr(text);
    const size = 17 + 4 * version;
    assert.equal(matrix.length, size, `version ${version} size`);
    assert.ok(matrix.every(row => row.length === size));
    const finder = (top, left) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const ring = y === 0 || y === 6 || x === 0 || x === 6;
        const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        assert.equal(matrix[top + y][left + x], ring || core,
          `finder at ${top},${left} module ${y},${x}`);
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) {
      assert.equal(matrix[6][i], i % 2 === 0, `timing row at ${i}`);
      assert.equal(matrix[i][6], i % 2 === 0, `timing column at ${i}`);
    }
    assert.equal(matrix[size - 8][8], true, "dark module");

    let first = 0;
    for (let i = 0; i < 6; i++) first |= (matrix[8][i] ? 1 : 0) << (14 - i);
    first |= (matrix[8][7] ? 1 : 0) << 8;
    first |= (matrix[8][8] ? 1 : 0) << 7;
    first |= (matrix[7][8] ? 1 : 0) << 6;
    for (let i = 0; i < 6; i++) first |= (matrix[i][8] ? 1 : 0) << i;
    let second = 0;
    for (let i = 0; i < 7; i++) second |= (matrix[size - 1 - i][8] ? 1 : 0) << (14 - i);
    for (let i = 0; i < 8; i++) second |= (matrix[8][size - 8 + i] ? 1 : 0) << (7 - i);
    assert.equal(first, second, "the two format copies differ");
    const format = first ^ 0x5412;
    assert.equal(bch(format, 0x537, 15), 0, "format field fails its BCH check");
    assert.equal(format >> 13, 0b00, "not error correction level M");
    if (version >= 7) {
      let info = 0;
      for (let i = 0; i < 18; i++) {
        info |= (matrix[size - 11 + i % 3][Math.floor(i / 3)] ? 1 : 0) << i;
      }
      let other = 0;
      for (let i = 0; i < 18; i++) {
        other |= (matrix[Math.floor(i / 3)][size - 11 + i % 3] ? 1 : 0) << i;
      }
      assert.equal(info, other, "the two version copies differ");
      assert.equal(info >> 12, version, "version field names another version");
      assert.equal(bch(info, 0x1F25, 18), 0, "version field fails its BCH check");
    }
  }
});
