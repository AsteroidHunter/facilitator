const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
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
  const env = { ...process.env, HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
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
    const installed = await fs.readFile(rc, 'utf8');
    assert.equal((installed.match(/# >>> Facilitator installer >>>/g) || []).length, 1);
    await integration(f, 'uninstall');
    assert.equal(await fs.readFile(rc, 'utf8'), original);
    await assert.rejects(fs.lstat(path.join(f.home, '.local/share/facilitator/bin/facilitator')), { code: 'ENOENT' });
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
    assert.match(result.stdout, /kept changed command/);
    assert.match(result.stdout, /kept PATH block/);
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

test('./install.sh sets up a fake checkout and exposes the real CLI command', async () => {
  const f = await fixture();
  try {
    const tools = path.join(f.dir, 'tools');
    await fs.mkdir(tools);
    const uv = path.join(tools, 'uv');
    await fs.writeFile(uv, '#!/bin/sh\nif [ "$1" = venv ]; then mkdir -p .venv/bin; touch .venv/bin/python .venv/bin/python3; fi\n');
    await fs.chmod(uv, 0o755);
    const env = { ...f.env, PATH: `${tools}:${f.env.PATH}` };
    const first = await exec('bash', [path.join(f.repo, 'install.sh')], { cwd: f.repo, env });
    assert.match(first.stdout, /FACILITATOR|█████/);
    assert.match(first.stdout, /1\. Check the command location/);
    assert.match(first.stdout, /2\. Set up the board/);
    assert.match(first.stdout, /3\. Add the facilitator command/);
    assert.match(first.stdout, /Installed\. Run: facilitator run/);
    const second = await exec('bash', [path.join(f.repo, 'install.sh')], { cwd: f.repo, env });
    assert.match(second.stdout, /command: already linked/);
    const ptyCapture = `import os,pty,subprocess,sys\nm,s=pty.openpty()\np=subprocess.Popen(['bash',sys.argv[1]],stdin=subprocess.DEVNULL,stdout=s,stderr=s)\nos.close(s)\nwhile True:\n try: data=os.read(m,65536)\n except OSError: break\n if not data: break\n os.write(1,data)\nsys.exit(p.wait())`;
    const terminal = await exec('python3', ['-c', ptyCapture, path.join(f.repo, 'install.sh')],
      { cwd: f.repo, env });
    assert.match(terminal.stdout, /\x1b\[38;2;190;55;30m█/, 'terminal banner lacks the reddish-orange gradient');
    const command = path.join(f.home, '.local/share/facilitator/bin/facilitator');
    const result = await exec(command, ['_install'], { env: { ...env, FACILITATOR_INTERNAL_INSTALL: '' } }).then(() => null, error => error);
    assert.ok(result, 'internal install was exposed without the installer guard');
    assert.match(result.stderr, /facilitator run/);
  } finally { await f.clean(); }
});
