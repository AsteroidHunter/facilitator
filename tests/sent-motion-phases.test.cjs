// The send flight's phases, frame by frame, in the owner's order:
// the box moves sideways, then up, and
// compresses from the typing box into the bubble the way the owner's reference
// recording does (a reference app's send: 400ms on cubic-bezier(.22, 1, .36, 1)),
// with no zoom in and out, nothing past the bubble's size, and no edge passing
// its landing. The six
// sends of the owner's two iPhone recordings
// (tests/fixtures/iphone-send-readings.json)
// are flown here on their own bars and landed
// boxes, one line and two, short and long, and the grey and the glide of what
// stood before still follow the iPhone's readings. One copy of the words stays
// dark the whole way, shrinking from the typing size to the bubble's, and no
// tail. Boxes are synthetic viewport rectangles; no layout engine and no
// browser runs, so nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");
const IPHONE = JSON.parse(readFileSync(path.join(__dirname, "fixtures", "iphone-send-readings.json"), "utf8"));
const FLIGHT_MS = 650;   // sideways by 260ms, up by 430ms, handed over to the bubble at 650ms
const FAINT = 0.135;     // how strong the bubble looks under the bar's glass, 17-50ms
const DRAWN = 0.686;     // how strong it is drawn on its first frame, outside the glass
const PT = 3;            // the recordings' pixels to a point

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

// ---- the phone's measures (--rest .985, so --u is .985px) ---------------------------
const FIELD = { left: 17.5, top: 500, width: 317.6, height: 43.3 };   // the textarea, m.html:928-933
const TYPED = { size: 17 * 0.985, line: 17 * 0.985 * 1.5, padLeft: 4 * 0.985, padTop: 8 * 0.985 };
const BUBBLE = { left: 199.7, top: 422.1, width: 160, height: 52.5 }; // the first send's panel
const PAD = { x: 18 * 0.985, y: 16 * 0.985 };                        // --answ-pad-x, --answ-pad-y
const WORDS = { size: 15 * 0.985, line: 21 };                         // --answ-font, m.html:863
const ROUND = 17.73;                                                   // --answ-round, 18u
const LOCAL = "rgb(249, 249, 249)", SAVED = "rgb(243, 243, 243)";       // .answered.undelivered, --bubble-fill
const RIGHT = BUBBLE.left + BUBBLE.width;                              // 359.7
const GROW = TYPED.size / WORDS.size;
// the compress, the sideways move and the rise: the share of their way at ms
const COMPRESS = ms => bezier([0.22, 1, 0.36, 1])(ms / 400);
const SIDEWAYS = ms => bezier([0.3, 0.6, 0.4, 1])(ms / 260);
const UP = ms => bezier([0.45, 0, 0.25, 1])(ms / 430);

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

