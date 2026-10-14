// A selection on the phone keeps to the place it was made in. The card's words
// stand in places of their own, the title, the answer's scroller, the sent box
// and the magic box's body, and a finger lifted past the scroller's top used to
// carry a selection from the answer into the title: the phone then took in every
// line between, the ones scrolled out of sight too, drew their highlight over the
// card's bar and up into the status bar, and brought up no Copy.
//
// m.html's own selectionchange handler is run in a vm over stand-in elements, and
// its own sheet is read for the rule that writes the other places off. No browser
// and no board: the real presses are the simulator proof in the job's report.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const html = readFileSync(path.resolve(__dirname, "..", "m.html"), "utf8");
const between = (from, to) => {
  const at = html.indexOf(from);
  assert.ok(at >= 0, `m.html has no ${from}`);
  return html.slice(at, html.indexOf(to, at));
};

function classes(){
  const set = new Set();
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
    toggle: (c, on) => (on ? set.add(c) : set.delete(c)), list: () => [...set] };
}
// a place and a text node inside it
function place(name){
  const el = { name, nodeType: 1, isConnected: true, classList: classes(), closest: () => el };
  const text = { nodeType: 3, parentElement: el };
  return { el, text };
}

function page(){
  const title = place("title"), reply = place("replyview"), sent = place("sentwrap");
  const chrome = { nodeType: 1, closest: () => null };
  let now = null, handler = null;
  const moved = () => { throw new Error("the handler moved the selection"); };
  const sel = {
    get rangeCount(){ return now ? 1 : 0; },
    get isCollapsed(){ return !now || now.collapsed; },
    getRangeAt: () => now,
    setBaseAndExtent: moved, addRange: moved, removeAllRanges: moved, collapse: moved, extend: moved,
  };
  const body = { classList: classes() };
  const document = { body, addEventListener(type, fn){ if (type === "selectionchange") handler = fn; } };
  vm.runInContext(between("const SELECT_PLACES", "\n// ---- the sent panel"),
    vm.createContext({ document, getSelection: () => sel }));
  assert.equal(typeof handler, "function", "no selectionchange handler");
  const pick = (start, end, collapsed = false) => {
    now = start ? { startContainer: start, endContainer: end || start, collapsed } : null;
    handler();
  };
  const off = () => [title, reply, sent].filter(p => !p.el.classList.contains("selplace")).map(p => p.el.name);
  return { title, reply, sent, chrome, body, pick, off };
}

test("a selection in the answer writes the title and the sent box off, and a clear gives them back", () => {
  const p = page();
  p.pick(p.reply.text);
  assert.ok(p.body.classList.contains("selecting"));
  assert.deepEqual(p.off(), ["title", "sentwrap"]);
  p.pick(p.reply.text, p.reply.text, true);
  assert.ok(!p.body.classList.contains("selecting"), "a collapsed selection left the page selecting");
  assert.deepEqual(p.off(), ["title", "replyview", "sentwrap"], "a place kept its mark after the selection went");
  p.pick(null);
  assert.ok(!p.body.classList.contains("selecting"));
});

test("a selection run out of its place keeps the place it started in", () => {
  const p = page();
  p.pick(p.reply.text);
  // the finger lifted over the title: the phone's own selection reaches into it
  p.pick(p.title.text, p.reply.text);
  assert.ok(p.reply.el.classList.contains("selplace"), "the answer lost its mark");
  assert.ok(!p.title.el.classList.contains("selplace"), "the title was let in");
  p.pick(p.reply.text, p.sent.text);
  assert.ok(p.reply.el.classList.contains("selplace") && !p.sent.el.classList.contains("selplace"));
});

test("each place can be the one, and a new selection moves the mark", () => {
  const p = page();
  for (const at of [p.title, p.sent, p.reply]){
    p.pick(null);
    p.pick(at.text);
    assert.deepEqual(p.body.classList.list(), ["selecting"]);
    assert.ok(at.el.classList.contains("selplace"), `${at.el.name} was not marked`);
    assert.equal(p.off().length, 2);
  }
});

test("a selection outside every place marks nothing", () => {
  const p = page();
  p.pick(p.chrome);
  assert.ok(!p.body.classList.contains("selecting"));
  assert.equal(p.off().length, 3);
});

test("the sheet writes off every place but the marked one, and keeps the opt-in", () => {
  const sheet = between("/* ---- what a long press can pick", "/* ---- the tab's type");
  const flat = sheet.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  for (const sel of [":is(.title, .replyview, .sentwrap, .mbbody):not(.selplace)",
                     ":is(.title, .replyview, .sentwrap, .mbbody):not(.selplace) *"])
    assert.ok(flat.includes("body.selecting " + sel), `no rule for body.selecting ${sel}`);
  assert.match(flat, /:not\(\.selplace\) \*\{-webkit-user-select:none; user-select:none\}/);
  assert.match(flat, /\.title, \.cardmd, \.cm-content, input, textarea,/, "the words and fields no longer opt in");
  const places = between("const SELECT_PLACES", ";");
  assert.match(places, /"\.title, \.replyview, \.sentwrap, \.mbbody"/, "the script and the sheet name different places");
});
