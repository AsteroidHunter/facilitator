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
function load(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(LOGIC, context);
  return { context, run: source => vm.runInContext(source, context) };
}

test("copied send duration and curve are shared by both pages", () => {
  const { run } = load();
  assert.equal(run("SENT_ARRIVE_MS"), 400);
  assert.deepEqual(Array.from(run("SENT_EASE_POINTS")), [.22, 1, .36, 1]);
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

test("copied send easing decelerates without overshoot and keeps exact endpoints", () => {
  const { context } = load();
  assert.equal(typeof context.sentEase, "function");
  assert.equal(context.sentEase(0), 0);
  assert.equal(context.sentEase(1), 1);
  assert.ok(Math.abs(context.sentEase(.5) - .96138) < .0001);
  let previous = 0;
  for (let frame = 1; frame <= 120; frame++) {
    const current = context.sentEase(frame / 120);
    assert.ok(current >= previous && current <= 1, "no frame may reverse or overshoot");
    previous = current;
  }
});

test("delivery seat is reserved before any receipt and the mark only paints outside it", () => {
  // The same margin exists on a local panel, a Delivered panel and a Read
  // panel. The receipt selectors cannot introduce another height or margin.
  assert.match(rule(".answered.sent"), /margin-bottom:var\(--answ-tag\)/);
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
