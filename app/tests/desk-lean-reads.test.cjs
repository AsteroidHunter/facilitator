// The Mac board's reading, lean. The page names the reading it holds and the
// board sends only what differs from it; laid over what the page holds, that
// must be exactly the reading a plain /state gives, after every kind of change.
//
// The board is the ~700 card fixture (phone-board-fixture.cjs) on a free port
// pair. The page is index.html's own reading code, the block from "the board's
// reading, lean" to its end, run in a vm and reading that board over real
// sockets. After every step its reading is checked against a plain /state taken
// right after it, as JSON text, so every field, every card and the order of
// their keys must agree. Only now and listenerGap, the board's clock, may move
// between the two readings; they are checked to be close. Three fixture
// patches: DESK_KEPT is cut to four, and card m1 and the reading itself carry
// the words of a probe file while it exists, which is a card and a field
// reading two ways at one revision with no save between, as a heartbeat going
// quiet does it. No browser, and port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const v8 = require("node:v8");
const vm = require("node:vm");
const { mkdtemp, readFile, rm, writeFile, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { boardState, startBoard } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const KEPT = 4;

let outer, board, html;

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-desk-lean-"));
  html = await readFile(path.join(ROOT, "index.html"), "utf8");
  const state = boardState({ dir: outer });
  board = await startBoard(outer, {
    state,
    extraPatches: [
      ["DESK_KEPT = 32", `DESK_KEPT = ${KEPT}`],
      // these cases are about lean reads, not the typing hold
      // (typing-hold.test.cjs), so a message sent here is free to go out at once
      ["TYPING_HOLD = 7.0", "TYPING_HOLD = 0.0"],
      [`                "queuePos": qpos.get(b["id"], 0),\n`,
       `                "queuePos": qpos.get(b["id"], 0),\n` +
       `                **({"probe": (HERE / "probe.txt").read_text()} if b["id"] == "m1" and (HERE / "probe.txt").exists() else {}),\n`],
      [`        "settingsRev": _settings_rev(),\n`,
       `        "settingsRev": _settings_rev(),\n` +
       `        **({"probe": (HERE / "probe.txt").read_text()} if (HERE / "probe.txt").exists() else {}),\n`],
    ],
  });
});

after(async () => {
  if (board) await board.stop();
  if (outer) await rm(outer, { recursive: true, force: true });
});

