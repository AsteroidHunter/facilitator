// The onboarding's sample project, marked sample on its record by the board
// (_sample_lane in server.py), is left out of every list of projects in one
// place, allRowsOf in card-logic.js, and neither page will open it. The shared
// code, the phone's project list (m.html renderTabs) and both pages' check of
// the project to open (validateActiveOwner in index.html, validateOwners in
// m.html) run in a VM on small fakes. No browser starts.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(root, "card-logic.js"), "utf8");
const MAC = readFileSync(path.join(root, "index.html"), "utf8");
const PHONE = readFileSync(path.join(root, "m.html"), "utf8");
function between(page, start, end) {
  const a = page.indexOf(start), b = page.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return page.slice(a, b);
}

// a board with the sample project beside three ordinary ones and the quick chat
// lane: the sample has a card, a folder, an unread reply and the first place in
// the board's saved order
function board({ mark = true } = {}) {
  const lanes = ["facilitator-sample", "orchard", "quarry", "rookery"];
  const card = (id, owner, extra = {}) => ({ id, owner, bucket: "must", title: id, ball: "you", replies: 0, ts: 1, agentTs: 0, ...extra });
  return {
    boxes: [card("s1", "facilitator-sample", { replies: 1, agentTs: 2 }), card("o1", "orchard"), card("c1", "qchat"), card("q1", "quarry")],
    projects: lanes.map(ow => ({ id: ow, name: ow, dir: "/Users/me/" + ow, ...(mark && ow === "facilitator-sample" ? { sample: true } : {}) })),
    pwds: { facilitator: "/Users/me/board", qchat: "/Users/me/board", ...Object.fromEntries(lanes.map(ow => [ow, "/Users/me/" + ow])) },
    tabs: { order: ["facilitator-sample", "rookery", "orchard"], closed: [] },
  };
}

function logic(extra = {}) {
  const context = vm.createContext({ Date, Math, JSON, Promise, setTimeout, clearTimeout, ...extra });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  return context;
}

test("allRowsOf leaves the marked sample out and every other lane where it stood", () => {
  const c = logic();
  assert.equal(c.sampleLane(board(), "facilitator-sample"), true);
  for (const ow of ["orchard", "facilitator", "qchat", "nowhere"]) assert.equal(c.sampleLane(board(), ow), false, ow);
  assert.equal(c.sampleLane(board({ mark: false }), "facilitator-sample"), false);
  assert.equal(c.sampleLane(null, "facilitator-sample"), false);
  assert.equal(c.sampleLane({ boxes: [] }, "facilitator-sample"), false);
  // the saved order leads, the rest follow as the board lists them, the quick chat lane never shows
  assert.deepEqual([...c.allRowsOf(board())], ["rookery", "orchard", "quarry"]);
  assert.deepEqual([...c.allRowsOf(board({ mark: false }))], ["facilitator-sample", "rookery", "orchard", "quarry"]);
  // a folder that matches the project made from it only counts once it is an ordinary project
  assert.equal(c.folderProject(board(), { machine: "this", path: "/Users/me/facilitator-sample" }), null);
  assert.equal(c.folderProject(board(), { machine: "this", path: "/Users/me/orchard" }), "orchard");
});

// ---- the phone -----------------------------------------------------------------
function el(id = "") {
  const classes = new Set();
  const node = {
    id, children: [], dataset: {}, attributes: {}, _text: "", scrollTop: 0,
    get classList() { return { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } }; },
    get textContent() { return this._text + this.children.map(k => k.textContent).join(""); },
    set textContent(v) { this.children = []; this._text = String(v); },
    appendChild(k) { this.children.push(k); return k; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    querySelectorAll(sel) { return sel === ".projrow" ? this.children : []; },
  };
  return node;
}

function phone({ state, activeOwner = "facilitator-sample", store = {} }) {
  const ids = Object.fromEntries(["projbtn", "projmenu", "projlist", "projname"].map(id => [id, el(id)]));
  const saved = new Map(Object.entries(store));
  const moves = [];
  const c = logic({
    document: { getElementById: id => ids[id], body: el("body"), createElement: () => el() },
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) },
    macHost: false, parent: {}, homeOpen: false, projCarry: null, activeOwner, validOwners: new Set(),
  });
  vm.runInContext(between(PHONE, "function validateOwners(state){", "// a card asked for by a notification"), c);
  vm.runInContext(between(PHONE, "function barOwners(st){", "function projOpen(){"), c);
  c.setTab = ow => { moves.push(ow); c.activeOwner = ow; };
  return { c, ids, moves, saved, list: () => ids.projlist.children.map(r => r.dataset.owner) };
}

