// The send flight's phases, frame by frame. The beat and the curve are the
// reference's, the bar morph of a reference app
// (armFieldMorph), written out here rather than imported, with where each one
// stands there. The squeeze and the words are the owner's order on the card:
// the box keeps the bubble's right end from the first frame and squeezes in
// from the left, and one copy of the words stays dark the whole way, shrinking
// from the typing size to the bubble's. Boxes are synthetic viewport
// rectangles on the phone's measures (a 390pt screen, keyboard up); no layout
// engine and no browser runs, so nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");

// ---- the reference ------------------------------------------------------------
const FLIGHT_MS = 400;                       // shift.ts:18
const EASE = [0.22, 1, 0.36, 1];             // shift.ts:25
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
const mix = (a, b, p) => a + (b - a) * p;

// ---- the phone's measures (--rest .985, so --u is .985px) ---------------------------
const FIELD = { left: 17.5, top: 500, width: 317.6, height: 43.3 };   // the textarea, m.html:928-933
const TYPED = { size: 17 * 0.985, line: 17 * 0.985 * 1.5, padLeft: 4 * 0.985, padTop: 8 * 0.985 };
const BUBBLE = { left: 199.7, top: 422.1, width: 160, height: 52.5 }; // the first send's panel
const PAD = { x: 18 * 0.985, y: 16 * 0.985 };                        // --answ-pad-x, --answ-pad-y
const WORDS = { size: 15 * 0.985, line: 21 };                         // --answ-font, m.html:863
const ROUND = 17.73;                                                   // --answ-round, 18u
const LOCAL = "rgb(249, 249, 249)", SAVED = "rgb(243, 243, 243)";       // .answered.undelivered, --bubble-fill
const RIGHT = BUBBLE.left + BUBBLE.width;                              // 359.7

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
    // what the sheet would give it: type, padding, and the strength it is drawn at
    font: 0, line: 21, padLeft: 0, padTop: 0, ink: "1",
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
      transform: node.transform, opacity: node.ink,
      fontSize: node.font ? node.font + "px" : "", lineHeight: node.line + "px",
      paddingLeft: node.padLeft + "px", paddingTop: node.padTop + "px",
      backgroundColor: node.fill || "rgba(0, 0, 0, 0)",
      borderTopLeftRadius: node.radius + "px", borderTopRightRadius: node.radius + "px",
      borderBottomRightRadius: node.radius + "px", borderBottomLeftRadius: node.radius + "px",
      getPropertyValue: name => name === "--card" ? "#ffffff" : name === "--answ-fill" ? node.fill :
        name === "opacity" ? node.ink : "",
    }),
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const card = element("div", "box");
  DOC.body.appendChild(card);
  const ta = element("textarea");
  card.appendChild(ta);
  box(ta, FIELD);
  Object.assign(ta, { font: TYPED.size, line: TYPED.line, padLeft: TYPED.padLeft, padTop: TYPED.padTop });
  ta.value = "Looks good, ship it";
  const sentwrap = element("div", "sentwrap");
  card.appendChild(sentwrap);
  const el = { box: card, ta, sent: null, sentwrap, answwrap: null, reply: null };
  // a row as stackAnswered draws it: the message's block of words inside it,
  // drawn at half strength while the board has not saved it (card-tokens.css
  // .answmsg.undelivered)
  function row(text) {
    const r = element("div", "answmsg cardmd undelivered");
    Object.assign(r, { font: WORDS.size, line: WORDS.line });
    const words = element("p");
    words.textContent = text;
    words.ink = "0.5";
    r.appendChild(words);
    return r;
  }
  // the panel the page would draw, with its rows; the page appends it, the test lays it out
  function panel(texts) {
    const p = element("div", "answered sent");
    p.radius = ROUND;
    p.fill = LOCAL;
    const clip = element("div", "answclip");
    const stack = element("div", "answstack");
    p.appendChild(clip);
    clip.appendChild(stack);
    for (const text of texts) stack.appendChild(row(text));
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
  // the shell's layers of words, and the one copy's place and scale
  const layers = () => shell().children.filter(n => n.classes.has("sentmorph-source") || n.classes.has("sentmorph-target"));
  const words = () => {
    const m = /translate\(([-\d.e]+)px,([-\d.e]+)px\) scale\(([-\d.e]+),([-\d.e]+)\)/
      .exec(shell().querySelector(".sentmorph-target").style.transform);
    return m ? { x: +m[1], y: +m[2], k: +m[3] } : { x: NaN, y: NaN, k: NaN };   // not placed yet
  };
  return { context, clock, el, panel, row, frame, shell, layers, words };
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
  box(p.querySelector(".answmsg"), { left: BUBBLE.left + PAD.x, top: BUBBLE.top + PAD.y, width: BUBBLE.width - 2 * PAD.x, height: 21 });
  motion.play();
  return { ...s, motion, p, face: () => s.shell().querySelector(".sentmorph-face") };
}
const edges = s => {
  const left = px(s.shell().style.left), width = px(s.shell().style.width);
  return { left, right: left + width, top: px(s.shell().style.top), width, height: px(s.shell().style.height) };
};
// the moments checked: before the first frame, then every 40ms to the landing
const MOMENTS = [null, 0, 40, 80, 120, 160, 200, 240, 280, 320, 360, 400];

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