async function call(route, body){
  const r = await fetch(board.origin + route, body === undefined ? {} : { method: "POST", body });
  const text = await r.text();
  return { status: r.status, bytes: Buffer.byteLength(text), body: JSON.parse(text) };
}
async function post(route, body = ""){
  const r = await call(route, body);
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(r.body)}`);
  return r.body;
}

// the page's reading code, reading the fixture board. serve(fn) answers the
// next ask with fn's object instead of the board's
function page(){
  const block = html.slice(html.indexOf("// ---- the board's reading, lean"), html.indexOf("// ---- the board's reading ends"));
  assert.ok(block.length > 1000, "the reading block was not found in index.html");
  const asked = [], answers = [], problems = [];
  let next = null;
  const ctx = vm.createContext({
    reportProblem(kind, e){ problems.push(e.message); },
    // no scheduler.yield here, so the page yields by a posted message
    MessageChannel,
    async fetch(url){
      asked.push(url);
      if (next){ const fn = next; next = null; const body = fn(); return { json: async () => body }; }
      const r = await fetch(board.origin + url);
      const text = await r.text();
      const body = JSON.parse(text);
      answers.push({ url, bytes: Buffer.byteLength(text), lean: body.delta != null,
                     cards: (body.boxes || []).map(b => b.id), set: Object.keys(body.set || {}),
                     keys: body.keys, gone: body.gone, after: body.after, ids: Array.isArray(body.ids) });
      return { json: async () => JSON.parse(text) };
    },
  });
  vm.runInContext(block + "\nglobalThis.probe = { readState, get held(){ return deskHeld; } };", ctx);
  let handed = null;
  return {
    asked, answers, problems, probe: ctx.probe,
    serve(fn){ next = fn; },
    // a reading, which must share no object with the reading held or with the
    // reading handed on before it: the draw writes into what it is handed
    async read(){
      const out = await ctx.probe.readState();
      if (out && Array.isArray(out.boxes)){
        const held = objects(ctx.probe.held.reading);
        const before = handed ? objects(handed) : new Set();
        for (const o of objects(out)){
          assert.equal(held.has(o), false, "the page was handed an object of the reading held");
          assert.equal(before.has(o), false, "the page was handed an object it was handed before");
        }
        handed = out;
      }
      return out;
    },
  };
}

// every object and array in a reading
function objects(v, out = new Set()){
  if (v !== null && typeof v === "object" && !out.has(v)){
    out.add(v);
    for (const k of Object.keys(v)) objects(v[k], out);
  }
  return out;
}

// a reading as text with the board's clock taken out, and the clock beside it
function split(reading){
  const o = JSON.parse(JSON.stringify(reading));
  const clock = { now: o.now, listenerGap: o.listenerGap };
  delete o.now; delete o.listenerGap;
  return { text: JSON.stringify(o), clock };
}

// the page's reading against a plain /state taken right after it
async function sameAsWhole(got, label){
  const whole = await call("/state");
  assert.equal(whole.status, 200);
  assert.equal("epoch" in whole.body, false, "plain /state carries the lean reading's epoch");
  const a = split(got), b = split(whole.body);
  if (a.text !== b.text){
    const x = JSON.parse(a.text), y = JSON.parse(b.text);
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])]
      .filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    const cards = (y.boxes || []).filter((c, i) => JSON.stringify(c) !== JSON.stringify((x.boxes || [])[i])).map(c => c.id);
    assert.fail(`${label}: the page's reading is not the board's; fields ${keys.join(", ")}; cards ${cards.slice(0, 10).join(", ")}`);
  }
  // the clock: now moves on between the two readings, and every gap moves on
  // with it, by as much give as rounding to a tenth leaves
  const moved = b.clock.now - a.clock.now;
  assert.ok(moved >= 0 && moved < 5, `${label}: now is off by ${moved}`);
  assert.deepEqual(Object.keys(a.clock.listenerGap), Object.keys(b.clock.listenerGap), label);
  for (const [ow, gap] of Object.entries(a.clock.listenerGap)){
    const off = b.clock.listenerGap[ow] - gap;
    assert.ok(off <= moved + 0.11 && (off >= moved - 0.11 || b.clock.listenerGap[ow] < 0.11 + moved),
      `${label}: ${ow}'s listener gap is ${gap}, then ${b.clock.listenerGap[ow]} ${moved.toFixed(3)} s later`);
  }
  for (const k of ["epoch", "delta", "gone", "after", "ids", "count", "set", "keys"])
    assert.equal(k in got, false, `${label}: the reading's own ${k} was handed on as board`);
  return whole;
}

test("plain /state is as it was, and since= is the same reading with epoch", async () => {
  const plain = await call("/state");
  const first = await call("/state?since=");
  assert.equal(plain.body.epoch, undefined);
  assert.equal(plain.body.delta, undefined);
  assert.equal(typeof first.body.epoch, "string");
  const { epoch, ...rest } = first.body;
  assert.equal(split(rest).text, split(plain.body).text);
  assert.equal(Object.keys(rest).join(), Object.keys(plain.body).join(), "the whole reading's fields are not in /state's order");
  assert.equal((await call("/state?since=abc")).status, 400);
  // nothing new is a short answer: the clock and nothing else
  const still = await call(`/state?since=${first.body.rev}&delta=${epoch}`);
  assert.equal(still.body.delta, first.body.rev);
  assert.deepEqual(still.body.boxes, []);
  assert.ok(still.bytes < 1500, `an unchanged reading took ${still.bytes} bytes`);
  // a reading from another run, or a revision never read, is answered whole
  for (const ask of [`/state?since=${first.body.rev}&delta=0a1b2c3d`, `/state?since=${first.body.rev}`, "/state?since=12"]){
    const other = await call(ask);
    assert.equal(other.body.delta, undefined, ask);
    assert.equal(other.body.boxes.length, plain.body.boxes.length, ask);
  }
});

