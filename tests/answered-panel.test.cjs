// the panel of messages a reply was given, with no browser and no board. the
// real card-logic.js and card-markdown.js run in a sandbox over a small stand-in
// dom, so the markup the panel is built from, the batch each reply shows, the
// history stepper's own batches, and the press that opens and cuts back a long
// batch on the old answered box's fold run are all read off the code the pages
// ship. the stand-in lays nothing out: a test writes the heights a browser
// would report, and ends a run by firing the transition's end or the timer
// behind it. what a browser alone can say, how it looks and how the run moves
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
// that builds the child elements its tags name so the panel's own markup can
// be walked. text is kept only as the html string
const VOID = new Set(["br", "img", "hr", "input", "source", "wbr"]);
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
// preview the test says it is cut to. midRun stands for a run caught part way,
// so it only holds while a run has its height written in
function laidOutHeight(node) {
  if (node.midRun != null && node.style.height) return node.midRun;
  if (node.style.height) return parseFloat(node.style.height);
  const panel = node.parentNode;
  if (node.classList.contains("answclip") && panel &&
      (panel.classList.contains("open") || panel.classList.contains("motion"))) return node.scrollHeight;
  return node.clientHeight;
}
function element(tag) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  let html = "";
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, dataset: {}, style: inlineStyle(), id: "",
    clientHeight: 0, scrollHeight: 0, scrollTop: 0, offsetWidth: 0, midRun: null,
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: laidOutHeight(el) }; },
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
      el.children.push(node);
      node.parentNode = el;
      return node;
    },
    append(...nodes) { for (const node of nodes) el.appendChild(node); },
    remove() {
      const parent = el.parentNode;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(el), 1);
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
    for (const child of el.children) child.parentNode = null;
    el.children = [];
  }
  return el;
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
// the tags of an html string, nested as written; the text between them is
// dropped, since the html string itself is what the tests compare
function build(parent, html) {
  const stack = [parent];
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = element(tag);
    const cls = /\bclass\s*=\s*"([^"]*)"/.exec(attrs);
    if (cls) node.className = cls[1];
    stack[stack.length - 1].appendChild(node);
    if (!selfClosing && !VOID.has(tag.toLowerCase())) stack.push(node);
  }
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
const FADE = "15.75px";   // the desktop's dissolve at the cut, three quarters of 21px
function sandbox() {
  FakeResizeObserver.made = [];
  const counts = { timers: 0, rooms: 0 };
  const timers = new Map();
  let seq = 0;
  const context = vm.createContext({
    Date, Promise, console,
    document: { createElement: element },
    CardMarkdown: markdown,
    ResizeObserver: FakeResizeObserver,
    setTimeout: (fn, ms) => { counts.timers++; timers.set(++seq, { fn, ms }); return seq; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: () => 0, clearInterval: () => {},
    stillness: false,
    matchMedia: query => ({ matches: /prefers-reduced-motion: reduce/.test(query) && context.stillness }),
    // the dissolve the sheet gives the cut: its depth while a long batch stands
    // cut, and nothing otherwise, unless the run has written it inline
    getComputedStyle: node => ({
      getPropertyValue(name) {
        const inline = node.style.getPropertyValue(name);
        if (inline) return inline;
        const panel = node.parentNode;
        if (name === "--answ-cut")
          return panel && panel.classList.contains("more") && !panel.classList.contains("open") ? FADE : "0px";
        return "";
      },
    }),
    picked: null,
    boxHasSelection: node => context.picked === node,
    roomSpy: () => { counts.rooms++; },
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
// a long batch laid out: cut at a 58px preview over a 240px batch, and the
// size watch telling the panel so
function layOutLong(panel, watch) {
  const clip = panel.querySelector(".answclip");
  clip.clientHeight = 58; clip.scrollHeight = 240;
  watch.fire();
  return clip;
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
  assert.equal(clip.style.getPropertyValue("--answ-cut"), "", "a new batch kept the old run's dissolve");
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
  // stood, 58px, to the whole batch, 240px, with the dissolve running from its
  // depth to nothing on the same run
  assert.equal(panel.classList.contains("open"), true, "the press did not head for the whole batch");
  assert.equal(panel.classList.contains("motion"), true, "the press did not start a run");
  assert.deepEqual(clip.style.heights, ["58px", "240px"], "the run is not from the cut to the whole batch");
  assert.equal(clip.style.getPropertyValue("--answ-cut"), "0px", "the dissolve does not run to nothing");
  assert.equal(clip.listening("transitionend"), 1, "the run is not waiting on its own end");
  assert.equal(pending().length, waiting + 1, "no timer stands behind the run");
  assert.equal(pending().at(-1).ms, run("FOLD_TIMER_MS"), "the timer behind the run is not the fold's own");
  assert.equal(run("FOLD_TIMER_MS"), 430, "the timer behind the run is not the old fold's");
  assert.equal(counts.rooms, before, "the answer was re-snapped on a frame of the run");
  // an end that is not the height's is not the run's end
  clip.fire("transitionend", { target: clip, propertyName: "--answ-cut" });
  assert.equal(panel.classList.contains("motion"), true, "another transition ended the run");
  landRun(panel);
  assert.equal(panel.classList.contains("motion"), false, "the run did not land");
  assert.equal(clip.style.height, "", "the run left its height written in");
  assert.equal(clip.style.getPropertyValue("--answ-cut"), "", "the run left its dissolve written in");
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
  assert.equal(clip.style.getPropertyValue("--answ-cut"), FADE, "the dissolve does not deepen again");
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
  // and aimed back at the cut from there rather than started over
  clip.midRun = 131;
  panel.fire("click", { target: panel });
  clip.midRun = null;
  assert.equal(panel.classList.contains("open"), false, "the press mid run did not turn it round");
  assert.deepEqual(clip.style.heights, ["58px", "240px", "131px", "58px"],
    "the turned run did not start from where the first one stood");
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

test("the small card draws the same panel and tells nobody when it opens", () => {
  const { context, counts, run } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const mini = card("m1");
  context.syncAnswered(mini, context.liveAnswered({ ...liveBox(), id: "m1" }), null);
  assert.equal(mini.answ.className, "answered");
  const clip = mini.answ.querySelector(".answclip");
  clip.clientHeight = 30; clip.scrollHeight = 200;
  FakeResizeObserver.made[0].fire();
  mini.answ.fire("click", { target: mini.answ });
  assert.equal(mini.answ.classList.contains("open"), true);
  assert.equal(mini.answ.classList.contains("motion"), true, "the small card's panel did not run");
  assert.deepEqual(clip.style.heights, ["30px", "200px"]);
  landRun(mini.answ);
  assert.equal(mini.answ.classList.contains("motion"), false);
  assert.equal(counts.rooms, 0, "the small card's panel re-snapped the large card");
  // and the page hands it the very same pass, with nobody to tell
  assert.match(DESKTOP, /syncAnswered\(el, liveAnswered\(b\), null\);/);
  assert.match(DESKTOP, /box\.append\(sun, arc, x, title, answwrap, reply, pend, compose\);/);
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
  assert.match(panel, /background:var\(--bubble-fill\)/, "the panel is not the bubble's grey");
  assert.match(panel, /border-radius:var\(--answ-round\)/);
  assert.match(panel, /margin-left:auto/, "the panel does not hug the right end of its column");
  assert.match(panel, /font:var\(--answ-font\)/);
  assert.ok(!/border:|box-shadow|outline/.test(panel), "the panel wears a frame or a shade");
  assert.match(rule(TOKENS, ".answclip"), /max-height:var\(--answ-peek\); overflow:hidden/);
  assert.match(rule(TOKENS, ".answered.open .answclip"), /max-height:none/);
  assert.match(rule(TOKENS, ".answered.more:not(.open) .answclip"), /--answ-cut:var\(--answ-fade\)/,
    "a cut batch does not dissolve by the surface's own depth");
  assert.match(rule(TOKENS, ".answered.more:not(.open) .answclip,\n.answered.motion .answclip"),
    /mask-image:linear-gradient\(to bottom, #000 calc\(100% - var\(--answ-cut\)\), transparent\)/,
    "a cut batch does not fade out, or a running one does not fade at its moving edge");
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
  assert.match(running,
    /transition:height var\(--answ-move\) var\(--gentle\), --answ-cut var\(--answ-move\) var\(--gentle\);/,
    "the height and the dissolve do not run on the old fold's length and curve");
  assert.match(TOKENS, /@property --answ-cut\{syntax:"<length>"; inherits:false; initial-value:0px\}/,
    "the dissolve is not a length the browser can run");
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
