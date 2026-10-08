// The card list opens only as far as the section on show needs, and never
// further than the room it is laid out in. The real menu script, the real
// drawerPane and the real fit block run in a VM against stand-in parts: the
// section is laid out as the stylesheet lays it out, as tall as its rows, gaps
// and padding and never taller than the list, and animate() records what the
// script asks for. No browser, layout engine or server: this proves the drop
// the page asks for and when, not the frames a phone paints.
// PHONE_FIT_SOURCE runs the same checks on an old copy of m.html.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const HTML = readFileSync(process.env.PHONE_FIT_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end, optional = false) {
  const at = HTML.indexOf(start), to = HTML.indexOf(end, at + start.length);
  if (optional && at < 0) return "";
  assert.ok(at >= 0 && to > at, `missing source between ${start} and ${end}`);
  return HTML.slice(at, to);
}
const MENUS = between('const page = document.getElementById("page");', "// the list's fades, the board's own");
const FIT = between("// what the section on show leaves spare", "// The keyboard pick belongs only to this drawer", true);
const PANE = HTML.match(/function drawerPane\(\)\{[\s\S]*?\n\}/)[0];
const CSS = between("<style>", "</style>").replace(/\/\*[\s\S]*?\*\//g, "");
function rule(selector) {
  const declarations = {};
  for (const [, selectors, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").some(s => s.trim() === selector)) continue;
    for (const part of body.split(";")) {
      const colon = part.indexOf(":");
      if (colon >= 0) declarations[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  return declarations;
}

// the page's layout, as the stylesheet lays it out on an 800px page
const BODY = 800, ROOM = Math.round(BODY * 0.55), SHARE = 0.9;
const HEAD = 39;                 // the names and the divider's gap, above the list
const AIR = 7;                   // the list reaches this far past the box's foot
const PAD_TOP = 11, PAD_FOOT = 18, ROW = 52, GAP = 6, NOTE = 33;
const TRAVEL = 300;              // the list's travel across: offsetLeft 10 + offsetWidth 290
const VIEWS = ["todo", "docked", "deferred", "done"];
// a section's own height: its rows, the gaps between them and its padding, or its empty note
const rowsHeight = n => PAD_TOP + (n ? n * ROW + (n - 1) * GAP : NOTE) + PAD_FOOT;

function fixture({ reduced = false, rows = { todo: 2, docked: 0, deferred: 12, done: 30 } } = {}) {
  const played = [], frames = [], observers = [], resizers = [], records = [], nodes = {}, clock = { now: 0 };
  let view = "todo";
  function element(id, parent = null) {
    const classes = new Set(), props = new Map(), handlers = {};
    const el = {
      id, dataset: {}, parentNode: parent, offsetLeft: 10, offsetWidth: 290,
      classList: {
        add(...names) { names.forEach(n => el.classList.toggle(n, true)); },
        remove(...names) { names.forEach(n => el.classList.toggle(n, false)); },
        contains: name => classes.has(name),
        toggle(name, on = !classes.has(name)) {
          if (classes.has(name) !== on) records.push({ type: "attributes", attributeName: "class", target: el });
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      },
      style: {
        setProperty(name, value) { props.set(name, value); },
        getPropertyValue: name => props.get(name) || "",
      },
      setAttribute() {},
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, extra = {}) { for (const fn of handlers[type] || []) fn({ type, target: el, ...extra }); },
      getBoundingClientRect: () => ({ width: 289, left: 30, right: 360, top: 300, bottom: 800 }),
      getAnimations: () => played.filter(a => a.el === el && a.playState === "running"),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      animate(keyframes, options) {
        let settle, fail;
        const finished = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
        finished.catch(() => {});
        const a = { el, keyframes, options, id: options.id, playState: "running", currentTime: 0, startTime: null, finished,
          cancel() { if (a.playState === "running") { a.playState = "idle"; fail(new Error("cancelled")); } },
          land() { if (a.playState === "running") { a.playState = "finished"; settle(a); } } };
        played.push(a);
        return a;
      },
    };
    return el;
  }
  for (const id of ["page", "pane", "tickets", "tikwin", "settings", "scrim", "setpage", "setsrc", "tikbtn", "setbtn"]) nodes[id] = element(id);
  nodes.tikhead = element("tikhead", nodes.tickets);
  for (const id of ["tik-page-back", "tik-page"]) nodes[id] = element(id, nodes.tikhead);
  for (const name of VIEWS) nodes["tv-" + name] = element("tv-" + name, nodes.tikhead);
  nodes["tv-todo"].classList.add("on");
  nodes.tickets.dataset.side = "left";
  nodes.settings.dataset.side = "right";
  // the room is what the script wrote on the page; the list takes nine tenths of
  // it, less the names above, plus the air it reaches past the box's foot
  const room = () => parseFloat(nodes.page.style.getPropertyValue("--list-room") || nodes.page.style.getPropertyValue("--list-drop")) || 0;
  const sheet = element("tiksheet", nodes.tickets);
  Object.defineProperty(sheet, "clientHeight", { get: () => Math.max(0, Math.round(room() * SHARE) - HEAD + AIR) });
  const panes = {};
  for (const name of VIEWS) {
    const pane = panes[name] = element(name, sheet);
    pane.parentElement = sheet;
    pane.rows = rows[name];
    // as tall as its own rows and never taller than the list
    Object.defineProperty(pane, "offsetHeight", { configurable: true, get: () => Math.min(rowsHeight(pane.rows), sheet.clientHeight) });
  }
  const body = element("body");
  body.clientHeight = BODY;
  const timeline = { currentTime: 5000 };
  const document = element("document");
  Object.assign(document, { body, documentElement: element("html"), activeElement: null, timeline,
    getElementById: id => nodes[id],
    querySelector: selector => panes[/data-view="([^"]+)"/.exec(selector)?.[1]] || null,
    querySelectorAll: selector => selector === ".tikpane" ? Object.values(panes) : [] });
  class ResizeObserver { constructor(fn) { resizers.push(fn); } observe() {} }
  class MutationObserver { constructor(fn) { this.fn = fn; } observe(target, options) { observers.push({ fn: this.fn, target, options }); } }
  const context = vm.createContext({
    document, window: { ResizeObserver }, ResizeObserver, MutationObserver,
    innerWidth: 390, macHost: null, homeOpen: false, lastTicketTap: null, lastState: null,
    performance: { now: () => clock.now },
    CSS: { supports: (property, value) => /^linear\(/.test(value) },
    matchMedia: query => ({ matches: reduced && /prefers-reduced-motion:\s*reduce/.test(query) }),
    requestAnimationFrame: fn => frames.push(fn),
    getComputedStyle: () => ({ getPropertyValue: name => name === "--sink" ? ".015" : "none", opacity: "1" }),
    addEventListener() {}, settingsPage: () => ({ reset() {} }),
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {},
    editing: () => false, closeProjects() {}, dropResponseScroll() {}, renderTickets() {},
    curView: () => view,
  });
  vm.runInContext(MENUS + "\n" + PANE + "\n" + FIT, context);
  const within = (el, target, deep) => el === target || deep && !!el.parentNode && within(el.parentNode, target, deep);
  // what the browser delivers between tasks: promise callbacks, then each
  // mutation observer's records, until nothing is left
  async function settle() {
    for (let turn = 0; turn < 20; turn++) {
      for (let i = 0; i < 5; i++) await Promise.resolve();
      if (!records.length) return;
      const batch = records.splice(0);
      for (const o of observers) {
        const mine = batch.filter(r => within(r.target, o.target, o.options.subtree));
        if (mine.length) o.fn(mine);
      }
    }
    assert.fail("the observers loop");
  }
  const point = (type, x, t) => {
    const at = { clientX: x, clientY: 400 }, ended = type === "touchend";
    document.fire(type, { timeStamp: t, button: 0, ...at, target: body, touches: ended ? [] : [at], changedTouches: [at] });
  };
  const f = {
    nodes, panes, played, timeline, body, run: source => vm.runInContext(source, context), point,
    tap: () => nodes.tikbtn.fire("click"),
    frame(ms = 16) { clock.now += ms; timeline.currentTime += ms; for (const fn of frames.splice(0)) fn(timeline.currentTime); },
    land: () => { for (const a of played) a.land(); },
    playing: () => played.filter(a => a.playState === "running"),
    settle,
    // the card's drop as written, and the distance from the section's foot down
    // to the card's top edge with the list out (the box stands 5% of the room
    // down from the page's top, the names over the section)
    drop: () => parseFloat(nodes.pane.style.getPropertyValue("--list-drop") || nodes.page.style.getPropertyValue("--list-drop")),
    paperUnder: () => f.drop() - (room() * (1 - SHARE) / 2 + HEAD + panes[view].offsetHeight),
    // a section named, as paintViewTabs marks it, and a section's rows changed,
    // which its ResizeObserver reports
    show(name) { view = name; for (const v of VIEWS) nodes["tv-" + v].classList.toggle("on", v === name); },
    rows(name, n) { panes[name].rows = n; for (const fn of resizers) fn([]); },
    // open from rest and let the run land, as the browser would
    async open() { f.tap(); f.frame(); f.frame(); f.land(); await settle(); },
    async close() { f.tap(); f.frame(); f.frame(); f.land(); await settle(); },
  };
  return f;
}
const of = (f, id, property) => f.playing().find(a => a.el === f.nodes[id] && property in a.keyframes[0]);
const px = value => String(value).match(/-?[\d.]+(?=px)/g).map(Number);
// the full paper under a section that fills the room: the room's 5% under the
// box, less the air the list reaches past the box's foot
const FULL_PAPER = ROOM * (1 - SHARE) / 2 - AIR;

// ---- the rule -----------------------------------------------------------------
test("a section is as tall as its rows and never taller than the list; the box keeps the room and only the card's drop moves", () => {
  const pane = rule(".tikpane");
  assert.equal(pane["max-height"], "100%", "a section is capped by the list");
  assert.equal(pane["align-self"], "flex-start", "a section is not stretched to the list's height");
  assert.equal(pane.height, undefined, "a section is not given the list's height");
  assert.equal(pane["overflow-y"], "auto", "a section that does not fit still scrolls");
  // the box and its window are laid out in the room; the card, the window and
  // the box move by the drop, written on the three, which no child inherits
  assert.equal(rule("#tickets").height, "calc(var(--list-room, 0px) * var(--list-share))");
  assert.match(rule("#tickets").top, /^calc\(var\(--list-room, 0px\) \+ var\(--pg-t\)/);
  assert.equal(rule("#tikwin").top, "calc(-1 * var(--list-room, 0px))");
  assert.match(rule("#tikwin").transform, /var\(--list-v\) \* var\(--list-drop, 0px\)/);
  assert.match(rule("#pane").transform, /var\(--list-v\) \* var\(--list-drop, 0px\)/);
  assert.match(CSS, /@property --list-drop\{[^}]*inherits:false/);
  // the measure is the list's height less the section's, read off the layout
  assert.match(FIT, /list\.clientHeight - pane\.offsetHeight/);
});

test("two tickets: the card stops as far under the last ticket as under a full section, well short of the room", async () => {
  const f = fixture();
  await f.open();
  const want = ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(2));
  assert.equal(f.drop(), want, "the drop is the room less what the section leaves spare");
  assert.ok(f.drop() < ROOM, `two tickets open ${f.drop()}px of a ${ROOM}px room`);
  assert.ok(Math.abs(f.paperUnder() - FULL_PAPER) < 1e-9, `paper under the last ticket ${f.paperUnder()}, a full section's ${FULL_PAPER}`);
  // the run itself goes to that drop: the card, the window and the list together
  f.tap(); f.frame(); f.frame(); f.land(); await f.settle();
  f.tap();
  const card = of(f, "pane", "transform");
  assert.equal(px(card.keyframes.at(-1).transform)[1], want);
});

test("more tickets than fit: the whole room, never more; a section that just fits opens the whole room too", async () => {
  for (const n of [30, 7]) {
    const f = fixture({ rows: { todo: n, docked: 0, deferred: 0, done: 0 } });
    await f.open();
    assert.equal(f.drop(), ROOM, `${n} tickets`);
    assert.ok(Math.abs(f.paperUnder() - FULL_PAPER) < 1e-9);
  }
  // exactly the list's height: nothing spare
  const exact = fixture();
  await exact.open();
  const fits = Math.round(ROOM * SHARE) - HEAD + AIR;
  exact.panes.todo.rows = 0;
  Object.defineProperty(exact.panes.todo, "offsetHeight", { get: () => fits });
  exact.rows("todo", 0);
  await exact.settle(); exact.frame(); exact.frame(); exact.land(); await exact.settle();
  assert.equal(exact.drop(), ROOM);
});

test("an empty section still opens onto its names, its arrows and its empty note", async () => {
  const f = fixture();
  f.show("docked");
  await f.open();
  const box = ROOM * (1 - SHARE) / 2;
  assert.ok(f.drop() > box + HEAD + rowsHeight(0) - AIR, `the card at ${f.drop()} covers the names or the note`);
  assert.ok(Math.abs(f.paperUnder() - FULL_PAPER) < 1e-9, "the same paper under the note as under a full section");
  assert.ok(f.drop() < ROOM, "and no further");
});

test("the open run is the same spring over the fitted drop: half way and nine tenths at the same times", async () => {
  // where the card's keyframes pass a share of their run, in ms from the run's start
  const when = (card, share) => {
    const ms = card.options.duration, drop = px(card.keyframes.at(-1).transform)[1];
    const pts = card.keyframes.map(k => [k.offset * ms, px(k.transform)[1] / drop]);
    const i = pts.findIndex(p => p[1] >= share);
    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
    return t0 + (t1 - t0) * (share - v0) / (v1 - v0);
  };
  const runs = [];
  for (const n of [2, 30]) {
    const f = fixture({ rows: { todo: n, docked: 0, deferred: 0, done: 0 } });
    f.tap();
    const card = of(f, "pane", "transform"), win = of(f, "tikwin", "transform"), list = of(f, "tickets", "transform");
    card.keyframes.forEach((k, i) => {
      const y = px(k.transform)[1], v = y / f.drop();
      assert.ok(Math.abs(px(win.keyframes[i].transform)[1] - y) < 1e-9, "the window goes down with the card");
      const [x, ly] = px(list.keyframes[i].transform);
      assert.ok(Math.abs(ly + y) < 1e-9 && Math.abs(x - (v - 1) * TRAVEL) < 1e-2, "the list holds still and comes in across");
    });
    runs.push({ half: when(card, .5), most: when(card, .9) });
  }
  for (const key of ["half", "most"])
    assert.ok(Math.abs(runs[0][key] - runs[1][key]) < 1, `${key}: ${runs[0][key].toFixed(1)}ms fitted, ${runs[1][key].toFixed(1)}ms full`);
  // and those are the reference app's: half way at 143ms, nine tenths at 336ms
  assert.ok(Math.abs(runs[0].half - 143) < 2 && Math.abs(runs[0].most - 336) < 2, JSON.stringify(runs[0]));
});

// ---- a change while the list is out ---------------------------------------------
test("a ticket that comes while the list is out and at rest glides the card down on the spring from rest, the list holding still", async () => {
  const f = fixture();
  await f.open();
  const was = f.drop();
  f.rows("todo", 3);
  await f.settle();
  const want = was + ROW + GAP;
  const run = f.playing();
  assert.deepEqual(run.map(a => a.el.id).sort(), ["pane", "tickets", "tikwin"], "the card, the window and the list, and nothing else");
  assert.ok(run.every(a => a.options.id === "list-run" && a.options.easing === "linear"));
  assert.ok(!run.some(a => "opacity" in a.keyframes[0] || "--list-v" in a.keyframes[0]), "no fade and no arrows: the list stays out");
  const card = of(f, "pane", "transform"), win = of(f, "tikwin", "transform"), list = of(f, "tickets", "transform");
  const spring = f.run(`listSpring(0, 1, 0, ${want - was})`);
  assert.equal(card.options.duration, spring.ms, "the spring's own length over the change");
  assert.deepEqual(card.keyframes.map(k => k.offset), spring.points.map(p => p[0]), "and the spring's own points");
  card.keyframes.forEach((k, i) => {
    const y = px(k.transform)[1];
    assert.ok(Math.abs(y - (was + (want - was) * spring.points[i][1])) < 1e-3, "the card on the spring");
    assert.ok(Math.abs(px(win.keyframes[i].transform)[1] - y) < 1e-9, "the window's foot on the card's top");
    assert.deepEqual(px(list.keyframes[i].transform).slice(0, 2).map(n => n + 0), [0, -y], "the list holds still, all the way out");
  });
  assert.equal(px(card.keyframes[0].transform)[1], was);
  assert.equal(px(card.keyframes.at(-1).transform)[1], want);
  // held on its first place until its first frame is drawn, as a tap's run is
  const asked = f.timeline.currentTime;
  assert.ok(run.every(a => a.startTime >= asked + 1000 && a.options.fill === "backwards"));
  f.frame(); f.frame();
  assert.ok(run.every(a => a.startTime === f.timeline.currentTime));
  assert.equal(f.body.classList.contains("listkeys"), true, "the stylesheet runs nothing of its own under it");
  assert.equal(f.drop(), want, "where the stylesheet stands it once the keyframes are gone");
  f.land(); await f.settle();
  assert.deepEqual(f.playing(), [], "it lands and stays");
  assert.ok(Math.abs(f.paperUnder() - FULL_PAPER) < 1e-9);
});

test("a ticket that goes, or another section named, glides it up or down the same way, to the whole room at most", async () => {
  const f = fixture();
  await f.open();
  const steps = [
    ["a ticket goes", () => f.rows("todo", 1), ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(1))],
    ["a full section", () => f.show("done"), ROOM],
    ["an empty one", () => f.show("docked"), ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(0))],
    ["back to one ticket", () => f.show("todo"), ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(1))],
  ];
  for (const [label, change, want] of steps) {
    const was = f.drop();
    change();
    await f.settle();
    const card = of(f, "pane", "transform");
    assert.ok(card, `${label}: a glide`);
    assert.equal(px(card.keyframes[0].transform)[1], was, `${label}: from where the card stands`);
    assert.equal(px(card.keyframes.at(-1).transform)[1], want, `${label}: to the section's drop`);
    f.frame(); f.frame(); f.land(); await f.settle();
    assert.equal(f.drop(), want);
    assert.ok(Math.abs(f.paperUnder() - FULL_PAPER) < 1e-9, label);
  }
});

test("a change while the list moves waits until it is at rest, then glides from there", async () => {
  const f = fixture();
  f.tap();
  const opening = f.playing();
  f.rows("todo", 4);
  await f.settle();
  assert.equal(f.playing().length, opening.length, "nothing new while the open run plays");
  f.frame(); f.frame(); f.land(); await f.settle();
  const card = of(f, "pane", "transform");
  assert.ok(card, "the glide once the list has come to rest");
  const was = ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(2));
  assert.equal(px(card.keyframes[0].transform)[1], was);
  assert.equal(px(card.keyframes.at(-1).transform)[1], was + 2 * (ROW + GAP));
  // and a section named during a glide waits for that glide to land
  f.frame(); f.frame();
  const glide = f.playing();
  f.show("done");
  await f.settle();
  assert.deepEqual(f.playing(), glide, "one glide at a time");
  f.land(); await f.settle();
  assert.equal(px(of(f, "pane", "transform").keyframes.at(-1).transform)[1], ROOM, "then on to the full section");
});

test("a close or a finger during a glide leaves from where the card stands", async () => {
  for (const by of ["tap", "finger"]) {
    const f = fixture();
    await f.open();
    const was = f.drop();
    f.rows("todo", 3);
    await f.settle();
    f.frame(); f.frame();
    const glide = f.playing();
    for (const a of glide) a.currentTime = 120;
    const shown = was + (ROW + GAP) * f.run("listSpring(0, 1, 0, " + (ROW + GAP) + ").at(120)");
    if (by === "tap") f.tap();
    else { f.point("touchstart", 300, 1000); f.point("touchmove", 280, 1010); }
    assert.ok(glide.every(a => a.playState === "idle"), `${by}: the glide stops`);
    assert.ok(Math.abs(f.drop() - shown) < .01, `${by}: the drop it reached is written (${f.drop()}, shown ${shown})`);
    if (by === "tap") {
      const card = of(f, "pane", "transform");
      assert.ok(Math.abs(px(card.keyframes[0].transform)[1] - shown) < .01, "the close leaves from where the card stands");
      assert.equal(px(card.keyframes.at(-1).transform)[1], 0);
    }
  }
});

test("reduced motion: the card goes to its new drop at once, with no keyframes", async () => {
  const f = fixture({ reduced: true });
  f.tap(); await f.settle();
  assert.deepEqual(f.played, []);
  const was = f.drop();
  f.rows("todo", 3);
  await f.settle();
  assert.deepEqual(f.played, [], "no glide is played");
  assert.equal(f.drop(), was + ROW + GAP, "the drop is written at once");
  assert.equal(f.body.classList.contains("listkeys"), false, "and the stylesheet, which reduced motion stills, has it");
});

test("a shut list does not move for a change; it opens onto the section's drop next time", async () => {
  const f = fixture();
  await f.open();
  await f.close();
  const shut = f.drop(), count = f.played.length;
  f.rows("todo", 5);
  f.show("docked");
  await f.settle();
  assert.equal(f.played.length, count, "nothing is played");
  assert.equal(f.drop(), shut, "nothing is written");
  f.tap();
  const card = of(f, "pane", "transform");
  assert.equal(px(card.keyframes.at(-1).transform)[1], ROOM - (Math.round(ROOM * SHARE) - HEAD + AIR - rowsHeight(0)));
});
