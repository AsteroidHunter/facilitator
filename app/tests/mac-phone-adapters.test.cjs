// Run the adapters shipped in each page, with just their surrounding UI mocked.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.MAC_PHONE_SOURCE_ROOT || path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function composer(value = '') {
  return { ta: { value, selectionStart: 1, selectionEnd: 2, selectionDirection: 'backward',
    focus() { this.focused = true; },
    setSelectionRange(start, end, dir) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: dir }); } },
    replyview: { scrollTop: 35 }, field: { focused: () => true }, trayItems: [], tick() {} };
}
function adapter(phone) {
  const source = read(phone ? 'm.html' : 'index.html');
  const start = source.lastIndexOf('  const adapter = {');
  assert.ok(start >= 0, 'the page must ship its handoff adapter');
  const end = source.indexOf('\n  };', start);
  const els = { a: composer('desktop words'), b: composer('second card') };
  const shelf = {}, stored = new Map(), handlers = {};
  const ctx = vm.createContext({ els, shelf, parent: { macPhoneProject: null, chimeMuted: () => false },
    activeOwner: 'alpha', selectedId: 'a', browsing: true, homeOpen: false, lastSel: { alpha: 'a' },
    lastState: { rev: 10, boxes: [{ id: 'a', owner: 'alpha' }, { id: 'b', owner: 'beta' }, { id: 'c', owner: 'beta' }] },
    ownerReady: true, validActiveOwnerIds: new Set(['alpha', 'beta']), validOwners: new Set(['alpha', 'beta']),
    LOCKED: null, draft: null, composing: false, pendingFocus: null, autoNext: null, ops: [],
    document: { querySelector: () => null, getElementById: () => ({}) },
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    curView: () => ctx.section || 'todo',
    setTicketViewOf(owner, section) { ctx.section = section; },
    setTab(owner) { ctx.activeOwner = owner; },
    setHome(on) { ctx.homeOpen = on; }, setBrowsing(on) { ctx.browsing = on; },
    deselect() { ctx.selectedId = null; },
    select(id) {
      ctx.selectedId = id;
      if (!els[id]) {
        els[id] = composer(shelf[id]?.value || '');
        if (shelf[id]) { ctx.MacPhoneView.writeDraft(els[id], shelf[id]); delete shelf[id]; }
      }
    },
    apply() { ctx.applied = true; }, renderCarousel() { ctx.ticketsPainted = true; },
    trayTake(el) { el.trayItems = el.trayItems.filter(it => it.state !== 'done'); },
  });
  vm.runInContext(read('mac-phone-view.js'), ctx);
  ctx.view = ctx.MacPhoneView;
  // the rail's rules are shared by both pages, so both are run on the real ones
  const logic = read('card-logic.js');
  for (const name of ['trayMoving', 'trayBusy']) {
    const from = logic.indexOf(`function ${name}(`);
    assert.ok(from >= 0, `card-logic.js must ship ${name}`);
    vm.runInContext(logic.slice(from, logic.indexOf('\n', from)), ctx);
  }
  if (phone) {
    const from = logic.indexOf('function trayMessage(el, typed){');
    vm.runInContext(logic.slice(from, logic.indexOf('\n}', from) + 2), ctx);
  }
  vm.runInContext(source.slice(start, end + '\n  };'.length) + '\nthis.adapter = adapter;', ctx);
  return { ctx, els, shelf, stored, adapter: ctx.adapter };
}

test('the real page adapters hand project, card, drafts and caret back and forth', () => {
  const mac = adapter(false), phone = adapter(true);
  phone.adapter.restore(mac.adapter.capture());
  assert.equal(phone.ctx.activeOwner, 'alpha');
  assert.equal(phone.ctx.selectedId, 'a');
  assert.equal(phone.els.a.ta.value, 'desktop words');
  phone.ctx.activeOwner = 'beta'; phone.ctx.selectedId = 'b'; phone.ctx.section = 'deferred';
  phone.els.a.ta.value = ''; phone.els.b.ta.value = 'phone edits';
  phone.els.b.ta.setSelectionRange(2, 4, 'backward');
  mac.adapter.restore(phone.adapter.capture());
  mac.adapter.focus(phone.adapter.capture());
  assert.equal(mac.ctx.activeOwner, 'beta');
  assert.equal(mac.ctx.selectedId, 'b');
  assert.equal(mac.ctx.section, 'deferred');
  assert.equal(mac.els.a.ta.value, '', 'a cleared draft must erase the stale destination');
  assert.equal(mac.els.b.ta.value, 'phone edits');
  assert.equal(mac.els.b.ta.selectionStart, 2);
  assert.equal(mac.els.b.ta.selectionEnd, 4);
  assert.equal(mac.els.b.ta.selectionDirection, 'backward');
  assert.equal(mac.els.b.ta.focused, true);
});

