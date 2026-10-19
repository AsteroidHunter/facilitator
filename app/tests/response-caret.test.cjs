// The response's read-only caret and the card's three places. Control+Option with
// up and down steps between a card's title, its response and its typing box, top to
// bottom, stopping at either end; in the response the browser's own caret stands
// while nothing typed can change the answer. The shared cardShortcut, cardPlace,
// replyCaret and the rest are run out of card-logic.js over small stand-ins that keep
// the focus and the selection the way a page does; each page's own action for the
// key is lifted from index.html and m.html and run the same way.
// No browser, layout, server or live board is involved.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const logic = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const mac = readFileSync(path.join(ROOT, "index.html"), "utf8");
const phone = readFileSync(path.join(ROOT, "m.html"), "utf8");
// the key list moved out of the runbook into the docs
const boardDocs = readFileSync(path.join(ROOT, "..", "docs", "board.md"), "utf8");
const tokens = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");

function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b + end.length);
}

function event(key, modifiers = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    isComposing: false, repeat: false, defaultPrevented: false, ...modifiers };
}

// a range over the stand-in nodes: a container and an offset at each end
function range() {
  return {
    startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
    selectNodeContents(n) { this.startContainer = this.endContainer = n; this.startOffset = 0; this.endOffset = 1; },
    setStart(n, o) { this.startContainer = n; this.startOffset = o; },
    collapse(toStart) {
      if (toStart) { this.endContainer = this.startContainer; this.endOffset = this.startOffset; }
      else { this.startContainer = this.endContainer; this.startOffset = this.endOffset; }
    },
    cloneRange() { return Object.assign(range(), this); },
  };
}

// one card on a page: a title, a response holding one paragraph of words, a typing
// box and a button, with the focus and the selection kept as a page keeps them
function world() {
  const doc = { active: null, hasFocus: true, listeners: {}, focusOpts: null, log: [] };
  const sel = {
    ranges: [],
    get rangeCount() { return this.ranges.length; },
    getRangeAt(i) { return this.ranges[i]; },
    removeAllRanges() { this.ranges = []; },
    addRange(r) { this.ranges = [r]; },
  };
  const blurOf = n => { if (doc.active === n) { doc.active = null; for (const fn of n.listeners.blur || []) fn(); } };
  const focusOn = n => {
    const prev = doc.active;
    if (prev === n) return;
    doc.active = n;
    doc.log.push(n.name);
    if (prev) for (const fn of prev.listeners.blur || []) fn();
    if (prev && prev.onblur) prev.onblur();
  };
  // extra is laid on with its getters kept as getters
  const node = (name, extra = {}) => Object.defineProperties({
    name, nodeType: 1, attrs: {}, listeners: {},
    setAttribute(n, v) { this.attrs[n] = String(v); },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    removeAttribute(n) { delete this.attrs[n]; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    contains(n) { return n === this; },
    focus(opts) { doc.focusOpts = opts; focusOn(this); },
    blur() { blurOf(this); },
  }, Object.getOwnPropertyDescriptors(extra));
  const answer = name => {
    const words = { nodeType: 3, data: "\n  The answer's first words" };
    return node(name, {
      words, innerHTML: "<p>The answer's first words</p>",
      get isContentEditable() { return this.attrs.contenteditable === "true"; },
      contains(n) { return n === this || n === words; },
      getBoundingClientRect: () => ({ left: 10, top: 0, bottom: 400 }),
    });
  };
  const reply = answer("response"), words = reply.words;
  const title = node("title", { textContent: "A named card",
    get isContentEditable() { return this.attrs.contenteditable === "plaintext-only"; } });
  const ta = node("compose", { value: "half typed" });
  const sun = node("sun");
  const replyview = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 300 }) };
  const el = { titleEl: title, reply, replyview, ta, sun, field: { focused: () => doc.active === ta } };
  const calls = { editTitle: 0 };
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
    NodeFilter: { SHOW_TEXT: 4 },
    document: {
      get activeElement() { return doc.active; },
      hasFocus: () => doc.hasFocus,
      createRange: range,
      createTreeWalker: root => { let done = false; return { nextNode: () => (done ? null : (done = true, root.words)) }; },
      addEventListener: (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    },
    getSelection: () => sel,
    getComputedStyle: () => ({ paddingLeft: "6", lineHeight: "24", fontSize: "16" }),
    els: { 7: el },
  });
  vm.runInContext(logic, context, { filename: "card-logic.js" });
  // the title opened as Tab opens it, without the rest of the rename
  context.editTitle = id => { calls.editTitle++; title.attrs.contenteditable = "plaintext-only"; title.focus(); };
  const toBox = e => e.ta.focus();
  const place = step => context.cardPlace("7", step, toBox);
  const where = () => (doc.active ? doc.active.name : "nothing");
  const fire = (n, type, extra = {}) => {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of n.listeners[type] || []) fn(e);
    return e;
  };
  return { doc, sel, el, reply, title, ta, sun, words, replyview, context, calls, place, where, fire, answer };
}

