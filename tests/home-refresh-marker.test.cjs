// Node-only regression: execute each page's Home setup with the real widgets,
// then evaluate their small footer flex contract. This is not pixel layout or
// a browser renderer. HOME_SOURCE_ROOT also allows checks against old source.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.HOME_SOURCE_ROOT || path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const CSS = read('home-widgets.css'), SOURCE = read('home-widgets.js');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const tokenAnswer = { days: [] };
const limitAnswer = count => {
  const answer = {};
  for (const [tool, key] of [['claude', 'five_hour'], ['claude', 'weekly'], ['codex', 'weekly'], ['codex', 'five_hour']].slice(0, count))
    (answer[tool] ||= {})[key] = { used: 12, resets: 4102444800 };
  return answer;
};

class Element {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag, ownerDocument: doc, children: [], attrs: {}, dataset: {}, style: {},
      className: '', hidden: false, clientWidth: 330, clientHeight: 190, _text: '' });
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  addEventListener() {}
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name), toggle: (name, on) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    } };
  }
  querySelectorAll(selector) {
    const matches = node => selector.slice(1).split('.').every(name => node.classList.contains(name));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function page(name, cached = true, count = 3) {
  const html = read(name), phone = name === 'm.html';
  let now = 1000000;
  const saved = new Map(cached ? [
    ['home.tokens', JSON.stringify({ at: now, answer: tokenAnswer })],
    ['home.limits', JSON.stringify({ at: now, answer: limitAnswer(count) })],
  ] : []);
  const doc = { hidden: false, addEventListener() {}, createElement: tag => new Element(tag, doc) };
  const nodes = Object.fromEntries(['homeico', 'homeplot', 'homelimits', 'stage'].map(id => [id, doc.createElement('div')]));
  doc.getElementById = id => nodes[id]; doc.body = doc.createElement('body');
  const requests = [];
  const ctx = { document: doc, console, settingsStore: {}, homeOpen: false, addEventListener() {},
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, reject,
      resolve: answer => resolve({ ok: true, json: async () => answer }) })),
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() { throw new Error('Unexpected follow-up request'); }, clearTimeout() {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const start = html.indexOf('const HOME_KEY = "homeopen";');
  const end = html.indexOf(phone ? '// the heading\'s mark and version' : 'function setHome(on){', start);
  assert.ok(start > 0 && end > start, 'execute the actual Home setup from this page');
  vm.runInContext(html.slice(start, end), ctx);
  const run = source => vm.runInContext(source, ctx);
  assert.equal(run('homeMake()'), true);
  return { html, nodes, requests, run, advance: seconds => { now += seconds * 1000; run('homeTick()'); } };
}

function declarations(selector, css = CSS) {
  const result = {};
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(',').map(s => s.trim()).includes(selector)) continue;
    for (const entry of rule[2].split(';')) {
      const colon = entry.indexOf(':');
      if (colon >= 0) result[entry.slice(0, colon).trim()] = entry.slice(colon + 1).trim();
    }
  }
  return result;
}
function length(value, unit) {
  if (!value || value === '0') return 0;
  const pixels = value.match(/^([\d.]+)px$/);
  if (pixels) return Number(pixels[1]);
  const scaled = value.match(/^calc\(([\d.]+) \* var\(--u, 1px\)\)$/);
  assert.ok(scaled, `known length contract: ${value}`);
  return Number(scaled[1]) * unit;
}
function noHorizontalInset(style) {
  for (const prop of ['margin-left', 'margin-right', 'margin-inline-start', 'padding-left', 'padding-right',
    'padding-inline-start', 'border-left-width', 'left', 'inset-inline-start', 'text-indent'])
    assert.equal(length(style[prop], 1), 0, `${prop} must not indent the timestamp`);
  for (const prop of ['margin', 'padding', 'margin-inline', 'padding-inline', 'transform', 'translate', 'order'])
    assert.ok(!style[prop] || style[prop] === '0' || style[prop] === 'none', `no ${prop} moves the timestamp`);
}

