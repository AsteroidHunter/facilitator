// The board's live line as the pages hear it (board-line.js), and what the Mac
// board, the /page view and the Mac's narrow view do with it.
//
// The pages' own code runs in a vm: board-line.js, then index.html's block from
// "the board's live line" to its end (and page.html's), with the reading
// (poll), the card motion (cardsMoving) and the clock's draw (drawClock)
// replaced by fakes that note each call, an EventSource and a SharedWorker the
// test drives by hand, and a clock of the test's own, so a second, the 15 s
// beat and the 40 s dead line are stepped through rather than waited for. The
// board itself is not started here (board-line-browser.test.cjs and
// tests/test_events_stream.py do that), no browser is opened, and port 8877 is
// never touched.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const LINE = fs.readFileSync(path.join(ROOT, "board-line.js"), "utf8");
const DESK = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const PAGE = fs.readFileSync(path.join(ROOT, "page.html"), "utf8");
const PHONE = fs.readFileSync(path.join(ROOT, "m.html"), "utf8");
const HOST = fs.readFileSync(path.join(ROOT, "mac-phone-view.js"), "utf8");

// a message made in the vm, as plain data, to compare with one made here
const plain = v => JSON.parse(JSON.stringify(v));

function block(html, from, to, name){
  const at = html.indexOf(from), end = html.indexOf(to, at);
  assert.ok(at >= 0 && end > at, `${name}: the block from ${from} was not found`);
  return html.slice(at, end);
}
const DESK_LINE = block(DESK, "// ---- the board's live line ----", "// ---- the board's live line ends", "index.html");
const PAGE_LINE = block(PAGE, "// ---- the board's live line ----", "// ---- the board's live line ends", "page.html");

