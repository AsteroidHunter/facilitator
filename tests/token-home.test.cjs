// the home page and its token widgets, with no browser. home-widgets.js is run
// in a sandbox and held to what it draws: one square per day of the year in 53
// week columns of 7, a red-orange scale light to deep over a faint warm grey,
// a line of trailing 7-day averages, both at their own size in a view that
// scrolls sideways and opens on the latest weeks, and one pill that switches
// the panel between the two. then index.html's own home block is lifted out of the page
// and driven through a small DOM: the house opens home, the widgets are
// fetched only then, the panel asks the route for its days, and every project
// tab leaves it. every count below is invented; nothing renders a pixel
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const WIDGETS = read("home-widgets.js");
const HTML = read("index.html");
const SERVER = read("server.py");
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

// ---- a small DOM ---------------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentElement = null;
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this._text = "";
    this._html = "";
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const list = {
      add: (...n) => { this.className = [...new Set([...names(), ...n])].join(" "); },
      remove: (...n) => { this.className = names().filter(x => !n.includes(x)).join(" "); },
      contains: n => names().includes(n),
      toggle: (n, on) => {
        const want = on === undefined ? !names().includes(n) : !!on;
        if (want) list.add(n); else list.remove(n);
        return want;
      },
    };
    return list;
  }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set textContent(v) { this._text = String(v); this._html = ""; this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this._text = ""; this.children = []; this._parts = null; }
  appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { this.fire("click"); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  contains(n) { for (let x = n; x; x = x.parentElement) if (x === this) return true; return false; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  // the two parts of a chart's view the scroller reads, made from the markup
  // this element was last given: the chart is as wide as its first svg says,
  // the view as wide as the test says the panel is (540 unless told), and
  // scrollLeft is held between nothing and the room there is, as a browser does
  querySelector(sel) {
    const cls = { ".tk-lane": "tk-lane", ".tk-scroll": "tk-scroll" }[sel];
    if (!cls || !this._html.includes(`class="${cls}"`)) return null;
    this._parts ||= {};
    if (!this._parts[cls]) {
      const part = new El("div", this.ownerDocument);
      part.className = cls;
      if (cls === "tk-scroll") {
        part.scrollWidth = Number(/<svg[^>]* width="(\d+)"/.exec(this._html)[1]);
        part.clientWidth = this.viewWidth ?? 540;
        let left = 0;
        Object.defineProperty(part, "scrollLeft", { get: () => left,
          set: v => { left = Math.max(0, Math.min(v, part.scrollWidth - part.clientWidth)); } });
      }
      this._parts[cls] = part;
    }
    return this._parts[cls];
  }
  querySelectorAll() { return []; }
}
// a reader moving a view by hand: the browser sets the place, then says so
function scrollTo(view, left) {
  view.scrollLeft = left;
  view.fire("scroll");
}
function walk(el, out = []) {
  for (const c of el.children) { out.push(c); walk(c, out); }
  return out;
}
function makeDocument() {
  const doc = { listeners: {}, hidden: false };
  doc.createElement = tag => new El(tag, doc);
  doc.body = new El("body", doc);
  doc.head = new El("head", doc);
  doc.activeElement = doc.body;
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  return doc;
}
function makeStore(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), map: m };
}
function widgets(extra = {}) {
  const ctx = { console, ...extra };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(WIDGETS, ctx);
  return { ctx, W: ctx.TokenWidgets };
}

// ---- invented days ---------------------------------------------------------------------
// n days ending on `last`, oldest first, in the route's own shape
function daysEnding(last, n, total = i => (i % 5 === 0 ? 0 : (i + 1) * 1000)) {
  const end = Date.parse(last + "T00:00:00Z");
  return Array.from({ length: n }, (_, k) => {
    const i = n - 1 - k;
    const date = new Date(end - i * 864e5).toISOString().slice(0, 10);
    return { date, total: total(k), input: 0, cache_write: 0, cache_read: 0, output: 0, claude: 0, codex: 0 };
  });
}
const weekday = date => new Date(date + "T00:00:00Z").getUTCDay();
function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

