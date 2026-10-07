// Run the real desktop lens and drag handlers with synthetic geometry/clock.
// These verify behavior and sampling math, not browser rendering or smoothness.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));

test("shared glass tokens preserve the established Mac material and tuning", () => {
  const tokens = readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8");
  const block = (source, selector) => {
    const start = source.indexOf(selector + "{");
    assert.ok(start >= 0, selector);
    return source.slice(start + selector.length + 1, source.indexOf("}", start)).replace(/\/\*[^]*?\*\//g, "");
  };
  const value = (source, property) => {
    const match = source.match(new RegExp(`(?:^|;)\\s*${property}:([^;]+)`));
    assert.ok(match, property);
    return match[1].replace(/\s+/g, " ").trim();
  };
  const shared = block(tokens, ".qn-glass"), face = block(tokens.slice(tokens.indexOf(".qn-glass{") + 1), ".qn-glass");
  const player = block(html, "\n  #magic1.filled");
  const resolve = (text, overrides) => text.replace(/var\((--qn-[\w-]+)\)/g,
    (_, name) => resolve(overrides[name] ?? value(shared, name), overrides));
  // The original material is still written out on the player at edge strength
  // one. Compare every layer, in order, instead of trusting the new token names.
  for (const property of ["background-image", "box-shadow"]) {
    const actual = resolve(value(face, property), { "--qn-edge": "1" }).replace(/calc\(([\d.]+) \* 1\)/g, "$1");
    assert.equal(actual, value(player, property), property);
  }
  assert.equal(value(face, "border-radius"), value(player, "border-radius"));
  assert.equal(resolve(value(face, "background-color"), {}), "rgba(255,255,255,.77)");
  assert.equal(resolve(value(face, "background-color"), { "--qn-tint": ".95" }), "rgba(255,255,255,.95)");
  for (const edge of ["2", "3", "3.5"]) {
    const light = resolve(value(face, "background-image"), { "--qn-edge": edge });
    assert.ok(light.includes(`calc(.60 * ${edge})`), "press lighting must resolve locally");
  }
  for (const property of ["backdrop-filter", "-webkit-backdrop-filter"])
    assert.equal(resolve(value(face, property), {}), "blur(15px) saturate(180%)");
});

function fixture({ home = false, closed = [], widths = [100, 140, 80], render = false } = {}) {
  const handlers = {}, tasks = new Map(), frames = new Map(), images = [], switches = [], writes = [], opens = [], observers = [];
  let id = 0, now = 0, context;
  class Element {
    constructor(cls = "", owner = null) {
      this.tagName = "span"; this.classes = new Set(cls.split(" ").filter(Boolean));
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
    removeAttribute(k) { delete this.attributes[k]; }
    getAttributeNames() { return Object.keys(this.attributes); }
    cloneNode(deep) {
      const copy = new Element([...this.classes].join(" "));
      copy.tagName = this.tagName; copy.attributes = { ...this.attributes }; copy.textContent = this.textContent;
      if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
      return copy;
    }
    appendChild(el) { if (el.parentNode) el.remove(); this.children.push(el); el.parentNode = this; el.isConnected = true; return el; }
    remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; this.isConnected = false; }
    set innerHTML(value) {
      for (const m of value.matchAll(/<(feImage|feDisplacementMap)\b/g)) {
        const child = new Element(); child.tagName = m[1]; this.appendChild(child);
      }
    }
    get firstElementChild() { return this.children[0]; }
    get lastElementChild() { return this.children.at(-1); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { (this.listeners.click || []).forEach(fn => fn()); }
    querySelectorAll(selector) {
      if (selector === "*") return this.children.flatMap(el => [el, ...el.querySelectorAll("*")]);
      if (selector === "feImage") return this.children.filter(el => el.tagName === selector);
      if (selector.includes(".plabel")) return [...(selector.includes("#homeico svg") ? [house] : []), ...Object.values(tabs).filter(t => !t.classes.has("closed")).flatMap(t => t.children)];
      return this.children.filter(el => el.classList.contains("ptab") &&
        (!selector.includes(":not(.draft)") || !el.classList.contains("draft")));
    }
    querySelector(selector) {
      if (selector === "feDisplacementMap") return this.children.find(el => el.tagName === selector);
      if ([".plabel", ".ptabx"].includes(selector)) return this.children.find(el => el.classes.has(selector.slice(1)));
      if (selector === ".ptab.on, .ptab.draft") return Object.values(tabs).find(el => el.classes.has("on") || el.classes.has("draft"));
      return null;
    }
    closest(selector) {
      const name = selector.endsWith(".ptab") ? "ptab" : selector.slice(1);
      for (let el = this; el; el = el.parentNode) if (selector === "#homeico" ? el.attributes.id === name : el.classes.has(name)) return el;
      return null;
    }
    getAnimations() { return this.animations || []; }
    matches(selector) { return selector === ":hover" && this.hovered; }
    getBoundingClientRect() {
      if (this === row) return { left:0, top:6, width:360, height:32, right:360, bottom:38 };
      if (this === homeButton) return { left:0, top:6, width:32, height:32, right:32, bottom:38 };
      if (this === house) return { left:8.5, top:14.5, width:15, height:15, right:23.5, bottom:29.5 };
      if (this === oval || this === bar) return { left: 40, top: 6, width: 320, height: 32, right: 360, bottom: 38 };
      if (this.classes.has("plabel") || this.classes.has("ptabx")) {
        const r = this.parentNode.getBoundingClientRect(), cross = this.classes.has("ptabx");
        const width = cross ? 24 : this.parentNode.baseWidth - 28, left = cross ? r.right - 27 : r.left + 14;
        const top = r.top + (cross ? 4 : 8), height = cross ? 24 : 16;
        return { left, top, width, height, right: left + width, bottom: top + height };
      }
      if (this.classes.has("seatlens")) {
        const r = this.parentNode.getBoundingClientRect(), scale = this.pressScale || 1;
        const width = r.width * scale, height = 32 * scale, left = r.left + (r.width - width) / 2, top = r.top + (32 - height) / 2;
        return { left, top, width, height, right: left + width, bottom: top + height };
      }
      if (this.classes.has("ptab")) {
        const order = context.lastState.order;
        const before = order.slice(0, order.indexOf(this.dataset.owner)).map(ow => tabs[ow]);
        const widthOf = el => el.classes.has("closed") ? 0 : el.baseWidth + (el.classes.has("armed") ? 12 : 0);
        const move = (this.style.transform || "").match(/translate(?:X)?\(([-.\d]+)px(?:,\s*([-.\d]+)px)?/);
        const left = 40 + before.reduce((sum, el) => sum + widthOf(el), 0) + Number(move?.[1] || 0);
        const top = 6 + Number(move?.[2] || 0);
        return { left, top, width: widthOf(this), height: 32, right: left + widthOf(this), bottom: top + 32 };
      }
      const move = (this.style.transform || "").match(/translate(?:X)?\(([-.\d]+)px(?:,\s*([-.\d]+)px)?/);
      const independent = (this.style.translate || "").split(" ").map(v => parseFloat(v) || 0);
      const left = (this.parentNode?.getBoundingClientRect().left || 0) + (parseFloat(this.style.left) || 0) + Number(move?.[1] || 0) + (independent[0] || 0);
      const top = 6 + Number(move?.[2] || 0) + (independent[1] || 0);
      return { left, top, width: parseFloat(this.style.width) || 0, height: 32, right: left + (parseFloat(this.style.width) || 0), bottom: top + 32 };
    }
  }
  const oval = new Element("taboval"), bar = new Element(), row = new Element(), body = new Element();
  const homeButton = new Element(), house = new Element();
  homeButton.tagName = "button"; homeButton.setAttribute("id", "homeico");
  house.tagName = "svg"; house.setAttribute("width", "15"); house.setAttribute("height", "15"); house.setAttribute("viewBox", "0 0 24 24");
  for (const d of ["M3 10.5 12 3l9 7.5", "M5.5 9.5V21h13V9.5"]) { const path = new Element(); path.tagName = "path"; path.setAttribute("d", d); house.appendChild(path); }
  homeButton.appendChild(house); row.appendChild(homeButton); row.appendChild(bar); bar.appendChild(oval);
  const tabs = Object.fromEntries(["a", "b", "c"].map((ow, i) => {
    const tab = new Element("ptab" + (closed.includes(ow) ? " closed" : ""), ow);
    tab.baseWidth = widths[i];
    const label = new Element("plabel"); label.textContent = "Project " + ow; tab.appendChild(label);
    tab.appendChild(new Element("ptabx"));
    oval.appendChild(tab); return [ow, tab];
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
    getElementById: id => id === "tabrow" ? row : id === "homeico" ? homeButton : bar,
    querySelectorAll: selector => oval.querySelectorAll(selector),
    addEventListener: (type, fn) => (handlers[type] ||= []).push(fn),
  };
  context = vm.createContext({
    console, document, Uint8ClampedArray, devicePixelRatio: 1, tabDrag: null, tabGlide: null,
    activeOwner: "a", homeOpen: home, draft: null, selectedId: null, browsing: false,
    validActiveOwnerIds: new Set(["a", "b", "c"]), DRAFT: "__new__", LOCKED: false,
    lastState: { order: ["a", "b", "c"], closed: [...closed] },
    h: (tag, cls) => Object.assign(new Element(cls), { tagName: tag }), ResizeObserver: class { observe() {} unobserve() {} },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} },
    getComputedStyle(el) {
      const tab = el.closest(".ptab") || el.closest("#homeico"), cross = el.classes.has("ptabx"), armed = tab?.classes.has("armed");
      return { columnGap: "0", width: el.style.width || el.parentNode?.style.width || "0px",
        opacity: cross ? (armed ? (el.classes.has("off") ? ".3" : "1") : "0") : (el.classes.has("tearing") ? ".45" : "1"),
        visibility: cross && !armed ? "hidden" : "visible", color: tab?.classes.has("on") ? "rgb(30,30,30)" : "rgb(100,100,100)",
        fontFamily: "sans-serif", fontSize: "13px", lineHeight: "16px", fontWeight: tab?.classes.has("unread") ? "600" : "500",
        fontStyle: "normal", fontStretch: "100%", letterSpacing: "normal", fontFeatureSettings: "normal", fontVariationSettings: "normal",
        whiteSpace: "nowrap", textTransform: "none" };
    },
    requestAnimationFrame(fn) { frames.set(++id, fn); return id; }, cancelAnimationFrame: key => frames.delete(key),
    setTimeout(fn, ms) { tasks.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: key => tasks.delete(key),
    addEventListener: document.addEventListener,
    location: { pathname: "/" }, open: (...args) => opens.push(args),
    tabClosed: ow => context.lastState.closed.includes(ow),
    tabRecord: st => st, allRowsOf: st => st.order, rowsOf: st => st.order.filter(ow => !st.closed.includes(ow)),
    writeTabs(record) { writes.push(JSON.parse(JSON.stringify(record))); Object.assign(context.lastState, record); },
    setTab(ow) { switches.push(ow); context.activeOwner = ow; context.homeOpen = false; context.draft = null; context.renderTabs(); },
    setHome(value) { context.homeOpen = !!value; homeButton.setAttribute("aria-pressed", String(value)); context.renderTabs(); context.placeSeat(); },
    unselectShown() { context.unselected = true; },
    renderTabs() {
      if (["select", "reorder"].includes(context.tabDrag?.mode) || context.tabGlide) return;
      for (const tab of Object.values(tabs)) {
        tab.classList.toggle("on", !context.homeOpen && tab.dataset.owner === context.activeOwner);
        tab.classList.toggle("closed", context.lastState.closed.includes(tab.dataset.owner));
      }
    },
  });
  vm.runInContext(between("const LENS_ZOOM =", "// the bar is painted in the middle"), context);
  if (!render) vm.runInContext("queueLensPaint = () => {}", context);
  const seat = vm.runInContext("tabSeat", context);
  const homeClick = html.match(/document\.getElementById\("homeico"\)\.addEventListener\("click", \(\) => \{ if \(!homeOpen\) setHome\(true\); \}\);/);
  assert.ok(homeClick, "the existing synchronous Home click handler changed");
  vm.runInContext(homeClick[0], context);
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
  return { context, seat, tabs, oval, bar, row, homeButton, house, document, images, switches, writes, opens, observers, frames, dispatch, down, move, up, click, tick,
    get: source => vm.runInContext(source, context),
  };
}

test("hidden cross drags only the lens, keeps all names and workspace still, selects once on release", () => {
  const f = fixture(); f.down(); f.move(180); f.move(300);
  assert.equal(f.context.tabDrag.mode, "select");
  assert.equal(f.context.activeOwner, "a"); assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
  assert.ok(Object.values(f.tabs).every(t => !t.style.transform));
  assert.notEqual(f.seat.el.style.transform, "translateX(40px)");
  f.up(300, 22, f.tabs.c); f.click("c");
  assert.deepEqual(f.switches, ["c"]); assert.deepEqual(f.writes, []);
  assert.equal(f.seat.owner, "c"); f.tick(0); assert.equal(f.context.tabDrag, null);
});

test("press before the hover timer fires stays a selection drag, even if held past the dwell", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(1600); f.down(); f.tick(500);
  assert.equal(f.tabs.a.classList.contains("armed"), false);
  f.tabs.a.classList.add("armed"); // even a late external change cannot change the captured intent
  f.move(180); assert.equal(f.context.tabDrag.mode, "select");
});

test("visible cross latches reorder even after the cross disappears, and writes order without selecting", () => {
  const f = fixture(); f.context.tabDwell(f.tabs.a); f.tick(1700);
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
  assert.deepEqual(f.switches, []); assert.equal(f.seat.el.style.transform, "translateX(40px)");
});

test("Escape, blur, pointer cancel and hidden-page cancellation never select on later release/click", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture(); f.down(); f.move(300);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    let stopped = false;
    f.dispatch(type, { key: "Escape", preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    f.up(300); f.click("c");
    assert.deepEqual(f.switches, [], type); assert.equal(f.seat.el.style.transform, "translateX(40px)", type);
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
  f.move(start.clientX + 3); f.up(start.clientX + 3, 22, f.tabs.b); f.click("b"); f.tick(0); f.tick(1700);
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

test("selection can begin on home; cancelling returns to its circle, releasing selects once", () => {
  const f = fixture({ home: true }); assert.equal(f.seat.el.classList.contains("gone"), false); assert.equal(f.seat.w, 32);
  f.down(); f.move(180); assert.equal(f.context.homeOpen, true); assert.equal(f.seat.el.classList.contains("gone"), false);
  f.up(180, 80); assert.equal(f.seat.el.classList.contains("gone"), false); assert.equal(f.seat.returning, false); assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  f.tick(0); f.down(); f.move(180); f.up(180);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
});

test("the lens dragged onto the house previews Home's circle and opens Home on release", () => {
  const f = fixture(); f.down(); f.move(180);
  assert.equal(f.seat.el.style.width, "100px");
  f.move(16);
  assert.equal(f.seat.el.style.width, "32px"); assert.equal(f.seat.el.style.transform, "translateX(0px)");
  assert.equal(f.context.homeOpen, false, "Home opened before the release");
  assert.deepEqual(f.switches, []); assert.deepEqual(f.writes, []);
  f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.equal(f.seat.owner, f.get("HOME_SEAT"));
  assert.equal(f.seat.w, 32); assert.equal(f.seat.x, 0);
  assert.deepEqual(f.switches, []); assert.equal(f.context.activeOwner, "a");
  f.tick(0); assert.equal(f.context.tabDrag, null);
});

test("moving off the house shows the name lens again, and a release on a name selects it", () => {
  const f = fixture(); f.down(); f.move(16);
  assert.equal(f.seat.el.style.width, "32px");
  f.move(200);
  assert.equal(f.seat.el.style.width, "100px"); assert.equal(f.seat.el.style.transform, "translateX(150px)");
  f.move(36);   // the gap between the house and the first name is neither
  assert.equal(f.seat.el.style.width, "100px"); assert.equal(f.seat.el.style.transform, "translateX(40px)");
  f.move(16); f.move(200); f.up(200, 22, f.tabs.b);
  assert.equal(f.context.homeOpen, false); assert.deepEqual(f.switches, ["b"]);
});

test("cancelling a drag that is over the house restores the name lens and opens nothing", () => {
  for (const type of ["keydown", "blur", "pointercancel", "visibilitychange"]) {
    const f = fixture(); f.down(); f.move(16);
    if (type === "visibilitychange") f.document.visibilityState = "hidden";
    f.dispatch(type, { key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(f.seat.el.style.width, "100px", type); assert.equal(f.seat.el.style.transform, "translateX(40px)", type);
    f.up(16, 22, f.homeButton);
    assert.equal(f.context.homeOpen, false, type); assert.deepEqual(f.switches, [], type);
  }
  const out = fixture(); out.down(); out.move(16); out.up(16, 80, out.homeButton);   // released below the row
  assert.equal(out.context.homeOpen, false); assert.equal(out.seat.el.style.transform, "translateX(40px)");
  const gone = fixture(); gone.down(); gone.move(16); gone.move(16, 22, 0);   // released outside the window
  assert.equal(gone.context.homeOpen, false); assert.equal(gone.seat.el.style.transform, "translateX(40px)");
});

test("a drag from Home can be carried back onto the house, which stays open, or onto a name", () => {
  const f = fixture({ home: true }); f.down("b"); f.move(200); f.move(16);
  assert.equal(f.seat.el.style.width, "32px"); f.up(16, 22, f.homeButton);
  assert.equal(f.context.homeOpen, true); assert.deepEqual(f.switches, []); assert.equal(f.seat.x, 0);
  f.tick(0); f.down("b"); f.move(16); f.move(200); f.up(200, 22, f.tabs.b);
  assert.deepEqual(f.switches, ["b"]); assert.equal(f.context.homeOpen, false);
});

test("a reorder drag never lands on the house and only reorders the projects", () => {
  const f = fixture(); f.tabs.b.classList.add("armed"); f.down("b"); f.move(10); f.move(16);
  assert.equal(f.context.tabDrag.mode, "reorder"); assert.equal(f.seat.el.style.width, "100px");
  f.up(16, 22, f.homeButton); f.tick(250);
  assert.equal(f.context.homeOpen, false); assert.deepEqual(f.switches, []);
  assert.deepEqual(f.writes[0].order, ["b", "a", "c"]);
});

test("a close button stops the tab gesture and closes only that project; the final tab stays", () => {
  const f = fixture(); const button = f.context.tabKillMark("b"); let stopped = 0;
  const e = { preventDefault() {}, stopPropagation() { stopped++; } };
  button.listeners.mousedown[0](e); button.listeners.pointerdown[0](e); button.listeners.click[0](e);
  assert.equal(stopped, 3); assert.equal(f.context.tabDrag, null); assert.deepEqual(f.writes[0].closed, ["b"]);
  f.context.closeTab("c"); f.context.closeTab("a"); assert.deepEqual([...f.context.lastState.closed], ["b", "c"]);
});

test("the lens follows a close before the selected name and keeps the label's full 32px height", () => {
  const f = fixture(); f.context.setTab("c"); f.context.placeSeat(); assert.equal(f.seat.x, 280);
  f.context.closeTab("b"); f.context.placeSeat(); assert.equal(f.seat.x, 140);
  assert.equal(f.seat.el.getBoundingClientRect().height, 32);
  f.context.placeSeat(); assert.equal(f.seat.el.classList.contains("still"), true);
});

test("center sampling enlarges by 1.075 and the rim adds inward curved displacement", () => {
  const f = fixture(), offset = f.context.lensOffset;
  const x = 75, dx = offset(x, 16, 100)[0];
  assert.ok(Math.abs((x + dx - 50) - (x - 50) / 1.075) < 1e-9);
  assert.deepEqual([...offset(50, 16, 100)], [0, 0]);
  assert.ok(offset(50, 1.25, 100)[1] > (16 - 1.25) * (1 - 1 / 1.075) + .46);
  assert.ok(offset(1.25, 16, 100)[0] > (50 - 1.25) * (1 - 1 / 1.075) + .46);
});

test("sampling remains inside the captured rectangle for short, long and fractional pills", () => {
  const f = fixture();
  for (const width of [28, 32, 79.5, 143, 480, 1200]) for (let y = .5; y < 32; y++) for (let x = .5; x < width; x += 1.5) {
    const [dx, dy] = f.context.lensOffset(x, y, width);
    assert.ok(x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < 32, `${width}: ${x},${y}`);
  }
});

test("encoded zoom and rim maps have exact neutral centers and bounded quantization error", () => {
  const f = fixture(), map = f.context.lensMap(143), [zoom, rim] = f.images;
  assert.equal(f.context.lensMap(143), map); assert.equal(f.images.length, 2);
  const k = 1 - 1 / 1.075, decode = byte => (byte - 128) / 254;
  for (let y = 0; y < 32; y += 3) for (let x = 0; x < 143; x += 7) {
    const expected = f.context.lensOffset(x + .5, y + .5, 143), i = (y * 143 + x) * 4;
    for (let axis = 0; axis < 2; axis++) {
      const actual = map.span * k * decode(zoom.data[i + axis]) + 2 / 1.075 * decode(rim.data[i + axis]);
      assert.ok(Math.abs(actual - expected[axis]) <= (map.span * k + 2 / 1.075) / 508 + 1e-9);
    }
    assert.equal(rim.data[i + 3], 255);
    if (f.context.lensDepth(x + .5, y + .5, 143) >= 2.5) {
      assert.equal(rim.data[i], 128); assert.equal(rim.data[i + 1], 128);
    }
  }
  for (let width = 200; width < 280; width++) f.context.lensMap(width);
  assert.equal(f.get("lensMaps.size"), 64);
});

test("lens resizing updates local map dimensions; translation alone needs no regenerated map", () => {
  const f = fixture(), el = f.seat.face;
  f.context.resizeLens(el, 100); const first = el.lens.map;
  f.down(); f.move(170); assert.equal(el.lens.map, first); assert.equal(f.images.length, 2);
  f.context.resizeLens(el, 140.25);
  assert.equal(el.lens.images[0].attributes.width, "140.25"); assert.notEqual(el.lens.map, first);
  assert.equal(el.attributes["aria-hidden"], "true");
});

test("the native rim mapping is monotonic through the old fold and smooth at both ends", () => {
  const f = fixture(), sample = (y, zoom) => y + f.context.lensOffset(50, y, 100, 32, zoom)[1];
  for (const zoom of [1.075, 1.075 * 1.04, 1.075 * 1.1]) {
    let previous = sample(0, zoom);
    for (let y = .01; y < 16; y += .01) {
      const next = sample(y, zoom); assert.ok(next > previous, `fold at ${y}, zoom ${zoom}`); previous = next;
    }
    const e = 1e-5, slope = y => (sample(y + e, zoom) - sample(y - e, zoom)) / (2 * e);
    for (const join of [0, 2.5, 3.5, 6]) assert.ok(Math.abs(slope(join) - 1 / zoom) < .0001, `kink at ${join}`);
  }
});

test("the inner mask completely replaces original ink and feathers only after the nonlinear rim ends", () => {
  const f = fixture(), alpha = f.context.lensCenterAlpha;
  assert.equal(alpha(-1), 0); assert.equal(alpha(2.5), 0); assert.equal(alpha(3.5), 1); assert.equal(alpha(16), 1);
  assert.ok(alpha(3) > 0 && alpha(3) < 1);
  const e = 1e-6;
  for (const join of [2.5, 3.5]) assert.ok(Math.abs((alpha(join + e) - alpha(join - e)) / (2 * e)) < .00001);
  f.context.devicePixelRatio = 2; f.context.lensMap(87.375);
  const map = f.images[0]; assert.equal(map.width, 175); assert.equal(map.height, 64);
  for (const width of [28, 32, 87.375, 480]) {
    const css = f.context.lensCenterMask(width);
    assert.doesNotMatch(css, /url\(/, "an undecoded mask image could expose the broken center for a frame");
    assert.equal((css.match(/gradient\(/g) || []).length, 3);
    const first = css.slice(0, css.indexOf(" left top/"));
    const stops = [...first.matchAll(/rgba\(0,0,0,([\d.]+)\) ([\d.]+)px/g)].map(m => [Number(m[2]), Number(m[1])]);
    const at = distance => {
      if (distance <= stops[0][0]) return stops[0][1];
      for (let i = 1; i < stops.length; i++) if (distance <= stops[i][0]) {
        const [a, va] = stops[i - 1], [b, vb] = stops[i]; return va + (vb - va) * (distance - a) / (b - a);
      }
      return stops.at(-1)[1];
    };
    const r = Math.min(width, 32) / 2, horizontal = width >= 32;
    for (let y = .125; y < 32; y += .5) for (let x = .125; x < width; x += .5) {
      const long = horizontal ? x : y, across = horizontal ? y : x, length = horizontal ? width : 32;
      const a = long <= 2 * r ? at(Math.hypot(long - r, across - r)) : 0;
      const b = long >= length - 2 * r ? at(Math.hypot(long - (length - r), across - r)) : 0;
      const c = long >= r && long <= length - r ? at(Math.abs(across - r)) : 0;
      const coverage = 1 - (1 - a) * (1 - b) * (1 - c), depth = f.context.lensDepth(x, y, width);
      if (depth >= 3.5) assert.equal(coverage, 1, "original center pixels can leak through");
      if (depth <= 2.5) assert.equal(coverage, 0, "the clear copy conceals the actual optical rim");
    }
  }
});

function assertCopyPosition(f, source, face = f.seat.face) {
  const copy = face.lens.copies.get(source); assert.ok(copy, "source has no visual copy");
  const numbers = copy.style.transform.match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number);
  const [x, y, scaleX, scaleY] = numbers;
  const r = face.getBoundingClientRect(), s = source.getBoundingClientRect();
  const width = parseFloat(face.style.width || face.parentNode.style.width), px = r.width / width, py = r.height / 32;
  const zoom = 1.075 * py, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  assert.ok(Math.abs((r.left + x * px) - (cx + (s.left - cx) * zoom)) < 1e-8, "horizontal copy drift");
  assert.ok(Math.abs((r.top + y * py) - (cy + (s.top - cy) * zoom)) < 1e-8, "vertical copy drift");
  assert.ok(Math.abs(scaleX * px - zoom) < 1e-8); assert.ok(Math.abs(scaleY * py - zoom) < 1e-8);
  return copy;
}

test("the center uses plain inert text, with the existing glass classes and no copied controls or IDs", () => {
  const f = fixture({ render: true }), face = f.seat.face, clear = face.lens.clear;
  assert.equal(face.classList.contains("qn-glass"), true, "the shared glass material was replaced");
  assert.equal(clear.classList.contains("qn-glass"), true);
  assert.equal(clear.inert, true); assert.equal(clear.attributes["aria-hidden"], "true");
  assert.equal(face.lens.copies.size, 4);
  for (const source of Object.values(f.tabs).map(t => t.querySelector(".plabel"))) {
    const copy = assertCopyPosition(f, source);
    assert.equal(copy.tagName, "span"); assert.equal(copy.textContent, source.textContent);
    assert.deepEqual(copy.listeners, {}); assert.equal(copy.attributes.id, undefined); assert.equal(copy.dataset.owner, undefined);
    assert.equal(copy.style.filter, undefined);
  }
  const css = between("  body.focus #tabrow .projectlens{", "  /* The outer seat moves");
  const surface = css.slice(0, css.indexOf("}"));
  assert.doesNotMatch(surface, /background:|box-shadow:/, "a bespoke material overrides the shared control recipe");
  assert.match(css, /background-image:inherit; box-shadow:inherit/);
  assert.match(css, /background-color:color-mix\(in srgb, var\(--paper\), #fff calc\(var\(--qn-tint\) \* 100%\)\)/);
  assert.match(css, /backdrop-filter:none/);
});

test("copy geometry tracks fractional slide/width and press states, with no new PNGs for pressing", () => {
  const f = fixture({ render: true }), label = f.tabs.b.querySelector(".plabel");
  for (const width of [100, 112.375, 139.75]) {
    f.seat.el.style.width = width + "px"; f.seat.el.style.transform = "translateX(47.625px)";
    f.context.paintLenses(); const images = f.images.length;
    for (const press of [1, 1.025, 1.075, 1.1, 1.03, 1]) {
      f.seat.face.pressScale = press; f.context.paintLenses(); assertCopyPosition(f, label);
      assert.equal(f.images.length, images, "press regenerated a geometry map");
      const expected = Math.max(width, 32) * (1 - 1 / (1.075 * press));
      assert.ok(Math.abs(Number(f.seat.face.lens.zoom.attributes.scale) - expected) < 1e-9);
    }
  }
});

test("renames, unread weights, closed/draft names and close-band opacity synchronize without stale copies", () => {
  const f = fixture({ render: true }), label = f.tabs.a.querySelector(".plabel"), face = f.seat.face;
  const before = face.lens.copies.get(label);
  label.textContent = "A renamed project"; f.tabs.a.classList.add("unread", "armed"); f.context.paintLenses();
  assert.equal(face.lens.copies.get(label), before); assert.equal(before.textContent, "A renamed project");
  assert.equal(before.style.fontWeight, "600");
  const cross = f.tabs.a.querySelector(".ptabx"); assertCopyPosition(f, cross);
  assert.equal(face.lens.copies.get(cross).classList.contains("lenscross"), true);
  cross.classes.add("off"); f.context.paintLenses(); assert.equal(face.lens.copies.get(cross).style.opacity, "0.3");
  f.tabs.a.classes.delete("armed"); f.context.paintLenses(); assert.equal(face.lens.copies.has(cross), false);
  f.tabs.b.classes.add("closed"); f.tabs.c.classes.add("draft"); f.tabs.c.querySelector(".plabel").textContent = "New Project";
  f.context.paintLenses(); assert.equal(face.lens.copies.has(f.tabs.b.querySelector(".plabel")), false);
  assert.equal(face.lens.copies.get(f.tabs.c.querySelector(".plabel")).textContent, "New Project");
});

test("both the selected and temporary lens follow translated/reordered label positions", () => {
  const f = fixture({ render: true }); f.tabs.b.classes.add("armed"); f.down("b"); f.move(45);
  const held = f.context.tabDrag.held; f.context.paintLenses();
  for (const source of Object.values(f.tabs).map(t => t.querySelector(".plabel"))) {
    assertCopyPosition(f, source); assertCopyPosition(f, source, held);
  }
  f.up(45); f.tick(250); f.context.paintLenses();
  assert.equal(f.get("liveLenses.size"), 1); assert.equal(held.isConnected, false);
});

test("rendering work stops at rest, ignores its own copy mutations and follows active CSS motion", () => {
  const f = fixture({ render: true }); assert.equal(f.frames.size, 0);
  const copy = [...f.seat.face.lens.copies.values()][0];
  f.observers[0].fn([{ target: copy }]); assert.equal(f.frames.size, 0, "copy mutations caused an endless paint loop");
  f.observers[0].fn([{ target: f.tabs.a.querySelector(".plabel") }]); assert.equal(f.frames.size, 1);
  f.row.animations = [{ playState: "running" }]; f.tick(16); assert.equal(f.frames.size, 1);
  f.row.animations = []; f.tick(16); assert.equal(f.frames.size, 0);
  f.row.listeners.pointerover[0](); assert.equal(f.frames.size, 1); f.tick(16); assert.equal(f.frames.size, 0);
  f.document.visibilityState = "hidden"; f.context.queueLensPaint(); f.tick(16); assert.equal(f.frames.size, 0);
});

test("Home and projects use the same lens, with a 32px circle at Home and a capsule on return", () => {
  const f = fixture({ render:true }), element = f.seat.el, face = f.seat.face;
  assert.equal(element.parentNode, f.row); assert.equal(f.seat.x, 40);
  f.homeButton.listeners.click[0](); f.context.paintLenses();
  assert.equal(f.context.homeOpen, true); assert.equal(f.seat.owner, f.get("HOME_SEAT"));
  assert.equal(f.seat.x, 0); assert.equal(f.seat.w, 32);
  assert.equal(face.getBoundingClientRect().width, 32); assert.equal(face.getBoundingClientRect().height, 32);
  assert.equal(f.seat.el.classList.contains("still"), false, "Home did not get the established slide");
  assert.equal(f.seat.el.classList.contains("gone"), false);
  f.context.placeSeat(); assert.equal(f.seat.el, element); assert.equal(f.seat.face, face);
  f.click("b"); f.context.placeSeat(); f.context.paintLenses();
  assert.equal(f.context.homeOpen, false); assert.equal(f.seat.owner, "b");
  assert.equal(f.seat.w, 140); assert.equal(f.seat.x, 140);
  assert.equal(f.seat.el, element); assert.equal(f.seat.face, face); assert.equal(f.get("liveLenses.size"), 1);
  assertCopyPosition(f, f.house);
  assert.equal(f.homeButton.listeners.mousedown, undefined, "Home gained a project drag/reorder gesture");
});

test("the Home center mirrors its existing SVG as an inert vector without IDs or handlers", () => {
  const f = fixture({ home:true, render:true }), source = f.house;
  const copy = assertCopyPosition(f, source), icon = copy.firstElementChild;
  assert.equal(icon.tagName, "svg"); assert.notEqual(icon, source);
  assert.equal(icon.attributes.width, "15"); assert.equal(icon.attributes.height, "15");
  assert.equal(icon.attributes.viewBox, source.attributes.viewBox);
  assert.deepEqual(icon.children.map(p => p.attributes.d), source.children.map(p => p.attributes.d));
  assert.equal(icon.attributes["aria-hidden"], "true"); assert.equal(icon.attributes.focusable, "false");
  assert.deepEqual(icon.listeners, {}); assert.equal(f.seat.face.lens.clear.inert, true);
  source.setAttribute("id", "source-only"); source.setAttribute("onclick", "source handler");
  source.children[0].setAttribute("id", "source-path"); source.children[0].setAttribute("tabindex", "0");
  const clean = f.context.lensIconCopy(source);
  for (const node of [clean, ...clean.querySelectorAll("*")]) {
    assert.equal(node.attributes.id, undefined); assert.equal(node.attributes.tabindex, undefined); assert.equal(node.attributes.onclick, undefined);
  }
  assert.equal(source.attributes.id, "source-only", "copy sanitizing changed the real artwork");
  for (const scale of [1, 1.04, 1.1]) { f.seat.face.pressScale = scale; f.context.paintLenses(); assertCopyPosition(f, source); }
});

test("Home is bare, keeps its original artwork/accessibility, and Plus is also bare", () => {
  const house = html.match(/<button id="homeico"[^>]*>(<svg[\s\S]*?<\/svg>)<\/button>/);
  assert.ok(house); assert.doesNotMatch(house[0], /class="qn-glass"/);
  assert.match(house[0], /type="button".*aria-label="Home".*aria-pressed="false"/);
  assert.match(house[1], /width="15" height="15" viewBox="0 0 24 24"/);
  assert.match(house[1], /<path d="M3 10\.5 12 3l9 7\.5"\/><path d="M5\.5 9\.5V21h13V9\.5"\/>/);
  assert.match(html, /body\.focus #homeico\{background:none; border:none; box-shadow:none\}/);
  assert.match(html, /const tabPlus = h\("button", "ptabplus"\)/);
  assert.doesNotMatch(html, /workspaceTransition|projectEntrance|project-enter|navigateWorkspace|navigateTab/);
});
