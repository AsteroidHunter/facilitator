// unfolding the ready-to-test fold, checked without a browser on every surface
// that draws it: the desktop board (index.html), the phone's drawer (m.html) and
// the typed page (page.html). each surface's real row painter is run over a
// small pool, the way tests/ticket-test-fold.test.cjs runs them, with the card
// logic the pages load. nothing here renders a pixel.
//
// marking a folded card done unfolds it. that was already true before any of
// this: every page closes a card with /close, the board lowers the marker there
// (server-testing.test.cjs), and no surface draws the fold on a done card. the
// tests below walk one folded card through that close on each surface.
//
// a click on the folded corner, or control+u on the selected card, unfolds it:
// the page asks the board for /testing v=0. checked here are the key's
// recognition and reach, the corner's geometry, the request, each surface's
// row click and each page's key wiring.
//
// once unfolded, the ticket keeps a crease: the board's creased flag
// (server-testing.test.cjs) puts creased on the row, never beside the fold,
// with one of three marks read off the card's id, and one layer draws it where
// the fold was: an image baked by tools/bake-crease.cjs from
// tools/crease-decal.js. checked here are the classes on each surface, the
// repaint, the layer as each sheet states it, that every baked image is the
// generator's own pixels at every size, and those pixels over a ticket against
// what the owner's photograph of a real crease measures: the groove's darkness
// and how it changes along the crease, where it lies, the ends, the corner's
// own tone, the fall on the ticket's side, the nicks in the edge and the rim
// beside the line. numbers are checked; how it looks to the owner is not.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = { desktop: read("index.html"), phone: read("m.html"), page: read("page.html") };

// ---- a small document -------------------------------------------------------------
// rows stack 72px apart, 300 by 64 each, so a click can be placed on a row's corner
const ROW = { w: 300, h: 64, gap: 72 };
class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = String(tag).toUpperCase();
    this.className = className || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
    this.listeners = {};
    this._text = String(text ?? "");
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      contains: n => names().includes(n),
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  setAttribute() {}
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  get offsetHeight() { return ROW.h; }
  getBoundingClientRect() {
    const top = (this.parentElement ? this.parentElement.children.indexOf(this) : 0) * ROW.gap;
    return { left: 0, right: ROW.w, width: ROW.w, top, bottom: top + ROW.h, height: ROW.h };
  }
  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(c => c.classList && c.classList.contains("trow") && c.classList.contains("on")) || null;
  }
  scrollIntoView() {}
}
const h = (tag, className, text) => new FakeElement(tag, className, text);
const noop = () => {};

// what the pages would have asked of the board and of themselves
const calls = [];
const record = name => (...a) => { calls.push([name, ...a]); };
let foldPx = 16;   // what the row's --fold computes to, per surface

const sandbox = {
  document: { createElement: tag => new FakeElement(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: new FakeElement("body") },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {},
  getComputedStyle: () => ({ getPropertyValue: name => (name === "--fold" ? " " + foldPx + "px" : "") }),
  fetch: (url, opts) => { calls.push(["fetch", url, opts && opts.method]); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }); },
  poll: record("poll"),
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const logic = name => vm.runInContext(`typeof ${name} === "function" ? ${name} : undefined`, sandbox);
const { cardState, queueState, testReady, appendOmniRowArt } = sandbox;

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}
const NOW = 1_000_000_000;
const DateStub = { now: () => NOW * 1000 };
const SPIN = ["|", "/", "-", "\\"];

// the typed page carries its own copies of the unfold helpers; the board and the
// phone take them from card-logic.js
function pageHelpers() {
  const html = HTML.page;
  if (!html.includes("function unfoldTicket(")) return {};
  const src = functionSource(html, "foldHit", "awaitsYou");
  return new Function("getComputedStyle", "fetch", "poll", "MOCK", "encodeURIComponent",
    `${src}\nreturn { foldHit, onFold, unfoldTicket, creaseVariant };`,
  )(sandbox.getComputedStyle, sandbox.fetch, sandbox.poll, false, encodeURIComponent);
}

