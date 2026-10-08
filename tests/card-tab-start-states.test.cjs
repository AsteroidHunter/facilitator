// The first Tab on an open card goes to its text box from every place the focus can be
// when the key is pressed, not only from a button of the card: nothing focused after a
// load, after a click on the answer, on bare card or on a ticket, with Home just left,
// and on a button outside the card that a shut menu has handed the focus back to. The
// browser's own Tab would start from where the reader last clicked and stop on the plus
// before the text box; here the page takes the key itself. The plus, and everything else
// on the card but its text box and its title, is no stop of Tab either.
// The Mac page and the phone page are each run on their own real code: cardTab,
// cardTabAway, cardTabOwned and quietStops out of card-logic.js, the board's and the
// phone's own test of whether the card on screen holds the keys, and the page's Tab
// listener lifted from index.html or m.html. The elements are small stand-ins.
// No browser, layout, server or live board is involved.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const logic = readFileSync(path.join(ROOT, 'card-logic.js'), 'utf8');
const mac = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const phone = readFileSync(path.join(ROOT, 'm.html'), 'utf8');

function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b + end.length);
}

const MAC_LISTENER = between(mac, 'addEventListener("keydown", e => {\n  if (e.key !== "Tab" || !FOCUS || draft', '\n});');
const MAC_KEYS_LIVE = between(mac, 'function boardKeysLive(){', '}\n');
const MAC_CARD_ON_SCREEN = between(mac, 'function boardResponseCard(){', '\n}\n');
const MAC_CARD_LISTENER = between(mac, 'box.addEventListener("keydown", e => cardTab(', '\n');
const PHONE_LISTENER = between(phone, 'addEventListener("keydown", e => {\n  if (e.key !== "Tab" || homeOpen || menuOut()) return;', '\n});');
const PHONE_CARD_ON_SCREEN = between(phone, 'function phoneResponseCard(){', '\n}\n');
const PHONE_CARD_LISTENER = between(phone, 'box.addEventListener("keydown", e => { if (!menuOut()) cardTab(', '\n');
const PHONE_FOCUS_BOX = between(phone, 'function focusBoxAtEnd(el){', '\n}\n');
const PHONE_TITLE_TAB = between(phone, 'document.addEventListener("keydown", e => {\n  if (e.key !== "Tab" || e.ctrlKey', '\n}, true);');

const BUTTONS = ['histUp', 'histDown', 'sun', 'dock', 'arc', 'x', 'clip', 'send'];

// a stand-in element. kinds are the selectors it answers to in closest()
function part(name, kinds = []) {
  return {
    name, kinds, inside: new Set(),
    contains(n) { return n === this || this.inside.has(n); },
    closest(sel) {
      const wanted = sel.split(/[\s,]+/).filter(Boolean);
      return this.kinds.some(k => wanted.includes(k)) ? this : null;
    },
  };
}

