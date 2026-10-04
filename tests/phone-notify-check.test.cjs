// What the phone page tells the log about its notifications each time the app
// starts or comes back: the permission, whether the worker is registered, and
// whether a subscription is held, as words, and "permission granted but no
// subscription" as a line of its own. The page's own check is lifted out of
// m.html and run against a small fake browser; reportNotice is card-report.js's
// side, run the way the incident history tests run it.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { plain, startPage } = require("./push-record-fixture.cjs");

const check = (reg, perm, sub, source = "start") => ({ kind: "notifycheck", source, perm, reg, sub });
const lost = (reg, source = "start") => ({ kind: "notifylost", source, reg });

test("every permission and subscription state is recorded at start, and only granted-without-one is lost", async () => {
  const states = [
    [{ permission: "granted", subscription: "yes" }, [check(true, "granted", "yes")]],
    [{ permission: "granted", subscription: "no" }, [check(true, "granted", "no"), lost(true)]],
    [{ permission: "granted", worker: "none" }, [check(false, "granted", "no"), lost(false)]],
    [{ permission: "granted", worker: false }, [check(false, "granted", "no"), lost(false)]],
    [{ permission: "denied", subscription: "yes" }, [check(true, "denied", "yes")]],
    [{ permission: "denied", subscription: "no" }, [check(true, "denied", "no")]],
    [{ permission: "default", subscription: "no" }, [check(true, "default", "no")]],
    [{ permission: "unsupported", subscription: "no" }, [check(true, "unsupported", "no")]],
    [{ permission: "granted", pushManager: false }, [check(true, "granted", "no"), lost(true)]],
    [{ permission: "granted", subscription: "throws" }, [check(true, "granted", "error")]],
  ];
  for (const [options, expected] of states) {
    const page = startPage(options);
    await page.settle();
    assert.deepEqual(page.reports, expected, JSON.stringify(options));
  }
});

test("the registration the page already holds is used, and the worker is asked to send its records", async () => {
  let page = startPage({ registered: true });
  await page.settle();
  assert.equal(page.asked.registration, 0, "the page asked again for a registration it holds");
  assert.deepEqual(page.reports, [check(true, "granted", "yes")]);
  assert.deepEqual(page.posted, [{ kind: "push-log-flush" }]);

  // a page the worker does not control yet reaches the worker through its registration
  page = startPage({ controller: false });
  await page.settle();
  assert.deepEqual(page.posted, [{ kind: "push-log-flush" }]);

  // no worker, nobody to ask, and the record is still made
  page = startPage({ worker: false });
  await page.settle();
  assert.deepEqual(page.posted, []);
  assert.equal(page.reports.length, 2);
});

test("coming back is recorded as a return, not more than once in ten seconds, and not when the page is hidden", async () => {
  const page = startPage({ subscription: "no" });
  await page.settle();
  assert.deepEqual(page.reports.map(r => r.source), ["start", "start"]);

  page.hide();
  page.visible();
  page.fire("pageshow", { persisted: true });
  await page.settle();
  assert.equal(page.reports.length, 2, "a return within ten seconds of the start was recorded");

  page.clock.now += 11_000;
  page.hide();
  await page.settle();
  assert.equal(page.reports.length, 2, "hiding the page was recorded as a return");
  page.visible();
  await page.settle();
  assert.deepEqual(page.reports.slice(2), [check(true, "granted", "no", "return"), lost(true, "return")]);

  page.clock.now += 11_000;
  page.fire("pageshow", { persisted: false });
  await page.settle();
  assert.equal(page.reports.length, 4, "a plain page show was recorded as a return");
  page.fire("pageshow", { persisted: true });
  await page.settle();
  assert.deepEqual(page.reports.slice(4).map(r => r.source), ["return", "return"]);
});

test("the record carries words and flags only: no address, no key, no text", async () => {
  const page = startPage();
  await page.settle();
  page.clock.now += 11_000;
  page.visible();
  await page.settle();
  const written = JSON.stringify([page.reports, page.posted]);
  for (const word of ["push.example.test", "very-secret-address", "SECRET", "endpoint", "p256dh", "http"]) {
    assert.ok(!written.includes(word), `${word} reached the record`);
  }
  const allowed = { notifycheck: ["kind", "source", "perm", "reg", "sub"], notifylost: ["kind", "source", "reg"] };
  for (const report of page.reports) assert.deepEqual(Object.keys(report), allowed[report.kind], report.kind);
});

test("the check changes nothing the page shows and asks for nothing", async () => {
  const page = startPage({ permission: "default", subscription: "no" });
  await page.settle();
  assert.deepEqual(page.listeners(), { window: ["pageshow"], document: ["visibilitychange"] });
  assert.equal(page.asked.subscription, 1, "the page read its subscription more than once");
});

// ---- the reporter's side: card-report.js sends a notice with the window's own labels ----

