// Source and handler checks for two phone fixes. No browser or server.
//  1. The plus in the bottom bar focuses a field inside its own tap, so the phone
//     raises the keyboard, and the card's name takes the focus when it exists.
//  2. The reply box's attachment plus is off while the card's name is edited.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const PHONE = read("m.html");

function between(start, end, from = 0) {
  const at = PHONE.indexOf(start, from);
  assert.ok(at >= 0, `missing ${start}`);
  const to = PHONE.indexOf(end, at + start.length);
  assert.ok(to > at, `missing ${end}`);
  return PHONE.slice(at, to);
}

// ---- fix 1: the caret in a new card's name --------------------------------------

function catcher() {
  const body = { name: "body" };
  const calls = { focus: [], insert: [] };
  const input = {
    value: "",
    focus(opts) { calls.focus.push(opts); document.activeElement = input; },
    blur() { if (document.activeElement === input) document.activeElement = body; },
  };
  const document = {
    activeElement: body,
    getElementById: id => (id === "titlecatch" ? input : null),
    execCommand: (name, _ui, text) => { calls.insert.push([name, text]); return true; },
  };
  const context = { document };
  vm.runInNewContext(
    between("const titleCatch =", "// one press, one card") +
    "\nthis.api = { catchTitle, letGoTitleCatch, handOffTitleCatch };", context);
  return { ...context.api, input, document, body, calls };
}

test("the tap focuses the catcher field without scrolling", () => {
  const c = catcher();
  c.catchTitle();
  assert.equal(c.document.activeElement, c.input);
  assert.equal(JSON.stringify(c.calls.focus), JSON.stringify([{ preventScroll: true }]));
});

test("a card that never comes lets the keyboard go", () => {
  const c = catcher();
  c.catchTitle();
  c.input.value = "half";
  c.letGoTitleCatch();
  assert.equal(c.document.activeElement, c.body);
  assert.equal(c.input.value, "");
  // and a focus that already moved on elsewhere is left alone
  const other = { name: "elsewhere" };
  c.document.activeElement = other;
  c.letGoTitleCatch();
  assert.equal(c.document.activeElement, other);
});

test("what was typed before the name existed goes into the name", () => {
  const c = catcher();
  const titleEl = { isContentEditable: true };
  c.catchTitle();
  c.input.value = "Plan";
  c.document.activeElement = titleEl;   // editTitle's focus has moved on
  c.handOffTitleCatch({ titleEl });
  assert.deepEqual(c.calls.insert, [["insertText", "Plan"]]);
  assert.equal(c.input.value, "");
});

test("a name that took no focus leaves nothing holding the catcher", () => {
  const c = catcher();
  const titleEl = { isContentEditable: true };
  c.catchTitle();
  c.input.value = "Plan";
  c.handOffTitleCatch({ titleEl });
  assert.deepEqual(c.calls.insert, []);
  assert.equal(c.document.activeElement, c.body);
});

test("the plus's own tap does the focus, with nothing deferred", () => {
  const body = between("function createCard(){", "\n}\n");
  assert.match(body, /catchTitle\(\)/);
  for (const later of ["setTimeout", "requestAnimationFrame", "await ", ".then(", "fetch(", "queueMicrotask"]) {
    assert.equal(body.includes(later), false, `createCard defers with ${later}`);
  }
  // the card is minted first, so a refused card does not raise a keyboard, then
  // the focus, then the request goes out
  const focusAt = body.lastIndexOf("catchTitle();");
  assert.ok(body.indexOf('mintOp("create"') < focusAt);
  assert.ok(focusAt < body.indexOf('runOps("create")'));
  // a second press while the card is on its way takes the keyboard up again too
  const pending = body.slice(body.indexOf("if (pendingCreate())"), body.indexOf('const op = mintOp("create"'));
  assert.match(pending, /catchTitle\(\)/);
  // it is the click of the plus, the tap itself
  assert.match(PHONE, /getElementById\("tikadd"\)\.addEventListener\("click", createCard\)/);
});

