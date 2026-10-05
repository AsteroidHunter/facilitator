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

function fixture({ selected = "r14", count = 20, height = 300, head = 10, foot = 17 } = {}) {
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
  const padding = (p, end) => parseFloat(p.style.getPropertyValue(`--pick-${end}`) || (end === "head" ? head : foot));
  for (const p of Object.values(panes)) {
    let scroll = 0;
    const clamp = value => Math.max(0, Math.min(value, Math.max(0, p.scrollHeight - p.clientHeight)));
    Object.defineProperty(p, "scrollTop", {
      get: () => (scroll = clamp(scroll)), set: value => { scroll = clamp(value); },
    });
    Object.defineProperty(p, "scrollHeight", { get() {
      return padding(p, "head") +
        p.rows.reduce((sum, r) => sum + r.offsetHeight, 0) + Math.max(0, p.rows.length - 1) * 6 +
        padding(p, "foot");
    } });
  }
  function row(id, p) {
    const r = node(["trow", ...(id === selected ? ["on"] : [])]);
    r.dataset.id = id;
    r.getBoundingClientRect = () => {
      const at = p.rows.indexOf(r);
      const top = 100 + padding(p, "head") - p.scrollTop +
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
  tickets.querySelector = () => allRows().find(r => r.classList.contains("on"));
  const allRows = () => Object.values(panes).flatMap(p => p.rows);
  const read = [], store = new Map(), els = Object.fromEntries(pane.rows.map(r => [r.dataset.id, { box: node() }]));
  const document = { body, activeElement: body,
    addEventListener(type, fn) { if (type === "keydown") keys.push(fn); },
    querySelector: () => panes[view], querySelectorAll: allRows, getElementById: () => node(),
  };
  const context = vm.createContext({ document, window: { ResizeObserver: true }, tickets,
    getComputedStyle: p => ({ paddingTop: padding(p, "head") + "px" }),
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
    menuAvailable: () => true,
    runMenu: (panel, v) => panel.classList.toggle("open", v > 0),
    traceFrameOpportunity() {},
    phoneShortcutActions: {}, tickBands() {}, phoneShortcutTyping: target => !!target.typing,
    ensureCard: id => els[id], tracePhone() {}, endPhoneTrace() {}, cancelAutoNext() {},
    syncPhoneHistory() {}, wearEditor() {}, openAtHead() {}, seatScroll() {}, renderTabs() {}, reachLater() {},
    markSeen: id => read.push(id),
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  context.markSeen = id => read.push(id);
  context.curView = () => view;
  for (const name of ["setBrowsing", "select", "browse", "chooseShown", "showMenu"])
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
    positions: () => pane.rows.map(r => r.getBoundingClientRect().top),
    ends: (p = pane) => [p.style.getPropertyValue("--pick-head"), p.style.getPropertyValue("--pick-foot")],
    open() { run("showMenu(tickets)"); flush(); },
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

test("ordinary touch use has no pick space on load, scroll, resize or row changes", () => {
  const f = fixture();
  assert.deepEqual(f.ends(), ["", ""]);
  assert.equal(f.pane.rows[0].getBoundingClientRect().top, 110);
  f.center(5); f.resize(400); f.changedRows();
  assert.deepEqual(f.ends(), ["", ""]);
  for (const extra of [{ isTrusted: false }, { code: "" }, { code: "Unidentified" }, { isComposing: true }, { keyCode: 229 }]) {
    f.key("x", extra); assert.deepEqual(f.ends(), ["", ""]);
  }
  f.scroll(f.pane.scrollHeight);
  assert.equal(f.pane.rows.at(-1).getBoundingClientRect().bottom, 500 - 17);
});

test("hardware keys keep the normal margins while the open ticket is visible", () => {
  const f = fixture(); f.center(14);
  const positions = f.positions();
  f.key(); assert.deepEqual(f.picks(), []); assert.deepEqual(f.ends(), ["", ""]);
  assert.deepEqual(f.positions(), positions);
  f.resize(400); f.changedRows(); assert.deepEqual(f.ends(), ["", ""]);
});

test("adding pick space preserves every ticket's position and the middle pick", () => {
  const f = fixture({ head: 10.5, foot: 17.5 }); f.center(5);
  const positions = f.positions(), scroll = f.pane.scrollTop;
  f.key();
  assert.deepEqual(f.ends(), ["124px", "124px"]);
  assert.equal(f.pane.scrollTop, scroll + 124 - 10.5);
  assert.deepEqual(f.positions(), positions); assert.deepEqual(f.picks(), ["r5"]);
  for (const p of [f.panes.deferred, f.panes.done]) assert.deepEqual(f.ends(p), ["", ""]);
  f.pane.fire("scroll"); f.changedRows(); f.key();
  assert.deepEqual(f.positions(), positions, "refreshes must not add compensation twice");
});

test("removing pick space when the open row returns preserves ticket positions", () => {
  const f = fixture({ head: 10.5, foot: 17.5 }); f.center(5); f.key();
  f.pane.scrollTop += f.pane.rows[14].getBoundingClientRect().top - 399.75;
  const positions = f.positions(), scroll = f.pane.scrollTop;
  f.pane.fire("scroll"); f.flush();
  assert.deepEqual(f.picks(), []); assert.deepEqual(f.ends(), ["", ""]);
  assert.equal(f.pane.scrollTop, scroll + 10.5 - 124);
  assert.deepEqual(f.positions(), positions);
  f.pane.fire("scroll"); f.changedRows(); assert.deepEqual(f.positions(), positions);
});

test("resizing active end space preserves ticket positions and still centers both ends", () => {
  const f = fixture(); f.center(5); f.key();
  const positions = f.positions(), scroll = f.pane.scrollTop;
  f.resize(400);
  assert.deepEqual(f.ends(), ["174px", "174px"]);
  assert.equal(f.pane.scrollTop, scroll + 50); assert.deepEqual(f.positions(), positions);
  for (const [index, top] of [[0, 0], [19, f.pane.scrollHeight - f.pane.clientHeight]]) {
    f.scroll(top);
    const rect = f.pane.rows[index].getBoundingClientRect();
    assert.equal((rect.top + rect.bottom) / 2, 300); assert.deepEqual(f.picks(), [`r${index}`]);
  }
});

test("removal saves the original scroll position before shorter padding clamps it", () => {
  const f = fixture({ selected: "r0" }); f.center(18); f.key();
  f.pane.scrollTop = f.pane.scrollHeight - f.pane.clientHeight - 110;
  const positions = f.positions(), scroll = f.pane.scrollTop;
  f.run('select("r18")'); f.flush();
  assert.deepEqual(f.ends(), ["", ""]);
  assert.equal(f.pane.scrollTop, scroll + 10 - 124);
  // Selection has its existing 1px lift; all other tickets stay still.
  assert.deepEqual(f.positions().slice(1, 18), positions.slice(1, 18));
});

test("closing and section changes clear the space without changing the saved row positions", () => {
  const f = fixture(); f.center(5); f.key();
  const positions = f.positions();
  f.view("done"); assert.deepEqual(f.ends(), ["", ""]); assert.deepEqual(f.positions(), positions);
  f.view("todo"); assert.deepEqual(f.ends(), ["124px", "124px"]); assert.deepEqual(f.positions(), positions);
  f.tickets.classList.remove("open"); f.flush();
  assert.deepEqual(f.ends(), ["", ""]); assert.deepEqual(f.positions(), positions);
  f.open();
  assert.deepEqual(f.ends(), ["", ""]); assert.deepEqual(f.picks(), []);
  const rect = f.pane.rows[14].getBoundingClientRect();
  assert.ok(rect.top < 400 && rect.bottom > 100, "opening still reveals the selected ticket");
});

test("opening on the first ticket has only the normal top margin after keyboard use", () => {
  const f = fixture({ selected: "r0" }); f.center(15); f.key();
  f.tickets.classList.remove("open"); f.flush(); f.open();
  assert.deepEqual(f.ends(), ["", ""]); assert.deepEqual(f.picks(), []);
  assert.ok(f.pane.rows[0].getBoundingClientRect().top <= 110);
});

test("ending a pick at either scroll limit removes the blank band and clamps to normal bounds", () => {
  for (const index of [0, 19]) {
    const f = fixture(); f.key(); f.center(index);
    assert.deepEqual(f.picks(), [`r${index}`]);
    f.run(`select("r${index}")`); f.flush();
    assert.deepEqual(f.ends(), ["", ""]); assert.deepEqual(f.picks(), []);
    assert.equal(f.pane.scrollTop, index === 0 ? 0 : f.pane.scrollHeight - f.pane.clientHeight);
  }
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

test("resize and row changes recalculate active ends, while empty and single-row lists have no pick space", () => {
  const f = fixture(); f.key(); f.resize(400);
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "174px");
  f.pane.rows[0].offsetHeight = 60; f.pane.rows[19].offsetHeight = 80; f.changedRows();
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "170px");
  assert.equal(f.pane.style.getPropertyValue("--pick-foot"), "160px");
  f.pane.rows = []; f.changedRows(); assert.deepEqual(f.picks(), []);
  assert.equal(f.pane.style.getPropertyValue("--pick-head"), "");
  assert.equal(f.pane.style.getPropertyValue("--pick-foot"), "");
  const one = fixture({ count: 1, selected: "r0" }); one.key();
  assert.equal(one.pane.scrollHeight, 79); assert.deepEqual(one.picks(), []);
  one.resize(30); assert.deepEqual(one.ends(), ["", ""]);
});

test("selection, removed rows, sections, Home and closing clear or replace the pick", () => {
  const f = fixture(); f.key(); f.center(5);
  const removed = f.pane.rows.splice(5, 1)[0]; f.changedRows();
  assert.equal(removed.classList.contains("drawer-pick"), false); assert.deepEqual(f.picks(), ["r6"]);
  f.run('select("r6")'); f.flush(); assert.deepEqual(f.picks(), []);
  f.run('select("r14")'); f.flush(); assert.deepEqual(f.picks(), ["r6"]);
  f.view("done"); assert.deepEqual(f.picks(), []);
  f.view("todo"); assert.deepEqual(f.picks(), ["r6"]);
  f.context.homeOpen = true; f.tickets.classList.remove("open"); f.flush();
  assert.deepEqual(f.picks(), []); assert.deepEqual(f.ends(), ["", ""]);
  f.context.homeOpen = false; f.tickets.classList.add("open"); f.flush(); assert.deepEqual(f.picks(), ["r6"]);
  f.tickets.classList.remove("open"); f.flush(); assert.deepEqual(f.picks(), []);
});

test("arrows still start at the open ticket, even with another ticket outlined", () => {
  const f = fixture(); f.key(); f.center(5); f.key("ArrowUp");
  assert.equal(f.context.selectedId, "r13"); assert.deepEqual(f.picks(), []);
});

const tokens = readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8");
const mac = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const compact = value => value.replace(/\s+/g, " ").trim();
function cssRule(source, selector) {
  const start = source.indexOf(selector + "{");
  assert.ok(start >= 0, `missing CSS rule ${selector}`);
  return source.slice(start + selector.length + 1, source.indexOf("}", start));
}
function cssValue(block, property) {
  const value = block.match(new RegExp(`(?:^|;)\\s*${property}:([^;]+)`))?.[1];
  assert.ok(value, `missing CSS property ${property}`);
  return compact(value);
}
const shared = cssRule(tokens, ".qn-glass, #tickets .trow.drawer-pick");
const glass = cssRule(tokens, ".qn-glass");
const pick = () => cssRule(html, "#tickets .trow.drawer-pick > .trowin::after");
const resolve = value => value.replace(/var\((--qn-[\w-]+)\)/g, (_, name) => resolve(cssValue(shared, name)));

test("the pick shares the Mac lens's filled face and complete surface lighting", () => {
  assert.match(mac, /h\("span", "projectlens qn-glass " \+ cls\)/);
  for (const property of ["background-color", "background-image"]) {
    assert.equal(cssValue(pick(), property), cssValue(glass, property), `${property} must use the same token`);
    assert.equal(resolve(cssValue(pick(), property)), resolve(cssValue(glass, property)));
  }
  assert.equal(resolve(cssValue(pick(), "background-color")), "rgba(255,255,255,.77)");
  const lighting = resolve(cssValue(pick(), "background-image"));
  assert.match(lighting, /feTurbulence/);
  assert.equal((lighting.match(/radial-gradient/g) || []).length, 4);
  assert.match(lighting, /linear-gradient\(145deg/);
  assert.doesNotMatch(shared + pick(), /--accent|#432bff/i);
});

test("the pick's edge, inner glow and outer shadows equal the Mac lens's seven layers", () => {
  const macShadow = cssValue(cssRule(mac, "body.focus :is(.bar .qn-glass, #appframe)"), "box-shadow");
  assert.equal(resolve(cssValue(pick(), "box-shadow")), resolve(macShadow));
  assert.equal(cssValue(shared, "--qn-ring"), "#c7c7cc");
  assert.equal(cssValue(shared, "--qn-edge"), "2");
  assert.match(pick(), /var\(--qn-depth-shadow\)/, "the cast shadow was reduced to a rim again");
  assert.match(cssRule(html, "#tickets .trow.drawer-pick"), /overflow:visible/, "row clipping would hide the cast shadow");
});

test("the glass covers the ticket border box and scrolls with its original sharp text", () => {
  assert.match(pick(), /position:absolute; inset:calc\(-1 \* var\(--edge-drawn\)\); border-radius:inherit/);
  assert.match(pick(), /pointer-events:none; z-index:0/);
  assert.match(cssRule(html, "#tickets .trow.drawer-pick"), /z-index:0/);
  assert.match(cssRule(html, "#tickets .trow.drawer-pick > .trowin"), /border-radius:inherit/);
  const text = cssRule(html, "#tickets .trow.drawer-pick > .trowin > *");
  assert.match(text, /position:relative; z-index:1/, "native title, metadata and artwork must paint above the face");
  const styling = between("  /* The Mac lens's face", "  .trow.seen .ttl").replace(/\/\*[^]*?\*\//g, "");
  assert.doesNotMatch(styling, /(?:backdrop-)?filter:|transition:|transform:|opacity:|--accent/,
    "no blur, displacement, fade or delayed motion may affect the ticket text");
  assert.match(cssRule(html, "#tickets .trow.drawer-pick > .omni-sweep"), /border-radius:inherit; overflow:hidden/);
  assert.match(html, /padding:var\(--pick-head,/); assert.match(html, /var\(--pick-foot,/);
});
