// Browser-free pin for the layout the owner set in the 2026-10-20 layout mock
// (m1330) as the board's starting layout: the clock, the ticket list and the
// card at these places and sizes (stage points, the stage being 1440 by 900),
// every other box put away at its own starting place, and the card's magic box
// at the size and gap set there. It reads the numbers out of the real
// stylesheet and magic-box.js, and runs the real layoutSource, regionHidden and
// applySavedLayout in a fake page, so what is shown is what a new project and a
// fresh install would draw.
//
// What it guards:
//   - the stylesheet's starting places and sizes are the owner's, for all nine
//     boxes; the three on screen are whole edit steps with every edge on a star
//     line, and onboarding.html's copy of them matches index.html.
//   - the card's magic box, beside the starting card in the laptop's 1512 wide
//     window, is 385.92 by 720 and stands 52.19 right of the card, level with
//     its middle, and keeps that gap in a wider window.
//   - a fresh install (nothing saved at all) and a new project (nothing saved for
//     it, and nothing for the facilitator project either) show the clock, the
//     list and the card, hide the rest, and write no inline place or size, so the
//     stylesheet's starting layout is what draws.
//   - the settings change that gives an existing project this same layout, in the
//     board's own key names and units, is accepted by the store and is what a new
//     project then inherits, with the same three boxes shown.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { create, isSetting } = require("../board-settings.js");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const ONBOARDING = fs.readFileSync(path.join(ROOT, "onboarding.html"), "utf8");

const STAGE_W = 1440, STAGE_H = 900;
// the owner's layout, as saved by the layout mock (stage points)
const LAYOUT = {
  main: { x: 460.8, y: 51.84, w: 518.4, h: 766.08, hidden: false },
  tickets: { x: 40.32, y: 172.8, w: 362.88, h: 512.64, hidden: false },
  clockbox: { x: 28.8, y: 28.8, w: 218.88, h: 103.68, hidden: false },
  rail: { x: 489.6, y: 858.24, w: 460.8, h: 23.04, hidden: true },
  magic1: { x: 113.472, y: 696.96, w: 279.936, h: 126.72, hidden: true },
  magic2: { x: 1077.12, y: 28.8, w: 311.04, h: 368.64, hidden: true },
  magic3: { x: 1054.08, y: 466.56, w: 288, h: 218.88, hidden: true },
  magic4: { x: 1054.08, y: 685.44, w: 288, h: 172.8, hidden: true },
  goalbox: { x: 1134.72, y: 743.04, w: 276.48, h: 126.72, hidden: true },
};
// and the card's magic box in the laptop's window, set in the same mock
const MAGIC = { width: 385.92, height: 720, gap: 52.19 };
const SHOWN = Object.keys(LAYOUT).filter(id => !LAYOUT[id].hidden);
const HIDDEN = Object.keys(LAYOUT).filter(id => LAYOUT[id].hidden);
const CHOSEN = Object.fromEntries(SHOWN.map(id => [id, LAYOUT[id]]));
const IDS = ["main", "clockbox", "rail", "tickets", "magic1", "magic2", "magic3", "magic4", "goalbox"];
const near = (a, b, label, by = 1e-6) => assert.ok(Math.abs(a - b) < by, `${label}: ${a} is not ${b}`);

// the line that starts with this, so a GRID inside a function further up is
// not taken for the board's
function line(start) {
  const at = HTML.indexOf("\n" + start);
  assert.ok(at >= 0, "found: " + start);
  return HTML.slice(at + 1, HTML.indexOf("\n", at + 1));
}
function between(startAnchor, endMark) {
  const start = HTML.indexOf(startAnchor);
  assert.ok(start >= 0, "anchor not found: " + startAnchor);
  const end = HTML.indexOf(endMark, start);
  assert.ok(end > start, "end mark not found: " + endMark);
  return HTML.slice(start, end + endMark.length);
}
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
// the board's own edit step, one star line to the next
const STEP = vm.runInNewContext(line("const GRID = ") + "\nGRID");

