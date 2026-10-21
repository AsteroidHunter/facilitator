// the home page and its token widgets, with no browser. home-widgets.js is run
// in a sandbox and held to what it draws: one square per day from January 1 in
// week columns of 7, a red-orange scale light to deep over a faint warm grey,
// a light column for each day's total under a curved line of trailing 7-day
// averages on a count axis that ends at the next round tick past the busiest
// day, both drawn to the view's height in a lane that scrolls sideways by
// swipe, wheel or drag and opens on the latest weeks, and one pill whose seat
// slides between the two; the pictures the download saves and the dice rolls
// through, their file names, and the overlay that shows them. then
// index.html's own home block is lifted out of the page
// and driven through a small DOM: the house opens home, the widgets are
// ready before Home opens, the panel asks the route for its days, and every project
// tab leaves it. every count below is invented; nothing renders a pixel
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
// the sheet draws each length in --u, which the board leaves at 1px, so on the board
// calc(N * var(--u, 1px)) is N px: the tests read the sheet's lengths as plain px
const plainPx = css => css.replace(/calc\(([\d.]+) \* var\(--u, 1px\)\)/g, "$1px")
  .replace(/([\d.]+) \* var\(--u, 1px\)/g, "$1px");
const read = name => {
  const text = fs.readFileSync(path.join(ROOT, name), "utf8");
  return name === "home-widgets.css" ? plainPx(text) : text;
};
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
  get firstChild() { return this.children[0] || null; }
  insertBefore(c, ref) {
    c.parentElement = this;
    const at = this.children.indexOf(ref);
    if (at < 0) this.children.push(c); else this.children.splice(at, 0, c);
    return c;
  }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
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
const activeLayer = root => walk(root).find(n => n.classList.contains("tk-layer") && n.classList.contains("on"));
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
test("the heatmap draws one square per day from January 1, in week columns of 7", () => {
  const { W } = widgets();
  // every weekday the year can end on
  for (let back = 0; back < 7; back++) {
    const last = new Date(Date.parse("2026-09-27T00:00:00Z") - back * 864e5).toISOString().slice(0, 10);
    const days = daysEnding(last, W.FETCH_DAYS);
    const model = W.heatmapModel(days);
    const sinceJan = days.filter(d => d.date >= "2026-01-01").length;
    assert.equal(model.cells.length, sinceJan, "January 1 to today, not a rolling year");
    assert.equal(model.cells[0].date, "2026-01-01", "the first square is January 1");
    assert.equal(model.cells.at(-1).date, last, "the last square is today");
    // January 1, 2026 is a Thursday: its week is the first column
    const weeks = Math.floor((4 + sinceJan - 1) / 7) + 1;
    assert.equal(model.weeks, weeks);
    assert.equal(W.yearWeeks(days), weeks);
    assert.equal(new Set(model.cells.map(c => c.col)).size, weeks);
    assert.equal(Math.min(...model.cells.map(c => c.col)), 0);
    assert.equal(Math.max(...model.cells.map(c => c.col)), weeks - 1);
    model.cells.forEach((c, i) => {
      assert.equal(c.row, weekday(c.date), `${c.date} sits in its weekday's row, Sunday on top`);
      if (i) {
        const p = model.cells[i - 1];
        assert.equal(c.col, p.row === 6 ? p.col + 1 : p.col, "a new column starts on Sunday");
      }
    });
    assert.equal(model.total, days.filter(d => d.date >= "2026-01-01").reduce((s, d) => s + d.total, 0),
                 "this year's total, leaving out the days fetched before it");
    // month names over their columns, January first, never crowded or off the grid
    assert.deepEqual([model.months[0].label, model.months[0].col], ["Jan", 0]);
    assert.ok(model.months.length >= 8);
    for (let i = 1; i < model.months.length; i++)
      assert.ok(model.months[i].col - model.months[i - 1].col >= 3, "month names stand apart");
    assert.ok(model.months.every(m => m.col >= 0 && m.col <= weeks - 2));
    const svg = W.heatmapSvg(model);
    assert.equal((svg.match(/<rect class="tk-day"/g) || []).length, sinceJan);
    assert.match(svg, /aria-label="[^"]+ tokens this year, one square per day"/);
    // drawn at the default view height when no view gives it one: 200 tall,
    // a 25px week column, 21px squares with 4px between, never stretched
    const width = 34 + weeks * 25 - 4;
    assert.match(svg, new RegExp(`<svg class="tk-heat" width="${width}" height="200" viewBox="0 0 ${width} 200"`));
    assert.equal((svg.match(/width="21" height="21" rx="3"/g) || []).length, sinceJan);
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

test("the heatmap's squares grow with the view's height, never under 12, and fill it", () => {
  const { W } = widgets();
  assert.equal(W.VIEW_H, 200);
  // the board's two window sizes (1512 x 982 and 1280 x 800) and the phone's
  // view: seven rows and the month names fill the height, with at most a few
  // pixels over, split above and below
  // and a 2560 x 1440 window's view, taller than any of those
  for (const [h, step, cell] of [[251, 32, 28], [187, 23, 19], [226, 29, 25], [156, 19, 16], [200, 25, 21],
                                 [391, 52, 48]]) {
    const g = W.geometry(h);
    assert.equal(g.step, step, `step at ${h}`);
    assert.equal(g.cell, cell, `square at ${h}`);
    assert.equal(g.height, h, "as tall as the view");
    assert.equal(g.width, 34 + 53 * step - g.gap, "a whole year's weeks unless told fewer");
    assert.equal(W.geometry(h, 40).width, 34 + 40 * step - g.gap);
    const bottom = g.top + g.rows;
    // under a column's width and its gap over, less than 7 + 2 + 4
    assert.ok(g.top - 20 >= 0 && h - bottom >= 0 && (g.top - 20) + (h - bottom) <= 12, `${h} leaves little over`);
    assert.ok(Math.abs((g.top - 20) - (h - bottom)) <= 3, "what is over is split");
  }
  // never smaller than 12 a column, however short the view, and no ceiling
  assert.equal(W.geometry(60).step, 12);
  assert.ok(W.geometry(60).height >= 20 + 7 * 12 - 3, "a short view is overdrawn, never squeezed");
  assert.equal(W.geometry(900).step, 125);
  assert.equal(W.MAX_STEP, undefined);
  // the model follows the height it is given
  const model = W.heatmapModel(daysEnding("2026-09-27", 371), 226);
  assert.equal(model.geo.step, 29);
  assert.ok(model.cells.every(c => (c.x - 34) % 29 === 0 && c.y >= model.geo.top));
  assert.match(W.heatmapSvg(model), /width="25" height="25" rx="3"/);
});

test("the colour scale runs light to deep red-orange, and a day with nothing is a faint warm grey", () => {
  const { W } = widgets();
  assert.equal(W.PALETTE.length, 7);
  const [empty, ...warm] = W.PALETTE.map(hsl);
  assert.ok(empty.s < 0.25 && empty.l > 0.85, "the empty square is a faint grey");
  const [r, g, b] = [1, 3, 5].map(i => parseInt(W.PALETTE[0].slice(i, i + 2), 16));
  assert.ok(r >= g && g >= b && r > b, "and a warm one");
  for (const c of warm) {
    assert.ok(c.h >= 8 && c.h <= 30, `hue ${c.h} is red-orange`);
    assert.ok(c.s > 0.6, "and saturated");
  }
  for (let i = 1; i < warm.length; i++) assert.ok(warm[i].l < warm[i - 1].l, "each step is deeper");
  // the four first tints are kept, the deepest last, and the added shades are faint
  assert.equal(W.PALETTE.at(-1), "#C9401B", "the busiest days are the old deepest red");
  assert.deepEqual([...W.PALETTE].filter(c => ["#FCD8C2", "#F7A67C", "#EC6B3C", "#C9401B"].includes(c)),
                   ["#FCD8C2", "#F7A67C", "#EC6B3C", "#C9401B"]);
  assert.ok(warm.every(c => c.l >= hsl("#C9401B").l), "nothing is deeper than it");

  // a log scale over the active days: nothing is level 0, the busiest is the
  // deepest, a busier day is never lighter, and days spread evenly over the
  // powers of ten share the six steps evenly
  const values = [0, 0, ...Array.from({ length: 150 }, (_, i) => 10 ** (4 + i * 0.03))];
  const sc = W.scale(values);
  assert.equal(sc.level(0), 0);
  assert.equal(sc.colour(0), W.PALETTE[0]);
  assert.equal(sc.level(values.at(-1)), 6);
  assert.equal(sc.level(1e4), 1);
  const levels = values.map(sc.level);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1]);
  for (const step of [1, 2, 3, 4, 5, 6]) {
    const n = levels.filter(l => l === step).length;
    assert.ok(n >= 24 && n <= 26, `step ${step} holds ${n} days`);
  }
  // a year from 126K to 3.06B a day: 500M and 3B are two shades, and no two
  // days six times apart share one
  const year = Array.from({ length: 184 }, (_, i) => 10 ** (5.1 + i * 4.386 / 183));
  const wide = W.scale(year);
  assert.ok(wide.level(500e6) < wide.level(3e9), "500M is lighter than 3B");
  for (const a of year) for (const b of year)
    if (b >= 6 * a) assert.notEqual(wide.level(a), wide.level(b), `${a} and ${b}`);
  // a step is never wider than a factor of 10^0.75, the quietest days going to the lightest
  const deep = W.scale([10, 1e3, 1e9]);
  assert.deepEqual([...deep.cuts].map(c => Math.round(Math.log10(c) * 100) / 100), [5.25, 6, 6.75, 7.5, 8.25]);
  assert.equal(deep.level(10), 1);
  assert.equal(deep.level(1e3), 1);
  // one enormous day does not wash every other day out to the lightest step
  const spike = W.scale([...Array.from({ length: 40 }, (_, i) => (i + 1) * 1e6), 5e12]);
  assert.equal(spike.level(40e6), 5);
  assert.equal(spike.level(5e12), 6);
  assert.equal(new Set(Array.from({ length: 40 }, (_, i) => spike.level((i + 1) * 1e6))).size, 5);
  assert.equal(W.scale([0, 7]).level(7), 6, "a single active day is the deepest");
  assert.equal(W.scale([7, 7, 7]).level(7), 6, "days all alike are the deepest");
  // what the squares are painted with is the palette and nothing else
  const model = W.heatmapModel(daysEnding("2026-09-27", 371));
  const fills = new Set([...W.heatmapSvg(model).matchAll(/class="tk-day"[^>]*fill="([^"]+)"/g)].map(m => m[1]));
  assert.deepEqual([...fills].sort(), [...W.PALETTE].sort());
  for (const c of model.cells) if (!c.total) assert.equal(c.fill, W.PALETTE[0]);
});

// ---- the line -----------------------------------------------------------------------------
test("the line draws a light column for each day under a curved 7-day line, in the picture's Editorial look", () => {
  const { W } = widgets();
  assert.deepEqual(Array.from(W.rolling([7, 0, 0, 0, 0, 0, 0, 14, 0])), [7, 3.5, 7 / 3, 1.75, 1.4, 7 / 6, 1, 2, 2]);
  assert.equal(W.FETCH_DAYS, 371, "the panel asks for the six days before the year too");
  // a year growing from ten thousand a day to a few million, one day of seven
  // million, and ten days with none in March
  const days = daysEnding("2026-09-27", 371, k => (k === 300 ? 7e6 : k >= 160 && k < 170 ? 0 : Math.round(1e4 * 10 ** ((k - 101) / 100))));
  const model = W.lineModel(days);
  assert.equal(model.points.length, 270, "January 1 to September 27, not 365 days");
  assert.equal(model.points[0].date, "2026-01-01");
  assert.equal(model.points.at(-1).date, "2026-09-27");
  for (let i = 1; i < model.points.length; i++) assert.ok(model.points[i].x > model.points[i - 1].x);
  const { box } = model;
  for (const p of model.points) {
    assert.ok(p.y >= box.top - 0.05 && p.y <= box.top + box.h + 0.05, "the day inside the plot");
    assert.ok(p.ya >= box.top - 0.05 && p.ya <= box.top + box.h + 0.05, "the average inside the plot");
  }
  // ten days with none are a gap: no average in it, the line in two runs
  assert.equal(W.GAP_DAYS, 7);
  assert.equal(model.points.filter(p => p.gap).length, 10);
  assert.equal(model.runs.length, 2);
  assert.ok(model.points.filter(p => p.gap).every(p => p.avg === 0 && p.span === 0));
  // the day after the gap averages only itself, the days in the gap left out
  const after = model.points.find((p, i) => i && model.points[i - 1].gap && !p.gap);
  assert.deepEqual([after.avg, after.span, after.from], [after.total, 1, after.date]);
  // the axis ends at the next half step past the busiest day, with lines at whole steps only
  assert.equal(model.top, 8e6);
  assert.deepEqual(Array.from(model.ticks), [0, 2e6, 4e6, 6e6, 8e6]);
  // drawn to the view's height and as wide as the heatmap of the same days
  const svg = W.lineSvg(model);
  const g = W.geometry(W.VIEW_H, W.yearWeeks(days));
  assert.equal(model.width, W.heatmapModel(days).geo.width);
  assert.match(svg, new RegExp(`<svg class="tk-line" width="${g.width}" height="200" viewBox="0 0 ${g.width} 200"`));
  assert.deepEqual({ ...model.box }, { left: 48, right: 14, top: 12, bottom: 26, w: g.width - 62, h: 162 });
  assert.equal(W.lineModel(days, 226).height, 226);
  // the months along the bottom at each one's first day, a tick under each,
  // January with its year, every name inside the chart
  assert.equal(model.months.length, 9, "January to September, the months of the year so far");
  assert.ok(model.months.every(m => m.x >= 48 && m.x + 26 <= g.width));
  assert.ok(model.months.some(m => m.label === "Jan 2026"));
  assert.equal((svg.match(/<line class="tk-tick"/g) || []).length, model.months.length);
  // the columns: one for each day with use, outside the gap, in the light
  // shade at the Editorial strength, a little narrower than a day's step
  const cols = /<path class="tk-cols" d="([^"]+)" fill="([^"]+)" fill-opacity="([^"]+)"\/>/.exec(svg);
  assert.ok(cols, "the days are columns");
  assert.equal((cols[1].match(/Z/g) || []).length, 260);
  assert.equal(cols[2], W.PALETTE[4], "the mock's Editorial columns, #F7A67C");
  assert.equal(Number(cols[3]), 0.62);
  assert.equal(model.calm, 0, "a year that grows is not crowded");
  // the 7-day line: curved, deep, over a ring of the ground's colour, one
  // piece for each run between gaps; nothing dotted is left
  const avg = /<path class="tk-avg" d="([^"]+)" fill="none" stroke="([^"]+)" stroke-width="([^"]+)"\/>/.exec(svg);
  assert.ok(avg, "the average is drawn");
  assert.equal(avg[2], W.AVG_LINE);
  assert.equal(W.AVG_LINE, "#C9401B");
  assert.equal((avg[1].match(/M/g) || []).length, 2, "two runs");
  assert.ok((avg[1].match(/C/g) || []).length > 200, "a curve through the days");
  assert.ok(svg.includes(`<path class="tk-ring" d="${avg[1]}" fill="none" stroke-width="${Number(avg[3]) + 3}"/>`));
  assert.ok(svg.indexOf("tk-cols") < svg.indexOf("tk-ring") && svg.indexOf("tk-ring") < svg.indexOf("tk-avg"), "the line over the columns");
  assert.doesNotMatch(svg, /tk-path|dasharray|stroke-opacity/, "the dotted daily line is gone");
  assert.equal(W.DAILY_DASH, undefined);
  assert.equal(W.DAILY_ALPHA, undefined);
  // a mark on the column and on the line where the pointer is, never smaller than 8px across
  const radius = cls => Number(new RegExp(`<circle class="${cls}" r="([\\d.]+)"`).exec(svg)[1]);
  assert.ok(2 * radius("tk-dot") >= 8 && 2 * radius("tk-dot avg") >= 8);
  assert.match(svg, /<circle class="tk-dot avg"[^>]*fill="#FFFFFF" stroke="#C9401B"/);
  // the count names sit on their gridlines at the left, drawn apart with the
  // gridlines' start into the place they held, to stay put while the line
  // scrolls; the floor is not named
  const pin = W.linePin(model);
  assert.match(pin, /^<svg width="48" height="200" viewBox="0 0 48 200"/);
  for (const t of [2e6, 4e6, 6e6, 8e6]) {
    const y = Math.round(model.yAt(t) * 10) / 10, label = W.compact(t);
    assert.ok(pin.includes(`<line class="tk-grid" x1="0" x2="48" y1="${y}" y2="${y}"/>`), `${label}'s gridline`);
    assert.ok(pin.includes(`<text class="tk-axis" x="0" y="${Math.round((y - 5) * 10) / 10}">${label}</text>`), `${label} on its line`);
    assert.ok(!svg.includes(`>${label}</text>`), `${label} would scroll away with the line`);
  }
  assert.equal((pin.match(/<text /g) || []).length, 4, "named at whole steps only, the floor not at all");
  assert.equal((svg.match(/<line class="tk-(grid|base)"/g) || []).length, 5, "lines at whole steps only");
  const half = W.lineModel(daysEnding("2026-09-27", 371, k => (k === 200 ? 3.06e9 : 1e6)));
  assert.equal(half.top, 3.5e9);
  assert.equal((W.linePin(half).match(/<text /g) || []).length, 3, "none at the top, which is no whole step");
  // a year of nothing still draws, flat on the floor, with no columns and no line
  const flat = W.lineModel(daysEnding("2026-09-27", 371, () => 0));
  assert.ok(flat.points.every(p => p.y === box.top + box.h));
  assert.doesNotMatch(W.lineSvg(flat), /tk-cols|tk-avg/);
});