// ---- the chord ---------------------------------------------------------------------

test("Control+Option with up and down is the place key: up -1, down 1", () => {
  const { context } = world();
  const resolve = e => { const s = context.cardShortcut(e); return s && { action: s.action, value: s.value }; };
  assert.deepEqual(resolve(event("ArrowUp", { ctrlKey: true, altKey: true })), { action: "place", value: -1 });
  assert.deepEqual(resolve(event("ArrowDown", { ctrlKey: true, altKey: true })), { action: "place", value: 1 });
  // a held key's repeats are still the chord, so the page can keep them from the browser
  assert.deepEqual(resolve(event("ArrowUp", { ctrlKey: true, altKey: true, repeat: true })), { action: "place", value: -1 });
});

test("the place key wants exactly Control and Option: the neighbouring chords keep what they were", () => {
  const { context } = world();
  const action = e => (context.cardShortcut(e) || {}).action || null;
  for (const key of ["ArrowUp", "ArrowDown"]) {
    // Control+Shift is the older and newer replies, with Option held or not
    assert.equal(action(event(key, { ctrlKey: true, shiftKey: true })), "history");
    assert.equal(action(event(key, { ctrlKey: true, shiftKey: true, altKey: true })), "history");
    // Command with them, Option alone, Control alone and plain are the text's own
    assert.equal(action(event(key, { ctrlKey: true, altKey: true, metaKey: true })), null);
    assert.equal(action(event(key, { altKey: true })), null);
    assert.equal(action(event(key, { altKey: true, shiftKey: true })), null);
    assert.equal(action(event(key, { ctrlKey: true })), null);
    assert.equal(action(event(key, { ctrlKey: true, altKey: true, isComposing: true })), null);
    assert.equal(action(event(key)), "drawerWalk");
  }
  // left and right with the same two are the magic box's, not the place key's
  for (const key of ["ArrowLeft", "ArrowRight"]) assert.equal(action(event(key, { ctrlKey: true, altKey: true })), "magicJump");
  // the small card has no response of this kind and no such key
  assert.equal(context.cardShortcut(event("ArrowUp", { ctrlKey: true, altKey: true }), "mini"), null);
});

// ---- the three places ----------------------------------------------------------------

test("up goes from the typing box to the response to the title, and stops there", () => {
  const w = world();
  w.ta.focus();
  assert.equal(w.place(-1), true);
  assert.equal(w.where(), "response");
  assert.equal(w.place(-1), true);
  assert.equal(w.where(), "title");
  assert.equal(w.calls.editTitle, 1);
  assert.equal(w.place(-1), false);
  assert.equal(w.where(), "title");
});

test("down goes from the title to the response to the typing box, and stops there", () => {
  const w = world();
  w.title.attrs.contenteditable = "plaintext-only";
  w.title.focus();
  assert.equal(w.place(1), true);
  assert.equal(w.where(), "response");
  assert.equal(w.place(1), true);
  assert.equal(w.where(), "compose");
  assert.equal(w.place(1), false);
  assert.equal(w.where(), "compose");
  assert.equal(w.ta.value, "half typed");
});

test("with nothing focused, or a button of the card, up lands in the response and down in the box", () => {
  for (const start of [null, "sun"]) {
    const up = world();
    if (start) up[start].focus();
    up.place(-1);
    assert.equal(up.where(), "response", String(start));
    const down = world();
    if (start) down[start].focus();
    down.place(1);
    assert.equal(down.where(), "compose", String(start));
  }
});

test("a title already being renamed is focused again rather than opened a second time", () => {
  const w = world();
  w.title.attrs.contenteditable = "plaintext-only";
  w.reply.focus();
  w.place(-1);
  assert.equal(w.where(), "title");
  assert.equal(w.calls.editTitle, 0);
});

// ---- the response's caret ------------------------------------------------------------

test("the response takes an editable face and the focus, with no keyboard asked for and nothing checked", () => {
  const w = world();
  w.place(-1);
  assert.deepEqual({ ...w.reply.attrs }, {
    contenteditable: "true", inputmode: "none", spellcheck: "false", autocorrect: "off", autocapitalize: "off",
    writingsuggestions: "false", role: "textbox", "aria-multiline": "true", "aria-readonly": "true" });
  assert.equal(w.doc.active, w.reply);
  assert.deepEqual({ ...w.doc.focusOpts }, { preventScroll: true });
});

