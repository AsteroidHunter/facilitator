// Tab on an open card cycles three stops in this order: the title, the text box, then
// the card itself with nothing focused (so the card's keys act on it), and back to the
// title. Shift Tab goes the other way: title, card, text box. From the card with
// nothing focused, or from a spot that is no stop, the first Tab lands on the title,
// the next stop, and the first Shift Tab in the text box. The exception is a card that
// already has a name, one being revisited: its first Tab lands in the text box, and the
// loop goes on from there (a card stop the loop itself left still goes on to the title).
// Both directions are run from each of the three stops and from the starting states
// the first-Tab fix covered (after a click on the reply text, on bare card, with
// nothing selected), on the Mac page and on the phone page, each on its own real
// code: cardTab, cardStop, cardTabAway and editTitle out of card-logic.js, the card's
// listener and the page's Tab listener lifted from index.html or m.html. The
// elements are small stand-ins that keep the focus the way a page does.
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

// one page with a card '7' on screen. which: 'mac' or 'phone'
// titled: false is a card just made (an empty title, the caret starts in it), true one
// that already has a name and is being revisited
function page(which, { titled = false } = {}) {
  const doc = { activeElement: null };
  const log = [];
  const body = part('body');
  const posts = [];
  function focusOn(n) {
    const prev = doc.activeElement;
    if (prev === n) return;
    doc.activeElement = n;
    log.push(n.name);
    if (prev && prev.onblur) prev.onblur();
  }
  function blurOn(n) {
    if (doc.activeElement !== n) return;
    doc.activeElement = null;
    log.push('card');
    if (n.onblur) n.onblur();
  }
  const box = Object.assign(part('box'), { classList: { contains: () => false } });
  const title = Object.assign(part('title'), {
    textContent: titled ? 'Tab cycling' : '', isContentEditable: false,
    setAttribute(n) { if (n === 'contenteditable') this.isContentEditable = true; },
    removeAttribute(n) { if (n === 'contenteditable') this.isContentEditable = false; },
    focus() { focusOn(this); }, blur() { blurOn(this); },
  });
  const ta = Object.assign(part('compose', ['textarea']), {
    value: 'half a message', caret: null, focus() { focusOn(this); }, blur() { blurOn(this); },
    setSelectionRange(a, b) { this.caret = [a, b]; },
  });
  const replyText = part('reply text');
  const el = { box, titleEl: title, ta, field: { focused: () => doc.activeElement === ta } };
  box.inside.add(title); box.inside.add(ta); box.inside.add(replyText);
  for (const b of BUTTONS) {
    el[b] = Object.assign(part(b), { focus() { focusOn(this); } });
    box.inside.add(el[b]);
  }

  const listeners = [], captures = [];
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, setInterval, clearInterval, window: {},
    document: {
      get activeElement() { return doc.activeElement || body; },
      createRange: () => ({ selectNodeContents() {} }),
      body: { classList: { contains: () => false } },
      addEventListener: (type, fn, capture) => (capture ? captures : listeners).push({ type, fn }),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    fetch: (url, opts) => { posts.push(opts && opts.body); return Promise.resolve({}); },
    poll() {}, omniRetitleCard() {},
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    els: { 7: el }, selectedId: '7', activeOwner: 'facilitator', arrivedCard: null,
    FOCUS: true, draft: false, pageWarn: null, pageMenu: null, setOpen: false, homeOpen: false,
    miniFocused: false, p3Zoom: false, onBoardPage: () => true,
    menuOut: () => null,
  });
  vm.runInContext(logic, context, { filename: 'card-logic.js' });
  let cardListener;
  const sandbox = { box: { addEventListener: (type, fn) => { cardListener = fn; } }, b: { id: '7' }, cardTab: context.cardTab,
    menuOut: () => context.menuOut() };
  if (which === 'mac') {
    vm.runInContext('keyboardTitle = true;', context);
    vm.runInContext(MAC_KEYS_LIVE, context);
    vm.runInContext(MAC_CARD_ON_SCREEN, context);
    vm.runInContext(MAC_LISTENER, context);
    sandbox.el = null;
    vm.runInNewContext(MAC_CARD_LISTENER, sandbox);
  } else {
    vm.runInContext(PHONE_FOCUS_BOX, context);
    vm.runInContext(PHONE_TITLE_TAB, context);
    vm.runInContext(PHONE_CARD_ON_SCREEN, context);
    vm.runInContext(PHONE_LISTENER, context);
    sandbox.focusBoxAtEnd = context.focusBoxAtEnd;
    vm.runInNewContext(PHONE_CARD_LISTENER, sandbox);
  }

  // a key pressed where the focus is (or on `target` when nothing holds it): the page's
  // capture listeners, the title's own handler, the card's listener when the key starts
  // inside the card, then the page's
  function press(shift, target = doc.activeElement || body) {
    const e = {
      key: 'Tab', target, shiftKey: !!shift, ctrlKey: false, metaKey: false, altKey: false,
      isComposing: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    };
    for (const l of captures) if (l.type === 'keydown') l.fn(e);
    if (target === title && title.onkeydown) { title.onkeydown(e); return e; }
    if (box.contains(target)) cardListener(e);
    for (const l of listeners) if (l.type === 'keydown') l.fn(e);
    return e;
  }
  // where the focus is: 'compose', 'title', or 'card' for nothing focused
  const where = () => doc.activeElement ? doc.activeElement.name : 'card';
  const go = n => { if (n === 'title') { title.focus(); } else if (n === 'compose') ta.focus(); else if (doc.activeElement) doc.activeElement.blur(); };
  return { el, doc, log, posts, context, body, replyText, title, ta, press, where, go };
}

