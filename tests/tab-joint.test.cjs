// The open project's lens joined to the workspace's pane, and its split and
// join, run through the real drag, release, hotkey and seat code with
// synthetic geometry and a synthetic clock. A CSS slide is stood in for by
// the seat's running transition and its place part way. These check the
// outline's shape and the joint's clock, not browser rendering or smoothness.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { fixture, html, between } = require("./project-lens-fixture.cjs");

const joint = f => f.get("tabJoint");
const shapes = f => [...(joint(f).outline?.loops || [])].map(o => o.top + ">" + o.bottom);
function record(f){
  const j = joint(f);
  return { t: f.now, tau: j.tau, kind: j.run?.kind || null, foot: j.run?.kind === "split" ? j.run.foot : j.foot,
    shapes: shapes(f), opacity: Number(j.svg.attributes.opacity), outline: j.outline };
}
function run(f, ms, each){
  const out = [];
  for (let t = 0; t < ms; t += 16){ if (each) each(f.now); f.tick(16); out.push(record(f)); }
  return out;
}
const center = r => (r.left + r.right) / 2;
const falling = list => list.every((r, i) => i === 0 || r.tau <= list[i - 1].tau + 1e-12);
const rising = list => list.every((r, i) => i === 0 || r.tau >= list[i - 1].tau - 1e-12);
// joined at rest under one name: one outline from the lens's middle into the
// pane, straight down the lens's sides and flaring out along the pane's edge
function assertJoinedUnder(f, ow){
  const j = joint(f), rect = f.tabs[ow].getBoundingClientRect();
  assert.equal(j.tau, 1, "joined"); assert.equal(j.run, null, "at rest");
  assert.deepEqual(shapes(f), ["lens>pane"]);
  const rows = j.outline.loops[0].rows;
  assert.ok(Math.abs(rows[0][1] - rect.left) < .05 && Math.abs(rows[0][2] - rect.right) < .05, "starts on the lens's own sides");
  // straight down the lens's full width from where its 7px corners end, then
  // only ever out into the flare: no waist at rest
  assert.equal(rows[0][0], rect.top + 7, "starts where the lens's corners end");
  for (const [y, l, r] of rows){
    if (y <= rect.bottom - 3) assert.ok(Math.abs(l - rect.left) < .3 && Math.abs(r - rect.right) < .3, "straight sides at " + y + ": " + l + ", " + r);
    assert.ok(l <= rect.left + .05 && r >= rect.right - .05, "no waist at " + y);
  }
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i][1] <= rows[i - 1][1] + 1e-6, "the side only goes out");
  const [y, l, r] = rows.at(-1);
  assert.ok(y > 45.9 && y < 46, "runs on to the pane's edge");
  assert.ok(rect.left - l > 3 && r - rect.right > 3, "flares out along the pane: " + l + ", " + r);
  assert.equal(j.foot, center(rect));
  assert.equal(j.svg.attributes.opacity, "1.000");
}
// Command + 1 to 9 and the up and down project step, as the page runs them;
// the page's renderTabs then asks for the seat (seatSoon), as placeSeat here
function hotkeys(f){
  const actions = vm.runInContext("({" + between("  tab(e, shortcut){", "\n  },") + "\n  }})", f.context);
  vm.runInContext(between("function nav(dx, dy, opts){", "\n}\n") + "\n}", f.context);
  f.context.FOCUS = true; f.context.lastState.boxes = [{ id: "x" }];
  return {
    digit(n){ let prevented = false; actions.tab({ preventDefault(){ prevented = true; } }, { value: n - 1 }); f.context.placeSeat(); return prevented; },
    step(dy){ f.context.nav(0, dy); f.context.placeSeat(); },
  };
}
// the joint's settings, read once from the page
const settings = f => f.get("({ split: JOINT_SPLIT_MS, join: JOINT_JOIN_MS, tear: JOINT_TEAR, pinch: JOINT_PINCH, touch: JOINT_TOUCH })");

