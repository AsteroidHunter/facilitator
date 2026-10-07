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

test("the send's lengths are shared by both pages: the flight, the iPhone's glide, the sheet's arrival", () => {
  const { run } = load();
  assert.equal(run("SENT_FLIGHT_MS"), 650);
  assert.equal(run("SENT_GLIDE_MS"), 340);
  assert.equal(run("SENT_GLIDE_EASE"), "cubic-bezier(.24,.1,.15,1)");
  assert.equal(run("SENT_FAINT"), .135);
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

test("the track runs in time from the typing box to the exact landing, and the box closes in from the left", () => {
  const { context, run } = load();
  assert.equal(typeof context.sentTrack, "function");
  assert.deepEqual({ ...context.sentTrack(-5) }, { left: 0, right: 0, down: 0, squeeze: 0, strength: .686 },
    "the track does not start on the typing box");
  assert.deepEqual({ ...context.sentTrack(run("SENT_FLIGHT_MS")) }, { left: 1, right: 1, down: 1, squeeze: 0, strength: 1 },
    "the track does not end on the landing");
  assert.deepEqual({ ...context.sentTrack(5000) }, { left: 1, right: 1, down: 1, squeeze: 0, strength: 1 });
  assert.ok(!("stretch" in context.sentTrack(100)), "the track still stretches the box taller");
  let before = context.sentTrack(0);
  const peakMs = run("SENT_SQUEEZE_PEAK_MS");
  assert.equal(peakMs, 330, "the squeeze does not peak where the flight's compress always has");
  for (let ms = 1; ms <= run("SENT_FLIGHT_MS"); ms++) {
    const at = context.sentTrack(ms);
    for (const key of ["left", "right", "down", "strength"])
      assert.ok(at[key] >= before[key] - 1e-12 && at[key] <= 1, `the track's ${key} goes back or over whole at ${ms}ms`);
    // the squeeze goes out to its full reach at the peak, then only closes
    assert.ok(at.squeeze >= 0 && at.squeeze <= 1, `the squeeze is out of range at ${ms}ms (${at.squeeze})`);
    if (ms <= peakMs) assert.ok(at.squeeze >= before.squeeze - 1e-12, `the squeeze closes before its peak at ${ms}ms`);
    else assert.ok(at.squeeze <= before.squeeze + 1e-12, `the squeeze goes out again at ${ms}ms`);
    before = at;
  }
  assert.equal(context.sentTrack(peakMs).squeeze, 1, "the squeeze does not reach its full reach at its peak");
  // the box drawn from the track: its right end, top and foot are the
  // frame's, and its left edge trails the frame's by the squeeze, up to a
  // fifth of the bubble's width
  const from = { left: 0, top: 100, width: 300, height: 40 }, to = { left: 200, top: 0, width: 100, height: 50 };
  const out = (squeeze, limit) => context.sentMorphBox(from, to, { left: 1, down: 1, right: 1, squeeze }, limit);
  assert.deepEqual({ ...out(1).box }, { left: 178, top: 0, width: 122, height: 50 }, "the squeeze is not a fifth of the bubble's width out from its left");
  assert.deepEqual({ ...out(.5).box }, { left: 189, top: 0, width: 111, height: 50 }, "half the squeeze is not half the reach");
  assert.deepEqual({ ...out(0).box }, { left: 200, top: 0, width: 100, height: 50 }, "the box does not close onto the bubble");
  // it stops at the limit, the card's own padding, and never reaches past it
  assert.deepEqual({ ...out(1, 190).box }, { left: 190, top: 0, width: 110, height: 50 }, "the squeeze goes past the card's padding");
  assert.deepEqual({ ...out(1, 250).box }, { left: 200, top: 0, width: 100, height: 50 }, "a limit right of the bubble's left makes the box narrower than the bubble");
  // never taller than the frame it rises in, nor drawn from another top
  const half = context.sentMorphBox(from, to, { left: .5, down: .5, right: .5, squeeze: 1 });
  assert.equal(half.box.height, half.frame.bottom - half.frame.top, "the box is taller than the frame it rises in");
  assert.equal(half.box.top, half.frame.top, "the box is not drawn from the frame's top");
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
  const reduced = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)", code.indexOf(".sentmorph")));
  assert.match(reduced, /\.answered\.markin::after\{animation:none !important\}/);
  assert.match(reduced, /\.answered\.markgone::after\{transition:none !important\}/);
});
