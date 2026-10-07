// The owner's fixes to the sent bubbles,
// one group of checks for each, every one of them failing on the code before
// the fix. No browser and no board runs: card-logic.js is loaded into a bare
// context and given synthetic boxes, and the sheets are read as text, so
// nothing here claims how it looks.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");

function load(extra = {}) {
  const context = vm.createContext({ console, ...extra });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  // the file's constants are not properties of the context; this reads them
  context.read = name => vm.runInContext(name, context);
  return context;
}

// ---- 1. the send motion: sideways, then up, then an accordion-like compress -------------
// the phone's one-line example: the typing box, and the bubble the send lands on
const FROM = { left: 17.5, top: 500, width: 317.6, height: 43.3 };
const TO = { left: 199.7, top: 422.1, width: 160, height: 52.5 };
function flight() {
  const c = load();
  const out = [], length = c.read("SENT_FLIGHT_MS");
  assert.ok(length > 0, "the flight has no length");
  for (let ms = 0; ms <= length; ms++) {
    const at = c.sentTrack(ms);
    const { frame, box } = c.sentMorphBox(FROM, TO, at);
    out.push({ ms, at, frame, box });
  }
  return out;
}

test("a send moves sideways and up with no zoom in and out: nothing shrinks and grows back, the right end, top and foot pass no landing", () => {
  for (const { ms, frame, box } of flight()) {
    // the box drawn is a real box and never scaled down about a corner: the
    // frame's right end, and its left edge at or left of the frame's, which
    // is the compress and not a change of scale
    assert.ok(Math.abs(box.left + box.width - frame.right) < 1e-9, `the box is drawn at another right end than it travels at ${ms}ms`);
    assert.ok(box.left <= frame.left + 1e-9 && box.width >= frame.right - frame.left - 1e-9, `the box is narrower than it travels at ${ms}ms`);
    // the left edge trails the words, so it may be left of the bubble's, but it
    // is never left of the typing box's and never right of the bubble's
    assert.ok(box.left >= FROM.left - 1e-9 && box.left <= TO.left + 1e-9, `the left edge is out of its run at ${ms}ms (${box.left})`);
    const right = box.left + box.width;
    assert.ok(right >= FROM.left + FROM.width - 1e-9 && right <= TO.left + TO.width + 1e-9, `the right end passed its landing at ${ms}ms (${right})`);
    assert.ok(box.top >= TO.top - 1e-9, `the top rose past its landing at ${ms}ms (${box.top})`);
  }
});

