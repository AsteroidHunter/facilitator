// The white between the answered panel and the answer's first line is the same
// on every Mac card. The snap (snapCard in index.html) may only spend its line
// remainder over the answer, pushing it down off the panel, when the answer runs
// on past the bar. An answer that ends a line or two above the bar used to be
// pushed down by up to a line, which made that card's gap visibly taller than
// every other card's.
// snapCard runs out of index.html over a small fake card whose answer lines are
// rectangles at fixed places, so every number here is exact.
// No browser, layout engine, server or live board is involved.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const HTML = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function fnSource(signature) {
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}

const LINE = 27.9;          // the answer's 18px type on a 1.55 line
const HALF_LEADING = 2.25;  // the text box sits this far inside its line box
const ASCENT = 18, INK_ASCENT = 13.3, INK_DESCENT = 4;
const VIEW = { top: 230, bottom: 860 };
const BAR_TOP = 840;        // the bar's top edge, what the snap measures to
const CLEAR = 3.5;          // the answer's own clear air over the bar
const PANEL_BOTTOM = 344, MARK_ROOM = 17, SEAT_STEP = 8.55;
const SEAT_BOTTOM = PANEL_BOTTOM + MARK_ROOM + SEAT_STEP;

function card(lineCount) {
  const style = () => ({});
  const rect = r => () => ({ ...r, height: r.bottom - r.top });
  const lines = Array.from({ length: lineCount }, (_, i) => {
    const top = SEAT_BOTTOM + i * LINE + HALF_LEADING;
    return { top, bottom: top + 23.4, height: 23.4 };
  });
  const text = { rects: lines };
  const first = { getBoundingClientRect: () => ({ height: lineCount * LINE }), rects: lines };
  const reply = { style: style(), children: [first], textContent: "Invented answer", text };
  const view = { style: style(), scrollTop: 0, getBoundingClientRect: rect(VIEW) };
  const answ = { classList: { contains: () => false }, getBoundingClientRect: rect({ top: 230, bottom: PANEL_BOTTOM }) };
  const answwrap = { getBoundingClientRect: rect({ top: 230, bottom: SEAT_BOTTOM }) };
  const pendwrap = { getBoundingClientRect: rect({ top: BAR_TOP, bottom: VIEW.bottom }) };
  const head = { style: style() };
  const box = { classList: { contains: c => c === "sel" }, querySelector: () => head };
  const el = { box, reply, replyview: view, answ, answwrap, pendwrap, sentwrap: null, titleEl: { style: style() } };
  const computed = new Map([
    [reply, { lineHeight: LINE + "px", font: "18px sans-serif" }],
    [view, { marginBottom: CLEAR + "px", paddingTop: "0px" }],
    [answ, { marginBottom: MARK_ROOM + "px" }],
  ]);
  const context = {
    FOCUS: true, selectedId: "c1", els: { c1: el },
    fitTitle() {}, tiltTitleAir() {},
    boxBand: () => Math.round(VIEW.bottom - BAR_TOP + CLEAR),
    getComputedStyle: node => computed.get(node),
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      createElement: () => ({ getContext: () => ({ measureText: () => ({
        fontBoundingBoxAscent: ASCENT, actualBoundingBoxAscent: INK_ASCENT, actualBoundingBoxDescent: INK_DESCENT }) }) }),
      createRange: () => { let node; return { selectNodeContents(n) { node = n; }, getClientRects: () => node.rects }; },
      createTreeWalker: root => { let done = false; return { nextNode: () => (done ? null : (done = true, root.text)) }; },
    },
  };
  vm.createContext(context);
  vm.runInContext(fnSource("function snapCard(){"), context);
  context.snapCard();
  const room = (VIEW.bottom - VIEW.top) - context.boxBand() - (SEAT_BOTTOM - 230);
  return { reply, view, remainder: room % LINE };
}

test("an answer that ends a line or two above the bar is not pushed down off the panel", () => {
  // fifteen lines: the last one's ink ends 55.6px over the bar, under two lines,
  // where the old two-line rule still counted the white as a boundary to even out
  const { reply, view, remainder } = card(15);
  assert.equal(parseFloat(reply.style.marginTop) || 0, 0, "the answer was pushed down off the panel");
  assert.equal(view.style.marginBottom, (CLEAR + remainder).toFixed(2) + "px",
    "the whole remainder does not go under the answer");
});

test("an answer that runs on past the bar still shares the remainder with the white under the panel", () => {
  // twenty-five lines run past the bar, so the white over its last visible line
  // is a boundary and the snap evens the two out as before
  const { reply, view, remainder } = card(25);
  const upper = parseFloat(reply.style.marginTop);
  assert.ok(upper > 0.5 && upper < remainder, `upper share ${upper} of ${remainder}`);
  assert.equal(parseFloat(view.style.marginBottom).toFixed(2), (CLEAR + remainder - upper).toFixed(2));
});
