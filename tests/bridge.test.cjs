// The facilitator bridge command against a stub tailscale on PATH, and the
// dependency-free QR encoder it prints with: a known answer that Apple's
// Vision decoder read back when it was written, plus the structure every
// symbol has to carry.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFile } = require("node:child_process");
const { createServer } = require("node:http");
const { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

let board;          // a stand in for the running server: it answers /state
let fixtureDir;
let binDir;

function qr(text) {
  return run("python3", ["-c", "import json, qr, sys; print(json.dumps(qr.encode(sys.argv[1])))", text], { cwd: ROOT })
    .then(r => JSON.parse(r.stdout));
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-bridge-"));
  binDir = path.join(fixtureDir, "bin");
  await mkdir(binDir);
  await copyFile(path.join(ROOT, "facilitator"), path.join(fixtureDir, "facilitator"));
  await copyFile(path.join(ROOT, "qr.py"), path.join(fixtureDir, "qr.py"));
  board = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ boxes: [], queued: 0, listening: {}, listenerGap: {}, busy: {} }));
  });
  await new Promise(resolve => board.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ port: board.address().port, lanes: [] }));
  const stub = path.join(binDir, "tailscale");
  await writeFile(stub, [
    "#!/bin/bash",
    "# a stand in for the tailscale command line: status answers the json named",
    "# by TS_STATUS_JSON; serve records its arguments in TS_SERVE_LOG",
    'if [ "$1" = "status" ]; then cat "$TS_STATUS_JSON"; exit 0; fi',
    'if [ "$1" = "serve" ]; then printf "%s\\n" "$@" > "$TS_SERVE_LOG"; echo "Available within your tailnet:"; echo "https://mac.tail0000.ts.net/"; exit 0; fi',
    'echo "unexpected: $*" >&2; exit 2',
    "",
  ].join("\n"));
  await chmod(stub, 0o755);
});

