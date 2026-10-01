// the panel of messages a reply was given, the same panel holding what has been
// sent and not answered yet, and the page turn between the two, with no browser
// and no board. the real card-logic.js and card-markdown.js run in a sandbox
// over a small stand-in dom, so the markup the panels are built from, the batch
// each reply shows, the history stepper's own batches, the press that opens and
// cuts back a long batch on the old answered box's fold run, a send landing the
// sent panel cut, and the order of a page turn are all read off the code the
// pages ship. the stand-in lays nothing out: a test writes the heights a browser
// would report, and ends a run by firing the transition's end or the timer
// behind it. what a browser alone can say, how it looks and how the motion runs
// on screen, is not claimed here: the sheet and the pages are read as text only
// for the rules and the wiring the design rests on. every card, reply and
// message below is invented.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const TOKENS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
const DESKTOP = readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const markdown = require("../card-markdown.js");

// ---- the stand-in dom ---------------------------------------------------------
// just enough of an element for the panel: classes, attributes, children, a
// click, inline style with a record of every height written, and an innerHTML
// that builds the child elements its tags name, and the text between them as
// text nodes, so the panel's own markup and its words can be walked. a text
// node reports whatever line boxes a test lays it out on (rects), and an
// element can be given a box of its own (rect), the way a picture has one
const VOID = new Set(["br", "img", "hr", "input", "source", "wbr"]);
function textNode(text) {
  const node = {
    nodeType: 3, textContent: text, parentNode: null, rects: [],
    remove() {
      const parent = node.parentNode;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(node), 1);
      node.parentNode = null;
    },
  };
  return node;
}
function inlineStyle() {
  const props = {};
  return {
    heights: [],
    // every transform written, in order, the way heights are kept
    transforms: [],
    get transform() { return props.transform || ""; },
    set transform(value) {
      if (value) props.transform = String(value); else delete props.transform;
      this.transforms.push(String(value));
    },
    setProperty(name, value) { props[name] = String(value); },
    removeProperty(name) { delete props[name]; },
    getPropertyValue(name) { return props[name] || ""; },
    get height() { return props.height || ""; },
    set height(value) {
      if (value) { props.height = String(value); this.heights.push(String(value)); }
      else delete props.height;
    },
  };
}
// the height a browser would report for a node. the cut stands at whatever is
// written inline, else at its full batch while open or running, else at the
// stop the script wrote, else at the preview the test says the sheet cuts it
// to. midRun stands for a run caught part way, so it only holds while a run
// has its height written in
function laidOutHeight(node) {
  if (node.midRun != null && node.style.height) return node.midRun;
  if (node.style.height) return parseFloat(node.style.height);
  const panel = node.parentNode;
  if (node.classList.contains("answclip") && panel &&
      (panel.classList.contains("open") || panel.classList.contains("motion"))) return node.scrollHeight;
  const stop = node.style.getPropertyValue("--answ-stop");
  if (stop) return parseFloat(stop);
  return node.clientHeight;
}
function element(tag) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  const nodes = [];
  let html = "";
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1,
    parentNode: null, dataset: {}, style: inlineStyle(), id: "",
    clientHeight: 0, scrollHeight: 0, scrollTop: 0, offsetWidth: 0, midRun: null, midShade: null, rect: null,
    get parentElement() { return el.parentNode; },
    get childNodes() { return nodes; },
    get children() { return nodes.filter(node => node.nodeType === 1); },
    getBoundingClientRect() {
      if (el.rect) return { ...el.rect, left: 0, right: 0, width: 0, height: el.rect.bottom - el.rect.top };
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: laidOutHeight(el) };
    },
    // a copy of the node and, deep, of everything under it: its classes and its
    // data, which is what a still picture of it is read by here
    cloneNode(deep) {
      const copy = element(tag);
      copy.className = el.className;
      Object.assign(copy.dataset, el.dataset);
      if (deep) {
        for (const child of nodes)
          copy.appendChild(child.nodeType === 3 ? textNode(child.textContent) : child.cloneNode(true));
        copy.keepMarkup(html);
      }
      return copy;
    },
    keepMarkup(value) { html = value; },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    listening(type) { return (listeners[type] || []).length; },
    get className() { return [...classes].join(" "); },
    set className(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name);
    },
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : !!on;
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, event) { for (const fn of listeners[type] || []) fn(event); },
    appendChild(node) {
      node.remove();
      nodes.push(node);
      node.parentNode = el;
      return node;
    },
    append(...added) { for (const node of added) el.appendChild(node); },
    prepend(...added) {
      for (const node of [...added].reverse()) {
        node.remove();
        nodes.unshift(node);
        node.parentNode = el;
      }
    },
    remove() {
      const parent = el.parentNode;
      if (!parent) return;
      parent.childNodes.splice(parent.childNodes.indexOf(el), 1);
      el.parentNode = null;
    },
    get textContent() { return html; },
    set textContent(value) { clear(); html = String(value); },
    get innerHTML() { return html; },
    set innerHTML(value) { clear(); html = String(value); build(el, html); },
    querySelector(selector) { return all(el).find(node => matches(node, selector)) || null; },
    querySelectorAll(selector) { return all(el).filter(node => matches(node, selector)); },
    closest(selector) {
      for (let at = el; at; at = at.parentNode) if (matches(at, selector)) return at;
      return null;
    },
    contains(node) {
      for (let at = node; at; at = at.parentNode) if (at === el) return true;
      return false;
    },
  };
  function clear() {
    for (const child of nodes) child.parentNode = null;
    nodes.length = 0;
  }
  return el;
}
// every text node under a node, in document order
function textsOf(node) {
  const out = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out.push(child);
    else out.push(...textsOf(child));
  }
  return out;
}
// every element under a node, depth first, in document order
function all(node) {
  const out = [];
  for (const child of node.children) out.push(child, ...all(child));
  return out;
}
// a selector list of plain tags, plain classes, a tag with a class, a data
// attribute that is present, and a node under another
function matchesOne(node, part) {
  const attrs = [...part.matchAll(/\[data-([\w-]+)\]/g)].map(m => m[1].replace(/-(\w)/g, (_, c) => c.toUpperCase()));
  const [tag, ...cls] = part.replace(/\[[^\]]*\]/g, "").split(".");
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (!cls.every(name => node.classList.contains(name))) return false;
  return attrs.every(name => node.dataset && node.dataset[name] !== undefined);
}
function matches(node, selector) {
  return selector.split(",").map(part => part.trim()).some(part => {
    const chain = part.split(/\s+/);
    if (!matchesOne(node, chain.pop())) return false;
    let at = node.parentNode;
    for (let i = chain.length - 1; i >= 0; i--) {
      while (at && !matchesOne(at, chain[i])) at = at.parentNode;
      if (!at) return false;
      at = at.parentNode;
    }
    return true;
  });
}
// the tags of an html string, nested as written, and the text between them as
// text nodes where it falls
function build(parent, html) {
  const stack = [parent];
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (m.index > last) stack[stack.length - 1].appendChild(textNode(html.slice(last, m.index)));
    last = tags.lastIndex;
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = element(tag);
    const cls = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (cls) node.className = cls[1];
    stack[stack.length - 1].appendChild(node);
    if (!selfClosing && !VOID.has(tag.toLowerCase())) stack.push(node);
  }
  if (last < html.length) stack[stack.length - 1].appendChild(textNode(html.slice(last)));
}

// a size watch the test drives by hand, standing in for the browser's
class FakeResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
    this.live = true;
    FakeResizeObserver.made.push(this);
  }
  observe(target) { this.targets.push(target); }
  disconnect() { this.live = false; this.targets = []; }
  fire() { if (this.live) this.callback([]); }
}

// ---- the sandbox ------------------------------------------------------------------
// no localStorage is handed in on purpose: a panel that tried to remember a
// word about a reply would throw here rather than pass quietly. timers are held
// rather than run, so a test decides when the one behind a run goes off, and
// the reduced motion setting is the test's to turn on. animation frames are held
// too: frame() lets go of the callbacks waiting for one, and callbacks they ask
// for wait for the next
// the strength the sheet gives the dissolve at the cut: whole while a long batch
// stands cut, nothing otherwise, unless a run has written it inline
function shadeOf(clip) {
  const inline = clip.style.getPropertyValue("--answ-shade");
  if (inline) return inline;
  const panel = clip.parentNode;
  return panel && panel.classList.contains("more") && !panel.classList.contains("open") ? "1" : "0";
}
function sandbox() {
  FakeResizeObserver.made = [];
  const counts = { timers: 0, rooms: 0, again: 0 };
  const timers = new Map();
  const frames = new Map();
  let seq = 0;
  const context = vm.createContext({
    Date, Promise, console, AbortSignal, crypto: require("node:crypto").webcrypto,
    // a range reports the line boxes the test laid its text node out on, and a
    // query for the card's own motion finds whatever the test says is moving
    document: {
      createElement: element,
      createRange: () => ({
        node: null,
        selectNodeContents(node) { this.node = node; },
        getClientRects() { return this.node ? this.node.rects : []; },
      }),
      querySelector: selector =>
        selector.split(",").some(part => (context.moving || []).includes(part.trim())) ? {} : null,
    },
    CardMarkdown: markdown,
    line: 21,   // the panel's line, the desktop's own unless a test says otherwise
    ResizeObserver: FakeResizeObserver,
    setTimeout: (fn, ms) => { counts.timers++; timers.set(++seq, { fn, ms }); return seq; },
    clearTimeout: id => { timers.delete(id); },
    requestAnimationFrame: fn => { frames.set(++seq, fn); return seq; },
    cancelAnimationFrame: id => { frames.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    stillness: false,
    matchMedia: query => ({ matches: /prefers-reduced-motion: reduce/.test(query) && context.stillness }),
    // every node stands on the panel's one line, and the dissolve's strip reports
    // the strength it stands at: a run caught part way (midShade), or else what
    // the sheet and the inline hold give it
    getComputedStyle: (node, pseudo) => ({
      get lineHeight() { return context.line + "px"; },
      get opacity() {
        if (pseudo !== "::after") return "1";
        return node.midShade != null ? String(node.midShade) : shadeOf(node);
      },
      getPropertyValue(name) {
        const inline = node.style.getPropertyValue(name);
        if (inline) return inline;
        if (name === "--answ-shade") return shadeOf(node);
        return "";
      },
    }),
    picked: null,
    boxHasSelection: node => context.picked === node,
    roomSpy: () => { counts.rooms++; },
    againSpy: () => { counts.again++; },
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const run = source => vm.runInContext(source, context);
  // the timers waiting now, and a way to let the newest one go off
  const pending = () => [...timers.values()];
  const ring = () => {
    const [id, timer] = [...timers].pop();
    timers.delete(id);
    timer.fn();
  };
  // the newest timer waiting for this many ms, let go
  const ringFor = ms => {
    const found = [...timers].filter(([, timer]) => timer.ms === ms).pop();
    assert.ok(found, `no timer waits ${ms}ms`);
    timers.delete(found[0]);
    found[1].fn();
  };
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const fn of due) fn(0);
  };
  const waiting = () => frames.size;
  return { context, counts, run, pending, ring, ringFor, frame, waiting };
}
// the end of the height's transition on a panel's cut, as a browser fires it
function landRun(panel) {
  const clip = panel.querySelector(".answclip");
  clip.fire("transitionend", { target: clip, propertyName: "height" });
}
// lays the batch's words out the way a browser reports them: the nth text node
// of the column, in document order, stands on a line starting at tops[n], and
// its letters fill six sevenths of that line in the middle of it, the way the
// panel's face stands in its line. a null top leaves a node unlaid. with no
// tops given, every text node takes the next line down with no gaps
function layText(panel, line = 21, tops = null) {
  const texts = textsOf(panel.querySelector(".answstack"));
  const glyph = line * 6 / 7;
  texts.forEach((node, i) => {
    const top = tops ? tops[i] : i * line;
    node.rects = top == null ? [] :
      [{ top: top + (line - glyph) / 2, bottom: top + (line + glyph) / 2, height: glyph }];
  });
  return texts;
}
// a long batch laid out: its words on line after line, the sheet cutting it at
// a 58px preview over its 240px whole, and the size watch telling the panel so
function layOutLong(panel, watch) {
  const clip = panel.querySelector(".answclip");
  layText(panel);
  clip.clientHeight = 58; clip.scrollHeight = 240;
  watch.fire();
  return clip;
}
// a batch laid out by hand: the words on the tops given, the sheet's cut and the
// batch's whole height, and the watch telling the panel
function layOut(panel, watch, { tops, cut, whole, line = 21 }) {
  const clip = panel.querySelector(".answclip");
  const texts = layText(panel, line, tops);
  clip.clientHeight = cut; clip.scrollHeight = whole;
  watch.fire();
  return { clip, texts };
}

// a card as both pages build it: the scroller holding the empty seat over the
// answer, and the history marks the stepper writes
function card(id) {
  const box = element("div");
  box.id = "box-" + id;
  const replyview = element("div");
  replyview.className = "replyview";
  const answwrap = element("div");
  answwrap.className = "answwrap";
  const reply = element("div");
  reply.className = "reply cardmd";
  replyview.append(answwrap, reply);
  box.append(replyview);
  return { box, replyview, answwrap, reply, answ: null, answId: null,
           histPos: { textContent: "" }, histUp: { disabled: false }, histDown: { disabled: true } };
}

const LIVE = [
  { text: "I am guessing this is a table that prints out?\n\nInvented second paragraph of the first message.", ts: 1760000000 },
  { text: "Invented second message with **some emphasis**.", ts: 1760000010 },
  { text: "Invented third message, one line.", ts: 1760000020 },
];
const liveBox = (answered = LIVE) =>
  ({ id: "c1", replyKind: "agent", replyId: "reply-live", replyTs: 1760000100, answered });

// what the panel shows, read the way a reader would name it: one entry per
// message block, with the html the block holds
function blocks(panel) {
  return panel.querySelector(".answstack").children.map(node => ({ cls: node.className, html: node.innerHTML }));
}
const OLD_PARTS = ["pendlist", "pendhead", "pendbody", "pendstamp", "pendscroll", "pendslide",
  "pendmsg", "pendcontent", "ptime", "rcpt", "chev", "chevmid", "chevtop", "stamp"];

test("the live reply's messages are one plain panel of message blocks, in the order sent", () => {
  const { context, counts } = sandbox();
  const el = card("c1");
  const timers = counts.timers;
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ;
  assert.ok(panel, "no panel was mounted for a reply the board recorded a batch for");
  assert.equal(panel.parentNode, el.answwrap, "the panel is not in the seat over the answer");
  assert.equal(el.answwrap.children.length, 1, "the seat holds more than the one panel");
  assert.equal(panel.className, "answered");
  assert.equal(el.answId, "reply-live");
  assert.deepEqual(panel.children.map(node => node.className), ["answclip", "answfoot"],
    "the panel is not the cut over the strip at its foot");
  const foot = panel.children[1];
  assert.deepEqual(foot.children.map(node => node.className), ["answchev"], "the strip does not hold the one arrow");
  assert.equal(foot.children[0].tagName, "SVG", "the arrow is not the drawn chevron");
  assert.deepEqual(panel.querySelector(".answclip").children.map(node => node.className), ["answstack"]);
  assert.deepEqual(blocks(panel), LIVE.map(m => ({ cls: "answmsg cardmd", html: markdown.render(m.text) })),
    "the blocks are not the batch's messages, rendered by the card's own markdown, in order");
  // the old box's parts, the bubbles, the run stamp, the pulled times and the
  // receipts, are all gone: the words stand in the panel and nothing else does
  for (const node of all(panel))
    for (const name of OLD_PARTS)
      assert.ok(!node.classList.contains(name), `the panel still carries the old box's ${name}`);
  assert.ok(!/\d:\d\d/.test(blocks(panel).map(b => b.html).join("")), "a time is printed in the panel");
  assert.equal(panel.getAttribute("role"), "group");
  assert.equal(panel.getAttribute("aria-label"), "your messages that the reply below answers");
  // mounted cut and not open, and with nothing armed to open it later
  assert.equal(panel.classList.contains("open"), false, "the panel was mounted open");
  assert.equal(counts.timers, timers, "mounting the panel armed a timer");
});

test("several messages stack one block under another, and one message is one block", () => {
  const { context } = sandbox();
  const many = Array.from({ length: 6 }, (_, i) => ({ text: `Invented stacked message ${i + 1}.`, ts: 1760000000 + i }));
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox(many)));
  assert.deepEqual(blocks(el.answ).map(b => b.html), many.map(m => markdown.render(m.text)));
  const one = card("c2");
  context.syncAnswered(one, context.liveAnswered({ ...liveBox([many[0]]), id: "c2", replyId: "reply-one" }));
  assert.equal(blocks(one.answ).length, 1, "a batch of one is not one block");
});

