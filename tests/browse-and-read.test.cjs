// browsing cards without selecting them, and what counts as reading one,
// checked without a browser. the desktop board's own selection code, its key
// table and the large card's click wiring are cut out of index.html as written
// and run together over a small document,
// with the card logic the pages load, so the two work on one card as they do
// on the board. the phone and the small card share the two read rules in
// card-logic.js; they are run here on their own, and each surface's wiring of
// them is read off its page. nothing here renders a pixel: how the browsed
// ticket and the settled card look is only checked as the stylesheet states it.
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
// an element: classes, attributes, a textarea's value and selection, a style,
// a box a test may set, listeners of its own, and focus. focus says focus on
// the element and focusin to the document, as a browser does
class Node {
  constructor(doc, tag, { id = "", cls = [], attrs = {}, parent = null } = {}) {
    this.doc = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.classList = classes(cls);
    this.attrs = { ...attrs };
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.focusCalls = [];
    this.style = { setProperty(k, v) { this[k] = String(v); } };
    this.rect = null;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this._value = ""; this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = "none";
    if (parent) parent.appendChild(this);
  }
  get className() { return this.classList.names.join(" "); }
  set className(v) { this.classList = classes(String(v).split(/\s+/).filter(Boolean)); }
  get value() { return this._value; }
  set value(v) {
    this._value = v == null ? "" : String(v);
    this.selectionStart = this.selectionEnd = this._value.length;
  }
  setSelectionRange(a, b, dir) { this.selectionStart = a; this.selectionEnd = b ?? a; this.selectionDirection = dir || "forward"; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this);
    this.parentNode = null;
  }
  get offsetWidth() { return 0; }
  getBoundingClientRect() {
    const r = this.rect || { left: 0, top: 0, right: 0, bottom: 0 };
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
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
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, ...event }); }
  focus(opts) {
    this.focusCalls.push(opts);
    if (this.doc.activeElement === this) return;
    this.doc.activeElement = this;
    this.fire("focus");
    this.doc.fire("focusin", this);
  }
  blur() { if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body; }
  click() { this.fire("click"); }
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
  const doc = { visibilityState: "visible", listeners: {} };
  // what the page hangs on the document, and an event sent there
  doc.addEventListener = (type, fn) => (doc.listeners[type] ||= []).push(fn);
  doc.fire = (type, target, event = {}) => {
    for (const fn of doc.listeners[type] || []) fn({ type, target, ...event });
  };
  const body = new Node(doc, "body");
  doc.body = body;
  doc.head = new Node(doc, "head");
  doc.activeElement = body;
  // the house in the bar and the home page it opens, both outside the stage
  const homeico = new Node(doc, "button", { id: "homeico", parent: body });
  new Node(doc, "div", { id: "homeplot", parent: new Node(doc, "section", { id: "home", parent: body }) });
  const stage = new Node(doc, "div", { id: "stage", parent: body });
  const main = new Node(doc, "main", { parent: stage });
  const sections = new Node(doc, "div", { id: "sections", parent: main });
  const list = new Node(doc, "div", { id: "tiklist", parent: body });
  const els = {}, rows = [];
  // a card as makeBox builds its parts: the reply, the bar with its row and a
  // chip
  const addCard = (id, parent = sections) => {
    const box = new Node(doc, "div", { cls: ["box"], parent });
    const reply = new Node(doc, "div", { cls: ["replyview"], parent: box });
    const chip = new Node(doc, "button", { cls: ["xbtn"], parent: box });
    const bottombar = new Node(doc, "div", { cls: ["bottombar"], parent: box });
    const compose = new Node(doc, "div", { cls: ["compose"], parent: bottombar });
    const ta = new Node(doc, "textarea", { parent: compose });
    els[id] = { box, ta, tick() {}, chip, reply, replyview: reply, bottombar, toc: { classList: classes() } };
    const row = new Node(doc, "div", { cls: ["trow", "yours"], parent: list });
    row.dataset.id = id;
    rows.push(row);
    return els[id];
  };
  for (const id of CARDS) addCard(id);
  const all = node => node.children.flatMap(c => [c, ...all(c)]);
  doc.querySelector = selector => {
    if (selector === "main") return main;
    if (selector === "#tiklist .trow.on") return rows.find(r => r.classList.contains("on")) || null;
    return null;
  };
  doc.querySelectorAll = selector => (selector === "#tiklist .trow" ? rows : []);
  doc.getElementById = id => all(body).find(n => n.id === id) || null;
  doc.createElement = tag => new Node(doc, tag);
  const store = new Map();
  const state = { boxes: CARDS.map(id => card(id)) };
  const noop = () => {};
  // what the page hangs on the window: the board's own keydown listener among them
  const win = {};
  const sandbox = {
    console, Date, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    document: doc, requestAnimationFrame: noop, scrollTo: noop,
    addEventListener: (type, fn) => (win[type] ||= []).push(fn),
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
                    removeItem: k => store.delete(k) },
    fetch: (url, opts) => {
      if (url === "/seen") seen.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    // the formatter's plain face: the field is the textarea itself
    ComposeFormat: { focused: ta => doc.activeElement === ta },
    els, lastState: state, lastSel: {}, selectedId: null, shownId: null, browsing: false,
    FOCUS: true, activeOwner: "lane", draft: null, DRAFT: "__draft__", editMode: false, setEditMode: noop,
    miniFocused: false, p3Zoom: null,
    // what the board's own boardKeysLive asks, beside the home page's homeOpen
    pageWarn: null, pageMenu: null, qnOpen: false, setOpen: false, onBoardPage: () => true,
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
    // the home page, the board's key guard and the board's key listener
    between(html, "// ---- the home page ----", "// ---- the project's pages ----"),
    /^function boardKeysLive\(\)\{.*\}$/m.exec(html)[0],
    between(html, "// a press anywhere on the large card, or the keyboard's focus landing in it,", "\n// browsing: the card on screen"),
    between(html, "function setBrowsing(on){", "\nfunction updatePwd("),
    between(html, "function nav(dx, dy, opts){", "\n// keep a valid selection"),
    between(html, "function applySelection(state){", "\nfunction statusOf("),
    block(html, "function setTab(owner){"),
    block(html, "function deselect(){"),
    between(html, "function boardResponseCard(){", "\n// the grid compass") +
      between(html, "const boardShortcutTyping = cardShortcutEditing;", "\naddEventListener(\"keydown\", e => {\n  if (!FOCUS) return;"),
    between(html, "addEventListener(\"keydown\", e => {\n  if (!FOCUS) return;", "\n});\n") + "\n});\n",
  ];
  for (const part of parts) vm.runInContext(part, sandbox, { filename: "index.html" });
  sandbox.seenSync(state);
  const get = name => vm.runInContext(name, sandbox);
  assert.equal((win.keydown || []).length, 1, "the board's key listener was not the one hung");
  // a key pressed on the page, through the board's own listener
  const press = (key, { target = body, ...extra } = {}) => {
    const e = { key, target, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
                repeat: false, isComposing: false, defaultPrevented: false, ...extra,
                preventDefault() { e.defaultPrevented = true; } };
    for (const fn of win.keydown) fn(e);
    return e;
  };
  return {
    sandbox, doc, body, main, els, rows, state, seen, get, press, store, addCard, homeico,
    shown: () => get("selectedId"),
    browsing: () => get("browsing"),
    row: id => rows.find(r => r.dataset.id === id),
    // a pointer pressed on a node, as the page's own listener on the document hears it
    pressOn: node => doc.fire("pointerdown", node),
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
  // filter a folded row draws its own with, so one rule covers both, and no ring
  const browsed = rule("body.browsing .trow.on");
  assert.match(browsed, /transform:none/);
  assert.match(browsed, /box-shadow:none/);
  assert.match(browsed, /filter:drop-shadow\(0 1px 4px rgba\(60,45,20,\.05\)\)/);
  assert.doesNotMatch(browsed, /18px/, "the browsed ticket still casts the selected shadow");
  assert.doesNotMatch(browsed, /outline/, "the browsed ticket is drawn with a ring");
  assert.match(css, /\n  \.trow\{[^}]*box-shadow:0 1px 4px rgba\(60,45,20,\.05\)/, "the resting row shade is not the one named");
  // and the large card sits level with the board, its edge line kept
  assert.match(rule("body.focus.browsing main"), /box-shadow:none/);
  assert.match(css, /body\.focus\.minifocus main\{box-shadow:0 2px 18px rgba\(60,45,20,\.06\)\}/);
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
    ["with the settings page open", () => { d.sandbox.setOpen = true; d.body.classList.add("setopen"); const e = d.press("Enter"); d.sandbox.setOpen = false; d.body.classList.remove("setopen"); return e; }],
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
  // the settings page shuts on Escape before the board hears the key, so it
  // says the key is spent and lets no key past it; the menu, the picture and the
  // quick note already do
  assert.match(LOGIC, /veil\.addEventListener\("keydown", e => \{\n    e\.stopPropagation\(\);\n    if \(e\.key === "Escape"\)\{ e\.preventDefault\(\); close\(\); \}\n  \}\);/);
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
  d.pressOn(d.els.b.reply);
  assert.equal(d.browsing(), false, "a press in the card left it browsed");
  assert.deepEqual(d.seen, [{ b: 1 }]);
  d.press("Escape");
  d.pressOn(d.main);
  assert.equal(d.browsing(), false, "a press on the card's frame left it browsed");
  // the keyboard's focus landing in it
  d.press("Escape");
  d.els.b.chip.focus();
  assert.equal(d.browsing(), false, "the focus landing in the card left it browsed");
  // in edit mode a press is a drag
  d.press("Escape");
  d.sandbox.editMode = true;
  d.pressOn(d.els.b.reply);
  assert.equal(d.browsing(), true, "a drag in edit mode selected the card");
  d.sandbox.editMode = false;
  // and a press anywhere else on the board is no press on the card
  d.pressOn(d.row("a"));
  d.pressOn(d.body);
  assert.equal(d.browsing(), true, "a press off the card selected it");
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
  // the tab's own key on a card already selected leaves it selected
  d.press("Enter");
  d.get("setTab")("lane");
  assert.equal(d.browsing(), false, "browsing to the selected card on screen unselected it");
  assert.equal(d.doc.activeElement, d.els.b.ta, "browsing to the selected card on screen dropped its caret");
  d.press("Escape", { target: d.els.b.ta });
  d.press("Escape");
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
  // control+u and control+shift+\ both read selectedId, which names
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

// ---- with the home page ----------------------------------------------------------------
// the house opens a page above every project and hides the board under it. the
// page's own home block runs here: the house, setHome, and a tab leaving home

// the page's own arrival line from apply(), run in the page with a card's parts
function arrivalOf(d) {
  const line = /\n    (readOnArrival\(el, b, [^\n]*\);)\n/.exec(between(HTML.desktop, "function apply(state){", "\n// ---- the clock"))[1];
  const arrive = vm.runInContext(`(el, b) => { ${line} }`, d.sandbox);
  return (id, replies) => {
    const b = d.state.boxes.find(x => x.id === id);
    b.replies = replies;
    d.sandbox.seenSync(d.state);
    arrive(d.els[id], b);
  };
}

test("going home unselects the card, and nothing on the board is selected or read while home is up", () => {
  const d = loaded();
  const land = arrivalOf(d);
  land("a", 1);   // the first drawing
  d.press("Enter");
  assert.equal(d.doc.activeElement, d.els.a.ta, "the caret is not in the card's composer");
  d.seen.length = 0;
  d.homeico.click();
  assert.equal(d.get("homeOpen"), true, "the house did not open home");
  assert.ok(d.body.classList.contains("home"));
  assert.equal(d.browsing(), true, "the card stayed selected under the home page");
  assert.equal(d.doc.activeElement, d.body, "the caret stayed in the card under the home page");
  // a reply landing on the card under home waits
  land("a", 2);
  assert.deepEqual(d.seen, [], "a reply landing under the home page was read");
  // the board's keys are off: no browsing, no Enter, no Escape
  for (const key of ["ArrowRight", "Enter", "Escape"]) d.press(key);
  assert.equal(d.shown(), "a", "an arrow browsed the board under the home page");
  assert.equal(d.browsing(), true, "Enter selected a card under the home page");
  // and should anything reach the card or its composer, it neither selects
  // nor reads: a press, the focus, the composer's own use
  d.pressOn(d.els.a.reply);
  d.els.a.chip.focus();
  d.get("useCard")("a");
  assert.equal(d.browsing(), true, "the card was selected under the home page");
  assert.deepEqual(d.seen, [], "the card was read under the home page");
});

test("leaving home through a tab shows the card browsed, and it is read when selected", () => {
  const d = loaded();
  d.press("Enter");
  d.homeico.click();
  d.state.boxes.find(x => x.id === "a").replies = 2;
  d.sandbox.seenSync(d.state);
  d.seen.length = 0;
  // back through the same tab, as through another: browsed, nothing read
  d.get("setTab")("lane");
  assert.equal(d.get("homeOpen"), false, "the tab did not leave home");
  assert.ok(!d.body.classList.contains("home"));
  assert.equal(d.shown(), "a");
  assert.equal(d.browsing(), true, "the card came back selected from home");
  assert.deepEqual(d.seen, [], "coming back from home read the card");
  d.press("ArrowRight");
  assert.equal(d.shown(), "b", "the arrows did not browse once home was left");
  d.press("ArrowLeft");
  d.press("Enter");
  assert.equal(d.browsing(), false);
  assert.deepEqual(d.seen, [{ a: 2 }]);
});

test("a board reloaded onto the home page shows its card browsed and reads nothing", () => {
  const d = desktop();
  d.store.set("homeopen", "1");
  for (const fn of d.doc.listeners.DOMContentLoaded) fn();
  assert.equal(d.get("homeOpen"), true, "the reload did not come back to home");
  d.get("applySelection")(d.state);
  assert.equal(d.browsing(), true);
  assert.deepEqual(d.seen, []);
});

test("the browsing look is drawn only on the board, which the home page hides", () => {
  const css = HTML.desktop;
  // the two browsing rules paint the ticket and the card frame alone
  const rules = css.match(/^[^\n{]*\.browsing[^\n{]*\{/gm) || [];
  assert.deepEqual(rules.map(r => r.trim()),
    ["body.focus.browsing main{", "body.browsing .trow.on{"]);
  // both stand on the stage, and home hides the stage
  const at = marker => { const i = css.indexOf(marker); assert.ok(i >= 0, marker); return i; };
  assert.ok(at('<div id="stage">') < at('<div id="tickets">') && at('<div id="tickets">') < at("\n<main>"));
  assert.ok(at("\n</main>\n</div>\n") < at('<section id="home"'), "the home page is inside the stage");
  assert.match(css, /body\.focus\.home #stage\{visibility:hidden; opacity:0; pointer-events:none\}/);
});

// ---- the two read rules, shared by every surface --------------------------------------
function logic({ visible = true } = {}) {
  const seen = [];
  const doc = { visibilityState: visible ? "visible" : "hidden", activeElement: null, fire() {} };
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
  const mini = between(HTML.desktop, "      ComposeFormat.attach(ta, { newline: e => e.shiftKey });", "      box.append(sun, arc, x, title, answwrap, reply, sentwrap, compose);");
  assert.match(mini, /\n      readOnCompose\(ta, b\.id\);\n/, "the small card's composer");
  const phone = between(HTML.phone, "  const field = ComposeFormat.attach(ta, {", "  ta.addEventListener(\"keydown\", e => {");
  assert.match(phone, /\n  readOnCompose\(ta, b\.id, useCard\);\n/, "the phone's composer");
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
  // the phone: the selected card with no drawer over it, after its own seenSync
  const phone = between(HTML.phone, "function apply(state){", "\n  applySelection(state);");
  assert.match(phone, /\n    readOnArrival\(el, b, b\.id === selectedId && !browsing && !drawerOpen\(\)\);\n/);
  assert.ok(phone.indexOf("seenSync(state);") < phone.indexOf("readOnArrival("));
});

test("Enter is recognized only bare, and only the two full pages answer it", () => {
  const l = logic();
  const key = (k, extra) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
                               repeat: false, isComposing: false, defaultPrevented: false, ...extra });
  const resolve = (e, scope) => { const s = l.sandbox.cardShortcut(e, scope); return s && s.action; };
  assert.equal(resolve(key("Enter")), "enter");
  for (const m of ["ctrlKey", "metaKey", "shiftKey", "altKey", "repeat", "isComposing", "defaultPrevented"])
    assert.equal(resolve(key("Enter", { [m]: true })), null, `Enter with ${m}`);
  assert.equal(resolve(key("Enter"), "mini"), null, "the small card took Enter");
  // the phone browses too, so its table answers Enter
  assert.match(between(HTML.phone, "const phoneShortcutActions = {", "\n};"), /\n  enter\(e\)\{/);
});
