// Sequential typing and caret geometry against an invented, ephemeral board.
// Phone-sized Chromium with iPhone platform metadata is not iOS Safari.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, '.venv/bin/python3');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVIDENCE = process.env.BULLET_SPACE_EVIDENCE || path.join(tmpdir(), 'facilitator-bullet-space-evidence');
const ROW = 'article.box.sel textarea';
const COPIED = ['m.html', 'm-sw.js', 'm-manifest.json', 'card-markdown.js', 'card-tokens.css',
  'card-logic.js', 'card-report.js', 'compose-format.js', 'cm-markdown.js', 'index.html', 'page.html'];
const PLATFORMS = [
  { name: 'phone', viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
];
let browser, child, fixtureDir, origin;
const traces = {};
const settle = (ms = 130) => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function api(route, body) {
  const response = await fetch(origin + route, { method: 'POST', body });
  assert.ok(response.ok, route + ': ' + response.status);
  return response.json();
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'facilitator-bullet-space-'));
  await mkdir(path.join(fixtureDir, 'logs'));
  await mkdir(EVIDENCE, { recursive: true });
  const port = await freePort();
  const source = await readFile(path.join(ROOT, 'server.py'), 'utf8');
  const patched = source.replace('PORT = 8877', "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source);
  await writeFile(path.join(fixtureDir, 'server.py'), patched);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, 'assets'));
  for (const name of await readdir(path.join(ROOT, 'assets')))
    await copyFile(path.join(ROOT, 'assets', name), path.join(fixtureDir, 'assets', name));
  await writeFile(path.join(fixtureDir, 'seed.json'), JSON.stringify({
    title: 'Sequential bullet typing fixture',
    items: [{ id: '0', bucket: 'meta', title: 'Fixture metadata', owner: 'facilitator', context: 'Invented content.' }],
  }));
  origin = 'http://127.0.0.1:' + port;
  child = spawn(PYTHON, [path.join(fixtureDir, 'server.py')], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, 'logs') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Fixture exited: ' + output);
    try { if ((await fetch(origin + '/state')).ok) { ready = true; break; } } catch {}
    await settle(30);
  }
  assert.ok(ready, output);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ['--disable-background-networking', '--no-first-run'] });
  await writeFile(path.join(EVIDENCE, 'runtime.json'), JSON.stringify({
    browser: await browser.version(), origin, fixtureDir,
    engine: 'Chromium; phone emulation does not run iOS Safari or a software keyboard',
  }, null, 2));
});

