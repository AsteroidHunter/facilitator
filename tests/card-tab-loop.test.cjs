// Tab on an open card walks three stops, the title, the text box, and the card itself
// with nothing focused, and round again; shift Tab walks them the other way; the
// buttons of the card are never a stop. The cards are made with an empty title, as
// the board makes a new one; the cases at the end give a card a name, and the first
// Tab onto it then lands in the text box. The Mac board and the phone page are each
// run on their own real wiring:
// the shared cardTab and editTitle out of card-logic.js, the card's listener
// lifted from index.html or m.html, and on the phone the Tab listener ahead of
// the title and focusBoxAtEnd. The elements are small stand-ins that keep the
// focus the way a page does (the one that had it is blurred, so the title's
// blur commits its name).
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
const line = (source, start) => between(source, start, '\n').trimEnd();

const MAC_LISTENER = line(mac, 'box.addEventListener("keydown", e => cardTab(');
const PHONE_LISTENER = line(phone, 'box.addEventListener("keydown", e => { if (!menuOut()) cardTab(');
const PHONE_TITLE_TAB = between(phone, 'document.addEventListener("keydown", e => {\n  if (e.key !== "Tab" || e.ctrlKey', '\n}, true);');
const PHONE_FOCUS_BOX = between(phone, 'function focusBoxAtEnd(el){', '\n}\n');

const BUTTONS = ['histUp', 'sun', 'dock', 'arc', 'x', 'clip', 'send'];

// one card on a page. which is 'mac' or 'phone'
// titled: false is a card just made (an empty title), true one that already has a name
function page(which, { menu = false, titled = false } = {}) {
  const doc = { activeElement: null, listeners: [] };
  const names = [];
  function focusOn(n) {
    const prev = doc.activeElement;
    if (prev === n) return;
    doc.activeElement = n;
    names.push(n.name);
    if (prev && prev.onblur) prev.onblur();
  }
  // letting go of the focus leaves nothing focused: the card itself ('card' in the log)
  function blurOf(n) {
    if (doc.activeElement !== n) return;
    doc.activeElement = null;
    names.push('card');
    if (n.onblur) n.onblur();
  }
  const part = name => ({ name, contains(n) { return n === this; }, focus() { focusOn(this); }, blur() { blurOf(this); } });
  const title = Object.assign(part('title'), {
    textContent: titled ? 'Tab cycling' : '', isContentEditable: false,
    setAttribute(n) { if (n === 'contenteditable') this.isContentEditable = true; },
    removeAttribute(n) { if (n === 'contenteditable') this.isContentEditable = false; },
  });
  const ta = Object.assign(part('compose'), {
    value: 'draft', caret: null,
    setSelectionRange(from, to) { this.caret = [from, to]; },
  });
  const el = { titleEl: title, ta, field: { focused: () => doc.activeElement === ta } };
  for (const name of BUTTONS) el[name] = part(name);

  const calls = { posts: 0, caretAtEnd: 0 };
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      get activeElement() { return doc.activeElement; },
      createRange: () => ({ selectNodeContents() {} }),
      addEventListener: (type, fn, capture) => doc.listeners.push({ type, fn, capture }),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    fetch: () => { calls.posts++; return Promise.resolve({}); },
    poll() {}, omniRetitleCard() {},
    els: { 7: el }, selectedId: '7', menuOut: () => menu, arrivedCard: null,
  });
  vm.runInContext(logic, context, { filename: 'card-logic.js' });

  const listeners = [];
  const box = { addEventListener: (type, fn) => listeners.push(fn) };
  context.box = box;
  context.b = { id: '7' };
  if (which === 'mac') {
    vm.runInContext('keyboardTitle = true;', context);
    vm.runInContext(MAC_LISTENER, context);
  } else {
    vm.runInContext(PHONE_FOCUS_BOX, context);
    vm.runInContext(PHONE_TITLE_TAB, context);
    vm.runInContext(PHONE_LISTENER, context);
  }

  // a key pressed where the focus is: the page's capture listeners, then the
  // title's own handler (which keeps the key from the card), then the card's
  function press(key, mods = {}) {
    const target = doc.activeElement;
    const e = {
      key, target, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
      isComposing: false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...mods,
    };
    for (const l of doc.listeners) if (l.type === 'keydown' && l.capture) l.fn(e);
    if (target === title && title.onkeydown) title.onkeydown(e);
    if (!e.stopped) for (const fn of listeners) fn(e);
    return e;
  }
  return { el, doc, names, calls, press, title, ta, context, sun: el.sun };
}

