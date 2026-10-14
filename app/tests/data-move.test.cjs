// The one-time move of an older checkout's board files into data/, driven the
// way it really runs: a checkout of the last commit from before data/, with
// its own code and its own server running, is brought up to this code by its
// own `facilitator update`, which pulls and hands over to the launcher at the
// top. Everything happens in throwaway folders with a fake uv and a fake
// tailscale; osascript and open are stand-ins that answer nothing, so no
// Chrome is asked or opened. No real port, board or data is touched.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile, execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");        // app/ of this checkout
const REPO = path.resolve(ROOT, "..");              // this checkout
// the last commit that kept the board's files at the checkout's top
const OLD_LAYOUT = "89b439e";
// one Python, with the server's packages, for the old board, the new one and
// both commands; the fake uv's .venv hands over to it
const OWN_VENV = path.join(REPO, "data", ".venv", "bin", "python3");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || (fs.existsSync(OWN_VENV) ? OWN_VENV
  : execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim());
const dirs = [];
const started = new Set();   // server pids this file started

// A server left running by a test that failed part way is found through the
// locks in its world and stopped, only when ps shows it running from there
function serversOf(base) {
  const pids = new Set(started);
  for (const lock of [path.join(base, "user", "facilitator", "data", "server.lock"),
                      path.join(base, "user", "facilitator", "server.lock")]) {
    try {
      const pid = JSON.parse(fs.readFileSync(lock, "utf8")).pid;
      if (Number.isInteger(pid) && pid > 1) pids.add(pid);
    } catch {}
  }
  return [...pids].filter(pid => {
    try {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes(base);
    } catch { return false; }
  });
}

after(async () => {
  for (const dir of dirs)
    for (const pid of serversOf(dir)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  await new Promise(resolve => setTimeout(resolve, 500));
  for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true });
});

function run(file, args, { cwd, env, timeout = 120000 }) {
  return new Promise(resolve => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 1 << 24 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function freePair() {
  for (let i = 0; i < 50; i++) {
    const a = net.createServer();
    await new Promise(resolve => a.listen(0, "127.0.0.1", resolve));
    const port = a.address().port;
    const b = net.createServer();
    const ok = await new Promise(resolve => {
      b.once("error", () => resolve(false));
      b.listen(port + 1, "127.0.0.1", () => resolve(true));
    });
    await new Promise(resolve => a.close(resolve));
    if (ok) await new Promise(resolve => b.close(resolve));
    if (ok && port < 65000) return port;
  }
  throw new Error("no free pair of ports");
}

const sha = file => fs.lstatSync(file).isSymbolicLink()
  ? "link:" + fs.readlinkSync(file)
  : crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// every file under dir, by path relative to it, with its checksum
function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = sub => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = path.join(sub, entry.name);
      if (entry.isDirectory()) walk(rel);
      else out[rel] = sha(path.join(dir, rel));
    }
  };
  walk("");
  return out;
}

const sectionTitles = text => text.split("\n").filter(line => /^\d\. \S/.test(line));

