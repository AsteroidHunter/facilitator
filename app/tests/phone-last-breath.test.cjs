const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// the phone's last breath note (m.html), run in a bare vm with the real reporter
// (card-report.js) beside it. No browser, phone, server or network: localStorage
// is a map two pages can share, the clock and the timers are moved by hand
const root = path.join(__dirname, "..");
const report = readFileSync(path.join(root, "card-report.js"), "utf8");
const html = readFileSync(path.join(root, "m.html"), "utf8");
const start = html.indexOf("// ---- the last breath");
const end = html.indexOf("// ---- the typing row", start);
assert.ok(start >= 0 && end > start, "missing the last breath block");
const block = html.slice(start, end);

const KEY = "phoneLastBreath";
// one page load. Pages made from the same store are two windows of one phone
function page(store, { developer = true, clock = { now: 1800000000000 } } = {}) {
  const windowEvents = {}, documentEvents = {}, beacons = [], fetched = [], timers = new Map();
  let writes = 0, serial = 0;
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  const fire = (events, name, event = {}) => { for (const fn of events[name] || []) fn(event); };
  const document = { hidden: false, addEventListener: listen(documentEvents) };
  const context = vm.createContext({
    Blob, URL, console, document,
    navigator: { onLine: true, sendBeacon: (url, body) => { beacons.push(body); return true; } },
    location: { href: "https://fixture.invalid/" },
    performance: { now: () => clock.now - 1800000000000 }, Date: { now: () => clock.now },
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn, ms) { timers.set(++serial, { fn, ms }); return serial; },
    clearInterval(id) { timers.delete(id); },
    addEventListener: listen(windowEvents),
    // what the page sends at once, through the reporter's immediate path
    fetch: async (url, init) => { fetched.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem(key, value) { writes++; store.set(key, String(value)); },
      removeItem: key => store.delete(key),
    },
  });
  context.window = context;
  vm.runInContext(report, context);
  context.startReporter("phone", { phoneHistory: false });
  vm.runInContext(`let phoneDeveloperMode = ${developer}; let selectedId = "m1200"; const els = {};`, context);
  vm.runInContext(block, context);
  const record = () => (store.has(KEY) ? JSON.parse(store.get(KEY)) : null);
  return {
    context, document, record, writes: () => writes,
    // the three second timer; the reporter's own one second watchdog is not it
    breath: () => [...timers.values()].filter(t => t.ms === 3000),
    watch: () => [...timers.values()].filter(t => t.ms === 1000),
    tick() { for (const t of this.breath()) t.fn(); },
    // the watchdog's tick, as the page's timer would run it
    watchTick() { for (const t of this.watch()) t.fn(); },
    // a tap or a key reaching the document, with whatever the event carries
    touch(name, event = {}) { fire(documentEvents, name, event); },
    // everything sent so far at once: the slow lines only
    sentNow() {
      const lines = [];
      for (const batch of fetched.splice(0)) for (const one of batch.reports) if (one.kind === "slow") lines.push(one);
      return lines;
    },
    sentBatches: () => fetched,
    run: code => vm.runInContext(code, context),
    hide() { document.hidden = true; fire(documentEvents, "visibilitychange"); },
    show() { document.hidden = false; fire(documentEvents, "visibilitychange"); },
    pagehide: () => fire(windowEvents, "pagehide"),
    // a window event the reporter listens for: an error, a rejection
    windowEvent: (name, event) => fire(windowEvents, name, event),
    // what the page sends as it goes away: the slow lines only
    async slow() {
      fire(windowEvents, "pagehide");
      const lines = this.sentNow();
      for (const body of beacons.splice(0)) {
        for (const one of JSON.parse(await body.text()).reports) if (one.kind === "slow") lines.push(one);
      }
      return lines;
    },
  };
}

test("with developer mode on a record is written, and written over every three seconds", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  f.context.noteDoing("render");
  f.run('selectedId = "m1201"');
  assert.equal(f.breath().length, 1, "one timer");
  clock.now += 3000; f.tick();
  const record = f.record();
  assert.equal(record.at, clock.now);
  assert.equal(record.box, "m1201");
  assert.equal(record.doing, "render");
  assert.equal(record.merging, false);
  assert.equal(record.closed, false);
  assert.equal(record.win, f.context.reportWho().window);
  assert.match(record.win, /^[a-f0-9]{16}$/);
  assert.equal(store.size, 1, "one key, written over");
  f.run('els.m1201 = { sentMerge: {} }');
  clock.now += 3000; f.tick();
  assert.equal(f.record().merging, true);
  assert.equal(f.record().at, clock.now);
});

test("with developer mode off nothing is written and nothing is sent", async () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { developer: false, clock });
  clock.now += 3000; f.tick(); clock.now += 3000; f.tick();
  f.hide(); f.show(); f.pagehide();
  assert.equal(f.writes(), 0);
  assert.equal(store.size, 0);
  assert.deepEqual(await f.slow(), []);
});

