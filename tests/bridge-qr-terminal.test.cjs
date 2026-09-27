// the bridge qr as a terminal draws it. show_qr is loaded straight from the
// cli script and handed a fake stdout, so nothing touches tailscale, the
// network or a server; the address is invented
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const URL = "https://example-mac.tail0000.ts.net/m";
// the fixed 256-colour cube's black (16) on white (231): themes restyle only
// the sixteen palette slots, so these stay true black and white
const PAINT = "\x1b[38;5;16;48;5;231m";
const RESET = "\x1b[0m";

async function showQr(tty) {
  const result = await run(PYTHON, ["-c", [
    "import importlib.machinery, importlib.util, io, json, sys",
    "loader = importlib.machinery.SourceFileLoader('facilitator_cli', sys.argv[1])",
    "cli = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))",
    "loader.exec_module(cli)",
    "class Out(io.StringIO):",
    "    def isatty(self):",
    "        return sys.argv[3] == 'tty'",
    "out, real = Out(), sys.stdout",
    "sys.stdout = out",
    "try:",
    "    cli.show_qr(sys.argv[2])",
    "finally:",
    "    sys.stdout = real",
    "print(json.dumps(out.getvalue()))",
  ].join("\n"), path.join(ROOT, "facilitator"), URL, tty ? "tty" : "pipe"], { cwd: ROOT });
  return JSON.parse(result.stdout);
}

async function rendered() {
  const result = await run(PYTHON, ["-c",
    "import json, qr, sys; print(json.dumps(qr.render(qr.encode(sys.argv[1]))))", URL],
  { cwd: ROOT });
  return JSON.parse(result.stdout);
}

test("on a terminal every QR line is painted true black on true white and reset", async () => {
  const lines = await rendered();
  assert.ok(lines.length > 0);
  const output = await showQr(true);
  assert.equal(output, lines.map(line => "  " + PAINT + line + RESET + "\n").join(""));
  assert.doesNotMatch(output, /\x1b\[30;107m/, "the theme's palette black on bright white came back");
  assert.doesNotMatch(output, /https:\/\//, "the private address was printed outside the QR");
});

test("piped, the QR lines stay bare characters with no colour codes", async () => {
  const lines = await rendered();
  const output = await showQr(false);
  assert.equal(output, lines.map(line => "  " + line + "\n").join(""));
  assert.doesNotMatch(output, /\x1b/);
});
