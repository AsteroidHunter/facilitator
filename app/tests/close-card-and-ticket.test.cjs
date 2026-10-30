// The cross takes the card off the screen and its ticket out of the list in the
// same turn (closeCardNow in card-logic.js), before the board has answered, and a
// close the board refuses puts the ticket back with the reason on the card. Run
// against card-logic.js alone, with no browser or board: the list is what the
// page would draw from the reading it holds.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const source = name => readFileSync(path.join(ROOT, name), "utf8");

function node() {
  const classes = new Set(), attrs = new Map();
  return { style: {}, dataset: {}, textContent: "",
    classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
    getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    addEventListener() {}, getBoundingClientRect: () => ({ width: 300 }) };
}
const card = (id, extra) => ({ id, owner: "lane", bucket: "meta", state: "yours", replies: 1, agentTs: 1,
  ts: 1, ball: "you", done: false, parked: false, docked: false, pending: 0, ...extra });

// a page holding three Doing cards, listed a, b, c (the oldest turn first), with b on screen. every request is held until
// the test answers it; drawn is the Doing list as the page last drew it
function page() {
  const requests = [], picked = [], store = new Map();
  const ctx = vm.createContext({ Date, console, AbortSignal: { timeout: () => undefined },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    document: { getElementById: () => node(), createElement: node, body: node() },
    localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
    window: {}, matchMedia: () => ({ matches: false }), getComputedStyle: () => ({}),
    els: {}, activeOwner: "lane", selectedId: "b", polls: 0, drawn: [],
    lastState: { boxes: [card("a", { agentTs: 1 }), card("b", { agentTs: 2 }), card("c", { agentTs: 3 })],
                 now: Date.now() / 1000, fetchedAt: Date.now() },
    fetch: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
  });
  vm.runInContext(source("card-logic.js"), ctx);
  for (const id of ["a", "b", "c"]) ctx.els[id] = { box: node(), metaNote: node() };
  ctx.apply = state => { ctx.drawn = ctx.viewPoolFor(state, "todo").map(b => b.id); ctx.shownOnly = vm.runInContext("tikShownOnly", ctx); };
  ctx.poll = () => { ctx.polls++; };
  ctx.select = (id, opts) => { picked.push([id, !!(opts && opts.hop)]); ctx.selectedId = id; };
  ctx.deselect = () => { picked.push([null, false]); ctx.selectedId = null; };
  ctx.apply(ctx.lastState);
  const close = id => ctx.closeCardNow(id, cardId => ctx.fetch(ctx.closeCardUrl(cardId), { method: "POST" }));
  return { ctx, requests, picked, close };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("the cross takes the ticket out of the list in the same turn as the card, before the board answers", async () => {
  const { ctx, requests, picked, close } = page();
  assert.deepEqual([...ctx.drawn], ["a", "b", "c"]);
  const closing = close("b");
  // nothing has answered yet: one close is out, and the card and its ticket have both gone
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url, "http://fixture");
  assert.equal(url.pathname, "/close");
  assert.equal(url.searchParams.get("box"), "b");
  assert.ok(url.searchParams.get("sid") && Number(url.searchParams.get("seq")) > 0);
  assert.deepEqual([...ctx.drawn], ["a", "c"], "the ticket waited for the board");
  assert.equal(ctx.shownOnly, true, "the press drew the sections off screen as well");
  assert.equal(vm.runInContext("tikShownOnly", ctx), false);
  assert.deepEqual(picked, [["c", true]], "the card did not hop to the one below it");
  assert.equal(ctx.els.b.box.classList.contains("done"), true);

  // a reading asked before the board answered still has the card open, and may not bring the ticket back
  const early = { boxes: [card("a", { agentTs: 1 }), card("b", { agentTs: 2 }), card("c", { agentTs: 3 })],
                  now: Date.now() / 1000, fetchedAt: Date.now() };
  ctx.apply(ctx.holdFlags(early));
  assert.deepEqual([...ctx.drawn], ["a", "c"]);

  requests[0].resolve(answer(200, { ok: true, action: "done" }));
  await closing;
  await settle();
  assert.deepEqual([...ctx.drawn], ["a", "c"]);
  assert.equal(ctx.els.b.metaNote.textContent, "");
  assert.ok(ctx.polls >= 1, "the board was not read after it answered");
  // the reading after the answer agrees, and the hold ends there
  const later = { boxes: [card("a", { agentTs: 1 }), card("b", { agentTs: 2, done: true, state: "done" }), card("c", { agentTs: 3 })],
                  now: Date.now() / 1000, fetchedAt: Date.now() + 1 };
  ctx.apply(ctx.holdFlags(later));
  assert.deepEqual([...ctx.drawn], ["a", "c"]);
  assert.equal(vm.runInContext("Object.keys(flagHolds).length", ctx), 0);
});

test("a close the board refuses puts the ticket back in the list with the reason on the card", async () => {
  const { ctx, requests, close } = page();
  const closing = close("b");
  assert.deepEqual([...ctx.drawn], ["a", "c"]);
  requests[0].resolve(answer(500, { error: "the board could not save" }));
  await closing;
  await settle();
  assert.deepEqual([...ctx.drawn], ["a", "b", "c"], "the refused close left the ticket out of the list");
  assert.equal(ctx.lastState.boxes.find(b => b.id === "b").done, false);
  assert.equal(ctx.els.b.box.classList.contains("done"), false);
  assert.match(ctx.els.b.metaNote.textContent, /done failed \(500\): try again/);
  assert.equal(vm.runInContext("Object.keys(flagHolds).length", ctx), 0);
});

test("the Mac board's cross and done keys and the phone's cross all close through closeCardNow", () => {
  const index = source("index.html"), phone = source("m.html");
  assert.match(index, /function boardCloseCard\(id\)\{\n  return closeCardNow\(id, card => fetch\(closeCardUrl\(card\), \{ method: "POST" \}\)\);/);
  assert.match(index, /if \(chipOff\(x\)\) return;[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*boardCloseCard\(b\.id\);/);
  assert.match(phone, /function closeCard\(id\)\{\n  return closeCardNow\(id, card => fetch\(closeCardUrl\(card\), \{ method: "POST" \}\)\);/);
});
