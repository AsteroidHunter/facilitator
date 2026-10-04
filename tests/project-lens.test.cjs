// Run the real desktop lens and drag handlers with synthetic geometry/clock.
// These verify behavior and sampling math, not browser rendering or smoothness.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));

function fixture({ home = false, closed = [], widths = [100, 140, 80] } = {}) {
  const handlers = {}, tasks = new Map(), frames = new Map(), images = [], switches = [], writes = [], opens = [];
  let id = 0, now = 0, context;
  class Element {
    constructor(cls = "", owner = null) {
      this.classes = new Set(cls.split(" ").filter(Boolean));
      this.dataset = owner ? { owner } : {};
      this.style = { setProperty(k, v) { this[k] = v; } };
      this.children = []; this.attributes = {}; this.listeners = {}; this.isConnected = true;
      this.classList = {
        contains: name => this.classes.has(name),
        add: (...names) => names.forEach(n => this.classes.add(n)),
        remove: (...names) => names.forEach(n => this.classes.delete(n)),
        toggle: (name, on) => (on ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name),
      };
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    appendChild(el) { if (el.parentNode) el.remove(); this.children.push(el); el.parentNode = this; el.isConnected = true; return el; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; this.isConnected = false; }
    set innerHTML(value) {
      if (value.includes("feImage")) { this.appendChild(new Element()); this.appendChild(new Element()); }
    }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    querySelectorAll(selector) {
      return this.children.filter(el => el.classList.contains("ptab") &&
        (!selector.includes(":not(.draft)") || !el.classList.contains("draft")));
    }
    querySelector(selector) {
      if (selector === ".ptab.on, .ptab.draft") return this.children.find(el => el.classes.has("on") || el.classes.has("draft"));
      return null;
    }
    closest() { return this; }
    matches(selector) { return selector === ":hover" && this.hovered; }
    getBoundingClientRect() {
      if (this === oval || this === bar) return { left: 40, top: 6, width: 320, height: 32, right: 360, bottom: 38 };
      if (this.classes.has("ptab")) {
        const order = context.lastState.order;
        const before = order.slice(0, order.indexOf(this.dataset.owner)).map(ow => tabs[ow]);
        const widthOf = el => el.classes.has("closed") ? 0 : el.baseWidth + (el.classes.has("armed") ? 12 : 0);
        const left = 40 + before.reduce((sum, el) => sum + widthOf(el), 0);
        return { left, top: 6, width: widthOf(this), height: 32, right: left + widthOf(this), bottom: 38 };
      }
      const left = 40 + Number((this.style.transform || "").match(/translateX\(([-.\d]+)/)?.[1] || 0);
      return { left, top: 6, width: parseFloat(this.style.width) || 0, height: 32, right: left + (parseFloat(this.style.width) || 0), bottom: 38 };
    }
  }
  const oval = new Element("taboval"), bar = new Element(), body = new Element();
  const tabs = Object.fromEntries(["a", "b", "c"].map((ow, i) => {
    const tab = new Element("ptab" + (closed.includes(ow) ? " closed" : ""), ow);
    tab.baseWidth = widths[i]; oval.appendChild(tab); return [ow, tab];
  }));
  const dispatch = (type, event = {}) => (handlers[type] || []).forEach(fn => fn(event));
  const document = {
    body, visibilityState: "visible", createElementNS: () => new Element(),
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = { getContext: () => ({
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: pixels => { canvas.pixels = pixels; },
      }), toDataURL() { images.push(canvas.pixels); return "data:image/png;base64," + images.length; } };
      return canvas;
    },
    getElementById: () => bar,
    querySelectorAll: selector => oval.querySelectorAll(selector),
    addEventListener: (type, fn) => (handlers[type] ||= []).push(fn),
  };
  context = vm.createContext({
    console, document, Uint8ClampedArray, tabDrag: null, tabGlide: null,
    activeOwner: "a", homeOpen: home, draft: null, selectedId: null, browsing: false,
    validActiveOwnerIds: new Set(["a", "b", "c"]), DRAFT: "__new__", LOCKED: false,
    lastState: { order: ["a", "b", "c"], closed: [...closed] },
    h: (tag, cls) => new Element(cls), ResizeObserver: class { observe() {} unobserve() {} },
    getComputedStyle: () => ({ columnGap: "0" }),
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; },
    setTimeout(fn, ms) { tasks.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: key => tasks.delete(key),
    addEventListener: document.addEventListener,
    location: { pathname: "/" }, open: (...args) => opens.push(args),
    tabClosed: ow => context.lastState.closed.includes(ow),
    tabRecord: st => st, allRowsOf: st => st.order, rowsOf: st => st.order.filter(ow => !st.closed.includes(ow)),
    writeTabs(record) { writes.push(JSON.parse(JSON.stringify(record))); Object.assign(context.lastState, record); },
    setTab(ow) { switches.push(ow); context.activeOwner = ow; context.homeOpen = false; context.draft = null; context.renderTabs(); },
    unselectShown() { context.unselected = true; },
    renderTabs() {
      if (["select", "reorder"].includes(context.tabDrag?.mode) || context.tabGlide) return;
      for (const tab of Object.values(tabs)) {
        tab.classList.toggle("on", !context.homeOpen && tab.dataset.owner === context.activeOwner);
        tab.classList.toggle("closed", context.lastState.closed.includes(tab.dataset.owner));
      }
    },
  });
  vm.runInContext(between("function lensOffset(", "// the bar is painted in the middle"), context);
  const seat = vm.runInContext("tabSeat", context);
  oval.appendChild(seat.el);
  vm.runInContext(between("function tabKillMark(", "// the plus tab: a fresh tab"), context);
  const clickSource = between('      t.addEventListener("click", () => {', "\n      oval.appendChild(t);");
  const downSource = between('        t.addEventListener("mousedown", e => {', "\n      // a press on the open").replace(/\n      }\s*$/, "");
  for (const [ow, tab] of Object.entries(tabs)) {
    vm.runInContext("(function(t, ow){" + clickSource + downSource + "})", context)(tab, ow);
  }
  const flushFrames = () => { const fns = [...frames.values()]; frames.clear(); fns.forEach(fn => fn(now)); };
  context.renderTabs(); context.placeSeat(); flushFrames();
  function tick(ms) {
    now += ms;
    for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.fn(); }
    flushFrames();
  }
  function down(ow = "a", extra = {}) {
    const rect = tabs[ow].getBoundingClientRect(), e = { button: 0, clientX: rect.left + rect.width / 2, clientY: 22, ...extra };
    tabs[ow].listeners.mousedown.forEach(fn => fn(e)); return e;
  }
  function move(x, y = 22, buttons = 1) { dispatch("mousemove", { clientX: x, clientY: y, buttons }); }
  function up(x, y = 22, target = tabs.a) { dispatch("mouseup", { clientX: x, clientY: y, screenX: x, screenY: y, target }); }
  const click = ow => tabs[ow].listeners.click.forEach(fn => fn());
  return { context, seat, tabs, oval, document, images, switches, writes, opens, dispatch, down, move, up, click, tick,
    get: source => vm.runInContext(source, context),
  };
}