test("every kind of change, read lean, gives the reading /state gives", async () => {
  const p = page();
  let got = await p.read();
  assert.equal(p.answers.at(-1).lean, false, "the first reading was not whole");
  await sameAsWhole(got, "first reading");
  const step = async (label, change, expect = () => {}) => {
    await change();
    got = await p.read();
    const answer = p.answers.at(-1);
    assert.equal(answer.lean, true, `${label}: not a lean reading`);
    await sameAsWhole(got, label);
    expect(answer);
    return answer;
  };
  const sizes = [];
  const measured = async (label, change, expect) => sizes.push([label, (await step(label, change, expect)).bytes]);
  await measured("nothing changed", async () => {}, a => assert.deepEqual(a.cards, []));

  // an agent listening, and then gone again: the presence fields, no save
  const wait = fetch(board.origin + "/wait?owner=facilitator&timeout=2&agent=desk-lean-test").then(r => r.json());
  await new Promise(r => setTimeout(r, 300));
  await measured("an agent listening", async () => {}, a => assert.ok(a.set.includes("listening"), "listening did not come"));
  assert.equal(got.listening.facilitator, true);
  assert.equal(got.agents.facilitator.alive, true);
  await wait;
  await measured("the agent gone", async () => {}, a => assert.ok(a.set.includes("listening")));
  assert.equal(got.listening.facilitator, false);

  let made;
  await measured("a new card", async () => { made = await post("/create?owner=facilitator", ""); }, a => {
    assert.deepEqual(a.cards, [made.id]);
    assert.equal(typeof a.after[made.id], "string", "the new card came without its place");
  });
  await measured("a message sent", () => post(`/send?box=${made.id}`, "A message to the new card"), a => {
    assert.deepEqual(a.cards, [made.id]);
    assert.ok(a.set.includes("queued"), "the queue count did not come");
  });
  const claim = await (await fetch(board.origin + "/wait?owner=facilitator&timeout=0&agent=desk-lean-test")).json();
  assert.equal(claim.box, made.id);
  await measured("a reply", () => post(`/reply?box=${made.id}`, "An answer, in a few words.\n\nAnd a second paragraph."), a => {
    assert.ok(a.cards.includes(made.id));
  });
  assert.equal(got.boxes.find(b => b.id === made.id).replyFull, "An answer, in a few words.\n\nAnd a second paragraph.");
  await measured("a title", () => post(`/title?box=${made.id}`, "Renamed for the desk test"), a => assert.deepEqual(a.cards, [made.id]));
  const open = got.boxes.filter(b => !b.done && !b.parked && b.id !== made.id && b.owner === "facilitator").map(b => b.id);
  await measured("a card done", () => post(`/done?box=${open[0]}&v=1`), a => assert.deepEqual(a.cards, [open[0]]));
  await measured("a card parked", () => post(`/park?box=${open[1]}&v=1`), a => assert.deepEqual(a.cards, [open[1]]));
  await measured("a magic box filled and opened", () => post(`/magic?box=${made.id}&kind=text`, "What the box shows."), a => {
    assert.deepEqual(a.cards, [made.id]);
  });
  assert.equal(got.boxes.find(b => b.id === made.id).magic.open, true);
  await measured("the magic box closed", () => post(`/magic/close?box=${made.id}`), a => assert.deepEqual(a.cards, [made.id]));
  assert.equal(got.boxes.find(b => b.id === made.id).magic.open, false);
  await measured("the magic box opened again", () => post(`/magic/reopen?box=${made.id}`), a => assert.deepEqual(a.cards, [made.id]));
  assert.equal(got.boxes.find(b => b.id === made.id).magic.open, true);
  const settingsWas = got.settingsRev;
  await measured("a setting changed", () => post("/settings", JSON.stringify({ bgcolor: "#102030" })), a => {
    assert.deepEqual(a.cards, []);
    assert.ok(a.set.includes("settingsRev"), "the settings' revision did not come");
  });
  assert.ok(got.settingsRev > settingsWas);
  // the fixture keeps a profile, so the onboarding flag first comes and then goes
  const profile = path.join(board.dir, "..", "data", "profile.json");
  const kept = await readFile(profile, "utf8");
  assert.equal("onboarding" in got, false);
  await measured("the profile gone (the onboarding needed)", () => unlink(profile), a => {
    assert.ok(a.set.includes("onboarding"));
    assert.equal(a.keys.at(-1), "onboarding");
  });
  assert.equal(got.onboarding, true);
  await measured("the profile kept again", () => writeFile(profile, kept), a => {
    assert.equal(a.keys.includes("onboarding"), false);
  });
  assert.equal("onboarding" in got, false);
  await measured("a card to the Bin", () => post(`/bin?box=${open[2]}`), a => assert.deepEqual(a.gone, [open[2]]));
  assert.equal(got.boxes.some(b => b.id === open[2]), false);
  await measured("the card restored", () => post(`/bin/restore?box=${open[2]}`), a => assert.ok(a.cards.includes(open[2])));
  assert.equal(got.boxes.some(b => b.id === open[2]), true);
  await measured("a job working on a card", () => post(`/working?box=${open[3]}&v=1`), a => assert.ok(a.cards.includes(open[3])));
  assert.equal(got.boxes.find(b => b.id === open[3]).bg, true);
  await measured("the job stopped", () => post(`/working?box=${open[3]}&v=0`), a => assert.ok(a.cards.includes(open[3])));
  await measured("a reply read", () => post("/seen", JSON.stringify({ [made.id]: 1 })), () => {});
  await measured("the empty card closed away", async () => {
    made = await post("/create?owner=facilitator", "");
    got = await p.read();
    await post(`/close?box=${made.id}`);
  }, a => assert.deepEqual(a.gone, [made.id]));

  // a card and a field reading two ways at one revision, with no save between
  const rev = got.rev;
  await measured("a card and a field changed with no save", () => writeFile(path.join(board.dir, "probe.txt"), "one"), a => {
    assert.deepEqual(a.cards, ["m1"]);
    assert.ok(a.set.includes("probe"));
    assert.equal(a.keys[a.keys.indexOf("settingsRev") + 1], "probe", "the new field came without its place");
  });
  assert.equal(got.rev, rev, "the probe moved the revision");
  await measured("and changed back", () => unlink(path.join(board.dir, "probe.txt")), a => {
    assert.deepEqual(a.cards, ["m1"]);
    assert.equal(a.keys.includes("probe"), false);
  });
  assert.equal(got.boxes.find(b => b.id === "m1").probe, undefined);

  assert.deepEqual(p.problems, []);
  assert.ok(p.asked.slice(1).every(s => /^\/state\?since=\d+&delta=[0-9a-f]+$/.test(s)),
    "a reading after the first did not name the reading it held");
  const whole = (await call("/state")).bytes;
  for (const [label, bytes] of sizes) assert.ok(bytes * 50 < whole, `${label}: ${bytes} bytes against ${whole} whole`);
  console.log(`whole /state ${whole} bytes; lean: ${sizes.map(([l, b]) => `${l} ${b}`).join(", ")}`);
});