test("the box keeps the bubble's right end at every frame and squeezes in from the left on the reference's curve", () => {
  // the reference's bar barely moves its right end (378 to 374) and narrows
  // from the left; here the right end stands on the bubble's from the start, and
  // the left edge, top and height travel on one eased progress (shift.ts:79-87)
  const s = flyFirst();
  // the start box: the typing box's left edge, top and height, the bubble's right end
  const first = edges(s);
  near(first.left, 17.5, "the start box's left edge");
  near(first.top, 500, "the start box's top");
  near(first.width, 342.2, "the start box's width");
  near(first.height, 43.3, "the start box's height");
  for (const ms of MOMENTS) {
    if (ms !== null) s.frame(ms);
    const at = ms === null ? "before the first frame" : `at ${ms}ms`, p = ease((ms || 0) / FLIGHT_MS);
    const got = edges(s);
    near(got.right, RIGHT, `the right end ${at}`, 1e-6);
    near(got.left, mix(FIELD.left, BUBBLE.left, p), `the left edge ${at}`);
    near(got.top, mix(FIELD.top, BUBBLE.top, p), `the top ${at}`);
    near(got.height, mix(FIELD.height, BUBBLE.height, p), `the height ${at}`);
    if (ms !== 120) continue;
    // within 13.1px of its height, still 30.6px of squeeze to go
    near(got.top - BUBBLE.top, 13.1, "rise still to go at 120ms", 0.1);
    near(BUBBLE.left - got.left, 30.6, "squeeze still to go at 120ms", 0.1);
  }
});

test("one copy of the words flies at full strength at every frame, even for a message the board has not saved", () => {
  // the reference fades its typed words out and its bubble's words in because
  // they turn white on its colour (shift.ts:102-117); here they stay dark on grey
  const s = flyFirst();
  for (const ms of MOMENTS) {
    if (ms !== null) s.frame(ms);
    const at = ms === null ? "before the first frame" : `at ${ms}ms`;
    const layers = s.layers();
    assert.equal(layers.length, 1, `the words are not one copy ${at}`);
    assert.equal(layers[0].style.opacity, "1", `the words are not at full strength ${at}`);
    assert.ok(!s.shell().style.opacity || s.shell().style.opacity === "1", `the box fades ${at}`);
    for (const block of layers[0].querySelectorAll("p"))
      assert.equal(block.style.opacity, "1", `the words take the unsaved half strength ${at}`);
  }
  assert.ok(s.shell(), "the landing frame was not painted before the swap");
  assert.equal(s.p.style.getPropertyValue("opacity"), "0", "the real bubble showed before the landing");
  s.frame(FLIGHT_MS + 17);
  assert.equal(s.shell(), null);
  assert.equal(s.p.style.getPropertyValue("opacity"), "");
});

