const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// Source/VM checks only: no browser and no claim about native iPhone gestures.
// The override lets the same checks run against an old HTML snapshot.
const root = path.join(__dirname, "..");
const HTML = readFileSync(process.env.PWA_ZOOM_HTML || path.join(root, "m.html"), "utf8");
const inlineCSS = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const CSS = [inlineCSS, ...["card-tokens.css", "home-widgets.css"].map(file => readFileSync(path.join(root, file), "utf8"))]
  .join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));
const actions = rules.flatMap(rule => [...rule.body.matchAll(/(?:^|;)\s*touch-action\s*:\s*([^;]+)/g)]
  .map(([, value]) => ({ selector: rule.selector, value: value.trim() })));

// A local universal declaration gives each scroller its own value, including
// its blank area and future dynamic children. Check it is unconditional (at
// stylesheet depth zero), then reject any conflicting declaration, regardless
// of specificity or a media condition. This does not emulate browser layout.
function universalAction() {
  const css = inlineCSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const match = /(?:^|\})\s*\*\s*\{\s*touch-action\s*:\s*([^;}]+)\s*;?\s*\}/.exec(css);
  assert.ok(match, "every PWA element needs its own touch-action declaration");
  const before = css.slice(0, match.index + match[0].indexOf("*"));
  assert.equal([...before].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0), 0,
    "the universal policy must apply outside media queries");
  for (const action of actions) assert.equal(action.value, "manipulation", action.selector);
  return match[1].trim();
}

// Include the actual overflow:auto/scroll selectors from the PWA and shared
// sheets, so adding a nested scroll boundary cannot silently escape this test.
const surfaces = new Set([
  "html", "body", "#page", "#pane", "#cards", "#empty", "#dock", "#settings",
  "#tickets", ".trow", "#projlist", "#scrim", "#loading", ".ask-card", "button", "input",
  ...rules.filter(r => /(?:^|;)\s*overflow(?:-[xy])?\s*:[^;]*\b(?:auto|scroll)\b/.test(r.body))
    .flatMap(r => r.selector.split(",").map(s => s.trim())),
]);
for (const surface of surfaces) {
  test(`PWA touch-action is manipulation on ${surface}, without ancestor inheritance`, () => {
    assert.equal(universalAction(), "manipulation", surface);
  });
}

function gestureWorld() {
  const script = HTML.match(/<script id="page-zoom-guard">([\s\S]*?)<\/script>/);
  assert.ok(script, "the PWA needs its iOS pinch gesture guard");
  assert.ok(HTML.indexOf(script[0]) < HTML.indexOf("<body>"), "install the guard before the page becomes interactive");
  const listeners = [];
  vm.runInNewContext(script[1], {
    document: { addEventListener: (type, fn, options) => listeners.push({ type, fn, options }) },
  });
  return { listeners, fire(type, event) { for (const listener of listeners) if (listener.type === type) listener.fn(event); } };
}

test("only gesturestart and gesturechange receive capturing, nonpassive pinch guards", () => {
  const { listeners } = gestureWorld();
  assert.deepEqual(listeners.map(l => l.type), ["gesturestart", "gesturechange"]);
  for (const { type, options } of listeners) {
    assert.equal(options.passive, false, type);
    assert.equal(options.capture, true, type);
  }
});

test("pinch open and pinch close cancel their defaults without stopping propagation", () => {
  const world = gestureWorld();
  for (const type of ["gesturestart", "gesturechange"]) {
    for (const scale of [0.5, 1, 2]) {
      const event = new Event(type, { cancelable: true, bubbles: true });
      event.scale = scale;
      event.stopPropagation = event.stopImmediatePropagation = () => assert.fail("keep other handlers reachable");
      world.fire(type, event);
      assert.equal(event.defaultPrevented, true, `${type} at scale ${scale}`);
    }
    world.fire(type, { cancelable: false, preventDefault: () => assert.fail("cannot cancel this event") });
  }
});

test("the guard leaves single-finger touches, two ticket clicks and other controls alone", () => {
  const world = gestureWorld();
  for (const type of ["touchstart", "touchmove", "touchend", "click", "click", "pointerdown", "input", "keydown"]) {
    const event = new Event(type, { cancelable: true, bubbles: true });
    world.fire(type, event);
    assert.equal(event.defaultPrevented, false, type);
  }
});
