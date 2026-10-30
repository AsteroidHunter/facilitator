// The phone's sent panel after a reading that raced a send. A reading asked
// before a send landed may not draw that card's sent panel (sendGuard in
// drawCard), but its revision is kept, so the reading after it answers nothing
// new. Two ways in: the receipt a resume reading carries lands a send made
// while the phone was away (path A), and a send landing while the resume
// reading is still out (path B). In both the reading the phone holds is the
// board's record of the card, read or answered, and the panel shows that once
// the next reading answers nothing new, not the phone's own Delivered.
//
// The board is a small fixture board (phone-board-fixture.cjs) on a free port
// pair, with an agent claiming and confirming over its real routes. The page is
// m.html's own code for readings, sends, receipts and the pass over a card,
// run in a vm with the rest of the drawing stubbed out. No browser, and port
// 8877 is never touched. Every card and message is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const vm = require("node:vm");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { boardState, startBoard } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
let outer, board, html, logic;

function between(source, start, end){
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const block = (source, start) => between(source, start, "\n}\n") + "\n}\n";
const line = (source, start) => between(source, start, "\n") + "\n";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-sent-catch-up-"));
  html = await readFile(path.join(ROOT, "m.html"), "utf8");
  logic = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const state = boardState({ cards: 6, dir: outer });
  // one card to a lane for each case, so each agent's claim is the card sent to
  const lanes = { m1: "facilitator", m2: "pastureland", m3: "tokens" };
  for (const b of state.boxes) b.owner = lanes[b.id] || "wiki";
  board = await startBoard(outer, {
    state,
    // these cases are about readings, not the typing hold (typing-hold.test.cjs),
    // so a message sent here is free to go out at once
    extraPatches: [["TYPING_HOLD = 3.5", "TYPING_HOLD = 0.0"]],
  });
});

after(async () => {
  if (board) await board.stop();
  if (outer) await rm(outer, { recursive: true, force: true });
});

async function post(route, body = ""){
  const r = await fetch(board.origin + route, { method: "POST", body });
  const answer = await r.json();
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(answer)}`);
  return answer;
}
// the lane's agent takes the card and confirms it has the messages: Read
async function agentReads(owner, box){
  const got = await (await fetch(`${board.origin}/wait?owner=${owner}&timeout=3&agent=catchup`)).json();
  assert.equal(got.box, box, `the agent took another card: ${JSON.stringify(got)}`);
  await post(`/ack?owner=${owner}&token=${got.ack}`);
}

// the page: readings, sends and receipts as m.html has them, and the pass over
// a card down to its sent panel. shown is what each card's sent panel was last
// drawn from, as [words, the mark it reads]. hold() keeps the next reading
// from reaching the board until release(), so the board builds it later than
// the page asked for it
function page(){
  const shown = {}, problems = [];
  let gate = null;
  const flags = { add(){}, remove(){}, toggle(){}, contains: () => false };
  const stored = new Map();
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, TextDecoder, AbortController, AbortSignal, crypto,
    localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
    // hidden: the page schedules no reading of its own; the test asks for each
    document: { hidden: true, getElementById: () => ({ textContent: "", classList: flags, setAttribute(){} }),
                body: { classList: flags },
                querySelector: () => ({ textContent: "", classList: flags, querySelector: () => ({ textContent: "" }) }) },
    window: {}, phoneDeveloperMode: false,
    tracePhone: () => null, endPhoneTrace(){}, phoneTraceState: () => ({}), noteDoing(){},
    validateOwners(){}, holdFlags: state => state, renderTickets(){}, syncSelectedHistory(){},
    startupTrouble(){}, startupAnswered(){}, startupRendered: async () => {}, pageMended(){},
    cardsMoving: () => false, listMoving: () => false, remoteFaded: () => false, showRemoteFade(){},
    reportProblem(kind, e){ problems.push(`${kind}: ${e && e.message}`); },
    // the rest of the pass over a card
    TURN_WAIT: "wait", turnBegin: () => null, turnGo(){}, fmt: s => s, headOnSwap(){}, histExit(){},
    readOnArrival(){}, drawerOpen: () => false, omniCardTitle: t => t, fitTitle(){}, syncOmniCard(){},
    syncAnswered(){}, liveAnswered(){}, cardState: () => "yours", cardSection: () => "",
    paintSectionChips(){}, setCardSpinner(){}, cardSpinning: () => false, syncPhoneHistory(){},
    // and of a send landing
    sentCursesRead(){}, undone(){}, schedulePhoneAdvance(){}, phoneEnterAgain: null, clearPhoneEnterAgain(){},
    letGoTitleCatch(){}, drawCreatePending(){}, drawerNote(){},
    drawSent(el, id){ shown[id] = el.sentItems.map(m => [m.text, ctx.SENT_TAGS[m.stage] || m.stage]); },
    async fetch(url, opts){
      if (url.startsWith("/m/state") && gate) await gate.held;
      return fetch(board.origin + url, opts);
    },
  });
  vm.runInContext(
    `let lastState = null, pollFails = 0, wantBox = null, validOwners = new Set(), activeOwner = "facilitator",` +
    ` selectedId = null, hist = null, browsing = false;\nconst els = {}, histCache = {};\n` +
    // the page's own apply draws every built card from the reading; that is the part this needs
    `function apply(state){ for (const b of state.boxes) if (els[b.id]) drawCard(els[b.id], b, state); }\n` +
    `function ensureCard(id){ return els[id] || null; }\n` +
    line(logic, "const RETRY_MIN_MS") + line(logic, "function backoffMs(") + line(logic, "const OP_CERTAIN_MS") +
    line(logic, "const OP_TRY_MS") + block(logic, "function newOpId(") + line(logic, "function replyFull(") +
    block(logic, "function sentFrom(") + line(logic, "const SENT_TAGS") + "globalThis.SENT_TAGS = SENT_TAGS;\n" +
    block(html, "function drawCard(") + between(html, "function syncSentPhone(", "// ---- reading the board") +
    between(html, 'const OPS_KEY = "pendops";', "// ---- sending and making") +
    between(html, "// ---- reading the board", "// waking up: the phone was locked") +
    `globalThis.probe = { poll, mintOp, runOps, els, get ops(){ return ops; }, get lastState(){ return lastState; },` +
    ` settle: async () => { while (pollRun) await pollRun; } };`,
    ctx);
  const p = ctx.probe;
  return {
    shown, problems,
    // a card built on the page, as makeBox leaves it before its first pass
    build(id){
      p.els[id] = { sentItems: [], reply: { dataset: {}, innerHTML: "" }, titleEl: { isContentEditable: false, textContent: "" },
                    box: { classList: { toggle(){} } }, meta: { textContent: "", dataset: {} }, cardSpin: {} };
    },
    // in this realm's own objects, so the strict comparisons compare contents
    held: id => JSON.parse(JSON.stringify(p.lastState.boxes.find(b => b.id === id))),
    mintOp: (kind, fields) => p.mintOp(kind, fields),
    runOps: lane => p.runOps(lane),
    ops: () => p.ops,
    hold(){ let release; gate = { held: new Promise(r => { release = r; }) }; gate.release = release; },
    release(){ const g = gate; gate = null; g.release(); },
    poll: () => p.poll(),
    async read(){ await p.poll(); await p.settle(); },
    settle: () => p.settle(),
  };
}
const mark = (p, id, text) => (p.shown[id] || []).find(([words]) => words === text)?.[1];

test("path A: a send that landed while the phone was away shows Read after the reading that follows the resume", async () => {
  const p = page();
  p.build("m1");
  await p.read();   // the page as it was before it went away
  const text = "Invented message sent before the phone was put away.";
  // the phone's own try reached the board and its answer was lost on the way
  const op = p.mintOp("send", { box: "m1", text });
  await post(`/send?box=m1&op=${op.id}`, text);
  await agentReads("facilitator", "m1");
  // the resume reading asks after the send, and its own receipt lands it
  await p.read();
  assert.equal(p.ops().length, 0, "the receipt did not land the send");
  const held = p.held("m1");
  assert.deepEqual([held.pendingTexts, held.pendingStates], [[text], ["delivered"]],
    "the reading the page holds is not the board's record with the message read");
  // the next reading finds nothing new
  await p.read();
  assert.equal(mark(p, "m1", text), "Read", `the panel was not drawn from the board's record: ${JSON.stringify(p.shown.m1)}`);
  assert.deepEqual(p.problems, []);
});

