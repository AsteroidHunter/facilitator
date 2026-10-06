// While the card list slides, no ticket in it may grow or shrink. The keyboard
// pick enlarges one ticket, its words included, by three percent over 0.14s,
// and it was placed by the drawer's own open and close: the open class lands at
// the start of a release, a flick or a close, the list's observer measured the
// pick on it, and a ticket's words grew or shrank under the moving drawer.
// The real menu script and the real pick code run here together against a
// stand-in document whose drawer slide starts and lands the way a browser runs
// one. No browser, layout or server: this proves when the pick changes, not
// the frames a phone paints.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
// An old source copy can prove the regression without changing the checkout.
const HTML = readFileSync(process.env.PHONE_PICK_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end) {
  const at = HTML.indexOf(start), to = HTML.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `missing source between ${start} and ${end}`);
  return HTML.slice(at, to);
}
const MENUS = between('const page = document.getElementById("page");', "// the list's fades, the board's own");
const PICK = between("// The keyboard pick belongs only to this drawer", "// Keep only the start, first intended move");
const SECTIONS = ["drawerPane", "drawerRows"].map(name => HTML.match(new RegExp(`function ${name}\\(\\)\\{[\\s\\S]*?\\n\\}`))[0]).join("\n");

const TOP = 100, HEIGHT = 300, HEAD = 10, FOOT = 17, ROW = 52, GAP = 6;

