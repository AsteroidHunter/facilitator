// The phone's board reading, lean. A page holding a reading this server run
// made is sent only the cards that changed since it, the answer is gzip
// compressed when the page takes gzip, and a download that keeps arriving is
// waited for rather than cut off by one clock for the whole of it.
//
// The board is the ~700 card fixture (phone-board-fixture.cjs) on a free port
// pair. The page is m.html's own reading code, the block from "reading the
// board" up to resume(), run in a vm with the drawing stubbed out and reading
// that board over real sockets, so what is checked is the board the page would
// draw: after every change it must equal a whole reading taken at the same
// revision. Three fixture patches: PHONE_KEPT is cut to four, a title of
// "Moved to the end" moves its card to the end of the board (no route moves a
// card today; this is the fallback's only way in), and card m1 carries the
// words of a probe file while it exists, which is a card reading two ways at
// one revision with no save between, the way a heartbeat going quiet does it.
// No browser, and port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const http = require("node:http");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { boardState, startBoard } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const KEPT = 4;
const GZ = { "Accept-Encoding": "gzip, deflate, br" };   // what Safari sends

let outer, board, html, cards;

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-lean-"));
  html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const state = boardState({ dir: outer });
  // a lane with no cards yet, so a card made in it is the board's first
  state.projects.push({ id: "spare", name: "spare", dir: path.join(outer, "spare") });
  cards = state.boxes.length;
  board = await startBoard(outer, {
    state,
    extraPatches: [
      ["PHONE_KEPT = 32", `PHONE_KEPT = ${KEPT}`],
      [`            box["title"] = _entered_title(box.get("owner", "facilitator"), text)\n        _log("title", bid, box["title"])`,
       `            box["title"] = _entered_title(box.get("owner", "facilitator"), text)\n` +
       `        if box["title"] == "Moved to the end":\n` +
       `            _state["boxes"].remove(box)\n` +
       `            _state["boxes"].append(box)\n` +
       `        _log("title", bid, box["title"])`],
      [`        "creased": bool(b.get("creased", False)),\n    }\n\n\ndef _live_section`,
       `        "creased": bool(b.get("creased", False)),\n` +
       `        "probe": (HERE / "probe.txt").read_text() if b["id"] == "m1" and (HERE / "probe.txt").exists() else "",\n` +
       `    }\n\n\ndef _live_section`],
    ],
  });
});

after(async () => {
  if (board) await board.stop();
  if (outer) await rm(outer, { recursive: true, force: true });
});

// one answer off the board, with the headers asked for and nothing added, as
// the bytes that came and the reading they decode to
function get(route, headers = {}){
  return new Promise((resolve, reject) => {
    http.get(board.origin + route, { headers }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const text = (res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, bytes: raw.length, body: JSON.parse(text) });
      });
    }).on("error", reject);
  });
}

