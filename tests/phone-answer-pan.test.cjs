const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// A swipe on the answer that a busy page swallowed. On the phone a touch, mouse
// or pointer listener that may cancel (one that is not passive) makes WebKit
// hold back every pan under it until the page has answered the touch, and on a
// busy page the swipe is over before then. The drawer pull, the card swipe and
// the gesture recorder listen on the document and on #cards, which both cover
// the answer, so every one of those listeners has to be passive, and the pull
// and the swipe have to work without cancelling anything.
// Their blocks are cut out of m.html by their own first lines and run here
// against a stand-in document: no browser and no layout.
const HTML = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
function block(first, next) {
  const start = HTML.indexOf(first), end = HTML.indexOf(next, start);
  assert.ok(start >= 0 && end > start && HTML.indexOf(first, start + 1) < 0, "the block moved: " + first);
  return HTML.slice(start, end);
}
const DRAWER = block("{\n  const EDGE = 28;    // how far in from an edge a pull may begin",
  "\n// Keep only the start, first intended move, and end of a gesture.");
const RECORDER = block("// Keep only the start, first intended move, and end of a gesture.", "// ---- the startup curtain");
const SWIPE = block("{\n  const EDGE = 28, START = 10, COMMIT = 0.22",
  "\n// the card whose response control+s may scroll");

function classList() {
  const set = new Set();
  return { set, add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
}
function box(id) {
  const props = {};
  return { id, classList: classList(), style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } }, props };
}
function world() {
  const listeners = [], calls = [], timers = [];
  const on = where => (type, fn, options) => listeners.push({ where, type, fn, options });
  const body = { classList: classList() };
  const boxes = { m1: box("m1"), m2: box("m2") };
  const cards = { addEventListener: on("#cards"), clientWidth: 360 };
  const panel = side => ({ dataset: { side } });
  const tickets = panel("left"), settings = panel("right");
  const document = {
    addEventListener: on("document"), body, activeElement: body,
    getElementById: id => id === "cards" ? cards : id === "pane" ? { classList: classList() } : null,
    querySelectorAll: selector => selector === ".box.cardswipe"
      ? Object.values(boxes).filter(b => b.classList.contains("cardswipe")) : [],
  };
  const els = { m1: { box: boxes.m1 }, m2: { box: boxes.m2 } };
  const context = vm.createContext({
    document, tickets, settings, innerWidth: 390, selectedId: "m1", hist: null,
    els,
    // the page builds the card coming in when it is not built yet
    ensureCard: id => els[id] || null,
    addEventListener: on("window"), performance: { now: () => 0 },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    menuOut: () => null, dismissEditor() {}, closeProjects() {}, tracePhone() {}, traceFrameOpportunity() {},
    phoneEnterRole: () => "other",
    menuTravel: () => 300, menuSign: p => p === settings ? -1 : 1,
    paintMenu: (p, at) => calls.push(["paint", p.dataset.side, Math.round(at * 100) / 100]),
    runMenu: (p, v) => calls.push(["run", p.dataset.side, v]),
    cardStepTarget: dir => ({ id: dir > 0 ? "m2" : "m1" }),
    select: id => calls.push(["select", id]),
    browse: id => calls.push(["browse", id]),
    // the card coming in is given its typing editor, and whether it was
    // already on show when that happened
    wearEditor: id => calls.push(["wear", id, boxes[id].classList.contains("cardswipe")]),
    // card-logic.js's own function: the card coming in is handed its reading head
    openAtHead: el => calls.push(["head", el.box.id]),
    // a card taken down and built again is handed its answer's scroll back
    seatScroll() {},
    MutationObserver: class { observe() {} disconnect() {} },
  });
  for (const source of [DRAWER, RECORDER, SWIPE]) vm.runInContext(source, context);
  // a touch the way the page sees one: cancelable, and it says so if anyone
  // tries to cancel it
  const touch = (x, y) => {
    const e = { touches: [{ clientX: x, clientY: y }], target: { closest: () => null }, cancelable: true,
      timeStamp: 0, prevented: 0, preventDefault() { e.prevented++; } };
    return e;
  };
  const events = [];
  const fire = (type, e) => {
    events.push(e);
    for (const l of listeners) if (l.type === type && (l.where === "document" || l.where === "#cards")) l.fn(e);
  };
  return { listeners, calls, timers, body, boxes, events,
    down: (x, y) => fire("touchstart", touch(x, y)),
    move: (x, y) => fire("touchmove", touch(x, y)),
    up: () => fire("touchend", { touches: [], target: { closest: () => null } }),
    flush() { while (timers.length) timers.shift()(); },
    prevented: () => events.reduce((n, e) => n + (e.prevented || 0), 0) };
}

test("every touch, mouse and pointer listener over the answer is passive", () => {
  const w = world();
  const over = w.listeners.filter(l => /^(touch|mouse|pointer)/.test(l.type));
  // the drawer pull's seven, the recorder's six and the card swipe's four
  assert.equal(over.length, 17);
  for (const l of over)
    assert.equal(l.options?.passive, true, `${l.where} ${l.type} may cancel, so the phone waits on the page`);
});

