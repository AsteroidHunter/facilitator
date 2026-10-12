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
    dataset: {}, style: { setProperty(k, v) { this[k] = String(v); } }, attributes: {}, listeners: {}, hidden: false, disabled: false, title: "", type: "",
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
  assert.match(html, /<button id="projnew" class="projrow" type="button">[\s\S]*?<span class="pname">Open a new folder<\/span>(<\/span>)?<\/button>/);
  // a closed project is not in the list, the faint names or the keys' order
  f.state.tabs.closed = ["wayside"]; f.context.renderTabs(f.state);
  assert.deepEqual(f.names(), ["facilitator", "moonbase", "alder-workshop", "marlow"]);
});

test("while Home is open no row is checked, and the pill reads Home", () => {
  const f = fixture({ homeOpen: true });
  assert.deepEqual(f.checked(), []); assert.equal(f.pill(), "Home");
  assert.equal(f.ids.projpill.hidden, false); assert.equal(f.ids.projpill.disabled, false);
  // Home is a place, not a project with replies: the pill is not bold, though marlow holds an unread reply
  assert.equal(f.ids.projpill.classes.has("unread"), false);
  assert.equal(f.ids.projname.dataset.label, "Home");
  // the unread replies are all elsewhere, marlow's too
  assert.match(f.ids.projpill.attributes["aria-label"], /^Home, unread replies elsewhere, choose a project$/);
});

test("a click on the Home pill opens the list, as on a project, with no row checked; the list shuts as before", () => {
  const f = fixture({ homeOpen: true, activeOwner: "wayside" });
  f.open(); assert.equal(f.isOpen(), true);
  assert.equal(f.ids.projpill.attributes["aria-expanded"], "true");
  assert.deepEqual(f.names(), ["facilitator", "moonbase", "alder-workshop", "wayside", "marlow"]);
  assert.deepEqual(f.checked(), []);
  assert.equal(f.row("wayside").attributes["aria-current"], "false");
  f.open(); assert.equal(f.isOpen(), false, "a second click shuts it");
});

test("on Home the project you came from leads the faint names, one click away, and a click leaves Home for it", () => {
  const f = fixture({ activeOwner: "wayside" });
  // on its board the project is the pill, and not a faint name
  assert.deepEqual(f.suggestions(), ["marlow", "moonbase"]);
  f.context.setHome(true);
  assert.equal(f.pill(), "Home");
  assert.deepEqual(f.suggestions(), ["wayside", "marlow", "moonbase"], "the project left leads on Home");
  // a long gone project that was left is first all the same, and the cap of 4 holds
  const g = fixture({ homeOpen: true, activeOwner: "facilitator" });
  assert.equal(g.suggestions()[0], "facilitator");
  assert.ok(g.suggestions().length <= 4);
  // one click on that faint name: the project's name is back in the pill, Home is down
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.context.homeOpen, false); assert.equal(f.context.activeOwner, "wayside");
  assert.equal(f.pill(), "wayside"); assert.deepEqual(f.checked(), ["wayside"]);
  assert.equal(f.ids.projname.dataset.label, "wayside");
  assert.deepEqual(f.suggestions(), ["marlow", "moonbase"]);
});

test("leaving Home by another faint name, a list row or Command + 1 to 9 puts that project's name back in the pill", () => {
  const home = over => { const f = fixture({ homeOpen: true, activeOwner: "wayside", ...over }); assert.equal(f.pill(), "Home"); return f; };
  // another faint name
  let f = home(); f.ids.tabbar.children[1].fire("click");
  assert.equal(f.pill(), "marlow"); assert.equal(f.context.homeOpen, false); assert.deepEqual(f.checked(), ["marlow"]);
  // a row of the list
  f = home(); f.open(); f.row("moonbase").fire("click");
  assert.equal(f.pill(), "moonbase"); assert.equal(f.context.homeOpen, false); assert.equal(f.isOpen(), false);
  // the row of the project Home came from
  f = home(); f.open(); f.row("wayside").fire("click");
  assert.equal(f.pill(), "wayside"); assert.equal(f.context.homeOpen, false);
  // Command + 1 to 9: the tab key's handler is setTab on the list's order
  f = home(); f.context.setTab(f.context.rowsOf(f.state)[1]);
  assert.equal(f.pill(), "moonbase"); assert.equal(f.context.homeOpen, false);
  // and the pill takes its bold again when that project holds a reply not yet read
  assert.equal(f.ids.projpill.classes.has("unread"), true);
});

