// Control + Shift + [ , ] , \ and Delete move the card on screen between Doing,
// Docked, Deferred and Done on the phone page, with the card list out and with
// it shut alike. The key table and the section helpers are card-logic.js as
// shipped; phoneSectionMove, the phone's action tables, the card list's walk
// and the two keydown listeners are cut out of m.html and run as written. No
// browser, no board, no network.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const html = readFileSync(process.env.DRAWER_STATE_KEYS_HTML || path.join(ROOT, 'm.html'), 'utf8');
const logic = readFileSync(path.join(ROOT, 'card-logic.js'), 'utf8');

function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source anchors: ${start}, ${end}`);
  return text.slice(a, b);
}

function node(parent = null, flags = {}) {
  return {
    parent, style: {}, dataset: {}, ...flags,
    getAttribute(k) { return this.attrs?.[k] ?? null; },
    contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    // the typing check's selector, answered the way the page's fields answer it
    closest(selector) {
      for (let at = this; at; at = at.parent) if (selector === '.cm-editor' ? at.cm : (at.field || at.cm)) return at;
      return null;
    },
  };
}

// the four chips on the card on screen; a chip with aria-disabled is the one
// for the section the card is already in
function chips(section) {
  const names = { todo: 'sun', docked: 'dock', deferred: 'arc', done: 'x' };
  return Object.fromEntries(Object.values(names).map(n =>
    [n, node(null, { attrs: { 'aria-disabled': names[section] === n ? 'true' : 'false' } })]));
}

const SECTIONS = { todo: ['c1', 'c2'], docked: ['d1'], deferred: [], done: [] };

// menu: 'tickets' (the card list out), 'settings' (the other drawer) or null
function phone({ menu = 'tickets', section = 'todo', bucket = 'meta' } = {}) {
  const body = node(), card = node(body), cm = node(card, { cm: true });
  const targets = { body, button: node(card), title: node(card, { field: true }), cm,
    ta: node(cm, { field: true }), other: node(body, { field: true }) };
  const calls = [], browsed = [], listeners = [];
  const rows = SECTIONS.todo.map(id => ({ dataset: { id }, classList: { contains: () => false }, scrollIntoView() {} }));
  const state = { menu };
  const ctx = vm.createContext({
    Date, console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { body, querySelector: () => ({ querySelectorAll: s => (s === '.trow' ? rows : []) }) },
    localStorage: { getItem: () => null, setItem() {} },
    window: {}, matchMedia: () => ({ matches: false }),
    tickets: 'tickets', homeOpen: false, phoneDeveloperMode: false,
    activeOwner: 'lane', selectedId: 'c1', els: { c1: { ta: targets.ta, ...chips(section) } },
    lastState: { boxes: [{ id: 'c1', bucket }, { id: 'c2', bucket }] },
    drawerOpen: () => state.menu === 'tickets', menuOut: () => state.menu,
    curView: () => 'todo',
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); },
  });
  vm.runInContext(logic, ctx, { filename: 'card-logic.js' });
  Object.assign(ctx, {
    wakeCard: id => calls.push(['doing', id]),
    setCardDestination: (id, to) => calls.push([to, id]),
    closeCard: id => calls.push(['done', id]),
    browse: id => { ctx.selectedId = id; browsed.push(id); },
    syncDrawerPick: () => null, closeDrawer() {}, hideMenu() {}, chooseShown() {}, select() {},
  });
  vm.runInContext(between(html, 'function phoneSectionMove(e, section){', '// a tap anywhere on the card on screen'), ctx);
  vm.runInContext(between(html, 'addEventListener("keydown", e => {\n  dispatchCardShortcut(e, homeOpen',
    '// releases, other keys'), ctx);
  return {
    ctx, calls, browsed, targets,
    // one keydown through the listeners in the order the page registers them
    press(key, over = {}, target = body) {
      const e = { ...key, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, repeat: false,
        isComposing: false, defaultPrevented: false, stopped: false, target,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; },
        ...over };
      for (const fn of listeners) { if (e.stopped) break; fn(e); }
      return e;
    },
  };
}

const KEYS = {
  '[': { code: 'BracketLeft', key: '{' },
  ']': { code: 'BracketRight', key: '}' },
  '\\': { code: 'Backslash', key: '|' },
  Delete: { code: 'Delete', key: 'Delete' },
  Backspace: { code: 'Backspace', key: 'Backspace' },
};
const MOVES = [['[', 'doing'], [']', 'docked'], ['\\', 'deferred'], ['Delete', 'done'], ['Backspace', 'done']];
// a card already in the section the key names has that chip faded; start each
// case in a section other than its own
const START = { doing: 'docked', docked: 'todo', deferred: 'todo', done: 'todo' };

for (const [menu, where] of [['tickets', 'with the card list out'], [null, 'with the card list shut']]) {
  for (const [name, to] of MOVES) {
    test(`Control + Shift + ${name} moves the card to ${to} ${where}, once, and cancels the key`, () => {
      const f = phone({ menu, section: START[to] });
      const e = f.press(KEYS[name]);
      assert.deepEqual(f.calls, [[to, 'c1']]);
      assert.equal(e.defaultPrevented, true);
    });
  }
}

test('the card list stays out and the card behind it is not typed into', () => {
  const f = phone();
  for (const [name] of MOVES) f.press(KEYS[name]);
  assert.equal(f.ctx.menuOut(), 'tickets');
  assert.deepEqual(f.browsed, []);
});

test('the chord works from the card\'s composer and from a button in the list, not from a title being typed', () => {
  for (const menu of ['tickets', null]) {
    const f = phone({ menu });
    f.press(KEYS['\\'], {}, f.targets.ta);
    f.press(KEYS[']'], {}, f.targets.button);
    assert.deepEqual(f.calls, [['deferred', 'c1'], ['docked', 'c1']], `menu ${menu}`);
    const g = phone({ menu });
    const e = g.press(KEYS['\\'], {}, g.targets.title);
    g.press(KEYS['\\'], {}, g.targets.other);
    assert.deepEqual(g.calls, [], `menu ${menu}: a field that is not the composer keeps the chord`);
    assert.equal(e.defaultPrevented, false);
  }
});

test('the chord moves the card the list has lifted, the one a walk down last browsed', () => {
  const f = phone();
  f.ctx.els.c2 = { ta: f.targets.ta, ...chips('todo') };
  f.press({ code: 'ArrowDown', key: 'ArrowDown' }, { ctrlKey: false, shiftKey: false });
  assert.deepEqual(f.browsed, ['c2']);
  f.press(KEYS[']']);
  assert.deepEqual(f.calls, [['docked', 'c2']]);
});

test('a card already in the section only has the key cancelled, as with the list shut', () => {
  for (const menu of ['tickets', null]) {
    const f = phone({ menu, section: 'docked' });
    const e = f.press(KEYS[']']);
    assert.deepEqual(f.calls, [], `menu ${menu}`);
    assert.equal(e.defaultPrevented, true);
  }
});

test('a card that is not a meta card is left alone with the list out and shut', () => {
  for (const menu of ['tickets', null]) {
    const f = phone({ menu, bucket: 'running' });
    const e = f.press(KEYS['[']);
    assert.deepEqual(f.calls, [], `menu ${menu}`);
    assert.equal(e.defaultPrevented, false);
  }
});

test('a held key, a missing modifier, Command or Option do not move the card with the list out', () => {
  for (const over of [{ repeat: true }, { ctrlKey: false }, { shiftKey: false }, { metaKey: true }, { altKey: true }]) {
    for (const [name] of MOVES) {
      const f = phone({ section: 'docked' });
      f.press(KEYS[name], over);
      assert.deepEqual(f.calls, [], `${name} with ${Object.keys(over)}`);
    }
  }
});

test('with the settings out the chord still moves nothing', () => {
  const f = phone({ menu: 'settings' });
  for (const [name] of MOVES) f.press(KEYS[name]);
  assert.deepEqual(f.calls, []);
});

test('the list\'s own keys are as they were: up and down walk, other chords stay table-only', () => {
  const f = phone();
  const plain = { ctrlKey: false, shiftKey: false };
  const down = f.press({ code: 'ArrowDown', key: 'ArrowDown' }, plain);
  assert.equal(down.defaultPrevented, true);
  assert.deepEqual(f.browsed, ['c2']);
  assert.deepEqual(f.calls, []);
  // the plain bracket keys are not the chords, and the list still swallows them
  const bare = f.press({ code: 'BracketLeft', key: '[' }, plain);
  assert.deepEqual(f.calls, []);
  assert.equal(bare.defaultPrevented, false);
});
