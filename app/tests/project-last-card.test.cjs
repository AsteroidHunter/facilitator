// Switching to a project, by its number key or by a click on its row or faint
// name, shows the card that was on screen the last time that project was open.
// The real setTab, chooseProject, select, browse and the shortcut listener run in
// a VM; painting is stubbed, no browser. A card can be on screen without
// select() having run (the one saved in "selbox" when the page loads, or the
// pick applySelection makes), so those visits are covered too.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const logic = readFileSync(path.join(root, "card-logic.js"), "utf8");
function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
function fixture() {
  const listeners = [], store = new Map();
  const els = {};
  for (const id of ["a1", "a2", "a3", "b1", "b2", "c1"])
    els[id] = { box: { classList: { toggle() {}, remove() {} } }, toc: { classList: { toggle() {}, remove() {} } }, tick() {} };
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, els,
    FOCUS: true, homeOpen: false, pageWarn: null, pageMenu: null, setOpen: false,
    LOCKED: null, ownerReady: true, draft: false, tabDrag: null, hist: null,
    activeOwner: "alpha", selectedId: null, shownId: null, browsing: false,
    lastSel: {}, validActiveOwnerIds: new Set(["alpha", "beta", "gamma"]),
    lastState: { boxes: [
      { id: "a1", owner: "alpha" }, { id: "a2", owner: "alpha" }, { id: "a3", owner: "alpha" },
      { id: "b1", owner: "beta" }, { id: "b2", owner: "beta" }, { id: "c1", owner: "gamma" }],
      projects: [], tabs: { order: ["alpha", "beta", "gamma"], closed: [] } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) },
    document: { querySelectorAll: () => [], querySelector: () => null },
    addEventListener(type, fn) { if (type === "keydown") listeners.push(fn); },
    listenResponseScroll() {},
    setHome(on) { context.homeOpen = on; },
    setBrowsing(on) { context.browsing = !!on; },
    endDraft() { context.draft = false; },
    cancelAutoNext() {}, cardTabAfresh() {}, histExit() {}, markSeen() {}, renderTabs() {},
    wearShownEditor() {}, openAtHead() {}, syncDesktopHistoryAvailability() {}, updatePwd() {},
    scrollTo() {}, snapCard() {}, requestAnimationFrame() {}, magicSync() {},
    applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {}, apply() {},
    boardFadeTake() { return null; }, boardFadeLand() {},
    closeProjMenu() {}, deselect() { context.selectedId = null; context.shownId = null; },
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  run(between("function setTab(owner){", "// clear the selection entirely:"));
  run(between("function tabClosed(ow, st){", "// ---- the one-time carry-over"));
  run(between("function select(id, opts){", "// the arrow keys and a tab switch:"));
  run(between("function browse(id){", "// the browsed card on screen becomes"));
  run(between("function rowsOf(state){", "function nav("));
  run(between("function onBoardPage(state){", "async function addPage(){"));
  run(between("const boardShortcutTyping =", "// releases, other keys"));
  run(between("function chooseProject(ow){", "function projOpen(){"));
  return {
    context,
    // the card on screen because the reader chose or browsed it
    visitBySelect(owner, id) { context.setTab(owner); context.select(id, { browse: true }); },
    // the card on screen with select() never run for it: the saved selection
    // after a load, or the pick applySelection makes
    visitUnrecorded(owner, id) { context.setTab(owner); context.selectedId = id; context.shownId = id; },
    click(owner) { context.chooseProject(owner); },
    key(number) {
      const e = { key: String(number), metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
        target: { closest: () => null }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      for (const listener of listeners) listener(e);
      return e;
    },
  };
}

const visits = { "select()": "visitBySelect", "a card put on screen without select()": "visitUnrecorded" };
const returns = { "its number": (f, owner) => f.key(1), "a click": (f, owner) => f.click(owner) };
for (const [how, visit] of Object.entries(visits)) {
  for (const [back, go] of Object.entries(returns)) {
    test(`project A on card a3 (by ${how}), away to B, back by ${back}, lands on a3`, () => {
      const f = fixture();
      f[visit]("alpha", "a3");
      f.key(2);
      assert.equal(f.context.activeOwner, "beta");
      go(f, "alpha");
      assert.equal(f.context.activeOwner, "alpha");
      assert.equal(f.context.selectedId, "a3");
    });
  }
}

test("each project keeps its own last card through several switches by number and by click", () => {
  const f = fixture();
  f.visitUnrecorded("alpha", "a2");
  f.key(2); f.context.select("b2", { browse: true });
  f.click("gamma");
  f.key(1);
  assert.equal(f.context.selectedId, "a2");
  f.click("beta");
  assert.equal(f.context.selectedId, "b2");
  f.key(3);
  assert.equal(f.context.selectedId, "c1");
});

test("a project never visited opens as it did before", () => {
  const f = fixture();
  f.visitUnrecorded("alpha", "a3");
  f.key(2);
  // no remembered card and none awaiting the reader: the lane's first card
  assert.equal(f.context.selectedId, "b1");
  assert.equal(f.context.lastSel.gamma, undefined);
});

test("leaving with no card on screen, or one from another project, remembers nothing wrong", () => {
  const f = fixture();
  f.context.selectedId = "b2";   // a card of another lane while alpha is open
  f.key(2);
  assert.equal(f.context.lastSel.alpha, undefined);
  const g = fixture();
  g.context.selectedId = null;
  g.key(2);
  assert.equal(g.context.lastSel.alpha, undefined);
});
