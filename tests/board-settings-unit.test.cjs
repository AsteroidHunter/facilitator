// The desktop pages' settings store (board-settings.js) on its own, with a
// stand-in board, clock and storage: reads come from what the server wrote in
// front of the file, writes are batched and sent one request at a time, a
// window's own write is held against an older reading, a key that is not a
// setting stays in the browser, and a browser's one-time copy is offered only
// to an empty store, once, and gives way to the board when it loses.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { create, isSetting, SETTINGS_HOLD, COPIED } = require("../board-settings.js");

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
    key: i => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

// a board that answers like the server: merge by key, seed only when empty
function board(values = {}) {
  const b = { rev: values && Object.keys(values).length ? 1 : 0, values: { ...values }, calls: [], hold: null };
  b.fetch = async (url, init = {}) => {
    b.calls.push({ url, body: init.body ? JSON.parse(init.body) : null, keepalive: !!init.keepalive });
    if (b.hold) await b.hold;
    if (!init.method) return { ok: true, json: async () => ({ rev: b.rev, values: { ...b.values } }) };
    const body = JSON.parse(init.body);
    if (url.endsWith("?seed=1") && Object.keys(b.values).length)
      return { ok: true, json: async () => ({ ok: true, seeded: false, rev: b.rev, values: { ...b.values } }) };
    for (const [k, v] of Object.entries(body)) { if (v === null) delete b.values[k]; else b.values[k] = v; }
    b.rev += 1;
    return { ok: true, json: async () => ({ ok: true, ...(url.endsWith("?seed=1") ? { seeded: true } : {}),
                                            rev: b.rev, values: { ...b.values } }) };
  };
  return b;
}

// the clock and the timer queue are the test's
function clock() {
  const c = { t: 1000, queue: [] };
  c.now = () => c.t;
  c.later = (fn, ms) => c.queue.push({ at: c.t + (ms || 0), fn });
  c.run = async (ms = 0) => {
    c.t += ms;
    for (let i = 0; i < 20; i++) {
      const due = c.queue.filter(item => item.at <= c.t);
      c.queue = c.queue.filter(item => item.at > c.t);
      for (const item of due) item.fn();
      await new Promise(resolve => setImmediate(resolve));
      if (!c.queue.some(item => item.at <= c.t)) break;
    }
  };
  return c;
}

test("the keys that are settings, and the ones that stay in the browser", () => {
  for (const key of ["pos.facilitator.main", "size.café-2.magic1", "hide.x.rail", "show.x.magic1",
                     "layoutbak.pos.x.main", "doc.tasks.facilitator", "bgcolor", "tocw", "composeformat",
                     "usagecounts", "home.chart", "magicrename.1", "layoutsync.1", "hideseed.1", "layoutvisibility.1",
                     "layoutvisibility.2", "navrestore.1", "pos.my.lane.main"])
    assert.equal(isSetting(key), true, key);
  for (const key of ["selbox", "activeproj", "homeopen", "tikview.x", "activepage.x", "minibox.x",
                     "pane.x", "focusbox", "spot.access", "spot.refresh", "spot.verifier", "spot.last",
                     "c3out", "home.limits", "taborder", "seenReplies", "pos.x.bad id", "layoutbak.hide.x.y",
                     COPIED])
    assert.equal(isSetting(key), false, key);
});

test("reads come from the board's values, writes are batched into one request, and other keys stay local", async () => {
  const b = board({ "pos.facilitator.main": "a" });
  const c = clock();
  const local = storage();
  const s = create({ seed: { rev: 1, values: { ...b.values } }, local, fetch: b.fetch, now: c.now, later: c.later });
  assert.equal(s.getItem("pos.facilitator.main"), "a");
  assert.equal(s.getItem("bgcolor"), null);
  s.setItem("bgcolor", "#eeeeee");
  s.setItem("tocw", 260);
  s.removeItem("pos.facilitator.main");
  s.setItem("selbox", "7");
  assert.equal(s.getItem("tocw"), "260", "a write is not read back at once");
  assert.equal(local.getItem("selbox"), "7");
  assert.equal(local.getItem("bgcolor"), null, "a setting went to the browser's storage");
  await c.run();
  assert.equal(b.calls.length, 1, "three writes were not one request");
  assert.deepEqual(b.calls[0].body, { bgcolor: "#eeeeee", tocw: "260", "pos.facilitator.main": null });
  assert.deepEqual(b.values, { bgcolor: "#eeeeee", tocw: "260" });
  assert.equal(s.length, 2);
  assert.deepEqual([s.key(0), s.key(1)].sort(), ["bgcolor", "tocw"]);
  assert.equal(local.getItem(COPIED), "1");
});

test("one request at a time: a write made while one is out goes after it", async () => {
  const b = board({ bgcolor: "#111111" });
  const c = clock();
  const s = create({ seed: { rev: 1, values: { ...b.values } }, local: storage(), fetch: b.fetch, now: c.now, later: c.later });
  let release;
  b.hold = new Promise(resolve => { release = resolve; });
  s.setItem("bgcolor", "#222222");
  await c.run();
  s.setItem("tocw", "300");
  await c.run();
  assert.equal(b.calls.length, 1, "a second request went out while the first was still out");
  b.hold = null;
  release();
  await c.run();
  await c.run();
  assert.equal(b.calls.length, 2);
  assert.deepEqual(b.calls[1].body, { tocw: "300" });
});