test("an older reply in the history shows its own batch, and live shows the live batch again", async () => {
  const { context, run } = sandbox();
  const el = card("c1");
  el.reply.dataset.raw = "The invented live answer.";
  const live = liveBox();
  context.els = { c1: el };
  context.selectedId = "c1";
  context.lastState = { boxes: [live] };
  const older = [
    { id: "reply-first", ts: 1750000000, answered: [{ text: "Invented message the first reply was given.", ts: 1749999990 }] },
    { id: "reply-second", ts: 1755000000, answered: [
      { text: "Invented first message the second reply was given.", ts: 1754999980 },
      { text: "Invented second message the second reply was given.", ts: 1754999990 },
    ] },
  ];
  run(`histCache.c1 = Promise.resolve(Object.assign(
    ["The invented first answer.", "The invented second answer."], { meta: ${JSON.stringify(older)} }))`);
  context.syncAnswered(el, context.liveAnswered(live));
  const panel = el.answ;
  const html = batch => batch.map(m => markdown.render(m.text));

  await context.histStep("c1", 1);
  assert.equal(el.answ, panel, "a history step threw the panel away instead of refilling it");
  assert.equal(el.answId, "reply-second");
  assert.deepEqual(blocks(el.answ).map(b => b.html), html(older[1].answered),
    "one step back does not show the reply's own batch");
  await context.histStep("c1", 1);
  assert.equal(el.answId, "reply-first");
  assert.deepEqual(blocks(el.answ).map(b => b.html), html(older[0].answered),
    "two steps back does not show the oldest reply's own batch");
  await context.histStep("c1", -1);
  assert.deepEqual(blocks(el.answ).map(b => b.html), html(older[1].answered));
  await context.histStep("c1", -1);
  assert.equal(run("hist"), null, "the stepper did not come back to the live reply");
  assert.equal(el.answ, panel, "coming back to live threw the panel away");
  assert.equal(el.answId, "reply-live");
  assert.deepEqual(blocks(el.answ).map(b => b.html), html(LIVE), "live does not show the live batch again");
});

test("a reply with no batch, an empty one or a progress note shows no panel", () => {
  const { context } = sandbox();
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const watch = FakeResizeObserver.made[0];
  context.syncAnswered(el, context.liveAnswered({ ...liveBox([]), replyId: "reply-empty" }));
  assert.equal(el.answ, null, "an empty batch still shows a panel");
  assert.equal(el.answwrap.children.length, 0, "the seat was left holding a panel");
  assert.equal(watch.live, false, "the panel's size watch outlived the panel");
  context.syncAnswered(el, context.liveAnswered({ ...liveBox(null), replyId: "reply-unknown" }));
  assert.equal(el.answ, null, "a reply the board recorded nothing for shows a panel");
  context.syncAnswered(el, context.liveAnswered({ ...liveBox(), replyKind: "note" }));
  assert.equal(el.answ, null, "a progress note borrowed the answer's batch");
});

test("a pass carrying the same reply again touches nothing, and an open panel stays open", () => {
  const { context } = sandbox();
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  panel.fire("click", { target: panel });
  const kids = all(panel);
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  assert.equal(el.answ, panel);
  const now = all(panel);
  assert.ok(now.length === kids.length && now.every((node, i) => node === kids[i]),
    "a pass with the same reply rebuilt the panel");
  assert.equal(panel.classList.contains("open"), true, "a pass with the same reply cut the panel back");
  assert.equal(panel.classList.contains("motion"), true, "a pass with the same reply cut the run short");
  // a different reply is another batch: it starts cut, and the run still going
  // on the batch it replaces is finished where it stands
  context.syncAnswered(el, context.liveAnswered({ ...liveBox([LIVE[2]]), replyId: "reply-next" }));
  assert.equal(el.answ, panel);
  assert.equal(panel.classList.contains("open"), false, "a new batch arrived open");
  assert.equal(panel.classList.contains("motion"), false, "a new batch arrived mid run");
  assert.equal(clip.style.height, "", "a new batch kept the old run's height");
  assert.equal(clip.style.getPropertyValue("--answ-shade"), "", "a new batch kept the old run's dissolve");
  assert.deepEqual(blocks(panel).map(b => b.html), [markdown.render(LIVE[2].text)]);
  // and the old run's end, arriving late, changes nothing
  landRun(panel);
  assert.equal(panel.classList.contains("open"), false, "the replaced batch's run landed on the new one");
});

test("a long batch opens on the old fold's run, from its cut to its whole height, and lands once", () => {
  const { context, counts, run, pending } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ, clip = panel.querySelector(".answclip");
  const rooms = counts.rooms;
  // not laid out yet, so nothing is claimed about its length
  assert.equal(panel.classList.contains("more"), false);
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "a panel not known to be long opened");
  // laid out: the batch runs past the preview, and the watch says so. the strip
  // at the foot arrives with the word, which is a change in the room
  layOutLong(panel, FakeResizeObserver.made[0]);
  assert.equal(panel.classList.contains("more"), true, "a batch longer than the preview was not marked");
  assert.equal(counts.rooms, rooms + 1, "the strip arrived without the answer being re-snapped");
  const before = counts.rooms;
  const waiting = pending().length;
  panel.fire("click", { target: panel });
  // the run: open is where it is heading, and the cut is written from where it
  // stood, 58px, to the whole batch, 240px, with the dissolve's strip fading
  // from whole to nothing on the same run. the two ends stay on the panel for
  // the length of the run
  assert.equal(panel.classList.contains("open"), true, "the press did not head for the whole batch");
  assert.equal(panel.classList.contains("motion"), true, "the press did not start a run");
  assert.deepEqual(clip.style.heights, ["58px", "240px"], "the run is not from the cut to the whole batch");
  assert.equal(clip.style.getPropertyValue("--answ-shade"), "0", "the dissolve does not fade to nothing");
  assert.deepEqual({ ...panel.answSpan }, { from: 58, to: 240, band: null }, "the run's two ends are not on the panel");
  assert.equal(clip.listening("transitionend"), 1, "the run is not waiting on its own end");
  assert.equal(pending().length, waiting + 1, "no timer stands behind the run");
  assert.equal(pending().at(-1).ms, run("FOLD_TIMER_MS"), "the timer behind the run is not the fold's own");
  assert.equal(run("FOLD_TIMER_MS"), 430, "the timer behind the run is not the old fold's");
  assert.equal(counts.rooms, before, "the answer was re-snapped on a frame of the run");
  // an end that is not the height's is not the run's end
  clip.fire("transitionend", { target: clip, propertyName: "opacity" });
  assert.equal(panel.classList.contains("motion"), true, "another transition ended the run");
  landRun(panel);
  assert.equal(panel.classList.contains("motion"), false, "the run did not land");
  assert.equal(clip.style.height, "", "the run left its height written in");
  assert.equal(clip.style.getPropertyValue("--answ-shade"), "", "the run left its dissolve written in");
  assert.equal(panel.answSpan, null, "the run's two ends outlived it");
  assert.equal(clip.listening("transitionend"), 0, "the run kept listening after it landed");
  assert.equal(pending().length, waiting, "the timer behind the run outlived it");
  assert.equal(counts.rooms, before + 1, "the answer was not re-snapped once the panel landed");
  // a press on a link inside a message, or one ending a pick of the words, is
  // not a request to cut it back
  const link = element("a");
  panel.querySelector(".answmsg").appendChild(link);
  panel.fire("click", { target: link });
  assert.equal(panel.classList.contains("open"), true, "a press on a link cut the panel back");
  context.picked = panel;
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), true, "picking out words cut the panel back");
  context.picked = null;
});

test("a second press cuts it back on the same run, and the timer lands a run with nothing to move", () => {
  const { context, counts, run, pending, ring } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  panel.fire("click", { target: panel });
  landRun(panel);
  clip.style.heights.length = 0;
  const before = counts.rooms;
  const waiting = pending().length;
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "the second press did not head back for the cut");
  assert.equal(panel.classList.contains("motion"), true, "cutting back did not run");
  assert.deepEqual(clip.style.heights, ["240px", "58px"], "the run back is not from the whole batch to the cut");
  assert.equal(clip.style.getPropertyValue("--answ-shade"), "1", "the dissolve does not fade back in");
  assert.equal(panel.classList.contains("more"), true, "the cut panel lost its strip");
  // the transition never ended here, so the timer behind the run lands it
  assert.equal(pending().length, waiting + 1);
  ring();
  assert.equal(panel.classList.contains("motion"), false, "the timer did not land the run");
  assert.equal(clip.style.height, "");
  assert.equal(counts.rooms, before + 1, "the answer was not re-snapped once the panel was cut back");
});

test("a press that catches a run turns it round from where it stands", () => {
  const { context, counts, run } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  panel.fire("click", { target: panel });
  // part way down, a second press: the run is frozen where it stands, 131px,
  // with its dissolve part faded, and aimed back at the cut from there rather
  // than started over
  clip.midRun = 131;
  clip.midShade = 0.4;
  const shades = [];
  const set = clip.style.setProperty;
  clip.style.setProperty = (name, value) => { if (name === "--answ-shade") shades.push(value); set(name, value); };
  panel.fire("click", { target: panel });
  clip.midRun = null;
  clip.midShade = null;
  assert.equal(panel.classList.contains("open"), false, "the press mid run did not turn it round");
  assert.deepEqual(clip.style.heights, ["58px", "240px", "131px", "58px"],
    "the turned run did not start from where the first one stood");
  assert.deepEqual(shades, ["0.4", "1"], "the dissolve did not turn round from the strength it had reached");
  // the first run's end, arriving now, belongs to a run that is over
  const before = counts.rooms;
  landRun(panel);
  assert.equal(counts.rooms, before + 1, "both runs landed, or neither did");
  assert.equal(panel.classList.contains("motion"), false);
  assert.equal(panel.classList.contains("open"), false, "the turned run landed open");
});

test("with reduced motion asked for, a press is a plain flip with nothing timed", () => {
  const { context, counts, run, pending } = sandbox();
  run("answeredRoomChanged = roomSpy");
  context.stillness = true;
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  const before = counts.rooms;
  const waiting = pending().length;
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), true, "the press did not open the batch");
  assert.equal(panel.classList.contains("motion"), false, "a run was started against the setting");
  assert.deepEqual(clip.style.heights, [], "a height was written for a run");
  assert.equal(pending().length, waiting, "a timer was armed for a run");
  assert.equal(counts.rooms, before + 1, "the answer was not re-snapped at once");
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "the second press did not cut it back");
  assert.equal(panel.classList.contains("motion"), false);
  assert.equal(counts.rooms, before + 2);
});

test("a batch that fits the preview is shown whole and takes no press", () => {
  const { context } = sandbox();
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox([LIVE[2]])));
  const panel = el.answ, clip = panel.querySelector(".answclip");
  clip.clientHeight = 21; clip.scrollHeight = 21;
  FakeResizeObserver.made[0].fire();
  assert.equal(panel.classList.contains("more"), false, "a short batch was marked as cut");
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "a short batch took a press");
});

// ---- blank lines --------------------------------------------------------------------
// the invisible characters a paste brings along, named by code point so none of
// them sits unseen in this file: a zero width space and a word joiner
const ZWSP = String.fromCharCode(0x200b);
const JOINER = String.fromCharCode(0x2060);
const stopOf = panel => panel.querySelector(".answclip").style.getPropertyValue("--answ-stop");

test("a message's blank tail is taken off before it is drawn, and a blank message draws nothing", () => {
  const { context } = sandbox();
  const el = card("c1");
  const batch = [
    { text: "Invented line one\nInvented line two\n\n\n", ts: 1 },
    { text: "Invented line one\nInvented line two\n" + ZWSP, ts: 2 },
    { text: "Invented paragraph\n\n" + ZWSP, ts: 3 },
    { text: "Invented tail with spaces \t \n  \n" + JOINER + "\n" + ZWSP, ts: 4 },
    { text: "   \n" + ZWSP + "\n\n", ts: 5 },
  ];
  // left as typed, the renderer would draw the invisible tails as blank lines
  assert.notEqual(markdown.render(batch[1].text), markdown.render("Invented line one\nInvented line two"),
    "the renderer no longer draws a zero width tail, so this case proves nothing");
  context.syncAnswered(el, context.liveAnswered(liveBox(batch)));
  assert.deepEqual(blocks(el.answ).map(b => b.html), [
    markdown.render("Invented line one\nInvented line two"),
    markdown.render("Invented line one\nInvented line two"),
    markdown.render("Invented paragraph"),
    markdown.render("Invented tail with spaces"),
  ], "a blank tail was drawn, or a blank message added a block and its blank line");
  for (const b of blocks(el.answ))
    assert.ok(!b.html.includes(ZWSP) && !b.html.includes(JOINER), `an invisible tail survived: ${JSON.stringify(b.html)}`);
  // a batch whose every message is blank has nothing to show
  context.syncAnswered(el, context.liveAnswered({ ...liveBox([batch[4], { text: "\n\n", ts: 6 }]), replyId: "reply-blank" }));
  assert.equal(el.answ, null, "a batch of blank messages still shows a panel");
});

test("in the history, an older batch's blank tails are taken off the same way", async () => {
  const { context, run } = sandbox();
  const el = card("c1");
  el.reply.dataset.raw = "The invented live answer.";
  const live = liveBox();
  context.els = { c1: el };
  context.selectedId = "c1";
  context.lastState = { boxes: [live] };
  const older = [
    { id: "reply-blank", ts: 1, answered: [{ text: "  \n" + ZWSP, ts: 1 }] },
    { id: "reply-tail", ts: 2, answered: [
      { text: "\n\n", ts: 2 },
      { text: "Invented older line\n" + ZWSP + "\n\n", ts: 3 },
    ] },
  ];
  run(`histCache.c1 = Promise.resolve(Object.assign(
    ["The invented first answer.", "The invented second answer."], { meta: ${JSON.stringify(older)} }))`);
  context.syncAnswered(el, context.liveAnswered(live));
  await context.histStep("c1", 1);
  assert.equal(el.answId, "reply-tail");
  assert.deepEqual(blocks(el.answ).map(b => b.html), [markdown.render("Invented older line")],
    "an older batch kept its blank tail or its blank message");
  await context.histStep("c1", 1);
  assert.equal(el.answ, null, "an older batch of blank messages still shows a panel");
  await context.histStep("c1", -1);
  await context.histStep("c1", -1);
  assert.deepEqual(blocks(el.answ).map(b => b.html), LIVE.map(m => markdown.render(m.text)),
    "live does not show the live batch again");
});

test("a batch with no text past the cut has no strip and no fade, and stands exactly as tall as its text", () => {
  const { context } = sandbox();
  // the owner's case: two lines of text and a third that is blank
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox([{ text: "Invented line one\nInvented line two\n" + ZWSP, ts: 1 }])));
  const two = layOut(el.answ, FakeResizeObserver.made[0], { tops: [0, 21], cut: 42, whole: 42 });
  assert.equal(two.texts.length, 2, "the blank third line was drawn");
  assert.equal(el.answ.classList.contains("more"), false, "two lines of text were taken for a long batch");
  assert.equal(stopOf(el.answ), "", "a batch that ends on its text was stopped short");
  // and a batch whose drawing still ends on a blank band past its text: the
  // band is not text, so it hides nothing and the panel stops at the text
  const band = card("c2");
  context.syncAnswered(band, context.liveAnswered({ ...liveBox([{ text: "Invented line one\nInvented line two", ts: 1 }]), id: "c2", replyId: "reply-band" }));
  const { clip } = layOut(band.answ, FakeResizeObserver.made[1], { tops: [0, 21], cut: 57.75, whole: 84 });
  assert.equal(band.answ.classList.contains("more"), false, "a blank band was taken for hidden text");
  assert.equal(stopOf(band.answ), "42px", "the panel did not stop at its last line of text");
  assert.equal(clip.getBoundingClientRect().height, 42, "the panel is taller than its text");
  band.answ.fire("click", { target: band.answ });
  assert.equal(band.answ.classList.contains("open"), false, "a batch with nothing hidden took a press");
});

test("a cut that lands in blank stops at the foot of the last line with text", () => {
  const cases = [
    ["a paragraph break", [{ text: "Invented line a\nInvented line b\n\nInvented line c", ts: 1 }], [0, 21, 63], 84],
    ["the gap between two messages", [{ text: "Invented line a\nInvented line b", ts: 1 }, { text: "Invented line c", ts: 2 }], [0, 21, 63], 84],
    ["a line with nothing on it but an invisible joiner",
      [{ text: "Invented line a\nInvented line b\n" + ZWSP + "\nInvented line d", ts: 1 }], [0, 21, 42, 63], 84],
    ["a line that shows under half of itself", [{ text: "Invented line a\nInvented line b", ts: 1 }, { text: "Invented line c", ts: 2 }], [0, 21, 52], 73],
  ];
  for (const [what, batch, tops, whole] of cases) {
    const { context } = sandbox();
    const el = card("c1");
    context.syncAnswered(el, context.liveAnswered(liveBox(batch)));
    layOut(el.answ, FakeResizeObserver.made[0], { tops, cut: 57.75, whole });
    assert.equal(el.answ.classList.contains("more"), true, `${what}: the text past the cut was not marked`);
    assert.equal(stopOf(el.answ), "42px", `${what}: the preview did not stop at the last line with text`);
  }
});

