// A copied server is a complete product server, including its guarded socket.
// Keep old board fixtures honest when they move server.py to a temporary home.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// m-splash.js is the launch picture's painter, which the gate page loads before
// sign-in and the phone page loads after it, so a copied server carries it too.
// The pages also fetch the home widgets once idle and ask /limits, which imports
// limits.py. That copy cannot find codex, or the first ask would start the
// machine's real codex; the tests that read the limits copy the real file over
// it. tokens.py is left out on purpose: with it the server reads the real token
// logs, so only the tests that open home copy it. The desktop pages load their
// settings store, board-settings.js, before anything else.
function copyBridgeFiles(dir) {
  for (const name of ['bridge_auth.py', 'bridge_gate.py', 'm-gate.html', 'm-splash.js',
                      'home-widgets.css', 'home-widgets.js', 'board-settings.js', 'mac-phone-view.js'])
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  const anchor = 'return shutil.which("codex", path=path)';
  const limits = fs.readFileSync(path.join(ROOT, 'limits.py'), 'utf8');
  if (!limits.includes(anchor)) throw new Error("the limits codex lookup's anchor moved");
  fs.writeFileSync(path.join(dir, 'limits.py'), limits.replace(anchor, 'return None'));
}

function bind(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function freePortPair() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const local = net.createServer();
    await bind(local, 0);
    const port = local.address().port;
    if (port >= 65535) { await close(local); continue; }
    const bridge = net.createServer();
    try {
      await bind(bridge, port + 1);
      await Promise.all([close(local), close(bridge)]);
      return port;
    } catch {
      await close(local);
    }
  }
  throw new Error('No adjacent free loopback ports for the fixture');
}

module.exports = { copyBridgeFiles, freePortPair };
