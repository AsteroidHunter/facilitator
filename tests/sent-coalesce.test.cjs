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

test("the merge keeps the owner's order: the word goes out, and the earlier bubble falls the moment it is gone", () => {
  const { run } = load();
  // the word under the earlier bubble goes out more gently than a word giving
  // way to the next, and comes in under the later one on the mark's own run
  assert.equal(run("MERGE_OUT_MS"), 300);
  assert.ok(run("MERGE_OUT_MS") > run("MARK_OUT_MS"), "the word moving goes out no gentler than a swap");
  assert.equal(run("MERGE_IN_MS"), run("MARK_IN_MS"));
  // no beat stands between the word going and the fall
  assert.equal(run("typeof MERGE_HOLD_MS"), "undefined", "a pause still stands before the fall");
  // the merge is longer than the send's own flight and the earlier messages' glide
  assert.equal(run("MERGE_MS"), 1000);
  assert.ok(run("MERGE_MS") > run("SENT_FLIGHT_MS") && run("MERGE_MS") > run("SENT_GLIDE_MS"));
  assert.equal(run("MERGE_TRAVEL"), .8);
  assert.equal(run("MERGE_OUT_MS + MERGE_MS"), 1300);
  // the sheet's gentler going out matches the script's clock
  const rule = /\.answered\.markout\.markmove::after\{transition:opacity calc\(var\(--answ-come\) \* \.75\) var\(--gentle\)\}/;
  assert.match(code, rule, "the word moving does not go out over 300ms on the even curve");
  assert.match(code, /--answ-come:\.4s/);
  // the word coming in as the earlier bubble falls is the mark's own run, and still where motion is not wanted
  assert.match(code, /\.sentgoo > \.sentgoo-mark\.markin\{animation:markin var\(--answ-come\) var\(--sent-ease\) backwards\}/);
  const reduced = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)", code.indexOf(".sentgoo")));
  assert.match(reduced.slice(0, reduced.indexOf("\n}")), /\.sentgoo > \.sentgoo-mark\.markin\{animation:none !important\}/);
});

test("the fall sets off softly, lands without passing its place, and leaves the tab joint's curve as it was", () => {
  const { run } = load();
  const [x1, y1, x2, y2] = plain(run("FALL_EASE"));
  assert.deepEqual([x1, y1, x2, y2], [.4, 0, .2, 1]);
  // no speed at the start or at the landing, and both handles inside the unit box, so nothing overshoots
  assert.equal(y1, 0, "the fall sets off at speed");
  assert.equal(y2, 1, "the fall lands at speed");
  for (const v of [x1, y1, x2, y2]) assert.ok(v >= 0 && v <= 1, "a handle stands outside the unit box");
  const fall = run("FALL_CURVE");
  let last = 0;
  for (let ms = 0; ms <= 800; ms++) {
    const y = fall(ms / 800);
    assert.ok(y >= last - 1e-12 && y <= 1 + 1e-12, `the fall goes back or past its landing at ${ms}ms`);
    last = y;
  }
  // seen to set off as the word goes: a tenth of the way by 150ms, half by 300ms
  assert.ok(fall(150 / 800) >= .1 && fall(300 / 800) >= .5, "the fall creeps before it is seen to start");
  assert.ok(fall(50 / 800) < .02, "the fall does not set off softly");
  // the tab joint in index.html runs on the curve two bubbles used to come together on
  assert.deepEqual(plain(run("MERGE_EASE")), [.6, 0, .3, 1]);
});

// two one-line bubbles on the phone (read-v7 in the simulator runs), in the
// joined bubble's own px: the earlier one 18pt narrower, 17pt of room between
// them, and the joined one laid out bottom up from the later one's foot. the
// ends as sentMerge works them out: the later bubble standing where it is, and
// the earlier one's head landing on the joined bubble's, its foot sunk a corner
// each way past the later one's head
const R = 17.73;
function spec() {
  const U0 = { left: 18, top: -28, right: 171, bottom: 25 };
  const L0 = { left: 0, top: 42, right: 171, bottom: 95 };
  const W = 171, H = 95;
  const L1 = { left: 0, top: Math.max(0, Math.min(L0.top, H - 2 * R)), right: W, bottom: H };
  const U1 = { left: 0, top: 0, right: W, bottom: Math.min(H, Math.max(U0.bottom - U0.top, L1.top + 2 * R)) };
  return { U0, L0, U1, L1, r: R };
}

