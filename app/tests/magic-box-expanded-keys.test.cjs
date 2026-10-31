// While a card's magic box is expanded, Control+Shift+Left and Right go to the
// widget's page in it, on the Mac board and the phone, so a widget that flips
// its items with those keys flips without a click in it first. The board hands
// the key to the page (widget/key) and the page's own script types it there as
// a keydown of its own. With the box at its size, with no widget in it, or with
// something over it holding the keys, the keys stay the board's. Run from the
// pages' own source, no browser: the page's script and the box's view in a bare
// context, and the two pages' listeners cut out as written.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.MAGIC_BOX_SOURCE_ROOT || path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const MagicBox = (() => { const s = vm.createContext({}); vm.runInContext(read("magic-box.js"), s); return s.MagicBox; })();
const plain = value => JSON.parse(JSON.stringify(value));
const KEY = { key: "ArrowRight", code: "ArrowRight", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false };

// the widget's page: its own script, with a window made of what it touches
function pageSide() {
  const listeners = [], dispatched = [];
  const parent = { postMessage() {} };
  const focused = { dispatchEvent: e => dispatched.push(e) };
  class KeyboardEvent { constructor(type, init) { this.type = type; this.init = init; } }
  const ctx = vm.createContext({ parent, KeyboardEvent, Promise, Map, Math, String, Object,
    addEventListener: (type, f, capture) => listeners.push({ type, f, capture }),
    document: { activeElement: focused, body: {} } });
  ctx.window = ctx;
  vm.runInContext(MagicBox.WIDGET, ctx);
  return { ctx, parent, focused, dispatched,
    send: data => listeners.filter(l => l.type === "message").forEach(l => l.f({ source: parent, data })),
    stray: data => listeners.filter(l => l.type === "message").forEach(l => l.f({ source: {}, data })) };
}

test("a widget's page types a key the board hands it into itself, as a keydown on what has its focus", () => {
  const p = pageSide();
  p.send({ jsonrpc: "2.0", method: "widget/key", params: KEY });
  assert.equal(p.dispatched.length, 1);
  const [e] = p.dispatched;
  assert.equal(e.type, "keydown");
  assert.deepEqual(plain(e.init), { key: "ArrowRight", code: "ArrowRight", ctrlKey: true, shiftKey: true, altKey: false,
    metaKey: false, repeat: false, bubbles: true, cancelable: true, composed: true });
  // only from the board, and only as a key
  p.stray({ jsonrpc: "2.0", method: "widget/key", params: KEY });
  p.send({ jsonrpc: "2.0", method: "widget/key" });
  p.send({ method: "widget/key", params: KEY });
  assert.equal(p.dispatched.length, 1);
  // the board's answers still reach the page as before
  const heard = [];
  vm.runInContext("facilitator", p.ctx).on("data", d => heard.push(d));
  p.send({ jsonrpc: "2.0", method: "widget/data", params: { thread: [], trev: 2 } });
  assert.deepEqual(plain(heard), [{ thread: [], trev: 2 }]);
  assert.equal(p.dispatched.length, 1);
});

// the board's side: the box's view with a widget's page in it
function boardSide(box) {
  const view = read("card-logic.js");
  let onMessage = null;
  const body = { style: { setProperty() {}, removeProperty() {} }, textContent: "", dataset: {}, append() {},
    addEventListener() {}, querySelector() { return null; } };
  const sent = [];
  const win = { postMessage: (...a) => sent.push(a) };
  const vctx = vm.createContext({
    MagicBox: { pageDoc: () => "", holderDoc: page => page }, getComputedStyle: () => ({ getPropertyValue: () => "0" }), setTimeout() {}, Date, JSON,
    document: { id: "document", body: { id: "body" } },
    addEventListener: (type, f) => { if (type === "message") onMessage = f; },
    h: () => ({ setAttribute() {}, addEventListener() {}, clientWidth: 398, contentWindow: win, isConnected: true }),
  });
  vm.runInContext(view.match(/function magicView\(el, hooks = \{\}\)\{[\s\S]*?\n  return view;\n\}/)[0] + ";this.magicView = magicView;", vctx);
  const el = { ownerDocument: vctx.document, querySelector: s => s === ".mbbody" ? body : null, lastElementChild: null };
  const v = vctx.magicView(el, { sized: true, placed() {} });
  v.draw({ kind: "html", html: "<p>x</p>", box: "c1", rev: 1, ...box });
  const run = v.page;
  return { v, run, sent,
    load: () => { onMessage({ source: win, data: true }); onMessage({ source: win, data: run.word }); } };
}

