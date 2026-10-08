// With the phone's card list out, a chord the list does not answer itself does
// what it does with the list shut (the list's keydown listener in m.html hands
// it to the page's own action table). Five such keys used to do nothing there:
// Command + T, Control + Shift + up and down, Control + Enter, Control + R and
// Control + U. The list's own keys, its plain keys and the settings drawer
// are as they were. The page's real listeners run in a VM (hotkey-pages.cjs);
// no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { phonePage } = require("./hotkey-pages.cjs");

const FIXED = [
  ["cmd+t", ["create"]],
  ["ctrl+shift+up", ["history c1 1"]],
  ["ctrl+enter", ["advance c1"]],
  ["ctrl+r", ["browse c2", "ticket in view c2"]],
  ["ctrl+u", ["fetch /testing?box=c1 POST"]],
];

test("the five chords the list has no entry for do what they do with the list shut, once", () => {
  for (const place of ["card list", "card list button"]) {
    for (const [key, want] of FIXED) {
      const f = phonePage();
      const { e, calls } = f.press(place, key);
      assert.deepEqual(calls, want, `${place} ${key}`);
      assert.equal(e.defaultPrevented, true, `${place} ${key}`);
      // and with the list shut the same key does the same
      const g = phonePage();
      assert.deepEqual(g.press("card", key).calls.filter(c => !c.startsWith("ticket")), want.filter(c => !c.startsWith("ticket")), `${key} with the list shut`);
    }
  }
});

test("the list stays out for the keys that do not leave the card list", () => {
  for (const key of ["ctrl+shift+up", "ctrl+enter", "ctrl+r", "ctrl+u"]) {
    const f = phonePage();
    f.press("card list", key);
    assert.equal(f.ctx.drawerOpen(), true, key);
  }
  // Command + T opens the new card, which the list goes down for, as it does with a tap
  const f = phonePage();
  f.press("card list", "cmd+t");
  assert.equal(f.ctx.drawerOpen(), false);
});

test("the list's own keys answer as they did", () => {
  const cases = [
    ["cmd+2", ["tab two"]],
    ["ctrl+shift+right", ["navigate 1", "ticket in view c1"]],
    ["ctrl+s", ["scroll"]],
    ["ctrl+shift+]", ["section c1 docked"]],
    ["ctrl+shift+'", ["view docked"]],
    ["down", ["browse c2", "ticket in view c2"]],
    ["escape", ["hide"]],
    ["ctrl+shift+,", ["hide"]],
  ];
  for (const [key, want] of cases) {
    const f = phonePage();
    const { calls } = f.press("card list", key);
    assert.deepEqual(calls, want, key);
  }
});

test("plain left, right and the bracket keys still do not reach the card with the list out", () => {
  for (const key of ["right", "]"]) {
    const f = phonePage();
    const { e, calls } = f.press("card list", key);
    assert.deepEqual(calls, [], key);
    assert.equal(e.defaultPrevented, false, key);
  }
});

test("the settings drawer keeps every key, the five included", () => {
  for (const place of ["settings", "settings field"]) {
    for (const key of ["cmd+t", "ctrl+shift+up", "ctrl+enter", "ctrl+r", "ctrl+u", "cmd+2", "ctrl+shift+]", "ctrl+s"]) {
      const f = phonePage();
      const { calls } = f.press(place, key);
      assert.deepEqual(calls, [], `${place} ${key}`);
    }
  }
});

test("the home page has no card list and keeps the card keys off", () => {
  for (const key of ["cmd+t", "ctrl+shift+up", "ctrl+enter", "ctrl+r", "ctrl+u"]) {
    const f = phonePage();
    assert.deepEqual(f.press("home", key).calls, [], key);
  }
  assert.deepEqual(phonePage().press("home", "cmd+2").calls, ["tab two"]);
});
