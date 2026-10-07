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

test("the send's lengths are shared by both pages: the iPhone's flight and glide, the sheet's arrival", () => {
  const { run } = load();
  assert.equal(run("SENT_FLIGHT_MS"), 750);
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

test("the iPhone's track runs in time from the typing bar to the exact landing and is read between its frames", () => {
  const { context, run } = load();
  // rows: ms, the box's left edge, its top and bottom, its right end, the size,
  // the strength the bubble is drawn at
  const track = Array.from(run("SENT_TRACK"), row => Array.from(row));
  assert.deepEqual(track[0].slice(0, 5), [0, 0, 0, 0, 1], "the track does not start on the typing bar at full size");
  assert.deepEqual(track.at(-1), [run("SENT_FLIGHT_MS"), 1, 1, 1, 1, 1], "the track does not end on the landing");
  for (let i = 1; i < track.length; i++) {
    assert.ok(track[i][0] > track[i - 1][0], "the track's frames are out of time order");
    assert.ok(track[i][0] - track[i - 1][0] <= 18.4, "the track skips a frame of the recordings");
    assert.ok(track[i][5] >= track[i - 1][5] && track[i][5] <= 1, "the strength drawn goes back or over whole");
  }
  assert.equal(typeof context.sentTrack, "function");
  assert.deepEqual({ ...context.sentTrack(-5) }, { left: 0, down: 0, right: 0, size: 1, strength: track[0][5] });
  assert.deepEqual({ ...context.sentTrack(5000) }, { left: 1, down: 1, right: 1, size: 1, strength: 1 });
  // halfway between two frames is halfway between their readings
  const [a, b] = [track[5], track[6]], half = context.sentTrack((a[0] + b[0]) / 2);
  assert.ok(Math.abs(half.left - (a[1] + b[1]) / 2) < 1e-9 && Math.abs(half.down - (a[2] + b[2]) / 2) < 1e-9);
  // the bubble drawn from the box: shrunk by the size about its bottom-right corner
  const drawn = context.sentMorphBox({ left: 0, top: 100, width: 300, height: 40 }, { left: 200, top: 0, width: 100, height: 50 },
    { left: 1, down: 1, right: 1, size: 0.5 });
  assert.deepEqual({ ...drawn.box }, { left: 250, top: 25, width: 50, height: 25 }, "the size is not held at the bottom-right corner");
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
  assert.doesNotMatch(shell, /transform|accent|432BFF/i);
  const reduced = code.slice(code.indexOf("@media (prefers-reduced-motion: reduce)", code.indexOf(".sentmorph")));
  assert.match(reduced, /\.answered\.markin::after\{animation:none !important\}/);
  assert.match(reduced, /\.answered\.markgone::after\{transition:none !important\}/);
});
