// Real drawer handlers with measured DOM rectangles supplied by a fixture.
// No browser or server. PHONE_GLASS_SOURCE runs the same checks on old HTML.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const html = readFileSync(process.env.PHONE_GLASS_SOURCE || path.join(__dirname, "..", "m.html"), "utf8");
const logic = readFileSync(path.join(__dirname, "..", "card-logic.js"), "utf8");

function between(start, end, optional = false) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  if (optional && a < 0) return "";
  assert.ok(a >= 0 && b > a, `missing source: ${start}`);
  return html.slice(a, b);
}

function fixture({ selected = "r14", count = 20, height = 300 } = {}) {
  const mutations = [], observers = [], resize = [], keys = [], microtasks = [], windowEvents = {};
  function node(classes = []) {
    const set = new Set(classes), styles = new Map(), events = {};
    const el = { dataset: {}, clientTop: 0, clientHeight: height, offsetHeight: 52, rows: [],
      style: { getPropertyValue: n => styles.get(n) || "", setProperty: (n, v) => styles.set(n, v), removeProperty: n => styles.delete(n) },
      classList: {
        contains: n => set.has(n),
        toggle(n, on = !set.has(n)) {
          if (set.has(n) !== on) {
            mutations.push({ type: "attributes", target: el, oldValue: [...set].join(" ") });
            if (on) set.add(n); else set.delete(n);
          }
        },
        add(n) { this.toggle(n, true); }, remove(n) { this.toggle(n, false); },
      },
      addEventListener(type, fn) { (events[type] ||= []).push(fn); },
      fire(type) { for (const fn of events[type] || []) fn({ target: el }); },
      closest: () => null,
      getBoundingClientRect: () => ({ top: 100, bottom: 100 + el.clientHeight }),
      querySelectorAll: () => el.rows,
    };
    return el;
  }
  const body = node(), tickets = node(["open"]), panes = { todo: node(), deferred: node(), done: node() };
  let view = "todo", closes = 0;
  const pane = panes.todo;
  tickets.querySelectorAll = () => Object.values(panes);
  for (const p of Object.values(panes)) {
    p.scrollTop = 0;
    Object.defineProperty(p, "scrollHeight", { get() {
      return parseFloat(p.style.getPropertyValue("--pick-head") || 10) +
        p.rows.reduce((sum, r) => sum + r.offsetHeight, 0) + Math.max(0, p.rows.length - 1) * 6 +
        parseFloat(p.style.getPropertyValue("--pick-foot") || 17);
    } });
  }
  function row(id, p) {
    const r = node(["trow", ...(id === selected ? ["on"] : [])]);
    r.dataset.id = id;
    r.getBoundingClientRect = () => {
      const at = p.rows.indexOf(r);
      const top = 100 + parseFloat(p.style.getPropertyValue("--pick-head") || 10) - p.scrollTop +
        p.rows.slice(0, at).reduce((sum, one) => sum + one.offsetHeight + 6, 0) - (r.classList.contains("on") ? 1 : 0);
      return { top, bottom: top + r.offsetHeight };
    };
    r.scrollIntoView = () => {
      const rect = r.getBoundingClientRect();
      if (rect.top < 100) p.scrollTop += rect.top - 100;
      else if (rect.bottom > 100 + p.clientHeight) p.scrollTop += rect.bottom - 100 - p.clientHeight;
      p.fire("scroll");
    };
    return r;
  }
  pane.rows = Array.from({ length: count }, (_, i) => row(`r${i}`, pane));
  const allRows = () => Object.values(panes).flatMap(p => p.rows);
  const read = [], store = new Map(), els = Object.fromEntries(pane.rows.map(r => [r.dataset.id, { box: node() }]));
  const document = { body, activeElement: body,
    addEventListener(type, fn) { if (type === "keydown") keys.push(fn); },
    querySelector: () => panes[view], querySelectorAll: allRows, getElementById: () => node(),
  };
  const context = vm.createContext({ document, window: { ResizeObserver: true }, tickets,
    queueMicrotask: fn => microtasks.push(fn),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe(target, options) { observers.push({ fn: this.fn, target, options }); } },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe(target) { resize.push({ fn: this.fn, target }); } },
    addEventListener(type, fn) { (windowEvents[type] ||= []).push(fn); },
    homeOpen: false, selectedId: selected, shownId: selected, browsing: true, els, lastSel: {}, hist: null,
    activeOwner: "project", lastState: { boxes: pane.rows.map(r => ({ id: r.dataset.id, owner: "project" })) },
    localStorage: { setItem: (k, v) => store.set(k, v) },
    curView: () => view, drawerOpen: () => tickets.classList.contains("open"),
    menuOut: () => tickets.classList.contains("open") ? tickets : null,
    closeDrawer: () => { tickets.classList.remove("open"); closes++; },
    phoneShortcutActions: {}, tickBands() {}, phoneShortcutTyping: target => !!target.typing,
    ensureCard: id => els[id], tracePhone() {}, endPhoneTrace() {}, cancelAutoNext() {},
    syncPhoneHistory() {}, wearEditor() {}, openAtHead() {}, seatScroll() {}, renderTabs() {}, reachLater() {},
    markSeen: id => read.push(id),
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  context.markSeen = id => read.push(id);
  context.curView = () => view;
  for (const name of ["setBrowsing", "select", "browse", "chooseShown"])
    run(html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]);
  run(between("function drawerPane(){", "// Tab walks the menu"));
  run(between("let drawerKeyboardUsed =", "// Keep only the start, first intended move", true));
  run(between('addEventListener("keydown", e => {\n  if (homeOpen || !menuOut())', "// a tap anywhere on the card on screen"));
  function flush() {
    let turns = 0;
    while (mutations.length) {
      assert.ok(++turns < 10, "marker changes must not loop the observer");
      const changes = mutations.splice(0);
      for (const o of observers) o.fn(changes);
    }
  }
  flush();
  return { context, pane, panes, tickets, read, store, run, row, flush,
    picks: () => allRows().filter(r => r.classList.contains("drawer-pick")).map(r => r.dataset.id),
    closes: () => closes,
    key(key = "Shift", extra = {}) {
      const e = { key, code: key === "Shift" ? "ShiftLeft" : key, isTrusted: true, keyCode: 0,
        target: body, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      for (const fn of [...keys, ...(windowEvents.keydown || [])]) { fn(e); if (e.stopped) break; }
      while (microtasks.length) microtasks.shift()();
      flush(); return e;
    },
    scroll(top) { pane.scrollTop = top; pane.fire("scroll"); flush(); },
    center(index) {
      const r = pane.rows[index], rect = r.getBoundingClientRect();
      this.scroll(pane.scrollTop + (rect.top + rect.bottom) / 2 - (100 + pane.clientHeight / 2));
    },
    resize(h) { pane.clientHeight = h; for (const r of resize) if (r.target === pane) r.fn(); flush(); },
    view(v) {
      view = v;
      mutations.push({ type: "attributes", target: node(["on"]), oldValue: "tvb" }); flush();
    },
    changedRows(p = pane) { mutations.push({ type: "childList", target: p }); flush(); },
  };
}

