// The home page's widgets: the tokens the local coding agents spent, drawn two
// ways from one reading of GET /tokens/daily, and the panel that holds them.
//
//   heatmap  a year as 53 week columns of 7 day squares, Sunday on top, the way
//            a contribution graph is drawn, but folded into two rows read like
//            two lines of text: the older 26 weeks on top, the latest 27 under
//            them, so the year fits a box that is taller than it is long
//            without shrinking its squares. One square per day of the last
//            365, a red-orange scale from light to deep by where the day
//            falls among the year's active days (quartiles), a faint warm
//            grey for a day with none, month names over each row, a total
//            for the year and a hover tip with the day and its count
//   line     the same days as one line in the same box: each day's trailing
//            7-day average, since single days jump between nothing and a
//            great deal. The tip names the day's own count beside the average
//   panel    one rectangle holding one of the two at a time and a two-way
//            pill to switch them; the choice is remembered in this browser
//
// Each widget is a function of (element, days) that draws into the element
// it is given and owns nothing outside it, so either can later sit in a shared
// widget system on its own. The drawing is plain SVG written as text; the
// models under it are plain data, which is what the tests hold them to.
// Nothing here fetches except the panel, and only /tokens/daily.
(function () {
  // the box both charts are drawn to, in its own units, which the panel shows
  // at about one to one: 540 across and 310 down, the two rows of weeks and a
  // band between them. home-widgets.css holds the same ratio for the wait
  const WEEKS = 53, CELL = 16, GAP = 3, STEP = CELL + GAP;
  const ROW_WEEKS = Math.ceil(WEEKS / 2);        // 27, the latest row; the older one holds 26
  const SPLIT = WEEKS - ROW_WEEKS;               // the first week of the second row
  const LEFT = 30, TOP = 18;                     // room for the day and month names
  const ROW_H = TOP + 7 * STEP - GAP, ROW_GAP = 14;
  const GRID_W = LEFT + ROW_WEEKS * STEP - GAP, GRID_H = 2 * ROW_H + ROW_GAP;
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
  // col is the week's place in the whole year, 0 to 52; band is the row of
  // weeks it is drawn in, and at is its column within that row
  function heatmapModel(days) {
    const year = days.slice(-YEAR);
    const sc = scale(year.map(d => d.total));
    const lead = year.length ? parts(year[0].date).weekday : 0;
    const cells = year.map((d, i) => {
      const col = Math.floor((lead + i) / 7), row = (lead + i) % 7;
      const band = col < SPLIT ? 0 : 1, at = band ? col - SPLIT : col;
      return { i, date: d.date, total: d.total, col, row, band, at, level: sc.level(d.total),
               fill: sc.colour(d.total), x: LEFT + at * STEP, y: band * (ROW_H + ROW_GAP) + TOP + row * STEP };
    });
    // in each row a month is named over the column its first day falls in,
    // and the partial month the row starts in only when the next name leaves
    // room, so each row can be read without the one above it
    const months = [];
    for (const band of [0, 1]) {
      const inRow = cells.filter(c => c.band === band);
      if (!inRow.length) continue;
      const width = band ? ROW_WEEKS : SPLIT;
      const named = inRow.filter(c => parts(c.date).d === 1 && c.at <= width - 2)
        .map(c => ({ band, at: c.at, label: MONTHS[parts(c.date).m - 1] }));
      const first = parts(inRow[0].date);
      if (first.d !== 1 && (!named.length || named[0].at >= 3))
        named.unshift({ band, at: 0, label: MONTHS[first.m - 1] });
      months.push(...named);
    }
    return { cells, months, weeks: WEEKS, cuts: sc.cuts,
             total: year.reduce((s, d) => s + (d.total || 0), 0) };
  }
  function heatmapSvg(model) {
    const out = [`<svg class="tk-heat" viewBox="0 0 ${GRID_W} ${GRID_H}" role="img" ` +
                 `aria-label="${esc(compact(model.total))} tokens in the last year, one square per day">`];
    for (const m of model.months)
      out.push(`<text class="tk-axis" x="${LEFT + m.at * STEP}" y="${m.band * (ROW_H + ROW_GAP) + TOP - 7}">${m.label}</text>`);
    for (const band of [0, 1])
      for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]])
        out.push(`<text class="tk-axis" x="0" y="${band * (ROW_H + ROW_GAP) + TOP + row * STEP + CELL - 4}">${name}</text>`);
    for (const c of model.cells)
      out.push(`<rect class="tk-day" data-i="${c.i}" x="${c.x}" y="${c.y}" width="${CELL}" ` +
               `height="${CELL}" rx="3" fill="${c.fill}"/>`);
    out.push("</svg>");
    return out.join("");
  }
  function legendHtml() {
    return `<span class="tk-legend">Less${PALETTE.map(c =>
      `<i style="background:${c}"></i>`).join("")}More</span>`;
  }
  function heatTip(cell) {
    return cell.total > 0
      ? `<b>${esc(compact(cell.total))} tokens</b><span>${esc(longDay(cell.date))}</span>`
      : `<b>No tokens</b><span>${esc(longDay(cell.date))}</span>`;
  }
  function drawHeatmap(el, days) {
    const model = heatmapModel(days);
    el.tkModel = { kind: "heatmap", model };
    el.innerHTML = `<div class="tk-chart">${heatmapSvg(model)}</div>` +
      `<div class="tk-foot"><span class="tk-sum"><b>${esc(compact(model.total))}</b> tokens in the last year</span>` +
      `${legendHtml()}</div><div class="tk-tip" hidden></div>`;
    wire(el);
    return model;
  }

  // ---- the line ------------------------------------------------------------
  // the line is drawn to the heatmap's own box, so the panel holds still when
  // the pill switches between them
  const LW = GRID_W, LH = GRID_H;
  const PAD = { left: 38, right: 6, top: 10, bottom: 20 };
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
    const points = shown.map((d, i) => ({ i, date: d.date, total: d.total || 0, avg: avg[i],
                                          x: r1(xAt(i)), y: r1(yAt(avg[i])) }));
    const months = points.filter(p => parts(p.date).d === 1 && p.x < LW - PAD.right - 16)
      .map(p => ({ x: p.x, label: MONTHS[parts(p.date).m - 1] }));
    return { points, months, top, ticks: [0, top / 2, top], yAt, box: { ...PAD, w, h } };
  }
  let fades = 0;   // each drawing's own gradient id, so two lines on a page never share one
  function lineSvg(model) {
    const { points, box } = model;
    const base = box.top + box.h;
    const path = points.map((p, i) => (i ? "L" : "M") + p.x + " " + p.y).join("");
    const fade = "tk-fade-" + (++fades);
    const out = [`<svg class="tk-line" viewBox="0 0 ${LW} ${LH}" role="img" ` +
                 `aria-label="tokens per day, 7-day average, over the last year">`,
                 `<defs><linearGradient id="${fade}" x1="0" y1="0" x2="0" y2="1">` +
                 `<stop offset="0" stop-color="${LINE}" stop-opacity=".2"/>` +
                 `<stop offset="1" stop-color="${LINE}" stop-opacity="0"/></linearGradient></defs>`];
    for (const t of model.ticks) {
      const y = r1(model.yAt(t));
      out.push(`<line class="tk-grid" x1="${box.left}" x2="${box.left + box.w}" y1="${y}" y2="${y}"/>`);
      out.push(`<text class="tk-axis" x="${box.left - 6}" y="${y + 3}" text-anchor="end">${compact(t)}</text>`);
    }
    for (const m of model.months)
      out.push(`<text class="tk-axis" x="${m.x}" y="${LH - 5}">${m.label}</text>`);
    if (points.length) {
      out.push(`<path class="tk-area" d="${path}L${points.at(-1).x} ${base}L${points[0].x} ${base}Z" fill="url(#${fade})"/>`);
      out.push(`<path class="tk-path" d="${path}" fill="none" stroke="${LINE}"/>`);
    }
    out.push(`<line class="tk-guide" x1="0" x2="0" y1="${box.top}" y2="${base}" visibility="hidden"/>`);
    out.push(`<circle class="tk-dot" r="3.5" cx="0" cy="0" fill="${LINE}" visibility="hidden"/>`);
    out.push(`<rect class="tk-hit" x="${box.left}" y="${box.top}" width="${box.w}" height="${box.h}" fill="transparent"/>`);
    out.push("</svg>");
    return out.join("");
  }
  function lineTip(p) {
    return `<b>${esc(compact(p.total))} tokens</b><span>${esc(longDay(p.date))}</span>` +
           `<span>${esc(compact(p.avg))} a day, 7-day average</span>`;
  }
  function drawLine(el, days) {
    const model = lineModel(days);
    el.tkModel = { kind: "line", model };
    el.innerHTML = `<div class="tk-chart">${lineSvg(model)}</div>` +
      `<div class="tk-foot"><span class="tk-sum">Tokens per day, 7-day average</span></div>` +
      `<div class="tk-tip" hidden></div>`;
    wire(el);
    return model;
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
    let data = null;
    function draw() {
      for (const [key] of VIEWS) {
        buttons[key].classList.toggle("on", key === view);
        buttons[key].setAttribute("aria-pressed", String(key === view));
      }
      if (!data) return;
      (view === "line" ? drawLine : drawHeatmap)(stage, data.days || []);
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
    PALETTE, LINE, YEAR, WEEKS, FETCH_DAYS, BOX: { width: GRID_W, height: GRID_H },
    compact, longDay, scale, rolling, niceTop,
    heatmapModel, heatmapSvg, heatTip, drawHeatmap,
    lineModel, lineSvg, lineTip, drawLine,
    panel,
  };
})();