// a clock and timers of the test's own, an EventSource and a SharedWorker it
// drives, and a document that is on screen unless hidden says otherwise
function world({ hidden = false, worker = null } = {}){
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  const sources = [], listeners = {}, docListeners = {}, problems = [];
  class FakeEventSource {
    constructor(url){ this.url = url; this.readyState = 0; this.closed = false; sources.push(this); }
    close(){ this.readyState = 2; this.closed = true; }
    say(line){ this.readyState = 1; this.onmessage && this.onmessage({ data: JSON.stringify(line) }); }
    fail(closed = false){ this.readyState = closed ? 2 : 0; this.onerror && this.onerror({}); }
  }
  const document = {
    hidden,
    body: { classList: new Set() },
    addEventListener(type, fn){ (docListeners[type] ||= []).push(fn); },
  };
  const ctx = {
    console, Promise, JSON, Number, Object, Math, Set, Map, Array, Error,
    Date: { now: () => t },
    setTimeout(fn, ms = 0){ const id = ++seq; timers.set(id, { at: t + Math.max(0, +ms || 0), fn, every: 0 }); return id; },
    clearTimeout(id){ timers.delete(id); },
    setInterval(fn, ms){ const id = ++seq; timers.set(id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval(id){ timers.delete(id); },
    EventSource: FakeEventSource,
    addEventListener(type, fn){ (listeners[type] ||= []).push(fn); },
    reportProblem(kind, e){ problems.push(kind + ": " + (e && e.message)); },
    document,
  };
  if (worker) ctx.SharedWorker = worker;
  vm.createContext(ctx);
  vm.runInContext(LINE, ctx);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  return {
    ctx, sources, problems, document,
    get now(){ return t; },
    intervals: () => [...timers.values()].filter(x => x.every),
    fire(type, e = {}){ for (const fn of listeners[type] || []) fn(e); },
    fireDoc(type){ for (const fn of docListeners[type] || []) fn({}); },
    flush,
    // the clock moves on by ms, running each timer that falls due on the way
    async advance(ms){
      const end = t + ms;
      for (;;){
        let next = null, id = null;
        for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next.at)){ next = v; id = k; }
        if (!next) break;
        t = next.at;
        if (next.every) next.at += next.every; else timers.delete(id);
        next.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

// index.html's live line block over the world, with poll, cardsMoving and
// drawClock as fakes. Each reading is held until the test answers it with the
// revision the board would have sent (answer), as a reading that took that
// long; deskHeld and lastState are then what a reading leaves
function desk(opts = {}){
  const w = world(opts);
  const polls = [], clocks = [];
  let moving = false;
  Object.assign(w.ctx, {
    poll(timed){
      const call = { timed: timed === true, at: w.now };
      call.promise = new Promise(done => { call.done = done; });
      polls.push(call);
      return call.promise;
    },
    cardsMoving: () => moving,
    drawClock(state, gone){
      clocks.push({ state, gone });
      // as drawListeners does: no lane quiet, so the banner comes down
      w.document.body.classList.delete("offline");
    },
  });
  vm.runInContext(
    "let deskHeld = null, lastState = null, pollFails = 0;\n" + DESK_LINE +
    "\nglobalThis.probe = { get line(){ return deskLine; }, get ticker(){ return deskTicker; }," +
    " set held(v){ deskHeld = v; }, set last(v){ lastState = v; }, set fails(v){ pollFails = v; }, get fails(){ return pollFails; } };",
    w.ctx);
  const p = w.ctx.probe;
  return {
    ...w, polls, clocks, probe: p,
    set moving(v){ moving = v; },
    // the reading out now answered: the page then holds rev
    async answer(rev, { failed = false } = {}){
      const call = polls.find(c => !c.answered);
      assert.ok(call, "no reading was out to answer");
      call.answered = true;
      if (failed) p.fails = p.fails + 1;
      else { p.fails = 0; p.held = { rev, reading: { rev, now: w.now / 1000, boxes: [], listenerGap: {} } }; p.last = {}; }
      call.done();
      await w.flush();
    },
  };
}

// the page loaded, its first reading answered at rev 5, and the first line
// heard and read: the line is up and the page holds 5
async function upAt5(d){
  await d.answer(5);
  d.sources[0].say({ rev: 5, quiet: "q1" });
  await d.advance(1000);
  assert.equal(d.polls.length, 2, "the first line did not read once");
  await d.answer(5);
}

test("the page reads at load and runs today's timed refresh until the first line, which stops it and reads once", async () => {
  const d = desk();
  assert.equal(d.polls.length, 1, "the page did not read at load");
  assert.equal(d.polls[0].timed, false, "the reading at load is not the plain reading it always was");
  const timer = d.intervals().filter(x => x.every === 1200);
  assert.equal(timer.length, 1, "the 1.2 s refresh does not run before a line is open");
  assert.ok(d.probe.ticker, "the timed refresh is not running");
  assert.equal(d.sources.length, 1);
  assert.equal(d.sources[0].url, "/events");
  await d.answer(5);
  d.sources[0].say({ rev: 5, quiet: "q1" });
  assert.equal(d.probe.line.up, true);
  assert.equal(d.probe.ticker, 0, "the timed refresh still runs with the line up");
  assert.equal(d.intervals().filter(x => x.every === 1200).length, 0);
  await d.advance(1000);
  assert.equal(d.polls.length, 2, "a line that opens does not read once");
});

test("a ring on a window on screen reads on the timer's own path, and on a hidden one plain", async () => {
  const shown = desk();
  await upAt5(shown);
  assert.equal(shown.polls[1].timed, true, "the first line's reading on screen was not poll(true)");
  shown.sources[0].say({ rev: 6, quiet: "q1" });
  await shown.advance(1000);
  assert.equal(shown.polls.length, 3);
  assert.equal(shown.polls[2].timed, true, "a ring on screen did not take the timed path");

  const hidden = desk({ hidden: true });
  await upAt5(hidden);
  hidden.sources[0].say({ rev: 6, quiet: "q1" });
  await hidden.advance(1000);
  assert.equal(hidden.polls.length, 3);
  assert.equal(hidden.polls[2].timed, false, "a ring on a hidden window did not draw whole");
});

test("a beat that matches what the page holds reads nothing; a new revision or a new mark reads", async () => {
  const d = desk();
  await upAt5(d);
  for (let i = 0; i < 4; i++){
    await d.advance(15000);
    d.sources[0].say({ rev: 5, quiet: "q1" });
  }
  await d.advance(5000);
  assert.equal(d.polls.length, 2, "a stale beat read the board");
  assert.equal(d.sources.length, 1, "a line that beats was taken for dead");
  d.sources[0].say({ rev: 5, quiet: "q2" });
  await d.advance(10);
  assert.equal(d.polls.length, 3, "a moved mark at the same revision did not read");
  await d.answer(5);
  await d.advance(2000);
  d.sources[0].say({ rev: 6, quiet: "q2" });
  await d.advance(10);
  assert.equal(d.polls.length, 4, "a new revision did not read");
});

test("a ring while a card moves is put off and tried again, not lost", async () => {
  const d = desk();
  await upAt5(d);
  await d.advance(2000);
  d.moving = true;
  d.sources[0].say({ rev: 6, quiet: "q1" });
  await d.advance(2000);
  assert.equal(d.polls.length, 2, "a ring read the board in the middle of a card's motion");
  d.moving = false;
  await d.advance(250);
  assert.equal(d.polls.length, 3, "the ring was dropped when the motion ended");
  assert.equal(d.polls[2].timed, true);
  await d.answer(6);
  await d.advance(5000);
  assert.equal(d.polls.length, 3, "the put off ring read more than once");
});

test("a burst of rings gives at most two readings, the last of what is current", async () => {
  const d = desk();
  await upAt5(d);
  await d.advance(3000);
  const before = d.polls.length;
  let said = 5;
  // ten saves 20 ms apart, each read as soon as it is asked for
  for (let i = 0; i < 10; i++){
    said++;
    d.sources[0].say({ rev: said, quiet: "q1" });
    await d.advance(20);
    const out = d.polls.find(c => !c.answered);
    if (out) await d.answer(said);
  }
  for (let i = 0; i < 20; i++){
    await d.advance(250);
    const out = d.polls.find(c => !c.answered);
    if (out) await d.answer(said);
  }
  const reads = d.polls.length - before;
  assert.ok(reads >= 1 && reads <= 2, `a burst of ten rings gave ${reads} readings`);
  assert.equal(d.polls.at(-1).at - d.polls[before].at >= 1000 || reads === 1, true, "two ring readings started within a second");
  // and a slow reading: rings while it is out read once more after it
  const slow = d.polls.length;
  d.sources[0].say({ rev: ++said, quiet: "q1" });
  await d.advance(10);
  assert.equal(d.polls.length, slow + 1);
  for (let i = 0; i < 5; i++){ d.sources[0].say({ rev: ++said, quiet: "q1" }); await d.advance(500); }
  assert.equal(d.polls.length, slow + 1, "a ring read while a reading was still out");
  await d.answer(said - 3);
  await d.advance(1000);
  assert.equal(d.polls.length, slow + 2, "the rings during a reading did not read once more after it");
  await d.answer(said);
  await d.advance(5000);
  assert.equal(d.polls.length, slow + 2);
});

test("while the line is down today's timed refresh runs, and a line that comes back stops it and reads", async () => {
  const d = desk();
  await upAt5(d);
  // the board stops: the browser will try the line again by itself
  d.sources[0].fail(false);
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker, "the timed refresh did not come back with the line down");
  await d.advance(1200);
  assert.equal(d.polls.length, 3, "the timed refresh did not read 1.2 s after the line went down");
  assert.equal(d.polls[2].timed, true);
  await d.answer(5, { failed: true });
  await d.advance(1200);
  assert.equal(d.polls.length, 4);
  await d.answer(5, { failed: true });
  // the board is back: the browser's next try opens and its first line comes
  d.sources[0].say({ rev: 7, quiet: "q3" });
  assert.equal(d.probe.ticker, 0, "the timed refresh still ran once the line was back");
  await d.advance(1000);
  assert.equal(d.polls.length, 5, "the line's return did not read");
  await d.answer(7);
  await d.advance(10000);
  assert.equal(d.polls.length, 5, "readings went on with the line up and nothing changed");
});

test("a line the board refuses (503 or 401) falls back to the timer and is opened again after 30 s", async () => {
  const d = desk();
  await upAt5(d);
  d.sources[0].fail(true);
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker);
  await d.advance(29_000);
  assert.equal(d.sources.length, 1, "a refused line was opened again too soon");
  for (const call of d.polls) if (!call.answered) await d.answer(5);
  await d.advance(1_000);
  assert.equal(d.sources.length, 2, "a refused line was never opened again");
  assert.equal(d.sources[0].closed, true);
  d.sources[1].say({ rev: 5, quiet: "q1" });
  assert.equal(d.probe.line.up, true);
  assert.equal(d.probe.ticker, 0);
});

test("a line that says nothing for 40 s is closed, opened again and read", async () => {
  const d = desk();
  await upAt5(d);
  // the last line came a second ago (upAt5)
  await d.advance(38_000);
  assert.equal(d.sources.length, 1);
  assert.equal(d.probe.line.up, true);
  await d.advance(1_000);
  assert.equal(d.sources[0].closed, true, "a silent line was not closed");
  assert.equal(d.sources.length, 2, "a silent line was not opened again");
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker, "the timed refresh did not run while the line was dead");
  for (const call of d.polls) if (!call.answered) await d.answer(5);
  const before = d.polls.length;
  d.sources[1].say({ rev: 5, quiet: "q1" });
  await d.advance(1000);
  assert.equal(d.polls.length, before + 1, "the line opened again did not read once");
});

test("a reading a ring asked for that does not get through is tried again at 1.2 s until one does", async () => {
  const d = desk();
  await upAt5(d);
  await d.advance(2000);
  d.sources[0].say({ rev: 6, quiet: "q1" });
  await d.advance(10);
  assert.equal(d.polls.length, 3);
  await d.answer(5, { failed: true });
  await d.advance(1199);
  assert.equal(d.polls.length, 3);
  await d.advance(1);
  assert.equal(d.polls.length, 4, "a failed ring's reading was not tried again");
  await d.answer(6);
  await d.advance(10000);
  assert.equal(d.polls.length, 4, "readings went on after one got through");
});

test("the tick draws the clock from the reading held while the line is up and the window on screen, never over the unreachable banner", async () => {
  const d = desk();
  await upAt5(d);
  d.probe.held = { rev: 5, reading: { rev: 5, now: d.now / 1000 - 10, boxes: [], listenerGap: { facilitator: 100 } } };
  await d.advance(15000);
  assert.equal(d.clocks.length, 1, "the tick did not draw the clock");
  assert.ok(Math.abs(d.clocks[0].gone - 25) < 0.01, `the time since the reading was ${d.clocks[0].gone}`);
  assert.equal(d.clocks[0].state.listenerGap.facilitator, 100, "the tick wrote into the reading held");
  // shown again: at once
  d.fireDoc("visibilitychange");
  assert.equal(d.clocks.length, 2, "showing the window did not draw the clock at once");
  // the banner says the board is unreachable: the tick leaves it up
  d.probe.fails = 3;
  d.document.body.classList.add("offline");
  await d.advance(45000);
  d.fireDoc("visibilitychange");
  assert.equal(d.clocks.length, 2, "the tick drew the clock over the unreachable banner");
  assert.ok(d.document.body.classList.has("offline"), "the tick took the unreachable banner down");
  // hidden, or with the line down, it draws nothing
  d.probe.fails = 0;
  d.document.hidden = true;
  await d.advance(15000);
  assert.equal(d.clocks.length, 2, "the tick drew a hidden window");
  d.document.hidden = false;
  d.sources[0].fail(false);
  await d.advance(15000);
  assert.equal(d.clocks.length, 2, "the tick drew with the line down");
});

test("shown again or resumed, a page with the line up reads once", async () => {
  const d = desk();
  await upAt5(d);
  await d.advance(3000);
  d.fireDoc("visibilitychange");
  await d.advance(10);
  assert.equal(d.polls.length, 3, "showing the window did not read");
  await d.answer(5);
  await d.advance(3000);
  d.fire("resume");
  await d.advance(10);
  assert.equal(d.polls.length, 4, "a resumed page did not read");
});

test("a page kept in the back and forward cache holds no line, and on coming back opens one and reads", async () => {
  const d = desk();
  await upAt5(d);
  d.fire("pagehide", { persisted: true });
  assert.equal(d.sources[0].closed, true, "the line stayed open in the cache");
  d.fire("pageshow", { persisted: true });
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker);
  assert.equal(d.sources.length, 2, "the page came back with no line");
  for (const call of d.polls) if (!call.answered) await d.answer(5);
  const before = d.polls.length;
  d.sources[1].say({ rev: 5, quiet: "q1" });
  await d.advance(1000);
  assert.equal(d.polls.length, before + 1, "the page back from the cache did not read");
});

