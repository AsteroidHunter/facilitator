// Exercise the installed skill's local selector and confirmed claim against a
// disposable board, locked as a real board is: every call on its own port
// carries the board's agent key, the helper's and this file's alike. These
// calls do not exercise either host's skill loader.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFile, spawn } = require('node:child_process');
const http = require('node:http');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { copyBridgeFiles, dataOf, freePortPair, stubWindow, windowOpens } = require('./fixture-auth.cjs');

const exec = promisify(execFile);
// what a ready inspect answers on the Mac: the lane, its port and runbook, and
// the -K and key file the runbook's curl lines take, with the board's address
const READY_KEYS = ['status', 'owner', 'port', 'runbook', 'curl', 'base'];
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, '../data/.venv/bin/python3');

// the board is a clone of its own, outer/board, laid out as the repository
// is: .agents/ at its top beside app/ and data/. The board names that clone as
// its folder, which is what the helper compares with the folder it is in.
// The projects and the home sit beside it, outside every lane but their own.
// lock: false is a board from before the key, which asks nobody for one and
// whose folder holds no key file
async function fixture(laneDirs, { lock = true } = {}) {
  const outer = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'facilitator-onboard-')));
  const clone = path.join(outer, 'board');
  const app = path.join(clone, 'app');
  const home = path.join(outer, 'home');
  await fs.mkdir(app, { recursive: true });
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
  // these cases are about the helper, not the typing hold (typing-hold.test.cjs),
  // so a message sent here is free to go out at once
  assert.match(source, /TYPING_HOLD = 3\.5/);
  // the board's window goes to stand-ins in window/, never to the real Chrome
  const windowDir = path.join(outer, 'window');
  await fs.writeFile(path.join(app, 'server.py'), stubWindow(source
    .replace('PORT = 8877', "PORT = int(os.environ['FACILITATOR_TEST_PORT'])")
    .replace('TYPING_HOLD = 3.5', 'TYPING_HOLD = 0.0')
    .replace('TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"',
      `TAILSCALE_APP = ${JSON.stringify(path.join(outer, 'no-real-tailscale'))}`), windowDir));
  copyBridgeFiles(app);
  await fs.cp(path.join(ROOT, '..', '.agents'), path.join(clone, '.agents'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'RUNBOOK.md'), path.join(app, 'RUNBOOK.md'));
  const project = path.join(outer, 'project');
  const second = path.join(outer, 'second');
  await fs.mkdir(project);
  await fs.mkdir(second);
  const lanes = laneDirs ? laneDirs({ outer, app, project, second }) : [
    { owner: 'garden', dir: project }, { owner: 'river', dir: second },
  ];
  await fs.writeFile(path.join(dataOf(app), 'run.config.json'), JSON.stringify({ port, lanes }));
  await fs.writeFile(path.join(dataOf(app), 'seed.json'), JSON.stringify({
    title: 'onboarding fixture',
    items: [{ id: '0', bucket: 'meta', title: 'Tool', owner: 'facilitator' },
      { id: 'm1', bucket: 'meta', title: 'Project', owner: 'garden' },
      { id: 'm2', bucket: 'meta', title: 'Second project card', owner: 'garden' }],
  }));
  for (const host of ['.claude', '.agents']) {
    const skillDir = path.join(home, host, 'skills');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.symlink(path.join(clone, '.agents/skills/facilitator'), path.join(skillDir, 'facilitator'));
  }
  const helper = path.join(home, '.agents/skills/facilitator/scripts/onboard.py');
  const env = { ...process.env, HOME: home, PATH: `${tools}${path.delimiter}${process.env.PATH}`,
    FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(outer, 'logs'),
    ...(lock ? { FACILITATOR_TEST_LOCK: '1' } : {}) };
  const child = spawn(PYTHON, [path.join(app, 'server.py')], {
    cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', chunk => { log += chunk; });
  }
  const curl = path.join(dataOf(app), 'agent.curl');
  const keyed = () => {
    try { return { Authorization: `Bearer ${require('node:fs').readFileSync(path.join(dataOf(app), 'agent.key'), 'utf8').trim()}` }; }
    catch { return {}; }
  };
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${log}`);
    try {
      if ((await fetch(origin + '/state', { headers: keyed() })).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  if (!(await fetch(origin + '/state', { headers: keyed() })).ok) throw new Error(`fixture server did not start:\n${log}`);
  if (!lock) {
    await fs.rm(path.join(dataOf(app), 'agent.key'));
    await fs.rm(curl);
  }
  return {
    outer, app, home, project, second, port, origin, helper, env, curl, keyed, lock, windowDir,
    // a GET on the board's own port with its key, as an agent's curl -K makes it
    async get(route) { return (await fetch(origin + route, { headers: keyed() })).json(); },
    async run(cwd, ...args) {
      const { stdout } = await exec(PYTHON, [helper, ...args], { cwd, env, timeout: 30000 });
      return JSON.parse(stdout.trim());
    },
    // the helper with text on its standard input, as a heredoc gives it
    reply(cwd, text, ...args) {
      return new Promise((resolve, reject) => {
        const child = execFile(PYTHON, [helper, 'wait', '--reply', ...args], { cwd, env, timeout: 30000 },
          (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`))
            : resolve(JSON.parse(stdout.trim()))));
        child.stdin.end(text);
      });
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
  const response = await fetch(f.origin + route, { method: 'POST', body, headers: f.keyed() });
  return { status: response.status, body: await response.json() };
}

