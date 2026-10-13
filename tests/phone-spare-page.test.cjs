// The spare page: the phone board writes a second history entry for itself, the
// same address, so the browser's own back swipe from the left edge lands on the
// board's first entry instead of leaving it. The page's code is lifted out of
// m.html and run against a small model of one tab's session history as WebKit
// keeps it: an entry written by pushState with no tap in the last few seconds is
// marked, and the back swipe skips a marked entry and the one under it
// (WebBackForwardList::itemStartingAtIndexSkippingItemsAddedByJSWithoutUserGesture).
// The address a notification opens the page by is read once, at the first load.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const PAGE = readFileSync(path.join(__dirname, "..", "m.html"), "utf8");

function cut(from, to) {
  const start = PAGE.indexOf(from);
  assert.ok(start > 0, "not in m.html: " + from);
  const end = PAGE.indexOf(to, start);
  assert.ok(end > start, "no end in m.html after: " + from);
  return PAGE.slice(start, end);
}
const SPARE = cut("// the spare page.", "</script>");
const ADDRESS = cut("// an entry the page wrote into its own history", "\n// the card's helpers");
const ARRIVAL = cut("// a page a notification opened by its address", "\nfunction keyBytes(");

const BOARD = "https://board.invalid/m";

// where the back swipe goes from entry `at`, as WebKit picks it when the swipe begins
function swipeTarget(entries, at) {
  if (at === 0) return null;
  if (!entries[at].marked) return entries[at - 1];
  let j = at - 1;
  while (entries[j].marked) { if (j === 0) return null; j--; }
  return j === 0 ? entries[0] : entries[j - 1];
}

// one tab: `behind` pages before the board, the board loaded with `state` and
// `search`. `active` stands for the window's activation: navigator.userActivation
// and WebKit's own ten seconds read as one here
function phone({ behind = 1, state = null, search = "", framed = false, activationApi = true, ahead = [] } = {}) {
  const entries = [];
  for (let n = 0; n < behind; n++) entries.push({ doc: "other", state: null, url: "https://elsewhere.invalid/", marked: false });
  entries.push({ doc: "board", state, url: BOARD + search, marked: false });
  for (const extra of ahead) entries.push({ doc: "board", url: BOARD + search, marked: false, ...extra });
  let at = behind, active = false;
  const queued = [], listeners = {}, notes = [];
  const fire = (type, event = {}) => { for (const fn of listeners[type] || []) fn(event); };
  const history = {
    get length() { return entries.length; },
    get state() { return structuredClone(entries[at].state); },
    scrollRestoration: "auto",
    pushState(value, _title, url) {
      entries.splice(at + 1, Infinity, { doc: "board", state: structuredClone(value), url, marked: !active });
      at++;
    },
    replaceState(value, _title, url) { entries[at] = { ...entries[at], state: structuredClone(value), url }; },
    back() { queued.push(-1); },
    forward() { queued.push(1); },
  };
  const navigator = activationApi ? { get userActivation() { return { isActive: active, hasBeenActive: true }; } } : {};
  const context = vm.createContext({
    history, navigator, URLSearchParams,
    location: { get href() { return entries[at].url; }, get search() { return new URL(entries[at].url).search; } },
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    tapNoteArrive: (...args) => notes.push(["arrive", ...args]),
    tapNoteResult: (...args) => notes.push(["result", ...args]),
  });
  context.window = context;
  context.parent = framed ? {} : context;
  vm.runInContext(ADDRESS, context, { filename: "m.html" });
  vm.runInContext(ARRIVAL, context, { filename: "m.html" });
  vm.runInContext(SPARE, context, { filename: "m.html" });

  // a traversal to an entry: inside the board's document a popstate, else the board is left
  function go(target) {
    at = entries.indexOf(target);
    if (target.doc !== "board") return "left";
    fire("popstate", { state: structuredClone(target.state) });
    while (queued.length) {
      const next = entries[at + queued.shift()];
      if (next) go(next);
    }
    return "stayed";
  }
  return {
    entries, notes, history, context,
    get at() { return at; },
    get current() { return entries[at]; },
    read: name => vm.runInContext(name, context),
    // a finger down and up; `counts` is whether the browser took it as a tap
    tap(counts = true) { fire("touchstart"); active = counts; fire("touchend"); if (counts) fire("click"); },
    click() { active = true; fire("click"); },
    touchstart() { fire("touchstart"); },
    // the seconds pass and the last tap no longer counts
    forget() { active = false; },
    // the system's back swipe: the target is picked when it begins, the lift may
    // or may not count as a tap, then the browser goes there
    swipe(lift = true) {
      const target = swipeTarget(entries, at);
      fire("touchstart");
      active = lift;
      fire(lift ? "touchend" : "touchcancel");
      return target ? go(target) : "nothing";
    },
  };
}

test("the spare is written only inside a tap, never at load, at touchstart or by a touch that was not a tap", () => {
  const p = phone();
  assert.equal(p.history.length, 2);
  assert.equal(p.history.state, null, "the page wrote an entry as it loaded");
  p.touchstart();
  assert.equal(p.history.length, 2, "a finger only put down wrote the spare");
  p.tap(false);
  assert.equal(p.history.length, 2, "a touch the browser did not count as a tap wrote the spare");
  p.tap();
  assert.equal(p.history.length, 3);
  const [, board, spare] = p.entries;
  assert.deepEqual(spare.state, { phonePage: "spare" });
  assert.deepEqual(board.state, { phonePage: "board" });
  assert.equal(spare.url, BOARD, "the spare has another address");
  assert.equal(board.url, BOARD);
  assert.equal(spare.marked, false, "the spare was written without a tap, so the swipe would skip it");
  assert.equal(p.current, spare);
  assert.equal(p.history.scrollRestoration, "manual");
});

