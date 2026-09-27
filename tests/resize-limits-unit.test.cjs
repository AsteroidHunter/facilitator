// Browser-free tests for the resize limits: clampResize and RESIZE_LIMITS in
// card-logic.js, run in a sandbox, plus a read of index.html to pin that the
// edit-mode resize handler goes through them and that the default layout sits
// inside every limit.
//
// What it guards:
//   - a drag past a box's largest size stops at that size, and past its
//     smallest stops at that one, for width and height separately.
//   - a west or north pull keeps the far edge pinned while it stops.
//   - a box with no limits keeps the old two-cell floor and has no ceiling.
//   - only the pulled axes are held to the limits, so a saved size outside
//     them does not jump on the other axis.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const noop = () => {};
const sandbox = {
  document: { createElement: () => ({ style: {}, classList: {} }), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, body: {} },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8") +
  "\nthis.RESIZE_LIMITS = RESIZE_LIMITS;", sandbox);
const { clampResize, RESIZE_LIMITS } = sandbox;

const G = 1440 * 0.008;   // the board's GRID
const cells = v => Math.round(v / G * 1000) / 1000;
// a box as beginSize records it, from its edges in cells
function box(leftCells, topCells, wCells, hCells){
  return { left: leftCells * G, top: topCells * G, w: wCells * G, h: hCells * G,
    right: (leftCells + wCells) * G, bottom: (topCells + hCells) * G };
}
const run = (s, dir, dx, dy, id) => {
  const out = clampResize(s, dir, dx, dy, G, RESIZE_LIMITS[id]);
  const res = { w: cells(out.w), h: cells(out.h) };
  if (out.left != null) res.left = cells(out.left);
  if (out.top != null) res.top = cells(out.top);
  return res;
};

test("the four boxes each have a smallest and largest width and height", () => {
  assert.deepEqual(Object.keys(RESIZE_LIMITS).sort(), ["clockbox", "magic1", "main", "tickets"]);
  const regions = /const REGION_SEL = "([^"]+)"/.exec(HTML)[1];
  for (const [id, lim] of Object.entries(RESIZE_LIMITS)){
    assert.ok(regions.includes(id === "main" ? "main" : "#" + id), id + " is a board region");
    for (const k of ["minW", "maxW", "minH", "maxH"])
      assert.ok(Number.isInteger(lim[k]) && lim[k] >= 2, id + " " + k + " is whole cells, at least two");
    assert.ok(lim.minW < lim.maxW && lim.minH < lim.maxH, id + " smallest is under largest");
    // the stage is 125 by 78 cells, with half a cell kept clear at the edge
    assert.ok(lim.maxW <= 124 && lim.maxH <= 77, id + " fits on the stage");
  }
});

test("a drag past the largest size stops at the largest size", () => {
  const card = box(40.5, 5.5, 46, 63);
  assert.deepEqual(run(card, "e", 5000, 0, "main"), { w: 70, h: 63 });
  assert.deepEqual(run(card, "s", 0, 5000, "main"), { w: 46, h: 76 });
  assert.deepEqual(run(card, "se", 5000, 5000, "main"), { w: 70, h: 76 });
  const spot = box(6.5, 56.5, 24, 12);
  assert.deepEqual(run(spot, "se", 5000, 5000, "magic1"), { w: 40, h: 24 });
  const clock = box(2.5, 2.5, 18, 9);
  assert.deepEqual(run(clock, "se", 5000, 5000, "clockbox"), { w: 34, h: 16 });
});

test("a drag past the smallest size stops at the smallest size", () => {
  const card = box(40.5, 5.5, 46, 63);
  assert.deepEqual(run(card, "e", -5000, 0, "main"), { w: 30, h: 63 });
  assert.deepEqual(run(card, "s", 0, -5000, "main"), { w: 46, h: 40 });
  const tik = box(5.5, 15.5, 31, 37);
  assert.deepEqual(run(tik, "se", -5000, -5000, "tickets"), { w: 22, h: 16 });
  const clock = box(2.5, 2.5, 18, 9);
  assert.deepEqual(run(clock, "se", -5000, -5000, "clockbox"), { w: 14, h: 7 });
});

test("inside the limits a drag still snaps to whole cells as before", () => {
  const card = box(40.5, 5.5, 46, 63);
  assert.deepEqual(run(card, "e", 3.2 * G, 0, "main"), { w: 49, h: 63 });
  assert.deepEqual(run(card, "s", 0, -2.6 * G, "main"), { w: 46, h: 60 });
  assert.deepEqual(run(card, "w", -4.4 * G, 0, "main"), { w: 50, h: 63, left: 36.5 });
});

test("a west pull stops at the limit with the right edge pinned", () => {
  const card = box(40.5, 5.5, 46, 63);   // right edge at 86.5
  const grow = run(card, "w", -5000, 0, "main");
  assert.deepEqual(grow, { w: 70, h: 63, left: 16.5 });
  assert.equal(grow.left + grow.w, 86.5);
  const shrink = run(card, "w", 5000, 0, "main");
  assert.deepEqual(shrink, { w: 30, h: 63, left: 56.5 });
  assert.equal(shrink.left + shrink.w, 86.5);
});

