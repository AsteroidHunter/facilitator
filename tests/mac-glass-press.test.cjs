// Run the Mac and PWA glass handlers with a controlled clock. The CSS check
// resolves the competing circle rules by specificity; browser tests separately
// measure the painted transition on an ordinary click.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const read = name => readFileSync(path.join(__dirname, "..", name), "utf8");
const mac = read("index.html"), phone = read("m.html");

function fixture(html, isPhone = false) {
  let now = 0, next = 1;
  const timers = new Map(), global = {}, documentEvents = {};
  const element = () => {
    const classes = new Set(), events = {};
    return { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
      fire(type, e = {}) { for (const fn of events[type] || []) fn(e); } };
  };
  const buttons = Array.from({ length: 4 }, element);
  const document = { visibilityState: "visible",
    getElementById: id => buttons[["homeico", "chimebtn", "setbtn"].indexOf(id)],
    querySelectorAll: () => buttons,
    addEventListener(type, fn) { (documentEvents[type] ||= []).push(fn); },
  };
  const context = vm.createContext({ document, tabPlus: buttons[3], tabSeat: { el: element() }, homeOpen:false,
    performance: { now: () => now },
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener(type, fn) { (global[type] ||= []).push(fn); },
  });
  const start = html.indexOf(isPhone ? "const PRESS_MIN = 120;" : "const GLASS_PRESS_MIN = 120;");
  const end = html.indexOf(isPhone ? "// ---- the capsule: a tap opens the list" : "// the cross, built with every tab", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  return { buttons: isPhone ? buttons : buttons.slice(1), home:buttons[0], seat:context.tabSeat.el,
    homeOpen(value) { context.homeOpen = value; },
    tick(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due; timers.delete(id); now = t.at; t.fn();
      }
      now = until;
    },
    fire(type, e = {}) { for (const fn of global[type] || []) fn(e); },
    hide() { document.visibilityState = "hidden"; for (const fn of documentEvents.visibilitychange || []) fn(); },
  };
}
const pressed = button => button.classList.contains("pressed");

for (const [name, html, isPhone] of [["Mac", mac, false], ["PWA", phone, true]]) {
  test(name + ": even a same-turn down/up keeps every glass button pressed for 120ms", () => {
    const f = fixture(html, isPhone);
    for (const button of f.buttons) {
      button.fire("pointerdown", { button: 0 });
      button.fire("pointerup"); f.fire("pointerup");
      assert.equal(pressed(button), true);
    }
    f.tick(119); assert.ok(f.buttons.every(pressed));
    f.tick(1); assert.ok(f.buttons.every(b => !pressed(b)));
  });

  test(name + ": a held press survives, releases outside, and a new press cancels the prior release", () => {
    const f = fixture(html, isPhone), button = f.buttons[0];
    button.fire("pointerdown", { button: 0 }); f.tick(500);
    assert.equal(pressed(button), true);
    f.fire("pointerup"); f.tick(0);
    assert.equal(pressed(button), false);
    button.fire("pointerdown", { button: 0 }); f.tick(15); button.fire("pointerup");
    f.tick(50); button.fire("pointerdown", { button: 0 });
    f.tick(100); assert.equal(pressed(button), true, "old release erased the new press");
    button.fire("pointerup"); f.tick(20);
    assert.equal(pressed(button), false);
  });

  test(name + ": pointer cancellation and hiding the page leave no stuck glass feedback", () => {
    const f = fixture(html, isPhone), button = f.buttons[0];
    button.fire("pointerdown", { button: 0 }); f.tick(20); f.fire("pointercancel");
    f.tick(100); assert.equal(pressed(button), false);
    button.fire("pointerdown", { button: 0 }); button.fire("pointerleave"); f.hide();
    assert.equal(pressed(button), false);
    f.tick(1000); assert.equal(pressed(button), false);
  });
}

test("Mac secondary clicks do not press the circle or cancel the button's own event", () => {
  const f = fixture(mac), button = f.buttons[0];
  const event = { button: 2, preventDefault() { assert.fail("press handler canceled the action"); },
    stopPropagation() { assert.fail("press handler swallowed the action"); } };
  button.fire("pointerdown", event); assert.equal(pressed(button), false);
  button.fire("pointerdown", { ...event, button: 0 }); assert.equal(pressed(button), true);
});

test("Home presses the shared lens only while Home is selected", () => {
  const f = fixture(mac);
  f.home.fire("pointerdown", { button:0 }); assert.equal(pressed(f.seat), false);
  assert.equal(pressed(f.home), false, "the bare house retained a separate glass press");
  f.homeOpen(true); f.home.fire("pointerdown", { button:2 }); assert.equal(pressed(f.seat), false);
  f.home.fire("pointerdown", { button:0 }); assert.equal(pressed(f.seat), true);
  f.fire("pointerup"); f.tick(119); assert.equal(pressed(f.seat), true);
  f.tick(1); assert.equal(pressed(f.seat), false);
});

function rules(html) {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, order) => ({ selector: m[1].trim(), order,
    values: Object.fromEntries(m[2].split(";").filter(d => d.includes(":")).map(d => {
      const at = d.indexOf(":"); return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
    })) }));
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// Specificity for the circle selectors: :is contributes its most specific
// alternative, including an ID even when a different alternative matches.
function specificity(selector) {
  const total = [0, 0, 0];
  selector = selector.replace(/:is\(([^()]*)\)/g, (_, alternatives) => {
    const max = alternatives.split(",").map(specificity).sort(compare).at(-1);
    max.forEach((n, i) => total[i] += n);
    return "";
  });
  total[0] += (selector.match(/#[\w-]+/g) || []).length;
  total[1] += (selector.match(/\.[\w-]+|:(?!:)[\w-]+/g) || []).length;
  total[2] += (selector.replace(/#[\w-]+|\.[\w-]+|:[\w-]+/g, "").match(/\b[a-z]+\b/g) || []).length;
  return total;
}
function circleTransitions(html, isPhone) {
  const all = rules(html);
  const idle = all.find(r => isPhone ? r.selector === "#dock .dockbtn" : r.selector.includes("#homeico") && r.values.width === "32px");
  const down = all.find(r => r.values.transform === "scale(1.06)" && r.selector.includes(".pressed"));
  assert.ok(idle && down, "the circle's idle and pressed rules must exist");
  const winner = [idle, down].sort((a, b) => compare(specificity(a.selector), specificity(b.selector)) || a.order - b.order).at(-1);
  const motion = rule => rule.values.transition.replace(/^color [^,]+,\s*/, "");
  return { idle: motion(idle), down: motion(winner), requested: motion(down) };
}

test("the Mac's effective press-in transition wins the idle rule and matches the PWA's faster curve", () => {
  const actual = circleTransitions(mac, false), reference = circleTransitions(phone, true);
  assert.equal(actual.down, actual.requested, "the idle selector overrode the short press animation");
  assert.equal(actual.down, reference.down);
  assert.equal(actual.idle, reference.idle);
});
