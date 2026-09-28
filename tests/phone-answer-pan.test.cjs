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
  const drawer = panel("left"), settings = panel("right");
  const document = {
    addEventListener: on("document"), body, activeElement: body,
    getElementById: id => id === "cards" ? cards : id === "pane" ? { classList: classList() } : null,
    querySelectorAll: selector => selector === ".box.cardswipe"
      ? Object.values(boxes).filter(b => b.classList.contains("cardswipe")) : [],
  };
  const context = vm.createContext({
    document, drawer, settings, innerWidth: 390, selectedId: "m1", hist: null,
    els: { m1: { box: boxes.m1 }, m2: { box: boxes.m2 } },
    addEventListener: on("window"), performance: { now: () => 0 },
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    matchMedia: () => ({ matches: false }),
    menuOut: () => null, dismissEditor() {}, tracePhone() {}, traceFrameOpportunity() {},
    phoneEnterRole: () => "other",
    menuWidth: () => 300, menuSign: p => p === settings ? -1 : 1,
    paintMenu: (p, at) => calls.push(["paint", p.dataset.side, Math.round(at * 100) / 100]),
    runMenu: (p, v) => calls.push(["run", p.dataset.side, v]),
    cardStepTarget: dir => ({ id: dir > 0 ? "m2" : "m1" }),
    select: id => calls.push(["select", id]),
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

test("the tab strip's carry is the page's one listener that may cancel a touch", () => {
  // the strip is its own box at the top and holds no answer, so a pan over the
  // answer never waits on it
  const cancellable = [...HTML.matchAll(/passive\s*:\s*false/g)];
  assert.equal(cancellable.length, 1);
  const at = cancellable[0].index;
  assert.match(HTML.slice(HTML.lastIndexOf("addEventListener(", at) - 4, at), /bar\.addEventListener\("touchmove"/);
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
  assert.deepEqual(w.calls.filter(c => c[0] === "select"), [["select", "m2"]]);
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
