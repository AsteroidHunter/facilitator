// Node-only: the phone's own sending loop, run from m.html's real code on a
// faked clock, with the network and the drawing as doubles. What is pinned: a
// send is tried again on its own for 15 minutes from the press and never after,
// across a reload too; past that it wears the red mark (not delivered) with its
// words kept; the arrow sends it again under the same operation id, so the
// board can never land it twice; and a send the board has confirmed is never
// marked as not delivered.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const PHONE = read("m.html");
const LOGIC = read("card-logic.js");
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const block = (source, start) => between(source, start, "\n}\n") + "\n}\n";
const line = (source, start) => between(source, start, "\n") + "\n";
const MINUTE = 60 * 1000;

function phone(kept = []) {
  let now = 1_800_000_000_000;
  const stored = new Map([["pendops", JSON.stringify(kept)]]);
  const timers = new Map();
  let timer = 0;
  const sent = [], landed = [], drawn = [];
  let answer = () => { throw new TypeError("Load failed"); };   // the board out of reach
  const ctx = vm.createContext({
    Date: { now: () => now },
    localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v) },
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; },
    clearTimeout: id => timers.delete(id),
    AbortSignal: { timeout: () => undefined },
    crypto: { randomUUID: () => "minted-" + (++timer) },
    async fetch(url, init) { sent.push({ url, body: init && init.body }); return answer(url); },
    document: { getElementById: () => ({ classList: { toggle() {} }, setAttribute() {} }) },
    tracePhone() { return null; }, endPhoneTrace() {}, phoneTraceState: () => ({}), askReceipt: async () => null,
    phoneEnterAgain: null, clearPhoneEnterAgain() {}, letGoTitleCatch() {}, drawerNote() {},
    lastRev: null, poll() {},
    els: { 1: { sentItems: [] } },
  });
  vm.runInContext(line(LOGIC, "const RETRY_MIN_MS") + block(LOGIC, "function backoffMs(") +
    line(LOGIC, "const OP_CERTAIN_MS") + line(LOGIC, "const OP_TRY_MS") + block(LOGIC, "function newOpId("), ctx);
  vm.runInContext(block(PHONE, "function sentOf(") + block(PHONE, "function opBadge(") +
    between(PHONE, "function resendOp(", "// a new answer that waited"), ctx);
  vm.runInContext(between(PHONE, 'const OPS_KEY = "pendops";', "// ---- sending and making"), ctx);
  // what the card shows: the rows drawn for its unsent messages, and the
  // messages that moved to the confirmed ones
  ctx.drawSent = (el, id) => drawn.push(ctx.sentOf(el, id).map(r => ({ text: r.text, op: r.op, badge: r.badge })));
  ctx.landSend = op => landed.push(op.id);
  const ops = () => vm.runInContext("ops", ctx);
  return {
    ctx, sent, landed, drawn, ops, timers,
    stored: () => JSON.parse(stored.get("pendops") || "[]"),
    answerWith(fn) { answer = fn; },
    tick(ms) { now += ms; },
    now: () => now,
    // the loop working one card's sends, to its end or to its next sleep
    async settle() {
      for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve));
    },
    // the sleep between two tries ends
    async wake() {
      for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
      await this.settle();
    },
  };
}
const ok = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const opOf = url => new URLSearchParams(url.split("?")[1]).get("op");

test("the phone tries a send on its own for 15 minutes, not half a day", () => {
  assert.match(PHONE, /const OP_GIVE_UP_MS = 15 \* 60 \* 1000;/);
  assert.doesNotMatch(PHONE, /12 \* 3600 \* 1000/);
});

test("a send kept across a reload and pressed more than 15 minutes ago is not sent again on its own and shows not delivered, words kept", async () => {
  const pressed = 1_800_000_000_000 - 15 * MINUTE - 1000;
  const p = phone([{ id: "kept-old-1", kind: "send", box: "1", text: "Meant a while ago", ts: pressed,
    tries: 4, waiting: true, asked: 0, state: "pending" }]);
  p.ctx.loadOps();
  p.ctx.wakeOps();
  await p.settle();
  assert.equal(p.sent.length, 0, "a send went out after the 15 minutes");
  const [op] = p.ops();
  assert.equal(op.state, "unsure");
  assert.equal(p.ctx.opBadge(op), "fail", "the row does not wear the red mark");
  assert.deepEqual(p.drawn.at(-1), [{ text: "Meant a while ago", op: "kept-old-1", badge: "fail" }]);
  assert.deepEqual(p.stored().map(o => [o.id, o.state, o.text, o.ts]), [["kept-old-1", "unsure", "Meant a while ago", pressed]],
    "the words or the press time were not kept for the next reload");
  // nothing more goes out however long the phone stays open
  p.tick(30 * MINUTE);
  p.ctx.wakeOps();
  await p.wake();
  assert.equal(p.sent.length, 0);
});

