// browsing cards without selecting them, and what counts as reading one,
// checked without a browser. the desktop board's own selection code, its key
// table and the large card's click wiring are cut out of index.html as written
// and run over a small document, with the card logic the pages load. the
// phone and the small card share the two read rules in card-logic.js; they are
// run here on their own, and each surface's wiring of them is read off its
// page. nothing here renders a pixel: how the browsed ticket and the settled
// card look is only checked as the stylesheet states it.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = { desktop: read("index.html"), phone: read("m.html") };
const LOGIC = read("card-logic.js");

// the text from start up to (not including) end, both found in order
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `start marker missing: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `end marker missing after ${start}: ${end}`);
  return source.slice(from, to);
}
// one top level function or block, up to its own closing brace at the margin
const block = (source, start) => between(source, start, "\n}\n") + "\n}\n";

// ---- a small document ---------------------------------------------------------------
function classes(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach(n => set.add(n)),
    remove: (...names) => names.forEach(n => set.delete(n)),
    toggle(name, on) {
      const want = on === undefined ? !set.has(name) : !!on;
      if (want) set.add(name); else set.delete(name);
      return want;
    },
    contains: name => set.has(name),
    get names() { return [...set].sort(); },
  };
}
// enough of a selector to answer closest(): tags, #id, .class and [attr]
function matches(node, selector) {
  return selector.split(",").map(s => s.trim()).some(one => {
    const attr = /^\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/.exec(one);
    if (attr) return attr[1] in node.attrs && (attr[2] === undefined || node.attrs[attr[1]] === attr[2]);
    if (one.startsWith("#")) return node.id === one.slice(1);
    if (one.startsWith(".")) return node.classList.contains(one.slice(1));
    return node.tagName === one.toUpperCase();
  });
}
class Node {
  constructor(doc, tag, { id = "", cls = [], attrs = {}, parent = null } = {}) {
    this.doc = doc;
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = classes(cls);
    this.attrs = attrs;
    this.parentNode = parent;
    this.dataset = {};
    this.listeners = {};
    this.focusCalls = [];
  }
  closest(selector) {
    for (let n = this; n; n = n.parentNode) if (matches(n, selector)) return n;
    return null;
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, ...event }); }
  focus(opts) { this.focusCalls.push(opts); this.doc.activeElement = this; this.fire("focus"); }
  blur() { if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  scrollIntoView() {}
}

// ---- the desktop board ------------------------------------------------------------------
const CARDS = ["a", "b", "c"];
function card(id, extra) {
  return { id, owner: "lane", bucket: "meta", title: "card " + id, ball: "you", state: "yours",
           replies: 1, seen: 0, agentTs: 1, ts: 1, pending: 0, done: false, parked: false, ...extra };
}

// the board with its three cards drawn and none shown yet. every read mark the
// page sends is recorded, as the board would receive it
function desktop() {
  const seen = [];
  const doc = { visibilityState: "visible" };
  const body = new Node(doc, "body");
  doc.body = body;
  doc.activeElement = body;
  const main = new Node(doc, "main", { parent: body });
  const sections = new Node(doc, "div", { id: "sections", parent: main });
  const list = new Node(doc, "div", { id: "tiklist", parent: body });
  const els = {}, rows = [];
  for (const id of CARDS) {
    const box = new Node(doc, "div", { cls: ["box"], parent: sections });
    const compose = new Node(doc, "div", { cls: ["compose"], parent: box });
    const ta = new Node(doc, "textarea", { parent: compose });
    const chip = new Node(doc, "button", { cls: ["xbtn"], parent: box });
    const reply = new Node(doc, "div", { cls: ["replyview"], parent: box });
    els[id] = { box, ta, chip, reply, toc: { classList: classes() }, tick() {} };
    const row = new Node(doc, "div", { cls: ["trow", "yours"], parent: list });
    row.dataset.id = id;
    rows.push(row);
  }
  doc.querySelector = selector => {
    if (selector === "main") return main;
    if (selector === "#tiklist .trow.on") return rows.find(r => r.classList.contains("on")) || null;
    return null;
  };
  doc.querySelectorAll = selector => (selector === "#tiklist .trow" ? rows : []);
  doc.getElementById = () => null;
  const store = new Map();
  const state = { boxes: CARDS.map(id => card(id)) };
  const noop = () => {};
  const sandbox = {
    console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    document: doc, requestAnimationFrame: noop, scrollTo: noop,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
                    removeItem: k => store.delete(k) },
    fetch: (url, opts) => {
      if (url === "/seen") seen.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    ComposeFormat: { focused: ta => doc.activeElement === ta },
    els, lastState: state, lastSel: {}, selectedId: null, shownId: null, browsing: false,
    FOCUS: true, activeOwner: "lane", draft: null, DRAFT: "__draft__", editMode: false,
    miniFocused: false, p3Zoom: null, boardKeysLive: () => true,
    cancelAutoNext: noop, histExit: noop, syncDesktopHistoryAvailability: noop, updatePwd: noop,
    snapCard: noop, renderTabs: noop, rowsOf: () => ["lane"],
    // what setTab asks of the rest of the board
    ownerReady: true, validActiveOwnerIds: new Set(["lane", "other"]), LOCKED: null, endDraft: noop,
    applySavedLayout: noop, panelPoll: noop, chatPoll: noop, fileNavPoll: noop, apply: noop,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  // the board narrows the lane to the chosen workspace; here the lane is whole
  vm.runInContext("viewPool = state => state.boxes.filter(b => b.owner === activeOwner && !b.done && !b.parked);", sandbox);
  const html = HTML.desktop;
  const parts = [
    block(html, "{\n  const frame = document.querySelector(\"main\");"),
    between(html, "function setBrowsing(on){", "\nfunction updatePwd("),
    between(html, "function nav(dx, dy, opts){", "\n// keep a valid selection"),
    between(html, "function applySelection(state){", "\nfunction statusOf("),
    block(html, "function setTab(owner){"),
    block(html, "function deselect(){"),
    between(html, "function boardResponseCard(){", "\n// the grid compass") +
      between(html, "const boardShortcutTyping = cardShortcutEditing;", "\naddEventListener(\"keydown\", e => {\n  if (!FOCUS) return;"),
  ];
  for (const part of parts) vm.runInContext(part, sandbox, { filename: "index.html" });
  sandbox.seenSync(state);
  const get = name => vm.runInContext(name, sandbox);
  const actions = get("boardShortcutActions");
  // a key pressed the way the board's own listener hands it on
  const press = (key, { target = body, ...extra } = {}) => {
    const e = { key, target, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
                repeat: false, isComposing: false, defaultPrevented: false, ...extra,
                preventDefault() { e.defaultPrevented = true; } };
    sandbox.dispatchCardShortcut(e, actions);
    return e;
  };
  return {
    sandbox, doc, body, main, els, rows, state, seen, get, press,
    shown: () => get("selectedId"),
    browsing: () => get("browsing"),
    row: id => rows.find(r => r.dataset.id === id),
    settle: () => new Promise(r => setImmediate(r)),
  };
}

// a board as it stands after its first reading: the card it opened on shown
// and nothing chosen
function loaded() {
  const d = desktop();
  d.get("applySelection")(d.state);
  return d;
}

test("the first reading shows a card browsed and reads nothing", () => {
  const d = loaded();
  assert.equal(d.shown(), "a");
  assert.equal(d.browsing(), true, "the card the board opened on counts as selected");
  assert.ok(d.body.classList.contains("browsing"), "the page does not draw it browsed");
  assert.deepEqual(d.seen, [], "opening the board marked a card read");
});

test("the arrow keys browse: the ticket is marked, nothing is selected and nothing is read", () => {
  const d = loaded();
  for (const [key, want] of [["ArrowRight", "b"], ["ArrowRight", "c"], ["ArrowLeft", "b"]]) {
    const e = d.press(key);
    assert.equal(e.defaultPrevented, true, `${key} was left to the page`);
    assert.equal(d.shown(), want);
    assert.equal(d.browsing(), true, `${key} selected the card it passed`);
    assert.ok(d.body.classList.contains("browsing"));
    assert.ok(d.row(want).classList.contains("on"), "the browsed ticket is not marked");
    assert.ok(!d.row(want).classList.contains("seen"), "the browsed ticket was drawn read");
    assert.ok(d.els[want].box.classList.contains("sel"), "the browsed card is not shown");
    assert.equal(d.els[want].ta.focusCalls.length, 0, "browsing put the caret in the composer");
  }
  assert.deepEqual(d.seen, [], "browsing marked a card read");
  assert.equal(d.get("lastSel").lane, "b", "the lane does not remember the card browsed to");
  // the arrows are the caret's while a field is being typed in
  d.press("Enter");
  const e = d.press("ArrowRight", { target: d.els.b.ta });
  assert.equal(e.defaultPrevented, false);
  assert.equal(d.shown(), "b");
});

test("the browsed ticket and card give up the selected drop shadow, as the sheet states it", () => {
  const css = HTML.desktop;
  const rule = selector => {
    const at = css.indexOf(selector + "{");
    assert.ok(at >= 0, `no rule for ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  // the selected look is the one it was
  const selected = rule("  .trow.on");
  assert.match(selected, /transform:translateY\(-1px\)/);
  assert.match(selected, /box-shadow:0 2px 18px rgba\(60,45,20,\.18\), 0 1px 3px rgba\(60,45,20,\.10\)/);
  // browsed: no lift and only the resting shade every row has, drawn as the
  // filter a folded row draws its own with, so one rule covers both, plus a
  // pale ring
  const browsed = rule("body.browsing .trow.on");
  assert.match(browsed, /transform:none/);
  assert.match(browsed, /box-shadow:none/);
  assert.match(browsed, /filter:drop-shadow\(0 1px 4px rgba\(60,45,20,\.05\)\)/);
  assert.doesNotMatch(browsed, /18px/, "the browsed ticket still casts the selected shadow");
  assert.match(browsed, /outline:2px solid var\(--accent-soft\)/);
  assert.match(css, /\n  \.trow\{[^}]*box-shadow:0 1px 4px rgba\(60,45,20,\.05\)/, "the resting row shade is not the one named");
  // and the large card settles the way it does for the small card
  assert.match(css, /body\.focus\.minifocus main, body\.focus\.browsing main\{box-shadow:0 2px 18px rgba\(60,45,20,\.06\)\}/);
});

