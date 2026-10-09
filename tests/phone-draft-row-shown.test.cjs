// A card the phone builds while it is hidden cannot measure its typing row: the
// cards around the one on show are built that way, and a card taken down is
// built again from the shelf the same way, and a row with no width keeps the
// height it had. So a draft of several lines stood one line tall when its card
// came back, until a key was typed. The row is fitted again on the frame the
// card is shown, read off its bar's width going from none to some (watchShown
// in m.html).
//
// No browser: the page's own watchShown, fitRow and dropCard run in a sandbox
// over a stand-in row whose width the test sets, wrapping its words at a fixed
// character width, and a stand-in ResizeObserver the test delivers to, as a
// browser delivers after layout. What a browser alone can say, the frames on
// screen, is not claimed here. Every word is invented.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");

const PHONE = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

// a top-level function of the page, from its name to its closing brace
function fn(name) {
  const from = PHONE.indexOf(`\nfunction ${name}(`);
  assert.ok(from >= 0, `m.html must ship ${name}`);
  const to = PHONE.indexOf("\n}\n", from);
  return PHONE.slice(from + 1, to + 2);
}

const LH = 25.5, PAD = 8, CHAR = 9;
// lines a plain field lays these words on at this width
function lines(text, width) {
  if (!width) return 1;
  const per = Math.max(1, Math.floor(width / CHAR));
  return text.split("\n").reduce((n, para) => n + Math.max(1, Math.ceil(para.length / per)), 0);
}

// the row, its twin and the bar, as the page builds them; width 0 while hidden
function card(value) {
  const room = { width: 0 };
  const ta = { value, style: {}, get clientWidth() { return room.width; } };
  const twin = { value: "", style: {},
    get scrollHeight() { return lines(this.value, parseFloat(this.style.width) || 0) * LH + 2 * PAD; } };
  return { room, ta, twin, bottombar: { name: "bar" }, ticks: 0 };
}

function sandbox({ observer = true } = {}) {
  const observers = [];
  class ResizeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; this.gone = false; observers.push(this); }
    observe(node) { this.targets.push(node); }
    disconnect() { this.gone = true; this.targets = []; }
    // what a browser does after layout when an observed box has a new size
    deliver(width, height = 44) {
      if (this.gone) return;
      this.cb(this.targets.map(target => ({ target, contentRect: { width, height } })), this);
    }
  }
  const ctx = vm.createContext({
    window: observer ? { ResizeObserver } : {},
    ResizeObserver,
    Math, parseFloat,
    getComputedStyle: () => ({ lineHeight: LH + "px", paddingTop: PAD + "px", paddingBottom: PAD + "px" }),
    ComposeFormat: { fieldOf: () => null },
  });
  for (const name of ["rowMetrics", "twinLines", "fitRow", "watchShown"]) vm.runInContext(fn(name), ctx);
  return { ctx, observers };
}

// the card's own tick, reduced to the part this is about: the row fitted to its words
function wire(ctx, el) {
  el.tick = () => { el.ticks++; ctx.fitRow(el.ta, el.twin); };
  return el;
}

const DRAFT = "Half a thought about the title size\n\nand then a second paragraph that wraps " +
  "onto a further line or two before it stops";

test("a draft built while its card is hidden is fitted on the frame the card is shown", () => {
  const { ctx, observers } = sandbox();
  const el = wire(ctx, card(DRAFT));
  // built hidden: the tick the card is built with measures nothing and writes nothing
  el.tick();
  assert.equal(el.ta.style.height, undefined, "a hidden row keeps the height it had");
  ctx.watchShown(el);
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].targets, [el.bottombar], "the bar is what is watched");
  assert.equal(el.shownObserver, observers[0], "the card keeps its watch, for dropCard");
  // still hidden: a delivery at no width is not a showing
  observers[0].deliver(0);
  assert.equal(el.ticks, 1);
  assert.equal(el.ta.style.height, undefined);
  // shown: the bar has a width, and the row takes its words' height in that same delivery
  el.room.width = 300;
  observers[0].deliver(360);
  assert.equal(el.ticks, 2, "one fit on the frame the card is shown");
  const want = Math.ceil(lines(DRAFT, 300) * LH + 2 * PAD);
  assert.ok(lines(DRAFT, 300) >= 3, "the draft is several lines at this width");
  assert.equal(el.ta.style.height, want + "px", "the row has its full height, with no key typed");
});

