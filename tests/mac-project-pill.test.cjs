// The Mac board's top bar: the project pill, its list and the faint
// suggestions beside it. The real script (renderTabs, the list's clicks,
// hover, carry and cross, the suggestions, setTab, closeTab and the folder
// chooser) runs in a VM on a small synthetic DOM with fixed geometry. This
// checks behaviour, not rendering; no browser starts.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const logic = readFileSync(path.join(root, "card-logic.js"), "utf8");
function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return html.slice(a, b);
}

// ---- a small DOM: enough elements, classes, selectors and events for the bar
function matchesOne(el, part) {
  const m = part.match(/^([a-z]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/);
  if (!m) throw new Error("selector " + part);
  if (m[1] && el.tagName !== m[1]) return false;
  if (m[2] && el.id !== m[2].slice(1)) return false;
  return (m[3].match(/\.[\w-]+/g) || []).every(c => el.classes.has(c.slice(1)));
}
function matches(el, sel) {
  const parts = sel.trim().split(/\s+/);
  if (!matchesOne(el, parts.at(-1))) return false;
  let at = el.parentNode;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (at && !(at.classes && matchesOne(at, parts[i]))) at = at.parentNode;
    if (!at) return false;
    at = at.parentNode;
  }
  return true;
}
function element(tag, cls = "", text) {
  const el = {
    tagName: tag, id: "", classes: new Set(cls.split(/\s+/).filter(Boolean)), children: [], parentNode: null,
    dataset: {}, style: {}, attributes: {}, listeners: {}, hidden: false, disabled: false, title: "", type: "",
    _text: text || "",
    get classList() {
      const c = this.classes;
      return { add: (...n) => n.forEach(x => c.add(x)), remove: (...n) => n.forEach(x => c.delete(x)), contains: n => c.has(n),
        toggle: (n, on) => { if (on === undefined ? !c.has(n) : on) c.add(n); else c.delete(n); } };
    },
    get className() { return [...this.classes].join(" "); },
    set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get textContent() { return this._text + this.children.map(c => c.textContent).join(""); },
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); },
    set innerHTML(v) { this._html = v; },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; },
    remove() { const p = this.parentNode; if (p) { p.children = p.children.filter(x => x !== this); this.parentNode = null; } },
    contains(o) { for (let at = o; at; at = at.parentNode) if (at === this) return true; return false; },
    closest(sel) { for (let at = this; at && at.classes; at = at.parentNode) if (matches(at, sel)) return at; return null; },
    querySelectorAll(sel) { const out = []; const walk = n => n.children.forEach(c => { if (matches(c, sel)) out.push(c); walk(c); }); walk(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    // an event at this element bubbles up the tree, as the browser's does
    fire(type, extra = {}) {
      let stopped = false;
      const e = { type, target: this, button: 0, buttons: 1, detail: 1, clientX: 0, clientY: 0, screenX: 0, screenY: 0,
        defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; }, ...extra };
      for (let at = this; at && !stopped; at = at.parentNode) for (const fn of at.listeners?.[type] || []) fn(e);
      return e;
    },
    getBoundingClientRect() { return this.rect ? this.rect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    focus() { dom.active = this; },
    scrollIntoView() {},
  };
  return el;
}
const dom = { active: null };
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function fixture(over = {}) {
  const ids = {}, windowListeners = {}, docListeners = {}, writes = [], opens = [], fetches = [], calls = [];
  const make = (id, tag = "div", cls = "") => { const el = element(tag, cls); el.id = id; ids[id] = el; return el; };
  const body = make("body", "body", "focus");
  for (const id of ["homeico", "projpill", "chimebtn", "setbtn"]) body.appendChild(make(id, "button", "qn-glass"));
  ids.projpill.appendChild(make("projname", "span"));
  body.appendChild(make("tabbar", "span"));
  const menu = body.appendChild(make("projmenu", "div", "qn-glass"));
  const list = menu.appendChild(make("projlist"));
  menu.appendChild(make("projsep"));
  const fresh = menu.appendChild(make("projnew", "button", "projrow"));
  body.appendChild(make("npstart", "button"));   // the home page's own folder button
  ids.projpill.rect = () => box(48, 7, 120, 32);
  menu.rect = () => box(48, 45, 220, 12 + 32 * (list.children.length + 1) + 9);
  const now = Date.now() / 1000, day = 86400;
  const card = (id, owner, extra = {}) => ({ id, owner, bucket: "must", title: id, ball: "you", replies: 0, ts: now - 30 * day, agentTs: 0, ...extra });
  const state = over.state || {
    boxes: [
      card("f1", "facilitator", { ts: now - 60 }),
      card("m1", "moonbase", { replies: 2, agentTs: now - 2 * day }),                 // unread, 2 days
      card("a1", "alder-workshop", { replies: 1, agentTs: now - 10 * day }),         // unread, 10 days
      card("w1", "wayside", { ts: now - 3 * day }),                                   // read, 3 days
      card("k1", "marlow", { replies: 3, agentTs: now - 3600 }),                      // unread, an hour
    ],
    projects: [], tabs: { order: ["facilitator", "moonbase", "alder-workshop", "wayside", "marlow"], closed: [] },
  };
  const store = new Map(Object.entries(over.store || {}));
  const context = vm.createContext({
    Date, Math, JSON, Promise, setTimeout: (fn) => { calls.push("timer"); fn(); return 0; }, clearTimeout() {},
    performance: { now: () => 0 },
    FOCUS: true, LOCKED: over.LOCKED || null, ownerReady: true, draft: null, homeOpen: !!over.homeOpen, homeChecked: true,
    activeOwner: over.activeOwner || "marlow", selectedId: "k1", browsing: false, lastSel: {},
    validActiveOwnerIds: new Set(state.tabs.order), lastState: state, editMode: false, magicSync() {},
    location: { pathname: "/" },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    document: {
      body, getElementById: id => ids[id] || null, createElement: tag => element(tag),
      addEventListener(type, fn, capture) { (docListeners[type] ||= []).push(fn); },
      get activeElement() { return dom.active; },
      visibilityState: "visible",
    },
    addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    h: (tag, cls, text) => element(tag, cls, text),
    fetch: async (url, options) => {
      fetches.push({ url, method: options?.method || "GET", body: options?.body });
      if (url === "/tabs") { writes.push(JSON.parse(options.body)); return { json: async () => ({}) }; }
      if (url === "/pickdir") return { status: 200, json: async () => ({ path: "/Users/me/garden/" }) };
      if (url.startsWith("/project?")) return { ok: true, json: async () => ({ id: "garden" }) };
      throw new Error("unexpected fetch " + url);
    },
    open: (...args) => { opens.push(args); },
    browse(id) { context.selectedId = id; context.browsing = true; },
    deselect() { context.selectedId = null; },
    unselectShown() { calls.push("unselect"); context.browsing = true; },
    applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {},
    apply(st) { context.renderTabs(st); },
    setHome(on) { context.homeOpen = !!on; context.renderTabs(state); },
    endDraft() { context.draft = null; },
    projNote(msg) { calls.push("note " + msg); },
    poll: async () => { calls.push("poll"); state.boxes.push(card("g1", "garden")); state.tabs.order.push("garden"); context.validActiveOwnerIds.add("garden"); },
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  run(between("function setTab(owner){", "// clear the selection entirely:"));
  run(between("function tabClosed(ow, st){", "// ---- the one-time carry-over"));
  run(between("function rowsOf(state){", "function nav("));
  run(between("// ---- the project pill, its list and the faint suggestions", "// ---- the press on the bar's glass"));
  run(between("// closing a project works exactly", "// the new project tab:"));
  run(between("const homePick =", "// ---- the home page"));
  context.renderTabs(state);
  const rows = () => list.children;
  const row = ow => rows().find(r => r.dataset.owner === ow);
  // rows stand edge to edge, 32px each, from 51px down
  const place = () => rows().forEach((r, i) => { r.rect = () => box(54, 51 + 32 * i, 208, 32); });
  place();
  const win = (type, extra = {}) => { for (const fn of windowListeners[type] || []) fn({ buttons: 1, button: 0, preventDefault() {}, stopImmediatePropagation() {}, ...extra }); };
  return { context, state, ids, body, menu, list, fresh, writes, opens, fetches, calls, store, rows, row, place, win,
    get: code => vm.runInContext(code, context),
    open: () => ids.projpill.fire("click"),
    isOpen: () => body.classes.has("projopen"),
    names: () => rows().map(r => r.dataset.owner),
    checked: () => rows().filter(r => r.classes.has("on")).map(r => r.dataset.owner),
    suggestions: () => ids.tabbar.children.map(b => b.dataset.owner),
    pill: () => ids.projname.textContent,
    doc: (type, e) => { for (const fn of docListeners[type] || []) fn(e); },
  };
}

test("the pill names the open project, and its list holds every open project in the board's order, the open one checked", () => {
  const f = fixture();
  assert.equal(f.pill(), "marlow");
  assert.equal(f.ids.projpill.hidden, false); assert.equal(f.ids.projpill.disabled, false);
  assert.deepEqual(f.names(), ["facilitator", "moonbase", "alder-workshop", "wayside", "marlow"]);
  assert.deepEqual(f.checked(), ["marlow"]);
  // unread projects are heavier, as their tabs were
  assert.deepEqual(f.rows().filter(r => r.classes.has("unread")).map(r => r.dataset.owner), ["moonbase", "alder-workshop", "marlow"]);
  // "Open a new folder" is the list's last row, after the projects
  assert.equal(f.menu.children.at(-1), f.fresh);
  assert.match(html, /<button id="projnew" class="projrow" type="button">[\s\S]*?<span class="pname">Open a new folder<\/span><\/button>/);
  // a closed project is not in the list, the faint names or the keys' order
  f.state.tabs.closed = ["wayside"]; f.context.renderTabs(f.state);
  assert.deepEqual(f.names(), ["facilitator", "moonbase", "alder-workshop", "marlow"]);
});

test("while Home is open no row is checked, and the pill still names the project Home was opened from", () => {
  const f = fixture({ homeOpen: true });
  assert.deepEqual(f.checked(), []); assert.equal(f.pill(), "marlow");
});

test("a project's own window shows its name on a pill that opens nothing, and no faint names", () => {
  const f = fixture({ LOCKED: "wayside", activeOwner: "wayside" });
  assert.equal(f.pill(), "wayside"); assert.equal(f.ids.projpill.disabled, true);
  assert.deepEqual(f.suggestions(), []); f.open(); assert.equal(f.isOpen(), false);
});

test("the faint names: unread and active in the last 7 days, newest first; the project just left always leads; at most 4", () => {
  const f = fixture(), s = (left, active = "marlow") => [...f.context.suggestedProjects(f.state, active, left)];
  // moonbase (unread, 2 days); alder-workshop is unread but 10 days old; wayside has nothing unread
  assert.deepEqual(s(null), ["moonbase"]);
  assert.deepEqual(f.suggestions(), ["moonbase"]);
  // the project just left leads, whatever it holds
  assert.deepEqual(s("wayside"), ["wayside", "moonbase"]);
  assert.deepEqual(s("moonbase"), ["moonbase"]);
  // never the open project, and never a closed one
  assert.deepEqual(s("marlow", "moonbase"), ["marlow"]);
  // with moonbase closed nothing unread is recent, so the few: most unread, then most recent
  f.state.tabs.closed = ["moonbase"];
  assert.deepEqual(s(null), ["alder-workshop", "facilitator", "wayside"]);
  assert.deepEqual(s("moonbase"), ["alder-workshop", "facilitator", "wayside"], "a closed project led, because it was just left");
  f.state.tabs.closed = [];
  // never more than 4, the newest first
  const now = Date.now() / 1000;
  for (const [i, ow] of ["p1", "p2", "p3", "p4", "p5"].entries())
    f.state.boxes.push({ id: ow + "c", owner: ow, ball: "you", replies: 1, agentTs: now - 100 * (i + 1), ts: 0 });
  assert.deepEqual(s("wayside"), ["wayside", "p1", "p2", "p3"]);
  assert.deepEqual(s(null), ["p1", "p2", "p3", "p4"]);
});

test("with nothing unread lately, the faint names are the 3 with the most unread, then the most recently active", () => {
  const now = Date.now() / 1000, day = 86400;
  const c = (id, owner, replies, at) => ({ id, owner, ball: "you", replies, agentTs: at, ts: 0 });
  const state = { projects: [], tabs: { order: ["a", "b", "c", "d", "e"], closed: [] }, boxes: [
    c("a1", "a", 0, now - day), c("b1", "b", 1, now - 20 * day), c("b2", "b", 1, now - 21 * day),
    c("c1", "c", 1, now - 9 * day), c("d1", "d", 0, now - 2 * day), c("e1", "e", 0, 0) ] };
  const f = fixture({ state, activeOwner: "a" });
  // b has two unread, c one, then d is the most recent; e was never active
  assert.deepEqual([...f.context.suggestedProjects(state, "a", null)], ["b", "c", "d"]);
  assert.deepEqual([...f.context.suggestedProjects(state, "a", "e")], ["e", "b", "c", "d"]);
});

test("a click on a faint name switches to it: it moves into the pill and the project left appears first beside it", () => {
  const f = fixture();
  assert.deepEqual(f.suggestions(), ["moonbase"]);
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.context.activeOwner, "moonbase"); assert.equal(f.pill(), "moonbase");
  assert.equal(f.suggestions()[0], "marlow"); assert.equal(f.store.get("projleft"), "marlow");
  assert.deepEqual(f.checked(), ["moonbase"]);
  // and back again
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.pill(), "marlow"); assert.equal(f.suggestions()[0], "moonbase");
});

