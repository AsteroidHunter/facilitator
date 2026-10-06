// Plain node:test, a small DOM and CSS box-contract evaluation. No browser,
// browser imports or pixel measurements. HOME_SOURCE_ROOT can point at old
// source files to prove that these regressions fail before the implementation.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.HOME_SOURCE_ROOT || path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'home-widgets.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'home-widgets.css'), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tokens = n => ({ days: [{ date: '2026-10-05', total: n, claude: n, codex: 0 }], found: { claude: true } });
const limits = n => ({ claude: { five_hour: { used: n, resets: 4102444800 }, weekly: { used: 48, resets: 4102444800 } }, fetched: 1000, now: 1000 });
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attrs = {};
    this.dataset = {}; this.style = {}; this.className = ''; this.hidden = false; this.listeners = {};
    this.clientWidth = 330; this.clientHeight = 190; this._text = ''; this._html = '';
  }
  set textContent(value) { this._text = String(value); this._html = ''; this.children = []; this.parts = {}; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(value) { this._html = String(value); this._text = ''; this.children = []; this.parts = {}; }
  get innerHTML() { return this._html; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  get classList() {
    return { contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) names.add(name); else names.delete(name); this.className = [...names].join(' '); },
      remove: name => { this.className = this.className.split(/\s+/).filter(n => n !== name).join(' '); },
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; } };
  }
  addEventListener(name, fn) { (this.listeners[name] ||= new Set()).add(fn); }
  removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') && selector.slice(1).split('.').every(cls => node.classList.contains(cls));
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) {
    if (selector === '.tk-view') this.ownerDocument.measure?.(this);
    const found = this.querySelectorAll(selector)[0];
    if (found) return found;
    const cls = selector.slice(1);
    if (!selector.startsWith('.') || !this._html.includes(`class="${cls}"`)) return null;
    this.parts ||= {};
    if (!this.parts[cls]) {
      const part = new Element('div', this.ownerDocument); part.className = cls;
      if (cls === 'tk-scroll') { part.scrollWidth = 1200; part.scrollLeft = 0; }
      this.parts[cls] = part;
    }
    return this.parts[cls];
  }
}
function harness(options = {}) {
  const doc = { listeners: {}, measure: options.onMeasure };
  doc.createElement = tag => new Element(tag, doc);
  doc.addEventListener = (name, fn) => (doc.listeners[name] ||= new Set()).add(fn);
  doc.removeEventListener = (name, fn) => doc.listeners[name]?.delete(fn);
  const observers = [];
  const ctx = { document: doc, console, setTimeout, clearTimeout, localStorage: options.store || storage(),
    ResizeObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }, ...options };
  ctx.window = ctx;
  if (options.storageDenied) Object.defineProperty(ctx, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(SOURCE, ctx);
  return { W: ctx.TokenWidgets, root: () => new Element('div', doc), doc, observers };
}
const spin = root => root.querySelector('.tk-refresh');
const note = root => root.querySelector('.tk-updated') || root.querySelector('.lm-updated');
const active = root => root.querySelector('.tk-layer.on');
function declarations(selector) {
  const out = {};
  for (const match of CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(',').map(s => s.trim()).includes(selector)) continue;
    for (const declaration of match[2].split(';')) { const at = declaration.indexOf(':'); if (at >= 0) out[declaration.slice(0, at).trim()] = declaration.slice(at + 1).trim(); }
  }
  return out;
}
// This evaluates only the explicit border-box height contract; it deliberately
// makes no claim to be a browser layout engine. A phone's containing height is
// auto, so the old height:100% and row-dependent limits height fail this check.
function structuralHeight(root, unit = 1, parent = null) {
  const panel = root.classList.contains('tk-panel') ? root : root.querySelector('.tk-panel');
  assert.ok(panel, 'the panel exists before data arrives');
  let rules = declarations('.tk-panel');
  if (panel.classList.contains('lm-box')) rules = { ...rules, ...declarations('.lm-box') };
  assert.equal(rules['box-sizing'], 'border-box');
  let expr = rules.height;
  if (expr?.startsWith('var(--tk-panel-h,')) expr = parent == null ? expr.slice(expr.indexOf(',') + 1, -1).trim() : `${parent}px`;
  expr = expr?.replace(/var\(--u,\s*1px\)/g, `${unit}px`).replace(/calc\((\d+)\s*\*\s*([\d.]+)px\)/g, (_, a, b) => `${a * b}px`);
  assert.match(expr || '', /^\d+(?:\.\d+)?px$/, 'height is definite with an auto-height phone parent');
  return Number(expr.slice(0, -2));
}