// a SharedWorker made by the page, whose port the test plays the worker's side of
function fakeWorker(){
  const made = [];
  class FakeSharedWorker {
    constructor(url, opts){
      this.url = url; this.opts = opts; this.sent = [];
      const self = this;
      this.port = { postMessage(m){ self.sent.push(m); }, close(){ self.closed = true; }, onmessage: null };
      made.push(this);
    }
    tell(m){ this.port.onmessage && this.port.onmessage({ data: m }); }
  }
  return { made, FakeSharedWorker };
}

test("a page with a SharedWorker joins the one line it holds and opens none of its own", async () => {
  const fw = fakeWorker();
  const d = desk({ worker: fw.FakeSharedWorker });
  assert.equal(fw.made.length, 1);
  assert.equal(fw.made[0].url, "/board-line-worker.js");
  assert.equal(fw.made[0].opts.name, "facilitator-board-line");
  assert.deepEqual(plain(fw.made[0].sent), [{ type: "hello" }]);
  assert.equal(d.sources.length, 0, "a page with a worker opened a line of its own");
  await d.answer(5);
  fw.made[0].tell({ type: "line", rev: 5, quiet: "q1" });
  assert.equal(d.probe.line.up, true);
  await d.advance(1000);
  assert.equal(d.polls.length, 2);
  await d.answer(5);
  fw.made[0].tell({ type: "down" });
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker);
  // leaving says bye, so the worker can close the line when no window is left
  d.fire("pagehide", { persisted: false });
  assert.deepEqual(plain(fw.made[0].sent.at(-1)), { type: "bye" });
});