const PAGES = ['mac', 'phone'];
const ORDER = ['title', 'compose', 'card'];
const next = n => ORDER[(ORDER.indexOf(n) + 1) % 3];
const prev = n => ORDER[(ORDER.indexOf(n) + 2) % 3];

for (const which of PAGES) {
  for (const stop of ORDER) {
    test(`${which}: Tab from the ${stop} goes to the ${next(stop)}`, () => {
      const p = page(which);
      if (stop === 'title') p.press(false, p.body);
      else p.go(stop);
      assert.equal(p.where(), stop === 'card' ? 'card' : stop);
      const e = p.press(false, stop === 'card' ? p.body : undefined);
      assert.ok(e.defaultPrevented);
      assert.equal(p.where(), next(stop));
    });

    test(`${which}: Shift Tab from the ${stop} goes to the ${prev(stop)}`, () => {
      const p = page(which);
      if (stop === 'title') p.press(false, p.body);
      else p.go(stop);
      assert.equal(p.where(), stop);
      const e = p.press(true, stop === 'card' ? p.body : undefined);
      assert.ok(e.defaultPrevented);
      assert.equal(p.where(), prev(stop));
    });
  }

  test(`${which}: six Tabs from the title go compose, card, title, compose, card, title and no button is visited`, () => {
    const p = page(which);
    p.press(false, p.body);
    assert.equal(p.where(), 'title');
    p.log.length = 0;
    for (let i = 0; i < 6; i++) p.press(false);
    assert.deepEqual(p.log, ['compose', 'card', 'title', 'compose', 'card', 'title']);
    for (const b of BUTTONS) assert.ok(!p.log.includes(b), b);
  });

  test(`${which}: six Shift Tabs from the title go card, compose, title, card, compose, title`, () => {
    const p = page(which);
    p.press(false, p.body);
    p.log.length = 0;
    for (let i = 0; i < 6; i++) p.press(true);
    assert.deepEqual(p.log, ['card', 'compose', 'title', 'card', 'compose', 'title']);
    for (const b of BUTTONS) assert.ok(!p.log.includes(b), b);
  });

  // the starting states of the first-Tab fix: nothing focused, with the key arriving at
  // the page (nothing selected, a click on bare card) or at the card's own face (a click
  // on the reply text)
  const STARTS = [
    ['nothing selected', p => p.body],
    ['after a click on bare card', p => p.body],
    ['after a click on the reply text', p => p.replyText],
  ];
  for (const [label, target] of STARTS) {
    test(`${which}: ${label}: Tab lands on the title, then the text box, then the card, then the title`, () => {
      const p = page(which);
      p.press(false, target(p));
      assert.equal(p.where(), 'title');
      assert.equal(p.title.isContentEditable, true);
      p.press(false);
      assert.equal(p.where(), 'compose');
      p.press(false);
      assert.equal(p.where(), 'card');
      p.press(false, target(p));
      assert.equal(p.where(), 'title');
    });

    test(`${which}: ${label}: Shift Tab lands in the text box, then the title, then the card, then the text box`, () => {
      const p = page(which);
      p.press(true, target(p));
      assert.equal(p.where(), 'compose');
      p.press(true);
      assert.equal(p.where(), 'title');
      p.press(true);
      assert.equal(p.where(), 'card');
      p.press(true, target(p));
      assert.equal(p.where(), 'compose');
    });
  }

  test(`${which}: leaving the title for the text box keeps a name being renamed, and the message in the box stays`, () => {
    const p = page(which);
    p.press(false, p.body);
    assert.equal(p.where(), 'title');
    p.title.textContent = 'Renamed card';
    p.press(false);
    assert.equal(p.where(), 'compose');
    assert.equal(p.title.isContentEditable, false);
    assert.equal(p.title.textContent, 'Renamed card');
    assert.deepEqual(p.posts, ['Renamed card']);
    assert.equal(p.ta.value, 'half a message');
  });

  test(`${which}: leaving the title for the card by Shift Tab keeps the name too`, () => {
    const p = page(which);
    p.press(false, p.body);
    p.title.textContent = 'Another name';
    p.press(true);
    assert.equal(p.where(), 'card');
    assert.equal(p.title.isContentEditable, false);
    assert.deepEqual(p.posts, ['Another name']);
  });

  test(`${which}: leaving the text box for the card keeps the half-typed message`, () => {
    const p = page(which);
    p.ta.focus();
    p.press(false);
    assert.equal(p.where(), 'card');
    assert.equal(p.ta.value, 'half a message');
    assert.deepEqual(p.posts, []);
    p.press(true);
    assert.equal(p.where(), 'compose');
    assert.equal(p.ta.value, 'half a message');
  });

  test(`${which}: at the card stop nothing is being typed in, so the card's keys act on the card`, () => {
    const p = page(which);
    p.ta.focus();
    p.press(false);
    assert.equal(p.where(), 'card');
    const live = p.context.document.activeElement;
    assert.equal(p.context.cardShortcutEditing(live), false);
    assert.equal(p.context.sectionChordSource(live, p.el), true);
    p.ta.focus();
    assert.equal(p.context.cardShortcutEditing(p.ta), true);
  });
}