test("an old record is left alone and not reported while developer mode is off", async () => {
  const store = new Map();
  const old = page(store); // never hidden: it is the page that stopped
  const before = store.get(KEY);
  const f = page(store, { developer: false });
  assert.equal(store.get(KEY), before);
  assert.equal(f.writes(), 0);
  assert.deepEqual(await f.slow(), []);
});

test("switching developer mode off takes the record away and stops the writing", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  assert.ok(f.record());
  f.run("phoneDeveloperMode = false");
  clock.now += 3000; f.tick();
  assert.equal(f.record(), null);
  const writes = f.writes();
  clock.now += 3000; f.tick();
  assert.equal(f.writes(), writes);
});

test("hiding the page marks the record closed, and showing it carries on writing", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  clock.now += 3000; f.hide();
  assert.equal(f.record().closed, true);
  assert.equal(f.record().at, clock.now);
  assert.equal(f.breath().length, 0, "no timer while hidden");
  const writes = f.writes();
  clock.now += 60000; f.tick();
  assert.equal(f.writes(), writes, "nothing written while hidden");
  clock.now += 1000; f.show();
  assert.equal(f.record().closed, false);
  assert.equal(f.record().at, clock.now);
  assert.equal(f.breath().length, 1);
  clock.now += 3000; f.tick();
  assert.equal(f.record().at, clock.now);
  f.pagehide();
  assert.equal(f.record().closed, true, "closing the page also marks it closed");
});

test("a start that finds an unclosed record from another window reports one line and clears it", async () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const first = page(store, { clock });
  first.context.noteDoing("render");
  first.run('selectedId = "m1200"; els.m1200 = { sentMerge: {} }');
  clock.now += 3000; first.tick();
  const stopped = first.record();
  assert.equal(stopped.closed, false);
  // the first page is frozen: no more notes and no hide. A minute and a half later:
  clock.now += 90000;
  const second = page(store, { clock });
  // sent the moment the page starts, before it has been hidden or closed
  const lines = second.sentNow();
  assert.equal(lines.length, 1);
  assert.deepEqual(await second.slow(), [], "nothing left to send at the next hide");
  assert.match(lines[0].message, /^the page stopped while on screen/);
  assert.ok(lines[0].message.includes(stopped.win), "names the window that stopped");
  assert.ok(lines[0].message.includes("m1200"));
  assert.ok(lines[0].message.includes("90 s"));
  assert.equal(lines[0].late, 90000);
  assert.equal(lines[0].doing, "render, merge running");
  assert.equal(lines[0].count, 1);
  // the old record is gone; the new page has started its own
  assert.notEqual(second.record().win, stopped.win);
  assert.equal(second.record().win, second.context.reportWho().window);
  assert.equal(store.size, 1);
});

test("the record holds the timer's lateness, the last tap or key, and the last error", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  // nothing has happened yet: the fields say so
  f.tick();
  assert.equal(f.record().late, 0);
  assert.equal(f.record().lateMax, 0);
  assert.equal("input" in f.record(), false);
  assert.equal("err" in f.record(), false);
  // the watchdog's second ticks: one on time, one 1.5 s late, one on time again
  clock.now += 1000; f.watchTick();
  clock.now += 2500; f.watchTick();
  clock.now += 1000; f.watchTick();
  clock.now += 1; f.tick();
  assert.equal(f.record().late, 0, "the latest tick was on time");
  assert.equal(f.record().lateMax, 1500, "the worst of the last minute");
  // a tap, then a key, then an error
  const tapAt = clock.now += 500;
  f.touch("pointerdown");
  assert.deepEqual(f.record().input, undefined, "kept in memory until the next note");
  clock.now += 1000; f.tick();
  assert.deepEqual(f.record().input, { kind: "tap", at: tapAt });
  const keyAt = clock.now += 200;
  f.touch("keydown");
  const errorAt = clock.now += 300;
  f.windowEvent("error", { message: "x is not defined", filename: "https://fixture.invalid/m?v=1", lineno: 4321, colno: 7 });
  clock.now += 100; f.tick();
  assert.deepEqual(f.record().input, { kind: "key", at: keyAt });
  assert.deepEqual(f.record().err, { msg: "x is not defined", file: "/m", line: 4321, at: errorAt });
  // a minute-long freeze shows as the latest lateness, then as the worst of the last minute
  f.watchTick();
  clock.now += 61000; f.watchTick(); f.tick();
  assert.equal(f.record().late, 60000);
  assert.equal(f.record().lateMax, 60000);
  clock.now += 1000; f.watchTick(); f.tick();
  assert.equal(f.record().late, 0);
  assert.equal(f.record().lateMax, 60000, "still the worst of the last minute");
  for (let i = 0; i < 62; i++) { clock.now += 1000; f.watchTick(); }
  f.tick();
  assert.equal(f.record().lateMax, 0, "and gone once it is more than a minute old");
  // a failed request is not an error of the page's own, and does not replace the last one
  f.run('window.reportProblem("fetch", new Error("offline"))');
  f.tick();
  assert.equal(f.record().err.msg, "x is not defined");
  // small: a few hundred bytes even with the longest message the record keeps
  f.windowEvent("error", { message: "m".repeat(900), filename: "https://fixture.invalid/" + "p".repeat(300), lineno: 99999, colno: 1 });
  f.tick();
  assert.ok(f.record().err.msg.length <= 100);
  assert.ok(f.record().err.file.length <= 60);
  assert.ok(store.get(KEY).length < 500, "record is " + store.get(KEY).length + " bytes");
});