function fixture({ reduced = false, selected = "r14", count = 20 } = {}) {
  const mutations = [], observers = [], microtasks = [], changes = [], docListeners = {};
  let body = null, tickets = null;
  const sliding = () => tickets.animations.length > 0 || body.classList.contains("menudrag");
  function element(id, classes = []) {
    const set = new Set(classes), props = new Map(), handlers = {};
    const el = {
      id, dataset: {}, offsetLeft: 10, offsetWidth: 290, clientTop: 0, animations: [],
      classList: {
        contains: name => set.has(name),
        toggle(name, on = !set.has(name)) {
          if (set.has(name) === on) return on;
          const oldValue = [...set].join(" ");
          if (on) set.add(name); else set.delete(name);
          if (el.inList) mutations.push({ type: "attributes", target: el, oldValue });
          if (el.row) changes.push({ id: el.dataset.id, name, on, sliding: sliding() });
          return on;
        },
        add(...names) { names.forEach(n => this.toggle(n, true)); },
        remove(...names) { names.forEach(n => this.toggle(n, false)); },
      },
      style: {
        getPropertyValue: name => props.get(name) || "",
        setProperty(name, value) {
          const was = props.has(name) ? props.get(name) : "0";
          props.set(name, value);
          // the browser's side of a drawer run: a new --list-v starts the
          // drawer's slide unless its transitions are off (a finger on it, the
          // hold, or reduced motion), and turning them off ends a slide in flight
          if (el === tickets && name === "--list-v") {
            const off = reduced || body.classList.contains("menudrag") || body.classList.contains("listhold");
            if (off) el.animations = [];
            else if (Number(was) !== Number(value)) el.animations = ["transform", "opacity"].map(slide);
          }
        },
      },
      setAttribute() {},
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, extra = {}) { for (const fn of handlers[type] || []) fn({ type, target: el, ...extra }); },
      getAnimations: () => el.animations,
      getBoundingClientRect: () => ({ width: 289, left: 30, right: 360, top: 300, bottom: 800 }),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
    return el;
  }
  function slide(transitionProperty) {
    let done;
    const finished = new Promise(resolve => { done = resolve; });
    return { transitionProperty, finished, done };
  }
  const nodes = Object.fromEntries(["page", "pane", "tickets", "tikwin", "settings", "scrim", "setpage", "setsrc", "tikbtn", "setbtn"]
    .map(id => [id, element(id)]));
  tickets = nodes.tickets;
  tickets.inList = true;
  tickets.dataset.side = "left";
  nodes.settings.dataset.side = "right";
  body = element("body");
  body.clientHeight = 800;
  // the section the list shows, scrolled to its top, so the open ticket is out of view
  const pane = element("todo");
  pane.clientHeight = HEIGHT;
  let scroll = 0;
  const rows = Array.from({ length: count }, (_, i) => {
    const r = element(`r${i}`, ["trow", ...(`r${i}` === selected ? ["on"] : [])]);
    r.dataset.id = `r${i}`;
    r.inList = r.row = true;
    r.getBoundingClientRect = () => {
      const top = TOP + HEAD - scroll + i * (ROW + GAP) - (r.classList.contains("on") ? 1 : 0);
      return { top, bottom: top + ROW };
    };
    r.scrollIntoView = () => {
      const rect = r.getBoundingClientRect();
      if (rect.top < TOP) pane.scrollTop += rect.top - TOP;
      else if (rect.bottom > TOP + HEIGHT) pane.scrollTop += rect.bottom - TOP - HEIGHT;
      pane.fire("scroll");
    };
    return r;
  });
  Object.defineProperty(pane, "scrollHeight", { get: () => HEAD + count * ROW + Math.max(0, count - 1) * GAP + FOOT });
  Object.defineProperty(pane, "scrollTop", {
    get: () => scroll, set: v => { scroll = Math.max(0, Math.min(v, pane.scrollHeight - HEIGHT)); },
  });
  pane.getBoundingClientRect = () => ({ top: TOP, bottom: TOP + HEIGHT });
  pane.querySelectorAll = () => rows;
  tickets.querySelectorAll = () => [pane];
  tickets.querySelector = () => rows.find(r => r.classList.contains("on")) || null;
  const document = element("document");
  Object.assign(document, {
    body, documentElement: element("html"), activeElement: null,
    getElementById: id => nodes[id],
    querySelector: selector => selector.includes('data-view="todo"') ? pane : null,
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
  });
  const context = vm.createContext({
    document, window: {}, innerWidth: 390, macHost: null, homeOpen: false, lastTicketTap: null, lastState: null, phoneDeveloperMode: false,
    selectedId: selected, curView: () => "todo",
    performance: { now: () => 0 },
    CSS: { supports: () => true },
    getComputedStyle: () => ({ getPropertyValue: name => name === "--sink" ? ".015" : name === "--drawer-pick-scale" ? "1" : "none", opacity: "1" }),
    queueMicrotask: fn => microtasks.push(fn),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe() { observers.push(this.fn); } },
    addEventListener() {}, settingsPage: () => ({ reset() {} }),
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {},
    editing: () => false, closeProjects() {}, dropResponseScroll() {}, renderTickets() {}, tickBands() {},
  });
  vm.runInContext(MENUS + "\n" + SECTIONS + "\n" + PICK, context);
  // what a microtask checkpoint delivers after each event: the queued
  // microtasks, then the list's mutation records, until nothing is left
  function settle() {
    for (let turn = 0; microtasks.length || mutations.length; turn++) {
      assert.ok(turn < 20, "the pick's observer must not loop");
      while (microtasks.length) microtasks.shift()();
      if (mutations.length) { const batch = mutations.splice(0); for (const fn of observers) fn(batch); }
    }
  }
  settle();
  const f = {
    rows, pane, tickets, body, changes, context,
    run: source => vm.runInContext(source, context),
    sliding,
    picks: () => rows.filter(r => r.classList.contains("drawer-pick")).map(r => r.dataset.id),
    // every change a ticket's classes took while the drawer was moving
    movedWhileSliding: () => changes.filter(c => c.sliding),
    // a physical key, which turns the pick on for this load
    key() {
      for (const fn of docListeners.keydown || [])
        fn({ type: "keydown", key: "Shift", code: "ShiftLeft", isTrusted: true, keyCode: 16, isComposing: false, target: body });
      settle();
    },
    scroll(top) { pane.scrollTop = top; pane.fire("scroll"); settle(); },
    tap() { nodes.tikbtn.fire("click"); settle(); },
    touch(type, x, t) {
      const point = { clientX: x, clientY: 400 }, ended = type === "touchend";
      for (const fn of docListeners[type] || [])
        fn({ type, timeStamp: t, target: body, touches: ended ? [] : [point], changedTouches: [point] });
      settle();
    },
    // a finger from x0 at `speed` px/ms, a reading every 10ms, lifted where it last was
    drag(x0, speed, ms, t0 = 1000) {
      f.touch("touchstart", x0, t0);
      for (let t = 10; t <= ms; t += 10) f.touch("touchmove", x0 + speed * t, t0 + t);
      f.touch("touchend", x0 + speed * ms, t0 + ms);
    },
    // the slide lands: its transitions finish and report their end
    async land() {
      const ending = tickets.animations;
      tickets.animations = [];
      for (const one of ending) { one.done(); tickets.fire("transitionend", { propertyName: one.transitionProperty }); }
      settle();
      await new Promise(resolve => setImmediate(resolve));
      settle();
    },
  };
  return f;
}