test("a line of text through the cut keeps the cut, and so does a picture", () => {
  const { context } = sandbox();
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox([{ text: "Invented line a\nInvented line b\nInvented line c\nInvented line d", ts: 1 }])));
  layOut(el.answ, FakeResizeObserver.made[0], { tops: [0, 21, 42, 63], cut: 57.75, whole: 84 });
  assert.equal(el.answ.classList.contains("more"), true);
  assert.equal(stopOf(el.answ), "", "a line dissolving through the cut was stopped short");
  // a picture has no text in it, but it is still something to see
  const pic = card("c2");
  context.syncAnswered(pic, context.liveAnswered({ ...liveBox([{ text: "Invented line a", ts: 1 }, { text: "Invented caption", ts: 2 }]), id: "c2", replyId: "reply-pic" }));
  const img = element("img");
  img.rect = { top: 30, bottom: 130 };
  pic.answ.querySelectorAll(".answmsg")[1].appendChild(img);
  layOut(pic.answ, FakeResizeObserver.made[1], { tops: [0, null], cut: 57.75, whole: 130 });
  assert.equal(pic.answ.classList.contains("more"), true, "a picture past the cut was not counted");
  assert.equal(stopOf(pic.answ), "", "a picture through the cut was taken for blank");
});

test("the small card's shorter preview stops the same way on its own line", () => {
  const { context } = sandbox();
  context.line = 17;
  const mini = card("m1");
  context.syncAnswered(mini, context.liveAnswered({ ...liveBox([{ text: "Invented line a", ts: 1 }, { text: "Invented line b", ts: 2 }]), id: "m1" }), null);
  layOut(mini.answ, FakeResizeObserver.made[0], { tops: [0, 34], cut: 29.75, whole: 51, line: 17 });
  assert.equal(mini.answ.classList.contains("more"), true);
  assert.equal(stopOf(mini.answ), "17px", "the small card's preview did not stop at its last line with text");
});

test("a stopped preview opens from its stop and cuts back to it on the fold's run", () => {
  const { context, run } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const el = card("c1");
  context.syncAnswered(el, context.liveAnswered(liveBox([{ text: "Invented line a\nInvented line b", ts: 1 }, { text: "Invented line c", ts: 2 }])));
  const { clip } = layOut(el.answ, FakeResizeObserver.made[0], { tops: [0, 21, 63], cut: 57.75, whole: 84 });
  el.answ.fire("click", { target: el.answ });
  landRun(el.answ);
  el.answ.fire("click", { target: el.answ });
  assert.deepEqual(clip.style.heights, ["42px", "84px", "84px", "42px"],
    "the run did not open from the stop, or did not cut back to it");
  landRun(el.answ);
  assert.equal(stopOf(el.answ), "42px", "the cut back panel lost its stop");
});

test("the small card draws the same panel and tells nobody when it opens", () => {
  const { context, counts, run } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const mini = card("m1");
  context.syncAnswered(mini, context.liveAnswered({ ...liveBox(), id: "m1" }), null);
  assert.equal(mini.answ.className, "answered");
  // the small card's own 17px line, cut at a line and three quarters
  context.line = 17;
  const { clip } = layOut(mini.answ, FakeResizeObserver.made[0], { tops: null, cut: 30, whole: 200, line: 17 });
  mini.answ.fire("click", { target: mini.answ });
  assert.equal(mini.answ.classList.contains("open"), true);
  assert.equal(mini.answ.classList.contains("motion"), true, "the small card's panel did not run");
  assert.deepEqual(clip.style.heights, ["30px", "200px"]);
  landRun(mini.answ);
  assert.equal(mini.answ.classList.contains("motion"), false);
  assert.equal(counts.rooms, 0, "the small card's panel re-snapped the large card");
  // and the page hands it the very same pass, with nobody to tell, and seats
  // the sent panel between its reply and its row
  assert.match(DESKTOP, /syncAnswered\(el, liveAnswered\(b\), null\);/);
  assert.match(DESKTOP, /box\.append\(sun, arc, x, title, answwrap, reply, sentwrap, compose\);/);
});

test("nothing opens by itself: the clock, the stored word and the visit guard are gone", () => {
  for (const name of ["ANSWERED_AUTO_EXPAND", "ANSWERED_OPEN_AFTER_SEC", "answbox.", "answeredChoice",
      "armAnsweredClock", "clearAnsweredClock", "protectAnsweredVisit", "releaseAnsweredVisit",
      "answeredOpensNow", "answeredChose", "holdAnswerScroll", "answeredPlace", "answeredStrip"])
    assert.ok(!LOGIC.includes(name), `card-logic.js still carries ${name}`);
  for (const [page, text] of [["index.html", DESKTOP], ["m.html", PHONE]])
    for (const name of ["growAnswered", "foldAnswered", "answeredChose", "AnsweredVisit", "AnsweredClock",
        "holdAnswerScroll", "pendwrap-answered", "manswered", "hasansw", "answFoldRun", "answKey",
        "--answ-open", "--answ-keep", "--cardroom", "--footband"])
      assert.ok(!text.includes(name), `${page} still carries ${name}`);
  // a reply of any age is mounted cut, and the pass arms nothing
  const { context, counts } = sandbox();
  const el = card("c1");
  const timers = counts.timers;
  for (const age of [0, 30, 61, 86400]) {
    context.syncAnswered(el, context.liveAnswered({ ...liveBox(), replyId: "reply-" + age,
      replyTs: Date.now() / 1000 - age }));
    assert.equal(el.answ.classList.contains("open"), false, `a reply ${age}s old was mounted open`);
  }
  assert.equal(counts.timers, timers, "the pass armed a clock");
});

// the rule a selector opens, as written in a sheet
function rule(css, selector) {
  const at = css.indexOf("\n" + selector + "{");
  assert.ok(at >= 0, `no rule for ${selector}`);
  return css.slice(at, css.indexOf("}", at) + 1);
}
// every rule a selector opens, the last selector of a list included
function rules(css, selector) {
  const out = [];
  for (let at = css.indexOf("\n" + selector + "{"); at >= 0; at = css.indexOf("\n" + selector + "{", at + 1))
    out.push(css.slice(at, css.indexOf("}", at) + 1));
  return out;
}

test("the sheet draws one grey panel with no frame, a blank line between messages and an arrow only when long", () => {
  const panel = rule(TOKENS, ".answered");
  assert.match(panel, /background:var\(--answ-fill\)/, "the panel is not drawn in its own fill");
  assert.match(panel, /--answ-fill:var\(--bubble-fill\)/, "the panel's fill is not the bubble's grey");
  assert.match(panel, /border-radius:var\(--answ-round\)/);
  assert.match(panel, /margin-left:auto/, "the panel does not hug the right end of its column");
  assert.match(panel, /font:var\(--answ-font\)/);
  assert.ok(!/border:|box-shadow|outline/.test(panel), "the panel wears a frame or a shade");
  assert.match(rule(TOKENS, ".answclip"), /max-height:var\(--answ-stop, var\(--answ-peek\)\); overflow:hidden/,
    "the cut does not take the script's stop before the surface's preview");
  assert.match(rule(TOKENS, ".answered.open .answclip"), /max-height:none/);
  // the dissolve: a strip of the panel's own grey, the surface's own depth,
  // laid over the foot of the cut and whole only while a long batch stands cut
  const strip = rule(TOKENS, ".answclip::after");
  assert.match(strip, /position:absolute; left:0; right:0; bottom:0; height:var\(--answ-fade\);/,
    "the dissolve is not a strip the surface's own depth over the foot of the cut");
  assert.match(strip, /background:linear-gradient\(to bottom, transparent, var\(--answ-fill\)\);/,
    "the dissolve is not the panel's own grey");
  assert.match(strip, /opacity:var\(--answ-shade\)/, "the strip's strength is not the one the run holds");
  assert.match(rule(TOKENS, ".answclip"), /position:relative;.*--answ-shade:0/);
  assert.match(rule(TOKENS, ".answered.more:not(.open) .answclip"), /--answ-shade:1/,
    "a cut batch does not dissolve");
  // one message from the next: a whole blank line of the panel's type, half
  // over the message's edge and half under it, and no rule drawn in it
  const between = rule(TOKENS, ".answmsg + .answmsg");
  assert.ok(!/border/.test(between), "two messages are split by a rule");
  assert.match(between, /margin-top:calc\(var\(--answ-line\) \/ 2\);/);
  assert.match(between, /padding-top:calc\(var\(--answ-line\) \/ 2\);/);
  assert.match(rule(TOKENS, ".answmsg p, .answmsg ul, .answmsg ol"), /margin-bottom:var\(--answ-line\)/);
  assert.match(rule(TOKENS, ".answfoot"), /display:none/, "the strip shows on a batch that fits");
  assert.match(rule(TOKENS, ".answered.more .answfoot"), /display:flex/, "a long batch has no strip");
  assert.ok(!TOKENS.includes("--raised-soft"), "the old box's raised shade is still a token");
});

test("the sheet runs the fold on the old box's length and curve, turns the arrow over and stands it in a taller strip", () => {
  // the old answered box folded over --pend-move, 330ms, on --gentle
  assert.match(rule(TOKENS, ".answered"), /--answ-move:\.33s;/, "the panel does not fold on the old box's length");
  assert.match(TOKENS, /--gentle:cubic-bezier\(\.42,\.06,\.38,1\);/, "the card's gentle curve is not the old one");
  const running = rules(TOKENS, ".answered.motion .answclip").find(body => body.includes("transition:"));
  assert.ok(running, "the cut has no run of its own");
  assert.match(running, /max-height:none;/, "the preview's cap holds the run back");
  assert.match(running, /transition:height var\(--answ-move\) var\(--gentle\);/,
    "the height does not run on the old fold's length and curve");
  assert.match(rule(TOKENS, ".answered.motion .answclip::after"),
    /transition:opacity var\(--answ-move\) var\(--gentle\)/,
    "the dissolve does not fade on the old fold's length and curve");
  assert.match(rule(TOKENS, ".answclip"), /overflow:hidden/, "the run's edge is not clipped");
  // the arrow: at the foot both ways, turned over while open, on the same run
  const chev = rule(TOKENS, ".answchev");
  assert.match(chev, /display:block/);
  assert.match(chev, /transition:transform var\(--answ-move\) var\(--gentle\);/, "the arrow's turn is not on the fold's run");
  assert.match(rule(TOKENS, ".answered.open .answchev"), /transform:rotate\(180deg\)/, "the open arrow does not point up");
  assert.match(rule(TOKENS, ".answfoot"), /height:var\(--answ-strip\);/);
  assert.match(rule(TOKENS, ".answfoot"), /align-items:center; justify-content:center;/, "the arrow is not centred in its strip");
  assert.match(rule(TOKENS, ".answered.more"), /padding-bottom:0/, "the panel's own air still stands under the strip");
  // each surface's strip, taller than the air it replaces, with clear room
  // over and under the 7px arrow
  for (const [where, css, selector, strip] of [["the desktop card", DESKTOP, "  body.focus .box.sel", 36],
      ["the small card", DESKTOP, "  #magic2 .mbox", 24], ["the phone card", PHONE, "  .box", 32]]) {
    const at = css.indexOf("\n" + selector + "{\n    --answ-font:");
    const body = css.slice(at, css.indexOf("}", at));
    const air = parseFloat(/--answ-pad-y:([\d.]+)px/.exec(body)[1]);
    const got = parseFloat((/--answ-strip:([\d.]+)px/.exec(body) || [])[1]);
    assert.equal(got, strip, `${where}'s strip is not ${strip}px`);
    assert.ok(got > air, `${where}'s strip is no taller than the air it replaces`);
    assert.ok((got - 7) / 2 >= 8, `${where}'s arrow has under 8px clear over and under it`);
  }
  // reduced motion: both pages still take every transition away, and the
  // script's own check makes a plain flip of it
  assert.match(DESKTOP, /@media \(prefers-reduced-motion: reduce\)\{ \*\{animation:none !important; transition:none !important\} \}/);
  assert.match(PHONE, /@media \(prefers-reduced-motion: reduce\)\{\n    \*, \*::before, \*::after\{animation:none !important; transition:none !important\}/);
  // the small card's seat keeps its cap for the whole of a run, and the
  // desktop snap leaves the answer alone while the panel moves
  assert.match(DESKTOP, /#magic2 \.answwrap:has\(\.answered\.open\),\n  #magic2 \.answwrap:has\(\.answered\.motion\)\{/);
  assert.match(DESKTOP, /if \(answ && \(answ\.classList\.contains\("open"\) \|\| answ\.classList\.contains\("motion"\)\)\) return;/);
});

test("each surface types the panel's measures and seats it in the answer's column", () => {
  const measures = ["--answ-font", "--answ-line", "--answ-pad-y", "--answ-pad-x", "--answ-round",
    "--answ-peek", "--answ-fade", "--answ-strip"];
  for (const [where, css, selector] of [["the desktop card", DESKTOP, "  body.focus .box.sel"],
      ["the small card", DESKTOP, "  #magic2 .mbox"], ["the phone card", PHONE, "  .box"]]) {
    const at = css.indexOf("\n" + selector + "{\n    --answ-font:");
    assert.ok(at >= 0, `${where} does not type the panel's measures`);
    const body = css.slice(at, css.indexOf("}", at));
    for (const name of measures) assert.ok(body.includes(name + ":"), `${where} leaves ${name} unset`);
    assert.match(body, /var\(--inter\)/, `${where} does not set the panel in the title's face`);
    // the cut and its dissolve are counted in the surface's own line
    const line = /--answ-line:([\d.]+)px/.exec(body)[1];
    for (const name of ["--answ-peek", "--answ-fade"])
      assert.match(body, new RegExp(name + ":calc\\(" + line.replace(".", "\\.") + "px \\* "),
        `${where}'s ${name} is not counted in its own ${line}px line`);
  }
  // the large card's seat stands in the answer's own column on both pages
  const column = "padding:0 calc(var(--pad-x)*5/3 - var(--sbar)) var(--sp-s) calc(var(--pad-x)*2/3);";
  assert.ok(rule(DESKTOP, "  body.focus .box.sel .answwrap").includes(column), "the desktop seat is not the answer's column");
  assert.ok(rule(PHONE, "  .answwrap").includes(column), "the phone seat is not the answer's column");
  // and both pages build the seat into the scroller over the answer
  for (const text of [DESKTOP, PHONE]) {
    assert.match(text, /const answwrap = h\("div", "answwrap"\);/);
    assert.match(text, /replyview\.append\(answwrap, reply\);/);
  }
});

// ---- the messages waiting for a reply --------------------------------------------------
// a large card as both pages build it: the answer's scroller in the card's body,
// and laid over it at the floor the wrapper holding the sent panel's seat. the
// card is the one on show, and has a row to type in
function fullCard(id) {
  const el = card(id);
  const body = element("div");
  body.className = "body";
  el.replyview.remove();
  body.appendChild(el.replyview);
  const pendwrap = element("div");
  pendwrap.className = "pendwrap";
  const sentwrap = element("div");
  sentwrap.className = "sentwrap";
  pendwrap.appendChild(sentwrap);
  body.appendChild(pendwrap);
  el.box.appendChild(body);
  el.box.classList.add("sel");
  return Object.assign(el, { body, pendwrap, sentwrap, sent: null, sentKey: "", sentItems: [], ta: element("textarea") });
}
const SENT = ["Invented first sent message.", "Invented second sent message with **emphasis**."];

test("a send lands its message in the same panel at the card's foot, cut to its preview", () => {
  const { context, counts, pending, ring } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  context.syncSent(el, context.sentBatch(SENT.slice(0, 1)), true);
  const panel = el.sent;
  assert.ok(panel, "a send brought no panel in");
  assert.equal(panel.parentNode, el.sentwrap, "the panel is not in the seat at the card's foot");
  assert.equal(el.sentwrap.children.length, 1);
  // the panel over the answer to the letter: its markup, its blocks, its arrow
  assert.equal(panel.className, "answered sent arrive");
  assert.deepEqual(panel.children.map(node => node.className), ["answclip", "answfoot"],
    "the sent panel is not the answered panel's cut over its strip");
  assert.deepEqual(panel.querySelector(".answfoot").children.map(node => node.className), ["answchev"]);
  assert.deepEqual(blocks(panel), [{ cls: "answmsg cardmd", html: markdown.render(SENT[0]) }]);
  for (const node of all(panel))
    for (const name of OLD_PARTS)
      assert.ok(!node.classList.contains(name), `the sent panel still carries the old box's ${name}`);
  assert.equal(panel.getAttribute("role"), "group");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply");
  // cut, and told to its card
  assert.equal(panel.classList.contains("open"), false, "a send landed the panel open");
  assert.equal(counts.rooms, 1, "the card was not told the panel took its room");
  // the arrival is a dress the clock takes off again
  assert.equal(pending().at(-1).ms, 320, "the arrival is not the sheet's own length");
  ring();
  assert.equal(panel.classList.contains("arrive"), false, "the arrival's dress stayed on");
  // the same list again touches no dom at all
  const kids = all(panel);
  context.syncSent(el, context.sentBatch(SENT.slice(0, 1)));
  assert.ok(all(panel).every((node, i) => node === kids[i]), "a pass with the same list redrew the panel");
  assert.equal(counts.rooms, 1);
  // a second send: the message already there is kept as it stands, and only
  // the new one comes in
  const first = panel.querySelector(".answmsg");
  context.syncSent(el, context.sentBatch(SENT), true);
  const now = panel.querySelector(".answstack").children;
  assert.equal(now.length, 2);
  assert.equal(now[0], first, "a send drew the message above it again");
  assert.equal(now[0].classList.contains("arrive"), false, "the message already there came in again");
  assert.equal(now[1].classList.contains("arrive"), true, "the new message did not come in");
  assert.equal(panel.classList.contains("open"), false, "a send left the panel open");
  // the answer lands, the board's list empties, and the panel goes with it
  const watch = FakeResizeObserver.made[0];
  context.syncSent(el, context.sentBatch([]));
  assert.equal(el.sent, null, "the panel outlived the list it was drawn from");
  assert.equal(el.sentwrap.children.length, 0);
  assert.equal(watch.live, false, "the panel's size watch outlived the panel");
});

test("the sent panel opens on the same arrow and run, and a send cuts it back on that run", () => {
  const { context, counts, run } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  const texts = LIVE.map(m => m.text);
  context.syncSent(el, context.sentBatch(texts));
  const panel = el.sent;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  assert.equal(panel.classList.contains("more"), true, "a long batch was not cut with the fade and the arrow");
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), true, "the press did not open the sent panel");
  assert.equal(panel.classList.contains("motion"), true, "the sent panel did not open on the fold's run");
  assert.deepEqual(clip.style.heights, ["58px", "240px"]);
  landRun(panel);
  clip.style.heights.length = 0;
  const rooms = counts.rooms;
  // a send while it stands open: the message goes in and the panel is cut back
  // to its preview on the fold's own run, from where it stood
  context.syncSent(el, context.sentBatch([...texts, "Invented message sent while it stood open."]), true);
  assert.equal(panel.classList.contains("open"), false, "a send left the panel standing open");
  assert.equal(panel.classList.contains("motion"), true, "the send cut the panel back without the fold's run");
  assert.deepEqual(clip.style.heights, ["240px", "58px"], "the cut back did not run from where the panel stood");
  assert.equal(blocks(panel).length, 4, "the message did not go into the panel it cut back");
  assert.equal(counts.rooms, rooms, "the card was told on the run's first frame");
  landRun(panel);
  assert.equal(counts.rooms, rooms + 1, "the card was not told once the panel had landed");
  // a reading that brings a message sent somewhere else is no arrival: a panel
  // the reader opened stays open
  panel.fire("click", { target: panel });
  landRun(panel);
  context.syncSent(el, context.sentBatch([...texts, "Invented message sent while it stood open.", "Invented from elsewhere."]));
  assert.equal(panel.classList.contains("open"), true, "a reading cut the reader's open panel back");
  assert.equal(panel.classList.contains("motion"), false);
  assert.equal(blocks(panel).length, 5);
  assert.equal(run("SENT_ARRIVE_MS"), 260, "the arrival is not the sheet's --answ-come");
});