after(async () => {
  if (board) await new Promise(resolve => board.close(resolve));
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function bridge(status, extra = []) {
  const statusPath = path.join(fixtureDir, "status.json");
  const serveLog = path.join(fixtureDir, "serve.log");
  await rm(serveLog, { force: true });
  await writeFile(statusPath, JSON.stringify(status));
  const env = { ...process.env, PATH: binDir + ":" + process.env.PATH, TS_STATUS_JSON: statusPath, TS_SERVE_LOG: serveLog };
  try {
    const { stdout, stderr } = await run("python3", [path.join(fixtureDir, "facilitator"), "bridge", ...extra], { env, cwd: fixtureDir });
    return { code: 0, stdout, stderr, served: await readFile(serveLog, "utf8").catch(() => null) };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, served: await readFile(serveLog, "utf8").catch(() => null) };
  }
}

const ON = { BackendState: "Running", CertDomains: ["mac.tail0000.ts.net"], Self: { DNSName: "mac.tail0000.ts.net." } };

test("with HTTPS on, bridge runs tailscale serve and prints the address under its QR code", async () => {
  const result = await bridge(ON);
  assert.equal(result.code, 0, result.stderr);
  const port = board.address().port;
  assert.deepEqual(result.served.trim().split("\n"), ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
  assert.match(result.stdout, new RegExp(`serve: ran \\S*tailscale serve --bg --https=443 http://127\\.0\\.0\\.1:${port}`));
  assert.match(result.stdout, /^phone page: https:\/\/mac\.tail0000\.ts\.net\/m$/m);
  const lines = result.stdout.split("\n");
  const code = lines.filter(line => /^  [ ▀▄█]+/.test(line));
  assert.ok(code.length >= 15, "no QR code drawn in block characters");
  // the address sits on its own line right under the last row and never
  // beside one, so a narrow terminal wrapping it cannot draw the tail inside the code
  assert.ok(!code.some(line => line.includes("https://")), "the address is printed beside a row of the code");
  const last = lines.findLastIndex(line => /^  [ ▀▄█]+/.test(line));
  assert.equal(lines[last + 1], "  https://mac.tail0000.ts.net/m", "the address is not printed on its own line under the code");
  assert.match(result.stdout, /serve reset/);
  assert.doesNotMatch(result.stdout, /\u2014/);
  // the drawn code is the encoder's own symbol for that address
  const matrix = await qr("https://mac.tail0000.ts.net/m");
  const quiet = 4;
  const rows = [];
  for (let y = 0; y < matrix.length + 2 * quiet; y++) rows.push(Array(matrix.length + 2 * quiet).fill(false));
  matrix.forEach((row, y) => row.forEach((v, x) => { rows[y + quiet][x + quiet] = v; }));
  const drawn = code.map(line => line.slice(2).replace(/\s+$/, ""));
  for (let i = 0; i < drawn.length; i++) {
    const top = rows[2 * i], bottom = rows[2 * i + 1] || rows[2 * i].map(() => false);
    const want = top.map((t, x) => t && bottom[x] ? "█" : t ? "▀" : bottom[x] ? "▄" : " ").join("").replace(/\s+$/, "");
    assert.equal(drawn[i], want, `line ${i} of the printed code differs from the encoder`);
  }
});

test("with HTTPS off, bridge says so in one sentence, runs no serve, and exits non-zero", async () => {
  const result = await bridge({ ...ON, CertDomains: null });
  assert.notEqual(result.code, 0);
  assert.equal(result.served, null, "tailscale serve was run with HTTPS off");
  assert.equal(result.stderr.trim(),
    "Tailscale HTTPS is off for this tailnet: switch on HTTPS certificates under DNS in the Tailscale admin console, then run facilitator bridge again.");
  assert.equal(result.stdout.trim(), "");
});

test("bridge refuses a disconnected tailscale and a missing tailnet name", async () => {
  let result = await bridge({ ...ON, BackendState: "Stopped" });
  assert.notEqual(result.code, 0);
  assert.equal(result.served, null);
  assert.match(result.stderr, /not connected/);
  result = await bridge({ ...ON, Self: { DNSName: "" } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /no tailnet name/);
});

test("a dry run prints the serve command without running it", async () => {
  const result = await bridge(ON, ["--dry-run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.served, null);
  assert.match(result.stdout, /^serve: would run \S*tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:\d+$/m);
  assert.match(result.stdout, /^phone page: https:\/\/mac\.tail0000\.ts\.net\/m$/m);
});

// the symbol for this address, as Apple's Vision decoder read it back
const KNOWN = [
  "11111110101001001111101111111",
  "10000010110010001100001000001",
  "10111010000111110011001011101",
  "10111010101110000100001011101",
  "10111010010001110001001011101",
  "10000010011110101011001000001",
  "11111110101010101010101111111",
  "00000000100101101100000000000",
  "10110111000111100101101001011",
  "10100100011010001001101110001",
  "11001010111110101100100000110",
  "00011101101001100000101110001",
  "01001110110100010111000001100",
  "01111100000101011111101000111",
  "11010010000100101001110100111",
  "01110101011111001011010010010",
  "00010010110010010000110111010",
  "01110101001001010010100101110",
  "10011110101110010010100010100",
  "00101001000100011100110110100",
  "01110110011101011101111111100",
  "00000000100101100000100011111",
  "11111110101011001101101011010",
  "10000010111110011000100011011",
  "10111010001010111110111110100",
  "10111010111000111001100011001",
  "10111010110000001110100100101",
  "10000010001100011010101111010",
  "11111110111101101011110000010",
];

test("the QR encoder reproduces a known symbol", async () => {
  const matrix = await qr("https://example-mac.tail0000.ts.net/m");
  assert.deepEqual(matrix.map(row => row.map(v => (v ? "1" : "0")).join("")), KNOWN);
});

function bch(value, poly, total) {
  const top = poly.toString(2).length - 1;
  for (let i = total - 1; i >= top; i--) if (value & (1 << i)) value ^= poly << (i - top);
  return value;
}

test("every symbol carries valid finders, timing, format and version fields", async () => {
  for (const [text, version] of [["A", 1], ["x".repeat(120), 7], ["y".repeat(200), 10]]) {
    const m = await qr(text);
    const size = 17 + 4 * version;
    assert.equal(m.length, size, `version ${version} size`);
    assert.ok(m.every(row => row.length === size));
    const finder = (top, left) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const ring = y === 0 || y === 6 || x === 0 || x === 6;
        const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
        assert.equal(m[top + y][left + x], ring || core, `finder at ${top},${left} module ${y},${x}`);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `timing row at ${i}`);
      assert.equal(m[i][6], i % 2 === 0, `timing column at ${i}`);
    }
    assert.equal(m[size - 8][8], true, "dark module");
    // the format field, both copies equal, level M, and a clean BCH remainder
    let first = 0;
    for (let i = 0; i < 6; i++) first |= (m[8][i] ? 1 : 0) << (14 - i);
    first |= (m[8][7] ? 1 : 0) << 8;
    first |= (m[8][8] ? 1 : 0) << 7;
    first |= (m[7][8] ? 1 : 0) << 6;
    for (let i = 0; i < 6; i++) first |= (m[i][8] ? 1 : 0) << i;
    let second = 0;
    for (let i = 0; i < 7; i++) second |= (m[size - 1 - i][8] ? 1 : 0) << (14 - i);
    for (let i = 0; i < 8; i++) second |= (m[8][size - 8 + i] ? 1 : 0) << (7 - i);
    assert.equal(first, second, "the two format copies differ");
    const format = first ^ 0x5412;
    assert.equal(bch(format, 0x537, 15), 0, "format field fails its BCH check");
    assert.equal(format >> 13, 0b00, "not error correction level M");
    if (version >= 7) {
      let info = 0;
      for (let i = 0; i < 18; i++) info |= (m[size - 11 + i % 3][Math.floor(i / 3)] ? 1 : 0) << i;
      let other = 0;
      for (let i = 0; i < 18; i++) other |= (m[Math.floor(i / 3)][size - 11 + i % 3] ? 1 : 0) << i;
      assert.equal(info, other, "the two version copies differ");
      assert.equal(info >> 12, version, "version field names another version");
      assert.equal(bch(info, 0x1F25, 18), 0, "version field fails its BCH check");
    }
  }
  const rendered = await run("python3", ["-c",
    "import qr; print('\\n'.join(qr.render(qr.encode('A'))))"], { cwd: ROOT });
  const lines = rendered.stdout.replace(/\n$/, "").split("\n");
  assert.equal(lines.length, Math.ceil((21 + 8) / 2), "render draws two module rows per line with a four module quiet zone");
  assert.ok(lines.every(line => /^[ ▀▄█]+$/.test(line) && line.length === 21 + 8));
});
