// Browser-free tests for the resize limits: clampResize and RESIZE_LIMITS in
// card-logic.js, run in a sandbox, plus a read of index.html to pin that the
// edit-mode resize handler goes through them and that the default layout sits
// inside every limit.
//
// What it guards:
//   - one step is 5.76 stage points, half the star pitch, on the board and on
//     the typed page, and a pull of one step moves an edge by exactly that.
//   - the star lines are every old line and one halfway between each two, so a
//     place saved on the old lines snaps back to the very same number.
//   - a drag past a box's largest size stops at that size, and past its
//     smallest stops at that one, for width and height separately; the limits
//     are the sizes they were on the old grid.
//   - a west or north pull keeps the far edge pinned while it stops.
//   - a box with no limits keeps the four-cell floor (two of the old cells)
//     and has no ceiling.
//   - only the pulled axes are held to the limits, so a saved size outside
//     them does not jump on the other axis.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "page.html"), "utf8");
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

// the board's GRID and onStar, as index.html writes them: the lines that start
// with them, so a GRID inside a function further up is not taken for it
function line(source, start){
  const at = source.indexOf("\n" + start);
  assert.ok(at >= 0, "found: " + start);
  return source.slice(at + 1, source.indexOf("\n", at + 1));
}
function snapOf(source){
  return vm.runInNewContext(line(source, "const GRID = ") + "\n" + line(source, "const onStar = ") +
    "\n({ GRID, onStar })");
}
const { GRID: G, onStar } = snapOf(HTML);
const PITCH = 1440 * 0.008;   // the star pitch of the drawing, the old step
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

test("one step is 5.76 stage points, half the star pitch, on the board and the typed page", () => {
  assert.equal(G, PITCH / 2);
  assert.ok(Math.abs(G - 5.76) < 1e-12, "the step is " + G);
  const page = snapOf(PAGE);
  assert.equal(page.GRID, G, "page.html steps as the board does");
  for (const v of [0, 3, 100, 466.56, 1000.1]) assert.equal(page.onStar(v), onStar(v), "page.html snaps " + v + " as the board does");
  // the star field is drawn at the same step
  assert.match(HTML, /--step:calc\(var\(--grid\) \/ 2\);/);
  assert.match(HTML, /background-size:var\(--step\) var\(--step\);/);
});

test("a pull of one step moves an edge by 5.76", () => {
  const card = box(81, 11, 92, 126);
  const wide = clampResize(card, "e", G, 0, G, RESIZE_LIMITS.main);
  assert.ok(Math.abs(wide.w - card.w - 5.76) < 1e-9, "east by one step: " + (wide.w - card.w));
  const tall = clampResize(card, "s", 0, G, G, RESIZE_LIMITS.main);
  assert.ok(Math.abs(tall.h - card.h - 5.76) < 1e-9, "south by one step: " + (tall.h - card.h));
  const west = clampResize(card, "w", -G, 0, G, RESIZE_LIMITS.main);
  assert.ok(Math.abs(card.left - west.left - 5.76) < 1e-9, "west by one step: " + (card.left - west.left));
  assert.ok(Math.abs(west.left + west.w - card.right) < 1e-9, "the right edge stays pinned");
  // under half a step snaps back, over half a step takes the next one
  assert.deepEqual(run(card, "e", 0.45 * G, 0, "main"), { w: 92, h: 126 });
  assert.deepEqual(run(card, "e", 0.55 * G, 0, "main"), { w: 93, h: 126 });
});

test("the star lines are every old line and one halfway between each two", () => {
  const oldStar = v => Math.round((v - PITCH / 2) / PITCH) * PITCH + PITCH / 2;
  for (let n = 0; n < 125; n++){
    // a place the old board saved, computed the way it computed it
    const old = oldStar(n * PITCH + PITCH / 2 + 0.3);
    assert.ok(Object.is(onStar(old), old), "the old line " + old + " came back as " + onStar(old));
    const between = old + PITCH / 2;
    assert.ok(Math.abs(onStar(between) - between) < 1e-9, between + " is a line now");
    assert.ok(Math.abs(onStar(old + 2.8) - old) < 1e-9, "2.8 past a line snaps back to it");
    assert.ok(Math.abs(onStar(old + 2.9) - between) < 1e-9, "2.9 past a line takes the next one");
  }
});

