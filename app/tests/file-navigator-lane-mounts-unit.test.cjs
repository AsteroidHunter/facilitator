// Deterministic, browser-free regression for the navigator mount map and the
// visibility of a configured reader. It extracts the ACTUAL FILENAV_SLOTS + fileNavMounts
// bytes and the DEFAULT_HIDDEN_REGIONS + regionHidden bytes from index.html and
// runs them in a tiny sandbox with a fake settings store, so which box each lane
// lands on, and whether that box is on screen by default, are checked without
// any browser. This guards the real source: if fileNavMounts goes back to dropping
// lanes past the two slots, if an overflow lane starts landing on magic box 3
// (the box the picture panel and chat also share), or if a configured reader
// stops showing by default or stops honouring an explicit hide, these fail.
// Every lane name here is invented, never a configured project name.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// pull a run of bytes between two stable anchors, failing loudly if either moves
function between(startAnchor, endMark) {
  const start = HTML.indexOf(startAnchor);
  assert.ok(start >= 0, "anchor not found: " + startAnchor);
  const end = HTML.indexOf(endMark, start);
  assert.ok(end > start, "end mark not found: " + endMark);
  return HTML.slice(start, end + endMark.length);
}

// a function body by brace matching, so a nested block cannot cut it short
function fnSource(signature) {
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  const open = i;
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}

const MOUNT_SRC = between("const FILENAV_SLOTS = [", "return FILENAV_MOUNTS;\n}");
const HIDDEN_SET = between('const DEFAULT_HIDDEN_REGIONS = new Set([', ']);');
const REGION_HIDDEN = fnSource("function regionHidden(owner, id)");

// Build a runnable copy of the real blocks with a Map-backed settings store,
// the board's own (board-settings.js) that the page reads these keys from. The
// two blocks share FILENAV_MOUNTS and the store, exactly as they do in the page.
function build() {
  const preamble = `
    const __store = new Map();
    const settingsStore = {
      getItem: k => __store.has(k) ? __store.get(k) : null,
      setItem: (k, v) => __store.set(k, String(v)),
      removeItem: k => __store.delete(k),
    };
  `;
  const tail = `
    ctl.fileNavMounts = fileNavMounts;
    ctl.regionHidden = regionHidden;
    ctl.defaultHidden = DEFAULT_HIDDEN_REGIONS;
    ctl.slotBoxes = () => FILENAV_SLOTS.map(s => s.box);
    ctl.boxOf = lane => (FILENAV_MOUNTS[lane] && FILENAV_MOUNTS[lane].box) || null;
    ctl.lanes = () => Object.keys(FILENAV_MOUNTS);
    ctl.set = (k, v) => settingsStore.setItem(k, v);
    ctl.clear = () => __store.clear();
  `;
  const factory = new Function("ctl",
    preamble + "\n" + MOUNT_SRC + "\n" + HIDDEN_SET + "\n" + REGION_HIDDEN + "\n" + tail);
  const ctl = {};
  factory(ctl);
  return ctl;
}

// the navigator-only box (no picture or chat tenant) is the last slot, and both
// the overflow rule and the visibility rule lean on it, so pin the layout here.
const READER_BOX = "magic4";

// three invented lanes standing in for a board that names three navigator lanes
const A = "cascade", B = "meridian", C = "orchard", NONE = "almanac";

test("the two configured homes are magic box 3 then the navigator-only box", () => {
  const m = build();
  assert.deepEqual(m.slotBoxes(), ["magic3", READER_BOX]);
  assert.equal(m.slotBoxes()[m.slotBoxes().length - 1], READER_BOX,
    "the last slot must be the box with no picture or chat tenant, or overflow lanes could collide");
});

test("one lane mounts in the first slot", () => {
  const m = build();
  m.fileNavMounts([A]);
  assert.equal(m.boxOf(A), "magic3");
  assert.deepEqual(m.lanes(), [A]);
});

test("the first two lanes keep their own homes", () => {
  const m = build();
  m.fileNavMounts([A, B]);
  assert.equal(m.boxOf(A), "magic3");
  assert.equal(m.boxOf(B), READER_BOX);
});

test("a third lane gains the reader on the right without displacing the first two", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);
  assert.equal(m.boxOf(A), "magic3");
  assert.equal(m.boxOf(B), READER_BOX);
  assert.equal(m.boxOf(C), READER_BOX,
    "the third configured lane must gain a home, not fall off the panel");
});

test("overflow lanes never land on the picture and chat box", () => {
  const m = build();
  m.fileNavMounts([A, B, C, "delta", "echo"]);
  for (const lane of [C, "delta", "echo"]) {
    assert.equal(m.boxOf(lane), READER_BOX, lane + " must reuse the navigator-only box");
    assert.notEqual(m.boxOf(lane), "magic3");
  }
});

test("no configured lanes leaves the panel off on every tab", () => {
  const m = build();
  m.fileNavMounts([]);
  assert.deepEqual(m.lanes(), []);
  m.fileNavMounts(undefined);
  assert.deepEqual(m.lanes(), []);
});

// ---- visibility: a configured reader shows by default -----------------------

test("a lane's configured reader box is on screen by default", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);
  // each navigator lane's own reader box is not hidden, without any show key
  assert.equal(m.regionHidden(A, "magic3"), false, "first lane's reader hidden by default");
  assert.equal(m.regionHidden(B, READER_BOX), false, "second lane's reader hidden by default");
  assert.equal(m.regionHidden(C, READER_BOX), false, "third lane's reader hidden by default");
});

test("the reader box is the only default-hidden region a configured lane reveals", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);
  // the third lane's box shows, but the other default-hidden boxes stay hidden:
  // the change is scoped to the reader, not a wholesale reveal of the layout
  assert.equal(m.regionHidden(C, READER_BOX), false);
  for (const id of ["magic3", "magic1", "magic2", "rail", "goalbox"]) {
    if (id === READER_BOX) continue;
    assert.equal(m.regionHidden(C, id), true, id + " should stay hidden for a configured lane");
  }
});

test("a lane with no configured reader keeps the plain default layout", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);   // NONE is not among them
  for (const id of ["magic3", "magic4", "magic1", "magic2", "rail", "goalbox"]) {
    assert.equal(m.regionHidden(NONE, id), true,
      NONE + " has no reader, so " + id + " must stay hidden by default");
  }
  // and its always-on elements are still on
  for (const id of ["main", "clockbox", "tickets"]) {
    assert.equal(m.regionHidden(NONE, id), false, id + " is a default element and must show");
  }
});

test("an explicit hide is honoured even for the configured reader box", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);
  m.set("hide." + C + "." + READER_BOX, "1");
  assert.equal(m.regionHidden(C, READER_BOX), true,
    "an explicit hide must win over the configured-reader default, not be overwritten");
});

test("an explicit show still reveals a default-hidden non-reader box", () => {
  const m = build();
  m.fileNavMounts([A, B, C]);
  // the reveal path other widgets use is untouched by the reader change
  m.set("show." + C + ".magic2", "1");
  assert.equal(m.regionHidden(C, "magic2"), false);
});

test("the configured-reader default does not depend on a show key (fresh storage)", () => {
  const m = build();
  m.clear();                 // no migration keys, no show keys: brand new storage
  m.fileNavMounts([A, B, C]);
  assert.equal(m.regionHidden(C, READER_BOX), false,
    "a fresh board must show the configured reader without a planted show key");
});