test("the pill opens the list under itself and shuts it; Escape, a press outside and a choice shut it too", () => {
  const f = fixture();
  f.open(); assert.equal(f.isOpen(), true);
  assert.equal(f.ids.projpill.attributes["aria-expanded"], "true");
  assert.equal(f.menu.style.left, "48px"); assert.equal(f.menu.style.top, "45px");
  f.open(); assert.equal(f.isOpen(), false, "a second click shuts it");
  f.open(); let stopped = false;
  f.win("keydown", { key: "Escape", stopImmediatePropagation() { stopped = true; } });
  assert.equal(f.isOpen(), false); assert.equal(stopped, true, "Escape went on to the board");
  assert.equal(dom.active, f.ids.projpill, "the focus goes back to the pill");
  f.open(); f.doc("pointerdown", { target: f.row("wayside") }); assert.equal(f.isOpen(), true, "a press inside shut it");
  f.doc("pointerdown", { target: f.ids.chimebtn }); assert.equal(f.isOpen(), false);
  f.open(); f.row("wayside").fire("click");
  assert.equal(f.isOpen(), false); assert.equal(f.context.activeOwner, "wayside");
  // opened by a key, the open project's row takes the focus; the arrows walk the rows
  f.ids.projpill.fire("click", { detail: 0 }); assert.equal(dom.active, f.row("wayside"));
  f.win("keydown", { key: "ArrowDown" }); assert.equal(dom.active, f.row("marlow"));
  f.win("keydown", { key: "ArrowDown" }); assert.equal(dom.active, f.fresh);
});

