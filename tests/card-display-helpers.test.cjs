// Deterministic unit tests for the shared display helpers added to card-logic.js:
// ticketNum (row numbering) and testReady (ready-to-test display gate). Loaded
// in a sandbox with DOM stubs so the pure logic runs under node without a
// browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = require("node:path").resolve(__dirname, "..", "card-logic.js");
const noop = () => {};
const el = tag => {
  const node = { tagName: String(tag || "div").toUpperCase(), style: {}, className: "", children: [],
    textContent: "", dataset: {}, parentNode: null, attributes: {} };
  const names = () => node.className.split(/\s+/).filter(Boolean);
  node.classList = {
    add: (...added) => { node.className = [...new Set([...names(), ...added])].join(" "); },
    remove: (...gone) => { node.className = names().filter(name => !gone.includes(name)).join(" "); },
    toggle: (name, force) => {
      const on = names().includes(name), want = force == null ? !on : !!force;
      if (want && !on) node.classList.add(name);
      if (!want && on) node.classList.remove(name);
      return want;
    },
    contains: name => names().includes(name),
  };
  node.appendChild = child => { child.parentNode = node; node.children.push(child); return child; };
  node.prepend = child => { child.parentNode = node; node.children.unshift(child); return child; };
  node.insertBefore = (child, before) => {
    child.parentNode = node;
    const index = node.children.indexOf(before);
    if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
    return child;
  };
  node.remove = () => {
    if (!node.parentNode) return;
    node.parentNode.children = node.parentNode.children.filter(child => child !== node);
    node.parentNode = null;
  };
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.addEventListener = noop;
  node.querySelector = selector => selector.startsWith(".")
    ? node.children.find(child => child.classList && child.classList.contains(selector.slice(1))) || null : null;
  node.querySelectorAll = () => [];
  return node;
};
const sandbox = {
  document: { createElement: el, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: el() },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
const { ticketNum, testReady, omniTicket, appendOmniRowArt, syncOmniCard } = sandbox;

// a card the machine has landed on the reader's turn (a completed reply waits)
const yours = extra => ({ state: "yours", ball: "you", replies: 1, agentTs: 1000, pending: 0, ...extra });

test("ticketNum shows a # number for board and numeric ids, none for standing ids", () => {
  assert.equal(ticketNum("m128"), "#128");   // a card made on the board
  assert.equal(ticketNum("m5"), "#5");
  assert.equal(ticketNum("128"), "#128");     // already numeric: no double #
  assert.equal(ticketNum("1.1"), "#1.1");
  assert.equal(ticketNum("0"), "#0");
  assert.equal(ticketNum("q"), "");           // purely non-numeric standing id
  assert.equal(ticketNum("meta"), "");
  assert.equal(ticketNum("m1a"), "");         // m not followed by digits only
  assert.equal(ticketNum(""), "");
  assert.equal(ticketNum(null), "");
});

test("ticketNum never renumbers: the id is read as given, not from position", () => {
  // two rows in some list order still map to their own ids
  assert.equal(ticketNum("m131"), "#131");
  assert.equal(ticketNum("m126"), "#126");
});

test("omniTicket maps canonical titles to the three supplied assets", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(omniTicket("Omni Ticket #1"))),
    { number: 1, variant: 1, src: "/assets/ticket-1.webp" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(omniTicket("Omni Ticket #2"))),
    { number: 2, variant: 2, src: "/assets/ticket-2.webp" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(omniTicket("Omni Ticket #3"))),
    { number: 3, variant: 3, src: "/assets/ticket-3.webp" });
});

test("omniTicket keeps later numbering reversible and rejects ordinary titles", () => {
  assert.equal(omniTicket("Omni Ticket #4").variant, 1);
  assert.equal(omniTicket("Omni Ticket #6").variant, 3);
  assert.equal(omniTicket("omni"), null);
  assert.equal(omniTicket("Omnibus cleanup"), null);
  assert.equal(omniTicket("Omni Ticket #0"), null);
  assert.equal(omniTicket("Omni Ticket #2 extra"), null);
});

test("Omni row art occupies the left slot without changing state classes", () => {
  for (const number of [1, 2, 3]){
    const row = el("div"); row.className = "trow working yours testc";
    const inner = el("div");
    const info = appendOmniRowArt(row, inner, { title: `Omni Ticket #${number}` });
    assert.equal(info.variant, number);
    assert.equal(row.classList.contains("omni-ticket"), true);
    assert.equal(row.classList.contains("working"), true);
    assert.equal(row.classList.contains("yours"), true);
    assert.equal(row.classList.contains("testc"), true);
    assert.equal(inner.children.length, 1);
    assert.equal(inner.children[0].className, "omni-art");
    assert.equal(inner.children[0].src, `/assets/ticket-${number}.webp`);
    assert.equal(inner.children[0].attributes["aria-hidden"], "true");
  }
  const ordinaryRow = el("div"), ordinaryInner = el("div");
  assert.equal(appendOmniRowArt(ordinaryRow, ordinaryInner, { title: "Ordinary" }), null);
  assert.equal(ordinaryInner.children.length, 0);
  assert.equal(ordinaryRow.classList.contains("omni-ticket"), false);
});

test("expanded card decoration follows canonical title renames", () => {
  const box = el("article"), toc = el("div"), head = el("div");
  const number = el("span"), titleEl = el("span");
  head.appendChild(number); head.appendChild(titleEl);
  const record = { box, toc, titleEl };
  syncOmniCard(record, { title: "Omni Ticket #2" });
  assert.equal(box.classList.contains("omni-card"), true);
  assert.equal(toc.classList.contains("omni-card"), true);
  assert.equal(head.children[1].className, "omni-card-art");
  assert.equal(head.children[1].src, "/assets/ticket-2.webp");
  syncOmniCard(record, { title: "Ordinary card" });
  assert.equal(box.classList.contains("omni-card"), false);
  assert.equal(toc.classList.contains("omni-card"), false);
  assert.equal(head.children.some(child => child.className === "omni-card-art"), false);
});

test("testReady paints only a marked card that is awaiting the reader", () => {
  assert.equal(testReady(yours({ testing: true })), true);
  assert.equal(testReady(yours({ testing: false })), false);
  // a marked card that returned to work, queued or done keeps its own colour
  assert.equal(testReady({ testing: true, state: "working" }), false);
  assert.equal(testReady({ testing: true, state: "queued", pending: 1 }), false);
  // a done card ships state "done" (the snapshot sends the shown state), so the gate is off
  assert.equal(testReady({ testing: true, done: true, state: "done" }), false);
  // a shelved (parked) card still awaiting the reader qualifies
  assert.equal(testReady({ testing: true, parked: true, state: "parked", ball: "you", replies: 1, agentTs: 1000, pending: 0 }), true);
  assert.equal(testReady({}), false);
});