// one request to the board's own port with exactly these headers
function raw(f, method, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.port, method, path: route,
      headers: { Host: `127.0.0.1:${f.port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// a request from the board's own window, as Chrome sends a script's: on a
// locked board with the window's cookie, got the way the window gets it: the
// board opens its window, and the address it gave the stand-in open is opened
async function fromThePage(f, method, route, body) {
  const headers = { Origin: f.origin, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty' };
  if (f.lock) {
    assert.equal((await raw(f, 'POST', '/window/open', f.keyed())).status, 200);
    const app = windowOpens(f.windowDir).at(-1).find(arg => arg.startsWith('--app='));
    const code = new URL(app.slice('--app='.length)).searchParams.get('launch');
    const opened = await raw(f, 'GET', `/?launch=${code}`,
      { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
    assert.equal(opened.status, 303, opened.text);
    headers.Cookie = opened.headers['set-cookie'][0].split(';')[0];
  }
  const r = await raw(f, method, route, headers, body);
  return { status: r.status, body: JSON.parse(r.text) };
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

test('inspect names the key file for the runbook curl lines, and a curl without it is refused', async () => {
  const f = await fixture();
  try {
    const ready = await f.run(f.project, 'inspect');
    assert.equal(ready.status, 'ready');
    assert.equal(ready.curl, `-K ${f.curl}`);
    assert.equal(ready.base, f.origin);
    assert.equal((await fs.stat(f.curl)).mode & 0o777, 0o600);
    const curl = async (...words) => (await exec('curl', ['-sS', ...words], { timeout: 30000 })).stdout;
    const route = `${ready.base}/fresh?owner=garden`;
    assert.deepEqual(JSON.parse(await curl(...ready.curl.split(' '), route)).messages, []);
    const bare = JSON.parse(await curl(route));
    assert.match(bare.error, /run scripts\/onboard\.py inspect and put -K and the file it names in front of every curl/);
    assert.equal(JSON.parse(await curl(`${ready.base}/unread?owner=garden`)).queued, 0);
    // a key file that is not the running board's: the helper says so and claims nothing
    const keyFile = path.join(dataOf(f.app), 'agent.key');
    const kept = await fs.readFile(keyFile, 'utf8');
    await fs.writeFile(keyFile, 'k'.repeat(43) + '\n');
    const refused = await f.run(f.project, 'inspect');
    assert.equal(refused.status, 'key_refused');
    assert.match(refused.detail, /did not take this folder's agent key/);
    assert.equal((await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1')).status, 'key_refused');
    await fs.writeFile(keyFile, kept);
    assert.equal((await f.run(f.project, 'inspect')).status, 'ready');
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

// the person's first name: the first word of the profile's name as typed,
// read the way the board reads the name, and nothing else of the profile
test('inspect gives the first word of the profile name, and no name for none', async () => {
  const f = await fixture();
  const profile = path.join(dataOf(f.app), 'profile.json');
  const others = { email: 'owner@example.invalid', email_yes: true, work: 'garden notes', time_zone: 'Europe/Madrid' };
  const inspect = async fields => {
    await fs.writeFile(profile, JSON.stringify({ ...others, ...fields }));
    return f.run(f.project, 'inspect');
  };
  try {
    assert.equal((await f.run(f.project, 'inspect')).name, 'Fixture');
    for (const [name, first] of [['Ada', 'Ada'], ['Ada Lovelace', 'Ada'], ['  ada  ', 'ada'],
      ['María José García', 'María'], ['Ада Лавлейс', 'Ада'], ['Ada\tLovelace\n', 'Ada']]) {
      const said = await inspect({ name });
      assert.deepEqual(Object.keys(said), [...READY_KEYS, 'name'], name);
      assert.equal(said.name, first, name);
    }
    // what the board reads as no name: none, blank, not text, a control
    // character, past 200 characters
    for (const fields of [{}, { name: '' }, { name: '   ' }, { name: null }, { name: 42 }, { name: 'A\u0007da' },
      { name: 'A'.repeat(201) }]) {
      const said = await inspect(fields);
      assert.equal(said.status, 'ready');
      assert.deepEqual(Object.keys(said), READY_KEYS, JSON.stringify(fields));
    }
    await fs.rm(profile);
    assert.deepEqual(Object.keys(await f.run(f.project, 'inspect')), READY_KEYS);
    // a lane already held still names the person beside the runbook
    await inspect({ name: 'Ada Lovelace' });
    assert.equal((await post(f, '/send?box=m1', 'First message')).status, 200);
    assert.equal((await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1')).status, 'claim');
    const held = await f.run(f.project, 'inspect');
    assert.equal(held.status, 'claim_held');
    assert.equal(held.name, 'Ada');
    assert.doesNotMatch(JSON.stringify(held), /Lovelace|owner@example|garden notes|Madrid/);
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
    const saved = JSON.parse(await fs.readFile(path.join(dataOf(f.app), 'state.json'), 'utf8'));
    assert.equal(saved.ack.garden.confirmed, true);
    assert.equal((await f.run(f.project, 'inspect')).status, 'claim_held');

    assert.equal((await post(f, '/send?box=m1', 'Follow-up')).status, 200);
    const fresh = await f.get('/fresh?owner=garden');
    assert.deepEqual(fresh.messages, ['Follow-up']);
    assert.equal((await post(f, '/working?box=m1&v=1')).status, 200);
    assert.equal((await post(f, '/ping?box=m1')).status, 200);
    assert.equal((await post(f, '/reply?box=m1', 'I received both messages. Work is underway.')).status, 200);
    let state = await f.get('/state');
    assert.equal(state.busy.garden, null);
    assert.equal(state.boxes.find(box => box.id === 'm1').state, 'working');
    assert.equal(JSON.parse(await fs.readFile(path.join(dataOf(f.app), 'state.json'), 'utf8'))
      .boxes.find(box => box.id === 'm1').state, 'deferred');
    assert.equal((await post(f, '/working?box=m1&v=0')).status, 200);
    state = await f.get('/state');
    assert.equal(state.boxes.find(box => box.id === 'm1').reply, 'I received both messages. Work is underway.');
    assert.equal((await post(f, '/send?box=m2', 'Another card')).status, 200);
    const noClaim = await f.get('/fresh?owner=garden');
    assert.deepEqual(noClaim.messages, []);
    assert.equal(Object.hasOwn(noClaim, 'box'), false);
    assert.equal((await post(f, '/reply?box=m1', 'The background work is complete.')).status, 200);
    const next = await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1');
    assert.equal(next.box, 'm2');
    assert.deepEqual(next.messages, ['Another card']);
    const freshNext = await f.get('/fresh?owner=garden');
    assert.equal(freshNext.box, 'm2');
    assert.deepEqual(freshNext.messages, []);
    assert.equal((await post(f, '/reply?box=m2', 'I received the other card.')).status, 200);
    assert.equal((await f.run(f.project, 'wait', '--owner', 'garden', '--timeout', '1')).status, 'idle');
  } finally { await f.close(); }
});

// wait --reply: the check, the reply and the next listen in one command, on a
// board that asks for the key and on one from before the key, with no key file
for (const lock of [true, false]) {
  test(`wait --reply posts only when nothing new came, then listens as wait does (${lock ? 'key file' : 'no key file'})`, async () => {
    const f = await fixture(undefined, { lock });
    const card = async id => (await f.get('/state')).boxes.find(box => box.id === id);
    const lane = ['--owner', 'garden', '--agent', 'opus'];
    try {
      const ready = await f.run(f.project, 'inspect');
      assert.equal(ready.status, 'ready');
      assert.equal(Object.hasOwn(ready, 'curl'), lock);
      assert.equal((await post(f, '/send?box=m1', 'First message')).status, 200);
      const claim = await f.run(f.project, 'wait', ...lane, '--timeout', '1');
      assert.equal(claim.box, 'm1');
      assert.equal((await post(f, '/send?box=m2', 'Another card')).status, 200);

      // nothing new: the reply goes as typed and the next claim comes back in next
      const replied = await f.reply(f.project, 'The answer to the first message.\n', 'm1', ...lane, '--timeout', '2');
      assert.deepEqual(Object.keys(replied), ['status', 'box', 'reply', 'next']);
      assert.deepEqual([replied.status, replied.box, replied.reply], ['replied', 'm1', { ok: true }]);
      assert.equal(replied.next.status, 'claim');
      assert.deepEqual([replied.next.box, replied.next.messages], ['m2', ['Another card']]);
      assert.deepEqual(Object.keys(replied.next), Object.keys(claim));
      assert.equal((await card('m1')).reply, 'The answer to the first message.');
      assert.equal((await f.get('/state')).busy.garden, 'm2');
      const saved = JSON.parse(await fs.readFile(path.join(dataOf(f.app), 'state.json'), 'utf8'));
      assert.equal(saved.ack.garden.confirmed, true);

      // a message that came while the reply was written: nothing posts, and it comes back
      assert.equal((await fromThePage(f, 'POST', '/send?box=m2', 'A follow-up')).status, 200);
      const before = await card('m2');
      const fresh = await f.reply(f.project, 'A reply that has not seen the follow-up.', 'm2', ...lane);
      assert.deepEqual(fresh, { status: 'fresh', box: 'm2', messages: ['A follow-up'], message_via: [null],
        message_by: [null], message_agent: [null] });
      assert.deepEqual([(await card('m2')).replies, (await card('m2')).reply], [before.replies, before.reply]);
      assert.equal((await f.get('/state')).busy.garden, 'm2');

      // another card held: nothing posts on the first card
      const other = await f.reply(f.project, 'A late word on the first card.', 'm1', ...lane);
      assert.deepEqual(other, { status: 'fresh', box: 'm2', messages: [], message_via: [], message_by: [],
        message_agent: [] });
      assert.equal((await card('m1')).reply, 'The answer to the first message.');

      // a message typed in the card's widget: nothing posts, and it comes back
      const page = '<!doctype html><p>a widget</p><script>facilitator.ready()</script>';
      assert.equal((await post(f, '/magic?box=m2&kind=html&widget=issues', page)).status, 200);
      const sent = await fromThePage(f, 'POST', `/magic/send?box=m2&rev=${(await card('m2')).magic.rev}&op=replyop0001`,
        JSON.stringify({ text: 'And this one?', about: 't1' }));
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const typed = await f.reply(f.project, 'A reply that covers the follow-up.', 'm2', ...lane);
      assert.equal(typed.status, 'fresh');
      assert.deepEqual([typed.box, typed.messages], ['m2', []]);
      assert.deepEqual(typed.widget_messages.map(({ ts, ...m }) => m),
        [{ from: 'widget', widget: 'issues', about: 't1', text: 'And this one?' }]);
      assert.equal((await card('m2')).replies, before.replies);

      // nothing new now: the reply goes, and the listen's idle reads as a plain wait's
      const done = await f.reply(f.project, 'A reply that covers the follow-up.', 'm2', ...lane, '--timeout', '1');
      assert.deepEqual([done.status, done.next], ['replied', { status: 'idle', owner: 'garden' }]);
      assert.deepEqual(done.next, await f.run(f.project, 'wait', ...lane, '--timeout', '1'));
      assert.equal((await card('m2')).reply, 'A reply that covers the follow-up.');

      // the board refusing the reply: its words come back and nothing listens
      assert.equal((await post(f, '/send?box=m1', 'Waiting while a reply is refused')).status, 200);
      const refused = await f.reply(f.project, 'For a card that is not there.', 'm999', ...lane, '--timeout', '1');
      assert.deepEqual(refused, { status: 'reply_failed', box: 'm999', code: 400, reply: { error: 'bad box' } });
      assert.equal((await f.get('/state')).busy.garden, null);

      // an empty reply is refused before any call
      for (const text of ['', ' \n\t\n']) {
        const empty = await f.reply(f.project, text, 'm1', ...lane, '--timeout', '1');
        assert.equal(empty.status, 'empty_reply');
        assert.equal((await f.get('/state')).busy.garden, null);
      }
      assert.equal((await card('m1')).reply, 'The answer to the first message.');
      assert.deepEqual((await f.run(f.project, 'wait', ...lane, '--timeout', '1')).messages,
        ['Waiting while a reply is refused']);
    } finally { await f.close(); }
  });
}

test('an active waiter is detected, and a stopped board is reported without starting one', async () => {
  const f = await fixture();
  try {
    const waiter = spawn(PYTHON, [f.helper, 'wait', '--owner', 'garden', '--timeout', '4'],
      { cwd: f.project, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const deadline = Date.now() + 4000;
      let state;
      do {
        state = await f.get('/state');
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

// The listen length is written in several places that must agree: the helper's
// default, its client deadline and help text, the skill's instruction and the
// RUNBOOK's loop. These pin them together.
const LISTEN = 420;

test('the helper listens 420 seconds by default in one request, with its client deadline 10 seconds above', async () => {
  const helperPath = path.join(ROOT, '../.agents/skills/facilitator/scripts/onboard.py');
  const probe = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("onboard", ${JSON.stringify(helperPath)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
calls = []
mod.board = lambda: ({"busy": {"garden": None}, "listening": {}}, None)
def fake(method, route, *, timeout=3):
    calls.append([method, route, timeout])
    return {"idle": True}
mod.request = fake
sys.argv = ["onboard.py", "wait", "--owner", "garden", "--agent", "codex"]
mod.main()
sys.argv = ["onboard.py", "wait", "--owner", "garden", "--timeout", "90"]
mod.main()
print(json.dumps(calls))`;
  const { stdout } = await exec(PYTHON, ['-c', probe], { timeout: 30000 });
  const calls = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(calls.length, 2, 'each wait is one request');
  assert.equal(calls[0][0], 'GET');
  assert.equal(new URL('http://x' + calls[0][1]).searchParams.get('timeout'), String(LISTEN));
  assert.equal(calls[0][2], LISTEN + 10);
  assert.equal(new URL('http://x' + calls[1][1]).searchParams.get('timeout'), '90');
  assert.equal(calls[1][2], 100);
  for (const bad of ['0', '541']) {
    await assert.rejects(exec(PYTHON, [helperPath, 'wait', '--owner', 'garden', '--timeout', bad], { timeout: 30000 }));
  }
  const help = (await exec(PYTHON, [helperPath, 'wait', '--help'], { timeout: 30000 })).stdout;
  assert.match(help, /default 420/);
  assert.doesNotMatch(help, /default 50\b/);
});

