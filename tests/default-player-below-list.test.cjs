// Browser-free pin for where the board's default places the Spotify player
// (magic box 1) against the default ticket list. Both are fixed boxes sized from
// fractions of the 1440 by 900 stage, so the numbers in the stylesheet are the
// whole story: read them, do the sums, and run the real applySavedLayout in a
// fake page to show a saved place still wins over them.
//
// What it guards:
//   - the player starts one star row below the list's foot, on a star line, so
//     the two never overlap however many tickets the list holds (it scrolls
//     inside its own box).
//   - the player keeps its width and left edge, and is whole star rows tall.
//   - the player's foot stays within the room fitStage gives: it does not
//     shrink the stage at 1512 by 982 or at 1440 by 900, and its box stays
//     inside any window the card's foot fits (the responsive browser tests
//     measure it even while it is hidden).
//   - a saved place or size for the player is applied as it was saved and is
//     never rewritten, and a tab with nothing saved falls through to the
//     stylesheet's default.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const TOKENS = fs.readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");

const STAGE_H = 900;
const GRID = 1440 * 0.008;
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} is not ${b}`);

// a fraction the stylesheet declares once, as --name:0.123 (or inside calc)
function frac(name){
  const hits = [...HTML.matchAll(new RegExp("--" + name + ":(?:calc\\((?:var\\(--ox\\) \\+ )?var\\(--cw\\)\\*)?([0-9.]+)", "g"))];
  assert.equal(hits.length, 1, "--" + name + " is declared once");
  return Number(hits[0][1]);
}
// a const written on one line, as in "const FRAME_CLEAR = 16;"
function constant(name){
  const hit = new RegExp("\\b" + name + " = (\\d+)").exec(HTML);
  assert.ok(hit, name + " found");
  return Number(hit[1]);
}

const listTop = frac("tik-y") * STAGE_H;
const listBottom = (frac("tik-y") + frac("tik-h")) * STAGE_H;
const playerTop = frac("m1-y") * STAGE_H;
const playerBottom = (frac("m1-y") + frac("m1-h")) * STAGE_H;
const cardBottom = (frac("frame-y") + frac("frame-h")) * STAGE_H;

test("the default player starts one star row below the default list", () => {
  assert.ok(playerTop > listBottom, `player top ${playerTop} is not below list bottom ${listBottom}`);
  near(playerTop - listBottom, GRID, "the list-to-player gap");
  // the list's own scroll area runs a little past its box foot (--list-air)
  const air = Number(/--list-air:(\d+)px/.exec(HTML)[1]);
  assert.ok(playerTop - listBottom > air, "the gap clears the list's overhang");
});

test("the default player is on star lines, whole rows tall, and keeps its width and left edge", () => {
  const onStar = v => { const rows = (v - GRID / 2) / GRID; near(rows, Math.round(rows), v + " in star rows"); };
  onStar(playerTop);
  onStar(playerBottom);
  near((playerBottom - playerTop) / GRID, 11, "player height in rows");
  near(frac("m1-w") * 1440, 279.936, "player width");
  near(frac("m1-x") * 1440, 113.472, "player left");
  near(listTop, 190.08, "the list was not moved");
  near(listBottom, 696.96, "the list was not resized");
});

// fitStage fits the lowest visible region's foot inside the frame: the stage's
// foot may sit no lower than the window's height less the frame's inset, its
// border (at its widest, the careful side) and FRAME_CLEAR, with the bar above
function roomAt(windowHeight){
  const inset = Number(/--app-inset:(\d+)px/.exec(TOKENS)[1]);
  return windowHeight - inset - 1 - constant("FRAME_CLEAR") - constant("STAGE_BAR");
}

test("the player's foot does not shrink the stage at 1512 by 982 or at 1440 by 900", () => {
  assert.ok(playerBottom <= roomAt(982), `player foot ${playerBottom} is past the ${roomAt(982)} room at 1512 by 982`);
  assert.ok(playerBottom <= roomAt(900), `player foot ${playerBottom} is past the ${roomAt(900)} room at 1440 by 900`);
});

test("the player's box stays inside any window the card's foot fits", () => {
  // with the card the lowest region the fit puts its foot FRAME_CLEAR plus the
  // frame's inset and border above the window's foot; the player may hang below
  // the card by no more than that, or its box (measured even while hidden)
  // would reach past the window
  const slack = Number(/--app-inset:(\d+)px/.exec(TOKENS)[1]) + 1 + constant("FRAME_CLEAR");
  assert.ok(playerBottom - cardBottom <= slack,
    `player foot ${playerBottom} is ${playerBottom - cardBottom} below the card's ${cardBottom}, over the ${slack} allowed`);
});

