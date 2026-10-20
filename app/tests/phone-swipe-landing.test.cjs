const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// A swipe that let go of the card was undone by the next one. The card swiped to
// eases in for RUN_MS and is only shown for good a moment after, and a finger
// down in that moment cleared the run: the card swiped from came back in one
// frame and the new swipe started from it, so quick swipes walked nowhere. A
// finger down now lands the run first. A quick short flick sprang back too, the
// card turning only past a share of its width; a flick turns it now. The card
// swipe's block is cut out of m.html by its first line and run here against a
// stand-in document, with each touch stamped with its time.
const HTML = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
const first = "{\n  const EDGE = 28, START = 10, COMMIT = 0.22";
const start = HTML.indexOf(first), end = HTML.indexOf("\n// the card whose response control+s may scroll", start);
assert.ok(start >= 0 && end > start && HTML.indexOf(first, start + 1) < 0, "the card swipe moved");
const SWIPE = HTML.slice(start, end);

function classList() {
  const set = new Set();
  return { set, add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
    contains: c => set.has(c) };
}
function box(id) {
  const props = {};
  return { id, classList: classList(), style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } }, props };
}
function world() {
  const listeners = [], calls = [], timers = new Map();
  let timerId = 0;
  const body = { classList: classList() };
  const boxes = { m1: box("m1"), m2: box("m2"), m3: box("m3") };
  const cards = { addEventListener: (type, fn) => listeners.push({ type, fn }), clientWidth: 360 };
  const document = {
    body,
    getElementById: id => id === "cards" ? cards : id === "pane" ? { classList: classList() } : null,
    querySelectorAll: selector => selector === ".box.cardswipe"
      ? Object.values(boxes).filter(b => b.classList.contains("cardswipe")) : [],
  };
  const els = { m1: { box: boxes.m1 }, m2: { box: boxes.m2 }, m3: { box: boxes.m3 } };
  vm.runInContext(SWIPE, vm.createContext({
    document, innerWidth: 390, selectedId: "m1", els, getSelection: () => ({ isCollapsed: true }),
    ensureCard: id => els[id] || null,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: n => { timers.delete(n); },
    matchMedia: () => ({ matches: false }), menuOut: () => null,
    // the card on show stays m1 here: m2 is the next, m3 the previous
    cardStepTarget: dir => ({ id: dir > 0 ? "m2" : "m3" }),
    browse: id => calls.push(["browse", id]),
    wearEditor() {}, openAtHead() {}, seatScroll() {},
  }));
  const fire = (type, e) => { for (const l of listeners) if (l.type === type) l.fn(e); };
  const plain = { closest: () => null };
  const touch = (x, t) => ({ touches: [{ clientX: x, clientY: 400 }], target: plain, timeStamp: t });
  return { calls, body, boxes,
    down: (x, t) => fire("touchstart", touch(x, t)),
    move: (x, t) => fire("touchmove", touch(x, t)),
    up: t => fire("touchend", { touches: [], timeStamp: t }),
    // a drag from x0 to x1 over ms, a move every 16 ms, lifted `hold` ms after the last
    drag(x0, x1, t0, ms, hold = 16) {
      this.down(x0, t0);
      const n = Math.max(2, Math.round(ms / 16));
      for (let i = 1; i <= n; i++) this.move(x0 + (x1 - x0) * i / n, t0 + ms * i / n);
      this.up(t0 + ms + hold);
    },
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } } };
}

test("a finger down while the card swiped to eases in shows that card for good", () => {
  const w = world();
  w.drag(300, 100, 0, 160);
  assert.deepEqual(w.calls, [], "shown before its run was over");
  w.down(300, 330);
  assert.deepEqual(w.calls, [["browse", "m2"]], "the next finger undid the swipe");
  assert.ok(!w.boxes.m1.classList.contains("cardswipe") && !w.boxes.m2.classList.contains("cardswipe"));
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m2"]], "the run's own end showed it a second time");
});

test("swipes in a quick rhythm each turn the card", () => {
  const w = world();
  for (let i = 0; i < 4; i++) w.drag(300, 120, i * 260, 96);
  w.flush();
  assert.deepEqual(w.calls, Array(4).fill(["browse", "m2"]));
});

test("a finger down while a short drag springs back shows nothing new", () => {
  const w = world();
  w.drag(300, 260, 0, 400);
  w.down(300, 500);
  w.flush();
  assert.deepEqual(w.calls, []);
});

test("a quick short flick turns the card", () => {
  const w = world();
  w.drag(300, 255, 0, 48);   // 45 px, an eighth of the card
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m2"]]);
});

test("a quick short flick the other way turns to the previous card", () => {
  const w = world();
  w.drag(90, 150, 0, 56);
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m3"]]);
});

test("the same short drag made slowly springs back", () => {
  const w = world();
  w.drag(300, 255, 0, 400);
  w.flush();
  assert.deepEqual(w.calls, []);
});

test("a flick that stood still before the lift springs back", () => {
  const w = world();
  w.drag(300, 255, 0, 48, 200);
  w.flush();
  assert.deepEqual(w.calls, []);
});

test("a drag taken back with a quick flick leaves the card", () => {
  const w = world();
  w.down(300, 0);
  for (let i = 1; i <= 10; i++) w.move(300 - 6 * i, i * 30);   // 60 px left, slowly
  for (let i = 1; i <= 3; i++) w.move(240 + 15 * i, 300 + i * 16);   // and quickly back to 15 px left
  w.up(360);
  w.flush();
  assert.deepEqual(w.calls, []);
});

test("a long swipe still turns the card however slow", () => {
  const w = world();
  w.drag(300, 200, 0, 900, 300);   // 100 px, past the 22% mark, held still before the lift
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m2"]]);
});