// an open list at rest whose open ticket is scrolled out of view, so the pick is on r0
async function openWithPick(options) {
  const f = fixture(options);
  f.key();
  f.tap(); await f.land();
  f.scroll(0);
  assert.deepEqual(f.picks(), ["r0"], "at rest the pick sits on the ticket under the line");
  f.changes.length = 0;
  return f;
}

for (const [label, x0, speed, ms] of [["a release", 8, .4, 500], ["a flick", 8, 1, 40]]) {
  test(`${label} that opens the list leaves every ticket as it is until the slide lands`, async () => {
    const f = fixture();
    f.key();
    assert.deepEqual(f.picks(), [], "a shut list has no pick");
    f.drag(x0, speed, ms);
    assert.equal(f.run("drawerOpen()"), true, "the list opened");
    assert.equal(f.sliding(), true, "and its slide is running");
    assert.deepEqual(f.movedWhileSliding(), [], "no ticket grew or shrank while the drawer moved");
    assert.deepEqual(f.picks(), []);
    await f.land();
    assert.deepEqual(f.picks(), ["r0"], "the pick is placed once the list stands still");
    assert.deepEqual(f.movedWhileSliding(), []);
  });
}

for (const [label, close] of [
  ["a tap", f => f.tap()],
  ["a release", f => f.drag(200, -.4, 500)],
  ["a flick", f => f.drag(200, -1, 40)],
]) {
  test(`${label} that shuts the list keeps the pick on its ticket until the list has gone`, async () => {
    const f = await openWithPick();
    close(f);
    assert.equal(f.run("drawerOpen()"), false, "the list is shutting");
    assert.equal(f.sliding(), true, "and its slide is running");
    assert.deepEqual(f.movedWhileSliding(), [], "no ticket shrank while the drawer moved");
    assert.deepEqual(f.picks(), ["r0"]);
    await f.land();
    assert.deepEqual(f.picks(), [], "the pick goes once the list has gone");
    assert.deepEqual(f.movedWhileSliding(), []);
  });
}

test("a first hardware key pressed while the list slides out waits for the landing", async () => {
  const f = fixture();
  f.drag(8, 1, 40);
  assert.equal(f.sliding(), true);
  f.key();
  assert.deepEqual(f.movedWhileSliding(), [], "the key changes no ticket under the moving drawer");
  await f.land();
  assert.deepEqual(f.picks(), ["r0"]);
});

test("a tap that opens the list scrolls the open ticket into view and picks nothing, as before", async () => {
  const f = fixture();
  f.key();
  f.tap();
  assert.deepEqual(f.movedWhileSliding(), []);
  await f.land();
  assert.deepEqual(f.picks(), [], "the open ticket is in view, so there is no pick");
  const shown = f.rows[14].getBoundingClientRect();
  assert.ok(shown.top >= TOP && shown.bottom <= TOP + HEIGHT, "the open ticket was scrolled into view");
});

test("at rest the pick still follows the scroll from ticket to ticket", async () => {
  const f = await openWithPick();
  const max = f.pane.scrollHeight - HEIGHT;
  f.scroll(max / 4);
  assert.equal(f.picks().length, 1);
  assert.notDeepEqual(f.picks(), ["r0"], "a scroll at rest moves the pick on");
  f.scroll(0);
  assert.deepEqual(f.picks(), ["r0"]);
});

test("Enter still finds the ticket under the line during a slide", async () => {
  const f = fixture();
  f.key();
  f.drag(8, 1, 40);
  assert.equal(f.sliding(), true);
  assert.equal(f.run("syncDrawerPick(true)")?.dataset.id, "r0", "Enter's own reading is not held back");
});

test("reduced motion runs no slide, so the pick comes and goes at once, as before", async () => {
  const f = fixture({ reduced: true });
  f.key();
  f.drag(8, .4, 500);
  assert.equal(f.sliding(), false, "no slide runs");
  assert.deepEqual(f.picks(), ["r0"], "the pick is placed on the open list at once");
  f.tap();
  assert.equal(f.run("drawerOpen()"), false);
  assert.deepEqual(f.picks(), [], "and taken away at once when it shuts");
  assert.deepEqual(f.movedWhileSliding(), []);
});
