// Section ordering, using the shared logic with no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

// ---- the rule, on its own ---------------------------------------------------------
function logicWith(state) {
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: () => ({}), body: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    els: {}, lastState: state, selectedId: null, activeOwner: "lane", lastSel: {},
    select() {}, deselect() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(require("node:fs").readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), sandbox, { filename: "card-logic.js" });
  return sandbox;
}
const card = (id, extra) => ({ id, owner: "lane", bucket: "meta", title: "card " + id, ball: "you", state: "yours",
  replies: 1, agentTs: 1, ts: 1, pending: 0, done: false, parked: false, parkedTs: 0, doneTs: 0, ...extra });
const docked = (id, dockedTs, extra) => card(id, { docked: true, dockedTs, ...extra });
const deferred = (id, parkedTs, extra) => card(id, { parked: true, state: "parked", parkedTs, ...extra });
const finished = (id, doneTs, extra) => card(id, { done: true, state: "done", doneTs, ...extra });
const ids = list => [...list].map(b => b.id);
const shuffles = list => [list, [...list].reverse(), [...list.slice(3), ...list.slice(0, 3)], [...list.slice(1), list[0]]];

test("Deferred runs by when each card was deferred and Done by when each was marked done, newest first", () => {
  const boxes = [
    docked("k1", 120), docked("k2", 420), docked("k3", 220),
    // the ts and agentTs of a card say nothing about when it was deferred or closed
    deferred("p1", 100, { ts: 90, agentTs: 40 }), deferred("p2", 300, { ts: 5, agentTs: 10 }),
    deferred("p3", 200, { ts: 70, agentTs: 99 }), deferred("p4", 250, { ts: 1, agentTs: 0 }),
    finished("d1", 50, { ts: 80 }), finished("d2", 500, { ts: 2 }), finished("d3", 400, { ts: 60 }),
    finished("d4", 450, { ts: 1 }),
    card("o1", { agentTs: 3 }), card("o2", { agentTs: 8 }),
  ];
  for (const order of shuffles(boxes)) {
    const state = { boxes: order };
    const sandbox = logicWith(state);
    assert.deepEqual(ids(sandbox.viewPoolFor(state, "docked")), ["k2", "k3", "k1"]);
    assert.deepEqual(ids(sandbox.viewPoolFor(state, "deferred")), ["p2", "p4", "p3", "p1"]);
    assert.deepEqual(ids(sandbox.viewPoolFor(state, "done")), ["d2", "d4", "d3", "d1"]);
    assert.deepEqual(ids(sandbox.viewPoolFor(state, "todo")), ["o1", "o2"]);
  }
});

test("Doing keeps the order it had, with or without cards in the other three sections", () => {
  const doing = [
    card("late", { agentTs: 9 }),
    card("fresh", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 50 }),
    card("bare", { agentTs: 0, ts: 0 }),
    card("tie-a", { agentTs: 5 }), card("tie-b", { agentTs: 5 }),
    card("early", { agentTs: 2 }),
    card("ts-only", { agentTs: 0, ts: 7 }),
    card("q1", { state: "queued", ball: "me", ts: 30 }), card("q2", { state: "queued", ball: "me", ts: 40 }),
    card("w1", { state: "working", ball: "me", ts: 10 }), card("w2", { state: "working", ball: "me", ts: 20 }),
    card("newer", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 60 }),
  ];
  const order = ["newer", "fresh", "early", "tie-a", "tie-b", "ts-only", "late", "bare", "q2", "q1", "w2", "w1"];
  const alone = { boxes: doing };
  assert.deepEqual(ids(logicWith(alone).viewPoolFor(alone, "todo")), order);
  const mixed = { boxes: [docked("ka", 3), docked("kb", 4), deferred("pa", 5), ...doing, finished("da", 6), deferred("pb", 7, { agentTs: 0, ts: 99 }), finished("db", 8)] };
  const sandbox = logicWith(mixed);
  assert.deepEqual(ids(sandbox.viewPoolFor(mixed, "todo")), order);
  // the whole pool lies in four runs one after another: Doing, Docked, Deferred, Done
  assert.deepEqual(ids(sandbox.poolOf(mixed)), [...order, "kb", "ka", "pb", "pa", "db", "da"]);
});

test("a card with no stamp yet counts as the newest, and equal stamps keep the older order", () => {
  // a page marks a card deferred or done a moment before the board's reading names the time
  const state = { boxes: [
    docked("old-dock", 40), docked("docked-here", 0), docked("later-dock", 90),
    deferred("old", 40), deferred("moved-here", 0), deferred("later", 90),
    finished("old-done", 40), finished("closed-here", 0), finished("later-done", 90),
  ] };
  const sandbox = logicWith(state);
  assert.deepEqual(ids(sandbox.viewPoolFor(state, "docked")), ["docked-here", "later-dock", "old-dock"]);
  assert.deepEqual(ids(sandbox.viewPoolFor(state, "deferred")), ["moved-here", "later", "old"]);
  assert.deepEqual(ids(sandbox.viewPoolFor(state, "done")), ["closed-here", "later-done", "old-done"]);

  // equal stamps: a card the reader is waiting on first, the oldest turn first; done cards newest ts first
  const tied = { boxes: [
    docked("k-late", 60, { agentTs: 20 }), docked("k-early", 60, { agentTs: 4 }), docked("k-first", 61),
    deferred("t-late", 60, { agentTs: 20 }), deferred("t-early", 60, { agentTs: 4 }), deferred("t-first", 61),
    finished("u-old", 70, { ts: 3 }), finished("u-new", 70, { ts: 9 }), finished("u-first", 71, { ts: 1 }),
  ] };
  const other = logicWith(tied);
  assert.deepEqual(ids(other.viewPoolFor(tied, "docked")), ["k-first", "k-early", "k-late"]);
  assert.deepEqual(ids(other.viewPoolFor(tied, "deferred")), ["t-first", "t-early", "t-late"]);
  assert.deepEqual(ids(other.viewPoolFor(tied, "done")), ["u-first", "u-new", "u-old"]);
});
