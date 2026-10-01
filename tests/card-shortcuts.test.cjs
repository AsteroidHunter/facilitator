const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

async function shortcuts() {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const context = vm.createContext({
    Date,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  return {
    resolve: vm.runInContext("cardShortcut", context),
    dispatch: vm.runInContext("dispatchCardShortcut", context),
  };
}

function event(key, modifiers = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    isComposing: false,
    repeat: false,
    ...modifiers,
  };
}

function plain(value) {
  return value && { action: value.action, value: value.value };
}

test("card navigation aliases resolve to one action and direction", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("ArrowLeft", { ctrlKey: true, shiftKey: true }))),
    { action: "navigate", value: -1 });
  assert.deepEqual(plain(resolve(event("ArrowRight", { ctrlKey: true, shiftKey: true, altKey: true }))),
    { action: "navigate", value: 1 });
  assert.deepEqual(plain(resolve(event("ArrowLeft"))),
    { action: "plainNavigate", value: -1 });
  assert.deepEqual(plain(resolve(event("ArrowRight"))),
    { action: "plainNavigate", value: 1 });
});

test("history, creation and tabs keep their modifier rules", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("ArrowUp", { ctrlKey: true, shiftKey: true, altKey: true }))),
    { action: "history", value: 1 });
  assert.deepEqual(plain(resolve(event("ArrowDown", { ctrlKey: true, shiftKey: true }))),
    { action: "history", value: -1 });
  assert.deepEqual(plain(resolve(event("t", { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true }))),
    { action: "create", value: true });
  assert.deepEqual(plain(resolve(event("1", { metaKey: true }))),
    { action: "tab", value: 0 });
  assert.deepEqual(plain(resolve(event("9", { metaKey: true, shiftKey: true, altKey: true }))),
    { action: "tab", value: 8 });
});

// the chord used to be a card command, a return to the card the send's own move
// left. It is the editor's undo again, and recognition must not know it at all:
// a page that still carried a handler for it can then never be handed the key.
test("command z and control z are no command of the card pages", async () => {
  const { resolve, dispatch } = await shortcuts();
  const held = [
    { metaKey: true }, { ctrlKey: true }, { metaKey: true, ctrlKey: true },
    { metaKey: true, shiftKey: true }, { ctrlKey: true, shiftKey: true },
    { metaKey: true, altKey: true }, { ctrlKey: true, altKey: true },
    { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true },
    {},
  ];
  for (const key of ["z", "Z"]) {
    for (const modifiers of held) {
      const combination = key + " with " + (Object.keys(modifiers).join(", ") || "nothing");
      assert.equal(resolve(event(key, modifiers)), null, combination + " is still recognized");
      assert.equal(resolve(event(key, modifiers), "mini"), null, combination + " is still a mini command");
      const called = [];
      const actions = new Proxy({}, { get: (_, name) => (() => called.push(name)) });
      assert.equal(dispatch(event(key, modifiers), actions), false, combination + " reached a page action");
      assert.deepEqual(called, []);
    }
  }
});

test("mini scope exposes only its established command subset", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("ArrowRight", { ctrlKey: true, shiftKey: true }), "mini")),
    { action: "navigate", value: 1 });
  assert.deepEqual(plain(resolve(event("T", { metaKey: true }), "mini")),
    { action: "create", value: true });
  assert.deepEqual(plain(resolve(event("ArrowLeft"), "mini")),
    { action: "plainNavigate", value: -1 });
  // the section keys move the small card's own card as well
  assert.deepEqual(plain(resolve(event("}", { ctrlKey: true, shiftKey: true, code: "BracketRight" }), "mini")),
    { action: "sectionChord", value: "deferred" });
  assert.deepEqual(plain(resolve(event("\\", { code: "Backslash" }), "mini")),
    { action: "sectionKey", value: "done" });
  assert.equal(resolve(event("Backspace"), "mini"), null);
  assert.equal(resolve(event("n", { ctrlKey: true }), "mini"), null);
  assert.equal(resolve(event("]", { metaKey: true, shiftKey: true }), "mini"), null);
  assert.equal(resolve(event("ArrowUp", { ctrlKey: true, shiftKey: true }), "mini"), null);
  assert.equal(resolve(event("2", { metaKey: true }), "mini"), null);
  assert.equal(resolve(event("t", { metaKey: true }), "unknown"), null);
});

