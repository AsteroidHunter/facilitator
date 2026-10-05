// Source and VM checks only: use the shipped button construction and click
// handler, with no browser, server, folder picker or network access.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function between(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing source block: ${start}`);
  return html.slice(a, b);
}

function fixture(homeOpen = false) {
  const calls = [], classes = new Set(), events = {};
  const context = vm.createContext({
    homeOpen, activeOwner: "garden", lastState: { projects: { garden: {} } },
    document: { body: { offsetWidth: 1000, classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
    } } },
    h(tag, className) {
      return { tagName: tag, className, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, handler) { (events[type] ||= []).push(handler); },
        click() { for (const handler of events.click || []) handler(); },
      };
    },
    setHome(value) { context.homeOpen = value; calls.push("home"); },
    renderHome() { calls.push("renderHome"); },
    renderTabs() { calls.push("renderTabs"); },
    apply() { calls.push("apply"); },
  });
  vm.runInContext(between('const tabPlus = h(', '// ---- the press on the bar'), context);
  vm.runInContext(between('const DRAFT = "__new__";', '// the picker\'s panel'), context);
  return { button: vm.runInContext("tabPlus", context), context, calls, classes,
    get: code => vm.runInContext(code, context) };
}

test("the plus is a bare native button with its original icon and accessible name", () => {
  const { button } = fixture();
  assert.equal(button.tagName, "button"); assert.equal(button.type, "button");
  assert.equal(button.className, "ptabplus", "the permanent glass material returned");
  assert.equal(button.title, "new project tab");
  assert.equal(button.attributes["aria-label"], "new project tab");
  assert.equal(button.attributes.tabindex, undefined, "native keyboard focus was overridden");
  assert.equal(button.innerHTML, '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>');
  const bare = html.match(/body\.focus #tabbar \.ptabplus\{([^}]+)\}/)[1];
  for (const property of ["background", "border", "box-shadow"])
    assert.match(bare, new RegExp(`${property}:none(?:;|$)`), `${property} still paints a circle`);
});

test("the plus keeps its hit area, centering, hover ink and press feedback", () => {
  const controls = html.match(/body\.focus :is\(#homeico, #chimebtn, #setbtn, #tabbar \.ptabplus\)\{([^}]+)\}/)[1];
  for (const value of ["width:32px", "height:32px", "margin:0", "padding:0", "align-items:center", "justify-content:center"])
    assert.ok(controls.includes(value), `the plus lost ${value}`);
  assert.match(html, /body\.focus #tabbar \.ptabplus\{[^}]*color:color-mix\(in srgb, var\(--ink\) 75%, transparent\)/);
  assert.match(html, /body\.focus #tabbar \.ptabplus:hover\{color:var\(--ink\)\}/);
  assert.match(html, /:is\(#chimebtn, #setbtn, #tabbar \.ptabplus\)\.pressed\{transform:scale\(1\.06\)/);
});

for (const homeOpen of [false, true]) {
  test(`clicking the bare plus from ${homeOpen ? "Home" : "a project"} opens a new project tab`, () => {
    const f = fixture(homeOpen);
    assert.equal(f.get("draft"), null);
    f.button.click(); // exercise the actual registered listener and plusClick
    assert.equal(f.context.activeOwner, "__new__");
    assert.equal(f.get("draft.screen"), "home");
    assert.equal(f.get("draft.from"), "garden");
    assert.equal(f.context.homeOpen, false);
    assert.equal(f.classes.has("choosing"), true);
    assert.deepEqual(f.calls, [...(homeOpen ? ["home"] : []), "renderHome", "renderTabs", "apply"]);
    // A real project is registered only after a folder is picked. The plus
    // starts the existing draft flow without registering a half-made lane.
    assert.deepEqual(Object.keys(f.context.lastState.projects), ["garden"]);
  });
}

test("the plus and folder choice create and select the new project", async () => {
  const f = fixture(true), requests = [], saved = [], startEvents = {};
  const start = {
    addEventListener(type, handler) { startEvents[type] = handler; },
    click() { return startEvents.click(); },
  };
  f.context.document.getElementById = id => {
    assert.equal(id, "npstart"); return start;
  };
  f.context.allRowsOf = state => Object.keys(state.projects);
  f.context.fetch = async (url, options) => {
    requests.push({ url, method: options?.method || "GET", body: options?.body });
    if (url === "/pickdir") return { status: 200, json: async () => ({ path: "/fixture/New Project/" }) };
    assert.equal(url, "/project?name=New%20Project");
    return { ok: true, json: async () => ({ id: "new-project" }) };
  };
  f.context.localStorage = { setItem(key, value) { saved.push([key, value]); } };
  f.context.poll = async () => {
    assert.equal(f.get("draft"), null);
    assert.equal(f.context.activeOwner, "new-project");
    f.calls.push("poll");
  };
  vm.runInContext(between("const homePick =", "// ---- the home page"), f.context);
  f.button.click();
  await start.click();
  assert.deepEqual(requests, [
    { url: "/pickdir", method: "GET", body: undefined },
    { url: "/project?name=New%20Project", method: "POST", body: "/fixture/New Project" },
  ]);
  assert.deepEqual(saved, [["activeproj", "new-project"]]);
  assert.equal(f.context.activeOwner, "new-project");
  assert.equal(f.get("draft"), null);
  assert.equal(f.classes.has("choosing"), false);
  assert.equal(f.context.homeOpen, false);
  assert.deepEqual(f.calls, ["home", "renderHome", "renderTabs", "apply", "poll"]);
});
