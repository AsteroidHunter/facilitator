// Shared by the tests of what the phone records about its notifications: the
// service worker run against a fake IndexedDB and a fake board, and the page's
// start-up check lifted out of m.html and run against a small fake browser.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const WORKER_SOURCE = readFileSync(process.env.PHONE_WORKER_SOURCE || path.join(ROOT, "m-sw.js"), "utf8");
const PAGE_SOURCE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const later = fn => setImmediate(fn);

// Just enough of IndexedDB for the worker's one store: transactions that
// complete once their requests are done, add / getAll / getAllKeys / delete,
// auto-increment keys that are never reused, and a read-only mode that refuses
// writes. `fail` makes every open fail the way a browser with storage turned
// off does.
function fakeIndexedDB() {
  const dbs = new Map();
  const idb = {
    fail: false,
    opens: 0,
    open(name) {
      idb.opens++;
      const request = {};
      later(() => {
        if (idb.fail) {
          request.error = new Error("storage unavailable");
          request.onerror?.({ target: request });
          return;
        }
        let db = dbs.get(name);
        const fresh = !db;
        if (fresh) dbs.set(name, db = { stores: new Map() });
        request.result = {
          createObjectStore(store, options) {
            db.stores.set(store, { key: options.keyPath, next: 1, rows: new Map() });
          },
          transaction(store, mode) {
            const held = db.stores.get(store);
            const tx = { pending: 0, done: false };
            const settle = () => later(() => {
              if (!tx.pending && !tx.done) { tx.done = true; tx.oncomplete?.({ target: tx }); }
            });
            const ask = (writes, work) => {
              if (writes && mode === "readonly") throw new Error("ReadOnlyError");
              const req = {};
              tx.pending++;
              later(() => {
                req.result = work();
                req.onsuccess?.({ target: req });
                tx.pending--;
                settle();
              });
              return req;
            };
            tx.objectStore = () => ({
              add: row => ask(true, () => {
                const key = held.next++;
                held.rows.set(key, plain({ ...row, [held.key]: key }));
                return key;
              }),
              getAll: () => ask(false, () => [...held.rows.values()].map(plain)),
              getAllKeys: () => ask(false, () => [...held.rows.keys()]),
              delete: key => ask(true, () => { held.rows.delete(key); }),
            });
            settle();
            return tx;
          },
          close() {},
        };
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    },
    // what the worker has kept, read straight out of the fake
    rows(store = "pushes", name = "facilitator-m-push-log") {
      const held = dbs.get(name)?.stores.get(store);
      return held ? [...held.rows.values()].map(plain) : [];
    },
  };
  return idb;
}

const OK = { ok: true, status: 200, json: async () => ({ authenticated: true }) };

// The worker's script in a fresh context. `net` says how the fake board answers:
//   auth(init)  -> what GET /auth/check does (a response, or a throw)
//   log(body)   -> what POST /clientlog does
// `clock.now` is the worker's idea of the time, moved by the fake board so a
// slow check can be told without waiting for one.
async function loadWorker({ idb = fakeIndexedDB(), net = {}, clock = { now: 1_800_000_000_000 },
                            noIndexedDB = false, shouldShow = () => {}, random } = {}) {
  const handlers = {};
  // the windows the worker finds and what opening one does, for a tapped notification
  const windows = { all: async () => [], open: async () => {}, asked: [], opened: [] };
  const shown = [];
  const calls = [];
  const order = [];
  const deadlines = [];
  const board = {
    auth: async () => OK,
    log: async () => ({ ok: true, status: 200 }),
    ...net,
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const context = {
    URL, Promise, Math, Number, JSON, Date: FakeDate, RegExp, Error, DOMException,
    // a deadline that comes after a few real milliseconds, with the reason a browser gives
    AbortSignal: {
      timeout(ms) {
        deadlines.push(ms);
        const stop = new AbortController();
        setTimeout(() => stop.abort(new DOMException("signal timed out", "TimeoutError")), 15);
        return stop.signal;
      },
    },
    fetch: async (url, init = {}) => {
      assert.ok(url === "/auth/check" || url === "/clientlog", `the worker asked for ${url}`);
      calls.push({ url, init });
      if (url === "/auth/check") return board.auth(init);
      order.push("log");
      return board.log(JSON.parse(init.body), init);
    },
    caches: { keys: async () => [], open: async () => ({ addAll: async () => {} }) },
    self: {
      location: { origin: "https://board.test" },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {},
      registration: {
        showNotification: async (title, options) => {
          order.push("show");
          await shouldShow(title, options);
          shown.push({ title, options: plain(options) });
        },
      },
      clients: {
        claim: async () => {},
        matchAll: async options => { windows.asked.push(plain(options)); return windows.all(options); },
        openWindow: async target => { windows.opened.push(target); return windows.open(target); },
      },
    },
  };
  if (!noIndexedDB) context.indexedDB = idb;
  // the browser's source of random bytes, when a test wants to choose them
  if (random) context.crypto = { getRandomValues: bytes => { bytes.set(random); return bytes; } };
  vm.runInNewContext(WORKER_SOURCE, context, { filename: "m-sw.js" });
  const dispatch = async (type, event = {}) => {
    const work = [];
    handlers[type]({ ...event, waitUntil: promise => { work.push(promise); } });
    // A handler can extend the event again while its routing promise is live.
    let from = 0;
    while (from < work.length) {
      const batch = work.slice(from);
      from = work.length;
      const settled = await Promise.allSettled(batch);
      const failed = settled.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  };
  const push = (payload = { box: "m101", title: "First card" }) =>
    dispatch("push", { data: { json: () => payload } });
  const logged = () => calls.filter(call => call.url === "/clientlog").map(call => JSON.parse(call.init.body));
  const closed = { n: 0 };
  const click = (box, notification = {}) => dispatch("notificationclick", {
    notification: { data: box === undefined ? undefined : { box }, close() { closed.n++; }, ...notification },
  });
  return { dispatch, push, click, closed, shown, calls, order, deadlines, idb, clock, board, logged, handlers, windows };
}

// The page's start-up check, as written in m.html, run against a fake browser.
function pageBlock() {
  const from = PAGE_SOURCE.indexOf("let noticeCheckedAt = 0;");
  assert.ok(from > 0, "the start-up check is not in m.html");
  const to = PAGE_SOURCE.indexOf("</script>", from);
  assert.ok(to > from, "the start-up check does not end before the script does");
  return PAGE_SOURCE.slice(from, to);
}

// Each option names what the phone has:
//   permission  "granted" | "denied" | "default" | "unsupported" (no Notification at all)
//   worker      false: no service worker support; "none": supported, never registered
//   subscription  "yes" | "no" | "throws"
//   pushManager   false: the page has no PushManager
function startPage({ permission = "granted", worker = true, subscription = "yes", pushManager = true,
                     active = true, controller = true, registered = false, clock = { now: 1_800_000_000_000 } } = {}) {
  const reports = [];
  const posted = [];
  const asked = { registration: 0, subscription: 0 };
  const windowEvents = {}, documentEvents = {};
  const listen = store => (name, fn) => (store[name] ||= []).push(fn);
  const address = "https://push.example.test/send/very-secret-address-0123456789";
  const mailbox = { postMessage: message => posted.push(plain(message)) };
  const registration = {
    active: active ? mailbox : null,
    pushManager: {
      async getSubscription() {
        asked.subscription++;
        if (subscription === "throws") throw new Error("the push manager refused");
        return subscription === "yes"
          ? { endpoint: address, toJSON: () => ({ endpoint: address, keys: { p256dh: "SECRET-P256", auth: "SECRET-AUTH" } }) }
          : null;
      },
    },
  };
  const navigator = {};
  if (worker) {
    navigator.serviceWorker = {
      controller: controller ? mailbox : null,
      getRegistration: async () => { asked.registration++; return worker === "none" ? undefined : registration; },
    };
  }
  class FakeDate extends Date { static now() { return clock.now; } }
  const context = vm.createContext({ macHost: null,
    Date: FakeDate, Promise, JSON, Array,
    navigator,
    document: { hidden: false, addEventListener: listen(documentEvents) },
    addEventListener: listen(windowEvents),
  });
  context.window = context;
  if (permission !== "unsupported") context.Notification = { permission };
  if (pushManager) context.PushManager = function PushManager() {};
  context.reportNotice = report => { reports.push(plain(report)); };
  vm.runInContext("let swReg = null;", context);
  if (registered) vm.runInContext("swReg = __registration;", Object.assign(context, { __registration: registration }));
  vm.runInContext(pageBlock(), context, { filename: "m.html" });
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
  return {
    reports, posted, asked, address, clock, settle,
    fire: (name, value = {}) => { for (const fn of windowEvents[name] || []) fn(value); },
    visible: () => { context.document.hidden = false; for (const fn of documentEvents.visibilitychange || []) fn({}); },
    hide: () => { context.document.hidden = true; for (const fn of documentEvents.visibilitychange || []) fn({}); },
    listeners: () => ({ window: Object.keys(windowEvents), document: Object.keys(documentEvents) }),
  };
}

module.exports = { ROOT, OK, plain, fakeIndexedDB, loadWorker, startPage, pageBlock };
