// Control + Shift + ' and ; step the board's ticket list to the next or previous
// section, as they do the phone's card list. The Mac page's own key handlers and
// its setView are cut out of index.html as shipped (see hotkey-pages.cjs) and run
// over card-logic.js as shipped; only the drawing of the list is a spy. No
// browser, no board, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage, between } = require("./hotkey-pages.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const VIEWS = ["todo", "docked", "deferred", "done"];
const NEXT = "ctrl+shift+'", PREVIOUS = "ctrl+shift+;";

// the Mac page with its list on show at `view`
function board(view = "todo") {
  const f = macPage(), drawn = [];
  Object.assign(f.ctx, {
    cancelAutoNext() {}, paintViewTabs() {}, apply() {},
    moveTicketSheet: (v, animate) => drawn.push([v, animate]),
  });
  vm.runInContext(between(MAC, "function setView(v){", '{\n  document.getElementById("tv-todo")'), f.ctx);
  f.ctx.setTicketViewOf("one", view);
  f.drawn = drawn;
  f.view = () => f.ctx.curView();
  return f;
}

test("next and previous step through the four sections, as a tap on a name does", () => {
  for (const [key, step] of [[NEXT, 1], [PREVIOUS, -1]]) {
    for (const start of VIEWS) {
      const target = VIEWS[VIEWS.indexOf(start) + step];
      if (!target) continue;
      const keyed = board(start), tapped = board(start);
      const { e } = keyed.press("board", key);
      tapped.ctx.setView(target);
      assert.equal(e.defaultPrevented, true, `${start} ${key}`);
      assert.equal(keyed.view(), target, `${start} ${key}`);
      assert.deepEqual(keyed.drawn, tapped.drawn, `${start} ${key} travels as a tap does`);
      assert.deepEqual(keyed.drawn, [[target, true]]);
    }
  }
});

test("three presses cross the whole list and three of the other bring it back", () => {
  const f = board("todo"), seen = [];
  for (let i = 0; i < 3; i++) { f.press("board", NEXT); seen.push(f.view()); }
  for (let i = 0; i < 3; i++) { f.press("board", PREVIOUS); seen.push(f.view()); }
  assert.deepEqual(seen, ["docked", "deferred", "done", "deferred", "docked", "todo"]);
});

test("at Doing the previous key and at Done the next key do nothing and never wrap", () => {
  for (const [start, key] of [["todo", PREVIOUS], ["done", NEXT]]) {
    const f = board(start);
    for (let i = 0; i < 3; i++) {
      const { e } = f.press("board", key);
      assert.equal(e.defaultPrevented, true, "the key is taken, as the faded name still takes its click");
    }
    assert.equal(f.view(), start);
    assert.deepEqual(f.drawn, []);
  }
});

test("the keys step the list from nothing focused, the reply box and the title", () => {
  for (const place of ["board", "composer", "title"]) {
    for (const [key, to] of [[NEXT, "deferred"], [PREVIOUS, "todo"]]) {
      const f = board("docked");
      const { e } = f.press(place, key);
      assert.equal(f.view(), to, `${place} ${key}`);
      assert.equal(e.defaultPrevented, true, `${place} ${key} was left to the box`);
    }
  }
});

test("a button focused on the card, the small card clicked into and no card selected still step the list", () => {
  for (const place of ["card button", "small card clicked"]) {
    const f = board("docked");
    f.press(place, NEXT);
    assert.equal(f.view(), "deferred", place);
  }
  const f = board("todo");
  f.ctx.selectedId = null;
  f.press("board", NEXT);
  assert.equal(f.view(), "docked");
});

test("a box that is not the card's own keeps the keys", () => {
  for (const place of ["small card box", "small card title", "goal editor", "file editor", "another card's title"]) {
    for (const key of [NEXT, PREVIOUS]) {
      const f = board("docked");
      const { e } = f.press(place, key);
      assert.equal(f.view(), "docked", `${place} ${key}`);
      assert.equal(e.defaultPrevented, false, `${place} ${key} was taken from the box`);
      assert.deepEqual(f.drawn, []);
    }
  }
});

test("with the list put away the keys do nothing and are not taken", () => {
  for (const place of ["board", "composer", "title"]) {
    for (const key of [NEXT, PREVIOUS]) {
      const f = board("docked");
      f.doc.byId("tickets").classList.add("region-off");
      const { e } = f.press(place, key);
      assert.equal(f.view(), "docked", `${place} ${key}`);
      assert.equal(e.defaultPrevented, false, `${place} ${key}`);
      assert.deepEqual(f.drawn, []);
    }
  }
  // and the same press steps it once the list is back
  const f = board("docked");
  f.doc.byId("tickets").classList.add("region-off");
  f.press("board", NEXT);
  f.doc.byId("tickets").classList.remove("region-off");
  f.press("board", NEXT);
  assert.equal(f.view(), "deferred");
});

test("an open picture, a new tab choosing its folder, a blank page and the settings leave the list alone", () => {
  const held = {
    picture: f => { f.ctx.p3Zoom = {}; },
    "new tab": f => { f.ctx.draft = { screen: "home", from: "one" }; },
    settings: f => { f.ctx.setOpen = true; },
    "home page": f => { f.ctx.homeOpen = true; },
  };
  for (const [name, hold] of Object.entries(held)) {
    const f = board("docked");
    hold(f);
    const { e } = f.press("board", NEXT);
    assert.equal(f.view(), "docked", name);
    assert.equal(e.defaultPrevented, false, name);
  }
  const blank = macPage({ page: "blank" });
  assert.equal(blank.press("board", NEXT).e.defaultPrevented, false, "blank page");
});

test("Command, Option, a missing modifier or a repeat is nothing", () => {
  for (const over of [{ metaKey: true }, { altKey: true }, { repeat: true }, { shiftKey: false }, { ctrlKey: false }]) {
    for (const key of [NEXT, PREVIOUS]) {
      const f = board("docked");
      const { e } = f.press("board", key, over);
      assert.equal(f.view(), "docked", `${key} with ${Object.keys(over)}`);
      assert.equal(e.defaultPrevented, false);
    }
  }
});

test("each project keeps its own section, and the section chords and other keys are as they were", () => {
  const f = board("todo");
  f.press("board", NEXT);
  assert.equal(f.ctx.ticketViewOf("one"), "docked");
  assert.equal(f.ctx.ticketViewOf("two"), "todo");
  const chord = f.press("board", "ctrl+shift+]");
  assert.deepEqual(chord.calls, ["section c1 docked"]);
  assert.equal(f.view(), "docked", "a section chord moves the card, not the list");
  assert.deepEqual(f.press("board", "ctrl+shift+,").calls, []);
});

test("the table entry and the Mac action are the same ones the phone uses", () => {
  const f = board();
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.cardShortcut({ key: "\"", code: "Quote", ctrlKey: true, shiftKey: true,
    metaKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false }))), { action: "drawerSection", value: 1 });
  assert.match(MAC, /drawerSection\(e, shortcut\)\{/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8"), /Only the phone's list answers them/);
});