test("Enter selects the browsed card where it stands, reads it and puts the caret in its composer", async () => {
  const d = loaded();
  d.press("ArrowRight");
  const e = d.press("Enter");
  assert.equal(e.defaultPrevented, true);
  assert.equal(d.shown(), "b");
  assert.equal(d.browsing(), false, "Enter left the card browsed");
  assert.ok(!d.body.classList.contains("browsing"), "the card did not take its drop shadow back");
  assert.deepEqual(d.seen, [{ b: 1 }], "Enter did not mark the card read");
  assert.ok(d.row("b").classList.contains("seen"), "the ticket is not drawn read at once");
  assert.equal(d.doc.activeElement, d.els.b.ta, "the caret is not in the composer");
  assert.equal(JSON.stringify(d.els.b.ta.focusCalls), JSON.stringify([{ preventScroll: true }]));
});

test("Enter is left alone on a button, while typing, in the small card or with a modifier", () => {
  const d = loaded();
  d.press("ArrowRight");
  const cases = [
    ["on a button in the card", () => d.press("Enter", { target: d.els.b.chip })],
    ["in the composer", () => d.press("Enter", { target: d.els.b.ta })],
    ["with shift", () => d.press("Enter", { shiftKey: true })],
    ["held down", () => d.press("Enter", { repeat: true })],
    ["already answered", () => d.press("Enter", { defaultPrevented: true })],
    ["with the small card holding the keys", () => { d.sandbox.miniFocused = true; const e = d.press("Enter"); d.sandbox.miniFocused = false; return e; }],
    ["with a picture open", () => { d.sandbox.p3Zoom = {}; const e = d.press("Enter"); d.sandbox.p3Zoom = null; return e; }],
    ["with the settings panel open", () => { d.body.classList.add("setopen"); const e = d.press("Enter"); d.body.classList.remove("setopen"); return e; }],
    ["on a new tab choosing its folder", () => { d.sandbox.draft = { screen: "home" }; const e = d.press("Enter"); d.sandbox.draft = null; return e; }],
  ];
  for (const [name, run] of cases) {
    run();
    assert.equal(d.browsing(), true, `Enter ${name} selected the card`);
  }
  assert.deepEqual(d.seen, []);
  assert.equal(d.els.b.ta.focusCalls.length, 0);
});

