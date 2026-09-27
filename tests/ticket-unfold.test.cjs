// unfolding the ready-to-test fold, checked without a browser on every surface
// that draws it: the desktop board (index.html), the phone's drawer (m.html) and
// the typed page (page.html). each surface's real row painter is run over a
// small pool, the way tests/ticket-test-fold.test.cjs runs them, with the card
// logic the pages load. nothing here renders a pixel.
//
// marking a folded card done unfolds it. that was already true before any of
// this: every page closes a card with /close, the board lowers the marker there
// (server-testing.test.cjs), and no surface draws the fold on a done card. the
// tests below walk one folded card through that close on each surface.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = { desktop: read("index.html"), phone: read("m.html"), page: read("page.html") };

// ---- a small document -------------------------------------------------------------
// rows stack 72px apart, 300 by 64 each, so a click can be placed on a row's corner
const ROW = { w: 300, h: 64, gap: 72 };
class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = String(tag).toUpperCase();
    this.className = className || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.listeners = {};
    this._text = String(text ?? "");
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      contains: n => names().includes(n),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  get offsetHeight() { return ROW.h; }
  getBoundingClientRect() {
    const top = (this.parentElement ? this.parentElement.children.indexOf(this) : 0) * ROW.gap;
    return { left: 0, right: ROW.w, width: ROW.w, top, bottom: top + ROW.h, height: ROW.h };
  }
  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(c => c.classList && c.classList.contains("trow") && c.classList.contains("on")) || null;
  }
  scrollIntoView() {}
}
const h = (tag, className, text) => new FakeElement(tag, className, text);
const noop = () => {};

// what the pages would have asked of the board and of themselves
const calls = [];
const record = name => (...a) => { calls.push([name, ...a]); };
let foldPx = 16;   // what the row's --fold computes to, per surface

const sandbox = {
  document: { createElement: tag => new FakeElement(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: new FakeElement("body") },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
  getComputedStyle: () => ({ getPropertyValue: name => (name === "--fold" ? " " + foldPx + "px" : "") }),
  fetch: (url, opts) => { calls.push(["fetch", url, opts && opts.method]); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }); },
  poll: record("poll"),
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const logic = name => vm.runInContext(`typeof ${name} === "function" ? ${name} : undefined`, sandbox);
const { cardState, queueState, testReady, appendOmniRowArt } = sandbox;

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}
const NOW = 1_000_000_000;
const DateStub = { now: () => NOW * 1000 };
const SPIN = ["|", "/", "-", "\\"];

// the typed page carries its own copies of the unfold helpers; the board and the
// phone take them from card-logic.js
function pageHelpers() {
  const html = HTML.page;
  if (!html.includes("function unfoldTicket(")) return {};
  const src = functionSource(html, "foldHit", "awaitsYou");
  return new Function("getComputedStyle", "fetch", "poll", "MOCK", "encodeURIComponent",
    `${src}; return { foldHit, onFold, unfoldTicket };`,
  )(sandbox.getComputedStyle, sandbox.fetch, sandbox.poll, false, encodeURIComponent);
}

// each surface's painter, handed one pool and the view it is drawing, answers
// with the rows it drew
const PAINT = {
  desktop: (pool, view = "todo") => {
    const paint = new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(DateStub, queueState, cardState, h, {}, () => "5m", SPIN, 0, () => view, "none", null, testReady,
      appendOmniRowArt, record("select"), logic("onFold"), logic("unfoldTicket"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents: {} }, "lane");
    return pane.children;
  },
  phone: (pool, view = "todo") => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "selectedId", "testReady", "appendOmniRowArt",
      "select", "closeDrawer", "onFold", "unfoldTicket",
      `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, () => "5m", SPIN, 0, "none", testReady, appendOmniRowArt,
      record("select"), record("closeDrawer"), logic("onFold"), logic("unfoldTicket"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, "sig", { agents: {} });
    return pane.children;
  },
  page: (pool, view = "todo") => {
    const tiklist = new FakeElement("div"), chips = new FakeElement("div");
    const document = { getElementById: id => ({ tiklist, chips })[id] };
    const own = pageHelpers();
    const render = new Function("document", "Date", "curWs", "poolOf", "viewFilter", "queueState",
      "cardState", "h", "seenReplies", "shortAge", "syncSpinner", "SPIN_FRAMES", "spinFrame", "activeOwner",
      "curView", "paintViewTabs", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.page, "renderCarousel", "ord")}; return renderCarousel;`,
    )(document, DateStub, () => null, state => state.boxes, () => true, queueState, cardState, h, {},
      () => "5m", noop, SPIN, 0, "lane", () => view, noop, "none", null, testReady, appendOmniRowArt,
      record("select"), own.onFold, own.unfoldTicket);
    render({ agents: {}, boxes: pool });
    return tiklist.children;
  },
};
const SURFACES = Object.keys(PAINT);
const rowOf = (rows, id) => rows.find(r => r.dataset.id === id);
const classes = row => row.className.split(/\s+/);

// a card whose change is ready to try: a completed reply awaits the reader
const reply = { ball: "you", replies: 1, agentTs: NOW - 300, pending: 0 };
const card = extra => ({ id: "m1", title: "Ready to test", owner: "lane", bg: false, task: "", state: "yours",
  ...reply, testing: true, ...extra });
// the same card as the board reads it once the close has landed: done, and the
// marker lowered by _mark_box_done
const closed = extra => card({ done: true, state: "done", testing: false, ...extra });

for (const where of SURFACES) {
  test(`${where}: marking a folded card done unfolds it, and it stays unfolded when brought back`, () => {
    const folded = rowOf(PAINT[where]([card()]), "m1");
    assert.ok(classes(folded).includes("testc"), "the card was not folded to begin with");
    const done = rowOf(PAINT[where]([closed()], "done"), "m1");
    assert.ok(done, "the closed card is not in the done list");
    assert.ok(classes(done).includes("donec"), "the closed card is not drawn done");
    assert.ok(!classes(done).includes("testc"), "the closed card still wears the fold");
    // a reading that still carried the raised marker on a done card, from a
    // board before the close lowered it, draws no fold either
    const stale = rowOf(PAINT[where]([card({ done: true, state: "done" })], "done"), "m1");
    assert.ok(!classes(stale).includes("testc"), "a done card with the marker up wears the fold");
    // brought back to doing, the card waits on the reader again with the
    // marker still down: the fold does not come back on its own
    const back = rowOf(PAINT[where]([card({ testing: false })]), "m1");
    assert.ok(!classes(back).includes("testc"), "the card came back folded");
  });
}