test("a send ends with an accordion-like compress from side to side: the box stands wider than the bubble as it arrives, then closes in onto its width", () => {
  const frames = flight();
  const right = f => f.box.left + f.box.width;
  // the right end is the bubble's from the moment the sideways move lands
  const landedSide = frames.find(f => Math.abs(right(f) - (TO.left + TO.width)) < 1e-9);
  assert.ok(landedSide, "the right end never lands on the bubble's");
  for (const f of frames.filter(f => f.ms >= landedSide.ms))
    assert.ok(Math.abs(right(f) - (TO.left + TO.width)) < 1e-9, `the right end left the bubble's at ${f.ms}ms (${right(f)})`);
  // widest at the peak, a fifth over the bubble, with time left to close
  const widest = frames.filter(f => f.ms >= landedSide.ms).reduce((a, b) => b.box.width > a.box.width ? b : a);
  const peak = load().read("SENT_SQUEEZE_PEAK_MS");
  assert.ok(Math.abs(widest.ms - peak) <= 2, `the box is widest at ${widest.ms}ms, not at the peak (${peak}ms)`);
  assert.ok(widest.box.width >= 1.15 * TO.width && widest.box.width <= 1.3 * TO.width,
    `the box is not a little wider than the bubble at its widest (${(widest.box.width / TO.width).toFixed(3)})`);
  // from there it only closes: the width shrinks and the left edge comes in,
  // for at least 300ms, and settles on the bubble
  const closing = frames.filter(f => f.ms >= widest.ms);
  assert.ok(closing.length >= 300, `the compress after its widest is too short (${closing.length}ms)`);
  for (let i = 1; i < closing.length; i++) {
    assert.ok(closing[i].box.width <= closing[i - 1].box.width + 1e-9, `the box widened again while closing at ${closing[i].ms}ms`);
    assert.ok(closing[i].box.left >= closing[i - 1].box.left - 1e-9, `the left edge went back while closing at ${closing[i].ms}ms`);
  }
  // nothing here is vertical: the box is never taller than the bubble, and its
  // height is the frame's own on the way up, never stretched under the top
  for (const { ms, box, frame } of frames) {
    assert.ok(box.height <= Math.max(FROM.height, TO.height) + 1e-9, `the box is taller than the bubble at ${ms}ms (${box.height})`);
    assert.ok(Math.abs(box.height - (frame.bottom - frame.top)) < 1e-9, `the box is stretched under its top at ${ms}ms`);
  }
  const end = frames.at(-1).box;
  assert.ok(Math.abs(end.width - TO.width) < 1e-9 && Math.abs(end.left - TO.left) < 1e-9 &&
    Math.abs(end.height - TO.height) < 1e-9 && Math.abs(end.top - TO.top) < 1e-9, "the box does not close exactly onto the bubble");
});

test("the compress stays inside the card's own padding: where the bubble is as wide as the typing row it reaches that far left and no further", () => {
  // the iPhone simulator's one-line send: the card 9.5 to 380.5 across, the
  // typing row 52.8 to 335.2 (a "+" stands left of it), the bubble 68.7 to
  // 359.8. The bubble's right end is 20.7 in from the card's right edge, so
  // the box may reach 20.7 in from the card's left edge: 30.2
  const CARD = { left: 9.5, top: 11.8, width: 371, height: 614.3 };
  const ROW = { left: 52.8, top: 560.1, width: 282.4, height: 66 };
  const BUBBLE = { left: 68.7, top: 484.1, width: 291.1, height: 73.5 };
  const padding = CARD.left + (CARD.left + CARD.width - (BUBBLE.left + BUBBLE.width));
  const p = page();
  p.set(p.el.box, CARD);
  p.set(p.el.ta, ROW);
  p.seat(p.arm(), BUBBLE);
  let leftmost = Infinity, widest = 0, before = null;
  for (const ms of [1000 / 60, ...Array.from({ length: 634 }, (_, i) => 17 + i)]) {
    p.frame(ms);
    const b = p.box();
    assert.ok(b.left >= padding - 1e-6, `the box reaches past the card's padding at ${ms}ms (${b.left} against ${padding})`);
    assert.ok(b.left + b.width <= BUBBLE.left + BUBBLE.width + 1e-6, `the right end passed the bubble's at ${ms}ms`);
    assert.ok(b.height <= Math.max(ROW.height, BUBBLE.height) + 1e-6, `the box is taller than the bubble at ${ms}ms (${b.height})`);
    if (ms >= 330) assert.ok(before === null || b.width <= before + 1e-6, `the box widened again after its peak at ${ms}ms`);
    if (ms >= 330) before = b.width;
    leftmost = Math.min(leftmost, b.left);
    widest = Math.max(widest, ms >= 260 ? b.width : 0);
  }
  assert.ok(Math.abs(leftmost - padding) < 0.01, `the box never reaches the card's padding (${leftmost} against ${padding})`);
  assert.ok(widest > BUBBLE.width + 30, `the box is hardly wider than the bubble at its widest (${widest})`);
  const end = p.box();
  for (const [key, want] of Object.entries(BUBBLE)) assert.ok(Math.abs(end[key] - want) < 1e-6, `the box did not land on the bubble's ${key} (${end[key]})`);
});

