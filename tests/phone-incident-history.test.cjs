const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(path.join(__dirname, "..", "card-report.js"), "utf8");
const OP = "12345678-1234-4234-8234-123456789abc";
function fixture(name = "phone") {
  let now = 0, next = 0, answer = "saved";
  const timers = new Map(), intervals = [], windowEvents = {}, documentEvents = {}, calls = [], beacons = [];
  const listen = store => (name, fn) => (store[name] ||= []).push(fn);
  const fire = (store, name, value = {}) => { for (const fn of store[name] || []) fn(value); };
  const document = { hidden: false, addEventListener: listen(documentEvents) };
  const navigator = { onLine: true, sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } };
  const context = vm.createContext({
    Blob, AbortController, URL, Promise, console, document, navigator,
    location: { href: "https://fixture.invalid/m" },
    performance: { now: () => now }, Date: { now: () => 1800000000000 + now },
    setTimeout(fn, ms = 0) { const id = ++next; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(fn, ms) { intervals.push({ fn, ms }); },
    addEventListener: listen(windowEvents),
    fetch: async (url, init = {}) => {
      if (url !== "/clientlog") {
        if (url === "/broken") throw new Error("fixture request failure");
        return { ok: true };
      }
      calls.push(JSON.parse(init.body));
      if (answer === "throw") throw new Error("fixture telemetry failure");
      if (answer === "timeout") return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      if (answer === "status") return { ok: false };
      return { ok: true, json: async () => ({ ok: true, written: answer === "saved" ? 1 : 0, dropped: answer === "saved" ? 0 : 1 }) };
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  context.startReporter(name);
  return {
    context, history: context.phoneHistory, calls, beacons, navigator,
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
const latest = f => f.calls.at(-1).reports[0];
const plain = v => JSON.parse(JSON.stringify(v));

test("incident capability follows v1 to v2 to v1 server responses", async () => {
  const f = fixture();
  f.history.identity("phone-diag-test-1");
  f.history.note("stage", { stage: "selected-ready", editorReady: true, paneBlank: false });
  await f.mark();
  assert.equal(latest(f).v, 1);
  assert.equal("build" in latest(f), false);
  assert.equal(latest(f).events.some(e => e.event === "stage" || "editorReady" in e), false);

  f.history.capability(2);
  f.history.note("stage", { stage: "selected-ready", editorReady: true, paneBlank: false });
  await f.mark();
  assert.equal(latest(f).v, 2);
  assert.equal(latest(f).build, "phone-diag-test-1");
  assert.ok(latest(f).events.some(e => e.event === "stage" && e.editorReady === true));

  f.history.capability(undefined);
  f.history.note("observer", { observer: "undelivered" });
  await f.mark();
  assert.equal(latest(f).v, 1);
  assert.equal("build" in latest(f), false);
  assert.equal(latest(f).events.some(e => e.event === "stage" || e.event === "observer"), false);
});

test("v3 keeps a two-minute scroll prelude through routine polls and records post-mark gaps", async () => {
  const f = fixture();
  f.history.capability(3); f.history.identity("phone-html-test"); f.history.worker("facilitator-m-5");
  f.now(1000);
  f.history.note("input", { action: "response-scroll", part: "touch", box: "m12", text: "private draft" });
  for (let i = 0; i < 70; i++) {
    f.now(2000 + i * 1500);
    const request = f.history.begin("request", { route: "/m/state" });
    f.now(2020 + i * 1500);
    f.history.end(request, { route: "/m/state", status: 200 }, { headers: { get: () => "2" } });
  }
  f.now(115000);
  const pending = f.history.mark("settings", { box: "m12" });
  assert.equal(f.calls.length, 0, "a mark is not reported saved before the post window or server reply");
  f.now(120000);
  f.history.note("scroll", { action: "response-scroll", phase: "end", ms: 1800, count: 12 });
  f.now(130000); f.history.note("frame", { ms: 1100 });
  f.now(135000); await f.run();
  assert.equal((await pending).status, "saved");
  const report = latest(f);
  assert.equal(report.v, 3);
  assert.equal(report.build, "phone-html-test");
  assert.equal(report.worker, "facilitator-m-5");
  assert.match(report.session, /^[a-f0-9]{16}$/);
  assert.ok(report.events.length <= 128);
  assert.ok(report.events.some(e => e.event === "input" && e.at === -114000));
  assert.ok(report.events.some(e => e.event === "scroll" && e.at === 5000));
  assert.ok(report.events.some(e => e.event === "frame" && e.at === 15000));
  assert.equal(report.events.filter(e => e.event === "mark").length, 1);
  assert.equal(report.events.find(e => e.event === "mark").at, 0);
  assert.ok(report.events.some(e => e.event === "poll" && e.count > 0));
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0])) <= 12 * 1024);
  assert.doesNotMatch(JSON.stringify(report), /private|draft|https?:/);
});

test("v3 failed save keeps the original mark and pagehide never claims persistence", async () => {
  const f = fixture(); f.history.capability(3); f.answer("dropped");
  f.now(1000); const pending = f.history.mark("shortcut", { box: "m12" });
  f.now(21000); await f.run();
  assert.equal((await pending).status, "failed");
  const marked = latest(f).marked;
  f.now(50000); f.answer("saved");
  assert.equal((await f.mark("settings", {}, true)).status, "saved");
  assert.equal(latest(f).marked, marked);
  assert.equal(latest(f).events.find(e => e.event === "mark").source, "shortcut");
  const hidden = fixture(); hidden.history.capability(3);
  const waiting = hidden.history.mark("settings");
  hidden.fire("pagehide");
  assert.equal((await waiting).status, "failed");
  assert.equal(hidden.calls.length, 0);
  assert.equal(hidden.beacons.length, 1);
});

test("a v3 mark rejected after a server downgrade stays retryable with its original timestamp", async () => {
  const f = fixture(); f.history.capability(3);
  f.now(1000); const pending = f.history.mark("settings", { box: "m12" });
  f.history.capability(2); f.answer("status");
  f.now(21000); await f.run();
  assert.equal((await pending).status, "failed");
  assert.equal(latest(f).v, 3);
  const first = latest(f).marked;
  f.history.capability(3); f.answer("saved");
  f.now(50000);
  assert.equal((await f.mark("shortcut", {}, true)).status, "saved");
  assert.equal(latest(f).marked, first);
  assert.equal(latest(f).events.find(e => e.event === "mark").source, "settings");
});

test("v3 timer detects a visible gap but ignores a resumed page's delayed callback", async () => {
  const f = fixture(); f.history.capability(3);
  f.now(100); f.tick(100);
  f.now(1500); f.tick(100);
  assert.equal(f.calls.length, 0);
  f.now(21500); await f.run();
  assert.equal(latest(f).reason, "freeze");
  assert.ok(latest(f).events.some(e => e.event === "timer" && e.late >= 1000));
  const resumed = fixture(); resumed.history.capability(3);
  resumed.hidden(true); resumed.now(10000); resumed.hidden(false); resumed.tick(100);
  resumed.history.freeze(9000);
  await resumed.run();
  assert.equal(resumed.calls.length, 0);
  const pending = resumed.history.mark("settings");
  resumed.now(30000); await resumed.run(); await pending;
  assert.equal(latest(resumed).events.some(e => e.event === "freeze" || e.event === "timer"), false);
});

test("normal history stays in RAM, with entry and age eviction and a bounded marker batch", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    f.now(i * 10);
    f.history.note("send", { box: "m12", op: OP, ms: 999, text: "NEVER LOG THIS", url: "https://secret.invalid/key" });
  }
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.mark()).status, "saved");
  const report = latest(f);
  assert.equal(report.events.length, 40);
  assert.ok(report.lost >= 61);
  assert.equal(report.events.at(-1).reason, "manual");
  assert.equal(report.box, "m12");
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0])) <= 12 * 1024);
  assert.doesNotMatch(JSON.stringify(report), /NEVER|secret|url|text/);
  f.now(62000);
  await f.mark();
  assert.equal(latest(f).events.length, 1, "old history survived the time bound");
});

