// What the phone's worker keeps about each push it receives: shown, or skipped
// and why, with how long display took, in the worker's own database,
// and sent to the client log when the board can be reached. The worker runs
// against a fake IndexedDB and a fake board; nothing here starts a server.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { OK, plain, fakeIndexedDB, loadWorker } = require("./push-record-fixture.cjs");

const WORKER = "facilitator-m-12";
const answered = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const reports = harness => harness.logged().flatMap(batch => batch.reports);

test("a shown push is kept with its display time, then sent once and let go", async () => {
  let harness;
  harness = await loadWorker({ shouldShow: () => { harness.clock.now += 40; } });
  await harness.push({ box: "m101", title: "First card" });
  assert.equal(harness.shown[0].title, "First card");
  assert.deepEqual(harness.logged(), [{
    page: "phone",
    reports: [{ kind: "pushreceived", outcome: "shown", ms: 40, status: 0, ago: 0, n: 1, worker: WORKER }],
  }]);
  assert.deepEqual(harness.idb.rows(), []);
  assert.deepEqual(harness.order, ["show", "log"]);
  assert.ok(harness.calls.every(call => call.url !== "/auth/check"));
});

test("a sign-in check that would time out never delays a received push", async () => {
  const harness = await loadWorker();
  harness.board.auth = init => new Promise((_, reject) => init.signal.addEventListener("abort", () => {
    harness.clock.now += 6000;
    reject(Object.assign(new Error("gave up"), { name: "TimeoutError" }));
  }));
  const work = harness.push();
  assert.deepEqual(harness.order, ["show"], "display must begin before any awaited work");
  await work;
  assert.equal(harness.shown.length, 1);
  assert.ok(!harness.deadlines.includes(6000));
  assert.deepEqual(reports(harness).map(r => [r.outcome, r.ms, r.status]), [["shown", 0, 0]]);
});

test("an unavailable or signed-out board and visible windows never suppress a push", async () => {
  for (const auth of [
    async () => answered(503, {}),
    async () => { throw new TypeError("offline"); },
    async () => answered(200, { authenticated: false }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError("bad json"); } }),
  ]) {
    const harness = await loadWorker();
    harness.board.auth = auth;
    harness.windows.all = async () => [{ visibilityState: "visible" }];
    await harness.push();
    assert.equal(harness.shown.length, 1);
    assert.deepEqual(harness.windows.asked, []);
    assert.deepEqual(reports(harness).map(r => [r.outcome, r.status]), [["shown", 0]]);
  }
});

test("a notification that could not be shown still fails the push as before, and says so", async () => {
  const harness = await loadWorker({ shouldShow: () => { throw new Error("the phone refused it"); } });
  await assert.rejects(harness.push(), /the phone refused it/);
  const sent = reports(harness);
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].outcome, sent[0].reason, sent[0].status], ["skipped", "show-failed", 0]);
});

test("records wait for the board, go out oldest first in batches it accepts, and are let go only once taken", async () => {
  const harness = await loadWorker();
  harness.board.log = async () => answered(503, {});
  for (let i = 0; i < 45; i++) { harness.clock.now += 1000; await harness.push(); }
  assert.equal(harness.idb.rows().length, 45);
  assert.equal(harness.logged().length, 45);
  harness.calls.length = 0;

  // the board is back, but takes the second batch of twenty badly
  harness.board.auth = async () => OK;
  let batches = 0;
  harness.board.log = async () => (++batches === 2 ? { ok: false, status: 503 } : { ok: true, status: 200 });
  harness.clock.now += 10_000;
  await harness.push();   // shown: 46 records, the board is known to answer
  assert.deepEqual(harness.logged().map(batch => batch.reports.length), [20, 20]);
  assert.equal(harness.idb.rows().length, 26, "records the board refused were let go, or taken ones were kept");
  assert.equal(harness.idb.rows()[0].id, 21);

  // the next push sends what is left, once
  harness.board.log = async () => ({ ok: true, status: 200 });
  harness.clock.now += 10_000;
  await harness.push();
  const sent = reports(harness);
  const numbers = sent.map(report => report.n);
  assert.deepEqual(harness.logged().slice(2).map(batch => batch.reports.length), [20, 7]);
  assert.deepEqual(numbers.slice(0, 20), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.deepEqual(numbers.slice(40), Array.from({ length: 27 }, (_, i) => i + 21),
    "records after the refused batch were skipped or sent twice");
  assert.deepEqual(harness.idb.rows(), []);
  // the oldest came a second into the run and went out at 45 + 10 seconds
  assert.equal(sent[0].ago, 45 + 10 - 1, "the record's age was not worked out from when it arrived");
});

test("a board that cannot be reached, or that refuses the batch, keeps every record", async () => {
  const harness = await loadWorker();
  harness.board.log = async () => answered(503, {});
  await harness.push();
  await harness.push();
  harness.board.auth = async () => OK;
  for (const refusal of [
    async () => { throw new TypeError("Load failed"); },
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: false, status: 400 }),
  ]) {
    harness.board.log = refusal;
    await harness.dispatch("message", { data: { kind: "push-log-flush" } });
    assert.equal(harness.idb.rows().length, 2);
  }
  harness.board.log = async () => ({ ok: true, status: 200 });
  await harness.dispatch("message", { data: { kind: "push-log-flush" } });
  assert.deepEqual(harness.idb.rows(), []);
});

