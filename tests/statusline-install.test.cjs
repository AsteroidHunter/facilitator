// The Claude Code status line entry the installer offers and uninstall takes
// back. Every run is on a copy of the checkout files in a temp folder, with HOME
// (or CLAUDE_CONFIG_DIR) inside it, so no real settings file is read or written.
// The question is answered through a pseudo terminal, since it is only asked
// where there is a terminal to ask on.
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { execFile, spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");
const QUESTION = "Show your Claude limits on the home page? [Y/n] ";
const folders = [];
after(async () => { for (const dir of folders) await fs.rm(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "facilitator-statusline-install-")));
  folders.push(dir);
  const home = path.join(dir, "home");
  const repo = path.join(dir, "repo");
  await fs.mkdir(home);
  await fs.mkdir(repo);
  for (const file of ["facilitator", "shell_integration.py", "claude-statusline.py"])
    await fs.copyFile(path.join(ROOT, file), path.join(repo, file));
  await fs.cp(path.join(ROOT, ".agents"), path.join(repo, ".agents"), { recursive: true });
  const env = { ...process.env, HOME: home, SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" };
  for (const name of ["ZDOTDIR", "BASH_ENV", "ENV", "CLAUDE_CONFIG_DIR"]) delete env[name];
  await fs.mkdir(path.join(home, ".claude"));
  return { dir, home, repo, env, settings: path.join(home, ".claude", "settings.json"),
    script: path.join(repo, "claude-statusline.py"), record: path.join(repo, ".facilitator-statusline.json") };
}

const run = (f, op, env = f.env) => exec("python3", [path.join(f.repo, "shell_integration.py"), op], { env });
const call = (f, code, env = f.env) => exec("python3", ["-c", `import shell_integration as s\n${code}`], { env, cwd: f.repo });
const add = (f, env) => call(f, "s.statusline_add()", env);
const take = (f, env) => call(f, "s.statusline_uninstall()", env);
const exists = file => fs.access(file).then(() => true, () => false);
const read = file => fs.readFile(file, "utf8");

// answers the question on a terminal: sends `answer` when the prompt appears
const ASK = `import os, pty, sys
answer, argv = sys.argv[1].encode().decode("unicode_escape").encode(), sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
seen, sent = b"", False
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    seen += data
    if not sent and b"[Y/n] " in seen:
        os.write(fd, answer)
        sent = True
code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
sys.stdout.write(seen.decode("utf-8", "replace").replace("\\r\\n", "\\n"))
sys.exit(code)
`;
function ask(f, answer, env = f.env) {
  const done = spawnSync("python3", ["-c", ASK, answer, "python3", path.join(f.repo, "shell_integration.py"), "statusline"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(done.status, 0, done.stderr + done.stdout);
  return done.stdout;
}

const commandFor = (f, wrapped) =>
  `python3 ${f.script.includes(" ") ? `'${f.script}'` : f.script}` + (wrapped === undefined ? "" : ` '${wrapped}'`);

test("on Enter it adds the entry and records it, and a second run adds nothing more", async () => {
  const f = await fixture();
  const out = ask(f, "\\n");
  assert.ok(out.includes(QUESTION), out);
  assert.match(out, /Claude limits added to /);
  const settings = JSON.parse(await read(f.settings));
  assert.deepEqual(settings, { statusLine: { type: "command", command: commandFor(f) } });
  const record = JSON.parse(await read(f.record));
  assert.equal(record.settings, f.settings);
  assert.equal(record.created, true);
  assert.equal(record.original, null);
  assert.deepEqual(record.entry, settings.statusLine);
  const before = await read(f.settings);
  const recordBefore = await read(f.record);
  const again = ask(f, "y\\n");
  assert.match(again, /Claude limits already added\./);
  assert.equal(await read(f.settings), before);
  assert.equal(await read(f.record), recordBefore);
});

test("no, an unclear answer, and no terminal at all add nothing", async () => {
  for (const answer of ["n\\n", "no\\n", "maybe\\n"]) {
    const f = await fixture();
    assert.match(ask(f, answer), /Claude limits not added\./);
    assert.equal(await exists(f.settings), false, answer);
    assert.equal(await exists(f.record), false, answer);
  }
  const f = await fixture();
  const quiet = await run(f, "statusline");
  assert.match(quiet.stdout, /Claude limits not added: there is no terminal to ask on\./);
  assert.equal(await exists(f.settings), false);
  assert.equal(await exists(f.record), false);
});

test("an existing settings file keeps every other key and its layout, and uninstall gives it back byte for byte", async () => {
  const layouts = {
    "two spaces": '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  },\n  "env": { "A": "1" }\n}\n',
    "four spaces, no final newline": '{\n    "model": "opus",\n    "theme": "dark"\n}',
    "tabs": '{\n\t"model": "opus",\n\t"hooks": {}\n}\n',
    "compact": '{"model":"opus","theme":"dark"}',
    "inline spaces": '{"model": "opus", "theme": "dark"}\n',
    "carriage returns": '{\r\n  "model": "opus",\r\n  "theme": "dark"\r\n}\r\n',
    "empty object": "{}\n",
    "a note in a string": '{\n  "model": "opus",\n  "note": "has a } and a , and \\"quotes\\""\n}\n',
  };
  for (const [name, original] of Object.entries(layouts)) {
    const f = await fixture();
    await fs.writeFile(f.settings, original);
    await add(f);
    const added = await read(f.settings);
    const parsed = JSON.parse(added);
    assert.deepEqual(parsed.statusLine, { type: "command", command: commandFor(f) }, name);
    const others = { ...parsed };
    delete others.statusLine;
    assert.deepEqual(others, JSON.parse(original), `${name}: the other keys`);
    assert.ok(added.startsWith(original.replace(/\s*\}\s*$/, "")), `${name}: what was there stays put`);
    if (name === "carriage returns") assert.doesNotMatch(added.replace(/\r\n/g, ""), /\n/, "every line break stays a carriage return pair");
    const out = await take(f);
    assert.match(out.stdout, /Removed the Claude limits status line from /, name);
    assert.equal(await read(f.settings), original, `${name}: back to what it was`);
    assert.equal(await exists(f.record), false, name);
  }
});

test("a status line that is already there is wrapped and keeps showing, and uninstall restores it exactly", async () => {
  const f = await fixture();
  const original = '{\n  "statusLine": {\n    "type": "command",\n    "command": "echo \\u00e9 \\"mine\\" $HOME",\n    "padding": 2\n  },\n  "model": "opus"\n}\n';
  await fs.writeFile(f.settings, original);
  const out = await add(f);
  assert.match(out.stdout, /around your status line/);
  const wrapped = JSON.parse(await read(f.settings));
  assert.equal(wrapped.statusLine.type, "command");
  assert.equal(wrapped.statusLine.padding, 2);
  assert.equal(wrapped.model, "opus");
  assert.equal(wrapped.statusLine.command, commandFor(f, 'echo é "mine" $HOME'));
  // run the setting as Claude Code does: the old command's line comes out unchanged, and the limits are kept
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 4102444800 } } });
  const shown = spawnSync("sh", ["-c", wrapped.statusLine.command], { input, encoding: "utf8", env: { ...f.env, HOME: "/invented" } });
  assert.equal(shown.stdout, "é mine /invented\n");
  assert.equal(JSON.parse(await read(path.join(f.repo, "claude-limits.json"))).five_hour.used_percentage, 12);
  await take(f);
  assert.equal(await read(f.settings), original);
  assert.equal(await exists(f.record), false);
});