test("the board hands a key to a widget's page once it has loaded, and never to a page that is not a widget", () => {
  const b = boardSide({ widget: "issues" });
  assert.equal(b.v.widgetKey(KEY), false, "not before the page has said its word");
  assert.deepEqual(b.sent, []);
  b.load();
  assert.equal(b.v.widgetKey({ ...KEY, key: "ArrowLeft", code: "ArrowLeft", repeat: true }), true);
  assert.deepEqual(plain(b.sent.map(s => s[0])), [{ jsonrpc: "2.0", method: "widget/key",
    params: { key: "ArrowLeft", code: "ArrowLeft", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: true } }]);
  const plainPage = boardSide({});
  plainPage.load();
  assert.equal(plainPage.v.widgetKey(KEY), false);
  assert.deepEqual(plainPage.sent, []);
});

// one page's listener, cut out as written, with the world it reads
function listener(file, from) {
  const src = read(file), a = src.indexOf(from), b = src.indexOf("}, true);\n", a);
  assert.ok(a >= 0 && b > a, from);
  const logic = vm.createContext({ addEventListener() {}, setTimeout() {}, clearTimeout() {} });
  vm.runInContext(read("card-logic.js"), logic, { filename: "card-logic.js" });
  const handed = [], added = [];
  const world = { big: true, handed: true, live: true, over: false };
  const view = { get big() { return world.big; }, widgetKey: e => { handed.push(e.key); return world.handed; } };
  const ctx = vm.createContext({
    cardShortcut: vm.runInContext("cardShortcut", logic), imeKey: vm.runInContext("imeKey", logic),
    addEventListener: (type, f, capture) => added.push({ type, f, capture }),
    FOCUS: true, MB: { el: {}, view }, PB: { view },
    boardKeysLive: () => world.live, projOpen: () => world.over, searchOpen: false, p3Zoom: null, cardPictureShown: null,
  });
  vm.runInContext(src.slice(a, b + 9), ctx);
  assert.equal(added.length, 1);
  assert.equal(added[0].type, "keydown");
  assert.equal(added[0].capture, true, "in capture, ahead of the page's own keys");
  const press = extra => {
    const e = { ...KEY, isComposing: false, keyCode: 39, prevented: false, stopped: false, ...extra,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    added[0].f(e);
    return e;
  };
  return { world, handed, press };
}

for (const [name, file, from] of [
  ["the Mac board", "index.html", "// control+shift+left and right while the box is expanded go to"],
  ["the phone", "m.html", "// control+shift+left and right while it is expanded go to"],
]) {
  test(`${name}: with the box expanded, control+shift+left and right go to the widget's page and no further`, () => {
    const l = listener(file, from);
    for (const key of ["ArrowRight", "ArrowLeft"]) {
      const e = l.press({ key, code: key });
      assert.ok(e.prevented && e.stopped, key);
    }
    assert.deepEqual(l.handed, ["ArrowRight", "ArrowLeft"]);
  });

  test(`${name}: with the box at its size, no widget in it, or other keys, the keys stay the board's`, () => {
    const l = listener(file, from);
    const untouched = (extra, why) => {
      const e = l.press(extra);
      assert.ok(!e.prevented && !e.stopped, why);
    };
    l.world.big = false;
    untouched({}, "the box at its size");
    l.world.big = true;
    for (const [extra, why] of [
      [{ altKey: true }, "with option too"], [{ shiftKey: false }, "control alone"], [{ ctrlKey: false }, "shift alone"],
      [{ metaKey: true }, "with command"], [{ key: "ArrowUp", code: "ArrowUp" }, "up"], [{ key: "ArrowDown", code: "ArrowDown" }, "down"],
      [{ isComposing: true }, "while composing"]])
      untouched(extra, why);
    assert.deepEqual(l.handed, [], "none of those was handed to the page");
    l.world.handed = false;
    untouched({}, "a box with no widget's page");
    assert.deepEqual(l.handed, ["ArrowRight"]);
  });
}

test("the Mac board: something over the expanded box that holds the keys keeps them", () => {
  const l = listener("index.html", "// control+shift+left and right while the box is expanded go to");
  l.world.over = true;
  assert.equal(l.press({}).prevented, false, "the project list");
  l.world.over = false;
  l.world.live = false;
  assert.equal(l.press({}).prevented, false, "the settings, a page's menu or a warning");
  assert.deepEqual(l.handed, []);
});