// a page with a typing row at `field`, its words typed as `typed` says, and rows
// set in `words`
function scene(field = FIELD, typed = TYPED, words = WORDS) {
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
  box(ta, field);
  Object.assign(ta, { font: typed.size, line: typed.line, padLeft: typed.padLeft, padTop: typed.padTop });
  ta.value = "Looks good, ship it";
  const sentwrap = element("div", "sentwrap");
  card.appendChild(sentwrap);
  const el = { box: card, ta, sent: null, sentwrap, answwrap: null, reply: null };
  // a row as stackAnswered draws it: the message's block of words inside it,
  // drawn at half strength while the board has not saved it (card-tokens.css
  // .answmsg.undelivered)
  function row(text) {
    const r = element("div", "answmsg cardmd undelivered");
    Object.assign(r, { font: words.size, line: words.line });
    const block = element("p");
    block.textContent = text;
    block.ink = "0.5";
    r.appendChild(block);
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
  const wordsAt = () => {
    const m = /translate\(([-\d.e]+)px,([-\d.e]+)px\) scale\(([-\d.e]+),([-\d.e]+)\)/
      .exec(shell().querySelector(".sentmorph-target").style.transform);
    return m ? { x: +m[1], y: +m[2], k: +m[3] } : { x: NaN, y: NaN, k: NaN };   // not placed yet
  };
  // where the first line of the words starts on the page: the box's left, the
  // copy's place in it, and the row's padding (PAD) scaled with the copy
  const wordsLeft = () => { const w = wordsAt(), left = parseFloat(shell().style.left); return left + w.x + PAD.x * w.k; };
  return { context, clock, el, panel, row, frame, shell, layers, words: wordsAt, wordsLeft };
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
// a recorded send flown on its own boxes: the typing row is its bar, the seat
// its landed bubble, and the typed and landed words one size, as on the iPhone
function flyRecorded(send) {
  const bar = { left: send.bar.left, top: send.bar.top, width: send.bar.right - send.bar.left, height: send.bar.bottom - send.bar.top };
  const s = scene(bar, { size: 51, line: 63, padLeft: 0, padTop: 0 }, { size: 51, line: 63 });
  const motion = s.context.armSentMotion(s.el);
  const p = s.panel(["recorded"]);
  const L = send.landed;
  box(p, { left: L.left, top: L.top, width: L.right - L.left, height: L.bottom - L.top });
  box(p.querySelector(".answmsg"), { left: L.left + 42, top: L.top + 24, width: L.right - L.left - 84, height: 63 });
  motion.play();
  return s;
}
const edges = s => {
  const left = px(s.shell().style.left), width = px(s.shell().style.width);
  const top = px(s.shell().style.top), height = px(s.shell().style.height);
  return { left, right: left + width, top, bottom: top + height, width, height };
};
// the moments checked: before the first frame, then every 1/60s to the landing
// the moments checked: before the first frame, then every 1/60s from the first
// frame drawn after the press to the landing. the flight's clock starts a frame
// before its first frame, so with the first frame drawn at exactly 1/60s every
// moment here is ms from the press
const FIRST = 1000 / 60;
const MOMENTS = [null, FIRST];
for (let i = 2; i <= 39; i++) MOMENTS.push(Math.round(i * 1000 / 6) / 10);
// and every ms, from that first frame to the landing
const EVERY_MS = [FIRST];
for (let ms = 17; ms <= FLIGHT_MS; ms++) EVERY_MS.push(ms);

// ---- the phases ------------------------------------------------------------------------
test("every recorded send, flown on its own boxes, goes sideways and up to its landing and never past it", () => {
  // one line and two, short and long, keyboard down and up: the left edge and
  // the top stay between where they start and where they land at every frame,
  // the right end and the foot never pass the bubble's, and every edge is on
  // its landing at the end
  for (const [name, send] of Object.entries(IPHONE.sends)) {
    const s = flyRecorded(send);
    const bar = send.bar, landed = send.landed;
    const between = (v, a, b) => v >= Math.min(a, b) - 1e-6 && v <= Math.max(a, b) + 1e-6;
    for (const ms of MOMENTS.slice(1)) {
      s.frame(ms);
      const got = edges(s);
      assert.ok(between(got.left, bar.left, landed.left), `${name}: the left edge passed its landing at ${ms}ms (${got.left})`);
      assert.ok(got.right <= landed.right + 1e-6, `${name}: the right end passed its landing at ${ms}ms (${got.right})`);
      assert.ok(between(got.top, bar.top, landed.top), `${name}: the top rose past its landing at ${ms}ms (${got.top})`);
      assert.ok(got.bottom >= landed.bottom - 1e-6, `${name}: the foot rose past its landing at ${ms}ms (${got.bottom})`);
    }
    const end = edges(s);
    for (const [key, want] of [["left", landed.left], ["right", landed.right], ["top", landed.top], ["bottom", landed.bottom]])
      near(end[key], want, `${name}: the ${key} at landing`, 1e-6);
  }
});

test("the sideways move goes before the box rises", () => {
  // sideways, then up: the sideways move, which the words ride with the box's
  // left edge, most of the way in while the top has barely left the row
  const s = flyFirst();
  const typedLeft = FIELD.left + TYPED.padLeft, landedLeft = BUBBLE.left + PAD.x;
  const travel = b => ({ across: (s.wordsLeft() - typedLeft) / (landedLeft - typedLeft), up: (FIELD.top - b.top) / (FIELD.top - BUBBLE.top) });
  let mostlyIn = null, quarterUp = null;
  for (const ms of EVERY_MS) {
    s.frame(ms);
    const p = travel(edges(s));
    if (mostlyIn === null && p.across >= 0.75) mostlyIn = ms;
    if (quarterUp === null && p.up >= 0.25) quarterUp = ms;
    if (ms === 67) assert.ok(p.across >= 0.4 && p.up <= 0.1, `at 67ms the left edge is ${p.across} of the way and the top ${p.up}`);
  }
  assert.ok(mostlyIn !== null && quarterUp !== null && mostlyIn < quarterUp,
    `the left edge was three quarters in (${mostlyIn}ms) after the top was a quarter up (${quarterUp}ms)`);
});

test("the box starts as the typing box and compresses into the bubble, closing in from the left while its right end only goes sideways", () => {
  // the typing box is wider (317.6) and a little shorter (43.3) than the
  // bubble (160 by 52.5): the box starts as the typing box itself, and its
  // width and height go to the bubble's on the reference curve. The right end
  // has only 24.6 to go and the left edge 182.2, so the right end goes
  // sideways on premain's curve and the rest of the left edge's way is the
  // compress: the box closes in from the left, as in the recording
  const s = flyFirst();
  const start = edges(s);
  for (const [key, want] of Object.entries(FIELD)) near(start[key], want, `the start box's ${key} (the typing box's)`, 1e-6);
  const fieldRight = FIELD.left + FIELD.width;
  let before = start;
  for (const ms of EVERY_MS) {
    s.frame(ms);
    const b = edges(s), c = COMPRESS(ms);
    near(b.width, FIELD.width + (BUBBLE.width - FIELD.width) * c, `the box's width is off the reference curve at ${ms}ms`, 1e-4);
    near(b.height, FIELD.height + (BUBBLE.height - FIELD.height) * c, `the box's height is off the reference curve at ${ms}ms`, 1e-4);
    near(b.right, fieldRight + (RIGHT - fieldRight) * SIDEWAYS(ms), `the right end is off the sideways curve at ${ms}ms`, 1e-4);
    near(b.top, FIELD.top + (BUBBLE.top - FIELD.top) * UP(ms), `the top is off the up curve at ${ms}ms`, 1e-4);
    assert.ok(b.width <= FIELD.width + 1e-9 && b.width >= BUBBLE.width - 1e-9, `the box's width left its run at ${ms}ms (${b.width})`);
    assert.ok(b.height >= FIELD.height - 1e-9 && b.height <= BUBBLE.height + 1e-9, `the box's height left its run at ${ms}ms (${b.height})`);
    assert.ok(b.right <= RIGHT + 1e-9, `the right end went past the bubble's at ${ms}ms`);
    assert.ok(b.left >= before.left - 1e-9, `the left edge went back at ${ms}ms`);
    assert.ok(b.right >= before.right - 1e-9, `the right end went back at ${ms}ms`);
    before = b;
  }
  for (const [key, want] of Object.entries(BUBBLE)) near(edges(s)[key], want, `the landing's ${key}`, 1e-6);
});

test("the words go once from the typing size to the bubble's, and the box's size goes once from the typing box's to the bubble's", () => {
  // no zoom in and out: the words' size only ever goes one way, the box only
  // ever narrows and grows taller (the typing box is wider and shorter than
  // the bubble) and never past the bubble, and its top only ever goes up
  const s = flyFirst();
  let k = s.words().k, before = edges(s);
  for (const ms of EVERY_MS) {
    s.frame(ms);
    const w = s.words().k, b = edges(s);
    assert.ok(w <= k + 1e-12 && w >= 1 - 1e-12, `the words' size went back or under the bubble's at ${ms}ms (${w})`);
    assert.ok(b.width <= before.width + 1e-9 && b.width >= BUBBLE.width - 1e-9, `the box's width went back or past the bubble's at ${ms}ms (${before.width} to ${b.width})`);
    assert.ok(b.height >= before.height - 1e-9 && b.height <= BUBBLE.height + 1e-9, `the box's height went back or past the bubble's at ${ms}ms (${before.height} to ${b.height})`);
    assert.ok(b.top <= before.top + 1e-9, `the top came back down at ${ms}ms`);
    k = w; before = b;
  }
  assert.equal(s.words().k, 1, "the words did not land at the bubble's size");
  near(edges(s).left, BUBBLE.left, "the box did not land at the bubble's left", 1e-6);
  near(edges(s).top, BUBBLE.top, "the box did not land at the bubble's top", 1e-6);
  near(edges(s).width, BUBBLE.width, "the box did not land at the bubble's width", 1e-6);
  near(edges(s).height, BUBBLE.height, "the box did not land at the bubble's height", 1e-6);
});

test("every recorded send compresses from its own typing bar into its bubble on the reference curve", () => {
  // the six sends' bars are as wide as the screen or wider than their bubbles,
  // and some are taller or shorter than them: the box starts as the bar and
  // its width and height go to the bubble's on the reference curve. Where the
  // bar's right end is the bubble's own (five of them, as in the reference
  // recording) the right end never moves and the box closes in from the left
  for (const [name, send] of Object.entries(IPHONE.sends)) {
    const s = flyRecorded(send), bar = send.bar, landed = send.landed;
    const from = { width: bar.right - bar.left, height: bar.bottom - bar.top };
    const to = { width: landed.right - landed.left, height: landed.bottom - landed.top };
    for (const ms of [null, ...EVERY_MS]) {
      if (ms !== null) s.frame(ms);
      const b = edges(s), c = ms === null ? 0 : COMPRESS(ms), at = ms === null ? "before the first frame" : `at ${ms}ms`;
      near(b.width, from.width + (to.width - from.width) * c, `${name}: the box's width is off the reference curve ${at}`, 1e-3);
      near(b.height, from.height + (to.height - from.height) * c, `${name}: the box's height is off the reference curve ${at}`, 1e-3);
      if (bar.right === landed.right) near(b.right, landed.right, `${name}: the right end moved ${at}`, 1e-6);
    }
  }
});

test("the words are not scaled sideways or squashed, stand at the bubble's own place in the box once the sideways move has landed, and still once the box has", () => {
  // the words are one copy scaled evenly (the same factor across and down),
  // riding the box's left edge: from the moment the sideways move lands they
  // stand at the bubble's own place in the box, and from the moment the
  // compress lands the box's left edge on the bubble's they stand still while
  // the box goes on rising
  const s = flyFirst();
  let still = null;
  for (const ms of EVERY_MS) {
    s.frame(ms);
    const m = /scale\(([-\d.e]+),([-\d.e]+)\)/.exec(s.shell().querySelector(".sentmorph-target").style.transform);
    assert.ok(m && Math.abs(m[1] - m[2]) < 1e-12, `the words are squashed at ${ms}ms (${m && m[0]})`);
    if (ms >= 260) near(s.wordsLeft() - PAD.x - edges(s).left, 0, `the words are not at the bubble's own place in the box at ${ms}ms`, 1e-6);
    if (ms >= 400) {
      const left = s.wordsLeft();
      if (still === null) still = left;
      near(left, still, `the words moved sideways at ${ms}ms`, 1e-6);
    }
  }
  near(still, BUBBLE.left + PAD.x, "the words did not stand at the bubble's own place", 1e-6);
});

test("the grey is faint over the typing row and comes in as the box rises clear, as the iPhone's colour does", () => {
  // the iPhone's bubble is drawn at 69% on its first frame and whole by 183ms,
  // and the part still in the bar looks at 13.5% under the bar's frosted glass
  const s = flyFirst();
  near(px(s.face().style.opacity), FAINT, "the grey before the first frame", 1e-9);
  assert.equal(s.face().style.background, LOCAL, "the face is not the bubble's live grey");
  let before = 0;
  for (const ms of MOMENTS.slice(1)) {
    s.frame(ms);
    const grey = px(s.face().style.opacity), b = edges(s);
    assert.ok(grey >= before - 1e-9 && grey <= 1, `the grey went back or over at ${ms}ms (${grey})`);
    if (b.top >= FIELD.top) near(grey, FAINT, `the grey over the row at ${ms}ms`, 1e-9);
    if (b.bottom <= FIELD.top) assert.ok(grey >= DRAWN - 1e-9, `the grey above the row at ${ms}ms is ${grey}`);
    if (ms >= 183.3 && b.bottom <= FIELD.top) near(grey, 1, `the grey at ${ms}ms`, 1e-9);
    before = grey;
  }
  // a taller bubble clears its bar later, and its grey comes in later: the
  // second recording's two lines against its one-line sends at 217ms
  const greyAt = (send, ms) => { const r = flyRecorded(send); r.frame(FIRST); r.frame(ms); return px(r.shell().querySelector(".sentmorph-face").style.opacity); };
  const two = greyAt(IPHONE.sends.s1, 216.7), one = greyAt(IPHONE.sends.s3, 216.7);
  assert.ok(two < 0.8 && one - two > 0.15, `at 217ms the two-line grey is ${two} and the one-line ${one}`);
  // the grey firms up with delivery while airborne, and the face follows it
  const s3 = flyFirst();
  s3.p.fill = SAVED;
  s3.frame(160);
  assert.equal(s3.face().style.background, SAVED);
});

test("the flight takes 650ms, and the bubble takes over a frame after it lands", () => {
  const s = flyFirst();
  for (const ms of [FIRST, 400, 617, 633]) {
    s.frame(ms);
    assert.ok(s.shell(), `the flight ended by ${ms}ms`);
    assert.equal(s.p.style.getPropertyValue("opacity"), "0", `the real bubble showed at ${ms}ms`);
  }
  s.frame(FLIGHT_MS);
  assert.ok(s.shell(), "the landing frame was not painted before the swap");
  near(edges(s).top, BUBBLE.top, "the landing", 1e-6);
  s.frame(FLIGHT_MS + 17);
  assert.equal(s.shell(), null);
  assert.equal(s.p.style.getPropertyValue("opacity"), "");
});

test("the flying box keeps the bubble's rounded corners at every frame", () => {
  const s = flyFirst();
  const corners = [ROUND, ROUND, ROUND, ROUND].map(n => n + "px").join(" ");
  assert.equal(s.shell().style.borderRadius, corners, "the corners are not the bubble's before the first frame");
  for (const ms of [0, 50, 133.3, 216.7, 400, FLIGHT_MS]) {
    s.frame(ms);
    assert.equal(s.shell().style.borderRadius, corners, `the corners are not the bubble's at ${ms}ms`);
  }
});

test("one copy of the words flies at full strength at every frame, even for a message the board has not saved", () => {
  // the iPhone's words turn white on its colour; here they stay dark on grey
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

test("the words start on the typed words at the typing size, ride inside the box, and land on the bubble's own place", () => {
  const s = flyFirst();
  // where the copy draws its first line: its left, its middle, its size
  const first = () => {
    const w = s.words(), b = edges(s);
    const left = b.left + w.x + PAD.x * w.k, top = b.top + w.y + PAD.y * w.k;
    return { left, middle: top + WORDS.line * w.k / 2, size: WORDS.size * w.k, box: b };
  };
  const start = first();
  near(start.size, TYPED.size, "the words' size before the first frame (the typing size)", 1e-9);
  near(start.left, FIELD.left + TYPED.padLeft, "the words' left before the first frame (the typed words')");
  near(start.middle, FIELD.top + TYPED.padTop + TYPED.line / 2, "the first line's middle before the first frame (the typed line's)");
  for (const ms of MOMENTS.slice(1)) {
    s.frame(ms);
    const got = first();
    assert.ok(got.left > got.box.left && got.left < got.box.right, `the words left the box sideways at ${ms}ms`);
    assert.ok(got.middle > got.box.top && got.middle < got.box.bottom, `the words left the box at ${ms}ms`);
  }
  const end = s.words();
  assert.equal(end.k, 1, "the words did not land at the bubble's size");
  near(end.x, 0, "the copy's left at landing", 1e-9);
  near(end.y, 0, "the copy's top at landing", 1e-9);
});

// a later send: a bubble standing where the first send landed, armed over, and
// the later message's own bubble taking the seat's foot (BUBBLE, its row where
// the first send's row stands), which pushes the one standing up by its own
// height and the mark's room between them (17u)
const ROOM = 17 * 0.985;
function flyLater(standing = ["Looks good, ship it"]) {
  const s = scene();
  const p = s.panel(standing);
  box(p, BUBBLE);
  const motion = s.context.armSentMotion(s.el);
  const q = s.panel(["One more thing"]);
  box(q, BUBBLE);
  box(q.querySelector(".answmsg"), { left: BUBBLE.left + PAD.x, top: BUBBLE.top + PAD.y, width: BUBBLE.width - 2 * PAD.x, height: 21 });
  box(p, { ...BUBBLE, top: BUBBLE.top - BUBBLE.height - ROOM });
  motion.play();
  return { ...s, motion, p, q };
}

test("the bubbles that stood before make room on the iPhone's glide, quicker than the new bubble rises", () => {
  // the six sends' earlier messages, the middle of them at each frame
  const { p, q } = flyLater();
  const glide = p.animations.at(-1);
  assert.ok(glide, "the bubble standing did not glide from where it stood");
  near(+/translate\(0px,([-\d.e]+)px\)/.exec(glide.keys[0].transform)[1], BUBBLE.height + ROOM,
    "the bubble standing did not glide from where it stood", 1e-9);
  assert.equal(q.animations.length, 0, "the new bubble glided as well as flying");
  assert.equal(glide.options.duration, 340, "the glide is not the iPhone's length");
  assert.equal(glide.options.easing, "cubic-bezier(.24,.1,.15,1)", "the glide is not the iPhone's curve");
  const curve = bezier([0.24, 0.1, 0.15, 1]);
  for (const [ms, value] of IPHONE.glide)
    near(curve(ms / 340), value, `the glide at ${ms}ms against the iPhone's`, 0.017);
  const f = flyFirst();
  f.frame(FIRST);
  f.frame(100);
  const up = (FIELD.top - edges(f).top) / (FIELD.top - BUBBLE.top);
  assert.ok(curve(100 / 340) - up > 0.4, `the glide is not well ahead of the rise at 100ms (${curve(100 / 340)} against ${up})`);
});

test("a later send flies into a bubble of its own the way the first send flies, frame for frame", () => {
  // the owner liked the first send's flight: a later one is that flight to the
  // letter, its only change the seat, which is now the later message's own
  // bubble under the one standing rather than a row inside it
  const first = flyFirst(), later = flyLater();
  for (const ms of MOMENTS) {
    if (ms !== null) { first.frame(ms); later.frame(ms); }
    const at = ms === null ? "before the first frame" : `at ${ms}ms`;
    const a = edges(first), b = edges(later);
    for (const key of ["left", "right", "top", "bottom"]) near(b[key], a[key], `the later shell's ${key} ${at}`, 1e-9);
    const wa = first.words(), wb = later.words();
    for (const key of ["x", "y", "k"]) near(wb[key], wa[key], `the later words' ${key} ${at}`, 1e-9);
    assert.equal(later.shell().querySelector(".sentmorph-face").style.opacity,
      first.shell().querySelector(".sentmorph-face").style.opacity, `the later grey ${at}`);
  }
  // it lands whole on the new bubble, and the one standing is never hidden
  near(edges(later).height, BUBBLE.height, "the later send did not land whole");
  assert.equal(later.q.style.getPropertyValue("opacity"), "0", "the new bubble showed under its flight");
  assert.equal(later.p.style.getPropertyValue("opacity"), "", "the bubble standing was hidden");
  later.frame(FLIGHT_MS + 17);
  assert.equal(later.shell(), null);
  assert.equal(later.q.style.getPropertyValue("opacity"), "");
});

test("nothing lands on a bubble standing cut: a later send flies whole to its own bubble, nothing fading", () => {
  // the old shared panel squeezed a row below its cut into the cut's edge; now
  // the bubble standing, cut or not, is only ever moved, and its rows are left alone
  const { p, q, frame, layers, shell } = flyLater(["Looks good, ship it", "And one more", "And a third"]);
  const rows = p.querySelectorAll(".answmsg");
  for (const ms of MOMENTS.slice(1)) {
    frame(ms);
    assert.equal(layers().length, 1, `the words are not one copy at ${ms}ms`);
    assert.equal(layers()[0].style.opacity, "1", `the words fade at ${ms}ms`);
    assert.ok(!shell().style.opacity || shell().style.opacity === "1", `the box fades at ${ms}ms`);
    for (const row of rows) assert.equal(row.style.getPropertyValue("opacity"), "", `a row standing was hidden at ${ms}ms`);
  }
  const landed = { top: px(shell().style.top), height: px(shell().style.height) };
  near(landed.top, BUBBLE.top, "the box did not land on the new bubble");
  near(landed.height, BUBBLE.height, "the box did not land whole");
  frame(FLIGHT_MS + 17);
  assert.equal(shell(), null);
  assert.equal(q.style.getPropertyValue("opacity"), "");
});

test("a reader who asked for no motion gets no flight", () => {
  const s = scene();
  s.clock.still = true;
  assert.equal(s.context.armSentMotion(s.el), null);
  assert.equal(s.shell(), null);
});