test("the open project's own row lets go of the selected card, as a click on its tab did", () => {
  const f = fixture();
  f.open(); f.row("marlow").fire("click");
  assert.deepEqual(f.calls.filter(c => c === "unselect"), ["unselect"]); assert.equal(f.context.activeOwner, "marlow");
});

test("resting on a row fades in its cross alone; the cross closes only that project, and the last one stays", () => {
  const f = fixture();
  f.open();
  f.row("wayside").children[1].fire("mouseover");
  assert.deepEqual(f.rows().filter(r => r.classes.has("hot")).map(r => r.dataset.owner), ["wayside"]);
  f.row("moonbase").fire("mouseover");
  assert.deepEqual(f.rows().filter(r => r.classes.has("hot")).map(r => r.dataset.owner), ["moonbase"], "never a column of crosses");
  f.menu.listeners.mouseleave[0]();
  assert.equal(f.rows().some(r => r.classes.has("hot")), false);
  // the cross is out of the row's flow and takes the row's press for itself
  const cross = f.row("wayside").querySelector(".projx");
  assert.equal(cross.attributes["aria-label"], "close project");
  assert.equal(cross.fire("mousedown").type, "mousedown"); assert.equal(f.get("projCarry"), null, "the cross started a carry");
  cross.fire("click");
  assert.deepEqual(f.writes.at(-1).closed, ["wayside"]); assert.equal(f.context.activeOwner, "marlow", "the cross switched project");
  assert.equal(f.isOpen(), true); assert.equal(f.row("wayside"), undefined);
  // closing the open project steps to the one after it, or before it at the end
  f.row("marlow").querySelector(".projx").fire("click");
  assert.equal(f.context.activeOwner, "alder-workshop");
  // the last project stays open, its cross pale
  f.context.closeTab("facilitator"); f.context.closeTab("moonbase");
  const last = f.row("alder-workshop").querySelector(".projx");
  assert.equal(last.classes.has("off"), true); assert.equal(last.title, "the last project stays open");
  const before = f.writes.length; last.fire("click"); assert.equal(f.writes.length, before);
});

