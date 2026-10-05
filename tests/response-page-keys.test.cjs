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
// nearest CodeMirror root when asked for .cm-editor. animate records the
// animation API calls the bounce makes
function node(parent, opts = {}) {
  return {
    parent, editor: !!opts.editor, cm: !!opts.cm, isConnected: true, animations: [],
    animate(frames, options) {
      const run = { frames, options, cancelled: false, cancel() { run.cancelled = true; } };
      this.animations.push(run);
      return run;
    },
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
    replyview.children = [answwrap, reply];
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
    key: "S", target, ctrlKey: true, shiftKey: false, metaKey: false, altKey: false,
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
  const release = key => fire("keyup", { key, ctrlKey: key !== "Control", shiftKey: false });
  return { fire, press, release };
}

async function setup(opts, globals) {
  const l = await logic(globals);
  const w = world(opts);
  w.doc.activeElement = w.a.parts.content;
  const actions = { responseScroll: e => l.responseScrollKey(e, w.find) };
  return { ...l, ...w, view: w.a.el.replyview, ...keyboard(l, w.doc, actions, w.a.parts.content) };
}

const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label || ""} ${actual} is not ${expected}`);

test("control+s with either case is the response scroll chord and nothing looser is", async () => {
  const { resolve } = await logic();
  for (const key of ["s", "S"]) assert.equal(resolve(chord(null, { key })).action, "responseScroll");
  assert.equal(resolve(chord(null, { repeat: true })).action, "responseScroll");
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: true },
                      { isComposing: true }, { defaultPrevented: true }, { key: "d" }]) {
    assert.notEqual(resolve(chord(null, over))?.action, "responseScroll", JSON.stringify(over));
  }
  // plain s and the old control+shift+s are nothing at all
  assert.equal(resolve(chord(null, { ctrlKey: false, key: "s" })), null);
  assert.equal(resolve(chord(null, { shiftKey: true })), null);
  assert.equal(resolve(chord(null), "mini"), null);
});

test("control+shift+s no longer scrolls or bounces and leaves the key alone", async () => {
  for (const scrollTop of [1000, 1600]) {
    const f = await setup({ scrollTop });
    const e = f.press({ shiftKey: true });
    assert.equal(e.defaultPrevented, false);
    assert.equal(f.time.pending(), 0);
    f.time.run(10);
    assert.deepEqual(f.view.writes, []);
    assert.deepEqual(f.a.el.reply.animations, []);
  }
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

test("letting go of control, or adding shift, stops the motion and forgets the tap", async () => {
  const stops = {
    Control: f => f.release("Control"),
    Shift: f => f.fire("keydown", chord(null, { key: "Shift", shiftKey: true })),
  };
  for (const [key, stop] of Object.entries(stops)) {
    const f = await setup();
    f.press(); f.time.run(3);
    stop(f);
    assert.equal(f.time.pending(), 0, key);
    const top = f.view.scrollTop;
    f.time.run(10);
    assert.equal(f.view.scrollTop, top, key);
    // a tap, a modifier changed, and a quick press again is a fresh down
    f.press(); f.time.run(1); f.release("S");
    stop(f);
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
  assert.deepEqual(hidden.a.el.reply.animations, []);
});

// ---- the edge bounce ------------------------------------------------------------
const REDUCED = { matchMedia: query => ({ matches: query === "(prefers-reduced-motion: reduce)" }) };

// the content's parts (the answered box and the answer) each took exactly the
// bounces listed, by their outward translate, and nothing wrote the scroll
function bounces(f) {
  const parts = [f.a.el.answwrap, f.a.el.reply];
  const outs = parts.map(part => part.animations.map(run => run.frames[1].translate));
  assert.deepEqual(outs[0], outs[1], "the answered box and the answer moved apart");
  return outs[1];
}

function assertBounceShape(run) {
  assert.equal(run.options.duration, 250);
  assert.equal(run.frames.length, 3, "one out and back, no overshoot");
  assert.equal(run.frames[0].translate, "0 0");
  assert.equal(run.frames[2].translate, "0 0");
  assert.equal(run.frames[1].offset, 0.4);
  for (const frame of run.frames.slice(0, 2)) assert.match(frame.easing, /^cubic-bezier\(/);
}

test("a press with nothing to scroll that way bounces once along the pressed direction", async () => {
  const cases = {
    "down at the bottom": { opts: { scrollTop: 1600 }, up: false, out: ["0 -7px"] },
    "down when it does not scroll": { opts: { scrollHeight: 300, scrollTop: 0 }, up: false, out: ["0 -7px"] },
    "down when it fits exactly": { opts: { scrollHeight: 400, scrollTop: 0 }, up: false, out: ["0 -7px"] },
    // a tap that never reached a frame, then the hold, which goes up
    "up at the top": { opts: { scrollTop: 0 }, up: true, out: ["0 7px"] },
    "up when it does not scroll": { opts: { scrollHeight: 300, scrollTop: 0 }, up: true, out: ["0 -7px", "0 7px"] },
  };
  for (const [name, { opts, up, out }] of Object.entries(cases)) {
    const f = await setup(opts);
    if (up) { f.press(); f.release("S"); f.time.elapse(50); }
    const e = f.press();
    assert.equal(e.defaultPrevented, true, name);
    assert.equal(f.time.pending(), 0, `${name}: a motion started`);
    assert.deepEqual(bounces(f), out, name);
    assertBounceShape(f.a.el.reply.animations.at(-1));
    // a first bounce is replaced by a second rather than left to stack
    if (out.length > 1) assert.equal(f.a.el.reply.animations[0].cancelled, true, name);
    f.time.run(10);
    assert.deepEqual(f.view.writes, [], name);
    assert.equal(f.doc.activeElement, f.a.parts.content, name);
    assert.deepEqual(bounces(f), out, `${name}: bounced again`);
    assert.equal(f.timers(), 0);
  }
});

test("a hold that reaches either end bounces once there and a scroll short of it does not", async () => {
  const down = await setup({ scrollTop: 1590 });
  down.press(); down.time.run(3);
  assert.deepEqual(bounces(down), [], "bounced before the end");
  down.time.run(1);
  assert.equal(down.view.scrollTop, 1600);
  assert.deepEqual(bounces(down), ["0 -7px"]);
  for (let i = 0; i < 10; i++) { down.press({ repeat: true }); down.time.run(1); }
  assert.deepEqual(bounces(down), ["0 -7px"], "a held key's repeats bounced again");
  assertBounceShape(down.a.el.reply.animations[0]);

  const up = await setup({ scrollTop: 10 });
  up.press(); up.release("S"); up.time.elapse(50);
  up.press(); up.time.run(10);
  assert.equal(up.view.scrollTop, 0);
  assert.deepEqual(bounces(up), ["0 7px"]);

  const mid = await setup();
  mid.press(); mid.time.run(20); mid.release("S");
  assert.deepEqual(bounces(mid), []);
});

test("reduced motion gets no bounce and the keys work as before", async () => {
  const edge = await setup({ scrollTop: 1600 }, REDUCED);
  assert.equal(edge.press().defaultPrevented, true);
  assert.deepEqual(bounces(edge), []);
  edge.release("S"); edge.time.elapse(50);
  // the tap still turns the next press into an up
  edge.press(); edge.time.run(2);
  near(edge.view.scrollTop, 1600 - 2 * STEP);

  const short = await setup({ scrollHeight: 300, scrollTop: 0 }, REDUCED);
  short.press();
  assert.deepEqual(bounces(short), []);

  const held = await setup({ scrollTop: 1596 }, REDUCED);
  held.press(); held.time.run(10);
  assert.equal(held.view.scrollTop, 1600);
  assert.deepEqual(bounces(held), []);
});

test("modified, composing and already handled keys leave the response and the key alone", async () => {
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: true },
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
  for (const over of [{ key: "a", ctrlKey: false }, { key: "ArrowDown" }, { shiftKey: true },
                      { altKey: true }, { metaKey: true }, { isComposing: true }, { key: "Alt", altKey: true },
                      { key: "Shift", shiftKey: true }]) {
    const f = await setup();
    f.press(); f.time.run(2);
    const e = chord(f.a.parts.content, over);
    f.fire("keydown", e);
    assert.equal(e.defaultPrevented, false, JSON.stringify(over));
    assert.equal(f.time.pending(), 0, JSON.stringify(over));
    f.time.run(5);
    assert.equal(f.view.writes.length, 2, JSON.stringify(over));
  }
  // control's own repeat while it alone is held is not a change
  const f = await setup();
  f.press(); f.fire("keydown", chord(null, { key: "Control", repeat: true }));
  assert.equal(f.time.pending(), 1);
});

// control+s while typing in the card's own composer scrolls, and the caret's
// field keeps focus
test("the composer being typed in, in either shape, the response and the page itself all take the chord", async () => {
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
  assert.equal(f.press({ key: "ArrowUp", shiftKey: true }).defaultPrevented, true);
  f.press({ key: "ArrowLeft", shiftKey: true });
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
  f.release("Control");
  assert.equal(f.time.pending(), 0);
  near(f.view.scrollTop, top - STEP);
  f.press({ key: "ArrowDown", shiftKey: true });
  f.press({ key: "ArrowRight", shiftKey: true });
  assert.deepEqual(f.calls, [["history", "c1", -1], ["step", 1]]);
});

// control+n and control+l through each page's own action table: no command of
// the page, typing or not, so macOS and the browser keep them, and no plain
// letter or control+s moves the selected card at all
for (const name of ["index.html", "m.html"]) {
  test(`${name} control+n and control+l are left alone, and no plain letter or control+s moves the card`, async () => {
    const f = await page(name, calls => ({
      FOCUS: true, boardKeysLive: () => true, miniFocused: false, p3Zoom: null,
      lastState: { boxes: [{ id: "c1", bucket: "meta" }] },
      setCardDestination: (id, where) => calls.push(["destination", id, where]),
    }));
    const targets = { composer: f.a.parts.content, textarea: f.a.parts.ta, title: f.a.parts.title,
                      reply: f.a.parts.reply, page: f.doc.body };
    for (const [where, target] of Object.entries(targets)) {
      for (const key of ["n", "N", "l", "L"]) {
        assert.equal(f.press({ key }, target).defaultPrevented, false, `${where} control+${key}`);
      }
    }
    assert.deepEqual(f.calls, [], "a destination key moved the card");
    for (const key of ["n", "N", "s", "S", "l", "L"]) f.press({ key, ctrlKey: false }, f.doc.body);
    assert.deepEqual(f.calls, [], "a plain letter moved the card");
    f.press({}, f.doc.body); f.release("S");
    f.press({}, f.a.parts.content); f.release("S");
    assert.deepEqual(f.calls, [], "control+s moved the card");
    for (const over of [{ shiftKey: true }, { metaKey: true }, { altKey: true }, { repeat: true }]) {
      f.press({ key: "n", ...over }, f.doc.body);
      f.press({ key: "l", ...over }, f.doc.body);
    }
    assert.deepEqual(f.calls, []);
  });
}

// ---- the section keys through each page's own action table -----------------------
// control+shift+[, ] and \ move the selected card while typing in its composer
// and while typing nothing; [, ] and \ alone only while typing nothing. the
// move itself (the chip's own request, and nothing where it is faded) is
// sun-section-chips' to prove; here it is who is asked, for what, and when
const SECTIONS = [
  { code: "BracketLeft", key: "[", shifted: "{", section: "doing" },
  { code: "BracketRight", key: "]", shifted: "}", section: "docked" },
  { code: "Backslash", key: "\\", shifted: "|", section: "deferred" },
];
const sectionChord = ({ code, shifted }, over = {}) => ({ key: shifted, code, ctrlKey: true, shiftKey: true, ...over });
const sectionAlone = ({ code, key }, over = {}) => ({ key, code, ctrlKey: false, ...over });

// hops records the shared hop to the next doing card (selectNextCard)
async function sectionPage(name) {
  const moves = [], requests = [], hops = [];
  const f = await page(name, calls => ({
    FOCUS: true, boardKeysLive: () => true, miniFocused: false, p3Zoom: null,
    lastState: { boxes: [{ id: "c1", bucket: "meta" }, { id: "c2", bucket: "meta" }] },
    setCardDestination: (id, where) => calls.push(["destination", id, where]),
    sectionKeyMove: (id, section, el, close) => { moves.push({ id, section, el, close }); return true; },
    nav: dir => calls.push(["nav", dir]),
    stepCard: dir => calls.push(["step", dir]),
    closeCard: id => calls.push(["closeCard", id]),
    selectNextCard: id => hops.push(id),
    poll() {},
    fetch: (url, init) => { requests.push([url, init && init.method]); return Promise.resolve({}); },
  }));
  return { ...f, moves, requests, hops };
}
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
// the cross faded, the way the page paints a card already done
const fadedCross = () => ({ getAttribute: name => (name === "aria-disabled" ? "true" : null) });

for (const name of ["index.html", "m.html"]) {
  test(`${name} control+shift with [, ] and \\ moves the selected card from its composer, the response and the page`, async () => {
    const f = await sectionPage(name);
    const from = { composer: f.a.parts.content, textarea: f.a.parts.ta, reply: f.a.parts.reply, page: f.doc.body };
    for (const [where, target] of Object.entries(from)) {
      for (const keys of SECTIONS) {
        const before = f.moves.length;
        // the editor has already cancelled the chord on its way when it came from the composer
        const cancelled = where === "composer" ? { defaultPrevented: true } : {};
        const e = f.press(sectionChord(keys, cancelled), target);
        assert.equal(e.defaultPrevented, true, `${where} ${keys.code}`);
        assert.equal(f.moves.length, before + 1, `${where} ${keys.code} moved nothing`);
        const move = f.moves.at(-1);
        assert.deepEqual([move.id, move.section], ["c1", keys.section], `${where} ${keys.code}`);
        assert.equal(move.el, f.a.el, "the move was not handed the selected card's own chips");
      }
    }
    assert.deepEqual(f.calls, [], "a section chord reached another command");
  });

  test(`${name} a title, another field and another card's composer keep the section chord`, async () => {
    const f = await sectionPage(name);
    const others = { title: f.a.parts.title, navigator: f.mdnav, search: f.search,
                     otherComposer: f.b.parts.content, otherTextarea: f.b.parts.ta };
    for (const [where, target] of Object.entries(others)) {
      for (const keys of SECTIONS) {
        assert.equal(f.press(sectionChord(keys), target).defaultPrevented, false, `${where} ${keys.code}`);
      }
    }
    assert.deepEqual(f.moves, []);
  });

  test(`${name} [, ] and \\ alone move the card only while nothing is typed`, async () => {
    const f = await sectionPage(name);
    const typing = { composer: f.a.parts.content, textarea: f.a.parts.ta, title: f.a.parts.title,
                     navigator: f.mdnav, search: f.search };
    for (const [where, target] of Object.entries(typing)) {
      for (const keys of SECTIONS) {
        assert.equal(f.press(sectionAlone(keys), target).defaultPrevented, false, `${where} ${keys.key}`);
      }
    }
    assert.deepEqual(f.moves, [], "a key alone moved the card while typing");
    for (const target of [f.doc.body, f.a.parts.reply]) {
      for (const keys of SECTIONS) {
        assert.equal(f.press(sectionAlone(keys), target).defaultPrevented, true, keys.key);
      }
    }
    assert.deepEqual(f.moves.map(m => [m.id, m.section]),
      [["c1", "doing"], ["c1", "docked"], ["c1", "deferred"], ["c1", "doing"], ["c1", "docked"], ["c1", "deferred"]]);
  });

  test(`${name} held and composing section keys do nothing`, async () => {
    const f = await sectionPage(name);
    for (const over of [{ repeat: true }, { isComposing: true }]) {
      for (const keys of SECTIONS) {
        f.press(sectionChord(keys, over), f.a.parts.content);
        f.press(sectionChord(keys, over), f.doc.body);
        f.press(sectionAlone(keys, over), f.doc.body);
      }
    }
    assert.deepEqual(f.moves, []);
  });

  test(`${name} section keys leave a card that is not a board card alone, and nothing is selected`, async () => {
    const f = await sectionPage(name);
    f.context.lastState = { boxes: [{ id: "c1", bucket: "lane" }] };
    for (const keys of SECTIONS) {
      assert.equal(f.press(sectionChord(keys), f.doc.body).defaultPrevented, false);
      assert.equal(f.press(sectionAlone(keys), f.doc.body).defaultPrevented, false);
    }
    f.context.lastState = { boxes: [{ id: "c1", bucket: "meta" }] };
    f.context.selectedId = null;
    for (const keys of SECTIONS) {
      f.press(sectionChord(keys), f.doc.body);
      f.press(sectionAlone(keys), f.doc.body);
    }
    assert.deepEqual(f.moves, []);
  });

  test(`${name} command+shift+[ and ], control+n, control+l, backspace and delete do nothing on the page`, async () => {
    const f = await sectionPage(name);
    const keys = [
      { key: "{", code: "BracketLeft", ctrlKey: false, metaKey: true, shiftKey: true },
      { key: "}", code: "BracketRight", ctrlKey: false, metaKey: true, shiftKey: true },
      { key: "[", code: "BracketLeft", ctrlKey: false, metaKey: true, shiftKey: true },
      { key: "]", code: "BracketRight", ctrlKey: true, metaKey: true, shiftKey: true },
      { key: "n", code: "KeyN" }, { key: "l", code: "KeyL" },
      { key: "Backspace", code: "Backspace", ctrlKey: false }, { key: "Delete", code: "Delete", ctrlKey: false },
    ];
    const done = f.a.el.x;
    for (const faded of [false, true]) {
      f.a.el.x = faded ? fadedCross() : done;
      for (const target of [f.doc.body, f.a.parts.reply, f.a.parts.content, f.a.parts.ta, f.a.parts.title]) {
        for (const over of keys) {
          assert.equal(f.press(over, target).defaultPrevented, false, `${over.key} on ${target === f.doc.body ? "the page" : "a field"}`);
        }
      }
    }
    await settle();
    assert.deepEqual(f.calls, [], "a removed key reached a page command");
    assert.deepEqual(f.requests, [], "a removed key closed a card");
    assert.deepEqual(f.hops, []);
    assert.deepEqual(f.moves, []);
  });

  test(`${name} done is the page's own close, and it hops`, async () => {
    const f = await sectionPage(name);
    f.press({ key: "Backspace", code: "Backspace", ctrlKey: true, shiftKey: true }, f.doc.body);
    const [move] = f.moves;
    assert.equal(move.section, "done");
    move.close("c1");
    await settle();
    if (name === "index.html") {
      assert.deepEqual(f.requests.map(([url, method]) => [url.split("&sid=")[0], method]), [["/close?box=c1", "POST"]], "not the cross's close");
      assert.deepEqual(f.hops, ["c1"], "the done key did not hop");
    } else assert.deepEqual(f.calls, [["closeCard", "c1"]], "not the cross's close");
  });
}

