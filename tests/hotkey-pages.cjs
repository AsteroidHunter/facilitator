// The Mac board's and the phone page's own key handlers, cut out of index.html,
// m.html and card-logic.js as shipped and run in a VM over a small DOM: one
// card on screen with its title, box and buttons, a second card, the project
// bar, the ticket list, the small card, the goal box and a panel with a file
// navigator. Keys go through capture, target and bubble as a browser sends
// them (page-event-model.cjs), so a handler that stops a key keeps it from the
// page's window listeners. The page's actions are spies; the rules that decide
// whether they run are the real ones. No browser, no board, no network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");
const vm = require("node:vm");
const { dispatch } = require("./page-event-model.cjs");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const LOGIC = read("card-logic.js");
const MAC = read("index.html");
const PHONE = read("m.html");

function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source anchors: ${start} .. ${end}`);
  return text.slice(a, b);
}

// ---- a small DOM ------------------------------------------------------------
// one simple selector: a tag, then any #id, .class, [attr] and [attr='v']
function matchOne(node, selector) {
  const m = /^([a-z0-9]*)(.*)$/i.exec(selector.trim());
  if (m[1] && node.tag !== m[1].toLowerCase()) return false;
  const rest = m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
  if (rest.join("") !== m[2]) return false;
  return rest.every(part => {
    if (part[0] === "#") return node.id === part.slice(1);
    if (part[0] === ".") return node.classes.has(part.slice(1));
    const [name, value] = part.slice(1, -1).split("=");
    if (!node.attrs.has(name)) return false;
    return value === undefined || node.attrs.get(name) === value.replace(/^['"]|['"]$/g, "");
  });
}

class Node {
  constructor(doc, tag, parent, { id, cls, attrs } = {}) {
    this.doc = doc; this.tag = tag; this.parent = null; this.children = [];
    this.listeners = []; this.id = id || ""; this.text = "";
    this.classes = new Set((cls || "").split(" ").filter(Boolean));
    this.attrs = new Map(Object.entries(attrs || {}));
    this.dataset = {}; this.style = {};
    const classes = this.classes;
    this.classList = {
      contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
    };
    if (parent) parent.appendChild(this);
  }
  appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  get isConnected() { for (let at = this; at; at = at.parent) if (at === this.doc.document) return true; return false; }
  get isContentEditable() {
    for (let at = this; at; at = at.parent) {
      if (!at.attrs) return false;
      if (at.attrs.has("contenteditable")) return at.attrs.get("contenteditable") !== "false";
    }
    return false;
  }
  get textContent() { return this.text; }
  set textContent(value) { for (const c of [...this.children]) c.remove(); this.text = String(value); }
  get value() { return this.text; }
  set value(v) { this.text = String(v); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  matches(selector) { return selector.split(",").some(s => matchOne(this, s)); }
  closest(selector) { for (let at = this; at && at.attrs; at = at.parent) if (at.matches(selector)) return at; return null; }
  contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const out = [];
    const walk = n => { for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  addEventListener(type, fn, options = false) {
    const capture = options === true || !!(options && options.capture);
    this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type, fn, options = false) {
    const capture = options === true || !!(options && options.capture);
    this.listeners = this.listeners.filter(l => l.type !== type || l.fn !== fn || l.capture !== capture);
  }
  set onkeydown(fn) {
    if (!this.idl) { this.idl = e => this.keyHandler && this.keyHandler(e); this.addEventListener("keydown", this.idl); }
    this.keyHandler = fn;
  }
  get onkeydown() { return this.keyHandler || null; }
  focus() {
    const was = this.doc.document.activeElement;
    if (was === this) return;
    this.doc.document.activeElement = this;
    if (was) was.lostFocus();
  }
  blur() {
    if (this.doc.document.activeElement !== this) return;
    this.doc.document.activeElement = this.doc.body;
    this.lostFocus();
  }
  lostFocus() {
    if (this.onblur) this.onblur();
    for (const l of this.listeners.filter(l => l.type === "blur")) l.fn({ target: this });
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  scrollIntoView() {}
  select() {}
  // a failed assertion names the node instead of printing the whole tree
  [util.inspect.custom]() { return `<${this.tag}${this.id ? "#" + this.id : ""}${[...this.classes].map(c => "." + c).join("")}>`; }
}

function dom() {
  const doc = {};
  const make = (tag, parent, opts) => new Node(doc, tag, parent, opts);
  doc.window = make("window", null);
  doc.document = make("document", doc.window);
  doc.html = make("html", doc.document);
  doc.body = make("body", doc.html);
  doc.document.body = doc.body; doc.document.documentElement = doc.html;
  doc.document.activeElement = doc.body;
  doc.document.createElement = tag => make(tag, null);
  doc.make = make;
  doc.byId = id => {
    const walk = n => { if (n.id === id) return n; for (const c of n.children) { const f = walk(c); if (f) return f; } return null; };
    return walk(doc.document);
  };
  return doc;
}

// a card as both pages build it: the title, the four chips and the history
// arrows on its top row, the answer with a code block's copy button, the
// answered panel above it, the sent box, and the box being typed in
function card(doc, parent, id) {
  const make = doc.make;
  const box = make("article", parent, { cls: "box", id: "box-" + id });
  const top = make("div", box, { cls: "topbar" });
  const chip = name => make("button", top, { cls: name, attrs: { "aria-disabled": "false" } });
  const sun = chip("sunbtn"), dock = chip("dockbtn"), arc = chip("arcbtn"), x = chip("xbtn");
  const histUp = make("button", top, { cls: "histbtn older" });
  const titleEl = make("span", box, { cls: "title" });
  titleEl.textContent = "Card " + id;
  const replyview = make("div", box, { cls: "replyview" });
  Object.assign(replyview, { clientHeight: 400, scrollHeight: 2000, scrollTop: 1000, ownerDocument: doc.document });
  const answwrap = make("div", replyview, { cls: "answwrap" });
  const answeredRow = make("button", answwrap, { cls: "answrow" });
  const reply = make("div", replyview, { cls: "reply cardmd" });
  const copy = make("button", reply, { cls: "copybtn" });
  const pendwrap = make("div", box, { cls: "pendwrap" });
  const pendRow = make("button", pendwrap, { cls: "pendrow" });
  const compose = make("div", box, { cls: "compose" });
  const ta = make("textarea", compose);
  const el = { box, titleEl, replyview, reply, answwrap, pendwrap, ta, sun, dock, arc, x, histUp,
    field: { focused: () => doc.document.activeElement === ta } };
  return { el, parts: { title: titleEl, sun, dock, arc, x, histUp, copy, answeredRow, pendRow, ta, reply } };
}

// the keys the hotkey map pressed, as a browser names them
const KEYS = {
  "cmd+t": { key: "t", code: "KeyT", metaKey: true },
  "cmd+2": { key: "2", code: "Digit2", metaKey: true },
  "ctrl+shift+right": { key: "ArrowRight", code: "ArrowRight", ctrlKey: true, shiftKey: true },
  "right": { key: "ArrowRight", code: "ArrowRight" },
  "ctrl+shift+up": { key: "ArrowUp", code: "ArrowUp", ctrlKey: true, shiftKey: true },
  "escape": { key: "Escape", code: "Escape" },
  "enter": { key: "Enter", code: "Enter" },
  "ctrl+enter": { key: "Enter", code: "Enter", ctrlKey: true },
  "ctrl+r": { key: "r", code: "KeyR", ctrlKey: true },
  "ctrl+s": { key: "s", code: "KeyS", ctrlKey: true },
  "ctrl+u": { key: "u", code: "KeyU", ctrlKey: true },
  "ctrl+shift+]": { key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true },
  "ctrl+shift+[": { key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true },
  "ctrl+shift+backspace": { key: "Backspace", code: "Backspace", ctrlKey: true, shiftKey: true },
  "]": { key: "]", code: "BracketRight" },
  "a": { key: "a", code: "KeyA" },
  "ctrl+shift+,": { key: "<", code: "Comma", ctrlKey: true, shiftKey: true },
  "down": { key: "ArrowDown", code: "ArrowDown" },
  "ctrl+shift+'": { key: "\"", code: "Quote", ctrlKey: true, shiftKey: true },
  "tab": { key: "Tab", code: "Tab" },
  "shift+tab": { key: "Tab", code: "Tab", shiftKey: true },
  "ctrl+tab": { key: "Tab", code: "Tab", ctrlKey: true },
};

function pressOn(doc, target, name, over = {}) {
  const e = dispatch(target, { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    repeat: false, isComposing: false, ...KEYS[name], ...over });
  return e;
}

// what both pages share in the VM: card-logic.js as shipped, the DOM, timers
// that never fire, and spies for the page actions the keys ask for
function base(doc, calls, extra) {
  const ctx = vm.createContext({
    Date, console, Promise, URL, URLSearchParams,
    window: doc.window, document: doc.document,
    addEventListener: doc.window.addEventListener.bind(doc.window),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    performance: { now: () => 1000 }, matchMedia: () => ({ matches: true }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    ...extra,
  });
  doc.document.createRange = () => ({ selectNodeContents() {} });
  doc.document.getElementById = doc.byId;
  doc.window.matchMedia = ctx.matchMedia;
  vm.runInContext(LOGIC, ctx, { filename: "card-logic.js" });
  Object.assign(ctx, {
    fetch: (url, init) => { calls.push(["fetch", String(url).split("&")[0], init && init.method]); return Promise.resolve({ json: async () => ({}) }); },
    poll() {}, omniRetitleCard() {},
    sectionKeyMove: (id, section) => { calls.push(["section", id, section]); return true; },
    histStep: (id, dir) => calls.push(["history", id, dir]),
    unselectShown: () => calls.push(["unselect"]),
    chooseShown: () => calls.push(["choose"]),
  });
  // the real response scroll, noted when it takes the chord
  const scroll = ctx.responseScrollKey;
  ctx.responseScrollKey = (e, find) => {
    const took = scroll(e, find);
    if (took) calls.push(["scroll"]);
    return took;
  };
  return ctx;
}

// ---- the Mac board ----------------------------------------------------------
function macPage({ page = "board" } = {}) {
  const doc = dom(), make = doc.make, calls = [];
  const bar = make("span", doc.body, { id: "tabbar" });
  const projectTab = make("button", bar, { cls: "ptab on" });
  const tickets = make("div", doc.body, { id: "tickets" });
  const sectionName = make("button", tickets, { id: "tv-docked", cls: "ptab tvb" });
  const pageDot = make("button", make("div", doc.body, { id: "pagepill" }), { cls: "pdot" });
  const speaker = make("button", doc.body, { id: "mutebtn" });
  const main = make("main", doc.body);
  const a = card(doc, main, "c1"), b = card(doc, main, "c2");
  const magic2 = make("div", doc.body, { id: "magic2" });
  const mbox = make("div", make("div", magic2, { cls: "mlist" }), { cls: "mbox" });
  const mtitle = make("div", mbox, { cls: "mtitle", attrs: { tabindex: "0" } });
  mtitle.textContent = "Small card";
  const msun = make("button", mbox, { cls: "msun", attrs: { "aria-disabled": "false" } });
  const mdock = make("button", mbox, { cls: "mdock", attrs: { "aria-disabled": "false" } });
  const mta = make("textarea", make("div", mbox, { cls: "mcompose" }));
  const goalbox = make("div", doc.body, { id: "goalbox", cls: "trio" });
  const goaltext = make("span", goalbox, { id: "goaltext", cls: "trio-text" });
  const magic3 = make("div", doc.body, { id: "magic3" });
  const navRow = make("button", magic3, { cls: "fnavrow file" });
  const editor = make("div", magic3, { cls: "cm-editor" });
  const fileEditor = make("div", editor, { cls: "cm-content", attrs: { contenteditable: "true" } });

  const boxes = [{ id: "c1", owner: "one", bucket: "meta", testing: true, state: "yours" },
    { id: "c2", owner: "one", bucket: "meta", state: "yours" }, { id: "m1", owner: "facilitator", bucket: "meta" }];
  const pages = page === "blank" ? { one: [{ id: "p2", kind: "blank" }] } : undefined;
  const ctx = base(doc, calls, {
    FOCUS: true, homeOpen: false, pageWarn: null, pageMenu: null, setOpen: false, draft: null, DRAFT: "__new__",
    ownerReady: true, LOCKED: null, p3Zoom: null, browsing: false,
    activeOwner: page === "new project" ? "__new__" : "one", selectedId: "c1",
    lastState: { boxes, ...(pages ? { pages } : {}) },
    els: { c1: a.el, c2: b.el }, miniFocused: false, miniId: "m1",
    miniEls: { m1: { box: mbox, title: mtitle, ta: mta, sun: msun, dock: mdock } },
  });
  if (page === "new project") ctx.draft = { screen: "home", from: "one" };
  Object.assign(ctx, {
    newCard: owner => calls.push(["create", owner]),
    setTab: owner => calls.push(["tab", owner]),
    nav: dx => calls.push(["navigate", dx]),
    boardAdvance: id => calls.push(["advance", id]),
    browse: id => calls.push(["random", id]),
    viewPool: state => state.boxes,
    rowsOf: () => ["one", "two", "three"],
    curPage: (st, owner) => (st.pages && st.pages[owner] || [])[0] || null,
    miniCreate: () => calls.push(["small create"]),
    miniStep: dir => calls.push(["small step", dir]),
    cardDeparture: () => ({ order: [], section: "todo" }), selectNextCard() {},
  });
  const run = source => vm.runInContext(source, ctx, { filename: "index.html" });
  run(between(MAC, "function onBoardPage(state){", "async function addPage(){"));
  run(between(MAC, "function inlineEdit(spanEl, initial, onSave){", "// ---- card state:"));
  run(between(MAC, "function miniEditTitle(id, opts){", "function renderMiniCards(state){"));
  run(between(MAC, "function boardResponseCard(){", "// releases, other keys"));
  // the small card's box: its own key handler, as renderMiniCards hangs it
  const miniBox = between(MAC, '      ta.addEventListener("keydown", e => {', '      ta.addEventListener("keyup"');
  const sent = [];
  vm.runInContext(`(ta, fire) => {\n${miniBox}\n}`, ctx)(mta, () => { sent.push(mta.value); return Promise.resolve(mta.value ? true : null); });

  const places = {
    board: () => doc.body,
    composer: () => a.parts.ta,
    title: () => { ctx.editTitle("c1"); return a.parts.title; },
    "card button": () => a.parts.dock,
    "copy button": () => a.parts.copy,
    "project tab": () => projectTab,
    "section name": () => sectionName,
    "page dot": () => pageDot,
    speaker: () => speaker,
    "small card box": () => { ctx.miniHold(true); mta.focus(); return mta; },
    "small card title": () => { ctx.miniHold(true); ctx.miniEditTitle("m1"); return mtitle; },
    "small card clicked": () => { ctx.miniHold(true); return doc.body; },
    "goal editor": () => {
      ctx.inlineEdit(goaltext, "the goal", v => calls.push(["goal saved", v]));
      return goaltext.querySelector("input");
    },
    "navigator row": () => navRow,
    "file editor": () => fileEditor,
    "sent box button": () => a.parts.pendRow,
    "answered panel button": () => a.parts.answeredRow,
    "another card's button": () => b.parts.dock,
    "another card's title": () => { ctx.editTitle("c2"); return b.parts.title; },
  };
  return {
    doc, ctx, calls, sent, a, b, mtitle, mta, goaltext, places,
    // put the page in a place, press one key there, and answer what it did
    press(place, name, over) {
      const target = places[place]();
      if (target !== doc.body && target.focus) target.focus();
      calls.length = 0;
      const e = pressOn(doc, target, name, over);
      return { e, calls: calls.map(c => c.join(" ")), target };
    },
    // one key on a node, the page left as it is
    send(target, name, over) {
      calls.length = 0;
      const e = pressOn(doc, target, name, over);
      return { e, calls: calls.map(c => c.join(" ")), target };
    },
  };
}

// ---- the phone page ---------------------------------------------------------
function phonePage() {
  const doc = dom(), make = doc.make, calls = [];
  const pane = make("main", doc.body, { id: "pane" });
  const cards = make("div", pane, { id: "cards" });
  const a = card(doc, cards, "c1"), b = card(doc, cards, "c2");
  const tickets = make("div", doc.body, { id: "tickets" });
  const sheet = make("div", tickets, { id: "tiksheet" });
  const todo = make("div", sheet, { cls: "tikpane", attrs: { "data-view": "todo" } });
  const rows = ["c1", "c2"].map(id => { const r = make("div", todo, { cls: "trow" }); r.dataset.id = id; return r; });
  const listButton = make("button", tickets, { id: "tv-docked", cls: "ptab tvb" });
  const settings = make("div", doc.body, { id: "settings" });
  const settingsField = make("input", settings);
  const state = { menu: null };
  doc.document.querySelector = s => (/data-view="todo"/.test(s) ? todo : null);
  const ctx = base(doc, calls, {
    homeOpen: false, phoneDeveloperMode: false, activeOwner: "one", selectedId: "c1", browsing: false,
    lastState: { boxes: [{ id: "c1", owner: "one", bucket: "meta", testing: true, state: "yours" },
      { id: "c2", owner: "one", bucket: "meta", state: "yours" }] },
    els: { c1: a.el, c2: b.el }, tickets, settings,
  });
  Object.assign(ctx, {
    menuOut: () => state.menu, drawerOpen: () => state.menu === tickets,
    showMenu: panel => { state.menu = panel; doc.body.classList.add("menuout"); calls.push(["show", panel === tickets ? "list" : "settings"]); },
    hideMenu: () => { state.menu = null; doc.body.classList.remove("menuout"); calls.push(["hide"]); },
    closeDrawer: () => { state.menu = null; doc.body.classList.remove("menuout"); },
    createCard: () => { ctx.closeDrawer(); calls.push(["create"]); },
    setTab: owner => calls.push(["tab", owner]),
    chooseRow: row => calls.push(["tab", row.dataset.owner]),
    barOwners: () => ["one", "two", "three"],
    stepCard: dir => calls.push(["navigate", dir]),
    phoneAdvance: id => calls.push(["advance", id]),
    navigationPool: state => state.boxes,
    browse: id => { ctx.selectedId = id; calls.push(["browse", id]); },
    select: id => calls.push(["select", id]),
    syncDrawerPick: () => null, curView: () => "todo", setView: v => calls.push(["view", v]),
    saveDiagnostic: () => calls.push(["diagnostic"]),
    closeCard: id => calls.push(["close", id]),
  });
  const run = source => vm.runInContext(source, ctx, { filename: "m.html" });
  run(between(PHONE, "function phoneResponseCard(){", "// a tap anywhere on the card on screen"));
  run(between(PHONE, 'addEventListener("keydown", e => {\n  dispatchCardShortcut(e, homeOpen', "// releases, other keys"));

  const places = {
    card: () => doc.body,
    composer: () => a.parts.ta,
    title: () => { ctx.editTitle("c1"); return a.parts.title; },
    "card button": () => a.parts.dock,
    "copy button": () => a.parts.copy,
    "card list": () => { ctx.showMenu(tickets); return doc.body; },
    "card list button": () => { ctx.showMenu(tickets); return listButton; },
    settings: () => { ctx.showMenu(settings); return doc.body; },
    "settings field": () => { ctx.showMenu(settings); return settingsField; },
    home: () => { ctx.homeOpen = true; return doc.body; },
    "sent box button": () => a.parts.pendRow,
    "answered panel button": () => a.parts.answeredRow,
    "another card's button": () => b.parts.dock,
  };
  return {
    doc, ctx, calls, a, b, rows, state, tickets, places,
    press(place, name, over) {
      const target = places[place]();
      if (target !== doc.body && target.focus) target.focus();
      calls.length = 0;
      const e = pressOn(doc, target, name, over);
      return { e, calls: calls.map(c => c.join(" ")), target };
    },
    // one key on a node, the page left as it is
    send(target, name, over) {
      calls.length = 0;
      const e = pressOn(doc, target, name, over);
      return { e, calls: calls.map(c => c.join(" ")), target };
    },
  };
}

module.exports = { macPage, phonePage, KEYS, between };
