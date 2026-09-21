// Deterministic unit tests for the shared display helpers added to card-logic.js:
// ticketNum (row numbering), testReady (ready-to-test display gate), and
// staleTier (Your-turn step fade). Loaded in a sandbox with DOM stubs so the
// pure logic runs under node without a browser. Clock is passed in, never waited.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = require("node:path").resolve(__dirname, "..", "card-logic.js");
const noop = () => {};
const el = () => ({ style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  appendChild: noop, prepend: noop, setAttribute: noop, addEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [], textContent: "", dataset: {}, children: [], remove: noop });
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
const { ticketNum, testReady, staleTier } = sandbox;

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

test("staleTier steps at 4 / 8 / 16 / 32 minutes from the true turn time", () => {
  const now = 10_000_000_000;               // fixed clock, ms
  const at = min => yours({ turnTs: now / 1000 - min * 60 });
  assert.equal(staleTier(at(0), now), 0);
  assert.equal(staleTier(at(3.9), now), 0);
  assert.equal(staleTier(at(4), now), 1);
  assert.equal(staleTier(at(7.9), now), 1);
  assert.equal(staleTier(at(8), now), 2);
  assert.equal(staleTier(at(16), now), 3);
  assert.equal(staleTier(at(31.9), now), 3);
  assert.equal(staleTier(at(32), now), 4);
  assert.equal(staleTier(at(100), now), 4);
});

test("only visibly yellow cards age; test-ready, other states and unknown turn time do not", () => {
  const now = 10_000_000_000;
  const oldTurn = now / 1000 - 100 * 60;
  // a marked (ready-to-test) card never ages even though it is old and yours
  assert.equal(staleTier(yours({ turnTs: oldTurn, testing: true }), now), 0);
  // non-yellow states never age
  assert.equal(staleTier({ state: "working", turnTs: oldTurn }, now), 0);
  assert.equal(staleTier({ state: "queued", pending: 1, turnTs: oldTurn }, now), 0);
  assert.equal(staleTier({ done: true, state: "done", turnTs: oldTurn }, now), 0);
  // a yours card with no recorded turn time does not age (turn time unknown)
  assert.equal(staleTier(yours({ turnTs: 0 }), now), 0);
  assert.equal(staleTier(yours({}), now), 0);
});
