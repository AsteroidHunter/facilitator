// the home page and its token widgets, with no browser. home-widgets.js is run
// in a sandbox and held to what it draws: one square per day of the year in 53
// week columns of 7, a red-orange scale light to deep over a faint warm grey,
// a solid line of daily totals under a dotted line of trailing 7-day averages
// on a count axis that ends at the next round tick past the busiest day, both
// drawn to the view's height in a lane that scrolls sideways by swipe, wheel
// or drag and opens on the latest weeks, and one pill whose seat slides
// between the two. then index.html's own home block is lifted out of the page
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
    // drawn at the default view height when no view gives it one: 200 tall,
    // a 25px week column, 21px squares with 4px between, never stretched
    assert.match(svg, /<svg class="tk-heat" width="1355" height="200" viewBox="0 0 1355 200"/);
    assert.equal((svg.match(/width="21" height="21" rx="3"/g) || []).length, 365);
    // the day names are drawn apart, in the place they held, to stay put while the row scrolls
    const pin = W.heatPin(model);
    assert.match(pin, /^<svg width="34" height="200" viewBox="0 0 34 200"/);
    for (const name of ["Mon", "Wed", "Fri"]) {
      assert.ok(pin.includes(`>${name}</text>`));
      assert.ok(!svg.includes(`>${name}</text>`), `${name} would scroll away with the row`);
    }
    assert.ok(model.cells.every(c => c.x >= 34), "no square sits under the pinned names at the start");
  }
});