test("touch scrolling never shows a keyboard pick before a hardware key", () => {
  const f = fixture(); f.center(5); assert.deepEqual(f.picks(), []);
  for (const extra of [{ isTrusted: false }, { code: "" }, { code: "Unidentified" }, { isComposing: true }, { keyCode: 229 }]) {
    f.key("x", extra); assert.deepEqual(f.picks(), []);
  }
  f.key(); assert.deepEqual(f.picks(), ["r5"]);
});

test("any visible part of the open ticket suppresses the outline at either edge", () => {
  const f = fixture(); f.key();
  const r = f.pane.rows[14];
  // Put the open ticket's top a quarter pixel inside the bottom edge.
  f.scroll(f.pane.scrollTop + r.getBoundingClientRect().top - 399.75);
  assert.deepEqual(f.picks(), []);
  f.scroll(f.pane.scrollTop - .25); assert.equal(f.picks().length, 1);
  // Put its bottom a quarter pixel inside the top edge.
  f.scroll(f.pane.scrollTop + r.getBoundingClientRect().bottom - 100.25);
  assert.deepEqual(f.picks(), []);
  f.scroll(f.pane.scrollTop + .25); assert.equal(f.picks().length, 1);
});

test("the middle pick follows both scroll directions and vanishes when the open row returns", () => {
  const f = fixture(); f.key();
  for (const index of [5, 4, 3, 6, 18, 19]) {
    f.center(index); assert.deepEqual(f.picks(), [`r${index}`]);
  }
  f.center(14); assert.deepEqual(f.picks(), []);
});