// Evaluate only the declared left-to-right flex row. Text width is an arbitrary
// supplied width: the timestamp's start must be unchanged for every width.
function footerFlow(host, unit, textWidth = 170 * unit) {
  const footer = host.querySelector('.tk-status'), spinner = host.querySelector('.tk-refresh');
  const note = host.querySelector('.tk-updated') || host.querySelector('.lm-updated');
  const row = declarations('.tk-status'), mark = declarations('.tk-refresh');
  assert.equal(row.display, 'flex');
  assert.ok(!row['flex-direction'] || row['flex-direction'] === 'row');
  assert.ok(!row['justify-content'] || ['start', 'flex-start', 'normal'].includes(row['justify-content']));
  noHorizontalInset(row); noHorizontalInset(declarations('.' + note.className));
  assert.equal(footer.parentElement.classList.contains('tk-panel'), true);
  const panel = declarations('.tk-panel');
  assert.equal(panel.display, 'flex'); assert.equal(panel['flex-direction'], 'column');
  const reference = host.querySelector('.lm-title') || host.querySelector('.tk-head');
  assert.strictEqual(reference.parentElement, footer.parentElement, 'title and footer share the panel text edge');
  noHorizontalInset(declarations('.' + reference.className));
  const gap = length(row.gap, unit);
  const hiddenDisplay = declarations('.tk-refresh[hidden]').display;
  const markerVisible = !spinner.hidden || (hiddenDisplay && hiddenDisplay !== 'none');
  const noteVisible = note.textContent !== '' || declarations('.' + note.className + ':empty').display !== 'none';
  const flow = footer.children.filter(child => child === spinner ? markerVisible : noteVisible);
  let width = 0;
  const left = new Map();
  for (const child of flow) {
    if (left.size) width += gap;
    left.set(child, width);
    if (child === spinner) {
      assert.match(mark.width, /^var\(--cardspin-s, 11px\)$/);
      width += 11 * unit;
    } else width += note.textContent ? textWidth : 0;
  }
  return { footer, spinner, note, flow, left, width, gap, textWidth };
}

