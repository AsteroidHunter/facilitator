// Run the phone's real drawer listeners with event clocks and coordinates.
// No browser, layout, server or live board is involved.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const html = readFileSync(process.env.DRAWER_FLICK_SOURCE || path.join(__dirname, '..', 'm.html'), 'utf8');
const start = html.indexOf('{\n  const EDGE = 28;    // how far in from an edge a pull may begin');
const finish = html.indexOf("\n// the list's fades, the board's own:", start);
assert.ok(start > 0 && finish > start, 'drawer listener block is present');
const policyStart = html.indexOf('function menuAvailable(panel){');
const policyEnd = html.indexOf('\nfunction syncMenuAvailability(){', policyStart);
assert.ok(policyStart > 0 && policyEnd > policyStart, 'menu availability policy is present');

function fixture({ open = null, width = 300, mouse = false } = {}) {
  const listeners = new Map(), paints = [], runs = [], classes = new Set();
  const tickets = { dataset: { side: 'left' } }, settings = { dataset: { side: 'right' } };
  let shown = open === 'left' ? tickets : open === 'right' ? settings : null;
  let x = 0, y = 400;
  const context = vm.createContext({
    tickets, settings, innerWidth: 390, homeOpen: false,
    performance: { now: () => 10000 }, // delivery time is deliberately unrelated to event time
    document: {
      addEventListener: (type, fn, options) => listeners.set(type, { fn, options }),
      body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } },
    },
    menuOut: () => shown,
    menuTravel: () => width,
    menuSign: p => p === tickets ? 1 : -1,
    dismissEditor() {}, closeProjects() {}, tracePhone() {},
    paintMenu: (p, at) => paints.push({ side: p.dataset.side, at }),
    runMenu: (p, at, release) => {
      runs.push({ side: p.dataset.side, at, release });
      shown = at ? p : null;
      classes.delete('menudrag');
    },
  });
  vm.runInContext(html.slice(policyStart, policyEnd) + '\n' + html.slice(start, finish), context);
  function fire(kind, t, px = x, py = y, extra = {}) {
    x = px; y = py;
    const type = mouse ? { start: 'mousedown', move: 'mousemove', end: 'mouseup', cancel: 'touchcancel' }[kind]
      : { start: 'touchstart', move: 'touchmove', end: 'touchend', cancel: 'touchcancel' }[kind];
    const point = { clientX: x, clientY: y };
    listeners.get(type).fn({ type, timeStamp: t, ...point, button: 0,
      touches: kind === 'end' || kind === 'cancel' ? [] : [point],
      changedTouches: [point], ...extra });
  }
  return { fire, listeners, paints, runs, classes, shown: () => shown?.dataset.side || null };
}

for (const mouse of [false, true]) {
  for (const closing of [false, true]) {
    test(`a short fast ${mouse ? 'mouse' : 'touch'} flick ${closing ? 'closes' : 'opens'} the list`, () => {
      const f = fixture({ mouse, open: closing ? 'left' : null });
      const x = closing ? 200 : 8, sign = closing ? -1 : 1;
      f.fire('start', 1000, x);
      f.fire('move', 1030, x + sign * 15);
      f.fire('move', 1060, x + sign * 30);
      f.fire('end', 1070);
      assert.equal(f.shown(), closing ? null : 'left');
      assert.deepEqual(f.runs, [{ side: 'left', at: closing ? 0 : 1, release: true }]);
    });
  }
}

for (const closing of [false, true]) {
  test(`a slow short ${closing ? 'closing' : 'opening'} drag snaps back`, () => {
    const f = fixture({ open: closing ? 'left' : null });
    const x = closing ? 200 : 8, sign = closing ? -1 : 1;
    f.fire('start', 1000, x);
    f.fire('move', 1100, x + sign * 10);
    f.fire('move', 1300, x + sign * 30);
    f.fire('end', 1350);
    assert.equal(f.shown(), closing ? 'left' : null);
  });

  test(`a deliberate 36% ${closing ? 'closing' : 'opening'} drag commits below the old halfway mark`, () => {
    const f = fixture({ open: closing ? 'left' : null });
    const x = closing ? 200 : 8, sign = closing ? -1 : 1;
    f.fire('start', 1000, x);
    f.fire('move', 2000, x + sign * 108);
    f.fire('end', 2200);
    assert.equal(f.shown(), closing ? null : 'left');
  });

  test(`a mostly vertical swipe leaves the ${closing ? 'open' : 'closed'} list alone`, () => {
    const f = fixture({ open: closing ? 'left' : null });
    const x = closing ? 200 : 8;
    f.fire('start', 1000, x);
    f.fire('move', 1010, x + 4, 380);
    f.fire('move', 1030, x + 60, 360);
    f.fire('end', 1040);
    assert.equal(f.shown(), closing ? 'left' : null);
    assert.deepEqual(f.paints, []);
    assert.deepEqual(f.runs, []);
  });

  test(`a cancelled ${closing ? 'closing' : 'opening'} flick restores the starting state`, () => {
    const f = fixture({ open: closing ? 'left' : null });
    const x = closing ? 200 : 8, sign = closing ? -1 : 1;
    f.fire('start', 1000, x);
    f.fire('move', 1040, x + sign * 30);
    f.fire('cancel', 1050);
    assert.equal(f.shown(), closing ? 'left' : null);
  });
}

