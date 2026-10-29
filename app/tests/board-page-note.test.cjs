const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// the board's page note (index.html), run in a bare vm with the real reporter
// (card-report.js) beside it. No browser, server or network: sessionStorage is
// a map that two loads of the same tab share, and the clock, the timers and the
// JS heap are moved by hand
const root = path.join(__dirname, "..");
const report = readFileSync(path.join(root, "card-report.js"), "utf8");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const start = html.indexOf("// ---- the page note");
const end = html.indexOf("// ---- the lane's worktrees", start);
assert.ok(start >= 0 && end > start, "missing the page note block");
const block = html.slice(start, end);

const KEY = "facilitator-page-note";
const MB = 1048576;
const T0 = 1800000000000;

// one load of the page in one tab. Loads made from the same store are the same
// tab loading again, as a reload after the page's process ended is
function page(store, { clock = { now: T0 }, heap = { used: 300 * MB }, nav = "reload",
                       discarded = false, memory = true } = {}) {
  const windowEvents = {}, documentEvents = {}, beacons = [], fetched = [], timers = new Map();
  let writes = 0, serial = 0;
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  const fire = (events, name, event = {}) => { for (const fn of events[name] || []) fn(event); };
  const document = {
    hidden: false, wasDiscarded: discarded, addEventListener: listen(documentEvents),
    getElementById: id => (id === "npversion" ? { textContent: "v0.3.59" } : null),
  };
  const performance = {
    now: () => clock.now - T0,
    getEntriesByType: type => (type === "navigation" ? [{ type: nav }] : []),
  };
  if (memory) Object.defineProperty(performance, "memory", { get: () => ({ usedJSHeapSize: heap.used }) });
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    Blob, URL, console, document, performance, Date: FakeDate,
    navigator: { onLine: true, userAgent: "Mozilla/5.0 (Macintosh) Chrome/156.0.0.0 Safari/537.36",
                 sendBeacon: (url, body) => { beacons.push(body); return true; } },
    location: { href: "http://127.0.0.1:8877/" },
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn, ms) { timers.set(++serial, { fn, ms }); return serial; },
    clearInterval(id) { timers.delete(id); },
    addEventListener: listen(windowEvents),
    // what the page sends at once, through the reporter's immediate path
    fetch: async (url, init) => { fetched.push({ url, ...JSON.parse(init.body) }); return { ok: true, status: 200 }; },
    sessionStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem(key, value) { writes++; store.set(key, String(value)); },
      removeItem: key => store.delete(key),
    },
  });
  context.window = context;
  vm.runInContext(report, context);
  context.startReporter("board");
  vm.runInContext('let selectedId = "m1200";', context);
  vm.runInContext(block, context);
  const record = () => (store.has(KEY) ? JSON.parse(store.get(KEY)) : null);
  return {
    context, document, record, writes: () => writes, heap,
    // the minute timer; the reporter's own one second watchdog is not it
    minute: () => [...timers.values()].filter(t => t.ms === 60000),
    watch: () => [...timers.values()].filter(t => t.ms === 1000),
    tick() { for (const t of this.minute()) t.fn(); },
    watchTick() { for (const t of this.watch()) t.fn(); },
    key(event = {}) { fire(documentEvents, "keydown", event); },
    run: code => vm.runInContext(code, context),
    // everything sent so far at once: the error lines only, each with its batch
    sentNow() {
      const lines = [];
      for (const batch of fetched.splice(0)) {
        for (const one of batch.reports) if (one.kind === "error") lines.push({ batch, line: one });
      }
      return lines;
    },
    hide() { document.hidden = true; fire(documentEvents, "visibilitychange"); },
    show() { document.hidden = false; fire(documentEvents, "visibilitychange"); },
    pagehide: (event = { persisted: false }) => fire(windowEvents, "pagehide", event),
    pageshow: event => fire(windowEvents, "pageshow", event),
    windowEvent: (name, event) => fire(windowEvents, name, event),
    // what the page sends as it goes away: page note lines only
    async atHide() {
      fire(windowEvents, "pagehide", { persisted: false });
      const lines = this.sentNow().map(one => one.line);
      for (const body of beacons.splice(0)) {
        for (const one of JSON.parse(await body.text()).reports) if (/^the page stopped/.test(one.message)) lines.push(one);
      }
      return lines;
    },
  };
}

test("the note is written when the page loads, with one minute timer", () => {
  const clock = { now: T0 }, store = new Map();
  const f = page(store, { clock });
  const note = f.record();
  assert.ok(note, "a note as soon as the page starts");
  assert.equal(note.win, f.context.reportWho().window);
  assert.match(note.win, /^[a-f0-9]{16}$/);
  assert.equal(note.start, T0);
  assert.equal(note.at, T0);
  assert.equal(note.box, "m1200");
  assert.equal(note.shown, true);
  assert.deepEqual(note.heaps, [300]);
  assert.equal(note.peak, 300);
  assert.equal(note.version, "v0.3.59");
  assert.equal("key" in note, false, "no key pressed yet");
  assert.equal("err" in note, false, "no error yet");
  assert.equal(f.minute().length, 1, "one timer, once a minute");
  assert.equal(f.writes(), 1, "one write on load");
  assert.equal(store.size, 1);
});