function script(file, text) {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

// A fake uv: its venv makes a .venv whose python3 hands over to the real one,
// and its package sync does nothing; it says a version new enough
const FAKE_UV = `#!/bin/sh
case "$1" in
  --version) echo "uv 0.11.18 (fake)" ;;
  venv)
    mkdir -p .venv/bin
    printf 'home = /fake\\nversion_info = 3.14.0\\n' > .venv/pyvenv.cfg
    printf '#!/bin/sh\\nexec "%s" "$@"\\n' ${JSON.stringify(PYTHON)} > .venv/bin/python3
    cp .venv/bin/python3 .venv/bin/python
    chmod +x .venv/bin/python .venv/bin/python3 ;;
esac
exit 0
`;
const FAKE_TAILSCALE = `#!/bin/sh
case "$*" in
  *"serve status"*) echo '{}' ;;
  *"status"*) echo '{"BackendState":"Stopped"}' ;;
esac
exit 0
`;

// names chosen to be awkward: spaces, a narrow no-break space, accents, a
// leading dot, an emoji, a subfolder, and one name in both upload folders
const ODD = ["1790062555829502000-Screenshot 2026-09-22 at 12.02.33 AM.png",
  "1791398534302337000-Screen Recording 2026-10-07 at 11.42.00 AM.mov",
  "1789113390654-café résumé (final) [v2].pdf", ".hidden-upload.png", "notes 📌.png"];
const CARDS = ["m1", "m2", "m3", "m4", "m5", "m7", "m9"];

function oldFile(name) {
  return execFileSync("git", ["-C", REPO, "show", `${OLD_LAYOUT}:${name}`], { maxBuffer: 1 << 26 });
}

// The world: origin (bare), dev (pushes), and user/facilitator, the checkout
// under test, with facilitator-internal/ beside it. fresh: the user's clone
// is made after the new layout is pushed, as a new install would be.
async function makeWorld({ fresh = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-data-move-")));
  dirs.push(base);
  const w = {
    base, origin: path.join(base, "origin.git"), dev: path.join(base, "dev"),
    parent: path.join(base, "user"), user: path.join(base, "user", "facilitator"),
    beside: path.join(base, "user", "facilitator-internal"), bin: path.join(base, "bin"),
    home: path.join(base, "home"), opened: path.join(base, "opened.log"),
  };
  fs.mkdirSync(w.bin);
  fs.mkdirSync(w.home);
  fs.mkdirSync(w.parent);
  script(path.join(w.bin, "uv"), FAKE_UV);
  script(path.join(w.bin, "tailscale"), FAKE_TAILSCALE);
  script(path.join(w.bin, "osascript"), "#!/bin/sh\nexit 1\n");
  script(path.join(w.bin, "open"), `#!/bin/sh\necho "open $*" >> ${JSON.stringify(w.opened)}\nexit 0\n`);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") || key.startsWith("FACILITATOR_") || key === "CLAUDE_CONFIG_DIR") delete env[key];
  w.env = { ...env, PATH: [w.bin, path.dirname(PYTHON), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(path.delimiter),
    HOME: w.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: w.env, encoding: "utf8" }).trim();
  w.git = git;

  git(base, "init", "--bare", "-b", "main", w.origin);
  git(base, "clone", "-q", w.origin, w.dev);
  git(w.dev, "branch", "-M", "main");
  // the old layout: the real command and server from before data/
  for (const name of ["facilitator", "server.py", "bridge_auth.py", "bridge_gate.py", "m-gate.html", ".gitignore",
                      "updates/README.md"]) {
    fs.mkdirSync(path.dirname(path.join(w.dev, name)), { recursive: true });
    fs.writeFileSync(path.join(w.dev, name), oldFile(name));
  }
  fs.chmodSync(path.join(w.dev, "facilitator"), 0o755);
  fs.writeFileSync(path.join(w.dev, "index.html"), '<span id="npversion">v0.2.414</span>\n');
  fs.writeFileSync(path.join(w.dev, "requirements.txt"), "\n");
  git(w.dev, "add", "-A");
  git(w.dev, "commit", "-qm", "Old layout");
  git(w.dev, "push", "-q", "origin", "main");

  // the new layout, this checkout's own files, pushed when a test says so
  w.pushNew = () => {
    for (const name of ["facilitator", "server.py", "bridge_auth.py", "bridge_gate.py", "m-gate.html", "index.html",
                        "requirements.txt", "updates"])
      git(w.dev, "rm", "-rq", name);
    fs.mkdirSync(path.join(w.dev, "app", "updates"), { recursive: true });
    for (const name of ["facilitator", "data_folder.py", "server.py", "bridge_auth.py", "bridge_gate.py", "m-gate.html"])
      fs.copyFileSync(path.join(ROOT, name), path.join(w.dev, "app", name));
    fs.copyFileSync(path.join(ROOT, "updates", "README.md"), path.join(w.dev, "app", "updates", "README.md"));
    fs.writeFileSync(path.join(w.dev, "app", "index.html"), '<span id="npversion">v0.2.415</span>\n');
    fs.writeFileSync(path.join(w.dev, "app", "requirements.txt"), "\n");
    fs.copyFileSync(path.join(REPO, "facilitator"), path.join(w.dev, "facilitator"));
    fs.copyFileSync(path.join(REPO, ".gitignore"), path.join(w.dev, ".gitignore"));
    git(w.dev, "add", "-A");
    git(w.dev, "commit", "-qm", "Code into app/, data into data/");
    git(w.dev, "push", "-q", "origin", "main");
  };
  if (fresh) w.pushNew();
  git(w.parent, "clone", "-q", w.origin, w.user);
  w.port = await freePair();
  w.cli = path.join(w.user, "facilitator");
  w.data = path.join(w.user, "data");
  w.update = (extra = {}) => run(PYTHON, [w.cli, "update"], { cwd: base, env: { ...w.env, ...extra } });
  return w;
}

// the board's files as an older install left them: at the checkout's top, with
// attachments and logs in facilitator-internal beside it, a .venv of the fake
// uv's kind, and someone's own notes in that folder too
function fillOldBoard(w) {
  const top = (name, text) => fs.writeFileSync(path.join(w.user, name), text);
  const state = { title: "older board", boxes: CARDS.map((id, n) => ({ id, bucket: "meta", title: `Card ${n}`,
    owner: "facilitator", reply: `reply ${id}`, pending: [], done: n % 2 === 0, replies: 1 })),
    bin: [], inbox: [], busy: {}, claimed: {}, busy_ts: {}, ack: {}, next_mid: 1, next_bid: 10, rev: 3, ops: {} };
  top("state.json", JSON.stringify(state));
  top("state.json.bak-20260906T230745", JSON.stringify({ boxes: [] }));
  top("transcript.jsonl", CARDS.map(id => JSON.stringify({ ts: 1, kind: "user", box: id, text: `hello ${id}` })).join("\n") + "\n");
  top("settings.json", JSON.stringify({ rev: 2, values: { bgcolor: "#336699" } }));
  top("profile.json", JSON.stringify({ name: "Ada", email: null, email_yes: false, work: null, agent: null, time_zone: null }));
  top("run.config.json", JSON.stringify({ port: w.port, lanes: [] }));
  top("seed.json", JSON.stringify({ title: "seed", items: [] }));
  top("vapid-key.pem", "-----BEGIN EC PRIVATE KEY-----\nfake\n-----END EC PRIVATE KEY-----\n");
  top("bridge-auth.json", JSON.stringify({ version: 1, salt: "00", password: "00", sessions: [] }));
  top("tokens-cache.json", JSON.stringify({ version: 1, files: {} }));
  top(".facilitator-updates.json", JSON.stringify({ ran: {} }));
  fs.mkdirSync(path.join(w.user, "magic-boxes"), { mode: 0o700 });
  top("magic-boxes/m1-3.json", JSON.stringify({ kind: "text", text: "a box" }));
  fs.mkdirSync(path.join(w.user, "uploads"));
  top("uploads/1700000000000-old.png", "old in-repo picture");
  top("uploads/m901-keys-lit.png", "the old in-repo copy");
  fs.mkdirSync(path.join(w.beside, "uploads", "mdpanel-20260828"), { recursive: true });
  fs.mkdirSync(path.join(w.beside, "logs"), { recursive: true });
  for (const name of ODD) fs.writeFileSync(path.join(w.beside, "uploads", name), `attachment ${name}`);
  fs.writeFileSync(path.join(w.beside, "uploads", "m901-keys-lit.png"), "the copy the board serves");
  fs.writeFileSync(path.join(w.beside, "uploads", "mdpanel-20260828", "panel.png"), "panel picture");
  fs.writeFileSync(path.join(w.beside, "logs", "server-20261001.log"), '{"kind":"start"}\n');
  fs.writeFileSync(path.join(w.beside, "logs", "bridge-20261001.log"), '{"kind":"shareon"}\n');
  fs.writeFileSync(path.join(w.beside, "notes.md"), "my own notes, not the board's\n");
  fs.mkdirSync(path.join(w.user, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(w.user, ".venv", "pyvenv.cfg"), "home = /fake\nversion_info = 3.14.0\n");
  script(path.join(w.user, ".venv", "bin", "python3"), `#!/bin/sh\nexec ${JSON.stringify(PYTHON)} "$@"\n`);
  fs.copyFileSync(path.join(w.user, ".venv", "bin", "python3"), path.join(w.user, ".venv", "bin", "python"));
}

async function waitBoard(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/state`);
      if (answer.ok) return answer.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`nothing answered on ${port}`);
}

async function boardDown(port) {
  try { await fetch(`http://127.0.0.1:${port}/state`); return false; } catch { return true; }
}

// the older board itself, run from the checkout's top on the same Python the
// commands run on, as `facilitator run` would have started it
async function startOldBoard(w) {
  const child = spawn(PYTHON, [path.join(w.user, "server.py")], { cwd: w.user, env: w.env, stdio: "ignore", detached: true });
  started.add(child.pid);
  const st = await waitBoard(w.port);
  assert.equal(st.pwd, w.user, "the old board names another folder");
  return child.pid;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// the new board's pid, read from its lock, remembered for the clean-up
function newBoardPid(w) {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(w.data, "server.lock"), "utf8")).pid;
    if (pid) started.add(pid);
    return pid;
  } catch { return null; }
}

// the board's files in their old places, by checksum, and the logs' text
function oldSnapshot(w) {
  const top = {};
  for (const name of fs.readdirSync(w.user))
    if (!["app", "data", ".git", ".gitignore", "facilitator", "server.py", "bridge_auth.py", "bridge_gate.py",
          "m-gate.html", "index.html", "requirements.txt", "updates", ".venv", "server.lock", "__pycache__",
          "bridge-auth.lock"].includes(name)) {
      const p = path.join(w.user, name);
      if (fs.statSync(p).isDirectory()) for (const [rel, s] of Object.entries(tree(p))) top[path.join(name, rel)] = s;
      else top[name] = sha(p);
    }
  const logs = path.join(w.beside, "logs");
  const logText = {};
  if (fs.existsSync(logs)) for (const name of fs.readdirSync(logs)) logText[name] = fs.readFileSync(path.join(logs, name));
  return { top, uploads: tree(path.join(w.beside, "uploads")), logText };
}

// files a running board writes as it goes: the old one until it is stopped,
// the new one from when it starts. The rest must arrive byte for byte as the
// snapshot before the update saw them.
const LIVE = new Set(["state.json", "transcript.jsonl", "settings.json", "tokens-cache.json", "claude-limits.json",
  "usage-counts.json", "usage-install.json", "run.config.json", ".facilitator-updates.json"]);
const live = to => LIVE.has(to) || to.startsWith("logs/");

const ids = st => st.boxes.map(box => box.id).sort();

test("a fresh install has nothing to move: no board files step, and its board starts on data/", async () => {
  const w = await makeWorld({ fresh: true });
  fs.mkdirSync(w.data);
  fs.writeFileSync(path.join(w.data, "run.config.json"), JSON.stringify({ port: w.port, lanes: [] }));
  const res = await w.update();
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(sectionTitles(res.stdout), ["1. Checkout", "2. Update steps", "3. Board"]);
  assert.doesNotMatch(res.stdout, /Board files|Backed up|moved/i);
  assert.equal(fs.existsSync(path.join(w.data, ".moved")), false, "a fresh install recorded a move");
  assert.equal(fs.existsSync(path.join(w.data, "backups")), false);
  assert.ok(fs.existsSync(path.join(w.data, ".venv", "pyvenv.cfg")), "the .venv was not made in data/");
  // its board starts with nothing in the way and keeps everything in data/
  const child = spawn(PYTHON, [path.join(w.user, "app", "server.py")], { cwd: w.user, env: w.env, stdio: "ignore", detached: true });
  started.add(child.pid);
  const st = await waitBoard(w.port);
  assert.equal(st.pwd, w.user);
  assert.ok(fs.existsSync(path.join(w.data, "state.json")));
  assert.deepEqual(fs.readdirSync(w.user).filter(n => !n.startsWith(".")).sort(), ["app", "data", "facilitator"]);
  assert.equal(fs.existsSync(w.beside), false, "a folder appeared beside the clone");
  process.kill(child.pid, "SIGTERM");
});

test("an older checkout with its board running moves every file into data/ through its own update", async () => {
  const w = await makeWorld();
  fillOldBoard(w);
  const oldPid = await startOldBoard(w);
  const before = await (await fetch(`http://127.0.0.1:${w.port}/state`)).json();
  assert.deepEqual(ids(before), [...CARDS].sort());
  await new Promise(resolve => setTimeout(resolve, 300));
  const snap = oldSnapshot(w);
  w.pushNew();

  const res = await w.update();
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(sectionTitles(res.stdout), ["1. Checkout", "2. Board files", "3. Update steps", "4. Board"]);
  assert.match(res.stdout, new RegExp(`Stopped the board on port ${w.port} to move its files\\.`));
  assert.match(res.stdout, /✓ Backed up \d+ files \([^)]*\) to data\/backups\/before-data-move-\d{8}-\d{6}\./);
  assert.match(res.stdout, /✓ Copied \d+ files \([^)]*\) into data\/ and checked each one\./);
  assert.match(res.stdout, /✓ Moved \.venv into data\//);
  assert.match(res.stdout, /The board was stopped to move its files into data\/\. Starting it again\./);
  assert.match(res.stdout, new RegExp(`✓ The board shows all ${CARDS.length} cards from data/\\.`));
  assert.match(res.stdout, /✓ Removed the old copies \(\d+ files\)\. The backup stays in data\/backups\/before-data-move-/);
  assert.match(res.stdout, /Old version: v0\.2\.414\nNew version: v0\.2\.415/);
  assert.equal(alive(oldPid), false, "the old board is still running");
  assert.equal(fs.existsSync(w.opened) ? fs.readFileSync(w.opened, "utf8") : "", "", "a window was opened");

  // the board answers from app/ with the same cards, the one board of this folder
  const after = await waitBoard(w.port);
  newBoardPid(w);
  assert.equal(after.pwd, w.user);
  assert.deepEqual(ids(after), ids(before));

  // every file is in data/ with the bytes it had; the old in-repo uploads/
  // became uploads-old, so the two pictures of one name are both kept
  const moved = JSON.parse(fs.readFileSync(path.join(w.data, ".moved"), "utf8"));
  assert.ok(moved.finished, "the finish did not record itself");
  assert.deepEqual(moved.kept, []);
  const byTo = Object.fromEntries(moved.items.map(item => [item.to, item]));
  const expected = {};
  for (const [rel, s] of Object.entries(snap.top))
    expected[rel.startsWith("uploads/") ? rel.replace(/^uploads\//, "uploads-old/") : rel] = s;
  for (const [rel, s] of Object.entries(snap.uploads)) expected[`uploads/${rel}`] = s;
  for (const name of Object.keys(snap.logText)) expected[`logs/${name}`] = null;
  for (const [to, s] of Object.entries(expected)) {
    assert.ok(byTo[to], `${to} was not moved`);
    if (!live(to)) {
      assert.equal(byTo[to].sha256, s, `${to} changed between the snapshot and the move`);
      assert.equal(sha(path.join(w.data, to)), s, `${to} did not arrive unchanged`);
    }
  }
  // a log carries every line the old board wrote, and the new board's after them
  for (const [name, text] of Object.entries(snap.logText)) {
    const now = fs.readFileSync(path.join(w.data, "logs", name));
    assert.ok(now.subarray(0, text.length).equals(text), `logs/${name} lost lines in the move`);
  }
  assert.equal(fs.readFileSync(path.join(w.data, "uploads", "m901-keys-lit.png"), "utf8"), "the copy the board serves");
  assert.equal(fs.readFileSync(path.join(w.data, "uploads-old", "m901-keys-lit.png"), "utf8"), "the old in-repo copy");
  const served = await fetch(`http://127.0.0.1:${w.port}/uploads/m901-keys-lit.png`);
  assert.equal(await served.text(), "the copy the board serves", "a different picture is served for the same address");
  assert.equal(await (await fetch(`http://127.0.0.1:${w.port}/uploads/1700000000000-old.png`)).text(), "old in-repo picture");

  // the backup holds every file as it was, and stays
  const backup = path.join(w.data, "backups", moved.backup);
  for (const item of moved.items) assert.equal(sha(path.join(backup, item.backup)), item.sha256, item.backup);
  assert.match(fs.readFileSync(path.join(backup, "README.txt"), "utf8"), /Nothing\nreads this folder, and nothing removes it/);
  assert.equal(fs.statSync(path.join(backup, "checkout", "magic-boxes", "m1-3.json")).isFile(), true);

  // the old copies are gone; the notes beside the checkout and the folder stay
  for (const rel of Object.keys(snap.top)) assert.equal(fs.existsSync(path.join(w.user, rel)), false, `${rel} was left at the top`);
  for (const name of ["uploads", "magic-boxes", ".venv", "server.lock", "tests"])
    assert.equal(fs.existsSync(path.join(w.user, name)), false, `${name} was left at the top`);
  assert.deepEqual(fs.readdirSync(w.beside), ["notes.md"]);
  assert.equal(fs.readFileSync(path.join(w.beside, "notes.md"), "utf8"), "my own notes, not the board's\n");
  assert.deepEqual(fs.readdirSync(w.user).filter(n => !n.startsWith(".")).sort(), ["app", "data", "facilitator"]);
  assert.equal(w.git(w.user, "status", "--porcelain"), "", "the move left git with something to say");
  assert.equal((fs.statSync(w.data).mode & 0o777), 0o700);

  // an update after the move has nothing to move and changes nothing
  const inData = tree(w.data);
  const again = await w.update();
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.deepEqual(sectionTitles(again.stdout), ["1. Checkout", "2. Update steps", "3. Board"]);
  assert.equal(await (await fetch(`http://127.0.0.1:${w.port}/state`)).ok, true, "the board went down");
  const still = tree(w.data);
  for (const [rel, s] of Object.entries(inData))
    if (!live(rel) && rel !== "server.lock") assert.equal(still[rel], s, `${rel} changed on an update after the move`);
  process.kill(newBoardPid(w), "SIGTERM");
});

for (const point of ["backup", "copy", "before-record"]) {
  test(`a move cut off at ${point} keeps the board down and every old file whole, and the next update finishes it`, async () => {
    const w = await makeWorld();
    fillOldBoard(w);
    await startOldBoard(w);
    await new Promise(resolve => setTimeout(resolve, 300));
    w.pushNew();
    const snap = oldSnapshot(w);
    const cut = await w.update({ FACILITATOR_TEST_MOVE_STOP: point });
    assert.equal(cut.code, 9, `the move was not cut off: ${cut.stdout}${cut.stderr}`);
    assert.match(cut.stdout, /Stopped the board on port \d+ to move its files\./);
    assert.ok(fs.existsSync(path.join(w.data, ".moving")), "no marker is left");
    assert.equal(fs.existsSync(path.join(w.data, ".moved")), false);
    // every old file is where it was, with the bytes it had when the old board
    // stopped, which the backup or the marker's plan saw
    const now = oldSnapshot(w);
    assert.deepEqual(now.uploads, snap.uploads);
    for (const [rel, s] of Object.entries(snap.top)) if (!live(rel)) assert.equal(now.top[rel], s, rel);
    for (const [name, text] of Object.entries(snap.logText))
      assert.ok(now.logText[name].subarray(0, text.length).equals(text), name);
    assert.ok(fs.existsSync(path.join(w.user, "state.json")), "the old state.json went");
    // the board stays down, and the server and the command say why, writing nothing
    assert.equal(await boardDown(w.port), true, "a board is running in the middle of the move");
    const inData = tree(w.data);
    const server = await run(PYTHON, [path.join(w.user, "app", "server.py")], { cwd: w.user, env: w.env, timeout: 30000 });
    assert.equal(server.code, 1);
    assert.match(server.stderr, /part way through moving into data\/.*Run facilitator update to finish the move/s);
    assert.deepEqual(tree(w.data), inData, "the refused server wrote into data/");
    const status = await run(PYTHON, [w.cli, "status"], { cwd: w.base, env: w.env });
    assert.equal(status.code, 1);
    assert.match(status.stderr, /Run facilitator update to finish the move\./);
    const runIt = await run(PYTHON, [w.cli, "run"], { cwd: w.base, env: w.env });
    assert.equal(runIt.code, 1);
    assert.match(runIt.stderr, /part way through moving into data\//);

    // the next update finishes it and starts the board the first one stopped
    const rerun = await w.update();
    assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
    assert.match(rerun.stdout, /2\. Board files/);
    if (point !== "backup") assert.match(rerun.stdout, /Kept the backup an earlier run made/);
    assert.match(rerun.stdout, /The board was stopped to move its files into data\/\. Starting it again\./);
    assert.match(rerun.stdout, new RegExp(`The board shows all ${CARDS.length} cards from data/\\.`));
    const st = await waitBoard(w.port);
    newBoardPid(w);
    assert.deepEqual(ids(st), [...CARDS].sort());
    for (const [rel, s] of Object.entries(snap.uploads)) assert.equal(sha(path.join(w.data, "uploads", rel)), s, rel);
    const record = JSON.parse(fs.readFileSync(path.join(w.data, ".moved"), "utf8"));
    assert.deepEqual(record.kept, []);
    const backup = path.join(w.data, "backups", record.backup);
    for (const item of record.items) {
      assert.equal(sha(path.join(backup, item.backup)), item.sha256, item.backup);
      if (!live(item.to)) assert.equal(sha(path.join(w.data, item.to)), item.sha256, item.to);
    }
    const backups = fs.readdirSync(path.join(w.data, "backups"));
    assert.equal(backups.filter(n => n.endsWith(".partial")).length, 0, "a half-made backup was left");
    assert.equal(fs.existsSync(path.join(w.data, ".moving-staging")), false);
    assert.equal(fs.existsSync(path.join(w.data, ".moving")), false);
    assert.deepEqual(fs.readdirSync(w.beside), ["notes.md"]);
    process.kill(newBoardPid(w), "SIGTERM");
  });
}

test("a file in both places stops the move before the board is stopped, names both, and moves nothing", async () => {
  const w = await makeWorld();
  fillOldBoard(w);
  const oldPid = await startOldBoard(w);
  await new Promise(resolve => setTimeout(resolve, 300));
  // something already in data/ under the name of an old file, with other bytes
  fs.mkdirSync(w.data);
  fs.writeFileSync(path.join(w.data, "settings.json"), '{"made":"by hand"}');
  w.pushNew();
  const snap = oldSnapshot(w);
  const res = await w.update();
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /These files are in their old place and in data\/ both, and they differ:/);
  assert.ok(res.stderr.includes(`${path.join(w.user, "settings.json")}  and  ${path.join(w.data, "settings.json")}`), res.stderr);
  assert.match(res.stderr, /Move one of each pair out of the way, then run facilitator update again\.\n  Nothing was moved\.\n$/);
  assert.equal(alive(oldPid), true, "the board was stopped although nothing could move");
  assert.equal(fs.existsSync(path.join(w.data, ".moving")), false);
  assert.equal(fs.existsSync(path.join(w.data, "backups")), false);
  assert.deepEqual(fs.readdirSync(w.data), ["settings.json"]);
  assert.deepEqual(oldSnapshot(w).uploads, snap.uploads);
  assert.ok(fs.existsSync(path.join(w.user, ".venv", "pyvenv.cfg")), "the .venv moved");
  assert.equal(fs.readFileSync(path.join(w.data, "settings.json"), "utf8"), '{"made":"by hand"}');

  // moved out of the way, the next update goes through
  fs.renameSync(path.join(w.data, "settings.json"), path.join(w.base, "settings-by-hand.json"));
  const rerun = await w.update();
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout, /Stopped the board on port \d+ to move its files\./);
  assert.match(rerun.stdout, /Removed the old copies/);
  assert.equal(alive(oldPid), false);
  assert.deepEqual(ids(await waitBoard(w.port)), [...CARDS].sort());
  newBoardPid(w);
  process.kill(newBoardPid(w), "SIGTERM");
});

test("a file the move cannot read stops it after the board was stopped; the next update moves everything and starts the board", async () => {
  const w = await makeWorld();
  fillOldBoard(w);
  const oldPid = await startOldBoard(w);
  await new Promise(resolve => setTimeout(resolve, 300));
  w.pushNew();
  const locked = path.join(w.beside, "uploads", ODD[2]);
  fs.chmodSync(locked, 0o000);
  let res;
  try {
    res = await w.update();
  } finally {
    fs.chmodSync(locked, 0o644);
  }
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /Stopped the board on port \d+ to move its files\./);
  assert.ok(res.stderr.includes(`⚠ The move into data/ stopped part way: Permission denied: ${locked}.\n`
    + "  Nothing old was removed.\n  Fix that, then run facilitator update again: it carries on from here.\n"
    + "  The board stays down until its files are in data/. Once the update goes through, it starts again: "
    + "run facilitator update."), res.stderr);
  assert.equal(alive(oldPid), false);
  assert.equal(await boardDown(w.port), true);
  // nothing was copied or backed up; the marker keeps the board down and
  // remembers that this update stopped it
  assert.deepEqual(fs.readdirSync(w.data).sort(), [".moving", "server.lock"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.data, ".moving"), "utf8")).stopped_board, true);
  const runIt = await run(PYTHON, [w.cli, "run"], { cwd: w.base, env: w.env });
  assert.equal(runIt.code, 1);
  assert.match(runIt.stderr, /part way through moving into data\//);

  const rerun = await w.update();
  assert.equal(rerun.code, 0, rerun.stdout + rerun.stderr);
  assert.doesNotMatch(rerun.stdout, /Stopped the board/);
  assert.match(rerun.stdout, /The board was stopped to move its files into data\/\. Starting it again\./);
  assert.match(rerun.stdout, /Removed the old copies/);
  assert.deepEqual(ids(await waitBoard(w.port)), [...CARDS].sort());
  newBoardPid(w);
  assert.equal(fs.readFileSync(path.join(w.data, "uploads", ODD[2]), "utf8"), `attachment ${ODD[2]}`);
  process.kill(newBoardPid(w), "SIGTERM");
});

