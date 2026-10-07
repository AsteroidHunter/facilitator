// the sent bubbles coming together, without a browser: the owner's rule for
// which bubbles may join (only when the new message stands in
// the same place as the one before it: not delivered, Delivered or Read),
// the order and lengths of the merge, and the
// two drops' outline, frame by frame, read off the real card-logic.js and
// card-tokens.css. boxes are synthetic; no layout engine runs, so nothing here
// claims how the merge looks on a phone (it was watched on the simulator)
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const CSS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
const DESKTOP = readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
function load() {
  const context = vm.createContext({ console });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  return { context, run: source => vm.runInContext(source, context) };
}
const plain = value => JSON.parse(JSON.stringify(value));
const m = (text, stage) => ({ text, stage });
// the groups a pass gives, as the words in each
const words = groups => plain(groups.map(group => group.msgs.map(one => one.text)));

test("where a message stands is the owner's three places: not delivered yet, Delivered and Read", () => {
  const { context } = load();
  assert.equal(context.sentState(m("a", "local")), "local");
  assert.equal(context.sentState(m("a", "sent")), "Delivered");
  assert.equal(context.sentState(m("a", "delivered")), "Read");
  assert.equal(context.sentState(m("a", "read")), "Read", "the board's two read stages are two places");
  // a bubble stands where its newest message stands
  assert.equal(context.sentStands([m("a", "read"), m("b", "sent")]), "Delivered");
  assert.equal(context.sentStands([]), null);
});

test("a first draw gives every run of messages standing in one place one bubble", () => {
  const { context } = load();
  const shown = [m("a", "read"), m("b", "delivered"), m("c", "sent"), m("d", "sent"), m("e", "local")];
  assert.deepEqual(words(context.sentGroups([], shown, null)), [["a", "b"], ["c", "d"], ["e"]]);
});

test("a send this page makes stands in a bubble of its own, even where the bubble above it stands", () => {
  const { context } = load();
  const before = [[m("a", "sent")]];
  const own = m("b", "sent");
  const groups = context.sentGroups(before, [m("a", "sent"), own], own);
  assert.deepEqual(words(groups), [["a"], ["b"]], "the send went into the bubble standing");
  assert.equal(groups[0].id, 0, "the bubble standing was not kept");
  assert.ok(groups[1].id >= before.length, "the send's bubble is not a new one");
  // still on its way, under one still on its way
  const local = m("y", "local");
  assert.deepEqual(words(context.sentGroups([[m("x", "local")]], [m("x", "local"), local], local)), [["x"], ["y"]]);
});

test("a reading's new message joins the bubble before it only where that bubble stands", () => {
  const { context } = load();
  const before = [[m("a", "sent")]];
  assert.deepEqual(words(context.sentGroups(before, [m("a", "sent"), m("b", "sent")], null)), [["a", "b"]],
    "a message from elsewhere standing where the bubble stands stood apart");
  for (const stage of ["local", "delivered", "read"])
    assert.deepEqual(words(context.sentGroups(before, [m("a", "sent"), m("b", stage)], null)), [["a"], ["b"]],
      `a ${stage} message from elsewhere joined a Delivered bubble`);
  // landing between two messages of one bubble, it joins that bubble rather than splitting it
  const two = [[m("a", "sent"), m("c", "local")]];
  assert.deepEqual(words(context.sentGroups(two, [m("a", "sent"), m("b", "read"), m("c", "local")], null)), [["a", "b", "c"]]);
});

test("a bubble once joined stays one whatever its messages do next, and keeps its words in place", () => {
  const { context } = load();
  // joined while both were on their way; the first has landed and the second not
  const before = [[m("a", "local"), m("b", "local")]];
  const groups = context.sentGroups(before, [m("a", "sent"), m("b", "local")], null);
  assert.deepEqual(words(groups), [["a", "b"]], "a joined bubble came apart");
  assert.equal(groups[0].id, 0);
  // what goes leaves the rest where they stood, and an emptied bubble goes
  const three = [[m("a", "read")], [m("b", "sent"), m("c", "sent")]];
  assert.deepEqual(plain(context.sentGroups(three, [m("b", "sent"), m("c", "sent")], null)).map(g => g.id), [1]);
});