test("each minute the note is written over with the time, the heap and the last key", () => {
  const clock = { now: T0 }, store = new Map();
  const f = page(store, { clock });
  f.run('selectedId = "m1201"');
  const heaps = [310, 320, 450, 330, 340, 350];
  for (const [i, mb] of heaps.entries()) {
    f.heap.used = mb * MB;
    if (i === 3) { clock.now += 20000; f.key({ key: "q" }); clock.now += 40000; }
    else clock.now += 60000;
    f.tick();
  }
  const note = f.record();
  assert.equal(f.writes(), 1 + heaps.length, "one write a minute and nothing else");
  assert.equal(note.at, clock.now);
  assert.equal(note.start, T0, "the start stays the page's start");
  assert.equal(note.box, "m1201");
  assert.deepEqual(note.heaps, [320, 450, 330, 340, 350], "the last five readings");
  assert.equal(note.peak, 450, "the most it has been");
  assert.equal(note.key, T0 + 3 * 60000 + 20000, "the time of the last key press");
  assert.equal(store.size, 1, "one key, written over");
  // a key press only keeps a time in memory until the next write
  const writes = f.writes();
  f.key(); f.key(); f.key();
  assert.equal(f.writes(), writes);
});

test("the note holds the timer's lateness and where the last error was thrown, never what was typed", () => {
  const clock = { now: T0 }, store = new Map();
  const f = page(store, { clock });
  const secret = "hunter2-card-text";
  clock.now += 1000; f.watchTick();
  clock.now += 3500; f.watchTick();   // 2.5 s late
  f.key({ key: secret, code: "KeyQ", target: { value: secret, textContent: secret } });
  const errorAt = clock.now += 100;
  f.windowEvent("error", { message: secret, filename: "http://127.0.0.1:8877/card-logic.js?v=1", lineno: 4321, colno: 7 });
  clock.now += 55000; f.tick();   // the late tick is still inside the minute the watchdog looks back over
  const note = f.record();
  assert.equal(note.late, 2500);
  assert.equal(note.lateMax, 2500);
  assert.deepEqual(note.err, { file: "/card-logic.js", line: 4321, at: errorAt });
  const text = store.get(KEY);
  assert.ok(!text.includes(secret) && !text.includes("KeyQ"), "no typed, card or error text in the note");
  assert.ok(text.length < 500, "note is " + text.length + " bytes");
  // and the listener never reads the event
  assert.match(block, /document\.addEventListener\("keydown", \(\) => \{ pageNoteKey = Date\.now\(\); \}, \{ capture: true, passive: true \}\)/);
});

test("hiding the page keeps the note; a normal close clears it and stops the timer", () => {
  const clock = { now: T0 }, store = new Map();
  const f = page(store, { clock });
  clock.now += 60000; f.hide(); f.tick();
  assert.ok(f.record(), "a page that dies while hidden must still be found");
  assert.equal(f.record().shown, false);
  f.show();
  f.pagehide();
  assert.equal(f.record(), null, "a normal close takes the note away");
  assert.equal(f.minute().length, 0, "and stops the timer");
  const writes = f.writes();
  clock.now += 60000; f.tick();
  assert.equal(f.writes(), writes);
  // a load from the page view's history that is not a cache restore does nothing
  f.pageshow({ persisted: false });
  assert.equal(f.record(), null);
  // back from the back/forward cache, the page is running again and says so
  f.pageshow({ persisted: true });
  assert.ok(f.record());
  assert.equal(f.record().at, clock.now);
  assert.equal(f.minute().length, 1);
});