test("only the earlier bubble falls: straight down at its own height until it touches, and the later one stands still", () => {
  const { context } = load();
  const s = spec();
  assert.deepEqual(s.L1, { ...s.L0, left: 0 }, "the later bubble's end is not where it stands");
  const tall = s.U0.bottom - s.U0.top;
  let touched = false, lastTop = s.U0.top;
  for (let ms = 0; ms <= 1000; ms += 4) {
    const shape = context.sentMergeShape(s, ms / 1000);
    assert.ok(Math.abs(shape.L.top - s.L0.top) < 1e-9 && Math.abs(shape.L.bottom - s.L0.bottom) < 1e-9,
      `the later bubble moved at ${ms}ms`);
    assert.ok(shape.U.top >= lastTop - 1e-9, `the earlier bubble went back up at ${ms}ms`);
    assert.ok(shape.U.top <= s.U1.top + 1e-9, `the earlier bubble fell past its landing at ${ms}ms`);
    lastTop = shape.U.top;
    if (shape.U.bottom > s.L0.top + 1e-9) touched = true;
    // over the room between the two it keeps its height: nothing stretches where it can be seen
    if (!touched) assert.ok(Math.abs(shape.U.bottom - shape.U.top - tall) < 1e-9, `the earlier bubble stretched at ${ms}ms`);
    else assert.ok(shape.U.bottom >= s.L0.top - 1e-9, `the foot came back out of the later bubble at ${ms}ms`);
  }
  assert.ok(touched, "the earlier bubble never reached the later one");
  // the travel is the fall's: none after the first four fifths
  const landed = context.sentMergeShape(s, .8);
  assert.ok(Math.abs(landed.U.top - s.U1.top) < 1e-9 && Math.abs(landed.U.bottom - s.U1.bottom) < 1e-9);
});
const EXT = { left: -12, top: -40, right: 183, bottom: 107 };
// the outline's loops, as points back in the joined bubble's px
function loops(d) {
  return d.split("Z").filter(s => s.includes("M")).map(s => s.replace("M", "").split("L")
    .map(p => p.trim().split(/\s+/).map(Number)).map(([x, y]) => [x + EXT.left, y + EXT.top]));
}

// a column as the phone stands one (the simulator's numbers): bubbles 52.5px
// tall (a long one 99px) 25.6px apart, laid out up from the foot, in the joined
// bubble's own px, the joined bubble 99px tall and 260px wide, its corner 18px
function columnOf(talls, widths = talls.map(() => 150)) {
  const W = 260, H = 99, gap = 25.6;
  const B0 = [];
  let foot = H;
  for (let i = talls.length - 1; i >= 0; i--) {
    B0.unshift({ left:W - widths[i], top:foot - talls[i], right:W, bottom:foot });
    foot -= talls[i] + gap;
  }
  return { B0, W, H, r:18 };
}

test("a column all lets go at once, keeps the room between its bubbles while they all fall, and falls as things fall: from rest, its distance the square of the time", () => {
  const { context } = load();
  const { B0, W, H, r } = columnOf([52.5, 52.5, 99, 52.5, 52.5]);
  const plan = context.sentColumnPlan(B0, W, H, r);
  const at = ms => context.sentColumnShape(plan, ms);
  const first = Math.min(...plan.falls.map(f => f.lands));
  // the first frame is the column as it stood, and the foot never moves down or up
  at(0).boxes.forEach((box, i) => assert.deepEqual(plain({ top:box.top, bottom:box.bottom }), { top:B0[i].top, bottom:B0[i].bottom }));
  for (const ms of [first / 4, first / 2, first * .99]) {
    const tops = at(ms).boxes.map(box => box.top);
    const fallen = tops.slice(0, -1).map((top, i) => top - B0[i].top);
    assert.ok(fallen.every(d => d > 0 && Math.abs(d - fallen[0]) < 1e-9), `the bubbles over the foot did not fall as one at ${ms}ms`);
    assert.equal(tops.at(-1), B0.at(-1).top, "the foot moved");
    assert.ok(Math.abs(fallen[0] - .5 * plan.pull * ms * ms) < 1e-9, "the fall is not from rest on a steady pull");
  }
  // twice the time, four times the way
  const d = ms => at(ms).boxes[0].top - B0[0].top;
  assert.ok(Math.abs(d(first / 2) - 4 * d(first / 4)) < 1e-9);
  assert.equal(load().run("COLUMN_PULL"), 1.25e-3);
});

