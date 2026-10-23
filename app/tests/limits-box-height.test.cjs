// Plain node:test, no browser. The Usage Limits box on Home is only as tall as
// its heading, the bars it has and its timestamp line, with a small gap under
// the heading and no spare room above the bars. The height is worked out from
// the sheet and the nodes the widget draws (limits-box-model.cjs).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CSS, declarations, boxHeight } = require("./limits-box-model.cjs");
const ROOT = process.env.HOME_SOURCE_ROOT || path.resolve(__dirname, "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "home-widgets.js"), "utf8");

class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attrs = {};
    this.style = {}; this.className = ""; this.hidden = false; this._text = "";
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  get classList() { return { toggle() {}, add() {}, remove() {}, contains: n => this.className.split(/\s+/).includes(n) }; }
  addEventListener() {}
  removeEventListener() {}
}
function widgets(store) {
  const doc = { createElement: tag => new Element(tag, doc), addEventListener() {}, removeEventListener() {} };
  const ctx = { document: doc, console, setTimeout, clearTimeout, localStorage: store };
  ctx.window = ctx;
  vm.runInNewContext(SOURCE, ctx);
  return { W: ctx.TokenWidgets, root: () => new Element("div", doc) };
}
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return { values, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
}
const FAR = 4102444800;
const win = used => ({ used, resets: FAR });
// an answer with the first n of the four possible bars
const WINDOWS = [["claude", "five_hour"], ["claude", "weekly"], ["codex", "five_hour"], ["codex", "weekly"]];
function answer(n) {
  const out = { fetched: 1000, now: 1000 };
  WINDOWS.slice(0, n).forEach(([tool, span], i) => { (out[tool] ||= {})[span] = win(10 + i); });
  return out;
}
// the owner's case: Claude 5-hour and weekly, Codex weekly only
const THREE = { claude: { five_hour: win(30), weekly: win(48) }, codex: { weekly: win(12) }, fetched: 1000, now: 1000 };
const kept = a => storage({ "home.limits": JSON.stringify({ at: 900000, answer: a }) });
const never = () => new Promise(() => {});
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const barsOf = host => host.children[0].children.find(c => c.className === "lm-rows").children.filter(c => c.className === "lm-row").length;
const height = (host, mac = true, unit = 1) => boxHeight(host.children[0], { mac, unit });
const draw = async (a, opts = {}) => {
  const { W, root } = widgets(storage());
  const host = root(), box = W.limits(host, { now: () => 1000000, load: async () => a, ...opts });
  await box.refresh();
  return host;
};

for (const mac of [true, false]) for (const unit of [1, 0.9, 1.2]) {
  const where = `${mac ? "mouse and trackpad" : "touch"}, unit ${unit}`;
  test(`the box is exactly the heading, its bars and the timestamp with 1, 2, 3 and 4 bars (${where})`, async () => {
    const rules = declarations(".lm-rows", { mac });
    const rowH = 16, gap = 7 * unit, above = 7 * unit;
    assert.equal(rules["margin-top"], "calc(7 * var(--u, 1px))", "a small gap under the heading");
    const heights = [];
    for (const n of [1, 2, 3, 4]) {
      const host = await draw(answer(n));
      assert.equal(barsOf(host), n);
      const rows = n * rowH + (n - 1) * gap;
      // everything that is not the bars: border, padding, heading, gap, timestamp
      const chrome = height(host, mac, unit) - rows;
      heights.push({ n, h: height(host, mac, unit), chrome });
      // the heading's bottom edge meets the gap and the gap meets the first bar: nothing between
      assert.equal(declarations(".lm-rows", { mac })["align-content"], undefined, "no packing to one end");
    }
    for (const x of heights) assert.ok(Math.abs(x.chrome - heights[0].chrome) < 1e-9, `${where}: same chrome with ${x.n} bars`);
    for (let i = 1; i < 4; i++) assert.ok(Math.abs(heights[i].h - heights[i - 1].h - (rowH + gap)) < 1e-9,
      `${where}: each bar adds its row and one gap, nothing else`);
    // heading 18 (+4 above it with a pointer) + 7 gap, border, padding and the 8 + 14 line
    const expectedChrome = (mac ? 10 + 9 + 4 : 16 + 14) * (mac ? 1 : unit) + 18 + above + 1.6 + 8 * unit + 14;
    assert.ok(Math.abs(heights[0].chrome - expectedChrome) < 1e-9, `${where}: chrome ${heights[0].chrome} against ${expectedChrome}`);
  });
}

test("the owner's three bars make a box of heading, gap, three rows and timestamp: 133.6px with a pointer", async () => {
  const host = await draw(THREE);
  assert.equal(barsOf(host), 3);
  assert.ok(Math.abs(height(host, true) - 133.6) < 1e-9, `got ${height(host, true)}`);
  // 3 rows of 16 and 2 gaps of 7 is 62; the old fixed box was 184 with 120 for the rows area
  assert.ok(height(host, true) < 184 - 50);
});

