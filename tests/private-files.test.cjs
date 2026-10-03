// What the board writes about its owner's work (state, transcript, logs, the
// push key, settings, token counts, uploads) can be read by the owner's Mac
// account alone, whatever the account's umask. A board that earlier left such
// files readable by other accounts is tightened when it starts, and nothing
// that is not the board's own is touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { ROOT, startBoard } = require("./board-fixture.cjs");

const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const day = back => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
const claudeLine = JSON.stringify({
  type: "assistant", timestamp: day(1) + "T10:00:00Z",
  message: { id: "msg_private", role: "assistant", content: [{ type: "text", text: "invented words" }],
             usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
});

const boards = [];
let home, umask, scratch;

// the account's umask is pinned loose for these tests: that is the case a file
// made with a plain open() is readable by others in
before(() => {
  umask = process.umask(0o022);
  home = fs.mkdtempSync(path.join(tmpdir(), "facilitator-private-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "p", "s.jsonl"), claudeLine + "\n");
  scratch = fs.mkdtempSync(path.join(tmpdir(), "facilitator-private-scratch-"));
});

after(async () => {
  for (const board of boards) await board.stop();
  process.umask(umask);
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

async function board() {
  const b = await startBoard({ extra: ["tokens.py"], env: { HOME: home, TZ: "UTC" } });
  boards.push(b);
  return b;
}

// the board does everything that writes a file of its own
async function exercise(b) {
  assert.equal((await b.call("POST", "/send?box=0", "a first message")).status, 200);
  assert.equal((await b.call("GET", "/push/key")).status, 200);
  assert.equal((await b.call("POST", "/settings", JSON.stringify({ bgcolor: "#336699" }))).status, 200);
  assert.equal((await b.call("GET", "/tokens/daily?days=3")).status, 200);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(b.app, "transcript.jsonl")) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25));
}

const mode = file => fs.lstatSync(file).mode & 0o777;
const logsOf = (b, pattern) => fs.readdirSync(b.logs).filter(name => pattern.test(name)).map(name => path.join(b.logs, name));
const octal = file => `${path.basename(file)} is ${mode(file).toString(8)}`;

test("every file a fresh board writes is readable by its owner alone", async () => {
  const b = await board();
  await exercise(b);
  const written = ["state.json", "transcript.jsonl", "settings.json", "vapid-key.pem", "tokens-cache.json", "server.lock"]
    .map(name => path.join(b.app, name));
  written.push(...logsOf(b, /^server-\d{8}(\.\d+)?\.log$/));
  assert.ok(written.length >= 7, "the server's log file is among them");
  for (const file of written) assert.ok(fs.existsSync(file), `${path.basename(file)} was not written`);
  const loose = written.filter(file => mode(file) & 0o077).map(octal);
  assert.deepEqual(loose, [], "files other accounts can read");
});

test("files an earlier board left readable by others are tightened at startup, and only those", async () => {
  const b = await board();
  await exercise(b);
  const internal = path.join(b.outer, "facilitator-internal");
  const uploads = path.join(internal, "uploads");
  const legacyUploads = path.join(b.app, "uploads");
  const outside = path.join(scratch, "not-the-boards.txt");
  const theirs = [outside, path.join(internal, "lane-notes.md"), path.join(b.logs, "notes.txt"),
    path.join(b.app, "server.py"), path.join(b.app, "index.html"), path.join(b.app, "seed.json")];
  const oldBackup = "state.json.bak-20200101T000000";
  const ours = ["state.json", oldBackup, "state.tmp", "transcript.jsonl", "settings.json", "settings.json.tmp",
    "settings.json.bad-20200101T000000", "vapid-key.pem", "bridge-auth.json", "tokens-cache.json", "claude-limits.json",
    "server.lock"].map(name => path.join(b.app, name));
  const olderLogs = ["server-20200101.log", "client-20200101.jsonl", "bridge-20200101.log"].map(name => path.join(b.logs, name));
  const kept = [path.join(uploads, "picture.png"), path.join(uploads, ".half.part"), path.join(legacyUploads, "old.png")];

  await b.restart(async () => {
    fs.mkdirSync(uploads, { recursive: true });
    fs.mkdirSync(legacyUploads, { recursive: true });
    // a state file from before revisions makes the board copy it as a backup
    const state = path.join(b.app, "state.json");
    const parsed = JSON.parse(fs.readFileSync(state, "utf8"));
    delete parsed.rev;
    fs.writeFileSync(state, JSON.stringify(parsed));
    for (const file of [...ours, ...olderLogs, ...kept, ...theirs]) {
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, path.basename(file) === "bridge-auth.json"
        ? JSON.stringify({ version: 1, salt: "", password: "", sessions: [] }) : "{}\n");
    }
    fs.symlinkSync(outside, path.join(b.app, "state.json.bak-link"));
    for (const file of [...ours, ...olderLogs, ...logsOf(b, /\.(log|jsonl)$/), ...kept, ...theirs]) fs.chmodSync(file, 0o644);
  });

  const made = fs.readdirSync(b.app).filter(name => /^state\.json\.bak-\d{8}T\d{6}$/.test(name) && name !== oldBackup);
  assert.equal(made.length, 1, "the board copied the old-style state as a backup");
  const boardFiles = [...new Set([...ours, ...olderLogs, ...logsOf(b, /^(server|client|bridge)-.*\.(log|jsonl)$/), ...kept,
    path.join(b.app, made[0])])];
  // the stale state.tmp is the one file the starting board renames away itself
  for (const file of boardFiles) assert.ok(fs.existsSync(file) || file.endsWith("state.tmp"), `${path.basename(file)} is gone`);
  const loose = boardFiles.filter(file => fs.existsSync(file) && mode(file) & 0o077).map(octal);
  assert.deepEqual(loose, [], "board files other accounts can still read");

  for (const file of theirs) assert.equal(mode(file), 0o644, `${path.basename(file)} is not the board's and was changed`);
});

test("the plan limits file claude-statusline.py keeps is readable by its owner alone, new or replaced", () => {
  const folder = fs.mkdtempSync(path.join(scratch, "statusline-"));
  fs.copyFileSync(path.join(ROOT, "claude-statusline.py"), path.join(folder, "claude-statusline.py"));
  const limits = path.join(folder, "claude-limits.json");
  const send = used => execFileSync(PYTHON, [path.join(folder, "claude-statusline.py")], {
    input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: used, resets_at: 1700000000 } } }),
  });
  send(12);
  assert.equal(mode(limits), 0o600, "a new file");
  fs.chmodSync(limits, 0o644);
  send(13);
  assert.equal(JSON.parse(fs.readFileSync(limits, "utf8")).five_hour.used_percentage, 13);
  assert.equal(mode(limits), 0o600, "a replaced file");
});