test("the page is handed a copy: nothing written into it reaches the reading held", async () => {
  const p = page();
  const first = await p.read();
  const target = first.boxes.find(b => b.owner === "facilitator" && !b.done);
  await post(`/magic?box=${target.id}&kind=text`, "A box to write into.");
  const a = await p.read();
  await sameAsWhole(a, "before the writes");
  // what the draw does to its reading, and worse
  const card = a.boxes.find(b => b.id === target.id);
  card.magic.open = false;              // magicClose
  card.title = "written by the page";   // holdFlags
  card.answered?.push({ text: "x", ts: 0 });
  card.pendingTexts.push("not sent");
  a.tabs.order.reverse();
  a.boxes = a.boxes.filter(b => b.id !== target.id);   // binHide
  a.fetchedAt = 1;
  const b = await p.read();
  assert.equal(p.answers.at(-1).lean, true);
  await sameAsWhole(b, "after the page wrote into its copy");
  assert.notEqual(a, b);
  assert.notEqual(a.boxes[0], b.boxes[0]);
  // and every card handed on is one of V8's fast objects, as a card JSON.parse
  // makes is: a copy built a key at a time is a dictionary, and the whole draw,
  // which reads cards everywhere, ran half again as slow on one
  v8.setFlagsFromString("--allow-natives-syntax");
  const fast = new Function("o", "return %HasFastProperties(o)");
  v8.setFlagsFromString("--no-allow-natives-syntax");
  assert.equal(fast(JSON.parse(JSON.stringify(b.boxes[0]))), true, "the check itself does not see a parsed card as fast");
  assert.ok(b.boxes.every(fast), "a card handed on is a dictionary object");
  assert.ok(b.boxes.filter(c => c.magic).every(c => fast(c.magic)));
});

