// The phone's keyboard stays up through a send. The send square's right part
// sits inside the strip along the right edge where a settings pull begins, and
// the iOS Simulator showed a tap there that slid 6 to 8 px letting go of the
// caret, so the keyboard went down, with the message sent or not. And a second
// press on the square moved to the next waiting card without the caret, which
// put the keyboard down too. Both are run here on the phone's real code: the
// drawer's touch listeners with event coordinates, and the second press's move
// with the shared card logic.
// No browser, layout, server or live board is involved.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = readFileSync(path.join(ROOT, 'm.html'), 'utf8');
const logic = readFileSync(path.join(ROOT, 'card-logic.js'), 'utf8');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const block = (source, start) => between(source, start, '\n}\n') + '\n}\n';
const DRAWER = between(html, '{\n  const EDGE = 28;    // how far in from an edge a pull may begin', "\n// the list's fades, the board's own:");
const POLICY = between(html, 'function menuAvailable(panel){', '\nfunction syncMenuAvailability(){');
const CLICK = between(html, '// a tap on the card with the list out', '// the two circles at the ends');

// the owner's phone is 375 wide, as is the simulator's iPhone 13 mini; there
// the square spans 326 to 354 and the strip begins at 347
const WIDTH = 375, ROW_Y = 290;
const row = { closest: s => s === '.bottombar' ? row : null };
const square = { closest: s => s === '.bottombar' ? row : null, parent: row };
const card = { closest: () => null };

function drawer({ open = null } = {}) {
  const listeners = new Map(), pageListeners = new Map(), events = [], runs = [];
  const tickets = { dataset: { side: 'left' } }, settings = { dataset: { side: 'right' } };
  const page = { addEventListener: (type, fn) => pageListeners.set(type, fn) };
  const cardPane = { getBoundingClientRect: () => ({ left: 10, right: WIDTH - 10, top: 60, bottom: 312 }) };
  const travel = p => p === tickets ? 300 : 320;
  let shown = open === 'left' ? tickets : open === 'right' ? settings : null;
  const context = vm.createContext({
    tickets, settings, page, cardPane, innerWidth: WIDTH, homeOpen: false,
    performance: { now: () => 0 },
    document: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      body: { classList: { add() {}, remove() {} } },
    },
    menuOut: () => shown,
    drawerOpen: () => shown === tickets,
    closeDrawer() {},
    menuTravel: travel,
    menuSign: p => p === tickets ? 1 : -1,
    // the row letting go of the caret, which is what puts a phone's keyboard down
    dismissEditor: () => events.push('let go'),
    closeProjects() {}, tracePhone() {}, stopList() {},
    paintMenu: (p, at) => events.push(Math.round(at * travel(p))),
    runMenu: (p, at) => { runs.push({ side: p.dataset.side, at }); shown = at ? p : null; },
  });
  vm.runInContext(POLICY + '\n' + CLICK + '\n' + DRAWER, context);
  let t = 1000;
  // one touch step, 16 ms after the last, as the page receives it
  const touch = (kind, x, y, target, gap = 16) => {
    t += gap;
    const point = { clientX: x, clientY: y };
    listeners.get('touch' + kind)({ type: 'touch' + kind, timeStamp: t, target,
      touches: kind === 'end' ? [] : [point], changedTouches: [point] });
  };
  // a press that slides `dx` in steps no larger than 4 px and lifts
  const slide = (x, y, dx, target) => {
    touch('start', x, y, target);
    const steps = Math.max(1, Math.ceil(Math.abs(dx) / 4));
    for (let i = 1; i <= steps; i++) touch('move', x + dx * i / steps, y, target);
    touch('end', x + dx, y, target);
  };
  return { touch, slide, events, runs, letGo: () => events.filter(e => e === 'let go').length };
}

// ---- a tap on the typing row is never a pull -------------------------------------------

for (const dx of [-6, -8, 6, 8]) {
  test(`a tap on the send square's right part that slides ${Math.abs(dx)} px ${dx < 0 ? 'in' : 'toward the edge'} keeps the caret`, () => {
    const f = drawer();
    f.slide(WIDTH - 24, ROW_Y, dx, square);
    assert.equal(f.letGo(), 0, 'the row let go of the caret, which puts the keyboard down');
    assert.deepEqual(f.events, [], 'the settings came out under a tap on the square');
    assert.deepEqual(f.runs, []);
  });
}

test('a press on the row\'s plus button inside the left strip that slides keeps the caret', () => {
  const f = drawer();
  f.slide(24, ROW_Y, 8, row);
  assert.equal(f.letGo(), 0);
  assert.deepEqual(f.events, [], 'the card list came out under a press on the row');
});

// ---- a slip beside the row comes out a little and goes back, with the caret kept ------

for (const dx of [-8, 8]) {
  test(`a press just right of the square that slips ${Math.abs(dx)} px ${dx < 0 ? 'in' : 'toward the edge'} keeps the caret, and settings go back`, () => {
    const f = drawer();
    f.slide(WIDTH - 14, ROW_Y, dx, card);
    assert.equal(f.letGo(), 0, 'a slip of a few px let go of the caret');
    assert.deepEqual(f.runs, [{ side: 'right', at: 0 }], 'the settings did not go back');
  });
}

