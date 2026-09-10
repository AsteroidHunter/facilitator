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