// ---- a stand-in page for a flight -------------------------------------------------------
// just enough of a page for armSentMotion: elements with boxes, styles that
// note every write, and reads of boxes and computed styles that note every
// read, so the order a frame reads and writes the page in can be checked
function page() {
  const log = [];
  let logging = false;
  const note = what => { if (logging) log.push(what); };
  function style() {
    const props = {};
    const api = {
      setProperty(name, value) { note("write"); props[name] = String(value); },
      getPropertyValue(name) { return props[name] || ""; },
      getPropertyPriority() { return ""; },
      removeProperty(name) { delete props[name]; },
    };
    return new Proxy(api, {
      get: (target, key) => key in target ? target[key] : props[key] || "",
      set: (target, key, value) => { note("write"); props[key] = String(value); return true; },
    });
  }
  const body = element("body");
  function element(tag = "div", cls = "") {
    const node = {
      tagName: tag.toUpperCase(), classes: new Set(cls.split(/\s+/).filter(Boolean)), style: style(),
      dataset: {}, attrs: {}, children: [], parentElement: null, layout: { left: 0, top: 0, width: 0, height: 0 },
      offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollLeft: 0, value: "", textContent: "",
      font: 15, line: 21, fill: "rgb(243, 243, 243)", radius: 18,
      get className() { return [...node.classes].join(" "); },
      set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
      classList: {
        add: (...n) => n.forEach(x => node.classes.add(x)), remove: (...n) => n.forEach(x => node.classes.delete(x)),
        contains: n => node.classes.has(n),
        toggle: (n, on) => ((on === undefined ? !node.classes.has(n) : on) ? node.classes.add(n) : node.classes.delete(n)),
      },
      get isConnected() { let at = node; while (at.parentElement) at = at.parentElement; return at === body; },
      getBoundingClientRect() {
        note("read");
        const r = node.layout;
        return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
      },
      setAttribute: (k, v) => { node.attrs[k] = v; }, getAttribute: k => node.attrs[k] ?? null, removeAttribute: k => { delete node.attrs[k]; },
      appendChild(child) { child.remove(); node.children.push(child); child.parentElement = node; return child; },
      append: (...kids) => kids.forEach(kid => node.appendChild(kid)),
      remove() { const p = node.parentElement; if (p){ p.children.splice(p.children.indexOf(node), 1); node.parentElement = null; } },
      querySelectorAll(sel) {
        const out = [], want = sel.split(",").map(s => s.trim());
        const walk = at => at.children.forEach(kid => { if (want.some(w => w.startsWith(".") ? kid.classes.has(w.slice(1)) : kid.tagName === w.toUpperCase())) out.push(kid); walk(kid); });
        walk(node);
        return out;
      },
      querySelector: sel => node.querySelectorAll(sel)[0] || null,
      cloneNode(deep) { const copy = element(tag, [...node.classes].join(" ")); if (deep) node.children.forEach(k => copy.appendChild(k.cloneNode(true))); return copy; },
      animate: () => ({ cancel() {} }),
    };
    return node;
  }
  const set = (node, r) => { node.layout = r; node.offsetWidth = r.width; node.offsetHeight = r.height; };
  const frames = [];
  const clock = { now: 0 };
  const context = load({
    document: { body, createElement: tag => element(tag) },
    performance: { now: () => clock.now },
    requestAnimationFrame: fn => frames.push(fn), cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    matchMedia: () => ({ matches: false }),
    getComputedStyle: node => {
      note("read");
      return { visibility: "visible", display: "block", transform: "none", opacity: "1",
        fontSize: node.font + "px", lineHeight: node.line + "px", paddingLeft: "0px", paddingTop: "0px",
        backgroundColor: node.fill, borderTopLeftRadius: node.radius + "px", borderTopRightRadius: node.radius + "px",
        borderBottomRightRadius: node.radius + "px", borderBottomLeftRadius: node.radius + "px",
        getPropertyValue: name => name === "--card" ? "#ffffff" : name === "--answ-fill" ? node.fill : "" };
    },
  });
  const card = element("div", "box");
  body.appendChild(card);
  const ta = element("textarea");
  card.appendChild(ta);
  set(ta, FROM);
  ta.font = 17; ta.line = 25.5;
  ta.value = "Looks good, ship it";
  const sentwrap = element("div", "sentwrap");
  card.appendChild(sentwrap);
  const el = { box: card, ta, sent: null, sentwrap, answwrap: null, reply: null };
  // arm, put the new bubble in the seat, lay it out at TO, and play
  const arm = () => context.armSentMotion(el);
  const fly = () => seat(arm());
  function seat(motion, landing = TO) {
    const p = element("div", "answered sent");
    const clip = element("div", "answclip"), stack = element("div", "answstack"), row = element("div", "answmsg");
    p.appendChild(clip); clip.appendChild(stack); stack.appendChild(row);
    sentwrap.appendChild(p);
    el.sent = p;
    set(p, landing);
    set(row, { left: landing.left + 18, top: landing.top + 16, width: landing.width - 36, height: 21 });
    motion.play();
    return p;
  }
  const frame = now => { clock.now = now; for (const fn of frames.splice(0)) fn(now); };
  const shell = () => body.children.find(n => n.classes.has("sentmorph")) || null;
  const box = () => { const s = shell().style; return { left: parseFloat(s.left), top: parseFloat(s.top), width: parseFloat(s.width), height: parseFloat(s.height) }; };
  return { context, el, arm, seat, fly, frame, shell, box, make: element, set, log,
    logging: on => { if (on) log.length = 0; logging = on; } };
}

