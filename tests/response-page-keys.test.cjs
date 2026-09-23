const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// 150 CSS pixels a second, so a 20ms frame moves 3
const STEP = 3;

// a hand-driven clock and frame queue, so every frame lands at a known time
function clock() {
  let now = 0, next = 1;
  const due = new Map();
  return {
    now: () => now,
    elapse(ms) { now += ms; },
    requestAnimationFrame(fn) { due.set(next, fn); return next++; },
    cancelAnimationFrame(id) { due.delete(id); },
    // n frames, each ms after the one before
    run(n = 1, ms = 20) {
      for (let i = 0; i < n; i++) {
        now += ms;
        const fns = [...due.values()];
        due.clear();
        for (const fn of fns) fn(now);
      }
    },
    pending() { return due.size; },
  };
}

// the globals are assigned after card-logic.js runs, so a spy is never
// overwritten by a function of the same name declared there
async function logic(globals = {}) {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const time = clock();
  const listeners = [];
  let timers = 0;
  const context = vm.createContext({
    Date, performance: { now: time.now },
    requestAnimationFrame: time.requestAnimationFrame, cancelAnimationFrame: time.cancelAnimationFrame,
    setTimeout: () => { timers++; return 0; }, clearTimeout: () => {},
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture: !!capture }),
  });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  Object.assign(context, globals);
  const get = name => vm.runInContext(name, context);
  return {
    time, context, listeners, timers: () => timers,
    resolve: get("cardShortcut"),
    dispatch: get("dispatchCardShortcut"),
    responseScrollKey: get("responseScrollKey"),
  };
}

// a tiny tree: contains walks parents, closest finds the nearest editor, or the
// nearest CodeMirror root when asked for .cm-editor
function node(parent, opts = {}) {
  return {
    parent, editor: !!opts.editor, cm: !!opts.cm, isConnected: true,
    contains(other) {
      for (let at = other; at; at = at.parent) if (at === this) return true;
      return false;
    },
    closest(selector) {
      for (let at = this; at; at = at.parent)
        if (selector === ".cm-editor" ? at.cm : (at.editor || at.cm)) return at;
      return null;
    },
  };
}

function world({ clientHeight = 400, scrollHeight = 2000, scrollTop = 1000, composer = "cm" } = {}) {
  const doc = { visibilityState: "visible" };
  doc.documentElement = node(null);
  doc.body = node(doc.documentElement);
  doc.activeElement = doc.body;
  const makeCard = () => {
    const box = node(doc.body);
    const title = node(box, { editor: true });
    const replyview = Object.assign(node(box), { clientHeight, scrollHeight, ownerDocument: doc, writes: [] });
    let top = scrollTop;
    Object.defineProperty(replyview, "scrollTop", {
      get: () => top,
      set: value => { top = value; replyview.writes.push(value); },
    });
    const reply = node(replyview);
    const answwrap = node(replyview);
    const answeredRow = node(answwrap);
    const pendwrap = node(box);
    const pendRow = node(pendwrap);
    const compose = node(box);
    let ta, content;
    if (composer === "cm") {
      // the editor stands in for the textarea, which is moved inside it
      const cm = node(compose, { cm: true });
      content = node(cm, { editor: true });
      ta = node(cm, { editor: true });
    } else {
      ta = content = node(compose, { editor: true });
    }
    return { el: { box, replyview, reply, pendwrap, answwrap, ta }, parts: { title, reply, answeredRow, pendRow, content, ta } };
  };
  const a = makeCard(), b = makeCard();
  const mdnav = node(node(doc.body, { cm: true }), { editor: true });
  const search = node(doc.body, { editor: true });
  const state = { id: "c1", owner: "p1", el: a.el, open: true };
  const find = () => state.open ? { id: state.id, owner: state.owner, el: state.el } : null;
  return { doc, a, b, mdnav, search, state, find };
}

function chord(target, over = {}) {
  const e = {
    key: "S", target, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false,
    isComposing: false, repeat: false, defaultPrevented: false, ...over,
    preventDefault() { e.defaultPrevented = true; },
  };
  return e;
}

