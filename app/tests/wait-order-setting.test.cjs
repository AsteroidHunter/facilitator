// The Cards waiting on you option: whether the cards awaiting the reader are
// listed oldest turn first (the default) or newest turn first, on the Mac board
// and the phone. Only that group's order turns over: new, queued, working,
// done, docked and deferred cards stand as they did, and the jump after a send
// lands on the same card either way. The order is poolOf's in card-logic.js,
// run in a vm; the option is one of the board's settings (waitnewest, "1" for
// newest first and absent for oldest first), and each page's own wiring is run
// in a vm with the store, the board and the elements replaced by small fakes.
// No browser and no server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { create, isSetting } = require("../board-settings.js");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const MAC = readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} ... ${to} is not in the page`);
  return source.slice(start, end);
}

// ---- the order, on its own ---------------------------------------------------------
function logicWith(state, newest) {
  const calls = [];
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: () => ({}), body: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    els: {}, lastState: state, selectedId: null, activeOwner: "lane", lastSel: {},
    select: (id, opts) => calls.push(id),
    deselect: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  // a page hands the answer in the way the Mac and the phone do
  if (newest !== undefined) vm.runInContext(`waitNewestFirst = () => ${newest}`, sandbox);
  return { sandbox, calls };
}
const card = (id, extra) => ({ id, owner: "lane", bucket: "meta", title: "card " + id, ball: "you", state: "yours",
  replies: 1, agentTs: 1, ts: 1, pending: 0, done: false, parked: false, ...extra });

function board() {
  return { boxes: [
    card("late", { agentTs: 9 }),
    card("fresh", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 50 }),
    card("bare", { agentTs: 0, ts: 0 }),
    card("tie-a", { agentTs: 5 }),
    card("tie-b", { agentTs: 5 }),
    card("early", { agentTs: 2 }),
    card("ts-only", { agentTs: 0, ts: 7 }),
    card("q1", { state: "queued", ball: "me", ts: 30 }), card("q2", { state: "queued", ball: "me", ts: 40 }),
    card("w1", { state: "working", ball: "me", ts: 10 }), card("w2", { state: "working", ball: "me", ts: 20 }),
    card("d1", { state: "done", done: true, ts: 1 }), card("d2", { state: "done", done: true, ts: 2 }),
    card("newer", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 60 }),
    // docked and deferred cards with equal stamps fall back to the order of Doing
    card("k1", { docked: true, dockedTs: 100, agentTs: 8 }), card("k2", { docked: true, dockedTs: 100, agentTs: 3 }),
    card("p1", { parked: true, state: "parked", parkedTs: 100, agentTs: 8 }),
    card("p2", { parked: true, state: "parked", parkedTs: 100, agentTs: 3 }),
  ] };
}
const idsOf = (sandbox, state) => [...sandbox.poolOf(state).map(b => b.id)];

const OLDEST = ["newer", "fresh", "early", "tie-a", "tie-b", "ts-only", "late", "bare", "q2", "q1", "w2", "w1",
                "k2", "k1", "p2", "p1", "d2", "d1"];
const NEWEST = ["newer", "fresh", "bare", "late", "ts-only", "tie-a", "tie-b", "early", "q2", "q1", "w2", "w1",
                "k2", "k1", "p2", "p1", "d2", "d1"];

test("with nothing chosen the waiting cards run oldest turn first, as they did", () => {
  const state = board();
  assert.deepEqual(idsOf(logicWith(state).sandbox, state), OLDEST, "no answer from the page");
  assert.deepEqual(idsOf(logicWith(state, "false").sandbox, state), OLDEST, "oldest first chosen");
});

test("newest first turns the waiting cards over and nothing else, equal turns keeping the board's order", () => {
  const state = board();
  const order = idsOf(logicWith(state, "true").sandbox, state);
  assert.deepEqual(order, NEWEST);
  const rest = list => list.filter(id => !["early", "tie-a", "tie-b", "ts-only", "late", "bare"].includes(id));
  assert.deepEqual(rest(order), rest(OLDEST), "a group other than the waiting cards moved");
});

test("a card that cannot be aged leads the list when newest first, and trails it when oldest first", () => {
  const state = { boxes: [card("a", { agentTs: 4 }), card("none", { agentTs: 0, ts: 0 }), card("b", { agentTs: 8 })] };
  assert.deepEqual(idsOf(logicWith(state, "false").sandbox, state), ["a", "b", "none"]);
  assert.deepEqual(idsOf(logicWith(state, "true").sandbox, state), ["none", "b", "a"]);
});

