// The send flight's phases, frame by frame. The motion is the iPhone's Messages
// send, measured off the owner's screen recording.
// Its readings
// are written out here in the recording's own pixels rather than imported, so
// the check does not lean on the code it checks. What is ours and not the
// iPhone's is the owner's order on the card: the box keeps the bubble's right
// end from the first frame, and one copy of the words stays dark the whole way,
// shrinking from the typing size to the bubble's. Boxes are synthetic viewport
// rectangles on the phone's measures (a 390pt screen, keyboard up); no layout
// engine and no browser runs, so nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const LOGIC = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");

// ---- the iPhone, off the recording ---------------------------------------------
// 1126 x 2436 pixels, 3 to a point, a frame every 1/60s while anything moves.
// 0ms is the last frame with the typed words still in the bar.
const BAR = { left: 241, top: 2235 };             // the typing bar's border at 0ms
const LANDED = { left: 711.51, top: 2072.32 };    // the landed bubble, frames 53-64
const FLIGHT_MS = 700;   // every frame from 698ms on is within 0.002 of the landing
// [frame, ms, left px, top px, size against the landed size, colour as seen]
const IPHONE = [
  [6, 16.7, 257.6, 2237.1, 0.968, 0.166],
  [7, 33.3, 287.9, 2237.4, 0.962, 0.177],
  [8, 50.0, 331.6, 2237.7, 0.946, 0.180],
  [9, 66.7, 387.0, 2237.1, 0.914, 0.177],
  [10, 83.3, 451.7, 2229.9, 0.905, 0.189],
  [11, 100.0, 529.5, 2221.3, 0.875, 0.211],
  [12, 116.7, 609.5, 2209.3, 0.844, 0.331],
  [13, 133.3, 661.8, 2197.4, 0.828, 0.360],   // left read through the bar's glass
  [14, 150.0, 727.4, 2184.0, 0.812, 0.370],
  [15, 166.7, 763.4, 2170.5, 0.796, 0.390],
  [16, 183.3, 783.4, 2158.0, 0.782, 0.446],
  [17, 200.0, 787.6, 2146.1, 0.782, 0.628],
  [18, 216.7, 787.5, 2134.2, 0.781, 1.000],
  [19, 233.3, 785.4, 2123.4, 0.792, 1.000],
  [20, 250.0, 779.6, 2113.4, 0.809, 1.000],
  [21, 266.7, 773.6, 2104.3, 0.830, 1.000],
  [22, 283.3, 767.5, 2097.4, 0.847, 1.000],
  [23, 300.0, 761.4, 2090.1, 0.864, 1.000],
  [24, 316.7, 753.5, 2084.7, 0.890, 1.000],
  [25, 333.3, 747.5, 2080.0, 0.906, 1.000],
  [26, 348.3, 741.5, 2076.0, 0.923, 1.000],
  [27, 365.0, 735.5, 2073.4, 0.939, 1.000],
  [28, 381.7, 731.4, 2071.4, 0.951, 1.000],
  [29, 398.3, 727.4, 2069.4, 0.961, 1.000],
  [30, 415.0, 723.4, 2068.4, 0.972, 1.000],
  [31, 431.7, 719.5, 2068.0, 0.983, 1.000],
  [32, 448.3, 717.5, 2067.4, 0.988, 1.000],
  [33, 465.0, 715.5, 2067.4, 0.994, 1.000],
  [34, 481.7, 713.5, 2067.4, 0.999, 1.000],
  [35, 498.3, 713.4, 2067.5, 0.999, 1.000],
  [36, 515.0, 711.5, 2068.2, 1.003, 1.000],
  [37, 531.7, 711.4, 2068.2, 1.000, 1.000],
  [38, 548.3, 711.4, 2069.4, 1.000, 1.000],
  [39, 565.0, 709.6, 2069.4, 1.005, 1.000],
  [40, 581.7, 709.5, 2069.5, 1.005, 1.000],
  [41, 598.3, 709.5, 2070.1, 1.005, 1.000],
  [42, 615.0, 709.5, 2070.6, 1.005, 1.000],
  [43, 631.7, 709.5, 2071.4, 1.005, 1.000],
  [44, 648.3, 709.6, 2071.4, 1.005, 1.000],
  [45, 665.0, 711.4, 2071.4, 1.000, 1.000],
  [46, 681.7, 711.4, 2071.5, 1.000, 1.000],
];
// how far the earlier bubbles have moved up to make room, frames 6-31
const IPHONE_GLIDE = [0.034, 0.133, 0.258, 0.377, 0.488, 0.592, 0.681, 0.748, 0.804, 0.854,
  0.886, 0.912, 0.935, 0.949, 0.964, 0.973, 0.980, 0.983, 0.989, 0.991, 0.992, 0.993, 0.995, 0.998, 0.999, 1.000];