test("a page whose worker does not load holds its own line", async () => {
  const fw = fakeWorker();
  const d = desk({ worker: fw.FakeSharedWorker });
  fw.made[0].onerror();
  assert.equal(d.sources.length, 1, "no line of its own after the worker failed to load");
  await d.answer(5);
  d.sources[0].say({ rev: 5, quiet: "q1" });
  assert.equal(d.probe.line.up, true);
});

test("a worker that can hold no line says so, and the page holds its own", async () => {
  const w = world();
  delete w.ctx.EventSource;
  let connect = null;
  w.ctx.BoardLine.worker({ addEventListener(type, fn){ if (type === "connect") connect = fn; } });
  const port = { got: [], postMessage(m){ this.got.push(m); }, close(){}, onmessage: null };
  connect({ ports: [port] });
  port.onmessage({ data: { type: "hello" } });
  assert.deepEqual(plain(port.got), [{ type: "none" }]);
  const fw = fakeWorker();
  const d = desk({ worker: fw.FakeSharedWorker });
  fw.made[0].tell({ type: "none" });
  assert.equal(fw.made[0].closed, true, "the page kept its port to a worker with no line");
  assert.equal(d.sources.length, 1, "the page did not open a line of its own");
  await d.answer(5);
  d.sources[0].say({ rev: 5, quiet: "q1" });
  assert.equal(d.probe.line.up, true);
});

