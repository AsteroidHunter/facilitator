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
const clickStart = html.indexOf('// a tap on the card with the list out');
const clickEnd = html.indexOf('// the two circles at the ends', clickStart);
assert.ok(clickStart > 0 && clickEnd > clickStart, 'card tap listener is present');

function fixture({ open = null, width = 300, mouse = false } = {}) {
  const listeners = new Map(), pageListeners = new Map(), paints = [], runs = [], classes = new Set();
  const tickets = { dataset: { side: 'left' } }, settings = { dataset: { side: 'right' } };
  const page = { addEventListener: (type, fn) => pageListeners.set(type, fn) };
  const cardPane = { getBoundingClientRect: () => ({ left: 30, right: 360, top: 300, bottom: 800 }) };
  let shown = open === 'left' ? tickets : open === 'right' ? settings : null;
  let x = 0, y = 400, target = null;
  const runMenu = (p, at, release) => {
    runs.push({ side: p.dataset.side, at, release });
    shown = at ? p : null;
    classes.delete('menudrag');
  };
  const context = vm.createContext({
    tickets, settings, page, cardPane, innerWidth: 390, homeOpen: false,
    performance: { now: () => 10000 }, // delivery time is deliberately unrelated to event time
    document: {
      addEventListener: (type, fn, options) => listeners.set(type, { fn, options }),
      body: { classList: { add: (...names) => names.forEach(c => classes.add(c)), remove: (...names) => names.forEach(c => classes.delete(c)) } },
    },
    menuOut: () => shown,
    drawerOpen: () => shown === tickets,
    closeDrawer: () => runMenu(tickets, 0),
    menuTravel: () => width,
    menuSign: p => p === tickets ? 1 : -1,
    dismissEditor() {}, closeProjects() {}, tracePhone() {}, stopList() {},
    paintMenu: (p, at) => paints.push({ side: p.dataset.side, at }),
    runMenu,
  });
  vm.runInContext(html.slice(policyStart, policyEnd) + '\n' + html.slice(clickStart, clickEnd) + '\n' + html.slice(start, finish), context);
  function fire(kind, t, px = x, py = y, extra = {}) {
    x = px; y = py;
    if (Object.hasOwn(extra, 'target')) target = extra.target;
    const type = mouse ? { start: 'mousedown', move: 'mousemove', end: 'mouseup', cancel: 'touchcancel' }[kind]
      : { start: 'touchstart', move: 'touchmove', end: 'touchend', cancel: 'touchcancel' }[kind];
    const point = { clientX: x, clientY: y };
    listeners.get(type).fn({ type, timeStamp: t, ...point, button: 0, target,
      touches: kind === 'end' || kind === 'cancel' ? [] : [point],
      changedTouches: [point], ...extra });
  }
  function click(t, extra = {}) {
    pageListeners.get('click')({ type: 'click', timeStamp: t, target: page,
      preventDefault() {}, stopPropagation() {}, ...extra });
  }
  return { fire, click, page, tickets, cardPane, listeners, paints, runs, classes, shown: () => shown?.dataset.side || null };
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

for (const mouse of [false, true]) {
  const input = mouse ? 'mouse' : 'touch';
  const cardStart = (f, t = 1000, x = 200, y = 500) => f.fire('start', t, x, y, { target: f.page });

  test(`an upward ${input} flick on the visible card closes the left drawer`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1030, 200, 485);
    f.fire('move', 1060, 200, 470);
    assert.equal(f.shown(), 'left', 'the card flick acts at release');
    f.fire('end', 1070);
    assert.equal(f.shown(), null);
    assert.deepEqual(f.runs, [{ side: 'left', at: 0, release: true }]);
    assert.deepEqual(f.paints, [], 'vertical motion must not pull the drawer sideways');
  });

  test(`a slow upward ${input} card drag and its click leave the drawer open`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1300, 200, 440);
    f.fire('move', 1800, 200, 320);
    f.fire('end', 1810);
    f.click(1811);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
    assert.deepEqual(f.paints, []);
    cardStart(f, 2000);
    f.fire('end', 2040);
    f.click(2041);
    assert.equal(f.shown(), null, 'a subsequent fresh tap must still close the drawer');
  });

  test(`a ${input} tap on the card still closes the drawer`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('end', 1040);
    assert.equal(f.shown(), 'left');
    f.click(1041);
    assert.equal(f.shown(), null);
    assert.equal(f.runs.length, 1);
  });

  test(`an upward ${input} card flick does nothing with the drawer closed`, () => {
    const f = fixture({ mouse });
    cardStart(f);
    f.fire('move', 1030, 200, 470);
    f.fire('end', 1040);
    f.click(1041);
    assert.equal(f.shown(), null);
    assert.deepEqual(f.paints, []);
    assert.deepEqual(f.runs, []);
  });

  test(`a downward ${input} card flick and its click do not close the drawer`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1040, 200, 540);
    f.fire('end', 1045);
    f.click(1046);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
    assert.deepEqual(f.paints, []);
  });

  test(`the upward ${input} card flick requires 18px and 0.4px/ms`, () => {
    for (const [distance, ms, expected] of [[18, 45, null], [17, 40, 'left'], [18, 46, 'left']]) {
      const f = fixture({ mouse, open: 'left' });
      cardStart(f);
      f.fire('move', 1000 + ms, 200, 500 - distance);
      f.fire('end', 1000 + ms);
      assert.equal(f.shown(), expected, `${distance}px over ${ms}ms`);
      f.click(1001 + ms);
      assert.equal(f.shown(), expected, 'a drag-generated click must not bypass the threshold');
    }
  });

  test(`a ${input} card flick held still before release loses its speed`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1040, 200, 470);
    f.fire('end', 1200);
    f.click(1201);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
  });

  test(`an upward ${input} card flick uses recent motion after a slow lead-in`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1500, 200, 492);
    f.fire('move', 1530, 200, 477);
    f.fire('move', 1560, 200, 447);
    f.fire('end', 1565);
    assert.equal(f.shown(), null);
  });

  test(`a sparse slow ${input} card move cannot become a recent flick`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1500, 200, 410);
    f.fire('end', 1505);
    f.click(1506);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
  });

  test(`the upward ${input} card flick includes movement delivered on release`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1020, 200, 490);
    f.fire('end', 1060, 200, 470);
    assert.equal(f.shown(), null);
  });

  test(`a fast ${input} card reversal follows the release direction`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1050, 200, 440);
    f.fire('move', 1080, 200, 470);
    f.fire('end', 1085);
    f.click(1086);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
  });

  test(`same-time ${input} card events cannot supply infinite flick velocity`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1000, 200, 470);
    f.fire('end', 1000);
    f.click(1001);
    assert.equal(f.shown(), 'left');
    assert.deepEqual(f.runs, []);
  });

  test(`upward ${input} gestures outside the card or on tickets and controls are ignored`, () => {
    for (const [name, x, y, target] of [
      ['above', 200, 299, 'page'], ['below', 200, 801, 'page'],
      ['left', 29, 500, 'page'], ['right', 361, 500, 'page'],
      ['ticket', 200, 500, 'tickets'], ['control', 200, 500, 'control'],
    ]) {
      const f = fixture({ mouse, open: 'left' });
      f.fire('start', 1000, x, y, { target: target === 'control' ? {} : f[target] });
      f.fire('move', 1040, x, y - 30);
      f.fire('end', 1045);
      assert.equal(f.shown(), 'left', name);
      assert.deepEqual(f.runs, [], name);
      assert.deepEqual(f.paints, [], name);
    }
  });

  test(`an upward ${input} gesture on the card does not close the right drawer`, () => {
    const f = fixture({ mouse, open: 'right' });
    cardStart(f);
    f.fire('move', 1040, 200, 470);
    f.fire('end', 1045);
    assert.equal(f.shown(), 'right');
    assert.deepEqual(f.runs, []);
    assert.deepEqual(f.paints, []);
  });

  test(`a sideways ${input} flick starting on the card still closes the left drawer`, () => {
    const f = fixture({ mouse, open: 'left' });
    cardStart(f);
    f.fire('move', 1040, 170, 500);
    f.fire('end', 1045);
    assert.equal(f.shown(), null);
    assert.deepEqual(f.runs, [{ side: 'left', at: 0, release: true }]);
    assert.ok(f.paints.length > 0);
  });
}

test('cancelling an upward touch card flick and its click leave the drawer open', () => {
  const f = fixture({ open: 'left' });
  f.fire('start', 1000, 200, 500, { target: f.page });
  f.fire('move', 1040, 200, 470);
  f.fire('cancel', 1045);
  f.click(1046);
  assert.equal(f.shown(), 'left');
  assert.deepEqual(f.runs, []);
  assert.deepEqual(f.paints, []);
});

test('compatibility mouse events after a slow touch drag cannot restore tap dismissal', () => {
  const f = fixture({ open: 'left' });
  f.fire('start', 1000, 200, 500, { target: f.page });
  f.fire('move', 1300, 200, 470);
  f.fire('end', 1310);
  for (const [type, timeStamp] of [['mousedown', 1320], ['mouseup', 1330]]) {
    f.listeners.get(type).fn({ type, timeStamp, target: f.page, button: 0, clientX: 200, clientY: 470 });
  }
  f.click(1331);
  assert.equal(f.shown(), 'left');
  assert.deepEqual(f.runs, []);
});