test("operation ids and numeric spans correlate without accepting arbitrary ids or fields", async () => {
  const f = fixture();
  const span = f.history.begin("request", { route: "/send", box: "m12", op: OP, token: "private" });
  f.now(37);
  f.history.end(span, { op: OP, status: 200 }, { headers: { get: () => "12" } });
  f.history.note("send", { box: "person@example.invalid", op: "this-is-a-private-token", ms: Infinity });
  f.history.note("arbitrary private event", { text: "private" });
  await f.mark();
  const events = latest(f).events.filter(e => e.event === "request");
  assert.equal(events[0].seq, events[1].seq);
  assert.equal(events[0].op, events[1].op);
  assert.equal(events[1].ms, 37);
  assert.equal(events[1].serverMs, 12);
  assert.doesNotMatch(JSON.stringify(latest(f)), /private|example|Infinity/);
});

test("routine ResizeObserver warnings stay in the legacy batch without causing incident uploads", async () => {
  const f = fixture();
  f.fire("error", { message: "ResizeObserver loop completed with undelivered notifications.",
    filename: "https://fixture.invalid/m", lineno: 1, colno: 2 });
  await f.run();
  assert.equal(f.calls.length, 0);
  f.fire("pagehide");
  const batch = JSON.parse(await f.beacons[0].body.text());
  assert.equal(batch.reports[0].kind, "error");
  assert.match(batch.reports[0].message, /ResizeObserver/);
});

