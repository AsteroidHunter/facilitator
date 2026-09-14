const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = path.resolve(__dirname, "..", "m-sw.js");

async function worker({ clients = [], uncontrolled = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const context = {
    URL, AbortSignal, Promise,
    fetch: async () => { throw new Error("notification push must not read mutable board state"); },
    caches: { keys: async () => [], open: async () => ({ addAll: async () => {} }) },
    self: {
      location: { origin: "https://board.test" },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {},
      registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
      clients: {
        claim: async () => {},
        matchAll: async options => options.includeUncontrolled ? clients.concat(uncontrolled) : clients,
        openWindow: async target => { opened.push(target); },
      },
    },
  };
  vm.runInNewContext(await readFile(SOURCE, "utf8"), context, { filename: "m-sw.js" });
  const dispatch = async (type, event) => {
    let work;
    handlers[type]({ ...event, waitUntil: promise => { work = promise; } });
    await work;
  };
  return { dispatch, shown, opened };
}

test("two pushes retain their independent titles and targets", async () => {
  const harness = await worker();
  for (const payload of [
    { box: "m101", title: "First card" },
    { box: "t202", title: "Second card" },
  ]) {
    await harness.dispatch("push", { data: { json: () => payload } });
  }
  assert.deepEqual(harness.shown.map(item => JSON.parse(JSON.stringify(item))), [
    { title: "First card", options: { tag: "facilitator-m101", data: { box: "m101" } } },
    { title: "Second card", options: { tag: "facilitator-t202", data: { box: "t202" } } },
  ]);
});

test("a missing or malformed payload safely shows the generic board notification", async () => {
  for (const data of [undefined, { json: () => { throw new Error("bad payload"); } }]) {
    const harness = await worker();
    await harness.dispatch("push", { data });
    assert.equal(harness.shown[0].title, "facilitator");
    assert.equal(harness.shown[0].options.data.box, "");
  }
});

test("a warm app receives its target even when focus rejects", async () => {
  const messages = [];
  const client = {
    url: "https://board.test/m",
    focus: async () => { throw new Error("focus rejected"); },
    postMessage: message => messages.push(message),
  };
  const harness = await worker({ clients: [client] });
  await harness.dispatch("notificationclick", {
    notification: { data: { box: "t202" }, close() {} },
  });
  assert.deepEqual(messages.map(message => JSON.parse(JSON.stringify(message))), [{ box: "t202" }]);
  assert.deepEqual(harness.opened, []);
});

test("a cold app opens the exact target and a failed warm delivery falls back to it", async () => {
  for (const clients of [[], [{
    url: "https://board.test/m",
    focus: async () => {},
    postMessage: () => { throw new Error("client disappeared"); },
  }]]) {
    const harness = await worker({ clients });
    await harness.dispatch("notificationclick", {
      notification: { data: { box: "m 7" }, close() {} },
    });
    assert.deepEqual(harness.opened, ["/m?box=m%207"]);
  }
});

test("an uncontrolled loading page cannot silently consume the notification target", async () => {
  const lost = [];
  const harness = await worker({ uncontrolled: [{
    url: "https://board.test/m",
    focus: async () => {},
    // WindowClient.postMessage returning normally does not acknowledge that
    // the page installed or ran a matching message listener.
    postMessage: message => lost.push(message),
  }] });
  await harness.dispatch("notificationclick", {
    notification: { data: { box: "m303" }, close() {} },
  });
  assert.deepEqual(lost, []);
  assert.deepEqual(harness.opened, ["/m?box=m303"]);
});
