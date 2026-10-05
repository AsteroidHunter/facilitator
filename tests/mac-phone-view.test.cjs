// The actual retained-frame controller, exercised without a browser. These
// checks establish routing and state ownership, not rendered pixels.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.MAC_PHONE_SOURCE_ROOT || path.join(__dirname, '..');
function api() {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'mac-phone-view.js'), 'utf8'), scope);
  return scope.MacPhoneView;
}
function node(tag) {
  const handlers = {}, attrs = {}, classes = new Set();
  const el = { tagName: tag.toUpperCase(), hidden: false, inert: false, dataset: {}, children: [],
    append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); return item; },
    setAttribute(k, v) { attrs[k] = String(v); },
    hasAttribute(k) { return k === 'data-phone-inert' ? 'phoneInert' in this.dataset : k in attrs; },
    addEventListener(k, fn) { (handlers[k] ||= []).push(fn); },
    fire(k, value = {}) { for (const fn of handlers[k] || []) fn(value); },
    classList: { toggle(k, on) { if (on) classes.add(k); else classes.delete(k); }, contains: k => classes.has(k) },
  };
  return el;
}
function adapter(state) {
  return { state: structuredClone(state), held: false, available: true, captures: 0, restores: 0,
    capture() { this.captures++; return structuredClone(this.state); },
    restore(value) { this.restores++; this.state = structuredClone(value); },
    ready() { return this.available; }, busy() { return this.held; },
    focus(value) { this.focused = structuredClone(value); },
  };
}
function fixture(state = { owner: 'one', id: 'a', drafts: { a: { value: 'unsent', start: 2, end: 4 } } }) {
  const body = node('body'), doc = node('document');
  const tasks = [];
  const source = { location: { origin: 'http://127.0.0.1:12345' }, focus() { this.focusCount = (this.focusCount || 0) + 1; } };
  const win = { document: doc, location: { origin: source.location.origin }, focus() {},
    setTimeout(fn) { const token = {}; tasks.push({ token, fn }); return token; },
    clearTimeout(token) { const i = tasks.findIndex(t => t.token === token); if (i >= 0) tasks.splice(i, 1); },
  };
  doc.body = body;
  doc.createElement = tag => { const el = node(tag); if (tag === 'iframe') el.contentWindow = source; return el; };
  const stage = node('main'), alreadyInert = node('aside'); alreadyInert.inert = true;
  body.append(stage, alreadyInert);
  const desktop = adapter(state), phone = adapter({ owner: 'old', id: 'old', drafts: {} });
  let changes = 0;
  const host = api().createHost({ window: win, adapter: desktop, changed() { changes++; } });
  return { host, desktop, phone, source, win, doc, body, stage, alreadyInert,
    frame: () => body.children.find(e => e.tagName === 'IFRAME'),
    status: () => body.children.find(e => e.id === 'phoneviewstatus'),
    back: () => body.children.find(e => e.id === 'phoneviewreturn'),
    changes: () => changes,
    connect() { return host.connect(source, phone); },
    advance() { const pending = tasks.splice(0); for (const t of pending) t.fn(); },
  };
}

test('portrait entry and exit keep both existing hysteresis thresholds', () => {
  const { portrait } = api();
  assert.equal(portrait(1000, 1260, 1000, false), false);
  assert.equal(portrait(1000, 1261, 1000, false), true);
  assert.equal(portrait(1000, 1141, 1000, true), true);
  assert.equal(portrait(1000, 1140, 1000, true), false);
  assert.equal(portrait(539, 300, 1000, false), true);
  assert.equal(portrait(540, 300, 1000, false), false);
  assert.equal(portrait(459, 300, 1000, true), true);
  assert.equal(portrait(460, 300, 1000, true), false);
  assert.equal(portrait(1440, 900, 1000, false), false);
});

test('landscape never mounts a phone or rewrites desktop state', () => {
  const f = fixture(), before = structuredClone(f.desktop.state);
  f.host.request(false); f.host.refresh(); f.advance();
  assert.equal(f.frame(), undefined);
  assert.deepEqual(f.desktop.state, before);
  assert.equal(f.desktop.restores, 0);
  assert.equal(f.stage.inert, false);
  assert.equal(f.alreadyInert.inert, true);
  assert.equal(f.changes(), 0);
});

