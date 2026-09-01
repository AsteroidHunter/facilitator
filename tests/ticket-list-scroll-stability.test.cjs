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

function rendererFrom(html, clock) {
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
    "SPIN_FRAMES", "spinFrame", "activeOwner", "ticketView", "selectedId",
    "selectedTask", `${source}; return renderCarousel;`,
  )(
    document, DateStub, () => null, state => state.boxes, () => true,
    () => "queued", () => "queued", h, {}, () => "1m", () => {},
    ["|", "/", "-", "\\"], 0, "facilitator", "todo", "m1", null,
  );
  return { renderCarousel, tiklist };
}

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} leaves manual ticket-list scrolling alone on a routine repaint`, async () => {
    const html = await readFile(path.join(ROOT, pageName), "utf8");
    const clock = { now: 1_000_000 };
    const { renderCarousel, tiklist } = rendererFrom(html, clock);
    const state = {
      agents: { facilitator: { name: "facilitator", alive: true } },
      boxes: Array.from({ length: 20 }, (_, index) => ({
        id: `m${index + 1}`,
        owner: "facilitator",
        ball: "me",
        writing: false,
        bg: false,
        done: false,
        pending: 0,
        task: "",
        title: `Card ${index + 1}`,
        agentTs: clock.now / 1000 - 30,
      })),
    };

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

  test(`${pageName} still reveals a row when the user explicitly selects it`, async () => {
    const html = await readFile(path.join(ROOT, pageName), "utf8");
    const source = functionSource(html, "select", "updatePwd");
    assert.match(source, /#tiklist \.trow\.on["']\)\?\.scrollIntoView\(\{ block: ["']nearest["'] \}\)/);
  });
}