test("the band over the answer holds still while the sent panel runs", () => {
  const { context } = sandbox();
  const el = fullCard("c1");
  context.syncSent(el, context.sentBatch(LIVE.map(m => m.text)));
  const panel = el.sent;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  assert.equal(context.sentBand(el, 300), 300, "a panel at rest held the band");
  // opening, 58px to 240px: the band stays where it stood before the run
  panel.fire("click", { target: panel });
  clip.midRun = 100;
  assert.equal(context.sentBand(el, 160), 118, "the opening run did not hold the band at its start");
  clip.midRun = 180;
  assert.equal(context.sentBand(el, 240), 118, "the band followed the panel on a frame of the run");
  clip.midRun = null;
  landRun(panel);
  assert.equal(context.sentBand(el, 300), 300, "the band stayed held once the run had landed");
  // cutting back, 240px to 58px: the band goes to the far end at the start, so
  // the words under the seat are back before it comes down over them
  panel.fire("click", { target: panel });
  clip.midRun = 240;
  assert.equal(context.sentBand(el, 300), 118, "cutting back did not put the band at its far end at once");
  clip.midRun = 120;
  assert.equal(context.sentBand(el, 180), 118);
  clip.midRun = null;
  // and a card with no sent panel is simply measured
  assert.equal(context.sentBand(fullCard("c2"), 77), 77);
});

test("a message the phone has not had confirmed carries its state and its badge, and keeps its block as it lands", () => {
  const { context } = sandbox();
  const el = fullCard("c1");
  const confirmed = { text: "Invented confirmed message." };
  const onWay = { text: "Invented message on its way.", op: "op-1" };
  context.syncSent(el, [confirmed, { ...onWay, state: "pending", badge: "ring" }], true);
  const row = el.sent.querySelector(".answstack").children[1];
  assert.equal(row.classList.contains("pending"), true, "the unconfirmed message is not dressed as one");
  assert.equal(row.dataset.op, "op-1", "the message does not name its operation");
  assert.equal(row.dataset.badge, "ring");
  assert.ok(row.querySelector(".answmark").querySelector(".tsqring"), "the send still being tried wears no ring");
  assert.equal(textsOf(row.querySelector(".answmark")).length, 0, "the ring has words on it");
  // the board refuses it: the same block wears the red mark and the cross
  context.syncSent(el, [confirmed, { ...onWay, state: "failed", badge: "fail" }]);
  const same = el.sent.querySelector(".answstack").children[1];
  assert.equal(same, row, "a new state drew the message again");
  assert.equal(row.classList.contains("failed"), true);
  assert.equal(row.classList.contains("pending"), false);
  assert.equal(row.dataset.badge, "fail");
  const mark = row.querySelector(".answmark");
  assert.deepEqual(mark.children.map(node => node.dataset.act), ["cross", "retry"], "the mark is not the arrow with a cross");
  assert.equal(mark.querySelector(".tsqring"), null, "the ring stayed under the mark");
  assert.equal(row.querySelectorAll(".answmark").length, 1, "a new badge stood beside the old one");
  assert.equal(textsOf(mark).length, 0, "the mark has words on it");
  // confirmed after all: the block stays, and its badge and dress go
  context.syncSent(el, [confirmed, { text: onWay.text }]);
  assert.equal(el.sent.querySelector(".answstack").children[1], row, "landing drew the message again");
  assert.equal(row.querySelector(".answmark"), null, "a confirmed message kept its badge");
  assert.equal(row.dataset.badge, undefined);
  assert.equal(row.classList.contains("failed"), false);
  assert.equal(row.dataset.op, undefined);
});

// ---- the page turn ------------------------------------------------------------------------
// a card on show with a sent panel standing, laid out the way a browser would
// report it: the card's body, the answer's view under the title, scrolled a
// little, and the seat at the foot
function turningCard(context, batch = context.sentBatch(SENT)) {
  const el = fullCard("c1");
  context.syncSent(el, batch, true);
  el.body.rect = { top: 100, bottom: 900 };
  el.replyview.rect = { top: 120, bottom: 900 };
  el.sentwrap.rect = { top: 700, bottom: 790 };
  el.replyview.scrollTop = 35;
  el.reply.dataset.raw = "The invented old answer.";
  el.reply.innerHTML = markdown.render(el.reply.dataset.raw);
  return el;
}
const NEXT = { id: "c1", replyKind: "agent", replyId: "reply-next", answered: SENT.map(text => ({ text })) };

test("a new answer turns the page in one motion: it rides up under the sent messages, and nothing fades in after", () => {
  const { context, run, pending } = sandbox();
  context.boxBand = () => 64;
  const el = turningCard(context);
  const turn = context.turnBegin(el, NEXT);
  assert.equal(turn.mode, "glide", "a new answer under a standing sent panel did not glide");
  // the still picture of the page the reader was on, over the card's column
  // down to the foot of the seat
  const sheet = el.body.querySelector(".turnsheet");
  assert.ok(sheet && sheet.parentNode === el.body, "no still picture was laid over the card");
  assert.equal(sheet.getAttribute("aria-hidden"), "true");
  assert.equal(sheet.style.top, "0px");
  assert.equal(sheet.style.height, "690px", "the picture does not reach down to the foot of the seat");
  const page = sheet.querySelector(".turnpage");
  assert.deepEqual(page.children.map(node => node.className), ["replyview", "sentwrap"],
    "the picture is not the answer and the sent panel as they stood");
  const [was, seat] = page.children;
  assert.equal(was.scrollTop, 35, "the picture is not at the reader's scroll");
  assert.equal(was.style.getPropertyValue("--boxband"), "64px", "the picture's foot is not cut where the reader saw it");
  assert.equal(was.style.top, "20px");
  assert.equal(seat.style.top, "600px", "the picture's sent panel is not where the reader saw it");
  assert.equal(seat.querySelector(".answered").classList.contains("arrive"), false,
    "the picture's panel would come in all over again");
  assert.equal(el.replyview.scrollTop, 0, "the new page does not open at its head");
  // the page draws the new page under the sheet, the way both pages' passes do:
  // the answer, the sent panel emptied, and its messages as the new answer's panel
  el.reply.dataset.raw = "The invented new answer.";
  el.reply.innerHTML = markdown.render(el.reply.dataset.raw);
  context.syncSent(el, context.sentBatch([]));
  el.answwrap.rect = { top: 120, bottom: 200 };
  context.syncAnswered(el, context.liveAnswered(NEXT));
  assert.deepEqual(blocks(el.answ).map(b => b.html), SENT.map(text => markdown.render(text)),
    "the sent messages did not become the panel at the head of the new page");
  context.turnGo(el, turn);
  // the new page is pictured too, under the old picture and a glide's length
  // further down: its panel exactly behind the old sent panel, and the new
  // answer already in it, just under
  assert.deepEqual(page.children.map(node => node.className), ["replyview", "replyview", "sentwrap"],
    "the new page is not pictured under the old one");
  const now = page.children[0];
  assert.notEqual(now, was);
  assert.equal(now.style.top, "600px", "the new page's panel does not wait behind the old sent panel");
  assert.equal(now.querySelector(".reply").innerHTML, markdown.render("The invented new answer."),
    "the new answer is not in place in the picture that glides");
  assert.equal(now.querySelector(".answered").dataset.tag, "Read", "the new page's panel does not say read");
  // one glide: one transform, up by exactly the distance from the seat to the
  // new page's own panel, carrying the old page out and the new one in
  assert.equal(page.classList.contains("gliding"), true, "the picture does not glide");
  assert.equal(page.style.transform, "translate3d(0, -580px, 0)",
    "the glide does not carry the sent panel onto the new page's own panel");
  assert.equal(el.reply.classList.contains("printing"), false, "the answer is faded in beside the glide");
  assert.equal(pending().at(-1).ms, run("TURN_GLIDE_MS") + 80, "no timer stands behind the glide");
  // an end that is not the transform's is not the glide's end
  page.fire("transitionend", { target: page, propertyName: "opacity" });
  assert.equal(sheet.parentNode, el.body, "another transition ended the glide");
  // landed: the pictures go, the new page stands where they stood, and nothing
  // is faded in after
  page.fire("transitionend", { target: page, propertyName: "transform" });
  assert.equal(sheet.parentNode, null, "the picture outlived the glide");
  assert.equal(el.turning, null);
  assert.equal(el.reply.classList.contains("printing"), false, "the answer was faded in after the glide");
  assert.ok(pending().every(t => t.ms !== run("PRINT_MS") + 60), "a print was armed after the glide");
  assert.equal(run("TURN_GLIDE_MS"), 560);
});

test("a glide that never ends is landed by its timer, and a new page with no panel is only printed", () => {
  const { context, ring } = sandbox();
  const el = turningCard(context);
  const turn = context.turnBegin(el, NEXT);
  el.answwrap.rect = { top: 120, bottom: 200 };
  context.syncAnswered(el, context.liveAnswered(NEXT));
  context.turnGo(el, turn);
  ring();
  assert.equal(el.body.querySelector(".turnsheet"), null, "the timer did not land the glide");
  assert.equal(el.reply.classList.contains("printing"), false, "a glide was followed by a print");
  // a page whose answer was given nothing has no panel to glide to
  const bare = sandbox();
  const other = turningCard(bare.context);
  const next = bare.context.turnBegin(other, { ...NEXT, answered: [] });
  bare.context.syncAnswered(other, bare.context.liveAnswered({ ...NEXT, answered: [] }));
  bare.context.turnGo(other, next);
  assert.equal(other.body.querySelector(".turnsheet"), null, "a page with nowhere to glide to glided");
  assert.equal(other.reply.classList.contains("printing"), true, "a page with nowhere to glide to was not printed");
  // nor has a card with no sent panel standing: its answer is printed in place
  const plain = sandbox();
  const lone = fullCard("c1");
  lone.replyview.rect = { top: 120, bottom: 900 };
  const only = plain.context.turnBegin(lone, NEXT);
  assert.equal(only.mode, "print");
  assert.equal(lone.body.querySelector(".turnsheet"), null);
  plain.context.turnGo(lone, only);
  assert.equal(lone.reply.classList.contains("printing"), true);
});

test("the reader is never moved while reading or typing: the new answer waits, and turns once the card is left still", () => {
  const busy = [
    ["scrolled the answer a moment ago", (el, context, run) => { el.readAt = Date.now(); }, el => { el.readAt = 0; }],
    ["typed into the row a moment ago", (el) => { el.ta.typedAt = Date.now(); }, el => { el.ta.typedAt = 0; }],
    ["on an older page of the history", (el, context, run) => { run("hist = { id: 'c1', step: 1 }"); },
      (el, context, run) => { run("hist = null"); }],
    ["picking out words in the answer", (el, context) => { context.picked = el.replyview; },
      (el, context) => { context.picked = null; }],
  ];
  for (const [what, start, stop] of busy) {
    const { context, counts, run, pending, ring } = sandbox();
    run("turnAgain = againSpy");
    const el = turningCard(context);
    start(el, context, run);
    const turn = context.turnBegin(el, NEXT);
    assert.equal(turn, run("TURN_HELD"), `${what}: the new answer did not wait`);
    assert.equal(el.body.querySelector(".turnsheet"), null, `${what}: the page moved`);
    assert.equal(el.replyview.scrollTop, 35, `${what}: the reader's scroll was taken`);
    assert.ok(el.sent, `${what}: the sent panel was taken away`);
    // the card looks again every half second, and leaves it alone while the reader is at it
    assert.equal(pending().at(-1).ms, run("HOLD_LOOK_MS"));
    assert.equal(run("HOLD_LOOK_MS"), 500);
    ring();
    assert.equal(counts.again, 0, `${what}: the page was drawn again while the reader was busy`);
    assert.ok(el.turnHeld, `${what}: the card stopped looking`);
    // a second pass while still busy waits too, and arms no second look
    const looks = pending().length;
    assert.equal(context.turnBegin(el, NEXT), run("TURN_HELD"));
    assert.equal(pending().length, looks, `${what}: a second pass armed a second look`);
    // left still, the card draws its page again and the turn runs
    stop(el, context, run);
    ring();
    assert.equal(counts.again, 1, `${what}: the page was not drawn again once the reader was done`);
    assert.equal(el.turnHeld, null);
    assert.equal(context.turnBegin(el, NEXT).mode, "glide", `${what}: the page did not turn once the reader was done`);
  }
  // the reader's scrolling is what says so, and the page's own moves of the scroll are not
  const { context } = sandbox();
  const el = fullCard("c1");
  context.watchReading(el);
  el.replyview.fire("scroll");
  assert.ok(Date.now() - el.readAt < 1000, "the reader's scroll was not noticed");
  el.readAt = 0;
  context.scrollCardTop(el);
  el.replyview.fire("scroll");
  assert.equal(el.readAt, 0, "the page's own scroll to the top was taken for the reader's");
  // the times the design names
  assert.equal(sandbox().run("READ_QUIET_MS"), 3000);
  assert.equal(sandbox().run("TYPE_QUIET_MS"), 2000);
});

test("a history step back to live while an answer waits shows the live page the card last drew", async () => {
  const { context, run } = sandbox();
  const el = turningCard(context);
  const old = { id: "reply-old", answered: [{ text: "Invented message the old answer was given.", ts: 1 }] };
  context.els = { c1: el };
  context.selectedId = "c1";
  context.syncAnswered(el, old);
  el.liveMeta = old;
  // the board already holds the new answer, and the page is holding it back
  context.lastState = { boxes: [NEXT] };
  run(`histCache.c1 = Promise.resolve(Object.assign(["The invented older answer."], { meta: [{ id: "reply-older", answered: [] }] }))`);
  await context.histStep("c1", 1);
  assert.equal(context.turnBegin(el, NEXT), run("TURN_HELD"), "the new answer did not wait for the reader on an older page");
  await context.histStep("c1", -1);
  assert.equal(el.answId, "reply-old", "stepping back to live showed the waiting answer's panel over the old answer");
});

test("a progress note, a card not on show, or a reader who asked for no motion turn nothing", () => {
  const { context } = sandbox();
  const el = turningCard(context);
  assert.equal(context.turnBegin(el, { ...NEXT, replyKind: "note" }), null, "a progress note turned the page");
  el.box.classList.remove("sel");
  assert.equal(context.turnBegin(el, NEXT), null, "a card not on show turned");
  el.box.classList.add("sel");
  context.stillness = true;
  assert.equal(context.turnBegin(el, NEXT), null, "a new answer moved against the setting");
  assert.equal(el.body.querySelector(".turnsheet"), null);
  // and a print is the answer shown at once
  context.printReply(el);
  assert.equal(el.reply.classList.contains("printing"), false, "the answer was printed against the setting");
  // the sent panel opens and cuts back as a plain flip too
  const { context: still } = sandbox();
  still.stillness = true;
  const other = fullCard("c2");
  still.syncSent(other, still.sentBatch(LIVE.map(m => m.text)), true);
  layOutLong(other.sent, FakeResizeObserver.made[0]);
  other.sent.fire("click", { target: other.sent });
  assert.equal(other.sent.classList.contains("open"), true);
  assert.equal(other.sent.classList.contains("motion"), false, "the sent panel ran against the setting");
});