test("the sheet has no fixed height for the box and no room kept for a fourth bar", () => {
  const box = declarations(".lm-box", { mac: true });
  assert.equal(box.height, "auto");
  assert.doesNotMatch(CSS.replace(/\/\*[\s\S]*?\*\//g, ""), /184|span 4/);
  const rows = declarations(".lm-rows", { mac: true });
  assert.equal(rows.flex, "none", "the rows area takes only what the rows need");
  assert.equal(rows["align-content"], undefined);
  assert.equal(rows["min-height"], undefined);
});

test("first paint: the box is made from the kept answer at the height it will have when the answer arrives", async () => {
  for (const n of [1, 2, 3, 4]) {
    const { W, root } = widgets(kept(answer(n)));
    const host = root(), request = pending();
    const box = W.limits(host, { now: () => 1000000, load: () => request.promise });
    // before any request has come back
    assert.equal(host.hidden, false);
    assert.equal(barsOf(host), n, `${n} kept bars are on the page at once`);
    assert.ok(!host.children[0].children.some(c => c.className === "lm-rows" && c.children.some(k => k.className === "tk-wait")), "no loading message");
    const first = height(host);
    const work = box.refresh();
    assert.equal(height(host), first, "asking again moves nothing");
    request.resolve(answer(n));
    await work;
    assert.equal(height(host), first, `${n} bars: the same height after the same answer`);
  }
});

test("first paint with the owner's three bars is the finished height, and a reload keeps it", async () => {
  const store = kept(THREE);
  const { W, root } = widgets(store);
  const host = root();
  const box = W.limits(host, { now: () => 1000000, load: async () => THREE });
  const opened = height(host);
  await box.refresh();
  assert.equal(height(host), opened);
  const again = widgets(store), next = again.root();
  again.W.limits(next, { now: () => 1000000, load: never });
  assert.equal(height(next), opened, "a reloaded page opens at the same height");
  assert.equal(barsOf(next), 3);
});

test("the box changes height only when the number of bars changes", async () => {
  const { W, root } = widgets(kept(THREE));
  const host = root(); let reply = THREE;
  const box = W.limits(host, { now: () => 1000000, load: async () => reply });
  const opened = height(host);
  reply = { ...THREE, claude: { five_hour: win(77), weekly: win(5) } };
  await box.refresh();
  assert.equal(height(host), opened, "new numbers on the same bars");
  reply = answer(4);
  await box.refresh();
  assert.equal(barsOf(host), 4);
  assert.ok(Math.abs(height(host) - opened - 23) < 1e-9, "a fourth bar adds one row and one gap");
  reply = { fetched: 2000, now: 2000, claude: { weekly: win(5) } };
  await box.refresh();
  assert.equal(barsOf(host), 1);
  assert.ok(Math.abs(height(host) - opened + 46) < 1e-9, "going down to one bar takes two rows and two gaps away");
});

test("before any answer was ever kept, a loading or failure message is never taller than one bar's box", async () => {
  const one = height(await draw(answer(1)));
  const { W, root } = widgets(storage());
  const host = root(); let fail = false, reply = {};
  const box = W.limits(host, { now: () => 1000000, load: () => (fail ? Promise.reject(new Error("offline")) : Promise.resolve(reply)) });
  assert.match(host.textContent, /Reading usage limits/);
  assert.ok(height(host) <= one + 1e-9, "the loading message");
  assert.equal(height(host), one, "it takes the room of one bar");
  fail = true;
  await box.refresh();
  assert.match(host.textContent, /unavailable/);
  assert.equal(height(host), one, "the failure message");
  fail = false;
  await box.refresh();
  assert.match(host.textContent, /No usage limits available yet/);
  assert.equal(height(host), one, "the empty message");
  // then three bars arrive: this is the one change a first-ever visit has
  reply = THREE;
  await box.refresh();
  assert.equal(barsOf(host), 3);
  assert.ok(height(host) > one);
});

test("the message keeps to one line, so it cannot grow the box", () => {
  const wait = declarations(".lm-rows > .tk-wait", { mac: true });
  assert.equal(wait.display, "block");
  assert.equal(wait["white-space"], "nowrap");
  assert.equal(wait.overflow, "hidden");
  assert.equal(wait["text-overflow"], "ellipsis");
  assert.equal(wait["grid-column"], "1 / -1");
  assert.equal(wait["grid-row"], undefined, "one row, not four");
  assert.equal(wait.height, undefined);
});

test("the box's rules use no purple and not the accent", () => {
  const mine = CSS.slice(CSS.indexOf(".lm-box"));
  assert.doesNotMatch(mine, /--accent|#432BFF|#EEEBFF|purple/i);
});