test("in a column the one over the foot lands first and each one above a moment later, at the joined head, where it stops", () => {
  const { context, run } = load();
  for (const talls of [[52.5, 52.5, 52.5], [52.5, 52.5, 52.5, 52.5, 52.5], [99, 52.5, 99, 52.5, 52.5]]) {
    const { B0, W, H, r } = columnOf(talls);
    const plan = context.sentColumnPlan(B0, W, H, r);
    const lands = plan.falls.map(f => f.lands);
    for (let i = 0; i < lands.length - 1; i++) assert.ok(lands[i] > lands[i + 1], `bubble ${i + 1} lands before bubble ${i + 2} under it (${lands})`);
    // with bubbles of one height the landings come closer as the ones above gather speed
    if (talls.every(h => h === talls[0])) {
      const gaps = lands.slice(0, -1).map((t, i) => t - lands[i + 1]).reverse();
      for (let i = 0; i < gaps.length - 1; i++) assert.ok(gaps[i] > gaps[i + 1], `the landings did not come closer (${gaps})`);
    }
    plan.falls.forEach((f, i) => {
      // its foot touches what it lands on before its head lands, never after
      assert.ok(f.touch <= f.lands);
      const before = context.sentColumnShape(plan, f.lands - 1).boxes[i].top;
      const after = [f.lands, f.lands + 50, plan.end].map(ms => context.sentColumnShape(plan, ms).boxes[i].top);
      assert.ok(before < 0, `bubble ${i + 1} reached the joined head early`);
      assert.deepEqual(after, [0, 0, 0], `bubble ${i + 1} did not stop at the joined head`);
    });
    assert.equal(plan.end, plan.last + run("COLUMN_SETTLE_MS"));
  }
});

test("a tall column falls on a harder pull rather than taking longer than COLUMN_LONGEST_MS", () => {
  const { context, run } = load();
  const { B0, W, H, r } = columnOf(Array(10).fill(99));
  const plan = context.sentColumnPlan(B0, W, H, r);
  assert.ok(plan.pull > run("COLUMN_PULL"));
  assert.ok(Math.abs(plan.last - run("COLUMN_LONGEST_MS")) < 1e-6, `a ten-bubble column takes ${plan.last}ms`);
  // and the five short ones keep the steady pull
  const five = columnOf(Array(5).fill(52.5));
  assert.equal(context.sentColumnPlan(five.B0, five.W, five.H, five.r).pull, run("COLUMN_PULL"));
});

test("a column's outline is exactly its bubbles on the first frame and exactly the joined bubble once it has settled", () => {
  const { context } = load();
  const { B0, W, H, r } = columnOf([52.5, 99, 52.5, 52.5], [90, 260, 150, 120]);
  const plan = context.sentColumnPlan(B0, W, H, r);
  const ext = { left:-4, top:B0[0].top - 4, right:W + 4, bottom:H + 4 };
  const path = state => state.boxes.slice(0, -1).map((box, i) =>
    context.sentGooPath(box, state.boxes[i + 1], r, state.joints[i].k, state.joints[i].bow, ext));
  const start = context.sentColumnShape(plan, 0);
  const box = b => context.sentBoxPath(b, r, v => (v - ext.left).toFixed(2), v => (v - ext.top).toFixed(2));
  assert.deepEqual(plain(path(start)), B0.slice(0, -1).map((b, i) => box(b) + box(B0[i + 1])), "the first frame is not the bubbles as they stood");
  const end = context.sentColumnShape(plan, plan.end);
  for (const b of end.boxes) {
    assert.ok(b.left === 0 && b.right === W && b.top >= 0 && b.bottom <= H, `a box stands outside the joined bubble once settled: ${JSON.stringify(b)}`);
    assert.ok(Math.abs(b.left) < 1e-9);
  }
  assert.equal(Math.min(...end.boxes.map(b => b.top)), 0);
  assert.equal(Math.max(...end.boxes.map(b => b.bottom)), H);
  assert.ok(end.joints.every(j => j.k === 0 && j.bow === 0), "the joints have not let go once settled");
  // the bubbles over the column come down on the fall's own curve, which is the square of the time
  const curve = context.sentCurve(plain(load().run("COLUMN_EASE")));
  for (const f of [.1, .3, .5, .8]) assert.ok(Math.abs(curve(f) - f * f) < 1e-6);
});

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