// ---- 2. a clear gap under Delivered and Read before the next bubble ---------------------
test("the word under a bubble has clear room under it before the next bubble, more than over it", () => {
  // in --u: the word stands under its bubble, 3 down, on a line of 10.5 at 1.35,
  // in the bubble's room (--answ-tag); the next bubble starts after that room
  // and any step a bubble after another takes
  const css = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const units = text => { const m = /calc\(([\d.]+) \* var\(--u\)\)/.exec(text || ""); return m ? +m[1] : 0; };
  const tag = units(/--answ-tag:([^;}]+)/.exec(css)[1]);
  const word = /\.answered\[data-mark\]::after\{[^}]*padding-top:([^;]+);[^}]*font:calc\(([\d.]+) \* var\(--u\)\)\/([\d.]+)/.exec(css);
  assert.ok(word, "the word's rule moved");
  const over = units(word[1]), line = +word[2] * +word[3];
  const step = /\n\.answered\.sent \+ \.answered\.sent\{margin-top:([^;}]+)/.exec(css);
  const under = tag - over - line + (step ? units(step[1]) : 0);
  assert.ok(under >= 8, `the word's line ends ${under.toFixed(2)}u from the next bubble`);
  assert.ok(under > over, `the word stands nearer the next bubble (${under.toFixed(2)}u) than its own (${over}u)`);
  // the step is never run as a transition: the bubbles' own glides carry it
  for (const rule of css.match(/transition:[^;}]+/g) || []) assert.doesNotMatch(rule, /margin-top/);
});

// ---- 3. the agent's answer stands still while the bubbles move and merge -----------------
// a scroller the answer stands in: its content is the answer, the band's run-out
// at its foot, and any slack held there
function scroller({ top = 0, client = 500, answer = 1810 } = {}) {
  const props = {};
  return {
    scrollTop: top, clientHeight: client, band: 0,
    get scrollHeight() { return answer + this.band + (parseFloat(props["--answ-slack"]) || 0); },
    style: { setProperty: (k, v) => { props[k] = String(v); }, getPropertyValue: k => props[k] || "", removeProperty: k => { delete props[k]; } },
    addEventListener() {},
  };
}