// ---- the heatmap -------------------------------------------------------------------------
test("the heatmap draws one square per day of the year in 53 week columns of 7", () => {
  const { W } = widgets();
  // every weekday the year can end on
  for (let back = 0; back < 7; back++) {
    const last = new Date(Date.parse("2026-09-27T00:00:00Z") - back * 864e5).toISOString().slice(0, 10);
    const days = daysEnding(last, W.FETCH_DAYS);
    const model = W.heatmapModel(days);
    assert.equal(model.cells.length, 365);
    assert.equal(new Set(model.cells.map(c => c.col)).size, 53, "53 week columns");
    assert.equal(Math.min(...model.cells.map(c => c.col)), 0);
    assert.equal(Math.max(...model.cells.map(c => c.col)), 52);
    assert.equal(model.cells.at(-1).date, last, "the last square is today");
    assert.equal(model.cells[0].date, days.at(-365).date, "the first is 364 days before it");
    model.cells.forEach((c, i) => {
      assert.equal(c.row, weekday(c.date), `${c.date} sits in its weekday's row, Sunday on top`);
      if (i) {
        const p = model.cells[i - 1];
        assert.equal(c.col, p.row === 6 ? p.col + 1 : p.col, "a new column starts on Sunday");
      }
    });
    assert.equal(model.total, days.slice(-365).reduce((s, d) => s + d.total, 0),
                 "the year's total leaves out the six days fetched for the line");
    // month names over their columns, left to right, never crowded or off the grid
    assert.ok(model.months.length >= 11);
    for (let i = 1; i < model.months.length; i++)
      assert.ok(model.months[i].col - model.months[i - 1].col >= 3, "month names stand apart");
    assert.ok(model.months.every(m => m.col >= 0 && m.col <= 51));
    const svg = W.heatmapSvg(model);
    assert.equal((svg.match(/<rect class="tk-day"/g) || []).length, 365);
    // the one long row as first drawn, at its own size: 11 unit squares, one unit a pixel
    assert.match(svg, /<svg class="tk-heat" width="769" height="113" viewBox="0 0 769 113"/);
    assert.equal((svg.match(/width="11" height="11" rx="2"/g) || []).length, 365);
    // the day names are drawn apart, in the place they held, to stay put while the row scrolls
    const pin = W.heatPin();
    assert.match(pin, /^<svg width="30" height="113" viewBox="0 0 30 113"/);
    for (const name of ["Mon", "Wed", "Fri"]) {
      assert.ok(pin.includes(`>${name}</text>`));
      assert.ok(!svg.includes(`>${name}</text>`), `${name} would scroll away with the row`);
    }
    assert.ok(model.cells.every(c => c.x >= 30), "no square sits under the pinned names at the start");
  }
});