// each surface's painter, handed one pool and the view it is drawing, answers
// with the rows it drew
const PAINT = {
  desktop: (pool, view = "todo") => {
    const paint = new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket", "creaseVariant",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(DateStub, queueState, cardState, h, {}, () => "5m", SPIN, 0, () => view, "none", null, testReady,
      appendOmniRowArt, record("select"), logic("onFold"), logic("unfoldTicket"), logic("creaseVariant"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents: {} }, "lane");
    return pane.children;
  },
  phone: (pool, view = "todo") => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "selectedId", "testReady", "appendOmniRowArt",
      "select", "closeDrawer", "onFold", "unfoldTicket", "creaseVariant",
      `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, () => "5m", SPIN, 0, "none", testReady, appendOmniRowArt,
      record("select"), record("closeDrawer"), logic("onFold"), logic("unfoldTicket"), logic("creaseVariant"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, "sig", { agents: {} });
    return pane.children;
  },
  page: (pool, view = "todo") => {
    const tiklist = new FakeElement("div"), chips = new FakeElement("div");
    const document = { getElementById: id => ({ tiklist, chips })[id] };
    const own = pageHelpers();
    const render = new Function("document", "Date", "curWs", "poolOf", "viewFilter", "queueState",
      "cardState", "h", "seenReplies", "shortAge", "syncSpinner", "SPIN_FRAMES", "spinFrame", "activeOwner",
      "curView", "paintViewTabs", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket", "creaseVariant",
      `${functionSource(HTML.page, "renderCarousel", "ord")}; return renderCarousel;`,
    )(document, DateStub, () => null, state => state.boxes, () => true, queueState, cardState, h, {},
      () => "5m", noop, SPIN, 0, "lane", () => view, noop, "none", null, testReady, appendOmniRowArt,
      record("select"), own.onFold, own.unfoldTicket, own.creaseVariant);
    render({ agents: {}, boxes: pool });
    return tiklist.children;
  },
};
const SURFACES = Object.keys(PAINT);
const rowOf = (rows, id) => rows.find(r => r.dataset.id === id);
const classes = row => row.className.split(/\s+/);

// a card whose change is ready to try: a completed reply awaits the reader
const reply = { ball: "you", replies: 1, agentTs: NOW - 300, pending: 0 };
const card = extra => ({ id: "m1", title: "Ready to test", owner: "lane", bg: false, task: "", state: "yours",
  ...reply, testing: true, ...extra });
// the same card as the board reads it once the close has landed: done, and the
// marker lowered by _mark_box_done
const closed = extra => card({ done: true, state: "done", testing: false, ...extra });

for (const where of SURFACES) {
  test(`${where}: marking a folded card done unfolds it, and it stays unfolded when brought back`, () => {
    const folded = rowOf(PAINT[where]([card()]), "m1");
    assert.ok(classes(folded).includes("testc"), "the card was not folded to begin with");
    const done = rowOf(PAINT[where]([closed()], "done"), "m1");
    assert.ok(done, "the closed card is not in the done list");
    assert.ok(classes(done).includes("donec"), "the closed card is not drawn done");
    assert.ok(!classes(done).includes("testc"), "the closed card still wears the fold");
    // a reading that still carried the raised marker on a done card, from a
    // board before the close lowered it, draws no fold either
    const stale = rowOf(PAINT[where]([card({ done: true, state: "done" })], "done"), "m1");
    assert.ok(!classes(stale).includes("testc"), "a done card with the marker up wears the fold");
    // brought back to doing, the card waits on the reader again with the
    // marker still down: the fold does not come back on its own
    const back = rowOf(PAINT[where]([card({ testing: false })]), "m1");
    assert.ok(!classes(back).includes("testc"), "the card came back folded");
  });
}

// ---- a click on the folded corner, or control+u -----------------------------------
const settle = () => new Promise(r => setImmediate(r));
const asked = () => calls.filter(c => c[0] === "fetch").map(c => c[1] + " " + c[2]);
const named = name => calls.filter(c => c[0] === name).map(c => c.slice(1));
function key(k, modifiers = {}) {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false, isComposing: false, repeat: false, ...modifiers };
}
const resolve = (e, scope) => { const s = sandbox.cardShortcut(e, scope); return s && { action: s.action, value: s.value }; };

test("control+u is the unfold key, with control alone and not composing, and only on the card pages", () => {
  for (const k of ["u", "U"]) {
    assert.deepEqual(resolve(key(k, { ctrlKey: true })), { action: "unfold", value: true });
    assert.equal(resolve(key(k, { ctrlKey: true }), "mini"), null, "the small card took control+u");
    for (const m of ["metaKey", "shiftKey", "altKey", "repeat", "isComposing", "defaultPrevented"])
      assert.equal(resolve(key(k, { ctrlKey: true, [m]: true })), null, `control+${k} with ${m}`);
    // a bare u is a letter being typed, and command+u is the editor's own
    assert.equal(resolve(key(k)), null);
    assert.equal(resolve(key(k, { metaKey: true })), null);
  }
  // the keys around it are the ones they were
  assert.deepEqual(resolve(key("n", { ctrlKey: true })), { action: "destination", value: "doing" });
  assert.deepEqual(resolve(key("l", { ctrlKey: true })), { action: "destination", value: "deferred" });
  assert.deepEqual(resolve(key("s", { ctrlKey: true })), { action: "responseScroll", value: true });
  assert.deepEqual(resolve(key("M", { ctrlKey: true, shiftKey: true })), { action: "diagnostic", value: true });
});

test("the folded corner is the row's top right --fold square, the flap and the cut corner together", () => {
  const foldHit = logic("foldHit");
  for (const fold of [16, 12]) {
    for (const [x, y] of [[0, 0], [fold, 0], [0, fold], [fold, fold], [fold / 2, fold / 3], [fold / 3, fold / 2]])
      assert.equal(foldHit(x, y, fold), true, `${x},${y} is off a ${fold}px fold`);
    for (const [x, y] of [[fold + .5, 1], [1, fold + .5], [-.5, 1], [1, -.5], [fold * 2, fold * 2]])
      assert.equal(foldHit(x, y, fold), false, `${x},${y} is on a ${fold}px fold`);
  }
  assert.equal(foldHit(0, 0, 0), false, "a row with no fold has a corner to click");
  // measured on the row's border box, with the fold the row's own --fold
  const onFold = logic("onFold");
  const row = h("div", "trow testc");
  const box = row.getBoundingClientRect();
  foldPx = 12;
  assert.equal(onFold(row, { clientX: box.right - 11, clientY: box.top + 11 }), true);
  assert.equal(onFold(row, { clientX: box.right - 14, clientY: box.top + 2 }), false, "the phone's 12px fold reached 14px");
  foldPx = 16;
  assert.equal(onFold(row, { clientX: box.right - 14, clientY: box.top + 2 }), true);
  assert.equal(onFold(h("div", "trow yours"), { clientX: box.right - 2, clientY: box.top + 2 }), false,
    "a row that is not folded has a folded corner");
});

test("unfolding asks the board to lower the marker, then reads the board again", async () => {
  calls.length = 0;
  await logic("unfoldTicket")("m1");
  assert.deepEqual(asked(), ["/testing?box=m1&v=0 POST"]);
  assert.equal(named("poll").length, 1, "the page did not read the board after asking");
  calls.length = 0;
  await logic("unfoldTicket")("a b&c");
  assert.deepEqual(asked(), ["/testing?box=a%20b%26c&v=0 POST"], "the card id was not encoded");
});

test("control+u unfolds the selected card only while it wears the fold, from where the section chords may come", async () => {
  const unfoldSelected = logic("unfoldSelected");
  const body = { closest: () => null };
  const ta = { tagName: "TEXTAREA", closest: sel => (sel === ".cm-editor" ? null : ta) };
  const title = { tagName: "INPUT", closest: sel => (sel === ".cm-editor" ? null : title) };
  const el = { ta };
  const press = target => ({ target, prevented: false, preventDefault() { this.prevented = true; } });
  sandbox.lastState = { boxes: [card(), card({ id: "m2", testing: false })] };
  for (const [target, where] of [[body, "the board"], [ta, "the card's own composer"]]) {
    calls.length = 0;
    const e = press(target);
    assert.equal(unfoldSelected(e, "m1", el), true, `control+u from ${where} did nothing`);
    assert.equal(e.prevented, true);
    await settle();
    assert.deepEqual(asked(), ["/testing?box=m1&v=0 POST"]);
  }
  calls.length = 0;
  for (const [e, id, why] of [[press(title), "m1", "from a title being renamed"], [press(body), "m2", "on a card with no fold"],
    [press(body), null, "with no card selected"], [press(body), "gone", "on a card the board no longer has"]]) {
    assert.equal(unfoldSelected(e, id, el), false, `control+u acted ${why}`);
    assert.equal(e.prevented, false, `control+u was cancelled ${why}`);
  }
  await settle();
  assert.deepEqual(asked(), []);
  delete sandbox.lastState;
});

// a click on a row, at a point measured from its top right corner
function click(row, fromRight, fromTop) {
  const box = row.getBoundingClientRect();
  for (const fn of row.listeners.click || []) fn({ clientX: box.right - fromRight, clientY: box.top + fromTop });
}
for (const where of SURFACES) {
  test(`${where}: a click on the folded corner unfolds the ticket and opens nothing; elsewhere it opens the card`, async () => {
    foldPx = where === "phone" ? 12 : 16;
    const rows = PAINT[where]([card(), card({ id: "m2", title: "Awaiting the reader", testing: false })]);
    const folded = rowOf(rows, "m1"), plain = rowOf(rows, "m2");
    assert.ok(classes(folded).includes("testc") && !classes(plain).includes("testc"));
    calls.length = 0;
    click(folded, 3, 3);
    click(folded, foldPx, foldPx);
    await settle();
    assert.deepEqual(asked(), ["/testing?box=m1&v=0 POST", "/testing?box=m1&v=0 POST"]);
    assert.deepEqual(named("select"), [], "a click on the fold opened the card");
    assert.deepEqual(named("closeDrawer"), [], "a tap on the fold closed the drawer");
    // the rest of the row, and the same corner of a ticket that is not folded,
    // open the card the way they always did
    calls.length = 0;
    click(folded, ROW.w / 2, ROW.h / 2);
    click(folded, foldPx + 2, 2);
    click(plain, 3, 3);
    await settle();
    assert.deepEqual(asked(), [], "a click off the fold unfolded the ticket");
    assert.deepEqual(named("select"), [["m1"], ["m1"], ["m2"]]);
    if (where === "phone") assert.equal(named("closeDrawer").length, 3);
  });
}

// the object a page hands its key table's actions to, built from the page's own
// source with the names its unfold action reads
function actionsOf(html, name, names, values) {
  const start = html.indexOf(`const ${name} = {`);
  const end = html.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, `${name} was not found`);
  return new Function(...names, `${html.slice(start, end + 3)} return ${name};`)(...values);
}
test("each card page hands control+u to its unfold action, for the selected card", () => {
  const seen = [];
  const unfoldSelected = (...a) => { seen.push(a); return true; };
  const el = { ta: {} };
  const e = key("u", { ctrlKey: true });
  const desktop = mini => actionsOf(HTML.desktop, "boardShortcutActions",
    ["miniFocused", "unfoldSelected", "selectedId", "els"], [mini, unfoldSelected, "m1", { m1: el }]);
  assert.equal(sandbox.dispatchCardShortcut(e, desktop(false)), true);
  assert.deepEqual(seen.splice(0), [[e, "m1", el]], "the board did not unfold its selected card");
  sandbox.dispatchCardShortcut(e, desktop(true));
  assert.deepEqual(seen.splice(0), [], "the board unfolded its card while the small card held the keys");
  const phone = actionsOf(HTML.phone, "phoneShortcutActions",
    ["unfoldSelected", "selectedId", "els"], [unfoldSelected, "m1", { m1: el }]);
  assert.equal(sandbox.dispatchCardShortcut(e, phone), true);
  assert.deepEqual(seen.splice(0), [[e, "m1", el]], "the phone did not unfold its selected card");
});

test("the typed page answers control+u itself, from where nothing is typed or its card's text box", async () => {
  const html = HTML.page;
  const start = html.indexOf('addEventListener("keydown", e => {\n  if (!FOCUS) return;');
  const end = html.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start, "the typed page's key handler was not found");
  const unfolds = [];
  const ta = { tagName: "TEXTAREA" }, other = { tagName: "INPUT" }, body = { tagName: "BODY" };
  const handler = (selectedId, boxes) => new Function("FOCUS", "lastState", "selectedId", "els", "testReady", "unfoldTicket",
    `return ${html.slice(start + 'addEventListener("keydown", '.length, end + 2)};`,
  )(true, { boxes }, selectedId, { m1: { ta } }, testReady, id => unfolds.push(id));
  const press = (target, modifiers = { ctrlKey: true }) =>
    ({ ...key("u", modifiers), target, prevented: false, preventDefault() { this.prevented = true; } });
  for (const target of [body, ta]) {
    const e = press(target);
    handler("m1", [card()])(e);
    assert.equal(e.prevented, true);
  }
  assert.deepEqual(unfolds.splice(0), ["m1", "m1"]);
  handler("m1", [card()])(press(other));
  handler("m1", [card({ testing: false })])(press(body));
  handler("m1", [card()])(press(body, { ctrlKey: true, shiftKey: true }));
  assert.deepEqual(unfolds, [], "control+u acted from another field, on a card with no fold, or with shift");
  // the page's own copies of the corner and the request match the shared ones
  for (const [name, next] of [["foldHit", "onFold"], ["onFold", "unfoldTicket"]])
    assert.equal(functionSource(html, name, next), functionSource(read("card-logic.js"), name, next),
      `the typed page's ${name} drifted from card-logic.js`);
  calls.length = 0;
  await pageHelpers().unfoldTicket("m1");
  assert.deepEqual(asked(), ["/testing?box=m1&v=0 POST"]);
  assert.equal(named("poll").length, 1);
});