test("the section lists draw the same order the pool does", () => {
  const state = board();
  const old = logicWith(state, "false").sandbox, fresh = logicWith(state, "true").sandbox;
  const todo = sandbox => [...sandbox.viewPoolFor(state, "todo").map(b => b.id)];
  assert.deepEqual(todo(old), OLDEST.slice(0, 12));
  assert.deepEqual(todo(fresh), NEWEST.slice(0, 12));
  const docked = sandbox => [...sandbox.viewPoolFor(state, "docked").map(b => b.id)];
  assert.deepEqual(docked(fresh), docked(old), "Docked changed with the option");
});

test("the jump after a send lands on the same card, whichever way the list is drawn", () => {
  const state = board();
  const landings = newest => {
    const { sandbox, calls } = logicWith(state, newest);
    const list = sandbox.viewPoolFor(state, "todo");
    for (const from of ["late", "early", "tie-a", "tie-b", "bare", "ts-only", "w1"]) sandbox.jumpNextYellow(from, null, list);
    // and from the page's own pool, as the Mac asks it
    vm.runInContext("lastState = " + JSON.stringify(state), sandbox);
    for (const from of ["late", "early", "tie-a"]) sandbox.jumpNextYellow(from, null);
    return calls;
  };
  const oldest = landings("false");
  assert.deepEqual(oldest.slice(0, 7), ["early", "tie-a", "early", "early", "early", "early", "early"]);
  assert.deepEqual(landings("true"), oldest);
  assert.deepEqual(landings(undefined), oldest);
});

// ---- the option is one of the board's settings -----------------------------------------
test("waitnewest is a setting of the board, in the browser file and in the server's list", () => {
  assert.equal(isSetting("waitnewest"), true);
  assert.equal(isSetting("waitnewest.2"), false);
  const server = readFileSync(path.join(ROOT, "server.py"), "utf8");
  assert.match(between(server, "SETTINGS_KEY = re.compile(", "SPOTIFY_FIELDS"), /\|waitnewest\|/);
});

test("the store keeps it like its neighbours: set, read back, removed, and sent to the board", () => {
  const sent = [], local = new Map();
  const store = create({
    seed: { rev: 1, values: { usagecounts: "0" } },
    local: { getItem: k => local.has(k) ? local.get(k) : null, setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k),
             key: i => [...local.keys()][i] ?? null, get length() { return local.size; } },
    fetch: async (url, init) => { sent.push([url, JSON.parse(init.body)]); return { ok: true, json: async () => ({ rev: 2, values: {} }) }; },
    later: fn => fn(),
  });
  assert.equal(store.getItem("waitnewest"), null, "a board with nothing stored is not newest first");
  store.setItem("waitnewest", "1");
  assert.equal(store.getItem("waitnewest"), "1");
  assert.equal(local.has("waitnewest"), false, "the choice stayed in the browser");
  store.removeItem("waitnewest");
  assert.equal(store.getItem("waitnewest"), null);
  assert.deepEqual(sent[0], ["/settings", { waitnewest: "1" }]);
});

// ---- the row, on both pages ------------------------------------------------------------
function row(source, from, to) {
  const html = between(source, from, to);
  const group = /<div data-section="appearance" data-label="Appearance">[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  assert.ok(group, "no Appearance section");
  return group[0];
}
const ROWS = {
  mac: () => row(MAC, '<div id="setsrc"', '<div id="appframe"'),
  phone: () => row(PHONE, '<div id="setsrc">', '<div id="setfoot">'),
};
for (const [name, find] of Object.entries(ROWS)) {
  test(`the ${name} settings hold the Cards waiting on you switch, off and reading Oldest first`, () => {
    const html = find();
    assert.match(html, /<label class="setlabel" for="setwait"><span>Cards waiting on you<\/span>/);
    const input = /<input\b[^>]*\bid="setwait"[^>]*>/.exec(html);
    assert.ok(input, "no switch");
    assert.match(input[0], /\btype="checkbox"/);
    assert.match(input[0], /\brole="switch"/);
    assert.doesNotMatch(input[0], /\schecked(?=[\s>])/, "newest first before anything is chosen");
    assert.match(html, /<small id="setwaitnote" class="sethelp" role="status" aria-live="polite">Oldest first<\/small>/);
    assert.match(html, /<div class="setrow">/);
  });
}

function macPage(stored = {}) {
  const store = new Map(Object.entries(stored));
  const elements = new Map();
  const repaints = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, checked: false, textContent: id === "setwaitnote" ? "Oldest first" : "", events: {},
      setAttribute() {}, addEventListener(type, fn) { this.events[type] = fn; } });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, body: { classList: { add() {}, remove() {} } } },
    settingsStore: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)),
                     removeItem: k => store.delete(k) },
    settingsOverlay: (host, source, opts) => ({ open: () => opts.onOpen() }),
    ComposeFormat: { enabled: () => false, setEnabled() {}, onChange() {}, preload() {} },
    lastState: { boxes: [] }, renderCarousel: state => repaints.push(state),
    fetch: async () => ({ ok: false }),   // the Profile section's reading, not under test here
    feedbackBox: () => ({ setReady() {} }),   // the feedback box in Improvements, tested in feedback-box.test.cjs
    controlShiftEnter: () => false, bareControlEnter: () => false,
  });
  // the page's own line that answers for the option, then its settings block
  vm.runInContext(between(MAC, "waitNewestFirst = () =>", "\n") + "\n", context);
  vm.runInContext(between(MAC, "// ---- settings ----", "function buildHandles()"), context);
  const wait = element("setwait"), note = element("setwaitnote");
  return {
    store, wait, note, repaints, answer: () => context.waitNewestFirst(),
    flip(on) { wait.checked = on; wait.events.change(); },
    open() { element("setbtn").events.click(); },
  };
}