function reporter() {
  const source = readFileSync(path.join(__dirname, "..", "card-report.js"), "utf8");
  const sent = [];
  const windowEvents = {};
  const board = { answer: { ok: true, status: 200 } };
  const context = vm.createContext({
    Blob, AbortController, URL, Promise, console,
    document: { hidden: false, addEventListener() {}, body: { classList: { contains: () => false } } },
    navigator: { onLine: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148", maxTouchPoints: 5 },
    location: { href: "https://board.test/m" },
    performance: { now: () => 0 }, Date: { now: () => 1800000000000 },
    setTimeout() { return 0; }, clearTimeout() {}, setInterval() {}, requestAnimationFrame() { return 0; },
    addEventListener: (name, fn) => (windowEvents[name] ||= []).push(fn),
    fetch: async (url, init = {}) => {
      if (url !== "/clientlog") return { ok: true };
      sent.push({ ...plain(init), body: JSON.parse(init.body) });
      if (board.answer === "throw") throw new TypeError("Load failed");
      return board.answer;
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  return { context, sent, board, windowEvents, settle: async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); } };
}

test("a notice goes to the client log at once, with the page, the kind of window and the window id", async () => {
  const r = reporter();
  r.context.reportNotice({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "yes" });
  assert.equal(r.sent.length, 0, "a notice was sent before the reporter started");

  r.context.startReporter("phone");
  r.context.reportNotice({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "yes" });
  await r.settle();
  assert.equal(r.sent.length, 1);
  const [call] = r.sent;
  assert.equal(call.method, "POST");
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(Object.keys(call.body), ["page", "client", "window", "reports"]);
  assert.equal(call.body.page, "phone");
  assert.equal(call.body.client, "phone");
  assert.match(call.body.window, /^[a-f0-9]{16}$/);
  assert.deepEqual(call.body.reports, [{ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "yes" }]);
});

test("a notice the board did not take is held and goes out with the next, and is not reported as a failed request", async () => {
  const r = reporter();
  r.context.startReporter("phone");
  r.board.answer = "throw";
  r.context.reportNotice({ kind: "notifylost", source: "start", reg: true });
  await r.settle();
  r.board.answer = { ok: false, status: 503 };
  r.context.reportNotice({ kind: "notifycheck", source: "return", perm: "granted", reg: true, sub: "no" });
  await r.settle();
  r.board.answer = { ok: true, status: 200 };
  r.context.reportNotice({ kind: "notifylost", source: "return", reg: true });
  await r.settle();
  assert.deepEqual(r.sent.at(-1).body.reports.map(x => x.kind + ":" + x.source),
    ["notifylost:start", "notifycheck:return", "notifylost:return"]);
  r.context.reportNotice({ kind: "notifylost", source: "return", reg: false });
  await r.settle();
  assert.equal(r.sent.at(-1).body.reports.length, 1, "taken notices were sent again");

  // the failed requests above were not turned into a "fetch" report of the page's own
  const beacons = [];
  r.context.navigator.sendBeacon = (url, blob) => { beacons.push(blob); return true; };
  r.windowEvents.pagehide.forEach(fn => fn({}));
  assert.deepEqual(beacons, [], "a notice that failed to send was reported as a failed request");
});

test("a board that refuses the shape of a notice is not sent it again", async () => {
  const r = reporter();
  r.context.startReporter("phone");
  r.board.answer = { ok: false, status: 400 };
  r.context.reportNotice({ kind: "notifylost", source: "start", reg: true });
  await r.settle();
  r.board.answer = { ok: true, status: 200 };
  r.context.reportNotice({ kind: "notifylost", source: "return", reg: true });
  await r.settle();
  assert.deepEqual(r.sent.at(-1).body.reports.map(x => x.source), ["return"]);
});

test("a notice held when the phone comes back online is sent without waiting for the next one", async () => {
  const r = reporter();
  r.context.startReporter("phone");
  r.board.answer = "throw";
  r.context.reportNotice({ kind: "notifylost", source: "start", reg: true });
  await r.settle();
  r.board.answer = { ok: true, status: 200 };
  r.windowEvents.online.forEach(fn => fn({}));
  await r.settle();
  assert.deepEqual(r.sent.at(-1).body.reports, [{ kind: "notifylost", source: "start", reg: true }]);
});

test("a notice made while another is out goes in the next request once the board has answered", async () => {
  const r = reporter();
  r.context.startReporter("phone");
  r.context.reportNotice({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "no" });
  r.context.reportNotice({ kind: "notifylost", source: "start", reg: true });
  await r.settle();
  assert.deepEqual(r.sent.map(call => call.body.reports.map(x => x.kind)), [["notifycheck"], ["notifylost"]]);
  await r.settle();
  assert.equal(r.sent.length, 2, "a notice the board took was sent again");
});

test("a board that does not answer is not asked again at once for the notice that waited", async () => {
  const r = reporter();
  r.context.startReporter("phone");
  r.board.answer = "throw";
  r.context.reportNotice({ kind: "notifycheck", source: "start", perm: "granted", reg: true, sub: "no" });
  r.context.reportNotice({ kind: "notifylost", source: "start", reg: true });
  await r.settle();
  await r.settle();
  assert.equal(r.sent.length, 1, "the reporter asked again with nothing new to say");
  r.board.answer = { ok: true, status: 200 };
  r.windowEvents.online.forEach(fn => fn({}));
  await r.settle();
  assert.deepEqual(r.sent.at(-1).body.reports.map(x => x.kind), ["notifycheck", "notifylost"]);
});