test("the project's capsule and its list's carry are the page's only listeners that may cancel a touch", () => {
  // the capsule in the row of buttons and the project list are boxes of their
  // own over the row, and hold no answer, so a pan over the answer never waits
  // on either
  // The dedicated pinch guard cancels GestureEvents, not ordinary touches.
  // Its registration and event behavior are tested in phone-page-zoom.test.cjs.
  const touchSource = HTML.replace(/<script id="page-zoom-guard">[\s\S]*?<\/script>/, "");
  const cancellable = [...touchSource.matchAll(/passive\s*:\s*false/g)];
  assert.equal(cancellable.length, 2);
  // each from the start of the line its listener is added on
  const owners = cancellable.map(m => touchSource.slice(touchSource.lastIndexOf("\n", touchSource.lastIndexOf("addEventListener(", m.index)), m.index));
  assert.match(owners[0], /projBtn\.addEventListener\("touchstart"/);
  assert.match(owners[1], /projList\.addEventListener\("touchmove"/);
});

test("a pull from the left edge opens the list, cancelling nothing", () => {
  const w = world();
  w.down(5, 400);
  w.move(60, 403);
  assert.ok(w.body.classList.contains("menudrag"));
  w.move(250, 410);
  w.up();
  assert.deepEqual(w.calls, [["paint", "left", 0.18], ["paint", "left", 0.82], ["run", "left", 1]]);
  assert.equal(w.prevented(), 0);
});

test("a pull that starts upright is a scroll and moves no menu", () => {
  const w = world();
  w.down(5, 400);
  w.move(9, 340);
  w.move(200, 300);
  w.up();
  assert.deepEqual(w.calls, []);
  assert.ok(!w.body.classList.contains("menudrag"));
});

test("a sideways drag over the card swipes to the next card, cancelling nothing", () => {
  const w = world();
  w.down(300, 400);
  w.move(288, 402);   // 12px across, 2 down: sideways
  assert.ok(w.body.classList.contains("carddrag"));
  assert.ok(w.boxes.m2.classList.contains("cardswipe-in"));
  w.move(100, 420);
  assert.equal(w.boxes.m1.props["--card-swipe-x"], "-200px");
  w.up();
  w.flush();
  // the card is shown and left unselected, so unread, until a tap selects it
  assert.deepEqual(w.calls.filter(c => c[0] === "browse"), [["browse", "m2"]]);
  assert.deepEqual(w.calls.filter(c => c[0] === "select"), []);
  assert.deepEqual(w.calls.filter(c => c[0] === "wear"), [["wear", "m2", false]],
    "the card slid in was not wearing its editor before it was shown");
  assert.deepEqual(w.calls.filter(c => c[0] === "head"), [["head", "m2"]],
    "the card slid in was not opened at its head");
  assert.equal(w.prevented(), 0);
});

test("an upright drag over the card is left to the answer's own scroll", () => {
  const w = world();
  w.down(200, 500);
  w.move(203, 470);
  w.move(260, 300);
  w.up();
  w.flush();
  assert.ok(!w.body.classList.contains("carddrag"));
  assert.deepEqual(w.calls, []);
});

// An older reply that would not scroll (Sep 24). From Sep 14 to Sep 26 the
// answered box rode at the top of the answer with a scrolling lane of its own,
// and a swipe that began on the opened box moved only that lane, or nothing
// once the lane was at its end. The panel riding there now clips its batch and
// opens in place; only the sent panel at the card's foot scrolls inside itself.
// Every class the riding panel is built from is read out of answeredPanel, and
// no rule may let one of them scroll up and down unless it is the sent panel's.
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");
const SHEETS = readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8") +
  [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
function scrollsUpright(body) {
  let y = null;
  for (const part of body.split(";")) {
    const [prop, ...rest] = part.split(":"), value = rest.join(":").trim().split(/\s+/);
    if (prop.trim() === "overflow") y = value.at(-1);
    if (prop.trim() === "overflow-y") y = value[0];
  }
  return y === "auto" || y === "scroll";
}
test("nothing in the answered panel over the answer scrolls up and down on its own", () => {
  const start = LOGIC.indexOf("function answeredPanel(room){");
  assert.ok(start >= 0, "answeredPanel moved");
  const markup = LOGIC.slice(start, LOGIC.indexOf("\n}\n", start));
  const names = ["answered", "answwrap", ...[...markup.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/))];
  assert.ok(names.includes("answclip") && names.includes("answstack"));
  const css = SHEETS.replace(/\/\*[\s\S]*?\*\//g, "");
  const riding = [], sent = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!scrollsUpright(body)) continue;
    for (const part of selector.split(",").map(s => s.trim())) {
      if (!names.some(n => new RegExp("\\." + n + "(?![\\w-])").test(part))) continue;
      (/\.sent(?![\w-])/.test(part) ? sent : riding).push(part);
    }
  }
  assert.deepEqual(riding, []);
  assert.ok(sent.length >= 1, "the sent panel's own lane is where the scan expects it");
});