async function post(route, body = ""){
  const r = await fetch(board.origin + route, { method: "POST", body });
  const answer = await r.json();
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(answer)}`);
  return answer;
}

const whole = async () => (await get("/m/state?since=", GZ)).body;
// a value made in the vm, in this realm's own objects, so the strict
// comparisons below compare contents and not which realm made them
const plain = value => JSON.parse(JSON.stringify(value));

// the page's mergeReading on its own
function pageMerge(){
  const ctx = vm.createContext({});
  vm.runInContext(html.slice(html.indexOf("function mergeReading("), html.indexOf("// the fetch and the render each get")), ctx);
  return ctx.mergeReading;
}

// the page's reading code, reading the fixture board. legacy plays a board from
// before this change: it never hears delta and never says epoch, and answers
// whole, as the old server did. serve(fn) answers the next reading with fn's
// Response instead of the board's
function page({ legacy = false, patches = [] } = {}){
  let block = html.slice(html.indexOf("// ---- reading the board"), html.indexOf("// waking up: the phone was locked"));
  for (const [from, to] of patches){
    const out = block.replace(from, to);
    assert.notEqual(out, block, `page patch did not apply: ${from}`);
    block = out;
  }
  const asked = [], answers = [], problems = [];
  let next = null;
  const flags = { add(){}, remove(){}, toggle(){} };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, TextDecoder, AbortController, AbortSignal,
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    // hidden: the page schedules no reading of its own; the test asks for each
    document: { hidden: true, getElementById: () => ({ textContent: "", classList: flags }), body: { classList: flags } },
    window: {},
    tracePhone: () => ({}), endPhoneTrace(){}, noteDoing(){}, askIds: () => [], reconcileOps(){},
    validateOwners(){}, holdFlags: state => state, apply(){}, renderTickets(){}, syncSelectedHistory(){},
    startupTrouble(){}, startupAnswered(){}, startupRendered: async () => {}, wakeOps(){},
    cardsMoving: () => false, stampText: () => "",
    reportProblem(kind, e){ problems.push(e.message); },
    async fetch(url, opts = {}){
      const target = new URL(url, board.origin);
      asked.push(target.search);
      if (next){ const fn = next; next = null; return fn(opts); }
      if (legacy) target.searchParams.delete("delta");
      const res = await new Promise((resolve, reject) => {
        const req = http.get(target, { headers: GZ }, resolve).on("error", reject);
        opts.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")));
      });
      const chunks = [];
      for await (const c of res) chunks.push(c);
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(raw) : raw).toString("utf8"));
      if (legacy) delete body.epoch;
      answers.push({ changed: body.changed, lean: body.delta != null, cards: (body.boxes || []).map(b => b.id),
                     gone: body.gone, after: body.after, ids: Array.isArray(body.ids), bytes: raw.length,
                     encoding: res.headers["content-encoding"] || "none" });
      return new Response(JSON.stringify(body), { status: res.statusCode, headers: { "Content-Type": "application/json" } });
    },
  });
  vm.runInContext(
    `let lastState = null, pollFails = 0, wantBox = null, validOwners = new Set(), activeOwner = "facilitator",` +
    ` selectedId = null, opsStarted = true;\n${block}\n` +
    `globalThis.probe = { poll, settle: async () => { while (pollRun) await pollRun; },` +
    ` get lastState(){ return lastState; }, get lastRev(){ return lastRev; }, get pollFails(){ return pollFails; } };`,
    ctx);
  const p = ctx.probe;
  return {
    asked, answers, problems,
    serve(fn){ next = fn; },
    get lastState(){ return p.lastState; }, get lastRev(){ return p.lastRev; }, get pollFails(){ return p.pollFails; },
    async read(){ await p.poll(); await p.settle(); return answers.at(-1); },
  };
}

// the page's board against a whole reading at the same revision
async function sameAsWhole(p, label){
  const w = await whole();
  assert.equal(p.lastRev, w.rev, `${label}: the page holds another revision`);
  assert.deepEqual(plain(p.lastState.boxes), w.boxes, `${label}: the page's board is not the board`);
  assert.equal(p.lastState.title, w.title, label);
  assert.deepEqual(plain(p.lastState.tabs), w.tabs, label);
  assert.deepEqual(plain(p.lastState.pwds), w.pwds, label);
  for (const k of ["epoch", "delta", "gone", "after", "ids", "count"])
    assert.equal(k in p.lastState, false, `${label}: the reading's own ${k} was kept as board`);
}

test("a page that names no delta gets every card as before, compressed only when it takes gzip", async () => {
  const plain = await get("/m/state?since=");
  assert.equal(plain.status, 200);
  assert.equal(plain.headers["content-encoding"], undefined, "an answer was compressed for a caller that took no gzip");
  assert.equal(plain.body.changed, true);
  assert.equal(plain.body.boxes.length, cards);
  assert.equal(plain.body.delta, undefined);
  assert.equal(typeof plain.body.epoch, "string");
  const packed = await get("/m/state?since=", GZ);
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.match(packed.headers.vary || "", /accept-encoding/i);
  assert.deepEqual(packed.body.boxes, plain.body.boxes, "the compressed reading is not the same reading");
  assert.ok(packed.bytes * 3 < plain.bytes, `compressed ${packed.bytes} of ${plain.bytes} bytes`);
  // a page holding a revision that names no delta, which is every page open
  // before this change: a change still brings the whole board
  await post("/title?box=m5", "Renamed with no delta named");
  const older = await get(`/m/state?since=${plain.body.rev}`, GZ);
  assert.equal(older.body.changed, true);
  assert.equal(older.body.delta, undefined);
  assert.equal(older.body.boxes.length, cards);
  assert.equal(older.body.boxes.find(b => b.id === "m5").title, "Renamed with no delta named");
  // nothing new is still the short answer, and small enough to be worth squeezing
  const still = await get(`/m/state?since=${older.body.rev}&delta=${older.body.epoch}`, GZ);
  assert.equal(still.body.changed, false);
  assert.equal(still.body.boxes, undefined);
  assert.equal(still.body.epoch, undefined);
  assert.ok(still.bytes < 400, `an unchanged reading took ${still.bytes} bytes`);
  for (const [accept, gzip] of [["gzip;q=0", false], ["br", false], ["identity", false], ["*", true],
                                ["br, gzip;q=0.5", true], ["*, gzip;q=0", false], ["GZIP", true]]){
    const r = await get("/m/state?since=", { "Accept-Encoding": accept });
    assert.equal(r.headers["content-encoding"] === "gzip", gzip, `Accept-Encoding: ${accept}`);
  }
});