// a fraction the stylesheet declares once, as --name:0.123 (or inside calc)
function frac(source, name) {
  const hits = [...source.matchAll(new RegExp("--" + name + ":(?:calc\\((?:var\\(--ox\\) \\+ )?var\\(--cw\\)\\*)?([0-9.]+)", "g"))];
  assert.equal(hits.length, 1, "--" + name + " is declared once");
  return Number(hits[0][1]);
}
function rectFromSheet(source, prefix) {
  return { x: frac(source, prefix + "-x") * STAGE_W, y: frac(source, prefix + "-y") * STAGE_H,
    w: frac(source, prefix + "-w") * STAGE_W, h: frac(source, prefix + "-h") * STAGE_H };
}
function sameRect(got, want, label) {
  for (const k of ["x", "y", "w", "h"]) near(got[k], want[k], label + " " + k);
}
// each box's starting rectangle, from the tokens its own rule reads
function startOf(id) {
  if (id === "main") return rectFromSheet(HTML, "frame");
  if (id === "tickets") return rectFromSheet(HTML, "tik");
  if (id === "clockbox") return rectFromSheet(HTML, "clock");
  if (id === "magic1") return rectFromSheet(HTML, "m1");
  if (id === "magic2") return rectFromSheet(HTML, "tg");
  if (id === "magic3") return rectFromSheet(HTML, "m2");
  if (id === "goalbox") return rectFromSheet(HTML, "goal");
  if (id === "magic4") {
    // magic box 3's column, from that box's foot, at its own height
    assert.match(HTML, /#magic4\{left:var\(--m2-x\); width:var\(--m2-w\);\s*top:calc\(var\(--oy\) \+ var\(--ch\)\*var\(--m4-y\)\); height:calc\(var\(--ch\)\*var\(--m4-h\)\)\}/);
    assert.match(HTML, /--m4-y:calc\(var\(--m2-y\) \+ var\(--m2-h\)\);/);
    const three = rectFromSheet(HTML, "m2");
    return { x: three.x, y: three.y + three.h, w: three.w, h: frac(HTML, "m4-h") * STAGE_H };
  }
  if (id === "rail") {
    const rule = between("  body.focus #rail{", "}");
    assert.match(rule, /left:var\(--rail-x\);\s*width:var\(--rail-w\);\s*top:calc\(var\(--oy\) \+ var\(--ch\)\*var\(--rail-y\)\);\s*height:calc\(2\*var\(--grid\)\);/);
    return { x: frac(HTML, "rail-x") * STAGE_W, y: frac(HTML, "rail-y") * STAGE_H,
      w: frac(HTML, "rail-w") * STAGE_W, h: 2 * frac(HTML, "grid") * STAGE_W };
  }
  throw new Error("no starting place for " + id);
}

test("the stylesheet's starting places and sizes are the owner's layout, all nine boxes", () => {
  for (const id of IDS) sameRect(startOf(id), LAYOUT[id], id);
});

test("every starting edge of the three boxes on screen is on a star line and every size is whole steps", () => {
  near(STEP, 5.76, "the edit step");
  const whole = (v, label) => { const n = v / STEP; near(n, Math.round(n), label + " " + v + " in steps"); };
  for (const [id, r] of Object.entries(CHOSEN)) {
    whole(r.x, id); whole(r.y, id); whole(r.x + r.w, id); whole(r.y + r.h, id);
    whole(r.w, id); whole(r.h, id);
  }
});

test("onboarding.html copies the same list and card places as the board", () => {
  for (const name of ["tik-x", "tik-y", "tik-w", "tik-h", "frame-x", "frame-y", "frame-w", "frame-h"]) {
    near(frac(ONBOARDING, name), frac(HTML, name), "--" + name);
  }
});

// ---- the card's magic box beside the starting card -----------------------------

function magicBox() {
  const scope = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, "magic-box.js"), "utf8"), scope);
  return scope.MagicBox;
}
// the workspace in a window w wide, as magicPlace hands it over (the magic box
// tests' own model): the frame's inner right edge 6.5 in from the window's side
const fitAt = w => ({ scale: 1, tx: Math.max(0, (w - 1440) / 2), right: w - 6.5, clear: 16 });