const across = row => (row[2] - BAR.left) / (LANDED.left - BAR.left);
const up = row => (BAR.top - row[3]) / (BAR.top - LANDED.top);
// the iPhone between its frames, on a straight line from the bar to the landing
function iphone(ms) {
  const rows = [[0, 0, 0, 1], ...IPHONE.map(r => [r[1], across(r), up(r), r[4]]), [FLIGHT_MS, 1, 1, 1]];
  let i = 1;
  while (i < rows.length - 1 && rows[i][0] < ms) i++;
  const a = rows[i - 1], b = rows[i], f = Math.max(0, Math.min(1, (ms - a[0]) / (b[0] - a[0])));
  const at = n => a[n] + (b[n] - a[n]) * f;
  return { across: at(1), up: at(2), size: at(3) };
}
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
const mix = (a, b, p) => a + (b - a) * p;
const within = p => Math.max(0, Math.min(1, p));

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
// how far the first send's box has gone, by the same measure as the iPhone's
const progress = b => ({ across: (b.left - FIELD.left) / (BUBBLE.left - FIELD.left), up: (FIELD.top - b.top) / (FIELD.top - BUBBLE.top) });
// the moments checked: before the first frame, then every iPhone frame to the landing
const MOMENTS = [null, 0, ...IPHONE.map(r => r[1]), FLIGHT_MS];

// ---- the phases ------------------------------------------------------------------------
test("the box squeezes in from the left before it rises, as the iPhone's bubble does", () => {
  // the recording: by 100ms (frame 11) its left edge is 61% of the way, its top 8%
  const f11 = IPHONE.find(r => r[0] === 11);
  assert.ok(across(f11) > 0.6 && up(f11) < 0.1);
  const s = flyFirst();
  let squeezed = null, halfUp = null;
  for (let ms = 0; ms <= FLIGHT_MS; ms++) {
    s.frame(ms);
    const p = progress(edges(s));
    if (squeezed === null && p.across >= 1) squeezed = ms;
    if (halfUp === null && p.up >= 0.5) halfUp = ms;
    if (Math.abs(ms - 67) < 1) {
      assert.ok(Math.abs(p.up) <= 0.02, `the top has left the row at 67ms (${p.up})`);
      assert.ok(p.across >= 0.3, `the left edge has not squeezed in at 67ms (${p.across})`);
    }
    if (ms === 100) {
      assert.ok(p.across >= 0.6, `the left edge is ${p.across} of the way at 100ms`);
      assert.ok(p.up <= 0.1, `the top is ${p.up} of the way at 100ms`);
      assert.ok(p.across - p.up >= 0.5, "the squeeze is not well ahead of the rise at 100ms");
    }
  }
  assert.ok(squeezed !== null && halfUp !== null && squeezed < halfUp,
    `the left edge reached the bubble's (${squeezed}ms) after the top was halfway up (${halfUp}ms)`);
});

test("the box's left edge and top follow the iPhone's frame by frame, its right end on the bubble's", () => {
  const s = flyFirst();
  const first = edges(s);
  near(first.left, FIELD.left, "the start box's left edge");
  near(first.top, FIELD.top, "the start box's top");
  near(first.height, FIELD.height, "the start box's height");
  near(first.right, RIGHT, "the start box's right end", 1e-6);
  for (const row of IPHONE) {
    const [frame, ms] = row;
    s.frame(ms);
    const got = edges(s), p = progress(got);
    near(got.right, RIGHT, `the right end at ${ms}ms`, 1e-6);
    near(p.up, up(row), `the top at ${ms}ms (frame ${frame})`, 0.002);
    // frame 13's left edge was read through the bar's glass, which blurs it;
    // the flight takes the run of the frames either side there
    if (frame === 13) {
      const [a, b] = [IPHONE.find(r => r[0] === 12), IPHONE.find(r => r[0] === 14)];
      assert.ok(p.across > across(a) && p.across < across(b), `the left edge at ${ms}ms is off its neighbours' run`);
    } else near(p.across, across(row), `the left edge at ${ms}ms (frame ${frame})`, 0.002);
  }
  s.frame(FLIGHT_MS);
  const landed = edges(s);
  near(landed.left, BUBBLE.left, "the landing's left", 1e-6);
  near(landed.top, BUBBLE.top, "the landing's top", 1e-6);
  near(landed.height, BUBBLE.height, "the landing's height", 1e-6);
});