test("a pull by hand with no update leaves the new command and server refusing, naming facilitator update", async () => {
  const w = await makeWorld();
  fillOldBoard(w);
  w.pushNew();
  w.git(w.user, "pull", "-q", "--ff-only");
  for (const words of [["status"], ["run"], ["restart"], ["magic", "m1", "show"], ["uninstall", "--keep-attachments"]]) {
    const res = await run(PYTHON, [w.cli, ...words], { cwd: w.base, env: w.env });
    assert.equal(res.code, 1, words.join(" "));
    assert.match(res.stderr, /still in their old place at the top of .* \(.*\), so the board stayed down\.\n  Run facilitator update to move them into data\/\. Nothing was changed\./, words.join(" "));
  }
  const help = await run(PYTHON, [w.cli, "uninstall", "--help"], { cwd: w.base, env: w.env });
  assert.equal(help.code, 0, "help is refused in the middle of the move");
  const server = await run(PYTHON, [path.join(w.user, "app", "server.py")], { cwd: w.user, env: w.env, timeout: 30000 });
  assert.equal(server.code, 1);
  assert.match(server.stderr, /still in their old place/);
  assert.equal(fs.existsSync(w.data), false, "the refused server made data/");
  assert.ok(fs.existsSync(path.join(w.user, "state.json")));
});