test('token cache is drawn synchronously before any network response and is separate from synced preferences', async () => {
  const cached = storage({ 'home.tokens': JSON.stringify({ at: 900000, answer: tokens(42) }) });
  const settings = storage({ 'home.chart': 'line' });
  const visibleAtMeasure = [];
  const { W, root } = harness({ store: cached, onMeasure: layer => visibleAtMeasure.push(layer.classList.contains('on')) });
  const host = root(), request = pending(); let calls = 0;
  const widget = W.panel(host, { store: settings, now: () => 1020000, load: () => { calls++; return request.promise; } });
  assert.equal(calls, 0);
  assert.match(active(host)?.innerHTML || '', /tk-line/);
  assert.equal(active(host).tkModel.model.points[0].total, 42);
  assert.ok(visibleAtMeasure.length && visibleAtMeasure.every(Boolean), 'cached drawing is visible at its first layout, without an initial fade from blank');
  assert.equal(note(host).textContent, 'Last updated: 2 mins ago');
  const work = widget.refresh(); await flush();
  assert.equal(calls, 1); assert.equal(spin(host).hidden, false);
  assert.equal(active(host).tkModel.model.points[0].total, 42);
  request.resolve(tokens(84)); await work;
  assert.equal(spin(host).hidden, true);
  assert.equal(JSON.parse(cached.values.get('home.tokens')).answer.days[0].total, 84);
  assert.equal(settings.values.has('home.tokens'), false);
  const reopened = harness({ store: cached }), next = reopened.root();
  reopened.W.panel(next, { store: settings });
  assert.equal(active(next).tkModel.model.points[0].total, 84, 'new page uses persisted payload');
});

test('limits cache survives reopening and paints before a deferred request', async () => {
  const store = storage({ 'home.limits': JSON.stringify({ at: 900000, answer: limits(23) }) });
  const { W, root } = harness({ store }); const host = root(), request = pending();
  const widget = W.limits(host, { now: () => 1020000, load: () => request.promise });
  assert.equal(host.hidden, false); assert.match(host.textContent, /23%/);
  assert.equal(note(host).textContent, 'Last updated: 2 mins ago');
  const row = host.querySelector('.lm-row'), work = widget.refresh(); await flush();
  assert.equal(spin(host).hidden, false); assert.match(host.textContent, /23%/);
  request.resolve(limits(61)); await work;
  assert.strictEqual(host.querySelector('.lm-row'), row, 'same rows update in place');
  assert.match(host.textContent, /61%/); assert.equal(spin(host).hidden, true);
  const reopened = harness({ store }), next = reopened.root();
  reopened.W.limits(next, { now: () => 1020000 }); assert.match(next.textContent, /61%/);
});

