// Run the phone's real menu, Home, render and keyboard handlers without a
// browser or server. CSS checks cover the immediate animation reset; a VM
// cannot establish how a phone compositor paints it.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
// An old source copy can prove the regressions without changing the checkout.
const HTML = readFileSync(process.env.PHONE_HOME_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");

function between(start, end) {
  const at = HTML.indexOf(start), to = HTML.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `missing source between ${start} and ${end}`);
  return HTML.slice(at, to);
}

function element(id) {
  const classes = new Set(), properties = new Map(), handlers = {};
  return {
    id, dataset: {}, attributes: {}, offsetLeft: 10, offsetWidth: 290,
    clientHeight: 800, classList: {
      add(...names) { names.forEach(n => classes.add(n)); },
      remove(...names) { names.forEach(n => classes.delete(n)); },
      contains: name => classes.has(name),
      toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
    },
    style: { setProperty: (name, value) => properties.set(name, value), getPropertyValue: name => properties.get(name) || "" },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    fire(type, extra = {}) {
      const e = { target: this, preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; }, ...extra };
      for (const fn of handlers[type] || []) { fn(e); if (e.stopped) break; }
      return e;
    },
    getBoundingClientRect: () => ({ width: 289 }),
    getAnimations: () => [],
    querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  };
}

function fixture() {
  const nodes = Object.fromEntries(["page", "pane", "tickets", "tikwin", "settings", "scrim", "setpage", "setsrc",
    "tikbtn", "setbtn", "homeico", "cards", "tiksheet"].map(id => [id, element(id)]));
  nodes.tickets.dataset.side = "left";
  nodes.settings.dataset.side = "right";
  nodes.tiksheet.querySelector = () => element("section");
  const document = element("document"), window = element("window"), stored = new Map();
  document.body = element("body");
  document.documentElement = element("html");
  document.getElementById = id => nodes[id];
  document.activeElement = { blur() { calls.push("blur"); } };
  const calls = [];
  let now = 1000;
  const context = vm.createContext({ macHost: null,
    performance: { now: () => now },
    document, window, innerWidth: 390, homeOpen: false, homePanel: {}, homeTimer: null, limitsTimer: null, limitsTick: null,
    HOME_KEY: "homeopen", wantBox: null, house: nodes.homeico, lastTicketTap: null, lastState: null,
    selectedId: "card", activeOwner: "project", browsing: false, els: {}, phoneEnterAgain: null,
    localStorage: { setItem: (key, value) => stored.set(key, value), getItem: key => stored.get(key), removeItem: key => stored.delete(key) },
    addEventListener: window.addEventListener.bind(window),
    getComputedStyle: () => ({ getPropertyValue: name => name === "--sink" ? ".015" : "none" }),
    clearInterval() {}, setTimeout() {}, clearTimeout() {},
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {},
    settingsPage: () => ({ reset: () => calls.push("settings-reset") }),
    editing: () => true,
    closeProjects: () => calls.push("close-projects"),
    dropResponseScroll: () => calls.push("stop-scroll"),
    unselectShown: () => calls.push("unselect"),
    homeShow: () => calls.push("home-show"), renderTabs() {}, brandStart() {}, homeMake() {}, homeWarm() {}, homePause() {},
    paintViewTabs() {}, poolOf: () => [], viewFilterFor: () => true, syncSentView: () => null,
    paintPhonePane: () => { calls.push("paint-tickets"); return false; }, syncSpinner() {},
    tikTravelIntent: null, tikShownView: "todo", curView: () => "todo", moveTicketSheet() {},
    TICKET_VIEWS: ["todo", "docked", "deferred", "done"],
    stepCard: () => calls.push("step-card"), browse: () => calls.push("browse"), chooseShown: () => calls.push("choose"),
    responseScrollKey: () => calls.push("scroll-key"), listenResponseScroll() {},
  });
  vm.runInContext(LOGIC.slice(0, LOGIC.indexOf("// the two standing boxes")), context);
  vm.runInContext(LOGIC.match(/function responseScrollChord\(e\)\{[\s\S]*?\n\}/)[0], context);
  vm.runInContext(
    between("function setHome(on){", "// ---- the card list, the desktop's ticket box") +
    between("function ticketsShown(){", "// each button writes the view") +
    between("const page = document.getElementById(\"page\");", "// the list's fades, the board's own") +
    between("const phoneShortcutTyping =", "// ---- installing, and being told"), context);
  const run = source => vm.runInContext(source, context);
  return { nodes, document, window, calls, run, context, stored,
    home: () => nodes.homeico.fire("click"),
    gesture(type, x = 0, y = 200, timeStamp) {
      // Existing distance checks are slow drags; flick checks supply event time.
      // Omitted timestamps also exercise the real performance.now() fallback.
      now += 200;
      const point = { clientX: x, clientY: y };
      const ended = type === "touchend" || type === "touchcancel";
      document.fire(type, { button: 0, ...point, timeStamp,
        touches: ended ? [] : [point], changedTouches: [point] });
    },
  };
}