test("the heatmap's squares grow with the view's height, within limits, and fill it", () => {
  const { W } = widgets();
  assert.equal(W.VIEW_H, 200);
  // the board's two window sizes (1512 x 982 and 1280 x 800) and the phone's
  // view: seven rows and the month names fill the height, with at most a few
  // pixels over, split above and below
  for (const [h, step, cell] of [[251, 32, 28], [187, 23, 19], [226, 29, 25], [156, 19, 16], [200, 25, 21]]) {
    const g = W.geometry(h);
    assert.equal(g.step, step, `step at ${h}`);
    assert.equal(g.cell, cell, `square at ${h}`);
    assert.equal(g.height, h, "as tall as the view");
    assert.equal(g.width, 34 + 53 * step - g.gap);
    const bottom = g.top + g.rows;
    // under a column's width and its gap over, less than 7 + 2 + 4
    assert.ok(g.top - 20 >= 0 && h - bottom >= 0 && (g.top - 20) + (h - bottom) <= 12, `${h} leaves little over`);
    assert.ok(Math.abs((g.top - 20) - (h - bottom)) <= 3, "what is over is split");
  }
  // never smaller than 12 or larger than 32 a column, however short or tall the view
  assert.equal(W.geometry(60).step, 12);
  assert.ok(W.geometry(60).height >= 20 + 7 * 12 - 3, "a short view is overdrawn, never squeezed");
  assert.equal(W.geometry(900).step, 32);
  // the model follows the height it is given
  const model = W.heatmapModel(daysEnding("2026-09-27", 371), 226);
  assert.equal(model.geo.step, 29);
  assert.ok(model.cells.every(c => (c.x - 34) % 29 === 0 && c.y >= model.geo.top));
  assert.match(W.heatmapSvg(model), /width="25" height="25" rx="3"/);
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
test("the line draws each day's total solid and the trailing seven-day average dotted over it", () => {
  const { W } = widgets();
  assert.deepEqual(Array.from(W.rolling([7, 0, 0, 0, 0, 0, 0, 14, 0])), [7, 3.5, 7 / 3, 1.75, 1.4, 7 / 6, 1, 2, 2]);
  assert.equal(W.FETCH_DAYS, 371, "the panel asks for the six days before the year too");
  const days = daysEnding("2026-09-27", 371, k => (k === 200 ? 7e6 : 0));
  const model = W.lineModel(days);
  assert.equal(model.points.length, 365);
  assert.equal(model.points.at(-1).date, "2026-09-27");
  // one day of seven million: the daily line stands at it that day alone, and
  // the average holds a million a day for that day and the six after it
  assert.equal(model.points.filter(p => p.total === 7e6).length, 1);
  const avg = model.points.map(p => p.avg);
  assert.equal(avg.filter(v => v === 1e6).length, 7);
  assert.equal(avg.filter(v => v === 0).length, 358);
  for (let i = 1; i < model.points.length; i++) assert.ok(model.points[i].x > model.points[i - 1].x);
  const { box } = model;
  for (const p of model.points) {
    assert.ok(p.y >= box.top - 0.05 && p.y <= box.top + box.h + 0.05, "the day inside the plot");
    assert.ok(p.ya >= box.top - 0.05 && p.ya <= box.top + box.h + 0.05, "the average inside the plot");
    assert.ok(Math.abs(p.y - model.yAt(p.total)) < 0.1 && Math.abs(p.ya - model.yAt(p.avg)) < 0.1);
  }
  // the axis ends at the next half step past the busiest day, not the busiest week,
  // with lines at whole steps only
  assert.equal(model.top, 8e6);
  assert.deepEqual(Array.from(model.ticks), [0, 2e6, 4e6, 6e6, 8e6]);
  const spike = model.points.find(p => p.total === 7e6);
  assert.ok(spike.y > box.top + 1, "the busiest day stands under the top line");
  // drawn to the view's height and as wide as the heatmap at that height, a
  // week of days as wide as a column
  const svg = W.lineSvg(model);
  const g = W.geometry(W.VIEW_H);
  assert.match(svg, new RegExp(`<svg class="tk-line" width="${g.width}" height="200" viewBox="0 0 ${g.width} 200"`));
  assert.deepEqual({ ...model.box }, { left: 48, right: 14, top: 12, bottom: 26, w: g.width - 62, h: 162 });
  assert.ok(Math.abs(7 * box.w / 364 - g.step) < 0.2, "a week of the line is a column of the heatmap");
  const tall = W.lineModel(days, 226);
  assert.equal(tall.height, 226);
  assert.equal(tall.width, W.geometry(226).width);
  // the months along the bottom at each one's first day, a tick under each,
  // January with its year, every name inside the chart
  assert.ok(model.months.length >= 11);
  assert.ok(model.months.every(m => m.x >= 48 && m.x + 26 <= g.width));
  assert.ok(model.months.some(m => m.label === "Jan 2026"));
  assert.equal((svg.match(/<line class="tk-tick"/g) || []).length, model.months.length);
  // the two lines, in the chart's own red-oranges: the day solid, its average in dots a shade deeper
  const path = /class="tk-path" d="([^"]+)"/.exec(svg)[1];
  assert.equal((path.match(/[ML]/g) || []).length, 365);
  const dotted = /<path class="tk-avg" d="([^"]+)" fill="none" stroke="([^"]+)" stroke-dasharray="([^"]+)"/.exec(svg);
  assert.ok(dotted, "the average is drawn dotted");
  assert.equal((dotted[1].match(/[ML]/g) || []).length, 365);
  assert.equal(dotted[2], W.AVG_LINE);
  assert.ok(svg.includes(`class="tk-path" d="${path}" fill="none" stroke="${W.LINE}"`));
  assert.doesNotMatch(/<path class="tk-path"[^>]*>/.exec(svg)[0], /dasharray/, "the daily line is solid");
  assert.ok(W.PALETTE.includes(W.AVG_LINE));
  for (const c of [W.LINE, W.AVG_LINE]) assert.ok(hsl(c).h >= 8 && hsl(c).h <= 30, `${c} is the same warm family`);
  assert.doesNotMatch(svg, /linearGradient|tk-area/, "no fill under the line");
  // a mark on each line where the pointer is, never smaller than 8px across
  const radius = cls => Number(new RegExp(`<circle class="${cls}" r="([\\d.]+)"`).exec(svg)[1]);
  assert.ok(2 * radius("tk-dot") >= 8 && 2 * radius("tk-dot avg") >= 8);
  assert.match(svg, /<circle class="tk-dot avg"[^>]*fill="#FFFFFF" stroke="#C9401B"/);
  // the count names are drawn apart into the place they held, to stay put while the line scrolls
  const pin = W.linePin(model);
  assert.match(pin, /^<svg width="48" height="200" viewBox="0 0 48 200"/);
  for (const label of ["0", "2M", "4M", "6M", "8M"]) {
    assert.ok(pin.includes(`text-anchor="end">${label}</text>`));
    assert.ok(!svg.includes(`>${label}</text>`), `${label} would scroll away with the line`);
  }
  assert.equal((pin.match(/<text /g) || []).length, 5, "names at whole steps only");
  assert.equal((svg.match(/<line class="tk-(grid|base)"/g) || []).length, 5, "lines at whole steps only");
  const half = W.lineModel(daysEnding("2026-09-27", 371, k => (k === 200 ? 3.06e9 : 0)));
  assert.equal(half.top, 3.5e9);
  assert.equal((W.linePin(half).match(/<text /g) || []).length, 4, "none at the top, which is no whole step");
  assert.equal((W.lineSvg(half).match(/<line class="tk-(grid|base)"/g) || []).length, 4);
  // a year of nothing still draws, flat on the floor
  const flat = W.lineModel(daysEnding("2026-09-27", 371, () => 0));
  assert.ok(flat.points.every(p => p.y === box.top + box.h && p.ya === box.top + box.h));
});

