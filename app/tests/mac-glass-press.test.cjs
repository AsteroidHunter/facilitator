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
    const classes = new Set(["qn-glass"]), events = {}, props = {};   // the page presses only what wears the glass
    return { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      offsetWidth: 32, offsetHeight: 32, props, style: { setProperty: (name, value) => { props[name] = value; } },
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
      fire(type, e = {}) { for (const fn of events[type] || []) fn(e); } };
  };
  // the pieces of glass the page's press script walks: the Mac's bar has the magnifier before the speaker
  // and the bug between the speaker and the squid
  const ids = isPhone ? ["homeico", "projpill", "chimebtn", "setbtn"]
    : ["homeico", "projpill", "searchbtn", "chimebtn", "feedbackbtn", "setbtn", "npstart"];
  const buttons = Array.from({ length: ids.length }, element);
  const document = { visibilityState: "visible",
    getElementById: id => buttons[ids.indexOf(id)],
    querySelectorAll: () => buttons,
    addEventListener(type, fn) { (documentEvents[type] ||= []).push(fn); },
  };
  const context = vm.createContext({ document, homeOpen:false,
    performance: { now: () => now },
    setTimeout(fn, ms) { const id = next++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
    addEventListener(type, fn) { (global[type] ||= []).push(fn); },
  });
  const start = html.indexOf(isPhone ? "const PRESS_MIN = 120;" : "const GLASS_PRESS_MIN = 120;");
  const end = html.indexOf(isPhone ? "// ---- the capsule: a tap opens the list" : "// closing a project works exactly", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  return { buttons, home:buttons[0], pill:buttons[1],
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

test("Home and the project pill press as their own glass, with Home open or not", () => {
  for (const open of [false, true]) {
    const f = fixture(mac);
    f.homeOpen(open);
    for (const button of [f.home, f.pill]) {
      button.fire("pointerdown", { button:2 }); assert.equal(pressed(button), false);
      button.fire("pointerdown", { button:0 }); assert.equal(pressed(button), true);
    }
    f.fire("pointerup"); f.tick(119); assert.ok(pressed(f.home) && pressed(f.pill));
    f.tick(1); assert.ok(!pressed(f.home) && !pressed(f.pill));
  }
  // and Home open holds the press's face on the house, without the press's grow
  const held = mac.match(/body\.focus\.home #homeico\{([^}]+)\}/)[1];
  assert.match(held, /--qn-tint:\.95; --qn-edge:3/); assert.doesNotMatch(held, /transform/);
});

test("the pill grows by the circles' few pixels, not by the same 6% of a wider box", () => {
  const circle = 32 * 0.06;
  for (const width of [60, 75, 93, 140, 260]) {
    const f = fixture(mac);
    f.pill.offsetWidth = width;
    f.pill.fire("pointerdown", { button: 0 });
    const across = Number(f.pill.props["--press-x"]);
    assert.ok(Math.abs(width * (across - 1) - circle) < 1e-9, width + "px wide grows " + width * (across - 1) + "px");
    assert.ok(Math.abs(32 * (1.06 - 1) - circle) < 1e-9);
  }
  const all = rules(mac);
  const shared = all.find(r => r.selector.includes("#projpill") && r.selector.includes("#homeico") && r.selector.includes(".pressed"));
  const pill = all.find(r => r.selector === "body.focus #projpill.pressed");
  assert.ok(shared && pill, "the pill takes the circles' press rule and one rule for its grow");
  assert.equal(pill.values.transform, "scale(var(--press-x, 1.06), 1.06)");
  assert.equal(pill.values.transition, undefined, "the pill's rise and fall are the circles' own");
  assert.ok(pill.order > shared.order && specificity(pill.selector).join() === specificity(shared.selector).join());
});

test("PWA: the capsule grows by the round buttons' few pixels, with its own face and timing as they were", () => {
  for (const [width, height] of [[120, 48], [170, 48], [260, 48], [200, 52], [150, 44]]) {
    const f = fixture(phone, true);
    f.pill.offsetWidth = width; f.pill.offsetHeight = height;
    f.pill.fire("pointerdown", { button: 0 });
    const across = Number(f.pill.props["--press-x"]), circle = height * (1.06 - 1);
    assert.ok(Math.abs(width * (across - 1) - circle) < 1e-9, width + "px wide grows " + width * (across - 1) + "px");
  }
  const all = rules(phone);
  const round = all.find(r => r.selector === "#dock .dockbtn.pressed");
  const capsule = all.find(r => r.selector === "#dock #projbtn.pressed");
  assert.ok(round && capsule);
  assert.equal(round.values.transform, "scale(1.06)");
  assert.equal(capsule.values.transform, "scale(var(--press-x, 1.06), 1.06)");
  assert.equal(capsule.values["--qn-tint"], ".97"); assert.equal(capsule.values["--qn-edge"], "3.5");
  assert.equal(capsule.values.transition,
    "transform .38s cubic-bezier(.2,.8,.2,1), --qn-tint .38s ease-out, --qn-edge .38s ease-out");
  assert.ok(capsule.order > round.order && compare(specificity(capsule.selector), specificity(round.selector)) > 0);
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
