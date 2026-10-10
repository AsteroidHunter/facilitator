// Run the desktop's real shortcut listener, project choice (a row of the pill's
// list or a faint name), ordering and setTab in a VM. Painting, card selection
// and Home rendering are stubbed; no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const html = readFileSync(process.env.BOARD_HOTKEY_SOURCE || path.join(root, "index.html"), "utf8");
const logic = readFileSync(path.join(root, "card-logic.js"), "utf8");
function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}
function fixture(overrides = {}) {
  const listeners = [], calls = [], store = new Map();
  const context = vm.createContext({
    Date, setTimeout, clearTimeout,
    FOCUS: true, homeOpen: true, pageWarn: null, pageMenu: null, setOpen: false,
    LOCKED: null, ownerReady: true, draft: false, tabDrag: null,
    activeOwner: "alpha", selectedId: "a1", browsing: false,
    lastSel: { alpha: "a1", beta: "b2" }, validActiveOwnerIds: new Set(["alpha", "beta", "hidden", "empty"]),
    lastState: { boxes: [{ id: "a1", owner: "alpha" }, { id: "b1", owner: "beta" },
      { id: "b2", owner: "beta", parked: true }, { id: "h1", owner: "hidden" }],
      projects: [{ id: "empty" }], tabs: { order: ["alpha", "hidden", "beta", "empty"], closed: ["hidden"] } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    addEventListener(type, fn) { if (type === "keydown") listeners.push(fn); },
    listenResponseScroll() {},
    setHome(on) { context.homeOpen = on; },
    browse(id) { context.selectedId = id; context.browsing = true; },
    deselect() { context.selectedId = null; context.browsing = false; },
    unselectShown() { context.browsing = true; calls.push("unselect"); },
    endDraft() { context.draft = false; calls.push("end-draft"); },
    applySavedLayout() { calls.push("layout"); }, panelPoll() { calls.push("panel"); },
    chatPoll() { calls.push("chat"); }, fileNavPoll() { calls.push("files"); },
    apply() { calls.push("apply"); }, closeProjMenu() {},
    ...overrides,
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  run(between("function setTab(owner){", "// clear the selection entirely:"));
  run(between("function tabClosed(ow, st){", "// ---- the one-time carry-over"));
  run(between("function rowsOf(state){", "function nav("));
  run(between("function onBoardPage(state){", "async function addPage(){"));
  run(between("const boardShortcutTyping =", "// releases, other keys"));
  run(between("function chooseProject(ow){", "function projOpen(){"));
  return { context,
    snapshot: () => ({ home: context.homeOpen, owner: context.activeOwner, selected: context.selectedId,
      browsing: context.browsing, stored: store.get("activeproj"), calls: [...calls] }),
    // a click on the project's row in the pill's list, or on its faint name
    click(owner) { context.chooseProject(owner); },
    key(key, extra = {}) {
      const e = { key, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
        target: { closest: () => null }, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (const listener of listeners) listener(e);
      return e;
    },
  };
}

for (const [number, owner, selected] of [["1", "alpha", "a1"], ["2", "beta", "b2"], ["3", "empty", null]]) {
  test(`Command+${number} on Mac Home opens ${owner} exactly like its tab`, () => {
    const key = fixture(), click = fixture();
    click.click(owner);
    assert.equal(key.key(number).defaultPrevented, true);
    assert.deepEqual(key.snapshot(), click.snapshot());
    assert.equal(key.snapshot().home, false);
    assert.equal(key.snapshot().owner, owner);
    assert.equal(key.snapshot().selected, selected);
  });
}

test("Mac project shortcuts keep their existing order and selection outside Home", () => {
  const f = fixture({ homeOpen: false });
  assert.equal(f.key("1").defaultPrevented, true);
  assert.equal(f.snapshot().browsing, true);
  assert.equal(f.snapshot().selected, "a1");
  assert.equal(f.key("2").defaultPrevented, true);
  assert.equal(f.snapshot().owner, "beta");
  assert.equal(f.snapshot().selected, "b2");
  assert.equal(f.key("3").defaultPrevented, true);
  assert.equal(f.snapshot().selected, null);
});

test("Mac Home preserves modal and focus guards and ignores unavailable numbers", () => {
  for (const overrides of [{ pageWarn: {} }, { pageMenu: {} }, { setOpen: true },
    { FOCUS: false }, { lastState: null }]) {
    const f = fixture(overrides), before = f.snapshot();
    assert.equal(f.key("2").defaultPrevented, false);
    assert.deepEqual(f.snapshot(), before);
  }
  for (const key of ["0", "9", "t", "ArrowLeft", "Escape", "`"]) {
    const f = fixture(), before = f.snapshot();
    assert.equal(f.key(key).defaultPrevented, false);
    assert.deepEqual(f.snapshot(), before);
  }
  const loading = fixture({ ownerReady: false }), before = loading.snapshot();
  loading.key("2");
  assert.deepEqual(loading.snapshot(), before);
});

test("Mac Home opens projects above a remembered blank page, which keeps the project keys and no card keys", () => {
  const f = fixture();
  f.context.lastState.pages = { alpha: [{ id: "blank", kind: "blank" }] };
  f.context.curPage = () => ({ kind: "blank" });
  assert.equal(f.key("2").defaultPrevented, true);
  assert.equal(f.snapshot().home, false);
  // the blank page chooses a project as Home does
  assert.equal(f.key("1").defaultPrevented, true);
  assert.equal(f.snapshot().owner, "alpha");
  const before = f.snapshot();
  for (const key of ["t", "ArrowLeft", "0"]) assert.equal(f.key(key).defaultPrevented, false, key);
  assert.deepEqual(f.snapshot(), before);
});

test("Mac Home respects a locked project and closes an unfinished draft through setTab", () => {
  const f = fixture({ LOCKED: "beta", draft: true });
  assert.equal(f.key("2").defaultPrevented, false);
  assert.equal(f.key("1").defaultPrevented, true);
  assert.equal(f.snapshot().home, false);
  assert.equal(f.snapshot().owner, "beta");
  assert.equal(f.context.draft, false);
});

// Command + ` is the house's click, matched by the physical key
function homeFixture(overrides = {}) {
  const clicks = [];
  const f = fixture({ homeOpen: false, document: { getElementById: id => ({ click() { clicks.push(id); } }) }, ...overrides });
  return { f, clicks };
}
const cmdBackquote = (extra = {}) => ({ key: "`", code: "Backquote", metaKey: true, ctrlKey: false, ...extra });

test("Command+` clicks the house, on any layout, and types nothing", () => {
  for (const extra of [{}, { key: "²" }, { key: "Dead" }, { key: "<", code: "Backquote" },
    { target: { closest: () => ({}) } }]) {
    const { f, clicks } = homeFixture();
    assert.equal(f.key("`", cmdBackquote(extra)).defaultPrevented, true);
    assert.deepEqual(clicks, ["homeico"]);
  }
});

test("Command+` on the home page does nothing but is still kept from the page", () => {
  const { f, clicks } = homeFixture({ homeOpen: true });
  assert.equal(f.key("`", cmdBackquote()).defaultPrevented, true);
  assert.deepEqual(clicks, []);
});

test("Command+` needs Command and the Backquote key; Control alone and with Command, and Option, do nothing", () => {
  for (const extra of [{ metaKey: false }, { metaKey: false, ctrlKey: true }, { ctrlKey: true }, { altKey: true },
    { code: "Digit1" }, { code: undefined }]) {
    const { f, clicks } = homeFixture();
    assert.equal(f.key("`", cmdBackquote(extra)).defaultPrevented, false, JSON.stringify(extra));
    assert.deepEqual(clicks, []);
  }
});

test("Command+` keeps the same guards as the project keys", () => {
  for (const overrides of [{ pageWarn: {} }, { pageMenu: {} }, { setOpen: true }, { FOCUS: false }]) {
    const { f, clicks } = homeFixture(overrides);
    assert.equal(f.key("`", cmdBackquote()).defaultPrevented, false);
    assert.deepEqual(clicks, []);
  }
});

test("Command+` opens Home from a blank page too", () => {
  const { f, clicks } = homeFixture();
  f.context.lastState.pages = { alpha: [{ id: "blank", kind: "blank" }] };
  f.context.curPage = () => ({ kind: "blank" });
  assert.equal(f.key("`", cmdBackquote()).defaultPrevented, true);
  assert.deepEqual(clicks, ["homeico"]);
});