// ---- the crease ------------------------------------------------------------------
for (const where of SURFACES) {
  test(`${where}: an unfolded ticket wears the crease in every state, never beside the fold, and nothing else changes`, () => {
    const pool = [
      card({ id: "c1", testing: false, creased: true }),                     // unfolded, still the reader's turn
      card({ id: "c2", testing: false, creased: false }),                    // never folded
      card({ id: "c3", testing: true, creased: true }),                      // a reading holding both: the fold wins
      card({ id: "c4", testing: false, creased: true, state: "working", ball: "me", writing: true }),
      card({ id: "c5", testing: false, creased: true, state: "queued", ball: "me", pending: 1 }),
    ];
    const rows = PAINT[where](pool), flat = PAINT[where](pool.map(b => ({ ...b, creased: false })));
    const want = { c1: true, c2: false, c3: false, c4: true, c5: true };
    const variant = where === "page" ? pageHelpers().creaseVariant : logic("creaseVariant");
    for (const [id, creased] of Object.entries(want)) {
      const got = classes(rowOf(rows, id));
      assert.equal(got.includes("creased"), creased, `${id} ${creased ? "lost" : "gained"} the crease`);
      assert.ok(!(got.includes("creased") && got.includes("testc")), `${id} wears the crease beside the fold`);
      // beside it, the one mark of the three its id picks, and no other
      const marks = got.filter(c => /^crease-\d$/.test(c));
      assert.deepEqual(marks, creased ? ["crease-" + variant(id)] : [], `${id} wears the wrong crease mark`);
      // the crease and its mark are all it adds: state, seen, omni and fold are as they were
      assert.deepEqual(got.filter(c => c !== "creased" && !marks.includes(c)), classes(rowOf(flat, id)),
        `${id} changed more than the crease`);
    }
    assert.ok(classes(rowOf(rows, "c4")).includes("working") && classes(rowOf(rows, "c5")).includes("queuedc"));
    // closed while folded, the done ticket keeps its crease too
    const done = classes(rowOf(PAINT[where]([closed({ creased: true })], "done"), "m1"));
    assert.ok(done.includes("creased") && done.includes("donec"), "the done ticket lost its crease");
  });
}

