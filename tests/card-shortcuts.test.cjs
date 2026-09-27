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
  assert.deepEqual(plain(resolve(event("[", { metaKey: true, shiftKey: true }))),
    { action: "navigate", value: -1 });
  assert.deepEqual(plain(resolve(event("}", { metaKey: true, ctrlKey: true, shiftKey: true, altKey: true }))),
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

test("control N and control L name card destinations only with control alone and not composing", async () => {
  const { resolve } = await shortcuts();
  for (const key of ["n", "N"]) {
    assert.deepEqual(plain(resolve(event(key, { ctrlKey: true }))), { action: "destination", value: "doing" });
    assert.equal(resolve(event(key, { ctrlKey: true }), "mini"), null);
  }
  for (const key of ["l", "L"]) {
    assert.deepEqual(plain(resolve(event(key, { ctrlKey: true }))), { action: "destination", value: "deferred" });
    assert.equal(resolve(event(key, { ctrlKey: true }), "mini"), null);
  }
  for (const key of ["n", "l"]) {
    for (const modifier of ["metaKey", "shiftKey", "altKey", "repeat", "isComposing", "defaultPrevented"]) {
      assert.equal(resolve(event(key, { ctrlKey: true, [modifier]: true })), null, `control ${key} with ${modifier}`);
    }
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
  assert.deepEqual(plain(resolve(event("Delete", {
    metaKey: true, ctrlKey: true, shiftKey: true, altKey: true,
  }))), { action: "close", value: true });
  assert.deepEqual(plain(resolve(event("Backspace"))), { action: "close", value: true });
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

test("command shift [ and ] still step to the previous and next card, with or without control", async () => {
  const { resolve } = await shortcuts();
  for (const extra of [{}, { ctrlKey: true }]) {
    assert.deepEqual(plain(resolve(event("{", { metaKey: true, shiftKey: true, code: "BracketLeft", ...extra }))),
      { action: "navigate", value: -1 });
    assert.deepEqual(plain(resolve(event("}", { metaKey: true, shiftKey: true, code: "BracketRight", ...extra }))),
      { action: "navigate", value: 1 });
  }
  // command shift \ is no command, and never a section
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

test("control N, control L and backspace are what they were beside the section keys", async () => {
  const { resolve } = await shortcuts();
  assert.deepEqual(plain(resolve(event("n", { ctrlKey: true, code: "KeyN" }))), { action: "destination", value: "doing" });
  assert.deepEqual(plain(resolve(event("l", { ctrlKey: true, code: "KeyL" }))), { action: "destination", value: "deferred" });
  assert.equal(resolve(event("n", { ctrlKey: true, shiftKey: true, code: "KeyN" })), null);
  assert.deepEqual(plain(resolve(event("Backspace", { code: "Backspace" }))), { action: "close", value: true });
  assert.deepEqual(plain(resolve(event("Delete", { code: "Delete" }))), { action: "close", value: true });
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