test("on the Mac page the switch is off until the board says 1, and a flip writes it and draws the list again", () => {
  const page = macPage();
  assert.equal(page.wait.checked, false);
  assert.equal(page.note.textContent, "Oldest first");
  assert.equal(page.answer(), false);
  page.flip(true);
  assert.equal(page.store.get("waitnewest"), "1");
  assert.equal(page.note.textContent, "Newest first");
  assert.equal(page.answer(), true);
  assert.equal(page.repaints.length, 1, "the list was not drawn again");
  page.flip(false);
  assert.equal(page.store.has("waitnewest"), false, "oldest first is not the absent default again");
  assert.equal(page.note.textContent, "Oldest first");
  assert.equal(page.answer(), false);
  assert.equal(page.repaints.length, 2);

  const newest = macPage({ waitnewest: "1" });
  assert.equal(newest.wait.checked, true, "a board set to newest first shows the switch off");
  assert.equal(newest.note.textContent, "Newest first");
  newest.store.delete("waitnewest");     // another window put it back
  newest.open();
  assert.equal(newest.wait.checked, false, "opening the page does not show the board's choice");
  assert.equal(newest.note.textContent, "Oldest first");
});

function phonePage({ values = {}, refuse = false } = {}) {
  const board = { values: { ...values }, calls: [], refuse };
  const wait = { checked: false, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const note = { textContent: "Oldest first" };
  const item = { events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const repaints = [];
  const context = vm.createContext({
    document: {
      getElementById: id => (id === "setwait" ? wait : id === "setwaitnote" ? note : null),
      querySelector: sel => (sel === '#setpage .sp-item[data-section="appearance"]' ? item : null),
    },
    lastState: { boxes: [] }, renderTickets: state => repaints.push(state),
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
  vm.runInContext(between(PHONE, "// the order of the cards waiting on the reader", "// the editor it is drawn with"), context);
  return {
    board, wait, note, repaints, answer: () => context.waitNewestFirst(),
    async flip(on) { wait.checked = on; wait.events.change(); await settle(); },
    async openSection() { item.events.click(); await settle(); },
  };
}

test("on the phone the switch reads the board's setting, writes it back and draws the list again", async () => {
  const page = phonePage();
  assert.equal(page.answer(), false, "newest first before the board answers");
  await settle();
  assert.deepEqual(page.board.calls, [["/settings", "GET", null]]);
  assert.equal(page.wait.checked, false);
  assert.equal(page.repaints.length, 0, "the list was drawn again for no change");
  await page.flip(true);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { waitnewest: "1" }]);
  assert.equal(page.board.values.waitnewest, "1");
  assert.equal(page.answer(), true);
  assert.equal(page.note.textContent, "Newest first");
  assert.equal(page.repaints.length, 1);
  await page.flip(false);
  assert.deepEqual(page.board.calls.at(-1), ["/settings", "POST", { waitnewest: null }]);
  assert.equal("waitnewest" in page.board.values, false);
  assert.equal(page.answer(), false);
  assert.equal(page.note.textContent, "Oldest first");
  assert.equal(page.repaints.length, 2);
});

test("on the phone a board set to newest first shows it, a change on the Mac shows when the section opens, and a refused flip flips back", async () => {
  const page = phonePage({ values: { waitnewest: "1" } });
  await settle();
  assert.equal(page.wait.checked, true);
  assert.equal(page.answer(), true);
  assert.equal(page.note.textContent, "Newest first");
  delete page.board.values.waitnewest;   // put back from the Mac
  await page.openSection();
  assert.equal(page.wait.checked, false, "opening Appearance does not read the board again");
  assert.equal(page.answer(), false);

  const refused = phonePage({ refuse: true });
  await settle();
  await refused.flip(true);
  assert.equal(refused.wait.checked, false, "a flip the board did not keep stays shown");
  assert.equal(refused.note.textContent, "Oldest first");
  assert.equal(refused.answer(), false);
});
