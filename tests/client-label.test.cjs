const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// what the pages tell /clientlog about themselves, read off the batch they
// send: the kind of window, worked out from the user agent, and one id per
// page load. The Electron and Tauri strings are the ones the built apps report
const source = readFileSync(path.join(__dirname, "..", "card-report.js"), "utf8");
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/";
const AGENTS = {
  chrome: [
    MAC + "537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    MAC + "537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
  ],
  electron: [
    MAC + "537.36 (KHTML, like Gecko) FacilitatorElectron/0.2.246 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36",
    MAC + "537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36",
  ],
  tauri: [
    MAC + "605.1.15 (KHTML, like Gecko)",
  ],
  safari: [
    MAC + "605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  ],
  phone: [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    // added to the home screen: no Version or Safari token, as in a bare web view
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36",
  ],
  other: [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
    MAC + "537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
    "",
    undefined,
  ],
};

function fixture(agent, page = "board", touchPoints = 0) {
  const windowEvents = {}, documentEvents = {}, sent = [];
  const listen = store => (name, fn) => (store[name] ||= []).push(fn);
  const fire = (store, name, value = {}) => { for (const fn of store[name] || []) fn(value); };
  const body = { classList: { contains: () => false } };
  const document = { hidden: false, addEventListener: listen(documentEvents), body, activeElement: body };
  const context = vm.createContext({
    Blob, AbortController, URL, Promise, console, document,
    navigator: { userAgent: agent, maxTouchPoints: touchPoints, onLine: true,
      sendBeacon: (url, blob) => { sent.push(blob); return true; } },
    location: { href: "https://fixture.invalid/" },
    performance: { now: () => 0 }, Date: { now: () => 1800000000000 },
    // a zero wait runs at once; the longer ones (a save's timeout, the recovery window) never come
    setTimeout(fn, ms = 0) { if (!ms) Promise.resolve().then(fn); return 1; }, clearTimeout() {},
    setInterval() {}, addEventListener: listen(windowEvents),
    fetch: async () => ({ ok: true }),
  });
  context.window = context;
  vm.runInContext(source, context);
  context.startReporter(page);
  return {
    context,
    // what the page sends as it goes away, after throwing once
    async batches(message = "a fixture throw") {
      fire(windowEvents, "error", { message, filename: "", lineno: 3, colno: 4 });
      fire(windowEvents, "pagehide");
      const out = [];
      for (const blob of sent.splice(0)) out.push(JSON.parse(await blob.text()));
      return out;
    },
  };
}

for (const [name, agents] of Object.entries(AGENTS)) {
  test(`a page in a ${name} window sends client "${name}"`, async () => {
    for (const agent of agents) {
      const [batch] = await fixture(agent).batches();
      assert.equal(batch.client, name, String(agent));
      assert.equal(batch.page, "board");
      assert.equal(batch.reports.length, 1);
    }
  });
}

test("an iPad, which reports a Mac user agent but has a touch screen, is a phone and not the Tauri app", async () => {
  const bare = AGENTS.tauri[0];
  assert.equal((await fixture(bare, "board", 5).batches())[0].client, "phone");
  assert.equal((await fixture(bare, "board", 0).batches())[0].client, "tauri");
});

test("every window kind is one the server accepts, and the user agent itself is never sent", async () => {
  const server = readFileSync(path.join(__dirname, "..", "server.py"), "utf8");
  const listed = /CLIENT_NAMES = \(([^)]*)\)/.exec(server)[1].match(/"([a-z]+)"/g).map(word => word.slice(1, -1));
  for (const [name, agents] of Object.entries(AGENTS)) {
    assert.ok(listed.includes(name), `the server does not know ${name}`);
    for (const agent of agents.filter(Boolean)) {
      const [batch] = await fixture(agent).batches();
      assert.ok(!JSON.stringify(batch).includes(agent), "the raw user agent was sent");
      assert.deepEqual(Object.keys(batch).sort(), ["client", "page", "reports", "window"]);
    }
  }
});

test("a page load has one window id on every batch, and no two loads share one", async () => {
  const first = fixture(AGENTS.chrome[0]);
  const [a] = await first.batches("first throw");
  const [b] = await first.batches("second throw");
  assert.match(a.window, /^[a-f0-9]{16}$/);
  assert.equal(b.window, a.window, "one page load changed its id between batches");
  const ids = new Set([a.window]);
  for (let n = 0; n < 20; n++) ids.add((await fixture(AGENTS.chrome[0]).batches())[0].window);
  assert.equal(ids.size, 21, "two page loads shared an id");
});

test("starting the reporter a second time changes neither the kind nor the id", async () => {
  const f = fixture(AGENTS.electron[0]);
  const [a] = await f.batches("before");
  f.context.startReporter("page");
  const [b] = await f.batches("after");
  assert.deepEqual([b.page, b.client, b.window], [a.page, a.client, a.window]);
});

test("the phone's incident history goes out under the same window id as its session", async () => {
  const f = fixture(AGENTS.phone[0], "phone");
  f.context.phoneHistory.capability(3);
  f.context.phoneHistory.mark("settings", {});
  const sent = await f.batches("the phone tripped");
  const incident = sent.flatMap(batch => batch.reports.map(report => ({ batch, report })))
    .find(({ report }) => report.kind === "incident");
  assert.ok(incident, `no incident was sent: ${JSON.stringify(sent).slice(0, 200)}`);
  assert.equal(incident.batch.page, "phone");
  assert.equal(incident.batch.client, "phone");
  assert.match(incident.report.session, /^[a-f0-9]{16}$/);
  assert.equal(incident.batch.window, incident.report.session);
  for (const batch of sent) assert.equal(batch.window, incident.report.session, "a phone batch had another id");
});
