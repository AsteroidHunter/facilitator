// A send whose saved words are not the typed ones (the board's "Replace curse
// words" switch): the reading that brings the saved words lands while the
// bubble is in the air, or after it has landed, and the bubble changes to them
// at that moment, gently. Its edges ease from the box it had to the box it has
// now on one curve over a fifth of a second, and its words go over from one
// copy to the other on the same run, at Mac size and at phone size. Every
// frame at 60 a second is checked against the same flight with nothing
// swapped: no edge may move more than EDGE_LIMIT further than that flight's
// between two frames. The same reading taken the way the page took it before
// (the seat simply moved under the flight) moves an edge about 12px in one
// frame, and the same check catches it. Boxes are synthetic viewport
// rectangles laid out by hand; no layout engine and no browser runs, so
// nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const { drawn, running, numbers } = require("./sent-flight-drawn.cjs");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");
const FLIGHT_MS = 650;
const SWAP_MS = 200;
const EDGE_LIMIT = 4;    // px between two frames at 60 a second, against the flight with nothing swapped
const FRAME = 1000 / 60;
const READ_MS = 100 / 3; // the reading lands two frames into the flight, as the Mac's does (about 35ms)

function bezier([x1, y1, x2, y2]) {
  const at = (a, b, t) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  return f => {
    if (f <= 0) return 0;
    if (f >= 1) return 1;
    let lo = 0, hi = 1, t = f;
    for (let i = 0; i < 40; i++) {
      const x = at(x1, x2, t);
      if (Math.abs(x - f) < 1e-7) break;
      if (x < f) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return at(y1, y2, t);
  };
}
const SWAP = bezier([0.3, 0, 0.7, 1]);

// the two surfaces: the typing row, the bubble the typed words fill, and the
// bubble the saved words fill, which is wider by what [expletive] takes over
// the word it replaced and stands on the same right edge
const SURFACES = {
  mac: { field: { left: 560, top: 795, width: 366, height: 44 }, typed: { size: 15, line: 22.5, padLeft: 12, padTop: 10 },
    words: { size: 15, line: 22 }, round: 18,
    typedBox: { left: 773.2, top: 712.6, width: 153, height: 56 }, savedBox: { left: 747.8, top: 712.6, width: 178.4, height: 56 } },
  phone: { field: { left: 17.5, top: 726.7, width: 317.6, height: 43.3 }, typed: { size: 16.7, line: 25.1, padLeft: 3.9, padTop: 7.9 },
    words: { size: 14.8, line: 21 }, round: 17.73,
    typedBox: { left: 209.3, top: 649.2, width: 150.7, height: 52.5 }, savedBox: { left: 184.3, top: 649.2, width: 175.7, height: 52.5 } },
};

// ---- a stand-in dom, just enough for the flight and the bubble ----------------------
const kebab = name => name.startsWith("--") ? name : name.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
function inline() {
  const props = {}, prio = {};
  const api = {
    setProperty(name, value, priority = "") { props[kebab(name)] = String(value); prio[kebab(name)] = priority; },
    getPropertyValue(name) { return props[kebab(name)] || ""; },
    getPropertyPriority(name) { return prio[kebab(name)] || ""; },
    removeProperty(name) { delete props[kebab(name)]; delete prio[kebab(name)]; },
  };
  return new Proxy(api, {
    get: (target, key) => key in target ? target[key] : props[kebab(String(key))] || "",
    set: (target, key, value) => { props[kebab(String(key))] = String(value); return true; },
  });
}
function selects(node, selector) {
  return selector.split(",").map(s => s.trim()).some(one =>
    one === "*" || (one.startsWith(".") ? node.classes.has(one.slice(1)) : node.tagName === one.toUpperCase()));
}
// each scene its own page, so a flight with nothing swapped can fly beside
// one with the swap, frame for frame
function page() {
const DOC = { body: null };
function element(tag = "div", cls = "") {
  const node = {
    tagName: tag.toUpperCase(), classes: new Set(cls.split(/\s+/).filter(Boolean)),
    style: inline(), dataset: {}, attrs: {}, children: [], parentElement: null,
    layout: null, offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollLeft: 0,
    value: "", textContent: "", transform: "none", radius: 0, fill: "",
    font: 0, line: 21, padLeft: 0, padTop: 0, ink: "1", animations: [],
    get className() { return [...node.classes].join(" "); },
    set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
    classList: {
      add: (...names) => names.forEach(n => node.classes.add(n)),
      remove: (...names) => names.forEach(n => node.classes.delete(n)),
      contains: name => node.classes.has(name),
      toggle: (name, on) => ((on === undefined ? !node.classes.has(name) : on) ? node.classes.add(name) : node.classes.delete(name), node.classes.has(name)),
    },
    get isConnected() { let at = node; while (at.parentElement) at = at.parentElement; return at === DOC.body; },
    getBoundingClientRect() {
      const r = node.layout || { left: 0, top: 0, width: 0, height: 0 };
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    },
    setAttribute: (name, value) => { node.attrs[name] = String(value); },
    getAttribute: name => name in node.attrs ? node.attrs[name] : null,
    removeAttribute: name => { delete node.attrs[name]; },
    appendChild(child) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
    append: (...kids) => kids.forEach(kid => node.appendChild(kid)),
    remove() {
      const parent = node.parentElement;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(node), 1);
      node.parentElement = null;
    },
    querySelectorAll(selector) {
      const out = [];
      const walk = at => at.children.forEach(kid => { if (selects(kid, selector)) out.push(kid); walk(kid); });
      walk(node);
      return out;
    },
    querySelector: selector => node.querySelectorAll(selector)[0] || null,
    cloneNode(deep) {
      const copy = element(tag, node.className);
      copy.textContent = node.textContent;
      if (deep) node.children.forEach(kid => copy.appendChild(kid.cloneNode(true)));
      return copy;
    },
    animate(keys, options) {
      const run = { keys, options, cancelled: false, finished: false, playState: "running",
        cancel() { run.cancelled = true; run.playState = "idle"; },
        finish() { run.finished = true; } };
      node.animations.push(run);
      return run;
    },
  };
  return node;
}
return { DOC, element };
}
function box(node, r) {
  node.layout = r;
  node.offsetWidth = Math.round(r.width);
  node.offsetHeight = Math.round(r.height);
}

