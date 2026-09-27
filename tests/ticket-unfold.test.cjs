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
// and one rule draws it where the fold was. checked here are the class on each
// surface, the repaint, and the rule's place, layer and shape as each sheet
// states them. how it looks is not checked; nothing here can see it.
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
function args(value, name) {
  const at = value.indexOf(name + "(");
  assert.ok(at >= 0, `no ${name}() in ${value}`);
  const out = [];
  let depth = 0, cur = "";
  for (const c of value.slice(at + name.length + 1)) {
    if (c === "(") depth++;
    if (c === ")") { if (depth === 0) break; depth--; }
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}
// one length term as px: percentages of `whole` and var(--edge-drawn) worked out
function measure(term, whole, drawn) {
  const t = term.replace(/var\(--edge-drawn\)/g, drawn + "px")
    .replace(/([\d.]+)%/g, (_, n) => String(Number(n) / 100 * whole) + "px")
    .replace(/calc/g, "").replace(/px/g, "");
  assert.match(t, /^[\d\s.+\-*/()]+$/, `an unexpected length term: ${term}`);
  return Function(`return (${t});`)();
}
// a linear-gradient() as its direction and stops, each stop's colour with any
// var() read off the rule's own declarations, and its place in px along a line
// of the given length
function gradient(decls, prop, length, drawn) {
  const [direction, ...stops] = args(decls[prop], "linear-gradient");
  return {
    direction,
    stops: stops.map(s => {
      const m = /^(var\(--[\w-]+\)|#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*(.*)$/i.exec(s);
      assert.ok(m, `an unexpected gradient stop: ${s}`);
      const name = /^var\((--[\w-]+)\)$/.exec(m[1]);
      const colour = name ? decls[name[1]] : m[1];
      assert.ok(colour, `${m[1]} is not set on the rule`);
      return { colour: colour.replace(/\s+/g, ""), at: m[2] ? measure(m[2], length, drawn) : null };
    }),
  };
}
const rgba = v => {
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  assert.ok(m, `not an rgb colour: ${v}`);
  const [r, g, b, a = 1] = m[1].split(",").map(Number);
  return { rgb: [r, g, b], a };
};
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);

const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const TOKENS = read("card-tokens.css");
// each page's own sheet, then the shared one where the page links it
const SHEETS = { desktop: styleOf(HTML.desktop) + "\n" + TOKENS, phone: styleOf(HTML.phone) + "\n" + TOKENS, page: styleOf(HTML.page) };
const CREASE = ".trow.creased > .trowin::after";

test("the crease is one layer nothing else draws on, laid on the square the fold lay on, inside the ticket's edge", () => {
  for (const [where, css] of Object.entries(SHEETS)) {
    const rules = rulesOf(css);
    // no other rule touches the row's .trowin::after, so the crease never meets
    // the working shimmer, the omni light or the fold, which draw elsewhere
    for (const r of rules) if (/trowin::?after/.test(r.sel))
      assert.deepEqual(r.sels, [CREASE], `${where}: ${r.sel} draws on the crease's layer`);
    // the creased row names its fold's size and nothing more: it keeps the
    // ticket's own fill, edge, shade and hidden overflow, which is what keeps
    // the crease inside the ticket's edge and rounded corner
    for (const r of rules) if (r.sels.includes(".trow.creased"))
      for (const [p] of declsOf(r.body)) assert.equal(p, "--fold", `${where}: the creased row sets ${p}`);
    assert.equal(style(css, ".trow").overflow, "hidden");
    // the crease square is the fold's own, placed on the border box as the
    // flap and the hole are
    const layer = style(css, CREASE), flap = style(css, ".trow.testc::after");
    assert.equal(layer.content, '""');
    assert.equal(layer.position, "absolute");
    assert.equal(layer["box-sizing"], "border-box");
    assert.equal(layer["pointer-events"], "none", "the crease takes clicks meant for the row");
    for (const p of ["top", "right", "width", "height"]) assert.equal(layer[p], flap[p], `${where}: the crease's ${p} is not the fold's`);
    // paint and nothing else: no edge, shadow, cut, filter or lift of its own
    for (const p of ["border", "border-left", "border-bottom", "box-shadow", "clip-path", "filter", "z-index", "transform", "opacity"])
      assert.equal(layer[p], undefined, `${where}: the crease sets ${p}`);
    // on every surface a creased row's square is its folded row's size
    assert.equal(custom(css, "--fold", [".trow", ".trow.creased"]), custom(css, "--fold", [".trow", ".trow.testc"]),
      `${where}: the crease's square is not the fold's size`);
  }
  assert.equal(custom(SHEETS.phone, "--fold", [".trow", ".trow.creased"]), "12px");
  // the typed page does not load card-tokens.css and keeps its own copy
  assert.deepEqual(style(SHEETS.page, CREASE), style(TOKENS, CREASE), "the typed page's crease drifted from card-tokens.css");
});

test("the crease is a line along the fold's crease, a shade on the folded side and a light on the ticket's", () => {
  const layer = style(TOKENS, CREASE);
  const hole = style(TOKENS, ".trow.testc > .trowin::before");
  const foldCrease = /#([0-9a-f]{6})/i.exec(style(TOKENS, ".trow.testc::after").background)[1];
  const creaseRgb = [0, 2, 4].map(i => parseInt(foldCrease.slice(i, i + 2), 16));
  for (const fold of [16, 12]) for (const drawn of [1, .5, 2 / 3]) {
    const diag = fold * Math.SQRT2, mid = diag / 2, at = `${fold}px at a ${drawn}px edge`;
    // the hole's contact shade, the fold's own shade on the corner side
    const contact = gradient(hole, "background", diag, drawn).stops;
    const reach = contact[1].at - contact[0].at, deepest = rgba(contact[0].colour).a;
    const { direction, stops } = gradient(layer, "background", diag, drawn);
    assert.equal(direction, "to bottom left", "the crease does not run across the square from the corner");
    for (let i = 0; i < stops.length; i++) {
      assert.ok(stops[i].at >= 0 && stops[i].at <= diag, `${at}: a stop falls off the square`);
      if (i) assert.ok(stops[i].at >= stops[i - 1].at, `${at}: the stops run backwards`);
    }
    // the line: the fold's crease colour, partly clear, solid from the crease
    // for half a drawn edge and ramping in and out over half a drawn edge each
    const line = stops.map((s, i) => [s, i]).filter(([s]) => s.colour === layer["--crease-line"].replace(/\s+/g, ""));
    assert.equal(line.length, 2, `${at}: the line is not one solid run`);
    const [[from, i0], [to, i1]] = line;
    near(from.at, mid, `${at}: the line does not start on the crease`);
    near(to.at - from.at, drawn / 2, `${at}: the line's solid part`);
    near(from.at - stops[i0 - 1].at, drawn / 2, `${at}: the line's ramp in`);
    near(stops[i1 + 1].at - to.at, drawn / 2, `${at}: the line's ramp out`);
    const ink = rgba(from.colour);
    assert.deepEqual(ink.rgb, creaseRgb, "the line is not the fold's crease colour");
    assert.ok(ink.a > 0 && ink.a < 1, "the line is not quieter than the fold's crease");
    // the folded side: the board's shade ink, no deeper than the hole's shade
    // and gone within its reach
    const before = stops.slice(0, i0);
    assert.equal(rgba(before[0].colour).a, 0, `${at}: the shade has no soft start`);
    for (const s of before) {
      assert.deepEqual(rgba(s.colour).rgb, rgba(contact[0].colour).rgb, "the shade is not the board's shade ink");
      assert.ok(rgba(s.colour).a <= deepest, "the shade is deeper than the fold's own");
      assert.ok(s.at >= mid - reach - 1e-6, `${at}: the shade reaches past the fold's`);
    }
    // the ticket's side: white, gone within three drawn edges of the crease
    const after = stops.slice(i1 + 1);
    for (const s of after) assert.deepEqual(rgba(s.colour).rgb, [255, 255, 255], "the light is not white");
    assert.equal(rgba(after.at(-1).colour).a, 0, `${at}: the light has no soft end`);
    assert.ok(after.at(-1).at <= mid + 3 * drawn + 1e-6, `${at}: the light spreads wider than a hairline`);
  }
});
