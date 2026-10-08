// Control + S scrolls the card's answer from a focused button as it does from
// the page: Chrome focuses a button it clicks, and the hotkey map found the key
// dead after a click on a card's sun, cloud, moon, cross or history arrow, a
// project tab, a list section name, a page dot or the speaker, and on the phone
// after Tab reached a card button. responseScrollSource in card-logic.js treats
// a focused element that is not a field as the page, unless it sits in the sent
// box, the answered panel, another card or a panel the page names (keyPanels).
// The pages' real handlers run in a VM (hotkey-pages.cjs); no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { macPage, phonePage } = require("./hotkey-pages.cjs");

// focus a node as a click or Tab leaves it, press Control + S there
function controlS(f, node) {
  node.focus();
  return f.send(node, "ctrl+s");
}
const scrolled = f => vm.runInContext("responseScrolling && responseScrolling.el", f.ctx);

test("Mac: a focused button on the card takes Control + S, as the page does", () => {
  for (const name of ["sun", "dock", "arc", "x", "histUp"]) {
    const f = macPage();
    const { e, calls } = controlS(f, f.a.parts[name]);
    assert.deepEqual(calls, ["scroll"], name);
    assert.equal(e.defaultPrevented, true, name);
    assert.ok(scrolled(f) === f.a.el, `${name} scrolled something other than the card's answer`);
  }
});

test("Mac: a focused button outside the card takes it too: project tab, section name, page dot, speaker", () => {
  for (const place of ["project tab", "section name", "page dot", "speaker"]) {
    const f = macPage();
    const { e, calls } = f.press(place, "ctrl+s");
    assert.deepEqual(calls, ["scroll"], place);
    assert.equal(e.defaultPrevented, true, place);
  }
});

test("phone: a card button reached by Tab takes Control + S", () => {
  for (const name of ["sun", "dock", "arc", "x", "histUp"]) {
    const f = phonePage();
    const { e, calls } = controlS(f, f.a.parts[name]);
    assert.deepEqual(calls, ["scroll"], name);
    assert.equal(e.defaultPrevented, true, name);
  }
});

test("the copy button in the answer and the page itself take it as before", () => {
  for (const make of [macPage, phonePage]) {
    const f = make();
    assert.deepEqual(f.press("copy button", "ctrl+s").calls, ["scroll"]);
    const g = make();
    assert.deepEqual(g.press(make === macPage ? "board" : "card", "ctrl+s").calls, ["scroll"]);
  }
});

// ---- off on purpose, and as it was ------------------------------------------
test("the sent box, the answered panel and another card keep the chord, on both pages", () => {
  for (const make of [macPage, phonePage]) {
    for (const place of ["sent box button", "answered panel button", "another card's button"]) {
      const f = make();
      const { e, calls } = f.press(place, "ctrl+s");
      assert.deepEqual(calls, [], place);
      assert.equal(e.defaultPrevented, false, place);
    }
  }
});

test("Mac: a file navigator row, like the panels' fields, keeps the chord (map: e)", () => {
  for (const place of ["navigator row", "file editor"]) {
    const f = macPage();
    const { e, calls } = f.press(place, "ctrl+s");
    assert.deepEqual(calls, [], place);
    assert.equal(e.defaultPrevented, false, place);
  }
  // and a button on the small card, which answers its own keys
  const f = macPage();
  const chip = f.ctx.miniEls.m1.sun;
  assert.deepEqual(controlS(f, chip).calls, []);
});

test("Mac: a button under the settings page, a page menu, the delete question or Home does not reach the card (map: c, b)", () => {
  const blockers = {
    settings: f => { f.ctx.setOpen = true; },
    "page menu": f => { f.ctx.pageMenu = {}; },
    "delete question": f => { f.ctx.pageWarn = {}; },
    home: f => { f.ctx.homeOpen = true; },
    "small card holding the keys": f => { f.ctx.miniFocused = true; },
  };
  for (const [name, block] of Object.entries(blockers)) {
    for (const place of ["card button", "project tab"]) {
      const f = macPage();
      block(f);
      assert.deepEqual(f.press(place, "ctrl+s").calls, [], `${name}: ${place}`);
    }
  }
});

test("phone: with the card list out a focused list button scrolls the list, not the card; the settings take nothing", () => {
  const f = phonePage();
  const { calls } = f.press("card list button", "ctrl+s");
  assert.deepEqual(calls, ["scroll"]);
  assert.ok(scrolled(f) !== f.a.el, "the card behind the list scrolled");
  const g = phonePage();
  assert.deepEqual(g.press("settings", "ctrl+s").calls, []);
});
