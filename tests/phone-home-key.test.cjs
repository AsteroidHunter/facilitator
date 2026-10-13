// Command + 0 on the phone page: the installed app takes it as the Home row's press,
// a Safari tab leaves it alone. The page's own key tables, installed-window test, key
// listener and house click handler run in a VM; only the Home page itself is replaced
// by a counter. No browser, server or phone is used.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const html = readFileSync(path.join(ROOT, "m.html"), "utf8");
const logic = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");

function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source block ${start}`);
  return html.slice(a, b);
}

// standalone: what navigator.standalone says (undefined in a browser that has none);
// displayMode: whether (display-mode: standalone) matches
function fixture({ standalone, displayMode = false, home = false } = {}) {
  const keydown = [], clicks = [], homes = [];
  const house = { listeners: [], addEventListener(type, fn) { if (type === "click") this.listeners.push(fn); },
    click() { clicks.push("house"); for (const fn of this.listeners) fn(); } };
  const context = vm.createContext({
    navigator: { standalone }, matchMedia: query => ({ matches: displayMode && /display-mode:\s*standalone/.test(query) }),
    house, homeOpen: home, homePanel: {}, homeShow() {}, lastState: null, phoneDeveloperMode: false,
    addEventListener(type, fn) { if (type === "keydown") keydown.push(fn); },
  });
  vm.runInContext(logic, context);
  context.setHome = on => { context.homeOpen = !!on; homes.push(!!on); };
  const run = source => vm.runInContext(source, context);
  run(between("function isInstalledWindow(){", "const curtain ="));
  run(between('house.addEventListener("click", () => {', "// put back once the whole script"));
  run(between("const phoneShortcutTyping =", "// a key brings its menu out"));
  run(between('addEventListener("keydown", e => {\n  dispatchCardShortcut(e, homeOpen', "// Tab with the focus nowhere"));
  const key = (extra = {}, target = { closest: () => null }) => {
    const e = { key: "0", code: "Digit0", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      target, defaultPrevented: false, repeat: false, isComposing: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const fn of keydown) { fn(e); if (e.stopped) break; }
    return e;
  };
  return { context, key, clicks, homes };
}
const typing = { closest: selector => (/textarea/.test(selector) ? {} : null) };

test("the installed app (navigator.standalone) opens Home on Command + 0 and keeps the key", () => {
  const f = fixture({ standalone: true });
  const e = f.key();
  assert.equal(f.context.homeOpen, true);
  assert.deepEqual(f.clicks, ["house"], "the key must be the Home row's own press");
  assert.deepEqual(f.homes, [true]);
  assert.equal(e.defaultPrevented, true);
});

test("the installed app (display-mode standalone, no navigator.standalone) opens Home too", () => {
  const f = fixture({ standalone: undefined, displayMode: true });
  const e = f.key();
  assert.equal(f.context.homeOpen, true);
  assert.equal(e.defaultPrevented, true);
});

test("a Safari tab does nothing on Command + 0 and does not prevent the default", () => {
  for (const standalone of [false, undefined]) {
    const f = fixture({ standalone, displayMode: false });
    const e = f.key();
    assert.equal(f.context.homeOpen, false);
    assert.deepEqual(f.clicks, []);
    assert.deepEqual(f.homes, []);
    assert.equal(e.defaultPrevented, false, "Safari's zoom reset must stay Safari's");
  }
});

test("on Home it does nothing and leaves the default alone", () => {
  const f = fixture({ standalone: true, home: true });
  const e = f.key();
  assert.equal(f.context.homeOpen, true);
  assert.deepEqual(f.clicks, []);
  assert.deepEqual(f.homes, []);
  assert.equal(e.defaultPrevented, false);
});

test("it works while typing in a box", () => {
  const f = fixture({ standalone: true });
  const e = f.key({}, typing);
  assert.equal(f.context.homeOpen, true);
  assert.equal(e.defaultPrevented, true, "the 0 must not be typed");
});

test("it needs Command and the Digit0 key; Control, Option and Shift with it do nothing", () => {
  for (const over of [{ metaKey: false }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { code: "Numpad0" }]) {
    const f = fixture({ standalone: true });
    const e = f.key(over);
    assert.equal(f.context.homeOpen, false, JSON.stringify(over));
    assert.equal(e.defaultPrevented, false, JSON.stringify(over));
  }
});