test("the count axis tops at the next half step past the busiest day, with lines at whole steps only", () => {
  const { W } = widgets();
  const axis = max => { const a = W.niceAxis(max); return { top: a.top, step: a.step, ticks: Array.from(a.ticks) }; };
  // the busiest day of 3.06B: lines at 0, 1B, 2B and 3B, the top at 3.5B, none at the half step
  assert.deepEqual(axis(3.06e9), { top: 3.5e9, step: 1e9, ticks: [0, 1e9, 2e9, 3e9] }, "3.06B");
  const cases = [
    [1.35e9, 1.5e9, 5e8, [0, 5e8, 1e9, 1.5e9]],
    [8.7e8, 9e8, 2e8, [0, 2e8, 4e8, 6e8, 8e8]],
    [3.5e9, 4e9, 1e9, [0, 1e9, 2e9, 3e9, 4e9]],
    [4.1e9, 4.5e9, 1e9, [0, 1e9, 2e9, 3e9, 4e9]],
    [1e6, 1.25e6, 5e5, [0, 5e5, 1e6]],
    [1115, 1250, 500, [0, 500, 1000]],
    [3, 3.5, 1, [0, 1, 2, 3]],
    [0, 4, 1, [0, 1, 2, 3, 4]],
  ];
  for (const [max, top, step, ticks] of cases) assert.deepEqual(axis(max), { top, step, ticks }, String(max));
  assert.deepEqual([0, 5e8, 1e9, 1.5e9].map(W.compact), ["0", "500M", "1B", "1.5B"]);
  // over a sweep of maxima: the top is past the busiest day by no more than
  // half a step and sits on a half step, three to five lines from 0, and a
  // step of 1, 2 or 5 times a power of ten
  for (let e = 0; e <= 13; e++) for (const f of [1, 1.01, 1.3, 1.99, 2.01, 2.5, 2.6, 3.01, 3.5, 3.7, 4.4, 5.01, 6.3, 7.9, 9.99]) {
    const max = f * Math.pow(10, e);
    if (max < 4) continue;
    const { top, step, ticks } = axis(max);
    assert.ok(top > max && top - max <= step / 2 * (1 + 1e-9), `${max} tops at ${top}`);
    assert.ok(Math.abs(top / (step / 2) - Math.round(top / (step / 2))) < 1e-9, `${max} top ${top} is on a half step of ${step}`);
    assert.ok(ticks.length >= 3 && ticks.length <= 5, `${max} has ${ticks.length} lines`);
    const lead = step / Math.pow(10, Math.floor(Math.log10(step)));
    assert.ok([1, 2, 5].some(x => Math.abs(lead - x) < 1e-9), `${max} steps by ${step}`);
    assert.ok(ticks.every((t, i) => Math.abs(t - i * step) < step * 1e-9) && ticks.at(-1) <= top);
  }
  // a busiest day right on a half step goes one half step higher
  assert.equal(axis(3.5e9).top, 4e9);
  assert.equal(axis(3e9).top, 3.5e9);
  assert.equal(W.niceTop, undefined, "no fixed top is left behind");
});