function noLeft(f) {
  assert.equal(f.nodes.tickets.classList.contains("open"), false, "no open project list on Home");
  assert.equal(f.nodes.tickets.classList.contains("live"), false, "no live project list on Home");
  for (const id of ["pane", "tickets", "tikwin"])
    assert.equal(Number(f.nodes[id].style.getPropertyValue("--list-v")), 0, id + " has no leftover travel");
  assert.equal(f.document.body.classList.contains("listout"), false);
  assert.equal(f.run("drawerOpen()"), false);
  assert.equal(f.run("ticketsShown()"), false);
}

test("the ticket button cannot open a project's list on Home", () => {
  const f = fixture(); f.home(); f.calls.length = 0;
  f.nodes.tikbtn.fire("click");
  noLeft(f);
  assert.deepEqual(f.calls, [], "an unavailable ticket press does not dismiss focus or the project picker");
  assert.equal(f.nodes.tikbtn.attributes["aria-disabled"], "true");
  f.run("setHome(false)");
  assert.equal(f.nodes.tikbtn.attributes["aria-disabled"], "false");
});

for (const kind of ["touch", "mouse"]) {
  const start = kind === "touch" ? "touchstart" : "mousedown";
  const move = kind === "touch" ? "touchmove" : "mousemove";
  const end = kind === "touch" ? "touchend" : "mouseup";
  test(`a fast ${kind} flick on Home cannot open the list`, () => {
    const f = fixture(); f.home(); f.calls.length = 0;
    f.gesture(start, 8, 200, 1000);
    f.gesture(move, 38, 200, 1040);
    f.gesture(end, 48, 200, 1050);
    noLeft(f);
    assert.equal(f.document.body.classList.contains("menudrag"), false);
    assert.deepEqual(f.calls, []);
  });
  test(`Home cancels ${kind} flicks without leaking speed into the next project pull`, () => {
    for (const closing of [false, true]) {
      const f = fixture();
      if (closing) f.nodes.tikbtn.fire("click");
      const x = closing ? 200 : 8, sign = closing ? -1 : 1;
      f.gesture(start, x, 200, 1000);
      f.gesture(move, x + sign * 30, 200, 1040);
      f.home(); noLeft(f);
      f.run("setHome(false)");
      f.gesture(move, x + sign * 40, 200, 1050);
      f.gesture(end, x + sign * 50, 200, 1060);
      noLeft(f);
      // A fresh short drag stays closed, even within the old sample window.
      f.gesture(start, 8, 200, 1070);
      f.gesture(move, 18, 200, 1090);
      f.gesture(end, 18, 200, 1100);
      noLeft(f);
      // A fresh intentional flick still works after cancellation.
      f.gesture(start, 8, 200, 1110);
      f.gesture(move, 38, 200, 1150);
      f.gesture(end, 48, 200, 1160);
      assert.equal(f.run("drawerOpen()"), true);
    }
  });
  test(`a ${kind} left-edge pull on Home never starts the drawer`, () => {
    const f = fixture(); f.home(); f.calls.length = 0;
    f.gesture(start, 0); f.gesture(move, 200);
    noLeft(f);
    assert.equal(f.document.body.classList.contains("menudrag"), false);
    f.gesture(end, 200); noLeft(f);
    assert.deepEqual(f.calls, []);
  });
  for (const phase of ["before intent", "opening", "closing"]) {
    test(`Home cancels a ${kind} pull ${phase}, even if a project returns before release`, () => {
      const f = fixture();
      if (phase === "closing") f.nodes.tikbtn.fire("click");
      f.gesture(start, phase === "closing" ? 300 : 0);
      if (phase !== "before intent") f.gesture(move, phase === "closing" ? 190 : 180);
      f.home(); noLeft(f);
      assert.equal(f.document.body.classList.contains("menudrag"), false);
      f.run("setHome(false)");
      f.gesture(move, 250); f.gesture(end, 250);
      noLeft(f);
      f.nodes.tikbtn.fire("click");
      assert.equal(f.run("drawerOpen()"), true, "a new project press still opens the drawer");
    });
  }
}

test("choosing Home closes an open list and resets all three travel fractions", () => {
  const f = fixture(); f.nodes.tikbtn.fire("click");
  assert.equal(f.run("drawerOpen()"), true);
  f.home(); noLeft(f);
  assert.equal(f.stored.get("homeopen"), "1");
});