test("a send the board does not answer is tried again until 15 minutes after the press, then stops and shows not delivered", async () => {
  const p = phone();
  const op = p.ctx.mintOp("send", { box: "1", text: "Hello board" });
  p.ctx.runOps("send:1");
  await p.settle();
  assert.equal(p.sent.length, 1, "the first try did not go out");
  assert.equal(p.ctx.opBadge(op), "ring", "a send being tried again on its own wears the ring");
  // still inside the window: the next try goes out under the same id
  p.tick(14 * MINUTE);
  await p.wake();
  assert.equal(p.sent.length, 2);
  assert.equal(op.state, "pending");
  // past the window: the loop stops before another try
  p.tick(MINUTE + 1000);
  await p.wake();
  assert.equal(p.sent.length, 2, "a try went out after the 15 minutes");
  assert.equal(op.state, "unsure");
  assert.equal(p.ctx.opBadge(op), "fail");
  assert.equal(p.timers.size, 0, "the loop is still sleeping toward another try");
  assert.ok(p.sent.every(s => opOf(s.url) === op.id && s.body === "Hello board"));
});

test("the arrow on a send that is not delivered sends it again under the same operation id, and it lands once", async () => {
  const p = phone([{ id: "kept-old-2", kind: "send", box: "1", text: "Try me again",
    ts: 1_800_000_000_000 - 40 * MINUTE, tries: 9, waiting: false, asked: 0, state: "unsure" }]);
  p.ctx.loadOps();
  const [op] = p.ops();
  assert.equal(p.ctx.opBadge(op), "fail");
  p.answerWith(ok);
  p.ctx.sentMarkAct(p.ctx.els[1], "kept-old-2", "retry");
  await p.settle();
  assert.equal(p.sent.length, 1, "the arrow did not send it, or sent it more than once");
  assert.equal(opOf(p.sent[0].url), "kept-old-2", "the arrow sent it under a new id");
  assert.equal(p.sent[0].body, "Try me again");
  assert.deepEqual(p.landed, ["kept-old-2"]);
  assert.equal(p.ops().length, 0);
  assert.deepEqual(p.stored(), []);
});

test("the arrow starts a fresh 15 minutes of tries, and they stop again after it", async () => {
  const p = phone([{ id: "kept-old-3", kind: "send", box: "1", text: "Still out of reach",
    ts: 1_800_000_000_000 - 40 * MINUTE, tries: 9, waiting: false, asked: 0, state: "unsure" }]);
  p.ctx.loadOps();
  const [op] = p.ops();
  p.ctx.resendOp(op);
  await p.settle();
  assert.equal(p.sent.length, 1);
  assert.equal(op.state, "pending");
  p.tick(15 * MINUTE + 1000);
  await p.wake();
  assert.equal(op.state, "unsure");
  assert.equal(p.sent.length, 1);
  assert.ok(p.sent.every(s => opOf(s.url) === "kept-old-3"));
});

test("a send the board has confirmed is never marked not delivered, even past the 15 minutes", async () => {
  // its answer was lost and the phone was closed past the window: the first
  // reading after the reload brings the board's receipt before any loop runs
  const p = phone([{ id: "kept-landed", kind: "send", box: "1", text: "It got there",
    ts: 1_800_000_000_000 - 20 * MINUTE, tries: 2, waiting: true, asked: 0, state: "pending" }]);
  p.ctx.loadOps();
  p.ctx.reconcileOps({ "kept-landed": { status: "applied", result: { rev: 3 } } });
  p.ctx.wakeOps();
  await p.settle();
  assert.deepEqual(p.landed, ["kept-landed"]);
  assert.equal(p.ops().length, 0);
  assert.equal(p.sent.length, 0);
  assert.ok(p.drawn.flat().every(r => r.badge !== "fail"), "a confirmed send wore the red mark");
  // and one confirmed on a try inside the window is gone before the window ends
  const q = phone();
  q.answerWith(ok);
  const op = q.ctx.mintOp("send", { box: "1", text: "Straight through" });
  q.ctx.runOps("send:1");
  await q.settle();
  q.tick(16 * MINUTE);
  q.ctx.markUnsure(op, "late");
  q.ctx.wakeOps();
  await q.settle();
  assert.deepEqual(q.landed, [op.id]);
  assert.equal(op.state, "applied");
  assert.equal(q.ops().length, 0);
});
