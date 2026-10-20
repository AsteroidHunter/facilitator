// Open in Finder for the home page's chart picture (POST /tokens/picture/reveal).
// The real route and its finder are lifted out of server.py into a Python
// process of their own, with a home folder made for the test and a recording
// stand-in for subprocess.run, so no Finder window or other program is ever
// opened. The board itself is only asked things it refuses before it looks.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { startBoard } = require("./board-fixture.cjs");

const ROOT = path.join(__dirname, "..");
const NAME = "facilitator-tokens-line-2026-10-20.png";

let home;
before(async () => { home = await mkdtemp(path.join(tmpdir(), "facilitator-reveal-")); });
after(async () => { if (home) await rm(home, { recursive: true, force: true }); });

// each check runs in a fresh home: HOME is the folder the route believes is home
async function routeTest(checks) {
  const folder = await mkdtemp(path.join(home, "home-"));
  execFileSync("python3", ["-c", `
import ast, hashlib, json, os, re, secrets, types
import sys as real_sys
from pathlib import Path
source = Path(real_sys.argv[1], 'server.py').read_text()
module = ast.parse(source)
wanted = {'_inside', '_user_dirs', '_picture_saved', '_post_picture_reveal',
          'PICTURE_NAME', 'PICTURE_DIGEST', 'PICTURE_MAX', 'PICTURE_LOOKS'}
def named(n):
    if isinstance(n, ast.FunctionDef):
        return n.name
    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Name):
        return n.targets[0].id
nodes = [n for n in module.body if named(n) in wanted]
assert {named(n) for n in nodes} == wanted, {named(n) for n in nodes}
future = ast.parse('from __future__ import annotations').body
HOME = Path(real_sys.argv[2])
DOWN = HOME / 'Downloads'
calls = []
class TimeoutExpired(Exception): pass
def run(args, **kwargs):
    calls.append((args, kwargs))
    return types.SimpleNamespace(returncode=0)
subprocess = types.SimpleNamespace(run=run, TimeoutExpired=TimeoutExpired)
sys = types.SimpleNamespace(platform='darwin')
def _home():
    return HOME
class Query:
    local = True
    same_origin = True
exec(compile(ast.Module(body=future + nodes, type_ignores=[]), '<route>', 'exec'))
q = Query()
NAME = '${NAME}'
PIC = b'\\x89PNG\\r\\n\\x1a\\n' + b'an invented chart ' * 64
def ask(name, data=PIC, digest=None):
    return _post_picture_reveal(q, json.dumps({'name': name, 'sha256': digest or hashlib.sha256(data).hexdigest()}))
def put(name, data, when, folder=None):
    p = (folder or DOWN) / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    os.utime(p, (when, when))
    return p
${checks}
`, ROOT, folder], { encoding: "utf8" });
}

test("Finder is asked to show the newest saved copy of the picture, by its absolute path, with no shell", async () => {
  await routeTest(`
put(NAME, b'an older picture of the same day', 1000)
saved = put(NAME[:-4] + ' (1).png', PIC, 2000)
status, answer = ask(NAME)
assert (status, answer) == (200, {'ok': True, 'name': saved.name}), (status, answer)
assert calls == [(['/usr/bin/open', '-R', str(saved)], {'capture_output': True, 'timeout': 10})], calls
# the same bytes under two names: the newer one, as a browser numbers them
calls.clear()
newer = put(NAME[:-4] + ' (2).png', PIC, 3000)
assert ask(NAME)[1]['name'] == newer.name
assert calls[0][0] == ['/usr/bin/open', '-R', str(newer)]
# the heatmap's picture, under the name the page gave it
calls.clear()
heat = put('facilitator-tokens-heatmap-2026-10-20.png', b'a heatmap', 1000)
assert ask(heat.name, b'a heatmap') == (200, {'ok': True, 'name': heat.name})
assert calls[0][0][2] == str(heat)
`);
});

test("only the Mac's own page is heard", async () => {
  await routeTest(`
put(NAME, PIC, 1000)
for local, same in [(False, False), (False, True), (True, False)]:
    q.local, q.same_origin = local, same
    assert ask(NAME) == (403, {'error': 'Open in Finder needs the local Mac page.'}), (local, same)
assert calls == []
`);
});

test("a path, or any name the board does not give its pictures, is refused before anything is read", async () => {
  await routeTest(`
put(NAME, PIC, 1000)
refused = (400, {'error': 'That is not a chart picture the board makes.'})
digest = hashlib.sha256(PIC).hexdigest()
for name in ['/etc/passwd', str(DOWN / NAME), '../' + NAME, 'Downloads/' + NAME, NAME + '/..', NAME + '\\n',
             NAME[:-4] + ' (1).png', 'facilitator-tokens-pie-2026-10-20.png', 'facilitator-tokens-line-26-10-20.png',
             'notes.txt', '', None, 5, [NAME], {'name': NAME}]:
    assert _post_picture_reveal(q, json.dumps({'name': name, 'sha256': digest})) == refused, name
for bad in [digest.upper(), digest[:-1], digest + 'a', 'g' * 64, '', None, 64]:
    assert _post_picture_reveal(q, json.dumps({'name': NAME, 'sha256': bad})) == refused, bad
for body in ['', 'not json', '[]', json.dumps(NAME), json.dumps({'path': str(DOWN / NAME), 'sha256': digest})]:
    assert _post_picture_reveal(q, body) == refused, body
assert calls == []
`);
});

