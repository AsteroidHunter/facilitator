// The glass carried onto the house and off it, and its landing. (1) A lens
// carried onto the house glides there and turns to the circle as a release
// slides it onto a name: from where it is seen, over the release's .28s, and
// the way off the house is the same motion the other way. (2) A drag's
// release changes the page and starts the joint forming in that same frame,
// under the lens as it slides, paced to end when it used to. The real drag,
// seat and joint code run on the synthetic bar of project-lens-fixture.cjs; a
// CSS transition is stood in for by the seat's running animation and the place
// it shows part way. This is geometry and timing, not rendering.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fixture, html } = require("./project-lens-fixture.cjs");

// the fixture's bar: the house is 0 to 32, the names a 40 to 140, b 140 to 280,
// c 280 to 360, and the seat's row starts at 0
const cls = (f, name) => f.seat.el.classList.contains(name);
// every write to the seat's style and every read of where it is drawn, in order
function watch(f){
  const el = f.seat.el, log = [], style = el.style, read = el.getBoundingClientRect.bind(el);
  el.style = new Proxy(style, { set(t, k, v){ log.push({ set: k, value: v }); t[k] = v; return true; } });
  el.getBoundingClientRect = () => {
    const r = read();
    log.push({ read: r.left, width: r.width, round: cls(f, "round"), still: cls(f, "still"), transition: style.transition });
    return r;
  };
  return log;
}
// what a carry across the edge of the house writes, from the first read on
const crossing = (log, from) => log.slice(from).map(e => e.read !== undefined ? "read " + e.read : e.set + " " + e.value);