test("the caret starts on the answer's first letter when the answer stands at its head", () => {
  const w = world();
  w.place(-1);
  const at = w.sel.getRangeAt(0);
  assert.equal(at.startContainer, w.words);
  assert.equal(at.startOffset, 3);   // past the line break and the two spaces
  assert.equal(at.endContainer, w.words);
  assert.equal(at.endOffset, 3);
});

test("in a scrolled answer the caret starts on the first line on show", () => {
  const w = world();
  w.replyview.scrollTop = 240;
  const seen = [];
  w.context.document.caretRangeFromPoint = (x, y) => {
    seen.push([x, y]);
    const r = range();
    r.setStart(w.words, 9);
    r.collapse(true);
    return r;
  };
  w.place(-1);
  assert.equal(w.sel.getRangeAt(0).startOffset, 9);
  // read at the prose's own column, half a line under the top of what shows
  assert.deepEqual(seen[0], [10 + 6 + 1, 100 + 12]);
});

test("the caret comes back to where it stood, a selection included", () => {
  const w = world();
  w.place(-1);
  const kept = range();
  kept.setStart(w.words, 5);
  kept.endContainer = w.words; kept.endOffset = 12;
  w.sel.addRange(kept);
  for (const fn of w.doc.listeners.selectionchange) fn();
  w.place(1);
  assert.equal(w.where(), "compose");
  w.place(-1);
  const back = w.sel.getRangeAt(0);
  assert.deepEqual([back.startOffset, back.endOffset], [5, 12]);
  // a selection elsewhere is not the answer's to keep
  w.ta.focus();
  const other = range();
  w.sel.addRange(other);
  for (const fn of w.doc.listeners.selectionchange) fn();
  assert.equal(w.el.replyMark.startOffset, 5);
});

test("a kept place the answer no longer holds (a new answer was drawn) gives way to the first letter", () => {
  const w = world();
  const gone = range();
  gone.setStart({ nodeType: 3, data: "old" }, 1);
  gone.collapse(true);
  w.el.replyMark = gone;
  w.place(-1);
  assert.equal(w.sel.getRangeAt(0).startContainer, w.words);
});

test("nothing typed, pasted, dropped, deleted, formatted or undone reaches the answer, and a cut takes nothing", () => {
  const w = world();
  w.place(-1);
  for (const inputType of ["insertText", "insertParagraph", "insertFromPaste", "insertFromDrop", "deleteContentBackward",
    "deleteWordBackward", "deleteByCut", "deleteByDrag", "formatBold", "historyUndo", "insertReplacementText"])
    assert.equal(w.fire(w.reply, "beforeinput", { inputType }).defaultPrevented, true, inputType);
  assert.equal(w.fire(w.reply, "cut").defaultPrevented, true);
  // copying is left to the browser
  assert.equal(w.fire(w.reply, "copy").defaultPrevented, false);
});

test("a word an input method composed is taken back out once it ends", async () => {
  const w = world();
  w.place(-1);
  w.fire(w.reply, "compositionstart");
  w.reply.innerHTML = "<p>The answer's first words かな</p>";
  w.fire(w.reply, "compositionend");
  await new Promise(r => setTimeout(r, 5));
  assert.equal(w.reply.innerHTML, "<p>The answer's first words</p>");
});

test("leaving the response makes it plain prose again; a window put behind another keeps the caret", () => {
  const w = world();
  w.place(-1);
  // the window loses the focus: the answer keeps its caret, as a text field does
  w.doc.hasFocus = false;
  for (const fn of w.reply.listeners.blur) fn();
  assert.equal(w.reply.attrs.contenteditable, "true");
  w.doc.hasFocus = true;
  // the focus goes elsewhere: the answer is plain again and refuses nothing
  w.ta.focus();
  assert.deepEqual({ ...w.reply.attrs }, {});
  assert.equal(w.fire(w.reply, "beforeinput", { inputType: "insertText" }).defaultPrevented, false);
  assert.equal(w.fire(w.reply, "cut").defaultPrevented, false);
});

test("the answer of a card left with its caret in it is made plain when another card's answer takes the caret", () => {
  const w = world();
  w.place(-1);
  const second = w.answer("second response");
  w.context.els[8] = { ...w.el, reply: second };
  w.doc.active = null;   // the card was hidden and its answer lost the focus with no blur
  w.context.cardPlace("8", -1, e => e.ta.focus());
  assert.deepEqual({ ...w.reply.attrs }, {});
  assert.equal(second.attrs.contenteditable, "true");
  assert.equal(w.where(), "second response");
});

