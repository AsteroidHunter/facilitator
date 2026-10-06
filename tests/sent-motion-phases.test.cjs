// The send flight's phases, frame by frame, held to the iPhone's Messages send
// as the owner's two screen recordings show it: six sends, one line and two,
// short and long, keyboard down and up. The
// recordings' own edge readings are in tests/fixtures/iphone-send-readings.json,
// raw, not the curves the code was fitted to, so the check does not lean on
// the code it checks: each send is flown here on its own bar and landed boxes
// and has to land its edges where the iPhone drew them. What is ours and not
// the iPhone's is the owner's order on the card: one copy of the words stays
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
const FLIGHT_MS = 750;   // every send is within 1px of its landing from 713-798ms
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
  return { context, clock, el, panel, row, frame, shell, layers, words: wordsAt };
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
const MOMENTS = [null, 0];
for (let i = 1; i <= 45; i++) MOMENTS.push(Math.round(i * 1000 / 6) / 10);

// ---- the phases ------------------------------------------------------------------------
test("every recorded send, flown on its own boxes, lands each edge where the iPhone drew it from 183ms on", () => {
  // one line and two, short and long, keyboard down and up: from 183ms every
  // edge within 3.5pt and on average within 1.2pt, and the right end within
  // 0.5pt at every frame, the size held at the bubble's bottom-right corner
  for (const [name, send] of Object.entries(IPHONE.sends)) {
    const s = flyRecorded(send);
    const sq = { L: [], R: [], T: [], B: [] };
    for (const [ms, L, R, T, B, wordsWidth] of send.frames) {
      if (ms > FLIGHT_MS) break;
      s.frame(ms);
      const got = edges(s);
      near(got.right, R, `${name}: the right end at ${ms}ms`, 0.5 * PT);
      if (ms < 182) continue;
      for (const [key, want, have] of [["L", L, got.left], ["R", R, got.right], ["T", T, got.top], ["B", B, got.bottom]]) {
        if (want === null) continue;
        near(have, want, `${name}: the ${{ L: "left edge", R: "right end", T: "top", B: "bottom" }[key]} at ${ms}ms`, 3.5 * PT);
        sq[key].push((have - want) ** 2);
      }
      if (wordsWidth !== null) near(s.words().k, wordsWidth, `${name}: the words' size at ${ms}ms`, 0.03);
    }
    for (const [key, list] of Object.entries(sq)) {
      const rms = Math.sqrt(list.reduce((a, b) => a + b, 0) / list.length) / PT;
      assert.ok(rms <= 1.2, `${name}: the ${key} edge is ${rms.toFixed(2)}pt off on average from 183ms`);
    }
  }
});

test("the box's left edge goes before it rises, as on the iPhone", () => {
  // the recordings: the left edge two thirds of the way while the top has
  // barely left the bar, at 100ms
  const s = flyFirst();
  const travel = b => ({ across: (b.left - FIELD.left) / (BUBBLE.left - FIELD.left), up: (FIELD.top - b.top) / (FIELD.top - BUBBLE.top) });
  let arrived = null, halfUp = null;
  for (let ms = 0; ms <= FLIGHT_MS; ms++) {
    s.frame(ms);
    const p = travel(edges(s));
    if (arrived === null && p.across >= 1) arrived = ms;
    if (halfUp === null && p.up >= 0.5) halfUp = ms;
    if (ms === 67) {
      assert.ok(Math.abs(p.up) <= 0.02, `the top has left the row at 67ms (${p.up})`);
      assert.ok(p.across >= 0.25, `the left edge has not squeezed in at 67ms (${p.across})`);
    }
    if (ms === 100) assert.ok(p.across >= 0.5 && p.up <= 0.1, `at 100ms the left edge is ${p.across} of the way and the top ${p.up}`);
  }
  assert.ok(arrived !== null && halfUp !== null && arrived < halfUp,
    `the left edge reached the bubble's (${arrived}ms) after the top was halfway up (${halfUp}ms)`);
});

test("the box's right end goes from the typing box's to the bubble's, as the iPhone's does", () => {
  // the iPhone's bubble starts as its bar, right end and all; where the bar's
  // right end is not the bubble's (the first recording), it travels across
  const s = flyFirst();
  near(edges(s).right, FIELD.left + FIELD.width, "the start box's right end (the typing box's)", 1e-6);
  near(edges(s).width, FIELD.width, "the start box's width (the typing box's)", 1e-6);
  let before = -Infinity;
  for (const ms of MOMENTS.slice(1)) {
    s.frame(ms);
    const r = edges(s).right;
    if (ms <= 283) assert.ok(r >= before - 1e-9, `the right end went back at ${ms}ms`);
    before = r;
    if (ms === 100) assert.ok(r > FIELD.left + FIELD.width + 1 && r < RIGHT - 1, `the right end is not on its way at 100ms (${r})`);
  }
  near(edges(s).right, RIGHT, "the landing's right end", 1e-6);
});

