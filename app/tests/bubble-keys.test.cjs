// Control + Shift + W and Control + Shift + S open and cut back the card's top
// and bottom message bubbles, the grey panels of the owner's own messages: on
// top the ones the reply on the card answered (el.answ), at the foot the ones
// still waiting (el.sent, the lowest bubble there). Each key does what a press
// on that bubble's arrow does (toggleAnswered), on the Mac board and on the
// phone page. The bubbles here are built by the panel's own code and folded by
// its own run (openAnswered, in its no-motion flip), and the keys go through
// each page's real handlers (hotkey-pages.cjs). Control + S alone is still the
// response scroll, and Control + Shift + S never scrolls. No browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { macPage, phonePage } = require("./hotkey-pages.cjs");
const { dispatch } = require("./page-event-model.cjs");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const DOCS = fs.readFileSync(path.join(ROOT, "..", "docs", "board.md"), "utf8");

function event(key, modifiers = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false, isComposing: false, repeat: false, ...modifiers };
}
function recognizer() {
  const context = vm.createContext({ Date, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const resolve = vm.runInContext("cardShortcut", context);
  return (e, scope) => { const s = resolve(e, scope); return s && { action: s.action, value: s.value }; };
}

// ---- recognition ------------------------------------------------------------
const CHORD = { ctrlKey: true, shiftKey: true };

test("control shift W names the top bubble and control shift S the bottom one", () => {
  const resolve = recognizer();
  for (const [key, code, value] of [["W", "KeyW", "answered"], ["w", "KeyW", "answered"],
                                    ["S", "KeyS", "sent"], ["s", "KeyS", "sent"]]) {
    assert.deepEqual(resolve(event(key, { ...CHORD, code })), { action: "bubble", value }, key);
    for (const over of [{ metaKey: true }, { altKey: true }, { repeat: true }, { isComposing: true },
                        { defaultPrevented: true }, { ctrlKey: false }]) {
      assert.notEqual(resolve(event(key, { ...CHORD, code, ...over }))?.action, "bubble", `${key} with ${JSON.stringify(over)}`);
    }
    assert.equal(resolve(event(key, { ...CHORD, code }), "mini"), null, `the small card took ${key}`);
  }
  // a layout whose ; or ' key types the letter keeps that key for the list's sections
  for (const [code, key, value] of [["Semicolon", "S", -1], ["Quote", "W", 1]])
    assert.deepEqual(resolve(event(key, { ...CHORD, code })), { action: "drawerSection", value }, `${code} typing ${key}`);
  // control W alone is nothing, and control S alone is still only the scroll
  assert.equal(resolve(event("w", { ctrlKey: true, code: "KeyW" })), null);
  for (const key of ["s", "S"])
    assert.deepEqual(resolve(event(key, { ctrlKey: true, code: "KeyS" })), { action: "responseScroll", value: true });
  // and the scroll's own chord test still refuses shift
  const context = vm.createContext({ Date, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const chord = vm.runInContext("responseScrollChord", context);
  assert.equal(chord(event("s", { ctrlKey: true })), true);
  assert.equal(chord(event("S", CHORD)), false);
});

// ---- the bubbles on a card ----------------------------------------------------
// the panel's own builders (answeredPanel, sentBubble) make each bubble. the
// small DOM parses no markup, so the cut, the column and the arrow's strip the
// panel writes as markup are put in by hand, with the style calls the fold
// makes on them. a batch taller than its preview (more) has an arrow
function seat(f, el, { top = true, bottom = 1, whole = false } = {}) {
  const { ctx, doc } = f;
  ctx.getComputedStyle = () => ({ opacity: "1" });
  ctx.boxHasSelection = () => false;
  const style = () => ({ removeProperty() {}, setProperty() {}, getPropertyValue: () => "" });
  const dress = panel => {
    panel.classList.add("answered");
    if (!whole) panel.classList.add("more");
    const clip = doc.make("div", panel, { cls: "answclip" });
    const stack = doc.make("div", clip, { cls: "answstack" });
    panel.foot = doc.make("div", panel, { cls: "answfoot" });
    for (const node of [panel, clip, stack]) node.style = style();
    return panel;
  };
  el.answ = top ? el.answwrap.appendChild(dress(ctx.answeredPanel(null))) : null;
  el.sentwrap = doc.make("div", el.pendwrap, { cls: "sentwrap" });
  const sent = [];
  for (let i = 0; i < bottom; i++) sent.push(el.sentwrap.appendChild(dress(ctx.sentBubble(el, null))));
  el.sent = sent.at(-1) || null;
  return { top: el.answ, bottom: el.sent, sent };
}
const open = panel => !!panel && panel.classList.contains("open");
const PAGES = { mac: macPage, phone: phonePage };
const BARE = { mac: "board", phone: "card" };

for (const [where, make] of Object.entries(PAGES)) {
  for (const place of [BARE[where], "composer", "title"]) {
    test(`${where}: from the ${place === BARE[where] ? "bare card" : place}, W opens and closes the top bubble and S the bottom one`, () => {
      const f = make();
      const { top, bottom } = seat(f, f.a.el);
      let r = f.press(place, "ctrl+shift+w");
      assert.deepEqual([open(top), open(bottom)], [true, false], "W did not open the top bubble alone");
      assert.equal(r.e.defaultPrevented, true, "W was left to the browser");
      assert.deepEqual(r.calls, [], "W did something besides the bubble");
      r = f.send(r.target, "ctrl+shift+w");
      assert.deepEqual([open(top), open(bottom)], [false, false], "a second W did not close the top bubble");
      r = f.send(r.target, "ctrl+shift+s");
      assert.deepEqual([open(top), open(bottom)], [false, true], "S did not open the bottom bubble alone");
      assert.equal(r.e.defaultPrevented, true);
      assert.deepEqual(r.calls, [], "control shift S scrolled the answer");
      r = f.send(r.target, "ctrl+shift+s");
      assert.deepEqual([open(top), open(bottom)], [false, false], "a second S did not close the bottom bubble");
      assert.deepEqual(r.calls, []);
    });
  }

  test(`${where}: each key does what a click on its bubble's arrow does, and the two take turns`, () => {
    const f = make();
    const { top, bottom } = seat(f, f.a.el);
    for (const [panel, key] of [[top, "ctrl+shift+w"], [bottom, "ctrl+shift+s"]]) {
      dispatch(panel.foot, { type: "click" });
      assert.equal(open(panel), true, "the arrow's click did not open the bubble");
      f.press(BARE[where], key);
      assert.equal(open(panel), false, `${key} did not close the bubble the click opened`);
      f.press(BARE[where], key);
      assert.equal(open(panel), true, `${key} did not open the bubble`);
      dispatch(panel.foot, { type: "click" });
      assert.equal(open(panel), false, "the arrow's click did not close the bubble the key opened");
    }
  });

  test(`${where}: with no such bubble, or one shown whole, the key does nothing and is left alone`, () => {
    for (const [layout, key, why] of [[{ top: false }, "ctrl+shift+w", "no top bubble"],
                                      [{ bottom: 0 }, "ctrl+shift+s", "no bottom bubble"],
                                      [{ whole: true }, "ctrl+shift+w", "a top bubble shown whole"],
                                      [{ whole: true }, "ctrl+shift+s", "a bottom bubble shown whole"]]) {
      const f = make();
      const { top, bottom } = seat(f, f.a.el, layout);
      const { e, calls } = f.press(BARE[where], key);
      assert.deepEqual([open(top), open(bottom)], [false, false], `${key} opened a bubble with ${why}`);
      assert.equal(e.defaultPrevented, false, `${key} was cancelled with ${why}`);
      assert.deepEqual(calls, [], `${key} did something else with ${why}`);
    }
    // the other bubble stays out of it
    const f = make();
    const { bottom } = seat(f, f.a.el, { top: false });
    f.press(BARE[where], "ctrl+shift+w");
    assert.equal(open(bottom), false, "W opened the bottom bubble when there was no top one");
  });

  test(`${where}: control S alone still scrolls the answer and leaves the bubbles, control shift S never scrolls`, () => {
    const f = make();
    const { top, bottom } = seat(f, f.a.el);
    let r = f.press(BARE[where], "ctrl+s");
    assert.deepEqual(r.calls, ["scroll"], "control S no longer scrolls");
    assert.equal(r.e.defaultPrevented, true);
    assert.deepEqual([open(top), open(bottom)], [false, false], "control S opened a bubble");
    r = f.press("composer", "ctrl+s");
    assert.deepEqual(r.calls, ["scroll"], "control S no longer scrolls from the composer");
    // with no bottom bubble there is nothing for S with shift to do, and it still
    // does not scroll
    const g = make();
    seat(g, g.a.el, { bottom: 0 });
    r = g.press(BARE[where], "ctrl+shift+s");
    assert.deepEqual(r.calls, [], "control shift S scrolled the answer");
    assert.equal(r.e.defaultPrevented, false);
  });

  test(`${where}: S works the lowest of several waiting bubbles`, () => {
    const f = make();
    const { sent } = seat(f, f.a.el, { bottom: 2 });
    f.press(BARE[where], "ctrl+shift+s");
    assert.deepEqual(sent.map(open), [false, true]);
  });
}

test("mac: another panel's field, or the small card holding the keys, keeps W and S", () => {
  for (const place of ["goal editor", "file editor", "small card clicked", "small card box"]) {
    for (const key of ["ctrl+shift+w", "ctrl+shift+s"]) {
      const f = macPage();
      const { top, bottom } = seat(f, f.a.el);
      const { e } = f.press(place, key);
      assert.deepEqual([open(top), open(bottom)], [false, false], `${place} ${key}`);
      assert.equal(e.defaultPrevented, false, `${place} ${key} was cancelled`);
    }
  }
});

test("phone: with the card list or the settings out, W and S leave the card's bubbles alone", () => {
  for (const place of ["card list", "settings"]) {
    for (const key of ["ctrl+shift+w", "ctrl+shift+s"]) {
      const f = phonePage();
      const { top, bottom } = seat(f, f.a.el);
      f.press(place, key);
      assert.deepEqual([open(top), open(bottom)], [false, false], `${place} ${key}`);
    }
  }
});

test("the board's key list names both chords", () => {
  assert.match(DOCS, /\n- Control \+ Shift \+ W and Control \+ Shift \+ S: open or close the card's top and bottom message bubbles/);
});