test("the board's timed refresh waits out a panel's run or a page turn", () => {
  const { context } = sandbox();
  context.moving = [];
  assert.equal(context.cardsMoving(), false);
  context.moving = [".answered.motion"];
  assert.equal(context.cardsMoving(), true, "a panel's run did not hold the refresh");
  context.moving = [".turnsheet"];
  assert.equal(context.cardsMoving(), true, "a page turn did not hold the refresh");
  // the desktop skips a timed tick; the phone puts its timed reading off a moment
  assert.match(DESKTOP, /setInterval\(\(\) => \{ if \(!cardsMoving\(\)\) poll\(\); \}, 1200\);/);
  assert.ok(!/setInterval\(poll, 1200\)/.test(DESKTOP), "the desktop still refreshes through a run");
  assert.match(PHONE, /if \(cardsMoving\(\)\)\{ schedulePoll\(RUN_WAIT_MS\); return; \}/);
});

// the body of the rule a selector opens, and every @keyframes block by name
function keyframes(css, name) {
  const at = css.indexOf("@keyframes " + name + "{");
  assert.ok(at >= 0, `no keyframes ${name}`);
  let depth = 0, i = css.indexOf("{", at);
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  return css.slice(at, i + 1);
}

test("every new motion is a transform or a fade, and nothing in a run is a mask", () => {
  // the panels' and the turn's own part of the shared sheet
  const from = TOKENS.indexOf("/* ---- the messages the answer was given");
  const to = TOKENS.indexOf(".cardmd .attachment");
  const part = TOKENS.slice(from, to);
  assert.ok(from > 0 && to > from);
  assert.ok(!/mask/.test(part.replace(/\/\*[\s\S]*?\*\//g, "")), "a panel or the turn still draws a mask");
  // the one registered property is the panel's grey, so that it can run with the words
  assert.deepEqual([...TOKENS.matchAll(/@property (--[a-z-]+)/g)].map(m => m[1]), ["--answ-fill"], "a custom property is still run");
  assert.ok(!/--answ-cut/.test(TOKENS + LOGIC), "the old run dissolve is still there");
  assert.ok(!/blur|filter/.test(part.replace(/\/\*[\s\S]*?\*\//g, "")), "a panel or the turn draws a blur");
  // every transition there: the fold's own height run, carried over as it was,
  // and otherwise strength and transforms alone, but for the bottom margin that
  // is the room for the mark and the panel's grey: a panel cut back is never held
  // down by a margin that grows, its head stays where it is
  const transitions = [...part.matchAll(/transition:([^;}]+)/g)].map(m => m[1].trim());
  for (const t of transitions)
    for (const one of t.split(","))
      assert.ok(/^(height|opacity|transform|margin-bottom|--answ-fill) /.test(one.trim()), `a run moves something other than height, strength or a transform: ${one}`);
  assert.equal(transitions.filter(t => t.startsWith("height")).length, 1, "a new run changes a height");
  assert.equal(transitions.filter(t => /margin-top/.test(t)).length, 0, "a margin holds a panel down while it is cut back");
  assert.equal(transitions.filter(t => /margin-bottom/.test(t)).length, 2, "the room for the mark runs somewhere other than the panel");
  assert.match(rule(TOKENS, ".answered.motion"),
    /transition:transform var\(--answ-move\) var\(--gentle\),\s*margin-bottom var\(--answ-move\) var\(--gentle\), --answ-fill var\(--answ-move\) var\(--gentle\)/,
    "the panel's run does not carry the room's and the grey's own run on the cut's length and curve");
  assert.ok(!/margin-top/.test(LOGIC.replace(/\/\/[^\n]*/g, "")), "the script still holds a panel down with a margin");
  // the arrival and the print are strength and a transform, and the glide a transform
  for (const name of ["answarrive", "cardprint"]) {
    const block = keyframes(TOKENS, name);
    const props = [...block.matchAll(/([a-z-]+):/g)].map(m => m[1]);
    assert.deepEqual([...new Set(props)].sort(), ["opacity", "transform"], `${name} moves more than strength and a transform`);
  }
  assert.match(rule(TOKENS, ".answered.arrive, .answmsg.arrive"), /animation:answarrive var\(--answ-come\) var\(--gentle\)/);
  assert.match(rule(TOKENS, ".turnpage.gliding"), /transition:transform var\(--turn-glide\) var\(--gentle\)/);
  assert.match(rule(TOKENS, ".turnpage"), /will-change:transform/, "the picture is not on a layer of its own");
  assert.match(rule(TOKENS, ".printing > *"), /animation:cardprint var\(--print-move\) var\(--gentle\) backwards/);
  assert.match(TOKENS, /:root\{--turn-glide:\.56s; --print-move:\.38s; --print-rise:6px\}/);
  // what a run moves is on a layer of its own only while the run is on
  assert.match(part, /\.answered\.motion \.answstack, \.answered\.motion \.answfoot,\n\.replyview:has\(> \.answwrap \.answered\.motion\) > \.reply\{will-change:transform\}/,
    "the moving parts of a run are not handed layers of their own");
  assert.ok(!/\n\.answstack\{[^}]*will-change/.test(part) && !/\n\.answfoot\{[^}]*will-change/.test(part),
    "a layer is held at rest");
  assert.match(DESKTOP, /#magic2 \.mbox:has\(\.answwrap \.answered\.motion\) \.mreply\{will-change:transform\}/);
  // the sent panel opens only as far as the room its card gives it
  assert.match(rule(TOKENS, ".answered.sent.open .answclip"), /max-height:var\(--sent-cap, none\); overflow-y:auto/);
});

test("both pages seat the sent panel at the foot and hand the turn a pass that draws nothing first", () => {
  const retired = ["growPend", "foldStrip", "foldWants", "risePend", "dropPend", "syncPend", "pendRow",
    "stampRcpts", "stampRun", "pendBottom", "foldPend", "foldBox", "wirePend", "padPair", "pendTimes",
    "pendRoomChanged", "drawLocalRows", "opRows", "pendlist", "pendslide", "pendstamp", "mpend", "--bubble-tail"];
  for (const [where, text] of [["card-logic.js", LOGIC], ["card-tokens.css", TOKENS], ["index.html", DESKTOP], ["m.html", PHONE]])
    for (const name of retired)
      assert.ok(!text.includes(name), `${where} still carries the old sent box's ${name}`);
  for (const [where, text] of [["the desktop", DESKTOP], ["the phone", PHONE]]) {
    assert.match(text, /const sentwrap = h\("div", "sentwrap"\);/, `${where} builds no seat for the sent panel`);
    assert.match(text, /pendwrap\.append\(meta, sentwrap, bottombar\);/, `${where} does not seat it over the row`);
    // the turn is asked before anything of the new answer is drawn, and handed
    // the new page once both panels have been drawn
    const ask = text.indexOf("const turn = el.reply.dataset.raw !== rawReply ? turnBegin(el, b) : null;");
    const swap = text.indexOf("el.reply.innerHTML = fmt(rawReply);", ask);
    const sent = text.search(/syncSent(Phone)?\(el, /);
    const answered = text.indexOf("syncAnswered(el, el.liveMeta)");
    const go = text.indexOf("turnGo(el, turn);");
    assert.ok(ask > 0 && ask < swap && swap < go && sent < go && answered < go,
      `${where} does not lay the picture first and glide once the new page is drawn`);
    assert.match(text, /if \(!held && el\.reply\.dataset\.raw !== rawReply\)\{/, `${where} swaps an answer it was told to hold`);
    assert.match(text, /watchReading\((els\[b\.id\]|card)\);/, `${where} does not watch the reader's scrolling`);
    assert.match(text, /noteTyping\(ta\);/, `${where} does not note the reader's typing`);
    assert.match(text, /sentBand\(el, boxBand\(el\.replyview, el\.pendwrap\)\)/, `${where} does not hold the band for a run`);
    assert.match(text, /turnAgain = /, `${where} cannot show an answer it held back`);
  }
  // the sends: both pages draw the message faded as an arrival when it is sent,
  // and the desktop saves it as sent once the board has answered
  assert.match(DESKTOP, /const sentItem = sentLaunch\(el, text, "\/send\?box=" \+ encodeURIComponent\(id\)\);/);
  assert.match(DESKTOP, /sentLanded\(el, sentItem\);/);
  assert.match(DESKTOP, /sentFailed\(el, sentItem, result === "refused"\);/);
  assert.match(DESKTOP, /const sentItem = sentLaunch\(own, text, /);
  assert.match(DESKTOP, /sentLanded\(own, sentItem\);/);
  assert.match(LOGIC, /el\.sentItems = \[\.\.\.el\.sentItems, item\];[\s\S]{0,200}syncSent\(el, el\.sentItems, true\);/);
  assert.match(PHONE, /drawSent\(el, id, true\);/);
  assert.match(LOGIC, /panel\.addEventListener\("click", e => sentBadgePress\(el, e\)\);/,
    "the press on a badge is not heard on the shared panel");
});

test("the turn keeps to the composer the reader is in, and to a board that is covered", () => {
  const { context, run, pending } = sandbox();
  // a key counts only in a row that holds the caret: the formatter's own input
  // as it puts its editor on, to every card on load, is nobody typing
  const idle = element("textarea"), typing = element("textarea");
  context.ComposeFormat = { focused: ta => ta === context.caret };
  context.noteTyping(idle);
  assert.equal(idle.typedAt, undefined, "a row with no caret was taken for typing");
  context.caret = typing;
  context.noteTyping(typing);
  assert.ok(Date.now() - typing.typedAt < 1000, "a key into the row with the caret was not noted");
  // typing in the card's composer holds the new answer back
  run("turnAgain = againSpy");
  const el = turningCard(context);
  el.ta = typing;
  assert.equal(context.turnBegin(el, NEXT), run("TURN_HELD"), "typing in the composer did not hold the answer");
  assert.equal(el.body.querySelector(".turnsheet"), null);
  typing.typedAt = 0;
  assert.equal(pending().at(-1).ms, 500);
  // with the seat standing at the card's floor, the picture reaches down to the
  // seat's foot wherever the seat stands
  el.sentwrap.rect = { top: 780, bottom: 900 };
  const turn = context.turnBegin(el, NEXT);
  assert.equal(turn.mode, "glide");
  assert.equal(el.body.querySelector(".turnsheet").style.height, "800px", "the picture does not reach the seat at the floor");
  assert.equal(context.caret, typing, "the turn took the caret out of the composer");
  // a board the page has covered, as the desktop's home page covers its stage,
  // is not on show: the answer swaps as it always did, and nothing is held
  const covered = sandbox();
  const hidden = turningCard(covered.context);
  const see = covered.context.getComputedStyle;
  covered.context.getComputedStyle = (node, pseudo) => node === hidden.box
    ? { ...see(node, pseudo), visibility: "hidden" } : see(node, pseudo);
  hidden.readAt = Date.now();
  assert.equal(covered.context.turnBegin(hidden, NEXT), null, "a covered card turned, or held its answer back");
  assert.equal(hidden.body.querySelector(".turnsheet"), null);
  // the pages: a reply landing on the card in use is read whatever the turn
  // does, the answer held back included
  for (const [where, text, rule] of [["the desktop", DESKTOP, "readOnArrival(el, b, b.id === selectedId && !browsing);"],
      ["the phone", PHONE, "readOnArrival(el, b, b.id === selectedId && !browsing && !drawerOpen());"]]) {
    const ask = text.indexOf("const held = turn === TURN_HELD;");
    const read = text.indexOf(rule, ask);
    const go = text.indexOf("turnGo(el, turn);", ask);
    assert.ok(ask > 0 && read > ask && read < go, `${where} does not ask the read rule on every pass of a card`);
    const between = text.slice(text.lastIndexOf("\n", read), read);
    assert.ok(!/held/.test(between), `${where} keeps the read rule from an answer that is held back`);
  }
});

// ---- the delivery marks ------------------------------------------------------------------
const stagesOf = panel => panel.querySelector(".answstack").children.map(node => node.classList.contains("undelivered"));

test("the sent panel reads the board's own record: faded until the board has it, then Delivered, then Read", () => {
  const { context, counts } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  // not yet saved by the board: the panel and the words faded, and no word
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }], true);
  const panel = el.sent;
  assert.equal(panel.classList.contains("undelivered"), true, "a message the board has not saved is not faded");
  assert.deepEqual(stagesOf(panel), [true]);
  assert.equal(panel.dataset.tag, undefined, "a message the board has not saved carries a mark");
  assert.equal(panel.querySelector(".answmark"), null, "a message still on its way carries a mark");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply");
  // the board saved it: full ink, and Delivered under the panel. a message sent
  // after it waits faded on its own, and the panel's grey is back
  const first = panel.querySelector(".answmsg");
  const rooms = counts.rooms;
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }, { text: "Invented two.", stage: "local" }]);
  assert.equal(panel.querySelector(".answmsg"), first, "a change of stage drew the message again");
  assert.equal(panel.classList.contains("undelivered"), false, "the panel stayed faded with a message saved");
  assert.deepEqual(stagesOf(panel), [false, true], "the message not yet saved is not faded on its own");
  assert.equal(panel.dataset.tag, "Delivered");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply, delivered");
  assert.ok(counts.rooms > rooms, "the card was not told the mark took its room");
  // an agent picked it up, its listener confirmed the claim: Read, at full ink
  context.syncSent(el, [{ text: "Invented one.", stage: "delivered" }]);
  assert.equal(panel.dataset.tag, "Read", "a message an agent picked up was not called read");
  assert.deepEqual(stagesOf(panel), [false]);
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply, read");
  // the mark names the newest message that has got anywhere
  context.syncSent(el, [{ text: "Invented one.", stage: "read" }, { text: "Invented two.", stage: "sent" }]);
  assert.equal(panel.dataset.tag, "Delivered", "a later message only saved was called read");
  context.syncSent(el, [{ text: "Invented one.", stage: "read" }, { text: "Invented two.", stage: "delivered" }]);
  assert.equal(panel.dataset.tag, "Read");
  context.syncSent(el, [{ text: "Invented one.", stage: "read" }, { text: "Invented two.", stage: "read" }]);
  assert.equal(panel.dataset.tag, "Read");
  // the phone's own message, not yet on the board: faded, with nothing in its
  // row while it is on its way, and with the ring only when it is being tried again
  const phone = fullCard("c2");
  context.syncSent(phone, [{ text: "Invented from the phone.", stage: "local", state: "pending", op: "op-1" }], true);
  assert.equal(phone.sent.classList.contains("undelivered"), true);
  const row = phone.sent.querySelector(".answmsg");
  assert.equal(row.classList.contains("pending"), true);
  assert.equal(row.querySelector(".answmark"), null, "a send on its way wears a badge");
  context.syncSent(phone, [{ text: "Invented from the phone.", stage: "local", state: "pending", badge: "ring", op: "op-1" }]);
  assert.ok(phone.sent.querySelector(".tsqring"), "a send being tried again wears no ring");
  assert.equal(textsOf(phone.sent.querySelector(".answmark")).length, 0, "the ring has words on it");
  assert.equal(phone.sent.classList.contains("undelivered"), true);
  // a board too old to say leaves the panel as it always was
  const old = fullCard("c3");
  context.syncSent(old, context.sentBatch(["Invented unmarked."]));
  assert.equal(old.sent.classList.contains("undelivered"), false);
  assert.equal(old.sent.dataset.tag, undefined);
  // the panel over an answer says Read: the answer under it is the proof
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  assert.equal(el.answ.dataset.tag, "Read", "the panel over an answer does not say read");
  assert.equal(el.answ.dataset.mark, "Read", "the panel over an answer is not drawn with its word");
});

// the mark's own motion: the record (data-tag), the word on show (data-mark), and
// the two classes the sheet draws the run by
const markOf = panel => [panel.dataset.tag, panel.dataset.mark, panel.classList.contains("markin"), panel.classList.contains("markout")];

test("a mark comes in on a panel that is standing, and the card is told of its room once the run has landed", () => {
  const { context, counts, run, pending, ringFor } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }], true);
  const panel = el.sent;
  panel.isConnected = true;
  assert.deepEqual(markOf(panel), [undefined, undefined, false, false]);
  assert.equal(run("MARK_IN_MS"), 330, "the mark does not come in over the fold's run");
  assert.equal(run("MARK_OUT_MS"), 165, "the mark does not go out over half of it");
  // saved by the board: the word is on show and comes in at once, over the run
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }]);
  assert.deepEqual(markOf(panel), ["Delivered", "Delivered", true, false], "the mark did not come in");
  assert.ok(pending().some(t => t.ms === 350), "no clock ends the mark's run");
  // the room's own run ends with the mark's: the card is told once, after
  const rooms = counts.rooms;
  ringFor(350);
  assert.equal(panel.classList.contains("markin"), false, "the mark's dress outlived its run");
  assert.equal(counts.rooms, rooms + 1, "the card was not told once the room had opened");
  // the same word again does nothing
  const runs = () => pending().filter(t => t.ms === 165 || t.ms === 350).length;
  const armed = runs();
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }, { text: "Invented two.", stage: "local" }]);
  assert.deepEqual(markOf(panel), ["Delivered", "Delivered", false, false], "the same word ran again");
  assert.equal(runs(), armed, "the same word armed a run");
});

