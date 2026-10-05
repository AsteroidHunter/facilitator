// Run the phone's actual key listeners, pill handler, project selection and
// ticket filtering in a VM. Only DOM painting/editor work is replaced; no
// browser, server or phone is used. PHONE_HOTKEY_SOURCE supports an old-source
// run without replacing the working tree's m.html.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ROOT = path.resolve(__dirname, "..");
const html = readFileSync(process.env.PHONE_HOTKEY_SOURCE || path.join(ROOT, "m.html"), "utf8");
const logic = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");

function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source block ${start}`);
  return html.slice(a, b);
}
function element(classes = []) {
  const set = new Set(classes);
  return {
    dataset: {}, listeners: {},
    classList: {
      contains: name => set.has(name), add: name => set.add(name), remove: name => set.delete(name),
      toggle(name, on) { if (on) set.add(name); else set.delete(name); },
    },
    setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
    closest() { return null; }, contains() { return false; },
  };
}
function fixture({ menu = "tickets", selected = "a1", browsing = false, projectsOpen = false } = {}) {
  const listeners = [], store = new Map(), read = [], calls = [];
  const document = { body: element(menu ? ["menuout"] : []), addEventListener() {} };
  if (projectsOpen) document.body.classList.add("projopen");
  document.activeElement = document.body;
  const nodes = Object.fromEntries(["pane", "tickets", "settings", "projbtn", "projmenu", "tiksheet", "tv-todo", "tv-docked", "tv-deferred", "tv-done"]
    .map(id => [id, element(id === menu ? ["open"] : [])]));
  const panes = Object.fromEntries(["todo", "docked", "deferred", "done"].map(view => [view, { rows: [] }]));
  nodes.tiksheet.querySelector = selector => panes[/data-view="([^"]+)"/.exec(selector)[1]];
  document.getElementById = id => nodes[id];
  document.querySelectorAll = () => Object.values(panes).flatMap(p => p.rows);
  const boxes = [
    { id: "a1", owner: "alpha" }, { id: "a2", owner: "alpha" },
    { id: "b1", owner: "beta" }, { id: "b2", owner: "beta", parked: true },
    { id: "b3", owner: "beta", done: true }, { id: "h1", owner: "hidden" },
  ].map(b => ({ bucket: "meta", replies: 0, ...b }));
  const els = Object.fromEntries(boxes.map(b => [b.id, { box: element(b.id === selected ? ["sel"] : []) }]));
  const context = vm.createContext({ macHost: null, Date, setTimeout, clearTimeout, document,
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    addEventListener(type, fn) { if (type === "keydown") listeners.push(fn); },
  });
  vm.runInContext(logic, context);
  Object.assign(context, {
    phoneDeveloperMode: false, saveDiagnostic: source => calls.push(["diagnostic", source]),
    els, selectedId: selected, shownId: selected, browsing, activeOwner: "alpha", homeOpen: false, hist: null, phoneEnterAgain: null,
    lastSel: { alpha: selected, beta: "b2" }, validOwners: new Set(["alpha", "beta", "hidden", "empty"]),
    lastState: { boxes, projects: [{ id: "empty" }], tabs: { order: ["alpha", "hidden", "beta", "empty"], closed: ["hidden"] } },
    tickets: nodes.tickets, settings: nodes.settings, projBtn: nodes.projbtn, projMenu: nodes.projmenu,
    ensureCard: id => els[id], markSeen: id => read.push(id),
    tracePhone() {}, endPhoneTrace() {}, cancelAutoNext() {}, syncPhoneHistory() {}, wearEditor() {},
    openAtHead() {}, seatScroll() {}, renderTabs() {}, reachLater() {}, endProjCarry() {}, syncSpinner() {},
    menuOut: () => menu ? nodes[menu] : null,
    drawerOpen: () => nodes.tickets.classList.contains("open"),
    setHome: on => { context.homeOpen = on; },
    paintPhonePane(pane, pool) {
      pane.rows = pool.map(b => Object.assign(element(b.id === context.selectedId ? ["on"] : []), { dataset: { id: b.id } }));
      return false;
    },
    moveTicketSheet(view) { vm.runInContext(`tikShownView = ${JSON.stringify(view)}`, context); },
    // apply's project-switch responsibility: redraw the list. The real
    // renderTickets below chooses every project's rows and remembered view.
    apply(state) { calls.push("apply"); context.renderTickets(state); },
  });
  const run = source => vm.runInContext(source, context);
  run(between("function menuAvailable(panel){", "function syncMenuAvailability(){"));
  run(between("function setBrowsing(on){", "// ---- the project's capsule"));
  run(between("function projOpen(){", "// the list's own taps."));
  run(between('projMenu.addEventListener("click", e => {', 'document.getElementById("projshade")'));
  context.house = element(); context.projCarried = false;
  run(between("function ticketsShown(){", "// each button writes the view"));
  run(between("const phoneShortcutTyping =", "// a tap anywhere on the card on screen"));
  run(between('addEventListener("keydown", e => {\n  dispatchCardShortcut(e, homeOpen', "// releases, other keys"));
  run('setTicketViewOf("beta", "deferred"); renderTickets(lastState);');
  const snapshot = () => ({ home: context.homeOpen, owner: context.activeOwner, selected: context.selectedId, browsing: context.browsing,
    drawer: context.drawerOpen(), projects: context.projOpen(), view: run("curView()"),
    rows: Object.fromEntries(Object.entries(panes).map(([view, p]) => [view, p.rows.map(r => r.dataset.id)])),
    highlighted: Object.values(panes).flatMap(p => p.rows.filter(r => r.classList.contains("on")).map(r => r.dataset.id)),
    read: [...read], storedProject: store.get("activeproj") ?? null, calls: [...calls] });
  return { context, run, snapshot,
    pill(owner) {
      const row = { dataset: { owner } };
      nodes.projmenu.listeners.click({ target: { closest: () => row } });
    },
    key(key, extra = {}) {
      const e = { key, code: `Digit${key}`, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
        target: document.body, defaultPrevented: false, repeat: false, isComposing: false,
        preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
      for (const listener of listeners) { listener(e); if (e.stopped) break; }
      return e;
    },
  };
}

test("Command+number with the ticket drawer open matches the pill's project, list, card and popover state", () => {
  for (const projectsOpen of [false, true]) {
    const key = fixture({ projectsOpen }), pill = fixture({ projectsOpen });
    pill.pill("beta");
    const event = key.key("2");
    assert.equal(event.defaultPrevented, true, "Command+2 was swallowed without switching projects");
    assert.deepEqual(key.snapshot(), pill.snapshot());
    const result = key.snapshot();
    assert.equal(result.owner, "beta", "closed tabs must not consume a number");
    assert.equal(result.drawer, true);
    assert.equal(result.projects, false);
    assert.equal(result.view, "deferred");
    assert.equal(result.selected, "b2", "restore the project's previous card");
    assert.equal(result.browsing, true);
    assert.deepEqual(result.rows, { todo: ["b1"], docked: [], deferred: ["b2"], done: ["b3"] });
    assert.deepEqual(result.highlighted, ["b2"]);
    assert.deepEqual(result.read, []);
  }
});

test("Command+number on the current project matches the pill's unselect and already-browsing paths", () => {
  for (const browsing of [false, true]) {
    const key = fixture({ browsing, projectsOpen: true }), pill = fixture({ browsing, projectsOpen: true });
    pill.pill("alpha");
    key.key("1");
    assert.deepEqual(key.snapshot(), pill.snapshot());
    assert.equal(key.snapshot().browsing, true);
    assert.equal(key.snapshot().selected, "a1");
    assert.equal(key.snapshot().drawer, true);
  }
});

test("Command+number switches to an empty project exactly as the pill does", () => {
  const key = fixture(), pill = fixture();
  pill.pill("empty"); key.key("3");
  assert.deepEqual(key.snapshot(), pill.snapshot());
  assert.equal(key.snapshot().selected, null);
  assert.equal(key.snapshot().owner, "empty");
  assert.deepEqual(key.snapshot().rows, { todo: [], docked: [], deferred: [], done: [] });
});

test("the closed drawer keeps its existing current-project and other-project shortcut behavior", () => {
  const f = fixture({ menu: null, selected: "a2", projectsOpen: true });
  assert.equal(f.key("1").defaultPrevented, true);
  assert.equal(f.snapshot().selected, "a2");
  assert.equal(f.snapshot().browsing, false, "the closed-drawer key must not unselect like the pill");
  assert.equal(f.snapshot().projects, true, "closed-drawer shortcuts must retain their previous popover behavior");
  assert.equal(f.key("2").defaultPrevented, true);
  assert.equal(f.snapshot().owner, "beta");
  assert.equal(f.snapshot().selected, "b2");
  assert.equal(f.snapshot().drawer, false);
});

test("settings, missing state and unavailable numbers do not switch projects", () => {
  for (const opts of [{ menu: "settings" }, { menu: "settings", home: true }, { missing: true }, { number: "9" }, { number: "0" }]) {
    const f = fixture(opts);
    if (opts.home) f.context.homeOpen = true;
    if (opts.missing) f.context.lastState = null;
    const before = f.snapshot();
    assert.equal(f.key(opts.number || "2").defaultPrevented, false);
    assert.deepEqual(f.snapshot(), before, JSON.stringify(opts));
  }
});

test("Control+Shift+M is inert and propagates while off in Home, either drawer and the card", () => {
  for (const menu of [null, "tickets", "settings"]) {
    for (const home of [false, true]) {
      const f = fixture({ menu }); f.context.homeOpen = home;
      const before = f.snapshot();
      const event = f.key("M", { metaKey: false, ctrlKey: true, shiftKey: true });
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.stopped, undefined);
      assert.deepEqual(f.snapshot(), before);
      f.context.phoneDeveloperMode = true;
      const enabled = f.key("M", { metaKey: false, ctrlKey: true, shiftKey: true });
      assert.equal(enabled.defaultPrevented, true);
      assert.deepEqual(f.snapshot().calls.at(-1), ["diagnostic", "shortcut"]);
    }
  }
});

for (const [number, owner, selected] of [["1", "alpha", "a1"], ["2", "beta", "b2"], ["3", "empty", null]]) {
  test(`Command+${number} on phone Home opens ${owner} exactly like its pill row`, () => {
    for (const projectsOpen of [false, true]) {
      for (const embedded of [false, true]) {
        const key = fixture({ menu: null, projectsOpen }), pill = fixture({ menu: null, projectsOpen });
        for (const f of [key, pill]) {
          f.context.homeOpen = true;
          f.context.macHost = embedded ? {} : null;
          f.context.parent = { macPhoneProject: null };
        }
        pill.pill(owner);
        assert.equal(key.key(number).defaultPrevented, true);
        assert.deepEqual(key.snapshot(), pill.snapshot());
        assert.equal(key.snapshot().home, false);
        assert.equal(key.snapshot().owner, owner);
        assert.equal(key.snapshot().selected, selected);
        assert.equal(key.snapshot().projects, false);
        assert.deepEqual(key.snapshot().read, []);
      }
    }
  });
}

test("phone Home leaves missing state, unavailable numbers and card commands alone", () => {
  for (const opts of [{ missing: true }, { number: "9" }, { number: "0" },
    { number: "t" }, { number: "ArrowLeft", metaKey: false }]) {
    const f = fixture({ menu: null }); f.context.homeOpen = true;
    if (opts.missing) f.context.lastState = null;
    const before = f.snapshot();
    assert.equal(f.key(opts.number || "2", { metaKey: opts.metaKey ?? true }).defaultPrevented, false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("phone Home in a locked Mac frame numbers only its allowed project", () => {
  const f = fixture({ menu: null });
  Object.assign(f.context, { homeOpen: true, macHost: {}, parent: { macPhoneProject: "beta" } });
  assert.equal(f.key("2").defaultPrevented, false);
  assert.equal(f.snapshot().home, true);
  assert.equal(f.key("1").defaultPrevented, true);
  assert.equal(f.snapshot().home, false);
  assert.equal(f.snapshot().owner, "beta");
});