test('a flick held still before release loses its speed', () => {
  const f = fixture();
  f.fire('start', 1000, 8);
  f.fire('move', 1040, 38);
  f.fire('end', 1200);
  assert.equal(f.shown(), null);
});

test('a final flick works after a long slow lead-in', () => {
  const f = fixture();
  f.fire('start', 1000, 8);
  f.fire('move', 1500, 16);
  f.fire('move', 1530, 31);
  f.fire('move', 1560, 61);
  f.fire('end', 1565);
  assert.equal(f.shown(), 'left');
});

test('the last motion delivered on touchend is included', () => {
  const f = fixture();
  f.fire('start', 1000, 8);
  f.fire('move', 1020, 18);
  f.fire('end', 1060, 38);
  assert.equal(f.shown(), 'left');
});

test('a fast reversal follows the release direction rather than earlier travel', () => {
  for (const closing of [false, true]) {
    const f = fixture({ open: closing ? 'left' : null });
    const x = closing ? 300 : 8, sign = closing ? -1 : 1;
    f.fire('start', 1000, x);
    f.fire('move', 1050, x + sign * 180);
    f.fire('move', 1080, x + sign * 150);
    f.fire('end', 1085);
    assert.equal(f.shown(), closing ? 'left' : null);
  }
});

test('tiny fast jitter and a wrong-way flick do not open the list', () => {
  for (const dx of [4, 12, -30]) {
    const f = fixture();
    f.fire('start', 1000, 8);
    f.fire('move', 1010, 8 + dx);
    f.fire('end', 1015);
    assert.equal(f.shown(), null, `dx=${dx}`);
  }
});

test('a fast swipe outside the 28px left edge never claims the drawer', () => {
  const f = fixture();
  f.fire('start', 1000, 29);
  f.fire('move', 1040, 89);
  f.fire('end', 1045);
  assert.deepEqual(f.paints, []);
  assert.deepEqual(f.runs, []);
});

test('the right drawer retains its distance-only halfway release', () => {
  for (const closing of [false, true]) {
    for (const dx of [30, 108, 180]) {
      const f = fixture({ open: closing ? 'right' : null });
      const x = closing ? 100 : 385, sign = closing ? 1 : -1;
      f.fire('start', 1000, x);
      f.fire('move', 1040, x + sign * dx);
      f.fire('end', 1045);
      assert.equal(f.shown(), dx > 150 ? (closing ? null : 'right') : (closing ? 'right' : null));
    }
  }
});

test('same-time events cannot supply infinite flick velocity', () => {
  const f = fixture();
  f.fire('start', 1000, 8);
  f.fire('move', 1000, 38);
  f.fire('end', 1000);
  assert.equal(f.shown(), null);
});

test('all drawer touch and mouse listeners remain passive', () => {
  const f = fixture();
  assert.equal(f.listeners.size, 7);
  for (const [type, listener] of f.listeners) assert.equal(listener.options.passive, true, type);
});

test('the flick needs both 18px of recent travel and 0.4px/ms', () => {
  for (const [dx, ms, expected] of [[18, 45, 'left'], [17, 40, null], [18, 46, null]]) {
    const f = fixture();
    f.fire('start', 1000, 8);
    f.fire('move', 1000 + ms, 8 + dx);
    f.fire('end', 1000 + ms);
    assert.equal(f.shown(), expected, `${dx}px over ${ms}ms`);
  }
});

test('a sparse slow move does not turn into a flick at the window boundary', () => {
  const f = fixture();
  f.fire('start', 1000, 8);
  f.fire('move', 1500, 98); // 30% distance, 0.18px/ms
  f.fire('end', 1505);
  assert.equal(f.shown(), null);
});