// the signature a list is repainted on, for one pool: the board and the typed
// page keep it on the list they paint, the phone works it out before painting
const SIG = {
  desktop: pool => PAINT.desktop(pool)[0].parentElement.dataset.sig,
  page: pool => PAINT.page(pool)[0].parentElement.dataset.sig,
  phone: pool => {
    const got = [], pane = new FakeElement("div");
    const document = { getElementById: () => ({ querySelector: () => pane }) };
    new Function("document", "paintViewTabs", "activeOwner", "TICKET_VIEWS", "viewPoolFor", "seenReplies",
      "selectedId", "testReady", "tracePhone", "paintPhonePane", "syncSpinner", "endPhoneTrace",
      "tikTravelIntent", "tikShownView", "curView", "moveTicketSheet", "Date",
      `${functionSource(HTML.phone, "renderTickets", "setView")}\nreturn renderTickets;`,
    )(document, noop, "lane", ["todo"], () => pool, {}, "none", testReady, noop, (p, b, n, sig) => got.push(sig),
      noop, noop, null, "todo", () => "todo", noop, DateStub)({ agents: {} });
    return got[0];
  },
};
for (const where of SURFACES) {
  test(`${where}: an unfold repaints the row, and so does the crease arriving on its own`, () => {
    const folded = SIG[where]([card()]);
    const unfolded = SIG[where]([card({ testing: false, creased: true })]);
    const plain = SIG[where]([card({ testing: false })]);
    assert.ok(folded && unfolded && plain, "a signature was not drawn");
    assert.notEqual(unfolded, folded, "unfolding left the folded row standing");
    assert.notEqual(unfolded, plain, "a crease arriving alone left the plain row standing");
  });
}

