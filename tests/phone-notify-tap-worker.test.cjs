// What the phone's worker writes about a tapped notification: one notifytap line
// with how the tap was routed, kept in the worker's own database and sent to the
// client log like a push's record. What a tap does is checked in
// phone-notification-worker; here it is only that the line is true, carries the
// same tap id the page is given, holds nothing but fixed words, ids and numbers,
// and can never get in the way of the tap.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { plain, fakeIndexedDB, loadWorker } = require("./push-record-fixture.cjs");

const TAP = /^[0-9a-f]{8}$/;
const DEAD = [0xde, 0xad, 0xbe, 0xef];
const answered = status => ({ ok: status >= 200 && status < 300, status, json: async () => ({}) });
const lines = harness => harness.logged().flatMap(batch => batch.reports).filter(line => line.kind === "notifytap");

function appWindow(posted, over = {}) {
  return {
    url: "https://board.test/m", visibilityState: "hidden", focused: false,
    focus: async () => {},
    postMessage: message => posted.push(plain(message)),
    ...over,
  };
}

test("a tap on a warm app is one line: routed by message, focused, with the tap id the page is given", async () => {
  const harness = await loadWorker({ random: DEAD });
  const posted = [];
  harness.windows.all = async () => [appWindow(posted)];
  await harness.click("m101", { data: { box: "m101", shown: harness.clock.now - 90_000 } });

  assert.deepEqual(posted, [{ box: "m101", tap: "deadbeef" }]);
  assert.deepEqual(harness.windows.opened, []);
  assert.deepEqual(harness.windows.asked, [{ type: "window" }], "the worker looked past the windows it controls");
  assert.deepEqual(lines(harness), [{
    kind: "notifytap", box: "m101", tap: "deadbeef", windows: 1, route: "message", focus: "ok", ms: 0, age: 90,
  }]);
  assert.equal(harness.closed.n, 1);
  assert.deepEqual(harness.idb.rows(), [], "a line the board took was kept");
});

test("a focus that is refused is said so, and the message is still the route", async () => {
  const harness = await loadWorker({ random: DEAD });
  const posted = [];
  harness.windows.all = async () => [appWindow(posted, { focus: async () => { throw new Error("no"); } })];
  await harness.click("m101");
  assert.equal(posted.length, 1);
  const [line] = lines(harness);
  assert.deepEqual([line.route, line.focus, line.windows], ["message", "rejected", 1]);
});

test("with no window the address is opened, carrying the same tap id the line has", async () => {
  for (const [opens, word] of [[async () => ({}), "client"], [async () => null, "null"], [async () => {}, "null"]]) {
    const harness = await loadWorker({ random: DEAD });
    harness.windows.open = async target => { harness.clock.now += 250; return opens(target); };
    await harness.click("m101");
    assert.deepEqual(harness.windows.opened, ["/m?box=m101&tap=deadbeef"]);
    assert.deepEqual(lines(harness), [{
      kind: "notifytap", box: "m101", tap: "deadbeef", windows: 0, route: "open", focus: "none", opened: word, ms: 250,
    }], word);
  }
});

test("a window that cannot be opened is said so, and the tap fails as it did before", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.windows.open = async () => { throw new Error("not allowed"); };
  await assert.rejects(harness.click("m101"), /not allowed/);
  assert.deepEqual(lines(harness).map(line => [line.route, line.opened, line.focus]), [["open", "rejected", "none"]]);
});

test("a warm window that cannot be posted to falls back to the address, with the line saying open", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.windows.all = async () => [appWindow([], { postMessage: () => { throw new Error("gone"); } })];
  harness.windows.open = async () => ({});
  await harness.click("m101");
  assert.deepEqual(harness.windows.opened, ["/m?box=m101&tap=deadbeef"]);
  assert.deepEqual(lines(harness).map(line => [line.windows, line.route, line.focus, line.opened]),
    [[1, "open", "ok", "client"]]);
});

test("windows that are not the phone page are not counted, and are not used", async () => {
  const harness = await loadWorker({ random: DEAD });
  const posted = [];
  const other = appWindow(posted, { url: "https://board.test/m/other" });
  harness.windows.all = async () => [other, appWindow(posted, { url: "https://board.test/" }),
    appWindow(posted), appWindow(posted, { url: "https://board.test/m?box=m5" })];
  await harness.click("m101");
  assert.equal(posted.length, 1);
  assert.equal(lines(harness)[0].windows, 2, "the windows at /m were not the count");
});

test("a worker that cannot list its windows says failed, and the tap fails as it did before", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.windows.all = async () => { throw new Error("no clients"); };
  await assert.rejects(harness.click("m101"), /no clients/);
  const [line] = lines(harness);
  assert.deepEqual([line.route, line.focus, line.windows, "opened" in line], ["failed", "none", 0, false]);
});