// ---- a real pull still lets the row go, on its way out -----------------------------------

test('a settings pull from the edge lets the caret go once settings have come out 24 px, and only once', () => {
  const f = drawer();
  const x = WIDTH - 6;
  f.touch('start', x, ROW_Y, card);
  for (const dx of [-8, -16, -20]) f.touch('move', x + dx, ROW_Y, card);
  assert.equal(f.letGo(), 0, 'the caret went before the settings had really moved');
  f.touch('move', x - 30, ROW_Y, card);
  assert.equal(f.letGo(), 1, 'a pull 30 px out still holds the caret');
  assert.deepEqual(f.events.slice(-2), ['let go', 30], 'the caret went after the move that took the settings out 30 px was painted');
  for (const dx of [-120, -200]) f.touch('move', x + dx, ROW_Y, card);
  f.touch('end', x - 200, ROW_Y, card);
  assert.equal(f.letGo(), 1, 'the caret was let go more than once');
  assert.deepEqual(f.runs, [{ side: 'right', at: 1 }], 'the pull did not land the settings open');
});

test('a list pull from the left edge at the row\'s height, left of the row, still opens it', () => {
  const f = drawer();
  f.touch('start', 6, ROW_Y, card);
  f.touch('move', 18, ROW_Y, card);
  assert.equal(f.letGo(), 0, 'the caret went 12 px into the pull');
  for (const x of [40, 120, 220]) f.touch('move', x, ROW_Y, card, 40);
  f.touch('end', 220, ROW_Y, card, 40);
  assert.equal(f.letGo(), 1);
  assert.deepEqual(f.runs, [{ side: 'left', at: 1 }]);
});

// 20 px in 30 ms: a flick (18 px at 0.4 px/ms) that never comes out 24 px, so
// the caret goes where the list is opened, in runMenu
test('a short fast flick still opens the list', () => {
  const f = drawer();
  f.touch('start', 8, 400, card);
  f.touch('move', 18, 400, card, 15);
  f.touch('move', 28, 400, card, 15);
  f.touch('end', 28, 400, card, 10);
  assert.deepEqual(f.runs, [{ side: 'left', at: 1 }], 'the flick did not open the list');
});

test('with the list out, a swipe that starts on the typing row still shuts it', () => {
  const f = drawer({ open: 'left' });
  f.touch('start', 300, ROW_Y, row);
  for (const x of [280, 200, 100]) f.touch('move', x, ROW_Y, row, 30);
  f.touch('end', 100, ROW_Y, row, 30);
  assert.deepEqual(f.runs, [{ side: 'left', at: 0 }]);
});

// ---- the second press's move carries the caret ------------------------------------------

function advance({ typing, waiting = true }) {
  const card = (id, extra) => ({ id, owner: 'one', ws: 'work', state: 'yours', ball: 'you', done: false, ...extra });
  const boxes = [card('sent', { agentTs: 5, ball: 'agent' }), card('newer', { agentTs: 30 }), card('older', { agentTs: 10 }),
                 card('working', { agentTs: 1, writing: true })];
  if (!waiting) for (const b of boxes) if (b.id !== 'sent') b.ball = 'agent';
  const body = { id: 'body' }, document = { body, activeElement: body }, els = {};
  for (const b of boxes) {
    const ta = { id: b.id, value: 'words in ' + b.id, sel: null,
      setSelectionRange(from, to) { this.sel = [from, to]; }, focus() { document.activeElement = this; } };
    els[b.id] = { ta, field: { focused: () => document.activeElement === ta } };
  }
  if (typing) document.activeElement = els.sent.ta;
  const ctx = vm.createContext({ document, els, lastState: { boxes }, selectedId: 'sent', arrivedCard: null,
    navigationPool: state => state.boxes,
    select(id) { ctx.selectedId = id; } });
  vm.runInContext(block(logic, 'function waitingSince(b)') + block(logic, 'function jumpNextYellow(') +
    block(html, 'function focusBoxAtEnd(') + block(html, 'function phoneAdvance('), ctx);
  ctx.phoneAdvance('sent');
  return { ctx, document, els };
}

test('a second press that moves to the next waiting card carries the caret into its row, at the end', () => {
  const { ctx, document, els } = advance({ typing: true });
  assert.equal(ctx.selectedId, 'older', 'the move did not land on the card that has waited longest');
  assert.equal(document.activeElement, els.older.ta, 'the caret was left behind in the card that was moved away from');
  assert.deepEqual(els.older.ta.sel, [els.older.ta.value.length, els.older.ta.value.length]);
});

test('a move made with the caret elsewhere leaves the focus where it was', () => {
  const { ctx, document } = advance({ typing: false });
  assert.equal(ctx.selectedId, 'older');
  assert.equal(document.activeElement, document.body, 'a move with nothing being typed raised a keyboard');
});

test('with no card waiting, nothing moves and the caret stays in the row', () => {
  const { ctx, document, els } = advance({ typing: true, waiting: false });
  assert.equal(ctx.selectedId, 'sent');
  assert.equal(document.activeElement, els.sent.ta);
});
