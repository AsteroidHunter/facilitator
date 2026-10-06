// Control + Shift + ' and ; step the open card list through its four sections.
// The key table and the section helpers are card-logic.js as shipped; setView,
// the phone's two keydown listeners and its action tables are cut out of m.html
// and run as written. No browser, no board, no network.
//
// What the owner's arrows do is not what the keys do. The triangles only slide
// the names between their two pages (Doing, Docked | Deferred, Done); choosing
// a section is a tap on its name, which is setView. The keys take that path, so
// each one is compared here with the tap on the name it lands on.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = process.env.DRAWER_SECTION_KEYS_SOURCE || path.resolve(__dirname, '..');
const source = name => readFileSync(path.join(ROOT, name), 'utf8');
const logic = source('card-logic.js'), html = source('m.html');
const VIEWS = ['todo', 'docked', 'deferred', 'done'];
const plain = v => JSON.parse(JSON.stringify(v));

function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source anchors: ${start}, ${end}`);
  return text.slice(a, b);
}

function node(parent = null, flags = {}) {
  const classes = new Set(), attrs = new Map(), listeners = new Map();
  return {
    parent, style: {}, dataset: {}, inert: false, ...flags,
    classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle(c, on = !classes.has(c)) { on ? classes.add(c) : classes.delete(c); } },
    getAttribute: k => (attrs.has(k) ? attrs.get(k) : null), setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: k => attrs.delete(k),
    addEventListener(k, fn) { listeners.set(k, [...(listeners.get(k) || []), fn]); },
    fire(k) { for (const fn of listeners.get(k) || []) fn({ target: this }); },
    getBoundingClientRect: () => ({ width: 300 }),
    contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    // the typing check's selector, answered the way the page's fields answer it
    closest(selector) {
      for (let at = this; at; at = at.parent) if (selector === '.cm-editor' ? at.cm : (at.field || at.cm)) return at;
      return null;
    },
  };
}

// which cards each section lists, top to bottom; c1 is the card on screen
const SECTIONS = { todo: ['c1', 'c2'], docked: ['d1', 'd2', 'd3'], deferred: ['p1'], done: ['x1', 'x2'] };

function phone({ view = 'todo', drawer = true, menu = drawer ? 'tickets' : null } = {}) {
  const body = node(), card = node(body), cm = node(card, { cm: true });
  const targets = { body, button: node(card), title: node(card, { field: true }), cm,
    content: node(cm, { field: true }), ta: node(cm, { field: true }), other: node(body, { field: true }),
    plainTa: node(card, { field: true }) };
  const nodes = Object.fromEntries(['tv-todo', 'tv-docked', 'tv-deferred', 'tv-done', 'tik-page',
    'tik-page-back', 'tiklabels', 'tiksheet', 'tickets'].map(id => [id, node()]));
  nodes['tik-page-back'].setAttribute('aria-disabled', 'true');
  nodes.tickets.classList.add('open', 'drawer-settled');
  const store = new Map(), timers = new Map(), calls = [], browsed = [], listeners = [];
  let serial = 0;
  const rows = Object.fromEntries(Object.entries(SECTIONS).map(([name, ids]) =>
    [name, ids.map(id => ({ dataset: { id }, scrollIntoView() {} }))]));
  const panes = Object.fromEntries(VIEWS.map(name => [name, { querySelectorAll: s => (s === '.trow' ? rows[name] : []) }]));
  const state = { drawer, menu };
  const ctx = vm.createContext({
    Date, console, AbortSignal: { timeout: () => undefined },
    setTimeout(fn, ms) { timers.set(++serial, fn); return serial; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 1, clearInterval() {},
    document: { getElementById: id => nodes[id], body, createElement: () => node(),
      querySelector: s => panes[/data-view="([^"]+)"/.exec(s)?.[1]] || null },
    localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
    window: {}, matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ transform: 'matrix(1, 0, 0, 1, 0, 0)' }),
    fetch: () => new Promise(() => {}), poll() {},
    tickets: nodes.tickets, homeOpen: false, phoneDeveloperMode: false,
    activeOwner: 'lane', selectedId: 'c1', els: { c1: { ta: targets.ta } }, lastState: { boxes: [] },
    drawerOpen: () => state.drawer, menuOut: () => state.menu,
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); },
  });
  vm.runInContext(logic, ctx, { filename: 'card-logic.js' });
  Object.assign(ctx, {
    dropResponseScroll: () => calls.push('stop-scroll'), cancelAutoNext: () => calls.push('cancel-next'),
    renderTickets: () => calls.push('render'),
    browse: id => { ctx.selectedId = id; browsed.push(id); },
  });
  // setView, the name taps and the two arrows' own handlers
  vm.runInContext(between(html, 'function setView(v){', '// press feedback,'), ctx);
  // the phone's action tables, the card list's walk and the menu's keydown listener
  vm.runInContext(between(html, 'const phoneShortcutTyping = cardShortcutEditing;',
    '// a tap anywhere on the card on screen'), ctx);
  // the page's own keydown listener, after the menu's
  vm.runInContext(between(html, 'addEventListener("keydown", e => {\n  dispatchCardShortcut(e, homeOpen',
    '// releases, other keys'), ctx);
  ctx.setTicketViewOf('lane', view); ctx.paintViewTabs(); ctx.moveTicketSheet(view, false);
  const quote = { code: 'Quote', key: '"' }, semicolon = { code: 'Semicolon', key: ':' };
  const f = {
    ctx, nodes, store, timers, calls, browsed, targets, state, quote, semicolon,
    // one keydown through the listeners in the order the page registers them
    press(key, over = {}, target = body) {
      const e = { ...key, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, repeat: false,
        isComposing: false, defaultPrevented: false, stopped: false, target,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; },
        ...over };
      for (const fn of listeners) { if (e.stopped) break; fn(e); }
      return e;
    },
    tap: name => nodes['tv-' + name].fire('click'),
    snapshot: () => plain({
      view: ctx.curView(), stored: [...store], sheet: nodes.tiksheet.style.transform,
      labels: nodes.tiklabels.style.transform, timers: timers.size, calls,
      arrows: ['tik-page-back', 'tik-page'].map(id => [nodes[id].getAttribute('aria-disabled'), nodes[id].tabIndex]),
      tabs: VIEWS.map(v => [nodes['tv-' + v].classList.contains('on'), nodes['tv-' + v].inert]),
    }),
    view: () => ctx.curView(),
  };
  f.calls.length = 0;
  return f;
}

// ---- the key table ------------------------------------------------------------
const CHORD = { ctrlKey: true, shiftKey: true };
function keyEvent(key, code, over = {}) {
  return { key, code, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false,
    defaultPrevented: false, isComposing: false, repeat: false, ...over };
}

test('Control + Shift + Quote steps to the next section and + Semicolon to the previous, by physical key', () => {
  const f = phone(), resolve = f.ctx.cardShortcut;
  for (const key of ['"', "'", ':', ';', 'Unidentified', 'q', '']) {
    assert.deepEqual(plain(resolve(keyEvent(key, 'Quote', CHORD))), { action: 'drawerSection', value: 1 }, `Quote typing ${key}`);
    assert.deepEqual(plain(resolve(keyEvent(key, 'Semicolon', CHORD))), { action: 'drawerSection', value: -1 }, `Semicolon typing ${key}`);
  }
});

test('the keys need Control and Shift alone: Command, Option, a missing modifier, a repeat or a composition is nothing', () => {
  const f = phone(), resolve = f.ctx.cardShortcut;
  for (const [key, code] of [['"', 'Quote'], [':', 'Semicolon']]) {
    assert.equal(resolve(keyEvent(key, code, CHORD))?.action, 'drawerSection', `${code} with Control and Shift`);
    for (const over of [{ metaKey: true }, { altKey: true }, { metaKey: true, altKey: true }, { repeat: true }, { isComposing: true }]) {
      assert.equal(resolve(keyEvent(key, code, { ...CHORD, ...over })), null, `${code} with ${Object.keys(over)}`);
    }
    for (const held of [{}, { ctrlKey: true }, { shiftKey: true }]) {
      assert.equal(resolve(keyEvent(key, code, held)), null, `${code} with ${Object.keys(held)}`);
    }
  }
  // the character without the physical key is not these keys
  assert.equal(resolve(keyEvent('"', undefined, CHORD)), null);
  assert.equal(resolve(keyEvent(':', 'KeyP', CHORD)), null);
  // lookups never reach an object's own names
  for (const code of ['constructor', 'toString', '__proto__']) assert.equal(resolve(keyEvent('x', code, CHORD)), null);
});

test('the board answers neither key, the small card scope does not see them and the section chords are as they were', () => {
  const f = phone(), resolve = f.ctx.cardShortcut;
  assert.equal(resolve(keyEvent('"', 'Quote', CHORD))?.action, 'drawerSection', 'the full scope has the key');
  assert.equal(resolve(keyEvent('"', 'Quote', CHORD), 'mini'), null);
  assert.equal(resolve(keyEvent(':', 'Semicolon', CHORD), 'mini'), null);
  assert.equal(f.ctx.dispatchCardShortcut(keyEvent('"', 'Quote', CHORD), {}), false, 'a page with no list leaves the key alone');
  assert.doesNotMatch(source('index.html'), /drawerSection/);
  for (const [key, code, section] of [['{', 'BracketLeft', 'doing'], ['}', 'BracketRight', 'docked'], ['|', 'Backslash', 'deferred']]) {
    assert.deepEqual(plain(resolve(keyEvent(key, code, CHORD))), { action: 'sectionChord', value: section });
  }
  assert.deepEqual(plain(resolve(keyEvent('<', 'Comma', CHORD))), { action: 'cardsDrawer', value: true });
});

test('adjacentTicketView steps through the four sections in drawing order and stops past either end', () => {
  const { adjacentTicketView } = phone().ctx;
  for (const [view, next, previous] of [['todo', 'docked', null], ['docked', 'deferred', 'todo'],
    ['deferred', 'done', 'docked'], ['done', null, 'deferred']]) {
    assert.equal(adjacentTicketView(view, 1), next, `${view} next`);
    assert.equal(adjacentTicketView(view, -1), previous, `${view} previous`);
  }
});

// ---- the open list ------------------------------------------------------------
test('each key from each section lands on the section a tap on its name lands on, and the names and arrows follow', () => {
  for (const [step, key] of [[1, 'quote'], [-1, 'semicolon']]) {
    for (const start of VIEWS) {
      const target = VIEWS[VIEWS.indexOf(start) + step];
      if (!target) continue;
      const keyed = phone({ view: start }), tapped = phone({ view: start });
      const e = keyed.press(keyed[key]);
      tapped.tap(target);
      assert.equal(e.defaultPrevented, true, `${start} ${key}: the page takes the key`);
      assert.equal(keyed.view(), target, `${start} ${key}`);
      assert.deepEqual(keyed.snapshot(), tapped.snapshot(), `${start} ${key} is a tap on ${target}`);
      assert.deepEqual(keyed.snapshot().stored, [['tikview.lane', target]], 'the choice is kept for the project');
      assert.equal(keyed.nodes.tiksheet.style.transform, `translateX(${-VIEWS.indexOf(target) * 100}%)`);
      // the names slide to the page the section is on, and the arrow that points away from it is the faded one
      const page = target === 'deferred' || target === 'done' ? 1 : 0;
      assert.equal(keyed.nodes.tiklabels.style.transform, `translateX(${-page * 100}%)`);
      assert.equal(keyed.nodes['tik-page-back'].getAttribute('aria-disabled'), page === 0 ? 'true' : null);
      assert.equal(keyed.nodes['tik-page'].getAttribute('aria-disabled'), page === 1 ? 'true' : null);
      assert.equal(keyed.nodes['tv-' + target].classList.contains('on'), true);
      assert.deepEqual(keyed.calls, ['stop-scroll', 'cancel-next', 'render'], 'the list is drawn again, as a tap does');
    }
  }
});

test('three presses of one key cross the whole list, and three of the other bring it back', () => {
  const f = phone({ view: 'todo' });
  const seen = [];
  for (let i = 0; i < 3; i++) { f.press(f.quote); seen.push(f.view()); }
  for (let i = 0; i < 3; i++) { f.press(f.semicolon); seen.push(f.view()); }
  assert.deepEqual(seen, ['docked', 'deferred', 'done', 'deferred', 'docked', 'todo']);
});

test('at Doing the previous key and at Done the next key do nothing, as a faded arrow does, and never wrap', () => {
  for (const [start, key, faded] of [['todo', 'semicolon', 'tik-page-back'], ['done', 'quote', 'tik-page']]) {
    const f = phone({ view: start }), before = f.snapshot();
    assert.equal(f.nodes[faded].getAttribute('aria-disabled'), 'true', `${faded} is the faded arrow there`);
    const e = f.press(f[key]);
    assert.equal(e.defaultPrevented, true, 'the key is taken, as the faded chip still takes its key');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.view(), start);
    assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
    for (let i = 0; i < 3; i++) f.press(f[key]);
    assert.deepEqual(f.snapshot(), before, 'held down or repeated, it still does not wrap');
    // the faded arrow itself does nothing either
    f.nodes[faded].fire('click');
    assert.deepEqual(f.snapshot(), before);
  }
});

test('after a key the up and down keys walk the new section, and stop at its first and last card', () => {
  const f = phone({ view: 'todo' }), down = { code: 'ArrowDown', key: 'ArrowDown' }, up = { code: 'ArrowUp', key: 'ArrowUp' };
  const plainKey = key => f.press(key, { ctrlKey: false, shiftKey: false });
  f.press(f.quote);
  assert.equal(f.view(), 'docked');
  // the card on screen is in Doing, so down goes to the first docked ticket and up to the last
  assert.equal(plainKey(down).defaultPrevented, true);
  assert.deepEqual(f.browsed, ['d1']);
  plainKey(down); plainKey(down); plainKey(down);
  assert.deepEqual(f.browsed, ['d1', 'd2', 'd3']);
  plainKey(up);
  assert.deepEqual(f.browsed, ['d1', 'd2', 'd3', 'd2']);
  // on to Deferred and Done: each walks its own list
  f.press(f.quote); plainKey(down);
  assert.equal(f.browsed.at(-1), 'p1', 'Deferred holds one card');
  f.press(f.quote); plainKey(up);
  assert.equal(f.browsed.at(-1), 'x2', 'Done, the card on screen is in Deferred: up goes to the last');
  // and back the other way
  f.press(f.semicolon); f.press(f.semicolon); f.ctx.selectedId = 'c1'; plainKey(down);
  assert.equal(f.view(), 'docked'); assert.equal(f.browsed.at(-1), 'd1');
});

test('a pending visit to the names\' second page is cancelled by a key as it is by a tap on a name', () => {
  const f = phone({ view: 'todo' });
  const page = () => vm.runInContext('tikNamesPage', f.ctx);
  f.nodes['tik-page'].fire('click');
  assert.equal(page(), 1); assert.equal(f.timers.size, 1);
  assert.equal(f.view(), 'todo', 'the arrow chose no section');
  f.press(f.quote);
  assert.equal(f.view(), 'docked'); assert.equal(f.timers.size, 0); assert.equal(page(), 0);
});

test('held with Command or Option, or with a modifier missing, repeating or composing, the keys do nothing and are left to the browser', () => {
  // the same press, plain, does step the list
  for (const [key, to] of [['quote', 'deferred'], ['semicolon', 'todo']]) {
    const f = phone({ view: 'docked' });
    assert.equal(f.press(f[key]).defaultPrevented, true);
    assert.equal(f.view(), to);
  }
  for (const over of [{ metaKey: true }, { altKey: true }, { metaKey: true, altKey: true }]) {
    for (const key of ['quote', 'semicolon']) {
      const f = phone({ view: 'docked' }), before = f.snapshot();
      const e = f.press(f[key], over);
      assert.equal(e.defaultPrevented, false, `${key} with ${Object.keys(over)} is left to the browser`);
      assert.deepEqual(f.snapshot(), before);
    }
  }
  const f = phone({ view: 'docked' }), before = f.snapshot();
  for (const over of [{ repeat: true }, { isComposing: true }, { shiftKey: false }, { ctrlKey: false }]) {
    for (const key of ['quote', 'semicolon']) f.press(f[key], over);
  }
  assert.deepEqual(f.snapshot(), before);
});

// ---- the closed list, the settings, the home page ----------------------------
test('with the list shut the keys do nothing and are not taken from the page', () => {
  for (const [key, to] of [['quote', 'deferred'], ['semicolon', 'todo']]) {
    const open = phone({ view: 'docked' });
    open.press(open[key]);
    assert.equal(open.view(), to, 'the same press with the list out steps it');
    const f = phone({ view: 'docked', drawer: false }), before = f.snapshot();
    const e = f.press(f[key]);
    assert.equal(e.defaultPrevented, false);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.view(), 'docked');
  }
});

test('with the settings out, or the home page up, the keys do not move the list behind', () => {
  for (const [key, to] of [['quote', 'deferred'], ['semicolon', 'todo']]) {
    const open = phone({ view: 'docked' });
    open.press(open[key]);
    assert.equal(open.view(), to, 'the same press with the list out steps it');
    const settings = phone({ view: 'docked', drawer: false, menu: 'settings' }), before = settings.snapshot();
    settings.press(settings[key]);
    assert.deepEqual(settings.snapshot(), before, 'settings out');
    const home = phone({ view: 'docked' });
    home.ctx.homeOpen = true; const homeBefore = home.snapshot();
    home.press(home[key]);
    assert.deepEqual(home.snapshot(), homeBefore, 'home page up');
  }
});

// ---- typing --------------------------------------------------------------------
test('typing: the card\'s own box and anywhere nothing is typed take the keys; a title or another field keeps them', () => {
  for (const key of ['quote', 'semicolon']) {
    for (const start of ['docked', 'deferred']) {
      const target = VIEWS[VIEWS.indexOf(start) + (key === 'quote' ? 1 : -1)];
      for (const from of ['ta', 'content', 'body', 'button']) {
        const f = phone({ view: start });
        const e = f.press(f[key], {}, f.targets[from]);
        assert.equal(f.view(), target, `${key} from ${from}`);
        assert.equal(e.defaultPrevented, true);
      }
      for (const from of ['title', 'other']) {
        const f = phone({ view: start }), before = f.snapshot();
        const e = f.press(f[key], {}, f.targets[from]);
        assert.equal(e.defaultPrevented, false, `${from} keeps the key`);
        assert.deepEqual(f.snapshot(), before);
      }
    }
  }
  // the plain composer is the card's textarea itself
  const f = phone({ view: 'todo' });
  f.ctx.els.c1 = { ta: f.targets.plainTa };
  f.press(f.quote, {}, f.targets.plainTa);
  assert.equal(f.view(), 'docked');
});

test('with no card selected the keys still step the list from where nothing is typed', () => {
  const f = phone({ view: 'todo' });
  f.ctx.selectedId = null;
  f.press(f.quote);
  assert.equal(f.view(), 'docked');
  const g = phone({ view: 'todo' });
  g.ctx.selectedId = null;
  const e = g.press(g.quote, {}, g.targets.title);
  assert.equal(e.defaultPrevented, false); assert.equal(g.view(), 'todo');
});

test('a layout that types something else on the same physical keys steps the list too', () => {
  for (const [code, key] of [['Quote', '-'], ['Quote', 'Dead'], ['Semicolon', 's'], ['Semicolon', 'ö']]) {
    const f = phone({ view: 'docked' });
    f.press({ code, key });
    assert.equal(f.view(), code === 'Quote' ? 'deferred' : 'todo', `${code} typing ${key}`);
  }
});
