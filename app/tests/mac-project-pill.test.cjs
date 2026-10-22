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
    click() { return this.fire("click", { detail: 0 }); },
  };
  return el;
}
const dom = { active: null };
const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function fixture(over = {}) {
  const ids = {}, windowListeners = {}, docListeners = {}, writes = [], opens = [], fetches = [], calls = [], pickers = [];
  const make = (id, tag = "div", cls = "") => { const el = element(tag, cls); el.id = id; ids[id] = el; return el; };
  const body = make("body", "body", "focus");
  for (const id of ["homeico", "projpill", "chimebtn", "setbtn"]) body.appendChild(make(id, "button", "qn-glass"));
  ids.projpill.appendChild(make("projname", "span"));
  ids.projpill.appendChild(make("projchev", "span")).appendChild(make("projchevsvg", "svg"));
  body.appendChild(make("tabbar", "span"));
  const menu = body.appendChild(make("projmenu", "div", "qn-glass"));
  const list = menu.appendChild(make("projlist"));
  menu.appendChild(make("projsep"));
  const fresh = menu.appendChild(make("projnew", "button", "projrow"));
  body.appendChild(make("npstart", "button"));   // the new tab's own folder button
  // the home page's list, which the pill's code paints in the same pass
  const homeBox = body.appendChild(make("homelistbox"));
  const homeRows = homeBox.appendChild(make("homerows"));
  const homeNew = homeBox.appendChild(make("homenew", "button", "homerow"));
  ids.projpill.rect = () => box(48, 7, 120, 32);
  menu.rect = () => box(48, 45, 220, 12 + 32 * (list.children.length + 1) + 9);
  homeBox.rect = () => box(1040, 200, 360, 40 * (homeRows.children.length + 1) + 10);
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
      if (url.startsWith("/project?")) return { ok: true, json: async () => ({ id: "garden" }) };
      throw new Error("unexpected fetch " + url);
    },
    open: (...args) => { opens.push(args); },
    // the board's folder picker (folder-picker.js), answering with the folder chosen in it
    FolderPicker: { open: async opts => { pickers.push(opts); return { machine: "this", path: "/Users/me/garden", name: "garden", short: "~/garden" }; } },
    browse(id) { context.selectedId = id; context.browsing = true; },
    deselect() { context.selectedId = null; },
    unselectShown() { calls.push("unselect"); context.browsing = true; },
    applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {},
    boardFadeTake() { return null; }, boardFadeLand() {},
    apply(st) { context.renderTabs(st); },
    setHome(on) { context.homeOpen = !!on; context.renderTabs(state); },
    endDraft() { context.draft = null; },
    projNote(msg) { calls.push("note " + msg); },
    homeFitSoon() { calls.push("fit"); },   // the home page's sizes, measured in a browser
    poll: async () => { calls.push("poll"); state.boxes.push(card("g1", "garden")); state.tabs.order.push("garden"); context.validActiveOwnerIds.add("garden"); },
  });
  const run = source => vm.runInContext(source, context);
  run(logic);
  context.folderPickerBundle = async () => true;   // the picker and its sheet, as if fetched
  run(between("function setTab(owner){", "// clear the selection entirely:"));
  run(between("function tabClosed(ow, st){", "// ---- the one-time carry-over"));
  run(between("function rowsOf(state){", "function nav("));
  run(between("// ---- the project pill, its list and the faint suggestions", "// ---- the press on the bar's glass"));
  run(between("// closing a project works exactly", "// the new project tab:"));
  run(between("const homePick =", "// ---- the home page"));
  context.renderTabs(state);
  const rows = () => list.children;
  const row = ow => rows().find(r => r.dataset.owner === ow);
  const homeRow = ow => homeRows.children.find(r => r.dataset.owner === ow);
  // rows stand edge to edge, 32px each, from 51px down; home's 40px each, from 200px down
  const place = () => {
    rows().forEach((r, i) => { r.rect = () => box(54, 51 + 32 * i, 208, 32); });
    homeRows.children.forEach((r, i) => { r.rect = () => box(1040, 200 + 40 * i, 360, 40); });
  };
  place();
  const win = (type, extra = {}) => { for (const fn of windowListeners[type] || []) fn({ buttons: 1, button: 0, preventDefault() {}, stopImmediatePropagation() {}, ...extra }); };
  return { context, state, ids, body, menu, list, fresh, homeBox, homeRows, homeNew, homeRow, writes, opens, fetches, calls, pickers, store, rows, row, place, win,
    homeNames: () => homeRows.children.map(r => r.dataset.owner),
    homeNumbers: () => homeRows.children.map(r => r.querySelector(".homenum").textContent),
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

test("while Home is open the pill names the project you came from, with the chevron on, and no row is checked", () => {
  const f = fixture({ homeOpen: true, activeOwner: "wayside" });
  assert.deepEqual(f.checked(), []); assert.equal(f.pill(), "wayside");
  assert.equal(f.ids.projpill.hidden, false); assert.equal(f.ids.projpill.disabled, false);
  assert.equal(f.ids.projname.dataset.label, "wayside");
  assert.equal(f.ids.projpill.classes.has("athome"), true);
  assert.equal(f.ids.projchev.tabIndex, 0); assert.equal(f.ids.projchev.attributes["aria-hidden"], "false");
  assert.equal(f.ids.projpill.attributes["aria-haspopup"], "false", "the pill itself opens a project, the chevron opens the list");
  assert.match(f.ids.projpill.attributes["aria-label"], /^wayside, unread replies elsewhere, open project$/);
  // the name takes its bold as on a board: marlow holds an unread reply
  assert.equal(f.ids.projpill.classes.has("unread"), false);
  assert.equal(fixture({ homeOpen: true }).ids.projpill.classes.has("unread"), true);
  // off Home there is no chevron to reach and the whole pill opens the list
  const g = fixture({ activeOwner: "wayside" });
  assert.equal(g.ids.projpill.classes.has("athome"), false);
  assert.equal(g.ids.projchev.tabIndex, -1); assert.equal(g.ids.projchev.attributes["aria-hidden"], "true");
  assert.equal(g.ids.projpill.attributes["aria-haspopup"], "true");
  assert.match(g.ids.projpill.attributes["aria-label"], /, choose a project$/);
  // a board with no project to name has no pill on Home either
  const h = fixture({ homeOpen: true, activeOwner: "gone" });
  assert.equal(h.ids.projpill.hidden, true); assert.equal(h.ids.projpill.classes.has("athome"), false);
  // and a project's own window never grows a chevron
  assert.equal(fixture({ LOCKED: "wayside", activeOwner: "wayside", homeOpen: true }).ids.projpill.classes.has("athome"), false);
});

test("on Home a click on the chevron opens the list, as on a project, with no row checked; the list shuts as before", () => {
  const f = fixture({ homeOpen: true, activeOwner: "wayside" });
  f.ids.projchev.fire("click"); assert.equal(f.isOpen(), true);
  assert.equal(f.ids.projpill.attributes["aria-expanded"], "true"); assert.equal(f.ids.projchev.attributes["aria-expanded"], "true");
  assert.deepEqual(f.names(), ["facilitator", "moonbase", "alder-workshop", "wayside", "marlow"]);
  assert.deepEqual(f.checked(), []);
  assert.equal(f.row("wayside").attributes["aria-current"], "false");
  assert.equal(f.context.homeOpen, true, "opening the list leaves Home up");
  // the same list sits under the pill's left edge
  assert.equal(f.menu.style.left, "48px"); assert.equal(f.menu.style.top, "45px");
  f.ids.projchev.fire("click"); assert.equal(f.isOpen(), false, "a second click shuts it");
  assert.equal(f.ids.projchev.attributes["aria-expanded"], "false");
  // the chevron's own drawing counts as the chevron
  f.ids.projchev.children[0].fire("click"); assert.equal(f.isOpen(), true);
  // Escape shuts it and the focus goes back to the pill
  f.win("keydown", { key: "Escape" }); assert.equal(f.isOpen(), false); assert.equal(dom.active, f.ids.projpill);
  // from the keyboard the chevron answers Enter and Space, and the first row takes the focus
  for (const key of ["Enter", " "]) {
    const e = f.ids.projchev.fire("keydown", { key }); assert.equal(e.defaultPrevented, true);
    assert.equal(f.isOpen(), true); assert.equal(dom.active, f.rows()[0]);
    f.ids.projchev.fire("click");
  }
  f.ids.projchev.fire("keydown", { key: "a" }); assert.equal(f.isOpen(), false);
  // a press outside shuts it, the pill and the chevron being inside
  f.ids.projchev.fire("click"); f.doc("pointerdown", { target: f.ids.projchev }); assert.equal(f.isOpen(), true);
  f.doc("pointerdown", { target: f.ids.chimebtn }); assert.equal(f.isOpen(), false);
});

test("on Home a click on the name opens that project, and the list shuts if it was open", () => {
  for (const hit of ["projname", "projpill"]) {
    const f = fixture({ homeOpen: true, activeOwner: "wayside" });
    f.ids[hit].fire("click");
    assert.equal(f.context.homeOpen, false, hit); assert.equal(f.context.activeOwner, "wayside");
    assert.equal(f.pill(), "wayside"); assert.deepEqual(f.checked(), ["wayside"]);
    assert.equal(f.isOpen(), false);
    assert.equal(f.store.get("projleft") ?? null, null, "it is the same project: nothing was left");
    assert.equal(f.ids.projpill.classes.has("athome"), false);
  }
  const g = fixture({ homeOpen: true, activeOwner: "wayside" });
  g.ids.projchev.fire("click"); assert.equal(g.isOpen(), true);
  g.ids.projname.fire("click");
  assert.equal(g.isOpen(), false); assert.equal(g.context.homeOpen, false); assert.equal(g.pill(), "wayside");
  // off Home the whole pill is one button for the list, the name included
  const h = fixture({ activeOwner: "wayside" });
  h.ids.projname.fire("click"); assert.equal(h.isOpen(), true); assert.equal(h.context.activeOwner, "wayside");
  h.ids.projname.fire("click"); assert.equal(h.isOpen(), false);
  // pressed from the keyboard, the pill itself opens the project
  const k = fixture({ homeOpen: true, activeOwner: "wayside" });
  k.ids.projpill.fire("click", { detail: 0 }); assert.equal(k.context.homeOpen, false);
});

test("on Home the project you came from is the pill's name, not a faint name; the faint names are the same on Home as on it", () => {
  for (const ow of ["facilitator", "moonbase", "alder-workshop", "wayside", "marlow"]) {
    const f = fixture({ activeOwner: ow }), off = f.suggestions();
    assert.ok(!off.includes(ow));
    f.context.setHome(true);
    assert.equal(f.pill(), ow);
    assert.deepEqual(f.suggestions(), off, ow);
    assert.ok(!f.suggestions().includes(ow), ow + " is shown twice on Home");
    assert.ok(f.suggestions().length <= 4);
  }
  // the project left before still leads, on Home as off it
  const g = fixture({ activeOwner: "wayside", store: { projleft: "facilitator" } });
  assert.equal(g.suggestions()[0], "facilitator");
  g.context.setHome(true); assert.equal(g.suggestions()[0], "facilitator"); assert.equal(g.pill(), "wayside");
  // a faint name on Home leaves it for that project, and the project came from is the one left
  g.ids.tabbar.children[0].fire("click");
  assert.equal(g.context.homeOpen, false); assert.equal(g.pill(), "facilitator"); assert.equal(g.store.get("projleft"), "wayside");
  assert.equal(g.suggestions()[0], "wayside");
});

test("leaving Home by the name, a faint name, a list row or Command + 1 to 9 takes the chevron away and names the project", () => {
  const home = over => { const f = fixture({ homeOpen: true, activeOwner: "wayside", ...over }); assert.equal(f.ids.projpill.classes.has("athome"), true); return f; };
  const gone = f => { assert.equal(f.context.homeOpen, false); assert.equal(f.ids.projpill.classes.has("athome"), false);
    assert.equal(f.ids.projchev.tabIndex, -1); assert.equal(f.ids.projchev.attributes["aria-hidden"], "true"); };
  // the name
  let f = home(); f.ids.projname.fire("click"); gone(f); assert.equal(f.pill(), "wayside");
  // a faint name
  f = home(); f.ids.tabbar.children[0].fire("click"); gone(f); assert.equal(f.pill(), "marlow"); assert.deepEqual(f.checked(), ["marlow"]);
  // a row of the list
  f = home(); f.ids.projchev.fire("click"); f.row("moonbase").fire("click");
  gone(f); assert.equal(f.pill(), "moonbase"); assert.equal(f.isOpen(), false);
  // the row of the project Home came from
  f = home(); f.ids.projchev.fire("click"); f.row("wayside").fire("click"); gone(f); assert.equal(f.pill(), "wayside");
  // Command + 1 to 9: the tab key's handler is setTab on the list's order
  f = home(); f.context.setTab(f.context.rowsOf(f.state)[1]); gone(f); assert.equal(f.pill(), "moonbase");
  // and the pill takes its bold again when that project holds a reply not yet read
  assert.equal(f.ids.projpill.classes.has("unread"), true);
  // arriving at Home brings it back
  f.context.setHome(true); assert.equal(f.ids.projpill.classes.has("athome"), true); assert.equal(f.pill(), "moonbase");
});

test("the chevron is a small down arrow inside the pill after the name, faded in on Home and out off it, with a hit area of its own", () => {
  const pill = html.match(/<button id="projpill"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.deepEqual([...pill.matchAll(/<(\w+)/g)].map(m => m[1]), ["span", "span", "svg", "path"], "the pill carries more than its name and the chevron");
  assert.match(pill, /^<span id="projname"><\/span><span id="projchev" /, "the chevron stands after the name");
  assert.doesNotMatch(html, /id="projico"|#projico/, "the house is gone from the pill");
  const chev = pill.match(/<span id="projchev"[^>]*>(<svg[\s\S]*?<\/svg>)<\/span>/)[1];
  assert.match(chev, /width="12" height="12"/); assert.match(chev, /stroke="currentColor"/); assert.match(chev, /aria-hidden="true"/);
  assert.match(chev, /<path d="m6 9 6 6 6-6"\/>/, "a down chevron");
  // it takes no room and is invisible off Home, and eases to its size and full opacity on Home, both ways
  const off = rule(sheet, "body.focus #projchev"), on = rule(sheet, "body.focus #projpill.athome #projchev");
  assert.equal(decl(off, "width"), "0"); assert.equal(decl(off, "opacity"), "0"); assert.equal(decl(off, "pointer-events"), "none");
  assert.equal(decl(on, "width"), "12px"); assert.equal(decl(on, "opacity"), "1"); assert.equal(decl(on, "pointer-events"), "auto");
  assert.equal(decl(on, "margin-left"), "6px");
  assert.match(decl(off, "transition"), /opacity \.22s/); assert.match(decl(off, "transition"), /width \.22s/);
  assert.equal(decl(off, "color"), "var(--sub)");
  assert.equal(decl(rule(sheet, "body.focus #projchev:hover"), "color"), "var(--ink)");
  // the hit area reaches the pill's top, bottom and right edge (14px of padding) and no further left than the name's end
  const hit = rule(sheet, "body.focus #projchev::before");
  assert.equal(decl(hit, "top"), "0"); assert.equal(decl(hit, "bottom"), "0");
  assert.equal(decl(hit, "right"), "-14px"); assert.ok(parseFloat(decl(hit, "left")) >= -6);
  // the pill's own height, padding, corners and type are as they were, and nothing is purple or a new colour
  const p = rule(sheet, "body.focus #projpill");
  assert.equal(decl(p, "height"), "32px"); assert.equal(decl(p, "padding"), "0 14px");
  assert.equal(decl(p, "border-radius"), "16px"); assert.equal(decl(p, "font"), "400 14px/17px var(--sans)");
  assert.match(sheet, /body\.focus #projpill\{[^}]*display:flex; align-items:center/);
  assert.doesNotMatch(off + on + hit, /#[0-9a-f]{3,6}\b|rgb|--accent/i);
});

test("the round glass Home button is back at the bar's left as it was, pressed while Home is up, and the list has no Home row", () => {
  const house = '<button id="homeico" class="qn-glass" type="button" title="Home" aria-label="Home" aria-pressed="false"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/></svg></button>';
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf("<!-- the pill's list"));
  assert.ok(bar.includes('<span id="tabrow">\n  ' + house + '\n  <button id="projpill"'), "the Home button is the bar's first piece, before the pill");
  assert.doesNotMatch(html, /id="projhome"|id="homesep"|#projhome|#homesep/, "a Home row is left in the list");
  const list = html.slice(html.indexOf('<div id="projmenu"'), html.indexOf("</div>\n", html.indexOf('<button id="projnew"')) + 7);
  assert.deepEqual([...list.matchAll(/id="(\w+)"/g)].map(m => m[1]), ["projmenu", "projlist", "projsep", "projnew"]);
  // its look: the 32px glass circle, the sub ink and the full ink under a pointer, 11px of glass gap to the pill
  const c = rule(sheet, "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn)");
  assert.equal(decl(c, "width"), "32px"); assert.equal(decl(c, "height"), "32px"); assert.equal(decl(c, "border-radius"), "50%");
  assert.equal(decl(c, "color"), "var(--sub)");
  assert.equal(decl(rule(sheet, "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn):hover"), "color"), "var(--ink)");
  assert.equal(parseFloat(decl(rule(sheet, "body.focus #tabrow"), "gap")), 11);
  // the press, and stays pressed while Home is up
  assert.match(sheet, /body\.focus :is\(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn, #projpill\)\.pressed\{transform:scale\(1\.06\)/);
  assert.match(sheet, /body\.focus\.home #homeico\{color:var\(--ink\); --qn-tint:\.95; --qn-edge:3\}/);
  assert.match(html, /for \(const btn of \["homeico", "projpill", "searchbtn", "chimebtn", "feedbackbtn", "setbtn"\]/);
  assert.match(html, /document\.getElementById\("homeico"\)\.setAttribute\("aria-pressed", String\(homeOpen\)\)/);
  // Command + 0 clicks it, and a press on it opens Home
  assert.match(html, /if \(!homeOpen\) document\.getElementById\("homeico"\)\.click\(\)/);
  assert.match(html, /document\.getElementById\("homeico"\)\.addEventListener\("click", \(\) => \{ if \(!homeOpen\) setHome\(true\); \}\)/);
});

test("a project's own window shows its name on a pill that opens nothing, and no faint names", () => {
  const f = fixture({ LOCKED: "wayside", activeOwner: "wayside" });
  assert.equal(f.pill(), "wayside"); assert.equal(f.ids.projpill.disabled, true);
  assert.deepEqual(f.suggestions(), []); f.open(); assert.equal(f.isOpen(), false);
});

test("the faint names: one order, unread first, then by most recent activity; the project just left moves to the front; at most 4", () => {
  const f = fixture(), s = (left, active = "marlow") => [...f.context.suggestedProjects(f.state, active, left)];
  // the order: marlow (unread, an hour), moonbase (unread, 2 days), alder-workshop (unread, 10 days),
  // then facilitator (a minute) and wayside (3 days), which hold nothing unread
  assert.deepEqual(s(null), ["moonbase", "alder-workshop", "facilitator", "wayside"]);
  assert.deepEqual(f.suggestions(), ["moonbase", "alder-workshop", "facilitator", "wayside"]);
  // the project just left moves to the front, whatever it holds, and the rest keep their order
  assert.deepEqual(s("wayside"), ["wayside", "moonbase", "alder-workshop", "facilitator"]);
  assert.deepEqual(s("facilitator"), ["facilitator", "moonbase", "alder-workshop", "wayside"]);
  assert.deepEqual(s("moonbase"), ["moonbase", "alder-workshop", "facilitator", "wayside"]);
  // never the open project, and never a closed one
  assert.deepEqual(s("marlow", "moonbase"), ["marlow", "alder-workshop", "facilitator", "wayside"]);
  f.state.tabs.closed = ["moonbase"];
  assert.deepEqual(s(null), ["alder-workshop", "facilitator", "wayside"]);
  assert.deepEqual(s("moonbase"), ["alder-workshop", "facilitator", "wayside"], "a closed project led, because it was just left");
  f.state.tabs.closed = [];
  // never more than 4, the newest unread first
  const now = Date.now() / 1000;
  for (const [i, ow] of ["p1", "p2", "p3", "p4", "p5"].entries())
    f.state.boxes.push({ id: ow + "c", owner: ow, ball: "you", replies: 1, agentTs: now - 100 * (i + 1), ts: 0 });
  assert.deepEqual(s("wayside"), ["wayside", "p1", "p2", "p3"]);
  assert.deepEqual(s(null), ["p1", "p2", "p3", "p4"]);
});

test("unread outranks recent activity, how many unread does not count, and a project never active comes last if there is room", () => {
  const now = Date.now() / 1000, day = 86400;
  const c = (id, owner, replies, at) => ({ id, owner, ball: "you", replies, agentTs: at, ts: 0 });
  const state = { projects: [], tabs: { order: ["a", "b", "c", "d", "e"], closed: [] }, boxes: [
    c("a1", "a", 0, now - day), c("b1", "b", 1, now - 20 * day), c("b2", "b", 1, now - 21 * day),
    c("c1", "c", 1, now - 9 * day), c("d1", "d", 0, now - 2 * day), c("e1", "e", 0, 0) ] };
  const f = fixture({ state, activeOwner: "a" });
  // c and b hold unread replies, c the more recent though b holds two; then d; e was never active
  assert.deepEqual([...f.context.suggestedProjects(state, "a", null)], ["c", "b", "d", "e"]);
  assert.deepEqual([...f.context.suggestedProjects(state, "a", "e")], ["e", "c", "b", "d"]);
  // reading c's reply moves it among the read ones, by its activity
  f.get("seenReplies.c1 = 1");
  assert.deepEqual([...f.context.suggestedProjects(state, "a", null)], ["b", "d", "c", "e"]);
});

test("a click on a faint name switches to it: it moves into the pill and the project left appears first beside it", () => {
  const f = fixture();
  assert.deepEqual(f.suggestions(), ["moonbase", "alder-workshop", "facilitator", "wayside"]);
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.context.activeOwner, "moonbase"); assert.equal(f.pill(), "moonbase");
  assert.equal(f.suggestions()[0], "marlow"); assert.equal(f.store.get("projleft"), "marlow");
  assert.deepEqual(f.checked(), ["moonbase"]);
  // and back again
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.pill(), "marlow"); assert.equal(f.suggestions()[0], "moonbase");
});

test("moving between two projects swaps only the open one and the one just left; the other names stay the same", () => {
  const f = fixture();
  // from marlow to facilitator, the third name, and back, twice
  f.ids.tabbar.children[2].fire("click");
  assert.equal(f.pill(), "facilitator");
  assert.deepEqual(f.suggestions(), ["marlow", "moonbase", "alder-workshop", "wayside"]);
  f.ids.tabbar.children[0].fire("click");
  assert.equal(f.pill(), "marlow");
  assert.deepEqual(f.suggestions(), ["facilitator", "moonbase", "alder-workshop", "wayside"]);
  f.ids.tabbar.children[0].fire("click");
  assert.deepEqual(f.suggestions(), ["marlow", "moonbase", "alder-workshop", "wayside"]);
  // and for every pair of projects, with more of them than the bar shows
  const now = Date.now() / 1000;
  for (const [i, ow] of ["p1", "p2", "p3"].entries())
    f.state.boxes.push({ id: ow + "c", owner: ow, ball: "you", replies: 0, ts: now - 7200 * (i + 1), agentTs: 0 });
  f.state.tabs.order.push("p1", "p2", "p3");
  const all = f.state.tabs.order, s = (active, left) => [...f.context.suggestedProjects(f.state, active, left)];
  for (const a of all) for (const b of all) {
    if (a === b) continue;
    const onA = s(a, b), onB = s(b, a);
    assert.equal(onA[0], b); assert.equal(onB[0], a);
    assert.deepEqual(onA.slice(1), onB.slice(1), a + " and " + b);
  }
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

test("\"Open a new folder\" opens the board's folder picker and lands on the new project, from Home too", async () => {
  const f = fixture({ homeOpen: true });
  f.open(); f.fresh.fire("click");
  assert.equal(f.isOpen(), false);
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(f.pickers.length, 1);
  assert.equal(f.pickers[0].kind, "panel");
  assert.equal(f.pickers[0].back, f.ids.projpill, "the focus goes back to the pill once the list has shut");
  assert.deepEqual(f.fetches.map(x => x.url), ["/project?name=garden"]);
  assert.equal(f.fetches[0].body, "/Users/me/garden");
  assert.doesNotMatch(html, /\/pickdir/);
  assert.equal(f.context.activeOwner, "garden"); assert.equal(f.store.get("activeproj"), "garden");
  assert.equal(f.context.homeOpen, false); assert.equal(f.store.get("projleft"), "marlow");
});

// ---- the home page's list (m1336): the pill's list without its box -----------
test("home's list holds the pill list's projects in its order and numbers, and a carry on either list moves both", () => {
  const f = fixture({ homeOpen: true });
  assert.deepEqual(f.homeNames(), f.names());
  assert.deepEqual(f.homeNumbers(), ["1", "2", "3", "4", "5"]);
  assert.equal(f.homeBox.style["--pnum"], "1ch", "the number column is as wide as the longest number");
  // a number, a name and the cross: no path, no box
  const r = f.homeRow("wayside");
  assert.deepEqual(r.children.map(c => c.className), ["homenum", "homename", "projx"]);
  assert.equal(r.querySelector(".homename").textContent, "wayside");
  assert.equal(r.querySelector(".homenum").attributes["aria-hidden"], "true");
  // the unread names take the bold in both
  const unread = rows => rows.filter(x => x.classes.has("unread")).map(x => x.dataset.owner);
  assert.deepEqual(unread(f.homeRows.children), unread(f.rows()));
  assert.ok(unread(f.homeRows.children).length > 0);
  // held on home and carried two rows down, as the pill's list carries
  const held = f.homeRow("facilitator");
  held.fire("mousedown", { clientX: 1100, clientY: 220 });
  f.win("mousemove", { clientX: 1100, clientY: 223 }); assert.equal(held.classes.has("lifted"), false, "under 5px is still a click");
  f.win("mousemove", { clientX: 1100, clientY: 305 });
  assert.equal(held.classes.has("lifted"), true); assert.equal(f.homeBox.classes.has("carrying"), true);
  assert.equal(f.homeRow("moonbase").style.transform, "translateY(-40px)");
  f.win("mouseup", { clientX: 1100, clientY: 305 }); held.fire("click");
  assert.deepEqual(f.writes.at(-1).order, ["moonbase", "alder-workshop", "facilitator", "wayside", "marlow"]);
  assert.equal(f.context.homeOpen, true, "the release is not a choice");
  assert.equal(f.homeBox.classes.has("carrying"), false);
  assert.deepEqual(f.homeNames(), ["moonbase", "alder-workshop", "facilitator", "wayside", "marlow"]);
  assert.deepEqual(f.names(), f.homeNames(), "the pill's list follows");
  assert.deepEqual(f.homeNumbers(), ["1", "2", "3", "4", "5"], "renumbered");
  // and carried in the pill's list, home follows
  f.place();
  f.row("marlow").fire("mousedown", { clientX: 100, clientY: 195 });
  f.win("mousemove", { clientX: 100, clientY: 60 }); f.win("mouseup", { clientX: 100, clientY: 60 });
  assert.deepEqual(f.names(), ["marlow", "moonbase", "alder-workshop", "facilitator", "wayside"]);
  assert.deepEqual(f.homeNames(), f.names());
});

test("the cross on a home row closes that project in both lists, and a project that arrives joins both", () => {
  const f = fixture({ homeOpen: true });
  const cross = f.homeRow("wayside").querySelector(".projx");
  assert.equal(cross.attributes["aria-label"], "close project");
  cross.fire("mousedown"); assert.equal(f.get("projCarry"), null, "the cross started a carry");
  cross.fire("click");
  assert.deepEqual(f.writes.at(-1).closed, ["wayside"]);
  assert.equal(f.homeRow("wayside"), undefined); assert.equal(f.row("wayside"), undefined);
  assert.equal(f.context.homeOpen, true, "closing a project the pill does not name stays on home");
  // the last project's cross is pale on home too
  for (const ow of ["facilitator", "moonbase", "alder-workshop"]) f.context.closeTab(ow);
  assert.equal(f.homeRow("marlow").querySelector(".projx").classes.has("off"), true);
  // a new project joins both under the next number
  const g = fixture({ homeOpen: true });
  g.state.boxes.push({ id: "g1", owner: "garden", bucket: "must", title: "g1", ball: "you", replies: 0, ts: 0, agentTs: 0 });
  g.state.tabs.order.push("garden"); g.context.validActiveOwnerIds.add("garden");
  g.context.renderTabs(g.state);
  assert.deepEqual(g.homeNames(), g.names()); assert.equal(g.homeNames().at(-1), "garden");
  assert.equal(g.homeNumbers().at(-1), "6");
});

test("a click on a home row opens its project, a row carried out opens its own window, and the folder row opens the picker", async () => {
  const f = fixture({ homeOpen: true });
  f.homeRow("wayside").querySelector(".homename").fire("click");
  assert.equal(f.context.activeOwner, "wayside"); assert.equal(f.context.homeOpen, false, "home is left for the project");
  // carried out past the list's edge it fades, and let go there it opens in a window of its own
  const t = fixture({ homeOpen: true });
  const held = t.homeRow("moonbase");
  held.fire("mousedown", { clientX: 1100, clientY: 260 });
  t.win("mousemove", { clientX: 1100, clientY: 270 });
  t.win("mousemove", { clientX: 900, clientY: 270 });
  assert.equal(held.classes.has("tearing"), true);
  t.win("mouseup", { clientX: 900, clientY: 270, screenX: 900, screenY: 400 });
  assert.equal(t.opens.length, 1); assert.equal(t.opens[0][0], "/?project=moonbase");
  assert.equal(t.writes.length, 0); assert.equal(t.context.homeOpen, true);
  // "+ Open a new folder" on home: the board's folder picker, the focus going back to it
  const g = fixture({ homeOpen: true });
  g.homeNew.fire("click");
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  assert.equal(g.pickers.length, 1); assert.equal(g.pickers[0].kind, "panel");
  assert.equal(g.pickers[0].back, g.homeNew, "the focus goes back to the folder row");
  assert.equal(g.context.activeOwner, "garden"); assert.equal(g.context.homeOpen, false);
});

test("the house, the pill and the right-hand circles keep their places: no plus, no lens, no row of names", () => {
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf("<!-- the pill's list"));
  const order = ["homeico", "projpill", "tabbar", "searchbtn", "chimebtn", "feedbackbtn", "setbtn"].map(id => bar.indexOf('id="' + id + '"'));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "the bar's order changed");
  assert.doesNotMatch(html, /installbtn|beforeinstallprompt|Install app/, "the install button is gone for good");
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

test("the pill is the name and the chevron, and the list's rows have no check mark", () => {
  const pill = html.match(/<button id="projpill"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert.deepEqual([...pill.matchAll(/<(\w+)/g)].map(m => m[1]), ["span", "span", "svg", "path"], "the pill carries more than its name and the chevron");
  assert.match(pill, /^<span id="projname"><\/span>/);
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
  const head = "body.focus :is(.bar .qn-glass, #projmenu){";
  assert.ok(sheet.includes(head), "the bar and the list share one stack");
  const rim = sheet.slice(sheet.indexOf(head));
  const stack = rim.slice(0, rim.indexOf("}"));
  assert.doesNotMatch(stack, /inset 0 1px 0 rgba\(255,255,255/, "the white first row over the ring");
  assert.doesNotMatch(stack, /inset 0 2px 0 rgba\(0,0,0/, "the dark band a row inside the ring");
  assert.match(stack, /inset 0 0 0 1px var\(--qn-ring\)/);
  // and that rule outranks the glass's own (an id beats the class)
  assert.match(tokens, /\.qn-glass\{\s*border:none;[^}]*inset 0 2px 0 rgba\(0,0,0,\.045\)/);
});

test("home's project list stands on the page with no box, and the new tab keeps its white well", () => {
  // the pill's list's rows without its glass (m1336): no box, fill, shadow or edge
  const markup = html.slice(html.indexOf('<nav id="homelist"'), html.indexOf("</nav>", html.indexOf('<nav id="homelist"')));
  assert.ok(markup.includes('<div id="homerows"></div>'));
  assert.doesNotMatch(markup, /qn-glass/);
  for (const selector of ["#homelistbox", "#homelist .homerow"]) {
    const r = rule(sheet, selector);
    assert.ok([undefined, "none"].includes(decl(r, "background")), selector + " has a fill");
    assert.ok([undefined, "none"].includes(decl(r, "border")), selector + " has an edge");
    assert.equal(decl(r, "box-shadow"), undefined, selector + " has a shadow");
  }
  assert.doesNotMatch(html, /getElementById\("(nppanel|npstart)"\)\?\.classList\.toggle\("qn-glass"/, "the new tab's picker takes no glass");
  // the white sunken well is the new tab's
  assert.match(sheet, /body:not\(\.home\) #nppanel\{background:#FFFFFF; border-radius:4px;\s*box-shadow:inset 0 1px 6px rgba\(60,45,20,\.14\), inset 0 0 0 1px rgba\(60,45,20,\.08\)\}/);
  assert.doesNotMatch(/\n  #nppanel\{([^}]*)\}/.exec(sheet)[1], /background|box-shadow|border-radius/);
});

test("home's list has a heading and a line over its projects, and its room is set by the logo and the limits, not by the number of projects", () => {
  // "Projects", its line, the rows, the line and the folder row, in that order
  const markup = html.slice(html.indexOf('<nav id="homelist"'), html.indexOf("</nav>", html.indexOf('<nav id="homelist"')));
  const order = ['<div id="homehead" aria-hidden="true">Projects</div>', '<div id="homeheadsep"></div>', '<div id="homerows"></div>',
    '<div id="homelistsep"></div>', '<button id="homenew"'].map(s => markup.indexOf(s));
  assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), "heading, line, rows, line, folder row: " + order);
  // the heading in the names' own face and size, the box's, which the rows
  // take too, in the semibold and the names' grey at rest
  const head = rule(sheet, "#homehead"), row = rule(sheet, "#homelist .homerow"), num = rule(sheet, "#homelist .homenum");
  assert.equal(decl(rule(sheet, "#homelistbox"), "font"), "400 var(--home-font)/calc(var(--home-font) * 17 / 14) var(--sans)");
  assert.equal(decl(row, "font"), "inherit");
  assert.equal(decl(head, "font"), undefined, "the heading sets no face or size of its own");
  assert.equal(decl(head, "font-size"), undefined);
  assert.equal(decl(head, "font-weight"), "600");
  assert.equal(decl(head, "color"), "color-mix(in srgb, var(--sub) 55%, transparent)");
  assert.equal(decl(head, "color"), decl(row, "color"), "the names' grey");
  // it starts where the names do: before it, a room as wide as the number
  // column, in the numbers' face, and the row's gap after it
  const before = rule(sheet, "#homehead::before");
  assert.equal(decl(before, "display"), "inline-block");
  assert.equal(decl(before, "width"), "var(--pnum, 1ch)");
  assert.equal(decl(before, "width"), decl(num, "width"));
  assert.equal(decl(before, "margin-right"), decl(row, "gap"));
  assert.equal(decl(before, "font"), "400 calc(var(--home-font) * 14.6 / 14) var(--mono)");
  assert.ok(decl(num, "font").startsWith("400 calc(var(--home-font) * 14.6 / 14)/") && decl(num, "font").endsWith(" var(--mono)"),
    "the number column's face: " + decl(num, "font"));
  // both lines the charts' line, 1px of the line colour at the group's scale
  assert.match(sheet, /#homelimits:not\(\[hidden\]\)::before\{[^}]*height:1px; background:var\(--line\)/);
  const lines = rule(sheet, "#homeheadsep, #homelistsep");
  assert.equal(decl(lines, "height"), "calc(1px * var(--home-t, 1))");
  assert.equal(decl(lines, "background"), "var(--line)");
  // the box fills its part between the top and foot homeFit sets, no longer
  // capped or centred, and the rows take the room between the lines from its top
  const box = rule(sheet, "#homelistbox");
  assert.equal(decl(box, "flex"), "1 1 0");
  assert.match(decl(box, "margin"), /^var\(--home-list-top, 0px\) .* var\(--home-list-foot, 0px\) 0$/);
  assert.equal(decl(box, "max-height"), undefined, "no cap on the list's height");
  assert.equal(decl(rule(sheet, "body.focus.home #homelist"), "justify-content"), undefined, "the list is not centred");
  assert.equal(decl(rule(sheet, "#homerows"), "flex"), "1 1 0");
  // homeFit sets the top from the logo's word and the foot from the last "Last updated" line, both as drawn
  const fit = between("function homeFit(){", "// fitted on the frame");
  assert.match(fit, /homeSet\(homeListPart, "--home-t", t, ""\)/);
  assert.match(fit, /homeInk\(document\.getElementById\("homebrandname"\), t\)/);
  assert.match(fit, /homePair\.querySelectorAll\("\.tk-updated, \.lm-updated"\)\]\.map\(el => homeInk\(el, t\)\)\.filter\(Boolean\)\.pop\(\)/);
  assert.match(fit, /homeSet\(homeListPart, "--home-list-top", /);
  assert.match(fit, /homeSet\(homeListPart, "--home-list-foot", /);
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
test("the magnifier, the speaker, the bug and the squid stand the house's gap to the pill apart, and the squid the house's inset from its edge", () => {
  const houseToPill = parseFloat(decl(rule(sheet, "body.focus #tabrow"), "gap"));
  const barGap = parseFloat(decl(rule(sheet, "body.focus .bar"), "gap"));
  const squid = parseFloat(decl(rule(sheet, "body.focus .bar :is(#chimebtn, #feedbackbtn, #setbtn)"), "margin-left"));
  assert.equal(barGap + squid, houseToPill, "magnifier to speaker to bug to squid is not house to pill");
  assert.equal(houseToPill, 11);
  // the bar is inset the same on both sides and has no side padding, so the squid is as far from the right
  // edge as the house is from the left
  assert.match(sheet, /body\.focus \.bar\{\s*margin:var\(--app-inset\) var\(--app-inset\) 0;/);
  assert.equal(decl(rule(sheet, "body.focus .bar"), "padding"), "1px 0 6px");
  // the squid is the bar's last piece, and the magnifier, just before the speaker, holds the right end's
  // run with an auto margin
  const bar = html.slice(html.indexOf('<div class="bar">'), html.indexOf("<!-- the pill's list"));
  assert.ok(bar.lastIndexOf('id="setbtn"') > bar.lastIndexOf('id="chimebtn"'));
  assert.ok(bar.lastIndexOf('id="chimebtn"') > bar.lastIndexOf('id="searchbtn"'));
  assert.equal(decl(rule(sheet, "body.focus .bar #searchbtn"), "margin-left"), "auto");
});