// one page with two cards, '7' and '8', which: 'mac' or 'phone'
function page(which) {
  const doc = { activeElement: null };
  const names = [];
  const bodyClasses = new Set();
  const body = part('body');
  function focusOn(n) {
    const prev = doc.activeElement;
    if (prev === n) return;
    doc.activeElement = n;
    names.push(n.name);
    if (prev && prev.onblur) prev.onblur();
  }
  function card(id) {
    const box = part('box' + id);
    const title = Object.assign(part('title' + id), {
      textContent: 'Card ' + id, isContentEditable: false,
      setAttribute(n) { if (n === 'contenteditable') this.isContentEditable = true; },
      removeAttribute(n) { if (n === 'contenteditable') this.isContentEditable = false; },
      focus() { focusOn(this); },
    });
    const ta = Object.assign(part('compose' + id, ['textarea']), {
      value: 'draft', caret: null, focus() { focusOn(this); },
      setSelectionRange(a, b) { this.caret = [a, b]; },
    });
    const el = { box, titleEl: title, ta, field: { focused: () => doc.activeElement === ta } };
    box.inside.add(title); box.inside.add(ta);
    for (const b of BUTTONS) {
      el[b] = Object.assign(part(b + id), { focus() { focusOn(this); } });
      box.inside.add(el[b]);
    }
    return el;
  }
  const els = { 7: card('7'), 8: card('8') };

  const listeners = [], captures = [];
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      get activeElement() { return doc.activeElement; },
      createRange: () => ({ selectNodeContents() {} }),
      body: { classList: { contains: c => bodyClasses.has(c) } },
      addEventListener: (type, fn, capture) => (capture ? captures : listeners).push({ type, fn }),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    fetch: () => Promise.resolve({}), poll() {}, omniRetitleCard() {},
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    els, selectedId: '7', activeOwner: 'facilitator', arrivedCard: null,
    // what the Mac page declares
    FOCUS: true, draft: false, pageWarn: null, pageMenu: null, setOpen: false, homeOpen: false,
    miniFocused: false, p3Zoom: false, onBoardPage: () => true,
    // what the phone page declares
    menuOut: () => null,
  });
  vm.runInContext(logic, context, { filename: 'card-logic.js' });
  if (which === 'mac') {
    vm.runInContext('keyboardTitle = true;', context);
    vm.runInContext(MAC_KEYS_LIVE, context);
    vm.runInContext(MAC_CARD_ON_SCREEN, context);
    vm.runInContext(MAC_LISTENER, context);
  } else {
    vm.runInContext(PHONE_FOCUS_BOX, context);
    vm.runInContext(PHONE_TITLE_TAB, context);
    vm.runInContext(PHONE_CARD_ON_SCREEN, context);
    vm.runInContext(PHONE_LISTENER, context);
  }
  // each card's own listener, the line lifted out of the page
  const cardListeners = {};
  for (const id of ['7', '8']) {
    const sandbox = { box: { addEventListener: (type, fn) => { cardListeners[id] = fn; } }, b: { id }, cardTab: context.cardTab,
      menuOut: () => context.menuOut(), focusBoxAtEnd: context.focusBoxAtEnd };
    vm.runInNewContext(which === 'mac' ? MAC_CARD_LISTENER : PHONE_CARD_LISTENER, sandbox);
  }

  // a key pressed where the focus is: the card's own listener when the key starts inside
  // the card (the title keeps its own), then the page's. a page that has not preventDefault-ed
  // the key leaves it to the browser, which these tests can only report as not taken
  function press(mods = {}, target = doc.activeElement || body) {
    const e = {
      key: 'Tab', target, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      isComposing: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
      ...mods,
    };
    for (const l of captures) if (l.type === 'keydown') l.fn(e);
    const owner = ['7', '8'].find(id => els[id].box.contains(target));
    if (owner && target === els[owner].titleEl && target.onkeydown) { target.onkeydown(e); return e; }
    if (owner && cardListeners[owner]) cardListeners[owner](e);
    for (const l of listeners) if (l.type === 'keydown') l.fn(e);
    return e;
  }
  const where = () => doc.activeElement ? doc.activeElement.name : 'body';
  return { els, doc, names, context, bodyClasses, body, press, where, focusOn,
    set: (name, value) => { context[name] = value; } };
}

const PAGES = ['mac', 'phone'];

// the places the focus can be, and the page's state around them
const STARTS = [
  ['nothing focused after a load', () => {}, p => p.body],
  ['after a click on the answer', () => {}, p => p.body],
  ['after a click on bare card', () => {}, p => p.body],
  ['after a click on a ticket (another card now on screen)', p => p.set('selectedId', '8'), p => p.body],
  ['with Home just left', p => { p.set('homeOpen', true); p.set('homeOpen', false); }, p => p.body],
  ['after a menu shut and gave the focus back to its button', () => {}, () => part('menu button', ['button'])],
  ['on a button of the page outside the card', () => {}, () => part('tab bar button', ['button'])],
];

