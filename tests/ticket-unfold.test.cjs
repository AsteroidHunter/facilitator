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
// the fold is ephemeral: however it was unfolded, the ticket is then drawn as
// it was before it was folded, and the board keeps nothing of it either
// (server-testing.test.cjs). checked here are the row each surface paints once
// the marker is down, the repaint, and that no sheet draws on a ticket's inner
// layers but the fold's own.
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
      toggle: (n, force) => {
        const want = force === undefined ? !names().includes(n) : !!force;
        this.className = (want ? [...new Set([...names(), n])] : names().filter(x => x !== n)).join(" ");
        return want;
      },
    };
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const at = this.parentElement ? this.parentElement.children.indexOf(this) : -1;
    return at < 0 ? null : this.parentElement.children[at + 1] || null;
  }
  insertBefore(child, ref) {
    child.parentElement = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
    return child;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
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

// the phone's painter keeps its rows on the section it is handed, so a second
// pass over the same section changes those rows in place
const phonePainter = () => new Function("queueState", "cardState", "h", "seenReplies", "shortAge",
  "spinGlyph", "selectedId", "testReady", "appendOmniRowArt", "omniRowFace",
  "select", "closeDrawer", "onFold", "unfoldTicket", "homeOpen", "setHome",
  `${functionSource(HTML.phone, "paintPhonePane", "renderTickets")}; return paintPhonePane;`,
)(queueState, cardState, h, {}, () => "5m", () => SPIN[0], "none", testReady, appendOmniRowArt, sandbox.omniRowFace,
  record("select"), record("closeDrawer"), logic("onFold"), logic("unfoldTicket"), false, record("setHome"));

// each surface's painter, handed one pool and the view it is drawing, answers
// with the rows it drew
const PAINT = {
  desktop: (pool, view = "todo") => {
    const paint = new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge",
      "spinGlyph", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
      "select", "onFold", "unfoldTicket",
      `${functionSource(HTML.desktop, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
    )(DateStub, queueState, cardState, h, {}, () => "5m", () => SPIN[0], () => view, "none", null, testReady,
      appendOmniRowArt, record("select"), logic("onFold"), logic("unfoldTicket"));
    const pane = new FakeElement("div");
    paint(pane, pool, view, { agents: {} }, "lane");
    return pane.children;
  },
  phone: (pool, view = "todo") => {
    const pane = new FakeElement("div");
    phonePainter()(pane, pool, view, { agents: {} }, noop);
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
  // the keys around it are the ones they were, and control+n and control+l are no command
  assert.equal(resolve(key("n", { ctrlKey: true })), null);
  assert.equal(resolve(key("l", { ctrlKey: true })), null);
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

// ---- once unfolded, nothing remains -----------------------------------------------
// what a row draws: the names on it and on everything inside it, with their
// text, so two rows can be compared whole
const drawn = el => ({ names: classes(el), text: el._text, inside: el.children.map(drawn) });
for (const where of SURFACES) {
  test(`${where}: an unfolded ticket keeps nothing of the fold, drawn or under the hand`, async () => {
    foldPx = where === "phone" ? 12 : 16;
    const folded = rowOf(PAINT[where]([card()]), "m1");
    // the same card once the board has lowered the marker, whichever way the
    // reader unfolded it: the fold's class goes and nothing else changes
    const unfolded = rowOf(PAINT[where]([card({ testing: false })]), "m1");
    assert.deepEqual(drawn(unfolded), { ...drawn(folded), names: classes(folded).filter(c => c !== "testc") },
      "unfolding changed more of the row than taking the fold away");
    // its corner is the ticket's again: a click there opens the card
    calls.length = 0;
    click(unfolded, 3, 3);
    click(unfolded, foldPx, foldPx);
    await settle();
    assert.deepEqual(asked(), [], "the unfolded ticket's corner still unfolds");
    assert.deepEqual(named("select"), [["m1"], ["m1"]]);
  });
}

// the signature a list is repainted on, for one pool: the board and the typed
// page keep it on the list they paint
const SIG = {
  desktop: pool => PAINT.desktop(pool)[0].parentElement.dataset.sig,
  page: pool => PAINT.page(pool)[0].parentElement.dataset.sig,
};
for (const where of Object.keys(SIG)) {
  test(`${where}: an unfold repaints the row, so the fold does not stay on screen`, () => {
    const folded = SIG[where]([card()]);
    const unfolded = SIG[where]([card({ testing: false })]);
    assert.ok(folded && unfolded, "a signature was not drawn");
    assert.notEqual(unfolded, folded, "unfolding left the folded row standing");
  });
}
test("phone: an unfold changes the row in place, so the fold does not stay on screen", async () => {
  foldPx = 12;
  const paint = phonePainter(), pane = new FakeElement("div");
  paint(pane, [card()], "todo", { agents: {} }, noop);
  const row = rowOf(pane.children, "m1");
  assert.ok(classes(row).includes("testc"), "the card was not folded to begin with");
  paint(pane, [card({ testing: false })], "todo", { agents: {} }, noop);
  assert.equal(pane.children.length, 1);
  assert.equal(rowOf(pane.children, "m1"), row, "the row was drawn again rather than changed");
  assert.ok(!classes(row).includes("testc"), "unfolding left the folded row standing");
  calls.length = 0;
  click(row, 3, 3);
  await settle();
  assert.deepEqual(asked(), [], "the unfolded row's corner still unfolds");
  assert.deepEqual(named("select"), [["m1"]]);
});

// ---- the sheets: each rule's selectors, as in ticket-test-fold.test.cjs -----------
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
const styleOf = html => [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
const TOKENS = read("card-tokens.css");
// each page's own sheet, then the shared one where the page links it
const SHEETS = { desktop: styleOf(HTML.desktop) + "\n" + TOKENS, phone: styleOf(HTML.phone) + "\n" + TOKENS, page: styleOf(HTML.page) };

test("no sheet draws on a ticket's inner layers but the fold, so an unfolded ticket wears no mark", () => {
  for (const [where, css] of Object.entries(SHEETS)) {
    const layers = new Set(rulesOf(css).flatMap(r => r.sels).filter(s => /trowin::?(before|after)/.test(s)));
    assert.deepEqual([...layers], [".trow.testc > .trowin::before"],
      `${where}: something other than the fold draws on a ticket's inner layers`);
  }
});
