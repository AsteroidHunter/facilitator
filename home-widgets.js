// The home page's widgets: the tokens the local coding agents spent, drawn two
// ways from one reading of GET /tokens/daily, and the panel that holds them.
//
//   heatmap  a year as 53 week columns of 7 day squares, Sunday on top, the way
//            a contribution graph is drawn. One square per day of the last
//            365, a red-orange scale from light to deep by where the day
//            falls among the year's active days (quartiles), a faint warm
//            grey for a day with none, month names over the columns, a total
//            for the year and a hover tip with the day and its count
//   line     the same days as one line: each day's trailing 7-day average,
//            since single days jump between nothing and a great deal. The
//            tip leads with that average, the number the dot stands at, and
//            names the day's own count under it, smaller, as that day alone
//   panel    one rectangle holding one of the two at a time and a two-way
//            pill to switch them; the choice is remembered in this browser
//   view     both charts are drawn at their own size, one unit to a pixel,
//            never stretched or squeezed to the panel: the heatmap as its
//            short strip, the line as tall as the view. A panel narrower than
//            a chart shows it through a view that scrolls sideways the native
//            way (trackpad, shift and the wheel), opening on the latest weeks
//            at the right end. The axis names on the left stay put while the
//            chart passes under them, and a soft fade marks each side with
//            more to see; no scrollbar, like every scroller on the board. Each
//            chart keeps its own place while the page is open, and one left
//            at its latest end stays there as new days arrive
//
// Each widget is a function of (element, days) that draws into the element
// it is given and owns nothing outside it, so either can later sit in a shared
// widget system on its own. The drawing is plain SVG written as text; the
// models under it are plain data, which is what the tests hold them to.
// Nothing here fetches except the panel, and only /tokens/daily.
(function () {
  const WEEKS = 53, CELL = 11, GAP = 3, STEP = CELL + GAP;
  const LEFT = 30, TOP = 18;                    // room for the day and month names
  const GRID_W = LEFT + WEEKS * STEP - GAP, GRID_H = TOP + 7 * STEP - GAP;
  // the scale: a warm grey for nothing, then four red-oranges, light to deep
  const PALETTE = ["#EEEAE4", "#FCD8C2", "#F7A67C", "#EC6B3C", "#C9401B"];
  const LINE = "#E0592B";
  const YEAR = 365, AVG = 7;
  // the panel asks for the year and the six days before it, so the line's
  // first average is a whole week's like every other
  const FETCH_DAYS = YEAR + AVG - 1;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const VIEWS = [["heatmap", "Heatmap"], ["line", "Line"]];
  const VIEW_KEY = "home.chart";

  // ---- numbers and days ----------------------------------------------------
  // 1234 is 1.23K, 48210000 is 48.2M: three figures at most, trailing zeros off
  function compact(n) {
    n = Math.max(0, Number(n) || 0);
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (let i = 0; i < units.length; i++) {
      const [size, unit] = units[i];
      if (n < size) continue;
      const shown = Number((n / size).toPrecision(3));
      // 999.6K rounds to 1000K, which is 1M
      if (shown >= 1000 && i > 0) return Number((n / units[i - 1][0]).toPrecision(3)) + units[i - 1][1];
      return shown + unit;
    }
    return String(Math.round(n));
  }
  // a day as written by the route, read as a calendar day with no zone at all
  function parts(date) {
    const [y, m, d] = date.split("-").map(Number);
    return { y, m, d, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  }
  function longDay(date) {
    const p = parts(date);
    return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
  }
  function shortDay(date) {
    const p = parts(date);
    return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.m - 1]} ${p.d}`;
  }
  // "Sep 15 to Sep 21, 2026", the first year named too when the two differ,
  // and one day on its own as just that day
  function dayRange(from, to) {
    const a = parts(from), b = parts(to);
    const last = `${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
    if (from === to) return last;
    return `${MONTHS[a.m - 1]} ${a.d}${a.y !== b.y ? ", " + a.y : ""} to ${last}`;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const r1 = n => Math.round(n * 10) / 10;

  // ---- the colour scale ----------------------------------------------------
  // the year's active days, cut at their quartiles: a day at or past the top
  // quartile is the deepest red, one under the first is the lightest. Ranking
  // rather than a straight share of the busiest day keeps one enormous day
  // from washing every other square out to the lightest step
  function quantile(sorted, q) {
    const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  }
  function scale(values) {
    const active = values.filter(v => v > 0).sort((a, b) => a - b);
    const cuts = active.length ? [0.25, 0.5, 0.75].map(q => quantile(active, q)) : [];
    const level = v => {
      if (!(v > 0) || !cuts.length) return 0;
      if (v >= cuts[2]) return 4;
      if (v >= cuts[1]) return 3;
      if (v >= cuts[0]) return 2;
      return 1;
    };
    return { cuts, level, colour: v => PALETTE[level(v)] };
  }

  // ---- the heatmap ---------------------------------------------------------
  function heatmapModel(days) {
    const year = days.slice(-YEAR);
    const sc = scale(year.map(d => d.total));
    const lead = year.length ? parts(year[0].date).weekday : 0;
    const cells = year.map((d, i) => {
      const col = Math.floor((lead + i) / 7), row = (lead + i) % 7;
      return { i, date: d.date, total: d.total, col, row, level: sc.level(d.total),
               fill: sc.colour(d.total), x: LEFT + col * STEP, y: TOP + row * STEP };
    });
    // a month is named over the column its first day falls in, and the
    // partial month the year starts in only when the next name leaves room
    const months = [];
    for (const c of cells) {
      const p = parts(c.date);
      if (p.d === 1 && c.col <= WEEKS - 2) months.push({ col: c.col, label: MONTHS[p.m - 1] });
    }
    if (cells.length && (!months.length || months[0].col >= 3) && parts(cells[0].date).d !== 1)
      months.unshift({ col: 0, label: MONTHS[parts(cells[0].date).m - 1] });
    return { cells, months, weeks: WEEKS, cuts: sc.cuts,
             total: year.reduce((s, d) => s + (d.total || 0), 0) };
  }
  // the chart as first drawn, at its own size. The day names are drawn apart
  // (heatPin) into the same place, where they stay while the chart scrolls
  function heatmapSvg(model) {
    const out = [`<svg class="tk-heat" width="${GRID_W}" height="${GRID_H}" viewBox="0 0 ${GRID_W} ${GRID_H}" ` +
                 `role="img" aria-label="${esc(compact(model.total))} tokens in the last year, one square per day">`];
    for (const m of model.months)
      out.push(`<text class="tk-axis" x="${LEFT + m.col * STEP}" y="${TOP - 7}">${m.label}</text>`);
    for (const c of model.cells)
      out.push(`<rect class="tk-day" data-i="${c.i}" x="${c.x}" y="${c.y}" width="${CELL}" ` +
               `height="${CELL}" rx="2" fill="${c.fill}"/>`);
    out.push("</svg>");
    return out.join("");
  }
  function heatPin() {
    const out = [`<svg width="${LEFT}" height="${GRID_H}" viewBox="0 0 ${LEFT} ${GRID_H}" aria-hidden="true">`];
    for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]])
      out.push(`<text class="tk-axis" x="0" y="${TOP + row * STEP + CELL - 2}">${name}</text>`);
    out.push("</svg>");
    return out.join("");
  }
  function legendHtml() {
    return `<span class="tk-legend">Less${PALETTE.map(c =>
      `<i style="background:${c}"></i>`).join("")}More</span>`;
  }
  // a square is one day, and its tip says so
  function heatTip(cell) {
    return cell.total > 0
      ? `<b>${esc(compact(cell.total))} tokens that day</b><span>${esc(longDay(cell.date))}</span>`
      : `<b>No tokens that day</b><span>${esc(longDay(cell.date))}</span>`;
  }
  function drawHeatmap(el, days, spot) {
    const model = heatmapModel(days);
    el.tkModel = { kind: "heatmap", model };
    el.innerHTML = viewHtml(heatmapSvg(model), heatPin(), LEFT) +
      `<div class="tk-foot"><span class="tk-sum"><b>${esc(compact(model.total))}</b> tokens in the last year</span>` +
      `${legendHtml()}</div><div class="tk-tip" hidden></div>`;
    seat(el, spot);
    wire(el);
    return model;
  }

  // ---- the line ------------------------------------------------------------
  // the line is as wide as the heatmap, so both scroll the same way, and as
  // tall as the whole view (home-widgets.css), which the heatmap sits in the
  // middle of: the panel holds still when the pill switches between them, and
  // the line reads at a glance instead of in the heatmap's short strip
  const VIEW_H = 192;
  const LW = GRID_W, LH = VIEW_H;
  const PAD = { left: 46, right: 8, top: 10, bottom: 24 };
  // the trailing mean over each day and the six before it; the first days of
  // a reading shorter than a week average what there is
  function rolling(values, n = AVG) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i] || 0;
      if (i >= n) sum -= values[i - n] || 0;
      out.push(sum / Math.min(i + 1, n));
    }
    return out;
  }
  // a top for the axis that halves to a round number: 2 x (1, 2, 2.5 or 5 x 10^k)
  function niceTop(max) {
    if (!(max > 0)) return 1;
    const half = max / 2, mag = Math.pow(10, Math.floor(Math.log10(half)));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= half);
    return 2 * step;
  }
  function lineModel(days) {
    const avg = rolling(days.map(d => d.total || 0)).slice(-YEAR);
    const shown = days.slice(-YEAR);
    const top = niceTop(Math.max(0, ...avg));
    const w = LW - PAD.left - PAD.right, h = LH - PAD.top - PAD.bottom;
    const n = shown.length;
    const xAt = i => PAD.left + (n > 1 ? i * w / (n - 1) : w / 2);
    const yAt = v => PAD.top + h - (v / top) * h;
    // each point also knows the days its average was taken over: the day
    // itself and the six before it, fewer only where the reading begins
    const lead = days.length - n;
    const points = shown.map((d, i) => {
      const first = Math.max(0, lead + i - AVG + 1);
      return { i, date: d.date, total: d.total || 0, avg: avg[i], from: days[first].date,
               span: lead + i - first + 1, x: r1(xAt(i)), y: r1(yAt(avg[i])) };
    });
    const months = points.filter(p => parts(p.date).d === 1 && p.x < LW - PAD.right - 22)
      .map(p => ({ x: p.x, label: MONTHS[parts(p.date).m - 1] }));
    return { points, months, top, ticks: [0, top / 2, top], yAt, box: { ...PAD, w, h } };
  }
  let fades = 0;   // each drawing's own gradient id, so two lines on a page never share one
  function lineSvg(model) {
    const { points, box } = model;
    const base = box.top + box.h;
    const path = points.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join("");
    const fade = "tk-fade-" + (++fades);
    const out = [`<svg class="tk-line" width="${LW}" height="${LH}" viewBox="0 0 ${LW} ${LH}" role="img" ` +
                 `aria-label="tokens per day, 7-day average, over the last year">`,
                 `<defs><linearGradient id="${fade}" x1="0" y1="0" x2="0" y2="1">` +
                 `<stop offset="0" stop-color="${LINE}" stop-opacity=".2"/>` +
                 `<stop offset="1" stop-color="${LINE}" stop-opacity="0"/></linearGradient></defs>`];
    for (const t of model.ticks) {
      const y = r1(model.yAt(t));
      out.push(`<line class="tk-grid" x1="${box.left}" x2="${box.left + box.w}" y1="${y}" y2="${y}"/>`);
    }
    for (const m of model.months)
      out.push(`<text class="tk-axis line" x="${m.x}" y="${LH - 5}">${m.label}</text>`);
    if (points.length) {
      out.push(`<path class="tk-area" d="${path}L${points.at(-1).x} ${base}L${points[0].x} ${base}Z" fill="url(#${fade})"/>`);
      out.push(`<path class="tk-path" d="${path}" fill="none" stroke="${LINE}"/>`);
    }
    out.push(`<line class="tk-guide" x1="0" x2="0" y1="${box.top}" y2="${base}" visibility="hidden"/>`);
    out.push(`<circle class="tk-dot" r="5" cx="0" cy="0" fill="${LINE}" visibility="hidden"/>`);
    out.push(`<rect class="tk-hit" x="${box.left}" y="${box.top}" width="${box.w}" height="${box.h}" fill="transparent"/>`);
    out.push("</svg>");
    return out.join("");
  }
  // the count names up the left, drawn apart into the place they held, where
  // they stay while the line scrolls
  function linePin(model) {
    const out = [`<svg width="${PAD.left}" height="${LH}" viewBox="0 0 ${PAD.left} ${LH}" aria-hidden="true">`];
    for (const t of model.ticks)
      out.push(`<text class="tk-axis line" x="${PAD.left - 8}" y="${r1(model.yAt(t)) + 4}" text-anchor="end">${compact(t)}</text>`);
    out.push("</svg>");
    return out.join("");
  }
  // the tip leads with what the line and its dot show, the average, which can
  // never pass the top of the axis. The day's own count comes second, smaller
  // and named as that one day, since a single busy day can stand well above
  // the line; then the days the average was taken over
  function lineTip(p) {
    return `<b>${esc(compact(p.avg))} a day, ${p.span}-day average</b>` +
           `<span>${esc(compact(p.total))} on ${esc(shortDay(p.date))} alone</span>` +
           `<span>Averaged over ${esc(dayRange(p.from, p.date))}</span>`;
  }
  function drawLine(el, days, spot) {
    const model = lineModel(days);
    el.tkModel = { kind: "line", model };
    el.innerHTML = viewHtml(lineSvg(model), linePin(model), PAD.left) +
      `<div class="tk-foot"><span class="tk-sum">Tokens per day, 7-day average</span></div>` +
      `<div class="tk-tip" hidden></div>`;
    seat(el, spot);
    wire(el);
    return model;
  }

  // ---- the view ------------------------------------------------------------
  // the chart in a lane that scrolls sideways, its axis names pinned over the
  // lane's left edge. The view around the lane is taller than the chart and
  // holds it in the middle, so the panel keeps one height for both charts
  function viewHtml(chart, pin, pinWidth) {
    return `<div class="tk-view"><div class="tk-lane">` +
      `<div class="tk-scroll"><div class="tk-chart">${chart}</div></div>` +
      `<div class="tk-pin" style="width:${pinWidth}px">${pin}</div>` +
      `</div></div>`;
  }
  // where a chart's view stands: at its latest end, or a place scrolled back to
  const latest = () => ({ end: true, left: 0 });
  // put a freshly drawn chart's view where it stood, the latest end the first
  // time, and follow it from then on. A view at its end stays at the end when
  // a redraw brings a new day; one scrolled back keeps its place. The fades
  // name the sides that have more: more-left once the chart has moved under
  // the pinned names, more-right until the latest end is in view
  function seat(el, spot) {
    const lane = el.querySelector && el.querySelector(".tk-lane");
    const box = el.querySelector && el.querySelector(".tk-scroll");
    if (!lane || !box) return;
    spot = spot || latest();
    const mark = () => {
      const room = box.scrollWidth - box.clientWidth;
      lane.classList.toggle("more-left", room > 0 && box.scrollLeft > 1);
      lane.classList.toggle("more-right", room > 0 && box.scrollLeft < room - 1);
    };
    const room = box.scrollWidth - box.clientWidth;
    box.scrollLeft = spot.end ? Math.max(room, 0) : Math.min(spot.left, Math.max(room, 0));
    mark();
    box.addEventListener("scroll", () => {
      const room = box.scrollWidth - box.clientWidth;
      spot.left = box.scrollLeft;
      spot.end = box.scrollLeft >= room - 1;
      mark();
    }, { passive: true });
  }

  // ---- the hover tip -------------------------------------------------------
  // wired once per element and read from whatever it last drew, so drawing
  // again never stacks a second set of listeners
  function wire(el) {
    if (el.tkWired || !el.addEventListener) return;
    el.tkWired = true;
    el.addEventListener("pointermove", e => hover(el, e));
    el.addEventListener("pointerleave", () => unhover(el));
  }
  function unhover(el) {
    const tip = el.querySelector(".tk-tip");
    if (tip) tip.hidden = true;
    for (const n of el.querySelectorAll(".tk-guide, .tk-dot")) n.setAttribute("visibility", "hidden");
    for (const n of el.querySelectorAll(".tk-day.hot")) n.classList.remove("hot");
  }
  function place(el, tip, html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const box = el.getBoundingClientRect(), w = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(x - box.left - w / 2, box.width - w)) + "px";
    tip.style.top = (y - box.top - tip.offsetHeight - 8) + "px";
  }
  function hover(el, e) {
    const drawn = el.tkModel, tip = el.querySelector(".tk-tip");
    if (!drawn || !tip) return;
    // what has scrolled under the pinned names is out of sight, so not hovered
    const pin = el.querySelector(".tk-pin");
    if (pin && e.clientX < pin.getBoundingClientRect().right) return unhover(el);
    if (drawn.kind === "heatmap") {
      const sq = e.target.closest && e.target.closest(".tk-day");
      if (!sq) return unhover(el);
      const cell = drawn.model.cells[Number(sq.dataset.i)];
      for (const n of el.querySelectorAll(".tk-day.hot")) if (n !== sq) n.classList.remove("hot");
      sq.classList.add("hot");
      const r = sq.getBoundingClientRect();
      place(el, tip, heatTip(cell), r.left + r.width / 2, r.top);
      return;
    }
    const svg = el.querySelector("svg.tk-line");
    const { points, box } = drawn.model;
    if (!svg || !points.length) return;
    const r = svg.getBoundingClientRect(), k = r.width / LW;
    const at = (e.clientX - r.left) / k;
    if (at < box.left - 4 || at > box.left + box.w + 4) return unhover(el);
    const p = points[Math.max(0, Math.min(points.length - 1,
      Math.round((at - box.left) / box.w * (points.length - 1))))];
    const guide = svg.querySelector(".tk-guide"), dot = svg.querySelector(".tk-dot");
    guide.setAttribute("x1", p.x); guide.setAttribute("x2", p.x); guide.setAttribute("visibility", "visible");
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("visibility", "visible");
    place(el, tip, lineTip(p), r.left + p.x * k, r.top + p.y * k);
  }

  // ---- the panel -----------------------------------------------------------
  // one rectangle: a heading and the pill on top, the chart under them. load
  // answers the route's reading; the default asks the board for it
  function readView(store) {
    try { const v = store && store.getItem(VIEW_KEY); return VIEWS.some(([k]) => k === v) ? v : "heatmap"; }
    catch (err) { return "heatmap"; }
  }
  function panel(root, opts = {}) {
    const doc = root.ownerDocument || document;
    const store = "store" in opts ? opts.store : (typeof localStorage !== "undefined" ? localStorage : null);
    const load = opts.load || (() => fetch("/tokens/daily?days=" + FETCH_DAYS)
      .then(r => { if (!r.ok) throw new Error("tokens " + r.status); return r.json(); }));
    const el = (tag, cls, text) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    };
    const box = el("div", "tk-panel");
    const head = el("div", "tk-head");
    const title = el("div", "tk-title");
    title.appendChild(el("span", "tk-name", "Tokens"));
    title.appendChild(el("span", "tk-what", "Claude Code and Codex on this machine"));
    const pill = el("div", "tk-pill");
    pill.setAttribute("role", "group");
    pill.setAttribute("aria-label", "Chart");
    const buttons = {};
    for (const [key, label] of VIEWS) {
      const b = el("button", "tk-opt", label);
      b.type = "button";
      b.dataset.view = key;
      b.addEventListener("click", () => show(key));
      buttons[key] = b;
      pill.appendChild(b);
    }
    head.appendChild(title);
    head.appendChild(pill);
    const stage = el("div", "tk-stage");
    const note = el("div", "tk-note");
    box.appendChild(head);
    box.appendChild(stage);
    box.appendChild(note);
    root.textContent = "";
    root.appendChild(box);

    let view = readView(store);
    // where each chart's view stands, its own for each, so the pill never
    // moves the other chart and a redraw never moves the one on show
    const spots = { heatmap: latest(), line: latest() };
    let data = null;
    function draw() {
      for (const [key] of VIEWS) {
        buttons[key].classList.toggle("on", key === view);
        buttons[key].setAttribute("aria-pressed", String(key === view));
      }
      if (!data) return;
      (view === "line" ? drawLine : drawHeatmap)(stage, data.days || [], spots[view]);
      const found = data.found || {};
      note.textContent = found.claude || found.codex ? ""
        : "No Claude Code or Codex logs were found on this machine.";
    }
    function show(key) {
      if (!VIEWS.some(([k]) => k === key)) return;
      view = key;
      try { if (store) store.setItem(VIEW_KEY, key); } catch (err) {}
      draw();
    }
    let asking = null;
    function refresh() {
      if (asking) return asking;
      if (!data) { stage.textContent = ""; stage.appendChild(el("div", "tk-wait", "Counting tokens…")); }
      asking = Promise.resolve().then(load).then(answer => {
        data = answer;
        draw();
      }, () => {
        if (!data) { stage.textContent = ""; stage.appendChild(el("div", "tk-wait", "The token counts could not be read.")); }
      }).finally(() => { asking = null; });
      return asking;
    }
    draw();
    return { root: box, show, refresh, view: () => view };
  }

  window.TokenWidgets = {
    PALETTE, LINE, YEAR, WEEKS, FETCH_DAYS, CHART: { width: GRID_W, height: GRID_H },
    LINE_CHART: { width: LW, height: LH },
    compact, longDay, scale, rolling, niceTop,
    heatmapModel, heatmapSvg, heatPin, heatTip, drawHeatmap,
    lineModel, lineSvg, linePin, lineTip, drawLine,
    viewHtml, seat, panel,
  };
})();
