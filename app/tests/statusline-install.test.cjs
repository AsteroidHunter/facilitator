// The Claude Code status line entry install adds, wraps around a status line
// that is already there, and uninstall takes back. The layouts come from
// tests/fixtures/older-statusline-installs.json: for each, the settings file
// before, the file after install, and the record it saves. Every run is on a
// copy of the checkout files in a temp folder, with HOME (or CLAUDE_CONFIG_DIR)
// inside it, so no real settings file is read or written.
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

// a copy of the checkout as the repository lays it out: the program in
// repo/app, .agents/ at repo's top, and the records in repo/data
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-statusline-install-")));
  folders.push(dir);
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  const app = path.join(repo, "app");
  await fs.mkdir(home);
  await fs.mkdir(app, { recursive: true });
  await fs.mkdir(path.join(repo, "data"));
  for (const file of ["facilitator", "shell_integration.py", "claude-statusline.py"])
    await fs.copyFile(path.join(ROOT, file), path.join(app, file));
  await fs.cp(path.join(ROOT, "..", ".agents"), path.join(repo, ".agents"), { recursive: true });
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  for (const name of ["ZDOTDIR", "BASH_ENV", "ENV", "CLAUDE_CONFIG_DIR"]) delete env[name];
  await fs.mkdir(path.join(home, ".claude"));
  return { dir, home, repo, app, env, settings: path.join(home, ".claude", "settings.json"),
    script: path.join(app, "claude-statusline.py"), record: path.join(repo, "data", ".facilitator-statusline.json") };
}

const run = (f, ...words) => exec("python3", [path.join(f.app, "shell_integration.py"), ...words], { env: f.env });
const call = (f, code, env = f.env) => exec("python3", ["-c", `import shell_integration as s\n${code}`], { env, cwd: f.app });
const take = (f, env) => call(f, "s.statusline_uninstall()", env);
const exists = file => fs.access(file).then(() => true, () => false);
const read = file => fs.readFile(file, "utf8");

const fill = (f, text, settings = f.settings) => text.split("@SCRIPT@").join(f.script).split("@SETTINGS@").join(settings);

// the files install leaves: the settings file as it is after, and the record
async function older(f, name, settings = f.settings) {
  const found = OLDER[name];
  assert.ok(found, name);
  await fs.mkdir(path.dirname(settings), { recursive: true });
  await fs.writeFile(settings, fill(f, found.after, settings));
  await fs.writeFile(f.record, fill(f, found.record, settings));
  return found;
}

test("the fixture file holds the layouts the installer is shown", () => {
  const names = Object.keys(OLDER);
  assert.ok(names.length >= 12, names.join(", "));
  for (const name of ["two spaces", "tabs", "compact", "carriage returns", "empty object", "wrapped", "made from nothing"])
    assert.ok(names.includes(name), name);
  for (const [name, found] of Object.entries(OLDER)) {
    assert.ok(found.after.includes("@SCRIPT@"), `${name}: the entry points at the script`);
    assert.equal(JSON.parse(found.record.split("@SCRIPT@").join("/s").split("@SETTINGS@").join("/t")).version, 1, name);
  }
});

test("uninstall gives every older layout back byte for byte and drops the record", async () => {
  for (const [name, found] of Object.entries(OLDER)) {
    const f = await fixture();
    await older(f, name);
    const out = (await take(f)).stdout;
    const record = JSON.parse(fill(f, found.record));
    if (record.original !== null) assert.match(out, /Restored your status line in /, name);
    else if (record.created) assert.match(out, /Removed .*, which setup made\./, name);
    else assert.match(out, /Removed the Claude limits status line from /, name);
    if (found.before === null) assert.equal(await exists(f.settings), false, `${name}: the file older setup made is gone`);
    else assert.equal(await read(f.settings), found.before, `${name}: back to what it was`);
    assert.equal(await exists(f.record), false, name);
  }
});

test("a settings file with carriage return line breaks gets them back", async () => {
  const f = await fixture();
  await older(f, "carriage returns");
  const text = await read(f.settings);
  assert.ok(text.includes("\r\n"));
  assert.doesNotMatch(text.replace(/\r\n/g, ""), /\n/, "every line break is a carriage return pair");
  await take(f);
  assert.equal(await read(f.settings), OLDER["carriage returns"].before);
});