test('an unmounted phone card receives the draft and can transfer its shelf back', () => {
  const mac = adapter(false), phone = adapter(true);
  delete phone.els.b;
  mac.els.b.ta.value = 'unmounted project words';
  phone.adapter.restore(mac.adapter.capture());
  assert.equal(phone.shelf.b.value, 'unmounted project words');
  assert.equal(phone.shelf.b.top, 35);
  assert.equal(phone.adapter.capture().drafts.b.value, 'unmounted project words');
  mac.els.b.ta.value = 'stale';
  mac.adapter.restore(phone.adapter.capture());
  assert.equal(mac.els.b.ta.value, 'unmounted project words');
  assert.equal(mac.els.b.replyview.scrollTop, 35);
});

test('a newly selected phone card is built from its incoming shelved draft', () => {
  const mac = adapter(false), phone = adapter(true);
  delete phone.els.b;
  mac.ctx.activeOwner = 'beta'; mac.ctx.selectedId = 'b';
  phone.adapter.restore(mac.adapter.capture());
  assert.equal(phone.ctx.selectedId, 'b');
  assert.equal(phone.els.b.ta.value, 'second card');
  assert.equal(phone.shelf.b, undefined);
});

for (const isPhone of [false, true]) {
  const name = isPhone ? 'phone' : 'desktop';
  test(`${name} handoff waits for a current board reading`, () => {
    const f = adapter(isPhone);
    assert.equal(f.adapter.ready({ rev: 11 }), false);
    assert.equal(f.adapter.ready({ rev: 10 }), true);
    f.ctx.lastState = null;
    assert.equal(f.adapter.ready({ rev: 10 }), false);
  });
  test(`${name} rejects deleted projects and missing cards without losing other drafts`, () => {
    const f = adapter(isPhone), state = f.adapter.capture();
    state.owner = 'deleted'; state.id = 'deleted'; state.drafts.a.value = 'kept';
    f.adapter.restore(state);
    assert.equal(f.ctx.activeOwner, 'alpha');
    assert.equal(f.ctx.selectedId, null);
    assert.equal(f.els.a.ta.value, 'kept');
  });
  test(`${name} keeps project-locked windows on their own project`, () => {
    const f = adapter(isPhone), state = f.adapter.capture();
    if (isPhone) f.ctx.parent.macPhoneProject = 'alpha'; else f.ctx.LOCKED = 'alpha';
    state.owner = 'beta'; state.id = 'b';
    f.adapter.restore(state);
    assert.equal(f.ctx.activeOwner, 'alpha');
    assert.equal(f.ctx.selectedId, null);
  });
  test(`${name} Home transfer retains drafts without focusing a hidden composer`, () => {
    const f = adapter(isPhone), state = f.adapter.capture();
    state.home = true; f.adapter.restore(state); f.adapter.focus(state);
    assert.equal(f.ctx.homeOpen, true);
    assert.equal(f.els.a.ta.focused, undefined);
    assert.equal(f.els.a.ta.value, 'desktop words');
  });
}

test('desktop uploads and unconfirmed sends defer handoff until settled', () => {
  const f = adapter(false);
  assert.equal(f.adapter.busy(), false);
  for (const [key, value] of [['attachmentPending', 1]]) {
    f.els.a.ta[key] = value; assert.equal(f.adapter.busy(), true); delete f.els.a.ta[key];
  }
  for (const [key, value] of [['sendsOut', 1], ['sentHeld', [{}]]]) {
    f.els.a[key] = value; assert.equal(f.adapter.busy(), true); delete f.els.a[key];
  }
  assert.equal(f.adapter.busy(), false);
});

test('desktop rail uploads and held sends defer handoff; a settled square does not', () => {
  const f = adapter(false);
  for (const state of ['up', 'queued', 'wait']) {
    f.els.a.trayItems = [{ state }]; assert.equal(f.adapter.busy(), true, state);
  }
  for (const state of ['done', 'failed', 'refused']) {
    f.els.a.trayItems = [{ state }]; assert.equal(!!f.adapter.busy(), false, state);
  }
  f.els.a.trayItems = [];
  f.els.a.trayHold = {}; assert.equal(f.adapter.busy(), true);
  f.els.a.trayHold = null; assert.equal(!!f.adapter.busy(), false);
});