test("the colour scale runs light to deep red-orange, and a day with nothing is a faint warm grey", () => {
  const { W } = widgets();
  assert.equal(W.PALETTE.length, 5);
  const [empty, ...warm] = W.PALETTE.map(hsl);
  assert.ok(empty.s < 0.25 && empty.l > 0.85, "the empty square is a faint grey");
  const [r, g, b] = [1, 3, 5].map(i => parseInt(W.PALETTE[0].slice(i, i + 2), 16));
  assert.ok(r >= g && g >= b && r > b, "and a warm one");
  for (const c of warm) {
    assert.ok(c.h >= 8 && c.h <= 30, `hue ${c.h} is red-orange`);
    assert.ok(c.s > 0.6, "and saturated");
  }
  for (let i = 1; i < warm.length; i++) assert.ok(warm[i].l < warm[i - 1].l, "each step is deeper");

  // quartiles of the active days: nothing is level 0, the busiest is the deepest,
  // a busier day is never lighter, and a hundred days share the four steps evenly
  const values = [0, 0, ...Array.from({ length: 100 }, (_, i) => (i + 1) * 1e6)];
  const sc = W.scale(values);
  assert.equal(sc.level(0), 0);
  assert.equal(sc.colour(0), W.PALETTE[0]);
  assert.equal(sc.level(100e6), 4);
  assert.equal(sc.level(1e6), 1);
  const levels = values.map(sc.level);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1]);
  for (const step of [1, 2, 3, 4]) {
    const n = levels.filter(l => l === step).length;
    assert.ok(n >= 24 && n <= 26, `step ${step} holds ${n} days`);
  }
  // one enormous day does not wash every other day out to the lightest step
  const spike = W.scale([...Array.from({ length: 40 }, (_, i) => (i + 1) * 1e6), 5e12]);
  assert.equal(spike.level(40e6), 4);
  assert.equal(W.scale([0, 7]).level(7), 4, "a single active day is the deepest");
  // what the squares are painted with is the palette and nothing else
  const model = W.heatmapModel(daysEnding("2026-09-27", 371));
  const fills = new Set([...W.heatmapSvg(model).matchAll(/class="tk-day"[^>]*fill="([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual([...fills].sort(), [...W.PALETTE].sort());
  for (const c of model.cells) if (!c.total) assert.equal(c.fill, W.PALETTE[0]);
});

// ---- the line -----------------------------------------------------------------------------
test("the line is each day's trailing seven-day average over the same year", () => {
  const { W } = widgets();
  assert.deepEqual(Array.from(W.rolling([7, 0, 0, 0, 0, 0, 0, 14, 0])), [7, 3.5, 7 / 3, 1.75, 1.4, 7 / 6, 1, 2, 2]);
  assert.equal(W.FETCH_DAYS, 371, "the panel asks for the six days before the year too");
  const days = daysEnding("2026-09-27", 371, k => (k === 200 ? 7e6 : 0));
  const model = W.lineModel(days);
  assert.equal(model.points.length, 365);
  assert.equal(model.points.at(-1).date, "2026-09-27");
  // the spike's week: one million a day for seven days, then nothing
  const avg = model.points.map(p => p.avg);
  assert.equal(avg.filter(v => v === 1e6).length, 7);
  assert.equal(avg.filter(v => v === 0).length, 358);
  for (let i = 1; i < model.points.length; i++) assert.ok(model.points[i].x > model.points[i - 1].x);
  const { box } = model;
  for (const p of model.points) assert.ok(p.y >= box.top - 0.05 && p.y <= box.top + box.h + 0.05);
  // the axis tops out at the first round number the busiest week reaches
  assert.equal(model.top, 1e6);
  assert.deepEqual(Array.from(model.ticks), [0, 5e5, 1e6]);
  assert.equal(W.niceTop(1.3e6), 2e6);
  assert.equal(W.niceTop(4.1e9), 5e9);
  assert.equal(W.niceTop(0), 1);
  const peak = model.points.find(p => p.avg === 1e6);
  assert.ok(Math.abs(peak.y - box.top) < 0.1, "the busiest week reaches the top line");
  const half = W.lineModel(daysEnding("2026-09-27", 371, k => (k === 200 ? 7e6 : k === 300 ? 14e6 : 0)));
  const low = half.points.find(p => p.avg === 1e6);
  assert.ok(Math.abs(low.y - (half.box.top + half.box.h / 2)) < 0.1, "half the axis is half the height");
  const svg = W.lineSvg(model);
  // its first proportions, at its own size: the heatmap's 769 by 113, one unit a pixel
  assert.match(svg, /<svg class="tk-line" width="769" height="113" viewBox="0 0 769 113"/);
  assert.deepEqual({ ...model.box }, { left: 38, right: 6, top: 8, bottom: 17, w: 725, h: 88 });
  const path = /class="tk-path" d="([^"]+)"/.exec(svg)[1];
  assert.equal((path.match(/[ML]/g) || []).length, 365);
  assert.ok(svg.includes(`stroke="${W.LINE}"`));
  assert.ok(hsl(W.LINE).h >= 8 && hsl(W.LINE).h <= 30, "the same warm colour");
  // the count names are drawn apart into the place they held, to stay put while the line scrolls
  const pin = W.linePin(model);
  assert.match(pin, /^<svg width="38" height="113" viewBox="0 0 38 113"/);
  for (const label of ["0", "500K", "1M"]) {
    assert.ok(pin.includes(`>${label}</text>`));
    assert.ok(!svg.includes(`>${label}</text>`), `${label} would scroll away with the line`);
  }
  // a year of nothing still draws, flat on the floor
  const flat = W.lineModel(daysEnding("2026-09-27", 371, () => 0));
  assert.ok(flat.points.every(p => p.y === box.top + box.h));
});