// ---- the scrolling view ---------------------------------------------------------------------
test("the view opens a chart on its latest weeks, keeps a place scrolled back to, and fades the sides with more", () => {
  const { W } = widgets();
  const doc = makeDocument();
  const days = daysEnding("2026-09-27", 371);
  const el = new El("div", doc);
  W.drawHeatmap(el, days);
  const width = W.geometry(W.VIEW_H).width, room = width - 540;
  assert.match(el.innerHTML, new RegExp(`^<div class="tk-view"><div class="tk-lane"><div class="tk-scroll"><div class="tk-chart"><svg class="tk-heat" width="${width}"`));
  assert.match(el.innerHTML, /<div class="tk-pin" style="width:34px"><svg width="34"/);
  let view = el.querySelector(".tk-scroll"), lane = el.querySelector(".tk-lane");
  assert.equal(view.scrollWidth, width, "the row at its own width, wider than the 540px view");
  assert.equal(view.scrollLeft, room, "it opens at the right end, on the latest weeks");
  assert.ok(lane.classList.contains("more-left") && !lane.classList.contains("more-right"), "more only to the left");

  // a place of its own, followed as the reader scrolls
  const spot = { end: true, left: 0 };
  W.drawHeatmap(el, days, spot);
  assert.equal(el.querySelector(".tk-scroll").scrollLeft, room);
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
  scrollTo(el.querySelector(".tk-scroll"), room);
  assert.equal(spot.end, true);
  el.viewWidth = 400;
  W.drawHeatmap(el, days, spot);
  assert.equal(el.querySelector(".tk-scroll").scrollLeft, width - 400);
  // a panel as wide as the chart has nothing to scroll and nothing to fade
  el.viewWidth = 1400;
  W.drawLine(el, days, { end: true, left: 0 });
  view = el.querySelector(".tk-scroll"); lane = el.querySelector(".tk-lane");
  assert.equal(view.scrollLeft, 0);
  assert.ok(!lane.classList.contains("more-left") && !lane.classList.contains("more-right"));
  // the line's view is the same, its count names pinned in their own 48px
  assert.match(el.innerHTML, new RegExp(`<svg class="tk-line" width="${width}"`));
  assert.match(el.innerHTML, /<div class="tk-pin" style="width:48px"><svg width="48"/);
});

// a wheel or pointer event as the browser gives one, with what the handler did to it
function wheelAt(target, deltaY, deltaX = 0, deltaMode = 0) {
  const e = { type: "wheel", target, deltaY, deltaX, deltaMode, prevented: false };
  e.preventDefault = () => { e.prevented = true; };
  return e;
}
const fire = (el, type, e) => { for (const fn of el.listeners[type] || []) fn(e); return e; };

test("the wheel moves a chart sideways anywhere over it, and the mouse can drag it", () => {
  const { W } = widgets();
  const doc = makeDocument();
  const el = new El("div", doc);
  W.drawHeatmap(el, daysEnding("2026-09-27", 371));
  const view = el.querySelector(".tk-scroll"), lane = el.querySelector(".tk-lane");
  const room = view.scrollWidth - view.clientWidth;
  scrollTo(view, 300);
  // the wheel, or a two-finger swipe up or down: down for later days, taken
  // from the page while the chart moves
  let e = fire(el, "wheel", wheelAt(view, 120));
  assert.equal(view.scrollLeft, 420);
  assert.equal(e.prevented, true);
  fire(el, "wheel", wheelAt(view, -200));
  assert.equal(view.scrollLeft, 220);
  // a mouse that counts in lines moves a line's worth each
  fire(el, "wheel", wheelAt(view, 3, 0, 1));
  assert.equal(view.scrollLeft, 268);
  // a sideways swipe is the browser's own scroll, left alone
  e = fire(el, "wheel", wheelAt(view, 4, -60));
  assert.equal(view.scrollLeft, 268);
  assert.equal(e.prevented, false);
  // past the end nothing moves, and the page may have the wheel
  scrollTo(view, room);
  e = fire(el, "wheel", wheelAt(view, 80));
  assert.equal(view.scrollLeft, room);
  assert.equal(e.prevented, false);
  // a wheel outside the chart, as over the foot, is not the chart's
  e = fire(el, "wheel", wheelAt(new El("div", doc), -80));
  assert.equal(view.scrollLeft, room);
  assert.equal(e.prevented, false);

  // the mouse takes hold and drags: nothing moves until it has gone 4px, then
  // the chart follows it, marked as held, and lets go when the button comes up
  scrollTo(view, 300);
  const at = (type, x, extra = {}) => fire(el, type, { type, target: view, pointerId: 7, pointerType: "mouse",
    button: 0, buttons: 1, clientX: x, ...extra });
  at("pointerdown", 500);
  at("pointermove", 498);
  assert.equal(view.scrollLeft, 300, "a nudge is not a drag");
  at("pointermove", 440);
  assert.equal(view.scrollLeft, 360, "dragged left, it shows later days");
  assert.ok(lane.classList.contains("dragging"));
  at("pointermove", 560);
  assert.equal(view.scrollLeft, 240);
  at("pointerup", 560, { buttons: 0 });
  assert.ok(!lane.classList.contains("dragging"));
  at("pointermove", 300, { buttons: 0 });
  assert.equal(view.scrollLeft, 240, "let go, it stays");
  // a finger scrolls the browser's own way, and the right button never drags
  at("pointerdown", 500, { pointerType: "touch" });
  at("pointermove", 400, { pointerType: "touch" });
  at("pointerdown", 500, { button: 2, buttons: 2 });
  at("pointermove", 400, { buttons: 2 });
  assert.equal(view.scrollLeft, 240);
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
  const room = W.geometry(W.VIEW_H).width - 540;
  await p.refresh();
  assert.equal(view().scrollLeft, room, "the heatmap opens on its latest weeks");
  scrollTo(view(), 100);
  line.click();
  assert.match(stage.innerHTML, /class="tk-line"/);
  assert.equal(view().scrollLeft, room, "the line opens on its own latest weeks, not where the heatmap was");
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
  assert.equal(walk(again).find(n => n.className === "tk-stage").querySelector(".tk-scroll").scrollLeft, room);
});

