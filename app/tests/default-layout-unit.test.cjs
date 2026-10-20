// Browser-free pin for the layout the owner chose in the 2026-10-12 mock as the
// board's starting layout: the clock, the ticket list and the card at these
// places and sizes (stage points, the stage being 1440 by 900), and every other
// box put away. It reads the numbers out of the real stylesheet, and runs the
// real layoutSource, regionHidden and applySavedLayout in a fake page, so what is
// shown is what a new project and a fresh install would draw.
//
// What it guards:
//   - the stylesheet's starting places and sizes are the chosen ones, in whole
//     cells with every edge on a star line, and onboarding.html's copy of them
//     matches index.html.
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
// the drawing's star pitch, which the starting layout is placed on. the board's
// edit step is half of it, so every one of these lines is a star line there too
const PITCH = STAGE_W * 0.008;
// the chosen layout, as measured on the owner's open mock (stage points)
const CHOSEN = {
  clockbox: { x: 28.8, y: 28.8, w: 218.88, h: 103.68 },
  tickets: { x: 40.32, y: 167.04, w: 368.64, h: 518.4 },
  main: { x: 466.56, y: 51.84, w: 506.88, h: 760.32 },
};
const SHOWN = ["clockbox", "tickets", "main"];
const HIDDEN = ["rail", "magic1", "magic2", "magic3", "magic4", "goalbox"];
const IDS = ["main", "clockbox", "rail", "tickets", "magic1", "magic2", "magic3", "magic4", "goalbox"];
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} is not ${b}`);

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

test("the stylesheet's starting places and sizes are the chosen layout", () => {
  sameRect(rectFromSheet(HTML, "clock"), CHOSEN.clockbox, "clock");
  sameRect(rectFromSheet(HTML, "tik"), CHOSEN.tickets, "tickets");
  sameRect(rectFromSheet(HTML, "frame"), CHOSEN.main, "card");
});

test("every starting edge is on a star line and every size is whole cells", () => {
  const onStar = v => { const n = (v - PITCH / 2) / PITCH; near(n, Math.round(n), v + " in star cells"); };
  const whole = v => { const n = v / PITCH; near(n, Math.round(n), v + " in cells"); };
  for (const r of Object.values(CHOSEN)) {
    onStar(r.x); onStar(r.y); onStar(r.x + r.w); onStar(r.y + r.h);
    whole(r.w); whole(r.h);
  }
});

test("onboarding.html copies the same list and card places as the board", () => {
  for (const name of ["tik-x", "tik-y", "tik-w", "tik-h", "frame-x", "frame-y", "frame-w", "frame-h"]) {
    near(frac(ONBOARDING, name), frac(HTML, name), "--" + name);
  }
});

// ---- what a new project and a fresh install draw: the real code, a fake page ---

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