test("the box and its words shrink as they leave the row and grow back to the bubble's size in place", () => {
  // the iPhone's bubble and words are 78% of their landed size at 217ms
  const s = flyFirst();
  for (const row of IPHONE) {
    s.frame(row[1]);
    const k = s.words().k;
    // (frame 13's left edge, which the shrink from the typing size rides, is
    // the blurred reading the flight does not take)
    near(k, mix(GROW, 1, within(across(row))) * row[4], `the words' scale at ${row[1]}ms`, row[0] === 13 ? 0.004 : 0.0012);
    near(edges(s).height, mix(FIELD.height, BUBBLE.height, within(up(row))) * row[4], `the box's height at ${row[1]}ms`, 0.06);
  }
  s.frame(216.7);
  const low = edges(s);
  near(s.words().k * WORDS.size, 0.781 * WORDS.size, "the words' size at 217ms", 0.02);
  assert.ok(low.width < 0.85 * BUBBLE.width, `the box is ${low.width}px wide at 217ms`);
  assert.ok(low.height < 0.8 * BUBBLE.height, `the box is ${low.height}px tall at 217ms`);
  // and grows back, never shrinking again until it is the bubble's size
  let before = s.words().k;
  for (let ms = 217; ms <= 482; ms += 1) {
    s.frame(ms);
    const k = s.words().k;
    assert.ok(k >= before - 1e-9, `the words shrank again at ${ms}ms`);
    before = k;
  }
  s.frame(FLIGHT_MS);
  assert.equal(s.words().k, 1, "the words did not land at the bubble's size");
  near(edges(s).width, BUBBLE.width, "the box did not land at the bubble's width", 1e-6);
});

test("the grey comes in as the box rises and is whole once it has risen clear, as the iPhone's colour does", () => {
  // the iPhone's colour shows at a sixth while it is in the bar, under its
  // frosted glass, and whole from 217ms, when it has risen clear
  const s = flyFirst();
  near(px(s.face().style.opacity), 0.166, "the grey before the first frame", 1e-6);
  assert.equal(s.face().style.background, LOCAL, "the face is not the bubble's live grey");
  for (const row of IPHONE) {
    s.frame(row[1]);
    near(px(s.face().style.opacity), row[5], `the grey at ${row[1]}ms`, 0.001);
  }
  const s2 = flyFirst();
  let before = 0;
  for (let ms = 0; ms <= FLIGHT_MS; ms++) {
    s2.frame(ms);
    const grey = px(s2.face().style.opacity);
    // never back by more than the readings' own noise (0.180 to 0.177 at 67ms)
    assert.ok(grey >= before - 0.005, `the grey went back at ${ms}ms`);
    if (ms <= 183) assert.ok(grey < 0.5, `the grey is ${grey} at ${ms}ms, while the iPhone's still shows faint`);
    if (ms >= 217) assert.equal(grey, 1, `the grey is not whole at ${ms}ms`);
    before = grey;
  }
  // the grey firms up with delivery while airborne, and the face follows it
  const s3 = flyFirst();
  s3.p.fill = SAVED;
  s3.frame(160);
  assert.equal(s3.face().style.background, SAVED);
});

