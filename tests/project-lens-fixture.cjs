// The desktop bar's real lens, drag and joint code run with synthetic
// geometry and a synthetic clock. Shared by project-lens.test.cjs and
// tab-joint.test.cjs. It checks behavior and geometry, not browser rendering.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
// The page loads card-logic.js before its own script, and the joint shares the
// sent bubbles' merge helpers from it. They are taken from that file as it
// is, in a context of their own, so its other globals cannot shadow the stubs.
const cardLogic = vm.createContext({ console });
vm.runInContext(readFileSync(path.join(root, "card-logic.js"), "utf8"), cardLogic);
const shared = { sentCurve: cardLogic.sentCurve, sentSmooth: cardLogic.sentSmooth,
  sentBoxDistance: cardLogic.sentBoxDistance, MERGE_EASE: vm.runInContext("MERGE_EASE", cardLogic) };

// The workspace pane at 1x: the bar's 32px pieces stand from 7 to 39 (--app-inset
// and the bar's 1px of padding under the window's top), and the pane's border
// box starts at --app-inset + --bar-h - 1 - --edge-drawn = 45, its .8px clear
// border drawn one device pixel wide, so its ring starts at 46.
const ROW_TOP = 7;
const PANE = { left: 6, top: 45, right: 994, bottom: 794 };

function fixture({ home = false, closed = [], widths = [100, 140, 80], render = false, pane = true, reduced = false } = {}) {
  const handlers = {}, tasks = new Map(), frames = new Map(), images = [], switches = [], writes = [], opens = [], observers = [];
  let id = 0, now = 0, context, still = reduced;
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
    getAttribute(k) { return this.attributes[k] ?? null; }
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
    after(el) { if (el.parentNode) el.remove(); const list = this.parentNode.children; list.splice(list.indexOf(this) + 1, 0, el); el.parentNode = this.parentNode; el.isConnected = true; }
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
    getAnimations(options) { return [...(this.animations || []), ...(options?.subtree ? this.children.flatMap(el => el.getAnimations(options)) : [])]; }
    matches(selector) { return selector === ":hover" && this.hovered; }
    getBoundingClientRect() {
      if (this === row) return { left:0, top:ROW_TOP, width:360, height:32, right:360, bottom:ROW_TOP + 32 };
      if (this === homeButton) return { left:0, top:ROW_TOP, width:32, height:32, right:32, bottom:ROW_TOP + 32 };
      if (this === house) return { left:8.5, top:ROW_TOP + 8.5, width:15, height:15, right:23.5, bottom:ROW_TOP + 23.5 };
      if (this === oval || this === bar) return { left: 40, top: ROW_TOP, width: 320, height: 32, right: 360, bottom: ROW_TOP + 32 };
      if (this === frame) return { ...PANE, width: PANE.right - PANE.left, height: PANE.bottom - PANE.top };
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
        const top = ROW_TOP + Number(move?.[2] || 0);
        return { left, top, width: widthOf(this), height: 32, right: left + widthOf(this), bottom: top + 32 };
      }
      // a test may stand in for a CSS transition by giving the place and width
      // the element shows part way through it (animated), as a browser reports
      const shown = this.animated || {};
      const move = (shown.transform ?? this.style.transform ?? "").match(/translate(?:X)?\(([-.\d]+)px(?:,\s*([-.\d]+)px)?/);
      const independent = (this.style.translate || "").split(" ").map(v => parseFloat(v) || 0);
      const width = parseFloat(shown.width ?? this.style.width) || 0;
      const left = (this.parentNode?.getBoundingClientRect().left || 0) + (parseFloat(this.style.left) || 0) + Number(move?.[1] || 0) + (independent[0] || 0);
      const top = ROW_TOP + Number(move?.[2] || 0) + (independent[1] || 0);
      return { left, top, width, height: 32, right: left + width, bottom: top + 32 };
    }
  }
  const oval = new Element("taboval"), bar = new Element(), row = new Element(), body = new Element();
  const homeButton = new Element(), house = new Element(), frame = new Element(), topBar = new Element("bar");
  frame.setAttribute("id", "appframe");
  body.appendChild(topBar); topBar.appendChild(row);
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
    getElementById: id => id === "tabrow" ? row : id === "homeico" ? homeButton : id === "appframe" && pane ? frame : bar,
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
      if (el === frame) return { borderTopWidth: "0.8px", borderTopLeftRadius: "7px", opacity: "1", width: "988px" };
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
    performance: { now: () => now },
    matchMedia: query => ({ get matches() { return still && query.includes("prefers-reduced-motion: reduce"); } }),
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
    ...shared,
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
  return { context, seat, tabs, oval, bar, row, topBar, homeButton, house, frame, document, images, switches, writes, opens, observers, frames, dispatch, down, move, up, click, tick,
    get now() { return now; }, setReduced(on) { still = on; },
    get: source => vm.runInContext(source, context),
  };
}

module.exports = { fixture, html, between, PANE, ROW_TOP };