test("a status line wrapped by install keeps showing until uninstall", async () => {
  const f = await fixture();
  await older(f, "wrapped");
  const wrapped = JSON.parse(await read(f.settings));
  assert.equal(wrapped.statusLine.type, "command");
  assert.equal(wrapped.statusLine.padding, 2);
  assert.equal(wrapped.model, "opus");
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 4102444800 } } });
  const shown = spawnSync("sh", ["-c", wrapped.statusLine.command], { input, encoding: "utf8", env: { ...f.env, HOME: "/invented" } });
  assert.equal(shown.stdout, "é mine /invented\n");
  assert.equal(JSON.parse(await read(path.join(f.repo, "data", "claude-limits.json"))).five_hour.used_percentage, 12);
  await take(f);
  assert.equal(await read(f.settings), OLDER.wrapped.before);
  assert.equal(await exists(f.record), false);
});

test("one wrapped around cat comes out unchanged while it is installed", async () => {
  const f = await fixture();
  await older(f, "wrapped cat");
  const command = JSON.parse(await read(f.settings)).statusLine.command;
  const input = JSON.stringify({ model: { display_name: "Invented" } });
  const shown = spawnSync("sh", ["-c", command], { input, encoding: "utf8" });
  assert.equal(shown.stdout, input);
});

test("uninstall takes out only what install added: the file it made and the folder it made", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.home, ".claude"), { recursive: true });
  await run(f, "install");
  assert.equal(await exists(f.settings), true, "install made the settings file in the folder it made");
  await run(f, "uninstall");
  assert.equal(await exists(f.settings), false, "the settings file install made is gone");
  assert.equal(await exists(f.record), false);
  assert.equal(await exists(path.join(f.home, ".claude")), false, "so is the folder");
});

test("a settings file that had other keys stays, without the entry", async () => {
  const f = await fixture();
  await older(f, "model only");
  await run(f, "uninstall");
  assert.equal(await read(f.settings), '{\n  "model": "opus"\n}\n');
});

test("an entry changed by hand since install is left alone, and uninstall says so", async () => {
  const f = await fixture();
  await older(f, "made from nothing");
  const edited = JSON.stringify({ statusLine: { type: "command", command: "my-own-line --short" } }, null, 2) + "\n";
  await fs.writeFile(f.settings, edited);
  const out = await take(f);
  assert.match(out.stdout, /Kept the status line in .*, which has changed since install\./);
  assert.equal(await read(f.settings), edited);
  assert.equal(await exists(f.record), false, "nothing is owned any more");
  const g = await fixture();
  await older(g, "wrapped compact");
  const wrapped = JSON.parse(await read(g.settings));
  wrapped.statusLine.padding = 1;
  const touched = JSON.stringify(wrapped);
  await fs.writeFile(g.settings, touched);
  assert.match((await take(g)).stdout, /which has changed since install/);
  assert.equal(await read(g.settings), touched);
});

test("an entry that is gone by hand, or a settings file that is gone, takes the record away quietly", async () => {
  const f = await fixture();
  await older(f, "compact");
  await fs.writeFile(f.settings, '{"model":"opus"}');
  assert.equal((await take(f)).stdout, "");
  assert.equal(await read(f.settings), '{"model":"opus"}');
  assert.equal(await exists(f.record), false);
  const g = await fixture();
  await older(g, "compact");
  await fs.rm(g.settings);
  assert.equal((await take(g)).stdout, "");
  assert.equal(await exists(g.record), false);
});

test("a settings file that is not JSON is kept as it is, and the record stays", async () => {
  const f = await fixture();
  await older(f, "two spaces");
  await fs.writeFile(f.settings, "{ not json");
  assert.match((await take(f)).stdout, /Kept the status line in .*: it could not be read as JSON\./);
  assert.equal(await read(f.settings), "{ not json");
  assert.equal(await exists(f.record), true);
});