test("there is never more than one spare, however many taps", () => {
  const p = phone({ behind: 3 });
  for (let n = 0; n < 40; n++) p.tap();
  assert.equal(p.history.length, 5);
  assert.equal(p.entries.filter(e => e.state?.phonePage === "spare").length, 1);
});

test("a board alone in its window, a board in a frame and a mouse click write none", () => {
  const alone = phone({ behind: 0 });
  for (let n = 0; n < 5; n++) alone.tap();
  assert.equal(alone.history.length, 1, "a board with nothing behind it wrote a spare");
  assert.equal(alone.history.scrollRestoration, "auto");

  const framed = phone({ framed: true });
  for (let n = 0; n < 5; n++) framed.tap();
  assert.equal(framed.history.length, 2, "the board inside the Mac wrote a spare");

  const mouse = phone();
  for (let n = 0; n < 5; n++) mouse.click();
  assert.equal(mouse.history.length, 2, "a click with no touch wrote a spare");
  mouse.tap();
  assert.equal(mouse.history.length, 3);
});

test("before any tap the first swipe still leaves: the spare needs a tap first", () => {
  const p = phone();
  assert.equal(p.swipe(), "left");
  assert.equal(p.at, 0);
});

test("each back swipe lands on the board's own entry and stays, and the landing writes the spare again", () => {
  const p = phone({ behind: 2 });
  p.tap();
  p.forget();
  const length = p.history.length;
  for (let n = 1; n <= 60; n++) {
    const before = p.current;
    assert.equal(p.swipe(), "stayed", "swipe " + n + " left the board");
    assert.notEqual(p.current, before, "swipe " + n + " was not answered with a fresh spare");
    assert.deepEqual(p.current.state, { phonePage: "spare" });
    assert.equal(p.current.marked, false);
    assert.equal(p.history.length, length, "history grew to " + p.history.length);
    p.forget();
  }
});

test("a swipe whose lift was not a tap steps forward onto the spare it came back from", () => {
  const p = phone();
  p.tap();
  p.forget();
  const spare = p.current;
  assert.equal(p.swipe(false), "stayed");
  assert.equal(p.current, spare, "the page did not step back onto its own spare");
  assert.equal(p.history.length, 3);
  assert.equal(p.swipe(false), "stayed", "the swipe after a lift that was no tap left the board");
  assert.equal(p.current, spare);
});

test("any mix of lifts, taps and swipes keeps the board and one spare", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const p = phone({ behind: 1 });
  p.tap();
  for (let n = 0; n < 300; n++) {
    const roll = random();
    if (roll < 0.2) p.tap();
    else if (roll < 0.3) p.forget();
    else assert.equal(p.swipe(random() < 0.7), "stayed", "step " + n);
    assert.ok(p.history.length <= 3, "history grew to " + p.history.length);
  }
  assert.deepEqual(p.current.state, { phonePage: "spare" });
});

test("a board loaded on its own entry again, without its spare, writes it on the next touch", () => {
  // the page let go and loaded again on the board's entry: the old spare ahead of
  // it is a marked one, which a swipe would skip, and is written over
  const p = phone({ state: { phonePage: "board" }, ahead: [{ state: { phonePage: "spare" }, marked: true }] });
  assert.equal(p.history.length, 3);
  p.tap();
  assert.equal(p.history.length, 3, "a second spare was written next to the old one");
  assert.equal(p.current.marked, false);
  p.forget();
  assert.equal(p.swipe(false), "stayed");
});

test("without the activation reading every touch and landing writes the spare, as the probe's version did", () => {
  const p = phone({ activationApi: false });
  p.tap();
  assert.equal(p.history.length, 3);
  for (let n = 0; n < 10; n++) assert.equal(p.swipe(), "stayed");
  assert.equal(p.history.length, 3);
});

test("a notification's address is acted on once: at the first load, never on the spare or a load on it", () => {
  const search = "?box=m580&tap=186f2374";
  const p = phone({ search });
  assert.equal(p.read("wantBox"), "m580");
  assert.deepEqual(p.notes, [["arrive", "m580", "186f2374", "url"], ["result", "m580", "186f2374"]]);
  p.tap();
  assert.equal(p.current.url, BOARD + search, "the spare dropped the address");
  assert.equal(p.entries[1].url, BOARD + search, "the board's own entry lost its address");
  for (let n = 0; n < 10; n++) { p.forget(); assert.equal(p.swipe(n % 3 !== 0), "stayed"); }
  assert.equal(p.notes.length, 2, "a swipe sent the tap again");

  // the page loaded again on either of its own entries, the spare or the board's
  for (const state of [{ phonePage: "spare" }, { phonePage: "board" }]) {
    const again = phone({ search, state });
    assert.equal(again.read("addressSeen"), true);
    assert.equal(again.read("wantBox"), null, "a load on " + state.phonePage + " opened the card again");
    assert.deepEqual(again.notes, [], "a load on " + state.phonePage + " sent the tap again");
  }

  const plain = phone();
  assert.equal(plain.read("wantBox"), null);
  assert.deepEqual(plain.notes, []);
});
