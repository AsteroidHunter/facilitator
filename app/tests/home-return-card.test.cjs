// Going to the home page and coming back to the project lands on the card that
// was on screen. Run the real setTab of the board and of the phone, with the
// real pickInRow, in a VM; painting is stubbed, no browser. BOARD_RETURN_SOURCE
// and PHONE_RETURN_SOURCE point a run at an older copy of index.html or m.html.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const logic = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const board = readFileSync(process.env.BOARD_RETURN_SOURCE || path.join(ROOT, "index.html"), "utf8");
const phone = readFileSync(process.env.PHONE_RETURN_SOURCE || path.join(ROOT, "m.html"), "utf8");

function between(html, start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source block ${start}`);
  return html.slice(a, b);
}

// alpha: a1 is the card the page would pick on its own (it awaits a reply), a2
// and a3 are quiet. beta has b1 and b2. "q" is the question card, never kept.
const boxes = [
  { id: "a1", owner: "alpha", state: "yours" }, { id: "a2", owner: "alpha" }, { id: "a3", owner: "alpha" },
  { id: "b1", owner: "beta" }, { id: "b2", owner: "beta" }, { id: "q", owner: "alpha" },
].map(b => ({ replies: 0, ...b }));

function fixture(kind, { selected, lastSel = {}, home = true, owner = "alpha" } = {}) {
  const store = new Map(), calls = [];
  const context = vm.createContext({
    Date, setTimeout, clearTimeout,
    selectedId: selected, activeOwner: owner, homeOpen: home, lastSel: { ...lastSel },
    lastState: { boxes, projects: [], tabs: { order: ["alpha", "beta"], closed: [] } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    browse(id) { context.selectedId = id; calls.push(["browse", id]); },
    deselect() { context.selectedId = null; calls.push(["deselect"]); },
    apply() {},
  });
  vm.runInContext(logic, context);
  if (kind === "board") {
    Object.assign(context, {
      LOCKED: null, ownerReady: true, draft: false, projLeft: "",
      validActiveOwnerIds: new Set(["alpha", "beta"]),
      setHome(on) { context.homeOpen = on; },
      endDraft() {}, applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {},
    });
    vm.runInContext(between(board, "function setTab(owner){", "// clear the selection entirely:"), context);
  } else {
    Object.assign(context, {
      macHost: null, validOwners: new Set(["alpha", "beta"]), tracePhone() {}, endPhoneTrace() {},
    });
    vm.runInContext(between(phone, "function setTab(owner){", "// the board's tabs, in the board's order"), context);
    // the phone leaves home before choosing the project (chooseRow)
    const raw = context.setTab;
    context.setTab = owner => { context.homeOpen = false; raw(owner); };
  }
  return { context, calls };
}

for (const kind of ["board", "phone"]) {
  test(`${kind}: coming back from home lands on the card that was on screen, though nothing recorded it`, () => {
    // a page just loaded: the card on screen came from the saved session, not from select()
    const f = fixture(kind, { selected: "a3" });
    f.context.setTab("alpha");
    assert.equal(f.context.selectedId, "a3");
    assert.equal(f.context.lastSel.alpha, "a3");
  });

  test(`${kind}: a stale record gives way to the card that was on screen`, () => {
    const f = fixture(kind, { selected: "a3", lastSel: { alpha: "a1" } });
    f.context.setTab("alpha");
    assert.equal(f.context.selectedId, "a3");
    assert.equal(f.context.lastSel.alpha, "a3");
  });

  test(`${kind}: a card chosen before going home is the one found after`, () => {
    const f = fixture(kind, { selected: "a2", lastSel: { alpha: "a2" } });
    f.context.setTab("alpha");
    assert.equal(f.context.selectedId, "a2");
  });

  test(`${kind}: two projects keep a card each when switched directly`, () => {
    const f = fixture(kind, { selected: "a3", home: false, lastSel: { beta: "b2" } });
    f.context.setTab("beta");
    assert.equal(f.context.selectedId, "b2");
    assert.equal(f.context.lastSel.alpha, "a3");
    f.context.setTab("alpha");
    assert.equal(f.context.selectedId, "a3");
  });

  test(`${kind}: a card of another project on screen is not recorded for this one`, () => {
    const f = fixture(kind, { selected: "b1", lastSel: { alpha: "a2" } });
    f.context.setTab("alpha");
    assert.equal(f.context.lastSel.alpha, "a2");
    assert.equal(f.context.selectedId, "a2");
  });

  test(`${kind}: the question card is never recorded`, () => {
    const f = fixture(kind, { selected: "q", lastSel: {} });
    f.context.setTab("alpha");
    assert.equal(f.context.lastSel.alpha, undefined);
    assert.equal(f.context.selectedId, "a1");
  });

  test(`${kind}: with no card on screen the project opens on its usual pick`, () => {
    const f = fixture(kind, { selected: null });
    f.context.setTab("alpha");
    assert.equal(f.context.selectedId, "a1");
  });
}