test("index.html the large card leaves the section keys to the small card while it holds the keys", async () => {
  const f = await sectionPage("index.html");
  f.context.miniFocused = true;
  for (const keys of SECTIONS) {
    assert.equal(f.press(sectionChord(keys), f.doc.body).defaultPrevented, false);
    assert.equal(f.press(sectionAlone(keys), f.doc.body).defaultPrevented, false);
  }
  assert.deepEqual(f.moves, []);
});

// the small card's capture table, run as written: the keys move the card it
// shows, and are stopped before its composer's editor sees them
test("index.html the small card's section keys move its own card and stop there", async () => {
  const text = await readFile(path.join(ROOT, "index.html"), "utf8");
  const start = text.indexOf("const miniShortcutActions = {");
  const fnAt = text.indexOf("function miniSectionMove(e, section){", start);
  const end = text.indexOf("\n}", fnAt) + 2;
  assert.ok(start >= 0 && fnAt > start && end > fnAt);
  const w = world();
  const moves = [], requests = [];
  const l = await logic({
    miniId: "c1", miniEls: { c1: w.a.el, c2: w.b.el },
    lastState: { boxes: [{ id: "c1", bucket: "meta" }] },
    miniCreate() {}, miniStep() {}, poll() {},
    sectionKeyMove: (id, section, el, close) => { moves.push({ id, section, el, close }); return true; },
    fetch: (url, init) => { requests.push([url, init && init.method]); return Promise.resolve({}); },
  });
  vm.runInContext(text.slice(start, end), l.context);
  const actions = vm.runInContext("miniShortcutActions", l.context);
  const send = (over, target) => {
    const e = chord(target, over);
    e.stopped = false;
    e.stopPropagation = () => { e.stopped = true; };
    l.dispatch(e, actions, "mini");
    return e;
  };
  for (const keys of SECTIONS) {
    for (const target of [w.a.parts.content, w.a.parts.ta, w.doc.body]) {
      const e = send(sectionChord(keys), target);
      assert.ok(e.defaultPrevented && e.stopped, `${keys.code} chord was not taken from the small card`);
    }
    // alone, only where nothing is typed
    for (const target of [w.a.parts.content, w.a.parts.title]) {
      const e = send(sectionAlone(keys), target);
      assert.ok(!e.defaultPrevented && !e.stopped, `${keys.key} alone was taken while typing`);
    }
    const e = send(sectionAlone(keys), w.doc.body);
    assert.ok(e.defaultPrevented && e.stopped);
    // another field keeps the chord
    assert.equal(send(sectionChord(keys), w.search).defaultPrevented, false);
    assert.equal(send(sectionChord(keys), w.a.parts.title).defaultPrevented, false);
  }
  assert.equal(moves.length, 12);
  for (const move of moves) assert.equal(move.el, w.a.el);
  assert.deepEqual(moves.map(m => m.section),
    ["doing", "doing", "doing", "doing", "docked", "docked", "docked", "docked", "deferred", "deferred", "deferred", "deferred"]);
  moves[0].close("c1");
  assert.deepEqual(requests.map(([url, method]) => [url.split("&sid=")[0], method]), [["/close?box=c1", "POST"]], "not the small cross's close");
});

