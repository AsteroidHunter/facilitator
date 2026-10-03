const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.scrollCalls = 0;
    this._textContent = String(text ?? "");
  }

  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    child.parentElement = this;
    this.children.unshift(child);
  }

  addEventListener() {}

  get offsetHeight() { return 40; }

  getBoundingClientRect() {
    const index = this.parentElement ? this.parentElement.children.indexOf(this) : 0;
    return { top: index * 40 - (this.parentElement?.scrollTop || 0) };
  }

  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(child => {
      const classes = child.className.split(/\s+/);
      return classes.includes("trow") && classes.includes("on");
    }) || null;
  }

  scrollIntoView() {
    if (!this.parentElement) return;
    this.parentElement.scrollCalls++;
    this.parentElement.scrollTop = this.parentElement.children.indexOf(this) * 40;
  }
}

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}

// page.html is the document view and keeps its single-list renderCarousel, so it
// is exercised whole. index.html now draws each of the three sheet sections with
// paintTicketPane, which owns the scroll keep and the reveal guard, so that one
// function is exercised for the board.
function pageRendererFrom(html, clock) {
  const tiklist = new FakeElement("div");
  const chips = new FakeElement("div");
  const document = {
    getElementById(id) {
      if (id === "tiklist") return tiklist;
      if (id === "chips") return chips;
      throw new Error(`unexpected element id: ${id}`);
    },
  };
  const h = (tag, className, text) => new FakeElement(tag, className, text);
  const DateStub = { now: () => clock.now };
  const source = functionSource(html, "renderCarousel", "ord");
  const renderCarousel = new Function(
    "document", "Date", "curWs", "poolOf", "viewFilter", "queueState",
    "cardState", "h", "seenReplies", "shortAge", "syncSpinner",
    "SPIN_FRAMES", "spinFrame", "activeOwner", "curView", "paintViewTabs",
    "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
    `${source}; return renderCarousel;`,
  )(
    document, DateStub, () => null, state => state.boxes, () => true,
    () => "queued", () => "queued", h, {}, () => "1m", () => {},
    ["|", "/", "-", "\\"], 0, "facilitator", () => "todo", () => {},
    "m1", null, () => false, () => null,
  );
  return { renderCarousel, tiklist };
}
function paneRendererFrom(html, clock) {
  const pane = new FakeElement("div");
  const h = (tag, className, text) => new FakeElement(tag, className, text);
  const DateStub = { now: () => clock.now };
  const source = functionSource(html, "paintTicketPane", "renderCarousel");
  const paintTicketPane = new Function(
    "Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
    "spinGlyph", "curView", "selectedId", "selectedTask",
    "testReady", "appendOmniRowArt",
    `${source}; return paintTicketPane;`,
  )(
    DateStub, () => "queued", () => "queued", h, {}, () => "1m",
    () => "|", () => "todo", "m1", null,
    () => false, () => null,
  );
  return { paintTicketPane, pane };
}

function pool(clock) {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `m${index + 1}`, owner: "facilitator", ball: "me", writing: false, bg: false,
    done: false, pending: 0, task: "", title: `Card ${index + 1}`, agentTs: clock.now / 1000 - 30,
  }));
}

test("page.html leaves manual ticket-list scrolling alone on a routine repaint", async () => {
  const html = await readFile(path.join(ROOT, "page.html"), "utf8");
  const clock = { now: 1_000_000 };
  const { renderCarousel, tiklist } = pageRendererFrom(html, clock);
  const state = { agents: { facilitator: { name: "facilitator", alive: true } }, boxes: pool(clock) };
  renderCarousel(state);
  assert.equal(tiklist.scrollCalls, 1, "the first render must reveal its selected row");
  tiklist.scrollCalls = 0;
  tiklist.scrollTop = 320;
  const firstSignature = tiklist.dataset.sig;
  clock.now += 61_000;
  renderCarousel(state);
  assert.notEqual(tiklist.dataset.sig, firstSignature, "the age boundary must force a repaint");
  assert.equal(tiklist.scrollCalls, 0, "a routine repaint must not reveal the selected row");
  assert.equal(tiklist.scrollTop, 320, "the user's list position must stay unchanged");
});

test("index.html keeps a section's scroll on a routine repaint and reveals only on select", async () => {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");
  const clock = { now: 1_000_000 };
  const { paintTicketPane, pane } = paneRendererFrom(html, clock);
  const state = { agents: { facilitator: { name: "facilitator", alive: true } } };
  const cards = pool(clock);   // one fixed pool, so advancing the clock crosses an age boundary
  paintTicketPane(pane, cards, "todo", state, "facilitator|true");
  assert.equal(pane.scrollCalls, 1, "the first render of a section reveals its selected row");
  pane.scrollCalls = 0;
  pane.scrollTop = 320;
  const firstSignature = pane.dataset.sig;
  clock.now += 61_000;
  paintTicketPane(pane, cards, "todo", state, "facilitator|true");
  assert.notEqual(pane.dataset.sig, firstSignature, "the age boundary must force a repaint");
  assert.equal(pane.scrollCalls, 0, "a routine repaint must not reveal the selected row");
  assert.equal(pane.scrollTop, 320, "the reader's scroll within the section is kept");
});

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} still reveals a row when the user explicitly selects it`, async () => {
    const html = await readFile(path.join(ROOT, pageName), "utf8");
    const source = functionSource(html, "select", "updatePwd");
    assert.match(source, /#tiklist \.trow\.on["']\)\?\.scrollIntoView\(\{ block: ["']nearest["'] \}\)/);
  });
}
