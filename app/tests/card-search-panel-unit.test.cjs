// The Mac board's card search, opened by the magnifier in the bar. What the
// panel works out runs from card-logic.js: the route it asks, the matched
// words of a snippet and a title (counted as the board counts them), the
// groups, and the search itself with its pause, its cancelled and dropped
// answers and its Enter. The panel runs from index.html's own search section
// on a small synthetic DOM: opening and shutting, the keys it keeps from the
// board, the list it draws and a card opening in its own project the way its
// ticket does. Then the bar's markup and sheet, read as written. Checks
// behaviour, not rendering; no browser starts.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const LOGIC = fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));   // values from the VM, compared as plain data
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
}

// ---- a clock, and a board that answers when told to ----------------------------
function clock() {
  let next = 1;
  const timers = new Map();
  return {
    later: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    cancel: id => { timers.delete(id); },
    pending: () => [...timers.values()].map(t => t.ms),
    run() { const due = [...timers.values()]; timers.clear(); for (const t of due) t.fn(); },
  };
}
// a deaf board answers even a search the panel has cancelled
function board(deaf = false) {
  const calls = [];
  const ask = (url, signal) => new Promise((resolve, reject) => {
    const call = { url, signal, aborted: false, answer: (status, body) => resolve({ status, body }), fail: reject };
    if (!deaf) signal?.addEventListener("abort", () => {
      call.aborted = true;
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
    calls.push(call);
  });
  return { ask, calls };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
// an answer from GET /search: each card [id, lane, title, snippet, marks, kind, section]
const answer = (cards, ready = true) => ({
  q: "", mode: "keyword", total: cards.length, index: { ready, building: !ready },
  results: cards.map(([card, lane, title, snippet = "", marks = [], kind = "user", section = "doing"]) =>
    ({ card, lane, title, section, created: 1, changed: 2, score: 1, mode: "keyword",
       match: { kind, message: "@1", ts: 1, snippet, marks } })),
});

function logic(extra = {}) {
  const sandbox = { console, Date, setTimeout, clearTimeout, AbortController, document: { createElement: () => ({}) }, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  return sandbox;
}
const L = logic();

// ---- what the panel works out ------------------------------------------------------
test("a search asks for the words typed, the last one as the start of a longer word, twenty cards at most", () => {
  assert.equal(L.searchRoute("  gutter repair  "), "/search?q=gutter%20repair&prefix=1&limit=20");
  assert.equal(L.searchRoute("a&b=c #1"), "/search?q=a%26b%3Dc%20%231&prefix=1&limit=20");
  // a project's own window searches that project alone
  assert.equal(L.searchRoute("fence", "my garden"), "/search?q=fence&prefix=1&limit=20&lane=my%20garden");
});

test("only words are searched for: spaces and marks alone are nothing to search", () => {
  for (const q of ["", "   ", "!!!", "-- ?", null, undefined]) assert.equal(L.searchHasWords(q), false, String(q));
  for (const q of ["a", " fence ", "é", "日本", "x1", "_"]) assert.equal(L.searchHasWords(q), true, q);
});

test("a snippet is cut into plain and marked runs, set as text, with the board's marks in its own count", () => {
  assert.deepEqual(plain(L.searchPieces("The downpipe by the back door leaks", [[4, 12]])),
    [{ text: "The ", mark: false }, { text: "downpipe", mark: true }, { text: " by the back door leaks", mark: false }]);
  // the board counts characters as Python does: the emoji is one there and two here
  const pieces = plain(L.searchPieces("🌧 rain on the roof 🏠 roof", [[2, 6], [21, 25]]));
  assert.deepEqual(pieces.filter(p => p.mark).map(p => p.text), ["rain", "roof"]);
  assert.equal(pieces.map(p => p.text).join(""), "🌧 rain on the roof 🏠 roof");
  // marks out of order, over each other, past the end, or not marks at all
  assert.deepEqual(plain(L.searchPieces("one two three", [[8, 13], [0, 3], [1, 2], [2, 7], [10, 99], [5], "x", [4, 4]])),
    [{ text: "one two", mark: true }, { text: " ", mark: false }, { text: "three", mark: true }]);
  assert.deepEqual(plain(L.searchPieces("abc", null)), [{ text: "abc", mark: false }]);
  assert.deepEqual(plain(L.searchPieces("", [[0, 2]])), []);
  // markup is words like any other
  assert.deepEqual(plain(L.searchPieces("<b>x</b>", [[3, 4]])),
    [{ text: "<b>", mark: false }, { text: "x", mark: true }, { text: "</b>", mark: false }]);
});

test("a title marks each word that starts with a word typed, and each word the board marked in the snippet", () => {
  const marked = (title, q, snippetMarks = []) =>
    plain(L.searchTitlePieces(title, q, plain(L.searchPieces(...snippetMarks)))).filter(p => p.mark).map(p => p.text);
  assert.deepEqual(marked("Gutter repair at the back", "gut REP"), ["Gutter", "repair"]);
  // the start of a word only, as the board marks a snippet
  assert.deepEqual(marked("Begutted gutters", "gut"), ["gutters"]);
  // a form of the word the board matched in the text is marked in the title too
  assert.deepEqual(marked("Search the index", "searching", ["searching for search", [[0, 9], [14, 20]]]), ["Search"]);
  assert.deepEqual(marked("Plain title", "fence"), []);
  assert.deepEqual(marked("Café 日本 notes", "caf 日"), ["Café", "日本"]);
});

test("the cards come in a group for each project, in the order of each group's best card", () => {
  const { groups, rows } = plain(L.searchGroups(answer([
    ["a", "garden", "A"], ["b", "facilitator", "B"], ["c", "garden", "C"], ["d", "house", "D"], ["e", "facilitator", "E"],
  ]).results.concat([null, { lane: "x" }])));
  assert.deepEqual(groups.map(g => [g.lane, g.rows.map(r => r.card)]),
    [["garden", ["a", "c"]], ["facilitator", ["b", "e"]], ["house", ["d"]]]);
  // the order the cards are shown in, which the arrows walk: the best card is still first
  assert.deepEqual(rows.map(r => r.card), ["a", "c", "b", "e", "d"]);
  assert.deepEqual(plain(L.searchGroups(undefined)), { groups: [], rows: [] });
});

test("a section is named as the ticket list names it, under the search's names and the list's", () => {
  assert.deepEqual(["doing", "todo", "docked", "deferred", "done", "bin", undefined].map(L.searchSectionName),
    ["Doing", "Doing", "Docked", "Deferred", "Done", "", ""]);
});

test("a board that cannot search says so in plain words", () => {
  assert.equal(L.searchTrouble(404, null), "Search starts working once the board restarts");
  assert.equal(L.searchTrouble(503, { error: "search is not running on this board" }), "Search is not running on this board");
  assert.equal(L.searchTrouble(400, { error: "a query is 500 characters at most" }), "A query is 500 characters at most");
  assert.equal(L.searchTrouble(500, { error: "boom" }), "The board did not answer. Try again in a moment");
  assert.equal(L.searchTrouble(0, null), "The board did not answer. Try again in a moment");
});

// ---- the search itself ---------------------------------------------------------------
function searcher(lane = null, deaf = false) {
  const c = clock(), b = board(deaf), told = [];
  const s = L.cardSearch({ ask: b.ask, lane, later: c.later, cancel: c.cancel, changed: x => told.push(x.phase) });
  return { s, c, b, told };
}

test("typing only sets a timer; the search goes once the field is left alone, with the last words", async () => {
  const { s, c, b } = searcher();
  for (const q of ["g", "gu", "gut", "gutter"]) s.type(q);
  assert.equal(b.calls.length, 0, "nothing goes while the words are typed");
  assert.deepEqual(c.pending(), [150], "the pause is not SEARCH_PAUSE");
  assert.equal(vm.runInContext("SEARCH_PAUSE", L), 150);
  assert.equal(s.waiting, true);
  c.run();
  assert.deepEqual(b.calls.map(x => x.url), ["/search?q=gutter&prefix=1&limit=20"]);
  b.calls[0].answer(200, answer([["m1", "garden", "Gutter repair", "The downpipe leaks", [[4, 12]]], ["m2", "garden", "Gutters"]]));
  await settle();
  assert.equal(s.phase, "results");
  assert.equal(s.hot, 0, "the first card is picked");
  assert.equal(s.picked().card, "m1");
  assert.equal(s.waiting, false);
});

test("a newer search cancels the one still out, and an answer for words typed over is dropped", async () => {
  const { s, c, b } = searcher();
  s.type("fence"); c.run();
  s.type("fence post"); c.run();
  assert.equal(b.calls[0].aborted, true, "the older search was not cancelled");
  b.calls[1].answer(200, answer([["n", "garden", "New"]]));
  await settle();
  assert.equal(s.picked().card, "n");
  // an answer that comes back anyway, after the words changed, never stands over the newer one
  const late = searcher(null, true);
  late.s.type("one"); late.c.run();
  const first = late.b.calls[0];
  late.s.type("two"); late.c.run();
  assert.equal(first.signal.aborted, true);
  late.b.calls[1].answer(200, answer([["two", "garden", "Two"]]));
  await settle();
  first.answer(200, answer([["one", "garden", "One"]]));
  await settle();
  assert.deepEqual(plain(late.s.rows.map(r => r.card)), ["two"]);
});

test("until the new answer lands the last one stays on show, so the list never flashes empty", async () => {
  const { s, c, b, told } = searcher();
  s.type("gutter"); c.run();
  b.calls[0].answer(200, answer([["m1", "garden", "Gutter"]]));
  await settle();
  told.length = 0;
  s.type("gutters");
  assert.equal(s.phase, "results");
  assert.deepEqual(plain(s.rows.map(r => r.card)), ["m1"]);
  assert.deepEqual(told, [], "nothing on show changed while the new search waits");
});

test("a field with no words in it is empty at once, and nothing is asked", () => {
  const { s, c, b, told } = searcher();
  s.type("gutter");
  s.type("  ");
  assert.equal(s.phase, "empty");
  assert.equal(s.waiting, false);
  assert.deepEqual(c.pending(), [], "the waiting search was not stopped");
  assert.equal(b.calls.length, 0);
  assert.deepEqual(told, ["empty"]);
});

test("no card matching, a board still reading, and a board that cannot search each have their phase", async () => {
  const none = searcher();
  none.s.type("zzz"); none.c.run();
  none.b.calls[0].answer(200, answer([]));
  await settle();
  assert.equal(none.s.phase, "none"); assert.equal(none.s.hot, -1); assert.equal(none.s.picked(), null);

  const reading = searcher();
  reading.s.type("fence"); reading.c.run();
  reading.b.calls[0].answer(200, answer([["a", "garden", "Fence"]], false));
  await settle();
  assert.equal(reading.s.building, true);

  for (const [status, body, note] of [[404, null, "Search starts working once the board restarts"],
                                      [503, { error: "x" }, "Search is not running on this board"]]) {
    const t = searcher();
    t.s.type("fence"); t.c.run();
    t.b.calls[0].answer(status, body);
    await settle();
    assert.equal(t.s.phase, "trouble"); assert.equal(t.s.note, note);
  }
  const lost = searcher();
  lost.s.type("fence"); lost.c.run();
  lost.b.calls[0].fail(new TypeError("Failed to fetch"));
  await settle();
  assert.equal(lost.s.phase, "trouble");
  assert.equal(lost.s.note, "The board did not answer. Try again in a moment");
});

test("the arrows move the pick one card at a time and stop at either end; the pointer picks the card under it", async () => {
  const { s, c, b } = searcher();
  s.type("a"); c.run();
  b.calls[0].answer(200, answer([["a", "x", "A"], ["b", "y", "B"], ["c", "x", "C"]]));
  await settle();
  assert.deepEqual(plain(s.rows.map(r => r.card)), ["a", "c", "b"]);
  s.move(-1); assert.equal(s.hot, 0);
  s.move(1); s.move(1); s.move(1); assert.equal(s.hot, 2);
  assert.equal(s.picked().card, "b");
  s.point(1); assert.equal(s.picked().card, "c");
  s.point(7); s.point(-1); assert.equal(s.hot, 1);
});

test("Enter before the pause has run searches at once and is told the first card it finds", async () => {
  const { s, c, b } = searcher();
  const picked = [];
  s.type("gut");
  s.settle(r => picked.push(r && r.card));
  assert.deepEqual(c.pending(), [], "the search did not go at once");
  assert.equal(b.calls.length, 1);
  b.calls[0].answer(200, answer([["m1", "garden", "Gutter"]]));
  await settle();
  assert.deepEqual(picked, ["m1"]);
  // with the answer on show it is told the picked card straight away
  s.move(0);
  s.settle(r => picked.push(r.card));
  assert.deepEqual(picked, ["m1", "m1"]);
  // and words typed after Enter take its place, so it opens nothing
  s.type("gutter"); c.run();
  s.settle(r => picked.push("again " + (r && r.card)));
  s.type("gutters"); c.run();
  b.calls.at(-1).answer(200, answer([["m2", "garden", "Gutters"]]));
  await settle();
  assert.deepEqual(picked, ["m1", "m1"]);
});

test("shutting the panel stops what is out and keeps what was typed and found", async () => {
  const { s, c, b } = searcher();
  s.type("fence"); c.run();
  b.calls[0].answer(200, answer([["a", "garden", "Fence"]]));
  await settle();
  s.type("fence post"); c.run();
  s.halt();
  assert.equal(b.calls[1].aborted, true);
  assert.equal(s.q, "fence post");
  assert.deepEqual(plain(s.rows.map(r => r.card)), ["a"]);
  s.type("hedge"); s.halt();
  assert.deepEqual(c.pending(), []);
});

test("a project's own window asks for its own project alone", () => {
  const { s, c, b } = searcher("garden");
  s.type("fence"); c.run();
  assert.equal(b.calls[0].url, "/search?q=fence&prefix=1&limit=20&lane=garden");
});

// ---- the panel, on a small DOM ---------------------------------------------------------
const dom = { active: null };
const textNode = s => ({ nodeType: 3, textContent: s, parentNode: null });
function element(tag, cls = "") {
  const el = {
    tagName: tag.toUpperCase(), nodeType: 1, id: "", classes: new Set(String(cls || "").split(/\s+/).filter(Boolean)),
    children: [], parentNode: null, dataset: {}, attributes: {}, listeners: {}, scrollTop: 0, value: "", seen: 0,
    get className() { return [...this.classes].join(" "); },
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get classList() {
      const c = this.classes;
      return { add: n => c.add(n), remove: n => c.delete(n), contains: n => c.has(n),
        toggle: (n, on) => { if (on === undefined ? !c.has(n) : on) c.add(n); else c.delete(n); } };
    },
    get textContent() { return this.children.map(c => c.textContent).join(""); },
    set textContent(v) { this.children = []; if (v != null && v !== "") this.children.push(textNode(String(v))); },
    get isConnected() { let at = this; while (at.parentNode) at = at.parentNode; return at.tagName === "BODY"; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    contains(o) { for (let at = o; at; at = at.parentNode) if (at === this) return true; return false; },
    closest(sel) { for (let at = this; at && at.classes; at = at.parentNode) if (at.classes.has(sel.slice(1))) return at; return null; },
    querySelectorAll(sel) {
      const out = [], name = sel.slice(1);
      const walk = n => n.children.forEach(c => { if (c.classes?.has(name)) out.push(c); if (c.children) walk(c); });
      walk(this);
      return out;
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    focus() { dom.active = this; },
    blur() { if (dom.active === this) dom.active = null; },
    select() { this.selected = true; },
    scrollIntoView() { this.seen++; },
    fire(type, extra = {}) {
      const e = { type, target: this, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      for (let at = this; at; at = at.parentNode) for (const fn of at.listeners?.[type] || []) fn(e);
      return e;
    },
  };
  return el;
}

const box = (id, owner, extra = {}) => ({ id, owner, title: id, bucket: "must", ball: "you", replies: 0, ts: 1, agentTs: 1, ...extra });
function page(over = {}) {
  dom.active = null;
  const ids = {}, win = {}, doc = {}, calls = [], store = new Map();
  const make = (id, tag) => { const el = element(tag); el.id = id; ids[id] = el; return el; };
  const body = element("body", "focus");
  for (const [id, tag] of [["searchbtn", "button"], ["searchpanel", "div"]]) body.appendChild(make(id, tag));
  ids.searchpanel.appendChild(make("searchq", "input"));
  ids.searchpanel.appendChild(make("searchlist", "div"));
  const outside = body.appendChild(element("div", "stage"));
  const clk = clock(), b = board();
  const state = over.state || {
    pwds: { facilitator: "/Users/me/facilitator", garden: "/Users/me/my-garden", house: "/Users/me/house" },
    boxes: [box("f1", "facilitator"), box("f2", "facilitator", { docked: true }),
            box("g1", "garden"), box("g2", "garden", { docked: true }), box("g3", "garden", { done: true }),
            box("h1", "house")],
  };
  const context = {
    console, Date, AbortController, Promise,
    setTimeout: clk.later, clearTimeout: clk.cancel,
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: {
      body, createElement: tag => element(tag), createTextNode: textNode,
      getElementById: id => ids[id] || null,
      addEventListener(type, fn) { (doc[type] ||= []).push(fn); },
      get activeElement() { return dom.active; },
    },
    addEventListener(type, fn) { (win[type] ||= []).push(fn); },
    fetch: (url, opts) => b.ask(url, opts && opts.signal).then(({ status, body }) => ({ status, json: async () => body })),
    FOCUS: true, LOCKED: over.LOCKED || null, lastState: state, activeOwner: over.activeOwner || "facilitator",
    homeOpen: !!over.homeOpen, draft: null, pageMenu: null, lastSel: {}, els: {},
    validActiveOwnerIds: new Set(["facilitator", "garden", "house"]),
    closeProjMenu: () => calls.push("closeProjMenu"), shutPageMenu: () => calls.push("shutPageMenu"),
    miniHold: inside => calls.push("miniHold " + inside),
    tabClosed: ow => (over.closed || []).includes(ow),
    setTab: ow => { calls.push("setTab " + ow); context.activeOwner = ow; context.homeOpen = false; },
    reopenTab: ow => { calls.push("reopenTab " + ow); context.activeOwner = ow; context.homeOpen = false; },
    setView: v => { calls.push("setView " + v); context.setTicketViewOf(context.activeOwner, v); },
    select: id => calls.push("select " + id),
    queueFatCaret: () => calls.push("caret"),
    chromeShortcutBlocked: e => !!e.metaKey && e.key === "s",
  };
  for (const card of state.boxes) context.els[card.id] = {};
  vm.createContext(context);
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  vm.runInContext(between(HTML, "// ---- the search ---", "// ---- the fat caret"), context, { filename: "index.html search" });
  const key = (k, extra = {}) => {
    let stopped = false;
    const e = { key: k, target: dom.active || body, keyCode: 0, defaultPrevented: false, cancelable: true,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { stopped = true; }, ...extra };
    for (const fn of win.keydown || []) fn(e);
    return { prevented: e.defaultPrevented, stopped };
  };
  const type = q => { ids.searchq.value = q; ids.searchq.fire("input"); };
  return { context, ids, body, outside, calls, store, clk, b, key, type,
    open: () => ids.searchbtn.fire("click"),
    isOpen: () => body.classes.has("searchopen") && vm.runInContext("searchOpen", context),
    press: target => { for (const fn of doc.pointerdown || []) fn({ target }); },
    list: () => ids.searchlist.children,
    rows: () => ids.searchlist.querySelectorAll(".srow"),
    hot: () => ids.searchlist.querySelectorAll(".srow").filter(r => r.classes.has("hot")).map(r => r.dataset.at),
  };
}
async function found(p, q, cards, ready = true) {
  p.type(q);
  p.clk.run();
  p.b.calls.at(-1).answer(200, answer(cards, ready));
  await settle();
}
const rowText = row => ({
  title: row.children[0].children[0].textContent, section: row.children[0].children[1].textContent,
  snippet: row.children[1] ? row.children[1].textContent : null,
});
const markedIn = el => {
  const out = [];
  const walk = n => (n.children || []).forEach(c => { if (c.tagName === "MARK") out.push(c.textContent); walk(c); });
  walk(el);
  return out;
};

test("the magnifier opens the panel with the field holding the keys and its words picked whole", () => {
  const p = page();
  assert.equal(p.list()[0].textContent, "Card titles and everything in them, in every project", "the calm empty state");
  p.open();
  assert.equal(p.isOpen(), true);
  assert.equal(p.ids.searchbtn.attributes["aria-expanded"], "true");
  assert.equal(dom.active, p.ids.searchq);
  assert.equal(p.ids.searchq.selected, true);
  // whatever else had the keys lets them go
  assert.deepEqual(p.calls, ["closeProjMenu", "miniHold false"]);
  assert.equal(p.b.calls.length, 0, "an empty field asks nothing");
  // the panel's own transition places the block caret again
  p.ids.searchpanel.fire("transitionend", { propertyName: "opacity" });
  p.ids.searchpanel.fire("transitionend", { propertyName: "transform" });
  assert.equal(p.calls.filter(c => c === "caret").length, 1);
});

test("Escape shuts it and gives the focus back to what held it before; a press outside or the magnifier again shuts it too", () => {
  const p = page();
  // nothing held the focus: nothing holds it after
  p.open();
  const esc = p.key("Escape");
  assert.equal(p.isOpen(), false);
  assert.deepEqual([esc.prevented, esc.stopped], [true, true]);
  assert.equal(dom.active, null);
  assert.equal(p.ids.searchbtn.attributes["aria-expanded"], "false");
  // a card's typing box held it, and the click on the magnifier moved it there on the way
  const composer = p.body.appendChild(element("textarea"));
  composer.focus();
  p.press(p.ids.searchbtn);
  p.ids.searchbtn.focus();
  p.open();
  assert.ok(dom.active === p.ids.searchq);
  p.key("Escape");
  assert.ok(dom.active === composer, "the typing box did not get the focus back");
  // the keys reached the magnifier, and they go back to it
  p.ids.searchbtn.focus();
  p.open(); p.key("Escape");
  assert.ok(dom.active === p.ids.searchbtn, "the magnifier did not get the focus back");
  // something that has left the page since gets nothing, and nothing holds the focus
  const gone = p.body.appendChild(element("textarea"));
  gone.focus();
  p.open();
  p.body.children = p.body.children.filter(c => c !== gone);
  gone.parentNode = null;
  p.key("Escape");
  assert.ok(dom.active === null, "the focus went to something no longer on the page");
  p.open();
  p.press(p.ids.searchq); p.press(p.ids.searchlist);
  assert.equal(p.isOpen(), true, "a press inside the panel shut it");
  p.press(p.outside);
  assert.equal(p.isOpen(), false);
  assert.notEqual(dom.active, p.ids.searchq);
  p.open(); p.ids.searchbtn.fire("click");
  assert.equal(p.isOpen(), false);
  // and once it is shut its keys are the board's again
  assert.deepEqual(p.key("ArrowDown"), { prevented: false, stopped: false });
});

test("the words typed are searched after the pause and drawn in a group for each project, the first card picked", async () => {
  const p = page();
  p.open();
  p.type("gut");
  assert.equal(p.b.calls.length, 0);
  await found(p, "gutter", [
    ["g2", "garden", "Gutter repair", "The downpipe by the gutter leaks", [[4, 12], [20, 26]], "user", "doing"],
    ["f1", "facilitator", "Gutters and guttering", "Gutters and guttering", [[0, 7], [12, 21]], "title"],
    ["g1", "garden", "Shed roof", "🌧 the gutter overflows", [[6, 12]], "agent"],
  ]);
  assert.equal(p.b.calls.length, 1);
  assert.equal(p.b.calls[0].url, "/search?q=gutter&prefix=1&limit=20");
  const list = p.list();
  // the groups are named by the project's own folder name, the best card's first
  assert.deepEqual(list.filter(n => n.classes.has("sgroup")).map(n => n.textContent), ["my-garden", "facilitator"]);
  assert.deepEqual(list.map(n => n.classes.has("sgroup") ? "group" : n.dataset.at), ["group", "0", "1", "group", "2"]);
  const [first, second, third] = p.rows();
  // the title, and the section the card stands in on the board now (g2 is docked there)
  assert.deepEqual([rowText(first).title, rowText(first).section], ["Gutter repair", "Docked"]);
  assert.equal(rowText(first).snippet, "The downpipe by the gutter leaks");
  assert.deepEqual(markedIn(first.children[1]), ["downpipe", "gutter"]);
  assert.deepEqual(markedIn(first.children[0]), ["Gutter"], "the typed word is marked in the title");
  // the board's count of characters is kept past an emoji
  assert.deepEqual(markedIn(second.children[1]), ["gutter"]);
  // a title the board matched is said once, as the title
  assert.equal(third.children.length, 1);
  assert.deepEqual(markedIn(third), ["Gutters", "guttering"]);
  // the first card is picked, and assistive tech is told
  assert.deepEqual(p.hot(), ["0"]);
  assert.equal(first.attributes["aria-selected"], "true");
  assert.equal(p.ids.searchq.attributes["aria-activedescendant"], first.id);
  assert.equal(p.ids.searchq.attributes["aria-expanded"], "true");
});

test("the arrows move the pick without building the list again, and keep the picked card in view", async () => {
  const p = page();
  p.open();
  await found(p, "a", [["f1", "facilitator", "A"], ["g1", "garden", "B"], ["f2", "facilitator", "C"]]);
  const built = p.rows();
  const down = p.key("ArrowDown", { target: p.ids.searchq });
  assert.deepEqual([down.prevented, down.stopped], [true, true]);
  assert.deepEqual(p.hot(), ["1"]);
  assert.equal(p.rows()[1].seen > 0, true);
  p.key("ArrowDown"); p.key("ArrowDown");
  assert.deepEqual(p.hot(), ["2"], "the pick runs past the last card");
  p.key("ArrowUp"); p.key("ArrowUp"); p.key("ArrowUp");
  assert.deepEqual(p.hot(), ["0"]);
  assert.ok(p.rows().every((r, i) => r === built[i]), "the list was built again for a move");
  // shift with an arrow is the field's own selection
  assert.deepEqual(p.key("ArrowDown", { shiftKey: true }), { prevented: false, stopped: true });
  // the pointer moving over a card picks it, and a click opens it
  p.rows()[2].fire("mousemove");
  assert.deepEqual(p.hot(), ["2"]);
  p.rows()[2].children[0].children[0].fire("click");
  assert.equal(p.isOpen(), false);
  assert.equal(p.calls.at(-1), "select g1");
});

test("Enter opens a card in another project the way its ticket does: its project, its section, then the card", async () => {
  const p = page({ activeOwner: "facilitator" });
  p.open();
  await found(p, "gutter", [["g2", "garden", "Gutter repair"]]);
  p.calls.length = 0;
  const enter = p.key("Enter");
  assert.deepEqual([enter.prevented, enter.stopped], [true, true]);
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.calls, ["setTab garden", "select g2"]);
  assert.equal(p.store.get("tikview.garden"), "docked", "the project did not open on the card's section");
  assert.equal(p.context.lastSel.garden, "g2", "the project opened on another card first");
  assert.equal(p.context.activeOwner, "garden");
});

test("a card in the project on screen opens in its own section; a closed project opens again; Home is left for it", async () => {
  const same = page({ activeOwner: "garden" });
  same.store.set("tikview.garden", "todo");
  same.open();
  await found(same, "x", [["g3", "garden", "Done one"]]);
  same.calls.length = 0;
  same.key("Enter");
  assert.deepEqual(same.calls, ["setView done", "select g3"]);
  const here = page({ activeOwner: "garden" });
  here.open();
  await found(here, "x", [["g1", "garden", "Doing one"]]);
  here.calls.length = 0;
  here.key("Enter");
  assert.deepEqual(here.calls, ["select g1"], "a card already in the section on show switches nothing");

  const shut = page({ activeOwner: "facilitator", closed: ["house"] });
  shut.open();
  await found(shut, "x", [["h1", "house", "House"]]);
  shut.calls.length = 0;
  shut.key("Enter");
  assert.deepEqual(shut.calls, ["reopenTab house", "select h1"]);

  const home = page({ activeOwner: "garden", homeOpen: true });
  home.open();
  await found(home, "x", [["g1", "garden", "Doing one"]]);
  home.calls.length = 0;
  home.key("Enter");
  assert.deepEqual(home.calls, ["setTab garden", "select g1"]);
});

test("a card the board no longer holds, or one in another project from a project's own window, opens nothing", async () => {
  const p = page();
  p.open();
  await found(p, "x", [["gone", "garden", "Gone"]]);
  p.calls.length = 0;
  p.key("Enter");
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.calls, []);
  const own = page({ LOCKED: "garden", activeOwner: "garden" });
  assert.equal(own.list()[0].textContent, "Card titles and everything in them, in this project");
  own.open();
  await found(own, "x", [["f1", "facilitator", "Elsewhere"]]);
  assert.equal(own.b.calls[0].url, "/search?q=x&prefix=1&limit=20&lane=garden");
  own.calls.length = 0;
  own.key("Enter");
  assert.deepEqual(own.calls, []);
});

test("Enter typed before the pause has run searches at once and opens the first card it finds", async () => {
  const p = page({ activeOwner: "garden" });
  p.open();
  p.type("shed");
  p.calls.length = 0;
  p.key("Enter");
  assert.equal(p.isOpen(), true, "it shut before the search answered");
  assert.equal(p.b.calls.length, 1);
  p.b.calls[0].answer(200, answer([["g1", "garden", "Shed"]]));
  await settle();
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.calls, ["select g1"]);
  // a held Enter opens once
  const q = page();
  q.open();
  await found(q, "x", [["g1", "garden", "Shed"]]);
  q.key("Enter", { repeat: true });
  assert.equal(q.isOpen(), true);
});

test("no card matching says so, a field emptied goes back to the calm line at once, and trouble says why", async () => {
  const p = page();
  p.open();
  await found(p, "zzz", []);
  assert.deepEqual(p.list().map(n => n.textContent), ["No cards match “zzz”"]);
  assert.equal(p.ids.searchq.attributes["aria-expanded"], "false");
  assert.equal("aria-activedescendant" in p.ids.searchq.attributes, false);
  assert.deepEqual(p.key("Enter"), { prevented: true, stopped: true });
  assert.equal(p.isOpen(), true, "Enter with nothing found shut the panel");
  p.type("");
  assert.deepEqual(p.list().map(n => n.textContent), ["Card titles and everything in them, in every project"]);
  assert.equal(p.b.calls.length, 1);
  p.type("fence"); p.clk.run();
  p.b.calls.at(-1).answer(404, null);
  await settle();
  assert.deepEqual(p.list().map(n => n.textContent), ["Search starts working once the board restarts"]);
  await found(p, "fence", [["g1", "garden", "Fence"]], false);
  assert.equal(p.list().at(-1).textContent, "Still reading the board, so some cards may be missing");
});

test("opened again it searches the same words on the board as it is now", async () => {
  const p = page();
  p.open();
  await found(p, "fence", [["g1", "garden", "Fence"]]);
  p.key("Escape");
  p.open();
  assert.equal(p.ids.searchq.value, "fence");
  assert.equal(p.rows().length, 1, "the last cards stay on show until the new answer");
  assert.deepEqual(p.clk.pending(), [150]);
  p.clk.run();
  assert.equal(p.b.calls.at(-1).url, "/search?q=fence&prefix=1&limit=20");
});

test("while it is open the board's keys wait, the field keeps its typing and the Chrome shortcuts stay blocked", () => {
  const p = page();
  p.open();
  for (const k of ["ArrowRight", "ArrowLeft", "[", "]", "\\", "Backspace", "a", " "])
    assert.deepEqual(p.key(k), { prevented: false, stopped: true }, k);
  assert.deepEqual(p.key("t", { metaKey: true }), { prevented: false, stopped: true }, "the board's new card key");
  assert.deepEqual(p.key("s", { metaKey: true }), { prevented: true, stopped: true }, "Save Page got through");
  assert.deepEqual(p.key("Tab"), { prevented: true, stopped: true }, "the field is the panel's one stop");
  // a key typed while an input method is composing is the input method's
  assert.deepEqual(p.key("Enter", { isComposing: true }), { prevented: false, stopped: true });
  assert.equal(p.isOpen(), true);
  // a key aimed elsewhere brings the focus back to the field
  dom.active = p.outside;
  p.key("x", { target: p.outside });
  assert.equal(dom.active, p.ids.searchq);
  // a press in the panel never takes the focus out of the field
  assert.equal(p.rows().length, 0);
  assert.equal(p.ids.searchlist.fire("mousedown").defaultPrevented, true);
  assert.equal(p.ids.searchq.fire("mousedown").defaultPrevented, false);
});

// ---- the bar and the sheet, as written ----------------------------------------------------
const BAR = between(HTML, '<div class="bar">', "<!-- the pill's list");
const SHEET = [...HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const ruleOf = selector => {
  const at = SHEET.indexOf("\n  " + selector + "{");
  assert.ok(at >= 0, selector + " has no rule");
  return SHEET.slice(at + selector.length + 4, SHEET.indexOf("}", at)).replace(/\s+/g, " ").trim();
};

test("the magnifier is a glass circle in the bar just left of the speaker, drawn in the bar's own icon style", () => {
  const order = ["homeico", "projpill", "boardname", "searchbtn", "chimebtn", "feedbackbtn", "setbtn"].map(id => BAR.indexOf('id="' + id + '"'));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "the bar's order is not house, pill, magnifier, speaker, bug, squid");
  const tag = BAR.slice(order[3], BAR.indexOf("</button>", order[3]));
  assert.match(tag, /^id="searchbtn" class="qn-glass" type="button" title="Search cards" aria-label="Search cards" aria-haspopup="dialog" aria-expanded="false"/);
  // the speaker's and the bug's own drawing: 15px on the 24 unit box, 2 units of stroke, round ends
  const drawn = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  assert.ok(tag.includes(drawn + '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.34-4.34"/></svg>'), "the magnifier is not Lucide's, drawn as the bar draws");
  assert.ok(BAR.slice(order[4]).includes(drawn), "the speaker's drawing moved");
  // the circles' size, glass, hover and press, and the press script
  assert.match(SHEET, /body\.focus :is\(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn\)\{\s*flex:none; position:relative; box-sizing:border-box; width:32px; height:32px;\s*margin:0; padding:0; border-radius:50%;/);
  assert.match(SHEET, /body\.focus :is\(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn\):hover\{color:var\(--ink\)\}/);
  assert.match(SHEET, /body\.focus :is\(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn, #projpill, #npstart\)\.pressed\{transform:scale\(1\.06\)/);
  assert.match(HTML, /for \(const btn of \["homeico", "projpill", "searchbtn", "chimebtn", "feedbackbtn", "setbtn", "npstart"\]/);
  // the four at the right stand evenly apart, the magnifier starting the run
  assert.equal(ruleOf("body.focus .bar #searchbtn"), "margin-left:auto");
  assert.equal(ruleOf("body.focus .bar :is(#chimebtn, #feedbackbtn, #setbtn)"), "margin-left:3px");
  assert.doesNotMatch(SHEET, /body\.focus \.bar #chimebtn\{margin-left:auto\}/, "the speaker still pushes the right run");
  // pressed while the search is open, as the house is while Home is up
  assert.equal(ruleOf("body.focus.searchopen #searchbtn"), "color:var(--ink); --qn-tint:.95; --qn-edge:3");
});

test("the panel is the pill's list's glass, round, shade and timings, with no accent and no purple", () => {
  assert.match(HTML, /<div id="searchpanel" class="qn-glass" role="dialog" aria-label="Search cards">/);
  const panel = ruleOf("body.focus #searchpanel"), open = ruleOf("body.focus.searchopen #searchpanel");
  const list = ruleOf("body.focus #projmenu"), listOpen = ruleOf("body.focus.projopen #projmenu");
  const value = (rule, name) => (rule.match(new RegExp("(?:^|; )" + name + ":([^;]+)")) || [])[1];
  assert.equal(value(panel, "border-radius"), value(list, "border-radius"));
  assert.equal(value(panel, "border-radius"), "14px");
  for (const name of ["transition", "transform", "opacity", "visibility"]) assert.equal(value(panel, name), value(list, name), name);
  assert.equal(value(open, "transition"), value(listOpen, "transition"));
  assert.equal(ruleOf("body.focus #searchshade").replace(/z-index:\d+; /, ""), ruleOf("body.focus #projshade").replace(/z-index:\d+; /, ""));
  assert.equal(ruleOf("body.focus.searchopen #searchshade"), ruleOf("body.focus.projopen #projshade"));
  // the list's one line top rim, and the settings page's floating shadow under it
  assert.match(panel, /inset 0 -1px 0 rgba\(255,255,255,calc\(\.45 \* var\(--qn-edge\)\)\), inset 0 0 0 1px var\(--qn-ring\),/);
  assert.match(panel, /0 1px 3px rgba\(0,0,0,\.08\), 0 12px 32px rgba\(0,0,0,\.14\);/);
  // the board's own faces and inks
  assert.equal(value(ruleOf("#searchq"), "font"), "400 21px/28px var(--sans)");
  assert.equal(value(ruleOf("#searchlist .srow.hot"), "background"), "color-mix(in srgb, var(--ink) 6%, transparent)");
  assert.equal(value(ruleOf("#searchlist mark"), "color"), "var(--ink)");
  const css = between(HTML, "/* ---- the search ---", "/* ---- new-project tab");
  assert.doesNotMatch(css, /--accent|#432BFF|purple|violet/i);
  assert.doesNotMatch(between(HTML, "// ---- the search ---", "// ---- the fat caret"), /—/);
});

test("no key opens the search: the magnifier is its one way in, and the phone has none", () => {
  const code = between(HTML, "// ---- the search ---", "// ---- the fat caret");
  assert.deepEqual([...HTML.matchAll(/openSearch\(\)/g)].length, 2, "openSearch is called from somewhere new");
  assert.match(code, /searchBtn\.addEventListener\("click", \(\) => \{ if \(searchOpen\) closeSearch\(\); else openSearch\(\); \}\);/);
  const phone = fs.readFileSync(path.join(ROOT, "m.html"), "utf8");
  assert.doesNotMatch(phone, /searchbtn|searchpanel|cardSearch|\/search\b/);
});