for (const kind of ['panel', 'limits']) {
  test(`${kind}: structural CSS/DOM panel height stays identical through loading, data, refresh and empty states`, async () => {
    const { W, root } = harness(); const host = root();
    let answer = kind === 'panel' ? tokens(10) : limits(23);
    const widget = W[kind](host, { load: async () => answer });
    const cold = [1, 0.9, 1.2].map(unit => structuralHeight(host, unit));
    const board = structuralHeight(host, 1, 240);
    const work = widget.refresh(); assert.deepEqual([1, 0.9, 1.2].map(unit => structuralHeight(host, unit)), cold);
    await work;
    assert.deepEqual([1, 0.9, 1.2].map(unit => structuralHeight(host, unit)), cold);
    assert.equal(structuralHeight(host, 1, 240), board);
    answer = kind === 'panel' ? tokens(0) : { codex: { weekly: { used: 12, resets: 4102444800 } } };
    await widget.refresh(); assert.deepEqual([1, 0.9, 1.2].map(unit => structuralHeight(host, unit)), cold);
    assert.equal(host.hidden, false);
    if (kind === 'panel') assert.match(host.textContent, /No token usage yet/);
  });

  test(`${kind}: a slow or failed refresh retains the last drawing and advancing relative time`, async () => {
    const { W, root } = harness(); const host = root(); let now = 1000000, answer = kind === 'panel' ? tokens(10) : limits(23);
    const widget = W[kind](host, { now: () => now, load: () => Promise.resolve(answer) });
    await widget.refresh(); const drawing = kind === 'panel' ? active(host).innerHTML : host.querySelector('.lm-row');
    assert.equal(note(host).textContent, 'Last updated: now');
    for (const [elapsed, text] of [[59, 'now'], [60, '1 min ago'], [120, '2 mins ago'], [3600, '1 hour ago'], [7200, '2 hours ago']]) {
      now = 1000000 + elapsed * 1000; widget.tick(); assert.equal(note(host).textContent, `Last updated: ${text}`);
    }
    const request = pending(); answer = request.promise;
    const work = widget.refresh(); assert.strictEqual(widget.refresh(), work, 'one in-flight request');
    await flush(); assert.equal(spin(host).hidden, false, 'slow request keeps spinner');
    assert.equal(note(host).textContent, 'Last updated: 2 hours ago');
    request.reject(new Error('offline')); await work;
    assert.equal(spin(host).hidden, true);
    assert.equal(note(host).textContent, 'Last updated: 2 hours ago');
    assert.strictEqual(kind === 'panel' ? active(host).innerHTML : host.querySelector('.lm-row'), drawing);
    answer = kind === 'panel' ? tokens(33) : { ...limits(33), now: 8200, fetched: 8200 };
    await widget.refresh(); assert.equal(note(host).textContent, 'Last updated: now', 'online retry succeeds');
  });

  test(`${kind}: invalid and non-success payloads keep the cache, chart and original timestamp`, async () => {
    const store = storage(); const { W, root } = harness({ store }); const host = root(); let now = 1000000;
    let answer = kind === 'panel' ? tokens(71) : limits(71);
    const widget = W[kind](host, { now: () => now, load: async () => answer });
    await widget.refresh();
    const key = kind === 'panel' ? 'home.tokens' : 'home.limits', before = store.values.get(key);
    const malformed = kind === 'panel' ? { days: [{ date: 'bad', total: 'x' }] } : { claude: { weekly: { used: 'x' } } };
    for (answer of [null, [], { ok: false }, { error: 'unavailable' }, malformed]) {
      now += 120000; await widget.refresh();
      assert.equal(store.values.get(key), before); assert.equal(spin(host).hidden, true);
      assert.notEqual(note(host).textContent, 'Last updated: now');
      if (kind === 'panel') assert.equal(active(host).tkModel.model.total, 71); else assert.match(host.textContent, /71%/);
    }
  });

  test(`${kind}: first-load empty and offline states remain visible and retry without layout changes`, async () => {
    const { W, root } = harness(); const host = root(); let fail = true;
    const widget = W[kind](host, { load: async () => { if (fail) throw new Error('offline'); return kind === 'panel' ? { days: [] } : {}; } });
    const height = structuralHeight(host); assert.ok(host.textContent.length > 0, 'quiet first-load message exists');
    await widget.refresh(); assert.match(host.textContent, /unavailable/); assert.equal(note(host).textContent, '');
    assert.equal(spin(host).hidden, true); assert.equal(host.hidden, false); assert.equal(structuralHeight(host), height);
    fail = false; await widget.refresh(); assert.match(host.textContent, /No (token usage|usage limits)/);
    assert.equal(structuralHeight(host), height); assert.equal(host.hidden, false);
  });

  test(`${kind}: denied storage still keeps the last reading in memory and a blocked storage getter is safe`, async () => {
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
    const { W, root } = harness({ store: blocked }); const host = root();
    const widget = W[kind](host, { now: () => 1000000, load: async () => kind === 'panel' ? tokens(71) : limits(71) });
    await widget.refresh(); const next = root(); W[kind](next, { now: () => 1000000 });
    if (kind === 'panel') assert.equal(active(next).tkModel.model.total, 71); else assert.match(next.textContent, /71%/);
    const denied = harness({ storageDenied: true }); assert.doesNotThrow(() => denied.W[kind](denied.root()));
  });
}

