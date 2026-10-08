// Motion contracts and frame-by-frame behavior without a browser or a board.
// Layout rectangles are synthetic. These checks cannot assess visual smoothness.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const CSS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
const PAGES = ["index.html", "m.html"].map(name => [name, readFileSync(path.join(ROOT, name), "utf8")]);
const code = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
function rule(selector) {
  const start = code.indexOf(selector + "{");
  assert.ok(start >= 0, "missing CSS rule: " + selector);
  return code.slice(start + selector.length + 1, code.indexOf("}", start));
}
// every rule a selector opens, joined: the sent panel has one for its preview
// and one for the room its mark stands in
function rulesOf(selector) {
  const out = [];
  for (let at = code.indexOf("\n" + selector + "{"); at >= 0; at = code.indexOf("\n" + selector + "{", at + 1))
    out.push(code.slice(at + selector.length + 2, code.indexOf("}", at)));
  assert.ok(out.length, "missing CSS rule: " + selector);
  return out.join(";");
}
function load(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(LOGIC, context);
  return { context, run: source => vm.runInContext(source, context) };
}

test("the send's lengths are shared by both pages: the flight, its compress, the iPhone's glide, the sheet's arrival", () => {
  const { run } = load();
  assert.equal(run("SENT_FLIGHT_MS"), 650);
  // the compress is the reference app's own send (FLIGHT_MS 400,
  // FLIGHT_EASE_POINTS [0.22, 1, 0.36, 1]), as the owner's reference recording shows it
  assert.equal(run("SENT_COMPRESS_MS"), 400);
  assert.deepEqual([...run("SENT_COMPRESS")], [.22, 1, .36, 1]);
  assert.equal(run("SENT_GLIDE_MS"), 340);
  assert.equal(run("SENT_GLIDE_EASE"), "cubic-bezier(.24,.1,.15,1)");
  // the curve an earlier flight's seat glides on is that same curve
  assert.equal(run("SENT_GLIDE_EASE"), "cubic-bezier(" + run("SENT_GLIDE").map(n => String(n).replace(/^0\./, ".")).join(",") + ")");
  // the flight is handed to the browser as keyframes joined straight, within
  // 0.1px of its curves on every ms
  assert.equal(run("SENT_TRUE_PX"), .1);
  assert.equal(run("SENT_ARRIVE_MS"), 400);
  assert.match(CSS, /--answ-come:\.4s/);
  assert.match(CSS, /--sent-ease:cubic-bezier\(\.22, 1, \.36, 1\)/);
  assert.match(CSS, /--answ-rise:10px/);
  assert.match(rule(".answered.arrive, .answmsg.arrive"), /var\(--answ-come\) var\(--sent-ease\)/);
  for (const [name, page] of PAGES) {
    assert.match(page, /src="\/card-logic\.js/, name);
    assert.match(page, /href="\/card-tokens\.css/, name);
    const send = page.slice(page.indexOf("function doSend(id, opts){"));
    const capture = send.indexOf("const motion = armSentMotion(el);");
    const clear = send.indexOf('el.ta.value = "";');
    const draw = send.indexOf(name === "index.html" ? "const sentItem = sentLaunch(" : "drawSent(el, id, true);");
    const play = send.indexOf("motion?.play();");
    assert.ok(capture >= 0 && capture < clear && clear < draw && draw < play,
      name + " must capture the typed field before collapse and fly after insertion");
  }
});

test("the track runs in time from the typing box to the exact landing, and its size goes once from the typing box's to the seat's", () => {
  const { context, run } = load();
  assert.equal(typeof context.sentTrack, "function");
  assert.deepEqual({ ...context.sentTrack(-5) }, { left: 0, down: 0, size: 0 },
    "the track does not start on the typing box");
  assert.deepEqual({ ...context.sentTrack(run("SENT_FLIGHT_MS")) }, { left: 1, down: 1, size: 1 },
    "the track does not end on the landing");
  assert.deepEqual({ ...context.sentTrack(5000) }, { left: 1, down: 1, size: 1 });
  // no stretch past the seat and close, no squeeze from the side: one size
  // change, from the typing box's to the seat's. and no strength: the box is
  // drawn whole the whole way, so its compress is seen
  for (const key of ["right", "squeeze", "stretch", "strength"])
    assert.ok(!(key in context.sentTrack(100)), `the track still carries a ${key}`);
  for (const name of ["SENT_SQUEEZE", "SENT_SQUEEZE_PEAK_MS", "SENT_STRETCH", "SENT_STRETCH_PEAK_MS", "SENT_FAINT", "SENT_STRENGTH"])
    assert.equal(run(`typeof ${name}`), "undefined", `${name} is still there`);
  let before = context.sentTrack(0);
  for (let ms = 1; ms <= run("SENT_FLIGHT_MS"); ms++) {
    const at = context.sentTrack(ms);
    for (const key of ["left", "down", "size"])
      assert.ok(at[key] >= before[key] - 1e-12 && at[key] <= 1, `the track's ${key} goes back or over whole at ${ms}ms`);
    before = at;
  }
  // the size on the reference recording's curve: the box's measured share of
  // its way in the owner's video, frame by frame from f0164 to f0180
  for (const [ms, share] of [[56, .525], [72.7, .634], [89.3, .723], [106, .787], [122.7, .842], [139.3, .881], [156, .912],
    [172.7, .936], [189.3, .951], [206, .966], [222.7, .976], [237.7, .985], [254.3, .988], [271, .994], [287.7, .997], [321, 1]])
    assert.ok(Math.abs(context.sentTrack(ms).size - share) <= .01, `the size at ${ms}ms is ${context.sentTrack(ms).size}, the recording's ${share}`);
  assert.equal(context.sentTrack(400).size, 1, "the compress is not whole by 400ms");
  // the sideways and up curves are premain's: across by 260ms, up by 430ms
  assert.equal(context.sentTrack(260).left, 1);
  assert.ok(context.sentTrack(259).left < 1);
  assert.equal(context.sentTrack(430).down, 1);
  assert.ok(context.sentTrack(429).down < 1);
  // the box drawn from the track: it starts as the typing box and lands as the
  // seat; its width and height go on the size; across, the way both side edges
  // share goes on the sideways curve and the rest of each one's on the size;
  // its top on the up curve
  const from = { left: 0, top: 100, width: 300, height: 40 }, to = { left: 200, top: 0, width: 150, height: 50 };
  const out = (left, down, size, seat = to) => ({ ...context.sentMorphBox(from, seat, { left, down, size }) });
  assert.deepEqual(out(0, 0, 0), from, "the box does not start as the typing box");
  assert.deepEqual(out(1, 1, 1), to, "the box does not land on the seat");
  // the right end has 50 to go and the left edge 200: they share 50
  assert.deepEqual(out(1, 0, 0), { left: 50, top: 100, width: 300, height: 40 }, "the sideways move is not the way both edges share");
  assert.deepEqual(out(0, 0, 1), { left: 150, top: 100, width: 150, height: 50 }, "the compress is not the rest of the way, closing in from the left");
  assert.deepEqual(out(0, 1, 0), { left: 0, top: 0, width: 300, height: 40 }, "the box changes size or crosses rising");
  assert.deepEqual(out(.5, .25, .5), { left: 100, top: 75, width: 225, height: 45 });
  // a seat wider than the typing box on its right: the left edge has the
  // shorter way, so it goes on the sideways curve and the right end takes the rest
  assert.deepEqual(out(1, 0, 0, { left: 20, top: 0, width: 320, height: 50 }), { left: 20, top: 100, width: 300, height: 40 });
  assert.deepEqual(out(0, 0, 1, { left: 20, top: 0, width: 320, height: 50 }), { left: 0, top: 100, width: 320, height: 50 });
  // edges going opposite ways share nothing: the whole way is the compress, as
  // in the recording
  assert.deepEqual(out(1, 0, 0, { left: 100, top: 0, width: 150, height: 50 }), from);
  assert.deepEqual(out(0, 0, 1, { left: 100, top: 0, width: 150, height: 50 }), { left: 100, top: 100, width: 150, height: 50 });
  // the seat read live is the one it follows: a seat that grows or moves while
  // the box is in the air is met at its new size
  assert.deepEqual(out(1, 1, 1, { ...to, width: 170, height: 70 }), { left: 200, top: 0, width: 170, height: 70 }, "the box does not follow the seat's size");
});

test("delivery seat is reserved before any receipt and the mark only paints outside it", () => {
  // The same margin exists on a local panel, a Delivered panel and a Read
  // panel. The receipt selectors cannot introduce another height or margin.
  assert.match(rulesOf(".answered.sent"), /margin-bottom:var\(--answ-tag\)/);
  assert.match(rule(".answered[data-mark], .answered.kept"), /margin-bottom:var\(--answ-tag\)/);
  assert.match(rule(".answered[data-mark]::after"), /position:absolute; top:100%/);
  for (const selector of [".answered.markin::after", ".answered.markout::after", ".answered.markgone::after"])
    assert.doesNotMatch(rule(selector), /(?:^|;)\s*(?:height|padding|margin|top|bottom)\s*:/);
  assert.match(rule(".answered.markin::after"), /var\(--answ-come\) var\(--sent-ease\)/);
  const { run } = load();
  assert.equal(run("MARK_IN_MS"), 400);
  assert.equal(run("MARK_OUT_MS"), 200);
});

test("send shells never scale their changing box and reduced motion stills receipt pseudo elements", () => {
  const shell = rule(".sentmorph");
  assert.match(shell, /position:fixed/);
  assert.match(shell, /pointer-events:none/);
  // a layer of its own, but never a transform on the box itself
  assert.doesNotMatch(shell, /(?:^|;)\s*transform\s*:|accent|432BFF/i);
  // the box is cut out by clips that only move: the shell clips nothing, each
  // clip hides what stands outside it, and the face is placed by the script,
  // rounded by the clips rather than by itself. the clips and the ground take
  // layers from their animations alone, so the frame a send draws stays light
  assert.doesNotMatch(shell, /overflow/);
  assert.match(rule(".sentmorph-clip"), /position:absolute; left:0; top:0; overflow:hidden/);
  for (const name of [".sentmorph-clip", ".sentmorph-ground"]) assert.doesNotMatch(rule(name), /will-change/, name + " asks for a layer up front");
  assert.doesNotMatch(rule(".sentmorph-face"), /inset|radius/);
  const reduced = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)", code.indexOf(".sentmorph")));
  assert.match(reduced, /\.answered\.markin::after\{animation:none !important\}/);
  assert.match(reduced, /\.answered\.markgone::after\{transition:none !important\}/);
});