// The PWA drawer hands the same motion a section scroller, while the closed
// drawer keeps the card route. Run the actual phone action tables and guards.
async function drawerKeys() {
  const f = await page("m.html", () => ({}));
  const text = await readFile(path.join(ROOT, "m.html"), "utf8");
  const panes = Object.fromEntries(["todo", "docked", "deferred", "done"].map(view => [view,
    Object.assign(node(f.doc.body), { ownerDocument: f.doc, clientHeight: 300,
      scrollHeight: 1500, scrollTop: 600, children: [node(f.doc.body)] })]));
  const state = { view: "todo" };
  f.doc.querySelector = selector => panes[/data-view="([^"]+)"/.exec(selector)?.[1]] || null;
  f.doc.activeElement = f.doc.body;
  Object.assign(f.context, { homeOpen: false, curView: () => state.view,
    drawerOpen: () => f.open.has("listout") });
  vm.runInContext(text.slice(text.indexOf("function drawerPane(){"), text.indexOf("// Tab walks the menu")), f.context);
  const menu = vm.runInContext("menuShortcutActions", f.context);
  const card = vm.runInContext("phoneShortcutActions", f.context);
  const press = (over = {}, target = f.doc.activeElement) => {
    const e = chord(target, over);
    f.fire("keydown", e);
    f.dispatch(e, f.open.has("menuout") ? menu : card);
    return e;
  };
  const openDrawer = () => { f.open.add("listout"); f.open.add("menuout"); };
  openDrawer();
  return { ...f, panes, state, press, openDrawer };
}