test("the focus moves to the name once the card is drawn, and is let go on every miss", () => {
  assert.match(PHONE, /select\(id\);\n\s+editTitle\(id\);\n\s+handOffTitleCatch\(els\[id\]\);/);
  const fail = between("function failOp(", "\n}\n");
  assert.match(fail.slice(fail.indexOf('op.kind === "create"')), /letGoTitleCatch\(\)/);
  const unsure = between("function markUnsure(", "\n}\n");
  assert.match(unsure.slice(unsure.indexOf('op.kind === "create"')), /letGoTitleCatch\(\)/);
  assert.match(between("function landCreate(", "\n}\n"), /if \(!result\.id\)\{ letGoTitleCatch\(\); return; \}/);
});

test("the catcher is a real, painted, untouchable text field", () => {
  assert.match(PHONE, /<input id="titlecatch" type="text" tabindex="-1" aria-hidden="true"/);
  const css = between("#titlecatch{", "}");
  assert.match(css, /position:fixed/);
  assert.match(css, /opacity:0/);
  assert.match(css, /pointer-events:none/);
  assert.match(css, /font-size:16px/);
  assert.doesNotMatch(css, /display:none|visibility:hidden/);
});

// ---- fix 2: the attachment plus while the name is edited ------------------------

function plus() {
  const handlers = {}, attrs = {}, calls = { opened: 0, prevented: 0 };
  let observe = null;
  const titleEl = { isContentEditable: false };
  const clip = {
    addEventListener(type, fn) { handlers[type] = fn; },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) { delete attrs[name]; },
  };
  const context = {
    titleEl, clip, ta: {}, clipfile: {}, b: { id: "x" },
    pickPhase: "idle",
    pickOpen: () => { calls.opened++; },
    ComposeFormat: { focused: () => false },
    wireAttachmentTransfer() {},
    trayAdd() {},
    MutationObserver: class { constructor(fn) { observe = fn; } observe() {} },
  };
  vm.runInNewContext(between("let plusHeld = false;", 'clipfile.addEventListener("cancel"'), context);
  const down = () => handlers.pointerdown({ preventDefault: () => { calls.prevented++; } });
  const click = () => handlers.click();
  const tap = ({ pointer = true } = {}) => {
    if (pointer) down();
    click();
  };
  return {
    attrs, calls, tap, down, click, titleEl, context,
    edit(on) { titleEl.isContentEditable = on; observe(); },
  };
}

test("the plus opens the picker when the name is not being edited", () => {
  const p = plus();
  assert.equal(p.attrs["aria-disabled"], undefined);
  p.tap();
  assert.equal(p.calls.opened, 1);
  assert.equal(p.calls.prevented, 0);
});

test("while the name is edited the plus reads disabled and opens nothing", () => {
  const p = plus();
  p.edit(true);
  assert.equal(p.attrs["aria-disabled"], "true");
  p.tap();
  assert.equal(p.calls.opened, 0);
  assert.equal(p.calls.prevented, 1, "the press is refused so the name keeps the keyboard");
  p.tap({ pointer: false });   // a click with no press, as a keyboard makes
  assert.equal(p.calls.opened, 0);
});

test("a name left between the press and the click does not let that tap through", () => {
  const p = plus();
  p.edit(true);
  p.down();      // the finger lands while the name is edited
  p.edit(false); // the name is left (Enter, or a tap elsewhere) before the click
  p.click();
  assert.equal(p.calls.opened, 0);
  assert.equal(p.attrs["aria-disabled"], undefined);
  p.tap();       // the next tap is a plain one
  assert.equal(p.calls.opened, 1);
});

test("the plus comes back the moment the name is left", () => {
  const p = plus();
  p.edit(true);
  p.edit(false);
  assert.equal(p.attrs["aria-disabled"], undefined);
  p.tap();
  assert.equal(p.calls.opened, 1);
});

test("the disabled look is the page's own fade and carries no colour", () => {
  const rule = between('.clipbtn[aria-disabled="true"]{', "}");
  assert.match(rule, /opacity:var\(--chipoff\)/);
  assert.doesNotMatch(rule, /color|background|#[0-9a-f]{3}|rgb|purple|violet/i);
  assert.match(read("card-tokens.css"), /--chipoff:\.28;/);
});

test("the Mac board is not touched", () => {
  for (const name of ["index.html", "card-logic.js", "card-tokens.css"]) {
    const text = read(name);
    assert.equal(text.includes("titlecatch"), false, `${name} has the catcher`);
    assert.equal(text.includes("catchTitle"), false, `${name} has the catcher`);
    assert.equal(/clipbtn\[aria-disabled/.test(text), false, `${name} has the disabled plus`);
  }
});