test("a mark giving way to the next goes out, is swapped while it is not seen, and comes in: two words are never on show", () => {
  const { context, counts, pending, ringFor } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  // a panel drawn already marked shows its word at once and runs nothing
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }], true);
  const panel = el.sent;
  panel.isConnected = true;
  assert.deepEqual(markOf(panel), ["Delivered", "Delivered", false, false], "a panel drawn marked ran a mark in");
  assert.ok(!pending().some(t => t.ms === 165 || t.ms === 350), "a panel drawn marked armed a run");
  // an agent picked it up: the record says Read at once, and the word on show is
  // still the old one while it fades out
  context.syncSent(el, [{ text: "Invented one.", stage: "delivered" }]);
  assert.deepEqual(markOf(panel), ["Read", "Delivered", false, true], "the old word was not faded out first");
  const rooms = counts.rooms;
  ringFor(165);
  assert.deepEqual(markOf(panel), ["Read", "Read", true, false], "the new word did not come in when the old had gone");
  ringFor(350);
  assert.deepEqual(markOf(panel), ["Read", "Read", false, false]);
  assert.equal(counts.rooms, rooms, "a word for a word moved the room");
  // a word that goes with none after it: faded out, then the room closes with it
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }]);
  assert.deepEqual(markOf(panel), [undefined, "Read", false, true]);
  const closing = counts.rooms;
  ringFor(165);
  assert.deepEqual(markOf(panel), [undefined, undefined, false, false], "a word with nothing after it was left on show");
  ringFor(350);
  assert.equal(counts.rooms, closing + 1, "the card was not told the room closed");
});

test("a change that lands while a mark is going out is not started again, and the last word is the one that lands", () => {
  const { context, pending, ringFor } = sandbox();
  const el = fullCard("c1");
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }], true);
  const panel = el.sent;
  context.syncSent(el, [{ text: "Invented one.", stage: "delivered" }]);
  assert.equal(pending().filter(t => t.ms === 165).length, 1);
  // the record moves again before the swap: no second run is armed, and the word
  // that lands is the record's when the swap is made
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }]);
  assert.equal(pending().filter(t => t.ms === 165).length, 1, "a second fade out was armed");
  assert.deepEqual(markOf(panel), [undefined, "Delivered", false, true]);
  ringFor(165);
  assert.deepEqual(markOf(panel), [undefined, undefined, false, false], "an old target was swapped in");
  // a word still coming in when the next change has swapped it again: the clock
  // of the run before leaves the dress of the run that is on
  const { context: again, pending: waiting, ringFor: letGo } = sandbox();
  const two = fullCard("c1");
  again.syncSent(two, [{ text: "Invented one.", stage: "sent" }], true);
  again.syncSent(two, [{ text: "Invented one.", stage: "delivered" }]);
  letGo(165);
  again.syncSent(two, [{ text: "Invented one.", stage: "sent" }]);
  letGo(165);
  const clocks = waiting().filter(t => t.ms === 350);
  assert.equal(clocks.length, 2, "each run has its own clock");
  clocks[0].fn();
  assert.equal(two.sent.classList.contains("markin"), true, "an older run's clock took the newer run's dress off");
  clocks[1].fn();
  assert.equal(two.sent.classList.contains("markin"), false);
});

test("a reader who asked for no motion, or a panel that was not standing, is given the word at once", () => {
  const { context, pending } = sandbox();
  context.stillness = true;
  const el = fullCard("c1");
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }], true);
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }]);
  assert.deepEqual(markOf(el.sent), ["Delivered", "Delivered", false, false], "the mark ran against the setting");
  context.syncSent(el, [{ text: "Invented one.", stage: "delivered" }]);
  assert.deepEqual(markOf(el.sent), ["Read", "Read", false, false], "the mark was swapped with a run against the setting");
  context.syncSent(el, [{ text: "Invented one.", stage: "local" }]);
  assert.deepEqual(markOf(el.sent), [undefined, undefined, false, false]);
  assert.ok(!pending().some(t => t.ms === 165 || t.ms === 350), "a clock stands behind a mark that did not run");
  // the panel over an answer is drawn with its word, and a page that draws it again keeps it
  const { context: live } = sandbox();
  const card = fullCard("c2");
  live.syncAnswered(card, live.liveAnswered(liveBox()));
  assert.deepEqual(markOf(card.answ), ["Read", "Read", false, false], "the panel over an answer ran its word in");
  live.syncAnswered(card, live.liveAnswered(liveBox()));
  assert.deepEqual(markOf(card.answ), ["Read", "Read", false, false]);
  // and the timed refresh waits out a mark's run as it does a panel's
  live.moving = [".answered.markin"];
  assert.equal(live.cardsMoving(), true, "a mark coming in did not hold the refresh");
  live.moving = [".answered.markout"];
  assert.equal(live.cardsMoving(), true, "a mark going out did not hold the refresh");
});

test("the page turn flips the sent panel's mark on the way up and holds the new panel's mark out, so no two words are drawn together", () => {
  const { context, run, ringFor } = sandbox();
  const saved = SENT.map(text => ({ text, stage: "sent" }));
  const el = turningCard(context, saved);
  ringFor(run("SENT_ARRIVE_MS") + 60);
  // the panel was in the middle of a change when the reader's reply came: the
  // picture is taken as still, without the classes that move
  context.syncSent(el, SENT.map(text => ({ text, stage: "delivered" })));
  assert.equal(el.sent.classList.contains("markout"), true);
  const turn = context.turnBegin(el, NEXT);
  const page = el.body.querySelector(".turnpage");
  const old = page.querySelector(".answered.sent");
  assert.equal(old.classList.contains("markout") || old.classList.contains("markin"), false,
    "the picture of the panel carried a mark's motion in");
  assert.equal(old.dataset.mark, "Delivered");
  el.reply.dataset.raw = "The invented new answer.";
  el.reply.innerHTML = markdown.render(el.reply.dataset.raw);
  context.syncSent(el, context.sentBatch([]));
  el.answwrap.rect = { top: 120, bottom: 200 };
  context.syncAnswered(el, context.liveAnswered(NEXT));
  context.turnGo(el, turn);
  // the new page's panel stands behind the old, and holds its word out
  const fresh = page.children[0].querySelector(".answered");
  assert.equal(fresh.dataset.mark, "Read");
  assert.equal(fresh.classList.contains("markout"), true, "the new page's mark is drawn under the old panel's");
  // the old panel turns its own word to Read on the way up
  assert.deepEqual(markOf(old), ["Read", "Delivered", false, true], "the old panel's mark did not go out");
  ringFor(165);
  assert.deepEqual(markOf(old), ["Read", "Read", true, false], "the old panel's mark did not come in as Read");
  assert.equal(fresh.classList.contains("markout"), true, "the new page's mark was let out during the glide");
  // the panel that stays is the card's own, and was never held out
  assert.deepEqual(markOf(el.answ), ["Read", "Read", false, false]);
  // one that was still faded when the reply landed takes its full ink up with it
  const other = sandbox();
  const faded = turningCard(other.context, SENT.map(text => ({ text, stage: "local" })));
  const held = other.context.turnBegin(faded, NEXT);
  const picture = faded.body.querySelector(".turnpage").querySelector(".answered.sent");
  assert.equal(picture.classList.contains("undelivered"), true);
  assert.equal(picture.querySelectorAll(".undelivered").length > 1, true, "the picture's messages were not faded");
  faded.reply.innerHTML = markdown.render("The invented new answer.");
  other.context.syncSent(faded, other.context.sentBatch([]));
  faded.answwrap.rect = { top: 120, bottom: 200 };
  other.context.syncAnswered(faded, other.context.liveAnswered(NEXT));
  other.context.turnGo(faded, held);
  assert.equal(picture.querySelectorAll(".undelivered").length, 0, "the picture stayed faded on its way to the new page");
  assert.deepEqual(markOf(picture), ["Read", "Read", true, false], "no mark came in on the panel that had none");
});

test("both pages draw the marks from the shared files alone, and the sheet runs them on the fold's own curve and length", () => {
  assert.ok(!/data-mark|data-tag|markin|markout/.test(DESKTOP + PHONE), "a page draws a mark of its own");
  assert.match(TOKENS, /@property --answ-fill\{syntax:"<color>"; inherits:true; initial-value:transparent\}/,
    "the panel's grey cannot run without being a colour");
  assert.ok(rules(TOKENS, ".answered").some(one => /transition:margin-bottom var\(--answ-move\) var\(--gentle\), --answ-fill var\(--answ-move\) var\(--gentle\)/.test(one)),
    "the room and the grey do not run on the fold's length and curve");
  assert.match(rule(TOKENS, ".answered.motion"), /margin-bottom var\(--answ-move\) var\(--gentle\),\s*--answ-fill var\(--answ-move\) var\(--gentle\)/,
    "a run in progress dropped the room's and the grey's own run");
  const props = [...keyframes(TOKENS, "markin").matchAll(/([a-z-]+):/g)].map(m => m[1]);
  assert.deepEqual([...new Set(props)].sort(), ["opacity", "transform"], "the mark comes in on more than strength and a transform");
  assert.match(rule(TOKENS, ".answered.markin::after"), /animation:markin var\(--answ-move\) var\(--gentle\) backwards/);
  assert.match(rule(TOKENS, ".answered.markout::after"), /opacity:0; transition:opacity calc\(var\(--answ-move\) \/ 2\) var\(--gentle\)/);
  assert.match(TOKENS, /--answ-move:\.33s/, "the fold's run is not the length the mark's clocks are set for");
});

test("the panel's list is the board's reading: a note's messages first, read, then the queue where it stands", () => {
  const { context } = sandbox();
  const list = context.sentFrom({ notedTexts: ["Invented noted."], pendingTexts: ["Invented queued.", "Invented later."],
    pendingStates: ["delivered", "sent"] });
  assert.deepEqual(JSON.parse(JSON.stringify(list)), [
    { text: "Invented noted.", stage: "read" },
    { text: "Invented queued.", stage: "delivered" },
    { text: "Invented later.", stage: "sent" },
  ]);
  // an older board with no record leaves every stage blank
  assert.deepEqual(JSON.parse(JSON.stringify(context.sentFrom({ pendingTexts: ["Invented bare."] }))),
    [{ text: "Invented bare.", stage: "" }]);
  // the pages draw from it on every reading, and a send lands as sent
  assert.match(DESKTOP, /el\.sentItems = sentFrom\(b\);\s*syncSent\(el, el\.sentItems\);/);
  assert.match(PHONE, /el\.sentItems = sentFrom\(b\);\s*drawSent\(el, b\.id\);/);
  assert.match(PHONE, /el\.sentItems = \[\.\.\.el\.sentItems, \{ text: op\.text, stage: "sent" \}\];/);
  assert.match(PHONE, /batch\.push\(\{ text: op\.text, op: op\.id, state: op\.state, badge: opBadge\(op\), stage: "local" \}\);/,
    "the phone's own messages are not marked as not yet on the board");
  // and the sheet draws the stages: faded words and grey, the one quiet mark in its room
  assert.match(rule(TOKENS, ".answered.undelivered"), /--answ-fill:color-mix\(in srgb, var\(--bubble-fill\) 50%, var\(--card, #fff\)\)/);
  assert.match(rule(TOKENS, ".answmsg.undelivered > :not(.answmark)"), /opacity:\.5/);
  assert.match(rule(TOKENS, ".answmsg > *"), /transition:opacity var\(--answ-move\) var\(--gentle\)/);
  assert.match(rule(TOKENS, ".answered[data-mark]"), /margin-bottom:var\(--answ-tag\)/);
  const mark = rule(TOKENS, ".answered[data-mark]::after");
  assert.match(mark, /content:attr\(data-mark\); position:absolute; top:100%; right:var\(--answ-round\);/);
  assert.match(mark, /font:10\.5px\/1\.35 var\(--mono\); color:var\(--sub\);/);
  assert.match(mark, /pointer-events:none/);
});

test("a send is faded from the press, Delivered once the board answers, and taken out again if the board does not", () => {
  const { context } = sandbox();
  const el = fullCard("c1");
  const item = context.sentLaunch(el, "Invented one.");
  assert.equal(item.stage, "local");
  assert.equal(el.sent.classList.contains("undelivered"), true, "a send on its way is not faded");
  assert.equal(el.sent.dataset.tag, undefined, "a send on its way carries a word");
  assert.equal(el.sendGuard, Infinity, "a reading asked before the board had it may replace the list");
  // a second send while the first is out: the guard stands until both have settled
  const second = context.sentLaunch(el, "Invented two.");
  context.sentLanded(el, item);
  assert.equal(item.stage, "sent");
  assert.equal(el.sendGuard, Infinity, "the guard came down with a send still out");
  assert.equal(el.sent.dataset.tag, "Delivered");
  assert.deepEqual(stagesOf(el.sent), [false, true], "the send still out is not faded on its own");
  context.sentLanded(el, second);
  assert.ok(Number.isFinite(el.sendGuard), "the guard did not come down once every send had settled");
  assert.equal(el.sent.classList.contains("undelivered"), false);
  // landing again, or failing one that landed, changes nothing
  context.sentLanded(el, second);
  context.sentFailed(el, second, false);
  assert.deepEqual([...el.sentItems.map(m => m.stage)], ["sent", "sent"]);
  assert.equal(el.sendsOut, 0);
  assert.equal((el.sentHeld || []).length, 0);
  // a send the board did not take stays in the panel, held out of the board's readings
  const lost = context.sentLaunch(el, "Invented three.");
  assert.equal(el.sent.querySelectorAll(".answmsg").length, 3);
  context.sentFailed(el, lost, false);
  assert.equal(lost.stage, "local", "a send the board did not take was called sent");
  assert.deepEqual([...el.sentItems.map(m => m.text)], ["Invented one.", "Invented two."]);
  assert.deepEqual([...el.sentHeld.map(m => m.text)], ["Invented three."]);
  assert.equal(el.sent.querySelectorAll(".answmsg").length, 3, "a send the board did not take left the panel");
  assert.equal(el.sendsOut, 0);
  assert.ok(Number.isFinite(el.sendGuard));
  // the board's reading replaces its own list and the held send is still drawn
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }]);
  assert.deepEqual(el.sent.querySelectorAll(".answmsg").map(row => row.dataset.text), ["Invented one.", "Invented three."],
    "the board's reading took the held send away");
  // the only message failed: the panel stays, holding it
  const alone = fullCard("c2");
  const only = context.sentLaunch(alone, "Invented only.");
  context.sentFailed(alone, only, false);
  assert.ok(alone.sent, "a panel holding the one failed message went");
  assert.equal(alone.sent.classList.contains("undelivered"), true);
});

// the badge of a failed send, and what each press on it does. fetch is the
// test's own, so each answer the board could give is the test's to choose
function held(context, text, route = "/send?box=c1") {
  const el = fullCard("c1");
  Object.assign(el, { tick() {} });
  el.ta.value = "";
  const item = context.sentLaunch(el, text, route);
  context.sentFailed(el, item, false);
  return { el, item };
}
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("a failed send wears the red round mark with its cross, and no words", () => {
  const { context } = sandbox();
  const { el, item } = held(context, "Invented failed.");
  const mark = el.sent.querySelector(".answmark");
  assert.ok(mark, "a failed send wears no mark");
  assert.equal(mark.dataset.kind, "fail");
  assert.equal(textsOf(mark).length, 0, "the mark carries words");
  assert.ok(mark.querySelector(".answretry"), "no circular arrow");
  assert.ok(mark.querySelector(".answcross"), "no cross");
  assert.match(mark.querySelector(".answretry").innerHTML, /<polyline/);
  assert.equal(el.sent.querySelector(".answmsg").dataset.op, item.op);
  assert.equal(el.sent.querySelector(".answnote"), null);
  // the same message tried again by the phone itself shows the ring and no buttons
  item.badge = "ring";
  context.syncSent(el, el.sentItems);
  assert.ok(el.sent.querySelector(".tsqring"));
  assert.equal(el.sent.querySelector(".answretry"), null);
  assert.equal(el.sent.querySelector(".answcross"), null);
});

test("the arrow sends the held message again under its own id, and lands it once", async () => {
  const { context } = sandbox();
  const { el, item } = held(context, "Invented retry.");
  const id = item.op;
  const seen = [];
  context.fetch = async (url, init) => { seen.push([url, init.method, init.body]); return reply(200, { ok: true }); };
  let landed = 0;
  item.landed = () => { landed++; };
  await context.sentRetry(el, item);
  assert.deepEqual(seen, [["/send?box=c1&op=" + encodeURIComponent(id), "POST", "Invented retry."]], "the retry did not reuse the id");
  assert.equal(item.stage, "sent");
  assert.equal(landed, 1);
  assert.equal((el.sentHeld || []).length, 0);
  assert.equal(el.sent.dataset.tag, "Delivered");
  assert.equal(el.sent.querySelector(".answmark"), null, "a landed message kept its mark");
  // pressing it again does nothing: it is no longer held
  await context.sentRetry(el, item);
  assert.equal(seen.length, 1);
  // a retry that does not get through puts the mark back
  const second = context.sentLaunch(el, "Invented again.", "/send?box=c1");
  context.sentFailed(el, second, false);
  context.fetch = async () => { throw new Error("offline"); };
  await context.sentRetry(el, second);
  assert.equal(second.badge, "fail");
  assert.equal(el.sentHeld.length, 1);
  assert.equal(el.sendsOut, 0);
});