test("a band coming down under the bubbles never pulls the answer's scroll: its room is held, then let go where the reader is not", () => {
  // the reader at the very end of the answer (1810 + 190 - 500), or at its head
  for (const [where, top] of [["at its end", 1500], ["at its head", 0]]) {
    const frames = [];
    const c = load({ requestAnimationFrame: fn => frames.push(fn) });
    const view = scroller({ top });
    const el = { replyview: view, sentwrap: { children: [] } };
    view.band = c.sentBand(el, 190);
    // two bubbles join and the seat comes down by 27px
    view.band = c.sentBand(el, 163);
    assert.equal(view.band, 163);
    assert.ok(view.scrollHeight - view.clientHeight >= top, `the scroll would be pulled back (${where})`);
    assert.equal(c.heldSlack(view), 27, `the room the band gave up was not held under the answer (${where})`);
    // a frame later, once the new band stands
    for (const fn of frames.splice(0)) fn();
    assert.equal(c.heldSlack(view), top ? 27 : 0, `the held room was not let go as far as the reader does not stand on it (${where})`);
  }
});

test("a send never glides the answer, whatever moved it", () => {
  const s = page();
  const moved = [];
  for (const key of ["reply", "answwrap"]) {
    const part = s.make("div");
    s.el.box.appendChild(part);
    s.set(part, { left: 20, top: 70, width: 300, height: 120 });
    part.animate = () => { moved.push(key); return { cancel() {} }; };
    s.el[key] = part;
  }
  const motion = s.arm();
  // something lays the answer out 20px higher while the bubble takes its room
  for (const key of ["reply", "answwrap"]) s.set(s.el[key], { left: 20, top: 50, width: 300, height: 120 });
  s.seat(motion);
  assert.deepEqual(moved, [], "the answer glided with the send");
});

test("the merge never glides the answer either", () => {
  const merge = LOGIC.slice(LOGIC.indexOf("function sentMerge(el, run){"), LOGIC.indexOf("function sentMergeLand(el){"));
  const around = merge.slice(merge.indexOf("const around ="), merge.indexOf(";", merge.indexOf("const around =")));
  assert.ok(around, "the merge names nothing it moves");
  assert.doesNotMatch(around, /el\.reply|el\.answwrap/, "the merge moves the answer");
});

test("the Mac board's snap fits the answer the same whatever stands in the bubbles' seat", () => {
  // the desktop's own boxBand and snapCard, run on a stand-in card: the answer's
  // scroller 500px tall, its line 28px, the bar 40px under it, and a seat of
  // bubbles of three heights over the bar
  const DESKTOP = readFileSync(path.join(ROOT, "index.html"), "utf8");
  const fn = name => { const at = DESKTOP.indexOf("function " + name + "("); return DESKTOP.slice(at, DESKTOP.indexOf("\n}\n", at) + 2); };
  const written = [];
  for (const seat of [0, 73, 150]) {
    const style = () => { const p = {}; return new Proxy({ getPropertyValue: k => p[k] || "", setProperty: (k, v) => { p[k] = v; } }, { get: (t, k) => k in t ? t[k] : p[k] || "", set: (t, k, v) => { p[k] = String(v); return true; } }); };
    const rect = r => () => ({ left: 0, right: 0, width: 0, ...r, bottom: r.top + r.height });
    const first = { getBoundingClientRect: rect({ top: 100, height: 28 }) };
    const reply = { style: style(), children: [first] };
    const view = { style: style(), scrollTop: 0, getBoundingClientRect: rect({ top: 100, height: 500 }) };
    const pendwrap = { getBoundingClientRect: rect({ top: 560 - seat, height: 40 + seat }) };
    const sentwrap = { getBoundingClientRect: rect({ top: 560 - seat, height: seat }) };
    const head = { style: style() };
    const el = { box: { classList: { contains: c => c === "sel" }, querySelector: () => head },
      reply, replyview: view, pendwrap, sentwrap, answ: null, answwrap: null, titleEl: { style: style() } };
    const context = vm.createContext({
      FOCUS: true, els: { card: el }, selectedId: "card",
      sentPanels: () => [], tiltTitleAir: () => {},
      getComputedStyle: node => ({ lineHeight: "28px", marginBottom: node === view ? "3.5px" : "0px", paddingTop: "0px", font: "18px x" }),
    });
    vm.runInContext(fn("boxBand") + fn("snapCard"), context);
    vm.runInContext("snapCard()", context);
    written.push(view.style.marginTop);
  }
  assert.ok(written[0], "the snap wrote nothing");
  assert.deepEqual(written, [written[0], written[0], written[0]], `the answer was snapped to another place for each seat: ${written.join(", ")}`);
});