test('portrait loads the real phone page once and retains both documents across resizes', () => {
  const f = fixture();
  f.host.request(true);
  const frame = f.frame();
  assert.equal(frame.src, '/m?mac=1');
  assert.equal(frame.hidden, true, 'old view remains usable while loading');
  assert.equal(f.host.active(), false);
  assert.equal(f.connect(), true);
  assert.equal(f.host.active(), true);
  assert.equal(frame.hidden, false);
  assert.equal(f.stage.inert, true);
  assert.equal(f.win.macPhoneInactive, true);
  assert.equal(f.source.macPhoneInactive, false);
  f.host.request(false);
  assert.equal(f.host.active(), false);
  assert.equal(f.stage.inert, false);
  assert.equal(f.alreadyInert.inert, true, 'preexisting inert state survives');
  assert.equal(f.win.macPhoneInactive, false);
  assert.equal(f.source.macPhoneInactive, true);
  f.host.request(true);
  assert.equal(f.frame(), frame);
  assert.equal(f.body.children.filter(e => e.tagName === 'IFRAME').length, 1);
});

test('both directions retain project, selected card, all drafts, carets and Home', () => {
  const state = { owner: 'one', id: 'a', home: false, browsing: true, view: 'deferred',
    drafts: { a: { value: '**half written**\n- more', start: 3, end: 8, dir: 'backward' },
      b: { value: 'another project draft', start: 0, end: 0 } } };
  const f = fixture(state);
  f.host.request(true); f.connect();
  assert.deepEqual(f.phone.state, state);
  assert.deepEqual(f.phone.focused, state);
  f.phone.state.owner = 'two'; f.phone.state.id = 'b'; f.phone.state.home = true;
  f.phone.state.drafts.a.value += '\nphone edits';
  const back = structuredClone(f.phone.state);
  f.host.request(false);
  assert.deepEqual(f.desktop.state, back);
  assert.deepEqual(f.desktop.focused, back);
  f.host.request(true);
  assert.deepEqual(f.phone.state, back, 'a later switch cannot resurrect stale drafts');
});

test('resize during load transfers the latest input only when the destination is ready', () => {
  const f = fixture();
  f.host.request(true); f.desktop.state.drafts.a.value = 'typed while loading';
  f.phone.available = false; f.connect();
  assert.equal(f.host.active(), false);
  assert.equal(f.phone.restores, 0);
  f.desktop.state.drafts.a.value += ' and waiting';
  f.phone.available = true; f.advance();
  assert.equal(f.host.active(), true);
  assert.equal(f.phone.state.drafts.a.value, 'typed while loading and waiting');
});

test('resize back before frame readiness cancels the pending switch', () => {
  const f = fixture();
  f.host.request(true); f.host.request(false); f.connect(); f.advance();
  assert.equal(f.host.active(), false);
  assert.equal(f.phone.restores, 0);
  assert.equal(f.desktop.restores, 0);
});

test('an upload or send retains its owner until settled and can cancel the resize', () => {
  const f = fixture(); f.desktop.held = true;
  f.host.request(true); f.connect(); f.advance();
  assert.equal(f.host.active(), false);
  assert.match(f.status().textContent, /attachments or sends/);
  f.desktop.state.drafts.a.value = '/uploads/abc/file.png\n\nretained draft';
  f.desktop.held = false; f.advance();
  assert.equal(f.phone.state.drafts.a.value, f.desktop.state.drafts.a.value);
  assert.equal(f.host.active(), true);
  f.phone.held = true; f.host.request(false);
  assert.equal(f.host.active(), true);
  f.host.request(true); f.phone.held = false; f.advance();
  assert.equal(f.host.active(), true, 'superseded wide request must stay canceled');
});

test('composition is never split by a handoff', () => {
  const f = fixture(); f.doc.fire('compositionstart');
  f.host.request(true); f.connect();
  assert.equal(f.host.active(), false);
  f.desktop.state.drafts.a.value = '日本語';
  f.doc.fire('compositionend'); f.advance();
  assert.equal(f.host.active(), true);
  assert.equal(f.phone.state.drafts.a.value, '日本語');
});

test('preparing uploaded attachment text occurs before the transferred snapshot', () => {
  const f = fixture();
  f.desktop.prepare = () => { f.desktop.state.drafts.a.value = '/uploads/a/photo.png\n\ncaption'; };
  f.host.request(true); f.connect();
  assert.equal(f.phone.state.drafts.a.value, '/uploads/a/photo.png\n\ncaption');
});