test("at rest the open project's lens and the workspace are one outline, drawn in the glass's face and ring", () => {
  const f = fixture({ render: true }), j = joint(f);
  assertJoinedUnder(f, "a");
  assert.match(j.face.attributes.d, /^M/); assert.match(j.ring.attributes.d, /^M/);
  assert.equal(j.ring.attributes.stroke, "#c7c7cc", "the glass's own ring color");
  assert.match(j.face.attributes.d, /V48\.50H/, "the pane's line is covered under the joint and faded below it");
  // the face takes the lens's clean middle out (the lens draws its own words):
  // its sides straight down from the first row, then round its foot's two
  // corners, the lens's own 7px less the 4px of rim
  const lens = f.seat.face.getBoundingClientRect(), foot = (lens.bottom - 4).toFixed(2);
  assert.ok(j.face.attributes.d.includes("V" + (lens.bottom - 4 - 3).toFixed(2) + "A3 3 0 0 1 " + (lens.right - 4 - 3).toFixed(2) + " " + foot +
    "H" + (lens.left + 4 + 3).toFixed(2) + "A3 3 0 0 1 " + (lens.left + 4).toFixed(2) + " " + (lens.bottom - 4 - 3).toFixed(2) + "V" + (lens.top + 7).toFixed(2)),
    "the clean middle is cut out with the lens's corners: " + j.face.attributes.d);
  assert.doesNotMatch(j.face.attributes.d, /A12 12|A13 13|A16 16/);
  // beside the bar, straight after it, so it paints over the lens's foot and
  // is not cut off at the bar's foot
  const beside = f.topBar.parentNode.children;
  assert.equal(beside[beside.indexOf(f.topBar) + 1], j.svg);
  assert.equal(f.row.children.includes(j.svg), false);
  assert.equal(j.svg.attributes["aria-hidden"], "true");
});