test("carried onto the house, the glass glides there from where it was and turns to the circle on the release's .28s", () => {
  const f = fixture();
  f.down("a"); f.move(60);
  const shown = f.seat.el.getBoundingClientRect().left;
  assert.equal(shown, 40, "held at the first name while the pointer is between it and the house");
  const log = watch(f); f.move(16);
  const steps = crossing(log, 0);
  assert.deepEqual(steps, [
    "read 40",                                   // where it is seen
    "transition width .28s var(--gentle)",       // a width already turning goes on
    "transform translateX(0px)",                 // its place: the house
    "translate 40px 0px",                        // the rest of the way, still to go
    "width 32px",
    "read 40",                                   // drawn first where it was: no jump
    "transition " + f.get("SEAT_GLIDE"),
    "translate 0px 0px",                         // and the rest of the way runs out
  ]);
  // at that first drawing it already wears the circle and is not .still, so the corner turns with the width
  const flush = log.filter(e => e.read !== undefined)[1];
  assert.equal(flush.round, true); assert.equal(flush.still, false);
  assert.equal(f.get("SEAT_GLIDE"), "width .28s var(--gentle), translate .28s var(--gentle)");
  // the release's own slide: the seat's width and the lens's corner on .28s var(--gentle)
  assert.match(html, /body\.focus #tabrow \.tabseat\{[^}]*transition:transform \.28s var\(--gentle\), width \.28s var\(--gentle\)/);
  assert.match(html, /body\.focus #tabrow \.tabseat:not\(\.still\) \.seatlens\{\s*transition:[^}]*border-radius \.28s var\(--gentle\)/);
  assert.equal(f.context.homeOpen, false, "nothing opens before the release");
});

test("off the house the glass glides back the same way, and it follows the pointer while it glides", () => {
  const f = fixture();
  f.down("a"); f.move(60); f.move(16);
  const log = watch(f); f.move(200);
  // a name's lens again, from the house it stood on, to where the pointer has it
  assert.deepEqual(crossing(log, 0), ["read 0", "transition width .28s var(--gentle)", "transform translateX(150px)",
    "translate -150px 0px", "width 100px", "read 0", "transition " + f.get("SEAT_GLIDE"), "translate 0px 0px"]);
  assert.equal(cls(f, "round"), false); assert.equal(cls(f, "still"), false);
  // a move while it glides writes only its place, at once: the translate runs out on its own
  const before = log.length; f.move(230);
  assert.deepEqual(crossing(log, before), ["transform translateX(180px)"]);
  assert.doesNotMatch(f.seat.el.style.transition, /transform/, "the place follows the pointer with no lag");
});

test("from Home the glass leaves the house by the mirror of the way a name's glass comes onto it", () => {
  const f = fixture({ home: true });
  f.downHome(); f.move(22);
  const log = watch(f); f.move(100);
  assert.deepEqual(crossing(log, 0), ["read 0", "transition width .28s var(--gentle)", "transform translateX(84px)",
    "translate -84px 0px", "width 100px", "read 0", "transition " + f.get("SEAT_GLIDE"), "translate 0px 0px"]);
  // and back over the house, from wherever it is seen part way (the translate a browser shows mid-glide)
  f.seat.el.style.translate = "-30px 0px";
  const back = log.length; f.move(16);
  assert.deepEqual(crossing(log, back), ["read 54", "transition width .28s var(--gentle)", "transform translateX(0px)",
    "translate 54px 0px", "width 32px", "read 54", "transition " + f.get("SEAT_GLIDE"), "translate 0px 0px"]);
  assert.equal(cls(f, "round"), true);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(f.switches, []);
});

test("let go part way through a glide, the release slides on from there: nothing is cut short", () => {
  // onto the house: Home opens and the glass goes on to the circle
  const f = fixture();
  f.down("a"); f.move(60); f.move(16);
  f.seat.el.style.translate = "20px 0px";   // the rest of the way, as a browser shows it part way
  f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.equal(f.seat.owner, f.get("HOME_SEAT"));
  assert.equal(f.seat.el.style.translate, "20px 0px", "the glide's own run is left to finish");
  assert.equal(f.seat.el.style.transition, "", "the sheet's slide, which keeps translate in its list");
  assert.match(html, /body\.focus #tabrow \.tabseat\{[^}]*translate 220ms/);
  assert.equal(f.seat.el.style.transform, "translateX(0px)"); assert.equal(cls(f, "round"), true);
  assert.equal(cls(f, "still"), false); assert.equal(cls(f, "carried"), false);
  // onto a name, just off the house
  const g = fixture({ home: true });
  g.downHome(); g.move(22); g.move(200);
  g.seat.el.style.translate = "-60px 0px";
  g.up(200, 22, g.tabs.b);
  assert.deepEqual(g.switches, ["b"]); assert.equal(g.seat.el.style.translate, "-60px 0px");
  assert.equal(g.seat.el.style.transform, "translateX(140px)"); assert.equal(g.seat.el.style.width, "140px");
});

test("the glide is CSS alone, so reduced motion sets it down at once like every other transition", () => {
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\{ \*\{animation:none !important; transition:none !important\} \}/);
  const glide = html.slice(html.indexOf("function seatGlide("), html.indexOf("function moveTabSelection("));
  assert.doesNotMatch(glide, /requestAnimationFrame|setTimeout|animate\(/);
});

// ---- (2) the landing ---------------------------------------------------------------
const joint = f => f.get("tabJoint");
// a drag from a onto c, let go, with the seat's CSS slide stood in for: running
// for its .28s from where it was let go, the lens drawn part way along it
function dropOnC(){
  const f = fixture({ render: true }), s = f.get("({ split: JOINT_SPLIT_MS, join: JOINT_JOIN_MS, touch: JOINT_TOUCH })");
  f.down("a"); f.move(84);
  for (let t = 0; t < s.split + 50; t += 16) f.tick(16);
  assert.equal(joint(f).tau, 0, "the old joint has gone before the release");
  f.move(330);
  const from = { x: parseFloat(f.seat.el.style.transform.match(/[-.\d]+/)[0]), w: parseFloat(f.seat.el.style.width) };
  f.up(330, 22, f.tabs.c); f.click("c");
  const to = { x: 280, w: 80 }, el = f.seat.el, start = f.now;
  assert.deepEqual(f.switches, ["c"], "the page changes on the release");
  assert.equal(el.style.transform, "translateX(280px)");
  const slide = () => {
    const p = Math.min(1, (f.now - start) / 280);
    if (p < 1){
      el.animations = [{ playState: "running", transitionProperty: "transform" }];
      el.animated = { transform: "translateX(" + (from.x + (to.x - from.x) * p) + "px)", width: (from.w + (to.w - from.w) * p) + "px" };
    } else { el.animations = []; el.animated = null; }
  };
  const frames = [];
  for (let t = 0; t < 1200; t += 16){
    slide(); f.tick(16);
    const j = joint(f), lens = f.seat.face.getBoundingClientRect();
    frames.push({ t: f.now - start, tau: j.tau, kind: j.run?.kind || null, foot: j.foot, centre: (lens.left + lens.right) / 2, sliding: !!el.animations.length });
  }
  return { f, s, frames };
}

test("the joint starts forming in the frame the page changes, under the lens while it is still sliding", () => {
  const { frames } = dropOnC();
  // the first frame after the release is the page change's: the join's clock starts there
  assert.equal(frames[0].kind, "join", "the join did not start in the release's frame");
  const during = frames.filter(r => r.sliding);
  assert.ok(during.length >= 15, "the slide was stood in for");
  assert.ok(during.slice(1).every(r => r.tau > 0), "the joint waited for the slide to end");
  assert.ok(during.every((r, i) => i === 0 || r.tau >= during[i - 1].tau), "the join only goes one way");
  // it forms under the lens as it slides, not where it was let go nor where it will land
  assert.ok(during.every(r => Math.abs(r.foot - r.centre) < 1e-9), "the joint's foot left the lens");
  assert.ok(during[0].centre < during.at(-1).centre);
});

test("one gentle motion: the join runs on the merge's curve from the release and ends when it used to", () => {
  const { f, s, frames } = dropOnC();
  assert.equal(s.join, 980, "the .28s slide and the old 700ms join together");
  // the join's own time on each frame is the merge's curve of the time since the
  // release's frame, one 16ms frame after the release
  const J = f.get("sentCurve(MERGE_EASE)");
  for (const r of frames.filter(r => r.kind === "join"))
    assert.ok(Math.abs(r.tau - J((r.t - 16) / 980)) < 1e-8, "off the curve at " + r.t + "ms");
  // they first touch about a third of the way in, as the lens lands, not half a second after the page
  const touched = frames.find(r => r.tau >= s.touch);
  assert.ok(touched.t > 250 && touched.t < 400, "touched at " + touched.t + "ms");
  const done = frames.find(r => r.tau === 1);
  assert.ok(done.t >= 980 && done.t <= 1012, "whole at " + done.t + "ms");
  assert.ok(frames.slice(frames.indexOf(done)).every(r => r.tau === 1 && r.kind === null), "and at rest after");
});

test("a drop on the house opens Home with the glass on it, and Home is never joined", () => {
  const f = fixture({ render: true }), j = joint(f);
  f.down("a"); f.move(60); f.move(16);
  for (let t = 0; t < 400; t += 16) f.tick(16);
  f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true);
  for (let t = 0; t < 1200; t += 16){ f.tick(16); assert.equal(j.tau, 0); assert.notEqual(j.run?.kind, "join"); }
  assert.equal(f.seat.el.style.transform, "translateX(0px)"); assert.equal(f.seat.el.style.width, "32px");
});

test("a click or a key still sets the glass down at once, joint whole, with no glide", () => {
  const f = fixture({ render: true });
  f.click("b"); f.context.placeSeat();
  assert.equal(cls(f, "still"), true); assert.equal(f.seat.el.style.translate || "", "");
  assert.equal(joint(f).tau, 1); assert.equal(joint(f).run, null);
  f.homeButton.listeners.click[0]();
  assert.equal(cls(f, "still"), true); assert.equal(cls(f, "round"), true); assert.equal(joint(f).tau, 0);
});