test("the age comes from when the push showed the notification, or the browser's own time", async () => {
  const harness = await loadWorker({ random: DEAD });
  const now = harness.clock.now;
  await harness.click("m101", { data: { box: "m101" } });
  await harness.click("m101", { data: { box: "m101" }, timestamp: now - 3_000 });
  await harness.click("m101", { data: { box: "m101", shown: now - 120_000 }, timestamp: now - 3_000 });
  await harness.click("m101", { data: { box: "m101", shown: now + 5_000 } });
  await harness.click("m101", { data: { box: "m101", shown: now - 400 * 86_400_000 } });
  const ages = lines(harness).map(line => ("age" in line ? line.age : "none"));
  assert.deepEqual(ages, ["none", 3, 120, 0, 7776000]);
});

test("only a card id is ever written as the box, and nothing else of the notification", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.windows.open = async () => ({});
  const ids = ["m101", "t202", "1.2", "12.3.4", "q", "m 7", "Quarterly plan <b>", "m".repeat(33), "", "private"];
  for (const id of ids) {
    await harness.click(id, {
      title: "Secret title", body: "Secret body", tag: "facilitator-" + id,
      data: { box: id, shown: harness.clock.now - 1000, endpoint: "https://push.example.test/send/secret" },
    });
  }
  const written = lines(harness);
  assert.deepEqual(written.map(line => line.box), ["m101", "t202", "1.2", "12.3.4", "q", "", "", "", "", ""]);
  for (const line of written) {
    assert.deepEqual(Object.keys(line).sort(),
      ["age", "box", "focus", "kind", "ms", "opened", "route", "tap", "windows"]);
  }
  const wire = JSON.stringify(harness.calls.map(call => call.init.body));
  assert.doesNotMatch(wire, /Secret|push\.example|private/);
  assert.deepEqual(harness.idb.rows(), []);
});

test("a tap with no card still opens the page and says so", async () => {
  const harness = await loadWorker({ random: DEAD });
  await harness.click(undefined);
  await harness.click("");
  assert.deepEqual(harness.windows.opened, ["/m", "/m"], "an address with no card was given a card or a tap id");
  assert.deepEqual(lines(harness).map(line => [line.box, line.tap, line.route]),
    [["", "deadbeef", "open"], ["", "deadbeef", "open"]]);
});

test("the tap id is eight hex characters from the browser's random bytes, or from Math when it has none", async () => {
  const seeded = await loadWorker({ random: [0x00, 0x0a, 0xf0, 0xff] });
  await seeded.click("m1");
  assert.equal(lines(seeded)[0].tap, "000af0ff");
  const plainWorker = await loadWorker();
  for (let i = 0; i < 5; i++) await plainWorker.click("m1");
  for (const line of lines(plainWorker)) assert.match(line.tap, TAP);
});

test("a held line goes out with the pushes held before it, oldest first, in one batch", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.board.log = async () => answered(503);
  await harness.push();
  assert.equal(harness.logged().length, 1);
  harness.calls.length = 0;
  harness.board.log = async () => answered(200);
  assert.equal(harness.idb.rows().length, 1);
  await harness.click("m101");
  const batches = harness.logged();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].reports.map(report => report.kind), ["pushreceived", "notifytapready", "notifytapready", "notifytap"]);
  assert.equal(batches[0].reports[0].outcome, "shown");
  assert.deepEqual(harness.idb.rows(), []);
});

test("a board that does not answer keeps the line, and the next flush sends it once", async () => {
  const harness = await loadWorker({ random: DEAD });
  harness.board.log = async () => answered(503);
  await harness.click("m101");
  const rows = harness.idb.rows();
  assert.deepEqual(rows.map(row => row.kind), ["notifytapready", "notifytapready", "notifytap"]);
  const row = rows[2];
  assert.deepEqual([row.kind, row.box, row.tap, row.route], ["notifytap", "m101", "deadbeef", "open"]);

  harness.board.log = async () => answered(200);
  await harness.dispatch("message", { data: { kind: "push-log-flush" }, ports: [] });
  assert.deepEqual(harness.idb.rows(), []);
  const sent = lines(harness).filter(line => line.tap === "deadbeef");
  assert.equal(sent.length, 2, "the line was sent once refused and once taken");
  await harness.dispatch("message", { data: { kind: "push-log-flush" }, ports: [] });
  assert.equal(lines(harness).length, 2, "a line the board took was sent again");
});

test("a store that fails costs the tap nothing", async () => {
  for (const options of [{ idb: Object.assign(fakeIndexedDB(), { fail: true }) }, { noIndexedDB: true }]) {
    const harness = await loadWorker({ random: DEAD, ...options });
    const posted = [];
    harness.windows.all = async () => [appWindow(posted)];
    await harness.click("m101");
    assert.deepEqual(posted, [{ box: "m101", tap: "deadbeef" }]);
    assert.deepEqual(harness.logged(), []);
    assert.equal(harness.closed.n, 1);
  }
});

test("a push is shown with the time it was shown, and its box and tag as before", async () => {
  const harness = await loadWorker();
  await harness.push({ box: "m101", title: "First card" });
  assert.deepEqual(harness.shown, [{
    title: "First card",
    options: { tag: "facilitator-m101", data: { box: "m101", shown: harness.clock.now } },
  }]);
});

const early = harness => harness.logged().flatMap(batch => batch.reports).filter(line => line.kind === "notifytapready");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), "the expected independent logging work did not finish");
}