test("modified native combinations remain outside common recognition", async () => {
  const { resolve } = await shortcuts();
  assert.equal(resolve(event("ArrowLeft", { altKey: true })), null);
  assert.equal(resolve(event("ArrowRight", { ctrlKey: true })), null);
  assert.equal(resolve(event("ArrowRight", { shiftKey: true })), null);
  assert.equal(resolve(event("ArrowLeft", { metaKey: true, shiftKey: true })), null);
  assert.equal(resolve(event("ArrowRight", { ctrlKey: true, metaKey: true, shiftKey: true })), null);
  assert.equal(resolve(event("z", { metaKey: true, shiftKey: true })), null);
  assert.equal(resolve(event("0", { metaKey: true })), null);
  assert.equal(resolve(event("t", { ctrlKey: true })), null);
});

// these chords are the browser's and the system's, and recognition must not know
// them at all, so no page can be handed them and cancel them
test("control N, control L, backspace, delete and command shift [ and ] are no command of the card pages", async () => {
  const { resolve, dispatch } = await shortcuts();
  const control = [{ ctrlKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true },
    { ctrlKey: true, shiftKey: true }];
  const command = [
    { metaKey: true, shiftKey: true }, { metaKey: true, shiftKey: true, ctrlKey: true },
    { metaKey: true, shiftKey: true, altKey: true },
    { metaKey: true, shiftKey: true, ctrlKey: true, altKey: true },
  ];
  const everything = [{}, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { metaKey: true, shiftKey: true, ctrlKey: true, altKey: true }];
  const cases = [];
  for (const [key, code] of [["n", "KeyN"], ["N", "KeyN"], ["l", "KeyL"], ["L", "KeyL"]])
    for (const modifiers of control) cases.push([key, { code, ...modifiers }]);
  for (const key of ["Backspace", "Delete"])
    for (const modifiers of everything) cases.push([key, { code: key, ...modifiers }]);
  for (const [key, code] of [["[", "BracketLeft"], ["]", "BracketRight"], ["{", "BracketLeft"], ["}", "BracketRight"]])
    for (const modifiers of command) cases.push([key, { code, ...modifiers }]);
  for (const [key, modifiers] of cases) {
    const combination = key + " with " + Object.keys(modifiers).join(", ");
    const chord = event(key, modifiers);
    const called = [];
    const actions = new Proxy({}, { get: (_, name) => (() => called.push(name)) });
    assert.equal(resolve(chord), null, combination + " is still recognized");
    assert.equal(resolve(chord, "mini"), null, combination + " is still a mini command");
    assert.equal(dispatch(chord, actions), false, combination + " reached a page action");
    assert.deepEqual(called, []);
    assert.equal(chord.defaultPrevented, false);
  }
});

// a stray letter used to move the selected card; no bare letter is a command now
test("plain N, S and L are no command, with or without shift", async () => {
  const { resolve, dispatch } = await shortcuts();
  for (const key of ["n", "N", "s", "S", "l", "L"]) {
    for (const modifiers of [{}, { shiftKey: true }]) {
      assert.equal(resolve(event(key, modifiers)), null, key);
      assert.equal(resolve(event(key, modifiers), "mini"), null, key);
      const called = [];
      const actions = new Proxy({}, { get: (_, name) => (() => called.push(name)) });
      assert.equal(dispatch(event(key, modifiers), actions), false, key);
      assert.deepEqual(called, []);
    }
  }
});

test("control S is only the response scroll, never a destination or the diagnostic", async () => {
  const { resolve } = await shortcuts();
  for (const key of ["s", "S"]) {
    assert.deepEqual(plain(resolve(event(key, { ctrlKey: true }))), { action: "responseScroll", value: true });
    assert.equal(resolve(event(key, { ctrlKey: true }), "mini"), null);
    // the old chord with shift is nothing now
    assert.equal(resolve(event(key, { ctrlKey: true, shiftKey: true })), null);
  }
  // the diagnostic keeps its own chord and letter
  assert.deepEqual(plain(resolve(event("m", { ctrlKey: true, shiftKey: true }))), { action: "diagnostic", value: true });
  assert.equal(resolve(event("m", { ctrlKey: true })), null);
});