// ---- a small reader for the sheets, as in ticket-test-fold.test.cjs -----------------
function rulesOf(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [], stack = [];
  let buf = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      buf += css.slice(i, end + 1);
      i = end;
    } else if (c === "{") { stack.push(buf.trim()); buf = ""; }
    else if (c === "}") {
      const sel = stack.pop();
      if (sel && !sel.startsWith("@") && !stack.some(s => s.startsWith("@keyframes")))
        out.push({ sel, sels: sel.split(",").map(x => x.trim().replace(/\s+/g, " ")), body: buf, at: stack.filter(s => s.startsWith("@")) });
      buf = "";
    } else buf += c;
  }
  return out;
}
function declsOf(body) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (const c of body) {
    if (quote) { if (c === quote) quote = null; cur += c; continue; }
    if (c === '"' || c === "'") quote = c;
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === ";" && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map(d => d.trim()).filter(Boolean).map(d => {
    const at = d.indexOf(":");
    return [d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim().replace(/\s+/g, " ")];
  });
}
function style(css, selector) {
  const got = {};
  for (const r of rulesOf(css)) if (!r.at.length && r.sels.includes(selector))
    for (const [p, v] of declsOf(r.body)) got[p] = v;
  return got;
}
function custom(css, name, rowSelectors) {
  let v;
  for (const sel of [":root", ...rowSelectors]) if (style(css, sel)[name] != null) v = style(css, sel)[name];
  return v;
}
// split a value at its top-level separators, keeping every (...) whole
function splitTop(value, sep = ",") {
  const out = [];
  let depth = 0, cur = "";
  for (const c of value) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === sep && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// the inside of the first name(...) in a value
function inner(value, name) {
  const at = value.indexOf(name + "(");
  assert.ok(at >= 0, `no ${name}() in ${value.slice(0, 80)}`);
  let depth = 0;
  for (let i = at + name.length; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")" && --depth === 0) return value.slice(at + name.length + 1, i);
  }
  assert.fail(`${name}() is not closed`);
}
// a function's own text, from its name to its closing brace
function fnText(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} was not found`);
  return src.slice(start, src.indexOf("\n}", start) + 2);
}

const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const TOKENS = read("card-tokens.css");
// each page's own sheet, then the shared one where the page links it
const SHEETS = { desktop: styleOf(HTML.desktop) + "\n" + TOKENS, phone: styleOf(HTML.phone) + "\n" + TOKENS, page: styleOf(HTML.page) };
const LAYER = ".trow.creased > .trowin::after";
const MARKS = [2, 3].map(v => `.trow.creased.crease-${v} > .trowin::after`);
const D = require(path.join(ROOT, "tools", "crease-decal.js"));
const { START, END } = require(path.join(ROOT, "tools", "bake-crease.cjs"));

// ---- png in: enough of a decoder for the baked images (8 bit rgba, not interlaced)
const zlib = require("node:zlib");
function unpng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "not a png");
  let at = 8, width = 0, height = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.toString("ascii", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9], data[12]], [8, 6, 0], "not 8 bit rgba, or interlaced");
    }
    if (kind === "IDAT") idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * 4, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i], a = i >= 4 ? rgba[y * stride + i - 4] : 0;
      const b = y ? rgba[(y - 1) * stride + i] : 0, c = i >= 4 && y ? rgba[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      rgba[y * stride + i] = (x + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
  }
  return { width, height, rgba };
}
// a sheet's baked block: every --crease-<fold>-<mark> as its images by density,
// and the block's other names
function decalsOf(css) {
  const a = css.indexOf(START), b = css.indexOf(END);
  assert.ok(a >= 0 && b > a, "no crease decal block");
  const vars = style(css.slice(a, b + END.length), ":root"), images = {};
  for (const [name, value] of Object.entries(vars)) {
    if (!/^--crease-\d+-\d$/.test(name)) continue;
    images[name] = splitTop(inner(value, "image-set")).map(entry => {
      const u = /^url\("data:image\/png;base64,([A-Za-z0-9+/=]+)"\) (\d)x$/.exec(entry);
      assert.ok(u, `an unexpected image in ${name}`);
      return { scale: Number(u[2]), bytes: Buffer.from(u[1], "base64"), png: unpng(Buffer.from(u[1], "base64")) };
    });
  }
  return { vars, images };
}
const imageOf = (decals, fold, mark, scale) => decals.images[`--crease-${fold}-${mark}`].find(e => e.scale === scale).png;

// an image over one ticket fill, as the eye gets it: each pixel inside the
// ticket (under the top edge, left of the right edge) with its lightness as a
// % of the fill's own, s its distance from the fold's crease (+ toward the
// corner) and t its place along the crease from its top end, in css px
function looks(img, fold, scale, edge, fill = [255, 255, 255]) {
  const lum = ([r, g, b]) => .2126 * r + .7152 * g + .0722 * b, base = lum(fill), pts = [];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const cx = (x + .5) / scale, cy = (y + .5) / scale;
    if (cy < edge || cx > fold + 6 - edge) continue;
    const o = (y * img.width + x) * 4, a = img.rgba[o + 3] / 255;
    const c = fill.map((f, k) => f * (1 - a) + img.rgba[o + k] * a);
    pts.push({ s: ((cx - 6) - cy) / Math.SQRT2, t: ((cx - 6) + cy) / Math.SQRT2, v: 100 * lum(c) / base, cx, cy, c });
  }
  // along the crease, the darkest pixel within 1px of it, a css px at a time
  const along = [];
  for (let t = 0; t + 1 <= fold * Math.SQRT2; t += 1) {
    const near = pts.filter(p => p.t >= t && p.t < t + 1 && Math.abs(p.s) <= 1);
    if (near.length) along.push(near.reduce((m, p) => (p.v < m.v ? p : m)));
  }
  const mean = f => { const q = pts.filter(f); return q.reduce((s, p) => s + p.v, 0) / q.length; };
  return { pts, along, mean };
}
const avg = a => a.reduce((s, v) => s + v, 0) / a.length;

test("the crease is one image on one layer, anchored where the fold's layers are, inside the ticket's edge", () => {
  const allowed = [".trow.testc > .trowin::before", LAYER, ...MARKS];
  for (const [where, css] of Object.entries(SHEETS)) {
    const rules = rulesOf(css);
    // the row's .trowin layers are the fold's contact shade and the crease, and
    // nothing else's: never the working shimmer or the omni light, which draw on
    // the row's own
    for (const r of rules) for (const s of r.sels) if (/trowin::?(before|after)/.test(s))
      assert.ok(allowed.includes(s), `${where}: ${s} draws on a layer the fold or the crease owns`);
    // the creased row keeps the ticket's own fill, edge, shade and hidden
    // overflow, which is what keeps the crease inside the edge and the corner
    for (const r of rules) if (r.sels.includes(".trow.creased"))
      for (const [p] of declsOf(r.body)) assert.equal(p, "--fold", `${where}: the creased row sets ${p}`);
    assert.equal(style(css, ".trow").overflow, "hidden");
    const layer = style(css, LAYER), flap = style(css, ".trow.testc::after");
    assert.equal(layer.content, '""');
    assert.equal(layer.position, "absolute");
    assert.equal(layer["pointer-events"], "none", "the crease takes clicks meant for the row");
    // on the border box's top right, where the flap and the hole are, and 6px
    // past the fold's square to the left and below: the generator's own box,
    // whose crease runs from 6px in along the top to --fold down the right edge
    for (const p of ["top", "right"]) assert.equal(layer[p], flap[p], `${where}: the crease's ${p} is not the fold's`);
    assert.equal(layer.width, "calc(var(--fold) + 6px)");
    assert.equal(layer.height, "calc(var(--fold) + 6px)");
    // one image, filling the layer, drawn as it is
    assert.equal(layer.background, "no-repeat 0 0 / 100% 100%");
    assert.equal(layer["background-image"], "var(--crease-1)");
    MARKS.forEach((sel, i) => assert.deepEqual(style(css, sel), { "background-image": `var(--crease-${i + 2})` }));
    for (const p of ["border", "box-shadow", "clip-path", "filter", "mix-blend-mode", "mask", "-webkit-mask",
      "opacity", "transform", "z-index", "animation", "transition"])
      assert.equal(layer[p], undefined, `${where}: the crease sets ${p}`);
    // on every surface a creased row's square is its folded row's size
    assert.equal(custom(css, "--fold", [".trow", ".trow.creased"]), custom(css, "--fold", [".trow", ".trow.testc"]),
      `${where}: the crease's square is not the fold's size`);
  }
  assert.equal(custom(SHEETS.phone, "--fold", [".trow", ".trow.creased"]), "12px");
  // the typed page does not load card-tokens.css and keeps its own copy
  for (const sel of [LAYER, ...MARKS])
    assert.deepEqual(style(SHEETS.page, sel), style(TOKENS, sel), `the typed page's ${sel} drifted from card-tokens.css`);
  assert.deepEqual(style(SHEETS.page, ".trow.creased"), { "--fold": "16px" });
});