test("early records start before lookup and focus, and persist while focus never resolves", async () => {
  const harness = await loadWorker({ random: DEAD, net: { log: async () => answered(503) } });
  const posted = [];
  let focusing = false;
  const client = appWindow(posted, {
    visibilityState: "hidden", focused: false,
    focus: () => {
      assert.ok(harness.idb.opens >= 2, "ready persistence had not started before focus");
      focusing = true;
      client.visibilityState = "visible";
      client.focused = true;
      return new Promise(() => {});
    },
  });
  harness.windows.all = async () => {
    assert.equal(harness.idb.opens, 1, "received persistence had not started before lookup");
    return [appWindow([], { url: "https://board.test/" }), client, appWindow([])];
  };
  void harness.click("m101");
  await until(() => focusing && harness.idb.rows().length === 2 && early(harness).length === 2);
  assert.deepEqual(early(harness), [
    { kind: "notifytapready", stage: "received", tap: "deadbeef", box: "m101", at: harness.clock.now, worker: "facilitator-m-12" },
    { kind: "notifytapready", stage: "ready", tap: "deadbeef", box: "m101", at: harness.clock.now, worker: "facilitator-m-12",
      windows: 2, visibility: "hidden", focused: "no" },
  ]);
  assert.deepEqual(harness.idb.rows().map(row => row.stage), ["received", "ready"]);
  assert.deepEqual(posted, []);
  assert.deepEqual(lines(harness), []);
});

test("received persists even when window lookup never resolves", async () => {
  const harness = await loadWorker({ random: DEAD, net: { log: async () => answered(503) } });
  harness.windows.all = () => new Promise(() => {});
  void harness.click("m1");
  await until(() => harness.idb.rows().length === 1 && early(harness).length === 1);
  assert.equal(early(harness)[0].stage, "received");
  assert.equal("windows" in early(harness)[0], false);
  assert.deepEqual(harness.windows.opened, []);
});

test("ready starts before openWindow and persists even when opening never resolves", async () => {
  const harness = await loadWorker({ random: DEAD, net: { log: async () => answered(503) } });
  harness.windows.open = () => {
    assert.ok(harness.idb.opens >= 2, "ready persistence had not started before openWindow");
    return new Promise(() => {});
  };
  void harness.click("m1");
  await until(() => harness.idb.rows().length === 2 && early(harness).length === 2);
  const ready = early(harness)[1];
  assert.deepEqual([ready.windows, ready.visibility, ready.focused], [0, "none", "none"]);
  assert.deepEqual(harness.windows.opened, ["/m?box=m1&tap=deadbeef"]);
  assert.deepEqual(lines(harness), []);
});

test("a stalled upload or store cannot hold up posting or opening", async () => {
  for (const storageStalls of [false, true]) {
    for (const warm of [false, true]) {
      const idb = storageStalls ? { open: () => ({}) } : fakeIndexedDB();
      const harness = await loadWorker({ random: DEAD, idb, net: { log: () => new Promise(() => {}) } });
      const posted = [];
      if (warm) harness.windows.all = async () => [appWindow(posted)];
      void harness.click("m1");
      await until(() => warm ? posted.length === 1 : harness.windows.opened.length === 1);
      assert.equal(harness.closed.n, 1);
    }
  }
});

test("early records keep click time and build through a worker restart and delayed upload", async () => {
  const harness = await loadWorker({ random: DEAD, net: { log: async () => answered(503) } });
  const clicked = harness.clock.now;
  harness.windows.all = async () => { harness.clock.now += 500; return []; };
  await harness.click("m101");
  const next = await loadWorker({ idb: harness.idb, clock: { now: clicked + 86_400_000 } });
  await next.dispatch("message", { data: { kind: "push-log-flush" } });
  assert.deepEqual(early(next).map(line => [line.stage, line.at, line.worker]), [
    ["received", clicked, "facilitator-m-12"], ["ready", clicked, "facilitator-m-12"],
  ]);
  assert.deepEqual(next.idb.rows(), []);
});

test("early records contain only allowed fields and validated card ids", async () => {
  const harness = await loadWorker({ random: DEAD });
  const ids = ["m1", "t2", "1.2", "q", "private", "m1\n", "m1\r", "9".repeat(33), ""];
  for (const box of ids) {
    await harness.click(box, { title: "Secret title", body: "Secret body", data: { box, endpoint: "https://private.test", key: "Secret" } });
  }
  const reports = early(harness);
  assert.equal(reports.length, ids.length * 2);
  assert.deepEqual(reports.filter(row => row.stage === "received").map(row => row.box), ["m1", "t2", "1.2", "q", "", "", "", "", ""]);
  for (const report of reports) {
    assert.deepEqual(Object.keys(report).sort(), (report.stage === "received"
      ? ["kind", "stage", "tap", "box", "at", "worker"]
      : ["kind", "stage", "tap", "box", "at", "worker", "windows", "visibility", "focused"]).sort());
  }
  assert.doesNotMatch(JSON.stringify(reports), /Secret|private/);
});