// a card with a typing row and a seat, on a surface
function scene(surface) {
  const { DOC, element } = page();
  DOC.body = element("body");
  const clock = { now: 0 };
  const frames = [];
  const context = vm.createContext({
    console,
    navigator: { userAgentData: { brands: [] } },
    document: { body: DOC.body, createElement: tag => element(tag) },
    performance: { now: () => clock.now },
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: node => ({
      visibility: "visible", display: "block", transform: node.transform, opacity: node.ink,
      fontSize: node.font ? node.font + "px" : "", lineHeight: node.line + "px",
      paddingLeft: node.padLeft + "px", paddingTop: node.padTop + "px",
      backgroundColor: node.fill || "rgba(0, 0, 0, 0)",
      width: node.layout ? node.layout.width + "px" : "", height: node.layout ? node.layout.height + "px" : "",
      borderTopLeftRadius: node.radius + "px", borderTopRightRadius: node.radius + "px",
      borderBottomRightRadius: node.radius + "px", borderBottomLeftRadius: node.radius + "px",
      getPropertyValue: name => name === "--card" ? "#ffffff" : name === "--bubble-fill" ? " #F3F3F3" : "",
    }),
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const card = element("div", "box");
  DOC.body.appendChild(card);
  const ta = element("textarea");
  card.appendChild(ta);
  box(ta, surface.field);
  Object.assign(ta, { font: surface.typed.size, line: surface.typed.line, padLeft: surface.typed.padLeft, padTop: surface.typed.padTop });
  ta.value = "that is so fucked";
  const sentwrap = element("div", "sentwrap");
  card.appendChild(sentwrap);
  const el = { box: card, ta, sent: null, sentwrap, answwrap: null, reply: null };
  // the bubble the page draws for the send, with its one row, laid out on r
  const bubble = (r, text) => {
    const p = element("div", "answered sent");
    p.radius = surface.round;
    p.fill = "rgb(243, 243, 243)";
    const clip = element("div", "answclip");
    const stack = element("div", "answstack");
    p.append(clip);
    clip.appendChild(stack);
    const row = element("div", "answmsg cardmd");
    Object.assign(row, { font: surface.words.size, line: surface.words.line });
    row.dataset.op = "op-1";
    row.dataset.text = text;
    const block = element("p");
    block.textContent = text;
    row.appendChild(block);
    stack.appendChild(row);
    sentwrap.appendChild(p);
    p.sentMsgs = [{ text, op: "op-1", stage: "sent" }];
    el.sent = p;
    lay(p, r);
    return p;
  };
  const lay = (p, r) => {
    box(p, r);
    box(p.querySelector(".answmsg"), { left: r.left + 18, top: r.top + 17, width: r.width - 36, height: surface.words.line });
  };
  const frame = ms => {
    clock.now = ms;
    for (const fn of frames.splice(0)) fn(ms);
  };
  const shell = () => DOC.body.children.find(n => n.classes.has("sentmorph")) || null;
  return { context, clock, el, bubble, lay, frame, shell };
}

// the browser's clock on every animation the flight is running, as the page
// reads it: the stand-in's animations keep whatever time they were last given
function clockAt(s, ms) {
  for (const node of s.shell().querySelectorAll("*")) for (const run of node.animations) if (!run.cancelled) run.currentTime = ms;
}
// a send flown to the typed words' bubble; `reading` is what happens at READ_MS
function fly(surface, reading) {
  const s = scene(surface);
  const motion = s.context.armSentMotion(s.el);
  assert.ok(motion, "the send must fly");
  const p = s.bubble(surface.typedBox, "that is so fucked");
  motion.play();
  // the frames drawn before the reading, as they were drawn: a flight handed
  // over again writes its past again too
  const seen = [];
  for (const ms of [FRAME, READ_MS]) {
    s.frame(ms);
    seen.push({ ms, edges: edgesAt(s, ms) });
  }
  clockAt(s, READ_MS);
  if (reading) reading(s, p);
  return { ...s, motion, p, seen };
}
// the board's reading with the saved words, as syncSent takes it: what the
// bubble shows is read before its rows are drawn again, and the change is made
// after
function saved(s, p, surface, gentle = true) {
  p.sentMsgs = [{ text: "that is so [expletive]", op: "op-1", stage: "sent" }];
  const was = gentle ? s.context.sentRewording(s.el, p) : null;
  const row = p.querySelector(".answmsg");
  row.dataset.text = "that is so [expletive]";
  row.querySelector("p").textContent = "that is so [expletive]";
  s.lay(p, surface.savedBox);
  if (was) s.context.sentReword(s.el, p, was);
  return was;
}
const edgesAt = (s, ms) => {
  const d = drawn(s.shell(), ms);
  return { l: d.left, t: d.top, r: d.right, b: d.bottom };
};
// the largest move of any edge between two frames, against the flight with
// nothing swapped, every frame from the first to the landing, each read as it
// is drawn
function largestStep(s, plain, end) {
  let worst = 0, at = null, prev = null;
  const frames = [...s.seen];
  for (let ms = READ_MS + FRAME; ms <= end + 1e-9; ms += FRAME) {
    s.frame(ms);
    frames.push({ ms, edges: edgesAt(s, ms) });
  }
  for (const { ms, edges: a } of frames) {
    const b = edgesAt(plain, ms);
    const d = Object.fromEntries(Object.keys(a).map(k => [k, a[k] - b[k]]));
    if (prev) for (const k of Object.keys(d)) {
      const step = Math.abs(d[k] - prev[k]);
      if (step > worst) { worst = step; at = { ms: Math.round(ms * 10) / 10, edge: k }; }
    }
    prev = d;
  }
  return { worst, at };
}

for (const [name, surface] of Object.entries(SURFACES)) {
  test(`${name}: saved words read in the air change the bubble with no edge moving more than ${EDGE_LIMIT}px between frames`, t => {
    const s = fly(surface, (one, p) => saved(one, p, surface));
    const plain = fly(surface);
    const { worst, at } = largestStep(s, plain, FLIGHT_MS);
    t.diagnostic(`largest move of an edge in one frame against the plain flight: ${worst.toFixed(2)}px at ${JSON.stringify(at)}`);
    assert.ok(worst <= EDGE_LIMIT, `an edge moved ${worst.toFixed(2)}px in one frame at ${JSON.stringify(at)}`);
    // and it lands on the bubble the saved words fill
    const end = edgesAt(s, FLIGHT_MS), want = surface.savedBox;
    for (const [k, v] of [["l", want.left], ["t", want.top], ["r", want.left + want.width], ["b", want.top + want.height]])
      assert.ok(Math.abs(end[k] - v) <= 0.5, `the landing's ${k} is ${end[k]}, not the saved words' ${v}`);
  });

  test(`${name}: the same reading taken the old way, the seat moved under the flight, moves an edge more than ${EDGE_LIMIT}px in one frame`, t => {
    // the check has teeth: before the swap was eased, the flight met the
    // wider bubble on the frame after the reading, all at once
    const s = fly(surface, (one, p) => saved(one, p, surface, false));
    const plain = fly(surface);
    const { worst, at } = largestStep(s, plain, FLIGHT_MS);
    t.diagnostic(`the old way: ${worst.toFixed(2)}px in one frame at ${JSON.stringify(at)}`);
    assert.ok(worst > 10, `the old way moved an edge only ${worst.toFixed(2)}px in one frame`);
  });

  test(`${name}: in the air, the saved words' copy is laid over the typed one and the two fade over on the swap's run, on the flight's clock`, () => {
    const s = fly(surface, (one, p) => saved(one, p, surface));
    const copies = s.shell().querySelector(".sentmorph-target").children;
    assert.equal(copies.length, 2, "the saved words' copy is not laid over the typed one");
    assert.equal(copies[1].style.position, "absolute", "the saved words' copy does not stand on the typed one's origin");
    // the stand-in lays out no text, so the copies fade over whole: the typed
    // words out, the saved ones in, on the swap's curve and length, from the
    // moment the reading landed
    const fades = copies.map(copy => running(copy));
    assert.deepEqual(fades.map(run => run && Array.from(run.keys, k => k.opacity)), [[1, 0], [0, 1]]);
    const length = s.context.sentSwapMs(surface.typedBox.left - surface.savedBox.left);
    assert.ok(length >= SWAP_MS && length < SWAP_MS + 5, `a change of about 25px takes ${length}ms`);
    for (const run of fades) {
      assert.equal(run.id, "reword");
      assert.equal(run.options.duration, length);
      assert.equal(run.options.easing, "cubic-bezier(.3,0,.7,1)");
      assert.equal(run.currentTime, 0, "the fade does not start at the reading");
    }
    // the copy is the saved bubble's size in the copies' own px (the typed
    // bubble's scale, read at the press), and the real bubble stays hidden
    // until the landing
    const scale = surface.typedBox.width / Math.round(surface.typedBox.width);
    assert.ok(Math.abs(parseFloat(copies[1].style.width) - surface.savedBox.width / scale) < 1e-9, `the saved words' copy is ${copies[1].style.width} wide`);
    assert.equal(s.p.style.getPropertyValue("opacity"), "0");
    s.frame(FLIGHT_MS);
    s.frame(FLIGHT_MS + FRAME);
    assert.equal(s.shell(), null, "the flight did not hand over at its own length");
    assert.equal(s.p.style.getPropertyValue("opacity"), "");
  });

  test(`${name}: saved words read late in the air run the flight on until the swap is in, and it lands on them`, () => {
    // read at 550ms, the swap's run ends at 750ms: the flight hands its box
    // over for that long, its moves all in by 650ms, the box easing on
    const s = scene(surface);
    const motion = s.context.armSentMotion(s.el);
    const p = s.bubble(surface.typedBox, "that is so fucked");
    motion.play();
    for (let ms = FRAME; ms <= 550; ms += FRAME) s.frame(ms);
    clockAt(s, 550);
    saved(s, p, surface);
    const clip = s.shell().querySelector(".sentmorph-clip");
    const length = s.context.sentSwapMs(surface.typedBox.left - surface.savedBox.left);
    assert.equal(running(clip).options.duration, Math.ceil(550 + length), "the flight was not handed over for the swap's run");
    const end = Math.ceil(550 + length);
    let before = edgesAt(s, 550);
    for (let ms = 550 + FRAME; ms <= end; ms += FRAME) {
      const now = edgesAt(s, ms);
      for (const k of Object.keys(now)) assert.ok(Math.abs(now[k] - before[k]) <= EDGE_LIMIT, `the ${k} moved ${Math.abs(now[k] - before[k])}px at ${ms}ms`);
      before = now;
    }
    const last = edgesAt(s, end);
    assert.ok(Math.abs(last.l - surface.savedBox.left) <= 0.5 && Math.abs(last.r - surface.savedBox.left - surface.savedBox.width) <= 0.5);
    for (let ms = 550 + FRAME; ms < end; ms += FRAME) { s.frame(ms); assert.ok(s.shell(), `the flight ended at ${ms}ms, before the swap was in`); }
    s.frame(end);
    s.frame(end + FRAME);
    assert.equal(s.shell(), null);
  });

  test(`${name}: saved words read after the landing change the landed bubble on the swap's curve, its word left where it is`, () => {
    const s = fly(surface);
    for (let ms = 3 * FRAME; ms <= FLIGHT_MS + 2 * FRAME; ms += FRAME) s.frame(ms);
    assert.equal(s.shell(), null, "the flight did not land");
    const was = saved(s, s.p, surface);
    assert.ok(was && was.rect && was.copy, "the landed bubble was not read before its rows changed");
    const layer = s.p.querySelector(".sentreword");
    assert.ok(layer, "no layer draws the change");
    assert.ok(s.context.sentBusy(s.p), "the bubble may merge while it changes");
    // the bubble's own grey and words are hidden under the layer
    assert.equal(s.p.style.getPropertyValue("background"), "transparent");
    for (const part of s.p.children.filter(one => one !== layer)) assert.equal(part.style.visibility, "hidden");
    // the box: from the typed words' bubble to the saved words', in the
    // bubble's own px, on the swap's curve over its run
    const clips = layer.querySelectorAll(".sentmorph-clip");
    assert.equal(clips.length, 4);
    const room = { width: parseFloat(clips[0].style.width), height: parseFloat(clips[0].style.height) };
    const at = (run, f) => { const a = numbers(run.keys[0].transform), b = numbers(run.keys[1].transform); return a.map((v, i) => v + (b[i] - v) * f); };
    const boxAt = f => {
      const [c1, c2, c3] = clips.map(clip => at(running(clip), f));
      const left = s.p.layout.left + c1[0], top = s.p.layout.top + c1[1];
      return { l: left, t: top, r: left + c2[0] + room.width, b: top + c3[1] + room.height };
    };
    const length = s.context.sentSwapMs(surface.typedBox.left - surface.savedBox.left);
    for (const clip of clips) {
      assert.equal(running(clip).options.duration, length);
      assert.equal(running(clip).options.easing, "cubic-bezier(.3,0,.7,1)");
    }
    const from = boxAt(0), to = boxAt(1), A = surface.typedBox, B = surface.savedBox;
    for (const [k, v] of [["l", A.left], ["t", A.top], ["r", A.left + A.width], ["b", A.top + A.height]])
      assert.ok(Math.abs(from[k] - v) <= 1e-6, `the change starts with its ${k} at ${from[k]}, not the bubble's ${v}`);
    for (const [k, v] of [["l", B.left], ["t", B.top], ["r", B.left + B.width], ["b", B.top + B.height]])
      assert.ok(Math.abs(to[k] - v) <= 1e-6, `the change ends with its ${k} at ${to[k]}, not the bubble's ${v}`);
    let prev = from;
    for (let ms = FRAME; ms <= length + 1e-9; ms += FRAME) {
      const now = boxAt(SWAP(ms / length));
      for (const k of Object.keys(now)) assert.ok(Math.abs(now[k] - prev[k]) <= EDGE_LIMIT, `the ${k} moved ${Math.abs(now[k] - prev[k])}px at ${ms}ms`);
      prev = now;
    }
    // the words: the copy as it stood and the copy as it stands fade over
    const copies = layer.querySelector(".sentmorph-target").children;
    assert.equal(copies.length, 2);
    assert.deepEqual(copies.map(copy => Array.from(running(copy).keys, k => k.opacity)), [[1, 0], [0, 1]]);
    // the bubble is itself again the frame after the run's last one
    for (const node of layer.querySelectorAll("*")) for (const run of node.animations) run.currentTime = length;
    s.frame(FLIGHT_MS + 100);
    assert.ok(s.p.querySelector(".sentreword"), "the layer went before the run's last frame was drawn");
    s.frame(FLIGHT_MS + 117);
    assert.equal(s.p.querySelector(".sentreword"), null);
    assert.equal(s.p.style.getPropertyValue("background"), "");
    for (const part of s.p.children) assert.equal(part.style.getPropertyValue("visibility"), "");
    assert.ok(!s.context.sentBusy(s.p));
  });
}

test("a reading with the words the bubble shows changes nothing, and one with other words under another id is not a swap", () => {
  const surface = SURFACES.mac;
  const s = fly(surface);
  assert.equal(s.context.sentRewording(s.el, s.p), null, "the same words read as a swap");
  s.p.sentMsgs = [{ text: "something else entirely", op: "op-2", stage: "sent" }];
  assert.equal(s.context.sentRewording(s.el, s.p), null, "another message read as a swap");
});

test("a fifth of a second for a change of up to about 25px, longer for more so no edge moves more than 3px a frame, never past the flight's length", () => {
  const ms = change => s.context.sentSwapMs(change);
  const s = scene(SURFACES.mac);
  assert.equal(ms(0), SWAP_MS);
  assert.equal(ms(25), SWAP_MS);
  assert.ok(ms(39) > 300 && ms(39) < 320, `a 39px change takes ${ms(39)}ms`);
  assert.equal(ms(200), FLIGHT_MS);
  // the steepest frame of the curve over that length moves the edge no more than 3px
  for (const change of [10, 25, 39, 60, 80]) {
    const length = ms(change);
    let worst = 0;
    for (let t = FRAME; t <= length + 1e-9; t += FRAME) worst = Math.max(worst, change * (SWAP(t / length) - SWAP((t - FRAME) / length)));
    assert.ok(worst <= 3.01, `a ${change}px change over ${length}ms moves ${worst.toFixed(2)}px in a frame`);
  }
});
