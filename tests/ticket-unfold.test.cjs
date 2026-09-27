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
// and two layers draw it where the fold was. checked here are the class on
// each surface, the repaint, and the layers as each sheet states them: where
// they sit, that their images lie exactly on the fold's crease, the tones
// across the crease on every ticket fill, the taper along it, the notches in
// the edge, what each tuning number moves, and how the line and the ridge land
// on device pixels at 1x, 2x and 3x. how it looks is not checked; nothing here
// can see it.
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
    `${src}\nreturn { foldHit, onFold, unfoldTicket };`,
  )(sandbox.getComputedStyle, sandbox.fetch, sandbox.poll, false, encodeURIComponent);
}

// each surface's painter, handed one pool and the view it is drawing, answers
// with the rows it drew
const PAINT = {
  desktop: (pool, view = "todo") => {
    const paint = new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(DateStub, queueState, cardState, h, {}, () => "5m", SPIN, 0, () => view, "none", null, testReady,
      appendOmniRowArt, record("select"), logic("onFold"), logic("unfoldTicket"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents: {} }, "lane");
    return pane.children;
  },
  phone: (pool, view = "todo") => {
    const paint = new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
      "SPIN_FRAMES", "spinFrame", "selectedId", "testReady", "appendOmniRowArt",
      "select", "closeDrawer", "onFold", "unfoldTicket",
      `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
    )(queueState, cardState, h, {}, () => "5m", SPIN, 0, "none", testReady, appendOmniRowArt,
      record("select"), record("closeDrawer"), logic("onFold"), logic("unfoldTicket"));
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
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.page, "renderCarousel", "ord")}; return renderCarousel;`,
    )(document, DateStub, () => null, state => state.boxes, () => true, queueState, cardState, h, {},
      () => "5m", noop, SPIN, 0, "lane", () => view, noop, "none", null, testReady, appendOmniRowArt,
      record("select"), own.onFold, own.unfoldTicket);
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
    for (const [id, creased] of Object.entries(want)) {
      const got = classes(rowOf(rows, id));
      assert.equal(got.includes("creased"), creased, `${id} ${creased ? "lost" : "gained"} the crease`);
      assert.ok(!(got.includes("creased") && got.includes("testc")), `${id} wears the crease beside the fold`);
      // the crease is the one class it adds: state, seen, omni and fold are as they were
      assert.deepEqual(got.filter(c => c !== "creased"), classes(rowOf(flat, id)), `${id} changed more than the crease`);
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
// the inside of the first name(...) in a value, and where that call ends
function inner(value, name) {
  const at = value.indexOf(name + "(");
  assert.ok(at >= 0, `no ${name}() in ${value}`);
  let depth = 0;
  for (let i = at + name.length; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")" && --depth === 0) return { body: value.slice(at + name.length + 1, i), end: i + 1 };
  }
  assert.fail(`${name}() is not closed in ${value}`);
}
// a value as the browser works it out: every var() swapped for the value
// given, then calc(), min(), px, and percentages of `whole`
function evaluate(expr, vars, whole = 0) {
  let t = String(expr);
  for (let i = 0; i < 8 && t.includes("var(--"); i++)
    t = t.replace(/var\((--[\w-]+)\)/g, (_, n) => { assert.ok(n in vars, `${n} has no value in ${expr}`); return "(" + vars[n] + ")"; });
  t = t.replace(/(\d*\.?\d+)%/g, (_, n) => "(" + Number(n) / 100 * whole + ")")
    .replace(/(\d)px\b/g, "$1").replace(/\bcalc\(/g, "(").replace(/\bmin\(/g, "Math.min(");
  assert.match(t.replace(/Math\.min/g, ""), /^[\d\s.+\-*/(),e]+$/, `an unexpected value: ${expr}`);
  return Function(`return (${t});`)();
}
const HEX = h => {
  h = h.replace("#", "");
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
// a colour as its channels and its alpha, worked out
function colourOf(c, vars) {
  if (c === "transparent") return { rgb: [0, 0, 0], a: 0 };
  if (c.startsWith("#")) return { rgb: HEX(c), a: 1 };
  if (c.startsWith("rgb(")) {
    const [chan, alpha] = inner(c, "rgb").body.split("/");
    return { rgb: chan.trim().split(/\s+/).map(Number), a: alpha == null ? 1 : evaluate(alpha.trim(), vars) };
  }
  if (c.startsWith("color-mix(")) {
    const [space, first, second] = splitTop(inner(c, "color-mix").body);
    assert.equal(space, "in srgb");
    assert.equal(second, "transparent", "the mix is not its colour thinned");
    const [base, share] = splitTop(first, " ");
    const name = /^var\((--[\w-]+)\)$/.exec(base);
    return { rgb: HEX(name ? vars[name[1]] : base), a: evaluate(share, vars, 100) / 100, base };
  }
  assert.fail(`an unexpected colour: ${c}`);
}
// a gradient stop as its colour and the rest (its place)
function stopOf(s, vars, length) {
  let colour = s.split(/\s+/)[0];
  for (const fn of ["rgb", "color-mix"]) if (s.startsWith(fn + "(")) colour = s.slice(0, inner(s, fn).end);
  const at = s.slice(colour.length).trim();
  return { ...colourOf(colour, vars), at: at ? evaluate(at, vars, length) : null };
}
// a linear-gradient() as its direction and stops, each placed in px along a
// gradient line of the given length
function linear(value, vars, length) {
  const [direction, ...stops] = splitTop(inner(value, "linear-gradient").body);
  return { direction, stops: stops.map(s => stopOf(s, vars, length)) };
}
// premultiplied colour at t px along a gradient line, as the browser mixes it:
// a stop placed before the one ahead of it is moved up to it
function sample(stops, t) {
  const pm = s => [...s.rgb.map(v => v * s.a), s.a];
  let last = -Infinity;
  const pos = stops.map(s => (last = Math.max(last, s.at)));
  if (t <= pos[0]) return pm(stops[0]);
  for (let i = 1; i < stops.length; i++) if (t <= pos[i]) {
    const f = pos[i] === pos[i - 1] ? 1 : (t - pos[i - 1]) / (pos[i] - pos[i - 1]);
    const a = pm(stops[i - 1]), b = pm(stops[i]);
    return a.map((v, k) => v + (b[k] - v) * f);
  }
  return pm(stops.at(-1));
}
// a premultiplied layer laid over a solid colour
const over = (under, [r, g, b, a]) => under.map((v, k) => v * (1 - a) + [r, g, b][k]);
const light = ([r, g, b]) => .299 * r + .587 * g + .114 * b;
// "right Xpx top Ypx" as the two offsets
function edgeOffsets(value) {
  const m = /^right (-?[\d.]+)px top (-?[\d.]+)px$/.exec(value);
  assert.ok(m, `not placed from the top right: ${value}`);
  return { right: Number(m[1]), top: Number(m[2]) };
}

const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const TOKENS = read("card-tokens.css");
// each page's own sheet, then the shared one where the page links it
const SHEETS = { desktop: styleOf(HTML.desktop) + "\n" + TOKENS, phone: styleOf(HTML.phone) + "\n" + TOKENS, page: styleOf(HTML.page) };
const PAPER = ".trow.creased > .trowin::before", HINGE = ".trow.creased > .trowin::after";
const BOTH = ".trow.creased > .trowin::before, .trow.creased > .trowin::after";
const TUNING = ["--crease-strength", "--crease-width", "--crease-raise", "--crease-light", "--crease-notch"];
// every ticket fill the crease can lie on
const FILLS = { plain: "#fff", "your turn": "#FFFBEB", working: "#F3FFF0", queued: "#F7F7F7" };
const W = 300;   // a row's border box width; the crease is read from its top right

// the crease on one sheet for one fold and one drawn edge, with any tuning
// swapped in. d is px across the crease from the fold's diagonal, positive
// toward the ticket and negative toward the corner's tip; s is px along it
// from its middle, positive toward the right edge
function creaseOf(css, fold, drawn, tune = {}) {
  const row = style(css, ".trow.creased");
  const vars = { "--fold": fold + "px", "--edge-drawn": drawn + "px", "--line": custom(css, "--line", []),
    ...Object.fromEntries(TUNING.map(n => [n, row[n]])), ...tune };
  const paper = style(css, PAPER), hinge = style(css, HINGE);
  const box = evaluate(paper.width, vars);
  const [topNotch, rightNotch, shade] = splitTop(paper["background-image"]);
  const side = evaluate(splitTop(splitTop(paper["background-size"])[2], " ")[0], vars);
  const across = side * Math.SQRT2;
  const shades = linear(shade, vars, across), lines = linear(hinge["background-image"], vars, across);
  const { body, end } = inner(hinge.mask, "linear-gradient");
  const along = linear(hinge.mask.slice(0, end), vars, across);
  const notch = r => {
    const [shape, ...stops] = splitTop(inner(r, "radial-gradient").body);
    const [size, place] = shape.split(" at ");
    const [rx, ry] = splitTop(size, " ").map(v => evaluate(v, vars));
    const [px, py] = splitTop(place, " ");
    // the centre in the row's border box: the layer's left edge is W less its width
    return { rx, ry, x: W - box + evaluate(px, vars, box), y: evaluate(py, vars, box), stops: stops.map(s => stopOf(s, vars, 1)) };
  };
  return {
    vars, box, side, across, shades, lines, along, mask: hinge.mask.slice(end).trim(), body,
    notches: [notch(topNotch), notch(rightNotch)],
    paper: d => sample(shades.stops, across / 2 + d),
    hinge: d => sample(lines.stops, across / 2 + d),
    taper: s => sample(along.stops, across / 2 + s)[3],
    // the two layers over one fill, at the middle of the crease's length
    on: (fill, d, s = 0) => {
      const h = sample(lines.stops, across / 2 + d), t = sample(along.stops, across / 2 + s)[3];
      return over(over(HEX(fill), sample(shades.stops, across / 2 + d)), h.map(v => v * t));
    },
  };
}

test("the crease is two layers only the fold also uses, anchored where the fold's layers are, inside the ticket's edge", () => {
  const allowed = [".trow.testc > .trowin::before", PAPER, HINGE];
  for (const [where, css] of Object.entries(SHEETS)) {
    const rules = rulesOf(css);
    // the row's .trowin layers are the fold's contact shade and the crease's
    // two, and nothing else's: never the working shimmer or the omni light,
    // which draw on the row's own
    for (const r of rules) for (const s of r.sels) if (/trowin::?(before|after)/.test(s))
      assert.ok(allowed.includes(s), `${where}: ${s} draws on a layer the fold or the crease owns`);
    // the creased row names its tuning (and on the typed page its fold) and
    // nothing more: it keeps the ticket's own fill, edge, shade and hidden
    // overflow, which is what keeps the crease inside the edge and the corner
    for (const r of rules) if (r.sels.includes(".trow.creased"))
      for (const [p] of declsOf(r.body)) assert.ok(p === "--fold" || TUNING.includes(p), `${where}: the creased row sets ${p}`);
    assert.deepEqual(Object.keys(style(css, ".trow.creased")).filter(p => p !== "--fold").sort(), [...TUNING].sort());
    assert.equal(style(css, ".trow").overflow, "hidden");
    const flap = style(css, ".trow.testc::after");
    for (const sel of [PAPER, HINGE]) {
      const layer = style(css, sel);
      assert.equal(layer.content, '""');
      assert.equal(layer.position, "absolute");
      assert.equal(layer["box-sizing"], "border-box");
      assert.equal(layer["pointer-events"], "none", "the crease takes clicks meant for the row");
      assert.equal(layer["background-repeat"], "no-repeat");
      // on the border box's top right, where the flap and the hole are, and
      // 6px past the fold's square to the left and below
      for (const p of ["top", "right"]) assert.equal(layer[p], flap[p], `${where}: the crease's ${p} is not the fold's`);
      assert.equal(layer.width, "calc(var(--fold) + 6px)");
      assert.equal(layer.height, "calc(var(--fold) + 6px)");
      // paint and nothing else: no edge, shadow, cut, filter, blend or lift of its own
      for (const p of ["border", "border-left", "border-bottom", "box-shadow", "clip-path", "filter", "z-index", "transform", "opacity", "mix-blend-mode"])
        assert.equal(layer[p], undefined, `${where}: the crease sets ${p}`);
    }
    // on every surface a creased row's square is its folded row's size
    assert.equal(custom(css, "--fold", [".trow", ".trow.creased"]), custom(css, "--fold", [".trow", ".trow.testc"]),
      `${where}: the crease's square is not the fold's size`);
  }
  assert.equal(custom(SHEETS.phone, "--fold", [".trow", ".trow.creased"]), "12px");
  // the typed page does not load card-tokens.css and keeps its own copy
  for (const sel of [PAPER, HINGE])
    assert.deepEqual(style(SHEETS.page, sel), style(TOKENS, sel), `the typed page's ${sel} drifted from card-tokens.css`);
  const { "--fold": fold, ...tuning } = style(SHEETS.page, ".trow.creased");
  assert.equal(fold, "16px");
  assert.deepEqual(tuning, style(TOKENS, ".trow.creased"), "the typed page's crease tuning drifted from card-tokens.css");
});

test("every image of the crease lies on the fold's own crease, its centre the crease's middle, and covers its layer", () => {
  const cut = style(TOKENS, ".trow.testc::before")["clip-path"];
  const H = 64;
  for (const [where, css] of Object.entries(SHEETS)) {
    const paper = style(css, PAPER), hinge = style(css, HINGE);
    assert.equal(hinge["-webkit-mask"], hinge.mask, `${where}: the prefixed mask is not the mask`);
    const maskRest = hinge.mask.slice(inner(hinge.mask, "linear-gradient").end).trim();
    const [maskPlace, maskSize] = maskRest.replace(/ no-repeat$/, "").split(" / ");
    const images = {
      "the paper's shades": [splitTop(paper["background-size"])[2], splitTop(paper["background-position"])[2]],
      "the hinge": [hinge["background-size"], hinge["background-position"]],
      "the taper": [maskSize, maskPlace],
    };
    assert.deepEqual(splitTop(paper["background-position"]).slice(0, 2), ["0 0", "0 0"], "the notches are not placed on the layer");
    for (const fold of [16, 12]) {
      const vars = { "--fold": fold + "px" };
      // the fold's crease: the two points where its cut meets the top and the right edge
      const [a, b] = splitTop(inner(cut, "polygon").body).slice(1, 3)
        .map(p => splitTop(p, " ")).map(([x, y]) => [evaluate(x, vars, W), evaluate(y, vars, H)]);
      assert.deepEqual([a, b], [[W - fold, 0], [W, fold]], "the fold's crease is not where it was");
      const onCrease = ([x, y]) => Math.abs((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) < 1e-9;
      const box = evaluate(paper.width, vars);
      for (const [what, [size, place]] of Object.entries(images)) {
        const [w, h] = splitTop(size, " ").map(v => evaluate(v, vars));
        assert.equal(w, h, `${what} is not square, so its diagonal is not at 45 degrees`);
        const { right, top } = edgeOffsets(place);
        const x1 = W - right, x0 = x1 - w, y0 = top, y1 = top + w;
        assert.ok(onCrease([x0, y0]) && onCrease([x1, y1]), `${where}, ${fold}px: ${what}'s diagonal is not the fold's crease`);
        assert.ok(Math.abs((x0 + x1) / 2 - (a[0] + b[0]) / 2) < 1e-9 && Math.abs((y0 + y1) / 2 - (a[1] + b[1]) / 2) < 1e-9,
          `${where}, ${fold}px: ${what} is not centred on the crease's middle`);
        assert.ok(x0 <= W - box && x1 >= W && y0 <= 0 && y1 >= box, `${where}, ${fold}px: ${what} leaves part of its layer bare`);
      }
    }
  }
});

test("across the crease, on every ticket fill: the raised corner's tint, a shade into the valley, the line, a bright ridge, a soft fall, then the ticket untouched", () => {
  const contact = Number(/rgba\(60,45,20,([\d.]+)\)/.exec(style(TOKENS, ".trow.testc > .trowin::before").background)[1]);
  const foldInk = HEX(/#[0-9a-f]{6}/i.exec(style(TOKENS, ".trow.testc::after").background)[0]);
  for (const fold of [16, 12]) for (const drawn of [1, .5, 2 / 3]) {
    const c = creaseOf(TOKENS, fold, drawn), at = `${fold}px at a ${drawn.toFixed(2)}px edge`;
    assert.equal(c.shades.direction, "to bottom left");
    assert.equal(c.lines.direction, "to bottom left");
    // the shades are the board's shade ink; the line is the fold's own crease
    // colour, far quieter than the fold; the ridge is white
    for (const s of c.shades.stops) assert.deepEqual(s.rgb, [60, 45, 20], `${at}: a shade is not the board's shade ink`);
    for (const s of c.lines.stops) assert.ok([foldInk.join(), "255,255,255"].includes(s.rgb.join()), `${at}: the hinge wears ${s.rgb}`);
    const ink = Math.max(...c.lines.stops.filter(s => s.rgb.join() === foldInk.join()).map(s => s.a));
    assert.ok(ink > .2 && ink < .5, `${at}: the line's strength ${ink} is not a quiet crease`);
    const alpha = d => c.paper(d)[3];
    // the corner that was folded keeps a tint across the whole of it, from its
    // tip (fold / sqrt 2 out) to the crease: paler at the tip, deepening into
    // the valley, and fainter than the fold's own contact shade away from it
    const tip = -fold / Math.SQRT2, valley = -drawn;
    assert.ok(alpha(tip) > 0, `${at}: the corner's tip has no tint`);
    for (let d = tip; d + .05 <= valley + 1e-9; d += .05) assert.ok(alpha(d + .05) >= alpha(d) - 1e-12, `${at}: the tint lightens toward the crease at ${d}`);
    assert.ok(alpha(tip) < alpha(-fold * .3), `${at}: the tip is not paler than the rest of the corner`);
    assert.ok(alpha(-fold * .3) < contact, `${at}: the raised corner is deeper than the fold's own shade`);
    assert.ok(alpha(valley) > alpha(-fold * .3) * 1.8, `${at}: the valley does not fall into shade`);
    // the fall past the ridge is gone within its reach, and the ticket past it is untouched
    const reach = drawn * 2.5 + fold * .08;
    for (const d of [reach + 1e-6, reach + 1, reach + 8]) {
      assert.equal(alpha(d), 0, `${at}: the paper is shaded ${d}px out on the ticket's side`);
      assert.equal(c.hinge(d)[3], 0, `${at}: the hinge reaches ${d}px out`);
    }
    // the layer runs 6px past the square, far enough that the fall near each
    // end of the crease fades out before the layer's own edge could cut it
    // square: at the first line under the top edge, the layer's left edge is
    // (drawn + 6) / sqrt 2 out from the crease
    assert.ok((drawn + (c.box - fold)) / Math.SQRT2 >= reach, `${at}: the fall is cut off by the layer's edge`);
    for (const [name, fill] of Object.entries(FILLS)) {
      const L = d => light(c.on(fill, d));
      const base = light(HEX(fill)), line = L(0), ridge = L(drawn * 1.5), fall = L(drawn * 2.5 + .25);
      // the line is the darkest place across the crease: nothing outside its
      // drawn width, softened sides included, is as dark as its middle
      for (let d = -fold; d <= reach + 1; d += .05)
        if (Math.abs(d) > drawn + 1e-9) assert.ok(L(d) > line - 1e-9, `${at} on ${name}: ${d}px is darker than the line`);
      // the ridge is brighter than the line and than the fall just past it: on
      // a white ticket that is all a white ridge can be
      assert.ok(ridge > line + 25, `${at} on ${name}: the ridge does not stand out from the line`);
      assert.ok(ridge > fall + 3, `${at} on ${name}: the ridge does not stand out from the fall past it`);
      // the corner reads darker than the ticket beside it, and the ticket
      // past the fall is its own fill
      assert.ok(L(-fold * .3) < base - 1.5, `${at} on ${name}: the raised corner has no tone of its own`);
      assert.ok(Math.abs(L(reach + 1) - base) < 1e-9, `${at} on ${name}: the ticket past the crease is not its own fill`);
    }
  }
});

test("along the crease the line and the ridge taper toward both edges, and each edge is notched where the crease meets it", () => {
  for (const fold of [16, 12]) for (const drawn of [1, .5, 2 / 3]) {
    const c = creaseOf(TOKENS, fold, drawn), at = `${fold}px at a ${drawn.toFixed(2)}px edge`;
    assert.equal(c.along.direction, "to bottom right", "the taper does not run along the crease");
    for (const s of c.along.stops) assert.deepEqual(s.rgb, [0, 0, 0]);
    // full over the middle half of the crease, down to .45 at its two ends,
    // the same both ways: it tapers and never vanishes
    const half = fold / Math.SQRT2;
    assert.ok(Math.abs(c.taper(0) - 1) < 1e-9 && Math.abs(c.taper(half * .49) - 1) < 1e-9, `${at}: the middle is not full`);
    for (const s of [half, -half]) assert.ok(Math.abs(c.taper(s) - .45) < 1e-9, `${at}: an end is not .45`);
    for (let s = 0; s <= half; s += .1) {
      assert.ok(Math.abs(c.taper(s) - c.taper(-s)) < 1e-9, `${at}: the taper is lopsided at ${s}`);
      assert.ok(c.taper(s + .1) <= c.taper(s) + 1e-12, `${at}: the taper rises toward the end at ${s}`);
    }
    // the notches: one where the crease crosses the inside of the top edge,
    // one where it crosses the inside of the right edge, each longer along its
    // edge than across it and no more than a couple of drawn edges in size
    const [top, right] = c.notches;
    const onCrease = ({ x, y }) => Math.abs(y - (x - (W - fold))) < 1e-9;
    assert.ok(Math.abs(top.x - (W - fold + drawn)) < 1e-9 && Math.abs(top.y - drawn) < 1e-9, `${at}: the top notch is off the edge`);
    assert.ok(Math.abs(right.x - (W - drawn)) < 1e-9 && Math.abs(right.y - (fold - drawn)) < 1e-9, `${at}: the right notch is off the edge`);
    assert.ok(onCrease(top) && onCrease(right), `${at}: a notch is not on the crease`);
    assert.ok(top.rx > top.ry && right.ry > right.rx, `${at}: a notch does not lie along its edge`);
    for (const n of [top, right]) {
      assert.ok(Math.max(n.rx, n.ry) <= drawn * 2 + 1e-9, `${at}: a notch is wider than a kink`);
      // in the edge's own grey, thinned, fading out
      assert.equal(n.stops[0].base, "var(--line)", "a notch is not the edge's grey");
      assert.deepEqual(n.stops[0].rgb, HEX("#CACACA"));
      assert.ok(Math.abs(n.stops[0].a - .7) < 1e-9);
      assert.equal(n.stops.at(-1).a, 0, "a notch does not fade out");
    }
  }
});

test("at 1x, 2x and 3x the line and the ridge land on device pixels without breaking up", () => {
  // a gradient's colour is taken at pixel centres, and across a 45 degree line
  // those lie 1/sqrt(2) of a device pixel apart. wherever the crease falls among
  // them, some centre lands on the line at nearly its full strength and one on
  // the ridge at its full light, at every width the mock offers
  const part = (stops, rgb) => stops.map(s => ({ ...s, a: s.rgb.join() === rgb.join() ? s.a : 0, rgb }));
  for (const [dppx, drawn] of [[1, 1], [2, .5], [3, 2 / 3]]) for (const width of [.5, 1, 2, 3]) {
    const c = creaseOf(TOKENS, 16, drawn, { "--crease-width": String(width) });
    const ink = part(c.lines.stops, [173, 157, 127]), lit = part(c.lines.stops, [255, 255, 255]);
    const inkFull = Math.max(...ink.map(s => s.a)), litFull = Math.max(...lit.map(s => s.a));
    const step = 1 / dppx / Math.SQRT2;
    for (let k = 0; k < 24; k++) {
      const centres = Array.from({ length: 121 }, (_, n) => (k / 24) * step + (n - 60) * step);
      const at = `${dppx}x, width ${width}, offset ${(k / 24).toFixed(2)}`;
      assert.ok(Math.max(...centres.map(d => sample(ink, c.across / 2 + d)[3])) >= inkFull * .75, `${at}: the line breaks up`);
      assert.ok(Math.max(...centres.map(d => sample(lit, c.across / 2 + d)[3])) >= litFull * .999, `${at}: the ridge breaks up`);
    }
  }
});

test("the crease's five numbers each move their own part and nothing else", () => {
  const base = creaseOf(TOKENS, 16, .5);
  const tuned = tune => creaseOf(TOKENS, 16, .5, tune);
  const grid = Array.from({ length: 400 }, (_, i) => -12 + i * .05);
  const inkOf = c => Math.max(...c.lines.stops.filter(s => s.rgb[0] === 173).map(s => s.a));
  const litOf = c => Math.max(...c.lines.stops.filter(s => s.rgb[0] === 255).map(s => s.a));
  assert.deepEqual(TUNING.map(n => style(TOKENS, ".trow.creased")[n]), ["1", "1", "1", ".85", ".7"]);
  // strength 0: no line, ridge, valley shade, fall or notch; the raised corner
  // keeps its tint, which ends across the line's own width at the crease
  const none = tuned({ "--crease-strength": "0" });
  for (const d of grid) {
    assert.equal(none.hinge(d)[3], 0, `a hinge is left at ${d}`);
    if (d >= .5) assert.equal(none.paper(d)[3], 0, `a fall is left at ${d}`);
    else assert.ok(none.paper(d)[3] <= .045 + 1e-12, `the valley keeps its shade at ${d}`);
  }
  assert.ok(Math.abs(none.paper(-1)[3] - .045) < 1e-9 && none.paper(0)[3] < .03, "the corner's tint does not end at the crease");
  assert.ok(none.notches.every(n => n.stops[0].a === 0), "a notch is left");
  // raise 0: the corner loses its tint, the valley keeps its shade
  const flat = tuned({ "--crease-raise": "0" });
  assert.equal(flat.paper(-16 * .4)[3], 0, "the corner keeps a tint");
  assert.ok(flat.paper(-.5)[3] > .05, "the valley lost its shade with the corner's tint");
  assert.deepEqual(flat.lines.stops, base.lines.stops, "raise moved the hinge");
  // light 0: no ridge, the line as it was
  const dim = tuned({ "--crease-light": "0" });
  assert.equal(litOf(dim), 0);
  assert.equal(inkOf(dim), inkOf(base));
  assert.deepEqual(dim.shades.stops, base.shades.stops, "light moved the shades");
  // width 2: the line's solid core is two drawn edges, the ridge still one
  const wide = tuned({ "--crease-width": "2" });
  const core = c => { const s = c.lines.stops; return s[2].at - s[1].at; };
  const ridge = c => { const s = c.lines.stops; return s[4].at - s[3].at; };
  assert.ok(Math.abs(core(base) - .5) < 1e-9 && Math.abs(core(wide) - 1) < 1e-9, "the line's width is not in drawn edges");
  assert.ok(Math.abs(ridge(base) - .5) < 1e-9 && Math.abs(ridge(wide) - .5) < 1e-9, "the ridge's width moved with the line's");
  // notch 0: no notch, all else as it was
  const clean = tuned({ "--crease-notch": "0" });
  assert.ok(clean.notches.every(n => n.stops[0].a === 0), "a notch is left");
  assert.deepEqual(clean.lines.stops, base.lines.stops);
  assert.deepEqual(clean.shades.stops, base.shades.stops);
  // strength 2 cannot push a notch past the edge's own grey
  assert.ok(tuned({ "--crease-strength": "2" }).notches.every(n => n.stops[0].a <= 1), "a notch is deeper than the edge");
});
