// The faint plus under the Mac board's open card makes a new card exactly as
// Command + T does: its click is the very function the key's action calls
// (newCardHere in index.html). The Mac page's key handlers and that function
// are cut out of index.html as shipped (see hotkey-pages.cjs) and run over
// card-logic.js as shipped; only the card's making (newCard) is a spy. The plus
// stands two ticket gaps under the card's foot, at a third of its strength, and
// takes the names' press; the ticket list has neither a line nor a plus at its
// foot any more. seatCardPlus, which says where the card's foot and middle are,
// is cut out of index.html and run over stubs. No browser, no board, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage, between } = require("./hotkey-pages.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PHONE = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
const rule = (text, head) => between(text, head, "}").slice(head.length).replace(/\s+/g, " ").trim();

// the Mac page with the plus wired as the page wires it
function board() {
  const f = macPage();
  const plus = f.doc.make("button", f.doc.body, { id: "cardplus" });
  vm.runInContext(between(MAC, "const PLUS_ICON = ", "\n").replace(/^const/, "var"), f.ctx);
  vm.runInContext(between(MAC, "const cardPlus = ", "\n\n"), f.ctx, { filename: "index.html" });
  f.plus = plus;
  f.click = () => {
    f.calls.length = 0;
    for (const l of plus.listeners.filter(l => l.type === "click")) l.fn({ type: "click", target: plus, button: 0 });
    return f.calls.map(c => c.join(" "));
  };
  return f;
}

test("the plus's click is the function Command + T's action calls", () => {
  const f = board();
  const clicks = f.plus.listeners.filter(l => l.type === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].fn, f.ctx.newCardHere, "the plus listens with newCardHere itself");
  const create = between(MAC, "  create(e){\n    e.preventDefault();\n    newCardHere();", "},");
  assert.ok(create, "the board's Command + T action calls newCardHere");
  assert.equal((MAC.match(/newCard\(activeOwner\)/g) || []).length, 1, "the open project's new card is made in one place");
});

test("a click and Command + T make the same card in the same project", () => {
  const keyed = board().press("board", "cmd+t");
  assert.deepEqual(keyed.calls, ["create one"]);
  assert.deepEqual(board().click(), keyed.calls);
});

test("where Command + T makes nothing, the plus makes nothing", () => {
  const held = {
    "a new tab choosing its folder": f => { f.ctx.draft = { screen: "home", from: "one" }; },
    "the project not ready": f => { f.ctx.ownerReady = false; },
  };
  for (const [name, hold] of Object.entries(held)) {
    const keyed = board(), clicked = board();
    hold(keyed); hold(clicked);
    assert.deepEqual(keyed.press("board", "cmd+t").calls, [], name);
    assert.deepEqual(clicked.click(), [], name);
  }
});