test("the response is a place of the reader's choosing, so Tab from it goes as from the card itself", () => {
  const w = world();
  w.ta.focus();
  w.context.cardStop(w.el);          // the loop's card stop
  assert.equal(w.el.cycleStop, true);
  w.place(-1);
  assert.equal(w.el.cycleStop, false);
});

// ---- what the caret standing in the answer still lets through ---------------------------

test("the section chords and Control+S may come from the response's caret", () => {
  const w = world();
  w.el.reply.closest = sel => (/contenteditable/.test(sel) ? w.reply : null);
  w.el.ta.closest = () => w.ta;
  w.place(-1);
  assert.equal(w.context.sectionChordSource(w.reply, w.el), true);
  // another editable field still keeps them
  const field = { closest: sel => (/contenteditable|textarea/.test(sel) ? field : null) };
  assert.equal(w.context.sectionChordSource(field, w.el), false);
  const doc = { body: {}, documentElement: {} };
  w.el.replyview.ownerDocument = doc;
  assert.equal(w.context.responseScrollSource(w.reply, w.el), true);
});

test("a new answer waits while the reader's caret stands in the answer", () => {
  const w = world();
  w.context.cardOnShow = () => true;
  assert.equal(w.context.turnHolding(w.el, "7"), false);
  w.place(-1);
  assert.equal(w.context.turnHolding(w.el, "7"), true);
  w.ta.focus();
  assert.equal(w.context.turnHolding(w.el, "7"), false);
});

// ---- each page's key ------------------------------------------------------------------

function pageAction(source, globals) {
  const body = between(source, "  place(e, shortcut){", "\n  },");
  const context = vm.createContext(globals);
  return vm.runInContext("({\n" + body + "\n})", context).place;
}