test("the words start on the typed words at the typing size and shrink to the bubble's size on the bubble's own place", () => {
  const s = flyFirst();
  const grow = TYPED.size / WORDS.size;
  // where the copy draws its first line: its left, its middle, its size
  const first = () => {
    const w = s.words(), b = edges(s);
    const left = b.left + w.x + PAD.x * w.k, top = b.top + w.y + PAD.y * w.k;
    return { left, middle: top + WORDS.line * w.k / 2, size: WORDS.size * w.k, k: w.k };
  };
  // before the first frame: the typing size, over the typed words
  const start = first();
  near(start.size, TYPED.size, "the words' size before the first frame (the typing size)", 1e-9);
  near(start.left, FIELD.left + TYPED.padLeft, "the words' left before the first frame (the typed words')");
  near(start.middle, FIELD.top + TYPED.padTop + TYPED.line / 2, "the first line's middle before the first frame (the typed line's)");
  let before = Infinity;
  for (const ms of MOMENTS) {
    if (ms !== null) s.frame(ms);
    const at = ms === null ? "before the first frame" : `at ${ms}ms`, p = ease((ms || 0) / FLIGHT_MS);
    const got = first();
    near(got.k, mix(grow, 1, p), `the words' scale ${at}`, 1e-6);
    assert.ok(got.size <= before + 1e-9, `the words grew ${at}`);
    before = got.size;
    near(got.left, mix(FIELD.left + TYPED.padLeft, BUBBLE.left + PAD.x, p), `the words' left ${at}`);
  }
  // the landing: the bubble's size, exactly where the bubble draws its words
  const end = s.words();
  assert.equal(end.k, 1, "the words did not land at the bubble's size");
  near(end.x, 0, "the copy's left at landing");
  near(end.y, 0, "the copy's top at landing");
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
  const row = s.row("One more thing");
  p.querySelector(".answstack").appendChild(row);
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
    const p2 = ease(ms / FLIGHT_MS), got = edges(s);
    near(got.top, mix(FIELD.top, seat.top, p2), `the shell's top at ${ms}ms`);
    near(got.height, mix(FIELD.height, seat.height, p2), `the shell's height at ${ms}ms`);
    near(got.right, seat.left + seat.width, `the shell's right end at ${ms}ms`);
    assert.equal(s.layers()[0].style.opacity, "1", `the words are not at full strength at ${ms}ms`);
  }
  p.shiftY = 0;
  p.transform = "none";
  s.frame(FLIGHT_MS);
  near(px(s.shell().style.top), seat.top, "the landing");
});

test("a message below the cut squeezes into the cut's edge, its words going on under it, with nothing fading", () => {
  // the panel keeps a batch past its preview under the cut. The box lands on the
  // cut's edge with no height, so it covers nothing of the words above the cut
  // and nothing has to fade out; the new words travel to their own place, under it
  const s = scene();
  const p = s.panel(["Looks good, ship it", "And one more"]);
  box(p, { left: BUBBLE.left, top: BUBBLE.top - 52, width: BUBBLE.width, height: BUBBLE.height + 52 });
  const clip = p.querySelector(".answclip");
  const cut = { left: 217.4, top: BUBBLE.top - 36, width: 124.5, height: 56.9 };
  box(clip, cut);
  const motion = s.context.armSentMotion(s.el);
  const row = s.row("A third, under the cut");
  p.querySelector(".answstack").appendChild(row);
  const under = { left: 217.4, top: cut.top + 83.4, width: 124.5, height: 31.3 };
  box(row, under);
  motion.play();
  for (const ms of MOMENTS.slice(1)) {
    s.frame(ms);
    assert.equal(s.layers().length, 1, `the words are not one copy at ${ms}ms`);
    assert.equal(s.layers()[0].style.opacity, "1", `the words fade at ${ms}ms`);
    assert.ok(!s.shell().style.opacity || s.shell().style.opacity === "1", `the box fades at ${ms}ms`);
    near(edges(s).right, cut.left + cut.width, `the right end at ${ms}ms`);
  }
  const landed = edges(s);
  near(landed.top, cut.top + cut.height, "the box did not land on the cut's edge");
  near(landed.height, 0, "the box landed with a height that covers the words above the cut");
  assert.ok(s.words().y >= 0, "the new words were left in sight above the cut");
  s.frame(FLIGHT_MS + 17);
  assert.equal(s.shell(), null);
  assert.equal(row.style.getPropertyValue("opacity"), "");
});

test("a reader who asked for no motion gets no flight", () => {
  const s = scene();
  s.clock.still = true;
  assert.equal(s.context.armSentMotion(s.el), null);
  assert.equal(s.shell(), null);
});