test("a window's own write stands over an older reading for the hold, then follows the board", async () => {
  const b = board({ bgcolor: "#111111", tocw: "200" });
  const c = clock();
  const s = create({ seed: { rev: 1, values: { ...b.values } }, local: storage(), fetch: b.fetch, now: c.now, later: c.later });
  s.setItem("bgcolor", "#222222");
  await c.run();
  // another window changes both keys afterwards, and the reading arrives
  // inside the hold
  b.values.bgcolor = "#333333";
  b.values.tocw = "300";
  b.rev += 1;
  s.notice(b.rev);
  await c.run(500);
  assert.equal(s.getItem("tocw"), "300", "another window's change to a key this one did not touch was not taken");
  assert.equal(s.getItem("bgcolor"), "#222222", "an older reading undid this window's own write");
  // past the hold, the board's last write wins
  b.values.bgcolor = "#444444";
  b.rev += 1;
  c.t += SETTINGS_HOLD;
  s.notice(b.rev);
  await c.run();
  assert.equal(s.getItem("bgcolor"), "#444444");
  // a reading older than one already taken is never taken
  const before = s.getItem("bgcolor");
  s.notice(b.rev - 5);
  await c.run();
  assert.equal(s.getItem("bgcolor"), before);
});

test("a browser's settings are offered once, whole, and only to an empty store; the keys stay in the browser", async () => {
  const b = board({});
  const c = clock();
  const local = storage({ "pos.facilitator.main": '{"x":40,"y":60}', "hide.facilitator.rail": "1",
                          bgcolor: "#f3efe6", selbox: "5" });
  const s = create({ seed: { rev: 0, values: {} }, local, fetch: b.fetch, now: c.now, later: c.later });
  // the page reads its own arrangement at once, before the board answers
  assert.equal(s.getItem("bgcolor"), "#f3efe6");
  s.setItem("layoutsync.1", "1");   // a start-up write rides along with the copy
  await c.run();
  assert.equal(b.calls[0].url, "/settings?seed=1");
  assert.deepEqual(b.calls[0].body, { "pos.facilitator.main": '{"x":40,"y":60}', "hide.facilitator.rail": "1",
                                      bgcolor: "#f3efe6", "layoutsync.1": "1" });
  assert.equal(b.calls.length, 1, "the start-up write was sent twice");
  assert.equal(local.getItem(COPIED), "1");
  assert.equal(local.getItem("bgcolor"), "#f3efe6", "the browser's own key was taken away");
  assert.equal(local.getItem("pos.facilitator.main"), '{"x":40,"y":60}');
  // the next page in this browser never offers it again, even to an empty store
  const empty = board({});
  create({ seed: { rev: 0, values: {} }, local, fetch: empty.fetch, now: c.now, later: c.later });
  await c.run();
  assert.equal(empty.calls.length, 0);
});

test("a copy that loses to another browser's takes the board's settings", async () => {
  const b = board({ bgcolor: "#000000", "pos.facilitator.main": '{"x":1,"y":1}' });
  const c = clock();
  const local = storage({ bgcolor: "#ffffff", tocw: "333" });
  // the page was served while the store was still empty
  const s = create({ seed: { rev: 0, values: {} }, local, fetch: b.fetch, now: c.now, later: c.later });
  assert.equal(s.getItem("bgcolor"), "#ffffff");
  await c.run();
  assert.equal(s.getItem("bgcolor"), "#000000");
  assert.equal(s.getItem("tocw"), null);
  assert.equal(s.getItem("pos.facilitator.main"), '{"x":1,"y":1}');
  assert.deepEqual(b.values, { bgcolor: "#000000", "pos.facilitator.main": '{"x":1,"y":1}' }, "the losing copy changed the board");
});

test("a browser with nothing to offer, or a store already full, offers nothing", async () => {
  const c = clock();
  const empty = board({});
  const bare = storage({ selbox: "1" });
  create({ seed: { rev: 0, values: {} }, local: bare, fetch: empty.fetch, now: c.now, later: c.later });
  await c.run();
  assert.equal(empty.calls.length, 0);
  assert.equal(bare.getItem(COPIED), "1");
  const full = board({ bgcolor: "#123456" });
  const old = storage({ bgcolor: "#ffffff" });
  const s = create({ seed: { rev: 1, values: { bgcolor: "#123456" } }, local: old, fetch: full.fetch, now: c.now, later: c.later });
  await c.run();
  assert.equal(full.calls.length, 0);
  assert.equal(s.getItem("bgcolor"), "#123456");
  assert.equal(old.getItem(COPIED), "1");
});

test("a write the board did not answer goes again; one it refused is let go; leaving sends what is unsent", async () => {
  const b = board({});
  const c = clock();
  const real = b.fetch;
  let down = true;
  b.fetch = (url, init) => (down && init && init.method ? Promise.reject(new TypeError("offline")) : real(url, init));
  const s = create({ seed: { rev: 1, values: { tocw: "200" } }, local: storage(), fetch: b.fetch, now: c.now, later: c.later });
  s.setItem("bgcolor", "#abcdef");
  await c.run();
  assert.deepEqual(b.values, {});
  down = false;
  await c.run(2000);
  assert.equal(b.values.bgcolor, "#abcdef");
  const refusing = { calls: 0, fetch: async () => { refusing.calls += 1; return { ok: false, status: 400 }; } };
  const r = create({ seed: { rev: 1, values: { tocw: "200" } }, local: storage(), fetch: refusing.fetch, now: c.now, later: c.later });
  r.setItem("bgcolor", "#abcdef");
  await c.run();
  await c.run(5000);
  assert.equal(refusing.calls, 1, "a refused write was sent again");
  const leaving = board({});
  const l = create({ seed: { rev: 1, values: { tocw: "200" } }, local: storage(), fetch: leaving.fetch, now: c.now, later: c.later });
  l.setItem("bgcolor", "#010101");
  l.flush(true);
  assert.equal(leaving.calls.length, 1);
  assert.equal(leaving.calls[0].keepalive, true);
  assert.deepEqual(leaving.calls[0].body, { bgcolor: "#010101" });
});