test("one that prints through cat comes out unchanged, and a second add changes nothing", async () => {
  const f = await fixture();
  await fs.writeFile(f.settings, JSON.stringify({ statusLine: { type: "command", command: "cat" } }, null, 2) + "\n");
  await add(f);
  const once = await read(f.settings);
  const input = JSON.stringify({ model: { display_name: "Invented" } });
  const shown = spawnSync("sh", ["-c", JSON.parse(once).statusLine.command], { input, encoding: "utf8" });
  assert.equal(shown.stdout, input);
  const again = await add(f);
  assert.match(again.stdout, /already added/);
  assert.equal(await read(f.settings), once);
});

test("uninstall takes out only what install added: the file it made, and nothing else", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.home, ".claude"), { recursive: true });
  await run(f, "install");
  await add(f);
  assert.equal(await exists(f.settings), true);
  await run(f, "uninstall");
  assert.equal(await exists(f.settings), false, "the settings file install made is gone");
  assert.equal(await exists(f.record), false);
  assert.equal(await exists(path.join(f.home, ".claude")), false, "so is the folder it made");
});

test("a settings file that had other keys stays, without the entry", async () => {
  const f = await fixture();
  await fs.writeFile(f.settings, '{\n  "model": "opus"\n}\n');
  await add(f);
  await run(f, "uninstall");
  assert.equal(await read(f.settings), '{\n  "model": "opus"\n}\n');
});