test("the box stands in the top right quarter, the charts fill it and scroll natively with no bar", () => {
  const { W } = widgets();
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => {
    const m = new RegExp("(?:^|\\})\\s*" + sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}").exec(css);
    assert.ok(m, `no rule for ${sel}`);
    return m[1];
  };
  // never stretched to the panel: each svg keeps the width and height it is drawn with
  assert.doesNotMatch(rule(".tk-chart svg"), /width|height/);
  assert.match(rule(".tk-chart"), /width:max-content/);
  // sideways scrolling the browser's own way, kept inside the lane, which is
  // the view's whole height so the pointer anywhere over a chart reaches it
  const scroll = rule(".tk-scroll");
  assert.match(scroll, /height:100%/);
  assert.match(scroll, /overflow-x:auto/);
  assert.match(scroll, /overflow-y:hidden/);
  assert.match(scroll, /overscroll-behavior-x:contain/);
  assert.match(rule(".tk-lane"), /height:100%/);
  assert.doesNotMatch(rule(".tk-view"), /align-items|overflow/, "no band around the chart and no clip over the pinned names");
  // no bar, the board's rule for every scroller, and no smooth scrolling;
  // the only thing that moves on its own is the pill's seat
  assert.match(read("card-tokens.css"), /\*\{scrollbar-width:none\}\n\*::-webkit-scrollbar\{display:none\}/);
  assert.doesNotMatch(css, /scrollbar|\bscroll-behavior/);
  assert.equal([...css.matchAll(/transition:[^;}]*(opacity|left|transform)/g)].length, 1);
  assert.match(rule(".tk-thumb"), /transition:transform \.28s var\(--gentle\)/);
  assert.doesNotMatch(WIDGETS, /smooth|scrollTo\(|scrollBy\(|requestAnimationFrame/);
  // held and dragged with the mouse, the chart's names never picked up as text
  assert.match(css, /\.tk-lane\.more-left \.tk-scroll, \.tk-lane\.more-right \.tk-scroll\{cursor:grab\}/);
  assert.match(rule(".tk-lane.dragging .tk-scroll"), /cursor:grabbing/);
  assert.match(rule(".tk-chart"), /user-select:none/);
  // a soft fade on each side with more, and the pinned names let the pointer through
  assert.match(css, /\.tk-lane\.more-left \.tk-pin::after, \.tk-lane\.more-right::after\{opacity:1\}/);
  assert.match(rule(".tk-pin"), /background:var\(--card\); pointer-events:none/);
  // the box: 35% of the page's frame (the rectangle under the bar, inset
  // --app-inset each side) wide and tall, centred on the right half's vertical
  // line. it is one of two boxes in #homepair, a column the height of the frame
  // that centres them in it (the pair is held in limits-home.test.cjs); the panel fills it
  const pair = /body\.focus\.home #homepair\{([^}]*)\}/.exec(HTML)[1];
  assert.match(pair, /--home-l:var\(--app-inset\); --home-r:calc\(100vw - var\(--app-inset\)\);/);
  assert.match(pair, /--home-t:calc\(var\(--app-inset\) \+ var\(--bar-h\) - 1px - var\(--edge-drawn\)\);/);
  assert.match(pair, /--home-b:calc\(100vh - var\(--app-inset\)\);/);
  assert.match(pair, /--home-w:calc\(\(var\(--home-r\) - var\(--home-l\)\) \* \.35\);/);
  assert.match(pair, /left:calc\(var\(--home-l\) \* \.25 \+ var\(--home-r\) \* \.75 - var\(--home-w\) \/ 2\);/);
  assert.match(pair, /width:var\(--home-w\);/);
  const home = /body\.focus\.home #home\{([^}]*)\}/.exec(HTML)[1];
  assert.match(home, /flex:0 1 calc\(\(var\(--home-b\) - var\(--home-t\)\) \* \.35\);/);
  assert.match(home, /min-height:0/);
  assert.doesNotMatch(home, /position|transform|left|top/, "the pair places it");
  // the frame the quarter is taken from is the one the page draws
  const frame = /body\.focus #appframe\{([^}]*)\}/.exec(HTML.replace(/\/\*[\s\S]*?\*\//g, ""))[1];
  assert.match(frame, /top:calc\(var\(--app-inset\) \+ var\(--bar-h\) - 1px - var\(--edge-drawn\)\);/);
  assert.match(frame, /left:var\(--app-inset\); right:var\(--app-inset\); bottom:var\(--app-inset\);/);
  assert.match(HTML, /body\.focus\.home #homeplot\{height:100%\}/);
  // the panel is a column that fills a box with a height of its own, the view
  // taking what the heading and foot leave; elsewhere the view is 200 tall
  const panelRule = rule(".tk-panel");
  assert.match(panelRule, /--tk-view-h:200px/);
  assert.match(panelRule, /box-sizing:border-box; height:100%; display:flex; flex-direction:column/);
  assert.match(panelRule, /padding:16px 20px 14px/);
  // where a mouse or trackpad hovers the chrome around the view is cut down so
  // the view takes more of the box; a phone, which does not hover, keeps the
  // roomier sizes above
  const board = /@media \(hover: hover\) and \(pointer: fine\)\{([^@]*?)\n\}/.exec(css);
  assert.ok(board, "a rule for pointers that hover");
  assert.match(board[1], /\.tk-panel\{padding:10px 14px 9px\}/);
  assert.match(board[1], /\.tk-head\{margin-bottom:6px\}/);
  assert.match(board[1], /\.tk-opt\{padding:2px 10px\}/);
  assert.match(board[1], /\.tk-foot\{margin-top:6px\}/);
  assert.match(rule(".tk-head"), /margin-bottom:14px/);
  assert.match(rule(".tk-opt"), /padding:3px 11px/);
  assert.match(rule(".tk-stage"), /flex:1 1 auto; min-height:0; display:flex; flex-direction:column/);
  assert.match(rule(".tk-view"), /flex:1 1 var\(--tk-view-h\); height:var\(--tk-view-h\); min-height:0/);
  assert.match(rule(".tk-head"), /^flex:none/);
  assert.match(rule(".tk-foot"), /^flex:none/);
  // neither the words nor the legend ever break; with no room for both across,
  // the legend drops to its own row at the right
  assert.match(rule(".tk-foot"), /flex-wrap:wrap/);
  assert.match(rule(".tk-sum"), /white-space:nowrap/);
  assert.match(rule(".tk-legend"), /margin-left:auto; white-space:nowrap/);
  assert.equal(W.VIEW_H, 200, "the widgets draw at the sheet's own view height until a view is measured");
  // both charts' names at the panel's 12px; the day's line solid, its average dotted
  assert.match(rule(".tk-axis"), /font:400 12px var\(--sans\)/);
  assert.match(rule(".tk-path"), /stroke-width:1\.75px/);
  assert.match(rule(".tk-avg"), /stroke-linecap:round/);
  assert.match(rule(".tk-grid"), /stroke:#EFEBE5/);
  // the wait holds the view's height and the foot's, so the box never moves
  assert.match(rule(".tk-wait"), /flex:1 1 auto;/);
  assert.match(rule(".tk-wait"), /height:calc\(var\(--tk-view-h\) \+ 26px\)/);
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

test("the line's tip names the day, its total and its 7-day average, and nothing on the line passes its axis", () => {
  const { W } = widgets();
  // Monday, Sep 21 alone was 1.35B, and its week averaged 616M a day
  const days = daysEnding("2026-09-27", 371,
    k => (k >= 358 && k <= 363 ? 493_666_667 : k === 364 ? 1.35e9 : 0));
  const model = W.lineModel(days);
  assert.equal(model.top, 1.5e9, "the axis ends at the next round tick past the busiest day, 1.35B");
  assert.match(W.linePin(model), />1\.5B<\/text>/);
  const p = model.points.find(x => x.date === "2026-09-21");
  const tip = W.lineTip(p);
  assert.match(tip, /^<b>Mon, Sep 21, 2026<\/b>/);
  const rows = [...tip.matchAll(/<span class="tk-row"><svg class="tk-key"[^>]*>.*?<\/svg>([^<]+)<em>([^<]+)<\/em><\/span>/g)]
    .map(m => [m[1], m[2]]);
  assert.deepEqual(rows, [["Daily", "1.35B"], ["7-day average", "616M"]]);
  // each row's stroke is its line's: the day solid, the average dotted
  assert.match(tip, new RegExp(`Daily.*stroke="${W.AVG_LINE}"[^>]*stroke-dasharray="${W.AVG_DASH}".*7-day average`));
  assert.ok(Math.abs(p.y - model.yAt(p.total)) < 0.1 && Math.abs(p.ya - model.yAt(p.avg)) < 0.1,
            "the two dots stand at the tip's two numbers");
  // every day of the year: both numbers in the tip, both marks inside the axis
  for (const q of model.points) {
    const t = W.lineTip(q);
    assert.ok(t.includes(`Daily<em>${W.compact(q.total)}</em>`) && t.includes(`7-day average<em>${W.compact(q.avg)}</em>`));
    assert.ok(q.total <= model.top && q.avg <= model.top, `${q.date} stands above the axis`);
    assert.equal(q.span, 7, "every day of the year averages a whole week");
  }
  // where a reading begins, the average says how few days it holds
  const short = W.lineModel(daysEnding("2026-09-27", 3, () => 3e6));
  assert.match(W.lineTip(short.points[0]), /^<b>Fri, Sep 25, 2026<\/b>.*Daily<em>3M<\/em>.*1-day average<em>3M<\/em>/);
  assert.match(W.lineTip(short.points[2]), /3-day average<em>3M<\/em>/);
  // the legend under the line names both, beside the same strokes, and the
  // words on its left name the tools whose tokens the days hold
  const doc = makeDocument();
  const footOf = set => {
    const el = new El("div", doc);
    W.drawLine(el, set);
    return /<div class="tk-foot">(.*?)<\/div>/.exec(el.innerHTML)[1];
  };
  const text = html => html.replace(/<[^>]+>/g, "");
  const split = (claude, codex) => days.map(d => ({ ...d, claude: d.total * claude, codex: d.total * codex }));
  const foot = footOf(split(1, 0));
  assert.match(foot, /^<span class="tk-sum">Includes data from Claude<\/span><span class="tk-legend"><svg class="tk-key"/);
  assert.equal(text(foot), "Includes data from ClaudeDaily7-day average");
  assert.equal(text(footOf(split(0, 1))), "Includes data from CodexDaily7-day average");
  assert.equal(text(footOf(split(0.5, 0.5))), "Includes data from Claude &amp; CodexDaily7-day average");
  assert.match(footOf(split(0, 0)), /^<span class="tk-sum"><\/span><span class="tk-legend"><svg class="tk-key"/,
               "with no tokens from either, nothing stands on the left and the legend stays");
  assert.doesNotMatch(foot, /Tokens per day/);
});

test("the foot names Claude, Codex or both, by whose tokens the year holds", () => {
  const { W } = widgets();
  const days = daysEnding("2026-09-27", 371, () => 1000);
  const set = (from, claude, codex) => days.map((d, k) => (k >= from ? { ...d, claude, codex } : { ...d, claude: 0, codex: 0 }));
  assert.deepEqual(Array.from(W.sources(set(0, 1000, 0))), ["Claude"]);
  assert.deepEqual(Array.from(W.sources(set(0, 0, 1000))), ["Codex"]);
  assert.deepEqual(Array.from(W.sources(set(0, 600, 400))), ["Claude", "Codex"]);
  assert.deepEqual(Array.from(W.sources(set(0, 0, 0))), []);
  // one day in the year is enough to name a tool, and the six days fetched
  // ahead of the year for the average are not
  assert.deepEqual(Array.from(W.sources(set(370, 1000, 1000))), ["Claude", "Codex"]);
  assert.deepEqual(Array.from(W.sources(set(6, 1000, 1000))), ["Claude", "Codex"]);
  const early = days.map((d, k) => ({ ...d, claude: 1000, codex: k < 6 ? 1000 : 0 }));
  assert.deepEqual(Array.from(W.sources(early)), ["Claude"], "a tool seen only before the year is not named");
  // a route that does not say which tool a day came from names neither
  assert.deepEqual(Array.from(W.sources(days.map(({ date, total }) => ({ date, total })))), []);
  assert.equal(W.sourceLine([]), "");
  assert.equal(W.sourceLine(["Claude"]), "Includes data from Claude");
  assert.equal(W.sourceLine(["Codex"]), "Includes data from Codex");
  assert.equal(W.sourceLine(["Claude", "Codex"]), "Includes data from Claude & Codex");
});

test("the panel's heading reads Token consumption per day, with no line under it", () => {
  const { W } = widgets();
  const doc = makeDocument();
  const root = new El("div", doc);
  W.panel(root, { load: async () => ({ days: daysEnding("2026-09-27", 371), found: { claude: true, codex: false } }), store: null });
  const nodes = walk(root);
  const title = nodes.find(n => n.className === "tk-title");
  assert.deepEqual(title.children.map(n => [n.className, n.textContent]), [["tk-name", "Token consumption per day"]]);
  assert.equal(title.textContent, "Token consumption per day");
  assert.ok(!nodes.some(n => n.className === "tk-what"), "no subtitle");
  assert.doesNotMatch(root.textContent, /Claude Code and Codex on this machine/);
});

test("the panel's line foot follows the tools the route's days carry", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const footText = async mix => {
    const days = daysEnding("2026-09-27", 371).map(d => ({ ...d, claude: d.total && mix.claude, codex: d.total && mix.codex }));
    const root = new El("div", doc);
    const p = W.panel(root, { load: async () => ({ days, found: { claude: true, codex: true } }), store: makeStore({ "home.chart": "line" }) });
    await p.refresh();
    const stage = walk(root).find(n => n.className === "tk-stage");
    return /<span class="tk-sum">(.*?)<\/span>/.exec(stage.innerHTML)[1];
  };
  assert.equal(await footText({ claude: 5, codex: 0 }), "Includes data from Claude");
  assert.equal(await footText({ claude: 0, codex: 5 }), "Includes data from Codex");
  assert.equal(await footText({ claude: 5, codex: 5 }), "Includes data from Claude &amp; Codex");
  assert.equal(await footText({ claude: 0, codex: 0 }), "");
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
  // a seat first, under the two names, which slides to the one showing
  const [thumb, ...opts] = pills[0].children;
  assert.deepEqual([thumb.tagName, thumb.className, thumb.textContent], ["SPAN", "tk-thumb", ""]);
  assert.deepEqual(opts.map(b => [b.tagName, b.type, b.dataset.view, b.textContent]),
                   [["BUTTON", "button", "heatmap", "Heatmap"], ["BUTTON", "button", "line", "Line"]]);
  assert.equal(pills[0].dataset.on, "heatmap");
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
  assert.equal(pills[0].dataset.on, "line", "the seat is sent to the line");
  // the seat is the pill's white; the names sit over it, one width each, and
  // it slides one name's width and the gap between them on the board's curve,
  // with no slide where motion is reduced
  const sheet = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(sheet, /\.tk-pill\{[^}]*position:relative; display:inline-grid; grid-template-columns:1fr 1fr;[^}]*gap:2px; padding:2px;/);
  assert.match(sheet, /\.tk-thumb\{position:absolute; top:2px; bottom:2px; left:2px; width:calc\(\(100% - 6px\) \/ 2\);[^}]*background:var\(--card\);/);
  assert.match(sheet, /\.tk-pill\[data-on="line"\] \.tk-thumb\{transform:translateX\(calc\(100% \+ 2px\)\)\}/);
  assert.match(sheet, /@media \(prefers-reduced-motion: reduce\)\{ \.tk-thumb\{transition:none\} \}/);
  assert.match(sheet, /\.tk-opt\{position:relative; z-index:1;[^}]*background:transparent;/);
  assert.match(sheet, /\.tk-opt\.on\{color:var\(--ink\)\}/, "the name shown has no fill of its own; the seat is under it");
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
  // the chart picked is one of the board's settings (board-settings.js);
  // whether home is open stays in the window's own storage
  const settings = makeStore({});
  const fetched = [], tabs = [], timers = new Map();
  let nextTimer = 0;
  const ctx = {
    console, document: doc, localStorage: store, settingsStore: settings, FOCUS: true, editMode: false, lastState: { rev: 1 },
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
