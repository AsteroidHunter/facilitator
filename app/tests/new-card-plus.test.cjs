// The plus under the thin line at the foot of the Mac board's ticket list
// makes a new card exactly as Command + T does: its click is the very function
// the key's action calls (newCardHere in index.html). The Mac page's key
// handlers and that function are cut out of index.html as shipped (see
// hotkey-pages.cjs) and run over card-logic.js as shipped; only the card's
// making (newCard) is a spy. The foot is the names' head turned over: its line
// is the divider's, the plus stands as far under it as the names stand over
// it, and it takes the names' press. No browser, no board, no network.
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

test("the plus is the board's plus on no glass, at the names' size and weight", () => {
  const f = board();
  assert.equal(f.plus.innerHTML, f.ctx.PLUS_ICON, "the typing box's plus, as drawn");
  assert.match(MAC, /<div id="tikfoot"><button id="tiknew" type="button" title="New card" aria-label="New card"><\/button><\/div>/, "a bare button");
  const own = rule(MAC, "  body.focus #tiknew{");
  assert.match(own, /background:transparent;/);
  assert.match(own, /border:1px solid transparent;/);
  assert.doesNotMatch(own, /backdrop-filter|box-shadow|transform|qn-/);
  assert.match(own, /color:var\(--sub\);/);
  assert.equal(rule(MAC, "  body.focus #tiknew:hover{"), "color:var(--ink)");
  // a 16px mark, the names' line, with 11px of ink in a 1.77px stroke
  assert.match(rule(MAC, "  body.focus #tiknew svg{"), /width:16px; height:16px; stroke-width:2.66$/);
  // none of the bar's glass: its stack, its zoom rule, its press and its press list
  assert.match(MAC, /body\.focus :is\(\.bar \.qn-glass, #projmenu\), body\.focus\.home :is\(#nppanel, #npstart\)\.qn-glass\{/);
  assert.match(MAC, /body\.p3zoom \.bar \.qn-glass\{backdrop-filter:none; -webkit-backdrop-filter:none\}/);
  assert.match(MAC, /body\.focus :is\(#homeico, #chimebtn, #setbtn, #projpill, #npstart\)\.pressed\{/);
  assert.match(MAC, /body\.focus :is\(#projpill, #npstart\)\.pressed\{transform:scale\(var\(--press-x, 1\.06\), 1\.06\)\}/);
  assert.match(MAC, /for \(const btn of \["homeico", "projpill", "chimebtn", "setbtn", "npstart"\]\.map/);
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

test("the foot is the head turned over: the divider's line, the names' gap and box", () => {
  const holder = between(MAC, '<div id="tickets">', "\n");
  assert.ok(holder.indexOf('id="tikfoot"') > holder.lastIndexOf('data-view="done"'), "after every section");
  assert.match(holder, /<\/div><\/div><div id="tikfoot">.*<\/div><\/div>$/, "a child of the holder, after the list");
  // the head's sides, and the holder's own gap from the list to the line's foot
  assert.match(TOKENS, /#tikhead\{margin:0 var\(--tik-inset-r\) 0 var\(--tik-inset-l\)\}/);
  const foot = rule(MAC, "  body.focus #tikfoot{");
  assert.match(foot, /margin:0 var\(--tik-inset-r\) 0 var\(--tik-inset-l\); padding:calc\(var\(--line-gap\) \+ 1px\) 0 0$/);
  assert.match(rule(MAC, "  body.focus #tickets{"), /gap:calc\(var\(--line-gap\) \+ 1px\);/);
  // the divider's line, a mirror: the divider's top is 1px over the list, this line's foot 1px under it
  const head = rule(MAC, "  #tikhead::after{"), line = rule(MAC, "  body.focus #tikfoot::before{");
  assert.match(head, /top:calc\(100% \+ var\(--line-gap\)\); left:0; right:0; height:0; border-top:var\(--edge\) solid var\(--line\);/);
  assert.match(line, /^content:""; position:absolute; pointer-events:none; bottom:calc\(100% - 1px\); left:0; right:0; height:0; border-bottom:var\(--edge\) solid var\(--line\);$/);
  // a name's box turned over, .6 of the old pill's .86 of the rows across
  const own = rule(MAC, "  body.focus #tiknew{");
  assert.match(rule(MAC, "  #tikhead .tvb{flex:1;"), /padding:6px 0 5px; font-size:14px; border:1px solid transparent/);
  assert.match(own, /box-sizing:content-box; width:calc\(100% \* \.86 \* \.6\); height:16px;/);
  assert.match(own, /padding:5px 0 6px; border:1px solid transparent;/);
  assert.match(own, /justify-content:center;/);
});

test("the phone's own new-card plus is unchanged", () => {
  assert.doesNotMatch(PHONE, /tiknew|tikfoot/);
});