test("a load that finds the note sends it once, at once, and clears it", async () => {
  const clock = { now: T0 }, store = new Map();
  const first = page(store, { clock });
  first.run('selectedId = "m1500"');
  for (const mb of [900, 950, 1000]) { first.heap.used = mb * MB; clock.now += 60000; first.tick(); }
  clock.now += 15000; first.key();
  clock.now += 45000; first.heap.used = 1100 * MB; first.tick();   // the last note
  const last = first.record();
  // the page's process ends here: no pagehide. The same tab reloads 52 s later
  clock.now += 52000;
  const second = page(store, { clock });
  const sent = second.sentNow();
  assert.equal(sent.length, 1, "one line, sent while the new page is still open");
  const [{ batch, line }] = sent;
  assert.equal(batch.url, "/clientlog");
  assert.equal(batch.page, "board");
  assert.equal(batch.client, "chrome");
  assert.equal(batch.window, second.context.reportWho().window, "from the new load's window");
  assert.equal(line.kind, "error");
  assert.equal(line.box, "m1500");
  assert.equal(line.late, 52000);
  assert.equal(line.count, 1);
  assert.equal(line.message,
    "the page stopped without closing: window " + last.win + " (v0.3.59), open 4 min 0 s, card m1500, on screen; "
    + "last note 2027-01-15T08:04:00Z, 52 s before this load; "
    + "JS heap MB at the last 5 notes 300, 900, 950, 1000, 1100, at most 1100 MB; "
    + "timer 0 ms late, 0 ms at worst in the last minute; "
    + "last key 45 s before the last note; this load: reload, not discarded; no error");
  // cleared: the new load's own note replaced it, and looking again finds nothing to send
  assert.equal(second.record().win, second.context.reportWho().window);
  assert.notEqual(second.record().win, last.win);
  assert.equal(second.record().start, clock.now);
  second.run("pageNoteFind()");
  assert.deepEqual(second.sentNow(), [], "the old note is not sent twice");
  assert.equal(second.record().win, second.context.reportWho().window, "and the load's own note is no news");
  // a load after a normal close finds nothing
  const store2 = new Map();
  const closed = page(store2, { clock });
  closed.pagehide();
  const after = page(store2, { clock });
  assert.deepEqual(after.sentNow(), []);
  assert.deepEqual(await after.atHide(), [], "and has nothing held back for its own hide");
});

test("the line keeps only the characters the board's log keeps, and says what Chrome did", () => {
  const clock = { now: T0 }, store = new Map();
  const first = page(store, { clock, memory: false });
  first.run('selectedId = "t12.3"');
  first.windowEvent("error", { message: "boom", filename: "", lineno: 0, colno: 0 });
  clock.now += 3 * 3600000 + 5 * 60000; first.hide(); first.tick();
  clock.now += 7000;
  const second = page(store, { clock, nav: "back_forward", discarded: true });
  const [{ line }] = second.sentNow();
  assert.match(line.message, /, card t12\.3, hidden;/);
  assert.match(line.message, /open 3 h 5 min, card t12/);
  assert.match(line.message, /JS heap not readable;/);
  assert.match(line.message, /no key pressed; this load: back forward, discarded by Chrome; last error at unknown:0, 3 h 5 min before the last note$/);
  // the board's log drops a message's words whole for any other character
  assert.match(line.message, /^[A-Za-z0-9 ,.:;()/-]*$/);
  assert.ok(line.message.length <= 500);
});

test("a note with numbers missing still reads, a single reading says so, and the longest line fits", () => {
  const clock = { now: T0 };
  const sparse = new Map([[KEY, JSON.stringify({ win: "0123456789abcdef", start: T0 - 60000, at: T0 - 5000, heaps: [12] })]]);
  const [{ line }] = page(sparse, { clock }).sentNow();
  assert.match(line.message, /\(unknown version\), open 55 s, hidden;/);
  assert.match(line.message, /JS heap MB at the last note 12, at most unknown; timer unknown late, unknown at worst/);
  assert.ok(!/NaN|null|undefined/.test(line.message), line.message);
  // the longest a real note makes: a long card id, four-digit readings, an error at a long route
  const big = new Map([[KEY, JSON.stringify({ win: "0123456789abcdef", start: T0 - 99 * 3600000, at: T0 - 59000,
    box: "m123456.12.34", shown: true, heaps: [9999, 9999, 9999, 9999, 9999], peak: 9999, late: 600000, lateMax: 600000,
    key: T0 - 118000, version: "v10.100.1000", err: { file: "/" + "p".repeat(59), line: 99999, at: T0 - 3600000 * 98 } })]]);
  const [{ line: long }] = page(big, { clock, nav: "back_forward" }).sentNow();
  assert.ok(long.message.length < 500, "longest line is " + long.message.length + " characters");
  assert.match(long.message, /last error at \/p{39}:99999, 97 h 59 min before the last note$/);
});

test("a garbled or partial note is cleared and nothing is sent", () => {
  for (const bad of ["{not json", JSON.stringify({ at: "yesterday", start: 1 }), JSON.stringify({ at: 5 }), "null"]) {
    const store = new Map([[KEY, bad]]);
    const f = page(store);
    assert.deepEqual(f.sentNow(), [], bad);
    assert.equal(f.record().win, f.context.reportWho().window, "the new load writes its own");
  }
});

test("the block is one timer and nothing that runs per frame or per keystroke beyond a time", () => {
  assert.equal((block.match(/setInterval\(/g) || []).length, 1);
  assert.ok(!/requestAnimationFrame|setTimeout|MutationObserver|localStorage/.test(block));
  assert.equal((block.match(/sessionStorage\.setItem\(/g) || []).length, 1, "one place writes the note");
});