test("the four boxes each have a smallest and largest width and height", () => {
  assert.deepEqual(Object.keys(RESIZE_LIMITS).sort(), ["clockbox", "magic1", "main", "tickets"]);
  const regions = /const REGION_SEL = "([^"]+)"/.exec(HTML)[1];
  for (const [id, lim] of Object.entries(RESIZE_LIMITS)){
    assert.ok(regions.includes(id === "main" ? "main" : "#" + id), id + " is a board region");
    for (const k of ["minW", "maxW", "minH", "maxH"])
      assert.ok(Number.isInteger(lim[k]) && lim[k] >= 4, id + " " + k + " is whole cells, at least four");
    assert.ok(lim.minW < lim.maxW && lim.minH < lim.maxH, id + " smallest is under largest");
    // the stage is 250 by 156 cells, with a cell kept clear at the edge
    assert.ok(lim.maxW <= 248 && lim.maxH <= 154, id + " fits on the stage");
  }
});

test("the limits are the sizes they were on the old grid", () => {
  const OLD = {
    main:     { minW: 30, maxW: 70, minH: 40, maxH: 76 },
    tickets:  { minW: 22, maxW: 46, minH: 16, maxH: 63 },
    magic1:   { minW: 16, maxW: 40, minH: 8,  maxH: 24 },
    clockbox: { minW: 14, maxW: 34, minH: 7,  maxH: 16 },
  };
  for (const [id, lim] of Object.entries(OLD))
    for (const k of Object.keys(lim))
      assert.ok(Math.abs(RESIZE_LIMITS[id][k] * G - lim[k] * PITCH) < 1e-9, id + " " + k);
});

test("a drag past the largest size stops at the largest size", () => {
  const card = box(81, 11, 92, 126);
  assert.deepEqual(run(card, "e", 5000, 0, "main"), { w: 140, h: 126 });
  assert.deepEqual(run(card, "s", 0, 5000, "main"), { w: 92, h: 152 });
  assert.deepEqual(run(card, "se", 5000, 5000, "main"), { w: 140, h: 152 });
  const spot = box(13, 113, 48, 24);
  assert.deepEqual(run(spot, "se", 5000, 5000, "magic1"), { w: 80, h: 48 });
  const clock = box(5, 5, 36, 18);
  assert.deepEqual(run(clock, "se", 5000, 5000, "clockbox"), { w: 68, h: 32 });
});

test("a drag past the smallest size stops at the smallest size", () => {
  const card = box(81, 11, 92, 126);
  assert.deepEqual(run(card, "e", -5000, 0, "main"), { w: 60, h: 126 });
  assert.deepEqual(run(card, "s", 0, -5000, "main"), { w: 92, h: 80 });
  const tik = box(11, 31, 62, 74);
  assert.deepEqual(run(tik, "se", -5000, -5000, "tickets"), { w: 44, h: 32 });
  const clock = box(5, 5, 36, 18);
  assert.deepEqual(run(clock, "se", -5000, -5000, "clockbox"), { w: 28, h: 14 });
});

test("inside the limits a drag still snaps to whole cells as before", () => {
  const card = box(81, 11, 92, 126);
  assert.deepEqual(run(card, "e", 6.4 * G, 0, "main"), { w: 98, h: 126 });
  assert.deepEqual(run(card, "s", 0, -5.2 * G, "main"), { w: 92, h: 121 });
  assert.deepEqual(run(card, "w", -8.8 * G, 0, "main"), { w: 101, h: 126, left: 72 });
});