test("the Home pill carries the board's own house before the word, drawn only while Home is up", () => {
  const pill = html.match(/<button id="projpill"[^>]*>([\s\S]*?)<\/button>/)[1];
  const house = html.match(/<button id="homeico"[^>]*>(<svg[\s\S]*?<\/svg>)<\/button>/)[1];
  const ico = pill.match(/^(<svg id="projico"[\s\S]*?<\/svg>)<span id="projname"><\/span>$/);
  assert.ok(ico, "the pill is the house and the name");
  assert.equal(ico[1].replace(' id="projico"', ""), house, "the pill's house is not the Home button's drawing");
  assert.match(ico[1], /aria-hidden="true"/);
  assert.match(ico[1], /stroke="currentColor"/, "the house takes the word's colour");
  // 15px beside the 14px word, 6px from it; the pill's flex centres it on the line
  const base = rule(sheet, "body.focus #projico");
  assert.equal(decl(base, "display"), "none"); assert.equal(decl(base, "flex"), "none");
  assert.equal(decl(base, "margin-right"), "6px");
  assert.equal(decl(rule(sheet, "body.focus.home #projico"), "display"), "block");
  assert.match(sheet, /body\.focus #projpill\{[^}]*display:flex; align-items:center/);
  assert.match(html, /<svg id="projico" width="15" height="15"/);
  // the pill's own height, padding, corners and type are as they were
  const p = rule(sheet, "body.focus #projpill");
  assert.equal(decl(p, "height"), "32px"); assert.equal(decl(p, "padding"), "0 14px");
  assert.equal(decl(p, "border-radius"), "16px"); assert.equal(decl(p, "font"), "400 14px/17px var(--sans)");
  // Home's button stays pressed while Home is up, and the new rules bring no purple or new colour
  assert.match(sheet, /body\.focus\.home #homeico\{color:var\(--ink\); --qn-tint:\.95; --qn-edge:3\}/);
  assert.doesNotMatch(base + rule(sheet, "body.focus.home #projico"), /#[0-9a-f]{3,6}\b|rgb|--accent/i);
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

// ---- round 2 (20261010): the owner's five notes ------------------------------
const sheet = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(path.join(root, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
// the last rule written for exactly this selector (the settings sheet says .sp-veil.open twice; the later one dims)
const rule = (text, selector) => {
  const at = text.lastIndexOf("\n  " + selector + "{") >= 0 ? text.lastIndexOf("\n  " + selector + "{") + 3 : text.lastIndexOf("\n" + selector + "{") + 1;
  assert.ok(at > 0, selector + " has no rule");
  return text.slice(at + selector.length + 1, text.indexOf("}", at)).replace(/\s+/g, " ").trim();
};
const decl = (block, property) => (block.match(new RegExp("(?:^|[;\\s])" + property + ":([^;]+)")) || [])[1]?.trim();

test("nothing below the bar clips its glass's shadows: only the root keeps the page from scrolling", () => {
  assert.match(sheet, /html:has\(body\.focus\)\{overflow:hidden\}/);
  assert.doesNotMatch(sheet, /body\.focus\s*(,[^{]*)?\{[^}]*overflow:\s*(hidden|clip)/, "the body clips the bar's shadows at its foot again");
  assert.doesNotMatch(sheet, /body\.focus \.bar\{[^}]*overflow/);
});

test("the pill is the name, with the Home house before it only on Home, and the list's rows have no check mark", () => {
  const pill = html.match(/<button id="projpill"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.deepEqual([...pill.matchAll(/<(\w+)/g)].map(m => m[1]), ["svg", "path", "path", "span"], "the pill carries more than the house and its name");
  assert.match(pill, /<span id="projname"><\/span>$/);
  const list = html.slice(html.indexOf('<div id="projmenu"'), html.indexOf("</div>\n", html.indexOf('<div id="projsep"')) + 20);
  assert.doesNotMatch(list, /<svg/, "the list carries a mark");
  assert.doesNotMatch(html, /PROJ_CHECK|pcheck|class="pmark"|"pmark"/);
  // the open project's row still says so, to assistive tech only
  const f = fixture();
  assert.equal(f.row("marlow").attributes["aria-current"], "true");
  assert.deepEqual(f.row("marlow").children.map(c => [...c.classes][0]), ["pline", "projx"],
    "the open row holds more than its line and its cross");
  assert.deepEqual(f.row("marlow").children[0].children.map(c => [...c.classes][0]), ["pnum", "pname"],
    "the open row's line holds more than its number and its name");
});

test("project names are one step larger, 14px, in the pill, the faint names and the list alike", () => {
  for (const selector of ["body.focus #projpill", "body.focus #tabbar .psug", "#projmenu .projrow"])
    assert.equal(decl(rule(sheet, selector), "font"), "400 14px/17px var(--sans)", selector);
  // and the row stays 32px high
  assert.equal(decl(rule(sheet, "body.focus #projpill"), "height"), "32px");
  assert.equal(decl(rule(sheet, "body.focus #tabbar .psug"), "height"), "32px");
});

test("the open list dims the board exactly as the settings page does, and the dim fades away on close", () => {
  const shut = rule(sheet, "body.focus #projshade"), open = rule(sheet, "body.focus.projopen #projshade");
  const veil = rule(tokens, ".sp-veil"), veilOpen = rule(tokens, ".sp-veil.open");
  const strength = decl(veil, "--qn-veil");
  assert.equal(strength, "24%");
  // the same colour and strength, open and shut
  assert.equal(decl(open, "background-color"), decl(veilOpen, "background-color").replace("var(--qn-veil)", strength));
  assert.equal(decl(shut, "background-color"), decl(veil, "background-color"));
  // the same fade, in and out, and hidden from the pointer once it has faded out
  assert.equal(decl(shut, "transition"), decl(veil, "transition"));
  assert.equal(decl(open, "transition"), decl(veilOpen, "transition"));
  for (const [a, b] of [[shut, veil], [open, veilOpen]]) {
    assert.equal(decl(a, "visibility"), decl(b, "visibility")); assert.equal(decl(a, "pointer-events"), decl(b, "pointer-events"));
  }
  // over the whole window and the bar, under the list
  assert.equal(decl(shut, "position"), "fixed"); assert.equal(decl(shut, "inset"), "0");
  assert.equal(Number(decl(shut, "z-index")), Number(decl(rule(sheet, "body.focus #projmenu"), "z-index")) - 1);
  assert.ok(Number(decl(shut, "z-index")) > 10, "the bar is not under the dim");
  assert.ok(html.indexOf('<div id="projshade"></div>') < html.indexOf('<div id="projmenu"'));
  // a press on the dim shuts the list (the capture listener: a press outside the list and the pill)
  const f = fixture(); f.open();
  f.doc("pointerdown", { target: { nodeType: 1 } }); assert.equal(f.isOpen(), false);
});

test("the list's top edge is one line: it wears the bar's rim, not the glass's doubled top", () => {
  assert.match(sheet, /body\.focus :is\(\.bar \.qn-glass, #projmenu\)\{\s*box-shadow:/);
  const rim = sheet.slice(sheet.indexOf("body.focus :is(.bar .qn-glass, #projmenu){"));
  const stack = rim.slice(0, rim.indexOf("}"));
  assert.doesNotMatch(stack, /inset 0 1px 0 rgba\(255,255,255/, "the white first row over the ring");
  assert.doesNotMatch(stack, /inset 0 2px 0 rgba\(0,0,0/, "the dark band a row inside the ring");
  assert.match(stack, /inset 0 0 0 1px var\(--qn-ring\)/);
  // and that rule outranks the glass's own (an id beats the class)
  assert.match(tokens, /\.qn-glass\{\s*border:none;[^}]*inset 0 2px 0 rgba\(0,0,0,\.045\)/);
});

// ---- rounds 3 and 4 (20261010): spacing, numbers and weights ------------------
test("glass stands about 10px from glass, and every project name the same distance from the next", () => {
  const sug = rule(sheet, "body.focus #tabbar .psug"), bar = rule(sheet, "body.focus #tabbar");
  assert.equal(decl(sug, "padding"), "0 14px", "the faint names have the pill's room, the whole box clickable");
  assert.equal(decl(rule(sheet, "body.focus #projpill"), "padding"), "0 14px");
  assert.equal(decl(sug, "margin"), "0");
  assert.equal(decl(sug, "text-align"), "left", "a word centred in a wider box draws a wider gap");
  assert.equal(decl(sug, "border"), "none"); assert.equal(decl(sug, "background"), "none", "no glass on a faint name");
  const houseToPill = parseFloat(decl(rule(sheet, "body.focus #tabrow"), "gap"));
  assert.equal(houseToPill, 11, "house to pill");
  // house to pill: 11px of box, and the rings draw 0.4px outside their boxes, so about 10px drawn.
  // the first faint box starts where the pill's glass ends (the margin takes back #tabrow's gap) and the
  // faint boxes touch, so pill word to first word and word to word are both 14 + 14 = 28px of box, about
  // 30px drawn, a word's ink standing about 1px inside its box at each end
  assert.equal(parseFloat(decl(bar, "margin-left")), -houseToPill, "the bar takes back #tabrow's gap");
  assert.equal(parseFloat(decl(bar, "gap")), 0);
  // the faint names hold no room for a bold self (it drew as a gap after a regular word)
  const f = fixture();
  assert.ok(f.ids.tabbar.children.length > 0);
  for (const b of f.ids.tabbar.children) assert.equal(b.children[0].dataset.label, undefined);
});

test("each row has its number in the monospace face and a greyer ink, as tall as the names, and the plus stands in the same column", () => {
  const f = fixture(), numOf = r => r.querySelector(".pnum");
  assert.deepEqual(f.rows().map(r => numOf(r).textContent), ["1", "2", "3", "4", "5"]);
  assert.ok(f.rows().every(r => numOf(r).attributes["aria-hidden"] === "true"));
  assert.equal(f.menu.style["--pnum"], "1ch", "the column is as wide as the longest number");
  const num = rule(sheet, "#projmenu .pnum");
  // Plex Mono's figures are 9.94px tall at 14px, Plex Sans's tall letters 10.36px: the figures are set at
  // 14 x 10.36 / 9.94 = 14.6px, on the names' 17px line, so they stand as tall as the names
  assert.equal(decl(num, "font"), "400 14.6px/17px var(--mono)");
  assert.ok(Math.abs(14 * 10.359 / 9.938 - 14.6) < .05);
  // the number and the name share one baseline, and the row centres that line
  const line = rule(sheet, "#projmenu .pline");
  assert.equal(decl(line, "display"), "flex"); assert.equal(decl(line, "align-items"), "baseline");
  assert.equal(decl(num, "color"), "var(--sub)", "the numbers are not greyer than the names");
  assert.equal(decl(num, "width"), "var(--pnum, 1ch)"); assert.equal(decl(num, "text-align"), "right");
  assert.equal(decl(rule(sheet, "#projmenu .projrow"), "color"), "var(--ink)");
  // "Open a new folder" carries the monospace plus in that column
  assert.match(html, /<button id="projnew" class="projrow" type="button"><span class="pline"><span class="pnum" aria-hidden="true">\+<\/span><span class="pname">Open a new folder<\/span><\/span><\/button>/);
  // a reorder renumbers: the numbers follow the list, as Command + 1 to 9 do
  f.open(); const held = f.row("facilitator");
  held.fire("mousedown", { clientX: 100, clientY: 60 });
  f.win("mousemove", { clientX: 100, clientY: 130 }); f.win("mouseup", { clientX: 100, clientY: 130 });
  assert.deepEqual(f.rows().map(r => [numOf(r).textContent, r.dataset.owner]),
    [["1", "moonbase"], ["2", "alder-workshop"], ["3", "facilitator"], ["4", "wayside"], ["5", "marlow"]]);
  // ten projects make the column two digits wide
  const now = Date.now() / 1000;
  for (let i = 0; i < 6; i++) { f.state.boxes.push({ id: "x" + i, owner: "extra" + i, ball: "you", replies: 0, ts: now, agentTs: 0 }); }
  f.context.renderTabs(f.state);
  assert.equal(f.rows().length, 11); assert.equal(numOf(f.rows()[10]).textContent, "11"); assert.equal(f.menu.style["--pnum"], "2ch");
});

test("unread names are Plex's 600 and the rest its 400, in the pill, the faint names and the list, and both weights are loaded", () => {
  assert.match(html, /family=IBM\+Plex\+Sans:wght@[^&"]*\b400\b[^&"]*\b600\b/, "the font link lacks 400 or 600");
  assert.match(html, /family=IBM\+Plex\+Mono:wght@[^&"]*\b400\b/);
  assert.equal(decl(rule(sheet, "body.focus #projpill.unread #projname"), "font-weight"), "600");
  assert.equal(decl(rule(sheet, "body.focus #tabbar .psug.unread .plabel"), "font-weight"), "600");
  assert.equal(decl(rule(sheet, "#projmenu .projrow.unread .pname"), "font-weight"), "600");
  assert.doesNotMatch(sheet.slice(sheet.indexOf("body.focus #projpill{"), sheet.indexOf("#projsep{")), /font-weight:700/, "a project name is still 700");
  // the pill's name holds room for its bold self, so a reply landing never moves the pill or the names after it
  assert.equal(decl(rule(sheet, "body.focus #projname[data-label]::after"), "font-weight"), "600");
  // the pill takes the bold for its own project's unread replies, and holds its label for the bold width
  const f = fixture();
  assert.equal(f.ids.projpill.classes.has("unread"), true, "marlow holds an unread reply");
  assert.equal(f.ids.projname.dataset.label, "marlow");
  f.ids.tabbar.children[0].fire("click");   // to moonbase, which is unread too
  assert.equal(f.ids.projpill.classes.has("unread"), true);
  f.context.setTab("facilitator"); f.context.renderTabs(f.state);
  assert.equal(f.ids.projpill.classes.has("unread"), false, "facilitator has nothing unread");
  assert.equal(f.ids.projname.dataset.label, "facilitator");
});

// ---- round 5 (20261010): the right-hand pair ------------------------------------
test("the speaker and the squid stand the house's gap to the pill apart, and the squid the house's inset from its edge", () => {
  const houseToPill = parseFloat(decl(rule(sheet, "body.focus #tabrow"), "gap"));
  const barGap = parseFloat(decl(rule(sheet, "body.focus .bar"), "gap"));
  const squid = parseFloat(decl(rule(sheet, "body.focus .bar #setbtn"), "margin-left"));
  assert.equal(barGap + squid, houseToPill, "speaker to squid is not house to pill");
  assert.equal(houseToPill, 11);
  // the bar is inset the same on both sides and has no side padding, so the squid is as far from the right
  // edge as the house is from the left
  assert.match(sheet, /body\.focus \.bar\{\s*margin:var\(--app-inset\) var\(--app-inset\) 0;/);
  assert.equal(decl(rule(sheet, "body.focus .bar"), "padding"), "1px 0 6px");
  // the squid is the bar's last piece, and the speaker still holds the right end with an auto margin
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf("<!-- the pill's list"));
  assert.ok(bar.lastIndexOf('id="setbtn"') > bar.lastIndexOf('id="chimebtn"'));
  assert.equal(decl(rule(sheet, "body.focus .bar #chimebtn"), "margin-left"), "auto");
});
