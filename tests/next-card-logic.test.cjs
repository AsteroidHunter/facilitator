// Departure selection without a browser; integration is in next-card-after-leaving-doing.test.cjs.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");

// ---- the rule, on its own ---------------------------------------------------------
function logicWith(state, selected) {
  const calls = [];
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: () => ({}), body: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    els: {}, lastState: state, selectedId: selected, activeOwner: "lane", lastSel: {},
    select: (id, opts) => calls.push({ select: id, hop: !!(opts && opts.hop) }),
    deselect: () => calls.push({ deselect: true }),
  };
  vm.createContext(sandbox);
  vm.runInContext(require("node:fs").readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), sandbox, { filename: "card-logic.js" });
  return { sandbox, calls };
}
const card = (id, extra) => ({ id, owner: "lane", bucket: "meta", title: "card " + id, ball: "you", state: "yours",
  replies: 1, agentTs: 1, ts: 1, pending: 0, done: false, parked: false, ...extra });

test("the card below takes the screen, else the card above, else nothing", () => {
  const { sandbox } = logicWith(null, null);
  const next = (id, order) => sandbox.doingNeighbour(id, order);
  const list = ["a", "b", "c", "d", "e"];
  assert.equal(next("a", list), "b", "the top card");
  assert.equal(next("c", list), "d", "a middle card");
  assert.equal(next("d", list), "e", "the second to last card");
  assert.equal(next("e", list), "d", "the last card");
  assert.equal(next("a", ["a"]), null, "the only card");
});

test("the standing boxes are never landed on, and a card outside the list opens the top of it", () => {
  const { sandbox } = logicWith(null, null);
  const next = (id, order) => sandbox.doingNeighbour(id, order);
  assert.equal(next("a", ["a", "0", "c"]), "c", "the box below is passed over");
  assert.equal(next("c", ["a", "0", "c"]), "a", "the box above is passed over");
  assert.equal(next("a", ["a", "0", "t0"]), null, "a list of standing boxes alone");
  assert.equal(next("z", ["a", "b"]), "a", "a card that was not in Doing");
  assert.equal(next("z", ["0", "b"]), "b", "a card that was not in Doing, past a standing box");
  assert.equal(next("z", []), null, "no Doing list at all");
});

test("the list is taken in the order the lists draw it, before the card leaves", () => {
  const state = { boxes: [
    card("old", { agentTs: 1 }), card("mid", { agentTs: 5 }), card("new", { agentTs: 9 }),
    card("gone", { agentTs: 7, parked: true, state: "parked" }),
    card("finished", { agentTs: 8, done: true, state: "done" }),
  ] };
  const { sandbox } = logicWith(state, null);
  assert.deepEqual([...sandbox.doingOrder(state)], ["old", "mid", "new"]);
  assert.deepEqual([...sandbox.doingOrder(null)], []);
});

test("the waiting group runs oldest turn first and the other groups keep their order", () => {
  const state = { boxes: [
    card("late", { agentTs: 9 }),
    card("fresh", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 50 }),
    card("bare", { agentTs: 0, ts: 0 }),
    card("tie-a", { agentTs: 5 }),
    card("tie-b", { agentTs: 5 }),
    card("early", { agentTs: 2 }),
    card("ts-only", { agentTs: 0, ts: 7 }),
    card("q1", { state: "queued", ball: "me", ts: 30 }), card("q2", { state: "queued", ball: "me", ts: 40 }),
    card("w1", { state: "working", ball: "me", ts: 10 }), card("w2", { state: "working", ball: "me", ts: 20 }),
    card("d1", { state: "done", done: true, ts: 1 }), card("d2", { state: "done", done: true, ts: 2 }),
    card("newer", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 60 }),
  ] };
  const { sandbox, calls } = logicWith(state, null);
  const order = [...sandbox.poolOf(state).map(b => b.id)];
  assert.deepEqual(order, ["newer", "fresh", "early", "tie-a", "tie-b", "ts-only", "late", "bare", "q2", "q1", "w2", "w1", "d2", "d1"]);
  // the jump after a send reads the same measure, so it lands on the top of the group
  const list = sandbox.viewPoolFor(state, "todo");
  assert.equal(sandbox.jumpNextYellow("late", null, list), "early");
  assert.equal(sandbox.jumpNextYellow("early", null, list), "tie-a");
  assert.equal(sandbox.jumpNextYellow("tie-a", null, list), "early");
  assert.deepEqual(calls.map(c => c.select), ["early", "tie-a", "early"]);
});

test("the hop lands from the list taken at the tap, whatever the page has repainted since", () => {
  const state = { boxes: ["a", "b", "c", "d"].map(id => card(id, { agentTs: 10 + "abcd".indexOf(id) })) };
  const { sandbox, calls } = logicWith(state, "b");
  const order = sandbox.doingOrder(state);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  // the card has already been painted out of Doing by the time the hop runs
  state.boxes.find(b => b.id === "b").parked = true;
  state.boxes.find(b => b.id === "b").state = "parked";
  sandbox.selectNextCard("b", order);
  assert.deepEqual(calls, [{ select: "c", hop: true }]);
  // the card below left Doing while the close was on its way: the next one down takes it
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "c").done = true;
  state.boxes.find(b => b.id === "c").state = "done";
  sandbox.selectNextCard("b", order);
  assert.deepEqual(calls, [{ select: "d", hop: true }]);
  // nothing below is left: the card above
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "d").parked = true;
  state.boxes.find(b => b.id === "d").state = "parked";
  sandbox.selectNextCard("b", order);
  assert.deepEqual(calls, [{ select: "a", hop: true }]);
  // Doing is empty: the next section opens, skipping the moved card
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "a").done = true;
  state.boxes.find(b => b.id === "a").state = "done";
  sandbox.selectNextCard("b", order);
  assert.deepEqual(calls, [{ select: "d", hop: true }]);
  assert.equal(sandbox.curView(), "deferred");
});

test("a card that is not the one on screen leaving Doing moves nothing on screen", () => {
  const state = { boxes: ["a", "b", "c"].map(id => card(id)) };
  const { sandbox, calls } = logicWith(state, "c");
  sandbox.selectNextCard("a", sandbox.doingOrder(state));
  assert.deepEqual(calls, []);
});

test("no page asks for the next card without the list from before the card left", async () => {
  const pages = ["index.html", "m.html", "card-logic.js"];
  for (const name of pages) {
    const source = await readFile(path.join(ROOT, name), "utf8");
    assert.doesNotMatch(source, /selectNextCard\([^,)]*\)/, name);
  }
});