// ---- the scrolling view ---------------------------------------------------------------------
test("the view opens a chart on its latest weeks, keeps a place scrolled back to, and fades the sides with more", () => {
  const { W } = widgets();
  const doc = makeDocument();
  const days = daysEnding("2026-09-27", 371);
  const el = new El("div", doc);
  W.drawHeatmap(el, days);
  assert.match(el.innerHTML, /^<div class="tk-view"><div class="tk-lane"><div class="tk-scroll"><div class="tk-chart"><svg class="tk-heat" width="769"/);
  assert.match(el.innerHTML, /<div class="tk-pin" style="width:30px"><svg width="30"/);
  let view = el.querySelector(".tk-scroll"), lane = el.querySelector(".tk-lane");
  assert.equal(view.scrollWidth, 769, "the row at its own width, wider than the 540px view");
  assert.equal(view.scrollLeft, 769 - 540, "it opens at the right end, on the latest weeks");
  assert.ok(lane.classList.contains("more-left") && !lane.classList.contains("more-right"), "more only to the left");

  // a place of its own, followed as the reader scrolls
  const spot = { end: true, left: 0 };
  W.drawHeatmap(el, days, spot);
  assert.equal(el.querySelector(".tk-scroll").scrollLeft, 229);
  scrollTo(el.querySelector(".tk-scroll"), 100);
  assert.deepEqual({ ...spot }, { end: false, left: 100 });
  lane = el.querySelector(".tk-lane");
  assert.ok(lane.classList.contains("more-left") && lane.classList.contains("more-right"), "more on both sides");
  // a redraw, as the five-minute refresh does, puts the view back where it stood
  W.drawHeatmap(el, days, spot);
  assert.equal(el.querySelector(".tk-scroll").scrollLeft, 100);
  scrollTo(el.querySelector(".tk-scroll"), 0);
  lane = el.querySelector(".tk-lane");
  assert.ok(!lane.classList.contains("more-left") && lane.classList.contains("more-right"), "at the start, more only to the right");
  // back at the end, a view stays at the end whatever room a redraw leaves it
  scrollTo(el.querySelector(".tk-scroll"), 229);
  assert.equal(spot.end, true);
  el.viewWidth = 400;
  W.drawHeatmap(el, days, spot);
  assert.equal(el.querySelector(".tk-scroll").scrollLeft, 369);
  // a panel as wide as the chart has nothing to scroll and nothing to fade
  el.viewWidth = 800;
  W.drawLine(el, days, { end: true, left: 0 });
  view = el.querySelector(".tk-scroll"); lane = el.querySelector(".tk-lane");
  assert.equal(view.scrollLeft, 0);
  assert.ok(!lane.classList.contains("more-left") && !lane.classList.contains("more-right"));
  // the line's view is the same, its count names pinned in their own 38px
  assert.match(el.innerHTML, /<svg class="tk-line" width="769"/);
  assert.match(el.innerHTML, /<div class="tk-pin" style="width:38px"><svg width="38"/);
});

test("each chart keeps its own place when the pill switches, and a refresh keeps it", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const store = makeStore();
  const data = { days: daysEnding("2026-09-27", 371), found: { claude: true, codex: true } };
  const root = new El("div", doc);
  const p = W.panel(root, { load: async () => data, store });
  const stage = walk(root).find(n => n.className === "tk-stage");
  const [heat, line] = walk(root).filter(n => n.dataset.view);
  const view = () => stage.querySelector(".tk-scroll");
  await p.refresh();
  assert.equal(view().scrollLeft, 229, "the heatmap opens on its latest weeks");
  scrollTo(view(), 100);
  line.click();
  assert.match(stage.innerHTML, /class="tk-line"/);
  assert.equal(view().scrollLeft, 229, "the line opens on its own latest weeks, not where the heatmap was");
  scrollTo(view(), 10);
  heat.click();
  assert.equal(view().scrollLeft, 100, "the heatmap is back where it was left");
  line.click();
  assert.equal(view().scrollLeft, 10, "and so is the line");
  await p.refresh();
  assert.equal(view().scrollLeft, 10, "a refresh redraws the line where it stood");
  // a new panel, as after a reload, opens on the latest weeks again
  const again = new El("div", doc);
  const q = W.panel(again, { load: async () => data, store });
  await q.refresh();
  assert.equal(q.view(), "line");
  assert.equal(walk(again).find(n => n.className === "tk-stage").querySelector(".tk-scroll").scrollLeft, 229);
});