test("only a showing fits the row: the row growing and the window turning do not", () => {
  const { ctx, observers } = sandbox();
  const el = wire(ctx, card(DRAFT));
  ctx.watchShown(el);
  el.room.width = 300;
  observers[0].deliver(360);
  assert.equal(el.ticks, 1);
  // the row growing as words are typed changes the bar's height, which the keystroke's own tick fits
  observers[0].deliver(360, 120);
  // and a new width is the window's, whose resize ticks the card on show itself
  observers[0].deliver(380, 120);
  assert.equal(el.ticks, 1, "nothing but a showing ticks from the watch");
});

test("a card hidden and shown again is fitted again, for words given to it while hidden", () => {
  const { ctx, observers } = sandbox();
  const el = wire(ctx, card("One line"));
  ctx.watchShown(el);
  el.room.width = 300;
  observers[0].deliver(360);
  const one = el.ta.style.height;
  // hidden again; the Mac's handoff or the shelf writes a longer draft into the hidden row
  el.room.width = 0;
  observers[0].deliver(0);
  el.ta.value = DRAFT;
  el.tick();
  assert.equal(el.ta.style.height, one, "the hidden row could not be fitted to the new words");
  el.room.width = 300;
  observers[0].deliver(360);
  assert.equal(el.ta.style.height, Math.ceil(lines(DRAFT, 300) * LH + 2 * PAD) + "px");
  assert.equal(el.ticks, 3);
});

test("a page without ResizeObserver builds the card as before", () => {
  const { ctx, observers } = sandbox({ observer: false });
  const el = wire(ctx, card(DRAFT));
  assert.doesNotThrow(() => ctx.watchShown(el));
  assert.equal(observers.length, 0);
  assert.equal(el.shownObserver, undefined);
});

test("a card taken down puts its draft on the shelf and lets its watch go", () => {
  const disconnected = [];
  const shelf = {}, els = {};
  const ctx = vm.createContext({
    els, shelf, arrivedCard: null, editorsWorn: new Set(["c1"]),
    omniSweepEnd() {}, turnEnd() {}, clearTimeout() {}, dropAnswered() {}, dropSent() {}, trayDrop() {},
  });
  vm.runInContext(fn("dropCard"), ctx);
  els.c1 = {
    ta: { value: DRAFT, selectionStart: 3, selectionEnd: 3, selectionDirection: "none" },
    reply: { dataset: { raw: "An invented answer." } }, replyTop: 0,
    field: { formatted: () => false, want() {}, detach() {} },
    bandObserver: { disconnect: () => disconnected.push("band") },
    shownObserver: { disconnect: () => disconnected.push("shown") },
    box: { remove() {} },
  };
  ctx.dropCard("c1");
  assert.deepEqual(disconnected.sort(), ["band", "shown"]);
  assert.equal(shelf.c1.value, DRAFT);
  assert.equal(els.c1, undefined);
});

test("every card the page builds is watched, once its parts are in els", () => {
  const make = fn("makeBox");
  const built = make.indexOf("const card = els[b.id] =");
  const watched = make.indexOf("watchShown(els[b.id]);");
  assert.ok(built >= 0 && watched > built, "makeBox hangs the watch on the card after building it");
  assert.match(fn("dropCard"), /if \(el\.shownObserver\) el\.shownObserver\.disconnect\(\);/);
});