test("a row held and dragged reorders the projects, and the release is not a choice", () => {
  const f = fixture();
  f.open();
  const held = f.row("facilitator");
  held.fire("mousedown", { clientX: 100, clientY: 60 });
  f.win("mousemove", { clientX: 100, clientY: 63 }); assert.equal(held.classes.has("lifted"), false, "under 5px is still a click");
  f.win("mousemove", { clientX: 100, clientY: 130 });
  assert.equal(held.classes.has("lifted"), true); assert.equal(held.style.transform, "translateY(70px)");
  assert.equal(f.row("moonbase").style.transform, "translateY(-32px)");
  f.win("mouseup", { clientX: 100, clientY: 130 }); held.fire("click");
  assert.deepEqual(f.writes.at(-1).order, ["moonbase", "alder-workshop", "facilitator", "wayside", "marlow"]);
  assert.equal(f.context.activeOwner, "marlow", "the release chose the carried project");
  assert.deepEqual(f.names(), ["moonbase", "alder-workshop", "facilitator", "wayside", "marlow"]);
  // Command + 1 to 9 follow the list's order
  assert.deepEqual([...f.context.rowsOf(f.state)], f.names());
  // let go where it began: nothing is written
  f.place(); const before = f.writes.length;
  f.row("wayside").fire("mousedown", { clientX: 100, clientY: 160 });
  f.win("mousemove", { clientX: 100, clientY: 170 }); f.win("mouseup", { clientX: 100, clientY: 170 });
  assert.equal(f.writes.length, before);
});