test("path B: a send that lands while the resume reading is out shows Read after the reading that follows", async () => {
  const p = page();
  p.build("m2");
  await p.read();
  const text = "Invented go ahead sent as the phone came back.";
  // the resume reading is asked, and the board is slow to answer it
  p.hold();
  const resume = p.poll();
  await pause(5);
  // the send the wake sends lands first, while that reading is still out
  p.mintOp("send", { box: "m2", text });
  p.runOps("send:m2");
  for (let i = 0; i < 200 && p.ops().length; i++) await pause(5);
  assert.equal(p.ops().length, 0, "the send did not land");
  assert.equal(mark(p, "m2", text), "Delivered");
  // the agent reads it before the board builds the reading the page asked for
  await agentReads("pastureland", "m2");
  p.release();
  await resume;
  await p.settle();
  const held = p.held("m2");
  assert.deepEqual([held.pendingTexts, held.pendingStates], [[text], ["delivered"]],
    "the reading the page holds is not the board's record with the message read");
  assert.equal(mark(p, "m2", text), "Read", `the panel was not drawn from the board's record: ${JSON.stringify(p.shown.m2)}`);
  // and it stays so on the readings after
  await p.read();
  assert.equal(mark(p, "m2", text), "Read");
  assert.deepEqual(p.problems, []);
});

test("path B: a send the agent answered before the racing reading was built goes from the sent panel on the reading that follows", async () => {
  const p = page();
  p.build("m3");
  await p.read();
  const text = "Invented message the agent answers at once.";
  p.hold();
  const resume = p.poll();
  await pause(5);
  p.mintOp("send", { box: "m3", text });
  p.runOps("send:m3");
  for (let i = 0; i < 200 && p.ops().length; i++) await pause(5);
  assert.equal(p.ops().length, 0, "the send did not land");
  await agentReads("tokens", "m3");
  await post("/reply?box=m3", "Invented answer to it.");
  p.release();
  await resume;
  await p.settle();
  assert.deepEqual(p.held("m3").pendingTexts, [], "the reading the page holds does not have the message answered");
  assert.equal(mark(p, "m3", text), undefined, `an answered message stayed in the sent panel: ${JSON.stringify(p.shown.m3)}`);
  assert.deepEqual(p.problems, []);
});
