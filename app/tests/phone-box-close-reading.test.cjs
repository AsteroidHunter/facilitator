// The phone's cross on a magic box, and the lean reading after it. The page
// keeps every card as the board sent it and builds on those, so a close that
// writes into the kept card makes the page hold a shut box that the board never
// sends again while the card reads the same: the close that never landed, or
// the box opened again before the phone's next reading, and Control + Shift +
// period only dips the card from then on.
//
// The page is m.html's own reading code (the block from "reading the board" up
// to resume()) and its own phoneMagicClose, run in a vm with the drawing
// stubbed out, reading the fixture board (phone-board-fixture.cjs) over real
// sockets. No browser, and port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const http = require("node:http");
const vm = require("node:vm");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { boardState, startBoard } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
let outer, board, html, card, other;

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-box-close-"));
  html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const state = boardState({ cards: 40, seed: 1223, dir: outer });
  const open = state.boxes.filter(b => b.owner === "facilitator" && !b.done && !b.parked);
  [card, other] = open.map(b => b.id);
  board = await startBoard(outer, { state });
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

const boardMagic = async id => (await (await fetch(board.origin + "/m/state?since=")).json())
  .boxes.find(b => b.id === id).magic;

// the page's reading and its cross. lose: the cross's close never reaches the
// board, as on a radio that dropped it
function page(){
  const block = html.slice(html.indexOf("// ---- reading the board"), html.indexOf("// waking up: the phone was locked"));
  const close = html.slice(html.indexOf("function phoneMagicClose(){"));
  const flags = { add(){}, remove(){}, toggle(){}, contains: () => false };
  // whatever element the reading code reaches for: every method a no-op
  const element = () => new Proxy(function(){}, {
    get: (_, k) => k === "classList" ? flags : element(), set: () => true, apply: () => element(),
  });
  const state = { lose: false };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, TextDecoder, AbortController, AbortSignal,
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    // hidden: the page schedules no reading of its own; the test asks for each
    document: { hidden: true, getElementById: () => element(), querySelector: () => element(), body: { classList: flags } },
    window: {}, phoneDeveloperMode: false,
    tracePhone: () => ({}), endPhoneTrace(){}, noteDoing(){}, askIds: () => [], reconcileOps(){},
    validateOwners(){}, holdFlags: s => s, apply(){}, renderTickets(){}, syncSelectedHistory(){},
    startupTrouble(){}, startupAnswered(){}, startupRendered: async () => {}, pageMended(){}, wakeOps(){},
    phoneMagicOff(){},
    reportProblem(kind, e){ throw e; },
    async fetch(url, opts = {}){
      const target = new URL(url, board.origin);
      if (target.pathname === "/magic/close"){
        if (state.lose) throw new TypeError("Load failed");
        return fetch(target, { method: "POST" });
      }
      const res = await new Promise((resolve, reject) => http.get(target, resolve).on("error", reject));
      const chunks = [];
      for await (const c of res) chunks.push(c);
      return new Response(Buffer.concat(chunks), { status: res.statusCode, headers: { "Content-Type": "application/json" } });
    },
  });
  vm.runInContext(
    `let lastState = null, pollFails = 0, wantBox = null, validOwners = new Set(), activeOwner = "facilitator",` +
    ` selectedId = null, opsStarted = true;\nconst PB = { id: null };\n${block}\n` +
    `${close.slice(0, close.indexOf("\n}\n") + 2)}\n` +
    `globalThis.probe = { poll, phoneMagicClose, PB, settle: async () => { while (pollRun) await pollRun; },` +
    ` get lastState(){ return lastState; } };`,
    ctx);
  const p = ctx.probe;
  return {
    state,
    magic: id => JSON.parse(JSON.stringify(p.lastState.boxes.find(b => b.id === id).magic ?? null)),
    async read(){ await p.poll(); await p.settle(); },
    // the cross on the box the phone has drawn, and the close it sends let land
    async cross(id){ p.PB.id = id; p.phoneMagicClose(); await new Promise(r => setTimeout(r, 300)); await p.settle(); },
  };
}

const fill = n => post(`/magic?box=${card}&kind=markdown&title=Runbook%20audit`, `# Runbook audit ${n}\n\n- one`);

test("the phone's cross with its close lost: the next reading brings the board's open box back", async () => {
  await fill(1);
  const p = page();
  await p.read();
  assert.equal(p.magic(card).open, true);
  p.state.lose = true;
  await p.cross(card);
  p.state.lose = false;
  assert.equal(p.magic(card).open, false, "the cross did not shut the box on the page");
  assert.equal((await boardMagic(card)).open, true, "the lost close reached the board");
  // another card changes, so the reading is lean and this card is not in it
  await post(`/title?box=${other}`, "Something else on the board");
  await p.read();
  assert.deepEqual(p.magic(card), await boardMagic(card),
    "the phone holds a shut box the board has open, so the key only dips the card");
});

test("the phone's cross, then the box opened again before the phone reads: the phone has it open", async () => {
  await fill(2);
  const p = page();
  await p.read();
  // the close lands, but the phone does not read before the agent's reopen
  p.state.lose = true;
  await p.cross(card);
  p.state.lose = false;
  await post(`/magic/close?box=${card}`);
  await post(`/magic/reopen?box=${card}`);
  await p.read();
  assert.deepEqual(p.magic(card), await boardMagic(card),
    "the phone holds a shut box the board has open, so the key only dips the card");
  // and a box shut on the board and read shut still reads shut
  await post(`/magic/close?box=${card}`);
  await p.read();
  assert.equal(p.magic(card).open, false);
});
