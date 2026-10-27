// The "Replace curse words" switch: a row in the Editor section of the Mac's
// settings page and of the phone's settings drawer, off by default, and its
// wiring. It is the board's expletives setting ("1" when on, absent when off),
// which the server reads at each send (_curse_free), so the Mac page keeps it
// with the board's settings and the phone reads and writes the same setting on
// the board. The groups are read from each page's #setsrc, and each page's own
// wiring is run in a vm with the store, the board and the elements replaced by
// small fakes. No browser and no server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { isSetting } = require("../board-settings.js");

const ROOT = path.resolve(__dirname, "..");
const MAC = readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };
const CAPTION = "Curse words in the messages you send are saved as [expletive], so the board, its history and agents only see the tag. Messages sent before stay as they are.";

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} ... ${to} is not in the page`);
  return source.slice(start, end);
}

function groups(setsrc) {
  const found = [...setsrc.matchAll(/<div data-section="([^"]+)" data-label="([^"]+)">/g)];
  return found.map((m, i) => ({ section: m[1], label: m[2],
                                html: setsrc.slice(m.index, i + 1 < found.length ? found[i + 1].index : undefined) }));
}

const VIEWS = {
  mac: { setsrc: () => between(MAC, '<div id="setsrc"', '<div id="appframe"'),
         sections: ["profile", "appearance", "editor", "improvements", "bin"] },
  phone: { setsrc: () => between(PHONE, '<div id="setsrc">', '<div id="setfoot">'),
           sections: ["profile", "appearance", "editor", "notifications", "improvements", "diagnostics"] },
};

for (const [name, view] of Object.entries(VIEWS)) {
  test(`the ${name} settings hold the switch in Editor, under the formatting switch, off by default`, () => {
    const all = groups(view.setsrc());
    assert.deepEqual(all.map(g => g.section), view.sections, "a section was added, moved or lost");
    const editor = all.find(g => g.section === "editor");
    const input = /<input\b[^>]*\bid="setcurses"[^>]*>/.exec(editor.html);
    assert.ok(input, "no setcurses control in the Editor section");
    assert.match(input[0], /\btype="checkbox"/);
    assert.match(input[0], /\brole="switch"/, "not the settings' switch look");
    assert.doesNotMatch(input[0], /\schecked(?=[\s>])/, "the switch is on before anything is read");
    assert.match(editor.html, /<div class="setrow">\s*<label class="setlabel" for="setcurses"><span>Replace curse words<\/span>/,
      "the switch is not in a settings row with its name");
    assert.ok(editor.html.includes(`<small class="sethelp">${CAPTION}</small>`), "the caption is not the same on both pages");
    assert.ok(editor.html.indexOf('id="setformat"') < editor.html.indexOf('id="setcurses"'), "the switch is above the formatting one");
    assert.doesNotMatch(editor.html, /#432BFF|—/i);
  });
}

test("the switch is one of the board's settings, on the page as on the board", () => {
  assert.equal(isSetting("expletives"), true);
  const server = readFileSync(path.join(ROOT, "server.py"), "utf8");
  assert.match(between(server, "SETTINGS_KEY = re.compile(", "SPOTIFY_FIELDS"), /\|expletives\|/);
  assert.match(server, /EXPLETIVES_SETTING = "expletives"/);
});

function macPage(stored = {}) {
  const store = new Map(Object.entries(stored));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, checked: false, events: {},
      closest: () => ({}), setAttribute() {}, addEventListener(type, fn) { this.events[type] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, body: { classList: { add() {}, remove() {} } } },
    settingsStore: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                     removeItem: k => store.delete(k) },
    settingsOverlay: (host, source, opts) => ({ open: () => opts.onOpen() }),
    ComposeFormat: { enabled: () => false, setEnabled() {}, onChange() {}, preload() {} },
    waitNewestFirst: () => false, lastState: null, renderCarousel() {},
    fetch: async () => ({ ok: false }),
    feedbackBox: () => ({ setReady() {} }),
    feedbackOverlay: () => ({ open() {}, close() {}, seat() {} }),
    controlShiftEnter: () => false, bareControlEnter: () => false,
  });
  vm.runInContext(between(MAC, "// ---- settings ----", "function buildHandles()"), context);
  const curses = element("setcurses");
  return {
    store, curses,
    flip(on) { curses.checked = on; curses.events.change(); },
    open() { element("setbtn").events.click(); },
  };
}

test("on the Mac page the switch is off until the board's setting says 1, and a flip writes it", () => {
  const page = macPage();
  assert.equal(page.curses.checked, false, "a board with nothing stored shows the switch on");
  page.flip(true);
  assert.equal(page.store.get("expletives"), "1");
  page.flip(false);
  assert.equal(page.store.has("expletives"), false, "off is not the board's default again");

  const on = macPage({ expletives: "1" });
  assert.equal(on.curses.checked, true, "a board switched on shows the switch off");
  on.store.delete("expletives");      // another window, or the phone, turned it off
  on.open();
  assert.equal(on.curses.checked, false, "opening the page does not show the board's choice");
});

function phonePage({ values = {}, refuse = false } = {}) {
  const board = { values: { ...values }, calls: [], refuse };
  const curses = { checked: false, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const item = { events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const context = vm.createContext({
    document: {
      getElementById: id => (id === "setcurses" ? curses : null),
      querySelector: sel => (sel === '#setpage .sp-item[data-section="editor"]' ? item : null),
    },
    fetch: async (url, init = {}) => {
      board.calls.push([url, init.method || "GET", init.body ? JSON.parse(init.body) : null]);
      if (init.method === "POST") {
        if (board.refuse) return { ok: false, status: 500 };
        for (const [k, v] of Object.entries(JSON.parse(init.body))) {
          if (v === null) delete board.values[k]; else board.values[k] = v;
        }
      }
      return { ok: true, json: async () => ({ rev: 1, values: { ...board.values } }) };
    },
  });
  vm.runInContext(between(PHONE, "// whether the reader's curse words are saved as [expletive]", "// the profile the Mac keeps"), context);
  return {
    board, curses,
    async flip(on) { curses.checked = on; curses.events.change(); await settle(); },
    async openSection() { item.events.click(); await settle(); },
  };
}

test("on the phone the switch reads the board's setting and writes it back", async () => {
  const page = phonePage();
  await settle();
  assert.deepEqual(page.board.calls, [["/settings", "GET", null]]);
  assert.equal(page.curses.checked, false, "a board with nothing stored shows the switch on");
  await page.flip(true);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { expletives: "1" }]);
  assert.equal(page.board.values.expletives, "1");
  assert.equal(page.curses.checked, true);
  await page.flip(false);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { expletives: null }]);
  assert.equal("expletives" in page.board.values, false);
  assert.equal(page.curses.checked, false);
});

test("on the phone a board switched on shows on, a change on the Mac shows when Editor opens, and a refused flip flips back", async () => {
  const page = phonePage({ values: { expletives: "1" } });
  await settle();
  assert.equal(page.curses.checked, true);
  delete page.board.values.expletives;   // turned off from the Mac
  await page.openSection();
  assert.equal(page.curses.checked, false, "opening Editor does not read the board again");

  const refused = phonePage({ refuse: true });
  await settle();
  await refused.flip(true);
  assert.equal(refused.curses.checked, false, "a flip the board did not keep stays shown");
});