test("the merge keeps the owner's order and reads calmly: the word out, the word in, a beat, then the drops", () => {
  const { run } = load();
  // the word under the earlier bubble goes out more gently than a word giving
  // way to the next, and comes in under the later one on the mark's own run
  assert.equal(run("MERGE_OUT_MS"), 300);
  assert.ok(run("MERGE_OUT_MS") > run("MARK_OUT_MS"), "the word moving goes out no gentler than a swap");
  assert.equal(run("MERGE_IN_MS"), run("MARK_IN_MS"));
  assert.equal(run("MERGE_HOLD_MS"), 100);
  // the merge is longer than the send's own flight and the earlier messages' glide
  assert.equal(run("MERGE_MS"), 1000);
  assert.ok(run("MERGE_MS") > run("SENT_FLIGHT_MS") && run("MERGE_MS") > run("SENT_GLIDE_MS"));
  assert.equal(run("MERGE_TRAVEL"), .8);
  assert.deepEqual(plain(run("MERGE_EASE")), [.6, 0, .3, 1]);
  assert.equal(run("MERGE_OUT_MS + MERGE_IN_MS + MERGE_HOLD_MS + MERGE_MS"), 1800);
  // the sheet's gentler going out matches the script's clock
  const rule = /\.answered\.markout\.markmove::after\{transition:opacity calc\(var\(--answ-come\) \* \.75\) var\(--gentle\)\}/;
  assert.match(code, rule, "the word moving does not go out over 300ms on the even curve");
  assert.match(code, /--answ-come:\.4s/);
});

// two one-line bubbles on the phone (read-v7 in the simulator runs), in the
// joined bubble's own px: the earlier one 18pt narrower, 17pt of room between
// them, and the joined one laid out bottom up from the later one's foot
const R = 17.73;
function spec() {
  const U0 = { left: 18, top: -28, right: 171, bottom: 25 };
  const L0 = { left: 0, top: 42, right: 171, bottom: 95 };
  const W = 171, H = 95, joinAt = 47.5;
  return { U0, L0, U1: { left: 0, top: 0, right: W, bottom: joinAt + R }, L1: { left: 0, top: joinAt - R, right: W, bottom: H }, r: R };
}
const EXT = { left: -12, top: -40, right: 183, bottom: 107 };
// the outline's loops, as points back in the joined bubble's px
function loops(d) {
  return d.split("Z").filter(s => s.includes("M")).map(s => s.replace("M", "").split("L")
    .map(p => p.trim().split(/\s+/).map(Number)).map(([x, y]) => [x + EXT.left, y + EXT.top]));
}

test("the outline is exactly the two bubbles on the first frame and exactly the joined bubble on the last", () => {
  const { context } = load();
  const s = spec();
  const first = context.sentMergeShape(s, 0);
  assert.deepEqual(plain(first.U), s.U0);
  assert.deepEqual(plain(first.L), s.L0);
  assert.equal(first.k, 0, "the union reaches across before the drops move");
  assert.equal(first.bow, 0, "the sides bulge before the drops move");
  // with nothing reaching or bulging the outline is the boxes' own, corners and all
  const d0 = context.sentGooPath(first.U, first.L, R, first.k, first.bow, EXT);
  assert.equal((d0.match(/M/g) || []).length, 2, "the two bubbles are not two shapes");
  assert.equal((d0.match(/A/g) || []).length, 8, "the bubbles' corners are not their own arcs");
  const last = context.sentMergeShape(s, 1);
  assert.deepEqual(plain(last.U), s.U1);
  assert.deepEqual(plain(last.L), s.L1);
  assert.ok(last.k < 1e-9 && last.bow < 1e-9, "the joint has not settled on the last frame");
  // the head and the foot overlap by a corner each way, so their union is one rounded bubble
  assert.ok(s.U1.bottom - s.L1.top >= 2 * R - 1e-9, "the joined bubble keeps a joint");
  assert.equal(s.U1.left, s.L1.left);
  assert.equal(s.U1.right, s.L1.right);
});

