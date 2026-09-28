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
    addEventListener: listen(windowEvents),
    fetch: async (url, init = {}) => {
      if (url !== "/clientlog") {
        if (url === "/broken") throw new Error("fixture request failure");
        return { ok: true };
      }
      calls.push(JSON.parse(init.body));
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
  context.startReporter(name);
  return {
    context, history: context.phoneHistory, calls, beacons, navigator, document, classes,
    fireDocument: (name, value) => fire(documentEvents, name, value),
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

test("busy recovery cannot evict the captured scroll and stall prelude", async () => {
  const f = fixture(); f.history.capability(3);
  f.now(100); f.history.note("input", { action:"response-scroll", part:"touch", box:"m12" });
  f.now(500); f.history.note("timer", { late:1200 });
  f.now(1000); const pending = f.history.mark("settings", { box:"m12" });
  for (let i = 0; i < 200; i++) {
    f.now(1100 + i * 90);
    f.history.note("input", { action:"card", part:"touch-end", box:"m12" });
    f.history.note("phase", { action:"drawer", part:"menu-commit", phase:"end", ms:12 });
  }
  f.now(19500); f.history.note("frame", { ms:650 });
  f.now(21000); await f.run();
  assert.equal((await pending).status, "saved");
  const report = latest(f);
  assert.ok(report.events.some(e => e.event === "input" && e.action === "response-scroll" && e.at === -900));
  assert.ok(report.events.some(e => e.event === "timer" && e.late === 1200 && e.at === -500));
  assert.ok(report.events.some(e => e.event === "frame" && e.ms === 650 && e.at === 18500));
  assert.equal(report.events.filter(e => e.event === "mark").length, 1);
  assert.equal(report.events.find(e => e.event === "mark").at, 0);
  assert.ok(report.events.length <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0])) <= 12 * 1024);
});

