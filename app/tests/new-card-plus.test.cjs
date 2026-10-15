// The plus under the Mac board's ticket list makes a new card exactly as
// Command + T does: its click is the very function the key's action calls
// (newCardHere in index.html). The Mac page's key handlers and that function are
// cut out of index.html as shipped (see hotkey-pages.cjs) and run over
// card-logic.js as shipped; only the card's making (newCard) is a spy. The plus
// stands on the list's real foot with no line there, tuned (20261014) to sit
// .48 of a ticket gap under the list, drawn at .9 of its 24px, in 1.6px lines,
// in --sub (#75695a) at 42%, and the list is as tall as its section needs, up to
// the height it had. The plus takes the names' press.
// No browser, no board, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage, between } = require("./hotkey-pages.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PHONE = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");
const TOKENS = fs.readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8");
const rule = (text, head) => between(text, head, "}").slice(head.length).replace(/\s+/g, " ").trim();

// the Mac page with the plus wired as the page wires it
function board() {
  const f = macPage();
  const plus = f.doc.make("button", f.doc.byId("tickets"), { id: "tiknew" });
  vm.runInContext(between(MAC, "const PLUS_ICON = ", "\n").replace(/^const/, "var"), f.ctx);
  vm.runInContext(between(MAC, "const tikNew = ", "\n\n"), f.ctx, { filename: "index.html" });
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

test("the plus is the board's plus on no glass, tuned: .9 of 24px, 1.6px lines, 42%", () => {
  const f = board();
  assert.equal(f.plus.innerHTML, f.ctx.PLUS_ICON, "the typing box's plus, as drawn");
  assert.match(MAC, /<div id="tikfoot"><button id="tiknew" type="button" title="New card" aria-label="New card"><\/button><\/div>/, "a bare button, labelled");
  const own = rule(MAC, "  body.focus #tiknew{");
  assert.match(own, /background:transparent;/);
  assert.match(own, /border:1px solid transparent;/);
  assert.doesNotMatch(own, /backdrop-filter|box-shadow|transform|opacity|qn-/, "no glass, and the button keeps the dip at full strength");
  assert.match(own, /color:var\(--sub\);/);
  assert.equal(TOKENS.match(/--sub:(#[0-9a-f]{6});/i)[1].toLowerCase(), "#75695a", "--sub is the picked colour");
  assert.equal(rule(MAC, "  body.focus #tiknew:hover{"), "color:var(--ink)");
  // the 24px of before (16px, 1.5 times over) stays the size variable; the pick is .9 of it
  assert.match(own, /^--plus-was:16px; --plus-size:calc\(var\(--plus-was\) \* 1\.5\);/);
  assert.match(own, /--plus-mult:\.9; --plus-drawn:calc\(var\(--plus-size\) \* var\(--plus-mult\)\);/);
  assert.match(own, /--plus-thick:1\.6; --plus-t:calc\(var\(--plus-thick\) \* 1px\);/);
  assert.match(own, /height:var\(--plus-drawn\);/);
  // 1.6px lines: in the drawing's 24 units that is 1.6 over the multiple, so they draw 1.6px
  const svg = rule(MAC, "  body.focus #tiknew svg{");
  assert.match(svg, /width:var\(--plus-drawn\); height:var\(--plus-drawn\); stroke-width:calc\(var\(--plus-thick\) \/ var\(--plus-mult\)\); opacity:\.42$/);
  assert.ok(Math.abs(1.6 / .9 * (24 * .9) / 24 - 1.6) < 1e-9);
  // none of the bar's glass: its stack, its zoom rule, its press and its press list
  assert.match(MAC, /body\.focus :is\(\.bar \.qn-glass, #projmenu\), body\.focus\.home :is\(#nppanel, #npstart\)\.qn-glass\{/);
  assert.match(MAC, /body\.p3zoom \.bar \.qn-glass\{backdrop-filter:none; -webkit-backdrop-filter:none\}/);
  assert.match(MAC, /body\.focus :is\(#homeico, #chimebtn, #feedbackbtn, #setbtn, #projpill, #npstart\)\.pressed\{/);
  assert.match(MAC, /body\.focus :is\(#projpill, #npstart\)\.pressed\{transform:scale\(var\(--press-x, 1\.06\), 1\.06\)\}/);
  assert.match(MAC, /for \(const btn of \["homeico", "projpill", "chimebtn", "feedbackbtn", "setbtn", "npstart"\]\.map/);
  // every rule and line of script that names it (the holder's markup, which
  // also holds the arrows' glass, is checked above)
  for (const line of MAC.split("\n").filter(line => /tiknew/.test(line) && !line.startsWith('<div id="tickets">')))
    assert.doesNotMatch(line, /qn-glass|glassPress|--press-x|#432BFF|--accent/i, line);
});

test("the plus dips with the section names' own rules", () => {
  assert.match(MAC, /\n  #tikhead \.tvb, #tiknew\{\n    border-radius:7px;\n    box-shadow:inset 0 0 0 rgba\(60,45,20,0\), inset 0 0 0 rgba\(60,45,20,0\);\n    transition:color \.18s, box-shadow \.16s ease-out;\n  \}/);
  assert.match(MAC, /\n  #tikhead \.tvb:active, #tikhead \.tvb\.pressed, #tiknew:active, #tiknew\.pressed\{\n    box-shadow:inset 0 1\.8px 4\.2px rgba\(60,45,20,\.132\), inset 0 \.6px 1\.2px rgba\(60,45,20,\.084\);\n    transition:color \.18s, box-shadow \.08s ease-in;\n  \}/);
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
    document: { querySelectorAll: sel => sel.split(",").map(s => s.trim()).includes("#tiknew") ? [plus] : [] },
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

test("the plus stands on the list's real foot, with no line there, as far under it as it first did", () => {
  const holder = between(MAC, '<div id="tickets">', "\n");
  assert.ok(holder.indexOf('id="tikfoot"') > holder.lastIndexOf('data-view="done"'), "after every section");
  assert.match(holder, /<\/div><\/div><div id="tikfoot">.*<\/div><\/div>$/, "a child of the holder, after the list");
  // the head's sides, and the holder's own gap between its parts
  assert.match(TOKENS, /#tikhead\{margin:0 var\(--tik-inset-r\) 0 var\(--tik-inset-l\)\}/);
  assert.match(rule(MAC, "  body.focus #tickets{"), /gap:calc\(var\(--line-gap\) \+ 1px\);/);
  // a seat of no height that takes the gap back, so it adds nothing to the column
  const foot = rule(MAC, "  body.focus #tikfoot{");
  assert.match(foot, /height:0;/);
  assert.match(foot, /margin:calc\(\(var\(--line-gap\) \+ 1px\) \* -1\) var\(--tik-inset-r\) 0 var\(--tik-inset-l\)$/);
  assert.doesNotMatch(MAC, /#tikfoot::(before|after)/, "the thin line is not drawn");
  // the gap to the top of the ink is .48 of a ticket gap (--tik-gap, the rows'
  // own) from the seat: the margin takes off the 6px of the box's border and top
  // padding and the clear air the drawing leaves over its ink (the arm's start,
  // 5 of 24 units scaled to the drawing, less half the line)
  const own = rule(MAC, "  body.focus #tiknew{");
  assert.match(own, /--plus-dist:calc\(\.48 \* var\(--tik-gap\)\);/);
  assert.match(own, /margin:calc\(var\(--plus-dist\) - 6px - \(var\(--plus-drawn\) \* 5 \/ 24 - var\(--plus-t\) \/ 2\)\) 0 0;/);
  assert.match(own, /padding:5px 0 6px; border:1px solid transparent;/);
  const dist = .48 * 900 * 0.007, drawn = 16 * 1.5 * .9, clear = drawn * 5 / 24 - 1.6 / 2;
  assert.ok(Math.abs(dist - 3) < .03, "about 3px");
  assert.ok(Math.abs((dist - 6 - clear) + 6 + clear - dist) < 1e-9, "the ink's top is --plus-dist under the seat");
  // a name's box turned over, .6 of the old pill's .86 of the rows across
  assert.match(rule(MAC, "  #tikhead .tvb{flex:1;"), /padding:6px 0 5px; font-size:14px; border:1px solid transparent/);
  assert.match(own, /box-sizing:content-box; width:calc\(100% \* \.86 \* \.6\);/);
  assert.match(own, /justify-content:center;/);
});

test("the list is as tall as its section needs, up to the height it had", () => {
  // the stylesheet: a basis from --tik-fit that shrinks to the holder, no motion of its own
  const list = rule(MAC, "  #tiklist{");
  assert.match(list, /flex:0 1 var\(--tik-fit, 100%\); min-height:0; overflow:clip;/);
  assert.doesNotMatch(list, /transition|animation/, "no height motion of its own");
  assert.match(rule(MAC, "  body.focus #tickets{"), /height:calc\(var\(--ch\)\*var\(--tik-h\)\);/, "the holder, and so the most, is unchanged");
  // the rows share the gap token
  assert.match(MAC, /\n    --tik-gap:calc\(var\(--ch\)\*0\.007\);/);
  assert.match(rule(MAC, "  .tikpane{"), /gap:var\(--tik-gap\);/);
  // the script: the section's padding plus its rows and the gaps between them, up to whole pixels
  const code = between(MAC, "function fitTicketList(){", '\nif (window.ResizeObserver && document.getElementById("tickets"))');
  const fit = (n, { rowH = 61.2, gapPx = 5.6, pad = [14.4, 30.4] } = {}) => {
    const style = {}, pane = { kind: "pane", children: Array.from({ length: n }, () => ({ kind: "row" })) };
    const ctx = vm.createContext({
      curView: () => "todo",
      document: { getElementById: () => ({ style: { getPropertyValue: k => style[k] || "", setProperty: (k, v) => { style[k] = v; } },
        querySelector: sel => sel === '.tikpane[data-view="todo"]' ? pane : null }) },
      getComputedStyle: el => el.kind === "pane" ? { paddingTop: pad[0] + "px", paddingBottom: pad[1] + "px", rowGap: gapPx + "px" } : { height: rowH + "px" },
    });
    vm.runInContext(code + "\nfitTicketList();", ctx);
    return style["--tik-fit"];
  };
  assert.equal(fit(3), Math.ceil(14.4 + 30.4 + 3 * 61.2 + 2 * 5.6) + "px", "three tickets: the box hugs them");
  assert.equal(fit(1), Math.ceil(14.4 + 30.4 + 61.2) + "px", "one ticket has no gap in it");
  assert.equal(fit(30), Math.ceil(14.4 + 30.4 + 30 * 61.2 + 29 * 5.6) + "px", "more than fit: it asks for more and the holder caps it");
  assert.equal(fit(0), Math.ceil(14.4 + 30.4) + "px", "a section with nothing in it asks for its padding only");
});

test("the fit is read whenever a section is drawn or shown, and when the holder is sized", () => {
  assert.match(between(MAC, "function renderCarousel(state){", "\n// ---- the garbage can"), /\n  fitTicketList\(\);\n/);
  assert.match(MAC, /new ResizeObserver\(fitTicketList\)\.observe\(document\.getElementById\("tickets"\)\)/);
});

test("nothing is left of the plus under the open card", () => {
  assert.doesNotMatch(MAC, /cardplus|cardPlus|seatCardPlus|--plus-foot|--plus-x\b|--plus-clear/);
});

test("the phone's own new-card plus is unchanged", () => {
  assert.doesNotMatch(PHONE, /tiknew|tikfoot|tik-fit|fitTicketList/);
});