test("the card's magic box is the owner's size and stands where it was set, in the laptop's window and wider", () => {
  const { place } = magicBox();
  const card = { left: startOf("main").x, top: startOf("main").y, width: startOf("main").w, height: startOf("main").h };
  const right = card.left + card.width, middle = card.top + card.height / 2;
  const at = place(card, fitAt(1512));
  assert.equal(at.shown, true);
  near(at.width, MAGIC.width, "width");
  near(at.height, MAGIC.height, "height");
  near(at.left - right, MAGIC.gap, "gap from the card's right edge", 0.01);
  near(at.top + at.height / 2, middle, "level with the card's middle");
  // a wider window is only more room: the box keeps its size and its gap
  for (const w of [1600, 1920, 2560]) {
    const wide = place(card, fitAt(w));
    near(wide.width, MAGIC.width, w + " width");
    near(wide.height, MAGIC.height, w + " height");
    near(wide.left - right, MAGIC.gap, w + " gap", 0.02);
  }
});

// ---- what a new project and a fresh install draw: the real code, a fake page ---

const SOURCE = [
  line("const GRID = "), line("const onStar = "), line("const REGION_SEL = "),
  between("const DEFAULT_HIDDEN_REGIONS = new Set([", "]);"),
  fnSource("function regionId(el)"), fnSource("function layoutSource()"),
  fnSource("function regionHidden(owner, id)"), fnSource("function applySavedLayout()"),
  "this.apply = owner => { activeOwner = owner; applySavedLayout(); };",
].join("\n");

// the board's real settings store over an empty or planted seed, as a page gets it
function board(values) {
  const store = create({ seed: { rev: 0, values }, local: { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null },
    fetch: () => new Promise(() => {}), later: () => {} });
  const off = {};
  const els = IDS.map(id => ({
    id: id === "main" ? "" : id, tagName: id === "main" ? "MAIN" : "DIV",
    style: { left: "", top: "", width: "", height: "", setProperty() {} },
    classList: { toggle: (name, on) => { if (name === "region-off") off[id] = !!on; }, add() {} },
  }));
  const sandbox = {
    document: { body: { dataset: {}, classList: { add() {} } }, querySelectorAll: () => els },
    settingsStore: store, FILENAV_MOUNTS: {}, fileNavBoxes: () => false, buildHandles() {}, seatPagePill() {},
  };
  vm.createContext(sandbox);
  vm.runInContext("let ownerReady = true, editMode = false, dragEnabled = true, activeOwner = '';\n" + SOURCE, sandbox);
  return { sandbox, els, off, byId: id => els[IDS.indexOf(id)], store };
}
function shownIds(off) { return IDS.filter(id => off[id] === false); }

test("a fresh install shows the clock, the list and the card from the stylesheet, nothing saved", () => {
  const b = board({});
  b.sandbox.apply("facilitator");
  assert.deepEqual(shownIds(b.off).sort(), [...SHOWN].sort(), "shown");
  assert.deepEqual(IDS.filter(id => b.off[id] === true).sort(), [...HIDDEN].sort(), "put away");
  for (const el of b.els) assert.deepEqual([el.style.left, el.style.top, el.style.width, el.style.height], ["", "", "", ""],
    "no inline place or size, so the stylesheet draws");
  assert.equal(b.store.length, 0, "applying wrote no setting");
});

test("a new project with nothing saved starts the same way", () => {
  const b = board({});
  b.sandbox.apply("a-brand-new-project");
  assert.deepEqual(shownIds(b.off).sort(), [...SHOWN].sort());
  for (const el of b.els) assert.equal(el.style.left + el.style.top + el.style.width + el.style.height, "");
});

test("the settings change for the facilitator project is valid and what a new project inherits", () => {
  const change = {};
  for (const [id, r] of Object.entries(CHOSEN)) {
    change["pos.facilitator." + id] = JSON.stringify({ x: r.x, y: r.y });
    change["size.facilitator." + id] = JSON.stringify({ w: r.w, h: r.h });
  }
  for (const key of Object.keys(change)) assert.ok(isSetting(key), key + " is a setting key the board accepts");
  const b = board(change);
  b.sandbox.apply("another-new-project");
  assert.deepEqual(shownIds(b.off).sort(), [...SHOWN].sort(), "same boxes shown and put away");
  for (const [id, r] of Object.entries(CHOSEN)) {
    const el = b.byId(id);
    sameRect({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) },
      r, id);
  }
});