test("fresh v2 and v1 marks strip all retained v3-only events and fields", async () => {
  const f = fixture(); f.history.capability(3);
  f.history.note("input", { action:"response-scroll", part:"touch" });
  f.history.note("frame", { ms:650 });
  f.history.note("phase", { action:"state", part:"json", bytes:100 });
  f.history.note("render", { changed:true, bytes:100, action:"state", part:"apply", editorReady:true });
  f.history.note("lifecycle", { lifecycle:"pagehide", persisted:true });
  f.history.capability(2);
  assert.equal((await f.mark()).status, "saved");
  const v2 = latest(f);
  assert.equal(v2.v, 2);
  assert.equal(v2.events.some(e => ["input", "frame", "phase"].includes(e.event)), false);
  assert.equal(v2.events.some(e => e.lifecycle === "pagehide"), false);
  assert.equal(v2.events.some(e => ["changed", "bytes", "action", "part", "persisted"].some(k => k in e)), false);
  assert.ok(v2.events.some(e => e.event === "render" && e.editorReady));
  f.history.capability(3);
  f.history.note("scroll", { action:"response-scroll", phase:"end", count:4 });
  f.history.note("stage", { stage:"title-input", editorReady:true });
  f.history.capability(undefined);
  assert.equal((await f.mark()).status, "saved");
  const v1 = latest(f);
  assert.equal(v1.v, 1);
  assert.equal("build" in v1, false);
  assert.equal(v1.events.some(e => ["input", "frame", "phase", "scroll", "stage", "observer"].includes(e.event)), false);
  assert.equal(v1.events.some(e => ["changed", "bytes", "action", "part", "persisted", "editorReady"].some(k => k in e)), false);
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

test("a board read's network wait is not a slow screen and leaves the recorder free for a freeze", async () => {
  const f = fixture(); f.history.capability(5);
  const server = { headers: { get: () => "3" } };
  const read = (start, headersMs, downloadMs) => {
    f.now(start);
    const request = f.history.begin("request", { route: "/m/state" });
    const headers = f.history.begin("phase", { action: "state", part: "fetch-headers" });
    f.now(start + headersMs);
    f.history.end(headers, { action: "state", part: "fetch-headers", status: 200 }, server);
    const json = f.history.begin("phase", { action: "state", part: "json" });
    f.now(start + headersMs + downloadMs);
    f.history.end(json, { action: "state", part: "json", changed: true, bytes: 795792 });
    f.history.end(request, { route: "/m/state", status: 200, rev: 7 }, server);
  };
  // headers after 700 ms and an 800 KB download over 1.2 s: an ordinary wait
  read(1000, 700, 1200);
  await f.run();
  assert.equal(f.calls.length, 0);
  // so a freeze right after is not refused behind a network save
  f.now(5000); f.history.freeze(3000);
  f.now(25000); await f.run();
  assert.deepEqual(f.calls.map(c => c.reports[0].reason), ["freeze"]);
  const frozen = latest(f).events;
  assert.ok(frozen.some(e => e.part === "fetch-headers" && e.phase === "end" && e.ms === 700));
  assert.ok(frozen.some(e => e.part === "json" && e.phase === "end" && e.ms === 1200 && e.bytes === 795792));
  // a slow screen step is still a slow screen
  f.now(60000);
  const apply = f.history.begin("phase", { action: "state", part: "apply" });
  f.now(60400); f.history.end(apply, { action: "state", part: "apply", changed: true });
  f.now(81000); await f.run();
  assert.equal(latest(f).reason, "slow-ui");
  // and a whole read past two seconds is still saved, as the slow request it is
  read(120000, 2400, 300);
  f.now(143000); await f.run();
  assert.deepEqual(f.calls.map(c => c.reports[0].reason), ["freeze", "slow-ui", "slow-request"]);
  assert.equal(latest(f).suppressed, 0);
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

// ---- schema 5: a swipe on the response -------------------------------------------
// The phone page's own gesture block, cut out of m.html by its two markers and
// run against this recorder with a stand-in response scroller. No browser and
// no layout: the scroller's numbers are set by hand.
const phoneSource = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
function gestureBlock() {
  const first = "// Keep only the start, first intended move, and end of a gesture.";
  const start = phoneSource.indexOf(first), end = phoneSource.indexOf("// ---- the startup curtain", start);
  assert.ok(start >= 0 && end > start && phoneSource.indexOf(first, start + 1) < 0, "the gesture block moved");
  return phoneSource.slice(start, end);
}
// a response 500px tall holding 1500px, 400px down: range 1000, in the middle
function responseScroller({ top = 400, height = 500, full = 1500 } = {}) {
  const view = { scrollTop: top, clientHeight: height, scrollHeight: full, isConnected: true,
    selected: true, reply: {},
    matches: selector => selector === ".replyview",
    closest: selector => !view.selected ? null
      : selector === ".box.sel .replyview" ? view : selector === ".box.sel" ? {} : null,
    querySelector: selector => selector === ":scope > .reply" ? view.reply : null,
    getBoundingClientRect: () => ({ left: 0, right: 390, top: 100, bottom: 700 }) };
  return view;
}
// a layer over the page, found by the one selector that names it
const layerTarget = (selector, side) => ({ closest: asked =>
  asked === selector ? {} : asked === "#drawer, #settings" ? { dataset: { side } } : null });
function gesture(schema = 5, shape) {
  const f = fixture();
  f.history.capability(schema);
  const view = responseScroller(shape), observers = [];
  Object.assign(f.context, {
    innerWidth: 390, selectedId: "m12", hist: null, els: { m12: { replyview: view } },
    menuOut: () => null, phoneEnterRole: () => "other", traceFrameOpportunity: () => {},
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
  });
  vm.runInContext("function tracePhone(action, ...args){ try { return window.phoneHistory?.[action](...args); } catch (_) {} }", f.context);
  vm.runInContext(gestureBlock(), f.context);
  let at = 0;
  const touches = (x, y) => [{ clientX: x, clientY: y }];
  return { ...f, view,
    at(ms) { at = ms; f.now(ms); },
    down(x, y, target = view) { f.fireDocument("touchstart", { touches: touches(x, y), target, timeStamp: at - 4 }); },
    // the page's capture listener first, then the window's after every handler
    move(x, y, { target = view, prevented = false } = {}) {
      const e = { touches: touches(x, y), target, timeStamp: at - 3, defaultPrevented: prevented };
      f.fireDocument("touchmove", e);
      f.fire("touchmove", e);
    },
    up(type = "touchend") { f.fireDocument(type, { type, touches: [] }); },
    scroll() { f.fireDocument("scroll", { target: view }); },
    swapReply() { for (const o of observers) if (o.target === view.reply) o.fn([]); },
    async inspect(ms) {
      const pending = f.history.mark("settings");
      this.at(ms); await f.run(); await pending;
      return latest(f);
    },
  };
}
const bare = ({ visible, online, resume, ...e }) => e;
const gestureEvent = (report, part) => report.events.find(e => e.event === "input" && e.part === part);

test("a swipe that moves nothing saves a no-scroll incident carrying every new gesture field", async () => {
  const g = gesture();
  g.at(1000); g.down(200, 600);
  g.at(1016); g.move(200, 588);            // the intent: 12px up, not yet far
  g.at(1100); g.move(200, 560);            // 40px: far
  g.at(1315); await g.run();
  assert.equal(g.calls.length, 0);
  g.at(1316); await g.run();               // NO_SCROLL_MS after the intent, finger still down
  g.at(1400); g.up("touchcancel");
  g.at(21316); await g.run();
  assert.equal(g.calls.length, 1);
  const report = latest(g);
  assert.equal(report.v, 5);
  assert.equal(report.reason, "no-scroll");
  assert.equal(report.box, "m12");
  assert.deepEqual(bare(gestureEvent(report, "touch")), { event: "input", action: "response-scroll",
    part: "touch", box: "m12", top: 400, range: 1000, view: 500, edge: "middle", hist: false,
    kb: false, focus: "none", lag: 4, at: -316 });
  assert.deepEqual(bare(gestureEvent(report, "intent")), { event: "input", action: "response-scroll",
    part: "intent", box: "m12", dir: "up", far: false, edge: "middle", lag: 3, at: -300 });
  assert.deepEqual(bare(report.events.find(e => e.event === "mark")),
    { event: "mark", reason: "no-scroll", box: "m12", at: 0 });
  assert.deepEqual(bare(gestureEvent(report, "touch-cancel")), { event: "input", action: "response-scroll",
    part: "touch-cancel", box: "m12", moved: 0, count: 0, ms: 400, same: true, prevented: false, at: 84 });
  assert.doesNotMatch(JSON.stringify(report), /clientX|clientY|"x"|"y"/);
});

test("a finger lifted before the wait is judged at touch end, and only a far one saves", async () => {
  for (const [to, saves] of [[580, false], [540, true]]) {
    const g = gesture();
    g.at(1000); g.down(200, 600);
    g.at(1016); g.move(200, 588);
    g.at(1060); g.move(200, to);           // 20px is a finger settling, 60px is a swipe
    g.at(1090); g.up();
    g.at(1400); await g.run();
    g.at(22000); await g.run();
    assert.equal(g.calls.length, saves ? 1 : 0, `a ${600 - to}px move`);
    if (saves) assert.equal(latest(g).reason, "no-scroll");
  }
});

test("no save at an edge the finger pushes into, or with nothing to scroll; the intent says which", async () => {
  for (const [shape, dir, edge, saves] of [
    [{ top: 0 }, "down", "top", false],
    [{ top: 1000 }, "up", "bottom", false],
    [{ full: 501 }, "up", "none", false],
    [{ top: 0 }, "up", "top", true],       // leaving the top edge is a scroll that should happen
  ]) {
    const g = gesture(5, shape), step = dir === "up" ? -1 : 1;
    g.at(1000); g.down(200, 600);
    g.at(1016); g.move(200, 600 + step * 12);
    g.at(1100); g.move(200, 600 + step * 60);
    g.at(1400); await g.run(); g.up();
    g.at(30000); await g.run();
    assert.equal(g.calls.length, saves ? 1 : 0, JSON.stringify(shape) + dir);
    const report = saves ? latest(g) : await g.inspect(60000);
    assert.equal(gestureEvent(report, "intent").edge, edge);
    assert.equal(gestureEvent(report, "intent").dir, dir);
  }
});

test("no save once the response scrolled, and the first scroll says how long it took", async () => {
  const g = gesture();
  g.at(1000); g.down(200, 600);
  g.at(1016); g.move(200, 588);
  g.at(1050); g.scroll(); g.view.scrollTop = 430;
  g.at(1100); g.move(200, 540);
  g.at(1400); await g.run(); g.up();
  g.at(30000); await g.run();
  assert.equal(g.calls.length, 0);
  const report = await g.inspect(60000);
  assert.equal(report.events.find(e => e.event === "scroll" && e.phase === "start").wait, 50);
  const end = gestureEvent(report, "touch-end");
  assert.equal(end.count, 1);
  assert.equal(end.moved, 30);
  assert.equal(end.same, true);
});

test("taken, reply swaps, prevented pans and a replaced response are recorded without coordinates", async () => {
  const g = gesture();
  const swipe = async (start, fn) => { g.at(start); await fn(); await g.run(); };
  await swipe(1000, () => {                // an edge pull from the response
    g.down(10, 600); g.classes.add("menudrag"); g.move(40, 602, { prevented: true }); g.up();
    g.classes.delete("menudrag");
  });
  await swipe(2000, () => {                // a card swipe from the response
    g.down(200, 600); g.classes.add("carddrag"); g.move(150, 601, { prevented: true }); g.up();
    g.classes.delete("carddrag");
  });
  await swipe(3000, () => {                // focus taken, then the reply replaced and the card redrawn
    g.down(200, 600); g.fireDocument("focusin", {});
    g.context.hist = { id: "m12", step: 1 }; g.swapReply();
    g.view.isConnected = false; g.up();
  });
  g.view.isConnected = true; g.context.hist = null;
  g.context.menuOut = () => ({ dataset: { side: "left" } });
  // a vertical swipe over the response that the shade, the curtain or a
  // leaving menu caught instead
  for (const [start, target] of [[4000, layerTarget("#scrim")], [5000, layerTarget("#loading")],
    [6000, layerTarget("#drawer:not(.open), #settings:not(.open)", "right")]])
    await swipe(start, () => { g.down(200, 600, target); g.move(200, 560, { target }); g.up(); });
  await swipe(7000, () => { g.down(200, 300, layerTarget("#scrim")); g.move(260, 302); g.up(); });   // sideways: not taken
  const report = await g.inspect(30000);
  const taken = report.events.filter(e => e.part === "taken").map(e => [e.by, e.side]);
  assert.deepEqual(taken, [["drawer", undefined], ["cardswipe", undefined], ["focus", undefined],
    ["scrim", "left"], ["curtain", undefined], ["panel", "right"]]);
  const ends = report.events.filter(e => e.part === "touch-end");
  assert.deepEqual(ends.map(e => e.prevented), [true, true, false]);
  assert.equal(ends[2].same, false);
  assert.equal("moved" in ends[2], false, "a detached response was read");
  const swap = report.events.find(e => e.part === "reply-swap");
  assert.deepEqual(bare(swap), { event: "phase", action: "response-scroll", part: "reply-swap",
    box: "m12", hist: true, ms: 0, at: swap.at });
  const allowed = new Set(["event", "at", "visible", "online", "resume", "action", "part", "box", "top",
    "range", "view", "edge", "hist", "kb", "focus", "lag", "dir", "far", "moved", "count", "ms", "same",
    "prevented", "by", "side", "phase", "wait", "reason", "source", "lifecycle", "selected"]);
  for (const e of report.events) for (const key of Object.keys(e)) assert.ok(allowed.has(key), key);
});

test("a stuck card saves once per 120 seconds, inside the shared cooldown, only on schema 5", async () => {
  const f = fixture();
  f.history.capability(4);
  assert.equal(f.history.noScroll("m12"), false, "a schema-4 receiver has no no-scroll reason");
  f.history.capability(5);
  assert.equal(f.history.noScroll("person@example.invalid"), false);
  f.now(1000); assert.equal(f.history.noScroll("m12"), true);
  f.now(21000); await f.run();
  f.now(40000); assert.equal(f.history.noScroll("m12"), false, "the same card saved again inside 120 s");
  assert.equal(f.history.noScroll("m13"), true, "another card waits only for the shared cooldown");
  f.now(60000); await f.run();
  f.now(65000); assert.equal(f.history.noScroll("m14"), false, "the shared 30 s cooldown");
  f.now(71000); assert.equal(f.history.noScroll("m14"), true, "held back by the shared cooldown is not stuck");
  f.now(91000); await f.run();
  f.now(120999); assert.equal(f.history.noScroll("m12"), false);
  f.now(121000); assert.equal(f.history.noScroll("m12"), true);
  f.now(141000); await f.run();
  assert.deepEqual(f.calls.map(c => [c.reports[0].reason, c.reports[0].box]),
    [["no-scroll", "m12"], ["no-scroll", "m13"], ["no-scroll", "m14"], ["no-scroll", "m12"]]);
  assert.equal(latest(f).suppressed, 3);
  f.hidden(true);
  f.now(300000); assert.equal(f.history.noScroll("m15"), false, "a hidden page saves nothing");
});

test("a schema-4 receiver is sent the history without the new fields and parts", async () => {
  const played = async g => {
    g.history.note("enter", { step: "capture", branch: "seen", base: 812, inner: 764, vh: 696, vt: 0,
      scale: 100, kb: true, target: "textarea", focus: "textarea", draft: true, prevented: false });
    g.at(1000); g.down(200, 600);
    g.at(1016); g.move(200, 588);
    g.at(1030); g.scroll(); g.fireDocument("focusin", {}); g.swapReply();
    g.at(1100); g.up("touchcancel");
  };
  const assertV4 = report => {
    assert.equal(report.v, 4);
    const gestures = report.events.filter(e => e.event !== "enter");
    for (const key of ["top", "range", "view", "edge", "hist", "focus", "lag", "dir", "far", "wait",
      "moved", "same", "prevented", "by"])
      assert.equal(gestures.some(e => key in e), false, key);
    assert.equal(report.events.some(e => ["taken", "reply-swap", "touch-cancel"].includes(e.part)), false);
    assert.ok(gestureEvent(report, "touch-end"), "the cancelled touch kept its v4 end");
    const enter = report.events.find(e => e.event === "enter");
    assert.equal(enter.focus, "textarea");
    assert.equal(enter.prevented, false);
  };
  // a v5 history refused by a receiver rolled back under the open page
  const stale = gesture(5); stale.answer("v4");
  await played(stale);
  const pending = stale.history.mark("settings");
  stale.at(30000); await stale.run();
  assert.equal((await pending).status, "saved-legacy");
  assert.deepEqual(stale.calls.map(c => c.reports[0].v), [5, 4]);
  assert.ok(gestureEvent(stale.calls[0].reports[0], "taken"), "the v5 attempt carried the new parts");
  assertV4(latest(stale));
  // a page told schema 4 from the start never sends them
  const old = gesture(4);
  await played(old);
  const saved = old.history.mark("settings");
  old.at(30000); await old.run();
  assert.equal((await saved).status, "saved-legacy");
  assert.deepEqual(old.calls.map(c => c.reports[0].v), [4]);
  assertV4(latest(old));
  // a no-scroll save has no v4 form, so it is not downgraded and stays held
  const stuck = fixture(); stuck.history.capability(5); stuck.answer("v4");
  stuck.now(1000); stuck.history.noScroll("m12");
  stuck.now(21000); await stuck.run();
  assert.deepEqual(stuck.calls.map(c => [c.reports[0].v, c.reports[0].reason]), [[5, "no-scroll"]]);
});