test("PWA Ctrl+S scrolls only the open ticket section at the existing speed and stops on release", async () => {
  const f = await drawerKeys();
  assert.equal(f.press().defaultPrevented, true);
  f.time.run(5);
  near(f.panes.todo.scrollTop, 615);
  near(f.panes.deferred.scrollTop, 600);
  near(f.view.scrollTop, 1000, "card behind the list");
  f.release("S"); f.time.run(10);
  near(f.panes.todo.scrollTop, 615);
  assert.equal(f.time.pending(), 0);
});

test("PWA drawer double S reverses within 300ms and held repeats never reverse or restart it", async () => {
  for (const elapsed of [299, 300]) {
    const f = await drawerKeys();
    f.press(); f.time.run(1); f.release("S");
    f.time.elapse(elapsed - 20);
    f.press(); f.time.run(1);
    const direction = elapsed < 300 ? -1 : 1;
    near(f.panes.todo.scrollTop, 603 + STEP * direction);
    f.press({ repeat: true }); f.time.run(2);
    near(f.panes.todo.scrollTop, 603 + STEP * direction * 3);
    f.release("Control"); f.time.run(5);
    assert.equal(f.time.pending(), 0);
    f.press(); f.time.run(1);
    near(f.panes.todo.scrollTop, 606 + STEP * direction * 3, "new Control hold goes down");
  }
});

