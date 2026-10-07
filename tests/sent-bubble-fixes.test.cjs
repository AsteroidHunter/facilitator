// The owner's fixes to the sent bubbles,
// one group of checks for each, every one of them failing on the code before
// the fix. No browser and no board runs: card-logic.js is loaded into a bare
// context and given synthetic boxes, and the sheets are read as text, so
// nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");

function load(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  // the file's constants are not properties of the context; this reads them
  context.read = name => vm.runInContext(name, context);
  return context;
}

// ---- 1. the send motion: sideways, then up, then an accordion-like compress -------------
// the phone's one-line example: the typing box, and the bubble the send lands on
const FROM = { left: 17.5, top: 500, width: 317.6, height: 43.3 };
const TO = { left: 199.7, top: 422.1, width: 160, height: 52.5 };
function flight() {
  const c = load();
  const out = [], length = c.read("SENT_FLIGHT_MS");
  assert.ok(length > 0, "the flight has no length");
  for (let ms = 0; ms <= length; ms++) {
    const at = c.sentTrack(ms);
    const { frame, box } = c.sentMorphBox(FROM, TO, at);
    out.push({ ms, at, frame, box });
  }
  return out;
}

test("a send moves sideways and up with no zoom in and out: nothing shrinks and grows back, no edge passes its landing", () => {
  for (const { ms, frame, box } of flight()) {
    // the box drawn is the travelling box itself, never scaled down about a corner
    assert.ok(Math.abs(box.width - (frame.right - frame.left)) < 1e-9, `the box is drawn at another size than it travels at ${ms}ms`);
    assert.ok(box.left >= FROM.left - 1e-9 && box.left <= TO.left + 1e-9, `the left edge passed its landing at ${ms}ms (${box.left})`);
    const right = box.left + box.width;
    assert.ok(right >= FROM.left + FROM.width - 1e-9 && right <= TO.left + TO.width + 1e-9, `the right end passed its landing at ${ms}ms (${right})`);
    assert.ok(box.top >= TO.top - 1e-9, `the top rose past its landing at ${ms}ms (${box.top})`);
  }
});

test("a send ends with an accordion-like compress: taller as it rises, then closing down onto the bubble under its landed top", () => {
  const frames = flight();
  let foot = Infinity, tallest = 0;
  for (const { ms, box } of frames) {
    const bottom = box.top + box.height;
    assert.ok(bottom <= foot + 1e-9 || ms === 0, `the box's foot went down at ${ms}ms`);
    foot = bottom;
    tallest = Math.max(tallest, box.height / TO.height);
  }
  assert.ok(tallest >= 1.15, `the box never stands taller than the bubble to close down from (${tallest.toFixed(3)})`);
  const landed = frames.find(f => Math.abs(f.box.top - TO.top) < 1e-9);
  assert.ok(landed, "the top never lands");
  const closing = frames.filter(f => f.ms >= landed.ms);
  assert.ok(closing.length >= 150, `the compress after the top lands is too short (${closing.length}ms)`);
  assert.ok(landed.box.height >= 1.1 * TO.height, `the box has nothing left to close when its top lands (${landed.box.height})`);
  for (let i = 1; i < closing.length; i++)
    assert.ok(closing[i].box.height <= closing[i - 1].box.height + 1e-9, `the box grew again while closing at ${closing[i].ms}ms`);
  const end = frames.at(-1).box;
  assert.ok(Math.abs(end.height - TO.height) < 1e-9 && Math.abs(end.top - TO.top) < 1e-9, "the box does not close exactly onto the bubble");
});