test("the phone diagnostic marker has one exact chord and leaves other scopes and editing keys alone", async () => {
  const { resolve, dispatch } = await shortcuts();
  const chord = event("M", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(plain(resolve(chord)), { action: "diagnostic", value: true });
  for (const over of [{ ctrlKey: false }, { shiftKey: false }, { metaKey: true }, { altKey: true },
                      { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
    assert.equal(resolve({ ...chord, ...over }), null);
  }
  assert.equal(resolve(chord, "mini"), null);
  assert.equal(dispatch(chord, {}), false, "a desktop without the action took the key");
});

test("editing flags do not add exclusions to recognized commands", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("t", {
    metaKey: true, defaultPrevented: true, isComposing: true, repeat: true,
  }))), { action: "create", value: true });
  assert.deepEqual(plain(resolve(event("Escape", {
    metaKey: true, ctrlKey: true, shiftKey: true, altKey: true,
  }))), { action: "escape", value: true });
});

test("dispatch calls only a supported action and leaves policy to it", async () => {
  const { dispatch } = await shortcuts();
  const seen = [];
  const key = event("ArrowLeft", { ctrlKey: true, shiftKey: true });
  assert.equal(dispatch(key, {
    navigate(received, shortcut) { seen.push([received, plain(shortcut)]); },
  }), true);
  assert.deepEqual(seen, [[key, { action: "navigate", value: -1 }]]);
  assert.equal(key.defaultPrevented, false, "dispatch canceled the event itself");

  const unsupported = event("t", { metaKey: true });
  assert.equal(dispatch(unsupported, {}), false);
  assert.equal(unsupported.defaultPrevented, false);
  assert.equal(dispatch(event("ArrowLeft"), { navigate() { throw new Error("not matched"); } }), false);
});

// ---- control+shift+[, ] and \, and the three keys alone ----------------------------
// what a US keyboard sends for each: the physical key, the character alone and
// the character shift makes of it
const SECTION_KEYS = [
  { code: "BracketLeft", key: "[", shifted: "{", section: "doing" },
  { code: "BracketRight", key: "]", shifted: "}", section: "deferred" },
  { code: "Backslash", key: "\\", shifted: "|", section: "done" },
];
const CHORD = { ctrlKey: true, shiftKey: true };

test("control shift with [, ] and \\ names doing, deferred and done, by physical key or by character", async () => {
  const { resolve } = await shortcuts();
  for (const { code, key, shifted, section } of SECTION_KEYS) {
    const want = { action: "sectionChord", value: section };
    // what the browser sends: the shifted character on the bracket's own key
    assert.deepEqual(plain(resolve(event(shifted, { ...CHORD, code }))), want, `${code} ${shifted}`);
    // control can leave e.key unusual; the physical key alone still decides
    assert.deepEqual(plain(resolve(event("Unidentified", { ...CHORD, code }))), want, `${code} unidentified`);
    // an event naming no physical key falls back to either character
    assert.deepEqual(plain(resolve(event(shifted, CHORD))), want, `${shifted} without a code`);
    assert.deepEqual(plain(resolve(event(key, CHORD))), want, `${key} without a code`);
    // the composer's editor has already cancelled it on the way: still the chord
    assert.deepEqual(plain(resolve(event(shifted, { ...CHORD, code, defaultPrevented: true }))), want,
      `${code} cancelled by the editor`);
  }
  // a layout whose bracket key types a letter still has the chord there
  assert.deepEqual(plain(resolve(event("Ü", { ...CHORD, code: "BracketLeft" }))),
    { action: "sectionChord", value: "doing" });
});

test("the section chord needs control and shift, no command or option, and ignores repeats and composition", async () => {
  const { resolve } = await shortcuts();
  for (const { code, key, shifted } of SECTION_KEYS) {
    for (const over of [{ repeat: true }, { isComposing: true }, { altKey: true }]) {
      assert.equal(resolve(event(shifted, { ...CHORD, code, ...over })), null, `${code} with ${Object.keys(over)}`);
    }
    // control without shift, and shift without control, is nothing
    assert.equal(resolve(event(key, { ctrlKey: true, code })), null, `${code} control alone`);
    assert.equal(resolve(event(shifted, { shiftKey: true, code })), null, `${code} shift alone`);
  }
  // other keys under control and shift are not a section
  assert.equal(resolve(event("P", { ...CHORD, code: "KeyP" })), null);
});

test("command shift with \\ is no command, and never a section", async () => {
  const { resolve } = await shortcuts();
  assert.equal(resolve(event("|", { metaKey: true, shiftKey: true, code: "Backslash" })), null);
  assert.equal(resolve(event("|", { metaKey: true, ctrlKey: true, shiftKey: true, code: "Backslash" })), null);
});