after(async () => {
  await writeFile(path.join(EVIDENCE, 'traces.json'), JSON.stringify(traces, null, 2));
  if (browser) await browser.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    if (!await Promise.race([ended.then(() => true), settle(5000).then(() => false)])) {
      child.kill('SIGKILL');
      await ended;
    }
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

async function open(platform) {
  const state = await (await fetch(origin + '/state')).json();
  for (const box of state.boxes)
    if (box.id !== '0' && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  const { id } = await api('/create?owner=facilitator', 'Invented typing fixture');
  await api(`/reply?box=${id}`, 'A fixture reply.');
  const page = await browser.newPage();
  await page.setViewport(platform.viewport);
  await page.evaluateOnNewDocument(phone => {
    localStorage.clear();
    Object.defineProperty(navigator, 'platform', { get: () => phone ? 'iPhone' : 'MacIntel', configurable: true });
    if (phone) {
      const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
      Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
      Object.defineProperty(navigator, 'vendor', { get: () => 'Apple Computer, Inc.', configurable: true });
    }
  }, platform.name === 'phone');
  const problems = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(origin + (platform.name === 'phone' ? `/m?box=${id}` : '/'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(cardId => typeof lastState !== 'undefined' && lastState && els[cardId], { timeout: 15000 }, id);
  if (platform.name === 'desktop') await page.evaluate(cardId => select(cardId), id);
  await page.waitForSelector(`#box-${id}.sel .cffield`, { timeout: 30000 });
  if (platform.name === 'phone') await page.waitForSelector('#loading', { hidden: true, timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.focus(ROW);
  return { page, problems };
}

async function snapshot(page, key) {
  await settle();
  return page.evaluate(label => {
    const row = document.querySelector('article.box.sel textarea');
    const view = ComposeFormat.fieldOf(row).view;
    const rect = r => r && ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    const content = view.contentDOM;
    const selection = window.getSelection();
    const domCaret = selection.rangeCount ? rect(selection.getRangeAt(0).getBoundingClientRect()) : null;
    const font = getComputedStyle(content);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px';
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing']) probe.style[property] = font[property];
    probe.textContent = ' ';
    document.body.append(probe);
    const spaceWidth = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      key: label, raw: row.value, selection: { from: row.selectionStart, to: row.selectionEnd },
      focused: view.hasFocus, caret: rect(view.coordsAtPos(view.state.selection.main.head)), domCaret,
      sourcePositions: Array.from({ length: view.state.doc.length + 1 }, (_, pos) => ({ pos, ...rect(view.coordsAtPos(pos)) })),
      domSelection: { anchorOffset: selection.anchorOffset, anchorText: selection.anchorNode && selection.anchorNode.textContent },
      bulletCount: content.querySelectorAll('.cf-bullet').length,
      lines: [...content.querySelectorAll('.cm-line')].map(line => ({
        text: line.textContent, html: line.innerHTML, rect: rect(line.getBoundingClientRect()),
        padding: getComputedStyle(line).paddingLeft, textIndent: getComputedStyle(line).textIndent,
        marks: [...line.querySelectorAll('.cf-mark')].map(mark => ({
          text: mark.textContent, rect: rect(mark.getBoundingClientRect()),
          color: getComputedStyle(mark).color, pseudo: getComputedStyle(mark, '::before').content,
        })),
      })),
      parser: CM6.syntaxTree(view.state).toString(),
      fontFamily: font.fontFamily, fontSize: font.fontSize, spaceWidth,
      platform: navigator.platform,
    };
  }, key);
}

async function press(page, key, out, label = key) {
  await page.keyboard.press(key);
  out.push(await snapshot(page, label));
}

async function screenshot(page, name) {
  const clip = await page.evaluate(() => {
    const r = document.querySelector('article.box.sel .compose').getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: Math.min(innerWidth, r.width + 16), height: r.height + 16 };
  });
  await page.screenshot({ path: path.join(EVIDENCE, name + '.png'), clip });
}

// A trace is collected once per platform and inspected by independent tests,
// so the early-marker failure cannot hide a later space/caret failure.
for (const platform of PLATFORMS) {
  test(`${platform.name}: collect each dash and space keystroke`, async () => {
    const { page, problems } = await open(platform);
    const out = traces[platform.name] = [];
    try {
      out.push(await snapshot(page, 'empty'));
      await press(page, 'Minus', out, 'dash');
      await screenshot(page, platform.name + '-bare-dash');
      await press(page, 'Space', out, 'separator');
      await screenshot(page, platform.name + '-separator');
      await press(page, 'Space', out, 'extra-space-1');
      await press(page, 'Space', out, 'extra-space-2');
      await screenshot(page, platform.name + '-three-spaces');
      await press(page, 'KeyX', out, 'first-letter');
      await screenshot(page, platform.name + '-first-letter');
      assert.deepEqual(out.map(s => s.raw), ['', '-', '- ', '-  ', '-   ', '-   x']);
      assert.ok(out.every(s => s.focused && s.selection.from === s.raw.length && s.selection.to === s.raw.length),
        'The source or logical caret changed independently of the typed characters');
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  });

  test(`${platform.name}: a bare dash stays literal until its separator`, () => {
    const trace = traces[platform.name];
    assert.equal(trace[1].bulletCount, 0, 'A dash with no separator is already painted as a bullet');
    assert.equal(trace[2].bulletCount, 1, 'Dash plus a separator should draw one bullet');
  });

  test(`${platform.name}: every typed separator space advances the visible caret`, () => {
    const trace = traces[platform.name];
    for (let index = 2; index <= 4; index++) {
      const before = trace[index - 1], after = trace[index];
      const advance = after.caret.left - before.caret.left;
      assert.ok(advance > 0.5, `${after.key}: source caret ${before.selection.from} -> ${after.selection.from}, ` +
        `but drawn x ${before.caret.left} -> ${after.caret.left} (${advance}px); normal space is ${after.spaceWidth}px`);
      if (index > 2) assert.ok(Math.abs(advance - after.spaceWidth) < 0.75,
        `${after.key}: a normal space is ${after.spaceWidth}px, but the caret advanced ${advance}px`);
    }
  });

  test(`${platform.name}: sentence hyphens remain literal while typing`, async () => {
    const { page, problems } = await open(platform);
    const out = traces[platform.name + '-inline'] = [];
    try {
      await page.keyboard.type('A sentence');
      await press(page, 'Space', out, 'before-hyphen');
      await press(page, 'Minus', out, 'inline-hyphen');
      await press(page, 'Space', out, 'after-hyphen');
      await press(page, 'KeyX', out, 'next-word');
      assert.ok(out.every(s => s.bulletCount === 0));
      assert.equal(out.at(-1).raw, 'A sentence - x');
      assert.ok(out[2].caret.left > out[1].caret.left + 0.5);
      assert.deepEqual(problems, []);
    } finally { await page.close(); }
  });
}

test('phone: collect a nested item and an ordered item while typing', async () => {
  const { page, problems } = await open(PLATFORMS[0]);
  try {
    const nested = traces['phone-nested'] = [];
    await page.keyboard.type('- parent');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Space');
    await press(page, 'Space', nested, 'nested-indent');
    await press(page, 'Minus', nested, 'nested-dash');
    await press(page, 'Space', nested, 'nested-separator');
    await press(page, 'Space', nested, 'nested-extra-space');
    await press(page, 'KeyX', nested, 'nested-letter');
    await screenshot(page, 'phone-nested');
    assert.deepEqual(nested.map(s => s.raw), ['- parent\n  ', '- parent\n  -', '- parent\n  - ', '- parent\n  -  ', '- parent\n  -  x']);
    // Clear through the browser's editing commands, not a document assignment.
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Meta');
    await page.keyboard.press('Backspace');
    const ordered = traces['phone-ordered'] = [];
    await press(page, 'Digit1', ordered, 'ordered-first-digit');
    await press(page, 'Digit0', ordered, 'ordered-second-digit');
    await press(page, 'Period', ordered, 'ordered-period');
    await press(page, 'Space', ordered, 'ordered-separator');
    await press(page, 'Space', ordered, 'ordered-extra-space');
    await press(page, 'KeyX', ordered, 'ordered-letter');
    await screenshot(page, 'phone-ordered');
    assert.deepEqual(ordered.map(s => s.raw), ['1', '10', '10.', '10. ', '10.  ', '10.  x']);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test('phone: a nested bare dash stays literal until its separator', () => {
  const trace = traces['phone-nested'];
  assert.equal(trace[1].bulletCount, 1, 'Only the parent item should have a painted bullet before the nested separator');
});

test('phone: an extra nested-item space advances the caret', () => {
  const trace = traces['phone-nested'];
  assert.ok(trace[3].caret.left > trace[2].caret.left + 0.5, 'An extra nested-item space did not move the caret');
  assert.ok(Math.abs(trace[3].caret.left - trace[2].caret.left - trace[3].spaceWidth) < 0.75,
    'An extra nested-item space did not advance by a normal space width');
});

test('phone: an extra ordered-item space advances the caret', () => {
  const trace = traces['phone-ordered'];
  assert.ok(trace[4].caret.left > trace[3].caret.left + 0.5,
    `Extra ordered-item space: caret x ${trace[3].caret.left} -> ${trace[4].caret.left}`);
  assert.ok(Math.abs(trace[4].caret.left - trace[3].caret.left - trace[4].spaceWidth) < 0.75,
    'An extra ordered-item space did not advance by a normal space width');
});

// The caret after the first separator must land on the column the item's words
// begin on. Any room held back inside the marker is room a later space has to
// cross before it can show, which is how a typed space becomes invisible.
test('the first separator ends on the column the words begin on', () => {
  const column = snapshot => {
    const line = snapshot.lines[snapshot.lines.length - 1];
    return line.rect.left + parseFloat(line.padding);
  };
  for (const [name, snapshot] of [
    ['phone dash', traces.phone[2]],
    ['desktop dash', traces.desktop[2]],
    ['nested dash', traces['phone-nested'][2]],
    ['ordered marker', traces['phone-ordered'][3]],
  ]) {
    const edge = column(snapshot);
    assert.ok(Math.abs(snapshot.caret.left - edge) < 0.75,
      `${name} (${JSON.stringify(snapshot.raw)}): the caret after the separator is at ` +
      `${snapshot.caret.left} and the words begin at ${edge}`);
  }
});