test("hidden cross drags only the lens, keeps all names and workspace still, selects once on release", () => {
  const f = fixture(); f.down(); f.move(180); f.move(300);
  assert.equal(f.context.tabDrag.mode, "select");
  assert.equal(f.context.activeOwner, "a"); assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
  assert.ok(Object.values(f.tabs).every(t => !t.style.transform));
  assert.notEqual(f.seat.el.style.transform, "translateX(0px)");
  f.up(300, 22, f.tabs.c); f.click("c");
  assert.deepEqual(f.switches, ["c"]); assert.deepEqual(f.writes, []);
  assert.equal(f.seat.owner, "c"); f.tick(0); assert.equal(f.context.tabDrag, null);
});

test("press before the hover timer fires stays a selection drag, even if held past the dwell", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(2400); f.down(); f.tick(500);
  assert.equal(f.tabs.a.classList.contains("armed"), false);
  f.tabs.a.classList.add("armed"); // even a late external change cannot change the captured intent
  f.move(180); assert.equal(f.context.tabDrag.mode, "select");
});

test("visible cross latches reorder even after the cross disappears, and writes order without selecting", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(2500);
  assert.equal(f.tabs.a.classList.contains("armed"), true);
  f.down(); f.context.disarmTab(); f.move(350); f.up(350); f.click("a");
  assert.deepEqual(f.writes[0].order, ["b", "c", "a"]); assert.deepEqual(f.switches, []);
  f.tick(250); assert.equal(f.context.tabDrag, null); assert.equal(f.context.tabGlide, null);
  assert.ok(Object.values(f.tabs).every(t => !t.style.transform));
});