test("a north pull stops at the limit with the bottom edge pinned", () => {
  const tik = box(5.5, 33.5, 31, 37);    // bottom edge at 70.5
  const grow = run(tik, "n", 0, -5000, "tickets");
  assert.deepEqual(grow, { w: 31, h: 63, top: 7.5 });
  assert.equal(grow.top + grow.h, 70.5);
  const shrink = run(tik, "n", 0, 5000, "tickets");
  assert.deepEqual(shrink, { w: 31, h: 16, top: 54.5 });
  assert.equal(shrink.top + shrink.h, 70.5);
  // the stage's top edge still wins over a largest size it cannot reach
  const card = box(40.5, 5.5, 46, 63);   // bottom edge at 68.5
  assert.deepEqual(run(card, "n", 0, -5000, "main"), { w: 46, h: 68, top: 0.5 });
});

test("a corner pull toward the top left holds both far edges", () => {
  const spot = box(30.5, 40.5, 24, 12);  // right 54.5, bottom 52.5
  const grow = run(spot, "nw", -5000, -5000, "magic1");
  assert.deepEqual(grow, { w: 40, h: 24, left: 14.5, top: 28.5 });
  const shrink = run(spot, "nw", 5000, 5000, "magic1");
  assert.deepEqual(shrink, { w: 16, h: 8, left: 38.5, top: 44.5 });
});

test("other boxes keep the two-cell floor and have no ceiling", () => {
  const m2 = box(60.5, 20.5, 20, 20);
  assert.equal(RESIZE_LIMITS.magic2, undefined);
  assert.deepEqual(run(m2, "se", -5000, -5000, "magic2"), { w: 2, h: 2 });
  assert.deepEqual(run(m2, "w", 5000, 0, "magic2"), { w: 2, h: 20, left: 78.5 });
  assert.deepEqual(run(m2, "n", 0, 5000, "magic2"), { w: 20, h: 2, top: 38.5 });
  assert.deepEqual(run(m2, "se", 50 * G, 50 * G, "magic2"), { w: 70, h: 70 });
  // a west pull still stops at the stage's left edge
  assert.deepEqual(run(m2, "w", -5000, 0, "magic2"), { w: 80, h: 20, left: 0.5 });
});

test("a saved size outside a limit only changes on the axis being pulled", () => {
  const tall = box(5.5, 5.5, 31, 70);     // saved taller than the tickets' 63
  assert.deepEqual(run(tall, "e", G, 0, "tickets"), { w: 32, h: 70 });
  assert.deepEqual(run(tall, "s", 0, -G, "tickets"), { w: 31, h: 63 });
});

test("the resize handler goes through the clamp and loading a layout does not", () => {
  const start = HTML.indexOf("addEventListener(\"pointermove\", e => {\n  if (!sizing) return;");
  assert.ok(start >= 0, "resize handler found");
  const handler = HTML.slice(start, HTML.indexOf("\n});", start));
  assert.match(handler, /clampResize\(s, s\.dir, dx, dy, GRID, RESIZE_LIMITS\[regionId\(s\.el\)\]\)/);
  assert.doesNotMatch(handler, /2 \* GRID/, "the floor lives in the clamp now");
  const apply = HTML.slice(HTML.indexOf("function applySavedLayout(){"),
    HTML.indexOf("let dragging = null;"));
  assert.doesNotMatch(apply, /RESIZE_LIMITS|clampResize/, "saved sizes are reapplied as saved");
});

test("today's default sizes sit inside the limits", () => {
  const frac = name => Number(new RegExp("--" + name + ":(?:calc\\(var\\(--cw\\)\\*)?([0-9.]+)").exec(HTML)[1]);
  const defaults = {
    main: [frac("frame-w") * 1440, frac("frame-h") * 900],
    tickets: [frac("tik-w") * 1440, frac("tik-h") * 900],
    magic1: [frac("m1-w") * 1440, frac("m1-h") * 900],
  };
  // the clock has no set size: three lines of its own text, the longest a
  // date like "September 30th" in a monospace face about 0.6 of the font wide
  const font = /#clockbox\{[^}]*font:500 (\d+)px\/([0-9.]+)/.exec(HTML);
  assert.ok(font, "clock font found");
  defaults.clockbox = [14 * 0.6 * Number(font[1]), 3 * Number(font[1]) * Number(font[2])];
  for (const [id, [w, h]] of Object.entries(defaults)){
    const lim = RESIZE_LIMITS[id];
    assert.ok(w >= lim.minW * G && w <= lim.maxW * G, id + " default width " + cells(w) + " cells");
    assert.ok(h >= lim.minH * G && h <= lim.maxH * G, id + " default height " + cells(h) + " cells");
  }
});