const PAGES = ['mac', 'phone'];
const where = p => p.doc.activeElement ? p.doc.activeElement.name : null;

for (const which of PAGES) {
  test(`${which}: Tab with the focus on a button of the card goes to the title`, () => {
    for (const name of BUTTONS) {
      const p = page(which);
      p.el[name].focus();
      const e = p.press('Tab');
      assert.equal(where(p), 'title', name);
      assert.equal(p.title.isContentEditable, true, name);
      assert.ok(e.defaultPrevented, name);
    }
  });

  test(`${which}: Tab in the text box goes to the card with nothing focused and keeps the message`, () => {
    const p = page(which);
    p.ta.focus();
    p.press('Tab');
    assert.equal(where(p), null);
    assert.equal(p.ta.value, 'draft');
  });

  test(`${which}: Tab in the title goes to the text box and keeps the name`, () => {
    const p = page(which);
    p.ta.focus();
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), 'title');
    p.title.textContent = 'Renamed card';
    p.press('Tab');
    assert.equal(where(p), 'compose');
    assert.equal(p.title.isContentEditable, false);
    assert.equal(p.title.textContent, 'Renamed card');
    assert.equal(p.calls.posts, 1);
  });

  test(`${which}: Shift Tab in the title goes to the card with nothing focused and keeps the name`, () => {
    const p = page(which);
    p.ta.focus();
    p.press('Tab', { shiftKey: true });
    p.title.textContent = 'Renamed card';
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), null);
    assert.equal(p.title.isContentEditable, false);
    assert.equal(p.title.textContent, 'Renamed card');
    assert.equal(p.calls.posts, 1);
  });

  test(`${which}: Tab loops title, text box, card and reaches nothing else`, () => {
    const p = page(which);
    p.sun.focus();
    for (let i = 0; i < 12; i++) p.press('Tab');
    const seen = p.names.slice(1);
    assert.deepEqual(seen, Array.from({ length: 4 }, () => ['title', 'compose', 'card']).flat());
    for (const name of BUTTONS) assert.ok(!seen.includes(name), name);
  });

  test(`${which}: Shift Tab goes round the same three stops the other way`, () => {
    const p = page(which);
    p.ta.focus();
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), 'title');
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), null);
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), 'compose');
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), 'title');
    for (const name of BUTTONS) assert.ok(!p.names.includes(name), name);
  });

  test(`${which}: Shift Tab from a button of the card lands in the text box`, () => {
    for (const name of BUTTONS) {
      const p = page(which);
      p.el[name].focus();
      p.press('Tab', { shiftKey: true });
      assert.equal(where(p), 'compose', name);
      p.press('Tab', { shiftKey: true });
      assert.equal(where(p), 'title', name);
    }
  });

  test(`${which}: chords with Control, Command or Option, composing and other keys are left alone`, () => {
    for (const [key, mods] of [['Tab', { ctrlKey: true }], ['Tab', { metaKey: true }], ['Tab', { altKey: true }],
      ['Tab', { isComposing: true }], ['Enter', {}], ['Escape', {}], ['ArrowDown', {}]]) {
      const p = page(which);
      p.sun.focus();
      const e = p.press(key, mods);
      assert.equal(where(p), 'sun', key + JSON.stringify(mods));
      assert.equal(e.defaultPrevented, false, key + JSON.stringify(mods));
    }
  });

  test(`${which}: a Tab another handler already took is not taken again`, () => {
    const p = page(which);
    p.sun.focus();
    const e = p.press('Tab', { defaultPrevented: true });
    assert.equal(where(p), 'sun');
    assert.ok(e.defaultPrevented);
  });
}

