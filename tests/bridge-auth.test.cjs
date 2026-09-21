// The two real sockets, in a disposable checkout with a fake Tailscale CLI.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const puppeteer = require('puppeteer-core');

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, '.venv/bin/python3');
const PASS = 'ExampleBridge7!';

async function freePair() {
  for (;;) {
    const first = http.createServer();
    await new Promise((resolve, reject) => first.listen(0, '127.0.0.1').once('listening', resolve).once('error', reject));
    const port = first.address().port;
    const second = http.createServer();
    try {
      await new Promise((resolve, reject) => second.listen(port + 1, '127.0.0.1').once('listening', resolve).once('error', reject));
      await Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve))]);
      return port;
    } catch {
      await new Promise(resolve => first.close(resolve));
    }
  }
}

function request(port, route, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : Buffer.from(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(bytes ? { 'content-length': bytes.length } : {}), ...headers } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
}

async function waitFor(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`fixture exited: ${child.output()}`);
    try { if ((await request(port, '/auth/check')).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`fixture did not start: ${child.output()}`);
}

test('bridge gates every route, persists sessions, signs out and rejects legacy Serve', async () => {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'facilitator-auth-'));
  const app = path.join(outer, 'app');
  const bin = path.join(outer, 'bin');
  const port = await freePair();
  let child;
  let browser;
  try {
    await fs.mkdir(app); await fs.mkdir(bin);
    for (const file of ['facilitator','server.py','bridge_auth.py','bridge_gate.py','m-gate.html','m.html',
      'm-sw.js','m-manifest.json','seed.example.json','index.html','page.html','manifest.json',
      'sw.js','card-markdown.js','card-tokens.css','card-logic.js','card-report.js',
      'compose-format.js','cm-markdown.js']) await fs.copyFile(path.join(ROOT,file), path.join(app,file));
    await fs.cp(path.join(ROOT,'assets'), path.join(app,'assets'), { recursive:true });
    const source = await fs.readFile(path.join(app,'server.py'),'utf8');
    await fs.writeFile(path.join(app,'server.py'), source.replace('PORT = 8877', 'PORT = int(os.environ["FACILITATOR_TEST_PORT"])'));
    await fs.writeFile(path.join(outer,'serve.json'), '{}');
    await fs.writeFile(path.join(bin,'tailscale'), '#!/bin/sh\ncat "$FAKE_SERVE_FILE"\n', { mode:0o755 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      FAKE_SERVE_FILE: path.join(outer,'serve.json'), FACILITATOR_TEST_PORT:String(port),
      FACILITATOR_LOG_DIR:path.join(outer,'logs') };
    await run(PYTHON,['-c',[
      'import bridge_auth',
      `good = ${JSON.stringify(PASS)}`,
      'bridge_auth.validate_password(good)',
      `bad = ['', 'short2!', 'LettersOnly', '12345678901!', ' surrounded7! ', 'nonascii7!é', 'tabbed7!\\t', 'a'*255 + '7!']`,
      'for value in bad:',
      '    try: bridge_auth.validate_password(value)',
      '    except ValueError: pass',
      '    else: raise AssertionError(repr(value))',
    ].join('\n')],{cwd:app,env});
    const start = () => {
      const proc = spawn(PYTHON, [path.join(app,'server.py')], { cwd:app, env, stdio:['ignore','pipe','pipe'] });
      let output = '';
      proc.stdout.on('data', data => { output += data; });
      proc.stderr.on('data', data => { output += data; });
      proc.output = () => output;
      return proc;
    };
    const stop = async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child,'exit'); } };
    for (const name of ['bridge_gate.py','bridge_auth.py','m-gate.html']) {
      await fs.rm(path.join(app,name));
      child = start();
      await once(child,'exit');
      assert.match(child.output(),new RegExp(`Phone bridge component ${name.replace('.', '\\.')} is missing`));
      await assert.rejects(request(port,'/state'),undefined,`local port opened without ${name}`);
      await fs.copyFile(path.join(ROOT,name),path.join(app,name));
    }
    await fs.writeFile(path.join(outer,'serve.json'), JSON.stringify({ Web:{ 'fixture.ts.net:443':{ Handlers:{ '/':{ Proxy:`http://127.0.0.1:${port}` } } } } }));
    child = start();
    await once(child,'exit');
    assert.match(child.output(), /Old Tailscale Serve rule/);
    await assert.rejects(request(port,'/state'));
    await fs.writeFile(path.join(outer,'serve.json'), '{}');
    child = start(); await waitFor(port+1,child);
    assert.equal((await request(port,'/state')).status,200, 'local agents still read the board');
    assert.equal((await request(port,'/state','GET',null,{'X-Forwarded-For':'100.101.102.103'})).status,401,
      'a Serve proxy retargeted to the local port must be gated');
    for (const route of ['/state','/m/state','/uploads/file.png','/page','/mdfile?lane=x',
      '/wait?owner=facilitator&timeout=0','/log','/dirs','/push/key'])
      assert.equal((await request(port+1,route)).status,401, route);
    assert.equal((await request(port+1,'/clientlog','POST','{}',{Origin:`http://127.0.0.1:${port+1}`})).status,401);
    assert.match((await request(port+1,'/m')).text,/Adding the Facilitator to the Home Screen/);
    assert.equal((await request(port+1,'/m-icon-180.png')).status,200);
    assert.match((await request(port+1,'/m-manifest.json')).text,/"name": "facilitator"/);
    const origin = { Origin:`http://127.0.0.1:${port+1}` };
    assert.equal((await request(port+1,'/auth/login','POST',JSON.stringify({password:PASS}),origin)).status,503);
    assert.equal((await request(port+1,'/auth/login','POST',JSON.stringify({password:PASS}),
      { Origin:'https://other.tailnet.example' })).status,403);
    assert.equal((await request(port+1,'/state','GET',null,
      { 'X-Forwarded-Host':'127.0.0.1', 'Tailscale-User-Login':'owner@example.test' })).status,401);
    const setup = await run(PYTHON,['-c',[
      'import getpass, sys',
      'from importlib.machinery import SourceFileLoader',
      'cli = SourceFileLoader("facilitator_cli", "facilitator").load_module()',
      'class Input:',
      '    def isatty(self): return True',
      'sys.stdin = Input()',
      `values = iter(['short2!', ${JSON.stringify(PASS)}, 'mismatch', ${JSON.stringify(PASS)}, ${JSON.stringify(PASS)}])`,
      'getpass.getpass = lambda prompt: next(values)',
      'cli.cmd_password(["password", "set"])',
    ].join('\n')],{cwd:app,env});
    assert.match(setup.stdout,/at least 11 characters|11 to 256 characters/);
    assert.match(setup.stdout,/passwords did not match/i);
    assert.equal(setup.stdout.includes(PASS),false,'the installer printed a password');
    const credentialFile = await fs.readFile(path.join(app,'bridge-auth.json'),'utf8');
    assert.equal(credentialFile.includes(PASS),false,'plaintext password was stored');
    assert.equal((await fs.stat(path.join(app,'bridge-auth.json'))).mode & 0o777,0o600);
    assert.equal((await request(port+1,'/auth/login','POST',JSON.stringify({password:'bad'}),origin)).status,401);
    const login = await request(port+1,'/auth/login','POST',JSON.stringify({password:PASS}),origin);
    assert.equal(login.status,200,login.text);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.match(login.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
    const auth = { Cookie:cookie };
    assert.equal((await request(port+1,'/state','GET',null,auth)).status,200);
    assert.match((await request(port+1,'/m','GET',null,auth)).text,/<aside id="settings"/);
    assert.equal((await request(port+1,'/create','POST','fixture',auth)).status,403);
    assert.equal((await request(port+1,'/create','POST','fixture',{...origin,...auth})).status,200);
    const endpoint = 'https://push.fixture.invalid/session-a';
    assert.equal((await request(port+1,'/push/subscribe','POST',JSON.stringify({endpoint,keys:{}}),
      {...origin,...auth})).status,200);
    const pushSession = JSON.parse(await fs.readFile(path.join(app,'state.json'),'utf8'))
      .push_subs.find(item => item.endpoint === endpoint).session;
    assert.match(pushSession,/^[0-9a-f]{64}$/);
    assert.equal((await request(port+1,'/push/unsubscribe','POST',JSON.stringify({endpoint}),
      {...origin,...auth})).status,200);
    assert.equal(JSON.parse(await fs.readFile(path.join(app,'state.json'),'utf8')).push_subs
      .some(item => item.endpoint === endpoint),false);

    // Open the real phone page in its own Chrome profile, at an iPhone size.
    browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
      userDataDir:path.join(outer,'chrome'), args:['--disable-background-networking','--no-first-run'] });
    const page = await browser.newPage();
    await page.setViewport({width:390,height:844,deviceScaleFactor:3,isMobile:true,hasTouch:true});
    const shots = process.env.FACILITATOR_SHOTS;
    if (shots) await fs.mkdir(shots,{recursive:true});
    await page.goto(`http://127.0.0.1:${port+1}/m`,{waitUntil:'domcontentloaded'});
    assert.equal(await page.$eval('.install-face', el => getComputedStyle(el).display !== 'none'),true);
    await new Promise(resolve => setTimeout(resolve,650));
    const mid = await page.$$eval('.step', rows => rows.map(row => row.classList.contains('shown')));
    assert.deepEqual(mid,[false,false,false,false,false], 'steps appeared before the card');
    await new Promise(resolve => setTimeout(resolve,900));
    const first = await page.$$eval('.step', rows => rows.map(row => row.classList.contains('shown')));
    assert.equal(first[0],true);
    assert.equal(first[4],false);
    await page.waitForFunction(() => document.querySelectorAll('.step.shown').length === 5 &&
      document.querySelector('.browser-link').classList.contains('shown'));
    await new Promise(resolve => setTimeout(resolve,350));
    if (shots) await page.screenshot({path:path.join(shots,'onboarding.png')});
    const standalone = await browser.newPage();
    await standalone.setViewport({width:390,height:844,deviceScaleFactor:3,isMobile:true,hasTouch:true});
    await standalone.evaluateOnNewDocument(() => Object.defineProperty(navigator,'standalone',{value:true}));
    await standalone.goto(`http://127.0.0.1:${port+1}/m`,{waitUntil:'domcontentloaded'});
    assert.equal(await standalone.$eval('.login-face',el => getComputedStyle(el).display !== 'none'),true,
      'installed PWA should open at password input');
    await standalone.close();
    await page.click('#use-browser');
    await page.type('#password','wrong');
    await page.click('.connect');
    await page.waitForFunction(() => document.querySelector('.login-face').classList.contains('bad'));
    if (shots) await page.screenshot({path:path.join(shots,'wrong-password.png')});
    await page.$eval('#password',el => { el.value=''; });
    await page.type('#password',PASS);
    await page.click('.connect');
    await page.waitForSelector('#settings');
    await browser.close();
    browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,
      userDataDir:path.join(outer,'chrome'), args:['--disable-background-networking','--no-first-run'] });
    const reopened = await browser.newPage();
    await reopened.setViewport({width:390,height:844,deviceScaleFactor:3,isMobile:true,hasTouch:true});
    await reopened.goto(`http://127.0.0.1:${port+1}/m`,{waitUntil:'domcontentloaded'});
    await reopened.waitForSelector('#settings');
    assert.equal(await reopened.$('.login-face'),null, 'reopening the installed profile asked for a password');
    assert.equal(await reopened.$eval('#signout',el => el.textContent.trim()),'Sign out');
    await reopened.evaluate(() => showMenu(settings));
    await new Promise(resolve => setTimeout(resolve,650));
    if (shots) await reopened.screenshot({path:path.join(shots,'signed-in-drawer.png')});
    await reopened.click('#signout');
    await reopened.waitForSelector('.install-face');
    assert.equal(await reopened.evaluate(async () => (await (await fetch('/auth/check')).json()).authenticated),false);
    await reopened.waitForFunction(() =>
      document.querySelectorAll('.step.shown').length === 5 &&
      Number(getComputedStyle(document.querySelector('.browser-link')).opacity) >= .99 &&
      Number(getComputedStyle(document.querySelector('.install-face .card')).opacity) >= .99);
    assert.equal(await reopened.$eval('.install-face', el => getComputedStyle(el).display !== 'none'),true);
    if (shots) await reopened.screenshot({path:path.join(shots,'signed-out.png')});
    await browser.close(); browser = null;

    await stop(); child = start(); await waitFor(port+1,child);
    assert.equal((await request(port+1,'/auth/check','GET',null,auth)).text.includes('"authenticated": true'),true);
    assert.equal((await request(port+1,'/state','GET',null,auth)).status,200);
    assert.equal((await request(port+1,'/auth/logout','POST',null,{...origin,...auth})).status,200);
    assert.equal((await request(port+1,'/state','GET',null,auth)).status,401);
    const pushVerdict = await run(PYTHON,['-c',
      `import bridge_auth; print(bridge_auth.has_session_digest(${JSON.stringify(pushSession)}))`],{cwd:app,env});
    assert.equal(pushVerdict.stdout.trim(),'False','sign-out left a push session active');
    const again = await request(port+1,'/auth/login','POST',JSON.stringify({password:PASS}),origin);
    const againCookie = again.headers['set-cookie'][0].split(';')[0];
    await run(PYTHON,['-c',`import bridge_auth; bridge_auth.set_password('ReplacementBridge8!')`],{ cwd:app, env });
    assert.equal((await request(port+1,'/state','GET',null,{Cookie:againCookie})).status,401);
    for (let n=0;n<5;n++) await request(port+1,'/auth/login','POST',JSON.stringify({password:'wrong'}),origin);
    assert.equal((await request(port+1,'/auth/login','POST',JSON.stringify({password:PASS}),origin)).status,429);
    await stop(); child = null;
    await run(PYTHON,['-c',[
      'import os, server, bridge_auth',
      'server._BRIDGE_AUTH = bridge_auth',
      'server._state = {"push_subs": [{"session": "0"*64, "endpoint": "https://push.invalid/one"}]}',
      'server._box = lambda bid: None',
      'server._push_bridge_available = lambda: (_ for _ in ()).throw(AssertionError("push check was bypassed"))',
      'os.unlink("bridge_auth.py")',
      'server._push_turn("fixture")',
    ].join('\n')],{cwd:app,env});
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child,'exit'); }
    await fs.rm(outer,{recursive:true,force:true});
  }
});