test("a page that hears nothing from its worker for 45 s joins it again", async () => {
  const fw = fakeWorker();
  const d = desk({ worker: fw.FakeSharedWorker });
  await d.answer(5);
  fw.made[0].tell({ type: "line", rev: 5, quiet: "q1" });
  await d.advance(1000);
  await d.answer(5);
  // the worker last spoke a second ago
  await d.advance(43_000);
  assert.equal(fw.made.length, 1);
  await d.advance(1_000);
  assert.equal(fw.made.length, 2, "a silent worker was not joined again");
  assert.deepEqual(plain(fw.made[0].sent.at(-1)), { type: "bye" });
  assert.equal(d.probe.line.up, false);
  assert.ok(d.probe.ticker);
});

test("the worker holds one line for every window, tells each one, and closes it when the last says bye", () => {
  const w = world();
  let connect = null;
  const scope = { addEventListener(type, fn){ if (type === "connect") connect = fn; } };
  w.ctx.BoardLine.worker(scope);
  const port = () => ({ got: [], postMessage(m){ this.got.push(m); }, close(){ this.closed = true; }, onmessage: null });
  const a = port(), b = port();
  connect({ ports: [a] });
  a.onmessage({ data: { type: "hello" } });
  assert.deepEqual(plain(a.got), [{ type: "down" }], "a window joining before any line was not told it is down");
  assert.equal(w.sources.length, 1);
  w.sources[0].say({ rev: 3, quiet: "m" });
  connect({ ports: [b] });
  b.onmessage({ data: { type: "hello" } });
  assert.equal(w.sources.length, 1, "a second window made a second line");
  assert.deepEqual(plain(b.got), [{ type: "line", rev: 3, quiet: "m" }], "a window joining was not told the line as it stands");
  w.sources[0].say({ rev: 4, quiet: "m" });
  assert.deepEqual(plain(a.got.at(-1)), { type: "line", rev: 4, quiet: "m" });
  assert.deepEqual(plain(b.got.at(-1)), { type: "line", rev: 4, quiet: "m" });
  a.onmessage({ data: { type: "bye" } });
  assert.equal(w.sources[0].closed, false, "the line closed with a window still on it");
  b.onmessage({ data: { type: "bye" } });
  assert.equal(w.sources[0].closed, true, "the line stayed open with no window left");
  const c = port();
  connect({ ports: [c] });
  c.onmessage({ data: { type: "hello" } });
  assert.equal(w.sources.length, 2, "a window after all had gone did not open the line again");
});

