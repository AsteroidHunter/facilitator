// The Share daily usage counts switch: an Improvements section on the Mac's
// settings page and in the phone's settings drawer, a switch that is on by
// default, and its wiring. The Mac page keeps it with the board's settings
// (usagecounts, "0" when off); the phone reads and writes the same setting on
// the board, since the Mac does the sending. The groups are read from each
// page's #setsrc, which the shared settings page in card-logic.js builds its
// sections from, and each page's own wiring is run in a vm with the store, the
// board and the elements replaced by small fakes. No browser and no server.
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

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} ... ${to} is not in the page`);
  return source.slice(start, end);
}

// the settings groups a page holds, in order, each with its own markup
function groups(setsrc) {
  const found = [...setsrc.matchAll(/<div data-section="([^"]+)" data-label="([^"]+)">/g)];
  return found.map((m, i) => ({ section: m[1], label: m[2],
                                html: setsrc.slice(m.index, i + 1 < found.length ? found[i + 1].index : undefined) }));
}

function theSwitch(html) {
  const input = /<input\b[^>]*\bid="setusage"[^>]*>/.exec(html);
  assert.ok(input, "no setusage control in the Improvements section");
  const label = /<label class="setlabel" for="setusage"><span>([^<]+)<\/span>/.exec(html);
  return { tag: input[0], label: label && label[1] };
}

const VIEWS = {
  mac: { source: MAC, setsrc: () => between(MAC, '<div id="setsrc"', '<div id="appframe"'),
         sections: ["appearance", "editor", "improvements"] },
  phone: { source: PHONE, setsrc: () => between(PHONE, '<div id="setsrc">', '<div id="setfoot">'),
           sections: ["editor", "notifications", "improvements", "diagnostics"] },
};

for (const [name, view] of Object.entries(VIEWS)) {
  test(`the ${name} settings have an Improvements section holding the switch, on by default`, () => {
    const all = groups(view.setsrc());
    assert.deepEqual(all.map(g => g.section), view.sections);
    const improvements = all.find(g => g.section === "improvements");
    assert.equal(improvements.label, "Improvements");
    const { tag, label } = theSwitch(improvements.html);
    assert.equal(label, "Share daily usage counts");
    assert.match(tag, /\btype="checkbox"/);
    assert.match(tag, /\brole="switch"/, "not the settings' switch look");
    assert.match(tag, /\schecked(?=[\s>])/, "the switch is not on before anything is read");
    assert.match(improvements.html, /<div class="setrow">/, "the switch is not in a settings row");
    assert.match(improvements.html, /README/, "the section does not say where every field is listed");
  });
}

test("the switch is one of the board's settings on the Mac page, as on the board", () => {
  assert.equal(isSetting("usagecounts"), true);
  const server = readFileSync(path.join(ROOT, "server.py"), "utf8");
  assert.match(between(server, "SETTINGS_KEY = re.compile(", "SPOTIFY_FIELDS"), /\|usagecounts\|/);
});

// the Mac page's settings block, with its store, overlay and composer fakes
function macPage(stored = {}) {
  const store = new Map(Object.entries(stored));
  const elements = new Map(), classes = new Set();
  let overlay = null;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, checked: id === "setusage", events: {},
      setAttribute() {}, addEventListener(type, fn) { this.events[type] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, body: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } } },
    settingsStore: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                     removeItem: k => store.delete(k) },
    settingsOverlay: (host, source, opts) => { overlay = opts; return { open: () => opts.onOpen() } },
    ComposeFormat: { enabled: () => false, setEnabled() {}, onChange() {}, preload() {} },
  });
  vm.runInContext(between(MAC, "// ---- settings ----", "function buildHandles()"), context);
  const usage = element("setusage");
  return {
    store, usage,
    flip(on) { usage.checked = on; usage.events.change(); },
    open() { element("setbtn").events.click(); },
  };
}

test("on the Mac page the switch is on until the board's setting says 0, and a flip writes it", () => {
  const page = macPage();
  assert.equal(page.usage.checked, true, "a board with nothing stored shows the switch off");
  page.flip(false);
  assert.equal(page.store.get("usagecounts"), "0");
  page.flip(true);
  assert.equal(page.store.has("usagecounts"), false, "on is not the board's default again");

  const off = macPage({ usagecounts: "0" });
  assert.equal(off.usage.checked, false, "a board switched off shows the switch on");
  off.store.delete("usagecounts");      // another window turned it back on
  off.open();
  assert.equal(off.usage.checked, true, "opening the page does not show the board's choice");
});

// the phone's block, with the board answering /settings
function phonePage({ values = {}, refuse = false } = {}) {
  const board = { values: { ...values }, calls: [], refuse };
  const usage = { checked: true, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const item = { events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const context = vm.createContext({
    document: {
      getElementById: id => (id === "setusage" ? usage : null),
      querySelector: sel => (sel === '#setpage .sp-item[data-section="improvements"]' ? item : null),
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
  vm.runInContext(between(PHONE, "// the daily usage counts: the one switch here", "// the editor it is drawn with"), context);
  return {
    board, usage,
    async flip(on) { usage.checked = on; usage.events.change(); await settle(); },
    async openSection() { item.events.click(); await settle(); },
  };
}

test("on the phone the switch reads the board's setting and writes it back", async () => {
  const page = phonePage();
  assert.equal(page.usage.checked, true, "the switch is not on before the board answers");
  await settle();
  assert.deepEqual(page.board.calls, [["/settings", "GET", null]]);
  assert.equal(page.usage.checked, true, "a board with nothing stored shows the switch off");
  await page.flip(false);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { usagecounts: "0" }]);
  assert.equal(page.board.values.usagecounts, "0");
  assert.equal(page.usage.checked, false);
  await page.flip(true);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { usagecounts: null }]);
  assert.equal("usagecounts" in page.board.values, false);
  assert.equal(page.usage.checked, true);
});

test("on the phone a board switched off shows off, a change on the Mac shows when the section opens, and a refused flip flips back", async () => {
  const page = phonePage({ values: { usagecounts: "0" } });
  await settle();
  assert.equal(page.usage.checked, false);
  delete page.board.values.usagecounts;  // turned back on from the Mac
  await page.openSection();
  assert.equal(page.usage.checked, true, "opening Improvements does not read the board again");

  const refused = phonePage({ refuse: true });
  await settle();
  await refused.flip(false);
  assert.equal(refused.usage.checked, true, "a flip the board did not keep stays shown");
});
