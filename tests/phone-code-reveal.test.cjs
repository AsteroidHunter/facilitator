const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// On the phone a code block's copy button is hidden at rest. It shows (the sheet
// fades it, the page sets copyshown on the block) while the block is scrolled
// sideways and when the block is tapped, stays while a finger is on it, and goes
// about 2 seconds after the last scroll or tap; a tick on the button is waited
// out. The page's block is cut out of m.html by its first comment line and run
// against a stand-in document with timers run by hand: no browser, no layout.
const ROOT = path.join(__dirname, "..");
const HTML = readFileSync(path.join(ROOT, "m.html"), "utf8");
const SHEET = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const first = "// the copy button shows on a fenced block only while the block is scrolled";
const start = HTML.indexOf(first);
assert.ok(start >= 0 && HTML.indexOf(first, start + 1) < 0, "the copy button's reveal moved");
const SOURCE = HTML.slice(start, HTML.indexOf("\n}\n", start) + 3);

const TICK = '<svg><path d="M4 12.5 10 18.5 20 6"/></svg>';
const ICON = "<svg><rect/></svg>";

function world() {
  const listeners = [], pending = new Map();
  let now = 0, nextTimer = 1;
  const classes = () => {
    const set = new Set();
    return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
  };
  const wrapOf = () => {
    const button = { innerHTML: ICON };
    return { classList: classes(), querySelector: sel => sel === ".copybtn" ? button : null, button };
  };
  const wraps = { long: wrapOf(), short: wrapOf() };
  // a stand-in element: finds its wrap by .codeblockwrap, and is pre.codeblock when it is the code
  const part = (wrap, isCode = false) => ({
    matches: sel => isCode && sel === "pre.codeblock",
    closest: sel => sel === ".codeblockwrap" ? wrap : null,
  });
  const outside = { matches: () => false, closest: () => null };
  const context = vm.createContext({
    document: { addEventListener: (type, fn, options) => listeners.push({ type, fn, options }) },
    setTimeout: (fn, ms) => { const id = nextTimer++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => { pending.delete(id); },
  });
  vm.runInContext(SOURCE, context);
  const fire = (type, target) => {
    const event = {
      target, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { throw new Error("stopped"); },
      stopImmediatePropagation() { throw new Error("stopped"); },
    };
    for (const l of listeners) if (l.type === type) l.fn(event);
    return event;
  };
  const wait = ms => {
    const until = now + ms;
    for (;;) {
      const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  const shown = name => wraps[name].classList.contains("copyshown");
  return { listeners, wraps, shown, wait, fire,
    code: name => part(wraps[name], true), inside: name => part(wraps[name]), outside };
}

test("nothing is shown at rest, and the page asks for none", () => {
  const w = world();
  assert.ok(!w.shown("long") && !w.shown("short"));
  w.wait(10000);
  assert.ok(!w.shown("long") && !w.shown("short"));
});

test("scrolling a block shows its button, and about 2 seconds after the last scroll it goes", () => {
  const w = world();
  w.fire("scroll", w.code("long"));
  assert.ok(w.shown("long"));
  assert.ok(!w.shown("short"), "only the block that scrolled");
  w.wait(1500);
  w.fire("scroll", w.code("long"));
  w.wait(1500);
  assert.ok(w.shown("long"), "a scroll starts the 2 seconds again");
  w.wait(499);
  assert.ok(w.shown("long"));
  w.wait(2);
  assert.ok(!w.shown("long"));
});

test("only a code block's own scroll counts: the reply scrolling or a stray element does not show it", () => {
  const w = world();
  w.fire("scroll", w.outside);
  w.fire("scroll", w.inside("long"));
  w.fire("scroll", {});
  assert.ok(!w.shown("long"));
});

test("the scroll is heard in the capture phase, as a scroll event does not bubble", () => {
  const scroll = world().listeners.filter(l => l.type === "scroll");
  assert.equal(scroll.length, 1);
  assert.equal(scroll[0].options, true);
});

test("a tap anywhere on the block shows the button, and 2 seconds after the tap it goes", () => {
  const w = world();
  w.fire("click", w.code("short"));
  assert.ok(w.shown("short"));
  w.wait(1999);
  assert.ok(w.shown("short"));
  w.wait(2);
  assert.ok(!w.shown("short"));
  w.fire("click", w.inside("short"));
  assert.ok(w.shown("short"), "the label or the button area counts as the block");
  w.fire("click", w.outside);
  w.wait(2100);
  assert.ok(!w.shown("short"));
});

test("a tap does nothing else: no prevented default, no stopped event, only passive touch listeners", () => {
  const w = world();
  for (const type of ["click", "scroll", "touchstart", "touchend", "touchcancel"]) {
    const event = w.fire(type, type === "scroll" ? w.code("short") : w.inside("short"));
    assert.equal(event.defaultPrevented, false, type);
  }
  for (const l of w.listeners.filter(l => l.type.startsWith("touch"))) assert.equal(l.options.passive, true, l.type);
});

test("a finger on a shown block holds the button, and 2 seconds after it lifts the button goes", () => {
  const w = world();
  w.fire("click", w.code("short"));
  w.wait(1000);
  w.fire("touchstart", w.code("short"));
  w.wait(10000);
  assert.ok(w.shown("short"), "held while the finger is down");
  w.fire("scroll", w.code("short"));
  w.wait(10000);
  assert.ok(w.shown("short"), "a scroll under the finger does not start the count");
  w.fire("touchend", w.code("short"));
  w.wait(1999);
  assert.ok(w.shown("short"));
  w.wait(2);
  assert.ok(!w.shown("short"));
});

test("a cancelled touch lets go like a lifted one", () => {
  const w = world();
  w.fire("click", w.code("short"));
  w.fire("touchstart", w.code("short"));
  w.fire("touchcancel", w.code("short"));
  w.wait(2001);
  assert.ok(!w.shown("short"));
});

test("a finger put down on a hidden block shows nothing: the tap or the scroll does", () => {
  const w = world();
  w.fire("touchstart", w.code("long"));
  assert.ok(!w.shown("long"));
  w.fire("touchend", w.code("long"));
  w.wait(5000);
  assert.ok(!w.shown("long"));
});

test("a shown button stays while its tick shows, and goes just after", () => {
  const w = world();
  w.fire("click", w.inside("short"));
  w.wraps.short.button.innerHTML = TICK;
  w.wait(2000);
  assert.ok(w.shown("short"), "the tick is still up");
  w.wait(900);
  assert.ok(w.shown("short"));
  w.wraps.short.button.innerHTML = ICON;
  w.wait(301);
  assert.ok(!w.shown("short"));
});

test("two blocks are counted apart", () => {
  const w = world();
  w.fire("click", w.code("long"));
  w.wait(1500);
  w.fire("click", w.code("short"));
  w.wait(600);
  assert.ok(!w.shown("long"));
  assert.ok(w.shown("short"));
});

test("the sheet hides the button at rest on a touch screen and fades it, and the Mac keeps its hover", () => {
  const touch = /@media\s*\(\s*hover\s*:\s*none\s*\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g;
  const media = [...SHEET.matchAll(touch)].map(m => m[1]).join("\n");
  assert.match(media, /\.copyshown \.copybtn\{opacity:1; pointer-events:auto\}/);
  assert.match(media, /transition:opacity \.25s/);
  assert.doesNotMatch(media, /accent|purple/i);
  const plain = SHEET.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  assert.match(plain, /\.codeblockwrap:hover \.copybtn\{opacity:1; pointer-events:auto\}/);
});