// the finish's own rules, on a move made in a folder of its own: a card the
// board does not show keeps every old copy; a file changed after it was copied
// is kept; the folder beside is kept when another copy of the board uses it;
// and nothing is removed through a link
function pyHere(w, code) {
  return execFileSync(PYTHON, ["-c", code], { cwd: path.join(w.user, "app"), env: w.env, encoding: "utf8" });
}

async function movedWorld() {
  const w = await makeWorld();
  fillOldBoard(w);
  w.pushNew();
  w.git(w.user, "pull", "-q", "--ff-only");
  pyHere(w, "import data_folder, pathlib\nclone = pathlib.Path('..').resolve()\n"
    + "with data_folder.Locks(clone):\n    data_folder.move(clone, data_folder.plan(clone))\n");
  return w;
}

test("the finish keeps every old copy while a card the old board held is not shown", async () => {
  const w = await movedWorld();
  const out = pyHere(w, `
import importlib.machinery, importlib.util, io, contextlib, json
loader = importlib.machinery.SourceFileLoader("cli", "facilitator")
spec = importlib.util.spec_from_loader(loader.name, loader)
cli = importlib.util.module_from_spec(spec)
loader.exec_module(cli)
cli.new_board_up = lambda port: (1, ("t", "python", ("python", str(cli.HERE / "server.py"))))
cli.board_state = lambda port: {"boxes": [{"id": "m1"}, {"id": "m2"}], "listening": {}, "busy": {}, "listenerGap": {}}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    cli.finish_move({"finish": True, "running_before": True})
print(json.dumps(buf.getvalue()))
`);
  const said = JSON.parse(out.trim().split("\n").at(-1));
  assert.match(said, /Kept the old copies: 5 of the 7 cards the old state\.json held are not on the board \(for example m3\)\./);
  assert.match(said, /removed by the next facilitator update once the board shows your cards/);
  assert.ok(fs.existsSync(path.join(w.user, "state.json")), "an old copy was removed");
  assert.ok(fs.existsSync(path.join(w.beside, "uploads", ODD[0])));
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.data, ".moved"), "utf8")).finished, null);
});