test("the images are the generator's own pixels: three marks at every size a screen draws them at", () => {
  const tokens = decalsOf(TOKENS), page = decalsOf(styleOf(HTML.page));
  const names = folds => folds.flatMap(f => D.SEEDS.map((_, i) => `--crease-${f}-${i + 1}`)).sort();
  assert.deepEqual(Object.keys(tokens.images).sort(), names([16, 12]));
  for (const set of D.SETS) D.SEEDS.forEach((seed, i) => {
    const name = `--crease-${set.fold}-${i + 1}`, want = D.render({ ...set, seed });
    const entry = tokens.images[name].find(e => e.scale === set.scale);
    assert.ok(entry, `${name} has no ${set.scale}x image`);
    assert.equal(want.size, Math.round((set.fold + 6) * set.scale), "an image is not its layer at that density");
    assert.deepEqual([entry.png.width, entry.png.height], [want.size, want.size]);
    assert.ok(Buffer.from(entry.png.rgba).equals(Buffer.from(want.rgba)), `${name} at ${set.scale}x is not the generator's`);
  });
  for (const fold of [16, 12]) for (const i of [1, 2, 3])
    assert.deepEqual(tokens.images[`--crease-${fold}-${i}`].map(e => e.scale),
      D.SETS.filter(s => s.fold === fold).map(s => s.scale), `--crease-${fold}-${i} is not drawn at its screens' densities`);
  // unless a page says otherwise the desktop's marks are drawn; the phone draws its 12px ones
  const phoneRow = style(styleOf(HTML.phone), ".trow");
  for (const i of [1, 2, 3]) {
    assert.equal(tokens.vars[`--crease-${i}`], `var(--crease-16-${i})`);
    assert.equal(phoneRow[`--crease-${i}`], `var(--crease-12-${i})`, "the phone does not draw its 12px marks");
  }
  // the typed page carries the desktop's marks, pixel for pixel the same
  assert.deepEqual(Object.keys(page.images).sort(), names([16]));
  for (const name of names([16])) {
    assert.deepEqual(page.images[name].map(e => e.scale), tokens.images[name].map(e => e.scale));
    page.images[name].forEach((e, k) => assert.ok(Buffer.from(e.png.rgba).equals(Buffer.from(tokens.images[name][k].png.rgba)),
      `the typed page's ${name} drifted from card-tokens.css`));
  }
  for (const i of [1, 2, 3]) assert.equal(page.vars[`--crease-${i}`], `var(--crease-16-${i})`);
  // three marks, each its own
  const marks = [1, 2, 3].map(i => Buffer.from(imageOf(tokens, 16, i, 2).rgba));
  assert.ok(!marks[0].equals(marks[1]) && !marks[1].equals(marks[2]) && !marks[0].equals(marks[2]), "two marks are the same");
  // small, and read once: every image under 2KB, all of them under 16KB
  const all = Object.values(tokens.images).flat();
  for (const e of all) assert.ok(e.bytes.length < 2048, `an image is ${e.bytes.length} bytes`);
  assert.ok(all.reduce((s, e) => s + e.bytes.length, 0) < 16384);
});

