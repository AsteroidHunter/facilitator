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
// a selector list of plain tags, plain classes, or a tag with a class
function matches(node, selector) {
  return selector.split(",").map(part => part.trim()).some(part => {
    const [tag, ...cls] = part.split(".");
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    return cls.every(name => node.classList.contains(name));
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
// the reduced motion setting is the test's to turn on
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
  let seq = 0;
  const context = vm.createContext({
    Date, Promise, console,
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
  return { context, counts, run, pending, ring };
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
  ], "a blank tail was drawn, or a blank message added a block and its hairline");
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

test("the sheet draws one grey panel with no frame, hairlines between messages and an arrow only when long", () => {
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
  const hairline = rule(TOKENS, ".answmsg + .answmsg");
  assert.match(hairline, /border-top:1px solid var\(--line\)/, "two messages are not split by a hairline");
  assert.match(hairline, /margin-top:calc\(var\(--answ-line\) \/ 2 - \.5px\)/);
  assert.match(hairline, /padding-top:calc\(var\(--answ-line\) \/ 2 - \.5px\)/);
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

test("a message the phone has not had confirmed carries its state and a line, and keeps its block as it lands", () => {
  const { context } = sandbox();
  const el = fullCard("c1");
  const confirmed = { text: "Invented confirmed message." };
  const onWay = { text: "Invented message on its way.", op: "op-1" };
  context.syncSent(el, [confirmed, { ...onWay, state: "pending", note: "Sending" }], true);
  const row = el.sent.querySelector(".answstack").children[1];
  assert.equal(row.classList.contains("pending"), true, "the unconfirmed message is not dressed as one");
  assert.equal(row.dataset.op, "op-1", "the message does not name its operation");
  assert.equal(row.querySelector(".answnote").textContent, "Sending");
  // the board refuses it: the same block says so
  context.syncSent(el, [confirmed, { ...onWay, state: "failed", note: "Not sent, tap to take the words back" }]);
  const same = el.sent.querySelector(".answstack").children[1];
  assert.equal(same, row, "a new state drew the message again");
  assert.equal(row.classList.contains("failed"), true);
  assert.equal(row.classList.contains("pending"), false);
  assert.equal(row.querySelector(".answnote").textContent, "Not sent, tap to take the words back");
  // confirmed after all: the block stays, and its line and dress go
  context.syncSent(el, [confirmed, { text: onWay.text }]);
  assert.equal(el.sent.querySelector(".answstack").children[1], row, "landing drew the message again");
  assert.equal(row.querySelector(".answnote"), null, "a confirmed message kept its line");
  assert.equal(row.classList.contains("failed"), false);
  assert.equal(row.dataset.op, undefined);
});

// ---- the page turn ------------------------------------------------------------------------
// a card on show with a sent panel standing, laid out the way a browser would
// report it: the card's body, the answer's view under the title, scrolled a
// little, and the seat at the foot
function turningCard(context) {
  const el = fullCard("c1");
  context.syncSent(el, context.sentBatch(SENT), true);
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
  assert.ok(!/@property/.test(TOKENS), "a custom property is still run");
  assert.ok(!/--answ-cut/.test(TOKENS + LOGIC), "the old run dissolve is still there");
  assert.ok(!/blur|filter/.test(part.replace(/\/\*[\s\S]*?\*\//g, "")), "a panel or the turn draws a blur");
  // every transition there: the fold's own height run, carried over as it was,
  // and otherwise strength and transforms alone
  const transitions = [...part.matchAll(/transition:([^;}]+)/g)].map(m => m[1].trim());
  for (const t of transitions)
    for (const one of t.split(","))
      assert.ok(/^(height|opacity|transform) /.test(one.trim()), `a run moves something other than height, strength or a transform: ${one}`);
  assert.equal(transitions.filter(t => t.startsWith("height")).length, 1, "a new run changes a height");
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
  // the sends: the desktop lands the message after the board has it, the phone
  // at once with its line, and both as an arrival
  assert.match(DESKTOP, /el\.sentItems = \[\.\.\.el\.sentItems, \{ text, stage: "sent" \}\];[\s\S]{0,80}syncSent\(el, el\.sentItems, true\);/);
  assert.match(DESKTOP, /own\.sentItems = \[\.\.\.own\.sentItems, \{ text, stage: "sent" \}\];[\s\S]{0,80}syncSent\(own, own\.sentItems, true\);/);
  assert.match(PHONE, /drawSent\(el, id, true\);/);
  assert.match(PHONE, /panel\.addEventListener\("click", e => sentPress\(e\), true\);/,
    "the phone's tap to take words back is not heard before the panel's own");
});

test("the turn keeps to the composer the reader is in, the right one included, and to a board that is covered", () => {
  const { context, run, pending } = sandbox();
  // a key counts only in a row that holds the caret: the formatter's own input
  // as it puts its editor on, to every card on load, is nobody typing
  const bar = element("textarea"), right = element("textarea");
  context.ComposeFormat = { focused: ta => ta === context.caret };
  context.noteTyping(bar);
  assert.equal(bar.typedAt, undefined, "a row with no caret was taken for typing");
  context.caret = right;
  context.noteTyping(right);
  assert.ok(Date.now() - right.typedAt < 1000, "a key into the row with the caret was not noted");
  // the composer on the right holds the card's draft, so it is the card's el.ta:
  // typing there holds the new answer back as typing in the bar does
  run("turnAgain = againSpy");
  const el = turningCard(context);
  el.bar = { ta: bar };
  el.ta = right;
  assert.equal(context.turnBegin(el, NEXT), run("TURN_HELD"), "typing in the composer on the right did not hold the answer");
  assert.equal(el.body.querySelector(".turnsheet"), null);
  right.typedAt = 0;
  assert.equal(pending().at(-1).ms, 500);
  // and with the bar stepped aside for it, the seat stands at the card's floor:
  // the picture reaches down to the seat's foot wherever the seat stands
  el.sentwrap.rect = { top: 780, bottom: 900 };
  const turn = context.turnBegin(el, NEXT);
  assert.equal(turn.mode, "glide");
  assert.equal(el.body.querySelector(".turnsheet").style.height, "800px", "the picture does not reach the seat at the floor");
  assert.equal(context.caret, right, "the turn took the caret out of the composer on the right");
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
  // the pages: the right composer's keys are noted, and a reply landing on the
  // card in use is read whatever the turn does, the answer held back included
  assert.match(DESKTOP, /xc\.ta\.addEventListener\("input", \(\) => \{[^}]*noteTyping\(xc\.ta\);/,
    "a key into the composer on the right is not noted");
  for (const [where, text, rule] of [["the desktop", DESKTOP, "readOnArrival(el, b, b.id === selectedId && !browsing);"],
      ["the phone", PHONE, "readOnArrival(el, b, b.id === selectedId && !drawerOpen());"]]) {
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

test("the sent panel reads the board's own record: faded until delivered, then Delivered, then Read", () => {
  const { context, counts } = sandbox();
  const el = fullCard("c1");
  el.sentRoom = context.roomSpy;
  // on the board, and no agent has received it: the panel and the words faded, no mark
  context.syncSent(el, [{ text: "Invented one.", stage: "sent" }], true);
  const panel = el.sent;
  assert.equal(panel.classList.contains("undelivered"), true, "a message nobody has received is not faded");
  assert.deepEqual(stagesOf(panel), [true]);
  assert.equal(panel.dataset.tag, undefined, "a message nobody has received carries a mark");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply");
  // the agent confirmed the claim: full ink, and Delivered under the panel. a
  // message sent after it waits faded on its own, and the panel's grey is back
  const first = panel.querySelector(".answmsg");
  const rooms = counts.rooms;
  context.syncSent(el, [{ text: "Invented one.", stage: "delivered" }, { text: "Invented two.", stage: "sent" }]);
  assert.equal(panel.querySelector(".answmsg"), first, "a change of stage drew the message again");
  assert.equal(panel.classList.contains("undelivered"), false, "the panel stayed faded with a message delivered");
  assert.deepEqual(stagesOf(panel), [false, true], "the message not yet delivered is not faded on its own");
  assert.equal(panel.dataset.tag, "Delivered");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply, delivered");
  assert.ok(counts.rooms > rooms, "the card was not told the mark took its room");
  // the mark names the newest message that has got anywhere
  context.syncSent(el, [{ text: "Invented one.", stage: "read" }, { text: "Invented two.", stage: "delivered" }]);
  assert.equal(panel.dataset.tag, "Delivered", "a later message still only delivered was called read");
  context.syncSent(el, [{ text: "Invented one.", stage: "read" }, { text: "Invented two.", stage: "read" }]);
  assert.equal(panel.dataset.tag, "Read");
  assert.equal(panel.getAttribute("aria-label"), "your messages waiting for a reply, read");
  // the phone's own message, not yet on the board: faded, with its own line
  const phone = fullCard("c2");
  context.syncSent(phone, [{ text: "Invented from the phone.", stage: "local", state: "pending", note: "Sending", op: "op-1" }], true);
  assert.equal(phone.sent.classList.contains("undelivered"), true);
  const row = phone.sent.querySelector(".answmsg");
  assert.equal(row.classList.contains("pending"), true);
  assert.equal(row.querySelector(".answnote").textContent, "Sending", "the phone's own line was lost");
  // a board too old to say leaves the panel as it always was
  const old = fullCard("c3");
  context.syncSent(old, context.sentBatch(["Invented unmarked."]));
  assert.equal(old.sent.classList.contains("undelivered"), false);
  assert.equal(old.sent.dataset.tag, undefined);
  // the panel over an answer says Read: the answer under it is the proof
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  assert.equal(el.answ.dataset.tag, "Read", "the panel over an answer does not say read");
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
  assert.match(PHONE, /batch\.push\(\{ text: op\.text, op: op\.id, state: op\.state, note: opNote\(op\), stage: "local" \}\);/,
    "the phone's own messages are not marked as not yet on the board");
  // and the sheet draws the stages: faded words and grey, the one quiet mark in its room
  assert.match(rule(TOKENS, ".answered.undelivered"), /--answ-fill:color-mix\(in srgb, var\(--bubble-fill\) 50%, var\(--card, #fff\)\)/);
  assert.match(rule(TOKENS, ".answmsg.undelivered > :not(.answnote)"), /opacity:\.5/);
  assert.match(rule(TOKENS, ".answmsg > *"), /transition:opacity var\(--answ-move\) var\(--gentle\)/);
  assert.match(rule(TOKENS, ".answered[data-tag]"), /margin-bottom:var\(--answ-tag\)/);
  const mark = rule(TOKENS, ".answered[data-tag]::after");
  assert.match(mark, /content:attr\(data-tag\); position:absolute; top:100%; right:var\(--answ-round\);/);
  assert.match(mark, /font:10\.5px\/1\.35 var\(--mono\); color:var\(--sub\);/);
  assert.match(mark, /pointer-events:none/);
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
  context.syncSent(el, [{ text: SENT[0], stage: "delivered" }], true);
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