// ---- 4. the fade over the answer does not jump once a bubble stands open ----------------
test("the answer's fade follows a bubble opening and cut back on every frame, so nothing changes once it stops", () => {
  // a bubble opening from 58px to 240px and cut back again, as openAnswered
  // leaves it for the length of each run (answSpan), and the band the page
  // measures to its top edge on each frame: the band written on the frame the
  // run lands must already be the one the open (or cut) bubble stands at
  const c = load({ requestAnimationFrame: () => 0 });
  const clip = { height: 58, getBoundingClientRect() { return { height: this.height }; } };
  const panel = { classList: { contains: k => k === "answered" }, answSpan: null, querySelector: () => clip };
  const el = { sentwrap: { children: [panel] } };
  const run = (from, to, steps) => {
    panel.answSpan = { from, to, band: null };
    const written = [];
    for (const h of steps){ clip.height = h; written.push(c.sentBand(el, 60 + h)); }
    panel.answSpan = null;
    const landed = c.sentBand(el, 60 + to);
    return { written, landed };
  };
  const open = run(58, 240, [58, 100, 160, 210, 240]);
  assert.deepEqual(open.written, [118, 160, 220, 270, 300], "the band did not follow the bubble opening");
  assert.equal(open.landed, open.written.at(-1), "the band jumped once the bubble stood open");
  const cut = run(240, 58, [240, 180, 110, 70, 58]);
  assert.equal(cut.written[0], 300, "the band left the bubble's top edge as the cut back set off");
  assert.deepEqual(cut.written, [300, 240, 170, 130, 118], "the band did not follow the bubble coming down");
  assert.equal(cut.landed, cut.written.at(-1));
});

// ---- 7. a shorter message moves left at a gentler pace as the bubbles join ---------------
test("as two bubbles join, the shorter message moves left at a gentler pace and still lands before the joined bubble comes up", () => {
  // the share of its sideways move a shorter message's words (and its drop's
  // edge) have made at each ms of the 1000ms merge: before, 450ms on a smooth
  // step, its fastest a third of the whole move in 100ms
  const c = load();
  const spec = { U0: { left: 0, top: 0, right: 300, bottom: 50 }, L0: { left: 200, top: 76, right: 300, bottom: 126 },
    U1: { left: 0, top: 0, right: 300, bottom: 68 }, L1: { left: 0, top: 50, right: 300, bottom: 100 }, r: 18 };
  const travel = c.read("MERGE_TRAVEL"), length = c.read("MERGE_MS");
  let peak = 0, from = null, to = null, prev = 0;
  for (let ms = 0; ms <= length; ms++) {
    const ew = c.sentMergeShape(spec, ms / length).ew;
    assert.ok(ew >= prev - 1e-12, `the move went back at ${ms}ms`);
    peak = Math.max(peak, (ew - prev) * 1000);
    if (from === null && ew > .001) from = ms;
    if (to === null && ew >= .999) to = ms;
    prev = ew;
  }
  assert.ok(peak <= 2.2, `its fastest is ${peak.toFixed(2)} of the move a second`);
  assert.ok(to - from >= 600, `the move takes only ${to - from}ms`);
  assert.equal(c.sentMergeShape(spec, travel).ew, 1, "the words have not landed when the joined bubble starts to come up");
});