test("a record this checkout did not write is kept and never acted on", async () => {
  const bad = [
    ["not JSON", () => "{ not json"],
    ["another script", f => fill(f, OLDER["two spaces"].record).replace(f.script, "/elsewhere/claude-statusline.py")],
    ["another version", f => fill(f, OLDER["two spaces"].record).replace('"version": 1', '"version": 2')],
    ["a relative settings path", f => fill(f, OLDER["two spaces"].record).replace(f.settings, "settings.json")],
  ];
  for (const [name, make] of bad) {
    const f = await fixture();
    await fs.writeFile(f.settings, fill(f, OLDER["two spaces"].after));
    await fs.writeFile(f.record, make(f));
    const out = await take(f);
    assert.match(out.stdout, /Kept .*: it is not a record this installer wrote\./, name);
    assert.equal(await read(f.settings), fill(f, OLDER["two spaces"].after), `${name}: the settings file is untouched`);
    assert.equal(await exists(f.record), true, name);
  }
});

test("with no record there is nothing to take back and the settings file is not read", async () => {
  const f = await fixture();
  await fs.writeFile(f.settings, "{ not json and not ours");
  assert.equal((await take(f)).stdout, "");
  assert.equal(await read(f.settings), "{ not json and not ours");
});

test("uninstall goes by the settings path in the record, whatever CLAUDE_CONFIG_DIR says now", async () => {
  const f = await fixture();
  const config = path.join(f.dir, "claude-config");
  const settings = path.join(config, "settings.json");
  await older(f, "two spaces", settings);
  await take(f);
  assert.equal(await read(settings), OLDER["two spaces"].before);
  assert.equal(await exists(f.settings), false, "the default place is not touched");
  assert.equal(await exists(f.record), false);
  const g = await fixture();
  await older(g, "compact");
  await take(g, { ...g.env, CLAUDE_CONFIG_DIR: path.join(g.dir, "elsewhere") });
  assert.equal(await read(g.settings), OLDER.compact.before);
});

test("a link for the settings file is followed and stays a link", async () => {
  const f = await fixture();
  const target = path.join(f.dir, "dotfiles-settings.json");
  await fs.writeFile(target, fill(f, OLDER["two spaces"].after));
  await fs.symlink(target, f.settings);
  await fs.writeFile(f.record, fill(f, OLDER["two spaces"].record));
  await take(f);
  assert.equal((await fs.lstat(f.settings)).isSymbolicLink(), true, "the link stays a link");
  assert.equal(await read(target), OLDER["two spaces"].before);
});

const SAID_ADDED = /Claude limits added to /;

test("install adds the entry in every layout as the fixtures show, again changes nothing, and uninstall gives the file back byte for byte", async () => {
  for (const [name, found] of Object.entries(OLDER)) {
    const f = await fixture();
    if (found.before !== null) await fs.writeFile(f.settings, found.before);
    const first = (await run(f, "install")).stdout;
    assert.match(first, SAID_ADDED, name);
    assert.equal(/around your status line/.test(first), JSON.parse(fill(f, found.record)).original !== null, name);
    assert.equal(await read(f.settings), fill(f, found.after), `${name}: the file after install`);
    assert.deepEqual(JSON.parse(await read(f.record)), JSON.parse(fill(f, found.record)), `${name}: the record`);
    const settled = [await read(f.settings), await read(f.record)];
    const second = (await run(f, "install")).stdout;
    assert.match(second, /Claude limits already added\./, name);
    assert.doesNotMatch(second, SAID_ADDED, name);
    assert.deepEqual([await read(f.settings), await read(f.record)], settled, `${name}: a second install changes nothing`);
    await run(f, "uninstall");
    if (found.before === null) assert.equal(await exists(f.settings), false, `${name}: the file install made is gone`);
    else assert.equal(await read(f.settings), found.before, `${name}: back to what it was`);
    assert.equal(await exists(f.record), false, name);
  }
});

test("install with a missing settings file makes one holding only the status line", async () => {
  const f = await fixture();
  await run(f, "install");
  assert.deepEqual(JSON.parse(await read(f.settings)), { statusLine: { type: "command", command: `python3 ${f.script}` } });
  assert.equal(JSON.parse(await read(f.record)).created, true);
});

test("a status line the person already has is wrapped, keeps showing its own output, and the board still gets the limits", async () => {
  const f = await fixture();
  await fs.writeFile(f.settings, OLDER.wrapped.before);
  await run(f, "install");
  const wrapped = JSON.parse(await read(f.settings));
  assert.equal(wrapped.statusLine.padding, 2, "the rest of the entry is kept");
  assert.equal(wrapped.model, "opus");
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 31, resets_at: 4102444800 } } });
  const shown = spawnSync("sh", ["-c", wrapped.statusLine.command], { input, encoding: "utf8", env: { ...f.env, HOME: "/invented" } });
  assert.equal(shown.stdout, "é mine /invented\n");
  assert.equal(JSON.parse(await read(path.join(f.repo, "data", "claude-limits.json"))).five_hour.used_percentage, 31);
});

