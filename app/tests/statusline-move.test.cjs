// What the move does for a Claude Code status line that still runs the script
// from the checkout's old top, <checkout>/claude-statusline.py, now in app/.
// statusline_fix() of the facilitator command is called on a copy of the
// program in a temp folder, with HOME inside it, so the real settings file is
// never read or written. The settings files and records an older install left
// come from tests/fixtures/older-statusline-installs.json.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const OLDER = require("./fixtures/older-statusline-installs.json");
const folders = [];
after(async () => { for (const dir of folders) await fs.rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-statusline-move-")));
  folders.push(dir);
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const app = path.join(repo, "app");
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.mkdir(path.join(repo, "data"), { recursive: true });
  await fs.mkdir(app, { recursive: true });
  for (const file of ["facilitator", "shell_integration.py", "data_folder.py", "claude-statusline.py"])
    await fs.copyFile(path.join(ROOT, file), path.join(app, file));
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };
  for (const name of ["CLAUDE_CONFIG_DIR", "FACILITATOR_LOG_DIR"]) delete env[name];
  return { dir, home, repo, app, env, settings: path.join(home, ".claude", "settings.json"),
    old: path.join(repo, "claude-statusline.py"), now: path.join(app, "claude-statusline.py"),
    record: path.join(repo, "data", ".facilitator-statusline.json"), backups: path.join(repo, "data", "backups") };
}

// statusline_fix() as the move calls it; what it printed
const FIX = `
import importlib.machinery, importlib.util, sys
loader = importlib.machinery.SourceFileLoader("facilitator_command", sys.argv[1])
spec = importlib.util.spec_from_loader("facilitator_command", loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)
module.statusline_fix()
`;
const fix = async (f, env = f.env) => (await exec("python3", ["-c", FIX, path.join(f.app, "facilitator")], { env, cwd: f.dir })).stdout;
const uninstall = (f, env = f.env) => exec("python3", ["-c", "import shell_integration as s\ns.statusline_uninstall()"], { env, cwd: f.app });
const read = file => fs.readFile(file, "utf8");
const exists = file => fs.access(file).then(() => true, () => false);
const backupsOf = async f => (await exists(f.backups)) ? await fs.readdir(f.backups) : [];

// the old install's files, with the script named where it was before app/
const fill = (f, text) => text.split("@SCRIPT@").join(f.old).split("@SETTINGS@").join(f.settings);
async function older(f, name) {
  const found = OLDER[name];
  await fs.writeFile(f.settings, fill(f, found.after));
  await fs.writeFile(f.record, fill(f, found.record));
  return found;
}

test("a status line that runs the old path now runs app/, in every layout, and uninstall still gives the file back", async () => {
  for (const [name, found] of Object.entries(OLDER)) {
    const f = await fixture();
    await older(f, name);
    const was = await read(f.settings);
    const out = await fix(f);
    assert.equal(out, `✓ Changed the status line command in ${f.settings} to run ${f.now}. ` +
      `The file before is in data/backups/${(await backupsOf(f))[0]}.\n`, name);
    assert.equal(await read(f.settings), was.split(f.old).join(f.now), `${name}: only the path changed`);
    // the backup is the file as it was, kept private beside the move's backups
    const backups = await backupsOf(f);
    assert.equal(backups.length, 1, name);
    assert.match(backups[0], /^claude-settings-before-statusline-move-\d{8}-\d{6}\.json$/);
    assert.equal(await read(path.join(f.backups, backups[0])), was, name);
    assert.equal((await fs.stat(path.join(f.backups, backups[0]))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.backups)).mode & 0o777, 0o700);
    assert.deepEqual((await fs.readdir(path.dirname(f.settings))).filter(n => n !== "settings.json"), [], `${name}: a temp file was left`);
    // the record names the new path, so uninstall finds the entry as install wrote it
    const record = JSON.parse(await read(f.record));
    assert.equal(record.script, f.now, name);
    assert.equal(record.entry.command.includes(f.old), false, name);
    await uninstall(f);
    if (found.before === null) assert.equal(await exists(f.settings), false, name);
    else assert.equal(await read(f.settings), found.before, `${name}: back to what it was`);
    assert.equal(await exists(f.record), false, name);
  }
});