test("a busy, steady year draws its daily marks smaller and paler under a bolder line, and a year that grows keeps them", () => {
  const { W } = widgets();
  assert.deepEqual([...W.FULL_DAYS], [0.6, 0.8]);
  assert.deepEqual([...W.FULL_EVEN], [0.1, 0.3]);
  // used every day at much the same rate: the calmest
  const steady = Array.from({ length: 200 }, (_, i) => 1e8 * (1 + 0.3 * Math.sin(i)));
  assert.equal(W.calmOf(steady), 1);
  // a first year: quiet for months, then growing a hundredfold
  const growing = Array.from({ length: 200 }, (_, i) => 1e5 * 10 ** (i / 50));
  assert.ok(W.fullness(growing).even < 0.1);
  assert.equal(W.calmOf(growing), 0);
  // used on few days: as it is
  const light = Array.from({ length: 200 }, (_, i) => (i % 7 < 3 ? 1e7 : 0));
  assert.ok(W.fullness(light).used < 0.6);
  assert.equal(W.calmOf(light), 0);
  // in between, in between
  const most = Array.from({ length: 200 }, (_, i) => (i % 10 < 7 ? 1e8 : 0));
  assert.ok(W.calmOf(most) > 0.4 && W.calmOf(most) < 0.6);
  assert.equal(W.calmOf([]), 0);
  assert.equal(W.calmOf([5, 5]), 0, "too few days to say");
  // the screen and the picture's marks at no calm are the mock's own, and
  // at the most calm smaller and paler, the line bolder
  assert.deepEqual({ ...W.screenMarks(0) }, { alpha: 0.62, width: 0.62, line: 2.6 });
  const calm = W.screenMarks(1);
  assert.ok(calm.alpha < 0.62 && calm.width < 0.62 && calm.line > 2.6);
  assert.deepEqual({ ...W.pictureMarks(0) }, { col: 0.62, colWidth: 0.62, colLine: 3, dot: 2.6, dotAlpha: 0.55, dotLine: 2.2 });
  const pic = W.pictureMarks(1);
  assert.ok(pic.col < 0.62 && pic.colWidth < 0.62 && pic.colLine > 3 && pic.dot < 2.6 && pic.dotAlpha < 0.55 && pic.dotLine > 2.2);
  // on the screen: the columns and the key paler, the line bolder
  const days = daysEnding("2026-09-27", 371, k => 1e8 * (1 + 0.3 * Math.sin(k)));
  const model = W.lineModel(days);
  assert.equal(model.calm, 1);
  const svg = W.lineSvg(model);
  assert.match(svg, new RegExp(`class="tk-cols"[^>]*fill-opacity="${calm.alpha}"`));
  assert.match(svg, new RegExp(`class="tk-avg"[^>]*stroke-width="${Math.round(calm.line * 10) / 10}"`));
  const el = new El("div", makeDocument());
  W.drawLine(el, days);
  assert.match(/<span class="tk-legend">(.*?)<\/span>/.exec(el.innerHTML)[1], new RegExp(`fill-opacity="${calm.alpha}"`));
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
  const width = W.geometry(W.VIEW_H, W.yearWeeks(days)).width, room = width - 540;
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
  const view = () => activeLayer(stage).querySelector(".tk-scroll");
  const room = W.geometry(W.VIEW_H, W.yearWeeks(data.days)).width - 540;
  await p.refresh();
  assert.equal(view().scrollLeft, room, "the heatmap opens on its latest weeks");
  scrollTo(view(), 100);
  line.click();
  assert.match(activeLayer(stage).innerHTML, /class="tk-line"/);
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
  assert.equal(activeLayer(again).querySelector(".tk-scroll").scrollLeft, room);
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
  // the pill slides and the two chart layers crossfade
  assert.match(read("card-tokens.css"), /\*\{scrollbar-width:none\}\n\*::-webkit-scrollbar\{display:none\}/);
  assert.doesNotMatch(css, /scrollbar|\bscroll-behavior/);
  // the pill's seat, the two chart layers and the download button's icons;
  // past the panel, the picture's overlay fades its box in and out, and its
  // glass buttons take the bar's press
  const [inPanel, inShot] = [css.slice(0, css.indexOf(".tk-shot-veil")), css.slice(css.indexOf(".tk-shot-veil"))];
  assert.equal([...inPanel.matchAll(/transition:[^;}]*(opacity|left|transform)/g)].length, 3);
  assert.deepEqual([...inShot.matchAll(/transition:[^;}]*/g)].map(m => m[0]).filter(t => /opacity|transform/.test(t)),
    ["transition:opacity .2s ease-out, transform .26s var(--gentle)",
     "transition:color .18s, transform .5s var(--gentle), --qn-tint .5s var(--gentle), --qn-edge .5s var(--gentle)",
     "transition:color .18s, transform .3s cubic-bezier(.22,.7,.3,1), --qn-tint .3s cubic-bezier(.22,.7,.3,1), --qn-edge .3s cubic-bezier(.22,.7,.3,1)"]);
  assert.match(rule(".tk-layer"), /transition:opacity \.22s var\(--gentle\)/);
  assert.match(rule(".tk-thumb"), /transition:transform \.28s var\(--gentle\)/);
  assert.doesNotMatch(WIDGETS, /smooth|scrollTo\(|scrollBy\(|requestAnimationFrame/);
  // held and dragged with the mouse, the chart's names never picked up as text
  assert.match(css, /\.tk-lane\.more-left \.tk-scroll, \.tk-lane\.more-right \.tk-scroll\{cursor:grab\}/);
  assert.match(rule(".tk-lane.dragging .tk-scroll"), /cursor:grabbing/);
  assert.match(rule(".tk-chart"), /user-select:none/);
  // a soft fade on each side with more, and the pinned names let the pointer through
  assert.match(css, /\.tk-lane\.more-left \.tk-pin::after, \.tk-lane\.more-right::after\{opacity:1\}/);
  assert.match(rule(".tk-pin"), /background:var\(--tk-ground\); pointer-events:none/);
  // no box around the panel: its edge drawn clear (so nothing inside moves),
  // no fill and no shadow, and the pinned names and the fades are painted in
  // the page's own colour, which is what the panel now stands on
  const panel = rule(".tk-panel");
  assert.match(panel, /--tk-ground:var\(--paper\)/);
  assert.match(panel, /border:var\(--edge\) solid transparent/);
  assert.doesNotMatch(panel, /background|box-shadow|border-radius/);
  assert.match(rule(".tk-lane::after"), /linear-gradient\(to left, var\(--tk-ground\), transparent\)/);
  // one line between the two, from the screenshot on the card: 1px of the line
  // colour, 3px past the column each side, 39% of the way down the gap
  assert.match(HTML, /body\.focus\.home #homelimits:not\(\[hidden\]\)::before\{content:""; position:absolute; left:-3px; right:-3px;\s*top:calc\(var\(--home-gap\) \* -\.61\); height:1px; background:var\(--line\); pointer-events:none\}/);
  // the phone's home page draws the same line at the same share of its 8px gap,
  // across the panels' own width, clear of the screen's edges
  assert.match(read("m.html"), /#home #homelimits:not\(\[hidden\]\)::before\{content:""; position:absolute; left:0; right:0;\s*top:calc\(8 \* var\(--u\) \* -\.61\); height:1px; background:var\(--line\); pointer-events:none\}/);
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
  assert.match(HTML, /body\.focus\.home #homeplot\{height:100%; --tk-panel-h:100%\}/);
  // the panel is a column that fills a box with a height of its own, the view
  // taking what the heading and foot leave; elsewhere the view is 200 tall
  const panelRule = rule(".tk-panel");
  assert.match(panelRule, /--tk-view-h:200px/);
  assert.match(panelRule, /box-sizing:border-box; height:var\(--tk-panel-h, 330px\); display:flex; flex-direction:column/);
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
  // both charts' names at the panel's 12px; the line's gridlines and floor
  // the Editorial look's, and its 7-day line ringed in the ground's colour
  assert.match(rule(".tk-axis"), /font:400 12px var\(--sans\)/);
  assert.doesNotMatch(css, /\.tk-path\{/, "no dotted daily line");
  assert.match(css, /\.tk-avg, \.tk-ring\{stroke-linecap:round; stroke-linejoin:round\}/);
  assert.match(rule(".tk-ring"), /stroke:var\(--tk-ground\)/);
  assert.match(rule(".tk-grid"), /stroke:#E4DED5/);
  assert.match(css, /\.tk-base, \.tk-tick\{stroke:#B9B1A5; stroke-width:1px\}/);
  // the panel reserves its size and loading content fills the same stage
  assert.match(rule(".tk-wait"), /flex:1 1 auto;/);
  assert.match(rule(".tk-layer"), /position:absolute; inset:0/);
});

test("counts read short and the tips name the day", () => {
  const { W } = widgets();
  // billions are the largest unit: a fourth figure with a comma, never trillions
  const cases = [[0, "0"], [999, "999"], [1234, "1.23K"], [999_600, "1M"], [48_210_000, "48.2M"],
                 [5_214_000_000, "5.21B"], [120e9, "120B"], [999.4e9, "999B"], [999.6e9, "1,000B"],
                 [1.07e12, "1,070B"], [1.2345e12, "1,235B"], [3e12, "3,000B"], [12.3456e12, "12,346B"]];
  for (const [n, want] of cases) assert.equal(W.compact(n), want, String(n));
  for (let n = 1; n < 1e16; n *= 1.37) assert.doesNotMatch(W.compact(n), /T|NaN|undefined/, String(n));
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
  // each row's mark is its own: the day a light column, the average the deep line
  assert.match(tip, new RegExp(`<path d="[^"]+" fill="${W.PALETTE[4]}" fill-opacity="0.62"/></svg>Daily`));
  assert.match(tip, new RegExp(`stroke="${W.AVG_LINE}" stroke-width="[^"]+" stroke-linecap="round"/></svg>7-day average`));
  assert.ok(Math.abs(p.y - model.yAt(p.total)) < 0.1 && Math.abs(p.ya - model.yAt(p.avg)) < 0.1,
            "the two dots stand at the tip's two numbers");
  // every day of the year: its total in the tip, and its average where a
  // line is drawn, over the days outside a gap; both marks inside the axis
  const gap = model.points.filter(q => q.gap);
  assert.equal(gap.length, 257, "the quiet months before the busy week are a gap");
  for (const q of model.points) {
    const t = W.lineTip(q);
    assert.ok(t.includes(`Daily<em>${W.compact(q.total)}</em>`));
    if (q.gap) assert.doesNotMatch(t, /average/, `${q.date} is in a gap, with no line and no average`);
    else assert.ok(t.includes(`${q.span}-day average<em>${W.compact(q.avg)}</em>`), q.date);
    assert.ok(q.total <= model.top && q.avg <= model.top, `${q.date} stands above the axis`);
  }
  // the busy week's first day follows the gap, so it averages itself alone
  assert.deepEqual(["2026-09-15", "2026-09-16", "2026-09-21"].map(d => model.points.find(q => q.date === d).span), [1, 2, 7]);
  // where a reading begins, the average says how few days it holds
  const short = W.lineModel(daysEnding("2026-09-27", 3, () => 3e6));
  assert.match(W.lineTip(short.points[0]), /^<b>Fri, Sep 25, 2026<\/b>.*Daily<em>3M<\/em>.*1-day average<em>3M<\/em>/);
  assert.match(W.lineTip(short.points[2]), /3-day average<em>3M<\/em>/);
  // the legend under the line names both, beside the same strokes, and the
  // words on its left give this year's total and no tool's name
  const doc = makeDocument();
  const footOf = set => {
    const el = new El("div", doc);
    W.drawLine(el, set);
    return /<div class="tk-foot">(.*?)<\/div>/.exec(el.innerHTML)[1];
  };
  const text = html => html.replace(/<[^>]+>/g, "");
  const split = (claude, codex) => days.map(d => ({ ...d, claude: d.total * claude, codex: d.total * codex }));
  const total = W.compact(days.slice(W.yearStart(days)).reduce((n, d) => n + d.total, 0));
  for (const mix of [split(1, 0), split(0, 1), split(0.5, 0.5), split(0, 0)]) {
    const foot = footOf(mix);
    assert.match(foot, /^<span class="tk-sum"><b>[^<]+<\/b> tokens this year<\/span><span class="tk-legend"><svg class="tk-key"/);
    assert.equal(text(foot), `${total} tokens this yearDaily7-day average`);
    assert.doesNotMatch(foot, /Claude|Codex|·|tk-src/, "no tool's name on the line's foot");
  }
});

test("the line and the heatmap both run from January 1 to today; the foot words follow", () => {
  const { W } = widgets();
  const days = daysEnding("2026-09-27", 371, () => 1000);
  assert.equal(days[W.yearStart(days)].date, "2026-01-01");
  assert.equal(W.yearStart(days), 371 - 270);
  assert.equal(W.lineModel(days).points.length, 270);
  assert.equal(W.heatmapModel(days).cells.length, 270, "the heatmap from January 1 too, not a rolling year");
  assert.equal(W.heatmapModel(days).cells[0].date, "2026-01-01");
  assert.equal(W.lineModel(days).width, W.heatmapModel(days).geo.width, "the two as wide, a week of the line a column");
  // the first day of the line has its whole week of average, from the six days before
  assert.equal(W.lineModel(days).points[0].span, 7);
  assert.equal(W.lineModel(days).points[0].from, "2025-12-26");
  // on January 1 itself, and a reading that starts after it
  assert.equal(W.lineModel(daysEnding("2026-01-01", 371, () => 1000)).points.length, 1);
  assert.equal(W.lineModel(daysEnding("2026-09-27", 20, () => 1000)).points.length, 20);
  assert.equal(W.yearStart([]), 0);
  // both totals are the days they show, this year's
  assert.equal(W.totalLine(56.2e9), "<b>56.2B</b> tokens this year");
  const footOf = draw => { const el = new El("div", makeDocument()); draw(el, days); return /<span class="tk-sum">(.*?)<\/span>/.exec(el.innerHTML)[1]; };
  assert.equal(footOf(W.drawHeatmap), "<b>270K</b> tokens this year");
  assert.equal(footOf(W.drawLine), "<b>270K</b> tokens this year");
  assert.doesNotMatch(WIDGETS, /in the last year/);
  // the route is asked for the year so far and a week before it when that is more than the heatmap's year
  const late = Date.UTC(2026, 11, 31, 12), early = new Date(2026, 2, 3, 12).getTime();
  assert.equal(W.fetchDays(early), W.FETCH_DAYS, "early in the year the heatmap's days are enough");
  assert.equal(W.fetchDays(new Date(2026, 11, 30, 12).getTime()), 364 + 7);
  assert.equal(W.fetchDays(new Date(2028, 11, 31, 12).getTime()), 366 + 7, "a leap year's last day");
  assert.equal(W.sources, undefined, "no tool names are built any more");
  assert.equal(W.sourceLine, undefined);
  assert.ok(late > early);
});

test("the panel's line foot gives this year's total and no tool names", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const footText = async mix => {
    const days = daysEnding("2026-09-27", 371).map(d => ({ ...d, claude: d.total && mix.claude, codex: d.total && mix.codex }));
    const root = new El("div", doc);
    const p = W.panel(root, { load: async () => ({ days, found: { claude: true, codex: true } }), store: makeStore({ "home.chart": "line" }) });
    await p.refresh();
    const stage = walk(root).find(n => n.className === "tk-stage");
    const sum = /<span class="tk-sum">(.*?)<\/span>(?=<span class="tk-legend">)/.exec(activeLayer(stage).innerHTML)[1];
    return sum.replace(/<[^>]+>/g, "");
  };
  for (const mix of [{ claude: 5, codex: 0 }, { claude: 0, codex: 5 }, { claude: 5, codex: 5 }, { claude: 0, codex: 0 }])
    assert.match(await footText(mix), /^[\d.]+[KMBT]? tokens this year$/);
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
  assert.match(activeLayer(stage).innerHTML, /class="tk-heat"/);
  assert.equal((activeLayer(stage).innerHTML.match(/class="tk-day"/g) || []).length, 270, "January 1 to September 27");
  assert.match(activeLayer(stage).innerHTML, /tokens this year/);

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
  assert.match(activeLayer(stage).innerHTML, /class="tk-line"/);
  assert.doesNotMatch(activeLayer(stage).innerHTML, /class="tk-heat"/);
  assert.equal(store.getItem("home.chart"), "line");
  assert.equal(p.view(), "line");

  // a second panel in the same browser opens on the chart last chosen
  const again = W.panel(new El("div", doc), { load: async () => data, store });
  await again.refresh();
  assert.equal(again.view(), "line");

  opts[0].click();
  assert.match(activeLayer(stage).innerHTML, /class="tk-heat"/);
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
  assert.match(failing.textContent, /Token usage is unavailable/);
  const empty = new El("div", doc);
  const q = W.panel(empty, { load: async () => ({ days: daysEnding("2026-09-27", 371, () => 0),
                                                  found: { claude: false, codex: false } }), store: null });
  await q.refresh();
  assert.match(empty.textContent, /No token usage yet/);
  assert.match(empty.textContent, /Last updated: now/);
  assert.equal(activeLayer(empty).tkModel, null, "an empty reading uses the calm message");
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
  // the house's circle takes the ink under a pointer, as the bar's other circles
  // do, and while home is up, when it also stays pressed
  assert.match(HTML, /body\.focus :is\(#homeico[^)]*\):hover\{color:var\(--ink\)\}/);
  assert.match(HTML, /body\.focus\.home #homeico\{color:var\(--ink\); --qn-tint:\.95; --qn-edge:3\}/);
  assert.match(HTML, /body\.focus\.home #stage\{visibility:hidden; opacity:0; pointer-events:none\}/);
  assert.match(HTML, /body\.focus\.home #home\{display:block;/);
  // shared widget assets load before the page script can open Home
  assert.match(HTML, /<script src="\/home-widgets\.js">/);
  assert.match(HTML, /<link[^>]*home-widgets\.css/);
  // every project leaves home, a new folder does too, no project is checked in
  // the pill's list while it is up, and the board's keys are off
  const setTab = HTML.slice(HTML.indexOf("function setTab("), HTML.indexOf("\n}\n", HTML.indexOf("function setTab(")));
  assert.match(setTab, /if \(LOCKED && owner !== LOCKED\) return;\n  if \(homeOpen\) setHome\(false\);/);
  const pick = HTML.slice(HTML.indexOf("async function pickFolder("), HTML.indexOf("\n}\n", HTML.indexOf("async function pickFolder(")));
  assert.match(pick, /if \(\(slot === homePick \|\| slot === menuPick\) && homeOpen\) setHome\(false\);/);
  assert.match(HTML, /const ow = row\.dataset\.owner, on = ow === activeOwner && !homeOpen && !draft;\n    row\.classList\.toggle\("on", on\);/);
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
    magicSync: () => {},   // the card's magic box goes with the board and comes back with it
    boardFadeStop: () => {},   // a crossfade between projects gives way to home

    setInterval: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    clearInterval: id => { timers.delete(id); },
    fetch: async url => { fetched.push(url);
      return { ok: true, json: async () => ({ days: daysEnding("2026-09-27", 371), found: { claude: true, codex: true } }) }; },
  };
  ctx.window = ctx;
  ctx.addEventListener = doc.addEventListener;
  // appending the script is where a browser would fetch it: here it runs the
  // real file into the same sandbox, or fails the way a 404 does
  doc.head.append = (...nodes) => {
    for (const n of nodes) {
      doc.head.appendChild(n);
      if (n.tagName !== "SCRIPT") continue;
      queueMicrotask(() => {
        if (serve) { vm.runInContext(WIDGETS, ctx); n.onload(); } else n.onerror();
      });
    }
  };
  vm.createContext(ctx);
  if (serve) vm.runInContext(WIDGETS, ctx);
  vm.runInContext(HTML.slice(start, end), ctx);
  const is = name => vm.runInContext(name, ctx);
  return { ctx, doc, byId, inside, store, fetched, tabs, timers, is };
}

test("the house opens its prepared widgets and a project tab leaves it", async () => {
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
  assert.equal(h.doc.head.children.length, 0, "no delayed widget download on opening");
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371"]);
  const panel = h.byId.homeplot.children[0];
  assert.equal(panel.className, "tk-panel");
  const stage = walk(panel).find(n => n.className === "tk-stage");
  assert.equal((activeLayer(stage).innerHTML.match(/class="tk-day"/g) || []).length, 270);
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
  assert.equal(h.doc.head.children.length, 0);
  assert.equal(h.byId.homeplot.children.length, 1);
  assert.deepEqual(h.fetched, ["/tokens/daily?days=371", "/tokens/daily?days=371"]);
});

test("a reload comes back to home, and a failed widget download can be retried", async () => {
  const back = homeBlock({ stored: { homeopen: "1" } });
  assert.equal(back.is("homeOpen"), false);
  for (const fn of back.doc.listeners.DOMContentLoaded) fn();
  assert.equal(back.is("homeOpen"), true);
  await settle();
  assert.deepEqual(back.fetched, ["/tokens/daily?days=371"]);

  const old = homeBlock({ serve: false });
  old.byId.homeico.click();
  await settle();
  assert.equal(old.is("homePanel"), null);
  assert.equal(old.is("homeLoad"), null, "connection recovery can retry the download");
  assert.deepEqual(old.fetched, []);
  assert.equal(old.doc.head.children.filter(n => n.tagName === "SCRIPT").length, 0, "the failed script is taken back out");
});

// ---- the download button and the picture ------------------------------------------------
test("a download button stands beside the pill, in one box with it, drawn from Lucide's download icon", async () => {
  const { W } = widgets();
  const doc = makeDocument();
  const root = new El("div", doc);
  const days = daysEnding("2026-09-27", 371);
  const p = W.panel(root, { load: async () => ({ days }), store: null });
  const nodes = walk(root);
  const head = nodes.find(n => n.className === "tk-head");
  assert.deepEqual(head.children.map(n => n.className), ["tk-title", "tk-tools"], "the heading and one box for the tools");
  const tools = head.children[1];
  assert.deepEqual(tools.children.map(n => n.className), ["tk-pill", "tk-save"], "the button right after the pill");
  const save = tools.children[1];
  assert.equal(save.tagName, "BUTTON");
  assert.equal(save.type, "button");
  assert.equal(save.getAttribute("aria-label"), "Download chart as a picture");
  assert.match(save.innerHTML, /<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"\/>.*<polyline points="7 10 12 15 17 10"\/>.*<line x1="12" x2="12" y1="15" y2="3"\/>/);
  assert.equal(save.disabled, true, "nothing to save before a reading has come");
  await p.refresh();
  assert.equal(save.disabled, false);
  // the sheet gives it the pill's own face and keeps the pair on one line
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.tk-tools\{flex:none; display:flex; align-items:stretch; gap:6px\}/);
  assert.match(css, /\.tk-save\{[^}]*border-radius:7px; background:color-mix\(in srgb, var\(--paper\) 92%, #fff 8%\);\s*border:var\(--edge\) solid var\(--line\)/);
  assert.match(css, /\.tk-name\{[^}]*white-space:nowrap; overflow:hidden; text-overflow:ellipsis\}/, "the heading never wraps");
  // a narrow panel spaces the row down, and below 355px brings the type down with it, the limits title too
  assert.match(css, /\.tk-panel\{container:tkpanel \/ inline-size\}/);
  assert.match(css, /@container tkpanel \(max-width: 373px\)\{\s*\.tk-head\{--tk-gap:8px\}/);
  assert.match(css, /@container tkpanel \(max-width: 355px\)\{[^@]*\.tk-name, \.lm-title\{font-size:12px\}/);
  assert.match(read("m.html"), /#home \.tk-tools\{grid-area:pill\}/, "the phone seats the box where the pill was");
});

test("the foot is one line that never wraps, and the phone leaves the tools the room they need", () => {
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.tk-sum\{white-space:nowrap; min-width:0; overflow:hidden; text-overflow:ellipsis\}/);
  assert.match(read("m.html"), /grid-template-columns:minmax\(0, 1fr\) auto/, "the heading column can give way");
});

// a canvas context that writes down what is painted on it
function recording() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (t, k) => {
      if (k === "measureText") return s => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
                                              actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(s).length * 7 });
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      if (k in t) return t[k];
      // text is written down with the side it is set from
      return (...args) => { calls.push(k === "fillText" || k === "strokeText" ? [k, ...args, t.textAlign || "left"] : [k, ...args]); };
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const texts = () => calls.filter(c => c[0] === "fillText").map(c => c[1]);
  return { ctx, calls, texts };
}
const paintOf = (W, kind, pick, days, installed = null, calm) => {
  const r = recording();
  W.paintLook(r.ctx, kind, pick, days, installed, W.LOOK, null, calm);
  return r;
};
// a look's place among the dice's, by its name: pickOf(W, "line", "poster band")
const pickOf = (W, kind, named) => {
  const at = W.DICE[kind].findIndex(p => p.join(" ") === named);
  assert.ok(at >= 0, `${kind} has ${named}`);
  return at;
};

test("the picture is 3:1 for the heatmap and 2:1 for the line, drawn three times over", () => {
  const { W } = widgets();
  const days = daysEnding("2026-09-27", 371, i => (i % 3 ? (i + 1) * 5000 : 0));
  assert.deepEqual({ ...W.SHAPE_OF }, { heatmap: "3:1", line: "2:1" });
  assert.equal(W.PIC_SCALE, 3);
  assert.deepEqual([...W.SHAPES["3:1"]], [1200, 400]);
  assert.deepEqual([...W.SHAPES["2:1"]], [1200, 600]);
  const doc = { createElement: () => ({ getContext: () => recording().ctx }) };
  for (const [kind, w, h] of [["line", 3600, 1800], ["heatmap", 3600, 1200]]) W.DICE[kind].forEach((_, pick) => {
    const canvas = W.pictureCanvas(doc, kind, pick, days, null, W.LOOK, null);
    assert.deepEqual([canvas.width, canvas.height], [w, h], `${kind} ${pick}`);
  });
  // every look carries the title, the name and the link, and this year's total
  const total = W.compact(days.slice(W.yearStart(days)).reduce((n, d) => n + d.total, 0));
  for (const kind of ["line", "heatmap"]) W.DICE[kind].forEach((_, pick) => {
    const t = paintOf(W, kind, pick, days).texts();
    for (const words of ["Token consumption per day", "Facilitator", "github.com/AsteroidHunter/facilitator", total])
      assert.ok(t.includes(words), `${kind} ${W.DICE[kind][pick].join(" ")} says ${words}`);
    assert.ok(t.includes(" tokens this year"), `${kind} ${pick} says this year`);
    assert.ok(!t.some(s => /in the last year|tokens a year/.test(s)));
  });
});

test("the dice rolls through six line looks and all three heatmaps, never the three the owner left out", () => {
  const { W } = widgets();
  assert.deepEqual(JSON.parse(JSON.stringify(W.DICE)), {
    line: [["poster", "band"], ["editorial", "daily"], ["editorial", "band"], ["lab", "daily"], ["lab", "dots"], ["poster", "dots"]],
    heatmap: [["editorial"], ["lab"], ["poster"]],
  });
  const pairs = W.DICE.line.map(p => p.join(" "));
  for (const left of ["poster daily", "lab band", "editorial dots"]) assert.ok(!pairs.includes(left), `${left} is left out`);
  // the first of each is what the download saves and the pop-up opens on: the
  // Poster two-week median with its band (the owner's choice, 20261020), and
  // the Editorial heatmap as before
  assert.deepEqual([...W.DICE.line[0]], ["poster", "band"], "the download saves the Poster median and band");
  assert.deepEqual([...W.DICE.heatmap[0]], ["editorial"], "the heatmap's stays Editorial");
  // each roll turns up another look, every other one before any comes round again
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const kind of ["line", "heatmap"]) {
    const bags = {};
    let at = 0;
    const seen = [];
    for (let i = 0; i < 4 * W.DICE[kind].length; i++) {
      const next = W.nextLook(bags, kind, at, random);
      assert.notEqual(next, at, "a roll always changes the look");
      assert.ok(next >= 0 && next < W.DICE[kind].length);
      seen.push(next);
      at = next;
    }
    const n = W.DICE[kind].length;
    assert.deepEqual([...new Set(seen.slice(0, n - 1))].sort(), Array.from({ length: n - 1 }, (_, k) => k + 1),
                     `${kind}: the first rolls show every other look once`);
    assert.equal(new Set(seen).size, n, `${kind}: every look comes up`);
  }
});

test("Poster puts the year's total over the title, so it never reads as a day's, and its heatmap draws squares", () => {
  const { W } = widgets();
  const days = daysEnding("2026-09-27", 371, i => (i % 3 ? (i + 1) * 5e6 : 0));
  const total = W.compact(days.slice(W.yearStart(days)).reduce((n, d) => n + d.total, 0));
  for (const [kind, named] of [["line", "poster band"], ["line", "poster dots"], ["heatmap", "poster"]]) {
    const pick = pickOf(W, kind, named);
    const r = paintOf(W, kind, pick, days);
    const at = words => r.calls.find(c => c[0] === "fillText" && c[1] === words);
    assert.ok(at(total)[3] < at("Token consumption per day")[3], `${kind}: the total stands over the title`);
    assert.ok(at(" tokens this year")[3] === at(total)[3], "with tokens this year beside it");
  }
  // the heatmap's days are squares, as in the other two looks, and so is its key
  const heat = paintOf(W, "heatmap", pickOf(W, "heatmap", "poster"), days);
  const cells = days.slice(W.yearStart(days)).length;
  assert.equal(heat.calls.filter(c => c[0] === "arc").length, 0, "no circles");
  assert.equal(heat.calls.filter(c => c[0] === "roundRect").length, cells + W.PALETTE.length);
  // big totals stay in billions
  const huge = daysEnding("2026-09-27", 371, i => (i > 120 ? 4e9 : 0));
  assert.ok(paintOf(W, "line", pickOf(W, "line", "poster band"), huge).texts().includes("1,000B"));
});

test("the picture's line marks the install day, and leaves the mark out when that day is not among the days shown or not a week old", () => {
  const { W } = widgets();
  const days = daysEnding("2026-09-27", 371);
  const inside = days.at(-100).date;
  const S = W.seriesOf(days, W.pictureStart(days), inside);
  assert.equal(S.shown[S.install].date, inside, "on that day's own place");
  for (const named of ["editorial daily", "editorial band", "lab daily", "lab dots"]) {
    const t = [...paintOf(W, "line", pickOf(W, "line", named), days, inside).calls].filter(c => c[0] === "fillText" || c[0] === "strokeText").map(c => c[1]);
    assert.ok(t.includes("Facilitator installed"), `${named} marks it`);
  }
  for (const named of ["poster band", "poster dots"])
    assert.ok(paintOf(W, "line", pickOf(W, "line", named), days, inside).texts().includes("Facilitator installed"), `${named}: Poster's tag`);
  const marks = installed => paintOf(W, "line", 0, days, installed).calls.some(c => c[1] === "Facilitator installed");
  assert.equal(marks(days[3].date), false, "before the days shown (the days fetched ahead of them are not shown)");
  assert.equal(marks("2027-01-01"), false, "after the last day");
  assert.equal(marks(null), false, "a board that has not said");
  // a board first started less than 7 days before today (the last day) is not
  // marked yet: the mark would stand at the right edge with nothing after it.
  // In every line look, 6 days after the install day there is no line, no
  // label and no room kept for them, the picture painted as with no install
  // day at all; 7 days after, the mark is there
  assert.equal(W.MARK_AFTER, 7);
  const ago = n => days.at(-1 - n).date;
  assert.equal(marks(ago(0)), false, "started today");
  assert.equal(marks(ago(3)), false, "three days ago");
  W.DICE.line.forEach((look, pick) => {
    const named = look.join(" ");
    const six = paintOf(W, "line", pick, days, ago(6)), none = paintOf(W, "line", pick, days, null);
    assert.equal(six.calls.some(c => c[1] === "Facilitator installed"), false, `${named}: 6 days after install, no mark`);
    assert.deepEqual(JSON.stringify(six.calls), JSON.stringify(none.calls), `${named}: 6 days after install, nothing kept for it`);
    const seven = paintOf(W, "line", pick, days, ago(7));
    assert.equal(seven.calls.some(c => c[1] === "Facilitator installed"), true, `${named}: 7 days after install, marked`);
  });
  assert.equal(W.seriesOf(days, W.pictureStart(days), ago(6)).install, -1);
  assert.equal(W.seriesOf(days, W.pictureStart(days), ago(7)).install, W.seriesOf(days).n - 1 - 7);
  for (const pick of [0, 1, 2]) assert.equal(paintOf(W, "heatmap", pick, days, inside).calls.some(c => c[1] === "Facilitator installed"), false, "never on the heatmap");
});

test("a board first started not long ago keeps its install label inside the picture and clear of the high point's note", () => {
  const { W } = widgets();
  // use growing all year, so the high point is the last days, just after the install day
  const days = daysEnding("2026-09-27", 371, k => Math.round(1e6 * 10 ** (k / 120)));
  const ago = n => days.at(-1 - n).date;
  // the boxes of the words painted, at the recording canvas's 7px a letter
  const boxes = r => r.calls.filter(c => c[0] === "fillText").map(([, s, x, y, align]) => {
    const w = String(s).length * 7, left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    return { s, x0: left, x1: left + w, y0: y - 12, y1: y + 3 };
  });
  const meet = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  for (const n of [7, 10, 14]) W.DICE.line.forEach((look, pick) => {
    const named = `${look.join(" ")}, installed ${n} days ago`;
    const words = boxes(paintOf(W, "line", pick, days, ago(n)));
    const label = words.filter(b => b.s === "Facilitator installed");
    assert.equal(label.length, 1, `${named}: marked once`);
    // the label and the date under it (Editorial's "September 17", Lab's "Sep 17, 2026")
    const p = ago(n).split("-").map(Number), month = ["January", "February", "March", "April", "May", "June", "July",
      "August", "September", "October", "November", "December"][p[1] - 1];
    const dates = words.filter(b => b.s === `${month} ${p[2]}` || b.s === `${month.slice(0, 3)} ${p[2]}, ${p[0]}`);
    for (const b of [...label, ...dates]) assert.ok(b.x0 >= 0 && b.x1 <= 1200, `${named}: "${b.s}" stays inside the picture`);
    // Lab's label stands left of its line where the right has no room
    if (look[0] === "lab") assert.ok(label[0].x1 <= 1164, `${named}: Lab's label ends inside the plot`);
    // Poster's note keeps clear of the tag
    if (look[0] === "poster") {
      const note = words.filter(b => /^(Highest median|Busiest week)$/.test(b.s) || / around | median, /.test(b.s));
      assert.equal(note.length, 2, `${named}: the note is there`);
      for (const b of note) assert.ok(!meet(b, label[0]), `${named}: "${b.s}" is clear of the tag`);
    }
  });
  // an install day well back in the year keeps Lab's label right of its line, as the mock has it
  const lab = paintOf(W, "line", pickOf(W, "line", "lab daily"), days, ago(100)).calls.find(c => c[0] === "fillText" && c[1] === "Facilitator installed");
  assert.equal(lab.at(-1), "left");
});

// a reading whose days have use where `on` says, `level` tokens each
const usedOn = (last, n, on, level = 5e6) => daysEnding(last, n).map(d => ({ ...d, total: on(d.date) ? level : 0 }));
const pictureDays = (W, days, installed = null) => W.seriesOf(days, W.pictureStart(days), installed);

test("the line's picture starts where use began, on each year the rule was chosen on and on the real days", () => {
  const { W } = widgets();
  // each year as runs of days without and with use, and the start the research found for it
  const { years } = JSON.parse(read("tests/fixtures/chart-start-years.json"));
  assert.equal(years.length, 24);
  assert.equal(W.MIN_SILENCE, 30);
  assert.equal(W.MIN_SHOWN, 28);
  const reading = y => {
    const used = y.runs.flatMap((n, k) => Array(n).fill(k % 2 === 1));
    assert.equal(used.length, y.days, y.name);
    const last = new Date(Date.parse(y.first + "T00:00:00Z") + (y.days - 1) * 864e5).toISOString().slice(0, 10);
    const days = daysEnding(last, y.days, k => (used[k] ? 1000 : 0));
    assert.equal(days[0].date, y.first, y.name);
    return days;
  };
  for (const y of years) {
    const days = reading(y);
    assert.equal(days[W.useStart(days)].date, y.start, y.name);
  }
  // the real days as the panel reads them: the picture starts on April 1, the
  // screen keeps January 1, and the total is still the year's
  const real = reading(years.find(y => y.name.startsWith("real daily totals")));
  assert.equal(real.at(-1).date, "2026-10-19");
  assert.equal(real[W.pictureStart(real)].date, "2026-04-01");
  const S = pictureDays(W, real, "2026-08-03");
  assert.equal(S.first, "2026-04-01");
  assert.equal(S.last, "2026-10-19");
  assert.deepEqual([S.since[0], S.span[0]], ["2026-03-26", 7], "the first average still takes the six days before");
  assert.equal(S.shown[S.install].date, "2026-08-03", "the install day comes after the start, so it is drawn");
  assert.equal(S.total, real.slice(W.yearStart(real)).reduce((n, d) => n + d.total, 0), "the total from January 1");
  assert.equal(W.lineModel(real).points[0].date, "2026-01-01", "the line on screen starts on January 1");
  assert.equal(W.heatmapModel(real).cells[0].date, "2026-01-01", "and so does the heatmap");
});

test("the line's picture skips an early trial but not a holiday, and always shows four weeks", () => {
  const { W } = widgets();
  // a week's trial in January, then nothing until May 11, then steady use; the
  // board was first started in the trial's wake, before the new start
  const trial = usedOn("2026-10-19", 371, d => (d >= "2026-01-12" && d <= "2026-01-18" ? 1 : d >= "2026-05-11"));
  const t = pictureDays(W, trial, "2026-02-02");
  assert.equal(t.first, "2026-05-11");
  assert.equal(t.install, -1, "the install day is before the start, so the mark is left out");
  assert.deepEqual([t.since[0], t.span[0]], ["2026-05-05", 7]);
  assert.equal(t.avg[0], 5e6 / 7, "the six days before it count, as they did");
  assert.equal(t.total, trial.slice(W.yearStart(trial)).reduce((n, d) => n + d.total, 0), "the trial is still in this year's total");
  assert.equal(W.lineModel(trial).points[0].date, "2026-01-01", "the screen keeps January 1");
  assert.ok(pictureDays(W, trial, "2026-06-01").install > 0, "a later install day is still marked");
  // five weeks off in the summer after six months of use: no crop, and the
  // weeks off are a gap in the line
  const holiday = pictureDays(W, usedOn("2026-10-19", 371, d => d < "2026-07-01" || d > "2026-08-04"));
  assert.equal(holiday.first, "2026-01-01");
  assert.equal(holiday.since[0], "2025-12-26");
  assert.equal(holiday.runs.length, 2);
  // steady use from March 3, the day it began
  assert.equal(pictureDays(W, usedOn("2026-10-19", 371, d => d >= "2026-03-03")).first, "2026-03-03");
  // use that stopped, with nothing since: a silence up to today never counts
  assert.equal(pictureDays(W, usedOn("2026-10-19", 371, d => d >= "2026-02-01" && d < "2026-05-01")).first, "2026-02-01");
  // early in a year at least 28 days are shown, from January 1 when there are fewer
  const feb = pictureDays(W, usedOn("2026-02-10", 371, d => d >= "2026-02-01"));
  assert.equal(feb.n, 28);
  assert.equal(feb.first, "2026-01-14");
  assert.equal(pictureDays(W, usedOn("2026-01-20", 371, d => d >= "2026-01-15")).first, "2026-01-01");
  // no use this year at all, and no days at all; every look still paints
  const none = usedOn("2026-10-19", 371, () => false);
  assert.equal(pictureDays(W, none).first, "2026-01-01");
  for (const kind of ["line", "heatmap"]) W.DICE[kind].forEach((_, pick) => paintOf(W, kind, pick, none));
  W.DICE.line.forEach((_, pick) => paintOf(W, "line", pick, usedOn("2026-01-01", 371, () => true)));
  assert.equal(W.useStart([]), 0);
});

// a canvas context that writes down each fill and stroke with the colour it
// is made in, keeping the colours across save and restore as a canvas does
function inked() {
  const marks = [], kept = [];
  const state = { fillStyle: "#000000", strokeStyle: "#000000" };
  const ctx = new Proxy(state, {
    get: (t, k) => {
      if (k === "measureText") return s => ({ width: String(s).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2,
                                              actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(s).length * 7 });
      if (k === "createLinearGradient") return () => ({ addColorStop() {} });
      if (k === "save") return () => kept.push({ ...t });
      if (k === "restore") return () => Object.assign(t, kept.pop());
      if (k in t) return t[k];
      return (...args) => {
        if (/^fill/.test(k)) marks.push({ op: k, colour: t.fillStyle, args });
        else if (/^stroke/.test(k)) marks.push({ op: k, colour: t.strokeStyle, args });
      };
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, marks };
}

test("every picture stands on pure white, and everything in it painted with the paper is white too, whatever the page's paper", () => {
  const { W } = widgets();
  assert.equal(W.LOOK.paper, "#FFFFFF");
  // the board's page paper is a warm off-white; the pictures do not take it
  const page = { "--paper": "#F5F4F1", "--ink": "#211D17", "--sub": "#75695A" };
  const node = { ownerDocument: { defaultView: { getComputedStyle: () => ({ getPropertyValue: n => page[n] || "" }) } } };
  const face = W.lookOf(node);
  assert.equal(face.paper, "#FFFFFF");
  assert.deepEqual([face.ink, face.sub], ["#211D17", "#75695A"], "the inks are still the page's");
  assert.match(read("card-tokens.css"), /--paper:#F5F4F1;/, "the board's own paper is unchanged");
  const code = WIDGETS.slice(WIDGETS.indexOf("// ---- the picture"), WIDGETS.indexOf("// ---- the panel"));
  assert.doesNotMatch(code, /F5F4F1/i, "no off-white is left in the painter");
  assert.doesNotMatch(code, /get\("--paper"/, "nor is the page's paper read for it");
  // use from May 21 with a quiet first fortnight, an install day 60 days back
  // and a high point at the end, so every look draws its rings, haloes, tags,
  // notes and dots
  const days = daysEnding("2026-09-27", 371, k => (k < 150 ? 0 : k < 163 ? 2e5 : Math.round(1e6 * 10 ** ((k - 163) / 80))));
  const installed = days.at(-60).date;
  for (const kind of ["line", "heatmap"]) W.DICE[kind].forEach((look, pick) => {
    const named = `${kind} ${look.join(" ")}`;
    const r = inked();
    W.paintLook(r.ctx, kind, pick, days, installed, face, null);
    const [first] = r.marks;
    assert.deepEqual([first.op, first.colour, ...first.args], ["fillRect", "#FFFFFF", 0, 0, 1200, kind === "line" ? 600 : 400],
                     `${named}: the whole picture is white before anything else`);
    const flat = r.marks.filter(m => typeof m.colour === "string");
    assert.ok(!flat.some(m => /^#F5F4F1$/i.test(m.colour)), `${named}: nothing is in the old paper`);
    // the marks painted with the paper are white: on a line look the rings
    // under its lines, the haloes round its notes and its dots and tags
    if (kind === "line") assert.ok(flat.slice(1).some(m => m.colour === "#FFFFFF"), `${named}: its paper marks are white`);
  });
  // the line's first look, the one saved, by what it paints white: the ring
  // under its median, the halo round its note, its install tag and the point's dot
  const r = inked();
  W.paintLook(r.ctx, "line", 0, days, installed, face, null);
  const white = new Set(r.marks.slice(1).filter(m => m.colour === "#FFFFFF").map(m => m.op));
  assert.deepEqual([...white].sort(), ["fill", "stroke", "strokeText"], "the dot and the tag, the ring, and the halo");
});

test("the picture is painted in the board's inks and the squid's own file, never purple and never the accent", () => {
  const code = WIDGETS.slice(WIDGETS.indexOf("// ---- the picture"), WIDGETS.indexOf("// ---- the panel"));
  assert.match(code, /LOGO_SRC = "\/m-splash-squid\.png"/, "the board's own logo file");
  assert.match(code, /ctx\.font = F\(700, size, INTER\)/, "the name in the board's wordmark face");
  assert.match(code, /REPO_LINK = "github\.com\/AsteroidHunter\/facilitator"/, "no https, no www");
  assert.match(code, /linkFont = s => `300 \$\{s\}px \$\{INTER\}`/, "the link is in Inter, light");
  assert.match(WIDGETS, /const INTER_LATIN = "[A-Za-z0-9+\/=]{40000,}"/, "Inter travels in the file");
  assert.match(WIDGETS, /new FontFace\(INTER_EXPORT, `url\(data:font\/woff2;base64,\$\{INTER_LATIN\}\)`/);
  assert.match(code, /rgba\(INK, 0\.3\); ctx\.fillRect\(x - 0\.5, top - 6, 1/, "Editorial's install line is thin and faint");
  assert.doesNotMatch(code, /--accent/);
  for (const hex of code.match(/#[0-9a-fA-F]{6}\b/g) || []) {
    const { h, s } = hsl(hex);
    assert.ok(!(h >= 250 && h <= 330 && s > 0.1), `${hex} is purple`);
  }
});

test("a picture's file is facilitator_, the day as eight figures and the first name, numbered after the day's first", () => {
  const { W } = widgets();
  const day = new Date(2026, 9, 20, 12).getTime();   // noon on October 20 wherever the tests run
  assert.equal(W.pictureName(day, "Robin Example"), "facilitator_20261020_Robin.png", "the first word, as typed");
  assert.equal(W.pictureName(day, "Robin Example", 1), "facilitator_20261020_Robin.png");
  assert.equal(W.pictureName(day, "Robin Example", 2), "facilitator_20261020_Robin_2.png");
  assert.equal(W.pictureName(day, "  Robin  ", 3), "facilitator_20261020_Robin_3.png");
  assert.equal(W.pictureName(day, "José", 1), "facilitator_20261020_José.png");
  assert.equal(W.pictureName(day, "../etc:x", 1), "facilitator_20261020_etcx.png", "nothing a path or a file system would read");
  assert.equal(W.pictureName(day, null), "facilitator_20261020.png", "no name, none in the file's name");
  assert.equal(W.pictureName(day, "", 2), "facilitator_20261020_2.png");
  assert.equal(W.pictureName(day, "?!", 1), "facilitator_20261020.png");
  assert.equal(W.pictureName(new Date(2027, 0, 5, 12).getTime(), "Robin"), "facilitator_20270105_Robin.png");
  // the day's count is kept in this browser: next reads it, take counts a file in
  const store = makeStore();
  const count = W.pictureCount(store);
  assert.equal(count.next(day), 1);
  assert.equal(count.next(day), 1, "reading counts nothing");
  assert.deepEqual([count.take(day), count.take(day), count.take(day)], [1, 2, 3], "three files in a row on one day");
  assert.equal(count.next(day), 4);
  assert.deepEqual(JSON.parse(store.getItem(W.PICTURES_KEY)), { day: "20261020", count: 3 });
  assert.equal(W.pictureCount(store).next(day), 4, "a page opened again goes on counting");
  assert.equal(count.next(day + 864e5), 1, "a new day starts again at the first");
  assert.equal(count.take(day + 864e5), 1);
  // with storage blocked, the page keeps its count in memory
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const held = W.pictureCount(blocked);
  assert.deepEqual([held.take(day), held.take(day)], [1, 2]);
  store.setItem(W.PICTURES_KEY, "not json");
  assert.equal(W.pictureCount(store).next(day + 2 * 864e5), 1);
});

// a panel with a reading, a page that records what it downloads and shares,
// timers fired by hand, and a profile that names Robin
async function savingPanel({ share = false, canShare = true, closed = false, name = "Robin Example", view = "line", installedAgo = 99 } = {}) {
  class FakeFile { constructor(parts, n, opts) { this.name = n; this.type = opts.type; } }
  const days = daysEnding("2026-09-27", 371);
  const { W } = widgets({ File: FakeFile, setTimeout: () => 0, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} } });
  const doc = makeDocument();
  doc.removeEventListener = () => {};
  const seen = { shared: [], clicked: [], canvases: [], states: [], asked: 0, painted: [] };
  doc.defaultView = {
    navigator: canShare ? { canShare: d => d.files.length === 1, share: async d => {
      if (closed) throw Object.assign(new Error("closed"), { name: "AbortError" });
      seen.shared.push([d.files[0].name, d.files[0].type, d.title]);
    } } : {},
    clickDownload: a => seen.clicked.push([a.download, a.href]),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  doc.documentElement = new El("html", doc);
  const make = doc.createElement;
  doc.createElement = tag => {
    const node = make(tag);
    if (tag === "canvas") {
      node.getContext = () => { const r = recording(); seen.painted.push(r); return r.ctx; };
      node.toBlob = fn => { seen.canvases.push([node.width, node.height]); fn({ size: 1 }); };
    }
    if (tag === "a") node.remove = () => {};
    return node;
  };
  const queue = [];
  const flush = async () => { for (let i = 0; i < 10; i++) await settle(); const next = queue.splice(0); next.forEach(([fn]) => fn()); for (let i = 0; i < 10; i++) await settle(); return next.map(([, ms]) => ms); };
  const cacheStore = makeStore();
  const root = new El("div", doc);
  const p = W.panel(root, { load: async () => ({ days, installed: days.at(-1 - installedAgo).date }), store: makeStore({ "home.chart": view }),
    cacheStore, share, now: () => new Date(2026, 9, 16, 12).getTime(),
    profile: async () => { seen.asked++; if (name instanceof Error) throw name; return name; },
    later: (fn, ms) => { queue.push([fn, ms]); return queue.length; }, cancel: () => {} });
  await p.refresh();
  const save = walk(root).find(n => n.className === "tk-save");
  seen.start = save.dataset.state;
  const first = p.download(), second = p.download();
  seen.states.push(save.dataset.state);
  seen.busyAria = save.getAttribute("aria-busy");
  await Promise.all([first.then(() => {}), flush().then(waits => { seen.spinWait = waits; }), second]);
  seen.states.push(save.dataset.state);
  // the overlay is up once the spinner has had its time, over the whole page
  const shot = p.overlay();
  seen.overlays = doc.body.children.filter(n => n.className.includes("tk-shot-veil")).length;
  seen.title = shot && shot.title.textContent;
  seen.look = shot && shot.box.dataset.look;
  seen.doneWait = await flush();
  seen.states.push(save.dataset.state);
  const count = () => JSON.parse(cacheStore.getItem("home.pictures") || "null");
  return { W, seen, shot, flush, count };
}

test("pressing the button saves the chart on show in its first look, the Poster median and band for the line, named for the day and the first name, and opens the overlay on it", async () => {
  const board = await savingPanel();
  const { seen } = board;
  assert.equal(seen.start, "idle");
  assert.deepEqual(seen.states, ["busy", "done", "idle"], "the spinner, then the check, then the download icon again");
  assert.equal(seen.busyAria, "true");
  assert.deepEqual(seen.spinWait, [500], "the spinner stays at least half a second");
  assert.deepEqual(seen.doneWait, [1500], "the check stays a moment");
  assert.equal(seen.asked, 1, "the first name is read once, for the one press that counts");
  assert.deepEqual(seen.canvases, [[3600, 1800]], "3x of 1200 x 600 for the line, once for the two presses");
  assert.deepEqual(seen.clicked, [["facilitator_20261016_Robin.png", "blob:x"]], "a download, named for the day and Robin");
  assert.deepEqual(board.count(), { day: "20261016", count: 1 });
  assert.equal(seen.overlays, 1, "one overlay for the two presses");
  assert.equal(seen.title, "Chart downloaded!");
  assert.equal(seen.look, "poster-band", "the Poster line, the two-week median and its band");
  // the file itself is that look: its key names the median and the band, and
  // nothing of the Editorial daily line is in it
  const saved = seen.painted[0].texts().map(t => String(t).trim());
  for (const words of ["2-week median", "1 sigma range", "Token consumption per day", " tokens this year".trim()])
    assert.ok(saved.includes(words), `the saved picture says ${words}`);
  assert.ok(!saved.includes("7-day average") && !saved.includes("Daily"), "not the Editorial daily line");
  assert.equal(board.shot.image().alt, "Token consumption per day, line chart, Poster, median and band");
  assert.equal(board.shot.dice.children[0].dataset.face, "1", "the die shows the first look's number");
  // the overlay's download button saves the chart on show as the day's second file
  board.shot.keep.click();
  await board.flush();
  assert.deepEqual(seen.clicked.at(-1), ["facilitator_20261016_Robin_2.png", "blob:x"]);
  assert.equal(board.shot.keep.dataset.state, "done");
  board.shot.keep.click();
  await board.flush();
  await board.flush();
  assert.deepEqual(seen.clicked.map(c => c[0]), ["facilitator_20261016_Robin.png", "facilitator_20261016_Robin_2.png",
                                                 "facilitator_20261016_Robin_3.png"], "three in a row on one day");
  assert.deepEqual(board.count(), { day: "20261016", count: 3 });
  // Share on the Mac hands the chart on show to the share sheet where the browser can
  board.shot.share.click();
  await board.flush();
  assert.deepEqual(seen.shared, [["facilitator_20261016_Robin_3.png", "image/png", "Token consumption per day"]]);

  const heat = await savingPanel({ view: "heatmap" });
  assert.deepEqual(heat.seen.canvases, [[3600, 1200]], "3x of 1200 x 400 for the heatmap");
  assert.equal(heat.seen.look, "editorial");
  // no name kept, or no answer: the file is named for the day alone
  for (const name of [null, new Error("offline")]) {
    const bare = await savingPanel({ name });
    assert.deepEqual(bare.seen.clicked, [["facilitator_20261016.png", "blob:x"]]);
  }
});

test("a phone that can share keeps the picture for the share sheet, and saves and shares through it", async () => {
  const phone = await savingPanel({ share: true });
  assert.deepEqual(phone.seen.clicked, [], "a phone that can share the file saves nothing on the press");
  assert.deepEqual(phone.seen.states, ["busy", "idle", "idle"], "nothing is saved yet, so no check");
  assert.equal(phone.seen.title, "Chart ready!");
  assert.equal(phone.count(), null, "nothing counted yet");
  phone.shot.share.click();
  await phone.flush();
  assert.deepEqual(phone.seen.shared, [["facilitator_20261016_Robin.png", "image/png", "Token consumption per day"]],
                   "the share sheet opens from the overlay's Share, with the day's next name");
  assert.equal(phone.count(), null, "a share is not a saved file");
  // the download button saves the phone's way, through the share sheet, and counts the file
  phone.shot.keep.click();
  await phone.flush();
  assert.equal(phone.seen.shared.length, 2);
  assert.deepEqual(phone.count(), { day: "20261016", count: 1 });
  assert.equal(phone.shot.keep.dataset.state, "done");
  const fallback = await savingPanel({ share: true, canShare: false });
  assert.equal(fallback.seen.shared.length, 0);
  assert.deepEqual(fallback.seen.clicked, [["facilitator_20261016_Robin.png", "blob:x"]], "a phone that cannot share a file downloads it");
  assert.equal(fallback.seen.title, "Chart downloaded!");
  const closed = await savingPanel({ share: true, closed: true });
  closed.shot.keep.click();
  await closed.flush();
  assert.deepEqual(closed.seen.shared, [], "a share sheet closed without sending sends nothing");
  assert.equal(closed.count(), null, "and counts nothing");
  assert.equal(closed.shot.keep.dataset.state, "idle");
  assert.equal(closed.shot.note.textContent, "", "and says nothing");
});

test("the download marks the install day only once 7 days have passed since it, in the picture and in every look the dice turns up", async () => {
  const marked = r => r.calls.some(c => (c[0] === "fillText" || c[0] === "strokeText") && c[1] === "Facilitator installed");
  const six = await savingPanel({ installedAgo: 6 }), seven = await savingPanel({ installedAgo: 7 });
  assert.equal(marked(six.seen.painted[0]), false, "6 days after install: the downloaded picture has no mark");
  assert.equal(marked(seven.seen.painted[0]), true, "7 days after install: it is marked");
  for (const [run, want] of [[six, false], [seven, true]]) {
    for (let i = 0; i < 5; i++) { run.shot.dice.click(); await run.flush(); }
    assert.equal(run.seen.painted.length, 6, "the download and the five other line looks");
    run.seen.painted.forEach((r, i) => assert.equal(marked(r), want, `picture ${i}`));
  }
});

// ---- the picture's overlay -----------------------------------------------------------
// a page for the overlay alone: the small DOM, its focus listeners and a
// navigator the test describes
function shotPage(nav = {}) {
  const doc = makeDocument();
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter(f => f !== fn); };
  doc.defaultView = { navigator: nav };
  return doc;
}
// one event to a node's own listeners, as the browser would hand it over
function send(node, type, fields = {}) {
  const e = { target: node, isComposing: false, stopped: false, prevented: false,
    stopPropagation() { e.stopped = true; }, preventDefault() { e.prevented = true; }, ...fields };
  for (const fn of node.listeners[type] || []) fn(e);
  return e;
}
function openShot(extra = {}, doc = shotPage()) {
  const timers = [], revoked = [], made = [], kept = [], shared = [];
  const { W } = widgets({ URL: { createObjectURL: b => "blob:" + b.id, revokeObjectURL: url => revoked.push(url) } });
  let luck = 0;
  const shot = W.overlay(doc, { blob: { size: 1, id: "first" }, name: "facilitator_20261020_Robin.png", kind: "line", saved: true,
    make: async (k, p) => { made.push(`${k}-${p}`); return { size: 2, id: `${k}-${p}` }; },
    keep: async blob => { kept.push(blob.id); return { outcome: "downloaded", name: "facilitator_20261020_Robin_2.png" }; },
    share: async (blob, name) => { shared.push([blob.id, name]); return "shared"; },
    later: (fn, ms) => { timers.push([fn, ms]); return timers.length; }, cancel: () => {},
    random: () => ((luck = (luck * 7 + 3) % 10) / 10), ...extra });
  const run = () => timers.splice(0).map(([fn, ms]) => { fn(); return ms; });
  return { W, doc, shot, timers, revoked, made, kept, shared, run, veil: doc.body.children[0], box: shot.box };
}

test("the overlay is the board's glass over the settings page's veil: Chart downloaded!, the pill and the cross, the picture let in flat, then the dice, the download button and Share", () => {
  const { W, doc, shot, veil, box } = openShot();
  assert.equal(veil, shot.root);
  assert.equal(veil.className, "qn-veil sp-veil tk-shot-veil open", "the settings page's veil, open");
  assert.equal(veil.getAttribute("aria-hidden"), "false");
  assert.equal(box.className, "qn-glass tk-shot", "the board's glass");
  assert.equal(box.dataset.kind, "line");
  assert.equal(box.dataset.look, "poster-band", "it opens on the line's first look, the Poster median and band");
  assert.equal(box.getAttribute("role"), "dialog");
  assert.equal(box.getAttribute("aria-modal"), "true");
  assert.equal(box.tabIndex, -1, "a press on bare glass keeps the focus in the box");
  assert.deepEqual(box.children.map(n => n.className), ["tk-shot-head", "tk-shot-frame", "tk-shot-foot"]);
  const [head, frame, foot] = box.children;
  // the top left says so, with no check and no file name; the pill stands left of the cross
  assert.deepEqual(head.children.map(n => n.className), ["tk-shot-title", "tk-pill tk-shot-kinds", "tk-shot-x"]);
  assert.equal(head.children[0].textContent, "Chart downloaded!");
  assert.equal(head.children[0].children.length, 0, "no check mark");
  assert.doesNotMatch(head.textContent, /facilitator_/);
  const pill = head.children[1];
  assert.deepEqual(pill.children.map(n => [n.className, n.textContent, n.dataset.view]),
    [["tk-thumb", "", undefined], ["tk-opt", "Heatmap", "heatmap"], ["tk-opt on", "Line", "line"]]);
  assert.equal(pill.dataset.on, "line");
  assert.deepEqual([shot.kinds.heatmap.getAttribute("aria-pressed"), shot.kinds.line.getAttribute("aria-pressed")], ["false", "true"]);
  const cross = head.children[2];
  assert.equal(cross.tagName, "BUTTON");
  assert.equal(cross.getAttribute("aria-label"), "Close");
  assert.match(cross.innerHTML, /M1\.936 1\.936L8\.064 8\.064M8\.064 1\.936L1\.936 8\.064/, "the card bar's cross");
  // the picture, let into the glass, with the dice's cover over it, away
  const pic = frame.children[0];
  assert.equal(pic, shot.image());
  assert.equal(pic.tagName, "IMG");
  assert.equal(pic.className, "tk-shot-pic");
  assert.equal(pic.dataset.kind, "line", "it carries its own shape");
  assert.equal(pic.src, "blob:first");
  assert.equal(frame.children[1], shot.cover);
  assert.equal(shot.cover.className, "tk-shot-cover");
  assert.equal(shot.cover.getAttribute("aria-hidden"), "true");
  assert.equal(pic.alt, "Token consumption per day, line chart, Poster, median and band");
  // the dice and the download button in the board's round glass, then Share, a glass pill with the link mark
  assert.deepEqual(foot.children.map(n => n.className), ["tk-shot-side", "qn-glass tk-shot-share", "tk-shot-note"]);
  assert.deepEqual(foot.children[0].children.map(n => n.className),
    ["qn-glass tk-shot-round tk-shot-dice", "qn-glass tk-shot-round tk-shot-keep"]);
  assert.equal(shot.dice.getAttribute("aria-label"), "Roll the dice for another look");
  assert.equal(shot.dice.children[0].dataset.face, "1", "the die shows the look's own number");
  assert.match(shot.dice.children[0].innerHTML, /<rect width="18" height="18" x="3" y="3" rx="3"\/><circle cx="12" cy="12"/);
  assert.equal(shot.keep.getAttribute("aria-label"), "Download this chart");
  assert.match(shot.keep.innerHTML, /<polyline points="7 10 12 15 17 10"\/>/);
  assert.equal(shot.keep.dataset.state, "idle");
  assert.match(shot.share.innerHTML, /<path d="M10 13a5 5 0 0 0 7\.54\.54l3-3a5 5 0 0 0-7\.07-7\.07l-1\.72 1\.71"\/>.*<span>Share<\/span>/);
  assert.equal(foot.children[2].getAttribute("role"), "status");
  assert.doesNotMatch(walk(box).map(n => n.innerHTML + n.textContent).join(" "), /Finder/, "no Open in Finder");
  assert.equal(doc.listeners.focusin.length, 1, "focus is held in the box while it is up");
  // a phone's, before anything is saved
  const phone = openShot({ saved: false, kind: "heatmap" });
  assert.equal(phone.box.dataset.kind, "heatmap");
  assert.equal(phone.box.dataset.look, "editorial");
  assert.equal(phone.shot.title.textContent, "Chart ready!");
  assert.equal(phone.box.children[1].children[0].alt, "Token consumption per day, heatmap, Editorial");
  assert.equal(phone.box.children[0].children[1].dataset.on, "heatmap");
  assert.equal(W.SHOT_TITLES.saved, "Chart downloaded!");
});

test("the cross, Escape and a press that starts and ends outside the box close the overlay, and it leaves the page", () => {
  const byCross = openShot();
  byCross.box.children[0].children[2].click();
  assert.equal(byCross.shot.isOpen(), false);
  assert.equal(byCross.veil.className, "qn-veil sp-veil tk-shot-veil", "the veil fades out");
  assert.equal(byCross.veil.getAttribute("aria-hidden"), "true");
  assert.deepEqual(byCross.doc.listeners.focusin, [], "the focus hold is let go");
  assert.equal(byCross.doc.body.children.length, 1, "still there while it fades");
  assert.deepEqual(byCross.run(), [320], "taken out once the .26s fade has run");
  assert.equal(byCross.doc.body.children.length, 0);
  assert.deepEqual(byCross.revoked, ["blob:first"], "and its picture's address with it");

  const byKey = openShot();
  const other = send(byKey.veil, "keydown", { key: "a" });
  assert.equal(other.stopped, true, "no key goes on to the page behind");
  assert.equal(byKey.shot.isOpen(), true);
  assert.equal(send(byKey.veil, "keydown", { key: "Escape", isComposing: true }).prevented, false, "an input method's Escape is its own");
  assert.equal(byKey.shot.isOpen(), true);
  const esc = send(byKey.veil, "keydown", { key: "Escape" });
  assert.equal(esc.prevented, true);
  assert.equal(byKey.shot.isOpen(), false);

  const byPress = openShot();
  send(byPress.veil, "pointerdown", { target: byPress.box });
  send(byPress.veil, "click", { target: byPress.veil });
  assert.equal(byPress.shot.isOpen(), true, "a drag out of the box let go on the veil does not close it");
  send(byPress.veil, "pointerdown", { target: byPress.veil });
  send(byPress.veil, "click", { target: byPress.box });
  assert.equal(byPress.shot.isOpen(), true, "nor a press inside the box");
  send(byPress.veil, "pointerdown", { target: byPress.veil });
  send(byPress.veil, "click", { target: byPress.veil });
  assert.equal(byPress.shot.isOpen(), false, "a press outside it does");
  byPress.shot.close();
  assert.deepEqual(byPress.run(), [320], "closing twice takes it out once");
});

test("the dice tumbles and swaps in each of the chart's other looks in turn, and the pill swaps the chart", async () => {
  const o = openShot();
  const { W, shot, box } = o;
  const pic = () => shot.image();
  const roll = async () => {
    shot.dice.click();
    assert.ok(shot.dice.classList.contains("rolling"), "it tumbles");
    assert.equal(shot.dice.getAttribute("aria-busy"), "true");
    shot.dice.click();   // a second press while it rolls does nothing
    await settle();
    const waits = o.run();
    assert.ok(waits.includes(W.ROLL_MS) && waits.length === 3, "the face turns twice on the way, then it lands");
    await settle();
    assert.ok(!shot.dice.classList.contains("rolling"));
    return shot.at();
  };
  assert.equal(W.ROLL_MS, 650);
  const lines = [0];
  for (let i = 0; i < 5; i++) {
    const at = await roll();
    assert.equal(at.kind, "line", "the dice keeps to the chart the pill names");
    assert.notEqual(at.pick, lines.at(-1), "every roll changes the look");
    assert.equal(box.dataset.look, W.DICE.line[at.pick].join("-"));
    assert.equal(pic().src, `blob:line-${at.pick}`);
    assert.equal(shot.dice.children[0].dataset.face, String(at.pick + 1), "and lands on the look's own number");
    lines.push(at.pick);
  }
  assert.deepEqual([...lines].sort(), [0, 1, 2, 3, 4, 5], "five rolls show all six line looks");
  assert.ok(!lines.slice(1).includes(0), "from the Poster median and band, the five rolls are the other five looks");
  assert.equal(o.made.length, 5, "each look is made once");
  // the pill: the heatmap in its first look, Editorial, and the dice then rolls through its three
  shot.kinds.heatmap.click();
  await settle();
  assert.deepEqual({ ...shot.at() },{ kind: "heatmap", pick: 0 });
  assert.equal(box.dataset.kind, "heatmap");
  assert.equal(box.children[0].children[1].dataset.on, "heatmap");
  assert.equal(shot.kinds.heatmap.getAttribute("aria-pressed"), "true");
  const heats = [0];
  for (let i = 0; i < 2; i++) heats.push((await roll()).pick);
  assert.deepEqual([...heats].sort(), [0, 1, 2], "two rolls show all three heatmaps");
  assert.ok(o.made.every(m => /^(line-[1-5]|heatmap-[0-2])$/.test(m)));
  // back to the line: its first look, the picture already made
  shot.kinds.line.click();
  await settle();
  assert.deepEqual({ ...shot.at() },{ kind: "line", pick: 0 });
  assert.equal(pic().src, "blob:first");
  assert.equal(o.made.filter(m => m === "line-0").length, 0);
  // a look that cannot be drawn says so and leaves the chart as it was
  const broken = openShot({ make: async () => { throw new Error("no"); } });
  broken.shot.dice.click();
  await settle(); broken.run(); await settle();
  assert.equal(broken.shot.note.textContent, "Could not draw that chart.");
  assert.deepEqual({ ...broken.shot.at() }, { kind: "line", pick: 0 });
  // put away mid-roll, its timers go with it
  const away = openShot();
  away.shot.dice.click();
  away.shot.close();
  assert.equal(away.timers.length, 4, "the turns, the landing and the fade");
  assert.deepEqual(away.revoked, []);
});

// a page for the overlay whose browser has the motion: every node animates,
// each run held where the test puts it (its currentTime) and read back
// through getComputedStyle as a browser reads a running animation, in a
// straight line; the frame is as tall as the picture in its flow, the line's
// 466 and the heatmap's a third of 932, unless a run holds it. still asks for
// reduced motion, and decode, when given, is each new picture's decode()
function motionPage({ still = false, decode } = {}) {
  const doc = shotPage(), runs = [];
  const make = doc.createElement;
  doc.createElement = tag => {
    const node = make(tag);
    node.animate = (frames, opts) => {
      const run = { node, frames, opts, currentTime: 0, playState: "running", onfinish: null,
        cancel() { run.playState = "idle"; },
        finish() { run.currentTime = opts.duration; run.playState = "finished"; if (run.onfinish) run.onfinish(); } };
      runs.push(run);
      return run;
    };
    if (tag === "img" && decode) node.decode = () => decode(node);
    return node;
  };
  const value = (node, prop) => {
    const run = runs.filter(r => r.node === node && r.playState !== "idle" && prop in r.frames[0]).at(-1);
    if (run && (run.playState === "running" || run.opts.fill === "forwards")) {
      const k = run.playState === "finished" ? 1 : Math.min(1, run.currentTime / run.opts.duration);
      const [a, b] = run.frames.map(f => parseFloat(f[prop]));
      return a + (b - a) * k;
    }
    if (prop === "opacity") return node.classList.contains("tk-shot-cover") && !node.classList.contains("on") ? 0 : 1;
    if (node.tagName === "IMG") return node.dataset.kind === "heatmap" ? 932 / 3 : 466;
    const flow = node.children.find(n => n.tagName === "IMG" && !n.classList.contains("going"));
    return flow ? value(flow, "height") : 0;
  };
  doc.defaultView.getComputedStyle = node => ({ height: value(node, "height") + "px", opacity: String(value(node, "opacity")) });
  doc.defaultView.matchMedia = q => ({ matches: still && q === "(prefers-reduced-motion: reduce)" });
  const on = node => runs.filter(r => r.node === node && r.playState !== "idle");
  const at = ms => { for (const r of runs) if (r.playState === "running") r.currentTime = Math.min(ms, r.opts.duration); };
  const finish = () => { for (const r of runs.slice()) if (r.playState === "running") r.finish(); };
  return { doc, runs, on, at, finish, value };
}
const plain = v => JSON.parse(JSON.stringify(v));
const HEAT_H = 932 / 3;

test("the pill glides the box to the other chart's height on a card picture's time and curve, the old picture fading off the new", async () => {
  const m = motionPage(), o = openShot({}, m.doc), { W, shot } = o;
  // the board's own timing: a card picture's zoom (card-logic.js)
  const logic = read("card-logic.js");
  assert.match(logic, new RegExp(`const CARD_PICTURE_MS = ${W.SHOT_GLIDE_MS};`));
  assert.ok(logic.includes(`const CARD_PICTURE_EASE = "${W.SHOT_GLIDE_EASE}";`));
  assert.deepEqual([W.SHOT_GLIDE_MS, W.SHOT_GLIDE_EASE], [300, "cubic-bezier(0.25, 1, 0.5, 1)"]);
  assert.equal(m.runs.length, 0, "nothing moves as it opens but the box's own fade");
  const line = shot.image();
  shot.kinds.heatmap.click();
  await settle();
  const heat = shot.image();
  assert.notEqual(heat, line);
  assert.deepEqual([heat.src, heat.dataset.kind, heat.dataset.slot], ["blob:heatmap-0", "heatmap", "heatmap:0"]);
  assert.equal(heat.alt, "Token consumption per day, heatmap, Editorial");
  // the new picture first, in the frame's flow, the old one over it on its way out
  assert.deepEqual(shot.frame.children.map(n => n.src || n.className), ["blob:heatmap-0", "blob:first", "tk-shot-cover"]);
  assert.ok(line.classList.contains("going") && !heat.classList.contains("going"));
  assert.deepEqual([line.alt, line.getAttribute("aria-hidden")], ["", "true"], "the one going is not read out");
  const [grow] = m.on(shot.frame), [fade] = m.on(line);
  assert.deepEqual(plain(grow.frames), [{ height: "466px" }, { height: HEAT_H + "px" }], "from the line's height to the heatmap's");
  assert.deepEqual(plain(grow.opts), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  assert.deepEqual(plain(fade.frames), [{ opacity: 1 }, { opacity: 0 }]);
  assert.deepEqual(plain(fade.opts), { duration: 300, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "forwards" }, "on the glide's own clock");
  assert.deepEqual(m.on(heat), [], "the new one is at full strength under the old from the start, so the two never dip");
  // halfway the frame is between the two heights, and the old picture half gone
  m.at(150);
  assert.equal(m.value(shot.frame, "height"), 466 + (HEAT_H - 466) / 2);
  assert.equal(m.value(line, "opacity"), 0.5);
  m.finish();
  assert.deepEqual(shot.frame.children.map(n => n.src || n.className), ["blob:heatmap-0", "tk-shot-cover"], "the old picture leaves once faded");
  assert.equal(m.value(shot.frame, "height"), HEAT_H, "and the frame is the heatmap's own height");
  // and back up, the heatmap fading off the line
  shot.kinds.line.click();
  await settle();
  const up = m.on(shot.frame).at(-1);
  assert.deepEqual(plain(up.frames), [{ height: HEAT_H + "px" }, { height: "466px" }]);
  assert.deepEqual(plain(m.on(heat).at(-1).frames), [{ opacity: 1 }, { opacity: 0 }]);
  assert.equal(shot.image().src, "blob:first", "the line's picture, already made");
});

test("pressed again mid-glide the switch turns round from where it is, in the time it had spent, and the picture going comes back", async () => {
  const m = motionPage(), o = openShot({}, m.doc), { shot } = o;
  const line = shot.image();
  shot.kinds.heatmap.click();
  await settle();
  const heat = shot.image(), [grow] = m.on(shot.frame), [fade] = m.on(line);
  m.at(120);
  const now = m.value(shot.frame, "height");
  assert.equal(now, 466 + (HEAT_H - 466) * 0.4);
  shot.kinds.line.click();
  await settle();
  assert.equal(shot.image(), line, "the line's own picture comes back, not a new one");
  assert.deepEqual(shot.frame.children.map(n => n.src || n.className), ["blob:heatmap-0", "blob:first", "tk-shot-cover"]);
  assert.ok(heat.classList.contains("going") && !line.classList.contains("going"));
  assert.equal(line.getAttribute("aria-hidden"), null);
  assert.deepEqual([grow.playState, fade.playState], ["idle", "idle"], "the glide and the fade are let go");
  const back = m.on(shot.frame).at(-1);
  assert.deepEqual(plain(back.frames), [{ height: now + "px" }, { height: "466px" }], "from where the frame had got to");
  assert.equal(back.opts.duration, 120, "in the 120ms it had spent");
  const going = m.on(heat).at(-1);
  assert.equal(going.frames[0].opacity.toFixed(6), (0.4).toFixed(6), "the heatmap over the line shows what the line did not: 1 less 0.6");
  assert.equal(going.opts.duration, 120);
  // a turn soon after the press takes no less than .4 of the whole
  shot.kinds.heatmap.click();
  await settle();
  m.at(10);
  shot.kinds.line.click();
  await settle();
  assert.equal(m.on(shot.frame).at(-1).opts.duration, 120);
  m.finish();
  assert.deepEqual(shot.frame.children.map(n => n.src || n.className), ["blob:first", "tk-shot-cover"]);
  assert.deepEqual(o.made, ["heatmap-0"], "nothing is made twice");
});

test("a dice look turned round to comes back as that look, and once its fade is over the pill gives the chart's first look as before", async () => {
  const m = motionPage(), o = openShot({}, m.doc), { shot } = o;
  shot.dice.click();
  await settle(); o.run(); await settle();
  m.finish();
  const rolled = shot.at().pick;
  assert.notEqual(rolled, 0);
  shot.kinds.heatmap.click();
  await settle();
  m.at(100);
  shot.kinds.line.click();
  await settle();
  assert.deepEqual({ ...shot.at() }, { kind: "line", pick: rolled }, "the look still fading out comes back");
  assert.equal(shot.dice.children[0].dataset.face, String(rolled + 1));
  m.finish();
  shot.kinds.heatmap.click();
  await settle();
  m.finish();
  shot.kinds.line.click();
  await settle();
  assert.deepEqual({ ...shot.at() }, { kind: "line", pick: 0 }, "a settled switch shows the line's first look, the Poster median and band");
});

test("the dice covers the picture with the paper and a spinner until the next look is drawn, then fades the look in as the cover goes", async () => {
  const m = motionPage(), o = openShot({}, m.doc), { W, shot } = o;
  const first = shot.image();
  assert.match(shot.cover.innerHTML, /<path d="M21 12a9 9 0 1 1-6\.219-8\.56"\/>/, "the download button's spinner");
  assert.equal(shot.cover.classList.contains("on"), false);
  shot.dice.click();
  assert.ok(shot.cover.classList.contains("on"), "the cover comes up at the press");
  const [up] = m.on(shot.cover);
  assert.deepEqual(plain(up.frames), [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(plain(up.opts), { duration: W.SHOT_COVER_MS, easing: W.SHOT_COVER_EASE });
  assert.deepEqual([W.SHOT_COVER_MS, W.SHOT_COVER_EASE], [180, "cubic-bezier(.42,.06,.38,1)"]);
  assert.match(read("card-tokens.css"), /--gentle:cubic-bezier\(\.42,\.06,\.38,1\);/, "the board's gentle curve");
  assert.ok(shot.dice.classList.contains("rolling"), "the die still tumbles in its circle");
  // the next look is made and ready, but stays under the cover until the die lands
  await settle();
  m.finish();
  const runs = m.runs.length, timers = o.timers.length;
  shot.dice.click();
  assert.deepEqual([m.runs.length, o.timers.length, o.made.length], [runs, timers, 1], "a press while it rolls does nothing");
  assert.equal(shot.image(), first);
  assert.equal(m.value(shot.cover, "opacity"), 1, "the cover holds");
  assert.deepEqual(o.run().at(-1), W.ROLL_MS);
  await settle();
  const next = shot.image();
  assert.notEqual(next, first);
  assert.equal(next.src, `blob:line-${shot.at().pick}`);
  assert.equal(shot.cover.classList.contains("on"), false);
  const away = m.on(shot.cover).at(-1), fade = m.on(first).at(-1);
  assert.deepEqual(plain(away.frames), [{ opacity: 1 }, { opacity: 0 }], "the cover goes from where it is");
  assert.deepEqual(plain(fade.frames), [{ opacity: 1 }, { opacity: 0 }], "the look on show fades off the next");
  for (const r of [away, fade]) assert.deepEqual([r.opts.duration, r.opts.easing], [300, "cubic-bezier(0.25, 1, 0.5, 1)"]);
  assert.deepEqual(m.on(shot.frame), [], "the line's looks are one height, so the box keeps its size");
  assert.equal(shot.dice.classList.contains("rolling"), false);
  m.finish();
  assert.deepEqual(shot.frame.children.map(n => n.src || n.className), [next.src, "tk-shot-cover"]);
  // a look that cannot be drawn takes the cover away and says so
  const b = motionPage(), broken = openShot({ make: async () => { throw new Error("no"); } }, b.doc);
  broken.shot.dice.click();
  await settle(); broken.run(); await settle();
  assert.equal(broken.shot.cover.classList.contains("on"), false);
  assert.equal(broken.shot.note.textContent, "Could not draw that chart.");
  assert.equal(broken.shot.image().src, "blob:first");
});

test("with reduced motion the box takes its new size at once and the pictures and the cover only fade, quickly", async () => {
  const m = motionPage({ still: true }), o = openShot({}, m.doc), { W, shot } = o;
  const line = shot.image();
  shot.kinds.heatmap.click();
  await settle();
  assert.deepEqual(m.on(shot.frame), [], "no glide");
  assert.equal(m.value(shot.frame, "height"), HEAT_H, "the heatmap's height straight away");
  const [fade] = m.on(line);
  assert.deepEqual(plain(fade.opts), { duration: W.SHOT_STILL_MS, easing: "ease", fill: "forwards" });
  assert.equal(W.SHOT_STILL_MS, 160, "the magic box's quick fade");
  assert.match(read("index.html"), /BIG_FADE_MS = 160;/);
  m.finish();
  shot.dice.click();
  assert.deepEqual(plain(m.on(shot.cover).at(-1).opts), { duration: 180, easing: "cubic-bezier(.42,.06,.38,1)" });
  await settle(); m.finish(); o.run(); await settle();
  assert.deepEqual(plain(m.on(shot.cover).at(-1).opts), { duration: 160, easing: "ease" });
  assert.deepEqual(m.on(shot.frame), []);
});

test("a picture is decoded before it goes in, so it never comes in blank", async () => {
  const held = [];
  const m = motionPage({ decode: node => new Promise(done => held.push({ node, done })) }), o = openShot({}, m.doc), { shot } = o;
  shot.kinds.heatmap.click();
  await settle();
  assert.equal(held.length, 1);
  assert.equal(held[0].node.src, "blob:heatmap-0");
  assert.equal(shot.image().src, "blob:first", "nothing changes while it decodes");
  assert.deepEqual(m.runs, []);
  held[0].done();
  await settle();
  assert.equal(shot.image(), held[0].node);
  assert.equal(m.on(shot.frame).length, 1, "then the glide");
});

test("the frame holds each picture at its own shape over its middle, and the cover is the paper with a turning spinner", () => {
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => (css.match(new RegExp("(?:^|\\})\\s*" + sel.replace(/[.[\]"=():,*]/g, "\\$&") + "\\{([^}]*)\\}")) || [])[1] || "";
  assert.match(rule(".tk-shot-frame"), /position:relative; display:flex; flex-direction:column; justify-content:center;/);
  assert.match(rule(".tk-shot-frame"), /border-radius:7px; overflow:hidden; background:#fff$/, "white under a white picture, so no band shows as it glides");
  assert.match(rule(".tk-shot-pic"), /^flex:none;/, "a picture keeps its height in a frame that is gliding");
  assert.match(rule(".tk-shot-pic.going"), /position:absolute; left:0; top:50%; transform:translateY\(-50%\)/);
  assert.match(rule(".tk-shot-cover"), /position:absolute; inset:0; display:grid; place-items:center; pointer-events:none; opacity:0;/);
  assert.match(rule(".tk-shot-cover"), /background:color-mix\(in srgb, #fff 55%, transparent\)/, "the pictures' own white");
  assert.match(rule(".tk-shot-cover"), /backdrop-filter:blur\(3px\)/);
  assert.match(rule(".tk-shot-cover.on"), /opacity:1/);
  assert.match(rule(".tk-shot-cover svg"), /width:20px; height:20px; color:var\(--sub\); animation:tk-save-turn \.9s linear infinite/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\{[^@]*\.tk-shot-cover svg\{animation-duration:2\.4s\}/);
  // the motion is the overlay's own, run from home-widgets.js, which every
  // page's reduced motion rule leaves alone; the sheet adds no transition
  const sheet = css.slice(css.indexOf(".tk-shot-veil"));
  assert.doesNotMatch(sheet, /transition:[^;}]*height/);
});

test("the download button saves the chart on show as a new file, with the spinner and the check, and says what went wrong", async () => {
  const o = openShot();
  o.shot.dice.click();
  await settle(); o.run(); await settle();
  const look = o.shot.at().pick;
  o.shot.keep.click();
  assert.equal(o.shot.keep.dataset.state, "busy");
  assert.equal(o.shot.keep.getAttribute("aria-busy"), "true");
  o.shot.keep.click();
  await settle();
  assert.deepEqual(o.kept, [`line-${look}`], "the look on show, once while it is at work");
  assert.deepEqual(o.run(), [500], "the spinner at least half a second");
  await settle();
  assert.equal(o.shot.keep.dataset.state, "done");
  assert.deepEqual(o.run(), [1500], "the check for a moment");
  assert.equal(o.shot.keep.dataset.state, "idle");
  // Share now sends that file by its name, and the first picture by its own
  o.shot.share.click();
  await settle();
  assert.deepEqual(o.shared, [[`line-${look}`, "facilitator_20261020_Robin_2.png"]]);
  // a look not saved is shared with no name of its own; the panel names it
  o.shot.dice.click();
  await settle(); o.run(); await settle();
  o.shot.share.click();
  await settle();
  assert.equal(o.shared.at(-1)[1], null);
  const failed = openShot({ keep: async () => { throw new Error("no"); } });
  failed.shot.keep.click();
  await settle(); failed.run(); await settle();
  assert.equal(failed.shot.note.textContent, "Could not save the picture.");
  assert.equal(failed.shot.keep.dataset.state, "idle");
});

test("Share hands the file to the share sheet where the browser can, and otherwise copies the picture and says so", async () => {
  class FakeFile { constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts.type; } }
  class FakeItem { constructor(items) { this.items = items; } }
  const blob = { size: 1 };
  const outcome = async nav => {
    const { W } = widgets({ File: FakeFile, ClipboardItem: FakeItem });
    return W.sharePicture({ navigator: nav }, blob, "facilitator_20261020_Robin.png");
  };
  const sent = [], wrote = [];
  assert.equal(await outcome({ canShare: d => d.files[0].type === "image/png", share: async d => sent.push(d) }), "shared");
  assert.equal(sent[0].files[0].name, "facilitator_20261020_Robin.png");
  assert.equal(sent[0].files[0].parts[0], blob);
  assert.equal(sent[0].title, "Token consumption per day");
  assert.equal(await outcome({ canShare: () => true, share: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); } }),
    "closed", "a sheet put away unsent");
  const clipboard = { write: async items => wrote.push(items) };
  assert.equal(await outcome({ canShare: () => false, clipboard }), "copied", "no file sharing: the clipboard");
  assert.equal(await outcome({ clipboard }), "copied", "no Web Share at all: the clipboard");
  assert.equal(wrote[0][0].items["image/png"], blob, "the picture itself, as a PNG");
  assert.equal(await outcome({ canShare: () => true, share: async () => { throw new Error("denied"); }, clipboard }), "copied",
    "a share that failed for another reason falls back to a copy");
  assert.equal(await outcome({ clipboard: { write: async () => { throw new Error("no"); } } }), "failed");
  assert.equal(await outcome({}), "failed");

  // on the button: Copied for a moment, as the download button's check stays
  const copied = openShot({ share: () => Promise.resolve("copied") });
  copied.shot.share.click();
  await settle();
  assert.match(copied.shot.share.innerHTML, /<path d="M20 6 9 17l-5-5"\/>.*<span>Copied<\/span>/);
  assert.deepEqual(copied.run(), [1500]);
  assert.match(copied.shot.share.innerHTML, /<span>Share<\/span>/);
  assert.equal(copied.shot.note.textContent, "");
  const failed = openShot({ share: () => Promise.resolve("failed") });
  failed.shot.share.click();
  await settle();
  assert.equal(failed.shot.note.textContent, "Could not share the picture.");
  const closed = openShot({ share: () => Promise.resolve("closed") });
  closed.shot.share.click();
  await settle();
  assert.equal(closed.shot.note.textContent, "", "a sheet put away unsent says nothing");
  assert.match(closed.shot.share.innerHTML, /<span>Share<\/span>/);
});

test("the overlay's box is only as tall as what it holds, the picture let in flat, Share in the middle of its row", () => {
  const css = read("home-widgets.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = sel => (css.match(new RegExp("(?:^|\\})\\s*" + sel.replace(/[.[\]"=():,*]/g, "\\$&") + "\\{([^}]*)\\}")) || [])[1] || "";
  const box = rule(".tk-shot");
  assert.match(box, /--shot-w:min\(960px, calc\(100vw - 96px\), calc\(\(100vh - 196px\) \* 2\)\); --shot-m:14px/);
  assert.match(box, /display:flex; flex-direction:column; gap:var\(--shot-m\);/);
  assert.match(box, /width:var\(--shot-w\); padding:var\(--shot-m\)/);
  assert.doesNotMatch(css.slice(css.indexOf(".tk-shot-veil")), /min-height:calc|justify-content:space-between/, "no room left over to share out");
  assert.match(rule(".tk-shot-pic"), /width:100%; height:auto; aspect-ratio:2 \/ 1/);
  assert.match(rule('.tk-shot-pic[data-kind="heatmap"]'), /aspect-ratio:3 \/ 1/);
  // let in, not lifted: an inner shade and hairline over its edge, the board's
  // folder well's, and no shadow under it
  assert.doesNotMatch(rule(".tk-shot-pic"), /box-shadow/);
  assert.doesNotMatch(rule(".tk-shot-frame"), /box-shadow/);
  assert.match(rule(".tk-shot-frame::after"), /box-shadow:inset 0 1px 6px rgba\(60,45,20,\.14\), inset 0 0 0 1px rgba\(60,45,20,\.08\)/);
  assert.match(HTML, /box-shadow:inset 0 1px 6px rgba\(60,45,20,\.14\), inset 0 0 0 1px rgba\(60,45,20,\.08\)/, "the folder well's own");
  // the row: Share in the middle column, the two circles right against it on its left
  assert.match(rule(".tk-shot-foot"), /display:grid; grid-template-columns:minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(rule(".tk-shot-side"), /justify-content:flex-end/);
  // the glass: circles as the bar's, Share as home's open a new folder pill
  assert.match(css, /\.tk-shot \.qn-glass\.tk-shot-round\{width:32px; padding:0; border-radius:50%; color:var\(--sub\)\}/);
  assert.match(css, /\.tk-shot \.qn-glass\.tk-shot-share\{gap:7px; padding:0 15px 0 13px; border-radius:16px; font:400 14px\/17px var\(--sans\)/);
  assert.match(HTML, /body\.focus #npstart\.qn-glass\{[^}]*height:32px;[^}]*border-radius:16px;[^}]*font:400 14px\/17px var\(--sans\)/s);
  assert.match(css, /\.tk-shot-dice\.rolling \.tk-die\{animation:tk-die-roll \.65s/);
  // on a phone the three are centred as one row, at a finger's height
  const phone = /@media \(max-width:600px\)\{([^@]*?)\n\}/.exec(css)[1];
  assert.match(phone, /\.tk-shot-foot\{display:flex; flex-wrap:wrap; justify-content:center\}/);
  assert.match(phone, /height:44px/);
  // the sizes the board's window gives it: the line's box is its picture's
  // height and 108px, the heatmap's shorter by the height the wider picture saves
  const w = 960, m = 14, head = 26, foot = 32;
  const height = pic => 2 * m + head + foot + 2 * m + pic;
  assert.equal(height((w - 2 * m) / 2), 580);
  assert.ok(Math.abs(height((w - 2 * m) / 3) - 424.7) < 0.1);
  // nothing new in colour: the board's inks, its glass and the panel's own marks
  const sheet = css.slice(css.indexOf(".tk-shot-veil"));
  for (const hex of sheet.match(/#[0-9a-fA-F]{3,6}\b/g) || []) assert.ok(["#FF7A72", "#1e1e1e", "#fff", "#000", "#E0592B"].includes(hex), hex);
  assert.doesNotMatch(sheet, /432BFF|--accent/i);
});

test("Open in Finder and its route are gone, and the phone's door has nothing of it", () => {
  assert.doesNotMatch(WIDGETS, /Finder|picture\/reveal|revealPicture/);
  assert.doesNotMatch(SERVER, /picture\/reveal|_post_picture_reveal|_picture_saved|PICTURE_REVEAL_BODY/);
  assert.doesNotMatch(read("bridge_gate.py"), /picture\/reveal/);
  assert.ok(!fs.existsSync(path.join(ROOT, "tests", "picture-reveal.test.cjs")));
});