test("the drops swell toward each other, touch in the middle of the side they share after a visible approach, and the neck widens", () => {
  const { context } = load();
  const s = spec();
  let touched = null, joint = [];
  for (let ms = 0; ms <= 1000; ms += 4) {
    const shape = context.sentMergeShape(s, ms / 1000);
    const d = context.sentGooPath(shape.U, shape.L, R, shape.k, shape.bow, EXT);
    const shapes = loops(d);
    if (ms < 150) assert.equal(shapes.length, 2, `the drops touched at ${ms}ms, before any approach was seen`);
    if (touched === null && shapes.length === 1) touched = ms;
    // the joint's narrowest row while the neck is forming: the rows between
    // where the two faces stood
    if (touched !== null && ms <= touched + 120) {
      const rows = new Map();
      for (const [x, y] of shapes[0]) if (y > shape.U.bottom - 4 && y < shape.L.top + 4) {
        const k = y.toFixed(2);
        rows.set(k, [...(rows.get(k) || []), x]);
      }
      const widths = [...rows.values()].filter(xs => xs.length >= 2).map(xs => Math.max(...xs) - Math.min(...xs));
      if (widths.length) joint.push([ms, Math.min(...widths)]);
    }
  }
  assert.ok(touched !== null, "the drops never touched");
  assert.ok(touched >= 200 && touched <= 330, `the drops touch at ${touched}ms, not a quarter of a second in`);
  // a neck, narrower than the side the two share, that widens
  const shared = s.U0.right - Math.max(s.U0.left, s.L0.left);
  assert.ok(joint.length >= 2, "the neck was never seen");
  assert.ok(joint[0][1] < shared * .6, `the drops met along the whole side (${joint[0][1]} of ${shared})`);
  assert.ok(joint.at(-1)[1] > joint[0][1], "the neck did not widen");
});

test("the outline never swells past the column's sides or above the earlier bubble", () => {
  const { context } = load();
  const s = spec();
  for (let ms = 0; ms <= 1000; ms += 20) {
    const shape = context.sentMergeShape(s, ms / 1000);
    const d = context.sentGooPath(shape.U, shape.L, R, shape.k, shape.bow, EXT);
    // with nothing reaching or bulging the outline is the boxes' own arcs, read above
    if (d.includes("A")) continue;
    const right = Math.max(shape.U.right, shape.L.right), left = Math.min(shape.U.left, shape.L.left);
    for (const shape2 of loops(d)) for (const [x, y] of shape2) {
      assert.ok(x <= right + 1e-6 && x >= left - 1e-6, `the outline swells sideways at ${ms}ms (${x})`);
      assert.ok(y >= Math.min(shape.U.top, shape.L.top) - 1e-6 && y <= Math.max(shape.U.bottom, shape.L.bottom) + 1e-6,
        `the outline swells past the top or the foot at ${ms}ms (${y})`);
    }
  }
});

