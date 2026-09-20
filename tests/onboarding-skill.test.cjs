// Exercise the installed skill's local selector and confirmed claim against a
// disposable board. These calls do not exercise either host's skill loader.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { copyBridgeFiles, freePortPair } = require('./fixture-auth.cjs');

const exec = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, '.venv/bin/python3');

async function fixture(laneDirs) {
  const outer = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'facilitator-onboard-')));
  const app = path.join(outer, 'app');
  const home = path.join(outer, 'home');
  await fs.mkdir(app);
  await fs.mkdir(home);
  const tools = path.join(outer, 'tools');
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools, 'tailscale'), '#!/bin/sh\nprintf "{}\\n"\n');
  await fs.chmod(path.join(tools, 'tailscale'), 0o755);
  const port = await freePortPair();
  const origin = `http://127.0.0.1:${port}`;
  const source = await fs.readFile(path.join(ROOT, 'server.py'), 'utf8');
  assert.match(source, /PORT = 8877/);
  assert.match(source, /TAILSCALE_APP = "\/Applications\/Tailscale\.app\/Contents\/MacOS\/Tailscale"/);
  await fs.writeFile(path.join(app, 'server.py'), source
    .replace('PORT = 8877', "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
      `TAILSCALE_APP = ${JSON.stringify(path.join(outer, 'no-real-tailscale'))}`));
  copyBridgeFiles(app);
  await fs.cp(path.join(ROOT, '.agents'), path.join(app, '.agents'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'RUNBOOK.md'), path.join(app, 'RUNBOOK.md'));
  const project = path.join(outer, 'project');
  const second = path.join(outer, 'second');
  await fs.mkdir(project);
  await fs.mkdir(second);
  const lanes = laneDirs ? laneDirs({ outer, app, project, second }) : [
    { owner: 'garden', dir: project }, { owner: 'river', dir: second },
  ];
  await fs.writeFile(path.join(app, 'run.config.json'), JSON.stringify({ port, lanes }));
  await fs.writeFile(path.join(app, 'seed.json'), JSON.stringify({
    title: 'onboarding fixture',
    items: [{ id: '0', bucket: 'meta', title: 'Tool', owner: 'facilitator' },
      { id: 'm1', bucket: 'meta', title: 'Project', owner: 'garden' },
      { id: 'm2', bucket: 'meta', title: 'Second project card', owner: 'garden' }],
  }));
  for (const host of ['.claude', '.agents']) {
    const skillDir = path.join(home, host, 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.symlink(path.join(app, '.agents/skills/facilitator'), path.join(skillDir, 'facilitator'));
  }
  const helper = path.join(home, '.agents/skills/facilitator/scripts/onboard.py');
  const env = { ...process.env, HOME: home, PATH: `${tools}${path.delimiter}${process.env.PATH}`,
    FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, 'logs') };
  const child = spawn(PYTHON, [path.join(app, 'server.py')], {
    cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { log += chunk; });
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${log}`);
    try {
      if ((await fetch(origin + '/state')).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!(await fetch(origin + '/state')).ok) throw new Error(`fixture server did not start:\n${log}`);
  return {
    outer, app, home, project, second, port, origin, helper, env,
    async run(cwd, ...args) {
      const { stdout } = await exec(PYTHON, [helper, ...args], { cwd, env, timeout: 30000 });
      return JSON.parse(stdout.trim());
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    },
    async close() {
      await this.stop();
      await fs.rm(outer, { recursive: true, force: true });
    },
  };
}

async function post(f, route, body = '') {
  const response = await fetch(f.origin + route, { method: 'POST', body });
  return { status: response.status, body: await response.json() };
}

test('personal links resolve one source from another project and select folder, path, board, and worktree', async () => {
  const f = await fixture();
  try {
    for (const host of ['.claude', '.agents']) {
      const text = await fs.readFile(path.join(f.home, host, 'skills/facilitator/SKILL.md'), 'utf8');
      assert.match(text, /^---\nname: facilitator/m);
    }
    const nested = path.join(f.project, 'src', 'deep');
    await fs.mkdir(nested, { recursive: true });
    assert.equal((await f.run(nested, 'inspect')).owner, 'garden');
    const explicit = await f.run(f.second, 'inspect', '--path', f.project);
    assert.equal(explicit.owner, 'garden');
    assert.equal(explicit.runbook, path.join(f.app, 'RUNBOOK.md'));
    assert.equal((await f.run(f.second, 'inspect', '--board', 'garden')).owner, 'garden');
    assert.equal((await f.run(f.second, 'inspect', '--board', 'RIVER')).owner, 'river');
    const added = path.join(f.home, 'blue-garden');
    await fs.mkdir(added);
    assert.equal((await post(f, '/project?name=Blue%20Garden', added)).status, 200);
    assert.equal((await f.run(f.second, 'inspect', '--board', 'Blue Garden')).owner, 'blue-garden');
    assert.equal((await f.run(added, 'inspect')).owner, 'blue-garden');
    const twin = path.join(f.home, 'second-blue-garden');
    await fs.mkdir(twin);
    assert.equal((await post(f, '/project?name=Blue%20Garden', twin)).status, 200);
    assert.equal((await f.run(f.second, 'inspect', '--board', 'Blue Garden')).status, 'ambiguous');

    await exec('git', ['init', '-q', f.project]);
    await exec('git', ['-C', f.project, '-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture',
      'commit', '--allow-empty', '-qm', 'initial']);
    const worktree = path.join(f.outer, 'project-worktree');
    await exec('git', ['-C', f.project, 'worktree', 'add', '-qb', 'fixture-worktree', worktree]);
    assert.equal((await f.run(worktree, 'inspect')).owner, 'garden');
    assert.equal((await f.run(f.outer, 'inspect')).status, 'project_unknown');
    assert.equal((await f.run(f.outer, 'inspect', '--path', path.join(f.outer, 'absent'))).status, 'path_missing');
    assert.equal((await f.run(f.project, 'inspect', '--board', '')).status, 'project_unknown');
    assert.equal((await f.run(f.project, 'inspect', '--path', '')).status, 'path_missing');
  } finally { await f.close(); }
});

test('ambiguous paths ask for a project, and occupied lanes do not start a duplicate wait', async () => {
  const f = await fixture(({ project }) => [
    { owner: 'garden', dir: project }, { owner: 'also-garden', dir: project },
  ]);
  try {
    const ambiguous = await f.run(f.project, 'inspect');
    assert.equal(ambiguous.status, 'ambiguous');
    assert.deepEqual(ambiguous.matches, ['also-garden', 'garden']);
    assert.equal((await f.run(f.project, 'inspect', '--board', 'garden')).owner, 'garden');
  } finally { await f.close(); }
});

test('one wait confirms a claim, fresh messages are answered, and a working reply defers the turn', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.run(f.project, 'inspect')).status, 'ready');
    assert.equal((await post(f, '/send?box=m1', 'First message')).status, 200);
    const claim = await f.run(f.project, 'wait', '--owner', 'garden', '--agent', 'codex', '--timeout', '1');
    assert.equal(claim.status, 'claim');
    assert.equal(claim.box, 'm1');
    assert.deepEqual(claim.messages, ['First message']);
    assert.equal(Object.hasOwn(claim, 'ack'), false);
    const saved = JSON.parse(await fs.readFile(path.join(f.app, 'state.json'), 'utf8'));
    assert.equal(saved.ack.garden.confirmed, true);
    assert.equal((await f.run(f.project, 'inspect')).status, 'claim_held');

    assert.equal((await post(f, '/send?box=m1', 'Follow-up')).status, 200);
    const fresh = await (await fetch(f.origin + '/fresh?owner=garden')).json();
    assert.deepEqual(fresh.messages, ['Follow-up']);
    assert.equal((await post(f, '/working?box=m1&v=1')).status, 200);
    assert.equal((await post(f, '/ping?box=m1')).status, 200);
    assert.equal((await post(f, '/reply?box=m1', 'I received both messages. Work is underway.')).status, 200);
    let state = await (await fetch(f.origin + '/state')).json();
    assert.equal(state.busy.garden, null);
    assert.equal(state.boxes.find(box => box.id === 'm1').state, 'working');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.app, 'state.json'), 'utf8'))
      .boxes.find(box => box.id === 'm1').state, 'deferred');
    assert.equal((await post(f, '/working?box=m1&v=0')).status, 200);
    state = await (await fetch(f.origin + '/state')).json();
    assert.equal(state.boxes.find(box => box.id === 'm1').reply, 'I received both messages. Work is underway.');
    assert.equal((await post(f, '/send?box=m2', 'Another card')).status, 200);
    const noClaim = await (await fetch(f.origin + '/fresh?owner=garden')).json();
    assert.deepEqual(noClaim.messages, []);
    assert.equal(Object.hasOwn(noClaim, 'box'), false);
    assert.equal((await post(f, '/reply?box=m1', 'The background work is complete.')).status, 200);
    const next = await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1');
    assert.equal(next.box, 'm2');
    assert.deepEqual(next.messages, ['Another card']);
    const freshNext = await (await fetch(f.origin + '/fresh?owner=garden')).json();
    assert.equal(freshNext.box, 'm2');
    assert.deepEqual(freshNext.messages, []);
    assert.equal((await post(f, '/reply?box=m2', 'I received the other card.')).status, 200);
    assert.equal((await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1')).status, 'idle');
  } finally { await f.close(); }
});

test('an active waiter is detected, and a stopped board is reported without starting one', async () => {
  const f = await fixture();
  try {
    const waiter = spawn(PYTHON, [f.helper, 'wait', '--owner', 'garden', '--timeout', '4'],
      { cwd: f.project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const deadline = Date.now() + 4000;
      let state;
      do {
        state = await (await fetch(f.origin + '/state')).json();
        if (state.listening.garden) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      } while (Date.now() < deadline);
      assert.equal(state.listening.garden, true);
      assert.equal((await f.run(f.project, 'inspect')).status, 'listener_present');
      assert.equal((await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1')).status, 'listener_present');
    } finally {
      await once(waiter, 'exit');
    }
    await f.stop();
    assert.equal((await f.run(f.project, 'inspect')).status, 'down');
  } finally { await f.close(); }
});