test("v2 histories timestamp routine ResizeObserver warnings without copying their message", async () => {
  const f = fixture();
  f.history.capability(2);
  f.fire("error", { message: "ResizeObserver loop completed with undelivered notifications.",
    filename: "https://fixture.invalid/m", lineno: 1, colno: 2 });
  await f.mark();
  const event = latest(f).events.find(e => e.event === "observer");
  assert.equal(event.observer, "undelivered");
  assert.equal(typeof event.at, "number");
  assert.doesNotMatch(JSON.stringify(latest(f)), /ResizeObserver|notifications/);
});

test("other page errors still save an automatic history without copying their message", async () => {
  const f = fixture();
  f.fire("error", { message: "fixture private failure words", filename: "https://private.invalid/m",
    lineno: 3, colno: 4 });
  await f.run();
  assert.equal(latest(f).reason, "problem");
  assert.ok(latest(f).events.some(event => event.problem === "error"));
  assert.doesNotMatch(JSON.stringify(latest(f)), /fixture private|private\.invalid/);
});

test("a failed operation saves its bounded lead-up automatically", async () => {
  const f = fixture();
  f.history.note("operation", { op: OP, box: "m12", outcome: "failed" });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(latest(f).reason, "problem");
  assert.ok(latest(f).events.some(event => event.event === "operation" &&
    event.outcome === "failed" && event.op === OP && event.box === "m12"));
});

test("UI and request thresholds have a cooldown, while a manual marker can follow an automatic save", async () => {
  const f = fixture();
  let span = f.history.begin("select");
  f.now(149); f.history.end(span);
  await f.run(); assert.equal(f.calls.length, 0);
  span = f.history.begin("drawer");
  f.now(299); f.history.end(span);
  await f.run(); assert.equal(latest(f).reason, "slow-ui");
  span = f.history.begin("request", { route: "/m/state" });
  f.now(3000); f.history.end(span);
  await f.run(); assert.equal(f.calls.length, 1);
  assert.equal((await f.mark("shortcut")).status, "saved");
  assert.equal(latest(f).reason, "manual");
  assert.ok(latest(f).suppressed >= 1);
  f.now(32000); span = f.history.begin("request", { route: "/send", op: OP });
  f.now(34000); f.history.end(span);
  await f.run(); assert.equal(latest(f).reason, "slow-request");
  await f.mark();
  assert.equal((await f.mark()).status, "limited");
  assert.equal(f.calls.length, 4);
});

test("render invariants distinguish an unnamed card from a missing rendered title", async () => {
  const f = fixture();
  const good = { known: true, present: true, shown: true, title: true, titled: false, emptyTitle: true, editing: false };
  f.history.end(f.history.begin("render"), good);
  await f.run(); assert.equal(f.calls.length, 0);
  f.history.end(f.history.begin("focus"), { ...good, titled: true });
  await f.run(); assert.equal(latest(f).reason, "invariant");
  assert.equal(latest(f).events.at(-2).emptyTitle, true);
  const missing = fixture();
  missing.history.end(missing.history.begin("select"), { ...good, present: false });
  await missing.run(); assert.equal(latest(missing).reason, "invariant");
});

test("hidden/resumed spans and wake timer delays do not trigger slow incidents", async () => {
  const f = fixture();
  const span = f.history.begin("request");
  f.hidden(true); f.now(10000); f.hidden(false);
  f.history.end(span); f.history.freeze(9000);
  await f.run(); assert.equal(f.calls.length, 0);
  f.now(20000); f.history.freeze(3000);
  await f.run(); assert.equal(latest(f).reason, "freeze");
  assert.ok(latest(f).events.some(e => e.lifecycle === "hidden"));
  assert.ok(latest(f).events.some(e => e.lifecycle === "visible"));
});