test("[, ] and \\ alone name the three sections, by the character they type", async () => {
  const { resolve } = await shortcuts();
  for (const { code, key, section } of SECTION_KEYS) {
    const want = { action: "sectionKey", value: section };
    assert.deepEqual(plain(resolve(event(key, { code }))), want, key);
    assert.deepEqual(plain(resolve(event(key))), want, `${key} without a code`);
    for (const over of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true },
                        { ctrlKey: true }, { metaKey: true }]) {
      assert.equal(resolve(event(key, { code, ...over })), null, `${key} with ${Object.keys(over)}`);
    }
  }
  // shift turns the key into another character, and a bracket key that types
  // a letter on another layout is that letter
  for (const { code, shifted } of SECTION_KEYS) assert.equal(resolve(event(shifted, { shiftKey: true, code })), null);
  assert.equal(resolve(event("ü", { code: "BracketLeft" })), null);
  // lookups never reach an object's own names
  for (const key of ["constructor", "toString", "__proto__"]) {
    assert.equal(resolve(event(key, { code: key })), null);
    assert.equal(resolve(event(key, { ...CHORD, code: key })), null);
  }
});

test("control S and the diagnostic are what they were beside the section keys", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("s", { ctrlKey: true, code: "KeyS" }))), { action: "responseScroll", value: true });
  assert.deepEqual(plain(resolve(event("M", { ...CHORD, code: "KeyM" }))), { action: "diagnostic", value: true });
});

test("dispatch hands each section key to its own action with the section", async () => {
  const { dispatch } = await shortcuts();
  const seen = [];
  const actions = {
    sectionChord(e, shortcut) { seen.push(["chord", shortcut.value]); },
    sectionKey(e, shortcut) { seen.push(["key", shortcut.value]); },
  };
  for (const { code, key, shifted } of SECTION_KEYS) {
    assert.equal(dispatch(event(shifted, { ...CHORD, code }), actions), true);
    assert.equal(dispatch(event(key, { code }), actions), true);
    assert.equal(dispatch(event(key, { code, repeat: true }), actions), false);
  }
  assert.deepEqual(seen, [["chord", "doing"], ["key", "doing"], ["chord", "deferred"], ["key", "deferred"],
                          ["chord", "done"], ["key", "done"]]);
});

// the typing rule the pages apply: the chord from the card's own composer in
// either shape and from anywhere nothing is typed; never from a title or
// another field. the keys alone only where nothing is typed at all
function tree() {
  const node = (parent, flags = {}) => ({
    parent, ...flags,
    contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    closest(selector) {
      for (let at = this; at; at = at.parent) {
        if (selector === ".cm-editor" ? at.cm : (at.field || at.cm)) return at;
      }
      return null;
    },
  });
  const body = node(null);
  const card = node(body);
  const title = node(card, { field: true });
  const cm = node(card, { cm: true });
  const content = node(cm, { field: true });
  const ta = node(cm, { field: true });
  const plainTa = node(card, { field: true });
  const other = node(body, { field: true });
  const otherCm = node(body, { cm: true });
  const otherContent = node(otherCm, { field: true });
  const button = node(card);
  return { body, title, content, ta, plainTa, other, otherContent, button, el: { ta } };
}

