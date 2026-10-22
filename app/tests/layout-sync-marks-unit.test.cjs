// The first-load marks on their own: the real syncLayoutsOnce and the two
// visibility passes out of index.html, over the real settings store
// (board-settings.js) with a stand-in board.
//
// What it guards:
//   - a board with no layoutsync.1 gets it and both visibility marks in the
//     same write, so a first load cut off before /state answers leaves nothing
//     for the next load to take as an older arrangement, and no show. keys
//     are written.
//   - a board that already has layoutsync.1 and no visibility marks still runs
//     both passes as before.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { create } = require("../board-settings.js");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function line(start) {
  const at = HTML.indexOf("\n" + start);
  assert.ok(at >= 0, "found: " + start);
  return HTML.slice(at + 1, HTML.indexOf("\n", at + 1));
}
function fnSource(signature) {
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}

const SOURCE = [
  line("const REGION_SEL = "), fnSource("function regionId(el)"),
  line("const LAYOUT_SYNC = "), line("const HAD_LEGACY_LAYOUT = "), fnSource("function syncLayoutsOnce()"),
  line("const DEFAULT_HIDDEN_REGIONS = "), line("const VISIBILITY_MIGRATION = "),
  line("const PLAYER_VISIBILITY_MIGRATION = "), fnSource("function hadLegacyVisibility(owner)"),
  fnSource("function migrateLegacyVisibility()"), fnSource("function migratePlayerVisibility()"),
  "this.hadLegacy = HAD_LEGACY_LAYOUT;",
  // the end of the page script, then the first /state answer
  "this.start = () => syncLayoutsOnce();",
  "this.firstState = owners => { validActiveOwnerIds = new Set(owners); migrateLegacyVisibility(); migratePlayerVisibility(); };",
].join("\n");

function storage() {
  const data = new Map();
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
    key: i => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
}

// one page load over the board's values; nothing is sent until the test says
function load(values) {
  const calls = [];
  const local = storage();
  const store = create({ seed: { rev: 1, values: { ...values } }, local,
    fetch: async (url, init = {}) => { calls.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; },
    now: () => 1000, later: () => {} });
  const sandbox = { settingsStore: store, localStorage: local, document: { querySelectorAll: () => [] } };
  vm.createContext(sandbox);
  vm.runInContext("let dragEnabled = true, validActiveOwnerIds = new Set();\n" + SOURCE, sandbox);
  return { sandbox, store, calls };
}
function settings(store) {
  const out = {};
  for (let i = 0; i < store.length; i++) out[store.key(i)] = store.getItem(store.key(i));
  return out;
}

test("a board with no layoutsync.1 gets it and both visibility marks in one write", () => {
  const first = load({});
  assert.equal(first.sandbox.hadLegacy, false);
  first.sandbox.start();
  // the page goes before /state answers: what it holds goes in one request
  first.store.flush(true);
  assert.equal(first.calls.length, 1);
  assert.deepEqual(first.calls[0], { "layoutsync.1": "1", "layoutvisibility.1": "1", "layoutvisibility.2": "1" });
  const next = load(first.calls[0]);
  assert.equal(next.sandbox.hadLegacy, true);
  next.sandbox.start();
  next.sandbox.firstState(["facilitator", "lane-two"]);
  assert.deepEqual(Object.keys(settings(next.store)).filter(k => k.startsWith("show.")), [],
    "the next load showed boxes the default hides");
});

test("a board that already has layoutsync.1 and no visibility marks still runs both passes", () => {
  const page = load({ "layoutsync.1": "1" });
  assert.equal(page.sandbox.hadLegacy, true);
  page.sandbox.start();
  assert.equal(page.store.getItem("layoutvisibility.1"), null);
  assert.equal(page.store.getItem("layoutvisibility.2"), null);
  page.sandbox.firstState(["facilitator"]);
  assert.deepEqual(settings(page.store), {
    "layoutsync.1": "1",
    "show.facilitator.rail": "1", "show.facilitator.magic1": "1", "show.facilitator.magic2": "1",
    "show.facilitator.magic3": "1", "show.facilitator.magic4": "1", "show.facilitator.goalbox": "1",
    "layoutvisibility.1": "1", "layoutvisibility.2": "1",
  });
});
