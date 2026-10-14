// Extract the real route into an isolated Python process. subprocess.run is a
// recording fake: no application, browser or server is launched by the route.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = process.env.PAGE_GUARD_SOURCE_ROOT || path.join(__dirname, '..');
function routeTest(checks) {
  execFileSync('python3', ['-c', `
import ast, re, sys, types
from pathlib import Path
from urllib.parse import urlparse
source = Path(sys.argv[1], 'server.py').read_text()
module = ast.parse(source)
route = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == '_post_open_in_browser')
calls = []
class TimeoutExpired(Exception): pass
class Query:
    local = True
    same_origin = True
def run(args, **kwargs):
    calls.append((args, kwargs))
    return types.SimpleNamespace(returncode=0)
subprocess = types.SimpleNamespace(run=run, TimeoutExpired=TimeoutExpired)
sys = types.SimpleNamespace(platform='darwin')
exec(compile(ast.Module(body=[route], type_ignores=[]), '<route>', 'exec'))
q = Query()
${checks}
`, root], { encoding: 'utf8' });
}
test('explicit Mac opening requests one normal Chrome window without app flags or a shell', () => {
  routeTest(`
url = 'https://example.com/a?q=$(touch%20x)&title=hello#part'
assert _post_open_in_browser(q, url) == (200, {'ok': True})
assert calls == [(['/usr/bin/open', '-na', 'Google Chrome', '--args', '--new-window', url], {'capture_output': True, 'timeout': 10})]
`);
});
test('only same-origin local requests can launch; invalid and executable URLs cannot launch', () => {
  routeTest(`
for local, same in [(False, False), (False, True), (True, False)]:
    q.local, q.same_origin = local, same
    assert _post_open_in_browser(q, 'https://example.com')[0] == 403
q.local = q.same_origin = True
for url in ['javascript:alert(1)', 'file:///tmp/a', 'chrome://newtab', '--new-window', '//example.com', 'https://', 'https://a:bad/', 'https://user:secret@a/', 'https://a/\\n--app=x', 'https://a/\\\\x']:
    assert _post_open_in_browser(q, url)[0] == 400, url
assert calls == []
`);
});
test('launch failures and unsupported hosts produce useful errors without browser fallbacks', () => {
  routeTest(`
sys.platform = 'linux'
assert _post_open_in_browser(q, 'https://example.com')[0] == 501
assert calls == []
sys.platform = 'darwin'
subprocess.run = lambda *a, **k: types.SimpleNamespace(returncode=1)
assert _post_open_in_browser(q, 'https://example.com')[0] == 502
for error in [OSError(), TimeoutExpired()]:
    def fail(*a, **k): raise error
    subprocess.run = fail
    assert _post_open_in_browser(q, 'https://example.com')[0] == 502
`);
});
test('the opener is a capped POST route and the phone bridge refuses it', () => {
  const fs = require('node:fs');
  assert.match(fs.readFileSync(path.join(root, 'server.py'), 'utf8'), /Route\("\/open-in-browser", _endpoint\(_post_open_in_browser, "text", 8192\), methods=\["POST"\]\)/);
  assert.match(fs.readFileSync(path.join(root, 'bridge_gate.py'), 'utf8'), /LOCAL_ONLY = frozenset\(\{[^}]*"\/open-in-browser"/);
});