test("a row dragged out of the list opens its project in a window of its own; back inside it reorders again", () => {
  const f = fixture();
  f.open();
  const held = f.row("wayside");
  held.fire("mousedown", { clientX: 100, clientY: 160 });
  f.win("mousemove", { clientX: 100, clientY: 170 });
  f.win("mousemove", { clientX: 320, clientY: 170 });
  assert.equal(held.classes.has("tearing"), true);
  f.win("mousemove", { clientX: 200, clientY: 170 }); assert.equal(held.classes.has("tearing"), false, "back over the list");
  f.win("mousemove", { clientX: 400, clientY: 300 });
  f.win("mouseup", { clientX: 400, clientY: 300, screenX: 900, screenY: 400 });
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0][0], "/?project=wayside");
  assert.match(f.opens[0][2], /popup=yes,width=1100,height=850,left=700,top=380/);
  assert.equal(f.writes.length, 0); assert.equal(f.isOpen(), false); assert.equal(f.context.activeOwner, "marlow");
  // let go outside the window (the next move has no button down): nothing opens
  const g = fixture(); g.open();
  g.row("wayside").fire("mousedown", { clientX: 100, clientY: 160 });
  g.win("mousemove", { clientX: 400, clientY: 300 }); g.win("mousemove", { clientX: 400, clientY: 300, buttons: 0 });
  assert.equal(g.opens.length, 0); assert.equal(g.get("projCarry"), null);
});

test("\"Open a new folder\" opens the Mac's folder chooser and lands on the new project, from Home too", async () => {
  const f = fixture({ homeOpen: true });
  f.open(); f.fresh.fire("click");
  assert.equal(f.isOpen(), false);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.deepEqual(f.fetches.map(x => x.url), ["/pickdir", "/project?name=garden"]);
  assert.equal(f.fetches[1].body, "/Users/me/garden");
  assert.equal(f.context.activeOwner, "garden"); assert.equal(f.store.get("activeproj"), "garden");
  assert.equal(f.context.homeOpen, false); assert.equal(f.store.get("projleft"), "marlow");
});

test("the house, the pill and the right-hand circles keep their places: no plus, no lens, no row of names", () => {
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf("<!-- the pill's list"));
  const order = ["homeico", "projpill", "tabbar", "chimebtn", "installbtn", "setbtn"].map(id => bar.indexOf('id="' + id + '"'));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "the bar's order changed");
  assert.doesNotMatch(html, /ptabplus|class="ptab"|"ptab"\)|tabKillMark|function placeSeat/);
  // nothing in the bar's new rules is the board's purple
  const css = html.slice(html.indexOf("/* ---- the bar's glass"), html.indexOf("/* ---- new-project tab"));
  assert.doesNotMatch(css, /--accent|#432BFF/i);
});