test("a wrapped command keeps what follows the path, and still runs and shows the wrapped line", async () => {
  const f = await fixture();
  const found = await older(f, "wrapped");
  const was = await read(f.settings);
  await fix(f);
  const after = JSON.parse(await read(f.settings));
  assert.equal(after.statusLine.command, `python3 ${f.now} 'echo é "mine" $HOME'`);
  assert.equal(after.statusLine.padding, 2);
  assert.equal(after.model, "opus");
  assert.equal(await read(f.settings), was.split(f.old).join(f.now));
  assert.equal(JSON.parse(await read(f.record)).original, JSON.parse(fill(f, found.record)).original, "the wrapped command in the record is untouched");
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 4102444800 } } });
  const shown = spawnSync("sh", ["-c", after.statusLine.command], { input, encoding: "utf8", env: { ...f.env, HOME: "/invented" } });
  assert.equal(shown.stdout, "é mine /invented\n");
  assert.equal(JSON.parse(await read(path.join(f.repo, "data", "claude-limits.json"))).five_hour.used_percentage, 12);
});

test("a path with a space, or spelled with escapes in the JSON, is rewritten too", async () => {
  const f = await fixture();
  const quoted = JSON.stringify({ statusLine: { type: "command", command: `python3 '${f.old}' --x` } }, null, 2) + "\n";
  await fs.writeFile(f.settings, quoted);
  await fix(f);
  assert.equal(JSON.parse(await read(f.settings)).statusLine.command, `python3 '${f.now}' --x`);
  const g = await fixture();
  const escaped = `{"statusLine": {"command": "python3 ${g.old.split("/").join("\\/")}"}, "k": "é"}\n`;
  await fs.writeFile(g.settings, escaped);
  await fix(g);
  const settings = JSON.parse(await read(g.settings));
  assert.equal(settings.statusLine.command, `python3 ${g.now}`);
  assert.equal(settings.k, "é");
});