test("the chord comes from the card's composer or from no field; the keys alone from no field only", async () => {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const context = vm.createContext({ Date, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  const chordFrom = vm.runInContext("sectionChordSource", context);
  const editing = vm.runInContext("cardShortcutEditing", context);
  const t = tree();
  // the formatted composer: its content and the textarea it holds
  assert.equal(chordFrom(t.content, t.el), true);
  assert.equal(chordFrom(t.ta, t.el), true);
  // the plain composer is the card's textarea itself
  assert.equal(chordFrom(t.plainTa, { ta: t.plainTa }), true);
  for (const target of [t.body, t.button, null]) assert.equal(chordFrom(target, t.el), true);
  for (const target of [t.title, t.other, t.otherContent]) assert.equal(chordFrom(target, t.el), false);
  assert.equal(chordFrom(t.content, null), false);
  // the keys alone: the page's typing check refuses every field and the composer
  for (const target of [t.content, t.ta, t.plainTa, t.title, t.other, t.otherContent]) assert.equal(editing(target), true);
  for (const target of [t.body, t.button]) assert.equal(editing(target), false);
});

test("the three chips' tooltips carry the section keys", async () => {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const context = vm.createContext({ Date, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  const hints = vm.runInContext("SECTION_KEY_HINTS", context);
  assert.equal(hints.doing, "Control + Shift + [, or [ when not typing");
  assert.equal(hints.deferred, "Control + Shift + ], or ] when not typing");
  assert.equal(hints.done, "Control + Shift + \\, or \\ when not typing");
  assert.match(source, /sun\.title = "move to doing\\n" \+ SECTION_KEY_HINTS\.doing;/);
  for (const page of ["index.html", "m.html"]) {
    const html = await readFile(path.join(ROOT, page), "utf8");
    const moons = html.match(/arc\.title = "defer to the deferred tab[^;]*;/g) || [];
    const crosses = html.match(/x\.title = "done \(an empty card is removed instead\)[^;]*;/g) || [];
    assert.ok(moons.length >= 1 && crosses.length >= 1, `${page} has no chip tooltips`);
    for (const line of moons) assert.ok(line.endsWith('\\n" + SECTION_KEY_HINTS.deferred;'), `${page}: ${line}`);
    for (const line of crosses) assert.ok(line.endsWith('\\n" + SECTION_KEY_HINTS.done;'), `${page}: ${line}`);
  }
});

// ---- control+enter and control+r ----------------------------------------------------
const NOT_BARE_CONTROL = [
  {}, { metaKey: true }, { shiftKey: true }, { altKey: true },
  { ctrlKey: true, shiftKey: true }, { ctrlKey: true, metaKey: true }, { ctrlKey: true, altKey: true },
];

test("control enter is the move key and no other modifier set is", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("Enter", { ctrlKey: true }))), { action: "advance", value: true });
  // a held key's repeats are still recognized, so a page can keep them from the browser
  assert.deepEqual(plain(resolve(event("Enter", { ctrlKey: true, repeat: true }))), { action: "advance", value: true });
  for (const held of NOT_BARE_CONTROL) assert.notEqual(resolve(event("Enter", held))?.action, "advance", JSON.stringify(held));
  // a composer that took the key, or an input method's own Enter, is not asked again
  assert.equal(resolve(event("Enter", { ctrlKey: true, defaultPrevented: true })), null);
  assert.equal(resolve(event("Enter", { ctrlKey: true, isComposing: true })), null);
  assert.equal(resolve(event("Enter", { ctrlKey: true }), "mini"), null);
});

test("option enter is no card key, alone or with control, command or shift", async () => {
  const { resolve } = await shortcuts();
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const context = vm.createContext({ Date, setInterval, clearInterval, setTimeout, clearTimeout });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  const controlEnter = vm.runInContext("controlEnter", context);
  for (const held of [{ altKey: true }, { altKey: true, ctrlKey: true }, { altKey: true, metaKey: true },
                      { altKey: true, shiftKey: true }, { altKey: true, ctrlKey: true, shiftKey: true }]) {
    assert.equal(resolve(event("Enter", held)), null, JSON.stringify(held));
    assert.equal(controlEnter(event("Enter", held)), false, JSON.stringify(held));
  }
  assert.equal(controlEnter(event("Enter", { ctrlKey: true })), true);
});

test("every page's Enter send and title save leaves out the Option key", async () => {
  for (const page of ["index.html", "m.html", "page.html", "card-logic.js"]) {
    const lines = (await readFile(path.join(ROOT, page), "utf8")).split("\n");
    lines.forEach((line, at) => {
      const send = /"Enter"/.test(line) && /shiftKey/.test(line);
      const save = /key === "Enter"/.test(line) && /commit\(\)/.test(line);
      if (send || save) assert.ok(/altKey/.test(line), `${page}:${at + 1} lets Option+Enter through: ${line.trim()}`);
    });
  }
  // the phone composer names the key on a line of its own
  const phone = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.match(phone, /if \(e\.altKey\) \{ notePhoneEnter\("handler", e, "modifier", ta\); return; \}/);
});

test("control r is the random jump key and no other modifier set is", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("r", { ctrlKey: true }))), { action: "random", value: true });
  assert.deepEqual(plain(resolve(event("R", { ctrlKey: true }))), { action: "random", value: true });
  assert.deepEqual(plain(resolve(event("r", { ctrlKey: true, repeat: true }))), { action: "random", value: true });
  for (const held of NOT_BARE_CONTROL) assert.notEqual(resolve(event("r", held))?.action, "random", JSON.stringify(held));
  assert.equal(resolve(event("r", { ctrlKey: true, defaultPrevented: true })), null);
  assert.equal(resolve(event("r", { ctrlKey: true, isComposing: true })), null);
  assert.equal(resolve(event("r", { ctrlKey: true }), "mini"), null);
  assert.equal(resolve(event("t", { ctrlKey: true })), null);
});