test("Escape: the first leaves the composer, the next unselects, and the card stays on screen", () => {
  const d = loaded();
  d.press("ArrowRight");
  d.press("Enter");
  assert.equal(d.doc.activeElement, d.els.b.ta);
  d.seen.length = 0;
  // the caret is in the composer: the first Escape only takes it out
  d.press("Escape", { target: d.els.b.ta });
  assert.equal(d.doc.activeElement, d.body, "the first Escape left the caret in the composer");
  assert.equal(d.browsing(), false, "the first Escape unselected the card");
  // the next one unselects, and the card is still the one on screen
  d.press("Escape");
  assert.equal(d.browsing(), true, "the second Escape left the card selected");
  assert.ok(d.body.classList.contains("browsing"));
  assert.equal(d.shown(), "b");
  assert.ok(d.els.b.box.classList.contains("sel"), "unselecting took the card off the screen");
  assert.ok(d.row("b").classList.contains("on"), "unselecting took the mark off the ticket");
  // a third changes nothing, and Enter selects it again
  d.press("Escape");
  assert.equal(d.browsing(), true);
  assert.equal(d.shown(), "b");
  d.press("Enter");
  assert.equal(d.browsing(), false);
  assert.deepEqual(d.seen, [], "a card already read was marked again");
});

test("Escape leaves the card selected when something else answered it or holds the keys", () => {
  const d = loaded();
  d.press("Enter");
  const holders = [
    ["answered first (a menu, a picture, the quick note)", () => d.press("Escape", { defaultPrevented: true })],
    ["held down", () => d.press("Escape", { repeat: true })],
    ["with the small card holding the keys", () => { d.sandbox.miniFocused = true; d.press("Escape"); d.sandbox.miniFocused = false; }],
    ["with a picture open", () => { d.sandbox.p3Zoom = {}; d.press("Escape"); d.sandbox.p3Zoom = null; }],
    ["with the drawer open", () => { d.body.classList.add("resp-drawer-open"); d.press("Escape"); d.body.classList.remove("resp-drawer-open"); }],
    ["with the confirmation or a menu up", () => { d.sandbox.boardKeysLive = () => false; d.press("Escape"); d.sandbox.boardKeysLive = () => true; }],
  ];
  for (const [name, run] of holders) {
    run();
    assert.equal(d.browsing(), false, `Escape ${name} unselected the card`);
  }
  // the settings panel shuts on Escape before the board hears the key, so it
  // says the key is spent; the menu, the picture and the quick note already do
  assert.match(HTML.desktop, /document\.addEventListener\("keydown", e => \{\n    if \(e\.key === "Escape" && isOpen\(\)\)\{ e\.preventDefault\(\); shut\(\); \}\n  \}\);/);
  assert.match(HTML.desktop, /if \(e\.key !== "Escape" \|\| !pageMenu\) return;\n  e\.preventDefault\(\); e\.stopPropagation\(\);/);
  assert.match(HTML.desktop, /if \(e\.key !== "Escape" \|\| !p3Zoom\) return;\n  e\.preventDefault\(\); e\.stopPropagation\(\);/);
  assert.match(LOGIC, /e\.stopPropagation\(\);\n    if \(e\.key === "Escape"\)\{ e\.preventDefault\(\); close\(\); return; \}/);
});