test("the phone's project list and its number keys go without the sample, and the phone never opens it", () => {
  assert.ok(PHONE.includes("const owners = barOwners(st);"), "the list is not built from barOwners");
  assert.match(PHONE, /const ow = barOwners\(lastState\)\[shortcut\.value\];/, "the number keys do not count along barOwners");
  // a phone whose saved project was the sample: it is not a project to open, and the list steps to the first one
  const p = phone({ state: board(), store: { activeproj: "facilitator-sample" } });
  p.c.validateOwners(board());
  assert.deepEqual([...p.c.validOwners].sort(), ["facilitator", "orchard", "quarry", "rookery"]);
  assert.equal(p.saved.get("activeproj"), undefined, "the sample stayed the saved project");
  assert.equal(p.c.activeOwner, "facilitator");
  p.c.renderTabs(board());
  assert.deepEqual(p.list(), ["rookery", "orchard", "quarry"]);
  assert.deepEqual(p.moves, ["rookery"]);
  assert.deepEqual([...p.c.barOwners(board())], ["rookery", "orchard", "quarry"]);
  // its unread reply makes no other project look unread
  assert.equal(p.ids.projbtn.attributes["aria-label"], "rookery, choose a project");
  // a board that closed every other project still lists those, never the sample
  const shut = { ...board(), tabs: { order: ["facilitator-sample", "rookery", "orchard"], closed: ["rookery", "orchard", "quarry"] } };
  assert.deepEqual([...p.c.barOwners(shut)], ["rookery", "orchard", "quarry"]);
  // and without the mark it is a project like any other
  const plain = phone({ state: board({ mark: false }), activeOwner: "orchard" });
  plain.c.validateOwners(board({ mark: false }));
  assert.equal(plain.c.validOwners.has("facilitator-sample"), true);
  plain.c.renderTabs(board({ mark: false }));
  assert.deepEqual(plain.list(), ["facilitator-sample", "rookery", "orchard", "quarry"]);
});

// ---- the Mac -----------------------------------------------------------------
function mac({ activeOwner, LOCKED = null }) {
  const saved = new Map([["activeproj", activeOwner]]);
  const refused = [];
  const c = logic({
    LOCKED, DRAFT: "__draft__", draft: null, activeOwner, ownerReady: true, sampleLeft: false,
    knownOwnerIds: new Set(), validActiveOwnerIds: new Set(),
    localStorage: { getItem: k => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) },
    showOwnerRefusal: words => refused.push(words), clearOwnerRefusal() {},
  });
  vm.runInContext(between(MAC, "function validateActiveOwner(state){", 'for (const type of ["click"'), c);
  return { c, saved, refused };
}

test("the Mac board never opens the sample, and one whose saved project was the sample is sent home once", () => {
  const m = mac({ activeOwner: "facilitator-sample" });
  assert.equal(m.c.validateActiveOwner(board()), true);
  assert.deepEqual([...m.c.validActiveOwnerIds].sort(), ["facilitator", "orchard", "quarry", "rookery"]);
  assert.equal(m.c.knownOwnerIds.has("facilitator-sample"), true, "the board's lanes are still all known");
  assert.equal(m.c.activeOwner, "facilitator");
  assert.equal(m.saved.get("activeproj"), undefined);
  assert.equal(m.c.sampleLeft, true);
  // a saved project that is simply gone falls back as before, with no word of home
  const gone = mac({ activeOwner: "vanished" });
  gone.c.validateActiveOwner(board());
  assert.equal(gone.c.activeOwner, "facilitator");
  assert.equal(gone.c.sampleLeft, false);
  // an ordinary project stays open
  const kept = mac({ activeOwner: "quarry" });
  kept.c.validateActiveOwner(board());
  assert.equal(kept.c.activeOwner, "quarry");
  assert.equal(kept.c.sampleLeft, false);
  // the sample in a window of its own is refused, as a project the board does not have
  const own = mac({ activeOwner: "facilitator-sample", LOCKED: "facilitator-sample" });
  assert.equal(own.c.validateActiveOwner(board()), false);
  assert.deepEqual(own.refused, ['Project "facilitator-sample" is not available.']);
  // a project chosen and a search hit both go through setTab, which takes only a valid project
  assert.match(between(MAC, "function setTab(owner){", "// the board being left"), /if \(!ownerReady \|\| !validActiveOwnerIds\.has\(owner\)\) return;/);
  assert.match(between(MAC, "function openFound(r){", "searchBtn.addEventListener"), /!validActiveOwnerIds\.has\(b\.owner\)/);
});
