const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// a hand-driven clock, so every wait is exact
function clock() {
  let now = 0, next = 1;
  const due = new Map();
  return {
    now: () => now,
    elapse(ms) { now += ms; },
    setTimeout(fn, ms) { due.set(next, { at: now + ms, fn }); return next++; },
    clearTimeout(id) { due.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        let pick = null;
        for (const entry of due) if (entry[1].at <= end && (!pick || entry[1].at < pick[1].at)) pick = entry;
        if (!pick) break;
        due.delete(pick[0]);
        now = pick[1].at;
        pick[1].fn();
      }
      now = end;
    },
    waiting() { return due.size; },
  };
}

async function logic(globals = {}) {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const time = clock();
  const context = vm.createContext({
    Date, performance: { now: time.now }, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, ...globals,
  });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  Object.assign(context, globals);
  const get = name => vm.runInContext(name, context);
  return {
    time, context,
    resolve: get("cardShortcut"),
    dispatch: get("dispatchCardShortcut"),
    responseTap: get("responseTap"),
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

function world({ clientHeight = 400, scrollHeight = 2000, scrollTop = 0, composer = "cm" } = {}) {
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

async function setup(opts) {
  const l = await logic();
  const w = world(opts);
  w.doc.activeElement = w.a.parts.content;
  const actions = { responsePage: e => l.responseTap(e, w.find) };
  const press = (over = {}, target = w.a.parts.content) => {
    const e = chord(target, over);
    l.dispatch(e, actions);
    return e;
  };
  return { ...l, ...w, view: w.a.el.replyview, press };
}

test("control+shift+s with either case is the response page chord and nothing looser is", async () => {
  const { resolve } = await logic();
  for (const key of ["s", "S"]) assert.equal(resolve(chord(null, { key })).action, "responsePage");
  assert.equal(resolve(chord(null, { repeat: true })).action, "responsePage");
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: false },
                      { isComposing: true }, { defaultPrevented: true }, { key: "d" }]) {
    assert.notEqual(resolve(chord(null, over))?.action, "responsePage", JSON.stringify(over));
  }
  assert.equal(resolve(chord(null, { ctrlKey: false, shiftKey: false, key: "s" })).action, "destination");
  assert.equal(resolve(chord(null), "mini"), null);
});

test("one tap pages down only once the double tap window has passed", async () => {
  const { press, time, view, doc, a } = await setup();
  const e = press();
  assert.equal(e.defaultPrevented, true);
  time.tick(299);
  assert.deepEqual(view.writes, []);
  time.tick(1);
  assert.deepEqual(view.writes, [350]);
  time.tick(1000);
  assert.deepEqual(view.writes, [350]);
  assert.equal(doc.activeElement, a.parts.content);
});

test("two quick taps page up once, with no down before it", async () => {
  const { press, time, view } = await setup({ scrollTop: 1000 });
  press();
  time.tick(150);
  assert.equal(press().defaultPrevented, true);
  assert.deepEqual(view.writes, [650]);
  time.tick(1000);
  assert.deepEqual(view.writes, [650]);
});

test("a held chord is one tap: its repeats are swallowed and never count as the second", async () => {
  const { press, time, view } = await setup({ scrollTop: 1000 });
  press();
  for (let at = 30; at < 300; at += 30) {
    time.tick(30);
    assert.equal(press({ repeat: true }).defaultPrevented, true);
  }
  time.tick(30);
  assert.deepEqual(view.writes, [1350]);
  for (let i = 0; i < 5; i++) { press({ repeat: true }); time.tick(30); }
  time.tick(1000);
  assert.deepEqual(view.writes, [1350]);
});

test("a delayed timer does not count a slow second tap as a double tap", async () => {
  const { press, time, view } = await setup({ scrollTop: 500 });
  press();
  time.elapse(450);
  press();
  assert.deepEqual(view.writes, [850]);
  time.tick(300);
  assert.deepEqual(view.writes, [850, 1200]);
});

test("a tap after a double tap, or after a down has landed, starts afresh", async () => {
  const { press, time, view } = await setup({ scrollTop: 1000 });
  press(); time.tick(100); press();
  assert.deepEqual(view.writes, [650]);
  time.tick(50); press();
  time.tick(299);
  assert.deepEqual(view.writes, [650]);
  time.tick(1);
  assert.deepEqual(view.writes, [650, 1000]);
  time.tick(100); press(); time.tick(100); press();
  assert.deepEqual(view.writes, [650, 1000, 650]);
});

test("modified, composing and already handled keys leave the response and the key alone", async () => {
  for (const over of [{ altKey: true }, { metaKey: true }, { ctrlKey: false }, { shiftKey: false },
                      { isComposing: true }, { defaultPrevented: true }]) {
    const { press, time, view } = await setup();
    const e = press(over);
    if (!over.defaultPrevented) assert.equal(e.defaultPrevented, false, JSON.stringify(over));
    assert.equal(time.waiting(), 0);
    time.tick(1000);
    assert.deepEqual(view.writes, [], JSON.stringify(over));
  }
});

