// The card list's run, played the way the browser would play it: the real menu
// script runs in a VM, and each moving part's transition is read out of the real
// stylesheet with the values the script wrote, then sampled over time. The curve
// is held against a reference app's jump to the latest message (its
// createGlide), ported below. No browser, layout, server or live board; this
// proves the curve the page asks for, not the frames a phone paints.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
// An old source copy can prove the regressions without changing the checkout.
const HTML = readFileSync(process.env.PHONE_EASE_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end) {
  const at = HTML.indexOf(start), to = HTML.indexOf(end, at + start.length);
  assert.ok(at >= 0 && to > at, `missing source between ${start} and ${end}`);
  return HTML.slice(at, to);
}
const MENUS = between('const page = document.getElementById("page");', "// the list's fades, the board's own");
const CSS = between("<style>", "</style>").replace(/\/\*[\s\S]*?\*\//g, "");

// ---- the stylesheet, read the way the existing drawer tests read it ------------
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
// a list's entries, split on the commas outside any brackets
function topLevel(list) {
  const out = [""];
  let depth = 0;
  for (const c of list) {
    if (c === "," && !depth) { out.push(""); continue; }
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    out[out.length - 1] += c;
  }
  return out.map(s => s.trim());
}
// var(), with fallbacks, the way a computed value substitutes it
function resolve(text, lookup) {
  let out = "";
  for (let i = 0; i < text.length;) {
    if (!text.startsWith("var(", i)) { out += text[i++]; continue; }
    let depth = 0, j = i + 3;
    for (; j < text.length; j++) if (text[j] === "(") depth++; else if (text[j] === ")" && --depth === 0) break;
    const [name, ...rest] = topLevel(text.slice(i + 4, j));
    const value = lookup(name);
    out += value ? resolve(value, lookup) : rest.length ? resolve(rest.join(", "), lookup) : "<invalid>";
    i = j + 1;
  }
  return out;
}
const ROOT = Object.fromEntries(["--drawer-ms", "--drawer-tap", "--drawer-drag"].map(name =>
  [name, CSS.match(new RegExp(name + ":([^;]+);"))[1].trim()]));

function bezier(x1, y1, x2, y2) {
  const at = (a, b, t) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return x => {
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 60; i++) { if (at(x1, x2, t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return at(y1, y2, t);
  };
}
function easing(text) {
  if (text === "linear") return x => x;
  let m = text.match(/^cubic-bezier\(([^)]*)\)$/);
  if (m) return bezier(...m[1].split(",").map(Number));
  m = text.match(/^linear\((.*)\)$/);
  assert.ok(m, "an easing this test can play: " + text);
  const stops = topLevel(m[1]).map(s => { const [y, x] = s.split(/\s+/); return { y: Number(y), x: x === undefined ? null : parseFloat(x) / 100 }; });
  if (stops[0].x === null) stops[0].x = 0;
  if (stops[stops.length - 1].x === null) stops[stops.length - 1].x = 1;
  assert.ok(stops.every(s => s.x !== null), "every stop of the curve says where it falls");
  return x => {
    if (x <= stops[0].x) return stops[0].y;
    for (let i = 1; i < stops.length; i++) if (x <= stops[i].x) {
      const a = stops[i - 1], b = stops[i];
      return b.x > a.x ? a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x) : b.y;
    }
    return stops[stops.length - 1].y;
  };
}

// ---- the reference app's glide, ported from its source --------------------------
const GLIDE_MAX_SPEED = 25, GLIDE_SPRING_SCREENS = 3.0, GLIDE_DAMPING_RATIO = 1.02;
const GLIDE_DT_MAX = 48, GLIDE_SNAP_SPEED = 0.05, GLIDE_VIEWPORT = 700;   // its own tests' chat height
function createGlide(startMs, maxSpeed = GLIDE_MAX_SPEED) {
  let lastMs = startMs, velocity = 0, landed = false;
  return {
    step(nowMs, remaining, viewportHeight) {
      const dt = Math.min(Math.max(nowMs - lastMs, 0), GLIDE_DT_MAX);
      lastMs = nowMs;
      if (landed) return 0;
      if (remaining <= 0 || (remaining <= 1 && velocity <= GLIDE_SNAP_SPEED)) { landed = true; return remaining; }
      const omega = maxSpeed / (GLIDE_SPRING_SCREENS * viewportHeight);
      const spread = Math.sqrt(GLIDE_DAMPING_RATIO * GLIDE_DAMPING_RATIO - 1);
      const fast = omega * (GLIDE_DAMPING_RATIO + spread), slow = omega * (GLIDE_DAMPING_RATIO - spread);
      const a = (velocity - slow * remaining) / (fast - slow), b = (fast * remaining - velocity) / (fast - slow);
      const decayFast = Math.exp(-fast * dt), decaySlow = Math.exp(-slow * dt);
      const springRemaining = a * decayFast + b * decaySlow;
      velocity = Math.min(fast * a * decayFast + slow * b * decaySlow, maxSpeed);
      const step = Math.min(remaining - springRemaining, maxSpeed * dt, remaining);
      if (step === remaining) landed = true;
      return step;
    },
    done: () => landed,
  };
}
// what the glide has left to go after each millisecond, from rest, over `px`
function glideLeft(px) {
  const g = createGlide(0), left = [px];
  let remaining = px;
  for (let ms = 1; !g.done() && ms < 5000; ms++) { remaining -= g.step(ms, remaining, GLIDE_VIEWPORT); left.push(remaining); }
  return left;
}

// ---- the page's menu script, in a VM ---------------------------------------------
const DROP = Math.round(800 * 0.55);   // the card's drop on an 800px page: the furthest any part goes
const TRAVEL = 300;                    // the list's travel across: offsetLeft 10 + offsetWidth 290

function fixture({ eased = true } = {}) {
  const log = [], nodes = {};
  const body = { clientHeight: 800 };
  function element(id) {
    const classes = new Set(), props = new Map(), handlers = {};
    const el = {
      id, dataset: {}, offsetLeft: 10, offsetWidth: 290, animations: [],
      classList: {
        add(...names) { names.forEach(n => classes.add(n)); },
        remove(...names) { names.forEach(n => classes.delete(n)); },
        contains: name => classes.has(name),
        toggle(name, on = !classes.has(name)) { if (on) classes.add(name); else classes.delete(name); return on; },
      },
      style: {
        setProperty(name, value) {
          props.set(name, value);
          log.push({ id, name, value, held: !!body.classList?.contains("listhold") });
        },
        getPropertyValue: name => props.get(name) || "",
      },
      setAttribute() {},
      addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
      fire(type, extra = {}) { for (const fn of handlers[type] || []) fn({ type, target: el, ...extra }); },
      getBoundingClientRect: () => ({ width: 289, left: 30, right: 360, top: 300, bottom: 800 }),
      getAnimations: () => el.animations,
      querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
    return el;
  }
  for (const id of ["page", "pane", "tickets", "tikwin", "settings", "scrim", "setpage", "setsrc", "tikbtn", "setbtn"])
    nodes[id] = element(id);
  nodes.tickets.dataset.side = "left";
  nodes.settings.dataset.side = "right";
  Object.assign(body, element("body"), { clientHeight: 800 });
  const document = element("document");
  Object.assign(document, { body, documentElement: element("html"), activeElement: null, getElementById: id => nodes[id] });
  // what the browser shows of the list right now; tests set it while a run plays
  let shown = null;
  const context = vm.createContext({
    document, innerWidth: 390, macHost: null, homeOpen: false, lastTicketTap: null, lastState: null,
    performance: { now: () => 0 },
    CSS: { supports: (property, value) => eased && /^linear\(/.test(value) },
    getComputedStyle: el => ({
      getPropertyValue: name => name === "--sink" ? ".015" : "none",
      opacity: el === nodes.tickets && shown !== null ? String(shown) : "1",
    }),
    addEventListener() {}, settingsPage: () => ({ reset() {} }),
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {},
    editing: () => false, closeProjects() {}, dropResponseScroll() {}, renderTickets() {},
  });
  vm.runInContext(MENUS, context);
  const fire = (type, x, t, y = 400) => {
    const point = { clientX: x, clientY: y }, ended = type === "touchend";
    document.fire(type, { timeStamp: t, button: 0, ...point, target: body, touches: ended ? [] : [point], changedTouches: [point] });
  };
  return {
    nodes, log, body, run: source => vm.runInContext(source, context),
    tap: () => nodes.tikbtn.fire("click"),
    show: v => { shown = v; },
    fire,
    // a finger that moves at a steady `speed` px/ms from x0, one reading every 10ms,
    // and lifts where it last was
    drag(x0, speed, ms, t0 = 1000) {
      fire("touchstart", x0, t0);
      for (let t = 10; t <= ms; t += 10) fire("touchmove", x0 + speed * t, t0 + t);
      fire("touchend", x0 + speed * ms, t0 + ms);
      return x0 + speed * ms;
    },
  };
}

// the run a part plays for `property`, as the browser would take it now: its
// transition from the stylesheet with the part's own values, and the fraction it
// leaves from and goes to, the part's last two writes of --list-v
function played(f, id, property) {
  const cls = f.body.classList;
  const held = cls.contains("menudrag") || cls.contains("listhold");
  const order = held ? [`body.menudrag #${id}`] : cls.contains("menurelease") ? [`body.menurelease #${id}`, `#${id}`] : [`#${id}`];
  const transition = order.map(s => rule(s).transition).find(Boolean);
  const entry = topLevel(transition).find(s => s.split(/\s+/)[0] === property);
  const fractions = f.log.filter(w => w.id === id && w.name === "--list-v").map(w => Number(w.value));
  const to = fractions[fractions.length - 1], from = fractions.length > 1 ? fractions[fractions.length - 2] : 0;
  if (!entry) return { untimed: true, from, to };
  const timing = resolve(entry.slice(property.length).trim(),
    name => f.nodes[id].style.getPropertyValue(name) || ROOT[name]);
  const m = timing.match(/^([\d.]+)(ms|s)\s+(.+)$/);
  assert.ok(m, `${id} ${property} has a length and a curve: ${timing}`);
  const ms = parseFloat(m[1]) * (m[2] === "s" ? 1000 : 1), ease = easing(m[3]);
  return { timing, ms, from, to, at: t => t >= ms ? to : from + (to - from) * ease(Math.max(0, t) / ms) };
}
const PARTS = [["pane", "transform"], ["tikwin", "transform"], ["tickets", "transform"], ["tickets", "opacity"], ["tickets", "--drawer-arrow-v"]];
// every part the list moves plays one run: one length, one curve, one start and end
function shared(f) {
  const runs = PARTS.map(([id, property]) => ({ id, property, ...played(f, id, property) }));
  for (const r of runs.slice(1)) {
    assert.equal(r.timing, runs[0].timing, `${r.id} ${r.property} rides the card's curve`);
    assert.equal(r.from, runs[0].from, `${r.id} leaves from the card's fraction`);
    assert.equal(r.to, runs[0].to, `${r.id} goes where the card goes`);
  }
  return runs[0];
}
// the speed of a run, fraction per ms, over [t, t + 1]
const rate = (run, t) => run.at(t + 1) - run.at(t);
// from half way in, the speed only falls until the reference's landing, the last
// step from under a pixel out (and the played curve's quarter pixel); and before
// that step it is down to a crawl
function settles(run, label) {
  let prev = Infinity, t = Math.floor(run.ms / 2);
  for (; t < run.ms; t++) {
    const speed = Math.abs(rate(run, t));
    if (speed > prev + 1e-9) break;
    prev = speed;
  }
  const out = Math.abs(run.to - run.at(t)) * DROP;
  assert.ok(out <= 1.25, `${label} speeds up only to land, from ${out.toFixed(2)}px out at ${t}ms`);
  assert.ok(prev * DROP <= 2 * GLIDE_SNAP_SPEED, `${label} crawls before it lands: ${(prev * DROP).toFixed(3)}px/ms`);
  return prev * DROP;
}

test("a tap opens and closes on the reference app's settling spring, every moving part on the one curve", t0 => {
  const f = fixture();
  for (const [to, label] of [[1, "open"], [0, "close"]]) {
    f.tap();
    const run = shared(f);
    assert.equal(run.from, 1 - to, label);
    assert.equal(run.to, to, label);
    // held against the reference in the card's own pixels, every millisecond
    const reference = glideLeft(DROP), end = Math.max(run.ms, reference.length - 1);
    for (let t = 0; t <= end; t++) {
      const left = Math.abs(to - run.at(t)) * DROP, want = reference[Math.min(t, reference.length - 1)];
      assert.ok(Math.abs(left - want) <= 1.25, `${label} at ${t}ms: ${left.toFixed(2)}px left, the reference ${want.toFixed(2)}px`);
    }
    // never past the end, and slowing all the way into it
    for (let t = 0; t <= run.ms; t++) assert.ok(run.at(t) >= 0 && run.at(t) <= 1, `${label} stays on its track at ${t}ms`);
    const crawl = settles(run, label);
    t0.diagnostic(`tap ${label}: ${run.ms}ms, ${(crawl).toFixed(3)}px/ms just before landing`);
    // the slowdown is the spring's: half way in 143ms, nine tenths in 336ms
    assert.ok(Math.abs(Math.abs(run.at(143) - (1 - to)) - .5) < .01, `${label} is half way at 143ms`);
    assert.ok(Math.abs(Math.abs(run.at(336) - (1 - to)) - .9) < .01, `${label} is nine tenths there at 336ms`);
  }
});

test("a release hands the finger's speed to the run with no jump and slows into place", t0 => {
  for (const [label, open, x0, speed, ms] of [
    ["opening flick", false, 8, 2, 50],
    ["closing flick", true, 300, -2, 60],
    ["fast flick near the end", false, 8, 3, 80],
    ["slow deliberate opening", false, 8, .3, 500],
  ]) {
    const f = fixture();
    if (open) f.tap();
    const x = f.drag(x0, speed, ms);
    const run = shared(f);
    const finger = (open ? 1 : 0) + (x - x0) / TRAVEL;
    assert.ok(Math.abs(run.from - finger) < 1e-4, `${label} leaves from where the finger let go`);
    const to = speed > 0 ? 1 : 0;
    assert.equal(run.to, to, label);
    // the first millisecond goes at the finger's speed, in the list's own pixels
    const start = rate(run, 0) * TRAVEL;
    assert.ok(Math.abs(start - speed) <= .05 * Math.abs(speed), `${label} leaves at ${start.toFixed(3)}px/ms, the finger at ${speed}`);
    // never past the end, and it lands slowing
    for (let t = 0; t <= run.ms; t++) {
      const v = run.at(t);
      assert.ok(to ? v <= 1 && v >= run.from - 1e-9 : v >= 0 && v <= run.from + 1e-9, `${label} stays between its ends at ${t}ms`);
    }
    const crawl = settles(run, label);
    t0.diagnostic(`${label}: from ${run.from.toFixed(3)} at ${start.toFixed(3)}px/ms (finger ${speed}), ` +
      `${run.ms}ms, ${crawl.toFixed(3)}px/ms just before landing`);
  }
});

test("a tap that turns a run round holds it where it is and carries its speed", () => {
  const f = fixture();
  f.tap();
  const opening = shared(f);
  // the browser is 120ms into the opening when the tap comes
  const t = 120, there = opening.at(t);
  f.nodes.tickets.animations = [{ transitionProperty: "opacity", currentTime: t }];
  f.show(there);
  const writes = f.log.length;
  f.tap();
  const hold = f.log.slice(writes).filter(w => w.name === "--list-v");
  assert.deepEqual(hold.map(w => [w.id, w.held]), [
    ["pane", true], ["tickets", true], ["tikwin", true], ["pane", false], ["tickets", false], ["tikwin", false],
  ], "the three parts are held at the place shown, with no run, before the run back starts");
  for (const w of hold.slice(0, 3)) assert.ok(Math.abs(Number(w.value) - there) < 1e-4, "held where it is shown");
  assert.equal(f.body.classList.contains("listhold"), false);
  // the hold takes the parts' runs away, so the browser cancels the opening rather
  // than shortening a reversal of it
  for (const id of ["pane", "tikwin", "tickets"]) {
    const timed = topLevel(rule(`body.listhold #${id}`).transition || "").map(s => s.split(/\s+/)[0]);
    assert.ok(!timed.some(p => p === "transform" || p === "opacity" || p === "--drawer-arrow-v"), `${id} is untimed while held`);
  }
  const closing = shared(f);
  assert.ok(Math.abs(closing.from - there) < 1e-4);
  assert.equal(closing.to, 0);
  // it leaves at the speed the opening had, still going out for a moment
  const had = (opening.at(t + 2) - opening.at(t - 2)) / 4, leaves = rate(closing, 0);
  assert.ok(had > 0 && Math.abs(leaves - had) <= .1 * had, `turned round at ${leaves.toFixed(5)}/ms, the run had ${had.toFixed(5)}/ms`);
  for (let s = 0; s <= closing.ms; s++) assert.ok(closing.at(s) >= 0 && closing.at(s) <= 1, `on its track at ${s}ms`);
  assert.equal(closing.at(closing.ms), 0);
});

test("reduced motion keeps its jumps: no run plays, so a second tap goes straight to its end", () => {
  // the sheet still takes every transition away under reduced motion, and nothing
  // the list moves by puts one back
  assert.match(CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\*,\s*\*::before,\s*\*::after\s*\{[^}]*transition:none !important/);
  for (const [, selectors, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    if (/#pane|#tikwin|#tickets/.test(selectors)) assert.doesNotMatch(body, /transition[^;]*!important/, selectors);
  // with transitions off the browser reports no run playing, so a tap made at once
  // after another writes only its end: no hold, no place in between
  const f = fixture();
  f.tap();
  const writes = f.log.length;
  f.tap();
  const after = f.log.slice(writes).filter(w => w.name === "--list-v");
  assert.deepEqual(after.map(w => [w.id, w.value, w.held]), [["pane", "0", false], ["tickets", "0", false], ["tikwin", "0", false]]);
  assert.equal(f.body.classList.contains("listhold"), false);
});

test("a drag still follows the finger exactly, untimed", () => {
  const f = fixture();
  f.fire("touchstart", 8, 1000);
  for (const [x, t] of [[38, 1100], [128, 1200], [98, 1300]]) {
    f.fire("touchmove", x, t);
    for (const [id, property] of PARTS) {
      const run = played(f, id, property);
      assert.equal(run.untimed, true, `${id} ${property} is not timed under the finger`);
      assert.ok(Math.abs(run.to - (x - 8) / TRAVEL) < 1e-4, `${id} is where the finger is`);
    }
  }
});

test("a browser without linear() curves keeps the menus' own curves", () => {
  const f = fixture({ eased: false });
  f.tap();
  assert.equal(shared(f).timing, `${ROOT["--drawer-ms"]} ${ROOT["--drawer-tap"]}`);
  f.drag(300, -2, 60);
  assert.equal(shared(f).timing, `${ROOT["--drawer-ms"]} ${ROOT["--drawer-drag"]}`);
});