test("the flight takes the iPhone's 700ms, and the bubble takes over a frame after it lands", () => {
  const s = flyFirst();
  for (const ms of [400, 417, 600]) {
    s.frame(ms);
    assert.ok(s.shell(), `the flight ended by ${ms}ms`);
    assert.equal(s.p.style.getPropertyValue("opacity"), "0", `the real bubble showed at ${ms}ms`);
  }
  // still settling at 600ms: the iPhone's top is 1.3% past the landing then
  near(progress(edges(s)).up, up(IPHONE.find(r => r[1] === 598.3)), "the settle at 600ms", 0.004);
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
  // the iPhone's words turn white on its green; here they stay dark on grey
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

test("the words start on the typed words at the typing size, ride the box, and land on the bubble's own place", () => {
  const s = flyFirst();
  // where the copy draws its first line: its left, its middle, its size
  const first = () => {
    const w = s.words(), b = edges(s);
    const left = b.left + w.x + PAD.x * w.k, top = b.top + w.y + PAD.y * w.k;
    return { left, middle: top + WORDS.line * w.k / 2, size: WORDS.size * w.k, k: w.k, box: b };
  };
  // before the first frame: the typing size, over the typed words
  const start = first();
  near(start.size, TYPED.size, "the words' size before the first frame (the typing size)", 1e-9);
  near(start.left, FIELD.left + TYPED.padLeft, "the words' left before the first frame (the typed words')");
  near(start.middle, FIELD.top + TYPED.padTop + TYPED.line / 2, "the first line's middle before the first frame (the typed line's)");
  for (const ms of MOMENTS.slice(1)) {
    s.frame(ms);
    const got = first();
    // the first line stays inside the box, its inset going from the typed
    // words' to the bubble's and taking the box's size
    const a = iphone(ms);
    if (ms !== 133.3)   // frame 13's blurred left edge, which the flight does not take
      near(got.left - got.box.left, mix(TYPED.padLeft, PAD.x, within(a.across)) * a.size, `the words' inset at ${ms}ms`, 0.03);
    assert.ok(got.middle > got.box.top && got.middle < got.box.top + got.box.height, `the words left the box at ${ms}ms`);
  }
  // the landing: the bubble's size, exactly where the bubble draws its words
  const end = s.words();
  assert.equal(end.k, 1, "the words did not land at the bubble's size");
  near(end.x, 0, "the copy's left at landing", 1e-9);
  near(end.y, 0, "the copy's top at landing", 1e-9);
});

test("what stood before makes room on the iPhone's glide, quicker than the bubble rises", () => {
  // the recording's earlier bubbles are 59% of the way up at 100ms, when the
  // new one's top is at 8%; the glide is one curve fitted to their frames
  const s = scene();
  const p = s.panel(["Looks good, ship it"]);
  box(p, BUBBLE);
  const motion = s.context.armSentMotion(s.el);
  p.querySelector(".answstack").appendChild(s.row("One more thing"));
  box(p, { left: BUBBLE.left, top: BUBBLE.top - 42, width: BUBBLE.width, height: BUBBLE.height + 42 });
  box(p.querySelector(".answclip"), { left: 217.4, top: BUBBLE.top - 42 + 15.76, width: 124.5, height: 63 });
  box(p.querySelectorAll(".answmsg").at(-1), { left: 217.4, top: BUBBLE.top + 15.76, width: 124.5, height: 21 });
  motion.play();
  const glide = p.animations.at(-1);
  assert.ok(glide, "the panel did not glide from where it stood");
  assert.equal(glide.options.duration, 340, "the glide is not the iPhone's length");
  assert.equal(glide.options.easing, "cubic-bezier(.24,.15,.15,1)", "the glide is not the iPhone's curve");
  const curve = bezier([0.24, 0.15, 0.15, 1]);
  IPHONE_GLIDE.forEach((value, i) => {
    const ms = IPHONE[i][1];
    near(curve(ms / 340), value, `the glide at ${ms}ms against the iPhone's`, 0.016);
  });
  assert.ok(curve(100 / 340) - iphone(100).up > 0.4, "the glide is not well ahead of the rise at 100ms");
});

test("a later send flies to its row's laid-out place, not to the glide its own send gives the panel", () => {
  // the new row stands inside the shared panel, which this send glides up from
  // where it stood; the box follows the same track to the row's place
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
  const curve = bezier([0.24, 0.15, 0.15, 1]);
  for (const ms of [40, 80, 160, 300]) {
    // the browser drawing the glide part way: the panel and all in it lower by what is left
    const left = 42 * (1 - curve(ms / 340));
    p.shiftY = left;
    p.transform = `matrix(1, 0, 0, 1, 0, ${left})`;
    s.frame(ms);
    const a = iphone(ms), got = edges(s);
    near(got.top, mix(FIELD.top, seat.top, a.up), `the shell's top at ${ms}ms`, 0.1);
    near(got.height, mix(FIELD.height, seat.height, within(a.up)) * a.size, `the shell's height at ${ms}ms`, 0.1);
    near(got.left, mix(FIELD.left, seat.left, a.across), `the shell's left edge at ${ms}ms`, 0.2);
    near(got.right, seat.left + seat.width, `the shell's right end at ${ms}ms`);
    assert.equal(s.layers()[0].style.opacity, "1", `the words are not at full strength at ${ms}ms`);
  }
  p.shiftY = 0;
  p.transform = "none";
  s.frame(FLIGHT_MS);
  near(px(s.shell().style.top), seat.top, "the landing");
  near(px(s.shell().style.height), seat.height, "the landing's height");
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