function chordEvent(repeat = false) {
  return { repeat, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

test("Mac board: the key steps the card on screen, keeps the browser off it, and goes once while held", () => {
  const block = between(mac, "const boardShortcutActions = {", "\n};");
  assert.ok(block.includes("  place(e, shortcut){"), "the board's key is among the board's actions");
  const calls = [];
  const globals = { draft: false, card: { id: "7" }, cardPlace: (...a) => calls.push(a) };
  globals.boardResponseCard = () => globals.card;
  const place = pageAction(block, globals);
  let e = chordEvent();
  place(e, { value: -1 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["7", -1]);
  // the box takes the caret the way the board's Tab puts it there
  const focused = [];
  calls[0][2]({ ta: { focus: () => focused.push("box") } });
  assert.deepEqual(focused, ["box"]);
  e = chordEvent(true);
  place(e, { value: 1 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(calls.length, 1);
  // no card holding the board's keys (Home, a panel, the small card, a picture), or a
  // new project being named: the key is left alone
  for (const [draft, card] of [[false, null], [true, { id: "7" }]]) {
    Object.assign(globals, { draft, card });
    e = chordEvent();
    place(e, { value: -1 });
    assert.equal(e.defaultPrevented, false);
    assert.equal(calls.length, 1);
  }
});

test("phone: the key steps the card on screen with the page's own caret at the end of the box, never with a menu out", () => {
  const block = between(phone, "const phoneShortcutActions = {", "\n};");
  assert.ok(block.includes("  place(e, shortcut){"), "the phone's key is among the page's actions");
  const calls = [];
  const globals = { card: { id: "7" }, cardPlace: (...a) => calls.push(a), focusBoxAtEnd: () => {} };
  globals.phoneResponseCard = () => globals.card;
  const place = pageAction(block, globals);
  let e = chordEvent();
  place(e, { value: 1 });
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(calls, [["7", 1, globals.focusBoxAtEnd]]);
  globals.card = null;   // a menu out or a card mid-swipe (phoneResponseCard)
  e = chordEvent();
  place(e, { value: -1 });
  assert.equal(e.defaultPrevented, false);
  assert.equal(calls.length, 1);
  assert.match(between(phone, "function phoneResponseCard(){", "\n}"), /menuout/);
});

test("both pages draw no ring round the response with its caret in it, and keep the caret clear of the typing row", () => {
  for (const [name, source] of [["mac", mac], ["phone", phone]]) {
    assert.match(source, /\.reply\[contenteditable\]\{outline:none\}/, name);
    assert.match(source, /\.replyview\{scroll-padding-block:var\(--replyfade\) calc\(var\(--boxband, 0px\) \+ var\(--replyfade\)\)\}/, name);
  }
});

test("Mac board: the block caret in the response is bounded by the answer's scroller less the band over its foot", () => {
  const body = between(mac, "function ceCaret(el){", "\n  }\n");
  // (and by the scroller of the response piped out beside a long reply, where it stands in that)
  assert.match(body, /el\.closest\("\.cm-scroller, \.replyview, #pipebox \.mbbody"\)/);
  assert.match(body, /getPropertyValue\("--boxband"\)/);
});

test("the docs' key list names the place key and the response's caret", () => {
  const keys = between(boardDocs, "The keys, on the Mac board and on the phone with a paired keyboard:",
    "The keys with Command or Control also work");
  assert.match(keys, /Control \+ Option \+ up and down/);
  assert.match(keys, /Command \+ A/);
  assert.match(keys, /Command \+ C/);
});

// ---- the read-only caret in silver ---------------------------------------------------

// a hex colour's three channels
const channels = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
function token(name) {
  const m = new RegExp(`--${name}:(#[0-9A-Fa-f]{6})`).exec(between(tokens, ":root{", "\n}"));
  assert.ok(m, name);
  return m[1];
}

test("the answer's caret and selection are greys, lighter than the solid ink the typing box draws them in", () => {
  const caret = channels(token("read-caret")), select = channels(token("read-select"));
  for (const [name, c] of [["read-caret", caret], ["read-select", select]]) {
    assert.ok(c[0] === c[1] && c[1] === c[2], `${name} is not a grey: ${c}`);
    assert.ok(c[0] >= 0x99, `${name} is not a light grey: ${c}`);
  }
  // the selection behind the words is lighter than the caret, so the words read through it
  assert.ok(select[0] > caret[0]);
  // the typing box's own dress is the black block and the black selection, untouched
  for (const source of [mac, phone]) assert.match(source, /\n  ::selection\{background:#000; color:#fff\}/);
  assert.match(mac, /#fatcaret\{background:var\(--card\); mix-blend-mode:difference\}/);
  assert.match(mac, /#fatcaretlift\{background:var\(--ink\); mix-blend-mode:color-dodge\}/);
});

test("the silver is worn by the answer only while its caret stands in it, the words keeping their ink", () => {
  const rule = between(tokens, "/* ---- the answer's read-only caret", "\n\n");
  assert.match(rule, /\n\.reply\[contenteditable\]::selection, \.reply\[contenteditable\] \*::selection\{background:var\(--read-select\); color:var\(--ink\)\}/);
  // the phone's own caret, which on an iPhone tints the selection and its handles too
  assert.match(phone, /\n  \.reply\[contenteditable\]\{caret-color:var\(--read-caret\)\}/);
  // and no typing field takes either colour
  for (const source of [mac, phone, tokens])
    for (const m of source.matchAll(/([^\n{}]*)\{[^}]*var\(--read-(?:caret|select)\)/g))
      assert.match(m[1], /\.reply\[contenteditable\]|#fatcaret\.ro/, m[1]);
});

test("Mac board: the block caret takes its silver form in the answer and its own in every other field", () => {
  assert.match(mac, /\n  #fatcaret\.ro\{background:var\(--read-caret\); mix-blend-mode:multiply\}/);
  assert.match(mac, /\n  #fatcaretlift\.ro\{visibility:hidden\}/);
  // the block's own focus listener, run over stand-ins
  const listener = between(mac, 'document.addEventListener("focusin", e => {\n    const el = trackable(e.target);', "\n  });");
  const cls = () => {
    const s = new Set();
    return { add: n => s.add(n), remove: n => s.delete(n), contains: n => s.has(n), toggle: (n, on) => (on ? s.add(n) : s.delete(n)) };
  };
  const bar = { classList: cls() }, lift = { classList: cls() };
  const field = tag => ({ tagName: tag, classList: cls() });
  const reply = field("DIV"), ta = field("TEXTAREA"), title = field("SPAN");
  reply.classList.add("reply");
  title.classList.add("title");
  const heard = [];
  const context = vm.createContext({ cells: [bar, lift], queue: () => {}, trackable: t => t,
    document: { addEventListener: (type, fn) => heard.push(fn) } });
  vm.runInContext("let cur = null, isField = false;\n" + listener, context);
  const focus = target => heard[0]({ target });
  focus(reply);
  assert.equal(bar.classList.contains("ro"), true);
  assert.equal(lift.classList.contains("ro"), true);
  for (const other of [ta, title, null]) {
    focus(other);
    assert.equal(bar.classList.contains("ro"), false, other && other.tagName);
    assert.equal(lift.classList.contains("ro"), false, other && other.tagName);
  }
});