test("the box and its words shrink to 77% as they leave the row and grow back in place", () => {
  const s = flyFirst();
  s.frame(216.7);
  near(s.words().k * WORDS.size, 0.771 * WORDS.size, "the words' size at 217ms", 0.02);
  const low = edges(s);
  assert.ok(low.width < 0.8 * BUBBLE.width && low.height < 0.8 * BUBBLE.height,
    `the box is ${low.width} by ${low.height} at 217ms`);
  let before = s.words().k;
  for (let ms = 217; ms <= 566; ms++) {
    s.frame(ms);
    const k = s.words().k;
    assert.ok(k >= before - 1e-9, `the words shrank again at ${ms}ms`);
    before = k;
  }
  assert.ok(before > 1 && before < 1.006, `the words do not go a touch over their size at 567ms (${before})`);
  s.frame(FLIGHT_MS);
  assert.equal(s.words().k, 1, "the words did not land at the bubble's size");
  near(edges(s).width, BUBBLE.width, "the box did not land at the bubble's width", 1e-6);
  near(edges(s).height, BUBBLE.height, "the box did not land at the bubble's height", 1e-6);
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
  const greyAt = (send, ms) => { const r = flyRecorded(send); r.frame(ms); return px(r.shell().querySelector(".sentmorph-face").style.opacity); };
  const two = greyAt(IPHONE.sends.s1, 216.7), one = greyAt(IPHONE.sends.s3, 216.7);
  assert.ok(two < 0.8 && one > 0.95, `at 217ms the two-line grey is ${two} and the one-line ${one}`);
  // the grey firms up with delivery while airborne, and the face follows it
  const s3 = flyFirst();
  s3.p.fill = SAVED;
  s3.frame(160);
  assert.equal(s3.face().style.background, SAVED);
});

test("the flight takes the iPhone's 750ms, and the bubble takes over a frame after it lands", () => {
  const s = flyFirst();
  for (const ms of [400, 717, 733]) {
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

test("what stood before makes room on the iPhone's glide, quicker than the bubble rises", () => {
  // the six sends' earlier messages, the middle of them at each frame
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
  assert.equal(glide.options.easing, "cubic-bezier(.24,.1,.15,1)", "the glide is not the iPhone's curve");
  const curve = bezier([0.24, 0.1, 0.15, 1]);
  for (const [ms, value] of IPHONE.glide)
    near(curve(ms / 340), value, `the glide at ${ms}ms against the iPhone's`, 0.017);
  const f = flyFirst();
  f.frame(100);
  const up = (FIELD.top - edges(f).top) / (FIELD.top - BUBBLE.top);
  assert.ok(curve(100 / 340) - up > 0.4, `the glide is not well ahead of the rise at 100ms (${curve(100 / 340)} against ${up})`);
});

test("a later send flies to its row's laid-out place, not to the glide its own send gives the panel", () => {
  // the new row stands inside the shared panel, which this send glides up from
  // where it stood: the flight drawn with the glide part way must be the one
  // drawn with no glide at all, landing on the row's laid-out place
  const make = () => {
    const s = scene();
    const p = s.panel(["Looks good, ship it"]);
    box(p, BUBBLE);
    const motion = s.context.armSentMotion(s.el);
    const row = s.row("One more thing");
    p.querySelector(".answstack").appendChild(row);
    const grown = { left: BUBBLE.left, top: BUBBLE.top - 42, width: BUBBLE.width, height: BUBBLE.height + 42 };
    box(p, grown);
    box(p.querySelector(".answclip"), { left: 217.4, top: grown.top + 15.76, width: 124.5, height: 63 });
    const seat = { left: 217.4, top: grown.top + 15.76 + 42, width: 124.5, height: 21 };
    box(row, seat);
    box(p.querySelector(".answmsg"), { left: 217.4, top: grown.top + 15.76, width: 124.5, height: 21 });
    return { s, p, motion, seat };
  };
  const MS = [40, 80, 160, 300, 500];
  // the same send with the panel never drawn moving
  const still = make();
  still.motion.play();
  const unmoved = MS.map(ms => { still.s.frame(ms); return edges(still.s); });
  const gliding = make();
  gliding.motion.play();
  const glide = gliding.p.animations.at(-1);
  assert.ok(glide, "the panel did not glide from where it stood");
  assert.equal(glide.keys[0].transform.trim(), "translate(0px,42px)");
  const curve = bezier([0.24, 0.1, 0.15, 1]);
  MS.forEach((ms, i) => {
    // the browser drawing the glide part way: the panel and all in it lower by what is left
    const left = 42 * (1 - curve(ms / 340));
    gliding.p.shiftY = left;
    gliding.p.transform = `matrix(1, 0, 0, 1, 0, ${left})`;
    gliding.s.frame(ms);
    const a = edges(gliding.s);
    for (const key of ["left", "right", "top", "height"]) near(a[key], unmoved[i][key], `the shell's ${key} at ${ms}ms`, 1e-6);
    assert.equal(gliding.s.layers()[0].style.opacity, "1", `the words are not at full strength at ${ms}ms`);
  });
  gliding.p.shiftY = 0;
  gliding.p.transform = "none";
  gliding.s.frame(FLIGHT_MS);
  near(px(gliding.s.shell().style.top), gliding.seat.top, "the landing");
  near(px(gliding.s.shell().style.height), gliding.seat.height, "the landing's height");
  near(edges(gliding.s).right, gliding.seat.left + gliding.seat.width, "the landing's right end");
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
  }
  const landed = edges(s);
  near(landed.right, cut.left + cut.width, "the box did not land on the cut's right end");
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