test('the skill and the RUNBOOK loop state the 7 minute listen and no longer the 50 second one', async () => {
  const skill = await fs.readFile(path.join(ROOT, '../.agents/skills/facilitator/SKILL.md'), 'utf8');
  assert.match(skill, /up to 7 minutes \(420 seconds\) in one request/);
  assert.match(skill, /430-second client deadline/);
  assert.match(skill, /Claude Code, call Bash with the tool `timeout` set to 600000/);
  assert.match(skill, /In Codex[^.]*still-running session[^.]*\bwrite_stdin\b/);
  assert.doesNotMatch(skill, /50 seconds|60-second/);
  const runbook = await fs.readFile(path.join(ROOT, 'RUNBOOK.md'), 'utf8');
  const loops = runbook.match(/curl --max-time \d+ -sS -K "\$KEY" "[^"]*\/wait\?[^"]*"/g);
  assert.equal(loops.length, 3);
  for (const line of loops) {
    assert.match(line, /--max-time 430 /);
    assert.match(line, /[?&]timeout=420&/);
  }
  assert.doesNotMatch(runbook, /timeout=50\b/);
});

test('the RUNBOOK says once, in its reply rules, to call the person by the name given at joining', async () => {
  const runbook = await fs.readFile(path.join(ROOT, 'RUNBOOK.md'), 'utf8');
  const sentence = 'Call the person by the name you were given when you joined; when you were given none, use no name.';
  assert.equal(runbook.split(sentence).length, 2);
  assert.ok(runbook.split('\n## Replies\n')[1].split('\n## ')[0].includes(`\n- ${sentence}\n`));
  assert.doesNotMatch(runbook, /\{name\}/);
  const skill = await fs.readFile(path.join(ROOT, '../.agents/skills/facilitator/SKILL.md'), 'utf8');
  assert.match(skill, /Its JSON result names the lane, port, and absolute `runbook` path, and carries the person's first name in `name` when their profile holds one\./);
});

test('the skill and the RUNBOOK send each reply with wait --reply, the one fresh-and-reply command allowed', async () => {
  const runbook = await fs.readFile(path.join(ROOT, 'RUNBOOK.md'), 'utf8');
  const skill = await fs.readFile(path.join(ROOT, '../.agents/skills/facilitator/SKILL.md'), 'utf8');
  const rule = 'The only combination of a `/fresh` call and a prewritten reply allowed in one command is '
    + '`onboard.py wait --reply`, which checks first and posts nothing if anything new came.';
  for (const [name, text] of [['RUNBOOK.md', runbook], ['SKILL.md', skill]]) {
    assert.equal(text.split(rule).length, 2, name);
    assert.doesNotMatch(text, /Do not combine a `\/fresh` call with a prewritten reply/, name);
    for (const status of ['replied', 'fresh', 'reply_failed', 'empty_reply'])
      assert.match(text, new RegExp(`\`${status}\`|"status": "${status}"`), `${name} ${status}`);
  }
  assert.ok(runbook.includes(`    python3 "$HOME/.agents/skills/facilitator/scripts/onboard.py" wait --reply ID --owner facilitator --agent opus <<'REPLY'\n`));
  assert.match(skill, /onboard\.py" wait --reply ID --owner OWNER --agent NAME`, the complete, self-contained reply text on standard input/);
  // the routes under the command stay written down as the protocol
  assert.ok(runbook.includes('curl -sS -K "$KEY" -X POST --data-binary @reply.txt "http://127.0.0.1:$PORT/reply?box=ID"'));
  assert.ok(runbook.includes('curl -sS -K ~/.facilitator/agents/LANE.curl -X POST --data-binary @reply.txt "http://board/reply?box=ID"'));
});