test("the narrow view hears the board's lines through the board and reads by its own revision", async () => {
  const d = desk();
  await upAt5(d);
  let childRev = 4;
  const child = { reads: 0, ups: 0, downs: 0 };
  const relay = d.probe.line.relay({
    held: () => childRev,
    read(){ child.reads++; },
    up(){ child.ups++; },
    down(){ child.downs++; },
  });
  assert.equal(child.downs, 1, "the narrow view was not told first that it has no line of its own");
  assert.equal(child.ups, 1, "the narrow view was not told the board's line is up");
  assert.equal(relay.up, true);
  await d.advance(1000);
  assert.equal(child.reads, 1, "the narrow view did not read when it joined");
  childRev = 5;
  // the board already holds 6 (a click's own reading), the narrow view 5
  d.probe.held = { rev: 6, reading: { rev: 6, now: d.now / 1000, boxes: [], listenerGap: {} } };
  await d.advance(2000);
  const boardReads = d.polls.length;
  d.sources[0].say({ rev: 6, quiet: "q1" });
  await d.advance(1000);
  assert.equal(d.polls.length, boardReads, "the board read a revision it holds");
  assert.equal(child.reads, 2, "the narrow view missed a revision the board already held");
  d.sources[0].fail(false);
  assert.equal(relay.up, false);
  assert.equal(child.downs, 2, "the narrow view was not told the line is down");
  relay.stop();
  d.sources[0].say({ rev: 7, quiet: "q1" });
  await d.advance(1000);
  assert.equal(child.reads, 2, "a narrow view that went still heard the line");
  assert.deepEqual(plain(d.problems), []);
});

