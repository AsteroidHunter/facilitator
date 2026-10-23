// The phone's service worker and the page's code: the worker never cuts a
// download of the page's shared files off and holds no copy of them to fall
// back to, so what the app runs is the Mac's latest files or nothing.
//
// Before this change the worker asked for card-markdown.js, card-logic.js,
// compose-format.js and the sheet itself, gave all four 8 seconds in total, and
// cut a download off even while it was arriving. Now it does not ask for them at
// all: the browser does, and waits however long they take.
//
// The worker runs in node:vm on a clock this test moves by hand. No browser
// opens and port 8877 is never touched.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const ORIGIN = "https://board.test";
const PAGE_CODE = ["/card-markdown.js", "/card-logic.js", "/compose-format.js", "/card-tokens.css"];
const flush = () => new Promise(resolve => setImmediate(resolve));

// a clock the test moves by hand
function fakeClock() {
  let now = 1_000_000, seq = 0;
  const timers = new Map();
  return {
    get now() { return now; },
    pending: () => timers.size,
    setTimeout(fn, ms = 0, ...args) {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args, seq: id });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await flush();
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at > until) continue;
          if (!next || timer.at < next.timer.at) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn(...next.timer.args);
      }
      now = until;
      await flush();
    },
  };
}

// the worker, with everything it can ask of the network or its cache written down
async function loadWorker({ kept = new Map() } = {}) {
  const clock = fakeClock();
  const handlers = {};
  const seen = { fetches: [], timeouts: [], adds: [], addAll: 0, puts: [] };
  const context = {
    URL, Promise, Response, Headers, AbortController,
    setTimeout: (...args) => clock.setTimeout(...args),
    clearTimeout: id => clock.clearTimeout(id),
    // any deadline the worker makes for itself comes through here
    AbortSignal: { timeout: ms => { seen.timeouts.push(ms); return new AbortController().signal; } },
    fetch: (request, init) => new Promise((resolve, reject) => {
      seen.fetches.push({ request, init, resolve, reject });
    }),
    caches: {
      keys: async () => [],
      match: async request => kept.get(typeof request === "string" ? request : new URL(request.url).pathname),
      open: async () => ({
        add: async path => { seen.adds.push(path); },
        addAll: async () => { seen.addAll += 1; },
        put: async (request, response) => { seen.puts.push(new URL(request.url).pathname); },
      }),
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {}, registration: {}, clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(await readFile(path.join(ROOT, "m-sw.js"), "utf8"), context, { filename: "m-sw.js" });
  return { handlers, clock, seen };
}

// a script, sheet or picture the page asks for, and whether the worker took it
function askFor(handlers, pathname, mode = "no-cors") {
  let answered = null;
  handlers.fetch({
    request: { url: ORIGIN + pathname, mode, method: "GET" },
    respondWith: promise => { answered = promise; },
  });
  return answered;
}

test("the worker does not touch the page's code: no deadline, no copy, nothing to fall back to", async () => {
  const { handlers, seen } = await loadWorker({
    // even with an old copy lying in the cache, the worker has no use for it
    kept: new Map(PAGE_CODE.map(p => [p, new Response("// an old copy")])),
  });
  for (const pathname of PAGE_CODE) {
    assert.equal(askFor(handlers, pathname), null, `the worker answered for ${pathname}`);
  }
  assert.equal(seen.fetches.length, 0, "the worker asked the Mac for the page's code itself");
  assert.deepEqual(seen.timeouts, [], "the worker started a deadline of its own on the page's code");
  assert.deepEqual(seen.puts, [], "the worker kept a copy of the page's code");
});

test("an install keeps the squid and the editor and nothing of the page's code", async () => {
  const { handlers, seen } = await loadWorker();
  let work = null;
  handlers.install({ waitUntil: promise => { work = promise; } });
  await work;
  assert.deepEqual(seen.adds.sort(), ["/cm-markdown.js", "/m-splash-squid.png"]);
  assert.equal(seen.addAll, 0, "the install fetched a list of the page's files");
});

test("the editor's first download is waited for however long it takes, and arrives whole", async () => {
  const { handlers, clock, seen } = await loadWorker();
  const answered = askFor(handlers, "/cm-markdown.js");
  assert.ok(answered, "the worker left the editor bundle alone");
  let result = null;
  answered.then(value => { result = value; });
  await clock.advance(0);
  assert.equal(seen.fetches.length, 1);
  assert.equal(seen.fetches[0].init, undefined, "the editor was asked for with a deadline or a signal");
  // the answer starts, then the rest takes more than a minute
  await clock.advance(90_000);
  assert.equal(result, null, "the worker gave up on the editor download");
  assert.equal(clock.pending(), 0, "a timer is still running on the editor download");
  assert.deepEqual(seen.timeouts, []);
  const bundle = new Response("export const editor = 1;", { status: 200 });
  seen.fetches[0].resolve(bundle);
  await clock.advance(0);
  assert.equal(result, bundle);
  assert.equal(await result.text(), "export const editor = 1;");
  assert.deepEqual(seen.puts, ["/cm-markdown.js"], "the editor was not kept for the next open");
});

test("a download that fails is the browser's failure to report, not a copy to serve", async () => {
  const { handlers, seen } = await loadWorker({ kept: new Map([["/cm-markdown.js", undefined]]) });
  const answered = askFor(handlers, "/cm-markdown.js");
  await flush();
  seen.fetches[0].reject(new TypeError("Failed to fetch"));
  await assert.rejects(answered, /Failed to fetch/);
});

test("the worker has a new cache name, and keeps its other jobs", async () => {
  const { handlers } = await loadWorker();
  const source = await readFile(path.join(ROOT, "m-sw.js"), "utf8");
  assert.match(source, /const CACHE = "facilitator-m-13";/, "the worker kept the old cache name");
  const asked = await new Promise(resolve => {
    handlers.message({ data: { kind: "diagnostic-worker" }, ports: [{ postMessage: resolve }], waitUntil() {} });
  });
  assert.deepEqual({ ...asked }, { kind: "diagnostic-worker", cache: "facilitator-m-13" });
  for (const type of ["push", "notificationclick", "install", "activate", "fetch", "message"]) {
    assert.equal(typeof handlers[type], "function", `the worker lost its ${type} job`);
  }
});
