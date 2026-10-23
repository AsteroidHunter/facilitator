// The sign-in page the phone link shows before sign-in follows m-gate.html and
// the board's version as they are now, not as they were when the board started.
// A board that kept its first copy showed an old squid and an old version on the
// install page until it was restarted. The gate is driven in its own Python
// process from a copy of its files; no server or browser is started.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || 'python3';

test('the signed-out page is read again on each answer, and the first copy stands in when it cannot be', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'facilitator-gate-fresh-'));
  try {
    const app = path.join(outer, 'app');
    fs.mkdirSync(app);
    for (const name of ['bridge_gate.py', 'bridge_auth.py', 'm-gate.html', 'index.html'])
      fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
    const out = execFileSync(PYTHON, ['-c', `
import asyncio, json, sys
from pathlib import Path
app = Path(sys.argv[1])
sys.path.insert(0, str(app))
import bridge_gate

async def board(scope, receive, send):
    raise AssertionError("a signed-out page open reached the board")

gate = bridge_gate.BridgeGate(board, 9999)

def page():
    sent = []
    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}
    async def send(message):
        sent.append(message)
    scope = {"type": "http", "method": "GET", "path": "/m", "headers": [], "server": ("127.0.0.1", 9999)}
    asyncio.run(gate(scope, receive, send))
    assert sent[0]["status"] == 200
    return sent[1]["body"].decode()

gate_file, index_file = app / "m-gate.html", app / "index.html"
first = page()
gate_file.write_text(gate_file.read_text().replace("Your app password please?", "A changed sign-in line"))
index_file.write_text(index_file.read_text().replace('id="npversion">', 'id="npversion">v9.9.9<!--', 1))
changed = page()
gate_file.unlink()
missing = page()
print(json.dumps({
  "first_has_steps": "Add to Home Screen" in first,
  "changed_line": "A changed sign-in line" in changed,
  "changed_version": '<span class="version">v9.9.9</span>' in changed,
  "missing_is_first": missing == first,
}))
`, app], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), {
      first_has_steps: true, changed_line: true, changed_version: true, missing_is_first: true,
    });
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});