// ---- 5. no Open and Download under an attachment ----------------------------------------
test("an attachment shows its name with no Open and Download links: a document's name opens it, a player stays a player", () => {
  // every message and answer is drawn by the shared renderer, sent bubbles and
  // the Mac's chat included, so this is what all of them show
  const markdown = require(path.join(ROOT, "card-markdown.js"));
  const files = {
    pdf: "/uploads/1791398534302337000-Meeting%20report.pdf", doc: "/uploads/1791398534302337001-Notes.docx",
    audio: "/uploads/1791398534302337002-Voice%20memo.wav", video: "/uploads/1791398534302337003-Clip.mp4",
  };
  for (const [kind, file] of Object.entries(files)) {
    const html = markdown.render("Here it is:\n\n" + file);
    assert.doesNotMatch(html, />\s*Open\s*</, `${kind}: an Open link stands under it`);
    assert.doesNotMatch(html, />\s*Download\s*</, `${kind}: a Download link stands under it`);
    assert.doesNotMatch(html, /attachment-links|download=1|\sdownload[\s>]/, `${kind}: download markup is drawn`);
    const name = /class="attachment-name"[^>]*>([^<]+)</.exec(html);
    assert.ok(name, `${kind}: the file's name is not shown`);
    assert.doesNotMatch(name[1], /^\d{13}/, `${kind}: the name carries the upload's stamp`);
    if (kind === "pdf" || kind === "doc")
      assert.match(html, new RegExp('<a class="attachment-name" href="' + file.replace(/[.]/g, "\\.") + '" target="_blank" rel="noopener">'),
        `${kind}: the document's name is not its link`);
    else assert.match(html, new RegExp("<" + kind + " controls"), `${kind}: the player is gone`);
  }
  // an image is still drawn as a picture
  assert.match(markdown.render("/uploads/1791398534302337004-plot.png"), /<img class="shot"/);
});

// ---- 6. the send flight on the Mac: no pause as it flies out, no lag ---------------------
test("the first frame drawn after a send already has the box on its way, on time or late", () => {
  for (const first of [1000 / 60, 500]) {
    const s = page();
    s.fly();
    const start = s.box();
    s.frame(first);
    const got = s.box(), want = s.context.sentMorphBox(FROM, TO, s.context.sentTrack(1000 / 60)).box;
    assert.ok((got.left - start.left) / (TO.left - FROM.left) >= 0.1,
      `the box stands on the row on the first frame drawn at ${first.toFixed(1)}ms (left ${got.left})`);
    for (const key of ["left", "top", "width", "height"])
      assert.ok(Math.abs(got[key] - want[key]) < 1e-6, `the first frame drawn at ${first.toFixed(1)}ms is not one frame into the flight (${key} ${got[key]}, ${want[key]})`);
  }
});

test("a frame of the flight reads the page before it writes to it, so the page is laid out once a frame", () => {
  const s = page();
  s.fly();
  s.frame(1000 / 60);
  for (const now of [100, 200, 300]) {
    s.logging(true);
    s.frame(now);
    s.logging(false);
    const firstWrite = s.log.indexOf("write"), lastRead = s.log.lastIndexOf("read");
    assert.ok(firstWrite >= 0 && lastRead >= 0, "the frame neither read nor wrote");
    assert.ok(lastRead < firstWrite, `the frame at ${now}ms read the page after writing to it (${s.log.join(" ")})`);
  }
});

test("the flying box has a layer of its own, so the page under it is not painted again as it moves", () => {
  const css = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(".sentmorph{");
  assert.ok(at >= 0, "no rule for the flying box");
  assert.match(css.slice(at, css.indexOf("}", at)), /will-change:transform/);
});