test("dispatch hands control enter and control r to the page's own action and leaves the event alone", async () => {
  const { dispatch } = await shortcuts();
  const seen = [];
  const actions = {
    advance(received) { seen.push(["advance", received.key]); },
    random(received) { seen.push(["random", received.key]); },
  };
  const enter = event("Enter", { ctrlKey: true });
  const random = event("r", { ctrlKey: true });
  assert.equal(dispatch(enter, actions), true);
  assert.equal(dispatch(random, actions), true);
  assert.deepEqual(seen, [["advance", "Enter"], ["random", "r"]]);
  assert.equal(enter.defaultPrevented || random.defaultPrevented, false, "dispatch canceled an event itself");
  assert.equal(dispatch(enter, {}), false);
});

async function randomPick() {
  const source = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  const context = vm.createContext({ Date, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(source, context, { filename: "card-logic.js" });
  return {
    pick: vm.runInContext("pickRandomCard", context),
    green: vm.runInContext("ticketGreen", context),
    queued: vm.runInContext("ticketQueued", context),
    standing: vm.runInContext("isStandingBox", context),
  };
}

test("a green ticket is a working or note card, and a done card still at work", async () => {
  const { green } = await randomPick();
  for (const state of ["working", "note"]) assert.equal(green({ id: "a", state }), true, state);
  for (const state of ["yours", "queued", "new", "parked", "done"]) assert.equal(green({ id: "a", state }), false, state);
  assert.equal(green({ id: "a", state: "done", writing: true }), true);
  assert.equal(green({ id: "a", parked: true, state: null, writing: true }), true);
  assert.equal(green({ id: "a", parked: true, state: null, ball: "you", replies: 1 }), false);
});

test("a grey ticket is a queued card, a parked one included, and nothing else", async () => {
  const { queued } = await randomPick();
  assert.equal(queued({ id: "a", state: "queued" }), true);
  assert.equal(queued({ id: "a", state: "yours", pending: 1 }), true);
  assert.equal(queued({ id: "a", parked: true, state: null, ball: "you", pending: 1 }), true);
  for (const state of ["yours", "new", "working", "note", "done", "parked"]) assert.equal(queued({ id: "a", state }), false, state);
});

test("the random pick leaves out green and queued tickets, the card on screen and the standing boxes", async () => {
  const { pick, standing } = await randomPick();
  assert.deepEqual([standing("0"), standing("t0"), standing("q"), standing("m1")], [true, true, false, false]);
  const pool = [
    { id: "0", state: "new" }, { id: "t0", state: "yours" },
    { id: "a", state: "yours" }, { id: "b", state: "queued" }, { id: "c", state: "working" },
    { id: "d", state: "note" }, { id: "e", state: "yours" }, { id: "f", state: "new" },
    { id: "g", state: "yours", pending: 2 },
  ];
  assert.equal(pick(pool, "a", () => 0), "e");
  assert.equal(pick(pool, "a", () => 0.999), "f");
  assert.equal(pick(pool, "e", () => 0), "a");
  assert.equal(pick(pool, null, () => 0), "a");
  // every one of the open cards can come up, and nothing else does
  const seen = new Set();
  for (let at = 0; at < 4; at++) seen.add(pick(pool, "a", () => at / 4));
  assert.deepEqual([...seen].sort(), ["e", "f"]);
  assert.ok(["e", "f"].includes(pick(pool, "a")), "the default chooser named a card outside the open ones");
});

test("the random pick has nothing to answer with when no card qualifies", async () => {
  const { pick } = await randomPick();
  assert.equal(pick([], "a"), null);
  assert.equal(pick([{ id: "a", state: "yours" }], "a"), null);
  assert.equal(pick([{ id: "a", state: "yours" }, { id: "c", state: "working" }, { id: "0", state: "new" }], "a"), null);
  assert.equal(pick([{ id: "a", state: "yours" }, { id: "b", state: "queued" }, { id: "c", state: "working" }], "a"), null);
});
