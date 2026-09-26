// The composer's arrow chords, read off the keymap a composer's editor is
// really created with and run through the vendored editor's own commands.
//
// The editor's stock keymap moves the caret's line up or down on Option (Alt)
// with Up or Down, and copies it with Shift added. A wrapped paragraph is one
// line to the editor, so in the composer those chords moved or copied whole
// paragraphs of the message. The composer leaves those four bindings out, and
// keeps every caret and selection binding the stock keymap has.
//
// No browser: the bundle and compose-format.js are loaded into a bare context
// with a navigator saying which platform it is, which is all the bundle reads
// to choose its Mac or its other bindings. Chords are resolved the way the
// bundle's keymap handler resolves them, over the same keymap facet the
// mounted editor reads, in the same precedence order. A command the chord
// reaches is then run on the state; one that needs a laid out view cannot run
// here and is recorded as such, which is every caret command. What this can
// not say is what the browser itself does with a chord no binding answers.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const BUNDLE = readFileSync(path.join(ROOT, "cm-markdown.js"), "utf8");
const COMPOSE = readFileSync(path.join(ROOT, "compose-format.js"), "utf8");

const PLATFORMS = {
  mac: {
    platform: "MacIntel", vendor: "Apple Computer, Inc.", maxTouchPoints: 0,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  },
  win: {
    platform: "Win32", vendor: "Google Inc.", maxTouchPoints: 0,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  },
};

function load(platform) {
  const context = vm.createContext({ navigator: PLATFORMS[platform], console });
  vm.runInContext(BUNDLE, context, { filename: "cm-markdown.js" });
  vm.runInContext(COMPOSE, context, { filename: "compose-format.js" });
  const C = vm.runInContext("CM6", context);
  const api = vm.runInContext("ComposeFormat", context);
  assert.ok(C && C.keymap && C.defaultKeymap, "the bundle did not load");
  assert.equal(typeof api.freshState, "function", "compose-format.js hands out no composer state");
  return { C, api, platform };
}

// the bundle's own spelling of a key: its modifiers written Alt, Ctrl, Meta,
// Shift in that order, Mod meaning Command on a Mac and Control elsewhere
function normalize(name, platform) {
  const parts = name.split(/-(?!$)/);
  let key = parts[parts.length - 1];
  if (key === "Space") key = " ";
  let alt = false, ctrl = false, meta = false, shift = false;
  for (const mod of parts.slice(0, -1)) {
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shift = true;
    else if (/^mod$/i.test(mod)) { if (platform === "mac") meta = true; else ctrl = true; }
    else throw new Error("unknown modifier " + mod);
  }
  return (alt ? "Alt-" : "") + (ctrl ? "Ctrl-" : "") + (meta ? "Meta-" : "") +
    (shift ? "Shift-" : "") + key;
}

// every command a key name reaches, in the order the handler tries them: the
// facet's keymaps highest precedence first, each in its own order, the Mac
// spelling of a binding used on a Mac when it has one
function resolve(state, C, platform) {
  const table = new Map();
  const add = (name, run, prevent) => {
    const at = normalize(name, platform);
    const entry = table.get(at) || { runs: [], preventDefault: false };
    if (!entry.runs.includes(run)) entry.runs.push(run);
    entry.preventDefault = entry.preventDefault || !!prevent;
    table.set(at, entry);
  };
  for (const binding of state.facet(C.keymap).flat()) {
    const scopes = binding.scope ? binding.scope.split(" ") : ["editor"];
    if (!scopes.includes("editor")) continue;
    const name = binding[platform] || binding.key;
    if (!name || / /.test(name)) continue;
    if (binding.run) add(name, binding.run, binding.preventDefault);
    if (binding.shift) add("Shift-" + name, binding.shift, binding.preventDefault);
  }
  return table;
}

function chordName({ key, alt, ctrl, meta, shift }) {
  return (alt ? "Alt-" : "") + (ctrl ? "Ctrl-" : "") + (meta ? "Meta-" : "") +
    (shift ? "Shift-" : "") + key;
}

class NeedsLayout extends Error {}

// Run what a chord reaches until a command takes it, the way the handler
// does. The stand-in view has a state and a dispatch and nothing else: a
// command asking it for anything more is a caret command needing layout.
function press(state, C, platform, chord) {
  const entry = resolve(state, C, platform).get(chordName(chord));
  const reached = [];
  let current = state, outcome = "unbound";
  if (!entry) return { reached, text: current.doc.toString(), outcome, preventDefault: false };
  for (const run of entry.runs) {
    reached.push(run);
    const target = {
      get state() { return current; },
      dispatch(...specs) {
        const tr = specs.length === 1 && specs[0] && specs[0].startState ? specs[0] : current.update(...specs);
        current = tr.state;
      },
    };
    const view = new Proxy(target, {
      get(own, prop) {
        if (prop in own) return Reflect.get(own, prop);
        throw new NeedsLayout(String(prop));
      },
    });
    let took;
    try { took = run(view); } catch (error) {
      if (!(error instanceof NeedsLayout)) throw error;
      outcome = "needs-layout";
      break;
    }
    if (took) { outcome = "ran"; break; }
    outcome = "declined";
  }
  return { reached, text: current.doc.toString(), outcome, preventDefault: entry.preventDefault };
}

const FIELD = { shellClass: "compose-test", newline: event => event.shiftKey, changed() {} };
const TEXT = [
  "First paragraph, long enough to wrap onto several rows in a narrow row.",
  "Second paragraph, where the caret sits.",
  "Third paragraph closing the message.",
].join("\n");
const CARET = TEXT.indexOf("where");