// a card that already has a name is one being revisited: the first Tab from the card
// stop, however it was come to, lands in the text box, and the loop goes on from there
for (const which of PAGES) {
  for (const [label, target] of [
    ['nothing selected', p => p.body],
    ['after a click on bare card', p => p.body],
    ['after a click on the reply text', p => p.replyText],
  ]) {
    test(`${which}: a titled card, ${label}: first Tab lands in the text box, then the card, the title, the text box`, () => {
      const p = page(which, { titled: true });
      p.press(false, target(p));
      assert.equal(p.where(), 'compose');
      p.press(false);
      assert.equal(p.where(), 'card');
      p.press(false);
      assert.equal(p.where(), 'title');
      p.press(false);
      assert.equal(p.where(), 'compose');
    });

    test(`${which}: a titled card, ${label}: Shift Tab is unchanged, text box, title, card, text box`, () => {
      const p = page(which, { titled: true });
      p.press(true, target(p));
      assert.equal(p.where(), 'compose');
      p.press(true);
      assert.equal(p.where(), 'title');
      p.press(true);
      assert.equal(p.where(), 'card');
      p.press(true, target(p));
      assert.equal(p.where(), 'compose');
    });
  }

  test(`${which}: a titled card: the card stop the loop left goes on to the title, from the text box or from the title`, () => {
    for (const via of ['compose', 'title']) {
      const p = page(which, { titled: true });
      if (via === 'compose') { p.ta.focus(); p.press(false); }
      else { p.press(false, p.body); p.press(false); p.press(false); p.press(true); }
      assert.equal(p.where(), 'card', via);
      p.press(false, via === 'compose' ? p.replyText : p.body);
      assert.equal(p.where(), 'title', via);
    }
  });

  test(`${which}: a card just made starts in its title and follows the standard cycle, named or not`, () => {
    for (const name of ['', 'Fresh card']) {
      const p = page(which);
      p.context.editTitle('7');
      assert.equal(p.where(), 'title');
      p.title.textContent = name;
      p.press(false);
      assert.equal(p.where(), 'compose');
      p.press(false);
      assert.equal(p.where(), 'card');
      p.press(false);
      assert.equal(p.where(), 'title', JSON.stringify(name));
      p.press(false);
      assert.equal(p.where(), 'compose');
    }
  });

  test(`${which}: a card with no name yet sends the first Tab from the card stop to the title`, () => {
    const p = page(which);
    p.press(false, p.body);
    assert.equal(p.where(), 'title');
  });
}

test('phone: Tab out of the title puts the caret at the end of the words, Shift Tab out of it leaves the box alone', () => {
  const p = page('phone');
  p.press(false, p.body);
  p.press(false);
  assert.equal(p.where(), 'compose');
  assert.deepEqual(p.ta.caret, [14, 14]);
  const q = page('phone');
  q.press(false, q.body);
  q.press(true);
  assert.equal(q.where(), 'card');
  assert.equal(q.ta.caret, null);
});