test('switches crossfade two persistent layers without hiding the outgoing chart or accepting its pointer events', async () => {
  const { W, root } = harness(); const host = root(); const widget = W.panel(host, { load: async () => tokens(20) });
  await widget.refresh(); const heat = active(host), height = structuralHeight(host);
  widget.show('line'); const line = active(host);
  assert.notStrictEqual(line, heat); assert.equal(host.querySelectorAll('.tk-layer').length, 2);
  assert.match(heat.innerHTML, /tk-heat/); assert.match(line.innerHTML, /tk-line/);
  assert.equal(heat.hidden, false); assert.equal(heat.inert, true); assert.equal(heat.getAttribute('aria-hidden'), 'true');
  assert.equal(line.inert, false); assert.equal(line.getAttribute('aria-hidden'), 'false');
  assert.match(CSS, /\.tk-layer\{[^}]*transition:opacity\s+\.22s var\(--gentle\)/);
  assert.match(CSS, /\.tk-layer\{[^}]*position:absolute;[^}]*opacity:0; pointer-events:none/s);
  assert.match(CSS, /\.tk-layer\.on\{opacity:1; pointer-events:auto\}/);
  assert.match(CSS, /prefers-reduced-motion: reduce\)\{ \.tk-layer\{transition:none\}/);
  widget.show('heatmap'); assert.strictEqual(active(host), heat); assert.equal(structuralHeight(host), height);
  widget.show('line'); assert.strictEqual(active(host), line); assert.equal(structuralHeight(host), height);
});

test('usage polling retains a spinner between renewal attempts, preserves stale rows on empty response, and cancels cleanly', async () => {
  const { W, root } = harness(); const host = root(); const timers = new Map(); let serial = 0, now = 1000000;
  let answer = limits(32);
  const widget = W.limits(host, { now: () => now, load: async () => answer,
    later: fn => { timers.set(++serial, fn); return serial; }, cancel: id => timers.delete(id) });
  await widget.refresh(); now += 120000;
  answer = { refreshing: true, now: 1120, fetched: null }; await widget.refresh();
  assert.match(host.textContent, /32%/); assert.equal(note(host).textContent, 'Last updated: 2 mins ago');
  assert.equal(spin(host).hidden, false); assert.equal(timers.size, 1);
  const retry = [...timers.values()][0]; timers.clear(); answer = { ...limits(40), now: 1120, fetched: 1120 };
  retry(); await flush(); assert.match(host.textContent, /40%/); assert.equal(spin(host).hidden, true);
  answer = { refreshing: true }; await widget.refresh(); widget.pause();
  assert.equal(timers.size, 0); assert.equal(spin(host).hidden, true);
  answer = {}; now += 120000; await widget.refresh(); assert.match(host.textContent, /40%/); assert.equal(note(host).textContent, 'Last updated: 2 mins ago');
  const delayed = pending(); answer = delayed.promise; const work = widget.refresh(); widget.destroy(); delayed.resolve(limits(90)); await work;
  assert.match(host.textContent, /40%/); assert.equal(timers.size, 0); assert.equal(spin(host).hidden, true);
});

test('token teardown disconnects resize and document listeners and ignores a late answer', async () => {
  const { W, root, doc, observers } = harness(); const host = root(); let answer = tokens(20);
  const widget = W.panel(host, { load: async () => answer }); await widget.refresh(); widget.show('line');
  assert.equal(doc.listeners.pointerdown.size, 2);
  const delayed = pending(); answer = delayed.promise; const work = widget.refresh(); widget.destroy();
  assert.equal(doc.listeners.pointerdown.size, 0); assert.equal(observers[0].disconnected, true);
  delayed.resolve(tokens(99)); await work; assert.equal(active(host).tkModel.model.points[0].total, 20);
  assert.equal(spin(host).hidden, true);
});

test('panel feedback reuses the small card spinner and warm focus color, without purple', () => {
  assert.match(SOURCE, /cardspin tk-refresh/);
  assert.match(CSS, /\.tk-refresh\[hidden\]\{display:inline-flex; visibility:hidden\}/);
  assert.match(CSS, /\.tk-opt:focus-visible\{outline:1\.5px solid #E0592B/);
  assert.doesNotMatch(CSS, /--accent|#432BFF/i);
});