test("unselecting lets go of a button in the card, so Enter selects rather than presses it", () => {
  const d = loaded();
  d.press("Enter");
  d.els.a.chip.focus();
  d.press("Escape", { target: d.els.a.chip });
  assert.equal(d.browsing(), true);
  assert.equal(d.doc.activeElement, d.body, "the button kept the focus");
  d.press("Enter");
  assert.equal(d.browsing(), false);
  assert.equal(d.doc.activeElement, d.els.a.ta);
});

test("a click on a ticket, or a press or the focus in the large card, selects and reads", () => {
  const d = loaded();
  d.press("ArrowRight");
  // anywhere on the card: its reply, its frame
  d.main.fire("pointerdown", { target: d.els.b.reply });
  assert.equal(d.browsing(), false, "a press in the card left it browsed");
  assert.deepEqual(d.seen, [{ b: 1 }]);
  d.press("Escape");
  d.main.fire("pointerdown", { target: d.main });
  assert.equal(d.browsing(), false, "a press on the card's frame left it browsed");
  // the keyboard's focus landing in it
  d.press("Escape");
  d.main.fire("focusin", { target: d.els.b.chip });
  assert.equal(d.browsing(), false, "the focus landing in the card left it browsed");
  // in edit mode a press is a drag
  d.press("Escape");
  d.sandbox.editMode = true;
  d.main.fire("pointerdown", { target: d.els.b.reply });
  assert.equal(d.browsing(), true, "a drag in edit mode selected the card");
  d.sandbox.editMode = false;
  // a ticket's click is select(), as it always was
  d.get("select")("c");
  assert.equal(d.shown(), "c");
  assert.equal(d.browsing(), false);
  assert.deepEqual(d.seen, [{ b: 1 }, { c: 1 }]);
  assert.ok(d.row("c").classList.contains("seen"));
});