test("an entry changed by hand since install is left alone, and uninstall says so", async () => {
  const f = await fixture();
  await add(f);
  const edited = JSON.stringify({ statusLine: { type: "command", command: "my-own-line --short" } }, null, 2) + "\n";
  await fs.writeFile(f.settings, edited);
  const out = await take(f);
  assert.match(out.stdout, /Kept the status line in .*, which has changed since install\./);
  assert.equal(await read(f.settings), edited);
  assert.equal(await exists(f.record), false, "nothing is owned any more");
  // the same for a wrapped entry that was edited
  const g = await fixture();
  await fs.writeFile(g.settings, JSON.stringify({ statusLine: { type: "command", command: "mine" } }));
  await add(g);
  const wrapped = JSON.parse(await read(g.settings));
  wrapped.statusLine.padding = 1;
  const touched = JSON.stringify(wrapped);
  await fs.writeFile(g.settings, touched);
  assert.match((await take(g)).stdout, /which has changed since install/);
  assert.equal(await read(g.settings), touched);
});

test("an entry that is gone by hand, or a settings file that is gone, takes the record away quietly", async () => {
  const f = await fixture();
  await add(f);
  await fs.writeFile(f.settings, '{"model":"opus"}');
  assert.equal((await take(f)).stdout, "");
  assert.equal(await read(f.settings), '{"model":"opus"}');
  assert.equal(await exists(f.record), false);
  const g = await fixture();
  await add(g);
  await fs.rm(g.settings);
  assert.equal((await take(g)).stdout, "");
  assert.equal(await exists(g.record), false);
});

test("a settings file that is not JSON, a status line that is not a command, and one already ours are left alone", async () => {
  const f = await fixture();
  await fs.writeFile(f.settings, "{ not json");
  assert.match((await add(f)).stdout, /could not be read as JSON/);
  assert.equal(await read(f.settings), "{ not json");
  assert.equal(await exists(f.record), false);
  for (const text of ['{"statusLine":"plain"}', '{"statusLine":{"type":"text"}}', '{"statusLine":{"type":"command"}}', '[]']) {
    const g = await fixture();
    await fs.writeFile(g.settings, text);
    await add(g);
    assert.equal(await read(g.settings), text, text);
    assert.equal(await exists(g.record), false, text);
  }
  // one set up by hand with this checkout's script: nothing to add and nothing to remove later
  const h = await fixture();
  const own = JSON.stringify({ statusLine: { type: "command", command: commandFor(h) } });
  await fs.writeFile(h.settings, own);
  assert.match((await add(h)).stdout, /already added/);
  assert.equal(await exists(h.record), false);
  await take(h);
  assert.equal(await read(h.settings), own);
  // another checkout's script is not wrapped either
  const k = await fixture();
  const other = JSON.stringify({ statusLine: { type: "command", command: "python3 /elsewhere/claude-statusline.py" } });
  await fs.writeFile(k.settings, other);
  assert.match((await add(k)).stdout, /runs another claude-statusline\.py/);
  assert.equal(await read(k.settings), other);
});

test("CLAUDE_CONFIG_DIR is where the entry goes, and uninstall finds it again when the environment changes", async () => {
  const f = await fixture();
  const config = path.join(f.dir, "claude-config");
  await fs.mkdir(config);
  const env = { ...f.env, CLAUDE_CONFIG_DIR: config };
  await add(f, env);
  const settings = path.join(config, "settings.json");
  assert.equal(JSON.parse(await read(settings)).statusLine.command, commandFor(f));
  assert.equal(await exists(f.settings), false, "the default place is not touched");
  await take(f);
  assert.equal(await exists(settings), false);
  assert.equal(await exists(f.record), false);
});

test("a changed CLAUDE_CONFIG_DIR does not add a second entry, and a link for the settings file is followed", async () => {
  const f = await fixture();
  await add(f);
  const config = path.join(f.dir, "claude-config");
  await fs.mkdir(config);
  const moved = await add(f, { ...f.env, CLAUDE_CONFIG_DIR: config });
  assert.match(moved.stdout, /already added to /);
  assert.equal(await exists(path.join(config, "settings.json")), false);
  const g = await fixture();
  const target = path.join(g.dir, "dotfiles-settings.json");
  await fs.writeFile(target, '{\n  "model": "opus"\n}\n');
  await fs.symlink(target, g.settings);
  await add(g);
  assert.equal((await fs.lstat(g.settings)).isSymbolicLink(), true, "the link stays a link");
  assert.equal(JSON.parse(await read(target)).statusLine.command, commandFor(g));
  await take(g);
  assert.equal(await read(target), '{\n  "model": "opus"\n}\n');
});

test("with no Claude Code folder, or without the script beside it, nothing is made", async () => {
  const f = await fixture();
  await fs.rm(path.join(f.home, ".claude"), { recursive: true });
  assert.match((await add(f)).stdout, /Claude limits not added: .* is not there\./);
  assert.equal(await exists(path.join(f.home, ".claude")), false);
  const g = await fixture();
  await fs.rm(g.script);
  assert.match((await add(g)).stdout, /is missing\./);
  assert.equal(await exists(g.settings), false);
});