test("the composer in either shape, the response and the page itself all take the chord", async () => {
  for (const composer of ["cm", "textarea"]) {
    for (const where of ["content", "ta", "reply", "body"]) {
      const f = await setup({ composer });
      const target = where === "body" ? f.doc.body : f.a.parts[where];
      f.doc.activeElement = target;
      assert.equal(f.press({}, target).defaultPrevented, true, `${composer} ${where}`);
      f.time.tick(300);
      assert.deepEqual(f.view.writes, [350], `${composer} ${where}`);
      assert.equal(f.doc.activeElement, target);
    }
  }
});

test("other fields, the sent and answered boxes and other cards keep the chord", async () => {
  const f = await setup({ scrollTop: 200 });
  const others = {
    title: f.a.parts.title, pendRow: f.a.parts.pendRow, answeredRow: f.a.parts.answeredRow,
    navigator: f.mdnav, search: f.search, otherComposer: f.b.parts.content,
    otherTextarea: f.b.parts.ta, otherReply: f.b.parts.reply,
  };
  for (const [name, target] of Object.entries(others)) {
    assert.equal(f.press({}, target).defaultPrevented, false, name);
    assert.equal(f.time.waiting(), 0, name);
  }
  // a stray chord elsewhere also drops a tap already waiting
  f.press(); f.time.tick(100);
  f.press({}, f.search);
  f.time.tick(1000);
  assert.deepEqual(f.view.writes, []);
  assert.deepEqual(f.b.el.replyview.writes, []);
});

test("paging stops at either end and still takes the chord there", async () => {
  const end = await setup({ scrollTop: 1500 });
  end.press(); end.time.tick(300);
  assert.equal(end.view.scrollTop, 1600);
  assert.equal(end.press().defaultPrevented, true);
  end.time.tick(300);
  assert.equal(end.view.scrollTop, 1600);

  const top = await setup({ scrollTop: 100 });
  top.press(); top.time.tick(100); top.press();
  assert.equal(top.view.scrollTop, 0);
  top.time.tick(400); top.press(); top.time.tick(100);
  assert.equal(top.press().defaultPrevented, true);
  assert.equal(top.view.scrollTop, 0);

  const short = await setup({ scrollHeight: 300 });
  short.press(); short.time.tick(300);
  assert.equal(short.view.scrollTop, 0);

  const hidden = await setup({ clientHeight: 0 });
  assert.equal(hidden.press().defaultPrevented, false);
  assert.equal(hidden.time.waiting(), 0);
});

test("a waiting down is dropped when the card, its render, project, focus, page or overlay changes", async () => {
  const changes = {
    card: f => { f.state.id = "c2"; },
    render: f => { f.state.el = { ...f.a.el }; },
    project: f => { f.state.owner = "p2"; },
    focus: f => { f.doc.activeElement = f.search; },
    hidden: f => { f.doc.visibilityState = "hidden"; },
    detached: f => { f.a.el.box.isConnected = false; },
    overlay: f => { f.state.open = false; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = await setup();
    f.press(); f.time.tick(100);
    change(f);
    f.time.tick(1000);
    assert.deepEqual(f.view.writes, [], name);
  }
});

test("a second tap on a different card is its own first tap, not an up on either", async () => {
  const f = await setup({ scrollTop: 1000 });
  f.press(); f.time.tick(100);
  Object.assign(f.state, { id: "c2", el: f.b.el });
  f.doc.activeElement = f.b.parts.content;
  f.press({}, f.b.parts.content);
  f.time.tick(1000);
  assert.deepEqual(f.a.el.replyview.writes, []);
  assert.deepEqual(f.b.el.replyview.writes, [1350]);
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
  const w = world({ scrollTop: 1000 });
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
  const press = (key = "S", over = {}) => {
    const e = chord(w.a.parts.content, { key, ...over });
    l.dispatch(e, actions);
    return e;
  };
  return { ...l, ...w, open, calls, press, view: w.a.el.replyview };
}

test("desktop panels, menus, the small card and a picture keep the chord, now and when the wait ends", async () => {
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
    assert.equal(f.time.waiting(), 0, name);
    clear();
    f.press(); f.time.tick(100); block(); f.time.tick(1000); clear();
    assert.deepEqual(f.view.writes, [], name);
  }
  f.press(); f.time.tick(300);
  assert.deepEqual(f.view.writes, [1350]);
  // history and card steps are untouched, and a history step leaves paging working
  assert.equal(f.press("ArrowUp").defaultPrevented, true);
  f.press("ArrowLeft");
  f.press(); f.time.tick(100); f.press();
  assert.deepEqual(f.calls, [["history", "c1", 1], ["nav", -1]]);
  assert.deepEqual(f.view.writes, [1350, 1000]);
});

test("a phone drawer or a swipe keeps the chord, now and when the wait ends", async () => {
  const f = await page("m.html", calls => ({
    stepCard: dir => calls.push(["step", dir]),
  }));
  for (const cls of ["menuout", "carddrag"]) {
    f.open.add(cls);
    assert.equal(f.press().defaultPrevented, false, cls);
    f.open.clear();
    f.press(); f.time.tick(100); f.open.add(cls); f.time.tick(1000); f.open.clear();
    assert.deepEqual(f.view.writes, [], cls);
  }
  f.press(); f.time.tick(100); f.press();
  assert.deepEqual(f.view.writes, [650]);
  f.press("ArrowDown");
  f.press("ArrowRight");
  assert.deepEqual(f.calls, [["history", "c1", -1], ["step", 1]]);
});