// the numbers below come from the owner's second photograph, decoded and
// measured off the decoded photograph:
// its long crease's groove averages 70% of the paper's lightness, 56% in its
// darkest quarter, swinging between 36% and 90% along it; its dog-eared
// corner's crease runs dark right into the sheet's edge, beside a corner that
// is a plane of its own, darker toward its tip
test("on a white ticket the crease reads as the photographs' creases do, at the desktop's 2x and the phone's 3x", () => {
  const tokens = decalsOf(TOKENS);
  for (const [fold, scale, edge] of [[16, 2, .5], [12, 3, 2 / 3]]) for (const mark of [1, 2, 3]) {
    const at = `${fold}px at ${scale}x, mark ${mark}`;
    const w = looks(imageOf(tokens, fold, mark, scale), fold, scale, edge);
    const line = w.along.map(p => p.v);
    // the groove: as dark on the whole as a pressed, clean crease can be beside
    // the photographs' (70%), and never the same all along: it swings by ten
    // points or more, the way the photographs' does and a drawn line does not
    assert.ok(avg(line) >= 65 && avg(line) <= 85, `${at}: the groove averages ${avg(line).toFixed(1)}%`);
    assert.ok(Math.max(...line) - Math.min(...line) >= 10, `${at}: the groove is the same all along`);
    // no taper: it runs dark right into both edges
    assert.ok(Math.min(...line.slice(0, 2)) <= 80 && Math.min(...line.slice(-2)) <= 85, `${at}: the groove fades at an edge`);
    // it lies where the fold's crease was: at every place, its darkest point is
    // within a pixel of the fold's diagonal, for all its wander
    for (const p of w.along) assert.ok(Math.abs(p.s) <= .9, `${at}: the groove strays ${p.s.toFixed(2)}px off the fold's crease`);
    // the corner is a plane of its own: a few points under the ticket, and
    // darker toward its tip, where it curls
    const near = w.mean(p => p.s > 1.5 && p.s < 4), far = w.mean(p => p.s > 7);
    assert.ok(near >= 92 && near <= 97.5, `${at}: the corner near the crease is ${near.toFixed(1)}%`);
    assert.ok(far < near - 1, `${at}: the corner is not darker toward its tip`);
    // the ticket's side: a faint fall just past the line, then the ticket's own white
    const fall = w.mean(p => p.s < -1.5 && p.s > -3);
    assert.ok(fall >= 96 && fall < 99.8, `${at}: the fall past the line is ${fall.toFixed(1)}%`);
    for (const p of w.pts.filter(q => q.s < -6)) assert.equal(p.v, 100, `${at}: the ticket is marked ${-p.s.toFixed(1)}px from the crease`);
    // nothing darker than the photographs' groove at its darkest quarter
    assert.ok(Math.min(...w.pts.map(p => p.v)) >= 56, `${at}: a pixel is darker than any groove in the photographs`);
    // the edge kinks where the crease meets it: the pixels just inside the top
    // edge and the right edge, at the crease, are dark
    const nick = (x, y) => Math.min(...w.pts.filter(p => Math.hypot(p.cx - x, p.cy - y) <= .6).map(p => p.v));
    assert.ok(nick(6 + edge, edge + .25) <= 80, `${at}: no nick in the top edge`);
    assert.ok(nick(fold + 6 - edge - .25, fold - edge) <= 80, `${at}: no nick in the right edge`);
    // the groove's lit wall is a rim right beside the line, as in the
    // photograph's dog-ear. a near-white ticket leaves a highlight almost no
    // room, so the rim is the ticket's own lightness left clear between the
    // dark line and the fall past it, on white and on the your-turn yellow alike
    for (const fill of [[255, 255, 255], [255, 251, 235]]) {
      const y = looks(imageOf(tokens, fold, mark, scale), fold, scale, edge, fill);
      const rim = y.pts.filter(p => p.s < 0 && p.s > -1.5).reduce((m, p) => (p.v > m.v ? p : m));
      assert.ok(rim.v >= 99.9, `${at}: no clear rim beside the line on ${fill}`);
      assert.ok(rim.v > y.mean(p => p.s < -1.5 && p.s > -3) + 1, `${at}: the rim is no lighter than the fall past it on ${fill}`);
    }
  }
});

test("a creased ticket's mark is read off its card's id: it keeps it through a reorder, and its neighbour differs", () => {
  const variant = logic("creaseVariant");
  const ids = Array.from({ length: 60 }, (_, i) => "m" + (600 + i));
  const got = ids.map(variant);
  assert.ok(got.every(n => [1, 2, 3].includes(n)));
  assert.deepEqual([...ids].reverse().map(variant), [...got].reverse(), "the mark moved with the list's order");
  for (let i = 1; i < got.length; i++) assert.notEqual(got[i], got[i - 1], `${ids[i]} wears its neighbour's mark`);
  assert.equal(new Set(got).size, 3);
  assert.equal(variant(null), variant(""));
  // the typed page's copy is card-logic.js's
  assert.equal(fnText(HTML.page, "creaseVariant"), fnText(read("card-logic.js"), "creaseVariant"));
});
