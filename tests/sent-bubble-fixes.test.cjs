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

test("a send moves sideways and up with no zoom in and out: nothing shrinks and grows back, no edge passes its landing", () => {
  for (const { ms, frame, box } of flight()) {
    // the box drawn is the travelling box itself, never scaled down about a corner
    assert.ok(Math.abs(box.width - (frame.right - frame.left)) < 1e-9, `the box is drawn at another size than it travels at ${ms}ms`);
    assert.ok(box.left >= FROM.left - 1e-9 && box.left <= TO.left + 1e-9, `the left edge passed its landing at ${ms}ms (${box.left})`);
    const right = box.left + box.width;
    assert.ok(right >= FROM.left + FROM.width - 1e-9 && right <= TO.left + TO.width + 1e-9, `the right end passed its landing at ${ms}ms (${right})`);
    assert.ok(box.top >= TO.top - 1e-9, `the top rose past its landing at ${ms}ms (${box.top})`);
  }
});

test("a send ends with an accordion-like compress: taller as it rises, then closing down onto the bubble under its landed top", () => {
  const frames = flight();
  let foot = Infinity, tallest = 0;
  for (const { ms, box } of frames) {
    const bottom = box.top + box.height;
    assert.ok(bottom <= foot + 1e-9 || ms === 0, `the box's foot went down at ${ms}ms`);
    foot = bottom;
    tallest = Math.max(tallest, box.height / TO.height);
  }
  assert.ok(tallest >= 1.15, `the box never stands taller than the bubble to close down from (${tallest.toFixed(3)})`);
  const landed = frames.find(f => Math.abs(f.box.top - TO.top) < 1e-9);
  assert.ok(landed, "the top never lands");
  const closing = frames.filter(f => f.ms >= landed.ms);
  assert.ok(closing.length >= 150, `the compress after the top lands is too short (${closing.length}ms)`);
  assert.ok(landed.box.height >= 1.1 * TO.height, `the box has nothing left to close when its top lands (${landed.box.height})`);
  for (let i = 1; i < closing.length; i++)
    assert.ok(closing[i].box.height <= closing[i - 1].box.height + 1e-9, `the box grew again while closing at ${closing[i].ms}ms`);
  const end = frames.at(-1).box;
  assert.ok(Math.abs(end.height - TO.height) < 1e-9 && Math.abs(end.top - TO.top) < 1e-9, "the box does not close exactly onto the bubble");
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
  function fly() {
    const motion = context.armSentMotion(el);
    const p = element("div", "answered sent");
    const clip = element("div", "answclip"), stack = element("div", "answstack"), row = element("div", "answmsg");
    p.appendChild(clip); clip.appendChild(stack); stack.appendChild(row);
    sentwrap.appendChild(p);
    el.sent = p;
    set(p, TO);
    set(row, { left: TO.left + 18, top: TO.top + 16, width: TO.width - 36, height: 21 });
    motion.play();
    return p;
  }
  const frame = now => { clock.now = now; for (const fn of frames.splice(0)) fn(now); };
  const shell = () => body.children.find(n => n.classes.has("sentmorph")) || null;
  const box = () => { const s = shell().style; return { left: parseFloat(s.left), top: parseFloat(s.top), width: parseFloat(s.width), height: parseFloat(s.height) }; };
  return { context, el, fly, frame, shell, box, log, logging: on => { if (on) log.length = 0; logging = on; } };
}

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
