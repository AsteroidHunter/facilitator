// Double Enter on the phone page (which the Mac board's narrow view shows) sends
// the message and then brings out the card list on Doing, the card just
// answered lifted in it, instead of jumping to the card that has waited longest.
// Control + Shift + Enter keeps its jump, a send the board refuses opens nothing, and
// the wide Mac board's double Enter still jumps.
//
// The phone's real reply-box key handler, its Enter intent (arm, ask, schedule),
// its landing and refusal of a send, and the real section choice from
// card-logic.js are cut out of the pages and run here with everything around
// them stubbed. The board's own double Enter is cut out of index.html the same
// way. No browser, layout, server or live board is involved.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const phone = readFileSync(path.join(ROOT, 'm.html'), 'utf8');
const board = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const logic = readFileSync(path.join(ROOT, 'card-logic.js'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const block = (source, start) => between(source, start, '\n}\n') + '\n}\n';
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

const HANDLER = between(phone, 'ta.addEventListener("keydown", e => {', '\n  // fitted again once the web faces');
const TIMING = between(phone, 'const AUTONEXT_MS = 0;', 'let phoneEnterAgain = null;');
const SECTIONS = between(logic, 'const TICKET_VIEWS = ', 'function ticketPageOf(') +
  between(logic, 'const TICKET_VIEW_KEY = ', 'function ticketViewOf(') +
  block(logic, 'function ticketViewOf(') + block(logic, 'function setTicketViewOf(') +
  'function curView(){ return ticketViewOf(activeOwner); }\n';

// a phone page with one card on screen in the given section. `calls` is the
// log of what the page was asked to do, in order
function phonePage({ view = 'todo' } = {}) {
  const calls = [], sent = [];
  const ta = { value: '', listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const b = { id: 'card' };
  const store = {};
  const ctx = vm.createContext({
    ta, b, calls, sent, setTimeout, clearTimeout, Date,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    document: { body: { classList: { contains: () => false } }, activeElement: null },
    activeOwner: 'one', selectedId: 'card', lastState: { boxes: [{ id: 'card', ws: 'work' }] },
    ops: [], createDiagnostics: new Map(),
    els: { card: { ta, field: { focused: () => false }, sentItems: [] } },
    controlShiftEnter: e => e.key === 'Enter' && e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey,
    bareControlEnter: e => e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey,
    traySendable: () => false,
    notePhoneEnter() {}, tracePhone() {}, saveOps() {}, drawSent() {}, ensureCard: id => ctx.els[id],
    undone() {}, endPhoneTrace() {},
    navigationPool: state => state.boxes,
    jumpNextYellow: (id) => { calls.push('jump'); return null; },
    focusBoxAtEnd() {},
    renderTickets() { calls.push('render'); },
    paintViewTabs() {}, chooseTicketNames() {},
    openDrawer() { calls.push('open:' + ctx.curView()); },
    // the board taking the words: the row empties and one operation is minted
    doSend: (id, opts) => {
      if (ta.refuse) return null;
      const op = { id: 'op' + (sent.length + 1), kind: 'send', box: id, advance: opts.advance !== false, state: 'pending' };
      sent.push(ta.value);
      ta.value = '';
      ctx.ops.push(op);
      return op;
    },
  });
  vm.runInContext(SECTIONS + TIMING + 'let phoneEnterAgain = null;\n' +
    block(phone, 'function phoneEnterViewKey(') + block(phone, 'function clearPhoneEnterAgain(') +
    block(phone, 'function cancelAutoNext(') + block(phone, 'function schedulePhoneAdvance(') +
    block(phone, 'function phoneOpenDrawer(') + block(phone, 'function phoneAdvance(') +
    block(phone, 'function armPhoneEnterAgain(') + block(phone, 'function askPhoneEnterAdvance(') +
    block(phone, 'function landSend(') + block(phone, 'function failOp(') +
    'var autoNext = null; (function(){' + HANDLER + '})();', ctx);
  vm.runInContext(`setTicketViewOf('one', ${JSON.stringify(view)})`, ctx);
  calls.length = 0;
  // answers whether the handler cancelled the key
  const press = (init = {}) => {
    let prevented = false;
    ta.listeners.keydown({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      repeat: false, isComposing: false, preventDefault() { prevented = true; }, ...init });
    return prevented;
  };
  return {
    ctx, calls, sent, ta, press,
    type: words => { ta.value = words; },
    land: () => ctx.landSend(ctx.ops[ctx.ops.length - 1], {}),
    refuse: () => ctx.failOp(ctx.ops[ctx.ops.length - 1], 'refused', 'board'),
    view: () => vm.runInContext('curView()', ctx),
    settle: () => later(30),
    done: () => vm.runInContext('clearPhoneEnterAgain()', ctx),
  };
}

// ---- double Enter sends, then opens the list on Doing ------------------------------

test('double Enter sends the words once and opens the card list on Doing', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.land();
  p.press();
  await p.settle();
  assert.deepEqual(p.sent, ['an answer']);
  assert.deepEqual(p.calls, ['open:todo']);
  assert.equal(p.ctx.selectedId, 'card', 'the answered card must stay the selected one');
  p.done();
});

test('a second Enter before the board has the message opens the list once it has', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.press();
  await p.settle();
  assert.deepEqual(p.calls, [], 'the list came out before the message was in');
  p.land();
  await p.settle();
  assert.deepEqual(p.calls, ['open:todo']);
  p.done();
});

for (const view of ['docked', 'deferred', 'done']) {
  test(`double Enter from a card in ${view} opens the list on Doing`, async () => {
    const p = phonePage({ view });
    p.type('an answer');
    p.press();
    p.land();
    p.press();
    await p.settle();
    assert.equal(p.view(), 'todo');
    assert.deepEqual(p.calls.filter(c => c.startsWith('open')), ['open:todo']);
    assert.ok(!p.calls.includes('jump'));
    p.done();
  });
}

test('double Enter never jumps to the card that has waited longest', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.land();
  p.press();
  await p.settle();
  assert.ok(!p.calls.includes('jump'));
  p.done();
});