test("a west pull stops at the limit with the right edge pinned", () => {
  const card = box(81, 11, 92, 126);   // right edge at 173
  const grow = run(card, "w", -5000, 0, "main");
  assert.deepEqual(grow, { w: 140, h: 126, left: 33 });
  assert.equal(grow.left + grow.w, 173);
  const shrink = run(card, "w", 5000, 0, "main");
  assert.deepEqual(shrink, { w: 60, h: 126, left: 113 });
  assert.equal(shrink.left + shrink.w, 173);
});

test("a north pull stops at the limit with the bottom edge pinned", () => {
  const tik = box(11, 67, 62, 74);    // bottom edge at 141
  const grow = run(tik, "n", 0, -5000, "tickets");
  assert.deepEqual(grow, { w: 62, h: 126, top: 15 });
  assert.equal(grow.top + grow.h, 141);
  const shrink = run(tik, "n", 0, 5000, "tickets");
  assert.deepEqual(shrink, { w: 62, h: 32, top: 109 });
  assert.equal(shrink.top + shrink.h, 141);
  // the stage's top edge still wins over a largest size it cannot reach
  const card = box(81, 11, 92, 126);   // bottom edge at 137
  assert.deepEqual(run(card, "n", 0, -5000, "main"), { w: 92, h: 136, top: 1 });
});

test("a corner pull toward the top left holds both far edges", () => {
  const spot = box(61, 81, 48, 24);  // right 109, bottom 105
  const grow = run(spot, "nw", -5000, -5000, "magic1");
  assert.deepEqual(grow, { w: 80, h: 48, left: 29, top: 57 });
  const shrink = run(spot, "nw", 5000, 5000, "magic1");
  assert.deepEqual(shrink, { w: 32, h: 16, left: 77, top: 89 });
});

test("other boxes keep the four-cell floor and have no ceiling", () => {
  const m2 = box(121, 41, 40, 40);
  assert.equal(RESIZE_LIMITS.magic2, undefined);
  assert.deepEqual(run(m2, "se", -5000, -5000, "magic2"), { w: 4, h: 4 });
  assert.deepEqual(run(m2, "w", 5000, 0, "magic2"), { w: 4, h: 40, left: 157 });
  assert.deepEqual(run(m2, "n", 0, 5000, "magic2"), { w: 40, h: 4, top: 77 });
  assert.deepEqual(run(m2, "se", 100 * G, 100 * G, "magic2"), { w: 140, h: 140 });
  // a west pull still stops at the stage's left edge
  assert.deepEqual(run(m2, "w", -5000, 0, "magic2"), { w: 160, h: 40, left: 1 });
});

test("a saved size outside a limit only changes on the axis being pulled", () => {
  const tall = box(11, 11, 62, 140);     // saved taller than the tickets' 126
  assert.deepEqual(run(tall, "e", G, 0, "tickets"), { w: 63, h: 140 });
  assert.deepEqual(run(tall, "s", 0, -G, "tickets"), { w: 62, h: 126 });
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
    clockbox: [frac("clock-w") * 1440, frac("clock-h") * 900],
  };
  // the clock's set size has to hold three lines of its own text, the longest a
  // date like "September 30th" in a monospace face about 0.6 of the font wide
  const font = /#clockbox\{[^}]*font:500 (\d+)px\/([0-9.]+)/.exec(HTML);
  assert.ok(font, "clock font found");
  assert.ok(defaults.clockbox[0] >= 14 * 0.6 * Number(font[1]), "the clock is wide enough for its longest date");
  assert.ok(defaults.clockbox[1] >= 3 * Number(font[1]) * Number(font[2]) - 1, "the clock is tall enough for its three lines");
  for (const [id, [w, h]] of Object.entries(defaults)){
    const lim = RESIZE_LIMITS[id];
    assert.ok(w >= lim.minW * G && w <= lim.maxW * G, id + " default width " + cells(w) + " cells");
    assert.ok(h >= lim.minH * G && h <= lim.maxH * G, id + " default height " + cells(h) + " cells");
  }
});
