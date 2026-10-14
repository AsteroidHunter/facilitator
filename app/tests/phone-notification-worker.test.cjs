const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = process.env.PHONE_WORKER_SOURCE || path.resolve(__dirname, "..", "m-sw.js");

async function worker({ clients = [], uncontrolled = [], authenticated = true, authOffline = false } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const context = {
    URL, AbortSignal, Promise,
    fetch: async (request) => {
      assert.equal(request, "/auth/check", "push read board state instead of session status");
      if (authOffline) throw new Error("offline");
      return { ok: true, json: async () => ({ authenticated }) };
    },
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
  const kept = harness.shown.map(item => JSON.parse(JSON.stringify(item)));
  assert.deepEqual(kept.map(item => [item.title, item.options.tag, item.options.data.box]), [
    ["First card", "facilitator-m101", "m101"],
    ["Second card", "facilitator-t202", "t202"],
  ]);
  for (const item of kept) {
    assert.deepEqual(Object.keys(item.options.data), ["box", "shown"]);
    assert.equal(typeof item.options.data.shown, "number");
  }
});

test("a missing or malformed payload safely shows the generic board notification", async () => {
  for (const data of [undefined, { json: () => { throw new Error("bad payload"); } }]) {
    const harness = await worker();
    await harness.dispatch("push", { data });
    assert.equal(harness.shown[0].title, "facilitator");
    assert.equal(harness.shown[0].options.data.box, "");
  }
});

test("a delivered title is shown even after sign-out or while offline", async () => {
  for (const options of [{authenticated:false}, {authOffline:true}]) {
    const harness = await worker(options);
    await harness.dispatch("push", { data: { json: () => ({box:"private",title:"Private card"}) } });
    assert.equal(harness.shown[0].title, "Private card");
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
  const [message, ...rest] = messages.map(message => JSON.parse(JSON.stringify(message)));
  assert.deepEqual(rest, []);
  assert.deepEqual(Object.keys(message), ["box", "tap"]);
  assert.equal(message.box, "t202");
  assert.match(message.tap, /^[0-9a-f]{8}$/);
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
    assert.equal(harness.opened.length, 1);
    assert.match(harness.opened[0], /^\/m\?box=m%207&tap=[0-9a-f]{8}$/);
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
  assert.equal(harness.opened.length, 1);
  assert.match(harness.opened[0], /^\/m\?box=m303&tap=[0-9a-f]{8}$/);
});

// Titles are read independently from the optional routing id.
test("empty and invalid titles fall back, while a title without a card id is kept", async () => {
  for (const title of ["", "  ", null, 42, undefined]) {
    const harness = await worker();
    await harness.dispatch("push", { data: { json: () => ({ box: "m3", title }) } });
    assert.equal(harness.shown[0].title, "facilitator");
    assert.equal(harness.shown[0].options.data.box, "m3");
  }
  const harness = await worker();
  await harness.dispatch("push", { data: { json: () => ({ title: "Delivered words" }) } });
  assert.equal(harness.shown[0].title, "Delivered words");
});