test('a second Enter after the window has run out opens nothing', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.land();
  vm.runInContext('phoneEnterAgain.deadline = Date.now() - 1', p.ctx);
  p.press();
  await p.settle();
  assert.deepEqual(p.calls, []);
  p.done();
});

// ---- a send the board refuses opens nothing ----------------------------------------

test('a send refused before the second Enter opens nothing and moves nothing', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.refuse();
  p.press();
  await p.settle();
  assert.deepEqual(p.calls, []);
  assert.equal(p.ctx.selectedId, 'card');
});

test('a send refused after the second Enter opens nothing and moves nothing', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.press();
  p.refuse();
  await p.settle();
  assert.deepEqual(p.calls, []);
  assert.equal(p.ctx.selectedId, 'card');
});

// ---- the other Enter keys keep what they do ----------------------------------------

test('a single Enter sends and neither opens the list nor jumps', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.land();
  await p.settle();
  assert.deepEqual(p.sent, ['an answer']);
  assert.deepEqual(p.calls, []);
  p.done();
});

const CONTROL_SHIFT = { ctrlKey: true, shiftKey: true };

test('Control + Shift + Enter with words sends and still jumps, with no list', async () => {
  const p = phonePage();
  p.type('an answer');
  assert.equal(p.press(CONTROL_SHIFT), true, 'the key was left to the box, which would type a line');
  p.land();
  await p.settle();
  assert.deepEqual(p.sent, ['an answer']);
  assert.deepEqual(p.calls, ['jump']);
});

test('Control + Shift + Enter sent before the board has the message jumps once it has', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press(CONTROL_SHIFT);
  await p.settle();
  assert.deepEqual(p.calls, []);
  p.land();
  await p.settle();
  assert.deepEqual(p.calls, ['jump']);
});

test('Control + Shift + Enter on an empty box still jumps, with no list', async () => {
  const p = phonePage();
  p.press(CONTROL_SHIFT);
  await p.settle();
  assert.deepEqual(p.calls, ['jump']);
});

test('Control + Shift + Enter as the second press after an Enter still jumps, with no list', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press();
  p.land();
  p.press(CONTROL_SHIFT);
  await p.settle();
  assert.deepEqual(p.calls, ['jump']);
});

test('Control + Enter alone is the system\'s: nothing sent, nothing jumped, nothing cancelled', async () => {
  const p = phonePage();
  p.type('an answer');
  assert.equal(p.press({ ctrlKey: true }), false, 'the key was cancelled');
  await p.settle();
  assert.deepEqual(p.sent, []);
  assert.deepEqual(p.calls, []);
  const empty = phonePage();
  assert.equal(empty.press({ ctrlKey: true }), false);
  await empty.settle();
  assert.deepEqual(empty.calls, []);
});

test('Shift + Enter alone is still a new line', async () => {
  const p = phonePage();
  p.type('an answer');
  assert.equal(p.press({ shiftKey: true }), false);
  assert.deepEqual(p.sent, []);
});

test('Command + Enter keeps what it did: a second press still jumps', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press({ metaKey: true });
  p.land();
  p.press({ metaKey: true });
  await p.settle();
  assert.deepEqual(p.calls, ['jump']);
});

test('Shift + Enter sends nothing and opens nothing', async () => {
  const p = phonePage();
  p.type('an answer');
  p.press({ shiftKey: true });
  p.press({ shiftKey: true });
  await p.settle();
  assert.deepEqual(p.sent, []);
  assert.deepEqual(p.calls, []);
});

test('an Enter on an empty box with nothing sent opens nothing', async () => {
  const p = phonePage();
  p.press();
  await p.settle();
  assert.deepEqual(p.calls, []);
});

// ---- the wide Mac board's double Enter is unchanged --------------------------------

test('the board\'s double Enter still jumps and has no card list to open', async () => {
  const calls = [];
  const ctx = vm.createContext({
    calls, setTimeout, clearTimeout, Date, FOCUS: true, selectedId: 'card', activeOwner: 'one',
    lastState: { boxes: [] }, els: {}, curView: () => 'todo', curWs: () => ({ id: 'work' }),
    jumpNextYellow: (id, opts) => { calls.push(['jump', id, opts && opts.focus]); },
    openDrawer() { calls.push('open'); }, phoneOpenDrawer() { calls.push('open'); },
  });
  vm.runInContext(between(board, 'const AUTONEXT_MS = 0;', 'let enterAgain = null;') + 'let enterAgain = null;\n' +
    block(board, 'function enterViewKey(') + block(board, 'function clearEnterAgain(') +
    block(board, 'function cancelAutoNext(') + block(board, 'function scheduleDesktopAdvance(') +
    block(board, 'function boardAdvance(') + block(board, 'function armEnterAgain(') +
    block(board, 'function askEnterAdvance(') + 'var autoNext = null;', ctx);
  vm.runInContext(`
    const intent = armEnterAgain('card');
    askEnterAdvance('card');
    intent.delivered = true;
    scheduleDesktopAdvance('card', intent);`, ctx);
  await later(30);
  assert.deepEqual(calls, [['jump', 'card', true]]);
  assert.ok(!/phoneOpenDrawer|openDrawer\(/.test(between(board, 'function scheduleDesktopAdvance(', 'function composerArrow(')),
    'the board\'s double Enter reaches for the phone\'s card list');
});
