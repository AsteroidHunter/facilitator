// The card list's run stays smooth while the page is busy. The real menu script
// runs in a VM against stand-in parts whose animate() records what the script
// asks for, and the real reading scheduler runs against a stand-in clock. On the
// iOS Simulator a linear() curve on a transition was played by the page
// frame by frame: a page busy for 150ms held the card still for 150ms and then
// jumped it 190px, where keyframes kept moving. So a run from rest is played as
// keyframes; a release or a turn keeps the curve, since starting keyframes under
// a moving finger measured worse. No browser, layout or server here; this proves
// what the page asks for, not the frames a phone paints.
// PHONE_SMOOTH_SOURCE runs the same checks on an old copy of m.html.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const HTML = readFileSync(process.env.PHONE_SMOOTH_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end) {
  const at = HTML.indexOf(start), to = HTML.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `missing source between ${start} and ${end}`);
  return HTML.slice(at, to);
}
const MENUS = between('const page = document.getElementById("page");', "// the list's fades, the board's own");
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
const DROP = Math.round(800 * 0.55), TRAVEL = 300;
const PARTS = ["pane", "tikwin", "tickets"];

function fixture({ reduced = false } = {}) {
  const log = [], nodes = {}, played = [], frames = [], clock = { now: 0 };
  const body = { clientHeight: 800 };
  function element(id) {
    const classes = new Set(), props = new Map(), handlers = {};
    const el = {
      id, dataset: {}, offsetLeft: 10, offsetWidth: 290,
      classList: {
        add(...names) { names.forEach(n => classes.add(n)); },
        remove(...names) { names.forEach(n => classes.delete(n)); },
        contains: name => classes.has(name),
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
      },
      style: {
        setProperty(name, value) { props.set(name, value); log.push({ id, name, value }); },
        getPropertyValue: name => props.get(name) || "",
      },
      setAttribute() {},
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, extra = {}) { for (const fn of handlers[type] || []) fn({ type, target: el, ...extra }); },
      getBoundingClientRect: () => ({ width: 289, left: 30, right: 360, top: 300, bottom: 800 }),
      getAnimations: () => played.filter(a => a.el === el && a.playState === "running"),
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
      // an animation as element.animate() hands it back, as far as the script reads one
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
  for (const id of ["page", "pane", "tickets", "tikwin", "settings", "scrim", "setpage", "setsrc", "tikbtn", "setbtn", "tik-page-back", "tik-page"]) nodes[id] = element(id);
  nodes.tickets.dataset.side = "left";
  nodes.settings.dataset.side = "right";
  Object.assign(body, element("body"), { clientHeight: 800 });
  const timeline = { currentTime: 5000 };
  const document = element("document");
  Object.assign(document, { body, documentElement: element("html"), activeElement: null, getElementById: id => nodes[id], timeline });
  const context = vm.createContext({
    document, innerWidth: 390, macHost: null, homeOpen: false, lastTicketTap: null, lastState: null,
    performance: { now: () => clock.now },
    CSS: { supports: (property, value) => /^linear\(/.test(value) },
    matchMedia: query => ({ matches: reduced && /prefers-reduced-motion:\s*reduce/.test(query) }),
    requestAnimationFrame: fn => frames.push(fn),
    getComputedStyle: () => ({ getPropertyValue: name => name === "--sink" ? ".015" : "none", opacity: "1" }),
    addEventListener() {}, settingsPage: () => ({ reset() {} }),
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {},
    editing: () => false, closeProjects() {}, dropResponseScroll() {}, renderTickets() {},
  });
  vm.runInContext(MENUS, context);
  const fire = (type, x, t) => {
    const point = { clientX: x, clientY: 400 }, ended = type === "touchend";
    document.fire(type, { timeStamp: t, button: 0, ...point, target: body, touches: ended ? [] : [point], changedTouches: [point] });
  };
  const f = {
    nodes, log, body, played, timeline, fire, run: source => vm.runInContext(source, context),
    tap: () => nodes.tikbtn.fire("click"),
    // the browser's next frame: its requestAnimationFrame callbacks, `ms` later
    frame(ms = 16) { clock.now += ms; timeline.currentTime += ms; for (const fn of frames.splice(0)) fn(timeline.currentTime); },
    wait(ms) { clock.now += ms; timeline.currentTime += ms; },
    // the stylesheet's own run of a part, as written for it
    curve: id => f.nodes[id].style.getPropertyValue("--drawer-run-ease"),
    land() { for (const a of played) a.land(); },
    // the runs now playing, one per part and property
    playing: () => played.filter(a => a.playState === "running"),
    drag(x0, speed, ms, t0 = 1000) {
      fire("touchstart", x0, t0);
      for (let t = 10; t <= ms; t += 10) fire("touchmove", x0 + speed * t, t0 + t);
      fire("touchend", x0 + speed * ms, t0 + ms);
    },
  };
  return f;
}
const of = (f, id, property) => f.playing().find(a => a.el === f.nodes[id] && property in a.keyframes[0]);

// ---- 1. the spring is handed to the graphics system ------------------------------
test("a tap plays the list's run as keyframes, with straight lines between, on every part it moves", () => {
  const f = fixture();
  f.tap();
  const runs = [["pane", "transform"], ["tikwin", "transform"], ["tickets", "transform"], ["tickets", "opacity"], ["tik-page-back", "--list-v"], ["tik-page", "--list-v"]]
    .map(([id, property]) => ({ id, property, a: of(f, id, property) }));
  for (const { id, property, a } of runs) {
    assert.ok(a, `${id} ${property} is played as keyframes`);
    assert.equal(a.options.easing, "linear", `${id} ${property}: straight lines between the spring's points`);
    assert.equal(a.options.id, "list-run");
    assert.equal(a.options.duration, runs[0].a.options.duration, `${id} ${property} is as long as the card's run`);
    assert.deepEqual(a.keyframes.map(k => k.offset), runs[0].a.keyframes.map(k => k.offset), `${id} ${property} passes the card's points`);
  }
  assert.ok(runs[0].a.keyframes.length > 8, "the spring's points, not a straight line");
  // and while they play the stylesheet runs nothing of its own on these parts
  // that the page would have to play itself
  assert.equal(f.body.classList.contains("listkeys"), true);
  for (const id of PARTS) {
    const timed = (rule(`body.listkeys #${id}`).transition || "").split(",").map(s => s.trim().split(/\s+/)[0]);
    assert.ok(!timed.some(p => p === "transform" || p === "opacity"), `${id} takes no transition of its own: ${timed}`);
  }
});

test("the keyframes are the spring's places: the card, the window and the list on one fraction", () => {
  const f = fixture();
  f.tap();
  const card = of(f, "pane", "transform"), win = of(f, "tikwin", "transform");
  const list = of(f, "tickets", "transform"), fade = of(f, "tickets", "opacity"), arrows = of(f, "tik-page", "--list-v");
  const px = value => String(value).match(/-?[\d.]+(?=px)/g).map(Number);
  card.keyframes.forEach((k, i) => {
    const v = px(k.transform)[1] / DROP;
    assert.ok(Math.abs(px(win.keyframes[i].transform)[1] / DROP - v) < 1e-5, "the window goes down with the card");
    const [x, y] = px(list.keyframes[i].transform);
    assert.ok(Math.abs(-y / DROP - v) < 1e-5 && Math.abs(x - (v - 1) * TRAVEL) < 1e-2, "the list rises in the window and comes in across its travel");
    assert.ok(Math.abs(Number(arrows.keyframes[i]["--list-v"]) - v) < 1e-5, "the arrows fade on the same fraction");
    assert.ok(Math.abs(fade.keyframes[i].opacity - Math.min(v, .999)) < 1e-5, "the list fades on the same fraction");
  });
  assert.ok(Math.abs(px(card.keyframes[0].transform)[1]) < 1e-9 && Math.abs(px(card.keyframes.at(-1).transform)[1] - DROP) < 1e-9);
  // the run ends where the stylesheet stands it once the keyframes are gone
  for (const id of PARTS) assert.equal(f.nodes[id].style.getPropertyValue("--list-v"), "1.0000");
});

test("a finger on the list or Home stops the run in flight; landing stops nothing", () => {
  const f = fixture();
  f.tap();
  const opening = f.playing();
  assert.equal(opening.length, 5);
  // a finger on the moving list takes it over where it is
  f.fire("touchstart", 300, 1000);
  f.fire("touchmove", 280, 1010);
  assert.ok(opening.every(a => a.playState === "idle"), "the finger stops the run");
  assert.equal(f.body.classList.contains("menudrag"), true);
  f.fire("touchend", 280, 1020);
  f.wait(1000);
  // Home takes the list away at once, run and all
  f.tap();
  const run = f.playing();
  assert.equal(run.length, 5, "a tap from rest plays keyframes");
  f.run("homeOpen = true; syncMenuAvailability()");
  assert.ok(run.every(a => a.playState === "idle"), "Home stops the run");
  assert.deepEqual(f.playing(), []);
  // a run that lands is finished, not stopped
  f.run("homeOpen = false");
  f.tap();
  const again = f.playing();
  f.land();
  assert.ok(again.every(a => a.playState === "finished"));
});

test("reduced motion plays no keyframes, which the stylesheet's own rule cannot reach", () => {
  const f = fixture({ reduced: true });
  f.tap();
  f.drag(300, -2, 60);
  assert.deepEqual(f.played, []);
});

// ---- 2. a run from rest waits for its first frame -------------------------------
test("a run from rest holds its first place until its first frame has been drawn, then starts", () => {
  for (const label of ["open", "close"]) {
    const f = fixture();
    if (label === "close") { f.tap(); f.frame(); f.frame(); f.land(); }
    f.tap();
    const run = f.playing();
    assert.equal(run.length, 5, label);
    const asked = f.timeline.currentTime;
    // held: a start far ahead, while the keyframes stand on their first place
    for (const a of run) {
      assert.ok(a.startTime >= asked + 1000, `${label}: the run waits rather than starting under its first frame`);
      assert.equal(a.options.fill, "backwards", `${label}: while it waits the parts stand on its first place`);
    }
    f.frame();   // the frame that shows the list, or builds its fade
    assert.ok(run.every(a => a.startTime >= asked + 1000), `${label}: still waiting through that frame`);
    f.frame();   // the next: the run starts on it
    for (const a of run) assert.equal(a.startTime, f.timeline.currentTime, `${label}: starts on the frame after`);
  }
});

test("a release and a run turned round are already moving: they keep the curve and start at once", () => {
  // starting keyframes costs the graphics system a frame or two, which a
  // moving run cannot wait out (on the Simulator a release held still for 70
  // to 100ms with keyframes, then jumped), so these stay on the stylesheet's curve
  const f = fixture();
  f.drag(8, 2, 50);
  assert.deepEqual(f.playing(), [], "a release plays no keyframes");
  assert.equal(f.body.classList.contains("listkeys"), false, "the stylesheet plays it");
  for (const id of PARTS) assert.match(f.curve(id), /^linear\(/, `${id} runs on the spring's curve`);
  f.wait(1000);
  f.tap();
  f.frame(); f.frame();
  const opening = f.playing();
  for (const a of opening) a.currentTime = 120;
  f.tap();
  assert.ok(opening.every(a => a.playState === "idle"), "the turn stops the keyframes where they are");
  assert.deepEqual(f.playing(), [], "and plays the run back on the curve");
  assert.equal(f.body.classList.contains("listkeys"), false);
  for (const id of PARTS) assert.match(f.curve(id), /^linear\(/);
});

test("a run's fade stops a thousandth short of whole, so a close's fade is built in its held frame", () => {
  const f = fixture();
  f.tap(); f.frame(); f.frame(); f.land();
  f.tap();
  const fade = of(f, "tickets", "opacity");
  assert.equal(fade.keyframes[0].opacity, .999, "a close leaves its held frame already fading");
  assert.ok(fade.keyframes.every(k => k.opacity <= .999));
  assert.equal(fade.keyframes.at(-1).opacity, 0);
  // at rest the list is whole: the stylesheet's own opacity is the fraction
  assert.equal(rule("#tickets").opacity, "var(--list-v)");
});

test("the list leaves the screen after a held close lands, not before", () => {
  const f = fixture();
  f.tap(); f.land();
  f.tap();
  const ms = of(f, "pane", "transform").options.duration;
  const wait = parseFloat(f.nodes.tickets.style.getPropertyValue("--drawer-run-ms"));
  assert.ok(wait >= ms + 100, `the list waits ${wait}ms for a ${ms}ms run that is held for its first frame`);
  assert.match(rule("#tickets")["--menuwait"] || CSS.match(/--menuwait:([^;]+);/)[1], /--drawer-run-ms/);
});

// ---- 3. the arrows' own fade restyles the arrows alone -------------------------
test("the arrows fade on a fraction of their own, which no ticket inherits, on the drawer's clock", () => {
  // nothing the list moves by is inherited: each change would restyle every ticket
  for (const [, name, body] of CSS.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g))
    if (/^--(list-v|drawer-run-ms|drawer-run-ease)$/.test(name)) assert.match(body, /inherits:\s*false/, `${name} is not inherited`);
  assert.doesNotMatch(CSS, /--drawer-arrow-v/, "no inherited arrow value is left");
  // the arrows' strength is their own fraction, the disabled one a share of it
  assert.equal(rule("#tickets #tikhead .tik-page").opacity, "var(--list-v)");
  assert.equal(rule('#tickets #tikhead .tik-page[aria-disabled="true"]').opacity, "calc(var(--list-v) * var(--chipoff))");
  // run on the fraction (so a page change cannot retime the disabled strength)
  // and on the list's own clock, untimed under a finger, a hold or keyframes
  const clock = sel => (rule(sel).transition || "").replace(/^--list-v\s+/, "");
  const listClock = sel => (rule(sel).transition || "").split(/,\s*(?=[a-z-]+ )/).find(t => t.startsWith("opacity ")).replace(/^opacity\s+/, "");
  assert.match(rule("#tickets #tikhead .tik-page").transition, /^--list-v /);
  assert.equal(clock("#tickets #tikhead .tik-page"), listClock("#tickets"));
  assert.equal(clock("body.menurelease #tickets #tikhead .tik-page"), listClock("body.menurelease #tickets"));
  for (const mode of ["listhold", "menudrag", "listkeys"]) assert.equal(rule(`body.${mode} #tickets #tikhead .tik-page`).transition, "none");
  // the script writes the drawer's fraction on both arrows with the parts it moves
  const f = fixture();
  f.fire("touchstart", 6, 1000);
  f.fire("touchmove", 96, 1010);
  for (const id of ["tik-page-back", "tik-page"])
    assert.equal(f.nodes[id].style.getPropertyValue("--list-v"), f.nodes.tickets.style.getPropertyValue("--list-v"), `${id} under the finger`);
  f.fire("touchend", 96, 1020);
  for (const id of ["tik-page-back", "tik-page"]) {
    assert.equal(f.nodes[id].style.getPropertyValue("--drawer-run-ease"), f.nodes.tickets.style.getPropertyValue("--drawer-run-ease"), `${id} on the release's curve`);
    assert.equal(f.nodes[id].style.getPropertyValue("--drawer-run-ms"), f.nodes.tickets.style.getPropertyValue("--drawer-run-ms"));
  }
});

// ---- 4. readings wait for the list --------------------------------------------
test("the list counts as moving under a finger and on its run, and not once it lands", () => {
  const f = fixture();
  assert.equal(f.run("listMoving()"), false);
  f.tap();
  assert.equal(f.run("listMoving()"), true, "on its run, held first frame included");
  f.frame(); f.frame();
  assert.equal(f.run("listMoving()"), true);
  f.land();
  assert.equal(f.run("listMoving()"), false, "landed");
  f.fire("touchstart", 300, 1000);
  f.fire("touchmove", 270, 1010);
  assert.equal(f.run("listMoving()"), true, "under a finger");
  f.fire("touchend", 270, 1020);
  // the release runs on the stylesheet's curve, as long as its run
  const ms = parseFloat(f.nodes.tickets.style.getPropertyValue("--drawer-run-ms"));
  assert.equal(f.run("listMoving()"), true, "on the release's run");
  f.wait(ms - 1);
  assert.equal(f.run("listMoving()"), true);
  f.wait(2);
  assert.equal(f.run("listMoving()"), false, "landed");
});

test("a reading that falls due while the list moves waits, and is read once it has landed", () => {
  const schedule = HTML.match(/function schedulePoll\(ms\)\{[\s\S]*?\n\}/)[0];
  const wait = HTML.match(/const RUN_WAIT_MS = \d+;/)[0];
  const timers = [], reads = [];
  let moving = true;
  const context = vm.createContext({
    document: { hidden: false },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    cardsMoving: () => false, listMoving: () => moving, poll: () => reads.push("read"),
  });
  vm.runInContext(`let pollTimer = null;\n${wait}\n${schedule}`, context);
  vm.runInContext("schedulePoll(1200)", context);
  timers.shift().fn();
  assert.deepEqual(reads, [], "no reading while the list moves");
  assert.equal(timers.length, 1, "it is put off, not dropped");
  assert.equal(timers[0].ms, vm.runInContext("RUN_WAIT_MS", context));
  timers.shift().fn();
  assert.deepEqual(reads, [], "still moving, still waiting");
  moving = false;
  timers.shift().fn();
  assert.deepEqual(reads, ["read"], "read once the list has landed");
});