test("the step that carries the caret selects, a tab switch browses, and the hop keeps the mode", () => {
  const d = loaded();
  // control+shift+right from the composer walks on with the caret, which is
  // using the next card
  d.press("Enter");
  d.seen.length = 0;
  d.press("ArrowRight", { ctrlKey: true, shiftKey: true, target: d.els.a.ta });
  assert.equal(d.shown(), "b");
  assert.equal(d.browsing(), false);
  assert.equal(d.doc.activeElement, d.els.b.ta);
  assert.deepEqual(d.seen, [{ b: 1 }]);
  // switching tabs is looking, like the arrows
  d.state.boxes.push(card("o1", { owner: "other" }));
  d.els.o1 = { box: new Node(d.doc, "div"), ta: new Node(d.doc, "textarea"), toc: { classList: classes() }, tick() {} };
  d.sandbox.seenSync(d.state);
  d.get("setTab")("other");
  assert.equal(d.shown(), "o1");
  assert.equal(d.browsing(), true, "a tab switch selected the tab's card");
  d.get("setTab")("lane");
  assert.equal(d.shown(), "b", "the lane did not come back to its card");
  assert.equal(d.browsing(), true);
  // the hop after a close or a snooze: a browsed card hops to a browsed card
  d.seen.length = 0;
  d.sandbox.selectNextDoing("b");
  assert.equal(d.shown(), "a");
  assert.equal(d.browsing(), true, "the hop from a browsed card selected the next one");
  assert.deepEqual(d.seen, []);
  // and a selected card to a selected one, read, as it always did. the card it
  // lands on has had a reply since it was last read
  d.press("Enter");
  d.state.boxes.find(x => x.id === "b").replies = 2;
  d.sandbox.seenSync(d.state);
  d.seen.length = 0;
  d.sandbox.selectNextDoing("a");
  assert.equal(d.shown(), "b");
  assert.equal(d.browsing(), false);
  assert.deepEqual(d.seen, [{ b: 2 }]);
});

