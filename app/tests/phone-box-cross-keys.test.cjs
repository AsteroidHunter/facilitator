// The phone's magic box cross and the keys. With the box out, Tab stays in the
// drawer (keepTabInMenu), and the cross was the one place in it a Tab could
// land: a Tab to get back to the reply box put the keys on the cross, and the
// next space or return pressed it, so POST /magic/close shut the box on the
// board with the cross never seen or touched. Control + Shift + period then
// only dipped the card, and a fresh open had no box, since the board had none.
//
// The page is m.html's own box setup (from PB to the cross's click) and its own
// keepTabInMenu, run in a vm over a drawer that holds the box's cross. No
// browser and no board.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const html = readFileSync(path.resolve(__dirname, "..", "m.html"), "utf8");
const between = (from, to) => {
  const at = html.indexOf(from);
  assert.ok(at >= 0, `m.html has no ${from}`);
  return html.slice(at, html.indexOf(to, at));
};

// the drawer out with the box's face: the cross and, at the bar's other end, the
// green button that expands the box are the only controls on show
function page(){
  const body = { tagName: "BODY" };
  const doc = { activeElement: body };
  const closes = [];
  const button = () => {
    const b = {
      tagName: "BUTTON", tabIndex: 0, disabled: false, hidden: false, listeners: {},
      getClientRects: () => [{}],
      focus(){ doc.activeElement = b; },
      addEventListener(type, fn){ b.listeners[type] = fn; },
    };
    return b;
  };
  const cross = button(), grow = button();
  const face = { querySelector: s => s === ".mbclose" ? cross : s === ".mbgrow" ? grow : null };
  const drawer = { querySelectorAll: () => [grow, cross] };
  doc.getElementById = id => id === "mbface" ? face : null;
  const ctx = vm.createContext({
    document: doc, menuOut: () => drawer, magicView: () => ({}),
    phoneMagicFit(){}, phoneMagicClose: () => closes.push(1),
  });
  vm.runInContext(
    between("const PB = {", "// the card the box belongs to, or null") +
    between("function keepTabInMenu(e){", "\naddEventListener(") +
    "\nglobalThis.probe = { keepTabInMenu };", ctx);
  const tab = shiftKey => {
    const e = { shiftKey, prevented: false, preventDefault(){ e.prevented = true; } };
    ctx.probe.keepTabInMenu(e);
    return e;
  };
  return { doc, cross, grow, closes, tab };
}

test("Tab with the box out never puts the keys on its cross, or on the button that expands it", () => {
  const p = page();
  for (const shift of [false, true, false]){
    const e = p.tab(shift);
    assert.notEqual(p.doc.activeElement, p.cross, `${shift ? "Shift+Tab" : "Tab"} put the keys on the box's cross`);
    assert.notEqual(p.doc.activeElement, p.grow, `${shift ? "Shift+Tab" : "Tab"} put the keys on the box's expand button`);
    assert.ok(e.prevented, "Tab left the drawer for the card behind it");
  }
  assert.equal(p.grow.tabIndex, -1);
});

test("a tap on the cross still puts the box away", () => {
  const p = page();
  assert.equal(typeof p.cross.listeners.click, "function");
  p.cross.listeners.click();
  assert.equal(p.closes.length, 1);
});

test("the page asks for the playback audio session, so the box pages' sounds play through silent mode", () => {
  assert.match(html, /if \(navigator\.audioSession\) navigator\.audioSession\.type = "playback";/);
});