test("the page opening asks the worker to send what it holds, and there is nothing to send when it holds none", async () => {
  const harness = await loadWorker();
  await harness.dispatch("message", { data: { kind: "push-log-flush" } });
  assert.deepEqual(harness.calls, [], "the board was asked something with nothing to say");

  harness.board.log = async () => answered(503, {});
  await harness.push();
  assert.equal(harness.idb.rows().length, 1);
  harness.calls.length = 0;
  harness.board.log = async () => OK;
  await harness.dispatch("message", { data: { kind: "push-log-flush" } });
  assert.deepEqual(reports(harness).map(report => [report.outcome, report.reason]), [["shown", undefined]]);
  assert.deepEqual(harness.idb.rows(), []);

  // the message that was there before still answers
  const replies = [];
  await harness.dispatch("message", { data: { kind: "diagnostic-worker" }, ports: [{ postMessage: m => replies.push(plain(m)) }] });
  assert.deepEqual(replies, [{ kind: "diagnostic-worker", cache: WORKER }]);
});

test("a record survives the worker being stopped, and only the newest fifty are kept", async () => {
  const idb = fakeIndexedDB();
  let harness = await loadWorker({ idb });
  harness.board.log = async () => answered(503, {});
  for (let i = 0; i < 60; i++) await harness.push();
  assert.equal(idb.rows().length, 50);

  harness = await loadWorker({ idb });
  assert.deepEqual(idb.rows().map(row => row.id), Array.from({ length: 50 }, (_, i) => i + 11),
    "the oldest ten were not the ones let go");
  await harness.dispatch("message", { data: { kind: "push-log-flush" } });
  assert.deepEqual(reports(harness).map(report => report.n), Array.from({ length: 50 }, (_, i) => i + 11));
});

test("nothing of the push is kept or sent: no title, no card, no address", async () => {
  const harness = await loadWorker();
  const secret = { box: "m-private-box-77", title: "Private card title about a lawsuit" };
  let stored;
  harness.board.log = async () => { stored = JSON.stringify(harness.idb.rows()); return { ok: true, status: 200 }; };
  await harness.push(secret);
  harness.board.log = async () => ({ ok: false, status: 503 });
  await harness.push(secret);
  harness.board.log = async () => answered(503, {});
  await harness.push(secret);

  const everything = JSON.stringify([stored, harness.idb.rows(), harness.logged(), harness.calls.map(c => c.url)]);
  for (const word of ["m-private-box-77", "lawsuit", "Private card", "endpoint", "p256dh", "token", "http"]) {
    assert.ok(!everything.includes(word), `${word} reached the worker's record`);
  }
  const fields = new Set(["id", "at", "outcome", "reason", "ms", "status", "worker"]);
  for (const row of harness.idb.rows()) for (const name of Object.keys(row)) assert.ok(fields.has(name), name);
  for (const report of reports(harness)) {
    for (const name of Object.keys(report)) {
      assert.ok(["kind", "outcome", "reason", "ms", "status", "ago", "n", "worker"].includes(name), name);
    }
  }
});

test("a phone that cannot keep records still tries every notification", async () => {
  const cases = [
    ["a shown push", async () => OK, undefined, ["First card"]],
    ["a signed-out answer", async () => answered(200, { authenticated: false }), undefined, ["First card"]],
    ["a failed check", async () => answered(500, {}), undefined, ["First card"]],
    ["an unreachable board", async () => { throw new TypeError("offline"); }, undefined, ["First card"]],
  ];
  for (const options of [{ noIndexedDB: true }, { idb: Object.assign(fakeIndexedDB(), { fail: true }) }]) {
    for (const [name, auth, , titles] of cases) {
      const harness = await loadWorker(options);
      harness.board.auth = auth;
      await harness.push();
      assert.deepEqual(harness.shown.map(item => item.title), titles, name);
    }
    const harness = await loadWorker({ ...options, shouldShow: () => { throw new Error("refused"); } });
    await assert.rejects(harness.push(), /refused/, "a refused notification stopped failing the push");
  }
});
