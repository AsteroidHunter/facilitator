// The PWA's real row click handler and tap clock, with no browser or board.
// Touch clicks may all have detail=1 and need not emit dblclick.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

function fixture() {
  let now = 0, open = true;
  const calls = [];
  const context = vm.createContext({
    selectedId: "old", activeOwner: "p1", view: "todo", homeOpen: false,
    performance: { now: () => now },
    curView: () => context.view,
    drawerOpen: () => open,
    closeDrawer: () => { calls.push(["close"]); open = false; },
    select: id => { calls.push(["select", id]); context.selectedId = id; },
    setHome: on => { context.homeOpen = on; calls.push(["home", on]); },
    onFold: (row, e) => !!e.fold,
    unfoldTicket: id => calls.push(["unfold", id]),
    appendOmniRowArt() {},
    h(tag, cls, text) {
      return { tagName: tag, className: cls, textContent: text, children: [], dataset: {}, listeners: {},
        appendChild(el) { this.children.push(el); },
        addEventListener(type, fn) { this.listeners[type] = fn; } };
    },
  });
  vm.runInContext(html.slice(html.indexOf("const ROW_MARKS ="), html.indexOf("function ticketsShown(){")), context);
  const makeRow = vm.runInContext("phoneRow", context);
  const rows = Object.fromEntries(["a", "b"].map(id => [id, makeRow({ id, title: id }, 0, "", "")]));
  return {
    calls, context, rows,
    tick: ms => { now += ms; },
    opened: () => open,
    tap: (id, extra = {}) => rows[id].row.listeners.click({ detail: 1, ...extra }),
    reopen: () => {
      // runMenu clears this on either an open or a close, including a swipe.
      assert.match(html, /function runMenu\(panel, v, release, speed = 0\)\{\s*lastTicketTap = null;/);
      vm.runInContext("lastTicketTap = null", context);
      open = true;
    },
  };
}

test("the first PWA ticket tap selects synchronously and leaves the list open", () => {
  const f = fixture();
  f.tap("a");
  assert.equal(f.context.selectedId, "a");
  assert.equal(f.opened(), true);
  assert.deepEqual(f.calls, [["select", "a"]]);
  f.tick(1000);
  assert.equal(f.opened(), true, "a single tap must not close later");
});

test("two touch clicks on the same ticket select and close without relying on dblclick or click detail", () => {
  const f = fixture();
  f.tap("a"); f.tick(180); f.tap("a");
  assert.equal(f.context.selectedId, "a");
  assert.equal(f.opened(), false);
  assert.deepEqual(f.calls, [["select", "a"], ["select", "a"], ["close"]]);
});

test("a second ticket tap must be under 300ms, and a late tap starts its own pair", () => {
  for (const elapsed of [299, 300, 800]) {
    const f = fixture();
    f.tap("a"); f.tick(elapsed); f.tap("a");
    assert.equal(f.opened(), elapsed >= 300, "elapsed " + elapsed);
    if (f.opened()) { f.tick(100); f.tap("a"); assert.equal(f.opened(), false); }
  }
});

test("tapping different tickets quickly never combines into a double tap", () => {
  const f = fixture();
  f.tap("a"); f.tick(50); f.tap("b"); f.tick(50); f.tap("a");
  assert.equal(f.opened(), true);
  assert.equal(f.context.selectedId, "a");
  assert.equal(f.calls.filter(c => c[0] === "close").length, 0);
});

test("the folded corner keeps its unfold action and cancels any earlier ticket tap", () => {
  const f = fixture();
  f.rows.a.marks = 1 << 5;
  f.tap("a"); f.tick(50); f.tap("a", { fold: true }); f.tick(50); f.tap("a");
  assert.equal(f.opened(), true);
  assert.deepEqual(f.calls, [["select", "a"], ["unfold", "a"], ["select", "a"]]);
  f.tick(100); f.tap("a");
  assert.equal(f.opened(), false);
});

test("another project, section or selected card breaks the ticket tap pair", () => {
  for (const [key, value] of [["activeOwner", "p2"], ["view", "done"], ["selectedId", "b"]]) {
    const f = fixture();
    f.tap("a"); f.tick(50); f.context[key] = value; f.tap("a");
    assert.equal(f.opened(), true, key);
  }
});

test("reopening the drawer starts a fresh tap pair", () => {
  const f = fixture();
  f.tap("a"); f.tick(50); f.reopen(); f.tap("a");
  assert.equal(f.opened(), true);
  f.tick(50); f.tap("a");
  assert.equal(f.opened(), false);
});

test("a ticket picked from home still selects immediately and a second tap closes", () => {
  const f = fixture();
  f.context.homeOpen = true;
  f.tap("a");
  assert.deepEqual(f.calls, [["home", false], ["select", "a"]]);
  f.tick(100); f.tap("a");
  assert.equal(f.opened(), false);
});

test("ticket rows allow pans and clicks while ancestors constrain page zoom", () => {
  assert.match(html, /\.trow\{[^}]*touch-action:manipulation;/);
});