test("a tap or key is saved as a time and a kind, and nothing that was typed", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  const secret = "hunter2-card-text";
  f.touch("keydown", { key: secret, code: "KeyQ", target: { value: secret, textContent: secret } });
  f.touch("input", { data: secret, target: { value: secret } });
  f.touch("pointerdown", { target: { textContent: secret, id: secret }, clientX: 123, clientY: 456 });
  f.touch("keydown", { key: secret, isComposing: false });
  clock.now += 3000; f.tick();
  const text = store.get(KEY);
  assert.ok(!text.includes(secret), "no typed or card text in the record");
  assert.ok(!text.includes("KeyQ") && !text.includes("123") && !text.includes("456"));
  assert.deepEqual(Object.keys(f.record().input).sort(), ["at", "kind"]);
  assert.equal(f.record().input.kind, "key");
  // the same after the stopped page is reported: the secret stays out of what is sent
  clock.now += 20000;
  const second = page(store, { clock });
  const sent = JSON.stringify(second.sentNow());
  assert.ok(sent.includes("last key handled"));
  assert.ok(!sent.includes(secret));
  // and the listeners only keep a time and a kind: they never read the event
  assert.match(block, /document\.addEventListener\(type, \(\) => \{ breathInput = kind; breathInputAt = Date\.now\(\); \}/);
});

test("a stopped page is reported at once, with the old record's new fields in the line", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const first = page(store, { clock });
  first.context.noteDoing("render");
  first.run('selectedId = "m1267"');
  clock.now += 1000; first.watchTick();
  clock.now += 3500; first.watchTick();   // 2.5 s late
  clock.now += 1000; first.watchTick();
  const tapAt = clock.now += 200;
  first.touch("pointerdown");
  first.windowEvent("error", { message: "Script error.", filename: "", lineno: 0, colno: 0 });
  clock.now += 300; first.tick();          // the last note
  const noteAt = clock.now;
  // the page then froze; the next one starts 41 s later and says so before anything is hidden
  clock.now += 41000;
  const second = page(store, { clock });
  const batches = second.sentBatches();
  assert.equal(batches.length, 1, "one request, made while the page is still open");
  assert.equal(batches[0].page, "phone");
  assert.equal(batches[0].window, second.context.reportWho().window, "from the new page's window");
  const [line] = batches[0].reports;
  assert.equal(line.kind, "slow");
  assert.equal(line.box, "m1267");
  assert.equal(line.late, 41000);
  assert.match(line.message, /last note written 41 s before this page started/);
  assert.match(line.message, /its timer was 0 ms late at that note and 2500 ms late at worst/);
  assert.match(line.message, /last tap handled 0 s before the last note/);
  assert.match(line.message, /last error "Script error\." at \?:0, 0 s before the last note$/);
  assert.ok(line.message.length <= 500);
  assert.equal(noteAt - tapAt, 300);
  // a record from a build before these fields still reads
  const old = new Map([[KEY, JSON.stringify({ at: clock.now - 5000, box: "m9", doing: "render",
    merging: false, win: "0123456789abcdef", closed: false })]]);
  const third = page(old, { clock });
  const [older] = third.sentNow();
  assert.match(older.message, /unknown late at that note.*no tap or key handled yet; no error yet$/);
});

test("a record marked closed, or this window's own, reports nothing", async () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const first = page(store, { clock });
  first.hide();
  const second = page(store, { clock });
  assert.deepEqual(await second.slow(), []);
  const own = page(store, { clock });
  own.run("breathFind()");
  assert.deepEqual(await own.slow(), []);
  assert.ok(own.record(), "its own record stays");
});

test("a garbled record is ignored", async () => {
  const store = new Map([[KEY, "{not json"]]);
  const f = page(store);
  assert.deepEqual(await f.slow(), []);
  store.set(KEY, JSON.stringify({ at: "yesterday", win: 7 }));
  assert.deepEqual(await page(store).slow(), []);
});

test("the block is one timer and nothing in a frame loop", () => {
  assert.equal((block.match(/setInterval\(/g) || []).length, 1);
  assert.ok(!/requestAnimationFrame|setTimeout|MutationObserver/.test(block));
});