test("the narrow view's host hands the line only to its own phone document, and lets go when it goes", () => {
  assert.match(HOST, /listen\(source, page\) \{\n\s+if \(!options\.line \|\| source !== childWindow\) return null;/);
  assert.match(HOST, /lost\(source\) \{\n\s+if \(source !== childWindow\) return;\n\s+if \(relay\) \{ relay\.stop\(\); relay = null; \}/);
  assert.ok(DESK.includes("view.createHost({ window, adapter, line: deskLine,"), "the board does not hand its line to the narrow view");
});

test("the narrow view reads on the timer only while the line is down, a reading failed or a send waits; the phone as always", () => {
  const fn = PHONE.slice(PHONE.indexOf("let pollRings = null;"), PHONE.indexOf("\n}\n", PHONE.indexOf("function pollTimed(){")) + 3);
  const ctx = vm.createContext({});
  vm.runInContext("let pollFails = 0, ops = [];\n" + fn +
    "\nglobalThis.t = { pollTimed, set rings(v){ pollRings = v; }, set fails(v){ pollFails = v; }, set ops(v){ ops = v; } };", ctx);
  assert.equal(ctx.t.pollTimed(), true, "the phone with no line stopped its timer");
  ctx.t.rings = { up: true };
  assert.equal(ctx.t.pollTimed(), false, "the narrow view still reads on the timer with the line up");
  ctx.t.fails = 1;
  assert.equal(ctx.t.pollTimed(), true, "a failed reading is not tried again");
  ctx.t.fails = 0;
  ctx.t.ops = [{ state: "unsure" }];
  assert.equal(ctx.t.pollTimed(), true, "a send waiting for its receipt is never asked after");
  ctx.t.ops = [{ state: "done" }];
  assert.equal(ctx.t.pollTimed(), false);
  ctx.t.rings = { up: false };
  assert.equal(ctx.t.pollTimed(), true, "the narrow view reads nothing with the board's line down");
  assert.ok(PHONE.includes("    else if (pollTimed()) schedulePoll(pollGap);\n"), "poll does not ask pollTimed before the next timed reading");
  assert.match(PHONE, /pollRings = typeof macHost\.listen === "function" \? macHost\.listen\(window, \{\n\s+held: \(\) => lastRev,\n\s+read: \(\) => schedulePoll\(0\),/);
  assert.ok(!PHONE.includes("board-line.js"), "the phone page loads the line's file");
});

// page.html's block, as index.html's, with its own poll and apply
function page(opts = {}){
  const w = world(opts);
  const polls = [], applied = [];
  Object.assign(w.ctx, {
    MOCK: false, docMockBoot(){},
    poll(){
      const call = { at: w.now, args: arguments.length };
      call.promise = new Promise(done => { call.done = done; });
      polls.push(call);
      return call.promise;
    },
    apply(state){ applied.push(state); },
  });
  vm.runInContext(
    "let lastState = null, pollFails = 0;\n" + PAGE_LINE +
    "\nglobalThis.probe = { get line(){ return pageLine; }, get ticker(){ return pageTicker; }," +
    " set last(v){ lastState = v; }, get last(){ return lastState; }, set fails(v){ pollFails = v; } };",
    w.ctx);
  return { ...w, polls, applied, probe: w.ctx.probe };
}

test("the /page view reads whole on every ring, runs today's timer while the line is down, and redraws its ages every 30 s", async () => {
  assert.ok(PAGE.includes('<script src="/board-line.js"></script>'), "the /page view does not load the line's file");
  assert.ok(PAGE_LINE.includes("pageTicker = setInterval(poll, 1200);"), "the /page view's timer is not today's line");
  const p = page();
  assert.equal(p.polls.length, 1, "the /page view did not read at load");
  assert.ok(p.probe.ticker);
  p.probe.last = { rev: 5, now: p.now / 1000, listenerGap: { facilitator: 200 }, boxes: [] };
  p.polls[0].done(); await p.flush();
  p.sources[0].say({ rev: 5, quiet: "q" });
  assert.equal(p.probe.ticker, 0);
  await p.advance(1000);
  assert.equal(p.polls.length, 2);
  assert.equal(p.polls[1].args, 0, "a ring on the /page view did not read the plain whole board");
  p.polls[1].done(); await p.flush();
  // the board's beat every 15 s, which reads nothing and keeps the line alive
  const beats = async ms => {
    for (let left = ms; left > 0; left -= 15000){
      await p.advance(Math.min(15000, left));
      p.sources[0].say({ rev: 5, quiet: "q" });
    }
  };
  await beats(29000);
  assert.equal(p.applied.length, 1, "the /page view's ages were not drawn again");
  // the tick runs 30 s after the load, when the reading held is 30 s old
  assert.ok(Math.abs(p.applied[0].listenerGap.facilitator - 230) < 0.01, `the quiet lane's gap was ${p.applied[0].listenerGap.facilitator}`);
  assert.equal(p.probe.last.listenerGap.facilitator, 200, "the tick wrote into the reading held");
  assert.equal(p.polls.length, 2, "a beat read the /page view's board");
  p.probe.fails = 3;
  await beats(30000);
  assert.equal(p.applied.length, 1, "the /page view drew over the unreachable banner");
  assert.equal(p.polls.length, 2);
  p.sources[0].fail(false);
  assert.ok(p.probe.ticker, "the /page view's timer did not come back with the line down");
  await p.advance(1200);
  assert.equal(p.polls.length, 3);
});

test("the board's timed refresh, the one that runs while the line is down, is today's line", () => {
  assert.ok(DESK_LINE.includes("deskTicker = setInterval(() => { if (!cardsMoving()) poll(true); }, 1200);"));
  assert.ok(DESK.includes('<script src="/board-line.js"></script>'), "the board does not load the line's file");
  assert.equal((DESK.match(/setInterval\(\(\) => \{ if \(!cardsMoving\(\)\) poll\(true\); \}, 1200\)/g) || []).length, 1,
    "the timed refresh runs from more than one place");
});