test("the finish keeps a file changed after it was copied, and removes the rest", async () => {
  const w = await movedWorld();
  fs.appendFileSync(path.join(w.beside, "logs", "server-20261001.log"), '{"kind":"late line"}\n');
  const out = pyHere(w, "import data_folder, pathlib, json\nprint(json.dumps(data_folder.finish(pathlib.Path('..').resolve())))");
  const [removed, kept] = JSON.parse(out.trim().split("\n").at(-1));
  assert.ok(removed > 10);
  assert.deepEqual(kept, [[path.join(w.beside, "logs", "server-20261001.log"), "it changed after it was copied"]]);
  assert.ok(fs.existsSync(path.join(w.beside, "logs", "server-20261001.log")));
  assert.equal(fs.existsSync(path.join(w.beside, "uploads")), false);
  assert.equal(fs.existsSync(path.join(w.user, "state.json")), false);
});

test("the finish keeps the folder beside while another copy of the board there still keeps its own board", async () => {
  const w = await movedWorld();
  const other = path.join(w.parent, "facilitator-second");
  fs.mkdirSync(other);
  for (const name of ["server.py", "facilitator", "state.json"]) fs.writeFileSync(path.join(other, name), "{}");
  const out = pyHere(w, "import data_folder, pathlib, json\nprint(json.dumps(data_folder.finish(pathlib.Path('..').resolve())))");
  const [, kept] = JSON.parse(out.trim().split("\n").at(-1));
  assert.ok(kept.length > 0 && kept.every(([where, why]) => where.startsWith(w.beside) && /facilitator-second/.test(why)), JSON.stringify(kept));
  assert.ok(fs.existsSync(path.join(w.beside, "uploads", ODD[0])), "the shared attachments were removed");
  assert.equal(fs.existsSync(path.join(w.user, "state.json")), false, "the checkout's own old copies stayed");
});

test("an attachments folder reached through a link is copied, and nothing is removed through it", async () => {
  const w = await makeWorld();
  fillOldBoard(w);
  const elsewhere = path.join(w.base, "elsewhere-uploads");
  fs.renameSync(path.join(w.beside, "uploads"), elsewhere);
  fs.symlinkSync(elsewhere, path.join(w.beside, "uploads"));
  w.pushNew();
  w.git(w.user, "pull", "-q", "--ff-only");
  pyHere(w, "import data_folder, pathlib\nclone = pathlib.Path('..').resolve()\n"
    + "with data_folder.Locks(clone):\n    data_folder.move(clone, data_folder.plan(clone))\n"
    + "data_folder.finish(clone)\n");
  assert.equal(fs.readFileSync(path.join(w.data, "uploads", ODD[0]), "utf8"), `attachment ${ODD[0]}`);
  assert.equal(fs.readFileSync(path.join(elsewhere, ODD[0]), "utf8"), `attachment ${ODD[0]}`, "a file was removed through the link");
  assert.ok(fs.lstatSync(path.join(w.beside, "uploads")).isSymbolicLink());
});