test('mac: Enter in the title still commits and goes to the text box, Escape too', () => {
  for (const key of ['Enter', 'Escape']) {
    const p = page('mac');
    p.ta.focus();
    p.press('Tab', { shiftKey: true });
    assert.equal(where(p), 'title');
    p.press(key);
    assert.equal(where(p), 'compose', key);
    assert.equal(p.title.isContentEditable, false, key);
  }
});

test('mac: the title takes shift Tab to the card and no longer to the sun', () => {
  const p = page('mac');
  p.ta.focus();
  p.press('Tab', { shiftKey: true });
  p.press('Tab', { shiftKey: true });
  assert.equal(where(p), null);
  assert.ok(!p.names.includes('sun'));
});

test('phone: a menu that is out keeps the Tab, the card does not move the focus', () => {
  const p = page('phone', { menu: true });
  p.sun.focus();
  const e = p.press('Tab');
  assert.equal(where(p), 'sun');
  assert.equal(e.defaultPrevented, false);
});

test('phone: Tab out of the title puts the caret at the end of the words, shift Tab leaves the card alone', () => {
  const p = page('phone');
  p.ta.focus();
  p.press('Tab', { shiftKey: true });
  assert.equal(where(p), 'title');
  p.press('Tab');
  assert.equal(where(p), 'compose');
  assert.deepEqual(p.ta.caret, [5, 5]);
  const q = page('phone');
  q.ta.focus();
  q.press('Tab', { shiftKey: true });
  q.press('Tab', { shiftKey: true });
  assert.equal(where(q), null);
  assert.equal(q.ta.caret, null);
});

test('phone: shift Tab from a button puts the caret at the end of the words', () => {
  const p = page('phone');
  p.sun.focus();
  p.press('Tab', { shiftKey: true });
  assert.equal(where(p), 'compose');
  assert.deepEqual(p.ta.caret, [5, 5]);
});

// a card that already has a name is one the reader is revisiting: the first Tab onto it
// lands in the text box, and the loop after that is the same
for (const which of PAGES) {
  test(`${which}: a titled card: Tab with the focus on a button of the card goes to the text box`, () => {
    for (const name of BUTTONS) {
      const p = page(which, { titled: true });
      p.el[name].focus();
      const e = p.press('Tab');
      assert.equal(where(p), 'compose', name);
      assert.ok(e.defaultPrevented, name);
    }
  });

  test(`${which}: a titled card: after the first Tab the loop is text box, card, title, text box`, () => {
    const p = page(which, { titled: true });
    p.sun.focus();
    for (let i = 0; i < 9; i++) p.press('Tab');
    assert.deepEqual(p.names.slice(1), Array.from({ length: 3 }, () => ['compose', 'card', 'title']).flat());
  });

  test(`${which}: a titled card: Shift Tab from a button still lands in the text box and the loop goes the other way`, () => {
    const p = page(which, { titled: true });
    p.sun.focus();
    for (let i = 0; i < 6; i++) p.press('Tab', { shiftKey: true });
    assert.deepEqual(p.names.slice(1), ['compose', 'title', 'card', 'compose', 'title', 'card']);
  });

  test(`${which}: a titled card: naming it again starts afresh, and the next first Tab lands in the text box`, () => {
    const p = page(which, { titled: true });
    p.ta.focus();
    p.press('Tab');
    assert.equal(where(p), null);
    p.context.editTitle('7');
    p.title.blur();
    assert.equal(where(p), null);
    p.press('Tab');
    assert.equal(where(p), 'compose');
  });

  test(`${which}: a card with no name yet, or only the ellipsis, sends the first Tab to the title`, () => {
    for (const text of ['', '   ', '…']) {
      const p = page(which);
      p.title.textContent = text;
      p.sun.focus();
      p.press('Tab');
      assert.equal(where(p), 'title', JSON.stringify(text));
    }
  });
}

test('the old ring is gone from the Mac board and the buttons carry no Tab handler of their own', () => {
  assert.ok(!/const ring = \[/.test(mac));
  assert.ok(!/ring\[next\]/.test(mac));
  assert.ok(!/node\.addEventListener\("keydown", e => \{\s*if \(e\.key === "Tab"\)/.test(mac));
  assert.ok(!/e\.shiftKey \? \(el\.sun \|\| el\.arc\)/.test(logic));
});
