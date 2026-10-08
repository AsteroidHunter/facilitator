// A box being typed in keeps the keys it is typed with and lets every key held
// with Command or Control go on to the page (pageChord in card-logic.js): a
// card's title while it is renamed on both pages, and on the Mac the small
// card's title and box and the goal box. The card's own title counts as the
// card's own box for Control + S, Control + U and the section chords. Each
// key that used to do nothing in these boxes is pressed here through the
// pages' real handlers, beside the keys that stay with the box on purpose.
// No browser (see hotkey-pages.cjs).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage, phonePage } = require("./hotkey-pages.cjs");

// place, key, what the page does with the key there
const MAC_FIXED = [
  ["title", "cmd+t", ["create one"]],
  ["title", "cmd+2", ["tab two"]],
  ["title", "ctrl+shift+right", ["navigate 1"]],
  ["title", "ctrl+shift+up", ["history c1 1"]],
  ["title", "ctrl+enter", ["advance c1"]],
  ["title", "ctrl+r", ["random c2"]],
  ["title", "ctrl+s", ["scroll"]],
  ["title", "ctrl+u", ["fetch /testing?box=c1 POST"]],
  ["title", "ctrl+shift+]", ["section c1 docked"]],
  ["small card box", "cmd+2", ["tab two"]],
  ["small card box", "escape", []],
  ["small card title", "cmd+2", ["tab two"]],
  ["small card title", "ctrl+enter", ["advance c1"]],
  ["small card title", "ctrl+shift+]", ["section m1 docked"]],
  ["goal editor", "cmd+t", ["create one"]],
  ["goal editor", "cmd+2", ["tab two"]],
  ["goal editor", "ctrl+shift+right", ["navigate 1"]],
  ["goal editor", "ctrl+shift+up", ["history c1 1"]],
  ["goal editor", "ctrl+enter", ["goal saved the goal", "advance c1"]],
  ["goal editor", "ctrl+r", ["random c2"]],
];

const PHONE_FIXED = [
  ["title", "cmd+t", ["create"]],
  ["title", "cmd+2", ["tab two"]],
  ["title", "ctrl+shift+right", ["navigate 1"]],
  ["title", "ctrl+shift+up", ["history c1 1"]],
  ["title", "ctrl+enter", ["advance c1"]],
  ["title", "ctrl+r", ["browse c2"]],
  ["title", "ctrl+s", ["scroll"]],
  ["title", "ctrl+u", ["fetch /testing?box=c1 POST"]],
  ["title", "ctrl+shift+]", ["section c1 docked"]],
  ["title", "ctrl+shift+,", ["show list"]],
];

test("20 Mac keys in the boxes being typed in do their job", () => {
  assert.equal(MAC_FIXED.length, 20);
  for (const [place, key, want] of MAC_FIXED) {
    const f = macPage();
    const { e, calls } = f.press(place, key);
    assert.deepEqual(calls, want, `${place} ${key}`);
    if (want.length) assert.equal(e.defaultPrevented, true, `${place} ${key} was left to the box`);
  }
});

test("10 phone keys in a renamed title do their job", () => {
  assert.equal(PHONE_FIXED.length, 10);
  for (const [place, key, want] of PHONE_FIXED) {
    const f = phonePage();
    const { e, calls } = f.press(place, key);
    assert.deepEqual(calls, want, `${place} ${key}`);
    assert.equal(e.defaultPrevented, true, `${place} ${key} was left to the title, which typed it`);
  }
});

test("the other section chords and done come from a renamed title too, on both pages", () => {
  for (const make of [macPage, phonePage]) {
    for (const [key, section] of [["ctrl+shift+[", "doing"], ["ctrl+shift+backspace", "done"]]) {
      const f = make();
      const { e, calls } = f.press("title", key);
      assert.deepEqual(calls, [`section c1 ${section}`], key);
      assert.equal(e.defaultPrevented, true);
    }
  }
});

test("control+enter keeps the name first: the title commits and the caret leaves it", () => {
  for (const make of [macPage, phonePage]) {
    const f = make();
    f.places.title();
    f.a.parts.title.textContent = "  Renamed  ";
    const { e, calls } = f.send(f.a.parts.title, "ctrl+enter");
    assert.equal(f.a.parts.title.isContentEditable, false, "the title is still being typed in");
    assert.equal(f.a.parts.title.textContent, "Renamed");
    assert.deepEqual(calls, ["fetch /title?box=c1 POST", "advance c1"]);
    assert.equal(e.defaultPrevented, true);
  }
  // the small card's title hands the keys back to the large card before the move
  const f = macPage();
  f.press("small card title", "ctrl+enter");
  assert.equal(f.ctx.miniFocused, false);
  assert.equal(f.mtitle.isContentEditable, false);
});