test("with --quiet install still says it changed the Claude settings, and says nothing the second time", async () => {
  const f = await fixture();
  assert.match((await run(f, "install", "--quiet")).stdout, SAID_ADDED);
  assert.doesNotMatch((await run(f, "install", "--quiet")).stdout, /Claude limits/);
});

test("a status line that cannot be wrapped, or runs another script, is left as it is and install goes on", async () => {
  const other = '{\n  "statusLine": { "type": "command", "command": "python3 /elsewhere/claude-statusline.py" }\n}\n';
  const cases = [
    ["a string", '{"statusLine":"echo hi"}', /is not a command that can be wrapped/],
    ["another type", '{"statusLine":{"type":"static","text":"hi"}}', /is not a command that can be wrapped/],
    ["an empty command", '{"statusLine":{"type":"command","command":"  "}}', /is not a command that can be wrapped/],
    ["another claude-statusline.py", other, /runs another claude-statusline\.py/],
    ["not JSON", "{ not json", /could not be read as JSON/],
    ["a list", "[1]", /could not be read as JSON/],
  ];
  for (const [name, text, said] of cases) {
    const f = await fixture();
    await fs.writeFile(f.settings, text);
    const out = (await run(f, "install")).stdout;
    assert.match(out, /Claude limits not added: /, name);
    assert.match(out, said, name);
    assert.equal(await read(f.settings), text, `${name}: the settings file is untouched`);
    assert.equal(await exists(f.record), false, name);
    assert.equal((await fs.lstat(path.join(f.home, ".local", "share", "facilitator", "bin", "facilitator"))).isSymbolicLink(), true, `${name}: the rest of install ran`);
  }
});

test("an entry already pointing at this script by hand is left, not recorded, and kept by uninstall", async () => {
  const f = await fixture();
  const text = JSON.stringify({ statusLine: { type: "command", command: `python3 ${f.script}` } });
  await fs.writeFile(f.settings, text);
  assert.match((await run(f, "install")).stdout, /Claude limits already added\./);
  assert.equal(await read(f.settings), text);
  assert.equal(await exists(f.record), false);
  await run(f, "uninstall");
  assert.equal(await read(f.settings), text);
});

test("install goes by CLAUDE_CONFIG_DIR, and a record for another place is not added to", async () => {
  const f = await fixture();
  const config = path.join(f.dir, "claude-config");
  const env = { ...f.env, CLAUDE_CONFIG_DIR: config };
  await exec("python3", [path.join(f.app, "shell_integration.py"), "install"], { env });
  const settings = path.join(config, "settings.json");
  assert.equal(JSON.parse(await read(settings)).statusLine.command, `python3 ${f.script}`);
  assert.equal(await exists(f.settings), false, "the default place is not touched");
  const again = (await run(f, "install")).stdout;
  assert.match(again, /Claude limits were already added to /);
  assert.equal(await exists(f.settings), false);
});

test("a link for the settings file is followed on install and stays a link", async () => {
  const f = await fixture();
  const target = path.join(f.dir, "dotfiles-settings.json");
  await fs.writeFile(target, OLDER["two spaces"].before);
  await fs.symlink(target, f.settings);
  await run(f, "install");
  assert.equal((await fs.lstat(f.settings)).isSymbolicLink(), true, "the link stays a link");
  assert.equal(await read(target), fill(f, OLDER["two spaces"].after));
});

test("there is no statusline operation and install.sh asks no Claude limits question", async () => {
  const f = await fixture();
  await assert.rejects(run(f, "statusline"), error => /usage: shell_integration\.py preflight\|install \[--quiet\]\|uninstall/.test(error.stderr));
  await assert.rejects(run(f, "uninstall", "--quiet"), error => /usage: shell_integration\.py/.test(error.stderr));
  assert.doesNotMatch(await read(path.join(ROOT, "..", "install.sh")), /Claude limits|statusline/i);
});