test("the plus is the board's plus on no glass, with its label, at a third of its strength", () => {
  const f = board();
  assert.equal(f.plus.innerHTML, f.ctx.PLUS_ICON, "the typing box's plus, as drawn");
  assert.match(MAC, /<\/main>\n<button id="cardplus" class="off" type="button" title="New card" aria-label="New card"><\/button>\n/, "a bare button after the card, off until a card is on screen");
  const own = rule(MAC, "  body.focus #cardplus{");
  assert.match(own, /position:fixed;/);
  assert.match(own, /background:transparent;/);
  assert.match(own, /border:1px solid transparent;/);
  assert.match(own, /opacity:\.33;/);
  assert.match(own, /color:var\(--sub\);/);
  assert.doesNotMatch(own, /backdrop-filter|box-shadow|transform|qn-/);
  assert.equal(rule(MAC, "  body.focus #cardplus:hover{"), "color:var(--ink)");
  // a 16px mark with 11px of ink in a 1.77px stroke
  assert.match(rule(MAC, "  body.focus #cardplus svg{"), /width:16px; height:16px; stroke-width:2.66$/);
  // none of the bar's glass: its stack, its zoom rule, its press and its press list
  assert.match(MAC, /body\.focus :is\(\.bar \.qn-glass, #projmenu\), body\.focus\.home :is\(#nppanel, #npstart\)\.qn-glass\{/);
  assert.match(MAC, /body\.p3zoom \.bar \.qn-glass\{backdrop-filter:none; -webkit-backdrop-filter:none\}/);
  assert.match(MAC, /body\.focus :is\(#homeico, #chimebtn, #setbtn, #projpill, #npstart\)\.pressed\{/);
  assert.match(MAC, /body\.focus :is\(#projpill, #npstart\)\.pressed\{transform:scale\(var\(--press-x, 1\.06\), 1\.06\)\}/);
  assert.match(MAC, /for \(const btn of \["homeico", "projpill", "chimebtn", "setbtn", "npstart"\]\.map/);
  // every rule and line of script that names it
  for (const line of MAC.split("\n").filter(line => /cardplus/.test(line)))
    assert.doesNotMatch(line, /qn-glass|glassPress|--press-x|#432BFF|--accent/i, line);
});

test("the plus dips with the section names' own rules", () => {
  assert.match(MAC, /\n  #tikhead \.tvb, #cardplus\{\n    border-radius:7px;\n    box-shadow:inset 0 0 0 rgba\(60,45,20,0\), inset 0 0 0 rgba\(60,45,20,0\);\n    transition:color \.18s, box-shadow \.16s ease-out;\n  \}/);
  assert.match(MAC, /\n  #tikhead \.tvb:active, #tikhead \.tvb\.pressed, #cardplus:active, #cardplus\.pressed\{\n    box-shadow:inset 0 1\.8px 4\.2px rgba\(60,45,20,\.132\), inset 0 \.6px 1\.2px rgba\(60,45,20,\.084\);\n    transition:color \.18s, box-shadow \.08s ease-in;\n  \}/);
});

test("the names' press script presses the plus, held at least 80ms", () => {
  const from = MAC.indexOf("const PRESS_MIN = 80;");
  const code = MAC.slice(from, MAC.indexOf("\n  }\n", from) + 5);
  const listeners = {}, classes = new Set();
  const plus = { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } };
  const fire = (type, e = {}) => (listeners[type] || []).forEach(fn => fn(e));
  const timers = new Map(); let now = 0, id = 0;
  const context = vm.createContext({
    document: { querySelectorAll: sel => sel.split(",").map(s => s.trim()).includes("#cardplus") ? [plus] : [] },
    performance: { now: () => now },
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: k => timers.delete(k),
  });
  vm.runInContext(code, context);
  const tick = ms => { now += ms; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.fn(); } };
  fire("pointerdown"); assert.ok(classes.has("pressed"));
  fire("pointerup"); tick(30); assert.ok(classes.has("pressed"), "a quick click still shows the dip");
  tick(50); assert.ok(!classes.has("pressed"));
  fire("keydown", { key: "Enter" }); assert.ok(classes.has("pressed"));
  fire("keyup", { key: "Enter" }); tick(80); assert.ok(!classes.has("pressed"));
});

test("the top of the plus's ink stands two ticket gaps under the card's foot, from the gap's own variable", () => {
  // one gap, a variable the list's rows and the plus both read
  assert.equal((MAC.match(/--tik-gap:/g) || []).length, 1, "the gap is defined once");
  assert.match(MAC, /--tik-gap:calc\(var\(--ch\)\*0\.007\);/);
  assert.match(rule(MAC, "  .tikpane{"), /display:flex; flex-direction:column; gap:var\(--tik-gap\);/);
  assert.doesNotMatch(MAC, /(?<!tik-)gap:calc\(var\(--ch\)\*0\.007\)/, "no second copy of the gap in a rule");
  const own = rule(MAC, "  body.focus #cardplus{");
  // the box's top is the foot, two gaps, less what stands over the ink in the box: 1px of border, 5px of
  // padding and the clear ground over the ink on the 16px line
  assert.match(own, /--plus-clear:calc\(16px \* \(5 - 2\.66 \/ 2\) \/ 24\);/);
  assert.match(own, /top:calc\(var\(--plus-foot, 0px\) \+ 2 \* var\(--tik-gap\) - 1px - 5px - var\(--plus-clear\)\);/);
  assert.match(own, /padding:5px 0 6px; border:1px solid transparent;/);
  assert.doesNotMatch(own.replace(/top:[^;]*;/, ""), /--tik-gap|--plus-foot/, "the distance is written once");
  // the numbers, on the 1440 by 900 stage the mock was drawn on: a 6.3px gap, 11.107px of ink
  const gap = 900 * 0.007, clear = 16 * (5 - 2.66 / 2) / 24, ink = 16 * (14 + 2.66) / 24;
  assert.ok(Math.abs(clear - 2.4467) < 1e-4);
  assert.ok(Math.abs(ink - 11.107) < 1e-3);
  const foot = 812.16, boxTop = foot + 2 * gap - 1 - 5 - clear, inkTop = boxTop + 1 + 5 + clear;
  assert.ok(Math.abs(inkTop - (foot + 12.6)) < 1e-9, "the ink's top is 12.6px under the foot");
  assert.ok(boxTop > foot, "the whole box is under the card, never over it");
});

test("the plus is in the stage's fit, and the page switcher keeps clear of it", () => {
  assert.match(MAC, /const FIT_REGIONS = \["main", "clockbox", "rail", "tickets", "magic1", "magic2",\n  "magic3", "magic4", "goalbox", "cardplus"\];/);
  assert.match(MAC, /if \(card\) card\.style\.maxHeight = "";\n  seatCardPlus\(\);[^\n]*\n  const all = contentBounds\(FIT_REGIONS\);/, "seated under the card's whole foot for the measure");
  assert.match(between(MAC, "function reserveFootRoom(floor){", "\nconst MIN_CARD_H"), /seatCardPlus\(\);[\s\S]*floor - reach - card\.getBoundingClientRect\(\)\.top/);
  assert.match(between(MAC, "function magicSync(){", "const was"), /seatCardPlus\(\);/, "every reading of the board seats it");
  assert.match(MAC, /new MutationObserver\(seatCardPlus\)\.observe\(document\.querySelector\("main"\), \{ attributes: true, attributeFilter: \["style", "class"\] \}\);/);
});

// seatCardPlus over stubs: the card's rectangle, the stage's and its scale
function seat(over = {}) {
  const props = new Map(), classes = new Set(["off"]);
  const plus = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: { getPropertyValue: k => props.get(k) || "", setProperty: (k, v) => props.set(k, v) } };
  const cardClasses = new Set(over.cardClasses || []);
  const card = { classList: { contains: c => cardClasses.has(c) },
    getBoundingClientRect: () => over.card || { left: 300, top: 100, right: 700, bottom: 500, width: 400, height: 400 } };
  const stage = { getBoundingClientRect: () => over.stage || { x: 20, y: 40 } };
  const ctx = vm.createContext({ FOCUS: true, shownId: "a", draft: null, phoneWanted: false, stageScale: 0.5, ...over.globals,
    document: { getElementById: id => ({ cardplus: plus, stage }[id] || null), querySelector: () => card } });
  vm.runInContext(between(MAC, "function seatCardPlus(){", "\n}\n") + "\n}", ctx);
  ctx.seatCardPlus();
  return { props, off: classes.has("off"), ctx, run: () => ctx.seatCardPlus() };
}

test("seatCardPlus puts the plus under the card on screen, in stage pixels", () => {
  const s = seat();
  assert.equal(s.off, false);
  // the card's foot 500 and middle 500 on the screen, the stage's corner at 20 and 40, half size
  assert.equal(s.props.get("--plus-foot"), "920.00px");
  assert.equal(s.props.get("--plus-x"), "960.00px");
});

test("it follows the card when the card is shorter, and is off where no card stands", () => {
  const s = seat();
  s.ctx.document.querySelector = () => ({ classList: { contains: () => false },
    getBoundingClientRect: () => ({ left: 300, top: 100, right: 700, bottom: 300, width: 400, height: 200 }) });
  s.run();
  assert.equal(s.props.get("--plus-foot"), "520.00px", "a card cut short for the page switcher");
  assert.equal(seat({ globals: { shownId: null } }).off, true, "no card on screen");
  assert.equal(seat({ globals: { draft: { screen: "home" } } }).off, true, "a tab choosing its folder");
  assert.equal(seat({ globals: { phoneWanted: true } }).off, true, "the phone's view");
  assert.equal(seat({ cardClasses: ["region-off"] }).off, true, "the card hidden for this tab");
  assert.equal(seat({ globals: { FOCUS: false } }).off, true, "off the board");
});

test("it is not drawn on home or in edit mode, nor where nothing stands for it", () => {
  assert.equal(rule(MAC, "  #cardplus{"), "display:none");
  assert.match(MAC, /\n  body\.focus #cardplus\.off, body\.focus:is\(\.home, \.editmode\) #cardplus\{display:none\}/);
});

test("the ticket list has no line and no plus at its foot", () => {
  assert.doesNotMatch(MAC, /tikfoot|tiknew|tikNew/, "nothing of the foot is left");
  const holder = between(MAC, '<div id="tickets">', "\n");
  assert.doesNotMatch(holder, /<button id="(tiknew|cardplus)"|New card/, "no plus in the holder");
  assert.match(holder, /data-view="done"><\/div><\/div><\/div><\/div>$/, "the holder ends with the list");
  assert.doesNotMatch(rule(MAC, "  body.focus #tickets{"), /tikfoot/);
});

test("the phone's own new-card plus is unchanged", () => {
  assert.doesNotMatch(PHONE, /tiknew|tikfoot|cardplus/);
});