test("a nonselected armed project has an independent held lens which is removed after reorder", () => {
  const f = fixture(); f.tabs.b.classList.add("armed"); f.down("b"); f.move(45);
  const held = f.context.tabDrag.held;
  assert.ok(held.lens.filter); assert.notEqual(held.lens.filter, f.seat.face.lens.filter);
  f.up(45); f.tick(250);
  assert.equal(held.isConnected, false); assert.equal(held.lens.filter.isConnected, false);
  assert.equal(f.context.activeOwner, "a"); assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
});

test("reorder keeps closed projects in the stored order and out of measured slots", () => {
  const f = fixture({ closed: ["b"] }); f.tabs.a.classList.add("armed"); f.down(); f.move(215); f.up(215);
  assert.deepEqual(f.writes[0], { order: ["b", "c", "a"], closed: ["b"] });
});

test("a drag that releases outside the names cancels and returns the lens", () => {
  const f = fixture(); f.down(); f.move(200); f.up(200, 80); f.click("a");
  assert.deepEqual(f.switches, []); assert.equal(f.seat.el.style.transform, "translateX(0px)");
});

test("Escape, blur, pointer cancel and hidden-page cancellation never select on later release/click", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture(); f.down(); f.move(300);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    let stopped = false;
    f.dispatch(type, { key: "Escape", preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    f.up(300); f.click("c");
    assert.deepEqual(f.switches, [], type); assert.equal(f.seat.el.style.transform, "translateX(0px)", type);
    if (type === "keydown") assert.equal(stopped, true);
  }
});

test("a release outside the window cancels selection on the next button-free move", () => {
  const f = fixture(); f.down(); f.move(300); f.move(300, 22, 0);
  assert.deepEqual(f.switches, []); assert.equal(f.context.tabDrag, null);
});

test("removed or remotely closed release targets are not selected", () => {
  for (const kind of ["removed", "closed"]) {
    const f = fixture(); f.down(); f.move(300);
    if (kind === "removed") f.context.validActiveOwnerIds.delete("c"); else f.context.lastState.closed.push("c");
    f.up(300); assert.deepEqual(f.switches, [], kind);
  }
});

test("small movement stays a normal click, and a new dwell starts after release", () => {
  const f = fixture(); const start = f.down("b"); f.tabs.b.hovered = true;
  f.move(start.clientX + 3); f.up(start.clientX + 3, 22, f.tabs.b); f.click("b"); f.tick(0); f.tick(2500);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.tabs.b.classList.contains("armed"), true);
});

test("a right-button press cannot start a drag", () => {
  const f = fixture(); f.down("a", { button: 2 }); assert.equal(f.context.tabDrag, null);
});

test("vertical tear-out still opens once, and a locked horizontal gesture cannot turn into tear-out", () => {
  const f = fixture(); f.down(); f.move(90, 70); f.up(90, 70); f.click("a");
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][0], "/?project=a"); assert.deepEqual(f.switches, []);
  const s = fixture(); s.down(); s.move(150); s.move(200, 90); s.up(200, 90);
  assert.deepEqual(s.opens, []); assert.deepEqual(s.switches, []);
});

