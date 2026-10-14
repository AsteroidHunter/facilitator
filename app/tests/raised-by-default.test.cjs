// the card on screen stands raised by default, and only a double tap on the
// phone's empty page, or a double click on the Mac board's, lowers it. checked
// without a browser: the phone's own selection code and its page-tap listener
// are cut out of m.html as written and run over a small document, with the card
// logic both pages load. the Mac board's side of this is in
// browse-and-read.test.cjs, which has the board's harness; the sheets are read
// as they state it here. nothing renders a pixel.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const PHONE = read("m.html");
const DESKTOP = read("index.html");
const LOGIC = read("card-logic.js");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `start marker missing: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `end marker missing after ${start}: ${end}`);
  return source.slice(from, to);
}
// the text of one rule, from its selector to its closing brace
function rule(source, selector) {
  const at = source.indexOf(selector + "{");
  assert.ok(at >= 0, `no rule for ${selector}`);
  return source.slice(at, source.indexOf("}", at) + 1);
}

// ---- a small document ----------------------------------------------------------------
function classes() {
  const set = new Set();
  return {
    toggle(name, on) {
      const want = on === undefined ? !set.has(name) : !!on;
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    add: name => set.add(name),
    remove: name => set.delete(name),
    contains: name => set.has(name),
  };
}
class Node {
  constructor(id = "") { this.id = id; this.classList = classes(); this.children = []; this.listeners = {}; this.blurred = 0; }
  contains(other) { return other === this || this.children.some(c => c.contains(other)); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  blur() { this.blurred += 1; if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  closest() { return null; }
}

// ---- the phone's selection code ------------------------------------------------------
const CARDS = ["a", "b", "c"];
function phone() {
  const doc = { activeElement: null };
  const nodes = {};
  const node = id => { const n = new Node(id); n.doc = doc; nodes[id] = n; return n; };
  doc.body = node("body");
  doc.activeElement = doc.body;
  for (const id of ["pane", "dock", "page"]) node(id);
  doc.getElementById = id => nodes[id] || null;
  doc.querySelectorAll = () => [];
  const els = {};
  for (const id of CARDS) {
    const box = node("box-" + id), ta = node("ta-" + id);
    box.children.push(ta);
    els[id] = { box, ta };
  }
  const seen = [];
  const noop = () => {};
  const card = (id, owner) => ({ id, owner, bucket: "meta", title: "card " + id, ball: "you", state: "yours",
    replies: 1, seen: 0, agentTs: 1, ts: 1, pending: 0, done: false, parked: false });
  const state = { boxes: [card("a", "lane"), card("b", "lane"), card("c", "lane"), card("o1", "other")] };
  els.o1 = { box: node("box-o1"), ta: node("ta-o1") };
  const clock = { now: 0 };
  const sandbox = {
    console, Date, Promise, Math, setTimeout, clearTimeout,
    document: doc, performance: { now: () => clock.now },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    els, lastState: state, lastSel: {}, selectedId: null, shownId: null, browsing: false, homeOpen: false,
    activeOwner: "lane", hist: null, macHost: false, parent: {}, validOwners: new Set(["lane", "other"]),
    tracePhone: noop, endPhoneTrace: noop, ensureCard: id => els[id], cancelAutoNext: noop, histExit: noop,
    // every read mark the page sends is recorded, as the board would receive it
    fetch: (url, opts) => {
      if (url === "/seen") seen.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    syncPhoneHistory: noop, wearEditor: noop, openAtHead: noop, seatScroll: noop,
    renderTabs: noop, reachLater: noop, apply: noop,
    pickInRow: (st, owner) => st.boxes.find(b => b.owner === owner),
    menuOut: () => null,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  sandbox.seenSync(state);
  vm.runInContext(
    between(PHONE, "function setBrowsing(on){", "// the board's tabs, in the board's order"),
    sandbox, { filename: "m.html" });
  // the page element and the page-tap listener as the page hangs them
  const page = nodes.page;
  sandbox.page = page;
  vm.runInContext(
    between(PHONE, "let lastPageTap = null;", "// a tap on the card with the list out lands on the page behind it"),
    sandbox, { filename: "m.html" });
  const get = name => vm.runInContext(name, sandbox);
  return {
    sandbox, doc, nodes, els, seen, clock, page, get,
    lowered: () => doc.body.classList.contains("lowered"),
    // is the card drawn raised? the sheet's own rules that take the pane's
    // shadow off, read against the classes the body wears
    raised() {
      const flat = [...PHONE.matchAll(/^\s*body((?:\.[\w-]+)+) main\{box-shadow:none\}/gm)].map(m => m[1].split(".").filter(Boolean));
      assert.ok(flat.length > 0, "the sheet has no rule that takes the card's shadow off");
      return !flat.some(names => names.every(name => doc.body.classList.contains(name)));
    },
    // one tap, as the page hears its click: where it lands and how long since the last
    tap(target = page, { at = clock.now, x = 100, y = 200 } = {}) {
      clock.now = at;
      for (const fn of page.listeners.click || []) fn({ target, clientX: x, clientY: y });
    },
    shown: () => get("selectedId"),
  };
}
// the board's first reading: the lane's card shown browsed, as applySelection leaves it
function loaded() {
  const p = phone();
  p.get("browse")("a");
  return p;
}

test("a card is raised on load and after switching projects and back; browsing is not lowering", () => {
  const p = loaded();
  assert.equal(p.shown(), "a");
  assert.equal(p.get("browsing"), true, "the card the page opened on counts as selected");
  assert.equal(p.raised(), true, "the card the page opened on is drawn flat");
  p.get("setTab")("other");
  assert.equal(p.shown(), "o1");
  assert.equal(p.raised(), true, "a project switch drew the card flat");
  p.get("setTab")("lane");
  assert.equal(p.shown(), "a");
  assert.equal(p.get("browsing"), true);
  assert.equal(p.raised(), true, "switching back drew the card flat");
  // selecting it reads it and does not lower it
  p.get("chooseShown")();
  assert.equal(p.get("browsing"), false);
  assert.equal(p.raised(), true);
  assert.deepEqual(p.seen, [{ a: 1 }]);
  // two quick taps on the empty page are what draw it flat
  p.tap(p.page, { at: 1000 });
  p.tap(p.page, { at: 1100 });
  assert.equal(p.raised(), false, "a double tap did not draw the card flat");
});

test("a single tap on the empty page does nothing to the card, however many", () => {
  const p = loaded();
  p.get("chooseShown")();
  p.doc.activeElement = p.els.a.ta;
  p.tap(p.page, { at: 1000 });
  p.tap(p.page, { at: 2000 });
  p.tap(p.page, { at: 3000 });
  p.tap(p.nodes.dock, { at: 4000 });
  assert.equal(p.lowered(), false, "single taps lowered the card");
  assert.equal(p.get("browsing"), false, "single taps let go of the card");
  assert.equal(p.doc.activeElement, p.els.a.ta, "a single tap took the caret out");
  assert.equal(p.els.a.ta.blurred, 0);
});

test("two quick taps on the empty page lower the card, let go of the caret and keep it on screen", () => {
  const p = loaded();
  p.get("chooseShown")();
  p.seen.length = 0;
  p.doc.activeElement = p.els.a.ta;
  p.tap(p.page, { at: 1000, x: 100, y: 200 });
  assert.equal(p.lowered(), false);
  p.tap(p.page, { at: 1180, x: 108, y: 205 });
  assert.equal(p.lowered(), true, "two quick taps did not lower the card");
  assert.equal(p.get("browsing"), true, "lowering did not let go of the card");
  assert.equal(p.shown(), "a", "lowering took the card off the screen");
  assert.ok(p.els.a.box.classList.contains("sel"), "lowering took the card off the screen");
  assert.equal(p.doc.activeElement, p.doc.body, "the caret stayed in the card");
  assert.deepEqual(p.seen, [], "lowering read the card");
  // the gaps between the row's buttons are the page too
  const q = loaded();
  q.tap(q.nodes.dock, { at: 50 });
  q.tap(q.nodes.dock, { at: 200 });
  assert.equal(q.lowered(), true, "two quick taps between the row's buttons did not lower the card");
});

test("two taps too far apart in time or in place do not lower the card; a third quick one pairs with the second", () => {
  const p = loaded();
  p.tap(p.page, { at: 1000 });
  p.tap(p.page, { at: 1300 });
  assert.equal(p.lowered(), false, "two taps a full double tap window apart lowered the card");
  p.tap(p.page, { at: 1500 });
  assert.equal(p.lowered(), true, "the second tap did not stand as the first of the next pair");
  const q = loaded();
  q.tap(q.page, { at: 1000, x: 100, y: 200 });
  q.tap(q.page, { at: 1100, x: 200, y: 200 });
  assert.equal(q.lowered(), false, "two taps a hundred pixels apart lowered the card");
  // the pair is counted once: a pair, then one more tap, is only a first tap
  const r = loaded();
  r.tap(r.page, { at: 1000 });
  r.tap(r.page, { at: 1100 });
  assert.equal(r.lowered(), true);
  r.get("chooseShown")();
  r.tap(r.page, { at: 1200 });
  assert.equal(r.lowered(), false, "a tap after a pair lowered the card on its own");
});

test("a tap on anything but the bare page breaks the pair, and so do a menu, the home page and the tap that shuts the list", () => {
  const p = loaded();
  const button = new Node("button");
  p.tap(p.page, { at: 1000 });
  p.tap(button, { at: 1050 });
  p.tap(p.page, { at: 1100 });
  assert.equal(p.lowered(), false, "a tap on a button between two page taps still paired them");
  // a tap on the card or the list never lowers, however quick
  for (const target of [p.nodes.pane, p.els.a.box, button]) {
    p.tap(target, { at: 2000 });
    p.tap(target, { at: 2100 });
    assert.equal(p.lowered(), false, `two taps on ${target.id} lowered the card`);
  }
  // with a menu out the page is not bare: the tap that shuts it is read while it is out
  p.sandbox.menuOut = () => ({});
  p.tap(p.page, { at: 3000 });
  p.sandbox.menuOut = () => null;
  p.tap(p.page, { at: 3100 });
  assert.equal(p.lowered(), false, "the tap that shut a menu counted as the first of a pair");
  // and the home page has no card to lower
  p.sandbox.homeOpen = true;
  p.tap(p.page, { at: 4000 });
  p.tap(p.page, { at: 4100 });
  assert.equal(p.lowered(), false, "two taps under the home page lowered the card");
  // the listener stands before the one that shuts the list, so it reads the list while it is still out
  const ours = PHONE.indexOf('page.addEventListener("click", e => {\n  const bare = ');
  const shuts = PHONE.indexOf('page.addEventListener("click", e => {\n  if (e.target === page && drawerOpen()');
  assert.ok(ours > 0 && shuts > 0, "a page listener is missing");
  assert.ok(ours < shuts, "the page-tap listener stands after the one that shuts the list");
});

test("whatever shows or chooses a card raises it again after a double tap lowered it", () => {
  const lower = p => { p.tap(p.page, { at: p.clock.now + 1000 }); p.tap(p.page, { at: p.clock.now + 100 }); assert.equal(p.lowered(), true); };
  const cases = {
    "a project switch": p => p.get("setTab")("other"),
    "the same project's tab": p => p.get("setTab")("lane"),
    "the arrows, a swipe or a random card (browse)": p => p.get("browse")("b"),
    "a ticket (select)": p => p.get("select")("c"),
    "Enter, or a tap into the card (chooseShown)": p => p.get("chooseShown")(),
    "a tap into the composer (useCard)": p => p.get("useCard")("a"),
    "an empty lane (deselect)": p => p.get("deselect")(),
  };
  for (const [name, run] of Object.entries(cases)) {
    const p = loaded();
    lower(p);
    run(p);
    assert.equal(p.lowered(), false, `${name} left the card lowered`);
  }
});

test("Escape lets go of the card on screen without lowering it", () => {
  const p = loaded();
  p.get("chooseShown")();
  p.get("unselectShown")();
  assert.equal(p.get("browsing"), true, "Escape did not let go of the card");
  assert.equal(p.lowered(), false, "Escape lowered the card");
  assert.equal(p.raised(), true, "Escape drew the card flat");
  const escape = between(PHONE, "  escape(e){", "  },");
  assert.match(escape, /unselectShown\(\)/);
  assert.doesNotMatch(escape, /lowerShown/);
});

test("the shared logic: the double tap window and the one lowered state live in card-logic.js", () => {
  const sandbox = { document: { body: { classList: classes() } }, Math };
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  const again = vm.runInContext("tapAgain", sandbox);
  const last = { at: 1000, x: 10, y: 10 };
  assert.equal(vm.runInContext("DOUBLE_TAP_MS", sandbox), 300, "the double tap window is not the usual 300 ms");
  assert.equal(again(null, 1100, 10, 10), false, "a first tap paired with nothing");
  assert.equal(again(last, 1299, 10, 10), true);
  assert.equal(again(last, 1300, 10, 10), false, "a tap a whole window later paired");
  assert.equal(again(last, 1100, 10 + 30, 10), true);
  assert.equal(again(last, 1100, 10 + 31, 10), false, "a tap far from the first paired");
  // both pages use the one copy and declare none of their own
  for (const [name, html] of [["m.html", PHONE], ["index.html", DESKTOP]]) {
    assert.doesNotMatch(html, /function (setLowered|lowerShown|tapAgain)\(/, `${name} has a copy of the shared logic`);
    assert.doesNotMatch(html, /const DOUBLE_TAP_(MS|PX)/, `${name} has its own double tap window`);
  }
  // setLowered is the one writer of the state
  sandbox.document.body.classList.toggle("lowered", false);
  vm.runInContext("setLowered(true)", sandbox);
  assert.equal(sandbox.document.body.classList.contains("lowered"), true);
  vm.runInContext("setLowered(false)", sandbox);
  assert.equal(sandbox.document.body.classList.contains("lowered"), false);
});

test("the sheets: the card is raised unless lowered, on both pages, in the app's own shadow and no new colour", () => {
  const raised = /box-shadow:0 2px 18px rgba\(60,45,20,\.18\), 0 1px 3px rgba\(60,45,20,\.10\)/;
  // the phone's pane carries the raised shadow in its base rule and the lowered rule is the only one that takes it away
  assert.match(rule(PHONE, "  main"), raised);
  assert.equal(rule(PHONE, "  body.lowered main"), "  body.lowered main{box-shadow:none}");
  assert.deepEqual(PHONE.match(/^[^\n{]*body\.browsing[^\n{]*\{/gm) || [], [], "a rule still draws a browsed phone card differently");
  assert.equal(rule(PHONE, "  body.lowered .box.cardswipe:not(.cardswipe-in)"),
    "  body.lowered .box.cardswipe:not(.cardswipe-in){box-shadow:none}");
  assert.doesNotMatch(PHONE, /\.box\.cardswipe-in, body/, "the card swiped to lands flat again");
  // the board's frame likewise
  assert.match(rule(DESKTOP, "  body.focus main"), raised);
  assert.equal(rule(DESKTOP, "  body.focus.lowered main"), "  body.focus.lowered main{box-shadow:none}");
  // nothing here is coloured: no purple, never the accent
  for (const text of [rule(PHONE, "  body.lowered main"), rule(DESKTOP, "  body.focus.lowered main")])
    assert.doesNotMatch(text, /accent|purple|#[0-9a-f]{3,8}\b|rgb/i);
});

test("a double tap on the phone neither zooms the page nor waits to be one", () => {
  // every element is manipulation, so WebKit takes no double tap zoom and holds no click back for a second tap
  assert.match(PHONE, /\*\{touch-action:manipulation\}/);
  assert.match(PHONE, /for \(const type of \["gesturestart", "gesturechange"\]\)/);
  // the pair is counted from clicks, which a scroll, a swipe or a pull never makes
  const wire = between(PHONE, "let lastPageTap = null;", "// a tap on the card with the list out lands on the page behind it");
  assert.match(wire, /page\.addEventListener\("click"/);
  assert.doesNotMatch(wire, /touchstart|touchend|preventDefault/);
});