test("the arrow on a refused message does nothing and shows no reason", async () => {
  const { context } = sandbox();
  const el = fullCard("c1");
  const item = context.sentLaunch(el, "Invented refused.", "/send?box=c1");
  context.sentFailed(el, item, true);
  let asked = 0;
  context.fetch = async () => { asked++; return reply(200, {}); };
  await context.sentRetry(el, item);
  assert.equal(asked, 0, "the arrow sent a refused message again");
  assert.equal(item.badge, "fail");
  assert.equal(el.sentHeld.length, 1);
  assert.ok(el.sent.querySelector(".answmark"));
  assert.equal(textsOf(el.sent.querySelector(".answmark")).length, 0);
});

test("a try is told landed, refused or failed by what the board answers", async () => {
  const { context } = sandbox();
  const item = { text: "Invented.", op: "op-x", route: "/send?box=c1" };
  const tries = [];
  context.fetch = async (url, init) => { tries.push(init.signal && typeof init.signal.aborted); return reply(context.said); };
  for (const [status, want] of [[200, "landed"], [400, "refused"], [409, "refused"], [413, "refused"], [500, "failed"], [502, "failed"], [401, "failed"]]) {
    context.said = status;
    assert.equal(await context.sentTry(item), want, `${status}`);
  }
  assert.ok(tries.every(t => t === "boolean"), "a try has no time limit");
  context.fetch = async () => { throw new Error("offline"); };
  assert.equal(await context.sentTry(item), "failed");
});

test("the cross asks the board first: landed makes the row Delivered, not landed gives the words back", async () => {
  const { context } = sandbox();
  // the board has it
  let h = held(context, "Invented landed.");
  h.el.ta.value = "Invented draft.";
  let asked = [];
  context.fetch = async url => { asked.push(url); return reply(200, { status: "applied", kind: "send", box: "c1", result: {} }); };
  let landed = 0;
  h.item.landed = () => { landed++; };
  await context.sentCross(h.el, h.item);
  assert.deepEqual(asked, ["/op?id=" + encodeURIComponent(h.item.op)]);
  assert.equal(h.el.ta.value, "Invented draft.", "words were taken back for a message that landed");
  assert.equal(h.item.stage, "sent");
  assert.equal(h.el.sent.dataset.tag, "Delivered");
  assert.equal(h.el.sent.querySelector(".answmark"), null);
  assert.equal(landed, 1);
  // the board does not have it
  h = held(context, "Invented not landed.");
  h.el.ta.value = "Invented draft.";
  context.fetch = async () => reply(200, { status: "unknown" });
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.ta.value, "Invented draft.\n\nInvented not landed.", "the words did not go back after the draft");
  assert.equal(h.el.sent, null, "the message stayed in the panel");
  // with nothing in the bar the words go in alone
  h = held(context, "Invented alone.");
  context.fetch = async () => reply(200, { status: "unknown" });
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.ta.value, "Invented alone.");
});

test("the cross does nothing while the board cannot be asked, and a refused message gives its words back at once", async () => {
  const { context } = sandbox();
  let h = held(context, "Invented unreachable.");
  context.fetch = async () => { throw new Error("offline"); };
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.ta.value, "");
  assert.equal(h.el.sentHeld.length, 1, "the message was taken back with no answer from the board");
  assert.ok(h.el.sent.querySelector(".answmark"));
  context.fetch = async () => reply(503, {});
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.sentHeld.length, 1);
  assert.equal(h.el.ta.value, "");
  // past the receipt's certain window "unknown" proves nothing
  h.item.ts = Date.now() - 37 * 3600 * 1000;
  context.fetch = async () => reply(200, { status: "unknown" });
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.sentHeld.length, 1);
  assert.equal(h.el.ta.value, "");
  // once it can be asked, it is
  h.item.ts = Date.now();
  await context.sentCross(h.el, h.item);
  assert.equal(h.el.ta.value, "Invented unreachable.");
  // a refused message is known not to have landed: no question is asked
  const el = fullCard("c2");
  Object.assign(el, { tick() {} });
  el.ta.value = "";
  const refused = context.sentLaunch(el, "Invented refused.", "/send?box=c2");
  context.sentFailed(el, refused, true);
  let asked = 0;
  context.fetch = async () => { asked++; return reply(200, {}); };
  await context.sentCross(el, refused);
  assert.equal(asked, 0);
  assert.equal(el.ta.value, "Invented refused.");
  assert.equal(el.sent, null);
});

test("a reading the board answers asks once about each held message, and a landed one becomes Delivered", async () => {
  const { context } = sandbox();
  const h = held(context, "Invented late.");
  let asked = 0;
  context.fetch = async () => { asked++; return reply(200, { status: "unknown" }); };
  await context.sentAskHeld(h.el);
  await context.sentAskHeld(h.el);
  assert.equal(asked, 1, "the board was asked again for a message it had already said unknown for");
  assert.equal(h.el.sentHeld.length, 1);
  const g = held(context, "Invented landed late.");
  context.fetch = async () => reply(200, { status: "applied", kind: "send", box: "c1", result: {} });
  await context.sentAskHeld(g.el);
  assert.equal(g.item.stage, "sent");
  assert.equal(g.el.sentHeld.length, 0);
  assert.equal(g.el.sent.dataset.tag, "Delivered");
  // a board that could not be reached is asked again at the next reading
  const k = held(context, "Invented waiting.");
  context.fetch = async () => { throw new Error("offline"); };
  await context.sentAskHeld(k.el);
  assert.equal(k.item.checked, false);
});

test("a press on the mark's buttons goes to the page, and no press on its row opens the panel", () => {
  const { context } = sandbox();
  const { el, item } = held(context, "Invented pressed.");
  const calls = [];
  context.sentMarkAct = (card, op, act) => { calls.push([op, act]); };
  const cross = el.sent.querySelector(".answcross");
  const retry = el.sent.querySelector(".answretry");
  let stopped = 0;
  context.sentBadgePress(el, { target: retry, stopPropagation() { stopped++; } });
  context.sentBadgePress(el, { target: cross, stopPropagation() { stopped++; } });
  assert.deepEqual(calls, [[item.op, "retry"], [item.op, "cross"]]);
  assert.equal(stopped, 2);
});

