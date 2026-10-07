const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// A code block wider than the reply scrolls sideways on its own. A swipe that
// starts on one belongs to the code and never starts a card swipe; a block that
// fits has nothing to scroll, so a swipe on it turns the card as anywhere else,
// and an upright drag over either is the reply's own scroll. The card swipe's
// block is cut out of m.html by its first line and run here against a stand-in
// document: no browser and no layout. The touched element is a stand-in too:
// only the block's own selector finds a block, and its widths are what the page
// reads.
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
  const listeners = [], calls = [], timers = [];
  const body = { classList: classList() };
  const boxes = { m1: box("m1"), m2: box("m2") };
  const cards = { addEventListener: (type, fn) => listeners.push({ type, fn }), clientWidth: 360 };
  const document = {
    body,
    getElementById: id => id === "cards" ? cards : id === "pane" ? { classList: classList() } : null,
    querySelectorAll: selector => selector === ".box.cardswipe"
      ? Object.values(boxes).filter(b => b.classList.contains("cardswipe")) : [],
  };
  const els = { m1: { box: boxes.m1 }, m2: { box: boxes.m2 } };
  vm.runInContext(SWIPE, vm.createContext({
    document, innerWidth: 390, selectedId: "m1", els,
    ensureCard: id => els[id] || null,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    matchMedia: () => ({ matches: false }), menuOut: () => null,
    cardStepTarget: dir => ({ id: dir > 0 ? "m2" : "m1" }),
    browse: id => calls.push(["browse", id]),
    wearEditor() {}, openAtHead() {}, seatScroll() {},
  }));
  const fire = (type, e) => { for (const l of listeners) if (l.type === type) l.fn(e); };
  const touch = (x, y, target) => ({ touches: [{ clientX: x, clientY: y }], target });
  return { calls, body, boxes,
    down: (x, y, target) => fire("touchstart", touch(x, y, target)),
    move: (x, y) => fire("touchmove", touch(x, y, { closest: () => null })),
    up: () => fire("touchend", { touches: [] }),
    flush() { while (timers.length) timers.shift()(); } };
}
const plain = { closest: () => null };
const onCode = (scrollWidth, clientWidth) => {
  const block = { scrollWidth, clientWidth };
  return { closest: selector => selector === "pre.codeblock" ? block : null };
};

test("a sideways swipe elsewhere on the card turns it", () => {
  const w = world();
  w.down(300, 400, plain);
  w.move(288, 402);
  assert.ok(w.body.classList.contains("carddrag"));
  w.move(100, 420);
  w.up();
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m2"]]);
});

test("a sideways swipe that starts on code wider than the reply moves the code, not the card", () => {
  const w = world();
  w.down(300, 400, onCode(965, 350));
  w.move(288, 402);
  w.move(100, 420);
  w.up();
  w.flush();
  assert.ok(!w.body.classList.contains("carddrag"));
  assert.ok(!w.boxes.m1.classList.contains("cardswipe"));
  assert.ok(!w.boxes.m2.classList.contains("cardswipe"));
  assert.deepEqual(w.calls, []);
});

test("a sideways swipe that starts on code that fits still turns the card", () => {
  const w = world();
  w.down(300, 400, onCode(350, 350));
  w.move(288, 402);
  assert.ok(w.body.classList.contains("carddrag"));
  w.move(100, 420);
  w.up();
  w.flush();
  assert.deepEqual(w.calls, [["browse", "m2"]]);
});

test("an upright drag that starts on wide code is left to the reply's own scroll", () => {
  const w = world();
  w.down(200, 500, onCode(965, 350));
  w.move(203, 470);
  w.move(260, 300);
  w.up();
  w.flush();
  assert.ok(!w.body.classList.contains("carddrag"));
  assert.deepEqual(w.calls, []);
});

test("a swipe that starts on a control is still left alone", () => {
  const w = world();
  w.down(300, 400, { closest: selector => selector.includes("button") ? {} : null });
  w.move(288, 402);
  assert.ok(!w.body.classList.contains("carddrag"));
});