test("the page takes only the changed cards and draws the board a whole reading would", async () => {
  const p = page();
  const first = await p.read();
  assert.equal(first.lean, false, "the first reading was not whole");
  assert.equal(first.encoding, "gzip");
  await sameAsWhole(p, "first reading");
  assert.equal((await p.read()).changed, false);
  const start = p.lastState.boxes;
  const open = start.filter(b => !b.done && !b.parked && b.owner === "facilitator").map(b => b.id);
  const step = async (label, change, expect) => {
    await change();
    const got = await p.read();
    assert.equal(got.lean, true, `${label}: not a lean reading`);
    assert.equal(got.encoding, "gzip", label);
    await sameAsWhole(p, label);
    expect(got);
    return got;
  };
  // the byte ceilings below are far under a whole board (about 210 KB
  // compressed) and loose on purpose: a card's words come from the docs, so
  // its exact size moves when they do
  await step("one card renamed", () => post("/title?box=m650", "Renamed on the phone test"), got => {
    assert.deepEqual(got.cards, ["m650"]);
    assert.ok(got.bytes < 4000, `a one card change took ${got.bytes} bytes`);
  });
  await step("a message sent", () => post("/send?box=m651&op=lean-send-0001", "A message to one card"), got => {
    assert.deepEqual(got.cards, ["m651"]);
  });
  let made;
  await step("a new card", async () => { made = await post("/create?owner=facilitator&op=lean-make-0001", ""); }, got => {
    assert.deepEqual(got.cards, [made.id]);
    assert.equal(typeof got.after[made.id], "string", "the new card came without its place");
    assert.equal(got.ids, false);
    assert.ok(got.bytes < 4000, `a new card took ${got.bytes} bytes`);
  });
  const three = [];
  await step("three new cards, two of them one after the other", async () => {
    for (const owner of ["wiki", "wiki", "tokens"]) three.push((await post(`/create?owner=${owner}`, "")).id);
  }, got => {
    assert.deepEqual([...got.cards].sort(), [...three].sort());
    assert.equal(got.after[three[1]], three[0], "the second wiki card was not placed after the first");
  });
  await step("a card in an empty lane, first on the board", async () => {
    three.push((await post("/create?owner=spare", "")).id);
  }, got => {
    assert.equal(got.after[three.at(-1)], "");
  });
  await step("a card done", () => post(`/done?box=${open[0]}&v=1`), got => assert.deepEqual(got.cards, [open[0]]));
  await step("a card parked", () => post(`/park?box=${open[1]}&v=1`), got => assert.deepEqual(got.cards, [open[1]]));
  await step("an empty card closed away", () => post(`/close?box=${made.id}`), got => {
    assert.deepEqual(got.gone, [made.id]);
    assert.deepEqual(got.cards, []);
  });
  await step("a card moved", () => post("/title?box=m100", "Moved to the end"), got => {
    assert.equal(got.ids, true, "a moved card came without the whole order");
    assert.deepEqual(got.cards, ["m100"]);
  });
  assert.equal(p.lastState.boxes.at(-1).id, "m100");
  assert.deepEqual(p.problems, []);
  assert.equal(p.pollFails, 0);
  assert.ok(p.asked.slice(1).every(s => /since=\d+/.test(s) && /delta=[0-9a-f]+/.test(s)),
    "a reading after the first did not name the reading it held");
});

test("a page on a board from before this change reads whole boards and never names delta", async () => {
  const p = page({ legacy: true });
  await p.read();
  await sameAsWhole(p, "first reading");
  await post("/title?box=m7", "Renamed for the older board");
  const got = await p.read();
  assert.equal(got.lean, false);
  assert.equal(got.cards.length, (await whole()).boxes.length, "the older board's answer was not the whole board");
  await sameAsWhole(p, "after a change");
  assert.ok(p.asked.every(s => !/delta=/.test(s)), "the page asked an older board for delta");
  assert.deepEqual(p.problems, []);
});