test('Mac tools remain reachable and return to the same phone document', () => {
  const f = fixture(); f.host.request(true); f.connect();
  f.phone.state.drafts.a.value = 'before files';
  f.host.openMac();
  assert.equal(f.host.active(), false);
  assert.equal(f.back().hidden, false);
  assert.equal(f.desktop.state.drafts.a.value, 'before files');
  f.desktop.state.drafts.a.value = 'after files';
  f.back().fire('click');
  assert.equal(f.host.active(), true);
  assert.equal(f.phone.state.drafts.a.value, 'after files');
  assert.equal(f.back().hidden, true);
});

test('only the owned same-origin frame may connect an adapter', () => {
  const f = fixture(); f.host.request(true);
  assert.equal(f.host.connect({ location: { origin: f.win.location.origin } }, f.phone), false);
  f.source.location.origin = 'https://other.example';
  assert.equal(f.connect(), false);
  assert.equal(f.host.active(), false);
});

test('frame load failure keeps the Mac and its drafts accessible', () => {
  const f = fixture(); f.host.request(true); f.frame().fire('load');
  assert.equal(f.host.active(), false);
  assert.equal(f.stage.inert, false);
  assert.equal(f.desktop.state.drafts.a.value, 'unsent');
  assert.match(f.status().textContent, /Restart.*server/);
});

test('a phone document closing recovers its current drafts into the Mac', () => {
  const f = fixture(); f.host.request(true); f.connect();
  f.phone.state.drafts.a.value = 'last unsent phone words';
  f.host.lost(f.source);
  assert.equal(f.host.active(), false);
  assert.equal(f.desktop.state.drafts.a.value, 'last unsent phone words');
  assert.equal(f.stage.inert, false);
});

test('draft helpers preserve empty drafts, shelved cards, source text and caret direction', () => {
  const a = api();
  const els = { one: { ta: { value: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'none' } },
    two: { ta: { value: '**source**', selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward' },
      field: { focused: () => true }, replyview: { scrollTop: 41 } } };
  const drafts = a.readDrafts(els, { unmounted: { value: 'kept', start: 1, end: 1 }, one: { value: 'stale' } });
  assert.equal(drafts.one.value, '');
  assert.equal(drafts.unmounted.value, 'kept');
  assert.equal(drafts.two.focus, true);
  const out = { ta: { setSelectionRange(...args) { this.selection = args; } }, replyview: {}, tick() { this.ticked = true; } };
  a.writeDraft(out, drafts.two);
  assert.equal(out.ta.value, '**source**');
  assert.deepEqual(out.ta.selection, [2, 5, 'backward']);
  assert.equal(out.replyview.scrollTop, 41);
  assert.equal(out.ticked, true);
});

test('the imitation portrait renderer is gone and both pages load the single handoff module', () => {
  const desktop = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const phone = fs.readFileSync(path.join(ROOT, 'm.html'), 'utf8');
  assert.ok(!/respdrawerbtn|respscrim|resp-drawer-open|respDrawerBtn|setRespDrawer|data-resp-mode="portrait"/.test(desktop), "old portrait renderer remains");
  assert.ok(desktop.includes('src="/mac-phone-view.js"'));
  assert.ok(phone.includes("parent.MacPhoneView"));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'mac-phone-view.js'), 'utf8'), /--accent|#432bff|id="dock"|id="tikbtn"/i);
});

test('a destination render failure keeps the source usable and retries its latest draft', () => {
  const f = fixture(), restore = f.phone.restore;
  f.phone.restore = () => { throw Error('draw failed'); };
  f.host.request(true); f.connect();
  assert.equal(f.host.active(), false);
  assert.equal(f.stage.inert, false);
  f.desktop.state.drafts.a.value = 'still typing';
  f.phone.restore = restore; f.advance();
  assert.equal(f.host.active(), true);
  assert.equal(f.phone.state.drafts.a.value, 'still typing');
});

test('an owned frame navigating cross-origin is refused without throwing', () => {
  const f = fixture(); f.host.request(true);
  Object.defineProperty(f.source, 'location', { get() { throw Error('blocked origin'); } });
  assert.equal(f.connect(), false);
  assert.equal(f.host.active(), false);
});
