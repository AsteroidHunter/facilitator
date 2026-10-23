// When the desktop board's ticket list (index.html, paintTicketPane) rebuilds a
// section, checked without a browser. A section is rebuilt only when its
// signature changes, and the signature carries the age each row shows ("now",
// "5m", "3h", "2d"), not the minute: the same rows with only time passing give
// the same signature until some row's shown age changes. A row under an hour
// old still changes each minute, as its shown age does then. The real
// paintTicketPane runs over a fake section with card-logic.js's own shortAge,
// ticketTs, queueState and testReady on a clock the test turns. Nothing here
// renders a pixel.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = read("index.html");

// ---- a small document -------------------------------------------------------------
class FakeElement {
  constructor(tag, className = "", text = "") {
    this.tagName = String(tag).toUpperCase();
    this.className = className || "";
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentElement = null;
    this.scrollTop = 0;
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
  replaceChild(next, prev) {
    this.children[this.children.indexOf(prev)] = next;
    next.parentElement = this; prev.parentElement = null;
    return prev;
  }
  setAttribute() {}
  addEventListener() {}
  get offsetHeight() { return 64; }
  getBoundingClientRect() {
    const top = (this.parentElement ? this.parentElement.children.indexOf(this) : 0) * 72 - (this.parentElement?.scrollTop || 0);
    return { left: 0, right: 300, width: 300, top, bottom: top + 64, height: 64 };
  }
  querySelector(selector) {
    if (selector !== ".trow.on") throw new Error(`unsupported selector: ${selector}`);
    return this.children.find(c => c.classList.contains("trow") && c.classList.contains("on")) || null;
  }
  scrollIntoView() { if (this.parentElement) this.parentElement.reveals = (this.parentElement.reveals || 0) + 1; }
}
const h = (tag, className, text) => new FakeElement(tag, className, text);
const noop = () => {};

// card-logic.js on a clock the test turns, so shortAge reads the same now as
// the rows are drawn with
const clock = { now: Date.UTC(2026, 9, 12, 12, 0, 0) };
class ClockDate extends Date { static now() { return clock.now; } }
const sandbox = {
  Date: ClockDate,
  document: { createElement: tag => new FakeElement(tag), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], addEventListener: noop, body: new FakeElement("body") },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
  navigator: {}, location: {}, getComputedStyle: () => ({ getPropertyValue: () => " 16px" }),
  fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }), poll: noop,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