test("as the earlier bubble falls the two swell toward each other, touch in the middle of the side they share after a visible approach, and the neck widens", () => {
  const { context } = load();
  const s = spec();
  let touched = null, joint = [];
  for (let ms = 0; ms <= 1000; ms += 4) {
    const shape = context.sentMergeShape(s, ms / 1000);
    const d = context.sentGooPath(shape.U, shape.L, R, shape.k, shape.bow, EXT);
    const shapes = loops(d);
    if (ms < 150) assert.equal(shapes.length, 2, `the two touched at ${ms}ms, before any approach was seen`);
    if (touched === null && shapes.length === 1) {
      touched = ms;
      assert.ok(shape.U.top - s.U0.top >= 4, `the two touched before the earlier one was seen to fall (${shape.U.top - s.U0.top}px)`);
    }
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
  assert.ok(touched !== null, "the two never touched");
  assert.ok(touched >= 150 && touched <= 330, `the two touch at ${touched}ms, not about a quarter of a second into the fall`);
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

test("the sent bubbles share the panel's preview, and the page turn hands them over to the panel behind with a fade", () => {
  // one preview, the sheet's own: a line and a half dissolving over the last
  // half line of them, two and a half when the second line is blank, on
  // every surface and for the panel over the answer and the sent bubbles alike
  assert.match(code, /--answ-peek:calc\(var\(--answ-line\) \* 1\.5\); --answ-fade:calc\(var\(--answ-line\) \* \.5\);\n\}/);
  assert.match(code, /\n\.answered\.gap\{--answ-peek:calc\(var\(--answ-line\) \* 2\.5\)\}/);
  assert.match(code, /\.answclip\{position:relative; max-height:var\(--answ-stop, var\(--answ-peek\)\);/);
  assert.doesNotMatch(code, /\.answered\.sent\{[^}]*--(?:answ-peek|answ-fade|sent-peek)/, "the sent bubbles are given a preview of their own");
  assert.doesNotMatch(PHONE + DESKTOP, /--answ-(?:peek|fade):/, "a surface types a preview of its own");
  assert.match(code, /@keyframes turnhand\{45%\{opacity:1\} to\{opacity:0\}\}/);
  assert.match(code, /\.turnpage\.gliding > \.sentwrap\{animation:turnhand var\(--turn-glide\) var\(--gentle\) both\}/);
  const go = LOGIC.slice(LOGIC.indexOf("function turnGo(el, turn)"), LOGIC.indexOf("function turnEnd(el)"));
  assert.match(go, /for \(const rising of turn\.page\.querySelectorAll\("\.answered\.sent"\)\)/,
    "the turn fades the word of one bubble only");
});

test("both pages read every bubble: the desktop's snap leaves the bubbles' seat out, and the phone opens the one a failed send stands in", () => {
  const snap = DESKTOP.slice(DESKTOP.indexOf("function snapCard(){"), DESKTOP.indexOf("function tiltTitleAir("));
  assert.match(snap, /const seat = el\.sentwrap \? el\.sentwrap\.getBoundingClientRect\(\)\.height : 0;/);
  assert.match(snap, /boxBand\(view, el\.pendwrap, seat\)/);
  assert.doesNotMatch(snap, /sentPanels\(el\)/, "the snap still waits on the bubbles");
  const draw = PHONE.slice(PHONE.indexOf("function drawSent(el, id, arrive){"), PHONE.indexOf("function opBadge(op){"));
  assert.match(draw, /for \(const panel of sentPanels\(el\)\)/);
  assert.match(draw, /sentRows\(panel\)\.some\(row => ids\.includes\(row\.dataset\.op\)\)\) openAnswered\(panel, true\)/);
  // the timed refresh and the page turn wait out a merge as they wait out a run
  assert.match(LOGIC, /\.answered\.sentflight, \.answered\.coalesce, \.answered\.markin/);
  const holding = LOGIC.slice(LOGIC.indexOf("function turnHolding(el, id){"), LOGIC.indexOf("function turnHold(el, id){"));
  assert.match(holding, /if \(el\.sentMerge\) return true;/);
});