test("the player's top and height are named only by its default and its own rule", () => {
  assert.equal(HTML.split("m1-y").length - 1, 2, "no script or other rule reads the player's top");
  assert.equal(HTML.split("m1-h").length - 1, 2, "no script or other rule reads the player's height");
});

// ---- saved places: the real applySavedLayout against a fake page -----------

function line(start){
  const at = HTML.indexOf(start);
  assert.ok(at >= 0, "found: " + start);
  return HTML.slice(at, HTML.indexOf("\n", at));
}
function fnSource(signature){
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++){
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}
const SOURCE = [
  "const GRID = 1440 * 0.008;",
  line("const onStar = "), line("const REGION_SEL = "),
  fnSource("function regionId(el)"), fnSource("function layoutSource()"),
  fnSource("function applySavedLayout()"),
  "this.apply = owner => { activeOwner = owner; applySavedLayout(); };",
].join("\n");

const IDS = ["main", "clockbox", "rail", "tickets", "magic1", "magic2", "magic3", "magic4", "goalbox"];

function board(saved){
  const writes = [], propertyCalls = [];
  const els = IDS.map(id => ({
    id: id === "main" ? "" : id, tagName: id === "main" ? "MAIN" : "DIV",
    style: { left: "", top: "", width: "", height: "",
      setProperty: (...args) => propertyCalls.push(args) },
    classList: { toggle: () => {}, add: () => {} },
  }));
  const sandbox = {
    document: { body: { dataset: {}, classList: { add: () => {} } }, querySelectorAll: () => els },
    settingsStore: { getItem: k => (k in saved ? saved[k] : null),
      setItem: (...a) => writes.push(a), removeItem: (...a) => writes.push(a) },
    regionHidden: () => false, fileNavBoxes: () => false, buildHandles: () => {}, seatPagePill: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext("let ownerReady = true, editMode = false, dragEnabled = true, activeOwner = '';\n" + SOURCE, sandbox);
  return { sandbox, writes, propertyCalls, player: els[IDS.indexOf("magic1")] };
}

test("a saved place and size for the player are applied as saved and never rewritten", () => {
  const b = board({
    "pos.kept.magic1": JSON.stringify({ x: 97.92, y: 650.88 }),
    "size.kept.magic1": JSON.stringify({ w: 276.48, h: 138.24 }),
  });
  b.sandbox.apply("kept");
  near(parseFloat(b.player.style.left), 97.92, "saved left");
  near(parseFloat(b.player.style.top), 650.88, "saved top");
  near(parseFloat(b.player.style.width), 276.48, "saved width");
  near(parseFloat(b.player.style.height), 138.24, "saved height");
  assert.deepEqual(b.writes, [], "applying a layout writes no setting");
  assert.deepEqual(b.propertyCalls, [], "no box's default token is overridden");
});

test("a tab with nothing saved leaves the player's top to the stylesheet default", () => {
  const b = board({});
  b.sandbox.apply("fresh");
  assert.equal(b.player.style.top, "");
  assert.equal(b.player.style.left, "");
  assert.deepEqual(b.writes, []);
});

test("a tab that has never been arranged still takes the first tab's saved player place", () => {
  const b = board({ "pos.facilitator.magic1": JSON.stringify({ x: 97.92, y: 731.52 }) });
  b.sandbox.apply("fresh");
  near(parseFloat(b.player.style.top), 731.52, "inherited top");
  assert.deepEqual(b.writes, []);
});
