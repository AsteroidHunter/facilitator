// The send flight's phases, frame by frame, against the reference it copies:
// the bar morph of a reference app (armFieldMorph).
// Its numbers are written out here rather than imported, with where each one
// stands there. Boxes are synthetic viewport rectangles on the phone's
// measures (a 390pt screen, keyboard up); no layout engine and no browser runs,
// so nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");

// ---- the reference ------------------------------------------------------------
const FLIGHT_MS = 400;                       // shift.ts:18
const EASE = [0.22, 1, 0.36, 1];             // shift.ts:25
const TEXT_OUT = 0.35, TEXT_IN = 0.6;        // shift.ts:102-103
// shift.ts:46 flightEase, solved the same way, written again so the check does
// not lean on the code it checks
function ease(f) {
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  const [x1, y1, x2, y2] = EASE;
  const at = (a, b, t) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
  let lo = 0, hi = 1, t = f;
  for (let i = 0; i < 32; i++) {
    const x = at(x1, x2, t);
    if (Math.abs(x - f) < 1e-6) break;
    if (x < f) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return at(y1, y2, t);
}
// shift.ts:79 morphBox: one eased progress for all four edges
const morph = (a, b, p) => ({
  left: a.left + (b.left - a.left) * p, top: a.top + (b.top - a.top) * p,
  width: a.width + (b.width - a.width) * p, height: a.height + (b.height - a.height) * p,
});

// ---- the phone's measures ----------------------------------------------------------
const FIELD = { left: 17.5, top: 500, width: 317.6, height: 43.3 };   // the textarea, m.html:928-933
const BUBBLE = { left: 199.7, top: 422.1, width: 160, height: 52.5 }; // the first send's panel
const ROUND = 17.73;                                                   // --answ-round, 18u at --rest .985
const LOCAL = "rgb(249, 249, 249)", SAVED = "rgb(243, 243, 243)";       // .answered.undelivered, --bubble-fill

// ---- a stand-in dom, just enough for the flight ------------------------------------
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
function element(tag = "div", cls = "") {
  const node = {
    tagName: tag.toUpperCase(), classes: new Set(cls.split(/\s+/).filter(Boolean)),
    style: inline(), dataset: {}, attrs: {}, children: [], parentElement: null,
    layout: null, shiftY: 0, offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollLeft: 0,
    value: "", textContent: "", hidden: false, transform: "none", radius: 0, fill: "",
    animations: [],
    get className() { return [...node.classes].join(" "); },
    set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
    classList: {
      add: (...names) => names.forEach(n => node.classes.add(n)),
      remove: (...names) => names.forEach(n => node.classes.delete(n)),
      contains: name => node.classes.has(name),
      toggle: (name, on) => ((on === undefined ? !node.classes.has(name) : on) ? node.classes.add(name) : node.classes.delete(name), node.classes.has(name)),
    },
    get isConnected() {
      let at = node;
      while (at.parentElement) at = at.parentElement;
      return at === DOC.body;
    },
    // the box as drawn: its laid-out place, moved by every glide over it
    getBoundingClientRect() {
      const r = node.layout || { left: 0, top: 0, width: 0, height: 0 };
      let dy = 0;
      for (let at = node; at; at = at.parentElement) dy += at.shiftY;
      return { left: r.left, top: r.top + dy, width: r.width, height: r.height,
        right: r.left + r.width, bottom: r.top + dy + r.height };
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
      const run = { keys, options, cancelled: false, cancel() { run.cancelled = true; } };
      node.animations.push(run);
      return run;
    },
  };
  return node;
}
const DOC = { body: null };
function box(node, r) {
  node.layout = r;
  node.offsetWidth = r.width;
  node.offsetHeight = r.height;
}

function scene() {
  DOC.body = element("body");
  const clock = { now: 0, still: false };
  const frames = [];
  const context = vm.createContext({
    console,
    document: { body: DOC.body, createElement: tag => element(tag) },
    performance: { now: () => clock.now },
    requestAnimationFrame: fn => frames.push(fn),
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    matchMedia: query => ({ matches: /reduce/.test(query) && clock.still }),
    getComputedStyle: node => ({
      visibility: "visible", display: node.hidden ? "none" : "block",
      transform: node.transform, lineHeight: "21px", opacity: "1",
      backgroundColor: node.fill || "rgba(0, 0, 0, 0)",
      borderTopLeftRadius: node.radius + "px", borderTopRightRadius: node.radius + "px",
      borderBottomRightRadius: node.radius + "px", borderBottomLeftRadius: node.radius + "px",
      getPropertyValue: name => name === "--card" ? "#ffffff" : name === "--answ-fill" ? node.fill : "",
    }),
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const card = element("div", "box");
  DOC.body.appendChild(card);
  const ta = element("textarea");
  card.appendChild(ta);
  box(ta, FIELD);
  ta.value = "Looks good, ship it";
  const sentwrap = element("div", "sentwrap");
  card.appendChild(sentwrap);
  const el = { box: card, ta, sent: null, sentwrap, answwrap: null, reply: null };
  // the panel the page would draw, with its rows; the page appends it, the test lays it out
  function panel(rows) {
    const p = element("div", "answered sent");
    p.radius = ROUND;
    p.fill = LOCAL;
    const clip = element("div", "answclip");
    const stack = element("div", "answstack");
    p.appendChild(clip);
    clip.appendChild(stack);
    for (const text of rows) {
      const row = element("div", "answmsg cardmd");
      row.textContent = text;
      stack.appendChild(row);
    }
    sentwrap.appendChild(p);
    el.sent = p;
    return p;
  }
  // every frame waiting, at this moment of the clock
  const frame = ms => {
    clock.now = ms;
    for (const fn of frames.splice(0)) fn(ms);
  };
  const shell = () => DOC.body.children.find(n => n.classes.has("sentmorph")) || null;
  return { context, clock, el, panel, frame, shell };
}
const px = value => parseFloat(value);
const near = (actual, expected, label, within = 0.05) =>
  assert.ok(Math.abs(actual - expected) <= within, `${label}: ${actual} is not ${expected}`);
function flyFirst() {
  const s = scene();
  const motion = s.context.armSentMotion(s.el);
  assert.ok(motion, "a send with a laid-out field must fly");
  const p = s.panel(["Looks good, ship it"]);
  box(p, BUBBLE);
  motion.play();
  return { ...s, motion, p, face: () => s.shell().querySelector(".sentmorph-face") };
}

// ---- the phases ------------------------------------------------------------------------
test("the flying box wears the bubble's own face from its first frame, not after it has landed", () => {
  // the reference's shell is visible from the first frame: an opaque sheet of
  // the page under the field's own pill (styles.css:1783-1787), with the
  // bubble's colour coming in over it (shift.ts:115). The row here draws no
  // pill, so the face it flies with is the bubble's grey, whole at once
  const s = flyFirst();
  assert.equal(s.face().style.opacity, "1", "the face is not whole before the first frame");
  assert.equal(s.face().style.background, LOCAL, "the face is not the bubble's live grey");
  for (const ms of [0, 40, 80, 120]) {
    s.frame(ms);
    assert.equal(s.face().style.opacity, "1", `the face is not whole at ${ms}ms`);
  }
  // the grey firms up with delivery while airborne, and the face follows it
  s.p.fill = SAVED;
  s.frame(160);
  assert.equal(s.face().style.background, SAVED);
});

test("the flying box keeps the bubble's rounded corners at every frame", () => {
  // the reference's box is round at every frame: the field's 18px pill
  // (styles.css:1335) turning into the bubble's 18px corners (styles.css:970)
  const s = flyFirst();
  const corners = [ROUND, ROUND, ROUND, ROUND].map(n => n + "px").join(" ");
  assert.equal(s.shell().style.borderRadius, corners, "the corners are not the bubble's before the first frame");
  for (const ms of [0, 40, 120, 240, 400]) {
    s.frame(ms);
    assert.equal(s.shell().style.borderRadius, corners, `the corners are not the bubble's at ${ms}ms`);
  }
});

test("the box rises and narrows on the reference's one curve: left, top, width and height together", () => {
  // shift.ts:79-87 and main.ts:6325-6337: one eased progress for all four
  // edges, no second phase and no overshoot. At 120ms the box is within 13.1px
  // of its height but still 26.4px wider than the bubble, which is what reads as
  // arriving first and then compressing
  const s = flyFirst();
  for (let ms = 0; ms <= FLIGHT_MS; ms += 40) {
    s.frame(ms);
    const want = morph(FIELD, BUBBLE, ease(ms / FLIGHT_MS));
    for (const edge of ["left", "top", "width", "height"])
      near(px(s.shell().style[edge]), want[edge], `${edge} at ${ms}ms`);
    if (ms !== 120) continue;
    near(px(s.shell().style.top) - BUBBLE.top, 13.1, "rise still to go at 120ms", 0.1);
    near(px(s.shell().style.width) - BUBBLE.width, 26.4, "narrowing still to go at 120ms", 0.1);
  }
});

test("the typed words leave by 140ms, the bubble's words arrive from 240ms to 400ms, and the bubble takes over a frame later", () => {
  const s = flyFirst();
  const typed = () => Number(s.shell().querySelector(".sentmorph-source").style.opacity);
  const words = () => Number(s.shell().querySelector(".sentmorph-target").style.opacity);
  s.frame(0); near(typed(), 1, "typed words at 0ms");
  s.frame(70); near(typed(), 1 - 0.175 / TEXT_OUT, "typed words at 70ms", 1e-9);
  s.frame(140); near(typed(), 0, "typed words at 140ms");
  s.frame(240); near(words(), 0, "bubble words at 240ms");
  s.frame(320); near(words(), (0.8 - TEXT_IN) / (1 - TEXT_IN), "bubble words at 320ms", 1e-9);
  s.frame(FLIGHT_MS); near(words(), 1, "bubble words at 400ms");
  assert.ok(s.shell(), "the landing frame was not painted before the swap");
  assert.equal(s.p.style.getPropertyValue("opacity"), "0", "the real bubble showed before the landing");
  s.frame(FLIGHT_MS + 17);
  assert.equal(s.shell(), null);
  assert.equal(s.p.style.getPropertyValue("opacity"), "");
});

test("the bubble's words hang from the shell's right end, as the reference's do", () => {
  // styles.css:1821-1824: the bubble's text layer is pinned top:0; right:0 of
  // the shell, so its words never ride the sweep of the shell's left edge
  const s = flyFirst();
  const x = () => px(/translate\(([-\d.e]+)px/.exec(s.shell().querySelector(".sentmorph-target").style.transform)[1]);
  for (const ms of [120, 280, FLIGHT_MS]) {
    s.frame(ms);
    near(x(), px(s.shell().style.width) - BUBBLE.width, `the words' offset at ${ms}ms`);
  }
});

test("a later send flies to its row's laid-out place, not to the glide its own send gives the panel", () => {
  // the reference never lets a send's own shift carry the seat it flies to
  // (main.ts:7249-7263 leaves the flying rows to the flight); here the new row
  // stands inside the shared panel, which this send glides up from where it stood
  const s = scene();
  const p = s.panel(["Looks good, ship it"]);
  box(p, BUBBLE);
  const motion = s.context.armSentMotion(s.el);
  // the second message joins the panel: the panel grows 42px up from its foot
  const stack = p.querySelector(".answstack");
  const row = s.context.document.createElement("div");
  row.classList.add("answmsg");
  row.textContent = "One more thing";
  stack.appendChild(row);
  const grown = { left: BUBBLE.left, top: BUBBLE.top - 42, width: BUBBLE.width, height: BUBBLE.height + 42 };
  box(p, grown);
  box(p.querySelector(".answclip"), { left: 217.4, top: grown.top + 15.76, width: 124.5, height: 63 });
  const seat = { left: 217.4, top: grown.top + 15.76 + 42, width: 124.5, height: 21 };
  box(row, seat);
  box(p.querySelector(".answmsg"), { left: 217.4, top: grown.top + 15.76, width: 124.5, height: 21 });
  motion.play();
  const glide = p.animations.at(-1);
  assert.ok(glide, "the panel did not glide from where it stood");
  assert.equal(glide.keys[0].transform.trim(), "translate(0px,42px)");
  for (const ms of [40, 80, 160]) {
    // the browser drawing the glide part way: the panel and all in it lower by what is left
    const left = 42 * (1 - ease(ms / FLIGHT_MS));
    p.shiftY = left;
    p.transform = `matrix(1, 0, 0, 1, 0, ${left})`;
    s.frame(ms);
    const want = morph(FIELD, seat, ease(ms / FLIGHT_MS));
    near(px(s.shell().style.top), want.top, `the shell's top at ${ms}ms`);
    near(px(s.shell().style.height), want.height, `the shell's height at ${ms}ms`);
  }
  p.shiftY = 0;
  p.transform = "none";
  s.frame(FLIGHT_MS);
  near(px(s.shell().style.top), seat.top, "the landing");
});

test("a reader who asked for no motion gets no flight", () => {
  const s = scene();
  s.clock.still = true;
  assert.equal(s.context.armSentMotion(s.el), null);
  assert.equal(s.shell(), null);
});
