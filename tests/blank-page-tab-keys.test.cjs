// Command + 1 to 9 choose a project from the Mac board's blank page and from
// the new project page, as they do from Home. Both pages have no card, so the
// board's other keys stay off there, and the settings page, the page menus and
// the delete question keep even the project keys. The board's real keydown
// listener runs in a VM (hotkey-pages.cjs); no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage } = require("./hotkey-pages.cjs");

const PAGES = ["blank", "new project"];
const CARD_KEYS = ["cmd+t", "ctrl+shift+right", "right", "ctrl+shift+up", "escape", "enter", "ctrl+enter",
  "ctrl+r", "ctrl+s", "ctrl+u", "ctrl+shift+]", "]"];

test("Command + number chooses a project on a blank page and on the new project page", () => {
  for (const page of PAGES) {
    for (const [digit, owner] of [["1", "one"], ["2", "two"], ["3", "three"]]) {
      const f = macPage({ page });
      const { e, calls } = f.press("board", "cmd+2", { key: digit, code: "Digit" + digit });
      assert.deepEqual(calls, [`tab ${owner}`], `${page} command+${digit}`);
      assert.equal(e.defaultPrevented, true);
    }
    // a number with no project behind it is left alone
    const f = macPage({ page });
    const { e, calls } = f.press("board", "cmd+2", { key: "9", code: "Digit9" });
    assert.deepEqual(calls, []);
    assert.equal(e.defaultPrevented, false);
  }
});

test("the card keys stay off where there is no card", () => {
  for (const page of PAGES) {
    for (const key of CARD_KEYS) {
      const f = macPage({ page });
      const { calls } = f.press("board", key);
      assert.deepEqual(calls, [], `${page} ${key}`);
    }
  }
});

test("the settings page, a page menu and the delete question keep even the project keys", () => {
  const over = { settings: { setOpen: true }, "page menu": { pageMenu: {} }, "delete question": { pageWarn: {} } };
  for (const page of ["board", ...PAGES]) {
    for (const [name, state] of Object.entries(over)) {
      const f = macPage({ page });
      Object.assign(f.ctx, state);
      const { e, calls } = f.press("board", "cmd+2");
      assert.deepEqual(calls, [], `${name} over the ${page} page`);
      assert.equal(e.defaultPrevented, false);
    }
  }
});

test("Home is as it was: the project keys and nothing else", () => {
  const f = macPage();
  f.ctx.homeOpen = true;
  assert.deepEqual(f.press("board", "cmd+2").calls, ["tab two"]);
  for (const key of CARD_KEYS) {
    const g = macPage();
    g.ctx.homeOpen = true;
    assert.deepEqual(g.press("board", key).calls, [], key);
  }
});

test("the board with cards keeps every key it had", () => {
  for (const [key, want] of [["cmd+2", ["tab two"]], ["cmd+t", ["create one"]], ["ctrl+r", ["random c2"]]]) {
    const f = macPage();
    assert.deepEqual(f.press("board", key).calls, want, key);
  }
});
