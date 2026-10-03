const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { sandbox } = require('./installer-sandbox.cjs');
const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'facilitator-shell-')));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  await fs.mkdir(home);
  await fs.mkdir(repo);
  for (const file of ['facilitator', 'shell_integration.py', 'install.sh', 'requirements.txt', 'run.config.example.json', 'seed.example.json'])
    await fs.copyFile(path.join(root, file), path.join(repo, file));
  await fs.cp(path.join(root, '.agents'), path.join(repo, '.agents'), { recursive: true });
  const env = { ...process.env, HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
  for (const name of ['ZDOTDIR', 'BASH_ENV', 'ENV']) delete env[name];
  return { dir, home, repo, env, async clean() { await fs.rm(dir, { recursive: true, force: true }); } };
}
async function integration(f, op, env = f.env) {
  return exec('python3', [path.join(f.repo, 'shell_integration.py'), op], { env });
}

test('owned command and profile block install twice and uninstall without changing user lines', async () => {
  const f = await fixture();
  try {
    const rc = path.join(f.home, '.zshrc');
    const original = 'export CUSTOM=value\n# my PATH\nexport PATH="/mine:$PATH"\n';
    await fs.writeFile(rc, original);
    await integration(f, 'install');
    await integration(f, 'install');
    assert.equal(await fs.readlink(path.join(f.home, '.local/share/facilitator/bin/facilitator')), path.join(f.repo, 'facilitator'));
    for (const host of ['.claude', '.agents']) {
      const link = path.join(f.home, host, 'skills', 'facilitator');
      assert.equal(await fs.readlink(link), path.join(f.repo, '.agents/skills/facilitator'));
      assert.match(await fs.readFile(path.join(link, 'SKILL.md'), 'utf8'), /^---\nname: facilitator/m);
    }
    const installed = await fs.readFile(rc, 'utf8');
    assert.equal((installed.match(/# >>> Facilitator installer >>>/g) || []).length, 1);
    await integration(f, 'uninstall');
    assert.equal(await fs.readFile(rc, 'utf8'), original);
    await assert.rejects(fs.lstat(path.join(f.home, '.local/share/facilitator/bin/facilitator')), { code: 'ENOENT' });
    for (const host of ['.claude', '.agents'])
      await assert.rejects(fs.lstat(path.join(f.home, host, 'skills', 'facilitator')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.repo, '.agents/skills/facilitator/SKILL.md'), 'utf8').then(Boolean), true);
  } finally { await f.clean(); }
});

test('preexisting skill names and a link from another checkout stop installation without changing settings', async () => {
  for (const obstruction of ['directory', 'file', 'other-link']) {
    const f = await fixture();
    try {
      const link = path.join(f.home, '.claude/skills/facilitator');
      await fs.mkdir(path.dirname(link), { recursive: true });
      if (obstruction === 'directory') {
        await fs.mkdir(link);
        await fs.writeFile(path.join(link, 'mine.txt'), 'mine');
      } else if (obstruction === 'file') {
        await fs.writeFile(link, 'mine');
      } else {
        const other = path.join(f.dir, 'other-checkout-skill');
        await fs.mkdir(other);
        await fs.symlink(other, link);
      }
      await assert.rejects(integration(f, 'preflight'), /already exists/);
      await assert.rejects(integration(f, 'install'), /already exists/);
      assert.equal((await fs.lstat(link)).isDirectory(), obstruction === 'directory');
      await assert.rejects(fs.lstat(path.join(f.home, '.agents/skills/facilitator')), { code: 'ENOENT' });
      await assert.rejects(fs.lstat(path.join(f.home, '.local/share/facilitator/bin/facilitator')), { code: 'ENOENT' });
      await integration(f, 'uninstall');
      assert.equal((await fs.lstat(link)).isDirectory(), obstruction === 'directory');
      if (obstruction === 'directory') assert.equal(await fs.readFile(path.join(link, 'mine.txt'), 'utf8'), 'mine');
      if (obstruction === 'file') assert.equal(await fs.readFile(link, 'utf8'), 'mine');
    } finally { await f.clean(); }
  }
});

test('a preexisting link to this skill stays unowned across install, reinstall, and uninstall', async () => {
  const f = await fixture();
  try {
    const link = path.join(f.home, '.claude/skills/facilitator');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(path.join(f.repo, '.agents/skills/facilitator'), link);
    const original = await fs.lstat(link);
    await integration(f, 'install');
    await integration(f, 'install');
    const record = JSON.parse(await fs.readFile(path.join(f.repo, '.facilitator-skills.json'), 'utf8'));
    assert.equal(Object.hasOwn(record.links, link), false);
    assert.equal(Object.keys(record.links).length, 1);
    await integration(f, 'uninstall');
    assert.equal((await fs.lstat(link)).ino, original.ino);
    await assert.rejects(fs.lstat(path.join(f.home, '.agents/skills/facilitator')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('replaced links and unrelated skills survive uninstall', async () => {
  const f = await fixture();
  try {
    await integration(f, 'install');
    const claude = path.join(f.home, '.claude/skills/facilitator');
    const codex = path.join(f.home, '.agents/skills/facilitator');
    const unrelated = path.join(f.home, '.agents/skills/unrelated');
    await fs.mkdir(unrelated);
    await fs.writeFile(path.join(unrelated, 'SKILL.md'), 'mine');
    await fs.rm(claude);
    await fs.symlink(path.join(f.dir, 'replacement'), claude);
    await integration(f, 'uninstall');
    assert.equal(await fs.readlink(claude), path.join(f.dir, 'replacement'));
    await assert.rejects(fs.lstat(codex), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(unrelated, 'SKILL.md'), 'utf8'), 'mine');
  } finally { await f.clean(); }
});

test('a recreated link to the same source is no longer installer-owned', async () => {
  const f = await fixture();
  try {
    await integration(f, 'install');
    const link = path.join(f.home, '.agents/skills/facilitator');
    const source = await fs.readlink(link);
    await fs.rm(link);
    await fs.symlink(source, link);
    await integration(f, 'install');
    await integration(f, 'uninstall');
    assert.equal(await fs.readlink(link), source);
  } finally { await f.clean(); }
});

test('custom Claude config root is recorded and removed even when the environment changes', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.dir, 'claude-config');
    await integration(f, 'install', { ...f.env, CLAUDE_CONFIG_DIR: config });
    const link = path.join(config, 'skills/facilitator');
    assert.equal(await fs.readlink(link), path.join(f.repo, '.agents/skills/facilitator'));
    await integration(f, 'uninstall');
    await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(config), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('another checkout cannot claim or remove this checkout’s skill or shell setup', async () => {
  const f = await fixture();
  try {
    await integration(f, 'install');
    const other = path.join(f.dir, 'other-checkout');
    await fs.mkdir(other);
    await fs.copyFile(path.join(f.repo, 'shell_integration.py'), path.join(other, 'shell_integration.py'));
    await fs.cp(path.join(f.repo, '.agents'), path.join(other, '.agents'), { recursive: true });
    const otherIntegration = op => exec('python3', [path.join(other, 'shell_integration.py'), op], { env: f.env });
    await assert.rejects(otherIntegration('preflight'));
    await otherIntegration('uninstall');
    assert.equal(await fs.readlink(path.join(f.home, '.claude/skills/facilitator')), path.join(f.repo, '.agents/skills/facilitator'));
    assert.match(await fs.readFile(path.join(f.home, '.zshrc'), 'utf8'), /Facilitator installer/);
  } finally { await f.clean(); }
});

test('a preexisting command and edited profile block remain untouched', async () => {
  const f = await fixture();
  try {
    const bin = path.join(f.home, '.local/share/facilitator/bin/facilitator');
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, 'my command');
    await assert.rejects(integration(f, 'preflight'));
    assert.equal(await fs.readFile(bin, 'utf8'), 'my command');
    await fs.rm(bin);
    await integration(f, 'install');
    const rc = path.join(f.home, '.zshrc');
    const changed = (await fs.readFile(rc, 'utf8')).replace('export PATH=', 'export MY_PATH=');
    await fs.writeFile(rc, changed);
    await integration(f, 'uninstall');
    assert.equal(await fs.readFile(rc, 'utf8'), changed);
  } finally { await f.clean(); }
});

test('an existing Facilitator bin on PATH needs no profile change', async () => {
  const f = await fixture();
  try {
    await integration(f, 'install', { ...f.env, PATH: `${f.home}/.local/share/facilitator/bin:${f.env.PATH}` });
    await assert.rejects(fs.lstat(path.join(f.home, '.zshrc')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('uninstall retains PATH for another command and never removes a replacement link', async () => {
  const f = await fixture();
  try {
    await integration(f, 'install');
    const binDir = path.join(f.home, '.local/share/facilitator/bin');
    const link = path.join(binDir, 'facilitator');
    await fs.writeFile(path.join(binDir, 'other-tool'), 'keep');
    await fs.rm(link);
    await fs.symlink(path.join(f.dir, 'other-project'), link);
    const rc = path.join(f.home, '.zshrc');
    const original = await fs.readFile(rc, 'utf8');
    const result = await integration(f, 'uninstall');
    assert.match(result.stdout, /Kept command .*, which has changed since install\./);
    assert.match(result.stdout, /Kept the PATH block: /);
    assert.equal(await fs.readlink(link), path.join(f.dir, 'other-project'));
    assert.equal(await fs.readFile(rc, 'utf8'), original);
  } finally { await f.clean(); }
});

test('bash profile changes are removed without touching existing bash settings', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, SHELL: '/bin/bash' };
    const rc = path.join(f.home, '.bashrc');
    const original = 'alias ll="ls -l"\nexport EDITOR=vim';
    await fs.writeFile(rc, original);
    await integration(f, 'install', env);
    assert.match(await fs.readFile(rc, 'utf8'), /Facilitator installer/);
    await integration(f, 'uninstall', { ...env, SHELL: '/bin/zsh' });
    assert.equal(await fs.readFile(rc, 'utf8'), original);
  } finally { await f.clean(); }
});

test('login and interactive Bash resolve the installed command', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, SHELL: '/bin/bash' };
    await fs.writeFile(path.join(f.home, '.bash_profile'), 'export MY_LOGIN_SETTING=kept\n');
    await integration(f, 'install', env);
    const expected = path.join(f.home, '.local/share/facilitator/bin/facilitator');
    const login = await exec('bash', ['-lc', 'command -v facilitator'], { env });
    const interactive = await exec('bash', ['-ic', 'command -v facilitator'], { env });
    assert.equal(login.stdout.trim(), expected);
    assert.equal(interactive.stdout.trim(), expected);
    await integration(f, 'uninstall', env);
    assert.equal(await fs.readFile(path.join(f.home, '.bash_profile'), 'utf8'), 'export MY_LOGIN_SETTING=kept\n');
  } finally { await f.clean(); }
});

test('an existing .profile remains the Bash login profile after install and uninstall', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, SHELL: '/bin/bash' };
    const profile = path.join(f.home, '.profile');
    const original = 'export PROFILE_SENTINEL=preserved\n';
    await fs.writeFile(profile, original);
    await integration(f, 'install', env);
    await assert.rejects(fs.lstat(path.join(f.home, '.bash_profile')), { code: 'ENOENT' });
    const login = await exec('bash', ['-lc', 'printf "%s:%s" "$PROFILE_SENTINEL" "$(command -v facilitator)"'], { env });
    assert.equal(login.stdout.trim(), `preserved:${f.home}/.local/share/facilitator/bin/facilitator`);
    await integration(f, 'uninstall', env);
    assert.equal(await fs.readFile(profile, 'utf8'), original);
    await assert.rejects(fs.lstat(path.join(f.home, '.bash_profile')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('uninstall removes an empty login profile it created', async () => {
  const f = await fixture();
  try {
    const env = { ...f.env, SHELL: '/bin/bash' };
    await integration(f, 'install', env);
    await integration(f, 'uninstall', env);
    await assert.rejects(fs.lstat(path.join(f.home, '.bash_profile')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(f.home, '.bashrc')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('Zsh resolves the command from exported ZDOTDIR and uninstall finds that profile later', async () => {
  const f = await fixture();
  try {
    const zdot = path.join(f.home, 'zsh-config');
    await fs.mkdir(zdot);
    const rc = path.join(zdot, '.zshrc');
    await fs.writeFile(rc, 'export OTHER=kept\n');
    const env = { ...f.env, ZDOTDIR: zdot };
    await integration(f, 'install', env);
    const result = await exec('zsh', ['-ic', 'command -v facilitator'], { env });
    assert.equal(result.stdout.trim(), path.join(f.home, '.local/share/facilitator/bin/facilitator'));
    await integration(f, 'uninstall', f.env);
    assert.equal(await fs.readFile(rc, 'utf8'), 'export OTHER=kept\n');
  } finally { await f.clean(); }
});

test('Zsh profile selection honors an unexported ZDOTDIR in .zshenv', async () => {
  const f = await fixture();
  try {
    const zdot = path.join(f.home, 'zsh-config');
    await fs.mkdir(zdot);
    await fs.writeFile(path.join(f.home, '.zshenv'), 'ZDOTDIR="$HOME/zsh-config"\n');
    await integration(f, 'install');
    await assert.rejects(fs.lstat(path.join(f.home, '.zshrc')), { code: 'ENOENT' });
    const rc = path.join(zdot, '.zshrc');
    assert.match(await fs.readFile(rc, 'utf8'), /Facilitator installer/);
    const result = await exec('zsh', ['-ic', 'command -v facilitator'], { env: f.env });
    assert.equal(result.stdout.trim(), path.join(f.home, '.local/share/facilitator/bin/facilitator'));
    await integration(f, 'uninstall');
    await assert.rejects(fs.lstat(rc), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('CRLF and missing final newline survive install and uninstall byte for byte', async () => {
  for (const original of [Buffer.from('export OTHER=kept\r\n# note\r\n'), Buffer.from('export OTHER=kept')]) {
    const f = await fixture();
    try {
      const rc = path.join(f.home, '.zshrc');
      await fs.writeFile(rc, original);
      await integration(f, 'install');
      await integration(f, 'uninstall');
      assert.deepEqual(await fs.readFile(rc), original);
    } finally { await f.clean(); }
  }
});

test('help and unknown installer arguments do not create or edit files', async () => {
  const f = await fixture();
  try {
    const rc = path.join(f.home, '.zshrc');
    await fs.writeFile(rc, 'export EXISTING=1\n');
    const help = await exec('bash', [path.join(f.repo, 'install.sh'), '--help'], { cwd: f.repo, env: f.env });
    assert.match(help.stdout, /usage: \.\/install\.sh/);
    const error = await exec('bash', [path.join(f.repo, 'install.sh'), '--bogus'], { cwd: f.repo, env: f.env })
      .then(() => null, failure => failure);
    assert.ok(error);
    assert.match(error.stderr, /^\n⚠ Unknown option or argument: --bogus\.\n  usage: \.\/install\.sh\n$/);
    assert.equal(await fs.readFile(rc, 'utf8'), 'export EXISTING=1\n');
    await assert.rejects(fs.lstat(path.join(f.repo, '.venv')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(f.home, '.local/share/facilitator/bin/facilitator')), { code: 'ENOENT' });
  } finally { await f.clean(); }
});

test('./install.sh sets up a fake checkout and exposes the real CLI command', async () => {
  const f = await sandbox({ agents: ['claude', 'codex'] });
  try {
    const first = await f.piped();
    assert.equal(first.code, 0, first.text);
    assert.match(first.text, /█████/);
    const titles = ['1. Claude Code or Codex', '2. Chrome', '3. Python', '4. Phone client'];
    const lines = first.text.split('\n');
    for (const title of titles) {
      const at = lines.indexOf(title);
      assert.ok(at > 0, `${title} is missing`);
      assert.equal(lines[at - 1], '', `no blank line before ${title}`);
      assert.equal(lines[at + 1], '─'.repeat(title.length), `the rule under ${title}`);
      assert.equal(lines[at + 2], '', `no blank line after the rule under ${title}`);
    }
    assert.doesNotMatch(first.text, /\n\n\n/, 'two blank lines in a row');
    assert.match(first.text, /⊘ Skipped the phone client: there is no interactive terminal\./);
    assert.doesNotMatch(first.text, /Claude limits|facilitator password set/);
    await assert.rejects(fs.lstat(path.join(f.home, '.claude', 'settings.json')), { code: 'ENOENT' });
    assert.match(first.text, /✓ facilitator command and agent skill installed\nOpen a new terminal to use facilitator\.\n\n✦ Facilitator is installed!\n\nNext steps:\n\n1\. Start the board: facilitator run\n2\. Onboard your agent, in Claude Code: \/facilitator onboard\n   or in Codex: \$facilitator onboard\n\n$/);
    const second = await f.piped();
    assert.equal(second.code, 0, second.text);
    assert.match(second.text, /✓ facilitator command and agent skill installed\n\n✦ Facilitator is installed!/);
    assert.doesNotMatch(second.text, /Open a new terminal/);
    const terminal = await f.terminal([['phone client? (y / n) ', 'n']], [], { color: true });
    assert.equal(terminal.code, 0, terminal.text);
    assert.match(terminal.text, /\x1b\[38;2;190;55;30m█/, 'terminal banner lacks the reddish-orange gradient');
    assert.match(terminal.text, /\x1b\[38;2;0;114;0m✓\x1b\[0m /, 'terminal output lacks the green check');
    const command = path.join(f.home, '.local/share/facilitator/bin/facilitator');
    const result = await exec(command, ['_install'], { env: { ...f.env, FACILITATOR_INTERNAL_INSTALL: '' } }).then(() => null, error => error);
    assert.ok(result, 'internal install was exposed without the installer guard');
    assert.match(result.stderr, /facilitator run/);
  } finally { await f.clean(); }
});