test("selection can begin on home; cancelling restores no lens, releasing selects once", () => {
  const f = fixture({ home: true }); assert.equal(f.seat.el.classList.contains("gone"), true);
  f.down(); f.move(180); assert.equal(f.context.homeOpen, true); assert.equal(f.seat.el.classList.contains("gone"), false);
  f.up(180, 80); assert.equal(f.seat.el.classList.contains("gone"), true); assert.equal(f.seat.returning, false);
  f.tick(0); f.down(); f.move(180); f.up(180);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
});

test("a close button stops the tab gesture and closes only that project; the final tab stays", () => {
  const f = fixture(); const button = f.context.tabKillMark("b"); let stopped = 0;
  const e = { preventDefault() {}, stopPropagation() { stopped++; } };
  button.listeners.mousedown[0](e); button.listeners.pointerdown[0](e); button.listeners.click[0](e);
  assert.equal(stopped, 3); assert.equal(f.context.tabDrag, null); assert.deepEqual(f.writes[0].closed, ["b"]);
  f.context.closeTab("c"); f.context.closeTab("a"); assert.deepEqual([...f.context.lastState.closed], ["b", "c"]);
});

test("the lens follows a close before the selected name and keeps the label's full 32px height", () => {
  const f = fixture(); f.context.setTab("c"); f.context.placeSeat(); assert.equal(f.seat.x, 240);
  f.context.closeTab("b"); f.context.placeSeat(); assert.equal(f.seat.x, 100);
  assert.equal(f.seat.el.getBoundingClientRect().height, 32);
  f.context.placeSeat(); assert.equal(f.seat.el.classList.contains("still"), true);
});

test("center sampling enlarges by 1.075 and the rim adds inward curved displacement", () => {
  const f = fixture(), offset = f.context.lensOffset;
  const x = 75, dx = offset(x, 16, 100)[0];
  assert.ok(Math.abs((x + dx - 50) - (x - 50) / 1.075) < 1e-9);
  assert.deepEqual([...offset(50, 16, 100)], [0, 0]);
  assert.ok(offset(50, 3, 100)[1] > (16 - 3) * (1 - 1 / 1.075) + 2);
  assert.ok(offset(3, 16, 100)[0] > (50 - 3) * (1 - 1 / 1.075) + 2);
});

test("sampling remains inside the captured rectangle for short, long and fractional pills", () => {
  const f = fixture();
  for (const width of [28, 32, 79.5, 143, 480, 1200]) for (let y = .5; y < 32; y++) for (let x = .5; x < width; x += 1.5) {
    const [dx, dy] = f.context.lensOffset(x, y, width);
    assert.ok(x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < 32, `${width}: ${x},${y}`);
  }
});

test("encoded maps reconstruct the desired offsets within quantization error and cache repeated widths", () => {
  const f = fixture(), map = f.context.lensMap(143.2), pixels = f.images.at(-1);
  assert.equal(f.context.lensMap(143.1), map); assert.equal(f.images.length, 1);
  for (let y = 0; y < 32; y += 3) for (let x = 0; x < 143; x += 7) {
    const expected = f.context.lensOffset(x + .5, y + .5, 143), i = (y * 143 + x) * 4;
    for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(map.scale * (pixels.data[i + axis] / 255 - .5) - expected[axis]) <= map.scale / 510 + 1e-9);
    assert.equal(pixels.data[i + 3], 255);
  }
  for (let width = 200; width < 280; width++) f.context.lensMap(width);
  assert.equal(f.get("lensMaps.size"), 64);
});

test("lens resizing updates local map dimensions; translation alone needs no regenerated map", () => {
  const f = fixture(), el = f.seat.face;
  f.context.resizeLens(el, 100); const first = el.lens.map;
  f.down(); f.move(170); assert.equal(el.lens.map, first); assert.equal(f.images.length, 1);
  f.context.resizeLens(el, 140.25);
  assert.equal(el.lens.image.attributes.width, "140.25"); assert.notEqual(el.lens.map, first);
  assert.equal(el.attributes["aria-hidden"], "true");
});
