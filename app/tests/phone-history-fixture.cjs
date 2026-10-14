const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = readFileSync(process.env.PHONE_REPORT_SOURCE || path.join(__dirname, "..", "card-report.js"), "utf8");
function fixture(name = "phone", { setup } = {}) {
  let now = 0, next = 0, answer = "saved";
  const timers = new Map(), intervals = [], windowEvents = {}, documentEvents = {}, calls = [], beacons = [], frames = [];
  const listen = store => (name, fn) => (store[name] ||= []).push(fn);
  const fire = (store, name, value = {}) => { for (const fn of store[name] || []) fn(value); };
  const classes = new Set();
  const body = { classList: { contains: name => classes.has(name) } };
  const document = { hidden: false, addEventListener: listen(documentEvents), body, activeElement: body };
  const navigator = { onLine: true, sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } };
  const context = vm.createContext({
    Blob, AbortController, URL, Promise, console, document, navigator,
    location: { href: "https://fixture.invalid/m" },
    performance: { now: () => now }, Date: { now: () => 1800000000000 + now },
    setTimeout(fn, ms = 0) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn, ms) { intervals.push({ fn, ms }); },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    addEventListener: listen(windowEvents),
    fetch: async (url, init = {}) => {
      if (url !== "/clientlog") {
        if (url === "/broken") throw new Error("fixture request failure");
        return { ok: true };
      }
      calls.push(JSON.parse(init.body));
      if (typeof answer === "function") return answer(url, init, calls.at(-1));
      if (answer === "throw") throw new Error("fixture telemetry failure");
      // a receiver still on schema 4, which refuses a v5 history outright
      if (answer === "v4" && calls.at(-1).reports[0].v === 5) return { ok: false, status: 400 };
      if (answer === "timeout") return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      if (answer === "status") return { ok: false };
      const stored = answer === "saved" || answer === "v4";
      return { ok: true, json: async () => ({ ok: true, written: stored ? 1 : 0, dropped: stored ? 0 : 1 }) };
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  if (setup) setup(context);
  else context.startReporter(name, { phoneHistory: true });
  return {
    context, history: context.phoneHistory, calls, beacons, navigator, document, classes,
    fireDocument: (name, value) => fire(documentEvents, name, value),
    // frames asked for and not yet delivered; a frame at `time` runs each of them
    frames: () => frames.length,
    frame(time) { for (const fn of frames.splice(0)) fn(time); },
    now: value => { now = value; }, answer: value => { answer = value; },
    tick: ms => { for (const interval of intervals) if (interval.ms === ms) interval.fn(); },
    hidden(value) { document.hidden = value; fire(documentEvents, "visibilitychange"); },
    fire: (name, value) => fire(windowEvents, name, value),
    async run() {
      for (let i = 0; i < 20; i++) {
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
        await Promise.resolve();
      }
    },
    async mark(source = "settings", detail = {}, retry = false) {
      const promise = context.phoneHistory.mark(source, detail, retry);
      await this.run();
      return promise;
    },
  };
}

module.exports = { fixture };
