// A copied server is a complete product server, including its guarded socket.
// Keep old board fixtures honest when they move server.py to a temporary home.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// m-splash.js is the launch picture's painter, which the gate page loads before
// sign-in and the phone page loads after it, so a copied server carries it too.
function copyBridgeFiles(dir) {
  for (const name of ['bridge_auth.py', 'bridge_gate.py', 'm-gate.html', 'm-splash.js'])
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
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
