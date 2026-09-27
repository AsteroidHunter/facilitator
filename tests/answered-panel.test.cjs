// the panel of messages a reply was given, with no browser and no board. the
// real card-logic.js and card-markdown.js run in a sandbox over a small stand-in
// dom, so the markup the panel is built from, the batch each reply shows, the
// history stepper's own batches and the one press that opens and cuts back a
// long batch are all read off the code the pages ship. what a browser alone
// can say, how it looks, is not claimed here: the sheet and the pages are read
// as text only for the rules and the wiring the design rests on. every card,
// reply and message below is invented.
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
// click, and an innerHTML that builds the child elements its tags name so the
// panel's own markup can be walked. text is kept only as the html string
const VOID = new Set(["br", "img", "hr", "input", "source", "wbr"]);
function element(tag) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  let html = "";
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, dataset: {}, style: {}, id: "",
    clientHeight: 0, scrollHeight: 0, scrollTop: 0,
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
// word about a reply would throw here rather than pass quietly
function sandbox() {
  FakeResizeObserver.made = [];
  const counts = { timers: 0, rooms: 0 };
  const context = vm.createContext({
    Date, Promise, console,
    document: { createElement: element },
    CardMarkdown: markdown,
    ResizeObserver: FakeResizeObserver,
    setTimeout: () => { counts.timers++; return 0; }, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    picked: null,
    boxHasSelection: node => context.picked === node,
    roomSpy: () => { counts.rooms++; },
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const run = source => vm.runInContext(source, context);
  return { context, counts, run };
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
  assert.deepEqual(panel.children.map(node => node.className), ["answclip", "answchev"],
    "the panel is not the cut and its one arrow");
  assert.equal(panel.children[1].tagName, "SVG", "the arrow is not the drawn chevron");
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
  const panel = el.answ, clip = panel.querySelector(".answclip");
  clip.clientHeight = 58; clip.scrollHeight = 240;
  FakeResizeObserver.made[0].fire();
  panel.fire("click", { target: panel });
  const kids = all(panel);
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  assert.equal(el.answ, panel);
  const now = all(panel);
  assert.ok(now.length === kids.length && now.every((node, i) => node === kids[i]),
    "a pass with the same reply rebuilt the panel");
  assert.equal(panel.classList.contains("open"), true, "a pass with the same reply cut the panel back");
  // a different reply is another batch, and it starts cut
  context.syncAnswered(el, context.liveAnswered({ ...liveBox([LIVE[2]]), replyId: "reply-next" }));
  assert.equal(el.answ, panel);
  assert.equal(panel.classList.contains("open"), false, "a new batch arrived open");
  assert.deepEqual(blocks(panel).map(b => b.html), [markdown.render(LIVE[2].text)]);
});

test("a long batch is cut with an arrow, a press opens it whole and a second cuts it back", () => {
  const { context, counts, run } = sandbox();
  run("answeredRoomChanged = roomSpy");
  const el = card("c1");
  const timers = counts.timers;
  context.syncAnswered(el, context.liveAnswered(liveBox()));
  const panel = el.answ, clip = panel.querySelector(".answclip");
  const rooms = counts.rooms;
  // not laid out yet, so nothing is claimed about its length
  assert.equal(panel.classList.contains("more"), false);
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "a panel not known to be long opened");
  // laid out: the batch runs past the preview, and the watch says so
  clip.clientHeight = 58; clip.scrollHeight = 240;
  FakeResizeObserver.made[0].fire();
  assert.equal(panel.classList.contains("more"), true, "a batch longer than the preview was not marked");
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), true, "the press did not open the whole batch");
  assert.equal(counts.rooms, rooms + 1, "the answer was not re-snapped against the opened panel");
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
  panel.fire("click", { target: panel });
  assert.equal(panel.classList.contains("open"), false, "the second press did not cut the batch back");
  assert.equal(panel.classList.contains("more"), true, "the cut panel lost its arrow");
  assert.equal(counts.rooms, rooms + 2);
  assert.equal(counts.timers, timers, "opening or cutting back armed a timer");
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

test("the sheet draws one grey panel with no frame, hairlines between messages and an arrow only when cut", () => {
  const panel = rule(TOKENS, ".answered");
  assert.match(panel, /background:var\(--bubble-fill\)/, "the panel is not the bubble's grey");
  assert.match(panel, /border-radius:var\(--answ-round\)/);
  assert.match(panel, /margin-left:auto/, "the panel does not hug the right end of its column");
  assert.match(panel, /font:var\(--answ-font\)/);
  assert.ok(!/border:|box-shadow|outline/.test(panel), "the panel wears a frame or a shade");
  assert.match(rule(TOKENS, ".answclip"), /max-height:var\(--answ-peek\); overflow:hidden/);
  assert.match(rule(TOKENS, ".answered.open .answclip"), /max-height:none/);
  assert.match(rule(TOKENS, ".answered.more:not(.open) .answclip"), /mask-image:linear-gradient/,
    "a cut batch does not fade out");
  const hairline = rule(TOKENS, ".answmsg + .answmsg");
  assert.match(hairline, /border-top:1px solid var\(--line\)/, "two messages are not split by a hairline");
  assert.match(hairline, /margin-top:calc\(var\(--answ-line\) \/ 2 - \.5px\)/);
  assert.match(hairline, /padding-top:calc\(var\(--answ-line\) \/ 2 - \.5px\)/);
  assert.match(rule(TOKENS, ".answmsg p, .answmsg ul, .answmsg ol"), /margin-bottom:var\(--answ-line\)/);
  assert.match(rule(TOKENS, ".answchev"), /display:none/, "the arrow shows on a panel that is not cut");
  assert.match(rule(TOKENS, ".answered.more:not(.open) .answchev"), /display:block/);
  assert.ok(!TOKENS.includes("--raised-soft"), "the old box's raised shade is still a token");
});

test("each surface types the panel's measures and seats it in the answer's column", () => {
  const measures = ["--answ-font", "--answ-line", "--answ-pad-y", "--answ-pad-x", "--answ-round",
    "--answ-peek", "--answ-fade"];
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