test("the ticket under the centre wins, including unequal rows and a gap", () => {
  const f = fixture(); f.key(); f.pane.rows[5].offsetHeight = 120;
  f.center(5); f.scroll(f.pane.scrollTop + 50);
  assert.deepEqual(f.picks(), ["r5"], "centre remains inside the tall ticket");
  const bottom = f.pane.rows[5].getBoundingClientRect().bottom;
  f.scroll(f.pane.scrollTop + bottom + 2 - 250); assert.deepEqual(f.picks(), ["r5"]);
  f.scroll(f.pane.scrollTop + 2); assert.deepEqual(f.picks(), ["r6"]);
});

test("Enter opens the outlined card, reads it and closes the drawer without focusing a field", () => {
  const f = fixture(); f.center(5); f.key();
  assert.deepEqual(f.picks(), ["r5"]);
  assert.equal(f.key("Enter").defaultPrevented, true);
  assert.equal(f.context.selectedId, "r5"); assert.equal(f.context.shownId, "r5");
  assert.equal(f.context.browsing, false); assert.deepEqual(f.read, ["r5"]);
  assert.equal(f.store.get("selbox"), "r5"); assert.equal(f.closes(), 1);
  assert.deepEqual(f.picks(), []);
  assert.equal(f.context.document.activeElement, f.context.document.body);
});

test("an outline also makes Enter choose its ticket when a drawer button has focus", () => {
  const f = fixture(); f.center(4); f.key();
  f.key("Enter", { target: { closest: () => ({}) } });
  assert.equal(f.context.selectedId, "r4"); assert.equal(f.closes(), 1);
});

test("Enter before any outline keeps the old action even after touch scrolling", () => {
  const f = fixture(); f.center(5); assert.deepEqual(f.picks(), []);
  f.key("Enter"); assert.equal(f.context.selectedId, "r14"); assert.equal(f.closes(), 1);
  assert.deepEqual(f.read, ["r14"]);
});

test("a hardware key outside the drawer enables later finger scrolling only for this load", () => {
  const f = fixture(); f.tickets.classList.remove("open"); f.flush(); f.key();
  assert.deepEqual(f.picks(), []);
  f.tickets.classList.add("open"); f.flush(); f.center(5); assert.deepEqual(f.picks(), ["r5"]);
  const reload = fixture(); reload.center(5); assert.deepEqual(reload.picks(), []);
});

test("editing, composition and modified Enter keep their existing key guards", () => {
  for (const extra of [{ target: { typing: true } }, { isComposing: true }, { shiftKey: true }, { ctrlKey: true }, { altKey: true }]) {
    const f = fixture(); f.key(); f.center(5); f.key("Enter", extra);
    assert.equal(f.context.selectedId, "r14"); assert.equal(f.closes(), 0);
  }
});

test("Enter without an outline keeps the visible selection and native control behavior", () => {
  const f = fixture(); f.center(14);
  assert.equal(f.key("Enter", { target: { closest: () => ({}) } }).defaultPrevented, false);
  assert.equal(f.closes(), 0);
  f.key("Enter"); assert.equal(f.context.selectedId, "r14");
  assert.equal(f.closes(), 1); assert.deepEqual(f.read, ["r14"]);
});