test("the small card turns the same way, its three pieces pictured and carried up in one glide", () => {
  const { context, run } = sandbox();
  // the small card: its panel over the answer, its answer, its sent panel, one column in the card
  const box = element("div");
  box.className = "mbox";
  const answwrap = element("div"); answwrap.className = "answwrap";
  const reply = element("div"); reply.className = "mreply cardmd";
  const sentwrap = element("div"); sentwrap.className = "sentwrap";
  box.append(answwrap, reply, sentwrap);
  const el = { box, reply, answwrap, answ: null, answId: null, sentwrap, sent: null, sentKey: "", sentItems: [],
               ta: element("textarea") };
  context.syncSent(el, [{ text: SENT[0], stage: "sent" }], true);
  box.rect = { top: 0, bottom: 400 };
  reply.rect = { top: 40, bottom: 300 };
  sentwrap.rect = { top: 300, bottom: 360 };
  reply.scrollTop = 12;
  // a card only held in the list and not the one on show turns nothing
  box.classList.add("off");
  assert.equal(context.turnBegin(el, NEXT), null, "a small card not on show turned");
  box.classList.remove("off");
  // typing in its own row holds the answer back
  el.ta.typedAt = Date.now();
  assert.equal(context.turnBegin(el, NEXT), run("TURN_HELD"), "typing in the small card did not hold the answer");
  el.ta.typedAt = 0;
  const turn = context.turnBegin(el, NEXT);
  assert.equal(turn.mode, "glide", "the small card did not glide");
  const sheet = box.querySelector(".turnsheet");
  assert.ok(sheet && sheet.parentNode === box, "the small card's picture is not over its column");
  assert.equal(sheet.style.top, "40px", "the picture does not start at the card's first piece");
  assert.equal(sheet.style.height, "320px");
  const page = sheet.querySelector(".turnpage");
  assert.deepEqual(page.children.map(node => node.className), ["mreply cardmd", "sentwrap"],
    "the small card's picture is not its answer and its sent panel");
  assert.equal(page.children[0].scrollTop, 12, "the picture is not at the reader's scroll");
  // the new page under it: the sent messages as the panel over the answer, and the answer
  reply.innerHTML = markdown.render("Invented short answer.");
  context.syncSent(el, []);
  context.syncAnswered(el, context.liveAnswered(NEXT), null);
  answwrap.rect = { top: 40, bottom: 100 };
  reply.rect = { top: 100, bottom: 300 };
  context.turnGo(el, turn);
  assert.deepEqual(page.children.map(node => node.className), ["answwrap", "mreply cardmd", "mreply cardmd", "sentwrap"]);
  assert.equal(page.children[0].style.top, "260px", "the new panel does not wait behind the old sent panel");
  assert.equal(page.children[1].style.top, "320px", "the new answer is not in place under the new panel");
  assert.equal(page.style.transform, "translate3d(0, -260px, 0)");
  page.fire("transitionend", { target: page, propertyName: "transform" });
  assert.equal(box.querySelector(".turnsheet"), null);
  assert.equal(reply.classList.contains("printing"), false, "the small card faded its answer in after the glide");
  // and the page hands its small cards the same turn around the same passes
  const mini = DESKTOP.slice(DESKTOP.indexOf("function renderMiniCards(state){"));
  const ask = mini.indexOf("? turnBegin(el, b) : null;");
  const go = mini.indexOf("turnGo(el, turn);");
  assert.ok(ask > 0 && go > mini.indexOf("syncSent(el, el.sentItems);") && go > ask,
    "the small card does not lay its picture first and glide once its new page is drawn");
  assert.match(mini, /watchReading\(el\);/);
  assert.match(mini, /noteTyping\(ta\);/);
  assert.match(DESKTOP, /#magic2 \.turnsheet\{background:inherit\}/);
});

// ---- cutting back the way it opened ----------------------------------------------------------
// the answer's scroller as a browser keeps it: its content is the panel's cut at
// the head of it (seat down from the start of the content), the answer (base)
// under it and whatever room is held at its foot, and whenever the page is laid
// out a scroll past the new end is pulled back to it (pulled). the cut is laid
// out, and so pulls the scroll, whenever the panel reads how tall its preview
// stands. every scroll a layout leaves is kept (seen) and every scroll the
// script writes (writes), so a pull inside a press shows even when the script
// writes the scroll back before the press is over. the view's top is at 0 on
// the screen unless a test puts it elsewhere, and the panel reports where its
// own head stands. head is where the panel's head stands on the screen, foot
// where its foot does, which is where the answer under the panel stands too,
// both from the view's top. a run caught part way stands its cut at clip.midRun
function scrollingView(view, clip, base, height, seat = 0) {
  let top = 0;
  let laying = false;
  const seen = [];
  const pulled = [];
  const writes = [];
  const slack = () => parseFloat(view.style.getPropertyValue("--answ-slack")) || 0;
  Object.defineProperty(view, "scrollHeight", { configurable: true,
    get: () => base + clip.getBoundingClientRect().height + slack() });
  const layout = () => {
    const max = Math.max(0, view.scrollHeight - view.clientHeight);
    if (top > max) { pulled.push({ from: top, to: max }); top = max; }
    seen.push(top);
  };
  Object.defineProperty(view, "scrollTop", { configurable: true,
    get: () => top, set: value => { writes.push(value); top = Math.max(0, value); layout(); } });
  view.clientHeight = height;
  const cut = clip.clientHeight;
  Object.defineProperty(clip, "clientHeight", { configurable: true,
    get: () => {
      if (!laying) { laying = true; layout(); laying = false; }
      return cut;
    } });
  clip.parentNode.getBoundingClientRect = () => {
    const at = (view.rect ? view.rect.top : 0) + seat - top;
    const tall = clip.getBoundingClientRect().height;
    return { top: at, bottom: at + tall, left: 0, right: 0, width: 0, height: tall };
  };
  const foot = () => seat + clip.getBoundingClientRect().height - top;
  const head = () => seat - top;
  return { layout, slack, seen, pulled, writes, foot, head, seat, top: () => top };
}
// a run played the way a browser plays it: at each height the transition has the
// cut at, the layout it leaves, then the frame's own callbacks, then what the
// frame draws
function playRun(view, clip, frame, heights) {
  const drawn = [];
  for (const h of heights) {
    clip.midRun = h;
    view.layout();
    frame();
    view.layout();
    drawn.push({ cut: h, scroll: view.seen.at(-1), foot: view.foot(), head: view.head() });
  }
  return drawn;
}
// the press that cuts an open panel back. the transition starts from the height
// the panel stands at, which is what any layout inside the press itself reads
function cutBack(panel, clip, from) {
  clip.midRun = from;
  panel.fire("click", { target: panel });
}
// a card whose panel has been opened, standing in a scroller as the test says: base
// of answer under the 240 batch, a view height tall, the panel seat down from the
// start of the content
function openedCard(base, height, seat = 0) {
  const s = sandbox();
  const el = card("c1");
  s.context.syncAnswered(el, s.context.liveAnswered(liveBox()));
  const clip = layOutLong(el.answ, FakeResizeObserver.made[0]);
  el.answ.fire("click", { target: el.answ });
  landRun(el.answ);
  return { ...s, el, panel: el.answ, clip, view: scrollingView(el.replyview, clip, base, height, seat) };
}
// a cut played from its press over the heights given, checked for what the reader
// sees. the part of the panel above the view's top (hidden) is given up first: the
// scroll goes back on every frame by what the cut has taken so far, no further
// than the hidden part, so the foot and the answer under it stay where they stand
// until the hidden part is used up and come up by the rest of the cut, and the
// panel's head is never scrolled into sight. the press writes the scroll once, the
// frames once each, and the browser never pulls it
function cutOnScreen(view, panel, clip, frame, from, heights, where) {
  const scroll = view.top();
  const hidden = Math.floor(Math.max(0, 0 - view.head()));
  const scrolls = heights.map(h => scroll - Math.max(0, Math.min(hidden, from - h)));
  view.writes.length = 0;
  view.pulled.length = 0;
  cutBack(panel, clip, from);
  assert.equal(panel.classList.contains("motion"), true, `${where}: the cut back did not run`);
  assert.deepEqual(view.writes, [scroll], `${where}: the press did more to the scroll than put the reader back where they were`);
  const frames = playRun(view, clip, frame, heights);
  assert.deepEqual(frames.map(f => f.scroll), scrolls, `${where}: the scroll did not go back by what the cut had taken, up to the hidden part`);
  assert.deepEqual(frames.map(f => f.foot), heights.map((h, i) => view.seat + h - scrolls[i]),
    `${where}: the foot did not come up by what the cut takes past the hidden part`);
  assert.deepEqual(frames.map(f => f.head), scrolls.map(s => view.seat - s), `${where}: the panel's head is not where the scroll leaves it`);
  if (hidden > 0)
    assert.ok(frames.every(f => f.head <= 0), `${where}: the panel's head came into sight during the run`);
  assert.deepEqual(view.pulled, [], `${where}: the browser pulled the view during the run`);
  assert.deepEqual(view.writes, hidden > 0 ? [scroll, ...scrolls] : [scroll],
    `${where}: the scroll was written other than once for the press and once for each frame of a followed run`);
  return frames;
}

test("a cut back with more of the panel above the view than the cut takes off scrolls the view back with the cut, so the answer stays where it stands", () => {
  const { el, panel, clip, view, frame, waiting } = openedCard(400, 400);
  assert.equal(panel.answView, el.replyview, "the panel does not know the scroller it rides in");
  // 400 of answer under a 240 batch in a 400 view, scrolled 200 down: the head
  // stands 200 above the view's top, the foot 40 below it, and the cut takes 182
  // off the batch, which is less than the 200 hidden
  el.replyview.scrollTop = 200;
  assert.equal(view.head(), -200);
  assert.equal(view.foot(), 40);
  view.seen.length = 0;
  view.pulled.length = 0;
  view.writes.length = 0;
  cutBack(panel, clip, 240);
  assert.equal(panel.classList.contains("motion"), true, "the cut back did not run");
  assert.deepEqual(clip.style.heights.slice(-2), ["240px", "58px"], "the run is not the panel's cut shrinking");
  // the press itself moves nothing: the view is where it was, room is held under
  // the answer for what the cut takes so no layout of the run pulls the scroll,
  // and the view is asked to follow the cut on its frames
  assert.deepEqual([...new Set(view.seen)], [200], "the view was pulled while the press was handled");
  assert.deepEqual(view.writes, [200], "the press did more to the scroll than put the reader back where they were");
  assert.equal(view.slack(), 142, "the room held is not what the run needs");
  assert.equal(panel.style.getPropertyValue("margin-top"), "", "the panel is held down by a margin");
  assert.equal(waiting(), 1, "the view is not asked to follow the cut on its frames");
  // the frames: the cut at heights the transition passes through. the scroll goes
  // back by what the cut has taken, so the foot and the answer under it do not move
  // at all, and the head, still above the view, comes down with the scroll
  const frames = playRun(view, clip, frame, [240, 208, 149, 100, 72, 58]);
  assert.deepEqual(frames.map(f => f.scroll), [200, 168, 109, 60, 32, 18], "the scroll did not go back with the cut");
  assert.deepEqual(frames.map(f => f.foot), Array(6).fill(40), "the foot and the answer under it moved");
  assert.deepEqual(frames.map(f => f.head), [-200, -168, -109, -60, -32, -18]);
  assert.ok(frames.every(f => f.head < 0), "the panel's head came into sight during the run");
  assert.deepEqual(view.pulled, [], "the browser pulled the view during the run");
  assert.deepEqual(view.writes, [200, 200, 168, 109, 60, 32, 18], "the scroll was written other than once per frame");
  assert.equal(panel.style.getPropertyValue("margin-top"), "", "a margin was written during the run");
  assert.equal(waiting(), 1, "the follow does not ask for the frame after this one");
  // landed: the far end is written for a run that ends between frames, the room
  // the view no longer stands on is let go, and the frame that was still waiting
  // finds the run over and asks for no more
  clip.midRun = null;
  landRun(panel);
  assert.equal(el.replyview.scrollTop, 18, "the scroll did not land where the cut leaves it");
  assert.equal(view.foot(), 40, "the answer moved as the panel landed");
  assert.equal(view.head(), -18);
  assert.deepEqual(view.pulled, [], "the browser pulled the scroll as the panel landed");
  assert.equal(view.slack(), 0, "room was kept that the view does not stand on");
  frame();
  assert.equal(waiting(), 0, "the follow went on asking for frames after the run landed");
  assert.deepEqual(view.writes, [200, 200, 168, 109, 60, 32, 18, 18], "the landing wrote more than the far end");
});

test("a cut back with less of the panel above the view than the cut takes off scrolls back by the hidden part, and the answer rises by the rest", () => {
  const { el, panel, clip, view, frame, waiting } = openedCard(400, 400);
  // scrolled 100 down: 100 of the head is above the view, the cut takes 182
  el.replyview.scrollTop = 100;
  assert.equal(view.foot(), 140);
  const frames = cutOnScreen(view, panel, clip, frame, 240, [240, 208, 149, 100, 72, 58], "the hidden part shorter than the cut");
  assert.deepEqual(frames.map(f => f.scroll), [100, 68, 9, 0, 0, 0], "the scroll did not go back by the hidden part");
  assert.deepEqual(frames.map(f => f.foot), [140, 140, 140, 100, 72, 58],
    "the answer did not stay put while the hidden part lasted and come up by the rest");
  assert.deepEqual(frames.map(f => f.head), [-100, -68, -9, 0, 0, 0], "the panel's head went past the top of the view");
  assert.equal(view.slack(), 42, "the room held is not what the run needs");
  clip.midRun = null;
  landRun(panel);
  assert.equal(el.replyview.scrollTop, 0);
  assert.equal(view.foot(), 58);
  assert.equal(frames[0].foot - view.foot(), 182 - 100, "the answer did not rise by what the hidden part could not give");
  assert.equal(view.slack(), 0, "room was kept that the view does not stand on");
  assert.deepEqual(view.pulled, []);
  frame();
  assert.equal(waiting(), 0);

  // a hidden part that is not a whole number of points is counted down, so the
  // scroll stops with the head still above the view, not at its top
  const part = openedCard(400, 400, 0.6);
  part.el.replyview.scrollTop = 100;
  const rounded = cutOnScreen(part.view, part.panel, part.clip, part.frame, 240, [240, 208, 149, 100, 58], "the hidden part in fractions");
  assert.deepEqual(rounded.map(f => f.scroll), [100, 68, 9, 1, 1]);
  assert.ok(rounded.every(f => f.head < 0), "the panel's head reached the view's top");
  part.clip.midRun = null;
  landRun(part.panel);
  assert.equal(part.el.replyview.scrollTop, 1);
  assert.equal(part.view.head(), 0.6 - 1, "the head was scrolled into sight");
});

test("a cut back with nothing of the panel above the view is cut from its foot with the scroll left alone, as ever", () => {
  // the panel at the top, its head in sight
  const top = openedCard(400, 400);
  assert.equal(top.view.top(), 0);
  const flush = cutOnScreen(top.view, top.panel, top.clip, top.frame, 240, [240, 149, 58], "the panel at the top");
  assert.deepEqual(flush.map(f => f.foot), [240, 149, 58], "the answer under the panel does not come up with its foot");
  assert.deepEqual(flush.map(f => f.scroll), [0, 0, 0]);
  assert.equal(top.waiting(), 0, "the view is asked to follow a cut that has nothing above the view");
  assert.equal(top.view.slack(), 0, "room was held under a view standing at its top");
  top.clip.midRun = null;
  landRun(top.panel);
  assert.equal(top.el.replyview.scrollTop, 0);
  assert.equal(top.view.foot(), 58);
  assert.equal(top.waiting(), 0);
  // the view scrolled a little, but the panel standing further down than that:
  // its head is in sight, so nothing is above the view and the scroll stays
  const seated = openedCard(400, 400, 30);
  seated.el.replyview.scrollTop = 20;
  assert.equal(seated.view.head(), 10);
  const kept = cutOnScreen(seated.view, seated.panel, seated.clip, seated.frame, 240, [240, 149, 58], "the head in sight");
  assert.deepEqual(kept.map(f => f.scroll), [20, 20, 20]);
  assert.deepEqual(kept.map(f => f.foot), [250, 159, 68]);
  assert.equal(seated.waiting(), 0, "the view is asked to follow a cut that has nothing above the view");
  seated.clip.midRun = null;
  landRun(seated.panel);
  assert.equal(seated.el.replyview.scrollTop, 20, "the scroll moved as the panel landed");
});

test("a cut back that is turned, taken by the reader, met by a short answer or a keyboard, or made plain, keeps the reader where the cut puts them", () => {
  // a press that catches the cut part way turns it round where it stands: the
  // scroll has not moved, the opening starts from the height the cut had reached,
  // the foot does not jump, nothing is written, and the follow of the cut stops
  const turned = openedCard(400, 400);
  turned.el.replyview.scrollTop = 200;
  cutBack(turned.panel, turned.clip, 240);
  playRun(turned.view, turned.clip, turned.frame, [240, 149]);
  assert.equal(turned.view.top(), 109);
  turned.view.seen.length = 0;
  turned.view.writes.length = 0;
  turned.panel.fire("click", { target: turned.panel });
  assert.equal(turned.panel.classList.contains("open"), true, "the second press did not turn the run round");
  assert.equal(turned.el.replyview.scrollTop, 109, "the scroll moved as the run turned round");
  assert.equal(turned.clip.style.heights.at(-2), "149px", "the opening run did not start where the cut stood");
  assert.equal(turned.view.foot(), 40, "the foot jumped as the run turned round");
  assert.ok(turned.view.seen.every(at => at === 109), "the view was pulled while the run turned round");
  assert.deepEqual(turned.view.writes, [], "the scroll was written as the run turned round");
  turned.frame();
  assert.equal(turned.waiting(), 0, "the cut's follow went on after a press turned the run round");
  assert.deepEqual(turned.view.writes, [], "the cut's follow wrote the scroll after a press turned the run round");
  turned.clip.midRun = null;
  landRun(turned.panel);
  assert.equal(turned.el.replyview.scrollTop, 109);
  assert.equal(turned.view.slack(), 0);

  // a press that catches the opening part way and cuts it back: the room is
  // counted from the whole the panel stands at when the run is settled, not from
  // the height the opening had reached, so the cut's end is not pulled
  const caught = openedCard(400, 400);
  caught.el.replyview.scrollTop = 200;
  cutBack(caught.panel, caught.clip, 240);
  playRun(caught.view, caught.clip, caught.frame, [240, 100]);
  caught.clip.midRun = null;
  landRun(caught.panel);
  assert.equal(caught.view.top(), 18);
  caught.panel.fire("click", { target: caught.panel });
  playRun(caught.view, caught.clip, caught.frame, [58, 149]);
  caught.el.replyview.scrollTop = 140;
  const back = cutOnScreen(caught.view, caught.panel, caught.clip, caught.frame, 149, [149, 100, 58], "the opening caught and cut back");
  assert.deepEqual(back.map(f => f.foot), [9, 9, 9], "the answer moved while the hidden part lasted");
  assert.equal(caught.view.slack(), 82, "the room is not counted from the whole panel");
  caught.clip.midRun = null;
  landRun(caught.panel);
  assert.equal(caught.el.replyview.scrollTop, 49);
  assert.deepEqual(caught.view.pulled, [], "the cut's end was pulled after the opening was caught");

  // a reader who takes the scroll during the run keeps it: the follow writes
  // nothing more, the room is not let go of while the run is on, and the landing
  // lets go of what the reader no longer stands on
  const taken = openedCard(400, 400);
  taken.el.replyview.scrollTop = 200;
  cutBack(taken.panel, taken.clip, 240);
  playRun(taken.view, taken.clip, taken.frame, [240, 149]);
  taken.el.replyview.scrollTop = 30;
  taken.el.replyview.fire("scroll");
  assert.equal(taken.view.slack(), 142, "room was let go of while the run was on");
  taken.view.pulled.length = 0;
  taken.view.writes.length = 0;
  playRun(taken.view, taken.clip, taken.frame, [100]);
  assert.equal(taken.el.replyview.scrollTop, 30, "the run fought the reader for the scroll");
  assert.deepEqual(taken.view.writes, [], "the run wrote the scroll a reader had taken");
  assert.equal(taken.waiting(), 0, "the follow went on after the reader took the scroll");
  taken.clip.midRun = null;
  landRun(taken.panel);
  assert.equal(taken.el.replyview.scrollTop, 30, "the landing moved a scroll the reader had taken");
  assert.equal(taken.view.slack(), 0);
  assert.deepEqual(taken.view.pulled, []);

  // an answer too short to stand the view on: 100 of answer under the 240 batch
  // in a 300 view, scrolled 40 to its end. the whole 40 is hidden, so the scroll
  // goes back to the top with the cut, the answer holds still until then, and
  // room is held for the run
  const short = openedCard(100, 300);
  short.el.replyview.scrollTop = 40;
  assert.equal(short.el.replyview.scrollTop, 40);
  const shortFrames = cutOnScreen(short.view, short.panel, short.clip, short.frame, 240, [240, 149, 58], "the short answer");
  assert.equal(short.view.slack(), 182, "the room held is not what the short answer needs");
  assert.deepEqual(shortFrames.map(f => f.foot), [200, 149, 58]);
  short.clip.midRun = null;
  landRun(short.panel);
  assert.equal(short.el.replyview.scrollTop, 0, "the short answer's view did not land at its top");
  assert.equal(short.view.foot(), 58);
  assert.equal(short.view.slack(), 0, "room was kept that the short answer's view does not stand on");
  assert.deepEqual(short.view.pulled, [], "the short answer's view was pulled as the panel landed");

  // the phone's keyboard, put away by the press: the view grows while the run
  // goes, as far as the window under its top, and the room held covers it. 100
  // of answer under the 240 batch in a 150 view with the keyboard up, scrolled
  // 190 to its end, the view's top 100 down a 450 window
  const typing = openedCard(100, 150);
  typing.context.innerHeight = 450;
  typing.el.replyview.rect = { top: 100, bottom: 250 };
  typing.el.replyview.scrollTop = 190;
  assert.equal(typing.view.foot(), 50);
  typing.view.writes.length = 0;
  cutBack(typing.panel, typing.clip, 240);
  assert.equal(typing.view.slack(), 382, "no room was held for the view to grow into");
  // part way, the keyboard is gone and the view stands 350 tall
  const grown = playRun(typing.view, typing.clip, typing.frame, [240]);
  typing.el.replyview.clientHeight = 350;
  grown.push(...playRun(typing.view, typing.clip, typing.frame, [149, 100]));
  assert.deepEqual(grown.map(f => f.scroll), [190, 99, 50], "the scroll did not go back with the cut as the view grew");
  assert.deepEqual(grown.map(f => f.head), [-190, -99, -50]);
  assert.deepEqual(grown.map(f => f.foot), [50, 50, 50], "the answer moved as the view grew");
  assert.deepEqual(typing.view.pulled, [], "the view was pulled as it grew");
  assert.deepEqual(typing.view.writes, [190, 190, 99, 50], "the scroll was written other than once per frame as the view grew");
  typing.clip.midRun = null;
  landRun(typing.panel);
  assert.equal(typing.el.replyview.scrollTop, 8, "the scroll did not land where the cut leaves it with the keyboard gone");
  assert.equal(typing.view.foot(), 50, "the answer jumped as the panel landed with the keyboard gone");
  assert.equal(typing.view.slack(), 200, "the room the grown view stands on was let go under it");
  assert.deepEqual(typing.view.pulled, []);
  typing.el.replyview.scrollTop = 0;
  typing.el.replyview.fire("scroll");
  assert.equal(typing.view.slack(), 0, "room was kept once the reader had scrolled off it");

  // with no motion asked for, the flip is the same on the screen: the scroll goes
  // back by what the cut takes up to the hidden part, at once, and the answer
  // under the panel is where the run would have left it
  const flat = openedCard(400, 400);
  flat.context.stillness = true;
  flat.el.replyview.scrollTop = 200;
  flat.panel.fire("click", { target: flat.panel });
  assert.equal(flat.panel.classList.contains("open"), false);
  assert.equal(flat.panel.classList.contains("motion"), false, "a run went against the setting");
  assert.equal(flat.el.replyview.scrollTop, 18, "the plain flip did not scroll back with the cut");
  assert.equal(flat.view.foot(), 40, "the plain flip moved the answer under the panel");
  assert.deepEqual(flat.view.pulled, [], "the plain flip pulled the view");
  assert.equal(flat.view.slack(), 0);
  assert.equal(flat.waiting(), 0, "a plain flip asked for frames");
  const level = openedCard(400, 400);
  level.context.stillness = true;
  level.panel.fire("click", { target: level.panel });
  assert.equal(level.el.replyview.scrollTop, 0, "the plain flip of a panel at the top moved the view");
  assert.equal(level.view.foot(), 58);
});

test("the room a cut back holds is a spacer under the answer, never the scroller's own padding", () => {
  // the answer's scroller is a flex item, which cannot stand shorter than its
  // padding: room held in it pushed the scroller past the card, and the band
  // the fade over the typing row is cut to, read off the scroller's foot, grew
  // with it and masked the answer out
  for (const [where, css, spacer] of [["the phone", PHONE, "\n  .replyview::after{"],
      ["the desktop", DESKTOP, "\n  body.focus .box.sel .replyview::after{"]]) {
    assert.doesNotMatch(css, /padding-bottom:[^;}]*--answ-slack/, `${where} still holds the room in the scroller's padding`);
    const at = css.indexOf(spacer);
    assert.ok(at > 0, `${where} has no spacer for the held room`);
    assert.match(css.slice(at, css.indexOf("}", at) + 1), /content:""; flex:none; height:var\(--answ-slack, 0px\)/);
  }
  assert.match(PHONE, /padding-bottom:calc\(var\(--boxband, 0px\) \+ var\(--replyfade\)\);/);
  assert.match(DESKTOP, /padding-bottom:calc\(var\(--boxband, 0px\) \+ var\(--replyfade\)\);/);
});

test("a panel whose own lane was scrolled comes down to its head on the run, not in a jump first", () => {
  const { context } = sandbox();
  // the large cards' sent panel: the opened batch scrolls inside its own cut
  const el = fullCard("c1");
  context.syncSent(el, context.sentBatch(LIVE.map(m => m.text)));
  const panel = el.sent;
  const clip = layOutLong(panel, FakeResizeObserver.made[0]);
  panel.fire("click", { target: panel });
  landRun(panel);
  clip.scrollTop = 90;
  const stack = panel.querySelector(".answstack");
  panel.fire("click", { target: panel });
  assert.equal(clip.scrollTop, 0, "the cut does not end on the head of the batch");
  assert.deepEqual(stack.style.transforms, ["translate3d(0, -90px, 0)", ""],
    "the words jumped to the head of the batch instead of travelling there on the run");
  assert.equal(panel.classList.contains("motion"), true);
  landRun(panel);
  assert.equal(stack.style.transform, "", "the words were left moved once the run had landed");
  // the small card's panel: the opened batch scrolls in the panel's seat, and
  // the card has no scroller of the answer's that the panel rides in
  const mbox = element("div");
  const mini = { box: mbox, answwrap: element("div"), reply: element("div"), answ: null, answId: null };
  mini.answwrap.className = "answwrap";
  mbox.append(mini.answwrap, mini.reply);
  context.syncAnswered(mini, context.liveAnswered({ ...liveBox(), id: "m1" }), null);
  const miniClip = layOutLong(mini.answ, FakeResizeObserver.made[1]);
  assert.equal(mini.answ.answView, null, "a small card's panel took a scroller it does not ride in");
  mini.answ.fire("click", { target: mini.answ });
  landRun(mini.answ);
  mini.answwrap.scrollTop = 50;
  mini.answ.fire("click", { target: mini.answ });
  assert.equal(mini.answwrap.scrollTop, 0);
  assert.deepEqual(mini.answ.style.transforms, ["translate3d(0, -50px, 0)", ""],
    "the small card's panel jumped to its head instead of travelling there");
  landRun(mini.answ);
  assert.equal(miniClip.style.height, "");
  // the sheet runs the travel on the fold's own length and curve
  assert.match(rule(TOKENS, ".answered.motion"), /transition:transform var\(--answ-move\) var\(--gentle\)/);
  assert.match(rule(TOKENS, ".answered.motion .answstack"), /transition:transform var\(--answ-move\) var\(--gentle\)/);
});