test("a reading from another run, or one the board no longer remembers, is answered whole", async () => {
  const held = await whole();
  await post("/title?box=m8", "Changed once");
  const other = await get(`/m/state?since=${held.rev}&delta=0a1b2c3d`, GZ);
  assert.equal(other.body.delta, undefined, "a reading from another run was built on");
  assert.equal(other.body.boxes.length, held.boxes.length);
  const same = await get(`/m/state?since=${held.rev}&delta=${held.epoch}`, GZ);
  assert.equal(same.body.delta, held.rev);
  assert.deepEqual(same.body.boxes.map(b => b.id), ["m8"]);
  for (let n = 0; n < KEPT; n++){
    await post("/title?box=m9", `Changed again ${n}`);
    await whole();
  }
  const forgotten = await get(`/m/state?since=${held.rev}&delta=${held.epoch}`, GZ);
  assert.equal(forgotten.body.delta, undefined, "a reading past PHONE_KEPT was still built on");
  assert.equal(forgotten.body.boxes.length, held.boxes.length);
});

test("the page's rebuild hands out fresh cards and refuses a reading that does not fit", () => {
  const merge = pageMerge();
  const card = (id, title) => ({ id, title, done: false });
  const first = merge(null, { rev: 1, epoch: "e1", boxes: [card("a", "A"), card("b", "B"), card("c", "C")] });
  assert.deepEqual(plain(first.order), ["a", "b", "c"]);
  assert.notEqual(first.boxes[0], first.cards.get("a"), "the page was handed the kept card itself");
  first.boxes[0].done = true;   // what holdFlags does to a held card
  assert.equal(first.cards.get("a").done, false, "a write into the page's card reached the kept one");
  const lean = { rev: 2, epoch: "e1", delta: 1, count: 3, boxes: [card("b", "B2"), card("d", "D")], gone: ["c"], after: { d: "a" } };
  const second = merge(first, lean);
  assert.deepEqual(plain(second.order), ["a", "d", "b"]);
  assert.deepEqual(plain(second.boxes.map(b => b.title)), ["A", "D", "B2"]);
  assert.equal(second.cards.get("a"), first.cards.get("a"), "an unchanged card was not kept as it came");
  assert.deepEqual(plain(merge(second, { rev: 3, epoch: "e1", delta: 2, count: 3, boxes: [], ids: ["b", "a", "d"] }).order),
    ["b", "a", "d"]);
  // readings that do not fit: another base, another run, a wrong count, a
  // place after a card the page does not hold
  assert.equal(merge(second, { ...lean, rev: 3, delta: 1 }), null);
  assert.equal(merge(second, { rev: 3, epoch: "e2", delta: 2, count: 3, boxes: [] }), null);
  assert.equal(merge(second, { rev: 3, epoch: "e1", delta: 2, count: 4, boxes: [] }), null);
  assert.equal(merge(second, { rev: 3, epoch: "e1", delta: 2, count: 4, boxes: [card("e", "E")], after: { e: "zz" } }), null);
  assert.equal(merge(null, lean), null);
  // a whole reading from a board that does not say epoch, or with an id twice,
  // is drawn and never built on
  assert.equal(merge(null, { rev: 1, boxes: [card("a", "A")] }).epoch, null);
  assert.equal(merge(null, { rev: 1, epoch: "e1", boxes: [card("a", "A"), card("a", "A")] }).epoch, null);
});

