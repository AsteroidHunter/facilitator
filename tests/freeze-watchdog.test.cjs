const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// the freeze watchdog in card-report.js, on the board page, with two clocks
// the test moves by hand: the page's own (performance.now) and the wall clock
// (Date.now), which keeps going while a Mac sleeps and the page's own does not
const source = readFileSync(path.join(__dirname, "..", "card-report.js"), "utf8");
function fixture() {
  let mono = 0, wall = 1800000000000;
  const intervals = [], windowEvents = {}, documentEvents = {}, beacons = [];
  const listen = store => (name, fn) => (store[name] ||= []).push(fn);
  const fire = (store, name, value = {}) => { for (const fn of store[name] || []) fn(value); };
  const document = { hidden: false, addEventListener: listen(documentEvents) };
  const context = vm.createContext({
    Blob, URL, console, document,
    navigator: { onLine: true, sendBeacon: (url, body) => { beacons.push(body); return true; } },
    location: { href: "https://fixture.invalid/" },
    performance: { now: () => mono }, Date: { now: () => wall },
    setTimeout: () => 0, clearTimeout() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    addEventListener: listen(windowEvents),
    fetch: async () => ({ ok: true }),
  });
  context.window = context;
  vm.runInContext(source, context);
  context.startReporter("board");
  return {
    document,
    // both clocks move together, as they do whenever the machine is awake
    pass(ms) { mono += ms; wall += ms; },
    // only the wall clock moves, as on a Mac that sleeps
    sleep(ms) { wall += ms; },
    tick() { for (const interval of intervals) if (interval.ms === 1000) interval.fn(); },
    hidden(value) { document.hidden = value; fire(documentEvents, "visibilitychange"); },
    fire: name => fire(windowEvents, name),
    // what the page would send as it goes away: the slow lines only
    async slow() {
      fire(windowEvents, "pagehide");
      const lines = [];
      for (const body of beacons.splice(0)) {
        for (const report of JSON.parse(await body.text()).reports) {
          if (report.kind === "slow") lines.push(report);
        }
      }
      return lines;
    },
  };
}

test("a visible page three seconds late is one slow line", async () => {
  const f = fixture();
  f.pass(4000); f.tick();
  const lines = await f.slow();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].message, "the main thread was blocked");
  assert.equal(lines[0].late, 3000);
});

test("a page hidden for fifty seconds and shown again logs nothing", async () => {
  const f = fixture();
  f.pass(1000); f.tick();
  f.hidden(true); f.pass(50000); f.hidden(false);
  f.pass(1000); f.tick();
  assert.deepEqual(await f.slow(), []);
});

test("a tick that runs while hidden, or before a show arrives, logs nothing", async () => {
  const f = fixture();
  f.hidden(true); f.pass(50000); f.tick();
  f.pass(30000); f.tick();
  // visible again with no event yet: the gap still spans a hidden stretch
  f.hidden(true); f.pass(40000);
  f.document.hidden = false; f.tick();
  assert.deepEqual(await f.slow(), []);
});

test("a skipped gap is only one tick: the next real block is logged", async () => {
  const f = fixture();
  f.hidden(true); f.pass(50000); f.hidden(false);
  f.pass(1000); f.tick();
  f.pass(5000); f.tick();
  const lines = await f.slow();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].late, 4000);
});

test("a block that starts right as the page is shown is still logged", async () => {
  const f = fixture();
  f.hidden(true); f.pass(50000); f.hidden(false);
  f.pass(3500); f.tick();
  const lines = await f.slow();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].late, 2500);
});

test("a page restored from the back cache logs nothing for its time away", async () => {
  const f = fixture();
  f.fire("pagehide"); f.pass(90000); f.fire("pageshow");
  f.pass(1000); f.tick();
  assert.deepEqual(await f.slow(), []);
});

test("a Mac asleep for an hour with the page visible logs nothing", async () => {
  const f = fixture();
  f.pass(1000); f.tick();
  f.pass(500); f.sleep(3600000); f.pass(500); f.tick();
  // and a wake slow enough to run late on the page's own clock as well
  f.pass(500); f.sleep(600000); f.pass(3000); f.tick();
  f.pass(1000); f.tick();
  assert.deepEqual(await f.slow(), []);
});

test("a long block with the clocks agreeing is logged, however long", async () => {
  // this is also what a sleep looks like on a browser whose own clock runs
  // through sleep: nothing tells it from a real freeze, so it is logged
  const f = fixture();
  f.pass(1000); f.tick();
  f.pass(171000); f.tick();
  const lines = await f.slow();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].late, 170000);
});