// the shared stop listeners installed as a page installs them, and keys sent
// the way a browser sends them: window capture first, then the page's own
function keyboard(l, doc, actions, target) {
  doc.addEventListener = (type, fn) => l.listeners.push({ type: "document:" + type, fn });
  l.context.document = doc;
  vm.runInContext("listenResponseScroll()", l.context);
  const fire = (type, e = {}) => { for (const x of l.listeners) if (x.type === type) x.fn(e); };
  const press = (over = {}, at = target) => {
    const e = chord(at, over);
    fire("keydown", e);
    l.dispatch(e, actions);
    return e;
  };
  const release = key => fire("keyup", { key, ctrlKey: key !== "Control", shiftKey: key !== "Shift" });
  return { fire, press, release };
}

async function setup(opts) {
  const l = await logic();
  const w = world(opts);
  w.doc.activeElement = w.a.parts.content;
  const actions = { responseScroll: e => l.responseScrollKey(e, w.find) };
  return { ...l, ...w, view: w.a.el.replyview, ...keyboard(l, w.doc, actions, w.a.parts.content) };
}

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label || ""} ${actual} is not ${expected}`);

test("control+shift+s with either case is the response scroll chord and nothing looser is", async () => {
  const { resolve } = await logic();
  for (const key of ["s", "S"]) assert.equal(resolve(chord(null, { key })).action, "responseScroll");
  assert.equal(resolve(chord(null, { repeat: true })).action, "responseScroll");
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: false },
                      { isComposing: true }, { defaultPrevented: true }, { key: "d" }]) {
    assert.notEqual(resolve(chord(null, over))?.action, "responseScroll", JSON.stringify(over));
  }
  assert.equal(resolve(chord(null, { ctrlKey: false, shiftKey: false, key: "s" })).action, "destination");
  assert.equal(resolve(chord(null), "mini"), null);
});

test("holding the chord scrolls down slowly from the first frame and letting go of s stops it", async () => {
  const f = await setup();
  const e = f.press();
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(f.view.writes, []);
  f.time.run(1);
  near(f.view.scrollTop, 1000 + STEP, "first frame");
  f.time.run(4);
  // 100ms in, well inside the double tap window, the motion is already 15px
  near(f.view.scrollTop, 1015, "after 100ms");
  f.release("S");
  assert.equal(f.time.pending(), 0);
  const writes = f.view.writes.length;
  f.time.run(50);
  f.time.elapse(1000);
  f.time.run(5);
  assert.equal(f.view.writes.length, writes);
  near(f.view.scrollTop, 1015);
  assert.equal(f.doc.activeElement, f.a.parts.content);
  assert.equal(f.timers(), 0);
});

test("letting go of control or shift stops the motion and forgets the tap", async () => {
  for (const key of ["Control", "Shift"]) {
    const f = await setup();
    f.press(); f.time.run(3);
    f.release(key);
    assert.equal(f.time.pending(), 0, key);
    const top = f.view.scrollTop;
    f.time.run(10);
    assert.equal(f.view.scrollTop, top, key);
    // a tap, a modifier let go, and a quick press again is a fresh down
    f.press(); f.time.run(1); f.release("S");
    f.release(key);
    f.time.elapse(100);
    const before = f.view.scrollTop;
    f.press(); f.time.run(2);
    near(f.view.scrollTop, before + 2 * STEP, key);
  }
});

test("a tap then a quick press and hold scrolls up, and the press after that goes down", async () => {
  const f = await setup();
  f.press(); f.time.run(2); f.release("S");
  near(f.view.scrollTop, 1000 + 2 * STEP, "the tap's small down");
  f.time.elapse(200);
  assert.equal(f.press().defaultPrevented, true);
  f.time.run(5);
  near(f.view.scrollTop, 1000 + 2 * STEP - 5 * STEP, "held up");
  f.release("S");
  f.time.elapse(100);
  const top = f.view.scrollTop;
  f.press(); f.time.run(3);
  near(f.view.scrollTop, top + 3 * STEP, "third press");
});

test("a second press after the double tap window goes down", async () => {
  const f = await setup();
  f.press(); f.time.run(1); f.release("S");
  f.time.elapse(300);
  const top = f.view.scrollTop;
  f.press(); f.time.run(2);
  near(f.view.scrollTop, top + 2 * STEP);
});

test("a long hold followed by a quick new press is not a double tap", async () => {
  const f = await setup();
  f.press(); f.time.run(25); f.release("S");
  f.time.elapse(50);
  const top = f.view.scrollTop;
  f.press(); f.time.run(2);
  near(f.view.scrollTop, top + 2 * STEP);
});

test("a held key's repeats neither restart nor turn the motion", async () => {
  const f = await setup();
  f.press(); f.time.run(1);
  for (let i = 0; i < 20; i++) {
    assert.equal(f.press({ repeat: true }).defaultPrevented, true);
    f.time.run(1);
    assert.equal(f.time.pending(), 1);
  }
  near(f.view.scrollTop, 1000 + 21 * STEP, "down");
  f.release("S");
  f.time.elapse(300);
  f.press(); f.time.run(1); f.release("S");
  f.time.elapse(50);
  const top = f.view.scrollTop;
  f.press(); f.time.run(1);
  for (let i = 0; i < 10; i++) { f.press({ repeat: true }); f.time.run(1); }
  near(f.view.scrollTop, top - 11 * STEP, "up");
  f.release("S");
  // a repeat after release starts nothing
  f.press({ repeat: true });
  assert.equal(f.time.pending(), 0);
});

test("a stalled frame moves at most one clamped step", async () => {
  const f = await setup();
  f.press();
  f.time.run(1, 5000);
  near(f.view.scrollTop, 1000 + 7.5);
});

test("the motion stops at either end and still takes the chord there", async () => {
  const end = await setup({ scrollTop: 1596 });
  end.press(); end.time.run(10);
  assert.equal(end.view.scrollTop, 1600);
  assert.equal(end.view.writes.length, 2);
  near(end.view.writes[0], 1599);
  assert.equal(end.time.pending(), 0);
  end.release("S");
  end.time.elapse(300);
  assert.equal(end.press().defaultPrevented, true);
  end.time.run(5);
  assert.equal(end.view.writes.length, 2);

  const top = await setup({ scrollTop: 2 });
  top.press(); top.release("S"); top.time.elapse(50);
  assert.equal(top.press().defaultPrevented, true);
  top.time.run(10);
  assert.equal(top.view.scrollTop, 0);

  const short = await setup({ scrollHeight: 300, scrollTop: 0 });
  short.press(); short.time.run(10);
  assert.deepEqual(short.view.writes, []);

  const hidden = await setup({ clientHeight: 0 });
  assert.equal(hidden.press().defaultPrevented, false);
  assert.equal(hidden.time.pending(), 0);
});

test("modified, composing and already handled keys leave the response and the key alone", async () => {
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: false },
                      { isComposing: true }, { defaultPrevented: true }]) {
    const f = await setup();
    const e = f.press(over);
    if (!over.defaultPrevented) assert.equal(e.defaultPrevented, false, JSON.stringify(over));
    assert.equal(f.time.pending(), 0, JSON.stringify(over));
    f.time.run(10);
    assert.deepEqual(f.view.writes, [], JSON.stringify(over));
  }
});

test("another key or a changed modifier during the hold stops it without taking the key", async () => {
  for (const over of [{ key: "a", ctrlKey: false, shiftKey: false }, { key: "ArrowDown" },
                      { altKey: true }, { metaKey: true }, { isComposing: true }, { key: "Alt", altKey: true }]) {
    const f = await setup();
    f.press(); f.time.run(2);
    const e = chord(f.a.parts.content, over);
    f.fire("keydown", e);
    assert.equal(e.defaultPrevented, false, JSON.stringify(over));
    assert.equal(f.time.pending(), 0, JSON.stringify(over));
    f.time.run(5);
    assert.equal(f.view.writes.length, 2, JSON.stringify(over));
  }
  // a modifier's own repeat while both are held is not a change
  const f = await setup();
  f.press(); f.fire("keydown", chord(null, { key: "Shift", repeat: true }));
  assert.equal(f.time.pending(), 1);
});

test("the composer in either shape, the response and the page itself all take the chord", async () => {
  for (const composer of ["cm", "textarea"]) {
    for (const where of ["content", "ta", "reply", "body"]) {
      const f = await setup({ composer });
      const target = where === "body" ? f.doc.body : f.a.parts[where];
      f.doc.activeElement = target;
      assert.equal(f.press({}, target).defaultPrevented, true, `${composer} ${where}`);
      f.time.run(2);
      near(f.view.scrollTop, 1000 + 2 * STEP, `${composer} ${where}`);
      assert.equal(f.doc.activeElement, target);
    }
  }
});

test("other fields, the sent and answered boxes and other cards keep the chord", async () => {
  const f = await setup();
  const others = {
    title: f.a.parts.title, pendRow: f.a.parts.pendRow, answeredRow: f.a.parts.answeredRow,
    navigator: f.mdnav, search: f.search, otherComposer: f.b.parts.content,
    otherTextarea: f.b.parts.ta, otherReply: f.b.parts.reply,
  };
  for (const [name, target] of Object.entries(others)) {
    assert.equal(f.press({}, target).defaultPrevented, false, name);
    assert.equal(f.time.pending(), 0, name);
  }
  // a stray chord elsewhere also stops a motion under way
  f.press(); f.time.run(1);
  f.press({ repeat: true }, f.search);
  assert.equal(f.time.pending(), 0);
  f.time.run(10);
  assert.equal(f.view.writes.length, 1);
  assert.deepEqual(f.b.el.replyview.writes, []);
});

test("the motion stops when the card, its render, project, focus, page or overlay changes", async () => {
  const changes = {
    card: f => { f.state.id = "c2"; },
    render: f => { f.state.el = { ...f.a.el }; },
    project: f => { f.state.owner = "p2"; },
    focus: f => { f.doc.activeElement = f.search; },
    hidden: f => { f.doc.visibilityState = "hidden"; },
    detached: f => { f.a.el.box.isConnected = false; },
    response: f => { f.view.isConnected = false; },
    collapsed: f => { f.view.clientHeight = 0; },
    overlay: f => { f.state.open = false; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = await setup();
    f.press(); f.time.run(1);
    change(f);
    f.time.run(10);
    assert.equal(f.view.writes.length, 1, name);
    assert.equal(f.time.pending(), 0, name);
  }
});

test("losing the window or hiding the page stops the motion and forgets the tap", async () => {
  for (const type of ["blur", "document:visibilitychange"]) {
    const f = await setup();
    f.press(); f.time.run(1);
    f.fire(type);
    assert.equal(f.time.pending(), 0, type);
    f.release("S");
    f.time.elapse(50);
    const top = f.view.scrollTop;
    f.press(); f.time.run(1);
    near(f.view.scrollTop, top + STEP, type);
  }
});

test("a second press on a different card is its own down, not an up on either", async () => {
  const f = await setup();
  f.press(); f.time.run(1); f.release("S");
  Object.assign(f.state, { id: "c2", el: f.b.el });
  f.doc.activeElement = f.b.parts.content;
  f.time.elapse(100);
  f.press({}, f.b.parts.content); f.time.run(2);
  assert.equal(f.a.el.replyview.writes.length, 1);
  near(f.b.el.replyview.scrollTop, 1000 + 2 * STEP);
});

// the page's own guard and action table, run as written against the helper
async function page(name, extra) {
  const text = await readFile(path.join(ROOT, name), "utf8");
  const fn = name === "index.html" ? "boardResponseCard" : "phoneResponseCard";
  const table = name === "index.html" ? "boardShortcutActions" : "phoneShortcutActions";
  const start = text.indexOf(`function ${fn}(){`);
  const at = text.indexOf(`const ${table} = {`, start);
  const end = text.indexOf("\n};", at) + 3;
  assert.ok(start >= 0 && at > start && end > at);
  assert.ok(text.includes("listenResponseScroll();"), `${name} installs the stop listeners`);
  const w = world();
  const open = new Set();
  w.doc.body.classList = { contains: value => open.has(value) };
  w.doc.activeElement = w.a.parts.content;
  const calls = [];
  const l = await logic({
    document: w.doc, els: { c1: w.a.el, c2: w.b.el }, selectedId: "c1", activeOwner: "p1",
    histStep: (id, dir) => calls.push(["history", id, dir]),
    ...extra(calls),
  });
  vm.runInContext(text.slice(start, end), l.context);
  const actions = vm.runInContext(table, l.context);
  return { ...l, ...w, open, calls, view: w.a.el.replyview, ...keyboard(l, w.doc, actions, w.a.parts.content) };
}

test("desktop panels, menus, the small card and a picture keep the chord and stop a motion", async () => {
  const f = await page("index.html", calls => ({
    FOCUS: true, boardKeysLive: () => true, miniFocused: false, p3Zoom: null,
    nav: dir => calls.push(["nav", dir]),
  }));
  const blockers = {
    setopen: () => f.open.add("setopen"),
    drawer: () => f.open.add("resp-drawer-open"),
    worktree: () => { f.a.el.wtmenu = { classList: { contains: v => v === "open" } }; },
    mini: () => { f.context.miniFocused = true; },
    picture: () => { f.context.p3Zoom = {}; },
    boardKeys: () => { f.context.boardKeysLive = () => false; },
    blank: () => { f.context.FOCUS = false; },
    selection: () => { f.context.selectedId = "c2"; },
  };
  const clear = () => {
    f.open.clear(); f.a.el.wtmenu = null;
    Object.assign(f.context, { miniFocused: false, p3Zoom: null, boardKeysLive: () => true, FOCUS: true, selectedId: "c1" });
  };
  for (const [name, block] of Object.entries(blockers)) {
    block();
    assert.equal(f.press().defaultPrevented, false, name);
    assert.equal(f.time.pending(), 0, name);
    clear();
    f.press(); f.time.run(1);
    const moved = f.view.writes.length;
    block(); f.time.run(5);
    assert.equal(f.view.writes.length, moved, name);
    assert.equal(f.time.pending(), 0, name);
    clear(); f.release("S"); f.time.elapse(1000);
  }
  // a release lands even while the board's keys are held elsewhere
  f.press(); f.time.run(1);
  f.context.boardKeysLive = () => false;
  f.release("S");
  assert.equal(f.time.pending(), 0);
  clear(); f.time.elapse(1000);
  // history and card steps are untouched, and scrolling still works after them
  assert.equal(f.press({ key: "ArrowUp" }).defaultPrevented, true);
  f.press({ key: "ArrowLeft" });
  assert.deepEqual(f.calls, [["history", "c1", 1], ["nav", -1]]);
  const top = f.view.scrollTop;
  f.press(); f.time.run(2); f.release("S");
  near(f.view.scrollTop, top + 2 * STEP);
  f.time.elapse(100);
  f.press(); f.time.run(3); f.release("S");
  near(f.view.scrollTop, top - STEP);
  assert.equal(f.timers(), 0);
});

test("a phone drawer or a swipe keeps the chord and stops a motion", async () => {
  const f = await page("m.html", calls => ({
    stepCard: dir => calls.push(["step", dir]),
  }));
  for (const cls of ["menuout", "carddrag"]) {
    f.open.add(cls);
    assert.equal(f.press().defaultPrevented, false, cls);
    f.open.clear();
    f.press(); f.time.run(1);
    const moved = f.view.writes.length;
    f.open.add(cls); f.time.run(5); f.open.clear();
    assert.equal(f.view.writes.length, moved, cls);
    f.release("S"); f.time.elapse(1000);
  }
  const top = f.view.scrollTop;
  f.press(); f.time.run(1); f.release("S");
  f.time.elapse(100);
  f.press(); f.time.run(2);
  f.release("Shift");
  assert.equal(f.time.pending(), 0);
  near(f.view.scrollTop, top - STEP);
  f.press({ key: "ArrowDown" });
  f.press({ key: "ArrowRight" });
  assert.deepEqual(f.calls, [["history", "c1", -1], ["step", 1]]);
});