test("a reading that keeps arriving is waited for, and one that stops is given up", async () => {
  const p = page({ patches: [["POLL_DEADLINE_MS = 8000", "POLL_DEADLINE_MS = 300"],
                             ["const POLL_STALL_MS = 8000;", "const POLL_STALL_MS = 300;"]] });
  const text = JSON.stringify(await whole());
  const bytes = new TextEncoder().encode(text);
  // a body that ends with an error when the fetch is called off, as a
  // browser's does
  const body = (opts, source) => new Response(new ReadableStream({
    start(c){ opts.signal?.addEventListener("abort", () => c.error(new Error("aborted"))); },
    ...source,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  // the whole board in twelve pieces 100 ms apart: 1.2 s in all, four times
  // either clock, and never 300 ms without a piece
  p.serve(opts => {
    let at = 0;
    const size = Math.ceil(bytes.length / 12);
    return body(opts, {
      async pull(c){
        await new Promise(r => setTimeout(r, 100));
        if (at >= bytes.length) return c.close();
        c.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    });
  });
  const began = Date.now();
  await p.read();
  assert.ok(Date.now() - began >= 1000, "the slow reading was not slow");
  assert.equal(p.pollFails, 0, "a download that kept arriving was counted lost");
  assert.equal(p.lastState.boxes.length, JSON.parse(text).boxes.length);
  const held = p.lastRev;
  // a body that brings one piece and then nothing
  let sent = false;
  p.serve(opts => body(opts, {
    pull(c){
      if (sent) return new Promise(() => {});
      sent = true;
      c.enqueue(bytes.slice(0, 1000));
    },
  }));
  const stalled = Date.now();
  await p.read();
  assert.ok(Date.now() - stalled < 2000, "a download that stopped was waited on");
  assert.equal(p.pollFails, 1);
  // and an answer that never starts
  p.serve(() => new Promise(() => {}));
  await p.read();
  assert.equal(p.pollFails, 2);
  assert.equal(p.lastRev, held, "a lost reading moved the revision held");
  assert.deepEqual(p.problems, []);
});

// where a sent message stands with the agent (pendingStates) moves on its own:
// the ack changes nothing else on the card, and /fresh folds a message into a
// confirmed claim the same way. Each is a save, so the revision moves, and the
// card's fingerprint is of everything the phone is sent, those states included,
// so the lean reading brings the card. Walked here through a whole claim with
// the page's own reading code, and once more by a page that skipped the steps
// between and takes them in one reading
test("a message's delivery state alone reaches the phone in a lean reading", async () => {
  // nothing else queued in any lane, so the claim below takes this card
  for (const b of (await whole()).boxes) if (b.pending) await post(`/dismiss?box=${b.id}`);
  const p = page(), late = page();
  await p.read();
  const target = p.lastState.boxes.find(b => b.owner === "facilitator" && !b.done && !b.parked).id;
  const mine = () => plain(p.lastState.boxes.find(b => b.id === target));
  const moved = (before, after) => Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  const step = async (label, change, states) => {
    const before = mine();
    await change();
    const got = await p.read();
    assert.equal(got.lean, true, `${label}: not a lean reading`);
    assert.deepEqual(got.cards, [target], `${label}: the card did not come, or others came with it`);
    await sameAsWhole(p, label);
    assert.deepEqual(mine().pendingStates, states, `${label}: the phone shows the wrong delivery state`);
    return moved(before, mine());
  };
  await step("a message sent", () => post(`/send?box=${target}`, "Invented message for the marks"), ["sent"]);
  await late.read();
  let token;
  await step("the message handed over, not yet confirmed", async () => {
    const got = (await get("/wait?owner=facilitator&timeout=3&agent=marks")).body;
    assert.equal(got.box, target, JSON.stringify(got));
    token = got.ack;
  }, ["sent"]);
  const acked = await step("the claim confirmed", () => post(`/ack?owner=facilitator&token=${token}`), ["delivered"]);
  assert.deepEqual(acked, ["pendingStates"], "the ack moved more than the message's state, so this is not the state alone");
  // a page that last read before the hand-over takes the hand-over and the ack in one reading
  const caught = await late.read();
  assert.equal(caught.lean, true);
  assert.deepEqual(caught.cards, [target]);
  await sameAsWhole(late, "a page that skipped the steps between");
  assert.deepEqual(plain(late.lastState.boxes.find(b => b.id === target).pendingStates), ["delivered"]);
  await step("a progress note over the claim", () => post(`/progress?box=${target}`, "Invented progress note"), ["read"]);
  await step("a second message while the claim is held", () => post(`/send?box=${target}`, "Invented second message"), ["read", "sent"]);
  const folded = await step("the second message folded into the confirmed claim", () => get("/fresh?owner=facilitator"),
    ["read", "delivered"]);
  assert.ok(folded.includes("pendingStates"), `the fold did not move the states: ${folded}`);
  await step("the answer lands", () => post(`/reply?box=${target}`, "Invented answer"), []);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(late.problems, []);
});

// one phone reads m1 one way, a second phone reads it the other way at the
// same revision, and then it goes back, still with no save: a heartbeat going
// quiet and then beating again. The second phone holds words the board no
// longer has, and only the mark made when m1 read two ways gets it the card
test("a card that reads two ways at one revision is sent to every phone holding it", async () => {
  const merge = pageMerge();
  const probe = path.join(board.dir, "probe.txt");
  const a = await whole();
  await writeFile(probe, "read the second way");
  const b = await whole();
  await rm(probe);
  assert.equal(b.rev, a.rev, "the probe moved the revision");
  assert.notDeepEqual(b.boxes.find(x => x.id === "m1"), a.boxes.find(x => x.id === "m1"));
  await post("/title?box=m2", "Changed beside the probe");
  const now = await whole();
  for (const [name, held] of [["the first phone", a], ["the second phone", b]]){
    const lean = (await get(`/m/state?since=${held.rev}&delta=${held.epoch}`, GZ)).body;
    assert.equal(lean.delta, held.rev, name);
    assert.deepEqual(lean.boxes.map(x => x.id).sort(), ["m1", "m2"], `${name} was not sent m1`);
    const rebuilt = merge(merge(null, held), lean);
    assert.deepEqual(plain(rebuilt.order.map(id => rebuilt.cards.get(id))), now.boxes, name);
  }
});