test('phone uploads, failed files, held sends and composition retain their live controls', () => {
  const f = adapter(true);
  assert.equal(f.adapter.busy(), false);
  for (const state of ['waiting', 'uploading', 'failed', 'refused']) {
    f.els.a.trayItems = [{ state }]; assert.equal(f.adapter.busy(), true, state);
  }
  f.els.a.trayItems = [{ state: 'done', url: '/uploads/a/test.png', kind: 'image' }];
  assert.equal(f.adapter.busy(), false);
  f.ctx.composing = true; assert.equal(f.adapter.busy(), true); f.ctx.composing = false;
  f.ctx.ops.push({}); assert.equal(f.adapter.busy(), true); f.ctx.ops.length = 0;
  f.els.a.trayHold = {}; assert.equal(f.adapter.busy(), true);
});

test('completed phone attachments become the same upload references with caret preserved', () => {
  const f = adapter(true);
  f.els.a.ta.value = 'caption'; f.els.a.ta.setSelectionRange(1, 3, 'backward');
  f.els.a.trayItems = [
    { state: 'done', kind: 'image', url: '/uploads/a/one.png' },
    { state: 'done', kind: 'image', url: '/uploads/b/two.png' },
    { state: 'done', kind: 'file', url: '/uploads/c/notes.pdf' },
  ];
  f.adapter.prepare();
  const prefix = '/uploads/a/one.png /uploads/b/two.png\n\n/uploads/c/notes.pdf\n\n';
  assert.equal(f.els.a.ta.value, prefix + 'caption');
  assert.equal(f.els.a.ta.selectionStart, prefix.length + 1);
  assert.equal(f.els.a.ta.selectionEnd, prefix.length + 3);
  assert.equal(f.els.a.ta.selectionDirection, 'backward');
  assert.deepEqual(f.els.a.trayItems, []);
});

function embeddedGate({ parentWindow = false, query = '?mac=1', origin = 'http://127.0.0.1:1234', accepts = true, throws = false } = {}) {
  const source = read('m.html'), start = source.indexOf('const macHost = (() => {');
  assert.ok(start > 0);
  const end = source.indexOf('if (macHost) window.macPhoneInactive = true;', start);
  const window = {}, host = { accepts: () => accepts };
  const parent = parentWindow ? window : { macPhoneHost: host, location: { origin } };
  if (throws) Object.defineProperty(parent, 'location', { get() { throw Error('cross origin'); } });
  const ctx = vm.createContext({ parent, window, URLSearchParams, location: { search: query, origin: 'http://127.0.0.1:1234' } });
  vm.runInContext(source.slice(start, end) + 'this.result = macHost;', ctx);
  return ctx.result;
}

test('an ordinary phone visit, even with the marker, never activates the Mac adapter', () => {
  assert.equal(embeddedGate({ parentWindow: true }), null);
  assert.equal(embeddedGate({ query: '' }), null);
  assert.equal(embeddedGate({ accepts: false }), null);
  assert.equal(embeddedGate({ origin: 'https://other.example' }), null);
  assert.equal(embeddedGate({ throws: true }), null);
  assert.ok(embeddedGate());
  assert.ok(!read('m.html').includes('src="/mac-phone-view.js"'), 'the phone keeps its dependency graph');
});

test('only the visible renderer can mark a reply read', () => {
  const source = read('card-logic.js'), start = source.indexOf('function markSeen(id){');
  const marks = [], ctx = vm.createContext({ seenTotals: { a: 3 }, setSeenMany: value => marks.push(plain(value)) });
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), ctx);
  ctx.markSeen('a');
  ctx.macPhoneInactive = true; ctx.markSeen('a');
  ctx.macPhoneInactive = false; ctx.markSeen('a');
  assert.deepEqual(marks, [{ a: 3 }, { a: 3 }]);
});

test('the real attachment uploader stays busy through resolution and releases on failure', async () => {
  const source = read('card-logic.js'), start = source.indexOf('async function attach(files, ta){');
  const f = adapter(false), pending = [];
  Object.assign(f.ctx, { uploadAttachment: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    attachmentNotice: (ta, value) => { ta.notice = value; }, Event: class Event {} });
  f.els.a.ta.dispatchEvent = () => {};
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), f.ctx);
  const send = f.ctx.attach([{ name: 'one.png' }], f.els.a.ta);
  assert.equal(f.adapter.busy(), true);
  pending.shift().resolve('/uploads/a/one.png'); await send;
  assert.equal(f.adapter.busy(), false);
  assert.ok(f.els.a.ta.value.includes('/uploads/a/one.png'));
  const failed = f.ctx.attach([{ name: 'two.png' }], f.els.a.ta);
  assert.equal(f.adapter.busy(), true);
  pending.shift().reject(Error('failed upload')); await failed;
  assert.equal(f.adapter.busy(), false);
  assert.match(f.els.a.ta.notice, /failed upload/);
  assert.ok(f.els.a.ta.value.includes('desktop words'), 'failure does not discard the existing words');
});