test("the reading is handed on a task later, by scheduler.yield where the browser has it", async () => {
  const block = html.slice(html.indexOf("// ---- the board's reading, lean"), html.indexOf("// ---- the board's reading ends"));
  const fetchBoard = async url => { const r = await fetch(board.origin + url); const text = await r.text(); return { json: async () => JSON.parse(text) }; };
  // without scheduler.yield: one posted message a reading
  let posted = 0;
  class Counted extends MessageChannel { constructor(){ super(); posted++; } }
  const plainCtx = vm.createContext({ MessageChannel: Counted, fetch: fetchBoard });
  vm.runInContext(block + "\nglobalThis.readState = readState;", plainCtx);
  await plainCtx.readState();
  await post("/title?box=m50", "Changed before a posted message");
  await sameAsWhole(await plainCtx.readState(), "after a posted message");
  assert.equal(posted, 2);
  // with it: scheduler.yield, once a reading, and no message
  let yields = 0;
  posted = 0;
  const ctx = vm.createContext({ MessageChannel: Counted, scheduler: { yield(){ yields++; return Promise.resolve(); } }, fetch: fetchBoard });
  vm.runInContext(block + "\nglobalThis.readState = readState;", ctx);
  await ctx.readState();
  await post("/title?box=m51", "Changed before scheduler.yield");
  await sameAsWhole(await ctx.readState(), "after scheduler.yield");
  assert.equal(yields, 2);
  assert.equal(posted, 0);
});

test("a lean answer that does not fit is never used: the whole board is read at once", async () => {
  const p = page();
  const first = await p.read();
  await post("/title?box=m20", "Changed before a bad answer");
  for (const bad of [
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length + 1, set: { rev: held.rev + 1 }, boxes: [] }),
    held => ({ delta: held.rev - 1, epoch: held.epoch, rev: held.rev + 1, count: held.order.length, set: {}, boxes: [] }),
    held => ({ delta: held.rev, epoch: "not-this-run", rev: held.rev + 1, count: held.order.length, set: {}, boxes: [] }),
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length + 1, set: { rev: held.rev + 1 },
               boxes: [{ id: "new" }], after: { new: "no-such-card" } }),
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length, set: { rev: held.rev + 2 }, boxes: [] }),
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length, set: null, boxes: [] }),
    // a field named that neither came nor is held, and an order without the cards
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length, set: { rev: held.rev + 1 },
               keys: [...Object.keys(held.reading), "unheard"], boxes: [] }),
    held => ({ delta: held.rev, epoch: held.epoch, rev: held.rev + 1, count: held.order.length, set: { rev: held.rev + 1 },
               keys: Object.keys(held.reading).filter(k => k !== "boxes"), boxes: [] }),
  ]){
    const held = p.probe.held;
    p.serve(() => bad(held));
    const before = p.asked.length;
    const got = await p.read();
    assert.deepEqual(p.asked.slice(before + 1), ["/state?since="], "the whole board was not asked for");
    assert.equal(p.answers.at(-1).lean, false);
    await sameAsWhole(got, "after a bad answer");
    assert.notEqual(got.boxes.length, 0);
  }
  assert.equal(p.problems.length, 8);
  assert.ok(first.boxes.length > 0);
  // an answer that is no reading is handed on as it came, as it always was,
  // and the reading held stays held
  const held = p.probe.held;
  p.serve(() => ({ error: "the board is busy answering other readers" }));
  assert.deepEqual(JSON.parse(JSON.stringify(await p.read())), { error: "the board is busy answering other readers" });
  assert.equal(p.probe.held, held);
  await post("/title?box=m21", "Changed after a busy answer");
  await sameAsWhole(await p.read(), "after a busy answer");
  assert.equal(p.answers.at(-1).lean, true, "a busy answer cost the held reading");
});

test("two readings asked at once both build on the reading held", async () => {
  const p = page();
  await p.read();
  await post("/title?box=m30", "Changed before two readings");
  const [a, b] = await Promise.all([p.read(), p.read()]);
  assert.deepEqual(p.problems, []);
  assert.ok(p.answers.slice(-2).every(x => x.lean), "a reading asked alongside another was not lean");
  await sameAsWhole(a, "the first of two");
  await sameAsWhole(b, "the second of two");
});

test("a reading the board no longer remembers is answered whole and built on again", async () => {
  const p = page();
  await p.read();
  const held = p.probe.held;
  // DESK_KEPT readings at newer revisions, made by another reader
  for (let n = 0; n < KEPT; n++){
    await post("/title?box=m40", `Changed again ${n}`);
    await call("/state?since=");
  }
  const got = await p.read();
  assert.equal(p.answers.at(-1).lean, false, "a reading past DESK_KEPT was still built on");
  assert.ok(p.asked.at(-1).includes(`since=${held.rev}&delta=`));
  await sameAsWhole(got, "after the board forgot");
  await post("/title?box=m40", "And once more");
  await sameAsWhole(await p.read(), "built on again");
  assert.equal(p.answers.at(-1).lean, true);
  assert.deepEqual(p.problems, []);
});
