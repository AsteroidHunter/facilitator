// The time on an open ticket, checked without a browser on the desktop board
// (index.html) and the phone page (m.html). Each page's real row painter is run
// over a small pool with the card logic the pages load, and both draw the time
// from card-logic.js's one ticketTs, so they cannot drift apart. The time counts
// from the last message on the card from either side: the reader's last (sent,
// queued or answered) or the agent's last reply, whichever is newer. A working
// card still shows the spinner, and a done card still counts from the agent's
// last reply. Nothing here renders a pixel.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = { desktop: read("index.html"), phone: read("m.html") };

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
const { cardState, queueState, testReady, appendOmniRowArt, shortAge, ticketTs } = sandbox;

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}

// each page's painter, handed one pool, answers with the rows it drew. the
// spinner is a stub that answers one frame, the way the other row tests do
const SPIN = ["|", "/", "-", "\\"];
const PAINT = {
  desktop: pool => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge", "ticketTs",
      "spinGlyph", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(queueState, cardState, h, {}, shortAge, ticketTs, () => SPIN[0], () => "todo", "none", null, testReady,
      appendOmniRowArt, noop, noop, noop);
    const pane = new FakeElement("div");
    paint(pane, pool, "todo", { agents: {} }, "lane");
    return pane.children;
  },
  phone: pool => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge", "ticketTs",
      "spinGlyph", "selectedId", "testReady", "appendOmniRowArt", "omniRowFace",
      "select", "closeDrawer", "onFold", "unfoldTicket", "homeOpen", "setHome", "drawerOpen",
      `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, shortAge, ticketTs, () => SPIN[0], "none", testReady, appendOmniRowArt, noop,
      noop, noop, noop, noop, false, noop, () => false);
    const pane = new FakeElement("div");
    paint(pane, pool, "todo", { agents: {} }, noop);
    return pane.children;
  },
};

const find = (node, cls) => {
  if (node.className.split(/\s+/).includes(cls)) return node;
  for (const child of node.children) { const hit = find(child, cls); if (hit) return hit; }
  return null;
};
const age = (where, b) => find(PAINT[where]([b]).find(r => r.dataset.id === b.id), "tage").textContent;

const NOW = Date.now() / 1000;
const MIN = 60, HOUR = 3600;
// a card the reader has just made: his message is queued and no agent has written to it
const fresh = extra => ({ id: "m1", title: "A card", owner: "lane", bg: false, task: "", ball: "me",
  replies: 0, agentTs: 0, pending: 1, pendingStamps: [NOW - 7 * MIN], state: "queued", ...extra });
// a card the agent has answered, with nothing of his waiting
const answered = extra => ({ id: "m1", title: "A card", owner: "lane", bg: false, task: "", ball: "you",
  replies: 1, agentTs: NOW - 2 * HOUR, pending: 0, pendingStamps: [], state: "yours", ...extra });

for (const where of Object.keys(PAINT)) {
  test(`${where}: a new card with only his message shows the time since that message`, () => {
    assert.equal(age(where, fresh()), "7m");
    assert.equal(age(where, fresh({ pendingStamps: [NOW - 30] })), "now");
    assert.equal(age(where, fresh({ pendingStamps: [NOW - 3 * HOUR - 5] })), "3h");
  });

  test(`${where}: an agent reply newer than his message counts from the reply`, () => {
    const b = answered({ agentTs: NOW - 5 * MIN, answered: [{ text: "hi", ts: NOW - 40 * MIN }] });
    assert.equal(age(where, b), "5m");
    // and his answered message, though older, never pulls the time back
    assert.equal(age(where, answered({ agentTs: NOW - 2 * HOUR, answered: [{ text: "hi", ts: NOW - 5 * HOUR }] })), "2h");
  });

  test(`${where}: his follow-up newer than the agent's reply counts from the follow-up`, () => {
    const b = answered({ ball: "me", state: "queued", pending: 1, pendingStamps: [NOW - 3 * MIN] });
    assert.equal(age(where, b), "3m");
    // the newest of several queued messages is the one counted
    const many = answered({ ball: "me", state: "queued", pending: 2, pendingStamps: [NOW - 50 * MIN, NOW - 9 * MIN] });
    assert.equal(age(where, many), "9m");
    // a queued message older than the reply does not win over it
    const older = answered({ agentTs: NOW - 4 * MIN, pending: 1, pendingStamps: [NOW - 30 * MIN], state: "queued" });
    assert.equal(age(where, older), "4m");
  });

  test(`${where}: a working card still shows the spinner, whoever wrote last`, () => {
    assert.equal(age(where, fresh({ writing: true, state: "working" })), SPIN[0]);
    assert.equal(age(where, answered({ writing: true, state: "working", pending: 1, pendingStamps: [NOW - 60] })), SPIN[0]);
  });

  test(`${where}: a done card keeps counting from the agent's last reply`, () => {
    const b = answered({ done: true, state: "done", agentTs: NOW - 3 * HOUR - 5, pending: 1, pendingStamps: [NOW - 60] });
    assert.equal(age(where, b), "3h");
    assert.equal(age(where, answered({ done: true, state: "done", agentTs: 0 })), "");
  });

  test(`${where}: a card with no message on either side shows no time`, () => {
    assert.equal(age(where, fresh({ pending: 0, pendingStamps: [], state: "new" })), "");
  });
}

test("ticketTs is one rule: both pages call it, and neither counts from agentTs alone", () => {
  assert.match(HTML.desktop, /shortAge\(ticketTs\(b\)\)/);
  assert.match(HTML.phone, /shortAge\(ticketTs\(b\)\)/);
  assert.doesNotMatch(functionSource(HTML.desktop, "paintTicketPane", "renderCarousel"), /shortAge\(b\.agentTs\)/);
  assert.doesNotMatch(functionSource(HTML.phone, "paintPhonePane", "renderTickets"), /shortAge\(b\.agentTs\)/);
  // the desktop repaints a row when the age it shows turns, counted from the same
  // stamp, not each minute (tests/ticket-list-signature.test.cjs)
  const desk = functionSource(HTML.desktop, "paintTicketPane", "renderCarousel");
  assert.equal(desk.match(/shortAge\(ticketTs\(b\)\)/g).length, 2, "the signature and the row both read the shown age");
  assert.doesNotMatch(desk, /Date\.now\(\) \/ 1000 - ticketTs\(b\)/);
});

test("ticketTs picks the newest of the reader's messages and the agent's reply", () => {
  assert.equal(ticketTs({ agentTs: 100, pendingStamps: [50, 150], answered: [{ ts: 120 }] }), 150);
  assert.equal(ticketTs({ agentTs: 200, pendingStamps: [50], answered: [{ ts: 120 }] }), 200);
  assert.equal(ticketTs({ agentTs: 0, pendingStamps: [], answered: null }), 0);
  assert.equal(ticketTs({}), 0);
  assert.equal(ticketTs({ done: true, agentTs: 100, pendingStamps: [150] }), 100);
});