test("the keys that act on the card act on the browsed one", () => {
  const d = loaded();
  d.press("ArrowRight");
  // control+u, control+shift+\ and backspace all read selectedId, which names
  // the card on screen whether it is selected or only browsed
  const src = between(HTML.desktop, "const boardShortcutActions = {", "\n};");
  assert.match(src, /unfold\(e\)\{\n    if \(!miniFocused\) unfoldSelected\(e, selectedId, selectedId && els\[selectedId\]\);/);
  assert.match(src, /sectionChord\(e, shortcut\)\{\n    const el = selectedId && els\[selectedId\];/);
  const unfolds = [];
  d.sandbox.unfoldSelected = (e, id) => unfolds.push(id);
  d.press("u", { ctrlKey: true });
  assert.deepEqual(unfolds, ["b"]);
  assert.equal(d.browsing(), true, "control+u selected the card");
});

// ---- the two read rules, shared by every surface --------------------------------------
function logic({ visible = true } = {}) {
  const seen = [];
  const doc = { visibilityState: visible ? "visible" : "hidden", activeElement: null };
  const sandbox = {
    console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    document: doc,
    ComposeFormat: { focused: ta => doc.activeElement === ta },
    fetch: (url, opts) => {
      if (url === "/seen") seen.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  const ta = new Node(doc, "textarea");
  const other = new Node(doc, "textarea");
  return { sandbox, doc, seen, ta, other };
}

test("clicking into a composer or typing there reads the card; the formatter's own input does not", () => {
  const l = logic();
  l.sandbox.seenSync({ boxes: [card("m1", { replies: 2 })] });
  l.sandbox.readOnCompose(l.ta, "m1");
  // the formatter puts its editor on every row at load and says input: the
  // caret is nowhere near, so nothing is read
  l.ta.fire("input");
  assert.deepEqual(l.seen, []);
  // a click into the row
  l.ta.focus();
  assert.deepEqual(l.seen, [{ m1: 2 }]);
  // a reply lands and the reader types on
  l.sandbox.seenSync({ boxes: [card("m1", { replies: 3, seen: 2 })] });
  l.ta.fire("input");
  assert.deepEqual(l.seen, [{ m1: 2 }, { m1: 3 }]);
  // a page that does more with it hands its own
  const used = [];
  const m = logic();
  m.sandbox.readOnCompose(m.ta, "m2", id => used.push(id));
  m.ta.focus();
  m.ta.fire("input");
  assert.deepEqual(used, ["m2", "m2"]);
});

test("a desktop composer used on a browsed card selects it where it stands", () => {
  const d = loaded();
  d.press("ArrowRight");
  d.sandbox.readOnCompose(d.els.b.ta, "b", d.get("useCard"));
  d.els.b.ta.focus();
  assert.equal(d.browsing(), false, "a click into the composer left the card browsed");
  assert.deepEqual(d.seen, [{ b: 1 }]);
});

test("a reply landing while the caret is in the composer is read at once, and only then", () => {
  const land = (l, el, b, inUse) => {
    l.sandbox.seenSync({ boxes: [b] });   // the poll takes the counts in first
    return l.sandbox.readOnArrival(el, b, inUse);
  };
  // the caret in the composer of the card in use, the page on screen
  const l = logic();
  const el = { ta: l.ta };
  assert.equal(land(l, el, card("m1", { replies: 1 }), true), false, "the first drawing marked the card");
  l.ta.focus();
  assert.equal(land(l, el, card("m1", { replies: 1 }), true), false, "a poll with nothing new marked it");
  assert.equal(land(l, el, card("m1", { replies: 2 }), true), true);
  assert.deepEqual(l.seen, [{ m1: 2 }]);
  // the page hidden: the reply waits
  const hidden = logic({ visible: false });
  const hel = { ta: hidden.ta };
  land(hidden, hel, card("m1", { replies: 1 }), true);
  hidden.ta.focus();
  assert.equal(land(hidden, hel, card("m1", { replies: 2 }), true), false, "a hidden page read the reply");
  assert.deepEqual(hidden.seen, []);
  // the caret somewhere else
  const away = logic();
  const ael = { ta: away.ta };
  land(away, ael, card("m1", { replies: 1 }), true);
  away.other.focus();
  assert.equal(land(away, ael, card("m1", { replies: 2 }), true), false, "a card with no caret read the reply");
  // not the card in use: browsed, another card, a drawer over it
  const idle = logic();
  const iel = { ta: idle.ta };
  land(idle, iel, card("m1", { replies: 1 }), true);
  idle.ta.focus();
  assert.equal(land(idle, iel, card("m1", { replies: 2 }), false), false, "a card not in use read the reply");
  assert.deepEqual(idle.seen, []);
  // and once the reader is back in the row, the next arrival is read
  assert.equal(land(idle, iel, card("m1", { replies: 3 }), true), true);
  assert.deepEqual(idle.seen, [{ m1: 3 }]);
});

// ---- each surface's wiring, as its page writes it -------------------------------------
test("every composer is wired to the read rule after its formatter, on every surface", () => {
  const desktopBox = between(HTML.desktop, "    const field = ComposeFormat.attach(ta, { newline: e => e.shiftKey });", "    ta.addEventListener(\"keydown\", e => composerEnter(e, b.id));");
  assert.match(desktopBox, /\n    readOnCompose\(ta, b\.id, useCard\);\n/, "the large card's composer");
  const mini = between(HTML.desktop, "      ComposeFormat.attach(ta, { newline: e => e.shiftKey });", "      box.append(sun, arc, x, title, answwrap, reply, pend, compose);");
  assert.match(mini, /\n      readOnCompose\(ta, b\.id\);\n/, "the small card's composer");
  const phone = between(HTML.phone, "  const field = ComposeFormat.attach(ta, {", "  ta.addEventListener(\"keydown\", e => {");
  assert.match(phone, /\n  readOnCompose\(ta, b\.id\);\n/, "the phone's composer");
  // and nothing else on those surfaces marks a card read on focus or input
  for (const [name, html] of Object.entries(HTML))
    assert.equal((html.match(/readOnCompose\(/g) || []).length, name === "desktop" ? 2 : 1, name);
});

test("every surface asks the arrival rule for the card it is using, after the counts came in", () => {
  // the large card: selected, not browsed, on the board's poll after seenSync
  const poll = between(HTML.desktop, "async function poll(){", "\n// the card whose response");
  assert.ok(poll.indexOf("seenSync(state);") < poll.indexOf("apply(state);"), "the board draws before it takes the counts in");
  const apply = between(HTML.desktop, "function apply(state){", "\n// ---- the clock");
  assert.match(apply, /\n    readOnArrival\(el, b, b\.id === selectedId && !browsing\);\n/);
  // the small card: the card it is showing, drawn in the same apply
  const mini = between(HTML.desktop, "function renderMiniCards(state){", "\n// ---- the carousel");
  assert.match(mini, /\n    readOnArrival\(el, b, b\.id === miniId\);\n/);
  assert.ok(apply.indexOf("renderMiniCards(state);") > apply.indexOf("readOnArrival("));
  // the phone: the open card with no drawer over it, after its own seenSync
  const phone = between(HTML.phone, "function apply(state){", "\n  applySelection(state);");
  assert.match(phone, /\n    readOnArrival\(el, b, b\.id === selectedId && !drawerOpen\(\)\);\n/);
  assert.ok(phone.indexOf("seenSync(state);") < phone.indexOf("readOnArrival("));
});

test("Enter is the board's key alone, recognized only bare", () => {
  const l = logic();
  const key = (k, extra) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
                               repeat: false, isComposing: false, defaultPrevented: false, ...extra });
  const resolve = (e, scope) => { const s = l.sandbox.cardShortcut(e, scope); return s && s.action; };
  assert.equal(resolve(key("Enter")), "enter");
  for (const m of ["ctrlKey", "metaKey", "shiftKey", "altKey", "repeat", "isComposing", "defaultPrevented"])
    assert.equal(resolve(key("Enter", { [m]: true })), null, `Enter with ${m}`);
  assert.equal(resolve(key("Enter"), "mini"), null, "the small card took Enter");
  // the phone has no browsing, so its table carries no Enter
  assert.ok(!/\n  enter\(e\)\{/.test(between(HTML.phone, "const phoneShortcutActions = {", "\n};")));
});