test("the box is narrower than the charts and taller than before, and scrolls them natively with no bar", () => {
  const { W } = widgets();
  assert.deepEqual({ ...W.CHART }, { width: 769, height: 113 });
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => {
    const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(css);
    assert.ok(m, `no rule for ${sel}`);
    return m[1];
  };
  // never stretched to the panel: each svg keeps the width and height it is drawn with
  assert.doesNotMatch(rule(".tk-chart svg"), /width|height/);
  assert.match(rule(".tk-chart"), /width:max-content/);
  // sideways scrolling the browser's own way, kept inside the lane
  const scroll = rule(".tk-scroll");
  assert.match(scroll, /overflow-x:auto/);
  assert.match(scroll, /overflow-y:hidden/);
  assert.match(scroll, /overscroll-behavior-x:contain/);
  // no bar, the board's rule for every scroller, and no motion of its own
  assert.match(read("card-tokens.css"), /\*\{scrollbar-width:none\}\n\*::-webkit-scrollbar\{display:none\}/);
  assert.doesNotMatch(css, /scrollbar|\bscroll-behavior|transition:[^;}]*(opacity|left|transform)/);
  assert.doesNotMatch(WIDGETS, /smooth|scrollTo\(|scrollBy\(|requestAnimationFrame/);
  // a soft fade on each side with more, and the pinned names let the pointer through
  assert.match(css, /\.tk-lane\.more-left \.tk-pin::after, \.tk-lane\.more-right::after\{opacity:1\}/);
  assert.match(rule(".tk-pin"), /background:var\(--card\); pointer-events:none/);
  // the box: 582 across, the view 192 tall, so with the panel's padding, its
  // heading and its foot about 291 down, against the 840 by 223 it first was
  const home = /body\.focus\.home #home\{([^}]*)\}/.exec(HTML)[1];
  assert.match(home, /width:min\(582px, calc\(100vw - 64px\)\)/);
  assert.match(home, /top:max\(calc\(var\(--bar-h\) \+ \(100vh - var\(--bar-h\)\) \* \.44\), calc\(var\(--bar-h\) \+ 162px\)\);/);
  assert.match(home, /transform:translate\(-50%, -50%\)/);
  assert.match(rule(".tk-view"), /height:192px/);
  assert.match(rule(".tk-panel"), /padding:16px 20px 14px/);
  const height = 16 + 14 + 41.6 + 192 + 26 + 1.6;
  assert.ok(height > 223 && 582 < 840 && 582 / height < 2.05, "taller and narrower than the first box");
  assert.ok(582 - 42 < W.CHART.width, "the view is narrower than the charts, so they scroll rather than shrink");
  // the wait holds the view's height and the foot's, so the centred box never moves
  assert.match(rule(".tk-wait"), /height:192px; margin-bottom:26px/);
});

test("counts read short and the tips name the day", () => {
  const { W } = widgets();
  const cases = [[0, "0"], [999, "999"], [1234, "1.23K"], [999_600, "1M"], [48_210_000, "48.2M"],
                 [5_214_000_000, "5.21B"], [120e9, "120B"], [3e12, "3T"]];
  for (const [n, want] of cases) assert.equal(W.compact(n), want, String(n));
  assert.equal(W.longDay("2026-09-27"), "Sun, Sep 27, 2026");
  // a square is one day, and its tip says so
  assert.equal(W.heatTip({ date: "2026-09-23", total: 48_210_000 }),
               "<b>48.2M tokens that day</b><span>Wed, Sep 23, 2026</span>");
  assert.equal(W.heatTip({ date: "2026-09-23", total: 0 }), "<b>No tokens that day</b><span>Wed, Sep 23, 2026</span>");
  // the headline a size up from the lines under it
  const css = read("home-widgets.css");
  assert.match(css, /\.tk-tip\{[^}]*font:400 11px\/15px var\(--sans\)/);
  assert.match(css, /\.tk-tip b\{font-weight:600; font-size:12px; line-height:16px\}/);
});

test("the line's tip leads with the average the dot shows, and no number on the line view passes its axis", () => {
  const { W } = widgets();
  // the owner's reading: Monday, Sep 21 alone was 1.35B, and its week averaged 616M a day
  const days = daysEnding("2026-09-27", 371,
    k => (k >= 358 && k <= 363 ? 493_666_667 : k === 364 ? 1.35e9 : 0));
  const model = W.lineModel(days);
  assert.equal(model.top, 1e9, "the axis tops out at 1B, as in the owner's picture");
  assert.match(W.linePin(model), />1B<\/text>/);
  const p = model.points.find(x => x.date === "2026-09-21");
  assert.equal(W.lineTip(p), "<b>616M a day, 7-day average</b>" +
    "<span>1.35B on Mon, Sep 21 alone</span><span>Averaged over Sep 15 to Sep 21, 2026</span>");
  assert.ok(Math.abs(p.y - model.yAt(p.avg)) < 0.1, "the dot stands at the headline's number");
  // on every day of the year the headline is the line's own value, which never
  // passes the axis top; a day's own count, which can, only ever appears named
  // as that one day, under the headline
  for (const q of model.points) {
    const tip = W.lineTip(q);
    assert.equal(/^<b>([^<]*)<\/b>/.exec(tip)[1], `${W.compact(q.avg)} a day, 7-day average`);
    assert.ok(q.avg <= model.top, `${q.date} stands above the axis`);
    assert.equal(q.span, 7, "every day of the year averages a whole week");
    assert.ok(tip.indexOf(`<span>${W.compact(q.total)} on `) > tip.indexOf("</b>"));
    assert.ok(tip.includes(" alone</span>"));
  }
  assert.ok(model.points.some(q => q.total > model.top), "the reading has a day above the axis to be careful of");
  // a week that crosses the new year names both years
  assert.match(W.lineTip(W.lineModel(daysEnding("2026-01-02", 371)).points.at(-1)),
               /Averaged over Dec 27, 2025 to Jan 2, 2026<\/span>$/);
  // where a reading begins, the average says how few days it holds
  const short = W.lineModel(daysEnding("2026-09-27", 3, () => 3e6));
  assert.equal(W.lineTip(short.points[0]),
               "<b>3M a day, 1-day average</b><span>3M on Fri, Sep 25 alone</span><span>Averaged over Sep 25, 2026</span>");
  assert.match(W.lineTip(short.points[2]), /^<b>3M a day, 3-day average<\/b>.*Averaged over Sep 25 to Sep 27, 2026/);
});

// ---- the panel -----------------------------------------------------------------------------
test("one pill switches the panel between the two charts and the choice is remembered", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const store = makeStore();
  const data = { days: daysEnding("2026-09-27", 371), found: { claude: true, codex: false } };
  const root = new El("div", doc);
  const p = W.panel(root, { load: async () => data, store });
  const box = root.children[0];
  assert.equal(box.className, "tk-panel", "one rectangle");
  const pills = walk(box).filter(n => n.className === "tk-pill");
  assert.equal(pills.length, 1, "one pill");
  const opts = pills[0].children;
  assert.deepEqual(opts.map(b => [b.tagName, b.type, b.dataset.view, b.textContent]),
                   [["BUTTON", "button", "heatmap", "Heatmap"], ["BUTTON", "button", "line", "Line"]]);
  const stage = walk(box).find(n => n.className === "tk-stage");
  const asking = p.refresh();
  assert.match(stage.textContent, /Counting tokens/);
  await asking;
  const pressed = () => opts.map(b => b.getAttribute("aria-pressed"));
  assert.deepEqual(pressed(), ["true", "false"]);
  assert.ok(opts[0].classList.contains("on") && !opts[1].classList.contains("on"));
  assert.match(stage.innerHTML, /class="tk-heat"/);
  assert.equal((stage.innerHTML.match(/class="tk-day"/g) || []).length, 365);
  assert.match(stage.innerHTML, /tokens in the last year/);

  opts[1].click();
  assert.deepEqual(pressed(), ["false", "true"]);
  assert.ok(!opts[0].classList.contains("on") && opts[1].classList.contains("on"));
  assert.match(stage.innerHTML, /class="tk-line"/);
  assert.doesNotMatch(stage.innerHTML, /class="tk-heat"/);
  assert.equal(store.getItem("home.chart"), "line");
  assert.equal(p.view(), "line");

  // a second panel in the same browser opens on the chart last chosen
  const again = W.panel(new El("div", doc), { load: async () => data, store });
  await again.refresh();
  assert.equal(again.view(), "line");

  opts[0].click();
  assert.match(stage.innerHTML, /class="tk-heat"/);
  assert.equal(store.getItem("home.chart"), "heatmap");
  p.show("pie");
  assert.equal(p.view(), "heatmap", "an unknown chart changes nothing");
});

