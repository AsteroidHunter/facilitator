// A copied server is a complete product server, including its guarded socket.
// Keep old board fixtures honest when they move server.py to a temporary home.
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// A copied board is laid out as a checkout is: its code in one folder and
// what it writes in data/ beside that folder, which is where the server looks
// (its own folder's parent, then data). So a copy always goes one level down
// in a sandbox of its own, never straight into the shared temporary folder.
function dataOf(app) {
  return path.join(path.dirname(app), 'data');
}

// a fresh sandbox under the temporary folder with app/ and data/ made in it;
// answers app/, and the sandbox to remove afterwards is its parent
function appFolder(prefix) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = path.join(outer, 'app');
  fs.mkdirSync(app);
  fs.mkdirSync(dataOf(app), { mode: 0o700 });
  return app;
}

// m-splash.js is the launch picture's painter, which the gate page loads before
// sign-in and the phone page loads after it, so a copied server carries it too.
// The pages also fetch the home widgets once idle and ask /limits, which imports
// limits.py. That copy cannot find codex, or the first ask would start the
// machine's real codex; the tests that read the limits copy the real file over
// it. tokens.py is left out on purpose: with it the server reads the real token
// logs, so only the tests that open home copy it. The desktop pages load their
// settings store, board-settings.js, before anything else. "Open a new folder"
// fetches the folder picker and its sheet, on every page.
// A board with no profile lays the onboarding over everything until it is
// done, so a copied board is given one that has been through it, as an owner's
// board has; a test of the onboarding itself removes it (noProfile) before the
// server starts. A profile already in place is left as it is. The server
// refuses to start without data_folder.py, which says where its files are.
// dir is the copy's code folder; the profile goes into data/ beside it.
const PROFILE = { name: 'Fixture Owner', email: null, email_yes: false, work: null, time_zone: null };
function copyBridgeFiles(dir) {
  for (const name of ['bridge_auth.py', 'bridge_gate.py', 'm-gate.html', 'm-splash.js',
                      'home-widgets.css', 'home-widgets.js', 'board-settings.js', 'mac-phone-view.js',
                      'magic-box.js', 'folder-picker.js', 'folder-picker.css', 'data_folder.py'])
    fs.copyFileSync(path.join(ROOT, name), path.join(dir, name));
  const anchor = 'return shutil.which("codex", path=path)';
  const limits = fs.readFileSync(path.join(ROOT, 'limits.py'), 'utf8');
  if (!limits.includes(anchor)) throw new Error("the limits codex lookup's anchor moved");
  fs.writeFileSync(path.join(dir, 'limits.py'), limits.replace(anchor, 'return None'));
  fs.mkdirSync(dataOf(dir), { recursive: true, mode: 0o700 });
  const profile = path.join(dataOf(dir), 'profile.json');
  if (!fs.existsSync(profile)) fs.writeFileSync(profile, JSON.stringify(PROFILE) + '\n', { mode: 0o600 });
}

function noProfile(dir) {
  fs.rmSync(path.join(dataOf(dir), 'profile.json'), { force: true });
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

module.exports = { appFolder, copyBridgeFiles, dataOf, freePortPair, noProfile, PROFILE };