test("viewport storms are coalesced, keep the last dimensions, and never send ordinary samples", async () => {
  const f = fixture();
  for (let i = 0; i < 10000; i++) {
    f.now(i / 100);
    f.history.note("viewport", { vh: 800 - i % 300, vt: i % 40, kb: true, lifting: false });
  }
  assert.equal(f.calls.length, 0);
  await f.mark();
  const viewport = latest(f).events.filter(e => e.event === "viewport");
  assert.equal(viewport.length, 2);
  assert.equal(viewport.at(-1).vh, 701);
  assert.equal(viewport.at(-1).vt, 39);
  assert.ok(latest(f).events.every((e, i, a) => !i || e.at >= a[i - 1].at));
});

test("offline and unconfirmed saves retain the noticed moment for an explicit retry", async () => {
  const f = fixture();
  f.navigator.onLine = false;
  f.now(10);
  assert.equal((await f.mark()).status, "offline");
  assert.equal(f.calls.length, 0);
  f.now(120000); f.navigator.onLine = true; f.fire("online");
  f.answer("dropped");
  assert.equal((await f.mark("settings", {}, true)).status, "failed");
  assert.equal(latest(f).marked, 1800000000010);
  f.answer("saved");
  assert.equal((await f.mark("settings", {}, true)).status, "saved");
  assert.equal(latest(f).marked, 1800000000010);
});

test("a manual marker made during an automatic upload is retained for retry", async () => {
  const f = fixture();
  f.answer("timeout");
  f.context.reportProblem("render", new Error("fixture automatic problem"));
  assert.equal((await f.history.mark("shortcut", { box: "m12" })).status, "busy");
  await f.run(); f.now(4000); await f.run();
  f.answer("saved");
  assert.equal((await f.mark("settings", {}, true)).status, "saved");
  assert.equal(latest(f).reason, "manual");
  assert.equal(latest(f).events.at(-1).source, "shortcut");
  assert.equal(latest(f).box, "m12");
});

test("telemetry failures, timeout, and busy saves stay separate from legacy error batches", async () => {
  const f = fixture();
  f.answer("timeout");
  const pending = f.history.mark("settings");
  assert.equal((await f.history.mark("shortcut")).status, "busy");
  await f.run(); f.now(4000); await f.run();
  assert.equal((await pending).status, "failed");
  f.context.reportProblem("render", new Error("fixture render failed"));
  f.history.hide();
  f.fire("pagehide");
  const batches = await Promise.all(f.beacons.map(async e => JSON.parse(await e.body.text())));
  assert.equal(batches.filter(b => b.reports.some(r => r.kind === "incident")).length, 1,
    "visibility and page hide sent the same held incident twice");
  f.hidden(false); f.hidden(true);
  assert.equal(f.beacons.filter(e => e.url === "/clientlog").length, 3,
    "a later visibility cycle did not retry the held incident once");
  assert.ok(batches.some(b => b.reports.some(r => r.kind === "incident")));
  assert.ok(batches.some(b => b.reports.some(r => r.kind === "render")));
  assert.ok(!batches.some(b => b.reports.some(r => r.kind === "fetch")), "telemetry recursively reported its own failure");
  await assert.rejects(f.context.fetch("/broken"), /fixture request failure/);
  f.fire("pagehide");
  const legacy = JSON.parse(await f.beacons.at(-1).body.text());
  assert.equal(legacy.reports[0].route, "/broken");
});

test("invalid field getters and missing transport cannot throw through recorder calls", async () => {
  const f = fixture();
  const detail = Object.defineProperty({}, "box", { enumerable: true, get() { throw new Error("bad getter"); } });
  assert.doesNotThrow(() => f.history.note("send", detail));
  assert.doesNotThrow(() => f.history.end(f.history.begin("select"), detail));
  f.answer("throw");
  assert.equal((await f.mark()).status, "failed");
  f.context.fetch = null;
  f.answer("saved");
  assert.equal((await f.mark()).status, "saved", "capture did not retain its independent transport");
});

test("desktop reporters retain their existing batching without starting phone history", async () => {
  const f = fixture("board");
  assert.equal(f.history, undefined);
  f.context.reportProblem("render", new Error("fixture render failed"));
  f.context.reportProblem("render", new Error("fixture render failed"));
  assert.equal(f.calls.length, 0);
  f.fire("pagehide");
  const batch = JSON.parse(await f.beacons[0].body.text());
  assert.equal(batch.page, "board");
  assert.equal(batch.reports.length, 1);
  assert.equal(batch.reports[0].count, 2);
  assert.equal(plain(batch.reports[0]).kind, "render");
});
