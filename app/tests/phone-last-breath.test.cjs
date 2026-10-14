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
  const windowEvents = {}, documentEvents = {}, beacons = [], timers = new Map();
  let writes = 0, serial = 0;
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  const fire = (events, name) => { for (const fn of events[name] || []) fn({}); };
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
    fetch: async () => ({ ok: true }),
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
    // the ten second timer; the reporter's own one second watchdog is not it
    breath: () => [...timers.values()].filter(t => t.ms === 10000),
    tick() { for (const t of this.breath()) t.fn(); },
    run: code => vm.runInContext(code, context),
    hide() { document.hidden = true; fire(documentEvents, "visibilitychange"); },
    show() { document.hidden = false; fire(documentEvents, "visibilitychange"); },
    pagehide: () => fire(windowEvents, "pagehide"),
    // what the page sends as it goes away: the slow lines only
    async slow() {
      fire(windowEvents, "pagehide");
      const lines = [];
      for (const body of beacons.splice(0)) {
        for (const one of JSON.parse(await body.text()).reports) if (one.kind === "slow") lines.push(one);
      }
      return lines;
    },
  };
}

test("with developer mode on a record is written, and written over every ten seconds", () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { clock });
  f.context.noteDoing("render");
  f.run('selectedId = "m1201"');
  assert.equal(f.breath().length, 1, "one timer");
  clock.now += 10000; f.tick();
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
  clock.now += 10000; f.tick();
  assert.equal(f.record().merging, true);
  assert.equal(f.record().at, clock.now);
});

test("with developer mode off nothing is written and nothing is sent", async () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const f = page(store, { developer: false, clock });
  clock.now += 10000; f.tick(); clock.now += 10000; f.tick();
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
  clock.now += 10000; f.tick();
  assert.equal(f.record(), null);
  const writes = f.writes();
  clock.now += 10000; f.tick();
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
  clock.now += 10000; f.tick();
  assert.equal(f.record().at, clock.now);
  f.pagehide();
  assert.equal(f.record().closed, true, "closing the page also marks it closed");
});

test("a start that finds an unclosed record from another window reports one line and clears it", async () => {
  const clock = { now: 1800000000000 }, store = new Map();
  const first = page(store, { clock });
  first.context.noteDoing("render");
  first.run('selectedId = "m1200"; els.m1200 = { sentMerge: {} }');
  clock.now += 10000; first.tick();
  const stopped = first.record();
  assert.equal(stopped.closed, false);
  // the first page is frozen: no more notes and no hide. A minute and a half later:
  clock.now += 90000;
  const second = page(store, { clock });
  const lines = await second.slow();
  assert.equal(lines.length, 1);
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
