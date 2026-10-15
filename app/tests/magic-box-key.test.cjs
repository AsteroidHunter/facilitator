// Control+Option+Right puts the owner into the card's magic box, as a click in
// it does (the box is the held one, the card settles), from the card or from
// typing in its box; Control+Option+Left puts them back where they were, the
// typing box with its caret and selection or the card itself. With no box on
// screen the key is left alone. Run from the page's own source, no browser:
// the key is recognised by card-logic.js, and the box's holding, remembering
// and giving back are the functions cut out of index.html as written.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.MAGIC_BOX_SOURCE_ROOT || path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = read("index.html");

function cut(from, to) {
  const a = HTML.indexOf(from), b = HTML.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} ... ${to}`);
  return HTML.slice(a, b);
}
const fn = name => cut(`function ${name}(`, "\n}\n") + "\n}\n";

// the card's logic, for the key's recognition
const logic = vm.createContext({ addEventListener() {}, setTimeout() {}, clearTimeout() {} });
vm.runInContext(read("card-logic.js"), logic, { filename: "card-logic.js" });
const resolve = e => logic.cardShortcut({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...e });
const dispatch = (e, actions) => vm.runInContext("dispatchCardShortcut", logic)(e, actions);

// a world with a card on screen whose typing box holds a caret, and a box beside it.
// a field that lets go of the focus forgets its selection, the worst a field can
// do, so it is the page's putting it back that is tested. editor: the field wears
// the editor, whose range is an anchor and a head
function world({ editor = false, open = true, typing = true } = {}) {
  const doc = { activeElement: null, body: { id: "body" } };
  doc.activeElement = doc.body;
  const classes = new Set(open ? ["on"] : []);
  const inBox = new Set();
  const frame = { where: "frame", blur() { doc.activeElement = doc.body; } };
  inBox.add(frame);
  const calls = [];
  const ta = {
    start: 0, end: 0, dir: "none",
    get selectionStart() { return this.start; }, get selectionEnd() { return this.end; },
    get selectionDirection() { return this.dir; },
    focus(o) { calls.push(["focus", o]); doc.activeElement = this; },
    blur() { calls.push(["blur"]); this.start = this.end = 0; this.dir = "none"; doc.activeElement = doc.body; },
    setSelectionRange(a, b, d) {
      calls.push(["range", a, b, d]);
      if (editor) { this.start = Math.min(a, b); this.end = Math.max(a, b); this.dir = a > b ? "backward" : "forward"; }
      else { this.start = a; this.end = b; this.dir = d; }
    },
  };
  const els = { c1: { ta, field: { focused: () => doc.activeElement === ta, formatted: () => editor } } };
  const el = {
    style: {}, contains: n => inBox.has(n),
    classList: { contains: c => classes.has(c), toggle: (c, yes) => (yes ? classes.add(c) : classes.delete(c)) },
  };
  const MB = { el, id: "c1" };
  const listeners = {};
  const sandbox = {
    MB, els, document: doc, shownId: "c1", draft: false,
    boardResponseCard: () => sandbox.card, card: { id: "c1", el: els.c1 },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const ctx = vm.createContext(sandbox);
  // as the page has them: the hold, what is remembered, the way in and back, and the key's action
  vm.runInContext(cut("function magicHold(", 'addEventListener("focusin"') + fn("boardMagicHeld") + fn("boardMagicShown"), ctx);
  const table = cut("  magicJump(e, shortcut){", "\n  create(e){");
  const actions = vm.runInContext("({" + table.replace(/\n  },\s*$/, "\n  }") + "})", ctx);
  if (typing) { doc.activeElement = ta; ta.start = 3; ta.end = 8; ta.dir = "backward"; }
  const press = (key, extra = {}) => {
    const e = { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, repeat: false, key,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const done = dispatch(e, actions);
    return { e, done };
  };
  return { doc, classes, frame, ta, els, MB, ctx, calls, sandbox, listeners, press,
    held: () => classes.has("held"), inBox,
    click: target => { for (const f of listeners.pointerdown) f({ target }); } };
}

test("control+option+right and left are one pair of keys, with nothing else held", () => {
  assert.deepEqual({ ...resolve({ ctrlKey: true, altKey: true, key: "ArrowRight" }) }, { action: "magicJump", value: 1 });
  assert.deepEqual({ ...resolve({ ctrlKey: true, altKey: true, key: "ArrowLeft" }) }, { action: "magicJump", value: -1 });
  for (const extra of [{ shiftKey: true }, { metaKey: true }, { altKey: false }, { ctrlKey: false }, { isComposing: true }])
    for (const key of ["ArrowRight", "ArrowLeft"])
      assert.notEqual(resolve({ ctrlKey: true, altKey: true, key, ...extra })?.action, "magicJump", key + JSON.stringify(extra));
  // up and down are still the card's places
  assert.equal(resolve({ ctrlKey: true, altKey: true, key: "ArrowUp" }).action, "place");
});

test("right with an open box focuses it: the box is the held one and the typing box lets go", () => {
  const w = world();
  const { e, done } = w.press("ArrowRight");
  assert.equal(done, true);
  assert.equal(e.defaultPrevented, true);
  assert.equal(w.held(), true, "the box is raised, as a click raises it");
  assert.notEqual(w.doc.activeElement, w.ta, "the typing box has let go");
  // the card settles from the box's held class, as it does for a click
  assert.match(HTML, /new MutationObserver\(\(\) => document\.body\.classList\.toggle\("mbheld",\s*MB\.el\.classList\.contains\("on"\) && MB\.el\.classList\.contains\("held"\)\)\)/);
  // from the bare card too, and a press already in the box changes nothing
  const bare = world({ typing: false });
  const second = bare.press("ArrowRight");
  assert.equal(second.e.defaultPrevented, true);
  assert.equal(bare.held(), true);
  bare.press("ArrowRight");
  assert.equal(bare.held(), true);
  // a held key goes once
  const again = world();
  again.press("ArrowRight", { repeat: true });
  assert.equal(again.held(), false);
});

test("right with no box does nothing and leaves the key alone", () => {
  for (const [name, w] of [
    ["no box open", world({ open: false })],
    ["a box hidden for want of room", (() => { const x = world(); x.MB.el.style.visibility = "hidden"; return x; })()],
    ["a box of another card", (() => { const x = world(); x.sandbox.shownId = "c2"; return x; })()],
    ["no card holding the board's keys", (() => { const x = world(); x.sandbox.card = null; return x; })()],
    ["a new card being drafted", (() => { const x = world(); x.sandbox.draft = true; return x; })()],
  ]) {
    const { e } = w.press("ArrowRight");
    assert.equal(e.defaultPrevented, false, name);
    assert.equal(w.held(), false, name);
    assert.equal(w.doc.activeElement, w.ta, name + ": the focus stays where it was");
    assert.deepEqual(w.calls, [], name);
  }
});

test("left returns to the typing box with the same caret and selection", () => {
  for (const editor of [false, true]) {
    const w = world({ editor });
    w.press("ArrowRight");
    assert.equal(w.ta.start, 0, "the field forgot its selection when it let go");
    const { e } = w.press("ArrowLeft");
    assert.equal(e.defaultPrevented, true);
    assert.equal(w.doc.activeElement, w.ta, "the caret is in the typing box");
    assert.equal(w.held(), false, "the card is the raised one again");
    assert.equal(w.ta.start, 3);
    assert.equal(w.ta.end, 8);
    assert.equal(w.ta.dir, "backward");
    assert.equal(w.calls.find(c => c[0] === "focus")[1].preventScroll, true, "the card does not scroll for it");
  }
  // a caret with nothing selected
  const w = world();
  w.ta.start = w.ta.end = 5; w.ta.dir = "none";
  w.press("ArrowRight"); w.press("ArrowLeft");
  assert.deepEqual([w.ta.start, w.ta.end], [5, 5]);
  // the way back is for once: a second left, with the keys on the card, is not ours
  const again = w.press("ArrowLeft");
  assert.equal(again.e.defaultPrevented, false);
});

test("left returns to the card itself when nothing was focused there", () => {
  const w = world({ typing: false });
  w.press("ArrowRight");
  assert.equal(w.held(), true);
  const { e } = w.press("ArrowLeft");
  assert.equal(e.defaultPrevented, true);
  assert.equal(w.held(), false);
  assert.equal(w.doc.activeElement, w.doc.body, "nothing is focused, so the card's keys act on the card");
  assert.deepEqual(w.calls, [], "the typing box is not touched");
  // the owner clicked into a frame (the page has the focus): left lets it go
  const framed = world({ typing: false });
  framed.press("ArrowRight");
  framed.doc.activeElement = framed.frame;
  framed.press("ArrowLeft");
  assert.equal(framed.doc.activeElement, framed.doc.body);
  assert.equal(framed.held(), false);
});

test("left with the keys not in the box is left alone", () => {
  const w = world();
  const { e, done } = w.press("ArrowLeft");
  assert.equal(done, true);
  assert.equal(e.defaultPrevented, false);
  assert.equal(w.doc.activeElement, w.ta);
});

test("a click into the box remembers the typing box too, and left goes back to it", () => {
  const w = world();
  w.click(w.frame);
  assert.equal(w.held(), true);
  w.ta.blur();   // the click moves the focus off the typing box
  w.doc.activeElement = w.frame;
  w.press("ArrowLeft");
  assert.equal(w.doc.activeElement, w.ta);
  assert.deepEqual([w.ta.start, w.ta.end, w.ta.dir], [3, 8, "backward"]);
  // a click on the card forgets it: a later way into the box is never taken back to a stale place
  const stale = world();
  stale.press("ArrowRight");
  stale.click({ where: "card" });
  assert.equal(stale.held(), false);
  assert.equal(stale.MB.came, null);
});

test("the page's own page can say left when the sealed frame keeps the key to itself", () => {
  const { pageDoc } = (() => { const s = vm.createContext({}); vm.runInContext(read("magic-box.js"), s); return s.MagicBox; })();
  const scripts = doc => [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // the Mac's page relays the key ahead of anything the agent wrote; the phone's page is as it was
  const mac = pageDoc("<p>x</p>", "w", true), phone = pageDoc("<p>x</p>", "w", false);
  assert.ok(mac.indexOf("'ArrowLeft'") > 0 && mac.indexOf("'ArrowLeft'") < mac.indexOf("<p>x</p>"));
  assert.ok(!/ArrowLeft/.test(phone));
  const posted = [], on = [];
  const ctx = vm.createContext({ addEventListener: (type, f, capture) => on.push({ type, f, capture }),
    document: { addEventListener() {}, body: null }, parent: { postMessage: (...a) => posted.push(a) } });
  for (const code of scripts(mac).slice(1)) vm.runInContext(code, ctx);
  const key = on.find(l => l.type === "keydown");
  assert.ok(key && key.capture === true, "heard in capture, ahead of the page's own listeners");
  const hit = { ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, key: "ArrowLeft", prevented: false, preventDefault() { this.prevented = true; } };
  key.f(hit);
  assert.deepEqual(posted, [["w back", "*"]]);
  assert.equal(hit.prevented, true);
  for (const miss of [{ key: "ArrowRight" }, { altKey: false }, { shiftKey: true }, { metaKey: true }, { ctrlKey: false }])
    key.f({ ...hit, ...miss, preventDefault() {} });
  assert.equal(posted.length, 1, "only control+option+left");
  // the board hears it from that frame alone and takes the owner back
  const view = read("card-logic.js");
  assert.match(view, /else if \(hooks\.back && e\.data === run\.word \+ " back"\) hooks\.back\(\);/);
  assert.match(HTML, /MB\.view = magicView\(MB\.el, \{ placed: \(\) => magicPlace\(\), openSite: magicOpenSite, sized: true,\s*back: \(\) => magicBack\(\),/);
  assert.ok(!/back:/.test(read("m.html").match(/PB\.view = magicView\([^;]*;/)?.[0] || ""), "the phone is not part of it");
});

test("command+T in a page is stopped in the frame and said to the board, which makes a card as the key does", () => {
  const { pageDoc } = (() => { const s = vm.createContext({}); vm.runInContext(read("magic-box.js"), s); return s.MagicBox; })();
  const scripts = doc => [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  // the Mac's page stops it ahead of anything the agent wrote; the phone's page has no keys of the board's
  const mac = pageDoc("<p>x</p>", "w", true);
  assert.ok(mac.indexOf("' create'") > 0 && mac.indexOf("' create'") < mac.indexOf("<p>x</p>"));
  assert.ok(!/' create'/.test(pageDoc("<p>x</p>", "w", false)) && !/' create'/.test(pageDoc("<p>x</p>", "w", false, true)));
  const posted = [], on = [];
  const ctx = vm.createContext({ addEventListener: (type, f, capture) => on.push({ type, f, capture }),
    document: { addEventListener() {}, body: null }, parent: { postMessage: (...a) => posted.push(a) } });
  for (const code of scripts(mac).slice(1)) vm.runInContext(code, ctx);
  const keys = on.filter(l => l.type === "keydown");
  // back, create, and the one that says the keys for control+S (PAGE_SCROLL)
  assert.ok(keys.length === 3 && keys.every(l => l.capture === true), "heard in capture, ahead of the page's own listeners");
  const press = extra => {
    const e = { ctrlKey: false, altKey: false, metaKey: true, shiftKey: false, key: "t", code: "KeyT", prevented: false,
      preventDefault() { this.prevented = true; }, ...extra };
    posted.length = 0;
    for (const l of keys) l.f(e);
    // the keys said for control+S are not part of this: command+T is one of them, and nothing else is said
    return { prevented: e.prevented, posted: posted.map(p => [...p]).filter(p => !p[0].startsWith("w key ")) };
  };
  assert.deepEqual(press({}), { prevented: true, posted: [["w create", "*"]] }, "no Chrome tab, and the board is told");
  // the T the board reads: another layout's letter at the T key, or a capital from caps lock
  assert.deepEqual(press({ key: "е" }).posted, [["w create", "*"]], "a Cyrillic layout's T key");
  assert.deepEqual(press({ key: "T" }).posted, [["w create", "*"]], "caps lock");
  // command alone: any other modifier, or another key, is left to the page and to Chrome
  for (const miss of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: false }, { key: "n", code: "KeyN" },
    { key: "y", code: "KeyT" }])
    assert.deepEqual(press(miss), { prevented: false, posted: [] }, JSON.stringify(miss));
  // the board's key for a card is the same key: command and T, read the same way
  assert.equal(resolve({ metaKey: true, key: "t", code: "KeyT" }).action, "create");
  assert.equal(resolve({ metaKey: true, key: "е", code: "KeyT" }).action, "create");
  // the board hears it from that frame alone and makes the card as the key does
  const view = read("card-logic.js");
  assert.match(view, /else if \(hooks\.create && e\.data === run\.word \+ " create"\) hooks\.create\(\);/);
  assert.ok(view.indexOf('run.word + " create"') < view.indexOf("(hooks.sized || hooks.tall) && e.data.startsWith"),
    "heard before a height is read off the message");
  assert.match(HTML, /back: \(\) => magicBack\(\),\s*create: \(\) => \{ if \(FOCUS && boardKeysLive\(\)\) newCardHere\(\); \},/);
  assert.match(cut("const boardShortcutActions = {", "\n};"), /\n  create\(e\)\{\s*e\.preventDefault\(\);\s*newCardHere\(\);\s*\},/);
  assert.match(cut("addEventListener(\"keydown\", e => {\n  if (!FOCUS) return;", "\n});"),
    /if \(!boardKeysLive\(\)\)\{ dispatchCardShortcut\(e, boardTabKeys\); return; \}\s*dispatchCardShortcut\(e, boardShortcutActions\);/);
  assert.ok(!/create:/.test(read("m.html").match(/PB\.view = magicView\([^;]*;/)?.[0] || ""), "the phone is not part of it");
  // the view's own message handler: one relayed press makes one card, from that frame only
  const made = [];
  let onMessage = null;
  const body = { style: { setProperty() {}, removeProperty() {} }, textContent: "", dataset: {}, append() {},
    addEventListener() {}, querySelector() { return null; } };
  const vctx = vm.createContext({
    MagicBox: { pageDoc }, getComputedStyle: () => ({ getPropertyValue: () => "0" }), setTimeout() {}, Date,
    addEventListener: (type, f) => { if (type === "message") onMessage = f; },
    h: () => ({ setAttribute() {}, addEventListener() {}, clientWidth: 398, contentWindow: {} }),
  });
  vm.runInContext(view.match(/function magicView\(el, hooks = \{\}\)\{[\s\S]*?\n  return view;\n\}/)[0] + ";this.magicView = magicView;", vctx);
  const v = vctx.magicView({ querySelector: s => s === ".mbbody" ? body : null, lastElementChild: null },
    { sized: true, placed() {}, create: () => made.push(1) });
  v.draw({ kind: "html", html: "<p>x</p>" });
  const run = v.page;
  onMessage({ source: {}, data: run.word + " create" });
  assert.equal(made.length, 0, "not from another window");
  onMessage({ source: run.frame.contentWindow, data: "other create" });
  assert.equal(made.length, 0, "not without the frame's word");
  onMessage({ source: run.frame.contentWindow, data: run.word + " create" });
  assert.equal(made.length, 1);
  assert.equal(run.height, 0, "and it is no height");
});