test("the drops are drawn with a clip path over a plain face, never a blur, filter or mask, and nothing in the layer takes a press", () => {
  const sheet = code.slice(code.indexOf(".sentgoo{"), code.indexOf(".sentgoo-ground{") + 80);
  assert.match(sheet, /\.sentgoo\{position:absolute; left:0; top:0; pointer-events:none\}/);
  assert.match(code, /\.sentgoo-ground\{position:absolute; left:0; right:0; pointer-events:none\}/);
  assert.ok(!/filter|blur|mask/.test(sheet), "the merge's layer filters, blurs or masks");
  const merge = LOGIC.slice(LOGIC.indexOf("function sentMerge(el, run)"), LOGIC.indexOf("function sentMergeLand(el)"));
  assert.match(merge, /face\.style\.clipPath = 'path\("'/, "the outline is not a clip path on the face");
  assert.ok(!/style\.(?:webkit)?(?:filter|mask)|backdropFilter|blur\(|url\(#/i.test(merge), "the merge draws with a filter, a blur or a mask");
  // and the word drawn under the bubbles while they run is the mark's own type
  assert.match(code, /\.sentgoo > \.sentgoo-mark\{left:auto; right:var\(--answ-round\); padding-top:calc\(3 \* var\(--u\)\);\s*font:calc\(10\.5 \* var\(--u\)\)\/1\.35 var\(--mono\); color:var\(--sub\); white-space:nowrap\}/);
  assert.ok(!/accent|432BFF|purple/i.test(sheet + merge), "the merge wears the accent");
});

test("the sent preview is one line deeper, and the page turn hands it over to the panel behind it with a fade", () => {
  assert.match(code, /\.answered\.sent\{--sent-peek:calc\(var\(--answ-peek\) \+ var\(--answ-line\)\)\}/);
  assert.match(code, /\.answclip\{position:relative; max-height:var\(--answ-stop, var\(--sent-peek, var\(--answ-peek\)\)\);/);
  // the surfaces keep their own previews: the phone and the large card 2.75
  // lines, the small card 1.75, so the sent one is 3.75 and 2.75
  assert.match(PHONE, /--answ-peek:calc\(21 \* var\(--u\) \* 2\.75\)/);
  assert.match(DESKTOP, /--answ-peek:calc\(20px \* 2\.75\)/);
  assert.match(DESKTOP, /--answ-peek:calc\(17px \* 1\.75\)/);
  assert.match(code, /@keyframes turnhand\{45%\{opacity:1\} to\{opacity:0\}\}/);
  assert.match(code, /\.turnpage\.gliding > \.sentwrap\{animation:turnhand var\(--turn-glide\) var\(--gentle\) both\}/);
  const go = LOGIC.slice(LOGIC.indexOf("function turnGo(el, turn)"), LOGIC.indexOf("function turnEnd(el)"));
  assert.match(go, /for \(const rising of turn\.page\.querySelectorAll\("\.answered\.sent"\)\)/,
    "the turn fades the word of one bubble only");
});

test("both pages read every bubble: the desktop's snap waits out any one moving, and the phone opens the one a failed send stands in", () => {
  const snap = DESKTOP.slice(DESKTOP.indexOf("function snapCard(){"), DESKTOP.indexOf("const r = el.reply;", DESKTOP.indexOf("function snapCard(){")));
  assert.match(snap, /sentPanels\(el\)\.some\(sent => sent\.classList\.contains\("open"\) \|\| sent\.classList\.contains\("motion"\) \|\|\s*sent\.classList\.contains\("coalesce"\)\)/);
  const draw = PHONE.slice(PHONE.indexOf("function drawSent(el, id, arrive){"), PHONE.indexOf("function opBadge(op){"));
  assert.match(draw, /for \(const panel of sentPanels\(el\)\)/);
  assert.match(draw, /sentRows\(panel\)\.some\(row => ids\.includes\(row\.dataset\.op\)\)\) openAnswered\(panel, true\)/);
  // the timed refresh and the page turn wait out a merge as they wait out a run
  assert.match(LOGIC, /\.answered\.sentflight, \.answered\.coalesce, \.answered\.markin/);
  const holding = LOGIC.slice(LOGIC.indexOf("function turnHolding(el, id){"), LOGIC.indexOf("function turnHold(el, id){"));
  assert.match(holding, /if \(el\.sentMerge\) return true;/);
});