const { cardState, queueState, testReady, appendOmniRowArt, shortAge, ticketTs } = sandbox;

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source was not found`);
  return html.slice(start, end);
}

const SPIN = ["|", "/", "-", "\\"];
// the board's real painter, with the page's globals handed in. seen holds what
// the reader has read of each card; selected is the open card
function painter({ seen = {}, selected = "none", task = null } = {}) {
  // the painter reads the same clock, should it ever read the time itself
  return new Function("Date", "queueState", "cardState", "h", "seenReplies", "shortAge", "ticketTs",
    "spinGlyph", "curView", "selectedId", "selectedTask", "testReady", "appendOmniRowArt",
    "select", "onFold", "unfoldTicket",
    `${functionSource(HTML, "paintTicketPane", "renderCarousel")}; return paintTicketPane;`,
  )(ClockDate, queueState, cardState, h, seen, shortAge, ticketTs, () => SPIN[0], () => "done", selected, task, testReady,
    appendOmniRowArt, noop, noop, noop);
}

// a section that counts its rebuilds: each rebuild writes a new data-sig
function section() {
  const pane = new FakeElement("div");
  let sig = pane.dataset.sig, rebuilds = 0;
  return {
    pane,
    paint(paint, pool, view = "done") {
      paint(pane, pool, view, { agents: { lane: { name: "claude", alive: true } } }, "claudetrue");
      if (pane.dataset.sig !== sig) { rebuilds++; sig = pane.dataset.sig; return true; }
      return false;
    },
    get rebuilds() { return rebuilds; },
  };
}

const NOW = () => clock.now / 1000;
const MIN = 60, HOUR = 3600, DAY = 86400;
const done = (n, ageSec) => ({ id: "m" + n, title: "Card " + n, owner: "lane", ball: "you", bg: false, writing: false,
  task: "", pending: 0, pendingStamps: [], replies: 1, agent: "claude", done: true, state: "done", agentTs: NOW() - ageSec });
const ages = (pane) => pane.children.map(r => r.children[0].children.find(c => c.className === "tmeta").children[0].textContent);

test("the same rows with only minutes passing keep their signature while no shown age changes", () => {
  // ages chosen so no row crosses an hour or a day in the next five minutes
  const pool = [done(1, 3 * HOUR + 20 * MIN), done(2, 5 * DAY + 2 * HOUR), done(3, 7 * HOUR + 1 * MIN), done(4, 2 * DAY + 10 * HOUR)];
  const s = section(), paint = painter();
  assert.equal(s.paint(paint, pool), true, "the first paint draws the section");
  const first = s.pane.dataset.sig, rows = [...s.pane.children];
  assert.deepEqual(ages(s.pane), ["3h", "5d", "7h", "2d"]);
  for (let step = 0; step < 250; step++) {   // 250 polls at 1.2 s: five minutes
    clock.now += 1200;
    assert.equal(s.paint(paint, pool), false, `no rebuild at ${step * 1.2} s`);
  }
  assert.equal(s.pane.dataset.sig, first);
  assert.ok(s.pane.children.every((r, i) => r === rows[i]), "the rows on screen are the very same nodes");
});

test("a row's shown age turning over rebuilds the section, and only then", () => {
  // the third row is 3h59m30s old: it reads 4h thirty seconds from now
  const pool = [done(1, 2 * DAY), done(2, 6 * HOUR + 10 * MIN), done(3, 4 * HOUR - 30)];
  const s = section(), paint = painter();
  s.paint(paint, pool);
  assert.deepEqual(ages(s.pane), ["2d", "6h", "3h"]);
  clock.now += 25 * 1000;
  assert.equal(s.paint(paint, pool), false);
  clock.now += 10 * 1000;
  assert.equal(s.paint(paint, pool), true, "3h to 4h is a change the reader sees");
  assert.deepEqual(ages(s.pane), ["2d", "6h", "4h"]);
});

test("a row under an hour old still updates each minute", () => {
  const pool = [done(1, 30), done(2, 5 * DAY)];
  const s = section(), paint = painter();
  s.paint(paint, pool);
  assert.deepEqual(ages(s.pane), ["now", "5d"]);
  clock.now += 31 * 1000;
  assert.equal(s.paint(paint, pool), true, "now to 1m");
  assert.deepEqual(ages(s.pane), ["1m", "5d"]);
  for (let m = 2; m <= 59; m++) {
    clock.now += 30 * 1000;
    assert.equal(s.paint(paint, pool), false, `no rebuild inside minute ${m - 1}`);
    clock.now += 30 * 1000;
    assert.equal(s.paint(paint, pool), true, `${m - 1}m to ${m}m`);
    assert.equal(ages(s.pane)[0], m + "m");
  }
  clock.now += 60 * 1000;
  assert.equal(s.paint(paint, pool), true, "59m to 1h");
  assert.equal(ages(s.pane)[0], "1h");
  clock.now += 30 * MIN * 1000;
  assert.equal(s.paint(paint, pool), false, "an hour-old row keeps 1h for the rest of the hour");
});

test("a section the size of the owner's Done rebuilds only as often as a shown age changes", () => {
  // 411 done rows aged a few hours to two months, spread by the second
  const pool = Array.from({ length: 411 }, (_, i) => done(i + 1, 2 * HOUR + (i * 15013) % (60 * DAY)));
  const s = section(), paint = painter();
  s.paint(paint, pool);
  // the minute count the signature carried before
  const minutes = () => pool.map(b => Math.floor((NOW() - ticketTs(b)) / 60)).join(",");
  let shown = ages(s.pane).join(","), mins = minutes(), changes = 0, minuteChanges = 0, polls = 0;
  for (let t = 0; t < 10 * MIN; t += 1.2) {   // ten minutes of 1.2 s polls
    clock.now += 1200; polls++;
    const rebuilt = s.paint(paint, pool);
    const now = pool.map(b => shortAge(ticketTs(b))).join(",");
    assert.equal(rebuilt, now !== shown, "a rebuild exactly when a shown age changed");
    if (now !== shown) { changes++; shown = now; }
    if (minutes() !== mins) { minuteChanges++; mins = minutes(); }
  }
  assert.equal(s.rebuilds - 1, changes);
  assert.ok(changes < polls / 20, `${changes} rebuilds in ${polls} polls`);
  // the minute count turned over on almost every one of these polls
  assert.ok(minuteChanges > polls * 0.9, `the minute changed on ${minuteChanges} of ${polls} polls`);
});

test("everything else a row shows still rebuilds it", () => {
  const base = () => [done(1, 3 * HOUR), { ...done(2, 3 * HOUR), done: false, state: "yours" }];
  const s = section(), paint = painter();
  s.paint(paint, base(), "todo");
  const cases = {
    "a title": p => { p[0].title = "Renamed"; },
    "the agent's tag": p => { p[0].agent = "codex"; },
    "the ball": p => { p[1].ball = "me"; },
    "a job working": p => { p[1].bg = true; },
    "a claim": p => { p[1].writing = true; },
    "a queued message": p => { p[1].pending = 1; },
    "the testing marker": p => { p[1].testing = true; },
    "the order": p => { p.reverse(); },
    "a row gone": p => { p.pop(); },
    // the board can turn a row green with none of the flags above moving: a
    // due card (deferred wears working's green) or a progress note
    "the board's state alone": p => { p[1].state = "working"; },
  };
  let before = s.pane.dataset.sig;
  for (const [what, change] of Object.entries(cases)) {
    const pool = base(); change(pool);
    assert.equal(s.paint(paint, pool, "todo"), true, what);
    assert.equal(s.paint(paint, base(), "todo"), true, what + " undone");
    assert.equal(s.pane.dataset.sig, before);
  }
  // and the state alone recolours the row, as the minute used to within a minute
  const green = base(); green[1].state = "working";
  s.paint(paint, green, "todo");
  assert.ok(s.pane.children[1].classList.contains("working"));
  assert.equal(ages(s.pane)[1], SPIN[0], "a working row shows the spinner, which turns on its own timer");
  clock.now += 2 * HOUR * 1000;
  assert.equal(s.paint(paint, green, "todo"), true, "the done row went 3h to 5h");
});

test("selection, the selected task and the lane still rebuild", () => {
  const pool = [done(1, 3 * HOUR), done(2, 4 * HOUR)];
  const s = section();
  s.paint(painter(), pool);
  assert.equal(s.paint(painter({ selected: "m2" }), pool), true, "a selection");
  assert.ok(s.pane.children[1].classList.contains("on"));
  assert.equal(s.paint(painter({ selected: "m2", task: "t1" }), pool), true, "a selected task");
  assert.equal(s.paint(painter({ selected: "m2", task: "t1", seen: { m1: 1 } }), pool), true, "a read mark");
  assert.equal(s.paint(painter({ selected: "m2", task: "t1", seen: { m1: 1 } }), pool), false, "nothing new");
});

test("a rebuild keeps the section's scroll and glides the rows that moved", () => {
  const pool = Array.from({ length: 12 }, (_, i) => done(i + 1, (i + 2) * DAY));
  const s = section(), paint = painter();
  s.paint(paint, pool);
  s.pane.reveals = 0;
  s.pane.scrollTop = 300;
  clock.now += 1200;
  assert.equal(s.paint(paint, pool), false);
  assert.equal(s.pane.scrollTop, 300);
  const moved = [pool[5], ...pool.slice(0, 5), ...pool.slice(6)];   // the sixth card rises to the top
  assert.equal(s.paint(paint, moved), true);
  assert.equal(s.pane.scrollTop, 300, "the reader's place in the section is kept");
  assert.equal(s.pane.reveals, 0, "an ordinary rebuild reveals nothing");
  const glides = s.pane.children.filter(r => /^translate 220ms/.test(r.style.transition || "")).map(r => r.dataset.id);
  assert.deepEqual(glides, ["m6", "m1", "m2", "m3", "m4", "m5"], "the rows that changed place glide; the rest stay put");
  assert.ok(s.pane.children.every(r => !r.style.transform), "the glide leaves the transform to the selected row's lift");
});

// a card leaves the list and the rows under it glide up; the board's reading of
// that move lands while they are still gliding. a row taken out and put back
// then started its glide over from where the page last drew it, which trails the
// screen, and the ticket dropped back down before it rose again
test("a reading that lands mid-glide keeps the gliding rows and their glide", () => {
  const todo = () => Array.from({ length: 6 }, (_, i) => ({ ...done(i + 1, (i + 2) * DAY), done: false, state: "yours" }));
  const s = section();
  s.paint(painter({ selected: "m2" }), todo(), "todo");
  // the second card is moved away while it is open: the list loses it at once
  s.paint(painter({ selected: "m2" }), todo().filter(b => b.id !== "m2"), "todo");
  const still = s.pane.children[0], gliding = s.pane.children.slice(1);
  assert.deepEqual(gliding.map(r => r.dataset.id), ["m3", "m4", "m5", "m6"]);
  assert.ok(gliding.every(r => /^translate 220ms/.test(r.style.transition)), "the rows under it glide up");
  assert.equal(still.style.transition, undefined, "the row above it stays put");
  // the reading: the next card is open now and one title has changed
  const reading = todo().filter(b => b.id !== "m2");
  reading[2].title = "Renamed while gliding";
  assert.equal(s.paint(painter({ selected: "m3" }), reading, "todo"), true, "the reading is drawn");
  assert.ok(s.pane.children.slice(1).every((r, i) => r === gliding[i]), "the gliding rows are the very same nodes");
  assert.ok(gliding.every(r => /^translate 220ms/.test(r.style.transition)), "their glide is left running");
  assert.ok(gliding[0].classList.contains("on"), "the open card's row is marked");
  assert.equal(gliding[1].children[0].children.find(c => c.className === "ttl").textContent, "Renamed while gliding");
  assert.notEqual(s.pane.children[0], still, "a row at rest is drawn anew, as before");
  // once the glide has landed, a reading rebuilds the rows as it always has
  for (const r of s.pane.children) r.style.transition = "";
  assert.equal(s.paint(painter({ selected: "m4" }), reading, "todo"), true);
  assert.ok(s.pane.children.slice(1).every((r, i) => r !== gliding[i]), "rows at rest are rebuilt");
});
