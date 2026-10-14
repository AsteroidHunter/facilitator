// The glass pill under the Mac board's ticket list makes a new card exactly as
// Command + T does: its click is the very function the key's action calls
// (newCardHere in index.html). The Mac page's key handlers and that function
// are cut out of index.html as shipped (see hotkey-pages.cjs) and run over
// card-logic.js as shipped; only the card's making (newCard) is a spy. No
// browser, no board, no network.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { macPage, between } = require("./hotkey-pages.cjs");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MAC = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const PHONE = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

// the Mac page with the pill wired as the page wires it
function board() {
  const f = macPage();
  const pill = f.doc.make("button", f.doc.byId("tickets"), { id: "tiknew", cls: "qn-glass" });
  vm.runInContext(between(MAC, "const PLUS_ICON = ", "\n").replace(/^const/, "var"), f.ctx);
  vm.runInContext(between(MAC, "const tikNew = ", "\n\n"), f.ctx, { filename: "index.html" });
  f.pill = pill;
  f.click = () => {
    f.calls.length = 0;
    for (const l of pill.listeners.filter(l => l.type === "click")) l.fn({ type: "click", target: pill, button: 0 });
    return f.calls.map(c => c.join(" "));
  };
  return f;
}

test("the pill's click is the function Command + T's action calls", () => {
  const f = board();
  const clicks = f.pill.listeners.filter(l => l.type === "click");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].fn, f.ctx.newCardHere, "the pill listens with newCardHere itself");
  const create = between(MAC, "  create(e){\n    e.preventDefault();\n    newCardHere();", "},");
  assert.ok(create, "the board's Command + T action calls newCardHere");
  assert.equal((MAC.match(/newCard\(activeOwner\)/g) || []).length, 1, "the open project's new card is made in one place");
});

test("a click and Command + T make the same card in the same project", () => {
  const keyed = board().press("board", "cmd+t");
  assert.deepEqual(keyed.calls, ["create one"]);
  assert.deepEqual(board().click(), keyed.calls);
});

test("where Command + T makes nothing, the pill makes nothing", () => {
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

test("the pill wears the board's plus and the project pill's glass and press", () => {
  const f = board();
  assert.equal(f.pill.innerHTML, f.ctx.PLUS_ICON, "the plus, as drawn");
  assert.match(f.ctx.PLUS_ICON, /<path d="M12 5v14M5 12h14"><\/path>/, "two crossing runs, not the attach button's paperclip");
  assert.match(MAC, /<button id="tiknew" class="qn-glass" type="button"/);
  assert.match(MAC, /body\.focus :is\(\.bar \.qn-glass, #projmenu, #tiknew\), body\.focus\.home #nppanel\.qn-glass\{/, "the bar's glass stack");
  assert.match(MAC, /:is\(#homeico, #chimebtn, #setbtn, #projpill, #tiknew\)\.pressed\{/, "the glass press");
  assert.match(MAC, /:is\(#projpill, #tiknew\)\.pressed\{transform:scale\(var\(--press-x, 1\.06\), 1\.06\)\}/, "the pill's few pixels across");
  assert.match(MAC, /\["homeico", "projpill", "chimebtn", "setbtn", "tiknew"\]/, "glassPress holds it");
});

test("the pill stands after the list in the holder, never in a section, and wears no accent", () => {
  const holder = between(MAC, '<div id="tickets">', "\n");
  assert.ok(holder.indexOf('id="tiknew"') > holder.lastIndexOf('data-view="done"'), "after every section");
  assert.match(holder, /<\/div><\/div><button id="tiknew"[^>]*><\/button><\/div>$/, "a child of the holder, after the list");
  const rules = MAC.split("\n").filter(line => /#tiknew/.test(line)).join("\n") +
    between(MAC, "  body.focus #tiknew{", "  body.focus #tiknew svg");
  assert.doesNotMatch(rules, /#432BFF|--accent/i);
});

test("the phone's own new-card plus is unchanged", () => {
  assert.doesNotMatch(PHONE, /tiknew/);
});