test("the panel says so when the counts cannot be read or no logs were found", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const failing = new El("div", doc);
  const p = W.panel(failing, { load: async () => { throw new Error("down"); }, store: null });
  await p.refresh();
  assert.match(failing.textContent, /could not be read/);
  const empty = new El("div", doc);
  const q = W.panel(empty, { load: async () => ({ days: daysEnding("2026-09-27", 371, () => 0),
                                                  found: { claude: false, codex: false } }), store: null });
  await q.refresh();
  const note = walk(empty).find(n => n.className === "tk-note");
  assert.match(note.textContent, /No Claude Code or Codex logs/);
  const stage = walk(empty).find(n => n.className === "tk-stage");
  assert.equal((stage.innerHTML.match(/fill="#EEEAE4"/g) || []).length, 365, "an empty year is still drawn");
});

// ---- the home page in the board --------------------------------------------------------
test("the board's markup, sheet and routes carry the home page", () => {
  const house = /<button id="homeico"[^>]*>/.exec(HTML);
  assert.ok(house, "the house is a button");
  assert.match(house[0], /type="button"/);
  assert.match(house[0], /aria-label="Home"/);
  assert.doesNotMatch(house[0], /aria-hidden/);
  assert.match(HTML, /<section id="home" aria-label="Home"><div id="homeplot"><\/div><\/section>/);
  assert.doesNotMatch(HTML, /#homeico\{[^}]*#C9BFAE/, "the house is no longer greyed out");
  assert.match(HTML, /body\.focus #homeico:hover, body\.focus\.home #homeico\{color:var\(--ink\)\}/);
  assert.match(HTML, /body\.focus\.home #stage\{visibility:hidden; opacity:0; pointer-events:none\}/);
  assert.match(HTML, /body\.focus\.home #home\{display:block;/);
  // the widgets are fetched when home opens, never on boot
  assert.doesNotMatch(HTML, /<script src="\/home-widgets\.js">/);
  assert.doesNotMatch(HTML, /<link[^>]*home-widgets\.css/);
  // every project tab leaves home, the plus does too, no tab is seated while it
  // is up, and the board's keys are off
  const setTab = HTML.slice(HTML.indexOf("function setTab("), HTML.indexOf("\n}\n", HTML.indexOf("function setTab(")));
  assert.match(setTab, /if \(LOCKED && owner !== LOCKED\) return;\n  if \(homeOpen\) setHome\(false\);/);
  const plus = HTML.slice(HTML.indexOf("function plusClick("), HTML.indexOf("\n}\n", HTML.indexOf("function plusClick(")));
  assert.match(plus, /if \(homeOpen\) setHome\(false\);\n  draft = /);
  assert.match(HTML, /t\.classList\.toggle\("on", t\.dataset\.owner === activeOwner && !homeOpen\);/);
  assert.match(HTML, /function boardKeysLive\(\)\{ return [^}]*!homeOpen && onBoardPage\(\); \}/);
  // the server hands out both files and the counts
  for (const route of ["/home-widgets.js", "/home-widgets.css", "/tokens/daily"])
    assert.ok(SERVER.includes(`Route("${route}"`), route);
});

// the page's own home block, run against the small DOM
function homeBlock({ serve = true, stored = {} } = {}) {
  const start = HTML.indexOf("// ---- the home page ----");
  const end = HTML.indexOf("// ---- the project's pages ----");
  assert.ok(start > 0 && end > start, "the home block was not found");
  const doc = makeDocument();
  const byId = {};
  for (const id of ["homeico", "homeplot", "stage"]) byId[id] = new El(id === "homeico" ? "button" : "div", doc);
  doc.getElementById = id => byId[id] || null;
  const inside = new El("textarea", doc);
  byId.stage.appendChild(inside);
  const store = makeStore(stored);
  const fetched = [], tabs = [], timers = new Map();
  let nextTimer = 0;
  const ctx = {
    console, document: doc, localStorage: store, FOCUS: true, editMode: false, lastState: { rev: 1 },
    setEditMode: on => { ctx.editMode = on; },
    renderTabs: st => tabs.push(st),
    setInterval: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: id => { timers.delete(id); },
    fetch: async url => { fetched.push(url);
      return { ok: true, json: async () => ({ days: daysEnding("2026-09-27", 371), found: { claude: true, codex: true } }) }; },
  };
  ctx.window = ctx;
  // appending the script is where a browser would fetch it: here it runs the
  // real file into the same sandbox, or fails the way a 404 does
  doc.head.append = (...nodes) => {
    for (const n of nodes) {
      doc.head.appendChild(n);
      if (n.tagName !== "SCRIPT") continue;
      if (serve) { vm.runInContext(WIDGETS, ctx); n.onload(); } else n.onerror();
    }
  };
  vm.createContext(ctx);
  vm.runInContext(HTML.slice(start, end), ctx);
  const is = name => vm.runInContext(name, ctx);
  return { ctx, doc, byId, inside, store, fetched, tabs, timers, is };
}

test("the house opens home, fetches the widgets then, and a project tab leaves it", async () => {
  const h = homeBlock();
  h.doc.activeElement = h.inside;              // typing in the board when home opens
  h.ctx.editMode = true;                       // and arranging it
  assert.equal(h.doc.head.children.length, 0, "nothing fetched on boot");
  h.byId.homeico.click();
  assert.equal(h.is("homeOpen"), true);
  assert.ok(h.doc.body.classList.contains("home"));
  assert.equal(h.byId.homeico.getAttribute("aria-pressed"), "true");
  assert.equal(h.store.getItem("homeopen"), "1");
  assert.equal(h.ctx.editMode, false, "the board's arranging goes with the board");
  assert.equal(h.doc.activeElement, h.doc.body, "and its typing");
  assert.equal(h.tabs.length, 1, "the tabs are drawn again with none seated");
  await settle();
  const [sheet, script] = h.doc.head.children;
  assert.equal(sheet.href, "/home-widgets.css");
  assert.equal(script.src, "/home-widgets.js");
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371"]);
  const panel = h.byId.homeplot.children[0];
  assert.equal(panel.className, "tk-panel");
  const stage = walk(panel).find(n => n.className === "tk-stage");
  assert.equal((stage.innerHTML.match(/class="tk-day"/g) || []).length, 365);
  assert.equal([...h.timers.values()].filter(t => t.ms === 5 * 60 * 1000).length, 1, "asks again every five minutes");

  // the house is a place: pressing it again changes nothing
  h.byId.homeico.click();
  await settle();
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371"]);

  // leaving, as a project tab does
  h.ctx.setHome(false);
  assert.equal(h.is("homeOpen"), false);
  assert.ok(!h.doc.body.classList.contains("home"));
  assert.equal(h.byId.homeico.getAttribute("aria-pressed"), "false");
  assert.equal(h.store.getItem("homeopen"), null);
  assert.equal(h.timers.size, 0, "no asking while home is shut");

  // back again: the same panel asks again, and nothing is fetched twice
  h.byId.homeico.click();
  await settle();
  assert.equal(h.doc.head.children.length, 2);
  assert.equal(h.byId.homeplot.children.length, 1);
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371", "/tokens/daily?days=371"]);
});

test("a reload comes back to home, and a board without the files says so", async () => {
  const back = homeBlock({ stored: { homeopen: "1" } });
  assert.equal(back.is("homeOpen"), false);
  for (const fn of back.doc.listeners.DOMContentLoaded) fn();
  assert.equal(back.is("homeOpen"), true);
  await settle();
  assert.deepEqual(back.fetched, ["/tokens/daily?days=371"]);

  const old = homeBlock({ serve: false });
  old.byId.homeico.click();
  await settle();
  assert.match(old.byId.homeplot.textContent, /needs the server restart/);
  assert.deepEqual(old.fetched, []);
  assert.equal(old.doc.head.children.filter(n => n.tagName === "SCRIPT").length, 0, "the failed script is taken back out");
});
