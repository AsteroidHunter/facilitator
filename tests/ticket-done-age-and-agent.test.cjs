// A ticket's right column, checked without a browser on every surface that draws
// it: the desktop board (index.html), the phone's drawer (m.html) and the typed
// page (page.html). Each surface's real row painter is run over a small pool, the
// way tests/ticket-unfold.test.cjs runs them, with the card logic the pages load
// and card-logic.js's own shortAge. Nothing here renders a pixel.
//
// the top is the card's age, counted from agentTs (when its agent last wrote to
// it, a progress note included) for a done card exactly as for any other, never
// the word "done". the bottom is the agent: the card's own `agent` when an agent
// has answered it, else the lane's live agent, else "offline".
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = { desktop: read("index.html"), phone: read("m.html"), page: read("page.html") };

// ---- a small document -------------------------------------------------------------
class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = String(tag).toUpperCase();
    this.className = className || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this._text = String(text ?? "");
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      contains: n => names().includes(n),
      toggle: (n, force) => {
        const want = force === undefined ? !names().includes(n) : !!force;
        this.className = (want ? [...new Set([...names(), n])] : names().filter(x => x !== n)).join(" ");
        return want;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const at = this.parentElement ? this.parentElement.children.indexOf(this) : -1;
    return at < 0 ? null : this.parentElement.children[at + 1] || null;
  }
  insertBefore(child, ref) {
    child.parentElement = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute() {}
  addEventListener() {}
  get offsetHeight() { return 64; }
  getBoundingClientRect() {
    const top = (this.parentElement ? this.parentElement.children.indexOf(this) : 0) * 72;
    return { left: 0, right: 300, width: 300, top, bottom: top + 64, height: 64 };
  }
  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(c => c.classList.contains("trow") && c.classList.contains("on")) || null;
  }
  scrollIntoView() {}
}
const h = (tag, className, text) => new FakeElement(tag, className, text);
const noop = () => {};

const sandbox = {
  document: { createElement: tag => new FakeElement(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: new FakeElement("body") },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {}, getComputedStyle: () => ({ getPropertyValue: () => " 16px" }),
  fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }), poll: noop,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const { cardState, queueState, testReady, appendOmniRowArt, shortAge } = sandbox;

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}

// each surface's painter, handed one pool, the view it is drawing and the
// board's agents, answers with the rows it drew
const SPIN = ["|", "/", "-", "\\"];
const PAINT = {
  desktop: (pool, view, agents) => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "spinGlyph", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(queueState, cardState, h, {}, shortAge, () => SPIN[0], () => view, "none", null, testReady,
      appendOmniRowArt, noop, noop, noop);
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents }, "lane");
    return pane.children;
  },
  phone: (pool, view, agents) => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "spinGlyph", "selectedId", "testReady", "appendOmniRowArt", "omniRowFace",
      "select", "closeDrawer", "onFold", "unfoldTicket", "homeOpen", "setHome", "drawerOpen",
      `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, shortAge, () => SPIN[0], "none", testReady, appendOmniRowArt, noop,
      noop, noop, noop, noop, false, noop, () => false);
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents }, noop);
    return pane.children;
  },
  page: (pool, view, agents) => {
    const tiklist = new FakeElement("div"), chips = new FakeElement("div");
    const document = { getElementById: id => ({ tiklist, chips })[id] };
    const render = new Function("document", "Date", "curWs", "poolOf", "viewFilter", "queueState",
      "cardState", "h", "seenReplies", "shortAge", "syncSpinner", "SPIN_FRAMES", "spinFrame", "activeOwner",
      "curView", "paintViewTabs", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.page, "renderCarousel", "ord")}; return renderCarousel;`,
    )(document, Date, () => null, state => state.boxes, () => true, queueState, cardState, h, {},
      shortAge, noop, SPIN, 0, "lane", () => view, noop, "none", null, testReady, appendOmniRowArt,
      noop, noop, noop);
    render({ agents, boxes: pool });
    return tiklist.children;
  },
};

// the first element with this class at or under a node
const find = (node, cls) => {
  if (node.className.split(/\s+/).includes(cls)) return node;
  for (const child of node.children) { const hit = find(child, cls); if (hit) return hit; }
  return null;
};
const ticket = (where, pool, view, agents, id) => {
  const row = PAINT[where](pool, view, agents).find(r => r.dataset.id === id);
  assert.ok(row, `${where}: card ${id} is not in the ${view} list`);
  return { age: find(row, "tage").textContent, agent: find(row, "teng").textContent };
};

const NOW = Date.now() / 1000;
const live = name => ({ lane: { name, alive: true } });
const card = extra => ({ id: "m1", title: "A card", owner: "lane", bg: false, task: "", ball: "you",
  replies: 1, pending: 0, agentTs: NOW - 401 * 86400, state: "yours", ...extra });
const done = extra => card({ done: true, state: "done", ...extra });

for (const where of Object.keys(PAINT)) {
  test(`${where}: a done card shows its age like any other, never the word done`, () => {
    assert.equal(ticket(where, [done()], "done", live("opus"), "m1").age, "401d");
    assert.equal(ticket(where, [card()], "todo", live("opus"), "m1").age, "401d");
    assert.equal(ticket(where, [done({ agentTs: NOW - 3 * 3600 - 5 })], "done", live("opus"), "m1").age, "3h");
    assert.equal(ticket(where, [done({ agentTs: NOW - 120 })], "done", live("opus"), "m1").age, "2m");
  });

  test(`${where}: a done card no agent ever wrote to shows no age, as any other card would`, () => {
    assert.equal(ticket(where, [done({ agentTs: 0 })], "done", live("opus"), "m1").age, "");
    assert.equal(ticket(where, [card({ agentTs: 0 })], "todo", live("opus"), "m1").age, "");
  });

  test(`${where}: each ticket names the agent that answered its card`, () => {
    const pool = [done({ id: "m1", agent: "astra" }), done({ id: "m2", agent: "opus" })];
    assert.equal(ticket(where, pool, "done", live("sonnet"), "m1").agent, "astra");
    assert.equal(ticket(where, pool, "done", live("sonnet"), "m2").agent, "opus");
    assert.equal(ticket(where, [card({ agent: "astra" })], "todo", live("opus"), "m1").agent, "astra");
  });

  test(`${where}: a card no agent has answered keeps the lane's agent, or offline`, () => {
    assert.equal(ticket(where, [done()], "done", live("opus"), "m1").agent, "opus");
    assert.equal(ticket(where, [done({ agent: "" })], "done", live("opus"), "m1").agent, "opus");
    assert.equal(ticket(where, [done()], "done", { lane: { name: "opus", alive: false } }, "m1").agent, "offline");
    assert.equal(ticket(where, [done()], "done", {}, "m1").agent, "");
  });

  test(`${where}: a card's own agent shows even while the lane is offline`, () => {
    assert.equal(ticket(where, [done({ agent: "sonnet" })], "done", { lane: { name: "opus", alive: false } }, "m1").agent, "sonnet");
  });
}

test("the phone and the typed page draw the same column as the desktop for the same cards", () => {
  const pool = [done({ id: "m1", agent: "astra" }), done({ id: "m2" }), done({ id: "m3", agentTs: 0, agent: "opus" })];
  const column = where => pool.map(b => ticket(where, pool, "done", live("sonnet"), b.id));
  assert.deepEqual(column("phone"), column("desktop"));
  assert.deepEqual(column("page"), column("desktop"));
});