test("the small card box's Escape takes the caret out, as the large card's does, and lets go of nothing", () => {
  const f = macPage();
  const { e, calls } = f.press("small card box", "escape");
  assert.ok(f.doc.document.activeElement === f.doc.body, "the caret stayed in the small card's box");
  assert.deepEqual(calls, [], "the large card was let go of");
  assert.equal(f.ctx.miniFocused, true, "the small card stopped holding the keys");
  assert.equal(e.cancelBubble, false);
});

// ---- off on purpose, and as it was ------------------------------------------
test("letters, the bracket keys and plain arrows stay in every box", () => {
  for (const place of ["title", "small card box", "small card title", "goal editor"]) {
    for (const key of ["a", "]", "right"]) {
      const f = macPage();
      const { e, calls } = f.press(place, key);
      assert.deepEqual(calls, [], `${place} ${key}`);
      assert.equal(e.defaultPrevented, false, `${place} ${key} was taken from the box`);
      assert.equal(e.cancelBubble, true, `${place} ${key} reached the board`);
    }
  }
  for (const key of ["a", "]", "right", "down"]) {
    const f = phonePage();
    const { e, calls } = f.press("title", key);
    assert.deepEqual(calls, [], `phone title ${key}`);
    assert.equal(e.defaultPrevented, false);
    assert.equal(e.cancelBubble, true);
  }
});

test("Option chords stay in the box as they were", () => {
  const f = macPage();
  const { e, calls } = f.press("title", "a", { altKey: true });
  assert.deepEqual(calls, []);
  assert.equal(e.cancelBubble, true);
});

test("Enter and Escape in a title are still the title's own", () => {
  for (const make of [macPage, phonePage]) {
    const f = make();
    let r = f.press("title", "enter");
    assert.deepEqual(r.calls, [], "Enter reached the page");
    assert.equal(r.e.cancelBubble, true);
    assert.equal(f.a.parts.title.isContentEditable, false);
    assert.ok(f.doc.document.activeElement === f.a.parts.ta, "Enter did not drop the caret into the box");
    const g = make();
    r = g.press("title", "escape");
    assert.deepEqual(r.calls, [], "Escape let go of the card");
    assert.equal(r.e.cancelBubble, true);
    assert.equal(g.a.parts.title.textContent, "Card c1");
  }
});

test("Tab, Shift+Tab and Control+Tab in a title are left exactly to the Tab handling", () => {
  for (const make of [macPage, phonePage]) {
    for (const key of ["tab", "shift+tab", "ctrl+tab"]) {
      const f = make();
      const { e, calls } = f.press("title", key);
      assert.equal(e.cancelBubble, true, `${key} left the title`);
      assert.deepEqual(calls, []);
    }
  }
});

test("the small card answers its own set: older replies, Control + R, S and U stay off in its boxes", () => {
  for (const place of ["small card box", "small card title"]) {
    for (const key of ["ctrl+shift+up", "ctrl+r", "ctrl+s", "ctrl+u"]) {
      const f = macPage();
      const { calls } = f.press(place, key);
      assert.deepEqual(calls, [], `${place} ${key}`);
    }
  }
  // clicked with nothing typed, the older replies key steps the large card, as before
  assert.deepEqual(macPage().press("small card clicked", "ctrl+shift+up").calls, ["history c1 1"]);
});

test("the small card's box keeps its own Enter and Control + Enter", () => {
  for (const key of ["enter", "ctrl+enter"]) {
    const f = macPage();
    f.places["small card box"]();
    f.mta.value = "hello";
    const { e, calls } = f.press("small card box", key);
    assert.deepEqual(f.sent, ["hello"], key);
    assert.equal(e.cancelBubble, true, `${key} reached the board`);
    assert.deepEqual(calls, []);
  }
});

test("another panel's field keeps the card's chords: Control + S, U and the section chords", () => {
  for (const place of ["goal editor", "file editor"]) {
    for (const key of ["ctrl+s", "ctrl+u", "ctrl+shift+]"]) {
      const f = macPage();
      const { e, calls } = f.press(place, key);
      assert.deepEqual(calls, [], `${place} ${key}`);
      assert.equal(e.defaultPrevented, false, `${place} ${key}`);
    }
  }
  // and another card's title is not this card's own
  for (const key of ["ctrl+s", "ctrl+u", "ctrl+shift+]"]) {
    const f = macPage();
    assert.deepEqual(f.press("another card's title", key).calls, [], key);
  }
});

test("with the card list shut, Control + Shift + ' from the phone's title still does nothing", () => {
  const f = phonePage();
  const { e, calls } = f.press("title", "ctrl+shift+'");
  assert.deepEqual(calls, []);
  assert.equal(e.defaultPrevented, false);
});