test("restoring Home at startup also discards any retained drawer state", () => {
  const f = fixture(); f.nodes.tikbtn.fire("click");
  f.stored.set("homeopen", "1"); f.document.fire("DOMContentLoaded");
  assert.equal(f.context.homeOpen, true); noLeft(f);
});

test("Home hides the ticket window and cancels the pane's slide without waiting for transitionend", () => {
  const css = between("<style>", "</style>").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(/body\.home #tikwin\{display:none\}/.test(css), "Home removes the ticket window immediately");
  assert.ok(/body\.home #pane\{transform:none; transition:margin-bottom var\(--kb-anim\)\}/.test(css), "Home cancels the pane's slide");
  assert.ok(/body\.home #dockbed > i\{transition:none\}/.test(css), "Home resets the drawer's dock backing immediately");
  const f = fixture();
  f.nodes.tikbtn.fire("click"); f.run("hideMenu(tickets, true)");
  // The browser may still be between its start and target transforms here.
  f.home(); noLeft(f);
});

test("Home rejects direct menu commits and stale paints before they can restore the list", () => {
  const f = fixture(); f.home(); f.context.lastState = {};
  for (const action of ["showMenu(tickets)", "runMenu(tickets, 1, true)", "paintMenu(tickets, .65)"]) {
    f.calls.length = 0; f.run(action); noLeft(f);
    assert.deepEqual(f.calls, [], action);
  }
});

test("state readings and ticket renders ignore stale open/live classes on Home", () => {
  const f = fixture(); f.home(); f.calls.length = 0;
  f.nodes.tickets.classList.add("open", "live");
  assert.equal(f.run("menuOut()"), null);
  assert.equal(f.run("drawerOpen()"), false);
  assert.equal(f.run("ticketsShown()"), false);
  f.run("renderTickets({})");
  assert.deepEqual(f.calls, [], "a poll must not repopulate the unavailable list");
  f.run("paintMenu(tickets, .4)"); noLeft(f);
});

test("the existing global Home key guard leaves drawer and card keys inert", () => {
  const f = fixture(); f.home(); f.calls.length = 0;
  for (const [key, ctrlKey, shiftKey, code] of [["<", true, true, "Comma"], ["s", true, false],
    ["ArrowLeft", true, true], ["ArrowDown", false, false], ["Enter", false, false]])
    f.window.fire("keydown", { target: f.document.body, key, code, ctrlKey, shiftKey, metaKey: false, altKey: false });
  noLeft(f);
  assert.deepEqual(f.calls, []);
});

test("the shared menu key action also rejects the ticket menu on Home", () => {
  const f = fixture(); f.home(); f.calls.length = 0;
  f.run("toggleMenuKey({ preventDefault() {} }, tickets)"); noLeft(f);
  assert.deepEqual(f.calls, []);
});

test("Home leaves an open or moving settings menu alone and its ticket button cannot close it", () => {
  for (const moving of [false, true]) {
    const f = fixture();
    if (moving) { f.gesture("touchstart", 390); f.gesture("touchmove", 200); }
    else f.nodes.setbtn.fire("click");
    const properties = [f.nodes.settings.style.getPropertyValue("--shift"), f.nodes.scrim.style.getPropertyValue("--scrimv"),
      f.nodes.page.style.getPropertyValue("--page-scale")];
    f.home(); noLeft(f); f.nodes.tikbtn.fire("click");
    assert.deepEqual([f.nodes.settings.style.getPropertyValue("--shift"), f.nodes.scrim.style.getPropertyValue("--scrimv"),
      f.nodes.page.style.getPropertyValue("--page-scale")], properties);
    if (moving) f.gesture("touchend", 200);
    assert.equal(f.run("menuOut() === settings"), true);
    assert.equal(f.document.body.classList.contains("setout"), true);
  }
});

test("project ticket taps, pulls, thresholds and settings swaps retain their behavior", () => {
  const f = fixture(); f.home(); f.run("setHome(false)");
  f.nodes.tikbtn.fire("click"); assert.equal(f.run("drawerOpen()"), true);
  f.nodes.setbtn.fire("click"); assert.equal(f.run("menuOut() === settings"), true);
  f.nodes.tikbtn.fire("click"); assert.equal(f.run("menuOut() === tickets"), true);
  f.nodes.tikbtn.fire("click"); assert.equal(f.run("menuOut()"), null);
  for (const distance of [100, 200]) {
    f.gesture("touchstart", 0); f.gesture("touchmove", distance); f.gesture("touchend", distance);
    assert.equal(f.run("drawerOpen()"), distance > 150);
  }
});

// Read fade targets from the real CSS and fractions from the real handlers.
// This checks drag values and transition wiring, not rendered animation frames.
const drawerCSS = between("<style>", "</style>").replace(/\/\*[\s\S]*?\*\//g, "");
function drawerRule(selector) {
  const declarations = {};
  for (const [, selectors, body] of drawerCSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").some(s => s.trim() === selector)) continue;
    for (const part of body.split(";")) {
      const colon = part.indexOf(":");
      if (colon >= 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  return declarations;
}
function drawerFade(f) {
  const box = drawerRule("#tickets");
  const values = { ...box, "--list-v": f.nodes.tickets.style.getPropertyValue("--list-v") ||
    drawerRule("@property --list-v")["initial-value"] };
  const resolve = value => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(values[name]));
  return {
    drawer: Number(resolve(box.opacity || "1")),
    arrow: Number(resolve(drawerRule("#tickets #tikhead .tik-page").opacity)),
  };
}
function assertDrawerFade(f, expected) {
  const fade = drawerFade(f);
  assert.equal(fade.drawer, expected, "the whole drawer follows its open fraction");
  assert.equal(fade.drawer, fade.arrow, "the drawer and arrows share the fade fraction");
}

test("the left drawer rests at zero opacity and tap opens and closes target one and zero", () => {
  const f = fixture();
  assertDrawerFade(f, 0);
  f.nodes.tikbtn.fire("click");
  assertDrawerFade(f, 1);
  assert.equal(f.run("drawerOpen()"), true);
  f.nodes.tikbtn.fire("click");
  assertDrawerFade(f, 0);
  assert.equal(f.run("drawerOpen()"), false);
});

for (const kind of ["touch", "mouse"]) {
  const start = kind === "touch" ? "touchstart" : "mousedown";
  const move = kind === "touch" ? "touchmove" : "mousemove";
  const end = kind === "touch" ? "touchend" : "mouseup";
  test(`left drawer opacity follows a ${kind} drag in both directions, including reversals and bounds`, () => {
    for (const closing of [false, true]) {
      const f = fixture();
      if (closing) f.nodes.tikbtn.fire("click");
      const x = closing ? 300 : 0, sign = closing ? -1 : 1;
      f.gesture(start, x);
      for (const distance of [30, 75, 180, 120, 300, 330, -30]) {
        f.gesture(move, x + sign * distance);
        const fraction = Math.max(0, Math.min(1, distance / 300));
        assertDrawerFade(f, closing ? 1 - fraction : fraction);
        assert.equal(f.document.body.classList.contains("menudrag"), true);
      }
    }
  });
  test(`a ${kind} flick hands left drawer opacity from the finger to the open or closed target`, () => {
    for (const closing of [false, true]) {
      const f = fixture();
      if (closing) f.nodes.tikbtn.fire("click");
      const x = closing ? 200 : 8, sign = closing ? -1 : 1;
      f.gesture(start, x, 200, 1000);
      f.gesture(move, x + sign * 30, 200, 1040);
      assertDrawerFade(f, closing ? .9 : .1);
      f.gesture(end, x + sign * 30, 200, 1050);
      assertDrawerFade(f, closing ? 0 : 1);
      assert.equal(f.document.body.classList.contains("menudrag"), false);
      assert.equal(f.document.body.classList.contains("menurelease"), true);
    }
  });
}

test("left drawer opacity returns to rest after a short drag, a cancelled pull and Home", () => {
  for (const end of ["touchend", "touchcancel"]) {
    const f = fixture();
    f.gesture("touchstart", 0, 200, 1000);
    f.gesture("touchmove", 30, 200, 1500);
    assertDrawerFade(f, .1);
    f.gesture(end, 30, 200, 1700);
    assertDrawerFade(f, 0);
    f.nodes.tikbtn.fire("click");
    assertDrawerFade(f, 1);
    f.home();
    assertDrawerFade(f, 0);
  }
});

for (const selector of ["#tickets", "body.menurelease #tickets"]) {
  test(`${selector} keeps opacity, travel and arrow fade on the same transition clock`, () => {
    const transitions = Object.fromEntries(drawerRule(selector).transition.split(/,(?![^()]*\))/).map(one => {
      const [property, ...timing] = one.trim().split(/\s+/);
      return [property, timing.join(" ")];
    }));
    assert.equal(transitions.opacity, transitions.transform, "opacity must follow travel throughout a slide or reversal");
    assert.equal(transitions.opacity, transitions["--drawer-arrow-v"], "the arrows keep the same clock");
    assert.equal(transitions.opacity, `var(--drawer-ms) var(--drawer-${selector === "#tickets" ? "tap" : "drag"})`);
  });
}

test("left drawer fades follow the finger directly and reduced motion still removes transitions", () => {
  assert.equal(drawerRule("body.menudrag #tickets").transition, "visibility 0s linear var(--menuwait)");
  assert.match(drawerCSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition:none !important/);
  assert.equal(drawerRule("#settings").opacity, "1", "the right drawer stays fully opaque");
});