test("a file the board did not save is never shown: other bytes, a link, another folder, a folder, a lookalike name", async () => {
  await routeTest(`
missing = (404, {'error': 'The picture is not in Downloads.'})
# the right name and other bytes
put('facilitator-tokens-line-2026-10-21.png', b'some other file', 1000)
assert ask('facilitator-tokens-line-2026-10-21.png') == missing
# the right bytes behind a link with the right name: links are never followed
secret = put('secret.png', PIC, 1000, HOME)
(DOWN / 'facilitator-tokens-line-2026-10-22.png').symlink_to(secret)
assert ask('facilitator-tokens-line-2026-10-22.png') == missing
# the right name and bytes, anywhere but Downloads
put('facilitator-tokens-line-2026-10-23.png', PIC, 1000, HOME)
put('facilitator-tokens-line-2026-10-23.png', PIC, 1000, HOME / 'Desktop')
put('facilitator-tokens-line-2026-10-23.png', PIC, 1000, DOWN / 'inner')
assert ask('facilitator-tokens-line-2026-10-23.png') == missing
# a folder under the name
(DOWN / 'facilitator-tokens-line-2026-10-24.png').mkdir()
assert ask('facilitator-tokens-line-2026-10-24.png') == missing
# names that only look like it
for lookalike in ['facilitator-tokens-line-2026-10-25.png.app', 'facilitator-tokens-line-2026-10-25 (1).png.app',
                  'xfacilitator-tokens-line-2026-10-25.png', 'facilitator-tokens-line-2026-10-25 (x).png',
                  'facilitator-tokens-line-2026-10-25(1).png', 'facilitator-tokens-line-2026-10-25 (12345).png']:
    put(lookalike, PIC, 1000)
assert ask('facilitator-tokens-line-2026-10-25.png') == missing
# a file larger than any picture the page makes is not read
put('facilitator-tokens-line-2026-10-26.png', PIC, 1000)
PICTURE_MAX = len(PIC) - 1
assert ask('facilitator-tokens-line-2026-10-26.png') == missing
assert calls == []
`);
});

test("macOS only; a Downloads that is missing or may not be read, and an open that fails, are said plainly", async () => {
  await routeTest(`
assert ask(NAME) == (404, {'error': 'The picture is not in Downloads.'}), 'no Downloads folder at all'
put(NAME, PIC, 1000)
sys.platform = 'linux'
assert ask(NAME) == (501, {'error': 'Open in Finder needs macOS.'})
sys.platform = 'darwin'
assert calls == []
DOWN.chmod(0)
try:
    status, answer = ask(NAME)
finally:
    DOWN.chmod(0o755)
assert status == 403 and 'Privacy & Security, Files and Folders' in answer['error'], answer
subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=1)
assert ask(NAME) == (502, {'error': 'Could not open Finder.'})
for error in [OSError(), TimeoutExpired()]:
    def fail(*a, **k): raise error
    subprocess.run = fail
    assert ask(NAME) == (502, {'error': 'Could not open Finder.'})
`);
});

test("the route is a capped POST, written down with the others, and the phone's door refuses it", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.py"), "utf8");
  assert.match(server, /Route\("\/tokens\/picture\/reveal", _endpoint\(_post_picture_reveal, "text", PICTURE_REVEAL_BODY\), methods=\["POST"\]\)/);
  assert.match(server, /^PICTURE_REVEAL_BODY = 1024$/m);
  assert.match(server, /^ {2}POST \/tokens\/picture\/reveal -> body \{"name", "sha256"\}/m, "in the routes the module's words list");
  assert.match(fs.readFileSync(path.join(ROOT, "bridge_gate.py"), "utf8"), /LOCAL_ONLY = frozenset\(\{[^}]*"\/tokens\/picture\/reveal"/);
});

test("over the wire: another site, the phone's door, a body too large, a path and the wrong bytes are all refused", async () => {
  // a home of its own whose Downloads holds the right name with other bytes,
  // so nothing asked here can reach Finder
  const own = await mkdtemp(path.join(home, "wire-"));
  await mkdir(path.join(own, "Downloads"));
  await writeFile(path.join(own, "Downloads", NAME), "not the picture");
  const board = await startBoard({ env: { HOME: own } });
  try {
    const body = name => JSON.stringify({ name, sha256: "0".repeat(64) });
    const route = "/tokens/picture/reveal";
    const cross = await board.call("POST", route, body(NAME), { Origin: "https://elsewhere.example", "Sec-Fetch-Site": "cross-site" });
    assert.equal(cross.status, 403);
    const phone = await fetch(`http://127.0.0.1:${board.port + 1}${route}`, { method: "POST", body: body(NAME) });
    assert.equal(phone.status, 404, "the phone's door never passes it");
    assert.equal((await board.call("POST", route, "x".repeat(2048))).status, 413);
    const traversal = await board.call("POST", route, body("../../etc/passwd"));
    assert.deepEqual([traversal.status, JSON.parse(traversal.text)], [400, { error: "That is not a chart picture the board makes." }]);
    const other = await board.call("POST", route, body(NAME));
    assert.deepEqual([other.status, JSON.parse(other.text)], [404, { error: "The picture is not in Downloads." }]);
    assert.equal((await fetch(board.origin + route)).status, 404, "a POST only: a GET finds nothing");
  } finally {
    await board.stop();
  }
});