function composerState(C, api) { return api.freshState(C, FIELD, TEXT, CARET); }
function stockState(C) {
  return C.EditorState.create({
    doc: TEXT, selection: { anchor: CARET }, extensions: [C.keymap.of(C.defaultKeymap)],
  });
}

const LINE_CHORDS = [
  { key: "ArrowUp", alt: true }, { key: "ArrowDown", alt: true },
  { key: "ArrowUp", alt: true, shift: true }, { key: "ArrowDown", alt: true, shift: true },
];

// The caret and selection chords a typist steps through text with. Control
// with Shift and an arrow is left out: the page claims those for itself, on
// purpose, ahead of the stock keymap.
function caretChords(platform) {
  const out = [];
  const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  for (const shift of [false, true]) {
    for (const key of arrows) out.push({ key, shift });
    for (const key of ["ArrowLeft", "ArrowRight"]) out.push({ key, alt: true, shift });
    for (const key of ["Home", "End", "PageUp", "PageDown"]) out.push({ key, shift });
    if (platform === "mac") {
      // Command with an arrow runs to a line's or the message's ends
      for (const key of arrows) out.push({ key, meta: true, shift });
      for (const key of ["Home", "End"]) out.push({ key, meta: true, shift });
    } else {
      // Control with Left or Right steps a word, with Home or End the message
      for (const key of shift ? ["Home", "End"] : ["ArrowLeft", "ArrowRight", "Home", "End"])
        out.push({ key, ctrl: true, shift });
    }
  }
  // Control with an arrow on a Mac is the stock page step and syntax jump
  if (platform === "mac") for (const key of arrows) out.push({ key, ctrl: true });
  return out;
}

for (const platform of Object.keys(PLATFORMS)) {
  test(`${platform}: the stock keymap moves and copies the caret's line, which is what the composer must not do`, () => {
    const { C } = load(platform);
    const [first, second, third] = TEXT.split("\n");
    // moved up, moved down, copied above, copied below
    const expected = [
      [second, first, third], [first, third, second],
      [first, second, second, third], [first, second, second, third],
    ].map(lines => lines.join("\n"));
    LINE_CHORDS.forEach((chord, i) => {
      const result = press(stockState(C), C, platform, chord);
      assert.equal(result.outcome, "ran", `stock ${chordName(chord)} ran nothing`);
      assert.equal(result.text, expected[i], `stock ${chordName(chord)} did not move or copy the line`);
    });
  });

  test(`${platform}: Option or Alt with Up or Down, with or without Shift, reaches no composer binding`, () => {
    const { C, api } = load(platform);
    for (const chord of LINE_CHORDS) {
      const result = press(composerState(C, api), C, platform, chord);
      assert.equal(result.reached.length, 0,
        `${chordName(chord)} still reaches a composer binding`);
      assert.equal(result.preventDefault, false,
        `${chordName(chord)} would still keep the key from the browser`);
      assert.equal(result.text, TEXT, `${chordName(chord)} changed the message`);
    }
  });

  test(`${platform}: every caret and selection chord reaches the same commands as the stock keymap and changes no text`, () => {
    const { C, api } = load(platform);
    const composer = resolve(composerState(C, api), C, platform);
    const stock = resolve(stockState(C), C, platform);
    for (const chord of caretChords(platform)) {
      const name = chordName(chord);
      const want = stock.get(name);
      assert.ok(want, `the stock keymap has no ${name}; this list is out of date`);
      assert.deepEqual(composer.get(name)?.runs, want.runs, `${name} is bound differently in the composer`);
      assert.equal(composer.get(name).preventDefault, want.preventDefault, `${name} prevents differently`);
      const result = press(composerState(C, api), C, platform, chord);
      assert.equal(result.text, TEXT, `${name} changed the message`);
    }
  });

  test(`${platform}: the composer keeps every stock binding but the return key and the four line chords`, () => {
    const { C, api } = load(platform);
    // copied into this realm's arrays so they compare as plain arrays do
    const carried = new Set([...composerState(C, api).facet(C.keymap)].flatMap(keys => [...keys]));
    const left = [...C.defaultKeymap].filter(binding => !carried.has(binding)).map(binding => binding.key);
    const lineKeys = LINE_CHORDS.map(chord => normalize(chordName(chord), platform));
    assert.deepEqual(
      left.filter(key => !/Enter/.test(key || "")).map(key => normalize(key, platform)).sort(),
      [...lineKeys].sort(),
      "the composer drops a stock binding it should keep, or keeps a line chord",
    );
  });
}

test("mac: Option with Left or Right is the stock word jump and its selecting form", () => {
  const { C, api } = load("mac");
  const composer = resolve(composerState(C, api), C, "mac");
  for (const [key, stockKey] of [["ArrowLeft", "Mod-ArrowLeft"], ["ArrowRight", "Mod-ArrowRight"]]) {
    const binding = C.defaultKeymap.find(b => b.key === stockKey && b.mac === "Alt-" + key);
    assert.ok(binding, `the stock keymap has no Mac word jump for ${key}`);
    assert.equal(composer.get("Alt-" + key)?.runs[0], binding.run, `Option ${key} is not the word jump`);
    assert.equal(composer.get("Alt-Shift-" + key)?.runs[0], binding.shift,
      `Shift Option ${key} is not the word selection`);
  }
});
