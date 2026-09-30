// The home page's widgets: the tokens the local coding agents spent, drawn two
// ways from one reading of GET /tokens/daily, and the panel that holds them.
//
//   heatmap  a year as 53 week columns of 7 day squares, Sunday on top, the way
//            a contribution graph is drawn. One square per day of the last
//            365, a red-orange scale from light to deep by where the day
//            falls among the year's active days (quartiles), a faint warm
//            grey for a day with none, month names over the columns, a total
//            for the year and a tip with the day and its count, shown on
//            hover, or on a phone on a tap
//   line     the same days as two lines on one axis: each day's own total as
//            the solid line, and the trailing 7-day average over it as a
//            dotted one a shade deeper, named by a legend under the chart.
//            The count axis runs from 0 to the first round tick at or above
//            the busiest day, in four to six steps; the months are named
//            along the bottom. A day is marked only where the pointer or a
//            tap is, with a dot on each line and a tip giving the date, the
//            day's total and its 7-day average. The foot says whose tokens
//            they are, "Includes data from Claude", "... Codex" or "...
//            Claude & Codex", from the per-tool counts on each day; a year
//            with none from either leaves that place empty
//   panel    one rectangle headed "Token consumption per day", holding one
//            of the two at a time and a two-way pill to switch them, whose
//            seat slides from one name to the other; the choice is
//            remembered in this browser
//   view     both charts are drawn to the height of the view they are shown
//            in, never stretched: the heatmap's squares grow until its seven
//            rows fill it, and the line is as wide as the heatmap, a week of
//            it as wide as a column. A view narrower than a chart shows it
//            through a lane that scrolls sideways, opening on the latest weeks
//            at the right end: a sideways swipe, the wheel (with or without
//            shift) and a drag with the mouse all move it, anywhere over the
//            chart. The axis names on the left stay put while the chart passes
//            under them, and a soft fade marks each side with more to see; no
//            scrollbar, like every scroller on the board. Each chart keeps its
//            own place while the page is open, and one left at its latest end
//            stays there as new days arrive or the window is resized
//
// Each widget is a function of (element, days) that draws into the element
// it is given and owns nothing outside it, so either can later sit in a shared
// widget system on its own. The drawing is plain SVG written as text; the
// models under it are plain data, which is what the tests hold them to.
// Nothing here fetches except the panel, and only /tokens/daily.
(function () {
  const WEEKS = 53;
  const LEFT = 34, TOP = 20;                    // room for the day and month names
  // a week column's width, as wide as the height allows between these two
  const MIN_STEP = 12, MAX_STEP = 32;
  // the height a chart is drawn to when its view has none of its own yet
  const VIEW_H = 200;
  // the scale: a warm grey for nothing, then four red-oranges, light to deep
  const PALETTE = ["#EEEAE4", "#FCD8C2", "#F7A67C", "#EC6B3C", "#C9401B"];
  const LINE = "#E0592B";                       // the daily line
  const AVG_LINE = PALETTE[4];                  // the 7-day average, dotted, a shade deeper
  const AVG_DASH = "0 5";                       // round dots 5px apart
  const YEAR = 365, AVG = 7;
  // the panel asks for the year and the six days before it, so the line's
  // first average is a whole week's like every other
  const FETCH_DAYS = YEAR + AVG - 1;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const VIEWS = [["heatmap", "Heatmap"], ["line", "Line"]];
  const VIEW_KEY = "home.chart";
  const TIP = `<div class="tk-tip" hidden></div>`;

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

  // ---- whose tokens these are ----------------------------------------------
  // each day from the route carries the share of each tool (claude, codex), and
  // a tool turned off or with no logs has none, so a tool is named when any day
  // of the year shown has tokens from it
  const TOOL_NAMES = [["claude", "Claude"], ["codex", "Codex"]];
  function sources(days) {
    const year = days.slice(-YEAR);
    return TOOL_NAMES.filter(([key]) => year.some(d => d[key] > 0)).map(([, name]) => name);
  }
  const sourceLine = names => (names.length ? "Includes data from " + names.join(" & ") : "");

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

  // ---- the size a chart is drawn at ------------------------------------------
  // both charts are drawn to the view's height. The heatmap's week column is
  // as wide as its seven rows and the month names let it be in that height,
  // a square that less its gap; the rows and names sit in the middle of any
  // height left over. The line is as wide as the heatmap and as tall as the view
  function geometry(h) {
    const height = Math.max(1, Math.round(Number(h) > 0 ? Number(h) : VIEW_H));
    const step = Math.max(MIN_STEP, Math.min(MAX_STEP, Math.floor((height - TOP - 2) / 7)));
    const gap = step >= 20 ? 4 : 3, cell = step - gap;
    const rows = 7 * step - gap;
    const top = TOP + Math.max(0, Math.floor((height - TOP - rows) / 2));
    return { height: Math.max(height, TOP + rows), width: LEFT + WEEKS * step - gap,
             step, gap, cell, rows, top, radius: step >= 20 ? 3 : 2 };
  }

  // ---- the heatmap ---------------------------------------------------------
  function heatmapModel(days, h) {
    const geo = geometry(h);
    const year = days.slice(-YEAR);
    const sc = scale(year.map(d => d.total));
    const lead = year.length ? parts(year[0].date).weekday : 0;
    const cells = year.map((d, i) => {
      const col = Math.floor((lead + i) / 7), row = (lead + i) % 7;
      return { i, date: d.date, total: d.total, col, row, level: sc.level(d.total),
               fill: sc.colour(d.total), x: LEFT + col * geo.step, y: geo.top + row * geo.step };
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
    return { cells, months, weeks: WEEKS, cuts: sc.cuts, geo,
             total: year.reduce((s, d) => s + (d.total || 0), 0) };
  }
  // the chart as drawn, at the view's height. The day names are drawn apart
  // (heatPin) into the same place, where they stay while the chart scrolls
  function heatmapSvg(model) {
    const g = model.geo;
    const out = [`<svg class="tk-heat" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" ` +
                 `role="img" aria-label="${esc(compact(model.total))} tokens in the last year, one square per day">`];
    for (const m of model.months)
      out.push(`<text class="tk-axis" x="${LEFT + m.col * g.step}" y="${g.top - 7}">${m.label}</text>`);
    for (const c of model.cells)
      out.push(`<rect class="tk-day" data-i="${c.i}" x="${c.x}" y="${c.y}" width="${g.cell}" ` +
               `height="${g.cell}" rx="${g.radius}" fill="${c.fill}"/>`);
    out.push("</svg>");
    return out.join("");
  }
  function heatPin(model) {
    const g = model.geo;
    const out = [`<svg width="${LEFT}" height="${g.height}" viewBox="0 0 ${LEFT} ${g.height}" aria-hidden="true">`];
    for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]])
      out.push(`<text class="tk-axis" x="0" y="${r1(g.top + row * g.step + g.cell / 2 + 4)}">${name}</text>`);
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
    const total = days.slice(-YEAR).reduce((s, d) => s + (d.total || 0), 0);
    const foot = `<div class="tk-foot"><span class="tk-sum"><b>${esc(compact(total))}</b> tokens in the last year</span>` +
      `${legendHtml()}</div>`;
    const h = viewHeight(el, foot);
    const model = heatmapModel(days, h);
    el.tkModel = { kind: "heatmap", model };
    el.innerHTML = viewHtml(heatmapSvg(model), heatPin(model), LEFT) + foot + TIP;
    seat(el, spot);
    wire(el);
    return model;
  }

  // ---- the line ------------------------------------------------------------
  const PAD = { left: 48, right: 14, top: 12, bottom: 26 };
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
  // the count axis: 0 up to the first round tick at or past the busiest day,
  // a step of 1, 2, 2.5 or 5 times a power of ten, in four to six ticks. Of
  // the steps that give that many, the lowest top wins, then the tick count
  // nearest five. A busiest day right on a tick gets one step more of room
  function niceAxis(max) {
    if (!(max > 0)) return { top: 4, step: 1, ticks: [0, 1, 2, 3, 4] };
    let best = null;
    for (const n of [3, 4, 5]) {
      const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = Math.max(1, [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw * (1 - 1e-9)));
      let count = Math.ceil(max / step - 1e-9);
      if (count * step <= max) count += 1;
      const top = count * step;
      if (count + 1 < 4 || count + 1 > 6) continue;
      if (!best || top < best.top || (top === best.top && Math.abs(count - 4) < Math.abs(best.count - 4)))
        best = { top, step, count };
    }
    if (!best) {
      // four ticks at the least, whatever the steps
      const step = Math.max(1, max / 3);
      best = { top: step * 4, step, count: 4 };
    }
    const ticks = Array.from({ length: best.count + 1 }, (_, i) => Number((i * best.step).toPrecision(12)));
    return { top: ticks.at(-1), step: best.step, ticks };
  }
  function lineModel(days, h) {
    const geo = geometry(h);
    const LW = geo.width, LH = geo.height;
    const avg = rolling(days.map(d => d.total || 0)).slice(-YEAR);
    const shown = days.slice(-YEAR);
    const axis = niceAxis(Math.max(0, ...shown.map(d => d.total || 0)));
    const top = axis.top;
    const w = LW - PAD.left - PAD.right, ht = LH - PAD.top - PAD.bottom;
    const n = shown.length;
    const xAt = i => PAD.left + (n > 1 ? i * w / (n - 1) : w / 2);
    const yAt = v => PAD.top + ht - (v / top) * ht;
    // each point also knows the days its average was taken over: the day
    // itself and the six before it, fewer only where the reading begins
    const lead = days.length - n;
    const points = shown.map((d, i) => {
      const first = Math.max(0, lead + i - AVG + 1);
      return { i, date: d.date, total: d.total || 0, avg: avg[i], from: days[first].date,
               span: lead + i - first + 1, x: r1(xAt(i)), y: r1(yAt(d.total || 0)), ya: r1(yAt(avg[i])) };
    });
    // the months along the bottom, at each one's first day; January carries its year
    const months = [];
    for (const p of points) {
      const q = parts(p.date);
      if (q.d !== 1) continue;
      const label = q.m === 1 ? `Jan ${q.y}` : MONTHS[q.m - 1];
      if (p.x + (q.m === 1 ? 54 : 26) <= LW) months.push({ x: p.x, label });
    }
    return { points, months, top, ticks: axis.ticks, yAt, geo, width: LW, height: LH,
             box: { ...PAD, w, h: ht } };
  }
  const path = pts => pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join("");
  function lineSvg(model) {
    const { points, box, width: LW, height: LH } = model;
    const base = box.top + box.h;
    const out = [`<svg class="tk-line" width="${LW}" height="${LH}" viewBox="0 0 ${LW} ${LH}" role="img" ` +
                 `aria-label="tokens per day and their 7-day average over the last year">`];
    for (const t of model.ticks) {
      const y = r1(model.yAt(t));
      out.push(`<line class="${t ? "tk-grid" : "tk-base"}" x1="${box.left}" x2="${box.left + box.w}" y1="${y}" y2="${y}"/>`);
    }
    for (const m of model.months) {
      out.push(`<line class="tk-tick" x1="${m.x}" x2="${m.x}" y1="${base}" y2="${base + 4}"/>`);
      out.push(`<text class="tk-axis" x="${m.x}" y="${LH - 7}">${m.label}</text>`);
    }
    if (points.length) {
      out.push(`<path class="tk-path" d="${path(points.map(p => [p.x, p.y]))}" fill="none" stroke="${LINE}"/>`);
      out.push(`<path class="tk-avg" d="${path(points.map(p => [p.x, p.ya]))}" fill="none" stroke="${AVG_LINE}" ` +
               `stroke-dasharray="${AVG_DASH}"/>`);
    }
    out.push(`<line class="tk-guide" x1="0" x2="0" y1="${box.top}" y2="${base}" visibility="hidden"/>`);
    // the day's mark a solid dot ringed in white, the average's a white one ringed in its colour
    out.push(`<circle class="tk-dot avg" r="4.5" cx="0" cy="0" fill="#FFFFFF" stroke="${AVG_LINE}" ` +
             `stroke-width="2.5" visibility="hidden"/>`);
    out.push(`<circle class="tk-dot" r="5.5" cx="0" cy="0" fill="${LINE}" stroke="#FFFFFF" stroke-width="2" ` +
             `visibility="hidden"/>`);
    out.push(`<rect class="tk-hit" x="${box.left}" y="0" width="${box.w}" height="${LH}" fill="transparent"/>`);
    out.push("</svg>");
    return out.join("");
  }
  // the count names up the left, drawn apart into the place they held, where
  // they stay while the line scrolls
  function linePin(model) {
    const LH = model.height;
    const out = [`<svg width="${PAD.left}" height="${LH}" viewBox="0 0 ${PAD.left} ${LH}" aria-hidden="true">`];
    for (const t of model.ticks)
      out.push(`<text class="tk-axis" x="${PAD.left - 8}" y="${r1(model.yAt(t)) + 4}" text-anchor="end">${compact(t)}</text>`);
    out.push("</svg>");
    return out.join("");
  }
  // a short stroke of each line, for the legend and the tip
  function swatch(avg) {
    return avg
      ? `<svg class="tk-key" width="20" height="8" aria-hidden="true"><line x1="3" x2="18" y1="4" y2="4" ` +
        `stroke="${AVG_LINE}" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="${AVG_DASH}"/></svg>`
      : `<svg class="tk-key" width="20" height="8" aria-hidden="true"><line x1="2" x2="18" y1="4" y2="4" ` +
        `stroke="${LINE}" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  // the tip names the day, then its total and its 7-day average, each beside
  // the stroke of its line
  function lineTip(p) {
    return `<b>${esc(longDay(p.date))}</b>` +
           `<span class="tk-row">${swatch(false)}Daily<em>${esc(compact(p.total))}</em></span>` +
           `<span class="tk-row">${swatch(true)}${p.span}-day average<em>${esc(compact(p.avg))}</em></span>`;
  }
  function drawLine(el, days, spot) {
    const foot = `<div class="tk-foot"><span class="tk-sum">${esc(sourceLine(sources(days)))}</span>` +
      `<span class="tk-legend">${swatch(false)}Daily${swatch(true)}7-day average</span></div>`;
    const h = viewHeight(el, foot);
    const model = lineModel(days, h);
    el.tkModel = { kind: "line", model };
    el.innerHTML = viewHtml(lineSvg(model), linePin(model), PAD.left) + foot + TIP;
    seat(el, spot);
    wire(el);
    return model;
  }

  // ---- the view ------------------------------------------------------------
  // the chart in a lane as tall as the view that scrolls sideways, its axis
  // names pinned over the lane's left edge
  function viewHtml(chart, pin, pinWidth) {
    return `<div class="tk-view"><div class="tk-lane">` +
      `<div class="tk-scroll"><div class="tk-chart">${chart}</div></div>` +
      `<div class="tk-pin" style="width:${pinWidth}px">${pin}</div>` +
      `</div></div>`;
  }
  // the height the page gives the view (home-widgets.css), read off the view
  // already there or an empty one set down first; a view not laid out yet
  // draws at the default and is drawn again once it is (panel)
  function viewHeight(el, foot) {
    let view = el.querySelector && el.querySelector(".tk-view");
    if (!view) {
      el.innerHTML = viewHtml("", "", 0) + foot + TIP;
      view = el.querySelector && el.querySelector(".tk-view");
    }
    const h = view && view.clientHeight;
    return h > 0 ? h : VIEW_H;
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

  // ---- moving the view by hand ---------------------------------------------
  // a sideways swipe scrolls the lane the browser's own way. A mostly upright
  // one, which is the wheel, shift and the wheel where the system leaves it
  // upright, and a two-finger swipe up or down, moves the chart sideways too
  // rather than nothing: down or away for later days. Past either end it is
  // left to the page. The mouse can also take hold of the chart and drag it
  const LINE_PX = 16;
  function wheel(el, e) {
    const box = el.querySelector(".tk-scroll");
    if (!box || !box.contains(e.target)) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? box.clientWidth : 1;
    const before = box.scrollLeft;
    box.scrollLeft = before + e.deltaY * unit;
    if (box.scrollLeft !== before) e.preventDefault();
  }
  function grab(el, e) {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const box = el.querySelector(".tk-scroll");
    if (!box || !box.contains(e.target) || box.scrollWidth <= box.clientWidth) return;
    el.tkDrag = { id: e.pointerId, x: e.clientX, left: box.scrollLeft, box, moved: false };
  }
  // true while a drag has the pointer, so the tip keeps out of its way
  function drag(el, e) {
    const d = el.tkDrag;
    if (!d || e.pointerId !== d.id) return false;
    if (!(e.buttons & 1)) { letGo(el); return false; }
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < 4) return false;
      d.moved = true;
      try { d.box.setPointerCapture(d.id); } catch (err) {}
      const lane = el.querySelector(".tk-lane");
      if (lane) lane.classList.add("dragging");
      unhover(el);
    }
    d.box.scrollLeft = d.left - dx;
    return true;
  }
  function letGo(el) {
    const d = el.tkDrag;
    if (!d) return;
    el.tkDrag = null;
    try { d.box.releasePointerCapture(d.id); } catch (err) {}
    const lane = el.querySelector(".tk-lane");
    if (lane) lane.classList.remove("dragging");
  }

  // ---- the hover tip -------------------------------------------------------
  // wired once per element and read from whatever it last drew, so drawing
  // again never stacks a second set of listeners. a mouse or a pen hovers. a
  // finger has no hover, so on a phone a tap shows the tip for the day under
  // it, and the next touch, a swipe of the chart or a tap anywhere else, takes
  // it away. a tap is a touch the browser let go of without taking it for a
  // scroll, which it ends with a cancel instead
  function wire(el) {
    if (el.tkWired || !el.addEventListener) return;
    el.tkWired = true;
    const finger = e => e.pointerType === "touch";
    el.addEventListener("wheel", e => wheel(el, e), { passive: false });
    el.addEventListener("pointerdown", e => grab(el, e));
    el.addEventListener("pointermove", e => { if (!drag(el, e) && !finger(e) && !el.tkDrag?.moved) hover(el, e); });
    el.addEventListener("pointerup", e => { const moved = el.tkDrag?.moved; letGo(el); if (finger(e) || !moved) hover(el, e); });
    el.addEventListener("pointercancel", () => letGo(el));
    el.addEventListener("pointerleave", e => { if (!finger(e) && !el.tkDrag?.moved) unhover(el); });
    const doc = el.ownerDocument;
    if (doc && doc.addEventListener)
      doc.addEventListener("pointerdown", e => { if (finger(e)) unhover(el); }, { capture: true, passive: true });
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
    tip.style.top = (y - box.top - tip.offsetHeight - 10) + "px";
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
    const { points, box, width } = drawn.model;
    if (!svg || !points.length) return;
    const r = svg.getBoundingClientRect(), k = r.width / width;
    const at = (e.clientX - r.left) / k;
    if (at < box.left - 4 || at > box.left + box.w + 4) return unhover(el);
    const p = points[Math.max(0, Math.min(points.length - 1,
      Math.round((at - box.left) / box.w * (points.length - 1))))];
    const guide = svg.querySelector(".tk-guide");
    const dot = svg.querySelector(".tk-dot:not(.avg)"), mean = svg.querySelector(".tk-dot.avg");
    guide.setAttribute("x1", p.x); guide.setAttribute("x2", p.x); guide.setAttribute("visibility", "visible");
    mean.setAttribute("cx", p.x); mean.setAttribute("cy", p.ya); mean.setAttribute("visibility", "visible");
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("visibility", "visible");
    place(el, tip, lineTip(p), r.left + p.x * k, r.top + Math.min(p.y, p.ya) * k);
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
    title.appendChild(el("span", "tk-name", "Token consumption per day"));
    const pill = el("div", "tk-pill");
    pill.setAttribute("role", "group");
    pill.setAttribute("aria-label", "Chart");
    // the seat under the chosen name, which slides to the other (home-widgets.css)
    pill.appendChild(el("span", "tk-thumb"));
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
    let drawnAt = "";
    const sizeOf = () => {
      const v = stage.querySelector && stage.querySelector(".tk-view");
      return v ? v.clientWidth + "x" + v.clientHeight : "";
    };
    function draw() {
      pill.dataset.on = view;
      for (const [key] of VIEWS) {
        buttons[key].classList.toggle("on", key === view);
        buttons[key].setAttribute("aria-pressed", String(key === view));
      }
      if (!data) return;
      (view === "line" ? drawLine : drawHeatmap)(stage, data.days || [], spots[view]);
      drawnAt = sizeOf();
      const found = data.found || {};
      note.textContent = found.claude || found.codex ? ""
        : "No Claude Code or Codex logs were found on this machine.";
    }
    // the view's size follows the window on the board, so a chart is drawn
    // again at the new height, where it stood
    if (typeof ResizeObserver === "function")
      new ResizeObserver(() => { if (data && sizeOf() && sizeOf() !== drawnAt) draw(); }).observe(stage);
    function show(key) {
      if (!VIEWS.some(([k]) => k === key)) return;
      view = key;
      try { if (store) store.setItem(VIEW_KEY, key); } catch (err) {}
      draw();
    }
    let asking = null;
    function refresh() {
      if (asking) return asking;
      if (!data) { stage.textContent = ""; stage.appendChild(el("div", "tk-wait", "Counting tokens")); }
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
    PALETTE, LINE, AVG_LINE, AVG_DASH, YEAR, WEEKS, FETCH_DAYS, VIEW_H, MIN_STEP, MAX_STEP,
    compact, longDay, scale, rolling, niceAxis, geometry, sources, sourceLine,
    heatmapModel, heatmapSvg, heatPin, heatTip, drawHeatmap,
    lineModel, lineSvg, linePin, lineTip, drawLine,
    viewHtml, seat, panel,
  };
})();