test("a status line that does not run exactly this checkout's old script is left alone", async () => {
  const other = f => [
    ["another command", "my-own-line --short"],
    ["another checkout", `python3 /elsewhere/facilitator/claude-statusline.py`],
    ["a path that ends with this one", `python3 /prefix${f.old}`],
    ["a longer file name", `python3 ${f.old}.bak`],
    ["a sibling file", `python3 ${f.old}x`],
    ["a longer folder name", `python3 ${f.repo}-2/claude-statusline.py`],
    ["the new path already", `python3 ${f.now}`],
    ["a sentence that ends with it", `echo see ${f.old}.`],
  ];
  const probe = await fixture();
  for (const [name] of other(probe)) {
    const f = await fixture();
    const text = JSON.stringify({ model: "opus", statusLine: { type: "command", command: other(f).find(([n]) => n === name)[1] } }, null, 2) + "\n";
    await fs.writeFile(f.settings, text);
    assert.equal(await fix(f), "", name);
    assert.equal(await read(f.settings), text, name);
    assert.deepEqual(await backupsOf(f), [], name);
  }
  // the path in some other key is not a status line
  const f = await fixture();
  const text = JSON.stringify({ env: { SCRIPT: f.old }, hooks: { x: `python3 ${f.old}` } }, null, 2) + "\n";
  await fs.writeFile(f.settings, text);
  assert.equal(await fix(f), "");
  assert.equal(await read(f.settings), text);
  // a status line that is not a command object
  const g = await fixture();
  const odd = `{"statusLine": "python3 ${g.old}"}\n`;
  await fs.writeFile(g.settings, odd);
  assert.equal(await fix(g), "");
  assert.equal(await read(g.settings), odd);
  // a record whose entry is not the old path keeps its words
  const h = await fixture();
  await older(h, "two spaces");
  await fs.writeFile(h.settings, JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
  const record = await read(h.record);
  assert.equal(await fix(h), "");
  assert.equal(await read(h.record), record, "the record stays while the settings do not show the new entry");
});

test("a missing settings file, or one that is not JSON, is not changed", async () => {
  const f = await fixture();
  assert.equal(await fix(f), "");
  assert.equal(await exists(f.settings), false, "a settings file appeared");
  assert.equal(await exists(path.join(f.home, ".claude", "settings.json.facilitator-tmp")), false);
  assert.deepEqual(await backupsOf(f), []);
  // a dangling link counts as missing
  await fs.symlink(path.join(f.dir, "nowhere.json"), f.settings);
  assert.equal(await fix(f), "");
  assert.equal(await exists(path.join(f.dir, "nowhere.json")), false);
  // not JSON, naming the old path: the hint, and the file as it was
  const g = await fixture();
  const broken = `{ "statusLine": { "command": "python3 ${g.old}" `;
  await fs.writeFile(g.settings, broken);
  assert.equal(await fix(g), `Claude Code's status line still runs ${g.old}, which is now ${g.now}.\n` +
    `Change it in ${g.settings} so the home page's limits stay current.\n`);
  assert.equal(await read(g.settings), broken);
  assert.deepEqual(await backupsOf(g), []);
  // not JSON and not naming it, or JSON that is not an object: nothing to say
  for (const text of ["{ not json", "", "[1, 2]", "null", '"python3"']) {
    const h = await fixture();
    await fs.writeFile(h.settings, text);
    assert.equal(await fix(h), "", JSON.stringify(text));
    assert.equal(await read(h.settings), text);
  }
  // the record is left as it was when the settings could not be read
  const k = await fixture();
  await older(k, "compact");
  await fs.writeFile(k.settings, "{ not json");
  const record = await read(k.record);
  await fix(k);
  assert.equal(await read(k.record), record);
});

test("a settings file that cannot be written is left whole and the hint is printed", async () => {
  const f = await fixture();
  const text = JSON.stringify({ statusLine: { type: "command", command: `python3 ${f.old}` } }, null, 2) + "\n";
  await fs.writeFile(f.settings, text);
  await fs.chmod(path.dirname(f.settings), 0o500);
  try {
    const out = await fix(f);
    if (process.getuid && process.getuid() !== 0) {
      assert.match(out, /Claude Code's status line still runs .*, which is now /);
      assert.equal(await read(f.settings), text);
    }
  } finally {
    await fs.chmod(path.dirname(f.settings), 0o700);
  }
});

test("run again, it changes nothing and says nothing", async () => {
  const f = await fixture();
  await older(f, "wrapped");
  assert.match(await fix(f), /^✓ Changed the status line command/);
  const settings = await read(f.settings);
  const record = await read(f.record);
  const backups = await backupsOf(f);
  assert.equal(await fix(f), "");
  assert.equal(await fix(f), "");
  assert.equal(await read(f.settings), settings);
  assert.equal(await read(f.record), record);
  assert.deepEqual(await backupsOf(f), backups);
});

test("a status line a person already fixed is not touched, and the record catches up to it", async () => {
  const f = await fixture();
  await older(f, "two spaces");
  const fixed = (await read(f.settings)).split(f.old).join(f.now);
  await fs.writeFile(f.settings, fixed);
  assert.equal(await fix(f), "");
  assert.equal(await read(f.settings), fixed);
  assert.deepEqual(await backupsOf(f), []);
  assert.equal(JSON.parse(await read(f.record)).script, f.now);
  await uninstall(f);
  assert.equal(await read(f.settings), OLDER["two spaces"].before);
});

test("the settings file the record names is fixed too, wherever CLAUDE_CONFIG_DIR points now", async () => {
  const f = await fixture();
  const recorded = path.join(f.dir, "claude-config", "settings.json");
  await fs.mkdir(path.dirname(recorded));
  f.settings = recorded;
  await older(f, "compact");
  const theirs = path.join(f.dir, "elsewhere");
  await fs.mkdir(theirs);
  await fix(f, { ...f.env, CLAUDE_CONFIG_DIR: theirs });
  assert.equal(await read(recorded), OLDER.compact.after.split("@SCRIPT@").join(f.now));
  assert.equal(await exists(path.join(theirs, "settings.json")), false, "the folder named now got a file");
  // and so is the one in the default place, when it names the old path as well
  const g = await fixture();
  await older(g, "compact");
  const other = path.join(g.dir, "claude-config");
  await fs.mkdir(other);
  const second = JSON.stringify({ statusLine: { type: "command", command: `python3 ${g.old} x` } });
  await fs.writeFile(path.join(other, "settings.json"), second);
  await fix(g, { ...g.env, CLAUDE_CONFIG_DIR: other });
  assert.equal(await read(path.join(other, "settings.json")), second.split(g.old).join(g.now));
  assert.equal(await read(g.settings), OLDER.compact.after.split("@SCRIPT@").join(g.now));
});

test("a settings file that is a link stays a link, and the target is fixed", async () => {
  const f = await fixture();
  const target = path.join(f.dir, "dotfiles-settings.json");
  const text = JSON.stringify({ statusLine: { type: "command", command: `python3 ${f.old}` } }, null, 2) + "\n";
  await fs.writeFile(target, text);
  await fs.symlink(target, f.settings);
  await fix(f);
  assert.equal((await fs.lstat(f.settings)).isSymbolicLink(), true);
  assert.equal(await read(target), text.split(f.old).join(f.now));
});