for (const which of PAGES) {
  for (const [label, arrange, target] of STARTS) {
    test(`${which}: the first Tab goes to the text box, ${label}`, () => {
      const p = page(which);
      arrange(p);
      const from = target(p);
      const shown = p.context.selectedId;
      const e = p.press({}, from);
      assert.ok(e.defaultPrevented, 'the page left the key to the browser');
      assert.equal(p.where(), 'compose' + shown);
      assert.ok(!p.names.some(n => BUTTONS.some(b => n.startsWith(b))), 'a button took the focus');
    });

    test(`${which}: Shift Tab goes to the title, ${label}`, () => {
      const p = page(which);
      arrange(p);
      const from = target(p);
      const shown = p.context.selectedId;
      const e = p.press({ shiftKey: true }, from);
      assert.ok(e.defaultPrevented);
      assert.equal(p.where(), 'title' + shown);
      assert.equal(p.els[shown].titleEl.isContentEditable, true);
    });
  }

  test(`${which}: from every starting place Tab, Tab, Tab only ever visits the text box and the title`, () => {
    for (const [label, arrange, target] of STARTS) {
      const p = page(which);
      arrange(p);
      const shown = p.context.selectedId;
      p.press({}, target(p));
      for (let i = 0; i < 5; i++) p.press();
      assert.deepEqual(p.names, ['compose', 'title', 'compose', 'title', 'compose', 'title'].map(n => n + shown), label);
    }
  });

  test(`${which}: a key in a text field, a list, a menu or a dialog is that control's own`, () => {
    for (const kinds of [['input'], ['textarea'], ['select'], ['[contenteditable]'], ['[role=\'textbox\']'], ['.cm-editor'],
      ['summary'], ['dialog'], ['[role=\'dialog\']'], ['[role=\'menu\']'], ['[role=\'listbox\']']]) {
      const p = page(which);
      const field = part('field', kinds);
      const e = p.press({}, field);
      assert.equal(e.defaultPrevented, false, kinds.join());
      assert.equal(p.names.length, 0, kinds.join());
    }
  });

  test(`${which}: chords with Control, Command or Option, and a Tab made while composing, are not taken`, () => {
    for (const mods of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }]) {
      const p = page(which);
      const e = p.press(mods, p.body);
      assert.equal(e.defaultPrevented, false, JSON.stringify(mods));
      assert.equal(p.names.length, 0);
    }
  });

  test(`${which}: a Tab another handler already took is not taken again`, () => {
    const p = page(which);
    const e = p.press({ defaultPrevented: true }, p.body);
    assert.equal(p.names.length, 0);
    assert.ok(e.defaultPrevented);
  });

  test(`${which}: with no card on screen the page leaves Tab to the browser`, () => {
    const p = page(which);
    p.set('selectedId', null);
    const e = p.press({}, p.body);
    assert.equal(e.defaultPrevented, false);
    assert.equal(p.names.length, 0);
  });
}

// the Mac board leaves the key alone while something else holds the board's keys
const MAC_HELD = [
  ['Home is up', p => p.set('homeOpen', true)],
  ['a page menu is out', p => p.set('pageMenu', {})],
  ['the delete-page window is up', p => p.set('pageWarn', {})],
  ['the settings page is open', p => p.set('setOpen', true)],
  ['the settings page is open (its class)', p => p.bodyClasses.add('setopen')],
  ['the small card holds the keys', p => p.set('miniFocused', true)],
  ['a picture is open', p => p.set('p3Zoom', true)],
  ['a new project is being named', p => p.set('draft', true)],
  ['the list view has no single card on screen', p => p.set('FOCUS', false)],
  ['the page is a blank one', p => p.set('onBoardPage', () => false)],
];
for (const [label, arrange] of MAC_HELD) {
  test(`mac: Tab is the browser's own while ${label}`, () => {
    const p = page('mac');
    arrange(p);
    const e = p.press({}, p.body);
    assert.equal(e.defaultPrevented, false);
    assert.equal(p.names.length, 0);
  });
}

// the phone page does the same while a menu is out over the card, Home is up, or the
// card is mid-swipe
const PHONE_HELD = [
  ['a menu is out', p => p.set('menuOut', () => ({}))],
  ['Home is up', p => p.set('homeOpen', true)],
  ['a drawer class is on the page', p => p.bodyClasses.add('menuout')],
  ['the card is mid-swipe', p => p.bodyClasses.add('carddrag')],
];
for (const [label, arrange] of PHONE_HELD) {
  test(`phone: Tab is not taken from the card while ${label}`, () => {
    const p = page('phone');
    arrange(p);
    const e = p.press({}, p.body);
    assert.equal(e.defaultPrevented, false);
    assert.equal(p.names.length, 0);
  });
}

test('phone: Tab from nothing puts the caret at the end of the words', () => {
  const p = page('phone');
  p.press({}, p.body);
  assert.deepEqual(p.els['7'].ta.caret, [5, 5]);
});