test("the joint is plain paint over the bar: no blur, filter, mask, pointer or accent", () => {
  const css = between("  /* the joint: the open project's lens joined", "  /* the plus: a bare mark");
  const rules = css.replace(/\/\*[^]*?\*\//g, "");
  assert.doesNotMatch(rules, /filter|mask|blur|--accent|purple|#[89a-f][0-9a-f]{1}[0-9a-f]{0,1}f[0-9a-f]/i);
  assert.match(rules, /body\.focus #seatjoin\{[^}]*position:fixed[^}]*pointer-events:none/);
  // at the bar's own level (.bar's z-index), so whatever stands over the bar
  // stands over the joint too
  assert.match(rules, /body\.focus #seatjoin\{[^}]*z-index:10\}/);
  assert.match(between("  .bar{", "}"), /z-index:10;/);
  // the lens's face is the clean face's own mix, over the page's paper
  assert.match(rules, /\.jl\{stop-color:color-mix\(in srgb, var\(--paper\), #fff calc\(var\(--qn-tint\) \* 100%\)\)\}/);
  const script = between("// ---- the seat's joint", "// the bar is painted in the middle");
  assert.doesNotMatch(script.replace(/\/\/.*$/gm, ""), /"filter"|"mask"|style\.(filter|mask|backdropFilter)|blur\(|--accent/i);
});

test("a drag pulls the lens off the workspace: the neck thins and parts, each side draws back, and the lens follows the pointer", () => {
  const f = fixture({ render: true }), s = settings(f);
  const start = f.down("a"); f.move(start.clientX - 6);   // the first name: the lens stays put while the hand holds
  assert.equal(f.context.tabDrag.mode, "select");
  const frames = run(f, 700);
  assert.ok(falling(frames), "the split only goes one way");
  assert.ok(frames.every(r => r.kind === "split" || r.tau === 0));
  assert.ok(frames.every(r => r.foot === 90), "the pane's side stays where the neck stood");
  // the same shapes as the join, in reverse: joined, a neck, two drops, none
  const kinds = [...new Set(frames.map(r => r.shapes.join(" ")))];
  assert.deepEqual(kinds, ["lens>pane", "lens>tip tip>pane", "lens>tip", ""]);
  const parted = frames.find(r => r.shapes.length === 2);
  assert.ok(Math.abs(parted.tau - s.touch) < .06, "parts where the join touches");
  // its own clock: the neck parts a little over half way through
  assert.ok(parted.t > .4 * s.split && parted.t < .65 * s.split, "parted at " + parted.t);
  assert.equal(frames.at(-1).tau, 0); assert.equal(joint(f).outline, null);
  assert.equal(frames.at(-1).opacity, 0);
  // the lens itself moved with the hand only, as before
  f.move(300); assert.equal(f.seat.el.style.transform, "translateX(" + (40 + 300 - 90) + "px)");
});

test("a lens pulled away breaks the thread at once, and leans after the hand while it parts", () => {
  const f = fixture({ render: true }), s = settings(f);
  f.down("a"); f.move(90 + 10);
  f.tick(16); const lean = f.get("tabJoint.outline");
  assert.ok(f.get("tabJoint.run.p") >= s.pinch * 10 / s.tear - 1e-9);
  const gap = lean.loops[0].rows.find(([y]) => y === 42);
  assert.ok(gap && gap[1] < 50 - 1, "the neck leans back toward where it stood");
  f.move(90 + s.tear + 30); f.tick(16);
  assert.ok(f.get("tabJoint.run.p") >= s.pinch, "pulled past the tear, the neck has parted");
  assert.deepEqual(shapes(f).filter(k => k === "lens>pane"), []);
});

test("released over another project, the lens lands and the joint forms under that project", () => {
  const f = fixture({ render: true }), s = settings(f);
  f.down("a"); f.move(84); run(f, s.split + 50);
  assert.equal(joint(f).tau, 0);
  f.move(330); f.up(330, 22, f.tabs.c); f.click("c");
  assert.deepEqual(f.switches, ["c"]);
  const frames = run(f, s.join + 100);
  assert.ok(rising(frames), "the join only goes one way");
  assert.ok(frames.every(r => r.kind === "join" || r.tau === 1));
  assert.ok(frames.every(r => r.foot === 320), "under the new project");
  // the merge's order: drops, touching, then one outline
  const kinds = [...new Set(frames.map(r => r.shapes.join(" ")))];
  assert.deepEqual(kinds, ["lens>tip", "lens>tip tip>pane", "lens>pane"]);
  const touched = frames.find(r => r.shapes[0] === "lens>pane");
  assert.ok(touched.t - frames[0].t + 16 > .25 * s.join && touched.t - frames[0].t + 16 < .5 * s.join, "touches at " + (touched.t - frames[0].t));
  assertJoinedUnder(f, "c");
});

test("released before the split is done, the old joint finishes going before the new one forms", () => {
  const f = fixture({ render: true });
  f.down("a"); f.move(84); run(f, 80);
  f.move(330); f.up(330, 22, f.tabs.c); f.click("c");
  const frames = run(f, 1600);
  const first = frames.findIndex(r => r.kind === "join");
  assert.ok(first > 0);
  assert.ok(frames.slice(0, first).every(r => r.kind === "split" && r.foot === 90 || r.tau === 0));
  assert.equal(frames[first - 1].tau, 0, "the old joint is gone first");
  assert.ok(frames.slice(first).every(r => r.foot === 320));
  assertJoinedUnder(f, "c");
});

test("cancelled, the lens rejoins where it was, from wherever the split had got to", () => {
  for (const cancel of ["escape", "off the row"]){
    const f = fixture({ render: true });
    f.down("a"); f.move(84); const split = run(f, 112);
    const reached = split.at(-1).tau;
    assert.ok(reached < 1 && reached > .5, cancel + " part way: " + reached);
    if (cancel === "escape") f.dispatch("keydown", { key: "Escape", preventDefault(){}, stopImmediatePropagation(){} });
    else f.up(84, 80);
    const back = run(f, 1000);
    assert.deepEqual(f.switches, [], cancel);
    assert.ok(rising(back), cancel + ": straight back, never apart");
    assert.ok(back.every(r => r.tau >= reached - 1e-9));
    assertJoinedUnder(f, "a");
  }
  const f = fixture({ render: true });
  f.down("a"); f.move(84); run(f, 700);
  f.up(84, 80); const back = run(f, 900);
  assert.ok(rising(back) && back[0].kind === "join"); assertJoinedUnder(f, "a");
});

// a lens set down by a click or a key, read in the very frame of the switch,
// before any clock has run: no delay, no slide and no fade, standing on the new
// name with its words cut for it, and the joint whole under it
function assertSetDown(f, ow){
  const el = f.seat.el, rect = f.tabs[ow].getBoundingClientRect(), lens = f.seat.face.getBoundingClientRect();
  assert.ok(!el.style.transitionDelay, "no hold");
  assert.equal(el.classList.contains("still"), true, "no slide: the seat's transform and width have no transition");
  assert.equal(f.get("seatSliding()"), false);
  assert.equal(el.classList.contains("gone"), false, "no fade");
  assert.ok(Math.abs(lens.left - rect.left) < 1e-9 && Math.abs(lens.width - rect.width) < 1e-9, "standing on the new name");
  const label = f.tabs[ow].querySelector(".plabel"), g = f.get("lensCopyGeometry")(label.getBoundingClientRect(), lens, parseFloat(el.style.width));
  assert.equal(f.seat.face.lens.copies.get(label).style.transform, "translate(" + g.x + "px," + g.y + "px) scale(" + g.sx + "," + g.sy + ")",
    "the lens's words are cut for the new name");
  assertJoinedUnder(f, ow);
}
const stays = (frames, foot) => frames.every(r => r.tau === 1 && r.kind === null && r.foot === foot && r.shapes.join() === "lens>pane");

test("a click on another name sets the lens down on it at once, joint whole, with no pause, slide, split or regrow", () => {
  const f = fixture({ render: true });
  assertJoinedUnder(f, "a");
  f.click("b"); f.context.placeSeat();   // and no clock has run
  assert.deepEqual(f.switches, ["b"]);
  assertSetDown(f, "b");
  assert.ok(stays(run(f, 1500), 210), "nothing moves afterwards");
  assertSetDown(f, "b");
  assert.equal(f.frames.size, 0, "and nothing is left asking for frames");
});

test("Command + a digit and the project step do the same: the lens and its joint stand on the new name in the frame of the key", () => {
  const f = fixture({ render: true }), keys = hotkeys(f);
  assert.equal(keys.digit(3), true); assert.deepEqual(f.switches, ["c"]);
  assertSetDown(f, "c");
  assert.ok(stays(run(f, 1500), 320));
  keys.step(-1); assert.deepEqual(f.switches, ["c", "b"]);
  assertSetDown(f, "b");
  assert.ok(stays(run(f, 1500), 210));
  keys.digit(1); assertSetDown(f, "a");
  assert.ok(stays(run(f, 1500), 90));
});

test("a click or key during a drag's split or slide ends the same way: in place, the old joint gone and the new one whole", () => {
  const f = fixture({ render: true });
  f.down("a"); f.move(84); run(f, 100);
  assert.ok(joint(f).tau > 0 && joint(f).tau < 1, "the split is part way");
  f.dispatch("keydown", { key: "Escape", preventDefault(){}, stopImmediatePropagation(){} });
  f.move(84, 22, 0);   // the grip is let go, as the next mouse move after a cancel finds it
  assert.equal(f.seat.el.classList.contains("still"), false, "the cancelled drag sends the lens back by sliding");
  f.click("b"); f.context.placeSeat();
  assertSetDown(f, "b");
  assert.ok(stays(run(f, 1500), 210));
});

test("the new project tab is reached the same way: the lens is set down on it at once", () => {
  const f = fixture({ render: true });
  f.tabs.a.classList.remove("on"); f.tabs.c.classList.add("on", "draft"); f.context.placeSeat();
  assert.equal(f.seat.owner, f.get("DRAFT"));
  assertSetDown(f, "c");
  assert.ok(stays(run(f, 1500), 320));
});

test("a drag's release still slides the lens the rest of the way from where it was let go", () => {
  const f = fixture({ render: true }), s = settings(f);
  f.down("a"); f.move(84); run(f, s.split + 50);
  f.move(330); f.up(330, 22, f.tabs.c); f.click("c");
  assert.deepEqual(f.switches, ["c"]);
  assert.equal(f.seat.el.classList.contains("still"), false, "the seat's transform and width transition runs");
  assert.ok(!f.seat.el.style.transitionDelay, "from the moment of release");
  assert.equal(f.seat.el.style.transform, "translateX(280px)");
  assert.equal(joint(f).tau, 0, "the joint forms only once the lens has landed");
  const after = run(f, s.join + 100);
  assert.ok(after.some(r => r.kind === "join") && rising(after));
  assertJoinedUnder(f, "c");
});

test("the page keeps no hold before a slide, and the seat slides only when it is let go by a drag", () => {
  assert.doesNotMatch(html, /JOINT_HOLD_MS|jointHold|holdUntil|transitionDelay/);
  const still = between("  body.focus #tabrow .tabseat.still{", "\n");
  assert.doesNotMatch(still, /transform|width/, "a seat set down has no transition on its place or width");
  assert.match(between("  body.focus #tabrow .tabseat{", "}"), /transition:transform \.28s var\(--gentle\), width \.28s var\(--gentle\)/, "a drag's release slides over .28s");
});

test("renames and closes before the open name move the joint with the lens, with no split", () => {
  const f = fixture({ render: true }), keys = hotkeys(f);
  keys.digit(3); run(f, 200); assertJoinedUnder(f, "c");
  f.context.closeTab("b"); f.context.placeSeat();
  assert.ok(!f.seat.el.style.transitionDelay);
  const frames = run(f, 200);
  assert.ok(frames.every(r => r.tau === 1 && r.kind === null));
  assertJoinedUnder(f, "c");
});

test("Home: its circle is never joined; a click on a name or on the house sets the lens down at once, joint whole or gone", () => {
  const f = fixture({ home: true, render: true }), j = joint(f);
  assert.equal(j.tau, 0); assert.equal(j.outline, null); assert.equal(j.svg.attributes.opacity, "0");
  assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  // home to a project: the lens is on the name and the joint whole in the same frame
  f.click("b"); f.context.placeSeat();
  assertSetDown(f, "b");
  assert.ok(stays(run(f, 1200), 210));
  // a project to home: the circle and no joint at once
  f.homeButton.listeners.click[0]();
  assert.equal(f.context.homeOpen, true);
  assert.ok(!f.seat.el.style.transitionDelay);
  assert.equal(f.seat.el.classList.contains("still"), true);
  assert.equal(j.tau, 0); assert.equal(j.outline, null); assert.equal(j.svg.attributes.opacity, "0");
  assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  assert.equal(f.seat.face.getBoundingClientRect().width, 32);
  const gone = run(f, 1500);
  assert.ok(gone.every(r => r.kind === null && r.tau === 0 && r.outline === null));
  assert.equal(f.seat.face.getBoundingClientRect().width, 32);
  // a drag from Home onto the house again and dropped there opens nothing new
  f.down("b"); f.move(16); run(f, 200); f.up(16, 22, f.homeButton); run(f, 1200);
  assert.equal(f.context.homeOpen, true); assert.equal(j.tau, 0);
  // a project's lens dragged onto the house parts and stays parted on Home
  const g = fixture({ render: true });
  g.down("a"); g.move(16); run(g, 200); g.up(16, 22, g.homeButton);
  assert.equal(g.seat.el.classList.contains("still"), false, "a drag's release onto the house still slides");
  const h = run(g, 1500);
  assert.equal(g.context.homeOpen, true); assert.ok(h.every(r => r.kind !== "join")); assert.equal(joint(g).tau, 0);
  // the house only lifts the lens while Home is open: closed, a press on it starts nothing
  const shut = fixture(); shut.downHome();
  assert.equal(shut.context.tabDrag, null, "a press on the house started a drag with Home closed");
});

test("with reduced motion the joint is simply there, or not, where the lens stands", () => {
  const f = fixture({ render: true, reduced: true }), keys = hotkeys(f);
  assertJoinedUnder(f, "a");
  f.down("a"); f.move(150);
  const drag = run(f, 300);
  assert.ok(drag.every(r => r.tau === 0 && r.kind === null), "apart at once while carried");
  f.up(330, 22, f.tabs.c); f.click("c");
  const landed = run(f, 100);
  assert.ok(landed.every(r => r.tau === 1 && r.kind === null), "joined at once where it landed");
  assertJoinedUnder(f, "c");
  keys.digit(2);
  assert.ok(!f.seat.el.style.transitionDelay, "no hold");
  const hop = run(f, 100);
  assert.ok(hop.every(r => r.tau === 1 && r.kind === null && r.foot === 210));
  assertJoinedUnder(f, "b");
  // and a motion setting changed while parting leaves it standing still too
  const g = fixture({ render: true }); g.down("a"); g.move(84); run(g, 100);
  g.setReduced(true); const now = run(g, 50);
  assert.ok(now.every(r => r.tau === 0 && r.kind === null));
});

test("the reorder drag and the cross keep their behaviour, with the joint riding on the open lens", () => {
  const f = fixture({ render: true });
  f.context.tabDwell(f.tabs.a); f.tick(1700); assert.equal(f.tabs.a.classList.contains("armed"), true);
  f.down(); f.move(250);
  assert.equal(f.context.tabDrag.mode, "reorder");
  const frames = run(f, 200);
  assert.ok(frames.every(r => r.tau === 1 && r.kind === null), "joined throughout");
  const lens = f.seat.face.getBoundingClientRect(), rows = joint(f).outline.loops[0].rows;
  assert.ok(Math.abs(rows[0][1] - lens.left) < .05 && Math.abs(rows[0][2] - lens.right) < .05, "on the carried lens");
  f.up(250); f.tick(0); f.tick(250); run(f, 100);   // the release's own 0ms timer runs before the glide's, as in a browser
  assert.deepEqual(f.writes[0].order, ["b", "a", "c"]); assert.deepEqual(f.switches, []);
  assertJoinedUnder(f, "a");
  // the cross closes only its own project, and the open lens keeps its joint
  const button = f.context.tabKillMark("c"); const e = { preventDefault(){}, stopPropagation(){} };
  button.listeners.click[0](e);
  assert.deepEqual(f.writes.at(-1).closed, ["c"]); run(f, 100); assertJoinedUnder(f, "a");
});

test("another name carried across the open one keeps its own lens over the joint", () => {
  const f = fixture({ render: true }), j = joint(f);
  f.tabs.b.classList.add("armed"); f.down("b"); f.move(60);
  assert.equal(f.context.tabDrag.mode, "reorder");
  const frames = run(f, 100), held = f.context.tabDrag.held.getBoundingClientRect();
  assert.ok(frames.every(r => r.tau === 1 && r.kind === null), "the open lens stays joined");
  assert.equal(j.group.attributes["clip-path"], "url(#seatjoinkeep)");
  const d = j.kept.attributes.d, r = 7, f2 = v => v.toFixed(2);
  // the carried name's own lens, a box with 7px corners, is the hole
  assert.ok(d.includes("M" + f2(held.left + r) + " " + f2(held.top) + "H" + f2(held.right - r) + "A7.00 7.00 0 0 1 " + f2(held.right) + " " + f2(held.top + r) +
    "V" + f2(held.bottom - r) + "A7.00 7.00 0 0 1 " + f2(held.right - r) + " " + f2(held.bottom) + "H" + f2(held.left + r) +
    "A7.00 7.00 0 0 1 " + f2(held.left) + " " + f2(held.bottom - r) + "V" + f2(held.top + r) + "A7.00 7.00 0 0 1 " + f2(held.left + r) + " " + f2(held.top) + "Z"),
    "the carried lens's box is cut out: " + d);
  assert.equal(j.kept.attributes["clip-rule"], "evenodd");
  f.up(60); f.tick(0); f.tick(250); run(f, 50);
  assert.equal(j.group.attributes["clip-path"], undefined, "nothing cut out once it is set down");
  assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
  assertJoinedUnder(f, "a");
});

test("the pinch point, the split's clock and the join's curve are the merge's", () => {
  const f = fixture({ render: true }), s = settings(f);
  assert.ok(s.touch > .15 && s.touch < .3, "touch " + s.touch);
  // the join runs on the sent bubbles' merge curve
  assert.equal(f.get("JOINT_JOIN(.5)"), f.get("sentCurve(MERGE_EASE)(.5)"));
  assert.match(html, /const JOINT_JOIN = sentCurve\(MERGE_EASE\)/);
  // the split's shapes are the join's, in reverse order
  const lens = { left: 40, top: 7, right: 140, bottom: 39 }, pane = { left: 6, top: 46, right: 994, bottom: 794, corner: 6.5 };
  for (const tau of [.1, .3, .6, .9]){
    const a = f.get("jointOutline(jointMoment(" + tau + ", " + JSON.stringify(lens) + ", " + JSON.stringify(pane) + ", 90, 0)).face");
    assert.equal(typeof a, "string"); assert.ok(a.length > 20);
  }
});
