// Source and handler checks for the phone project pill. No browser or server.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const PHONE = fs.readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

function between(start, end) {
  const at = PHONE.indexOf(start);
  assert.ok(at >= 0, `missing ${start}`);
  const to = PHONE.indexOf(end, at + start.length);
  assert.ok(to > at, `missing ${end}`);
  return PHONE.slice(at, to);
}

test("the project name uses the arrow's space and keeps centered ellipsis layout", () => {
  assert.equal(PHONE.includes("updown"), false, "the arrow's markup and CSS are gone");
  const pill = between("#dock #projbtn{", "}");
  assert.doesNotMatch(pill, /gap:/);
  assert.match(pill, /flex:1 1 auto; min-width:0/);
  assert.match(pill, /padding:0 calc\(16 \* var\(--u\)\)/);
  const button = between("#dock .dockbtn{", "}");
  assert.match(button, /height:100%/);
  assert.match(button, /border-radius:calc\(var\(--dock-h\) \/ 2\)/);
  assert.match(button, /display:flex; align-items:center; justify-content:center/);
  assert.match(between("#projname{", "}"), /flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap/);
});

function picker() {
  const handlers = {}, attributes = {}, classes = new Set();
  const context = {
    projBtn: {
      addEventListener(type, fn) { handlers[type] = fn; },
      setAttribute(name, value) { attributes[name] = value; },
      getBoundingClientRect: () => ({ left: 100, width: 100 }),
    },
    document: {
      body: { classList: {
        contains: name => classes.has(name),
        add: name => classes.add(name),
        remove: name => classes.delete(name),
      } },
      documentElement: { clientWidth: 375 },
      getElementById: id => ({ getBoundingClientRect: () => (id === "tikbtn" ? { left: 16 } : { right: 359 }) }),
    },
    projMenu: { querySelector: () => null, style: {} },
    getComputedStyle: () => ({ width: "200px" }),
    lastState: null,
    dismissEditor() {},
    endProjCarry() {},
  };
  vm.runInNewContext(
    between("function projOpen(){", "// a project chosen in the list") +
    between("const PROJ_SLIP =", "// ---- carrying a project"), context);
  return {
    fire: (type, values = {}) => handlers[type]({ button: 0, pointerId: 1, clientX: 20, clientY: 20, ...values }),
    open: () => classes.has("projopen"),
    attributes,
  };
}

test("tapping the name-only project pill still opens and closes its picker", () => {
  assert.match(between('<button id="projbtn"', '\n'), /aria-haspopup="true"[^>]*aria-expanded="false"[^>]*aria-controls="projmenu"><span id="projname"><\/span><\/button>/);
  const p = picker();
  assert.equal(p.open(), false);
  p.fire("pointerdown");
  p.fire("pointerup");
  assert.equal(p.open(), true);
  assert.equal(p.attributes["aria-expanded"], "true");
  p.fire("pointerdown");
  p.fire("pointerup");
  assert.equal(p.open(), false);
  assert.equal(p.attributes["aria-expanded"], "false");
});

test("keyboard activation opens the picker while moved and cancelled taps do not", () => {
  const p = picker();
  p.fire("pointerdown");
  p.fire("pointermove", { clientX: 40 });
  p.fire("pointerup");
  assert.equal(p.open(), false);
  p.fire("pointerdown");
  p.fire("pointercancel");
  p.fire("pointerup");
  assert.equal(p.open(), false);
  p.fire("click", { detail: 0 });
  assert.equal(p.open(), true);
  p.fire("click", { detail: 1 });
  assert.equal(p.open(), true);
  p.fire("click", { detail: 0 });
  assert.equal(p.open(), false);
});

// ---- the markup and the sheet -----------------------------------------------------------
test("the row holds four glass buttons in the owner's order, a name-only project pill, two inline icons and the settings logo", () => {
  const dock = /<nav id="dock"[^>]*>([\s\S]*?)<\/nav>/.exec(PHONE);
  assert.ok(dock, "the row of buttons is not in the page");
  const buttons = [...dock[1].matchAll(/<button id="(\w+)" class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map(b => b[1]), ["tikbtn", "projbtn", "tikadd", "setbtn"]);
  for (const [, id, cls, inside] of buttons){
    assert.match(cls, /\bqn-glass\b/, `${id} does not wear the board's glass`);
    assert.match(cls, /\bdockbtn\b/);
    if (id === "projbtn"){
      assert.equal(inside, '<span id="projname"></span>', "the capsule holds only its name");
      continue;
    }
    if (id === "setbtn"){
      assert.match(inside, /^<span class="squidmark" aria-hidden="true"><img src="data:image\/png;base64,[A-Za-z0-9+/=]+"[^>]*><\/span>$/, "setbtn is not the embedded logo PNG");
      assert.doesNotMatch(inside, /<svg|url\(/, "setbtn also carries a drawn mark");
      continue;
    }
    assert.match(inside, /<svg[^>]*aria-hidden="true"/, `${id} carries no inline mark`);
    assert.doesNotMatch(inside, /<img|url\(/, `${id} fetches its mark`);
  }
  // the capsule is only the name; the ticket
  // is one outline with its side notches and no tear line
  assert.deepEqual([...buttons[1][3].matchAll(/<(\w+)/g)].map(m => m[1]), ["span"], "the capsule carries more than the name");
  assert.equal([...buttons[0][3].matchAll(/<path\b/g)].length, 1, "the ticket is more than one outline");
  // the two ends are circles
  assert.match(buttons[0][2], /\bround\b/);
  assert.match(buttons[3][2], /\bround\b/);
  // the row, the list and every rule written for them carry no purple
  const sheet = [...PHONE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
  const ours = [...sheet.matchAll(/([^{}]*(?:#dock|\.dockbtn|#projbtn|#projmenu|#projshade|\.projrow|#projsep|#projlist|#tikadd)[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(ours.length >= 10, "the row's rules were not found");
  for (const [, sel, body] of ours)
    assert.doesNotMatch(body, /--accent|#432BFF|purple|violet/i, `${sel.trim()} uses a purple`);
  // nothing on the row or in the list can be long-pressed into a selection
  assert.match(sheet, /#dock\{[^}]*-webkit-user-select:none; user-select:none; -webkit-touch-callout:none/);
  assert.match(sheet, /#projmenu\{[^}]*-webkit-user-select:none; user-select:none; -webkit-touch-callout:none/);
});