test("PWA drawer accepts Ctrl+S from its buttons, leaves typing alone, and settings never scroll", async () => {
  const f = await drawerKeys();
  const button = node(f.doc.body);
  f.doc.activeElement = button;
  assert.equal(f.press().defaultPrevented, true);
  f.time.run(1); f.release("Control");
  near(f.panes.todo.scrollTop, 603);
  f.doc.activeElement = f.a.parts.content;
  assert.equal(f.press().defaultPrevented, false);
  f.open.delete("listout");
  f.doc.activeElement = button;
  assert.equal(f.press().defaultPrevented, false);
  f.time.run(5);
  near(f.panes.todo.scrollTop, 603);
  near(f.view.scrollTop, 1000);
});

test("PWA drawer motion stops when its section, project, focus, visibility or drawer changes", async () => {
  for (const [name, leave] of Object.entries({
    section: f => { f.state.view = "done"; },
    project: f => { f.context.activeOwner = "p2"; },
    focus: f => { f.doc.activeElement = node(f.doc.body); },
    hidden: f => { f.doc.visibilityState = "hidden"; },
    detached: f => { f.panes.todo.isConnected = false; },
    close: f => f.open.clear(),
    drag: f => f.open.add("menudrag"),
    home: f => { f.context.homeOpen = true; },
  })) {
    const f = await drawerKeys();
    f.press(); f.time.run(1);
    leave(f); f.time.run(5);
    near(f.panes.todo.scrollTop, 603, name);
    near(f.panes.done.scrollTop, 600, name);
    near(f.view.scrollTop, 1000, name);
    assert.equal(f.time.pending(), 0, name);
  }
});

test("closing the PWA drawer returns Ctrl+S and double S to the response without carrying the list's tap", async () => {
  const f = await drawerKeys();
  f.press(); f.time.run(1); f.release("S");
  f.open.clear();
  f.press(); f.time.run(1); f.release("S");
  near(f.panes.todo.scrollTop, 603);
  near(f.view.scrollTop, 1003);
  f.press(); f.time.run(2); f.release("Control");
  near(f.view.scrollTop, 997);
  near(f.panes.todo.scrollTop, 603);
});

test("a short PWA ticket list keeps the shared edge feedback and leaves the card still", async () => {
  const f = await drawerKeys();
  Object.assign(f.panes.todo, { scrollHeight: 100, scrollTop: 0 });
  assert.equal(f.press().defaultPrevented, true);
  f.time.run(4);
  near(f.panes.todo.scrollTop, 0);
  near(f.view.scrollTop, 1000);
  assert.equal(f.panes.todo.children[0].animations.length, 1);
  assert.equal(f.time.pending(), 0);
});