// nothing on a card but its text box and its title is a Tab stop
function node(tag, opts = {}) {
  const n = {
    nodeType: 1, tagName: tag, tabIndex: tag === 'DIV' ? -1 : 0, kids: [], parent: null, ...opts,
    matches(sel) { return sel.split(',').map(s => s.trim()).some(s => s === tag.toLowerCase() || (s === 'a[href]' && tag === 'A' && this.href)); },
    closest(sel) { for (let c = this; c; c = c.parent) if (sel.split(',').map(s => s.trim()).some(s => c.classes && c.classes.includes(s.replace('.', '')))) return c; return null; },
    querySelectorAll(sel) { const out = []; const walk = x => { for (const k of x.kids) { if (k.matches(sel)) out.push(k); walk(k); } }; walk(this); return out; },
    add(k) { k.parent = this; this.kids.push(k); return k; },
  };
  return n;
}

function cardTree() {
  const box = node('ARTICLE');
  const title = box.add(node('SPAN', { tabIndex: 0 }));
  const bar = box.add(node('DIV'));
  const parts = {};
  for (const name of ['histUp', 'histDown', 'sun', 'dock', 'arc', 'x']) parts[name] = bar.add(node('BUTTON'));
  const body = box.add(node('DIV'));
  const reply = body.add(node('DIV'));
  parts.link = reply.add(node('A', { href: 'https://example.com' }));
  parts.copy = reply.add(node('BUTTON'));
  const bottom = body.add(node('DIV'));
  parts.clip = bottom.add(node('BUTTON'));
  const compose = bottom.add(node('DIV'));
  parts.ta = compose.add(node('TEXTAREA'));
  parts.send = compose.add(node('BUTTON'));
  const editor = compose.add(node('DIV', { classes: ['cm-editor'] }));
  parts.editable = editor.add(node('DIV', { tabIndex: 0 }));
  parts.editable.matches = sel => false;   // the editor's own surface is no stop the page lists
  parts.editorButton = editor.add(node('BUTTON'));
  return { box, titleEl: title, ta: parts.ta, parts };
}

function quietContext() {
  const observers = [];
  const context = vm.createContext({
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe(root, opts) { this.root = root; this.opts = opts; } },
  });
  vm.runInContext(logic, context, { filename: 'card-logic.js' });
  return { context, observers };
}

test('quietStops: the plus, the send arrow, the top row, the reply arrows and the answer\'s links and buttons are no Tab stop', () => {
  const { context, observers } = quietContext();
  const el = cardTree();
  context.quietStops(el);
  for (const name of ['histUp', 'histDown', 'sun', 'dock', 'arc', 'x', 'clip', 'send', 'link', 'copy'])
    assert.equal(el.parts[name].tabIndex, -1, name);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].root, el.box);
  assert.deepEqual(JSON.parse(JSON.stringify(observers[0].opts)), { childList: true, subtree: true });
});

test('quietStops: the text box and the title stay stops, and so does the editor standing in for the box', () => {
  const { context } = quietContext();
  const el = cardTree();
  context.quietStops(el);
  assert.equal(el.parts.ta.tabIndex, 0);
  assert.equal(el.titleEl.tabIndex, 0);
  assert.equal(el.parts.editable.tabIndex, 0);
  assert.equal(el.parts.editorButton.tabIndex, 0, 'the editor\'s own controls are left as the editor made them');
});

test('quietStops: what the card draws afterwards is quieted as it arrives', () => {
  const { context, observers } = quietContext();
  const el = cardTree();
  context.quietStops(el);
  const drawn = node('DIV');
  const link = drawn.add(node('A', { href: 'https://example.com/more' }));
  const copy = drawn.add(node('BUTTON'));
  const text = { nodeType: 3 };
  observers[0].fn([{ addedNodes: [drawn, text] }]);
  assert.equal(link.tabIndex, -1);
  assert.equal(copy.tabIndex, -1);
  const lone = node('BUTTON');
  observers[0].fn([{ addedNodes: [lone] }]);
  assert.equal(lone.tabIndex, -1, 'an added node that is itself a button');
  assert.equal(drawn.tabIndex, -1, 'a plain block is left as it was');
});

test('both pages quiet each card they build, and the Mac board no longer opens the reply arrows to Tab', () => {
  assert.ok(/quietStops\(els\[b\.id\]\);/.test(mac));
  assert.ok(/quietStops\(card\);/.test(phone));
  assert.ok(!/histUp\.tabIndex = hasHistory/.test(mac));
  assert.ok(!/histDown\.tabIndex = hasHistory/.test(mac));
  assert.ok(!/el\.histUp\.tabIndex = /.test(mac));
  assert.ok(!/el\.histDown\.tabIndex = /.test(mac));
});