for (const name of ['index.html', 'm.html']) {
  test(`${name}: a loaded timestamp stays at the panel text edge while its refresh marker is running`, async () => {
    const p = page(name);
    const work = p.run('Promise.all([homePanel.refresh(), homeLimits.refresh()])');
    try {
      await flush();
      for (const host of [p.nodes.homeplot, p.nodes.homelimits]) for (const unit of [0.72, 1, 1.3]) {
        const f = footerFlow(host, unit);
        assert.equal(f.spinner.hidden, false);
        assert.equal(f.note.textContent, 'Last updated: now');
        assert.equal(f.left.get(f.note), 0, 'running marker must not indent the timestamp');
      }
    } finally {
      for (const request of p.requests.splice(0)) request.resolve(request.url.startsWith('/tokens') ? tokenAnswer : limitAnswer(3));
      await work;
    }
  });

  test(`${name}: an idle refresh marker has no flow box or reserved gap`, () => {
    const p = page(name);
    for (const host of [p.nodes.homeplot, p.nodes.homelimits]) for (const unit of [0.72, 1, 1.3]) {
      const f = footerFlow(host, unit);
      assert.equal(f.spinner.hidden, true);
      assert.equal(f.flow.includes(f.spinner), false, 'hidden marker must not retain a flow box');
      assert.equal(f.flow.length, 1, 'timestamp is the only footer item when idle');
      assert.equal(f.width, f.textWidth, 'no marker width or gap is reserved');
    }
  });

  test(`${name}: real Home footers keep timestamps at the text edge during idle, refresh, completion and failure`, async () => {
    const p = page(name);
    assert.match(p.html, /<link id="homesheet" rel="stylesheet" href="\/home-widgets\.css">/);
    assert.match(p.html, /<script src="\/home-widgets\.js"><\/script>/);
    const inlineCSS = [...p.html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
    assert.doesNotMatch(inlineCSS, /\.(?:tk-status|tk-refresh|tk-updated|lm-updated|lm-rows)\b/, 'page CSS does not override the shared footer contract');
    const check = busy => {
      for (const host of [p.nodes.homeplot, p.nodes.homelimits]) for (const unit of [0.72, 1, 1.3]) {
        const f = footerFlow(host, unit);
        assert.match(f.note.textContent, /^Last updated: (now|123 days ago)$/);
        assert.equal(f.left.get(f.note), 0, 'timestamp starts at the same content edge as the panel title');
        assert.equal(f.spinner.hidden, !busy);
        assert.equal(f.footer.parentElement.getAttribute('aria-busy'), String(busy));
        if (busy) {
          assert.equal(f.left.get(f.spinner), f.textWidth + f.gap, 'marker follows the timestamp on its line');
          assert.equal(f.spinner.getAttribute('data-f'), '|');
          assert.ok(f.spinner.classList.contains('cardspin'));
        } else {
          assert.deepEqual(f.flow, [f.note], 'idle marker has no flow box or intervening gap');
          assert.equal(f.width, f.textWidth, 'footer reserves only the timestamp width when idle');
        }
      }
    };
    check(false);
    p.advance(123 * 86400); check(false);
    const first = p.run('Promise.all([homePanel.refresh(), homeLimits.refresh()])');
    try { await flush(); check(true); }
    finally {
      for (const request of p.requests.splice(0)) request.resolve(request.url.startsWith('/tokens') ? tokenAnswer : limitAnswer(3));
      await first;
    }
    check(false);
    p.advance(123 * 86400);
    const failed = p.run('Promise.all([homePanel.refresh(), homeLimits.refresh()])');
    try { await flush(); check(true); }
    finally {
      for (const request of p.requests.splice(0)) request.reject(new Error('offline'));
      await failed;
    }
    check(false);
  });

  test(`${name}: a cold refresh marker starts at the text edge without an empty timestamp gap`, async () => {
    const p = page(name, false);
    const work = p.run('Promise.all([homePanel.refresh(), homeLimits.refresh()])');
    try {
      await flush();
      for (const host of [p.nodes.homeplot, p.nodes.homelimits]) for (const unit of [0.72, 1, 1.3]) {
        const f = footerFlow(host, unit);
        assert.equal(f.note.textContent, ''); assert.equal(f.spinner.hidden, false);
        assert.deepEqual(f.flow, [f.spinner]);
        assert.equal(f.left.get(f.spinner), 0, 'cold marker has no leading gap');
        assert.equal(f.width, 11 * unit);
      }
    } finally {
      for (const request of p.requests.splice(0)) request.reject(new Error('offline'));
      await work;
    }
    for (const host of [p.nodes.homeplot, p.nodes.homelimits]) assert.equal(footerFlow(host, 1).width, 0);
  });

  test(`${name}: usage rows end next to the footer without changing reserved panel or row sizes`, () => {
    const rows = declarations('.lm-rows');
    assert.equal(declarations('.lm-box').height, 'calc(184 * var(--u, 1px))');
    assert.equal(rows.flex, '1 1 auto'); assert.equal(rows['grid-auto-rows'], '16px');
    assert.equal(rows['align-content'], 'end', 'spare provider space belongs above the rows, not above the footer');
    for (const count of [0, 1, 3, 4]) {
      const host = page(name, count > 0, count).nodes.homelimits;
      assert.equal(host.querySelectorAll('.lm-row').length, count);
      if (!count) assert.ok(host.querySelector('.tk-wait'), 'cold loading keeps the reserved grid stage');
      for (const unit of [0.72, 1, 1.3]) {
        assert.equal(length(rows['row-gap'], unit), 7 * unit);
        assert.equal(length(declarations('.tk-status')['margin-top'], unit), 8 * unit);
      }
    }
  });
}

test('the refresh marker retains the ticket glyph, size and stepped rotation', () => {
  const shared = read('card-tokens.css');
  assert.equal(declarations('.cardspin::before', shared).content, 'attr(data-f)');
  assert.equal(declarations('.cardspin::before', shared).font, '600 var(--cardspin-s)/var(--cardspin-s) var(--mono)');
  assert.match(read('card-logic.js'), /const SPIN_FRAMES = \["\|","\/","-","\\\\"\]/);
  assert.match(CSS, /\.tk-refresh.on::before\{animation:tk-refresh-turn \.8s steps\(4\) infinite\}/);
  assert.match(CSS, /@keyframes tk-refresh-turn\{to\{transform:rotate\(180deg\)\}\}/);
  assert.match(CSS, /prefers-reduced-motion: reduce\)\{ \.tk-refresh.on::before\{animation:none\}/);
});