test("empty sections and sections without the open ticket keep the old Enter path", () => {
  for (const count of [0, 20]) {
    const f = fixture({ count, selected: "absent" }); f.key();
    assert.deepEqual(f.picks(), []); f.key("Enter");
    assert.equal(f.context.selectedId, "absent"); assert.equal(f.closes(), 1); assert.deepEqual(f.read, []);
  }
});

test("the first and last ticket reach the middle at the scroll limits", () => {
  const f = fixture(); f.key();
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "124px");
  assert.equal(f.pane.style.getPropertyValue("--pick-foot"), "124px");
  for (const [index, top] of [[0, 0], [19, f.pane.scrollHeight - f.pane.clientHeight]]) {
    f.scroll(top);
    const rect = f.pane.rows[index].getBoundingClientRect();
    assert.equal((rect.top + rect.bottom) / 2, 250); assert.deepEqual(f.picks(), [`r${index}`]);
  }
});

test("resize and row changes recalculate empty ends, including empty and single-row lists", () => {
  const f = fixture(); f.key(); f.resize(400);
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "174px");
  f.pane.rows[0].offsetHeight = 60; f.pane.rows[19].offsetHeight = 80; f.changedRows();
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "170px");
  assert.equal(f.pane.style.getPropertyValue("--pick-foot"), "160px");
  f.pane.rows = []; f.changedRows(); assert.deepEqual(f.picks(), []);
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "");
  assert.equal(f.pane.style.getPropertyValue("--pick-foot"), "");
  const one = fixture({ count: 1, selected: "r0" }); one.key();
  assert.equal(one.pane.scrollHeight, 300); assert.deepEqual(one.picks(), []);
  one.resize(30); assert.equal(one.pane.style.getPropertyValue("--pick-head"), "0px");
});

test("selection, removed rows, sections, Home and closing clear or replace the pick", () => {
  const f = fixture(); f.key(); f.center(5);
  const removed = f.pane.rows.splice(5, 1)[0]; f.changedRows();
  assert.equal(removed.classList.contains("drawer-pick"), false); assert.deepEqual(f.picks(), ["r6"]);
  f.run('select("r6")'); f.flush(); assert.deepEqual(f.picks(), []);
  f.run('select("r14")'); f.flush(); assert.deepEqual(f.picks(), ["r6"]);
  f.view("done"); assert.deepEqual(f.picks(), []);
  f.view("todo"); assert.deepEqual(f.picks(), ["r6"]);
  f.context.homeOpen = true; f.tickets.classList.remove("open"); f.flush(); assert.deepEqual(f.picks(), []);
  f.context.homeOpen = false; f.tickets.classList.add("open"); f.flush(); assert.deepEqual(f.picks(), ["r6"]);
  f.tickets.classList.remove("open"); f.flush(); assert.deepEqual(f.picks(), []);
});

test("arrows still start at the open ticket, even with another ticket outlined", () => {
  const f = fixture(); f.key(); f.center(5); f.key("ArrowUp");
  assert.equal(f.context.selectedId, "r13"); assert.deepEqual(f.picks(), []);
});

test("the outline reuses only the dock glass rim and travels on the row", () => {
  const rule = html.match(/#tickets \.trow\.drawer-pick > \.trowin::after\{([^]*?)\n  \}/)?.[1];
  assert.ok(rule, "missing row-bound glass rim");
  assert.match(rule, /position:absolute; inset:0; border-radius:inherit/);
  assert.match(rule, /pointer-events:none/);
  assert.match(rule, /inset 0 0 0 1px var\(--qn-ring, #c7c7cc\)/);
  assert.match(rule, /\.45 \* var\(--qn-edge, 2\)/); assert.match(rule, /\.35 \* var\(--qn-edge, 2\)/);
  assert.doesNotMatch(rule, /background|backdrop-filter|transition|--accent|transform/);
  assert.match(html, /padding:var\(--pick-head,/); assert.match(html, /var\(--pick-foot,/);
  assert.match(html, /if \(pane\) sizeDrawerEnds\(pane\);/, "size padding before open scrollIntoView");
});
