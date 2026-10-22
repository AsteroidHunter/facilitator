// The home page's widgets: the tokens the local coding agents spent, drawn two
// ways from one reading of GET /tokens/daily, and the panel that holds them.
//
//   heatmap  this year so far, January 1 to today, as week columns of 7 day
//            squares, Sunday on top, the way a contribution graph is drawn.
//            One square per day, a red-orange scale from light to deep by
//            the day's count on a log scale under the year's busiest day, a
//            faint warm grey for a day with none, month names over the
//            columns, "<total> tokens this year" and a tip with the day and
//            its count, shown on hover, or on a phone on a tap
//   line     the same days in the picture's Editorial look: a light column
//            for each day's total and a curved deep line over them for the
//            trailing 7-day average, named by a key under the chart. The
//            count axis runs from 0 to the first round tick at or above the
//            busiest day, in four to six steps, each count named on its
//            gridline; the months are named along the bottom. A week or
//            more with no tokens is left as a gap, the line stopping before
//            it. A busy, steady year draws its columns smaller and paler
//            (calmOf). A day is marked only where the pointer or a tap is,
//            with a dot on its column and on the line and a tip giving the
//            date, the day's total and its 7-day average. The foot says
//            "<total> tokens this year", the total of the days shown
//   panel    one column headed "Token consumption per day", with no box
//            around it (home-widgets.css), holding one
//            of the two at a time and a two-way pill to switch them, whose
//            seat slides from one name to the other; the choice is
//            remembered in this browser. A download button stands beside the
//            pill and saves the chart on show as a picture (see picture)
//   picture  a chart in one of the looks the dice can pick (DICE), the whole
//            of it, drawn on a canvas at three times the size into a 2:1 PNG
//            for the line and a 3:1 one for the heatmap, with its heading,
//            names, key, the squid and "Facilitator" at the top right, and on
//            the line the day the board was first started. The line starts
//            on the day use began this year (pictureStart), its total still
//            the one from January 1, and the install mark is left out when
//            that day comes before the start, or less than a week before the
//            last day, where it would stand at the right edge with nothing
//            after it to show (MARK_AFTER). Every picture is on pure white.
//            The download button saves the chart on show in its first look,
//            the Poster median and band for the line and the Editorial
//            heatmap, named by pictureName. The Mac saves it as a download,
//            as does a phone whose browser cannot share a file; then the
//            overlay shows it
//   overlay  the picture just made, in a box of the board's glass over the
//            dimmed page, under "Chart downloaded!", a heatmap or line pill
//            and the cross, and over a row of three: a glass dice that rolls
//            and swaps in another look of the chart, a glass download button
//            that saves the chart on show as a new file, and "Share", which
//            hands the file to the system's share sheet where the browser
//            can (on a phone, to go to Photos or Files) and copies the
//            picture otherwise. The cross, Escape and a press outside the
//            box put it away
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
//   limits   a second, shorter panel of the same make: one row for each plan
//            window GET /limits has a number for, Claude 5-hour, Claude
//            weekly, Codex 5-hour, Codex weekly, each a name, a bar and the
//            percent used, and under them, small and faint, when the numbers
//            were taken ("Last updated: 3 mins ago"). The bars are drawn in the
//            token chart's own colours: the line's daily colour filled into a
//            track of the heatmap's lightest tint. The last answer is kept in
//            this browser and drawn the moment the box is made, before the
//            route has answered; the answer that follows moves the bars and
//            the numbers where they differ, on the same nodes, so nothing
//            jumps. The box is only as tall as its heading, its rows and its
//            line, with a small gap under the heading, so it opens at its
//            finished height from the kept answer and changes height only when
//            the number of rows does. With no saved reading a quiet loading or
//            empty message takes the room of one row
//
// Each widget is a function of (element, days) that draws into the element
// it is given and owns nothing outside it, so either can later sit in a shared
// widget system on its own. The drawing is plain SVG written as text; the
// models under it are plain data, which is what the tests hold them to.
// Nothing here fetches except the panel, and only /tokens/daily and, when the
// download button is pressed, GET /profile for the first name in the file's
// name, and the limits box, and only /limits. The overlay is the one thing set
// down outside the element a widget is given: it covers the whole page while
// it is up.
(function () {
  const WEEKS = 53;
  const LEFT = 34, TOP = 20;                    // room for the day and month names
  // a week column's width, as wide as the height allows and never under this,
  // so the seven rows fill a taller view instead of leaving bands above and
  // under them
  const MIN_STEP = 12;
  // the height a chart is drawn to when its view has none of its own yet
  const VIEW_H = 200;
  // the scale: a warm grey for nothing, then six red-oranges, light to deep
  const PALETTE = ["#EEEAE4", "#FFECDC", "#FCD8C2", "#FABF9F", "#F7A67C", "#EC6B3C", "#C9401B"];
  const [GREY, PALEST, PALE, LIGHT, SOFT, MID, DEEP] = PALETTE;
  const LINE = "#E0592B";                       // the board's warm line colour, the limits bars' fill
  const AVG_LINE = DEEP;                        // the 7-day average, over the days' columns
  const YEAR = 365, AVG = 7;
  // the panel asks for the year and the six days before it, so the line's
  // first average is a whole week's like every other
  const FETCH_DAYS = YEAR + AVG - 1;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const VIEWS = [["heatmap", "Heatmap"], ["line", "Line"]];
  const VIEW_KEY = "home.chart";
  const TIP = `<div class="tk-tip" hidden></div>`;
  const TOKENS_KEY = "home.tokens";
  // Lucide's download, loader-circle and check (ISC), the set the board's other
  // icons are drawn from, stacked in one place: the button shows one at a time
  // and fades between them (its data-state, in home-widgets.css)
  const ICON = body => '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  const SAVE_ICONS =
    `<span class="tk-ico down">${ICON('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>')}</span>` +
    `<span class="tk-ico spin">${ICON('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>')}</span>` +
    `<span class="tk-ico done">${ICON('<path d="M20 6 9 17l-5-5"/>')}</span>`;
  // the spinner shows at least this long, so a quick picture still reads as
  // work; the check stays this long before the download icon comes back
  const SPIN_MIN = 500, DONE_MS = 1500;
  // Storage can be blocked or full. A page still keeps its most recent reading
  // in memory; reopening the page also works whenever localStorage is available.
  const memory = new WeakMap(), noStore = {};
  function localStore() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; }
    catch (err) { return null; }
  }
  const record = value => value && typeof value === "object" && !Array.isArray(value);
  const successful = value => record(value) && !value.error && value.ok !== false && value.success !== false;
  function tokenAnswer(answer) {
    return successful(answer) && Array.isArray(answer.days) && answer.days.every(day =>
      record(day) && typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
      Number.isFinite(day.total) && day.total >= 0);
  }
  function limitsAnswer(answer) {
    if (!successful(answer)) return false;
    if (Object.keys(answer).some(key => !["claude", "codex", "fetched", "now", "refreshing"].includes(key))) return false;
    return ["claude", "codex"].every(tool => answer[tool] == null || (record(answer[tool]) &&
      ["five_hour", "weekly"].every(span => answer[tool][span] == null ||
        (record(answer[tool][span]) && Number.isFinite(answer[tool][span].used)))));
  }
  function readCache(store, key, valid) {
    const saved = memory.get(store || noStore);
    if (saved && saved[key]) return saved[key];
    try {
      const kept = store && JSON.parse(store.getItem(key));
      if (record(kept) && valid(kept.answer) && (kept.at === null || Number.isFinite(kept.at))) return kept;
    } catch (err) {}
    return null;
  }
  function keepCache(store, key, kept) {
    const owner = store || noStore, saved = memory.get(owner) || {};
    saved[key] = kept;
    memory.set(owner, saved);
    try { if (store) store.setItem(key, JSON.stringify(kept)); } catch (err) {}
  }
  function element(doc, tag, cls, text) {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  // Keep the timestamp at the panel's text edge. The card glyph follows it
  // only while refreshing; an empty timestamp leaves the glyph at that edge.
  function statusLine(doc, box, timeClass) {
    const footer = element(doc, "div", "tk-status");
    const spinner = element(doc, "span", "cardspin tk-refresh");
    spinner.setAttribute("data-f", "|");
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", "Refreshing");
    const note = element(doc, "span", timeClass);
    footer.appendChild(note);
    footer.appendChild(spinner);
    box.appendChild(footer);
    function busy(on) {
      spinner.hidden = !on;
      spinner.className = "cardspin tk-refresh" + (on ? " on" : "");
      box.setAttribute("aria-busy", String(on));
    }
    busy(false);
    return { note, busy };
  }

  // ---- numbers and days ----------------------------------------------------
  // 1234 is 1.23K, 48210000 is 48.2M: three figures at most, trailing zeros
  // off. Billions are the largest unit: from a thousand of them the count is
  // whole billions with a comma, 1,234B, and never trillions
  const grouped = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  function compact(n) {
    n = Math.max(0, Number(n) || 0);
    const units = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (let i = 0; i < units.length; i++) {
      const [size, unit] = units[i];
      if (n < size) continue;
      const shown = Number((n / size).toPrecision(3));
      if (shown >= 1000 && i === 0) return grouped(Math.round(n / size)) + unit;
      // 999.6K rounds to 1000K, which is 1M
      if (shown >= 1000) return Number((n / units[i - 1][0]).toPrecision(3)) + units[i - 1][1];
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

  // ---- the foot and the charts' range --------------------------------------
  // the foot's one line, under both charts: the total of this year so far
  const totalLine = (total, when = "this year") => `<b>${esc(compact(total))}</b> tokens ${when}`;
  const sum = list => list.reduce((s, d) => s + (d.total || 0), 0);
  // where both charts start: the first day on or after January 1 of the year
  // the last day falls in, so a reading is cut at the new year and not at 365
  // days. The days before it stay in the reading, for the line's first average
  function yearStart(days) {
    if (!days.length) return 0;
    const first = days[days.length - 1].date.slice(0, 4) + "-01-01";
    const at = days.findIndex(d => d.date >= first);
    return at < 0 ? 0 : at;
  }
  // where use began in a run of days: the first day with any use, skipping
  // each early stretch followed by a silence of MIN_SILENCE days or more when
  // that silence and the days after it are each longer than the stretch, so a
  // short trial months before is skipped and a holiday in the middle is not.
  // A silence running up to the last day never counts, and at least MIN_SHOWN
  // days are left
  const MIN_SILENCE = 30, MIN_SHOWN = 28;
  function useStart(days) {
    const n = days.length, used = days.map(d => (d.total || 0) > 0);
    let start = used.indexOf(true);
    if (start < 0) return 0;
    for (let i = start; i < n; ) {
      if (used[i]) { i++; continue; }
      let j = i;
      while (j < n && !used[j]) j++;   // the silence is i to j - 1
      if (j === n) break;
      const stretch = i - start;
      if (i > start && j - i >= MIN_SILENCE && j - i > stretch && n - j > stretch) start = j;
      i = j;
    }
    return Math.max(0, Math.min(start, n - MIN_SHOWN));
  }
  // where the line's picture starts: January 1, or the day use began this
  // year when that is later. The days before it stay in the reading, for its
  // first average
  function pictureStart(days) {
    const from = yearStart(days);
    return from + useStart(days.slice(from));
  }
  const thisYear = days => sum(days.slice(yearStart(days)));
  // how many days to ask the route for: a year and the week of average before
  // it, or, from January 1 to today and that week, if more
  function fetchDays(now) {
    const d = new Date(now), start = new Date(d.getFullYear(), 0, 1);
    const sinceJan = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - start) / 864e5) + 1;
    return Math.max(FETCH_DAYS, sinceJan + AVG);
  }

  // ---- the colour scale ----------------------------------------------------
  // the year's active days on a log scale, from the quietest to the busiest
  // cut into one equal step per shade, each step at most a factor of 10^0.75,
  // about 5.6, with any day under the bottom on the lightest. Quartiles put
  // every day in the busiest quarter on one shade, 500M and 3B alike. The top
  // is held to the top quartile plus 1.5 times the quartiles' spread (of the
  // logs), so one enormous day does not wash every other square out
  const STEP = 0.75;
  function quantile(sorted, q) {
    const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
  }
  function logCuts(active) {
    const shades = PALETTE.length - 1, logs = active.map(Math.log10);
    const q1 = quantile(logs, 0.25), q3 = quantile(logs, 0.75);
    const top = Math.min(logs[logs.length - 1], q3 + 1.5 * (q3 - q1));
    const step = Math.min(STEP, (top - logs[0]) / shades), bottom = top - shades * step;
    const at = Array.from({ length: shades - 1 }, (_, k) => k + 1);
    // days all alike are all the deepest
    if (!(step > 0)) return at.map(() => active[0]);
    return at.map(k => 10 ** (bottom + k * step));
  }
  function scale(values) {
    const active = values.filter(v => v > 0).sort((a, b) => a - b);
    const cuts = active.length ? logCuts(active) : [];
    const level = v => (v > 0 && cuts.length ? 1 + cuts.filter(c => v >= c).length : 0);
    return { cuts, level, colour: v => PALETTE[level(v)] };
  }

  // ---- the size a chart is drawn at ------------------------------------------
  // both charts are drawn to the view's height. The heatmap's week column is
  // as wide as its seven rows and the month names let it be in that height,
  // a square that less its gap; the rows and names sit in the middle of any
  // height left over. The line is as wide as the heatmap and as tall as the
  // view. Both hold the weeks from January 1 to the last day (yearWeeks)
  function geometry(h, weeks = WEEKS) {
    const height = Math.max(1, Math.round(Number(h) > 0 ? Number(h) : VIEW_H));
    const step = Math.max(MIN_STEP, Math.floor((height - TOP - 2) / 7));
    const gap = step >= 20 ? 4 : 3, cell = step - gap;
    const rows = 7 * step - gap;
    const top = TOP + Math.max(0, Math.floor((height - TOP - rows) / 2));
    return { height: Math.max(height, TOP + rows), width: LEFT + weeks * step - gap, left: LEFT,
             step, gap, cell, rows, top, radius: step >= 20 ? 3 : 2, weeks };
  }
  // the week columns this year's days take, Sunday on top: the one January 1
  // falls in to the one the last day falls in
  function yearWeeks(days) {
    const from = yearStart(days), n = days.length - from;
    if (n <= 0) return 1;
    return Math.floor((parts(days[from].date).weekday + n - 1) / 7) + 1;
  }

  // ---- the heatmap ---------------------------------------------------------
  function heatmapModel(days, h) {
    const weeks = yearWeeks(days), geo = geometry(h, weeks);
    const year = days.slice(yearStart(days));
    const sc = scale(year.map(d => d.total));
    const lead = year.length ? parts(year[0].date).weekday : 0;
    const cells = year.map((d, i) => {
      const col = Math.floor((lead + i) / 7), row = (lead + i) % 7;
      return { i, date: d.date, total: d.total, col, row, level: sc.level(d.total),
               fill: sc.colour(d.total), x: geo.left + col * geo.step, y: geo.top + row * geo.step };
    });
    // a month is named over the column its first day falls in, and the
    // partial month a reading starts in only when the next name leaves room
    const months = [];
    for (const c of cells) {
      const p = parts(c.date);
      if (p.d === 1 && c.col <= weeks - 2) months.push({ col: c.col, label: MONTHS[p.m - 1] });
    }
    if (cells.length && (!months.length || months[0].col >= 3) && parts(cells[0].date).d !== 1)
      months.unshift({ col: 0, label: MONTHS[parts(cells[0].date).m - 1] });
    return { cells, months, weeks, cuts: sc.cuts, geo, total: sum(year) };
  }
  // the chart as drawn, at the view's height. The day names are drawn apart
  // (heatPin) into the same place, where they stay while the chart scrolls
  function heatmapSvg(model) {
    const g = model.geo;
    const out = [`<svg class="tk-heat" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" ` +
                 `role="img" aria-label="${esc(compact(model.total))} tokens this year, one square per day">`];
    for (const m of model.months)
      out.push(`<text class="tk-axis" x="${g.left + m.col * g.step}" y="${g.top - 7}">${m.label}</text>`);
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
    const foot = `<div class="tk-foot"><span class="tk-sum">${totalLine(thisYear(days))}</span>` +
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
  // the count axis: a main step of 1, 2 or 5 times a power of ten, lines and
  // names at whole steps only, three to five of them counting 0. The top is the
  // busiest day rounded up to the next half step, strictly above it, so a day
  // on a half step gets one half step more. Of the steps that fit, the lowest
  // top wins, then the line count nearest four
  function niceAxis(max) {
    if (!(max > 0)) return { top: 4, step: 1, ticks: [0, 1, 2, 3, 4] };
    const mag = Math.floor(Math.log10(max));
    let best = null;
    for (let e = Math.max(0, mag - 2); e <= mag; e++) for (const f of [1, 2, 5]) {
      const step = f * Math.pow(10, e), half = step / 2;
      const top = Number(((Math.floor(max / half + 1e-9) + 1) * half).toPrecision(12));
      const count = Math.floor(top / step + 1e-9) + 1;
      if (count < 3 || count > 5) continue;
      if (!best || top < best.top || (top === best.top && Math.abs(count - 4) < Math.abs(best.count - 4)))
        best = { top, step, count };
    }
    if (!best) {
      // under four tokens no step fits; the smallest whole one
      const half = 0.5;
      best = { top: (Math.floor(max / half + 1e-9) + 1) * half, step: 1 };
      best.count = Math.floor(best.top) + 1;
    }
    const ticks = Array.from({ length: best.count }, (_, i) => Number((i * best.step).toPrecision(12)));
    return { top: best.top, step: best.step, ticks };
  }
  // ---- the days a line shows -----------------------------------------------
  // a run of this many days or more with no tokens is left as a gap in every
  // line: no line or band is drawn across it and no mark inside it. The dates
  // along the floor still run through it, and shorter quiet runs are drawn as
  // they are
  const GAP_DAYS = 7;
  // the day the board was first started is marked once this many days of the
  // line follow it; before that the mark would stand at the right edge with
  // nothing after it to show
  const MARK_AFTER = 7;
  // the days from `from` (January 1 on the screen, pictureStart in a
  // picture), each day's total and the board's 7-day average, and for each
  // day the first day and the number of days its average was taken over. The
  // gaps are found first, and the lines are drawn in the runs of days between
  // them. Nothing is drawn in a gap, so a day in one has no average, and a
  // 7-day average whose week reaches into a gap averages only the days
  // outside it, the way a reading's first days average what there is, so the
  // line does not climb out of the gap from zero
  function seriesOf(days, from = yearStart(days), installed = null) {
    const shown = days.slice(from), vals = shown.map(d => d.total || 0), n = shown.length;
    const avg = rolling(days.map(d => d.total || 0)).slice(from);
    const firsts = vals.map((_, i) => Math.max(0, from + i - AVG + 1));
    const since = vals.map((_, i) => days[firsts[i]].date);
    const span = vals.map((_, i) => from + i - firsts[i] + 1);
    const gap = vals.map(() => false);
    for (let i = 0; i < n; ) {
      if (vals[i] > 0) { i++; continue; }
      let j = i;
      while (j < n && !(vals[j] > 0)) j++;
      if (j - i >= GAP_DAYS) for (let k = i; k < j; k++) gap[k] = true;
      i = j;
    }
    const runs = [];
    for (let i = 0; i < n; ) {
      if (gap[i]) { i++; continue; }
      let j = i;
      while (j < n && !gap[j]) j++;
      runs.push([i, j - 1]);
      i = j;
    }
    vals.forEach((_, i) => {
      if (gap[i]) { avg[i] = 0; span[i] = 0; return; }
      const week = [];
      for (let j = Math.max(0, i - AVG + 1); j <= i; j++) week.push(j);
      if (!week.some(j => gap[j])) return;
      const use = week.filter(j => !gap[j]);
      avg[i] = use.reduce((s, j) => s + vals[j], 0) / use.length;
      since[i] = shown[use[0]].date;
      span[i] = use.length;
    });
    const months = [];
    shown.forEach((d, i) => { const p = parts(d.date); if (p.d === 1) months.push({ i, label: MONTHS[p.m - 1] }); });
    const at = installed ? shown.findIndex(d => d.date === installed) : -1;
    return { shown, vals, avg, since, span, gap, runs, months, n,
             install: at >= 0 && n - 1 - at >= MARK_AFTER ? at : -1,
             total: thisYear(days), first: n ? shown[0].date : null, last: n ? shown[n - 1].date : null };
  }
  // the days of each run between gaps, for drawing a line or band run by run
  const runDays = S => S.runs.map(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k));

  // ---- how full a year is ----------------------------------------------------
  // a busy, steady year has a tall mark on nearly every day from end to end,
  // which crowds a chart of daily marks, so there the marks are drawn smaller
  // and paler under a bolder 7-day line. How busy and steady is two numbers
  // over the days shown: the share of days with any use, and how even the
  // use is, the quietest of the four quarters the days cut into, by its mean
  // day, over the busiest. Each counts from nothing to all between its two
  // ends below, and the calm is the two multiplied, from 0 to 1. A year that
  // starts quiet and grows, as most first years do, is far from even and
  // keeps the marks as they are (0); one used on most days at much the same
  // rate from end to end gets them at their calmest (1)
  const FULL_DAYS = [0.6, 0.8], FULL_EVEN = [0.1, 0.3];
  const ramp = (v, [a, b]) => Math.max(0, Math.min(1, (v - a) / (b - a)));
  const lerp = (a, b, t) => a + (b - a) * t;
  function fullness(vals) {
    const n = vals.length;
    if (n < 4) return { used: 0, even: 0 };
    const mean = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += vals[i]; return s / (b - a); };
    const quarters = [0, 1, 2, 3].map(k => mean(Math.floor(k * n / 4), Math.floor((k + 1) * n / 4)));
    const top = Math.max(...quarters);
    return { used: vals.filter(v => v > 0).length / n, even: top > 0 ? Math.min(...quarters) / top : 0 };
  }
  function calmOf(vals) {
    const { used, even } = fullness(vals);
    return ramp(used, FULL_DAYS) * ramp(even, FULL_EVEN);
  }
  // the screen's marks at a calm: the columns' strength and their width as a
  // share of a day's step, and the 7-day line's width
  const screenMarks = calm => ({ alpha: lerp(0.62, 0.3, calm), width: lerp(0.62, 0.42, calm), line: lerp(2.6, 3.2, calm) });

  // ---- the curved line -------------------------------------------------------
  // a curve through points that never overshoots them (monotone cubic), so no
  // day is drawn higher or lower than its value
  function slopes(pts) {
    const n = pts.length, d = [], t = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
    if (n < 2) return t;
    t[0] = d[0]; t[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      const h0 = pts[i][0] - pts[i - 1][0], h1 = pts[i + 1][0] - pts[i][0];
      t[i] = d[i - 1] * d[i] <= 0 ? 0 : 3 * (h0 + h1) / ((2 * h1 + h0) / d[i - 1] + (h1 + 2 * h0) / d[i]);
    }
    return t;
  }
  function curvePath(pts) {
    if (!pts.length) return "";
    const at = ([x, y]) => r1(x) + " " + r1(y);
    if (pts.length < 3) return "M" + pts.map(at).join("L");
    const t = slopes(pts), out = ["M" + at(pts[0])];
    for (let i = 0; i < pts.length - 1; i++) {
      const h = (pts[i + 1][0] - pts[i][0]) / 3;
      out.push("C" + at([pts[i][0] + h, pts[i][1] + h * t[i]]) + " " + at([pts[i + 1][0] - h, pts[i + 1][1] - h * t[i + 1]]) +
               " " + at(pts[i + 1]));
    }
    return out.join("");
  }

  // ---- the line on the screen ---------------------------------------------------
  // the Editorial look at the view's height, from January 1, as wide as the
  // heatmap of the same days
  function lineModel(days, h) {
    const geo = geometry(h, yearWeeks(days)), pad = PAD;
    const LW = geo.width, LH = geo.height;
    const S = seriesOf(days);
    const axis = niceAxis(Math.max(0, ...S.vals, ...S.avg));
    const top = axis.top;
    const w = LW - pad.left - pad.right, ht = LH - pad.top - pad.bottom;
    const n = S.n;
    const xAt = i => pad.left + (n > 1 ? i * w / (n - 1) : w / 2);
    const yAt = v => pad.top + ht - (v / top) * ht;
    const points = S.shown.map((d, i) => ({ i, date: d.date, total: S.vals[i], avg: S.avg[i], from: S.since[i],
      span: S.span[i], gap: S.gap[i], x: r1(xAt(i)), y: r1(yAt(S.vals[i])), ya: r1(yAt(S.avg[i])) }));
    // the months along the bottom, at each one's first day; January carries its year
    const months = [];
    for (const m of S.months) {
      const p = points[m.i], label = m.label === "Jan" ? `Jan ${parts(p.date).y}` : m.label;
      if (p.x + (m.label === "Jan" ? 54 : 26) <= LW) months.push({ x: p.x, label });
    }
    const calm = calmOf(S.vals);
    return { points, runs: S.runs, months, top, ticks: axis.ticks, yAt, geo, width: LW, height: LH,
             box: { ...pad, w, h: ht }, step: n > 1 ? w / (n - 1) : w, calm, marks: screenMarks(calm) };
  }
  // a column rising from the floor to y, its top corners rounded
  function columnPath(x0, x1, y, base) {
    const r = Math.min(1.5, (x1 - x0) / 2);
    if (base - y <= 2) return `M${r1(x0)} ${r1(base)}V${r1(y)}H${r1(x1)}V${r1(base)}Z`;
    return `M${r1(x0)} ${r1(base)}V${r1(y + r)}Q${r1(x0)} ${r1(y)} ${r1(x0 + r)} ${r1(y)}H${r1(x1 - r)}` +
           `Q${r1(x1)} ${r1(y)} ${r1(x1)} ${r1(y + r)}V${r1(base)}Z`;
  }
  function lineSvg(model) {
    const { points, box, width: LW, height: LH, marks } = model;
    const base = box.top + box.h;
    const out = [`<svg class="tk-line" width="${LW}" height="${LH}" viewBox="0 0 ${LW} ${LH}" role="img" ` +
                 `aria-label="tokens per day and their 7-day average this year">`];
    for (const t of model.ticks) {
      const y = r1(model.yAt(t));
      out.push(`<line class="${t ? "tk-grid" : "tk-base"}" x1="${box.left}" x2="${box.left + box.w}" y1="${y}" y2="${y}"/>`);
    }
    for (const m of model.months) {
      out.push(`<line class="tk-tick" x1="${m.x}" x2="${m.x}" y1="${base}" y2="${base + 4}"/>`);
      out.push(`<text class="tk-axis" x="${m.x}" y="${LH - 7}">${m.label}</text>`);
    }
    // a light column for each day with use, and the curved deep 7-day line
    // over them, ringed in the ground's colour, stopping at each gap
    const half = Math.max(1, model.step * marks.width) / 2;
    const cols = points.filter(p => p.total > 0 && !p.gap).map(p => columnPath(p.x - half, p.x + half, model.yAt(p.total), base));
    if (cols.length)
      out.push(`<path class="tk-cols" d="${cols.join("")}" fill="${SOFT}" fill-opacity="${r1(marks.alpha * 100) / 100}"/>`);
    const line = model.runs.map(([a, b]) => curvePath(points.slice(a, b + 1).map(p => [p.x, model.yAt(p.avg)]))).join("");
    if (line) {
      out.push(`<path class="tk-ring" d="${line}" fill="none" stroke-width="${r1(marks.line + 3)}"/>`);
      out.push(`<path class="tk-avg" d="${line}" fill="none" stroke="${AVG_LINE}" stroke-width="${r1(marks.line)}"/>`);
    }
    out.push(`<line class="tk-guide" x1="0" x2="0" y1="${box.top}" y2="${base}" visibility="hidden"/>`);
    // the day's mark a solid dot ringed in white, the average's a white one ringed in its colour
    out.push(`<circle class="tk-dot avg" r="4.5" cx="0" cy="0" fill="#FFFFFF" stroke="${AVG_LINE}" ` +
             `stroke-width="2.5" visibility="hidden"/>`);
    out.push(`<circle class="tk-dot" r="5.5" cx="0" cy="0" fill="${SOFT}" stroke="#FFFFFF" stroke-width="2" ` +
             `visibility="hidden"/>`);
    out.push(`<rect class="tk-hit" x="${box.left}" y="0" width="${box.w}" height="${LH}" fill="transparent"/>`);
    out.push("</svg>");
    return out.join("");
  }
  // the count names, each sitting on its gridline at the left, drawn apart
  // into the place they held with the gridlines' start, where they stay
  // while the line scrolls. The floor is not named
  function linePin(model) {
    const LH = model.height;
    const out = [`<svg width="${PAD.left}" height="${LH}" viewBox="0 0 ${PAD.left} ${LH}" aria-hidden="true">`];
    for (const t of model.ticks) {
      const y = r1(model.yAt(t));
      out.push(`<line class="${t ? "tk-grid" : "tk-base"}" x1="0" x2="${PAD.left}" y1="${y}" y2="${y}"/>`);
      if (t) out.push(`<text class="tk-axis" x="0" y="${r1(y - 5)}">${compact(t)}</text>`);
    }
    out.push("</svg>");
    return out.join("");
  }
  // a little of each mark, for the key and the tip: a day's column, at the
  // strength the chart draws them, and a stroke of the 7-day line
  function swatch(avg, marks = screenMarks(0)) {
    return avg
      ? `<svg class="tk-key" width="20" height="8" aria-hidden="true"><line x1="2" x2="18" y1="4" y2="4" ` +
        `stroke="${AVG_LINE}" stroke-width="2.6" stroke-linecap="round"/></svg>`
      : `<svg class="tk-key" width="12" height="12" aria-hidden="true"><path d="${columnPath(3.5, 8.5, 1, 12)}" ` +
        `fill="${SOFT}" fill-opacity="${r1(marks.alpha * 100) / 100}"/></svg>`;
  }
  // the tip names the day, then its total and its 7-day average, each beside
  // its mark. A day in a gap has no average, as no line is drawn there
  function lineTip(p, marks) {
    return `<b>${esc(longDay(p.date))}</b>` +
           `<span class="tk-row">${swatch(false, marks)}Daily<em>${esc(compact(p.total))}</em></span>` +
           (p.gap ? "" : `<span class="tk-row">${swatch(true)}${p.span}-day average<em>${esc(compact(p.avg))}</em></span>`);
  }
  function drawLine(el, days, spot) {
    const marks = screenMarks(calmOf(seriesOf(days).vals));
    const foot = `<div class="tk-foot"><span class="tk-sum">${totalLine(thisYear(days))}</span>` +
      `<span class="tk-legend">${swatch(false, marks)}Daily${swatch(true)}7-day average</span></div>`;
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
    // The foot can wrap differently after a source or view changes. Measure
    // with the incoming foot in place, not the previous drawing's foot.
    el.innerHTML = viewHtml("", "", 0) + foot + TIP;
    const view = el.querySelector && el.querySelector(".tk-view");
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
    // putting the view there fires a scroll of its own a frame later, and by
    // then a window being resized may have made the lane narrower; read as the
    // reader's, that echo took the view off its latest end, and the last
    // month's name stood cut under the fade. only a move away from where the
    // view was put is the reader's
    let put = box.scrollLeft;
    box.addEventListener("scroll", () => {
      if (put !== null && box.scrollLeft === put) { put = null; mark(); return; }
      put = null;
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
    el.tkDrag = { id: e.pointerId, x: e.clientX, left: box.scrollLeft, box, moved: false, k: drawnScale(box) };
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
    d.box.scrollLeft = d.left - dx / d.k;   // the chart stays under the pointer at any scale
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
    if (doc && doc.addEventListener) {
      const dismiss = e => { if (finger(e)) unhover(el); };
      doc.addEventListener("pointerdown", dismiss, { capture: true, passive: true });
      el.tkDispose = () => { letGo(el); if (doc.removeEventListener) doc.removeEventListener("pointerdown", dismiss, true); };
    }
  }
  function unhover(el) {
    const tip = el.querySelector(".tk-tip");
    if (tip) tip.hidden = true;
    for (const n of el.querySelectorAll(".tk-guide, .tk-dot")) n.setAttribute("visibility", "hidden");
    for (const n of el.querySelectorAll(".tk-day.hot")) n.classList.remove("hot");
  }
  // x and y are the window's; the tip stands in the element's own pixels,
  // which are the window's over the scale a page may draw the panel at
  function place(el, tip, html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const box = el.getBoundingClientRect(), k = drawnScale(el), w = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min((x - box.left) / k - w / 2, box.width / k - w)) + "px";
    tip.style.top = ((y - box.top) / k - tip.offsetHeight - 10) + "px";
  }
  // the scale an element is drawn at: its width on screen over its own, and 1
  // for one with no width to read
  function drawnScale(el) {
    if (!(el.offsetWidth > 0)) return 1;
    const k = el.getBoundingClientRect().width / el.offsetWidth;
    return Number.isFinite(k) && k > 0 ? k : 1;
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
    mean.setAttribute("cx", p.x); mean.setAttribute("cy", p.ya); mean.setAttribute("visibility", p.gap ? "hidden" : "visible");
    dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y); dot.setAttribute("visibility", "visible");
    place(el, tip, lineTip(p, drawn.model.marks), r.left + p.x * k, r.top + (p.gap ? p.y : Math.min(p.y, p.ya)) * k);
  }

  // ---- the picture ---------------------------------------------------------
  // a chart saved as a PNG: the heatmap 1200 x 400 laid out, 3:1, the line
  // 1200 x 600, 2:1, and drawn at three times that so the words stay crisp on
  // a phone's screen. It is drawn on a canvas for the whole of the chart at
  // once, never the part the lane has scrolled to, the heatmap from January 1
  // and the line from the day use began this year (pictureStart), its total
  // still the year's. Each picture is one of the looks of the chart looks mock
  // (20261020) the dice can pick (DICE): the Editorial, Lab and Poster
  // heatmaps, and six line pictures, each a look and one of the three things
  // a line can show: the days and their 7-day average, a two-week median
  // over its 1 sigma range, or each week's median as a dot. The words use the
  // board's own faces (the sheet's --sans and --mono, and Inter for the name
  // at the top right and the repo link under it, which the file carries
  // itself so it is set the same with or without the network) and its inks,
  // and every look carries the squid, the name, the link, and on the line the
  // day the board was first started
  const SHAPES = { "3:1": [1200, 400], "2:1": [1200, 600] };
  const SHAPE_OF = { heatmap: "3:1", line: "2:1" };
  const PIC_SCALE = 3;
  const REPO_LINK = "github.com/AsteroidHunter/facilitator";
  const INTER_EXPORT = "Inter Export";           // the family the embedded file is added as
  const PIC_TITLE = "Token consumption per day";
  const INSTALLED = "Facilitator installed";
  const LOGO_SRC = "/m-splash-squid.png";
  // the pictures stand on pure white (20261020), whatever paper the page
  // around them has, and so does everything in them painted with the paper:
  // the rings under lines, the haloes round notes, label boxes and dots
  const LOOK = { ink: "#211D17", sub: "#75695A", line: "#CACACA", paper: "#FFFFFF",
                 sans: '"IBM Plex Sans", -apple-system, sans-serif', inter: '"Inter", -apple-system, sans-serif',
                 mono: '"IBM Plex Mono", ui-monospace, monospace' };
  // what the dice rolls through, by chart, each a look and what the line
  // shows. The first of each is the one the download button saves and the
  // pop-up opens on: the Poster two-week median with its band for the line
  // (20261020), the Editorial heatmap
  const DICE = {
    line: [["poster", "band"], ["editorial", "daily"], ["editorial", "band"], ["lab", "daily"],
           ["lab", "dots"], ["poster", "dots"]],
    heatmap: [["editorial"], ["lab"], ["poster"]],
  };
  const LOOK_NAMES = { editorial: "Editorial", lab: "Lab", poster: "Poster" };
  const SHOW_NAMES = { daily: "daily and 7-day average", band: "median and band", dots: "weekly dots" };

  // ---- what a line picture shows -----------------------------------------------
  // the band and the weekly dots run from the 15.9th to the 84.1st
  // percentile, one sigma either side of the median for a normal spread. The
  // band's days are weighted by a bell curve around each day, sigma 3.5
  // days, so 95% of the weight is within a week either side and a spike fades
  // in and out of the band instead of switching it like a 14-day box does
  const SIGMA = 3.5, REACH = Math.ceil(3 * SIGMA), LO_Q = 0.159, HI_Q = 0.841, BIN = 7;
  // percentiles of days that each count for a weight: each day stands at the
  // middle of its share of the total weight, and a percentile between two
  // days is read off the straight line between them
  function weighted(pairs) {
    pairs.sort((a, b) => a.v - b.v);
    const total = pairs.reduce((s, p) => s + p.w, 0);
    let c = 0;
    const at = pairs.map(p => { const m = (c + p.w / 2) / total; c += p.w; return m; });
    const q = p => {
      if (p <= at[0]) return pairs[0].v;
      for (let k = 1; k < at.length; k++)
        if (p <= at[k]) return pairs[k - 1].v + (pairs[k].v - pairs[k - 1].v) * (p - at[k - 1]) / (at[k] - at[k - 1]);
      return pairs[pairs.length - 1].v;
    };
    return { lo: q(LO_Q), mid: q(0.5), hi: q(HI_Q) };
  }
  // a series (seriesOf) with a median and the 1 sigma range of the two weeks
  // around each day, and 7-day bins counted back from the last day, each with
  // its median and its 1 sigma range. The band's window and the bins leave
  // gap days out, so they do not dive at a gap's edge. A bin's dot stands in
  // the middle of its days outside gaps; a bin cut by a gap keeps its dot
  // only with 4 or more days outside it, so no dot is a median of a day or
  // two, and a bin wholly in a gap has none. The 7-day blocks themselves are
  // kept for the ticks
  function spreadOf(S) {
    const { vals, gap } = S;
    const pct = list => { const s = [...list].sort((a, b) => a - b); return { lo: quantile(s, LO_Q), mid: quantile(s, 0.5), hi: quantile(s, HI_Q) }; };
    S.band = vals.map((_, i) => {
      const pairs = [];
      for (let j = Math.max(0, i - REACH); j <= Math.min(vals.length - 1, i + REACH); j++)
        if (!gap[j]) pairs.push({ v: vals[j], w: Math.exp(-0.5 * ((j - i) / SIGMA) ** 2) });
      return pairs.length && !gap[i] ? weighted(pairs) : { lo: 0, mid: 0, hi: 0 };
    });
    S.bins = []; S.blocks = [];
    for (let end = vals.length; end > 0; end -= BIN) {
      const a = Math.max(0, end - BIN), use = [];
      for (let k = a; k < end; k++) if (!gap[k]) use.push(k);
      S.blocks.unshift(a);
      const cut = use.length < end - a;
      if (use.length && (!cut || use.length >= 4))
        S.bins.unshift({ a, b: end - 1, u0: use[0], u1: use[use.length - 1], at: (use[0] + use[use.length - 1]) / 2,
                         ...pct(use.map(k => vals[k])) });
    }
    return S;
  }
  // the highest count drawn at each day or bin, as [day, count]: the day and
  // its 7-day average, the band's top, or a bin's top
  function highsOf(S, c) {
    if (c === "dots") return S.bins.map(b => [b.at, b.hi]);
    return S.vals.map((v, i) => [i, c === "daily" ? Math.max(v, S.avg[i]) : S.band[i].hi]);
  }
  // the highest value a content draws, for its axis
  function peakOf(S, c) {
    if (c === "daily") return Math.max(0, ...S.vals);
    if (c === "band") return Math.max(0, ...S.band.map(b => b.hi));
    return Math.max(0, ...S.bins.map(b => b.hi));
  }
  const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const longDate = date => { const p = parts(date); return `${LONG[p.m - 1]} ${p.d}`; };
  const shortDate = date => { const p = parts(date); return `${MONTHS[p.m - 1]} ${p.d}`; };
  // two days, short: "Oct 6 to 12", or "Sep 29 to Oct 5" across a month
  const shortRange = (a, b) => (parts(a).m === parts(b).m ? `${shortDate(a)} to ${parts(b).d}` : `${shortDate(a)} to ${shortDate(b)}`);
  const spanWords = S => `${longDate(S.first)} to ${longDate(S.last)}, ${parts(S.last).y}`;
  // the content's own high point, for a note: the busiest day, the highest
  // median, the bin with the highest median
  function highOf(S, c) {
    if (c === "daily") { const i = S.vals.indexOf(Math.max(...S.vals)); return { i, v: S.vals[i], words: ["Busiest day", `${compact(S.vals[i])} on ${shortDate(S.shown[i].date)}`] }; }
    if (c === "band") { const m = S.band.map(b => b.mid), i = m.indexOf(Math.max(...m)); return { i, v: m[i], words: ["Highest median", `${compact(m[i])} around ${shortDate(S.shown[i].date)}`] }; }
    if (!S.bins.length) return { i: 0, v: 0, words: ["", ""] };
    const b = S.bins.reduce((p, q) => (q.mid > p.mid ? q : p));
    return { i: b.at, v: b.mid, words: ["Busiest week", `${compact(b.mid)} median, ${shortRange(S.shown[b.u0].date, S.shown[b.u1].date)}`] };
  }
  const xMap = (x0, x1, i0, i1) => i => (i1 > i0 ? x0 + (i - i0) * (x1 - x0) / (i1 - i0) : (x0 + x1) / 2);
  // an axis with room for a label at the top of a chart: `highs` are [day,
  // count] pairs, and the highest count among the days whose place falls in
  // [x0, x1] must sit below the label's lowest edge, so the label never
  // covers the data whatever shape the year has. The axis as it was when it
  // already does
  function roomFor(axis, highs, xAt, x0, x1, labelBottom, top, base) {
    const reach = Math.max(0, ...highs.filter(([i]) => xAt(i) >= x0 && xAt(i) <= x1).map(([, v]) => v));
    const need = reach / (1 - (labelBottom - top) / (base - top));
    return need >= axis.top ? niceAxis(need) : axis;
  }
  // the heatmap's days, January 1 to the last day, one column per week with
  // Sunday on top as the screen draws it, coloured by the board's own scale.
  // The columns share the width from left to right, so the squares are as
  // large as the weeks allow, and never so large that the seven rows pass
  // maxStep a row, so early in a year the weeks stand from the left
  function yearHeat(days, left, right, gap, maxStep = Infinity) {
    const year = days.slice(yearStart(days));
    const sc = scale(year.map(d => d.total));
    const lead = year.length ? parts(year[0].date).weekday : 0;
    const weeks = Math.floor((lead + year.length - 1) / 7) + 1;
    const step = Math.min((right - left + gap) / weeks, maxStep), cell = step - gap;
    const cells = year.map((d, i) => ({ date: d.date, total: d.total, fill: sc.colour(d.total),
                                        col: Math.floor((lead + i) / 7), row: (lead + i) % 7 }));
    const months = cells.filter(c => parts(c.date).d === 1).map(c => ({ col: c.col, label: MONTHS[parts(c.date).m - 1] }));
    return { cells, months, weeks, left, step, cell, rows: 7 * step - gap, cuts: sc.cuts, total: sum(year),
             first: year.length ? year[0].date : null, last: year.length ? year[year.length - 1].date : null };
  }
  // where a heatmap's rows start: the block of month names and seven rows set
  // in the middle of the room between two heights, and the largest row step
  // that room takes
  const heatTop = (h, from, to, names = 26) => Math.round(from + (to - from - names - h.rows) / 2) + names;
  const heatStep = (from, to, gap, names = 26) => (to - from - names + gap) / 7;

  // the pictures' daily marks at a calm (calmOf): Editorial's columns, their
  // strength and their width as a share of a day's step, and its 7-day line;
  // Lab's dots, their radius and strength, and its line. At 0 they are the
  // mock's own
  const pictureMarks = calm => ({ col: lerp(0.62, 0.3, calm), colWidth: lerp(0.62, 0.42, calm), colLine: lerp(3, 3.6, calm),
                                  dot: lerp(2.6, 1.7, calm), dotAlpha: lerp(0.55, 0.3, calm), dotLine: lerp(2.2, 2.8, calm) });

  // ---- the three looks ------------------------------------------------------
  // painting on ctx in the board's inks and faces (face), with the squid
  // (logo) and the daily marks at a calm. Each look paints a line picture,
  // line(S, shows), from a series with its spread, and a heatmap, heat(days)
  function looks(ctx, face, logo, calm = 0) {
    const INK = face.ink, SUB = face.sub, PAPER = face.paper;
    const SANS = face.sans, INTER = face.inter, MONO = face.mono || LOOK.mono;
    const M = pictureMarks(calm);
    const F = (weight, size, family = SANS) => `${weight} ${size}px ${family}`;
    const rgba = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
    const spacing = px => { if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px"; };
    function put(str, x, y, fill, font, align = "left", space = 0) {
      ctx.font = font; ctx.fillStyle = fill; ctx.textAlign = align; ctx.textBaseline = "alphabetic";
      spacing(space);
      ctx.fillText(str, x, y);
      spacing(0);
    }
    function widthOf(str, font, space = 0) {
      ctx.font = font; spacing(space);
      const w = ctx.measureText(str).width;
      spacing(0);
      return w;
    }
    // text with a ring of the paper round it, where it crosses lines
    function haloed(str, x, y, fill, font, align, ring = PAPER, width = 5) {
      ctx.save();
      ctx.font = font; ctx.textAlign = align; ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round"; ctx.lineWidth = width; ctx.strokeStyle = ring;
      ctx.strokeText(str, x, y);
      ctx.fillStyle = fill; ctx.fillText(str, x, y);
      ctx.restore();
    }
    // a run of words and little keys on one baseline; a key is { w, draw(x, y) }
    function run(items, x, y, fill, font) {
      let at = x;
      for (const it of items) {
        if (typeof it === "string") { put(it, at, y, fill, font); at += widthOf(it, font); }
        else { it.draw(at, y); at += it.w; }
      }
    }
    // the squid, the name and the link as the board sets them: the name's ink
    // ends on `right`, the squid's a little before it, both centred on `mid`,
    // and the link under them as wide as the two
    function lockup({ right, mid, size = 28, side = 38, linkGap = 8 }) {
      ctx.font = F(700, size, INTER); spacing(-0.02 * size);
      const t = ctx.measureText("Facilitator");
      const base = mid + (t.actualBoundingBoxAscent - t.actualBoundingBoxDescent) / 2;
      const nameLeft = right - t.actualBoundingBoxRight;
      ctx.fillStyle = INK; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillText("Facilitator", nameLeft, base);
      spacing(0);
      const ink = logo && logo.ink ? logo.ink : { x0: 0, y0: 0, x1: 1, y1: 1 };
      const logoX = nameLeft - t.actualBoundingBoxLeft - 6 * side / 38 - ink.x1 * side;
      const left = logoX + ink.x0 * side;
      if (logo) ctx.drawImage(logo.image, logoX, mid - (ink.y0 + ink.y1) / 2 * side, side, side);
      const bottom = Math.max(base + t.actualBoundingBoxDescent, mid + (ink.y1 - ink.y0) * side / 2);
      const linkFont = s => `300 ${s}px ${INTER}`;
      ctx.font = linkFont(20);
      const probe = ctx.measureText(REPO_LINK);
      const ls = 20 * (right - left) / ((probe.actualBoundingBoxLeft + probe.actualBoundingBoxRight) || 1);
      ctx.font = linkFont(ls);
      const link = ctx.measureText(REPO_LINK);
      ctx.fillStyle = SUB;
      ctx.fillText(REPO_LINK, left + link.actualBoundingBoxLeft, bottom + linkGap + link.actualBoundingBoxAscent);
    }
    // a line through points, or a curve through them that never overshoots
    // (slopes, as the screen's line is drawn)
    const straight = (pts, move = true) => pts.forEach(([x, y], i) => (i || !move ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    function curve(pts, { move = true, back = false } = {}) {
      const n = pts.length, t = slopes(pts);
      if (n < 3) return straight(back ? [...pts].reverse() : pts, move);
      if (!back) {
        if (move) ctx.moveTo(pts[0][0], pts[0][1]); else ctx.lineTo(pts[0][0], pts[0][1]);
        for (let i = 0; i < n - 1; i++) {
          const h = (pts[i + 1][0] - pts[i][0]) / 3;
          ctx.bezierCurveTo(pts[i][0] + h, pts[i][1] + h * t[i], pts[i + 1][0] - h, pts[i + 1][1] - h * t[i + 1], pts[i + 1][0], pts[i + 1][1]);
        }
      } else {
        if (move) ctx.moveTo(pts[n - 1][0], pts[n - 1][1]); else ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);
        for (let i = n - 2; i >= 0; i--) {
          const h = (pts[i + 1][0] - pts[i][0]) / 3;
          ctx.bezierCurveTo(pts[i + 1][0] - h, pts[i + 1][1] - h * t[i + 1], pts[i][0] + h, pts[i][1] + h * t[i], pts[i][0], pts[i][1]);
        }
      }
    }
    // a stroke with a ring of paper under it, so it stands off what it crosses
    function stroked(build, colour, width, ring = PAPER, ringWidth = width + 3) {
      ctx.save();
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      if (ring) { ctx.beginPath(); build(); ctx.strokeStyle = ring; ctx.lineWidth = ringWidth; ctx.stroke(); }
      ctx.beginPath(); build(); ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.stroke();
      ctx.restore();
    }
    const heatKey = (x, y, size) => {
      put("More", x, y, SUB, F(400, size), "right");
      x -= widthOf("More", F(400, size)) + 10;
      for (let i = PALETTE.length - 1; i >= 0; i--) { x -= 15; ctx.fillStyle = PALETTE[i]; ctx.beginPath(); ctx.roundRect(x, y - 12, 15, 15, 3.5); ctx.fill(); x -= 4; }
      put("Less", x - 6, y, SUB, F(400, size), "right");
    };
    const total = (tot, x, y, size) => {
      put(compact(tot), x, y, INK, F(600, size));
      put(" tokens this year", x + widthOf(compact(tot), F(600, size)), y, SUB, F(400, size));
    };

    // ---- Editorial: a larger title with the key in the line under it, values
    // named on their gridlines inside the chart, light columns for the days
    // and a curved deep line over them, and a quiet foot
    const editorial = {
      keys: {
        col: () => ({ w: 20, draw: (x, y) => { ctx.fillStyle = rgba(SOFT, M.col); ctx.beginPath(); ctx.roundRect(x + 5, y - 13, 7, 15, [2, 2, 0, 0]); ctx.fill(); } }),
        line: width => ({ w: 32, draw: (x, y) => stroked(() => { ctx.moveTo(x + 5, y - 5); ctx.lineTo(x + 27, y - 5); }, DEEP, width, null) }),
        band: () => ({ w: 32, draw: (x, y) => { ctx.fillStyle = rgba(LIGHT, 0.8); ctx.beginPath(); ctx.roundRect(x + 5, y - 12, 22, 14, 3); ctx.fill(); } }),
        gap: () => ({ w: 26, draw: () => {} }),
      },
      // the key under the title: each mark, then its short name
      keyRow(c) {
        const k = this.keys;
        if (c === "daily") return [k.col(), "Daily", k.gap(), k.line(M.colLine), "7-day average"];
        return [k.line(3), "2-week median", k.gap(), k.band(), "1 sigma range"];
      },
      // the content itself: g has xAt, yAt, base and the day step
      draw(S, c, g) {
        const runs = runDays(S);
        if (c === "daily") {
          const w = Math.max(1, g.step * M.colWidth);
          ctx.fillStyle = rgba(SOFT, M.col);
          for (const idx of runs) for (const i of idx) {
            const v = S.vals[i]; if (!(v > 0)) continue;
            const x = g.xAt(i), y = g.yAt(v), h = g.base - y;
            ctx.beginPath(); ctx.roundRect(x - w / 2, y, w, h, h > 2 ? [Math.min(1.5, w / 2), Math.min(1.5, w / 2), 0, 0] : 0); ctx.fill();
          }
          for (const idx of runs) stroked(() => curve(idx.map(i => [g.xAt(i), g.yAt(S.avg[i])])), DEEP, M.colLine, PAPER, M.colLine + 3);
        } else {
          for (const idx of runs) {
            ctx.beginPath();
            curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].hi)]));
            curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].lo)]), { move: false, back: true });
            ctx.closePath(); ctx.fillStyle = rgba(LIGHT, 0.8); ctx.fill();
          }
          for (const idx of runs) stroked(() => curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].mid)])), DEEP, 3, PAPER, 6);
        }
      },
      head(L, R) {
        const titleFont = F(600, 30);
        put(PIC_TITLE, L, 70, INK, titleFont, "left", -0.3);
        ctx.font = titleFont; const tm = ctx.measureText(PIC_TITLE);
        lockup({ right: R, mid: 70 - (tm.actualBoundingBoxAscent - tm.actualBoundingBoxDescent) / 2 });
      },
      line(S, c) {
        const W = 1200, H = 600, L = 40, R = 1160;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
        this.head(L, R);
        run(this.keyRow(c).map(it => (typeof it === "string" ? " " + it : it)), L, 101, SUB, F(400, 17));
        const top = 134, base = 484, x0 = L + 2, x1 = R - 2, xAt = xMap(x0, x1, 0, S.n - 1);
        let axis = niceAxis(peakOf(S, c));
        // the install label stands left of its line at the top; the axis makes room for it
        if (S.install >= 0) {
          const x = xAt(S.install), w = Math.max(widthOf(INSTALLED, F(500, 13)), widthOf(longDate(S.shown[S.install].date), F(400, 13)));
          axis = roomFor(axis, highsOf(S, c), xAt, x - 12 - w, x - 4, top + 36, top, base);
        }
        const g = { xAt, yAt: v => base - v / axis.top * (base - top), base, step: (x1 - x0) / Math.max(1, S.n - 1) };
        // gridlines, each named where it starts, the floor a shade stronger
        for (const t of axis.ticks) {
          const y = Math.round(g.yAt(t)) + 0.5;
          ctx.fillStyle = t ? "#E4DED5" : "#B9B1A5"; ctx.fillRect(L, y - 0.5, R - L, 1);
          if (t) put(compact(t), L, y - 7, SUB, F(400, 14));
        }
        // the day Facilitator was installed, named at the top
        if (S.install >= 0) {
          const x = Math.round(g.xAt(S.install)) + 0.5;
          ctx.fillStyle = rgba(INK, 0.3); ctx.fillRect(x - 0.5, top - 6, 1, base - top + 6);
          haloed(INSTALLED, x - 8, top + 6, INK, F(500, 13), "right");
          haloed(longDate(S.shown[S.install].date), x - 8, top + 23, SUB, F(400, 13), "right");
        }
        this.draw(S, c, g);
        // months along the floor
        for (const m of S.months) {
          const x = Math.round(g.xAt(m.i)) + 0.5;
          ctx.fillStyle = "#B9B1A5"; ctx.fillRect(x - 0.5, base, 1, 5);
          put(m.label, x, base + 24, SUB, F(400, 14));
        }
        // the foot
        ctx.fillStyle = "#DDD6CB"; ctx.fillRect(L, 530, R - L, 1);
        total(S.total, L, 562, 17);
        put(spanWords(S), R, 562, SUB, F(400, 15), "right");
      },
      heat(days) {
        const W = 1200, L = 40, R = 1160;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, 400);
        this.head(L, R);
        const h = yearHeat(days, L + 44, R, 5, heatStep(108, 336, 5)), top = heatTop(h, 108, 336);
        put(`${longDate(h.first)} to ${longDate(h.last)}, ${parts(h.last).y}`, L, 101, SUB, F(400, 17));
        for (const mo of h.months) put(mo.label, h.left + mo.col * h.step, top - 12, SUB, F(400, 14));
        for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]]) put(name, L, top + row * h.step + h.cell / 2 + 5, SUB, F(400, 14));
        for (const c of h.cells) { ctx.fillStyle = c.fill; ctx.beginPath(); ctx.roundRect(h.left + c.col * h.step, top + c.row * h.step, h.cell, h.cell, 4); ctx.fill(); }
        ctx.fillStyle = "#DDD6CB"; ctx.fillRect(L, 336, R - L, 1);
        total(h.total, L, 366, 17);
        heatKey(R, 366, 15);
      },
    };

    // ---- Lab: two axes only, the left and the floor, with ticks inward and
    // the floor set a little under zero so a day at zero is still seen,
    // numbers in Plex Mono, the axis named up the side, and a legend of short
    // names in whichever top corner the data leaves empty, or, where neither
    // is, with the axis raised to make room for it, so it never covers the
    // data whatever its shape
    const lab = {
      draw(S, c, g) {
        const runs = runDays(S);
        if (c === "daily") {
          ctx.fillStyle = rgba(MID, M.dotAlpha);
          for (const idx of runs) for (const i of idx) { ctx.beginPath(); ctx.arc(g.xAt(i), g.yAt(S.vals[i]), M.dot, 0, 7); ctx.fill(); }
          for (const idx of runs) stroked(() => straight(idx.map(i => [g.xAt(i), g.yAt(S.avg[i])])), DEEP, M.dotLine, null);
        } else {
          ctx.strokeStyle = DEEP; ctx.lineWidth = 1.5; ctx.lineCap = "butt";
          for (const b of S.bins) {
            const x = g.xAt(b.at), y1 = g.yAt(b.hi), y0 = g.yAt(b.lo);
            ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1);
            ctx.moveTo(x - 4.5, y0); ctx.lineTo(x + 4.5, y0); ctx.moveTo(x - 4.5, y1); ctx.lineTo(x + 4.5, y1); ctx.stroke();
          }
          for (const b of S.bins) {
            ctx.beginPath(); ctx.arc(g.xAt(b.at), g.yAt(b.mid), 4.2, 0, 7);
            ctx.fillStyle = DEEP; ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = PAPER; ctx.stroke();
          }
        }
      },
      // the highest thing drawn at each place across, for the legend to keep clear of
      highs(S, c, g) {
        if (c === "dots") return S.bins.map(b => [g.xAt(b.at), b.hi]);
        return S.vals.map((v, i) => [g.xAt(i), Math.max(v, S.avg[i])]);
      },
      legend(c) {
        const dot = (x, y, r, fill) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); };
        const ln = (x, y, colour, w) => { ctx.strokeStyle = colour; ctx.lineWidth = w; ctx.lineCap = "butt"; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 24, y); ctx.stroke(); };
        if (c === "daily") return [[(x, y) => { for (const dx of [6, 12, 18]) dot(x + dx, y, M.dot, rgba(MID, M.dotAlpha)); }, "Daily"],
                                   [(x, y) => ln(x, y, DEEP, M.dotLine), "7-day average"]];
        return [[(x, y) => dot(x + 12, y, 4.2, DEEP), "Weekly median"],
                [(x, y) => { ctx.strokeStyle = DEEP; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 12, y - 8); ctx.lineTo(x + 12, y + 8);
                             ctx.moveTo(x + 7.5, y - 8); ctx.lineTo(x + 16.5, y - 8); ctx.moveTo(x + 7.5, y + 8); ctx.lineTo(x + 16.5, y + 8); ctx.stroke(); },
                 "1 sigma range"]];
      },
      head(L, R) {
        const titleFont = F(600, 26);
        put(PIC_TITLE, L, 62, INK, titleFont, "left", -0.2);
        ctx.font = titleFont; const tm = ctx.measureText(PIC_TITLE);
        lockup({ right: R, mid: 62 - (tm.actualBoundingBoxAscent - tm.actualBoundingBoxDescent) / 2, size: 26, side: 35 });
      },
      line(S, c) {
        const W = 1200, H = 600, L = 36, R = 1164;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
        this.head(L, R);
        // the plot: zero at `base`, the floor axis a little under it, the left axis a little before the first day
        const fx0 = 114, top = 112, base = 474, floor = 484, x0 = fx0 + 14, x1 = R - 8;
        const xAt = xMap(x0, x1, 0, S.n - 1);
        const rows = this.legend(c), lf = F(400, 13.5);
        const lw = 46 + Math.max(...rows.map(r => widthOf(r[1], lf))) + 18, lh = 12 + rows.length * 22;
        const ly = top + 12, need = ly + lh + 10 - top, highs = this.highs(S, c, { xAt });
        const reach = lx => Math.max(0, ...highs.filter(([x]) => x >= lx - 10 && x <= lx + lw + 10).map(([, v]) => v));
        const instX = S.install >= 0 ? xAt(S.install) : -1e9;
        // the install label stands right of its line, or, where that would
        // pass the plot's right edge (a board first started not long ago),
        // left of it
        const markW = S.install >= 0 ? Math.max(widthOf(INSTALLED, F(500, 12.5)), widthOf(shortDate(S.last) + ", 2026", F(400, 12, MONO))) : 0;
        const markRight = instX + 11 + markW <= R;
        const clearOfMark = lx => (markRight ? lx > instX + 150 || lx + lw < instX - 4 : lx > instX + 4 || lx + lw < instX - 11 - markW);
        const fits = (lx, axisTop) => reach(lx) / axisTop < 1 - need / (base - top) && clearOfMark(lx);
        // the axis is fitted to the highest thing drawn, the days' dots included
        const peak = Math.max(0, ...highs.map(([, v]) => v));
        let axis = niceAxis(peak), lx = fx0 + 16;
        if (!fits(lx, axis.top)) {
          const right = R - 8 - lw;
          if (fits(right, axis.top)) lx = right;
          else axis = niceAxis(Math.max(peak, reach(lx) / (1 - need / (base - top))));
        }
        // the install label stands at the top beside its line; the axis makes room for it too
        if (S.install >= 0)
          axis = markRight ? roomFor(axis, highs, x => x, instX + 3, instX + 11 + markW, top + 36, top, base)
                           : roomFor(axis, highs, x => x, instX - 11 - markW, instX - 3, top + 36, top, base);
        const g = { xAt, yAt: v => base - v / axis.top * (base - top) };
        const axisInk = "#4A4239", grid = "#E9E3D9";
        // faint lines at each named count, then the two axes and their ticks, all under the data
        for (const t of axis.ticks) { ctx.fillStyle = grid; ctx.fillRect(fx0 + 1, Math.round(g.yAt(t)), R - fx0 - 1, 1); }
        ctx.fillStyle = axisInk;
        ctx.fillRect(fx0, top, 1, floor - top + 1);
        ctx.fillRect(fx0, floor, R - fx0, 1);
        ctx.beginPath(); ctx.strokeStyle = axisInk; ctx.lineWidth = 1;
        for (const t of axis.ticks) {
          const y = Math.round(g.yAt(t)) + 0.5, half = Math.round(g.yAt(t + axis.step / 2)) + 0.5;
          ctx.moveTo(fx0, y); ctx.lineTo(fx0 + 7, y);
          if (t + axis.step / 2 <= axis.top) { ctx.moveTo(fx0, half); ctx.lineTo(fx0 + 3.5, half); }
        }
        for (const m of S.months) { const x = Math.round(g.xAt(m.i)) + 0.5; ctx.moveTo(x, floor); ctx.lineTo(x, floor - 7); }
        for (const a of S.blocks) if (a > 0) { const x = Math.round(g.xAt(a - 0.5)) + 0.5; ctx.moveTo(x, floor); ctx.lineTo(x, floor - 3.5); }
        ctx.stroke();
        // the install day
        if (S.install >= 0) {
          const x = Math.round(g.xAt(S.install)) + 0.5;
          ctx.save(); ctx.strokeStyle = rgba(INK, 0.5); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, floor); ctx.stroke(); ctx.restore();
          const tx = markRight ? x + 7 : x - 7, align = markRight ? "left" : "right";
          haloed(INSTALLED, tx, top + 12, INK, F(500, 12.5), align);
          haloed(shortDate(S.shown[S.install].date) + ", " + parts(S.last).y, tx, top + 28, SUB, F(400, 12, MONO), align);
        }
        this.draw(S, c, g);
        // names: counts up the left, months along the floor, the axis up the side
        for (const t of axis.ticks) put(compact(t), fx0 - 9, Math.round(g.yAt(t)) + 4.5, SUB, F(400, 13, MONO), "right");
        for (const m of S.months) put(m.label, g.xAt(m.i), floor + 22, SUB, F(400, 13, MONO), "center");
        ctx.save(); ctx.translate(48, (top + base) / 2); ctx.rotate(-Math.PI / 2);
        put("Tokens per day", 0, 0, SUB, F(500, 13), "center"); ctx.restore();
        // the legend
        ctx.fillStyle = PAPER; ctx.fillRect(lx, ly, lw, lh);
        ctx.strokeStyle = "#CFC7BB"; ctx.lineWidth = 1; ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
        rows.forEach(([key, words], k) => { const y = ly + 17 + k * 22; key(lx + 12, y); put(words, lx + 46, y + 4.5, INK, lf); });
        // the foot
        total(S.total, L, 564, 16);
        put(`${S.n} days, ${shortDate(S.first)} to ${shortDate(S.last)}, ${parts(S.last).y}`, R, 564, SUB, F(400, 13, MONO), "right");
      },
      heat(days) {
        const W = 1200, L = 36, R = 1164;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, 400);
        this.head(L, R);
        const h = yearHeat(days, L + 40, R, 3, heatStep(98, 326, 3)), top = heatTop(h, 98, 326);
        put(`${shortDate(h.first)} to ${shortDate(h.last)}, ${parts(h.last).y}`, L, 87, SUB, F(400, 13.5, MONO));
        for (const mo of h.months) put(mo.label, h.left + mo.col * h.step, top - 10, SUB, F(400, 13, MONO));
        for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]]) put(name, L, top + row * h.step + h.cell / 2 + 4.5, SUB, F(400, 13, MONO));
        for (const c of h.cells) { ctx.fillStyle = c.fill; ctx.beginPath(); ctx.roundRect(h.left + c.col * h.step, top + c.row * h.step, h.cell, h.cell, 1.5); ctx.fill(); }
        total(h.total, L, 364, 16);
        // the colour key with the counts, to two figures, where one shade gives
        // way to the next
        const sw = 50, kx = R - PALETTE.length * sw, ky = 336;
        PALETTE.forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(kx + i * sw, ky, sw, 11); });
        ctx.strokeStyle = "#4A4239"; ctx.lineWidth = 1; ctx.strokeRect(kx + 0.5, ky + 0.5, PALETTE.length * sw - 1, 10);
        put("0", kx + sw / 2, ky + 28, SUB, F(400, 12, MONO), "center");
        h.cuts.forEach((v, k) => {
          const x = kx + (k + 2) * sw;
          ctx.fillStyle = "#4A4239"; ctx.fillRect(x - 0.5, ky + 11, 1, 4);
          put(compact(Number(v.toPrecision(2))), x, ky + 28, SUB, F(400, 12, MONO), "center");
        });
        put("tokens a day", kx - 12, ky + 10, SUB, F(400, 12, MONO), "right");
      },
    };

    // ---- Poster: the year's total as the headline, the title under it in
    // the deep colour over the chart, so the total never reads as a day's,
    // the band and the bars shaded light to deep by height the way the
    // heatmap is, a tag on the install day, notes on a quiet start and the
    // high point, and no foot
    const poster = {
      shade(top, base, alpha = 1) {
        const g = ctx.createLinearGradient(0, top, 0, base);
        g.addColorStop(0, rgba(DEEP, alpha)); g.addColorStop(0.38, rgba(MID, alpha));
        g.addColorStop(0.72, rgba(SOFT, alpha)); g.addColorStop(1, rgba(PALE, alpha));
        return g;
      },
      draw(S, c, g) {
        const runs = runDays(S), fill = this.shade(g.top, g.base);
        if (c === "band") {
          ctx.save(); ctx.globalAlpha = 0.8;
          for (const idx of runs) {
            ctx.beginPath();
            curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].hi)]));
            curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].lo)]), { move: false, back: true });
            ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
          }
          ctx.restore();
          for (const idx of runs) stroked(() => curve(idx.map(i => [g.xAt(i), g.yAt(S.band[i].mid)])), DEEP, 3, PAPER, 6);
        } else {
          const w = 18;
          for (const b of S.bins) {
            const x = g.xAt(b.at), y1 = g.yAt(b.hi) - w / 2, y0 = g.yAt(b.lo) + w / 2;
            ctx.fillStyle = fill; ctx.beginPath();
            ctx.roundRect(x - w / 2, y1, w, Math.min(y0, g.base) - y1, [w / 2, w / 2, y0 > g.base ? 2 : w / 2, y0 > g.base ? 2 : w / 2]); ctx.fill();
          }
          for (const b of S.bins) {
            ctx.beginPath(); ctx.arc(g.xAt(b.at), g.yAt(b.mid), 5.5, 0, 7);
            ctx.fillStyle = PAPER; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = DEEP; ctx.stroke();
          }
        }
      },
      keys(c) {
        const line = { w: 30, draw: (x, y) => stroked(() => { ctx.moveTo(x, y - 5); ctx.lineTo(x + 22, y - 5); }, DEEP, 3, null) };
        const band = { w: 30, draw: (x, y) => { ctx.save(); ctx.globalAlpha = 0.8; ctx.fillStyle = this.shade(y - 14, y + 2); ctx.beginPath(); ctx.roundRect(x, y - 13, 22, 15, 3); ctx.fill(); ctx.restore(); } };
        const ring = { w: 16, draw: (x, y) => { ctx.beginPath(); ctx.arc(x + 7, y - 5, 5, 0, 7); ctx.fillStyle = PAPER; ctx.fill(); ctx.lineWidth = 2.6; ctx.strokeStyle = DEEP; ctx.stroke(); } };
        const capsule = { w: 16, draw: (x, y) => { ctx.fillStyle = this.shade(y - 18, y + 4); ctx.beginPath(); ctx.roundRect(x + 1, y - 17, 12, 24, 6); ctx.fill(); } };
        if (c === "band") return [line, "2-week median", "      ", band, "1 sigma range"];
        return [ring, "Weekly median", "      ", capsule, "1 sigma range"];
      },
      // the headline: the year's total, large, then "tokens this year", and
      // under it the title in the deep colour; the squid, the name and the
      // link stand on the total's middle
      head(tot, L, R) {
        const big = F(600, 78), base = 100;
        put(compact(tot), L - 3, base, INK, big, "left", -2.4);
        put(" tokens this year", L - 3 + widthOf(compact(tot), big, -2.4) + 4, base, SUB, F(400, 24));
        ctx.font = big; spacing(-2.4);
        const tm = ctx.measureText(compact(tot));
        spacing(0);
        lockup({ right: R, mid: base - (tm.actualBoundingBoxAscent - tm.actualBoundingBoxDescent) / 2, size: 30, side: 42 });
        put(PIC_TITLE, L, 146, DEEP, F(600, 18), "left", 0.2);
      },
      line(S, c) {
        const W = 1200, H = 600, L = 44, R = 1156;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
        this.head(S.total, L, R);
        run(this.keys(c).map((it, i) => (typeof it === "string" && i ? " " + it : it)), L, 186, SUB, F(400, 15));

        const top = 226, base = 528, x0 = L, x1 = R - 40;
        const xAt = xMap(x0, x1, 0, S.n - 1);
        // the install tag's place, which does not hang on the counts
        const tagY = top + 6, tagFont = F(600, 13.5);
        let tagBox = null;
        if (S.install >= 0) {
          const x = Math.round(xAt(S.install)) + 0.5, tw = widthOf(INSTALLED, tagFont) + 30;
          tagBox = { x, x0: x - tw / 2, x1: x + tw / 2, y1: tagY + 28 };
        }
        // the high point's note: at the top of the chart to the left of the point,
        // else to its right, else under the install tag, whichever is first clear
        // of the tag and of the data. A point just after the install day (a
        // board first started not long ago) has the tag's line between it and
        // those places, so last comes a place under the tag on the far side of
        // its line, the leader running across to the point (side 2). Where none
        // is clear, the axis is raised until the note is, so it reads whatever
        // shape the year has
        const hi = highOf(S, c), nf = [F(600, 14), F(400, 14)];
        const nw = Math.max(widthOf(hi.words[0], nf[0]), widthOf(hi.words[1], nf[1]));
        const under = tagBox ? tagBox.y1 + 26 : top + 50;
        const plan = axisTop => {
          const g = { xAt, yAt: v => base - v / axisTop * (base - top), top, base }, hx = xAt(hi.i), tops = this.tops(S, c, g);
          const box = ([side, ny]) => (side === 2
            ? { x0: tagBox.x < hx ? tagBox.x - 10 - nw : tagBox.x + 10, x1: tagBox.x < hx ? tagBox.x - 10 : tagBox.x + 10 + nw, y0: ny - 15, y1: ny + 27 }
            : { x0: side < 0 ? hx - 14 - nw : hx + 14, x1: side < 0 ? hx - 14 : hx + 14 + nw, y0: ny - 15, y1: ny + 27 });
          const inside = b => b.x0 >= x0 && b.x1 <= x1;
          // clear of the tag, and of its line down to the floor
          const offTag = b => !(tagBox && ((b.x0 < tagBox.x1 + 8 && b.x1 > tagBox.x0 - 8 && b.y0 < tagBox.y1 + 4) ||
                                           (tagBox.x > b.x0 - 6 && tagBox.x < b.x1 + 6)));
          const clear = b => inside(b) && offTag(b) && tops.every(([x, y]) => x < b.x0 - 4 || x > b.x1 + 4 || y > b.y1 + 10);
          const spots = [[-1, top + 8], [1, top + 8], [-1, under], [1, under], ...(tagBox ? [[2, under]] : [])];
          return { g, hx, box, spot: spots.find(sp => clear(box(sp))),
                   first: spots.find(sp => inside(box(sp)) && offTag(box(sp))) || spots.find(sp => inside(box(sp))) || spots[0] };
        };
        // a high point of zero (a year whose median day is a day off) has no note
        const noted = hi.v > 0;
        // the tag itself keeps clear of the data under it first
        let axis = niceAxis(peakOf(S, c));
        if (tagBox) axis = roomFor(axis, highsOf(S, c), xAt, tagBox.x0 - 13, tagBox.x1 + 13, tagBox.y1 + 15, top, base);
        let p = plan(axis.top);
        if (noted && !p.spot) {
          const b = p.box(p.first);
          axis = roomFor(axis, highsOf(S, c), xAt, b.x0 - 13, b.x1 + 13, b.y1 + 19, top, base);
          p = plan(axis.top);
          p.spot = p.spot || p.first;
        }
        const g = p.g;
        // gridlines, dashed, named in the right margin
        ctx.save(); ctx.setLineDash([2, 5]); ctx.strokeStyle = "#D6CDBF"; ctx.lineWidth = 1;
        for (const t of axis.ticks) if (t) { const y = Math.round(g.yAt(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1 + 6, y); ctx.stroke(); }
        ctx.restore();
        for (const t of axis.ticks) if (t) put(compact(t), R, Math.round(g.yAt(t)) + 5, SUB, F(500, 14), "right");
        // the install day, a tag (the squid stays only at the top right)
        if (tagBox) { ctx.fillStyle = rgba(INK, 0.35); ctx.fillRect(tagBox.x - 0.5, tagY + 26, 1, base - tagY - 26); }
        this.draw(S, c, g);
        ctx.fillStyle = INK; ctx.fillRect(x0, base, x1 - x0, 1.5);
        if (tagBox) {
          ctx.fillStyle = PAPER; ctx.beginPath(); ctx.roundRect(tagBox.x0, tagY, tagBox.x1 - tagBox.x0, 28, 14); ctx.fill();
          ctx.strokeStyle = "#DCCFC0"; ctx.lineWidth = 1; ctx.stroke();
          put(INSTALLED, tagBox.x0 + 15, tagY + 19, INK, tagFont);
        }
        // months under the floor
        for (const m of S.months) {
          const x = Math.round(g.xAt(m.i)) + 0.5;
          ctx.fillStyle = INK; ctx.fillRect(x - 0.5, base, 1, 7);
          put(m.label, x + 5, base + 25, SUB, F(500, 15));
        }
        // the quiet start: the first 13 days never reached half a million a day.
        // The note points at the day nearest the middle of them that is not in a gap
        const quiet = S.vals.slice(0, 13), qmax = Math.max(...quiet);
        if (S.n >= 13 && qmax < 5e5) {
          const near = quiet.map((_, i) => i).filter(i => !S.gap[i]).sort((a, b) => Math.abs(a - 6) - Math.abs(b - 6))[0] ?? 6;
          const ax = g.xAt(near), ay = base - 4;
          ctx.fillStyle = INK; ctx.fillRect(Math.round(ax), base - 64, 1, 58);
          ctx.beginPath(); ctx.arc(ax + 0.5, ay, 3, 0, 7); ctx.fill();
          const end = S.shown[12].date, words = parts(end).m === parts(S.first).m ? parts(end).d : shortDate(end);
          put(`${shortDate(S.first)} to ${words}`, ax - 6, base - 88, INK, F(600, 14));
          put("under 500K a day", ax - 6, base - 70, SUB, F(400, 14));
        }
        // the high point and its note, in the place planned above, with a leader down to it
        if (!noted) return;
        const [side, ny] = p.spot, hx = p.hx, hy = g.yAt(hi.v);
        ctx.fillStyle = INK;
        // a note across the tag's line reaches over to the point, then up or down to it
        const across = side === 2, b = p.box(p.spot), left = b.x1 <= hx;
        if (across) {
          const near = left ? b.x1 + 4 : b.x0 - 4;
          ctx.fillRect(Math.min(near, hx), ny - 0.5, Math.abs(hx - near), 1);
          if (Math.abs(hy - ny) > 9) ctx.fillRect(hx - 0.5, Math.min(ny, hy + 7), 1, Math.abs(hy - ny) - 7);
        } else if (hy - 7 > ny + 2) { ctx.fillRect(side < 0 ? hx - 9 : hx, ny - 0.5, 9, 1); ctx.fillRect(hx - 0.5, ny, 1, hy - 7 - ny); }
        ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fillStyle = PAPER; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = INK; ctx.stroke();
        const nx = across ? (left ? b.x1 : b.x0) : side < 0 ? hx - 14 : hx + 14, align = (across ? left : side < 0) ? "right" : "left";
        haloed(hi.words[0], nx, ny + 4, INK, nf[0], align);
        haloed(hi.words[1], nx, ny + 22, SUB, nf[1], align);
      },
      // the top of what is drawn at each place across, for the notes to keep clear of
      tops(S, c, g) {
        if (c === "dots") return S.bins.flatMap(b => [[g.xAt(b.at) - 9, g.yAt(b.hi) - 9], [g.xAt(b.at) + 9, g.yAt(b.hi) - 9]]);
        return S.vals.map((v, i) => [g.xAt(i), g.yAt(S.band[i].hi)]);
      },
      // the heatmap's days are squares, as in the other two looks
      heat(days) {
        const W = 1200, L = 44, R = 1156;
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, 400);
        const h = yearHeat(days, L + 42, R, 5, heatStep(160, 380, 5)), top = heatTop(h, 160, 380);
        this.head(h.total, L, R);
        for (const mo of h.months) put(mo.label, h.left + mo.col * h.step, top - 12, SUB, F(500, 14));
        for (const [row, name] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]]) put(name, L, top + row * h.step + h.cell / 2 + 5, SUB, F(400, 14));
        for (const c of h.cells) { ctx.fillStyle = c.fill; ctx.beginPath(); ctx.roundRect(h.left + c.col * h.step, top + c.row * h.step, h.cell, h.cell, 4); ctx.fill(); }
        heatKey(R, 146, 15);
      },
    };
    return { editorial, lab, poster };
  }
  // one picture of a chart, DICE[kind][pick], painted on ctx at its laid out
  // size: a heatmap of this year's days, or a line from where use began.
  // calm is for tests and the proof frames; a picture works its own out
  function paintLook(ctx, kind, pick, days, installed, face = LOOK, logo = null, calm) {
    const [look, shows] = DICE[kind][pick];
    if (kind === "heatmap") return looks(ctx, face, logo)[look].heat(days);
    const S = spreadOf(seriesOf(days, pictureStart(days), installed));
    looks(ctx, face, logo, calm == null ? calmOf(S.vals) : calm)[look].line(S, shows);
  }

  // the faces and the squid are fetched ahead, when the panel first has a
  // reading, so that pressing the button paints at once: a phone only lets the
  // share sheet open for a moment after the press
  // the squid's file has clear margin round it, so its ink box is found once
  // (as fractions of the file) for the heading to be centred on and sized by
  let logoLoad = null;
  function inkBox(img) {
    const fallback = { x0: 0, y0: 0, x1: 1, y1: 1 };
    try {
      const size = 160, c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, size, size);
      const px = g.getImageData(0, 0, size, size).data;
      let x0 = size, y0 = size, x1 = -1, y1 = -1;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
        if (px[(y * size + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return x1 < 0 ? fallback : { x0: x0 / size, y0: y0 / size, x1: (x1 + 1) / size, y1: (y1 + 1) / size };
    } catch (err) { return fallback; }
  }
  function loadLogo() {
    if (!logoLoad) logoLoad = new Promise(done => {
      if (typeof Image !== "function") return done(null);
      const img = new Image();
      img.onload = () => done({ image: img, ink: inkBox(img) });
      img.onerror = () => done(null);
      img.src = LOGO_SRC;
    });
    return logoLoad;
  }
  // the one font the picture carries itself (INTER_LATIN, at the foot of this
  // file), added to the page's faces once
  let interLoad = null;
  function loadInter(doc) {
    if (!interLoad) interLoad = Promise.resolve().then(() => {
      if (typeof FontFace !== "function" || !doc.fonts || !doc.fonts.add) return;
      const face = new FontFace(INTER_EXPORT, `url(data:font/woff2;base64,${INTER_LATIN})`, { weight: "100 900" });
      return face.load().then(f => { doc.fonts.add(f); }).catch(() => { interLoad = null; });
    });
    return interLoad;
  }
  function loadFaces(doc, look) {
    const set = doc.fonts;
    if (!set || typeof set.load !== "function") return Promise.resolve();
    return Promise.all([loadInter(doc), ...[`400 13px ${look.sans}`, `500 13px ${look.sans}`, `600 24px ${look.sans}`,
                                            `400 13px ${look.mono || LOOK.mono}`]
      .map(f => set.load(f).catch(() => null))]).then(() => {});
  }
  function lookOf(node) {
    const view = node.ownerDocument && node.ownerDocument.defaultView;
    const css = view && view.getComputedStyle ? view.getComputedStyle(node) : null;
    const get = (name, fallback) => (css && css.getPropertyValue(name).trim()) || fallback;
    return { ink: get("--ink", LOOK.ink), sub: get("--sub", LOOK.sub), line: get("--line", LOOK.line),
             paper: LOOK.paper, sans: get("--sans", LOOK.sans), mono: get("--mono", LOOK.mono),
             inter: `"${INTER_EXPORT}", ` + get("--inter", LOOK.inter) };
  }
  // the canvas a picture is painted on, at three times its laid out size
  function pictureCanvas(doc, kind, pick, days, installed, look, logo, calm) {
    const [width, height] = SHAPES[SHAPE_OF[kind]];
    const canvas = doc.createElement("canvas");
    canvas.width = width * PIC_SCALE;
    canvas.height = height * PIC_SCALE;
    const ctx = canvas.getContext("2d");
    ctx.scale(PIC_SCALE, PIC_SCALE);
    paintLook(ctx, kind, pick, days, installed, look, logo, calm);
    return canvas;
  }
  function pictureBlob(canvas) {
    return new Promise((done, fail) => canvas.toBlob(b => (b ? done(b) : fail(new Error("no picture"))), "image/png"));
  }
  // a picture's file name: facilitator_20261020_Robin.png, the day as eight
  // figures and the first word of the profile's name as it was typed (no
  // other file name the board gives holds a name, so it is not lowercased),
  // then _2, _3 for the day's second and third. A name with nothing a file
  // name can carry, or no name, is left out: facilitator_20261020_2.png
  const dayStamp = now => {
    const d = new Date(now), pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  };
  function pictureName(now, name, n = 1) {
    const first = (String(name || "").trim().split(/\s+/)[0] || "").replace(/[^\p{L}\p{N}_-]/gu, "");
    return ["facilitator", dayStamp(now), first, n > 1 ? String(n) : ""].filter(Boolean).join("_") + ".png";
  }
  // which number the day's next picture gets, counted in this browser, which
  // is where the files go: the browser adds " (1)" of its own to a name it
  // has saved before, so the board numbers them itself. next() only reads;
  // take() counts the file in
  const PICTURES_KEY = "home.pictures";
  function pictureCount(store) {
    const owner = store || noStore;
    function read(day) {
      let kept = (memory.get(owner) || {})[PICTURES_KEY];
      try { const saved = store && JSON.parse(store.getItem(PICTURES_KEY)); if (record(saved)) kept = saved; } catch (err) {}
      return record(kept) && kept.day === day && Number.isInteger(kept.count) && kept.count > 0 ? kept.count : 0;
    }
    return {
      next: now => read(dayStamp(now)) + 1,
      take(now) {
        const day = dayStamp(now), kept = { day, count: read(day) + 1 };
        const saved = memory.get(owner) || {};
        saved[PICTURES_KEY] = kept;
        memory.set(owner, saved);
        try { if (store) store.setItem(PICTURES_KEY, JSON.stringify(kept)); } catch (err) {}
        return kept.count;
      },
    };
  }
  // the picture as a file the browser can hand to the share sheet, or null
  // where it cannot
  function shareable(win, blob, name) {
    const nav = win && win.navigator;
    if (!nav || typeof nav.canShare !== "function" || typeof File !== "function") return null;
    const file = new File([blob], name, { type: "image/png" });
    return nav.canShare({ files: [file] }) ? file : null;
  }
  // a phone that can share a file keeps the picture for the overlay's Share,
  // which opens the share sheet, to go to Photos or Files; the Mac, and a
  // phone whose browser cannot share a file, saves a download
  async function deliver(doc, blob, name, share) {
    if (share && shareable(doc.defaultView, blob, name)) return "ready";
    const url = URL.createObjectURL(blob), link = doc.createElement("a");
    link.href = url; link.download = name; link.style.display = "none";
    // the board's link guard (card-logic.js) takes every link click for a card's
    // link and asks what to do; it lets this one through
    const win = doc.defaultView;
    if (win && typeof win.clickDownload === "function") win.clickDownload(link);
    else { doc.body.appendChild(link); link.click(); link.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return "downloaded";
  }
  // the PNG of one look of a chart, DICE[kind][pick]; calm is for tests
  async function picture({ doc, kind, pick = 0, days, installed, look, calm }) {
    const face = look || lookOf(doc.documentElement);
    const [logo] = await Promise.all([loadLogo(), loadFaces(doc, face)]);
    return pictureBlob(pictureCanvas(doc, kind, pick, days, installed, face, logo, calm));
  }

  // ---- the picture's overlay -----------------------------------------------
  // the picture just made, shown on the board's glass (.qn-glass) over the
  // settings page's veil (.sp-veil), both in card-tokens.css, which every page
  // that draws the panel loads; the sizes are home-widgets.css's. Over the
  // picture "Chart downloaded!" (or "Chart ready!" on a phone that has saved
  // nothing yet), the panel's heatmap or line pill and the magic box's cross;
  // the picture let into the glass, flat; under it, in the board's glass, the
  // dice, which tumbles in its circle and swaps in another look of the chart
  // on show (DICE), the download button, which saves the chart on show as a
  // new file, and Share, a pill with the link mark in the middle of the row,
  // and a line for what went wrong. The pill's other chart glides the box to
  // its height as the picture fades across, and the dice lays a soft cover
  // and a spinner over the picture until the next look is drawn, which then
  // fades in as the cover goes. A press that starts and ends on the veil,
  // Escape and the cross put it away, no key goes on to the page it covers,
  // and focus cannot wander behind it. It is taken out of the page once its
  // fade has run, and its pictures' addresses with it
  const SHOT_ICONS = {
    check: ICON('<path d="M20 6 9 17l-5-5"/>'),
    // Lucide's link (ISC)
    share: ICON('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
                '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  };
  // a die's face, Lucide's dice (ISC) with the pips as filled dots
  const PIPS = { 1: [[12, 12]], 2: [[15.5, 8.5], [8.5, 15.5]], 3: [[16, 8], [12, 12], [8, 16]],
                 4: [[8, 8], [16, 8], [8, 16], [16, 16]], 5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]],
                 6: [[8, 7.5], [16, 7.5], [8, 12], [16, 12], [8, 16.5], [16, 16.5]] };
  const dieFace = n => '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect width="18" height="18" x="3" y="3" rx="3"/>' +
    PIPS[n].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" fill="currentColor" stroke="none"/>`).join("") + "</svg>";
  // the card bar's cross (MAGIC_CROSS in card-logic.js)
  const SHOT_CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3333" ' +
    'stroke-linecap="round" aria-hidden="true"><path d="M1.936 1.936L8.064 8.064M8.064 1.936L1.936 8.064"></path></svg>';
  const SHOT_FADE = 320;                        // the veil's .26s fade out, and a little over
  const SHOT_WORDS = { share: "Could not share the picture.", save: "Could not save the picture.",
                       draw: "Could not draw that chart." };
  const SHOT_TITLES = { saved: "Chart downloaded!", ready: "Chart ready!" };
  const KIND_NAMES = { heatmap: "heatmap", line: "line chart" };
  // the die tumbles this long, its face turning this many times on the way;
  // a glass button stays pressed at least GLASS_HOLD, as the bar's do
  const ROLL_MS = 650, ROLL_TURNS = 3, GLASS_HOLD = 120;
  // the box changes size between the heatmap and the line on the time and
  // curve a card's picture zooms on (CARD_PICTURE_MS, CARD_PICTURE_EASE in
  // card-logic.js), and the pictures fade across on the same clock; with
  // reduced motion the size changes at once and the pictures only fade, as
  // quickly as the magic box does (BIG_FADE_MS in index.html). the dice's
  // cover fades in over the picture on the board's gentle curve
  const SHOT_GLIDE_MS = 300, SHOT_GLIDE_EASE = "cubic-bezier(0.25, 1, 0.5, 1)", SHOT_STILL_MS = 160;
  const SHOT_COVER_MS = 180, SHOT_COVER_EASE = "cubic-bezier(.42,.06,.38,1)";
  // the look the dice turns up next: each of the chart's other looks once,
  // in a shuffled order, before any comes round again
  function nextLook(bags, kind, now, random = Math.random) {
    let bag = (bags[kind] || []).filter(p => p !== now);
    if (!bag.length) {
      bag = DICE[kind].map((_, p) => p).filter(p => p !== now);
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    const pick = bag.shift();
    bags[kind] = bag;
    return pick;
  }
  // Share: the system's share sheet where the browser can hand it the file,
  // else the picture onto the clipboard. shared, closed (the sheet put away
  // unsent), copied or failed
  async function sharePicture(win, blob, name) {
    const file = shareable(win, blob, name);
    if (file) {
      try { await win.navigator.share({ files: [file], title: PIC_TITLE }); return "shared"; }
      catch (err) { if (err && err.name === "AbortError") return "closed"; }
    }
    const clip = win && win.navigator && win.navigator.clipboard;
    if (clip && typeof clip.write === "function" && typeof ClipboardItem === "function") {
      try { await clip.write([new ClipboardItem({ "image/png": blob })]); return "copied"; }
      catch (err) {}
    }
    return "failed";
  }
  // blob and name are the picture just made and its file's name; saved, that
  // the file is saved. make(kind, pick) makes another look's picture, keep(blob)
  // saves one as a new file, answering its outcome and name, and share(blob,
  // name) shares one; later and cancel are the timers, random the dice's luck
  function overlay(doc, { blob, name, kind, saved, make, keep, share, later, cancel, random = Math.random }) {
    const el = (tag, cls, text) => element(doc, tag, cls, text);
    const veil = el("div", "qn-veil sp-veil tk-shot-veil");
    const box = el("div", "qn-glass tk-shot");
    box.dataset.kind = kind;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", saved ? "Chart downloaded" : "Chart picture");
    // a press on bare glass leaves focus on the box, so Escape still reaches the veil
    box.tabIndex = -1;
    const head = el("div", "tk-shot-head");
    const title = el("div", "tk-shot-title", saved ? SHOT_TITLES.saved : SHOT_TITLES.ready);
    const pill = el("div", "tk-pill tk-shot-kinds");
    pill.setAttribute("role", "group");
    pill.setAttribute("aria-label", "Chart");
    pill.appendChild(el("span", "tk-thumb"));
    const kinds = {};
    for (const [key, label] of VIEWS) {
      const b = el("button", "tk-opt", label);
      b.type = "button";
      b.dataset.view = key;
      kinds[key] = b;
      pill.appendChild(b);
    }
    const cross = el("button", "tk-shot-x");
    cross.type = "button";
    cross.setAttribute("aria-label", "Close");
    cross.setAttribute("data-tip", "Close (Escape)");
    cross.innerHTML = SHOT_CROSS;
    head.appendChild(title);
    head.appendChild(pill);
    head.appendChild(cross);
    const frame = el("div", "tk-shot-frame");
    let pic = el("img", "tk-shot-pic");
    frame.appendChild(pic);
    // the dice's cover over the picture while the next look is drawn: the
    // paper, half clear, with the download button's spinner in its middle
    const cover = el("div", "tk-shot-cover");
    cover.setAttribute("aria-hidden", "true");
    cover.innerHTML = ICON('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>');
    frame.appendChild(cover);
    const foot = el("div", "tk-shot-foot");
    const side = el("div", "tk-shot-side");
    const dice = el("button", "qn-glass tk-shot-round tk-shot-dice");
    dice.type = "button";
    dice.setAttribute("aria-label", "Roll the dice for another look");
    dice.setAttribute("data-tip", "Another Look");
    const die = el("span", "tk-die");
    dice.appendChild(die);
    const keeper = el("button", "qn-glass tk-shot-round tk-shot-keep");
    keeper.type = "button";
    keeper.setAttribute("aria-label", "Download this chart");
    keeper.setAttribute("data-tip", "Download");
    keeper.innerHTML = SAVE_ICONS;
    keeper.dataset.state = "idle";
    side.appendChild(dice);
    side.appendChild(keeper);
    const send = el("button", "qn-glass tk-shot-share");
    send.type = "button";
    send.innerHTML = SHOT_ICONS.share + "<span>Share</span>";
    const note = el("span", "tk-shot-note");
    note.setAttribute("role", "status");
    foot.appendChild(side);
    foot.appendChild(send);
    foot.appendChild(note);
    box.appendChild(head);
    box.appendChild(frame);
    box.appendChild(foot);
    veil.appendChild(box);
    doc.body.appendChild(veil);

    let shown = true, downOutside = false, rolling = false, asked = 0, copiedTimer = null, keptTimer = null;
    // every timer it sets, so putting it away stops them all
    const timers = new Set();
    const wait = (fn, ms) => { const id = later(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
    const stop = id => { if (id == null) return; cancel(id); timers.delete(id); };
    // the pictures made while it is up, by chart and look, each with its
    // address and, once saved, its file's name
    const made = new Map(), urls = [];
    const slot = (k, p) => k + ":" + p;
    const entry = (b, n) => { const url = URL.createObjectURL(b); urls.push(url); return { blob: b, url, name: n }; };
    made.set(slot(kind, 0), entry(blob, saved ? name : null));
    let at = { kind, pick: 0 };
    const current = () => made.get(slot(at.kind, at.pick));
    const back = doc.activeElement;
    const say = words => { note.textContent = words; };
    const hold = e => { if (shown && !box.contains(e.target)) box.focus({ preventScroll: true }); };
    const face = n => { die.innerHTML = dieFace(n); die.dataset.face = String(n); };
    function seat(k) {
      pill.dataset.on = k;
      for (const [key] of VIEWS) {
        kinds[key].classList.toggle("on", key === k);
        kinds[key].setAttribute("aria-pressed", String(key === k));
      }
    }
    // the motion, where the browser has it: the frame's height (grow, eased
    // to growTo) and each picture's and the cover's fade (tkFade)
    const win = doc.defaultView;
    const moves = !!win && typeof win.getComputedStyle === "function" && typeof frame.animate === "function";
    const still = () => !!(win && typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const tall = node => parseFloat(win.getComputedStyle(node).height) || 0;
    const strength = node => { const o = parseFloat(win.getComputedStyle(node).opacity); return Number.isFinite(o) ? o : 1; };
    let grow = null, growTo = 0, growMs = 0;
    // the frame eased from the height it was drawn at (from) to the picture
    // now in it, the box around it following, so the head and the row move
    // with its edges and keep their own size and corners. turned round on its
    // way it goes back in the time it had spent, never under .4 of the whole,
    // as a card's picture does (cardPictureTurn in card-logic.js); one already
    // on its way to that height goes on. answers the share of the whole time
    function resize(from) {
      const to = tall(pic), going = grow && grow.playState === "running";
      if (going && Math.abs(to - growTo) < 0.5) return Math.max(0.4, (growMs - (grow.currentTime || 0)) / SHOT_GLIDE_MS);
      const part = going ? Math.min(1, Math.max(0.4, (grow.currentTime || 0) / SHOT_GLIDE_MS)) : 1;
      if (grow) grow.cancel();
      grow = null;
      if (still() || Math.abs(to - from) < 0.5) return part;
      const mine = grow = frame.animate([{ height: from + "px" }, { height: to + "px" }],
        { duration: SHOT_GLIDE_MS * part, easing: SHOT_GLIDE_EASE });
      growTo = to; growMs = SHOT_GLIDE_MS * part;
      mine.onfinish = () => { if (grow === mine) grow = null; };
      return part;
    }
    // the picture coming in stands in the frame's flow at full strength, and
    // the one on show goes over it, at its own shape over the frame's middle,
    // and fades out, so the two cross-fade with no dip between them and
    // neither moves. one still on its way out comes back from where its fade
    // had got to. answers how long the change takes
    function place(next) {
      if (next === pic) return 0;
      const from = moves ? tall(frame) : 0, old = pic;
      let left = 1;
      if (next.parentElement === frame) {
        left = 1 - (moves ? strength(next) : 0);
        if (next.tkFade) { next.tkFade.cancel(); next.tkFade = null; }
        next.classList.remove("going");
        next.removeAttribute("aria-hidden");
      } else frame.insertBefore(next, frame.firstChild);
      pic = next;
      old.classList.add("going");
      old.alt = "";
      old.setAttribute("aria-hidden", "true");
      let ms = 0;
      if (moves) { const part = resize(from); ms = still() ? SHOT_STILL_MS : SHOT_GLIDE_MS * part; }
      if (old.tkFade) { old.tkFade.cancel(); old.tkFade = null; }
      if (!ms) { old.remove(); return 0; }
      const run = old.tkFade = old.animate([{ opacity: left }, { opacity: 0 }],
        { duration: ms, easing: still() ? "ease" : SHOT_GLIDE_EASE, fill: "forwards" });
      run.onfinish = () => { if (old.tkFade === run) old.remove(); };
      return ms;
    }
    // the cover up or away, from where its fade has got to
    function veiled(on, ms, ease) {
      if (cover.classList.contains("on") === on) return;
      const from = moves ? strength(cover) : 0;
      cover.classList.toggle("on", on);
      if (cover.tkFade) { cover.tkFade.cancel(); cover.tkFade = null; }
      if (!moves || !ms || from === (on ? 1 : 0)) return;
      cover.tkFade = cover.animate([{ opacity: from }, { opacity: on ? 1 : 0 }], { duration: ms, easing: ease });
    }
    // a look's picture to put in the frame: the one still fading out of it,
    // or a new one, decoded first so it never comes in blank
    function drawn(k, p, e) {
      const there = [...frame.children].find(n => n !== pic && n.dataset.slot === slot(k, p));
      if (there) return Promise.resolve(there);
      const node = el("img", "tk-shot-pic");
      node.dataset.slot = slot(k, p);
      node.src = e.url;
      return typeof node.decode === "function" ? node.decode().then(() => node, () => node) : Promise.resolve(node);
    }
    function show(k, p, node) {
      at = { kind: k, pick: p };
      const [look, shows] = DICE[k][p];
      box.dataset.kind = k;
      box.dataset.look = look + (shows ? "-" + shows : "");
      node.dataset.kind = k;
      node.alt = `${PIC_TITLE}, ${KIND_NAMES[k] || k}, ${LOOK_NAMES[look]}${shows ? ", " + SHOW_NAMES[shows] : ""}`;
      const ms = place(node);
      veiled(false, ms, still() ? "ease" : SHOT_GLIDE_EASE);
      seat(k);
      face(p + 1);
      stop(keptTimer); keptTimer = null;
      keeper.dataset.state = "idle";
    }
    // a look's picture, made the first time it is asked for
    function pictureOf(k, p) {
      if (made.has(slot(k, p))) return Promise.resolve(made.get(slot(k, p)));
      return Promise.resolve().then(() => make(k, p)).then(b => {
        if (!shown) return null;
        if (!made.has(slot(k, p))) made.set(slot(k, p), entry(b, null));
        return made.get(slot(k, p));
      });
    }
    pic.dataset.slot = slot(kind, 0);
    pic.src = current().url;
    show(kind, 0, pic);
    function close() {
      if (!shown) return;
      shown = false;
      for (const id of timers) cancel(id);
      timers.clear();
      veil.classList.remove("open");
      veil.setAttribute("aria-hidden", "true");
      doc.removeEventListener("focusin", hold);
      if (back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
      else if (box.contains(doc.activeElement)) doc.activeElement.blur();
      later(() => { veil.remove(); for (const url of urls) URL.revokeObjectURL(url); }, SHOT_FADE);
    }
    // the pill shows the other chart in its first look (DICE); whichever was
    // asked for last is the one shown
    for (const [key] of VIEWS) kinds[key].addEventListener("click", () => {
      if (!shown) return;
      // back to the chart on show before the other came: it stays as it is
      if (key === at.kind) { if (pill.dataset.on !== key) { asked++; seat(key); } return; }
      const mine = ++asked;
      say("");
      seat(key);
      const ours = () => shown && mine === asked;
      // pressed again while the chart's own picture is still fading out, the
      // switch turns round to that look rather than its first one
      const leaving = [...frame.children].find(n => n !== pic && n.classList.contains("going") && (n.dataset.slot || "").startsWith(key + ":"));
      const p = leaving ? Number(leaving.dataset.slot.slice(key.length + 1)) : 0;
      pictureOf(key, p).then(e => (e && ours() ? drawn(key, p, e) : null))
        .then(node => { if (node && ours()) show(key, p, node); })
        .catch(() => { if (ours()) { say(SHOT_WORDS.draw); seat(at.kind); } });
    });
    // the dice tumbles, its face turning, while the next look is made, and
    // lands on that look's own number as it is swapped in. the picture is
    // under the cover all the while, at least as long as the tumble, and the
    // next look fades in as the cover goes. a press while it rolls does nothing
    const bags = {};
    dice.addEventListener("click", () => {
      if (!shown || rolling) return;
      rolling = true;
      say("");
      const k = at.kind, p = nextLook(bags, k, at.pick, random), mine = ++asked;
      const ours = () => shown && mine === asked;
      dice.classList.add("rolling");
      dice.setAttribute("aria-busy", "true");
      veiled(true, SHOT_COVER_MS, SHOT_COVER_EASE);
      for (let turn = 1; turn < ROLL_TURNS; turn++)
        wait(() => face(1 + ((Number(die.dataset.face) + turn + Math.floor(random() * 4)) % 6)), ROLL_MS * turn / ROLL_TURNS);
      Promise.all([pictureOf(k, p).then(e => (e && ours() ? drawn(k, p, e) : null)), new Promise(done => wait(done, ROLL_MS))])
        .then(([node]) => { if (node && ours()) show(k, p, node); })
        .catch(() => { if (ours()) say(SHOT_WORDS.draw); })
        .then(() => {
          rolling = false;
          dice.classList.remove("rolling");
          dice.setAttribute("aria-busy", "false");
          if (!shown) return;
          face(at.pick + 1);
          veiled(false, still() ? SHOT_STILL_MS : SHOT_GLIDE_MS, still() ? "ease" : SHOT_GLIDE_EASE);
        });
    });
    // the download button: the spinner while the file is made and handed
    // over, at least as long as the panel's, then the check for a moment.
    // keep is asked inside the press itself, as a phone's share sheet needs
    const mark = state => {
      keeper.dataset.state = state;
      if (state === "busy") keeper.setAttribute("aria-busy", "true"); else keeper.removeAttribute("aria-busy");
    };
    keeper.addEventListener("click", () => {
      if (!shown || keeper.dataset.state === "busy") return;
      say("");
      stop(keptTimer); keptTimer = null;
      mark("busy");
      const e = current();
      const work = Promise.resolve().then(() => keep(e.blob));
      Promise.all([work.catch(() => ({ outcome: "failed" })), new Promise(done => wait(done, SPIN_MIN))])
        .then(([got]) => {
          if (!shown) return;
          const { outcome, name: file } = got || {};
          if (outcome !== "downloaded" && outcome !== "shared") {
            mark("idle");
            if (outcome !== "closed") say(SHOT_WORDS.save);
            return;
          }
          e.name = file;
          if (current() === e) {
            mark("done");
            keptTimer = wait(() => { keptTimer = null; mark("idle"); }, DONE_MS);
          }
        });
    });
    // a button at work says so to the pointer and takes no second press
    const busy = (b, on) => { b.dataset.busy = on ? "1" : ""; b.setAttribute("aria-busy", String(on)); };
    // the share sheet is opened inside the press itself, which a phone asks for
    send.addEventListener("click", () => {
      if (send.dataset.busy === "1") return;
      say("");
      busy(send, true);
      const e = current();
      Promise.resolve(share(e.blob, e.name)).catch(() => "failed").then(outcome => {
        busy(send, false);
        if (!shown) return;
        if (outcome === "failed") return say(SHOT_WORDS.share);
        if (outcome !== "copied") return;
        // the button says it is done for a moment, as the download button does
        send.innerHTML = SHOT_ICONS.check + "<span>Copied</span>";
        stop(copiedTimer);
        copiedTimer = wait(() => { copiedTimer = null; send.innerHTML = SHOT_ICONS.share + "<span>Share</span>"; }, DONE_MS);
      });
    });
    // the glass's own press, as the bar's (glassPress in index.html): pressed
    // while the pointer holds it and at least GLASS_HOLD, and Share, a pill,
    // grows across by the few pixels a circle does
    for (const b of [dice, keeper, send]) {
      let since = 0, letGo = null;
      b.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        stop(letGo); letGo = null;
        since = Date.now();
        if (b === send && b.offsetWidth) b.style.setProperty("--press-x", String(1 + 32 * 0.06 / b.offsetWidth));
        b.classList.add("pressed");
      });
      const release = () => {
        if (!b.classList.contains("pressed")) return;
        stop(letGo);
        letGo = wait(() => { letGo = null; b.classList.remove("pressed"); }, Math.max(0, since + GLASS_HOLD - Date.now()));
      };
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) b.addEventListener(type, release);
    }
    cross.addEventListener("click", close);
    veil.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); close(); }
    });
    // a press that starts and ends on the veil, outside the box, puts it away;
    // a selection dragged out of the box and let go on the veil does not
    veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
    veil.addEventListener("click", e => {
      if (downOutside && e.target === veil) close();
      downOutside = false;
    });
    doc.addEventListener("focusin", hold);
    // laid out closed once, so the veil and the box have a fade to run
    void veil.offsetWidth;
    veil.classList.add("open");
    veil.setAttribute("aria-hidden", "false");
    if (typeof box.focus === "function") box.focus({ preventScroll: true });
    return { root: veil, box, close, isOpen: () => shown, title, kinds, dice, keep: keeper, share: send, note,
             frame, cover, image: () => pic, at: () => ({ ...at }), picture: () => current() };
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
    const store = "store" in opts ? opts.store : localStore();
    // Chart preference can be a synced settings store; data belongs only to
    // this browser, so never put token readings in that settings store.
    const cacheStore = "cacheStore" in opts ? opts.cacheStore : localStore();
    const clock = opts.now || (() => Date.now());
    const load = opts.load || (() => fetch("/tokens/daily?days=" + fetchDays(clock()))
      .then(r => { if (!r.ok) throw new Error("tokens " + r.status); return r.json(); }));
    const el = (tag, cls, text) => element(doc, tag, cls, text);
    const box = el("div", "tk-panel");
    const head = el("div", "tk-head");
    const title = el("div", "tk-title");
    title.appendChild(el("span", "tk-name", "Token consumption per day"));
    const pill = el("div", "tk-pill");
    pill.setAttribute("role", "group");
    pill.setAttribute("aria-label", "Chart");
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
    // the download button stands beside the pill, in one box with it, so the
    // two travel together and neither can drop to a line of its own
    const save = el("button", "tk-save");
    save.type = "button";
    save.setAttribute("aria-label", "Download chart as a picture");
    save.setAttribute("data-tip", "Download Chart");
    save.innerHTML = SAVE_ICONS;
    save.dataset.state = "idle";
    const tools = el("div", "tk-tools");
    tools.appendChild(pill);
    tools.appendChild(save);
    head.appendChild(title);
    head.appendChild(tools);
    let view = readView(store), destroyed = false;
    const stage = el("div", "tk-stage");
    const layers = {};
    for (const [key] of VIEWS) {
      // Select before the first layout measurement so restored data does not
      // fade up from a blank frame. Later pill changes still crossfade.
      layers[key] = el("div", "tk-layer" + (key === view ? " on" : ""));
      layers[key].setAttribute("data-view", key);
      stage.appendChild(layers[key]);
    }
    box.appendChild(head);
    box.appendChild(stage);
    const status = statusLine(doc, box, "tk-updated");
    root.textContent = "";
    root.appendChild(box);

    const spots = { heatmap: latest(), line: latest() };
    const kept = readCache(cacheStore, TOKENS_KEY, tokenAnswer);
    let data = kept && kept.answer, at = kept ? kept.at : null;
    let message = "Counting tokens", drawnAt = "";
    const sizeOf = () => stage.clientWidth + "x" + stage.clientHeight;
    function tick() {
      status.note.textContent = at == null ? "" : "Last updated: " + ago((clock() - at) / 1000);
    }
    function draw() {
      if (destroyed) return;
      const layer = layers[view];
      if (data && data.days.some(day => day.total > 0))
        (view === "line" ? drawLine : drawHeatmap)(layer, data.days, spots[view]);
      else {
        layer.textContent = "";
        layer.tkModel = null;
        layer.appendChild(el("div", "tk-wait", data
          ? "No token usage yet." : message));
      }
      pill.dataset.on = view;
      save.disabled = !(data && data.days.some(day => day.total > 0));
      for (const [key] of VIEWS) {
        const selected = key === view;
        buttons[key].classList.toggle("on", selected);
        buttons[key].setAttribute("aria-pressed", String(selected));
        layers[key].classList.toggle("on", selected);
        layers[key].setAttribute("aria-hidden", String(!selected));
        layers[key].inert = !selected;
      }
      drawnAt = sizeOf();
      if (!save.disabled) warm();
      tick();
    }
    // Each view keeps its own scrolling position. Both layers stay mounted so
    // opacity can crossfade in either direction, including a rapid reversal.
    function show(key) {
      if (destroyed || key === view || !VIEWS.some(([k]) => k === key)) return;
      view = key;
      try { if (store) store.setItem(VIEW_KEY, key); } catch (err) {}
      draw();
    }
    // the picture of the chart on show; a second press while one is being
    // made, or with nothing drawn, does nothing. The faces and the squid are
    // fetched the first time there is something to save
    const later = opts.later || ((fn, ms) => setTimeout(fn, ms));
    const cancel = opts.cancel || (id => clearTimeout(id));
    let saving = false, warmed = false, doneTimer = null;
    function warm() {
      if (warmed) return;
      warmed = true;
      loadLogo();
      loadFaces(doc, lookOf(box));
    }
    // idle: the download icon; busy: the spinner while the picture is made and
    // handed over; done: the check, for a moment, then back to idle. A picture
    // that failed goes straight back to idle, and so does one kept for a
    // phone's share sheet, which nothing has saved yet
    function mark(state) {
      save.dataset.state = state;
      if (state === "busy") save.setAttribute("aria-busy", "true"); else save.removeAttribute("aria-busy");
    }
    // the overlay showing the last picture, one at a time. The file is named
    // for the day and the profile's first name, read at each press, and
    // numbered in this browser (pictureName, pictureCount). profile, share
    // and random are for tests
    let shot = null, first = null;
    const win = doc.defaultView;
    const share = opts.sharePicture || ((blob, name) => sharePicture(win, blob, name));
    const profile = opts.profile || (() => (typeof fetch === "function"
      ? fetch("/profile").then(r => (r.ok ? r.json() : null)).then(p => (p && typeof p.name === "string" ? p.name : null))
      : null));
    const count = pictureCount(cacheStore);
    const nextName = () => pictureName(clock(), first, count.next(clock()));
    const takeName = () => pictureName(clock(), first, count.take(clock()));
    // a phone that can share a file keeps the picture for the overlay, and
    // saves through the share sheet, opened inside the press
    const phoneShares = blob => !!opts.share && !!shareable(win, blob, nextName());
    // the overlay's download button: the chart on show as a new file
    function keep(blob) {
      if (phoneShares(blob)) {
        const name = nextName();
        return Promise.resolve(share(blob, name)).then(outcome => {
          if (outcome === "shared") count.take(clock());
          return { outcome, name };
        });
      }
      const name = takeName();
      return deliver(doc, blob, name, false).then(outcome => ({ outcome, name }));
    }
    function download() {
      if (saving || destroyed || save.disabled) return Promise.resolve();
      saving = true;
      if (doneTimer != null) { cancel(doneTimer); doneTimer = null; }
      mark("busy");
      const began = clock(), kind = view, days = data.days, installed = data.installed;
      const make = (k, pick) => picture({ doc, kind: k, pick, days, installed, look: lookOf(box) });
      return Promise.resolve().then(profile).catch(() => null).then(name => { first = name || null; })
        .then(() => make(kind, 0))
        .then(blob => {
          if (phoneShares(blob)) return { outcome: "ready", blob, name: nextName() };
          const name = takeName();
          return deliver(doc, blob, name, false).then(outcome => ({ outcome, blob, name }));
        })
        .catch(() => ({ outcome: "failed" }))
        .then(made => new Promise(done => later(done, Math.max(0, SPIN_MIN - (clock() - began)))).then(() => made))
        .then(({ outcome, blob, name }) => {
          saving = false;
          if (destroyed) return;
          if (outcome !== "ready" && outcome !== "downloaded") return mark("idle");
          if (outcome === "downloaded") {
            mark("done");
            doneTimer = later(() => { doneTimer = null; mark("idle"); }, DONE_MS);
          } else mark("idle");
          if (shot) shot.close();
          shot = overlay(doc, { blob, name, kind, saved: outcome === "downloaded", make, keep,
                                share: (b, n) => share(b, n || nextName()), later, cancel, random: opts.random });
        });
    }
    save.addEventListener("click", download);
    let observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(() => { if (sizeOf() !== drawnAt) draw(); });
      observer.observe(stage);
    }
    let asking = null;
    function refresh() {
      if (destroyed) return Promise.resolve();
      if (asking) return asking;
      status.busy(true);
      if (!data) { message = "Counting tokens"; draw(); }
      asking = Promise.resolve().then(load).then(answer => {
        if (destroyed) return;
        if (!tokenAnswer(answer)) throw new Error("Invalid token reading");
        data = answer;
        at = clock();
        keepCache(cacheStore, TOKENS_KEY, { at, answer });
        draw();
      }).catch(() => {
        if (destroyed) return;
        if (!data) { message = "Token usage is unavailable. We’ll try again."; draw(); }
        tick();
      }).finally(() => { asking = null; if (!destroyed) status.busy(false); });
      return asking;
    }
    function destroy() {
      destroyed = true;
      if (doneTimer != null) cancel(doneTimer);
      if (shot) shot.close();
      if (observer) observer.disconnect();
      for (const layer of Object.values(layers)) if (layer.tkDispose) layer.tkDispose();
      status.busy(false);
    }
    draw();
    return { root: box, show, refresh, tick, destroy, download, view: () => view, overlay: () => shot };
  }

  // ---- the limits box ------------------------------------------------------
  // the plan windows GET /limits can answer with, in the order they are shown:
  // the tool, the window and the words on the row
  const LIMIT_ROWS = [["claude", "five_hour", "Claude 5-hour"], ["claude", "weekly", "Claude weekly"],
                      ["codex", "five_hour", "Codex 5-hour"], ["codex", "weekly", "Codex weekly"]];
  // the bars wear the chart's colours: the daily line's colour for the fill and
  // the heatmap's second tint for the track
  const LIMIT_FILL = LINE, LIMIT_TRACK = PALETTE[2];
  const LIMITS_KEY = "home.limits";
  // while the server says it is renewing its reading the box asks again, this
  // often and at most this many times in a row
  const FOLLOW_MS = 2000, FOLLOW_MAX = 8;
  // the rows an answer has a number for, each a whole percent from 0 to 100; a
  // tool the answer leaves out, or a window it has no number for, has no row.
  // given the time in seconds, a window whose reset has passed is 0, since the
  // number kept with it describes a window that is over
  function limitRows(answer, now) {
    const rows = [];
    if (!answer || typeof answer !== "object") return rows;
    for (const [tool, span, label] of LIMIT_ROWS) {
      const w = answer[tool] && answer[tool][span];
      if (!w || typeof w.used !== "number" || !Number.isFinite(w.used)) continue;
      const over = now != null && typeof w.resets === "number" && w.resets <= now;
      rows.push({ label, used: over ? 0 : Math.max(0, Math.min(100, Math.round(w.used))) });
    }
    return rows;
  }
  // How old the last successful reading is, updated by the page while Home
  // is open. A failed request never moves this clock forward.
  function ago(seconds) {
    const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + (m === 1 ? " min ago" : " mins ago");
    const h = Math.floor(m / 60);
    if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
    const d = Math.floor(h / 24);
    return d + (d === 1 ? " day ago" : " days ago");
  }
  function limits(root, opts = {}) {
    const doc = root.ownerDocument || document;
    const store = "store" in opts ? opts.store : localStore();
    const clock = opts.now || (() => Date.now());
    const later = opts.later || ((fn, ms) => setTimeout(fn, ms));
    const cancel = opts.cancel || (id => clearTimeout(id));
    const load = opts.load || (() => fetch("/limits")
      .then(r => { if (!r.ok) throw new Error("limits " + r.status); return r.json(); }));
    const el = (tag, cls, text) => element(doc, tag, cls, text);
    const box = el("div", "tk-panel lm-box");
    box.appendChild(el("span", "lm-title", "Usage Limits"));
    const content = el("div", "lm-rows");
    box.appendChild(content);
    const status = statusLine(doc, box, "lm-updated");
    root.textContent = "";
    root.appendChild(box);
    root.hidden = false;
    const kept = readCache(store, LIMITS_KEY, limitsAnswer);
    let data = kept && kept.answer, at = kept ? kept.at : null;
    let drawn = null, destroyed = false, message = "Reading usage limits";
    function tick() {
      status.note.textContent = at == null ? "" : "Last updated: " + ago((clock() - at) / 1000);
    }
    function draw() {
      const rows = limitRows(data, clock() / 1000);
      const same = drawn && drawn.labels.length === rows.length && drawn.labels.every((l, i) => l === rows[i].label);
      if (!rows.length) {
        content.textContent = "";
        content.appendChild(el("div", "tk-wait", data ? "No usage limits available yet." : message));
        drawn = null;
      } else if (!same) {
        content.textContent = "";
        const parts = [];
        for (const { label, used } of rows) {
          const row = el("div", "lm-row");
          const bar = el("span", "lm-bar");
          bar.setAttribute("role", "progressbar");
          bar.setAttribute("aria-label", label);
          bar.setAttribute("aria-valuemin", "0");
          bar.setAttribute("aria-valuemax", "100");
          bar.setAttribute("aria-valuenow", String(used));
          bar.style.background = LIMIT_TRACK;
          const fill = el("span", "lm-fill");
          fill.style.width = used + "%";
          fill.style.background = LIMIT_FILL;
          bar.appendChild(fill);
          const pct = el("span", "lm-pct", used + "%");
          row.appendChild(el("span", "lm-name", label));
          row.appendChild(bar);
          row.appendChild(pct);
          content.appendChild(row);
          parts.push({ fill, bar, pct });
        }
        drawn = { labels: rows.map(r => r.label), rows: parts };
      } else rows.forEach(({ used }, i) => {
        const part = drawn.rows[i];
        if (part.pct.textContent === used + "%") return;
        part.fill.style.width = used + "%";
        part.pct.textContent = used + "%";
        part.bar.setAttribute("aria-valuenow", String(used));
      });
      tick();
    }
    function take(answer) {
      if (!limitsAnswer(answer)) throw new Error("Invalid limits reading");
      // An empty response can mean a local provider is temporarily unavailable.
      // Retain a previous reading and its time until usable numbers return.
      if (!limitRows(answer).length && data && limitRows(data).length) return;
      // The route can return the old reading while a renewal runs. Without a
      // fetched time, this answer cannot make a saved reading any fresher.
      if (answer.refreshing && data && !Number.isFinite(answer.fetched)) return;
      data = answer;
      at = Number.isFinite(answer.fetched) && Number.isFinite(answer.now)
        ? clock() - Math.max(0, answer.now - answer.fetched) * 1000 : clock();
      keepCache(store, LIMITS_KEY, { at, answer });
      draw();
    }
    let asking = null, wave = 0, timer = null;
    function stopFollow() {
      if (timer != null) { cancel(timer); timer = null; }
    }
    function refresh(follow = 0) {
      if (destroyed) return Promise.resolve();
      if (asking) return asking;
      stopFollow();
      const mine = follow ? wave : ++wave;
      status.busy(true);
      if (!data) { message = "Reading usage limits"; draw(); }
      asking = Promise.resolve().then(load).then(answer => {
        if (destroyed) return;
        take(answer);
        tick();
        if (mine === wave && answer.refreshing === true && follow < FOLLOW_MAX)
          timer = later(() => { timer = null; if (!destroyed && mine === wave) refresh(follow + 1); }, FOLLOW_MS);
      }).catch(() => {
        if (destroyed) return;
        if (!data) { message = "Usage limits are unavailable. We’ll try again."; draw(); }
        tick();
      }).finally(() => { asking = null; if (!destroyed && timer == null) status.busy(false); });
      return asking;
    }
    function pause() { ++wave; stopFollow(); if (!asking) status.busy(false); }
    function destroy() { destroyed = true; pause(); status.busy(false); }
    draw();
    return { root, refresh, tick, pause, destroy };
  }

  // Inter, the latin subset of the variable font (weights 100 to 900) as Google
  // Fonts serves it, version 20, under the SIL Open Font License 1.1 (see
  // THIRD-PARTY-NOTICES.md). The picture adds it to the page's faces under the
  // name "Inter Export", so the name and the repo link are drawn in Inter on
  // any machine, with or without the network
  const INTER_LATIN = "d09GMgABAAAAAL0wABQAAAAB4AgAALy3AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoZeG4KyRBzVcD9IVkFSi2k/TVZBUl4GYD9TVEFUgU4nJgCFNi9sEQgKgbtAgaEUC4gOADCCnD4BNgIkA5AYBCAFhi4HoQRbbM1xJ9pEvFeIqaVsuokIsO22SVU1fQk3aHa/1VxA501dSsJn5lSwbRr1bgcRJN0fNvv////PTSpjaFO2tAUBUdXp/H+hZmYeWbxMkksUg6gSjR4sJp1OluyFAZzHknNZFfcOC/jkm4TBTvWYFyAlzqJGm4RoBKtiTp9mkyGfCzYwC/BDbocpQqUSQIhMa7ygZvA0U75Y4LFTHnT/aGZJWR6pLqVniIDetGuXwgUe8/POsOsP1Q9VUiWTp72izbt5tKtLgWhoWrfh09M7RFpXf5QIFuBDxYUkcftGuBj4EcUodLrLBqOES28ulU2C4bvURfopCwxHk8sX8DGo2D5LQadmFhKB7no9F66EECKF6kb1LqY15mIYK93FNtnkyduuV/xNv9PH6x75G9MA70vGml6p8vX9jTf8AlMyEzuyoIG97E5cYX23aa9Hhfa/gh+rhMr0p6hG3V/wUX/4bg8BtusHxJhISTNsDu+T58G6+P7cJFXdA5Grx9UI3uHDWFqdI9Ktmb2SSyGEEKqU0AMiIERQ9DXQRVFERKTZsDREnyYqQuzAK/KWiqiIvCLvK49+s1SK7ysqomJ9xU6RIlJyVj8G+727t4KYRiKJ6Uw3iRAa2bRlQiZEItHsW/vD03T+u+jlcsnF5JJcVJs03iStI4UWK6LFbFo+M0LKTNmHjYkoait4BVakjq+l1KiQpkOgZ1ejQ422tKUtSiXWioidPSUhIkaCIEQiJCIRxIrZgS6Umqtf2qKtjv1Px/y9+msMz2/q/7lAgHjTWFWm1u39lwuknXfinuWlXXeFXDRAULlcJHiACBaVSpLG6zrP9pfj382aQdsZgpTumfvX7RNCulCnLRXfvMwJ+YXfUxXkTPjnn/182+cl+UV2VSRMdTuAwgDh8lHDRrIjMIL8qBEeMNcHvm3fH+/WjbYKuzHASXJESqJioBVY17svf6PqbzuK4d/N6iGtj+iaWFkz/5I7p6zJuXQ61p1ScwoePIQQgkYhEBIIwQMEAPR8+/VWPTOJIpIZnRPLCgkX7n+LqGKXJDBIYOoauuaHLayoaOIjGdjlV6MOfAKzjwhVNzQG8uRBYAVG2G770u2fvmQSp6bxI+T7xENyB+QBe8AeoEcZuQ+kAeuBNUAPWC5Q9GWfx1lOJY/yDoxbtnO9DPRjm33JS4DgNZ9ZFz3tVZR+Oa2onNy/uJXaQAMEgOdzqn9JzlyoZbnAjsVZJcsFBJQRPR7+3U9T2ylSxF9XdraQNyIXPyBJZMSM6/E1btLkwv/za5LnfprgMqmiIj2Tlm3ZuArXd/NTJInsditVbStcBuZmuh2o+5q/Le+s6Wn6HRGdCSs788v5/j+BxKuXa14CfoTIRDS2lRoVt+HWDIa+ViyxC8jxO7gBW/OIoGiLnaEaCsXU2aW+WOJz2VEo+nvGlPjd/j3RNKHmv5gaD0KBXUYZRsEehmEIuDF2TFNM/H2pWtf/Gh9kA5phEeCu2FpPaNrLnY+JkCacQbXkCSnd99xAEwa6AVINiJIBUAGkU4Myxx8UaYPksMwGFGjSKVLakO2sTfkDlGpalDzVJhVAOVGaqPJtYqA3hHCL8bS1p91biOe9nUK+7Snkw+m+x93rZXn+//fmbO5s6ij+etAlEhlh/sKqKS05REF/DrprzauscSBjvAD+v5+m+OmM5rkr2p9WEdv5sgNIAA7ga3fN3Y1SuiawdVQqlAsK8gQgT1AHpHVcAQpjISAAx/+cllRPT77x/4su6bQ1zlclIxd5i51a0HpTCwsK4UFHYADC+WmtX/2Le4iQCUnMG41QmMfyvu0XQ8yiv5WbO/8ijmop1ELNs4MdJLETVBI8H960wDp7QLiL8kmCA8CPYRj2l6qfLR6BNyR/5kVeCKEozyFWJ3cVsIvVYrFYEUzzQYI8pUskpR8yJQetwH8GeSGGyjFQF0LsfOXVrly5c1V6ehdFFXLfmIf+l+/s3iS0stDloIiOcN+q3Ucdhtaqa0U4MBYhP8Jx8ECgLqa7fnPxCKfgAxOkGc4hlEASFBLH+3xTZ9v8XOc6hmIrhE8c8ssqm9XruP+Qa2oewlIXHDK9wBLCOBOecPNd7o+pilS1stzLEdZ9OtYygqAgwlXJwr/bC6/nhumPhSelkyKhBBdk7HPWxMpSrcMGsGGGxQgzCCOEEI1ohBA6YRzfxPl9y2RNdvv3faPQ77zZeW6nHCQEEREJEkQknX0IdYqXva4nCasWr+lFjEq5Tuwb6+8dY7Yf8GuX1ae/5AEBBTmWNsEitkz2kJfKUKpQ4/X//dLPi8Gk3T2+ZZaNLIdSawnBKxJFQgjHOvM1lqqKI1Neth/ZVFpz6cNukFF/QZG7/ffQd4HvIswRhVCRs1CVR9Bjz6GX+qBBOhiCBDA0MoCRoAQwUtQHjHUEjEMGmOAIMOHRYQqrh9mTHmZ/RpiDWWBO5Yc5XQjm79IwF2uDqWkEldauwHTUgUp33SiIAKsDi0NsahpsqOGu1Q1hbkNQbkWDshFwCnAIsDI9iEDggQXOPtm7vQDyP9G7f7Y+9Uco+35f/hvvxaeBOeAe8BVQIAKkd761/u0pr4EC5AXBef4Jv3BX5YMrdv/fntv3rzjw+FMrbkKPvnKL8+Ss2yrvXH5X5d3L7x1/7/J7V967+t619y9/wFzrrI0/uPxhZX30kvNS5WOOf8ufeLisvQxMT3+SceW8K5VPLnly+VOO64broevxZ21NrqaspmBT5fO+oNGKHwAzshFCBHGhdDGLTbIkqN+rVUtPnanehoztbX4LDnwYRsg7nJ7e3O5O97OLD6X00c9wSAOP4vjSkvmmO/3zkzm43GqWP6fTWR0xUuSYKIYBa86TTyEiarHkbGOExU976TuJWFQmOdOY+BzOl0cycktZhDqgD46jsLEgZEEYhRYehAy2sjksbIUO+7URjkhEI5ahclSowhWtwk5PzjXn//QTtXTZ1kFMbNzlbxBNZ3pTSr99G7pYktK+O5qgBtbtcGNhHofHE+ydhAVbBIk4MqWyXWnKUu7JZKJUmtjOvegIivXu6zsL3wGPAwAEoE24SCKtUzsbQpFUh8Vm9/j8cBjDE8k0STFslsvxhdJgwvN5KGJMorKq6YZlZwViBaHRGsxWRyhcINEa7aFsDhAgHQYdFQRgbxoQYFERitD738bp4f14iY/B5WneH4XLC+5sAuZoQOcNUFAm1Cg7xs0ue5JPYOSkqf6Vi1C+GI3v2hwIJjg2ercBtaG5gnHXJxpf5uewRmhJsWSQCMIlSsXzzuJCgqHhwZExCaok7FnpBR+uQxWG6SBafD6UPwfUfNiMH3ni8C5UivfKiBb3hgy2AKpvJjiC/7WCaVABDXhcuSU8D0fg4hdIkmMcFh0GZ6/4Nx//0NL/Xgvdl/o/fPtXfAS+9ri+Oiv5yz/M4Z/3YVOo7H1x2cPOd9ZbLrnI2U/bComrutjZTqugctwTnkMe5bE9FGFX/sfFF9rlmTOue7U1n9iqja3nMt+DQZNpZStM37ahV14eNqdTW8WOpiRGfInEHq0zI42y2/K/TWbYIc7yifFGF0EQDrb9bPk6tzrgfOXrtltrqdTdwLeD3zXbRCNsqqD0sFkdS1ZO13RB+cpYQcqNSytCVSqQqFizFS+PTJIIZnopMHqFFnlsoMG0u83Q6RM0QotZQzlTmNZrOJlIwmkwm7EgL1ZZgpHoryUL19xpef5XpYpVq+qG6qiq4jqqq8wFSZ0uzQblYfjE45lscxbjjTWy8PN9C5rxfvRh7CjtSco3lsiCkD5z4ga0a9Su2BojujTIuVGO1aSioUr9emM1TEaEAnNAyLcAatm0GSMCYqu5ZIhYBZ0Yg4BEinZJlRlGUrIK4agtQinyvBsACEeSpeqAztqyiNe24NAk6E39qzMefI9uaAVcVbTyv9DevGWz/kU3hK0nNstO7Z+FwrRJWWLW9zLpWcR4Crd9E15Xz+OhLZ+9KVXx74Y2nOQMUF71midvXjG807SupKyoEX2RM2S43m3CkbgV8131NbICl2yOfDhPVePOWXFLFhn3Xza9foOTJzgQKjOcTZhWDYGp86oAef2Rp68ex54tWo7GuAdTr++81yZwExUeu0b7UOqZwCa+aWayiWrXLvwJf7uhEG30URWB+3bwRRkbDbvvaMvl4Ja1mtqZD3OI7J2DcIGh/SkX/MuaGYHD/bIvl2OzZSx6L+QlngLk1VeGNPOs7eYZlkr6enPTOaVYX246qNY5hIvuMNvMe7Xp/MY/PdufDHWu7DNZifO0Py8e7GdvMpHnFmMQCss4oiRcsmPT5PgitkzQP9ebG4+/UpPxh78OoYHMk6uy8BFZsNHm/4Q/GcJyfjhfo72Yx88Ds3DApGaFzw4mLOGro34kNfhwiLweyV4GloOmDWkLShB29CMIeF4SklM1HdexIkRC9h8jacvLa7bnRe3VEo+L1n7qOCFIGloxb258jez5vvZtDIsCBmFtMWezGTAYMVsJX7LrfNUSb3j64t79YLru5cUH5sQSy2o5MJ/dcPnF5b7E69xbIGPrYo7h75JpfsRxCNazc0hDXryxrLHdZMsqZ5xxe4nixaYYjswSbL1JJAhZW5/pVo4bUY4ZmXGOsYcbLIaaJesN+abkwXl/sIPL4G9CDLry3D8Mxxyf31ZBt0RumZcuMvPR7+M/XZXfhqdlKKl4QE3H99HPg1EIxFGzK5socjt93p4b+6osmW3c114Nmftxv+/I+rSdoxuLwQl0/qOMzdf7r2OfFcDX8GBWMqF0CTPhJIHWu5Mgoiv0ku4p6Sq7SGc+Gik3+Q97OqgvsOJvnlgXBNm6jllh/09lLgqxM+dzr+a/vTwGItvUZxPJVS6WILXSzk/HhmTRVaxzHNDT/vDl3URwqTYxDx7ugT9igPsAXGj3hdbUMpRqQa1XTsiWbvqyvcyqOjn7vE25N9nu8hgfuQgVVaJCdKlKFCfmZzm1PAayaUomkivx0achqFcVi67u9UdOqWL0csxnQkEIlDWfy/MTBc0hzFtnKF7o18mCfLiIPcER2D+f19iv2BeavAa7/SEe8koirLipmRtyQOslMeydafS9cLw0q+yy+rHXQ57cscKJbr7IHrZhLoIAujkH0ebqqx6sGSCDKx3fJvvByq1d0/ogEjg/OFmq+ZRWLseTxF1tbUrRQCGdwOV4Aqi3/jyH31zAvzh9SKHeY11+87s/89dhhPQkMy2gpkWfFmNaTLrHYh1D/FBPwVYAWHwjFmHwhctsDnKJV0R5vJ9ufYKJ8Lxl5NF/tmlRH/CRW1iM93b/Ar/jHSJ+e9CRn6LOsIx31Sz8O77lG3dDE7rHpYvZULZMMorcaCGoctnYkku8CQ4MJholbZDqcdbKYiYZRW7TQsSrgmyYIIvDWrJBhklfksumb1J3sGf1jLGvDYW09mFEHK9B7ilGjsUmlpcuQxONYF/l6lo7DwPY5Y5Pt7coWJ+sL72jyWSAXZsCZ0i5eh4O5usH4ls5cCXu2YQhpgvt62ddyNLggPChj9NG0xOTLzJcJRjunLj6YdBcLlJUm26+6K7B2rFp4o90bg2g2qJ9Ujyn+1nALJjjQYnyJBw6dmPkjI6QDzPRE5Ivt5AU3R0cSpAMwyB7HG9U88DT/jPjqmEm0zybZ/w8luTP/pUHxUjbOxJ2Rq4i9H6Vw3cT8yKK/HiSM8z8WROAYrlMG+A0Z32fvocv4ahfTogMDbXG5b36HM4s9Jwva32ddsFTsXr+QqncGP9PFFuhj5AASzMgZsSTHrWphoqWb4LtCuUqstN6e5y1aXvhKH9zg3q1bCN6r9+i+l0fITCidNGZ3tRaeg+R61eQoYHK/Nc/LkRlcfkVwNTuEiFDbbBf+w2QAmXNvwSCdX7t/cNQbnD3nqzAIT34LffMLoOn6Wn3jnPveJUxiBnIvmMakw6eEJpQXOSlxoUDEhey74dwn0NZYeFCkxYXacE46GP+kMORXlxK/xQnjy/umhEdzy/ddVISi7+1O7qJUO7zL1Y2EMqMdEh+aWhavF9+vdHXVa8p7WLktOqGlMeptrLvPa8oTjAVTdeertpdj3XpKwgxXnrstaYtez62v4UYRqzPgd86TZvjMgnXChBRmvMg0lns4xy3PU7YPfwpo8tAnAWZwfycJK5F5J6Er0TCbEg1WLvJv+khooV7UMrSHMmV9pkYmBvXhwT9ZY3TW5LGO8KBPK6Afv4qtaCln4yELfw91hqEvtHc6+7yYwye1ZPMpsbNB//77n3HPPlaB/DXSaCXZRqiDzSunsKvpzUS6AZlGw8fRuvPw/Hn/cDTJleElYkhkoTPvNzkj2wOeBHEM9pMVdwlE2Dxlg7xQxG733+LjTV8m+nDmR/G/MJxZ0/++k/8uVnaIWRIWUXRHs8n2JZUFvyGW1zwOeafwKwbg984nXMEZ77vJ4EZBdoVsC5/Uz/sJN3H6wpHrvUlrakWkzWNTvq97ul+VVp+0q990kLMUxL0VDj6g0o1WWtRyTdKp9nX7be2g+bDCIITEhnjDV3/uGYdtargr7zznmjol8cjaH/ZWHFPBBCuV/0UMDL3l1yU2lu53YWNF7+S4eNmpScWqAhRDFxsQBw7JHFAL6pH0owoQj/+UZg0sWDTpJVtU+NJmpHAn7MTcWp+OZxbWSHP1qXmXVWVxrQpQkAakwvLcYIp6cwoMmcK09NDTM4xIwNBbEbzictEISHzHyRmuZSZ2eig2fmok+ZBd+Y8lga9tMAAFmFgcds7r0R1EZG7qQgcKju6QxIC5JGBeRTgGhVYRwOKYCCPAZxDJtiXZMfkQ+KdH2Yk0BkFxheS0WDGQMcfg/IwrQBpQpBmPNKEwSaKoU2DynRsqwATB514MDOhMwtxZgfCzCmLKEmlPzUv6Zv55eCyuAKCLKsIkxTArMC4xzHpCYx7EpOqApLMtDBZBTqrwayBZC2YnF6VG3atBzobwGzsqDYlWLcmppd8oFOAVW/AZhuy3pr06r6ZDbBsG8Pajk0f4NSHGLaDIX2Msk8w6rO2szVul77Q5AAKps/idMcuNw3zuFmETKwvezakTFBUjGJWWQ7PjGLqIZh0Ag4XrtarKofUd1VZhPGXluWHJYPPDSoMTxbmayiOuKg1g2eSTBgPcb2EC1f9sVMEdQ+pOEKPiJgeEWGxHwrRWU5oMISFISxWtQ6p8rK+68qG1HRVTfoIJQkFfRRrLhh2Me1wzsw5MiVnxXYw7NKAeZOJgC/uJhBYtvx7PylyOj1znvdqfonLq/+CUruliObVkTwIKRQgh0KcFt/884w1pM6Qv2DR9B5lv9MJi880OPmTGAWWB5bZAmjZN70o+3WymLd39LtLkvo3D+whMrDPC3xiTVY4qGEOlFYIkzo2BxXhU81hirs+AjNN0MkG0BHwkbvfbdjJ1zEvDg79Jo6Cw1YG1g7/ZNNn9z1ueQqcsi7MJXDy2qgsHnq3VVZRZvUsQahYtFo4z5WQufqcr4DDF9+Sl9k+D8AOvLsSgJO+jWy8JUD+aGD1PkmfMn6ftvGPFPvwN0WVJjjhq0FwABJod1IJtrfj8uq973PvVigbsvAitAw/vRjHlYgcP0kZVenUXaUVp6mhel4iaXXJkucoVDv9swb2zqhlT+MDkscxE0FyeNyO3X1Ixg1NGK5lEInXovMfh2onMXkUS7AFOZDb/9iQXho5CeJ9ThKNWpNoWSD3ju93QkfIKw0UEBoCdP0E60XXqqDDHlA3xOI5L4RdYCChSDgOCI77qCHDoXJu4/0yzgFsiGXKfO+tiTUPSzak2GjYCPiKcuVVaKeeHdQPdrytNOxaT8z/yI+oQOsVjAvvO0xmDb4EzjVIAjOEq1gaoW1t0EkHme/jh08HnyIHXRF414zh/pBhrTkQvKHk4vrsOLC9BNxx8T8NS2C2XdiU7E+IQyWUYa+tttQzTjNnt7LWC9e7pfWUsyKrq42twquxPxr7SGbsfvV1a7wP93fEnYzWZVC6u67gPa1Zj8UgP6AONLhVWHZ9/Sleco3mOW/x0Xhd3sn8IgnfzgKsHO6rqfgj2lYUHJrEtBA0C3Okbh/A0eLeopw+z7TYFXnMIg/Gj+TuXLYD2I9lJUfypOd4riONqU2Vd2X8k/vF7v6m5ba23Lrjqq8fu0HFH7nk17z2Tshz/Jz3S+0aA9a4oDM1AcWaKXNWzLLOZVHsc53inwk4FeqpZ5vr5PhaHcW91ECnWuR6OmR9Y3/KVhKt8DdYdhK/e4xxcdH93pi2XenKsj5Z3LVEyUpuf9V8xpZWyP/aRT85mpTClkMAE+/1NeVFYYmSiB6gkg6+tP4ctL0tPLZvMMnA3/oucglcfkbrBOIVO3E6fNnnDNp/as09e9wMMCnHXz9db2hoLJZ6wkmhU1sGOak6q01Cyf64r/eXCXJKdp7Ft72r8gBeQqBWZBU5qpK2vu1DGhBl+zbTImFj3Cj/CvlNQRYdK2oK/4AZuWwsrlwJ+SdASreBOgMvEVfR1LK7ay4X1I2Nfjb64PFaL0ZqLAuOh/vRAi6Tq6lHgU9eoM5YS8m69/yxDkBehoBj1pOY1t/V+3Uwb5bKojsuImX0i3ZLLJahuNxdT3Kn/g4Kp9r95ncaS1ygnXN9jSPanz2GsfNveFzwXB4wJfUnvMzNBAmqfrCihQ34sTyg7fwmy45ahgTlDz8LqbF1oZQw+6Goor/OxxbgM294ScsB7V+Gwk6dPHEXaoFtLzu+FPjLbmuSr8neSSfwtB5P+9WVSoLscOZiKQCt7aGlFp18/BKkxQmvM5hs8vX+6NO0hcIjrHvsadflz4s7xUqjrYHtPn4C8Ve4OLAu8xdki1ZoHMSLAk9q83qBrhrgSF4j9p1DOMKTdcBc6vGzePMaSRvR8LYkmLBnU7DOr0CYzxmeWSEcNL4H87yeE9qqMAdzHWZ+poQ5QdUCQA3jwMEjHmms8zI+Wx+SONG8cXVKtjgBPzhKAzc2rICvR5fFAKB0nub1gdftYfFxPab0ZRSwH9yx59qr9xuKzIWVoMTkj8C5VUuT/yy1936dEVzUo22lqVN12whkFjsd1o5AlAcvplEXcTVHP6T2SJ/jIOkSBodKcKTNfQHWE3PW89f8QhbRUwow/kXdcUBqgTQw7z1bUIz0tigpihnsTwdjt2VnbdquEfcxaxDdzlZodSK6AsQg4G4D9ysA8f91Qf2Bq7C66Y7nZYxqfIDInFidSS5nd7HRHeN0ySkYyEoseFj5KSUGwkvwFgBLgMHXLkw4zGDB/eSirNVpnSgv4fNnlohB+vhi5c5r+9AyMR/RqM87vTOWC3yK5gwsm9YpK6PpK0TCx2nM8TKZOylbvrJBbZLfSza/YcOZYikZA7WqpEX/WZbtqdU6e7fu42198XZ8hHqI7fFJHJmbsQUUz8gJbR8ZrO58fQmQ2vi8826tWcxly+o802PpRvgMi7nAapSBWKo8ajB/ykvkgC05sD/u65G9dD/emWIKnAXJ6x5CkJ/We38Y6GMYXvFulAMfjO7Ica8w6FeLld+RANuPYv7y95zsWN0AMwHATHJKFCgkAACQHQzMTTG1Eou4wyeAsSZELefgr2d6BorScAwyGzRm3djXxMcb/LOiBHAtkmwCTXsS9xxeqrzEAQo5h7fnz/TS+XVyQ9W78Ru3jVV+cEyYq/nFxBcYcMwibnH0P7fR371wlTi7WpUlE6A3bD2OXmDKjnslfb9scm4JWWtec+FcWUL7f4TF/l/btcW9C1nkbQeWNIeoH32CGLDaQ6xI+L2s61LgZDASZA3U6iB/iPbAuOvqPM7ExFEFlhgEo9XvMxSE/OHPA5i3bqt79YIDPu5ELFB1dyq69mw84l5M6jj7qKlp1izx36MWTz+AVrQYtwsv/RkBDPlRDUodPwRKweAB9qMLxh+xoytgpW+nEOl44vCrD2QJDrMekP2BmY+iBQvRTCMYY7A7/D78/gbmER62y5TFM8qQ9KMYgui79//R+R5BCgZikAVdQhQj4Dpj0EMy2h1S0OGQiqqOduqdRtecNDftgHZQc9c8NS8tQAvRYNJDO3XcOjnc2Xz31Cl22tMver7vaV9GN63nQyVoEVyr97Cf3KrQzp5eJWkcYtna0Smwe9awebziqFeNTWu3HiuYim6VsPZPRYv/HBgHaMpysIoN6u4Jcdlw4alD64DGxqp9tEqLnXVQixh7bMHb0lq6sX2N6OEjt8SNXezliet2tmu2Qa3a4lqWgBeWtLIVaqkW261X6w4s36LRjQTAs1VhrOSh7bIoBNnI1M+1SYtHbmZLZcdsDStax2grk9qpx17Uvf9TxQaEPoaMASSnQDNiC9lxQHPkDLkYSsHVMMiNB4XhPCEvXuyo+UH+pqJFmQZFi0abbgYUK56BBIn0zLSU0DLLmUmRylKadHIZskmsk8uY1jYC2+2AihxGlChh74hjiFJl0Anl9P3iJCunnKavUiUrv/qNvrPOMVXlT+gvV1GuuYP4z12Ue+4hGjxAeegRsSZN0GNPsZo9x3nhhbFeeovT4j2RD76w0KqNuXbfiPTqY6JfPzRgADFokC8dHedISMA9MlIwIioy4BMNWfAIRg7cY6AQxoWgCEanScMmXTo2GTKwOVuz+8jOkCRlREpGyohbvE4ZNJSroVwN5frMugnjJptK588wOeaCaBhm1DmTpIxIGVFx4EjFgS2lIaSG8zScJxkpI1IyUjJSRqRkpFwY8WZt2M8uvZ2KU1vtJnUf3PRDfz405pRI0mPZqnsGIxGbERIMPfoEzUFeZqcZo5mwIWBrGdYosWyRmKqYtkVxv3oz4mMUcyryaKoRjB3ur8CxZzs2KaujfP27wDZOttsJ7XEYNgprFgghR8JynKmErZpxkX4XNgcLItKxHCUARcyGkjiGCpowfrzEOgKRuIaADeKkTbGsrLHSGIORjzEYuaAcPtl8svlkx3UCJysrqwLaWAAjh5HzcHDycLDFfBonU0zNARMRFRlHYeRjbIzByC9ijQDGSy7Oxc/Lfazdl0wRu4zcXgLsBM7YbDXaKrK8N4M1Soly8uAhW9D/8DBRufT5Up4SyQVilv2YSSKRgIjPAyo2v33K633kqanzx3p+2TRKkxzV+Q3PbR19qkc+LgO2HH0/e7An25pkbmgS28p258KPBPjt16/EejwPAq+M3Z143/+5Wkh46vI/ebHLXjnt0cjFmG3p17Yq4OtCFhUyKi6NqigpTDSuGuCIvRiPSeCgYInBnQiJiElIycjhFJRUCGoaBkYmZjZ2bh5eaxYFLhpCjFhx4iVIlAQJhYuHT0CoTbsO5w0aOhi+s+U1GDFuwqRpM2azEJBFuOAdFy1ZdsllV6xYteaqax5514ZNj1XOTfoDO8w/i7TuI5WOD2CtLWhfElBPRwGNwRLgCImISeiR0j9MJHR52SPxMGdZ370wINnye1M64mmFlX6U+gDevfuSx6/yVU/gabjcu1gXF1DhtF+d8VvImaQh+n0EPSdAblZOwy+CnBxOARVOp9LmV2f8dszjYQ34U+SEKfFTDqdUOO1XZ/zmrHPHdPRXPqrEFR4wjXCZ4jDF3QWcUuG0X53x2zGVwkPFDJ7MkyUYFKEL9Yy2kTNztbUf4Ci/eylVdJM5sNqeu5p7xTzKdl+ydnw4YPP+bylDjUFp7ZBC2zT/Lpq0g33DPn7WMXN9mbW1zA/WPOJ/PtmCqQx6g8zJKllWW2Ot7BgvlSj5syQ3DLYp98H9tnnIy173tWr/swsKw0cQmDQ1mX4JbJvYUgZFKRbUEWSlbwE5sl/SjIHCbTeeTXFLREDfMmcWT+67bzNZY8FjGlFWFz6fhKXaPz6nn5fL0UfSVvbSusQnsEQ2+/GseCGXZCIZS9d6C4n1InImklbQXUuESc7CD+fp7J9PR/Q7aNd0LtdVY7FP19y1fjvY6HkQpS3PUoHHyyjs7nO6nijRrCTIZbNTrOB9YR/idI3fC54Jc2H04S79ySTX3TBZk+emeOmLmL1dzX/uOZ2cJG2xPKhjUja+WrGzqZXb32xape9XzmSknsrcW1TWu/cfyK7T1rWuda1rXeta9yZm3BCjyJ80rBTs2HPgL0CgIMFChBovzAQThZtksghTRJoqOhI6kpgzV87CbHPMlWSe+RZYaJHFllgaz5GAy4FQfH/E8jSZIdcbjCazxWo7xEXP60seFIArgRCMoARiSBxFDoWLUWl0BpPFDofDuLz5x9xxEgiFxLXIoXAclUZnMFnsb/mS9MeU/JBpnBlyvcFoMlusthZAHQjAaSCUik8VGp3BZLEPvXIyHIDgoMCchKAEYihciUqjM5gsdqTSZHKFUqXW6A1Gk9li7bZ5DwXyqKfsVFdicq2RlhRoDJYAR0hETEKPlD6vtxKC4R5bJ6dyzy+HoUHx4YC6KC6ddlnVrd7RFmcoap1TKj0P/EcZdTp4ortnIpl1qnqp1QUnDvtWQZE2UvVvopOmIM4G+86hbfnHnJ63rzQlDRNp29KYfh0SquuoCtop9K1r3biB77XLxtFW+EMCj0GThaQ+tELGOZJxrtcVYhs7cSPeoX722FB+JJV8wVS/w3l+yDlrnvl37O3YdTeiuVPPPPfCS6+89r833ubHnA69vnd9LeOHez4ar3NSiki/LtcwiH6UfO4vvOjtWD4ysCjrzhTvCASJ2efXPX/ijmC3qLb2FN+d/Ag6+FZbfJf1HcNZsjvHs+pazJYTqBglVUhbHiKvT7a+ASm3Vyb7Oyl7uN8NvYAIdF6AvPgYphegm3WJd3b/iTvv0VgW6ed54ykkn59IxrHwQt7tRdjlSW8MgVfm4jzGvvL7LEa+8U95hpYLZp1nWdS0JXBEJKRkhy/TjJkyZ8GK0k1woLz9m8aWHUdOhl79ybxb86a/X6PVzOkf1T+oilQbVEm926vYZZnygYt+8arFIp2EeC7FrejR7P8iUJQoitCnD7081HHIepBBpJhXHsRAIDjEUl6hqIdS1EdZ3HjxEyRMHp4qIkXK1GnSZ0ibLmOmRImTJE2WOUvWbNlz5MyVu6y8+crOX6BgocJ5ihQtByEKQTFA9o9ElAkxyapIwLg5iZi0snymramIeU9Vx7JXk3DvXHsNlxv6Nocb6fA7NWREKA4VKkxxZGHDRYwUPkKUqDFiRoueIFGbuVZ2CBGslSvSV1lTezJWdegQrJvzq41IEhGRXUaCY0HknknsSzGG2BRWlaUvflri0lOw3PljHe9EJzvV6c50tnOd70IXu4QQaNWaj+FkmJhScQcqfxVLklYlveQlZlxdh5kYExoABHnFpIX+0lzHmsZ+VVyGTkiqamWKrDDxmGGWAWbwNvJOuc2Ub7xQ52uvsFX1Vd21agpTXUnGHmP02ZNAuMz6UFyzB5T6pVrXJKRgCxDT6NmNg0WUwNCOmw8UUsgiB9c86AJpO2cWcN9QqLZmzw3lGE8jj9HW1JyNWJDUJpyRIR+lgiQnG8NWKzuPehLVGD2reiMeiwm+nga0iD3pi0iH0nwa6ggrmPcqBqe93Y8EQq1qJBSKAbQEGo0QRTBcvp9vRrHdHMCxgR2OIjFJcWD5OmbYhMSE9sCCDD0sRWIcPWClDD9EJUbUa2M3IUy4hDEjSUHLC+3mUNBif0fTQUGL7GR7AwUtkvR2GwUtJ3KTL9XOQEGLl2tbERS0vBpPh4KWZVo8FLQsiAaioGUqTNgFkg8WwdYEmwloBuh0nENPskYMM9l8byTH5j1tFGYvI5EuZB8+tbg8EsSjnSlNYF55aZECGbj1xIu0uWo2XaOavLaKKZMxk+bRmNtza6GA81NXiQ+FVB6KTg5OPqyF+XswO4dK4khfo6C0u2ZICZ65gm3+fM0HUT0HRZGYm3XDOms0Ei1KwwtskRIlR8PFlkgERDdCz+F76oGxah6oid4gmk8ewNaoGoa5aiipQh+IaX8iLobftiq8BjZQOrcFSqhwG8REYbPLwpVDQgSYs5gNlZmw+47JQAJs6MSjOA6l8YCU5aEIOVewWrf/7YAdonqukKw7iaZ15pne9Zy7l/rEH+uLDEkKu/oCAmISRt0YWf17Lnhq3J9jMCO5qSjP/kP1HD5wZuvdS5Ku3ZGnQ/94C90gC+9sjZMg7hI2k6giViqztZh4U5l/xzFNOkrQZJTjMqIiURVM20NCF2NCJj846g213nVs9QA66v6Gjqoy6AgVsRrM8WZoOhUimWxpKRakNKU8Uv4kxpBdKV0hHMnGC1OEnGyoDCztziQdIH/XlvYFivjnhari11orlFgzrFhZSkE1B4p0ttWMw9CLJpmx6HbRMHOGociXnVkPn+xIWFN9b0+EBYX9tYKiQsLEJCyl1H1ErK2aL7Xsta3eQbJxGRMK0SYJ5EtVjcsl2HxCsm5S6Qvzo/n1dkSneTaffhLKc43qyFU4aq9tNsiSYr5E7vcWbCxvbhwjQU9vUMkJ0eaPKsOEDPmtTf1MZpXKIMiIvkOLOPlsVREPDjpuTkY2I5uRydgNQ0VZ/liS90lmXtT6SgLVkGG+fGUNgZE8qNiyYEyWJdmSD/kI8u3YbuxgKuqN5NL70TqIS9q7q6Gqxhrfz60oioFoN+vwSsYP6RinqSW5lw1WYN9LE8GTkhQFFGOoK1NtsDg8QhiuH5uSVZ6EuinEJGpjsh3TSuYrXYi5DjUCMmZKpUkJl7nEzJLFR9eN4pGaI1+/w0NrjAPQ4qe/9ks/9qt/4vu+5fUp38vG93zTV37BR8Qg+sfxR3akey/uM5/yhLfnshc51xmO+/TSupMd52jCgZU2u8lFyqdn2vkNLLn6lS1/aza1gbWtdmUrXu9alljRokISV1zvi1L+Y7iWQMz8l2i8sUYdcZBUpSCZEYQebGLjiiF4eIEFOsvO2XaZL7nQWQ6ZstEKE97tEudabK7JRhpumzWWmC2g2T4VxeqGmM4pV3H5ZJdWUmGqlkLZShFT+FekfGWlBEJYsP2HPMO06D80/UOJ0E0zlRRyD9WUU8JkUokmgg7qKCOHNMfQA5WabbJIoZo630DJ6isrvzVNNVBbtZVVXG8tJSoqShOqN0Lo4AnEntVEX47yxdQRB0lVYvHEFFVzuvBIaOTxWpkiTUhNkO2zhYU0u2xUn6RGlYrFrJE3okeLWhVSrunRokaZAtmEIwRfjzqJk/l6mQmU7lOYxqEI1oyaLw6Hw+FQFEVRFEEQBEGwWCwWi8VgMBgMJPqhkvuhNmcjtLIWZmZmJEkCAKCqqioiIpW1HJuZmZlZ7kqTSJIEAEBVVVVERG5EkiRJkiRJkiRJkiRJkgAAAAAAAAAAAAAAAAAgfpIkSZIkSZIkSZIkSZIEAAAAAAAAAAAMPzH7JnPKhO1JnTxJyVFDh8iRLlmcaKPHPIlApvlnvFeNSjFW43uuY1tt7vJyMzYvie56minobFVVSliP1wCPPd4eTwchIQFBCVaskiRJAADDB04HrCmPLOJ4YwkRUVCKkF4F6Vca/odVo3q1qlYsYpUxPZpUybimS4O4PGHUIYPgwcoqcQJsmKGOWJQ1LvzjE/sLRX7frlapmNUm9GlRrcQNPZpUKhAhgP+AhwTDh5VlInV05N1kieHDhh7ZBEwrmTUpIqTJeQOS6pXJt8aUAW1qlSnWq0VCkSgh2IsADU4AO6tE8WJFjfgJ/v0YHkyoYNjAiw0dOAJQpGHgE4/32qfx+NMEfN7s6x0/KP2RHeqUyZGGA0hkSYIAYWKeACR6ZPCpIUUAG1pkiPFigUAEigR6BRoP2NerK8uKd2/blB05X70/dnwQr0VivNbvt+myqEbie6JnNdL/3X2/RiO0shZmZmYkSQIAIA+TJAGQ+rmg1hBhCs5MhwQDSLHShjgSyPay20szwMOcRVsU1ligYPM/9stH2wDrcCfMv84c+XxTApJrHc4U9uXjbqJ/4DpAlDF3+XbAqDX8bHrUXcLISIuH2Gpl2TuvhQ7kQZ/YKiuyCVzEgSwdYitdjsHaC30eYitcVGOkQjVDbLnzcrRIqGyILHNV+YriiTYNsaX04EegtXDQEpnMT5VKc5aUSgZfBV7N9e8LF6mxaLHitZYoVbKWmmpm7GaXaD2w2ERx7iv2+qIShBtn/nM2b6j2ehFgaUYdjUrY57FDRATDV81qVDmqUI4Uc0QJNYYrvMdgkVGSEcDEGChcQLmgrsKkXdBWZTKTYEgArAbGRKZAY04SIafJThNkhZrsIolAlAgWHZgpTpRdLFE7iVrJHAyAPi4ckpDphxa6mIy0bqJWVGCeKv4w08vifjJrtuw5InPmyZuvhtxRuRA0J1QAidiQNKU8L9aVYe+mquiStPLEyMHHQl4IEqRN2eG0y+2A25SSxKI+rsyFdefZ8yKEo0dJTnTeC5joDOeXJT6Nyv6bo2ayXvrlXvqhz/N++WLP8loehf7adNePR39WU05p1P4I82Fs6Q/Hy1pdNqLbz7XsR+5EsY8sKLP7gc/roZidHtq8mG31IX2/vrwJZoG/HjcNsIAXOL450A/68hngj3wm+L32QMXTfq2ng2vfZJIUNJGOus2eNqxGQJefzlvEe+hCyFRM7tiZ+EzdjAOtE/E5rEM8EO1Hdc1meG/Wwv7NZ4HJdBoN1bjQ6uK8+Lm0dTY+bobUE8Fs9UwwAPrvS5aj1hmmgw5rT2dyoJmWw95mYsFOmsT8Zt/ENzLOCwAb/CrFjtQzgI9RDbCJfBrwa3oizd8yoG+czX0LfRm6OJmsPmWUNYb9M58FzGEG0PM3N/D/idm2Mq25r9pHWopbtYWfOhoxyxJdNUT9FI9M4+JVUFaoDEGq5ESvCpIWVbm4hTT1iRoVJe1KilB82740Q5J4USYKNNZInoXR0ogs0byRJOYym1lnF6NS9y0XzR31DVhYdkRagI5nvupENhPzqPhHM65GmFHFpFRNm4lcrif5G5jLNXwzpilSiWC8BdQdAgUrBAQzuR4wSXe8hZf1qd5E6ZpAJ4aESb4vp/iZJtQaZ2PTesY0R6fCqObIBd6MOMYZU1/twYU9K6bkPB02vO7mId/c83ouocMwXG1o1cEolavplFdzCHXsHyYUXNZawYZTyihmnd9mEeoMwQxTs7I6WeqpBnFjV7QbIF2KfoKSjIgRQkHDwlSiqvlfeiH0yMgZMWHHkTM1H75+4C9IlOliJZhpmRRpMqyjVWC7IrvscUSpE8pVOe8vF11z038aPPRYsxYftGrXuxUfS0VnV/zmbKHvCj8jUayxVBhgxfv0ptcLpn/E9GRqGv64GuBEJ3rLPobOjJxybhWdon6kBnEdO+Pc580IaOsDywPaseJCg6jirRibhgk2vnh0mCSM4KIRrYDsGTSFEJ8xplEbwsAq+HLC3hxG68JW32g5se3sLFIQiRJDU0YDN2U3ayYWO5s7UG8SDB2Ehxere9GxxQKz1k/Jm47VPaqnid0eZHmxPTh+r9B09gyp+Im1jZ4YRhhiFB/D+2IRGFvUzoqwqBztt8JUYDsWKjNePU0+OW3ywYBnSFWsy03WiXv/OUuiI4tC2CI3AB4psc0DKkqkFAQ9/eB6fNziO4R2RBQLU9kYyZwtzjD6/EkRpixNNoSECZGhPMgfZ4yxZHwadyl1diTrB5ITUKA3FO640OyEDSnJYnq9w+x8lJJcq8fYQsdz9vJDaq/wi0guTBEV1D23c4B3bIiKHSDIByjg78CNwPKM15E5zT6LbPfPlt0vHZ/lCmeVdb2L3N41s2X9v+mdqdM31ow0oY+a5cXHzj4h23ubNxMNn1nhZp7FfZFz3Wv0/FDh/OQsp6em/5P/vbnXF+xa6NeFdG+6efs/d5acnc497NEj2mcVvOjIyw6+rvRNN989/5Gjn3Lwi3Z+zabvyv+x7T+x5ye0P1X5U5d+ZvfP5f1O8+w34mPwpfiv4Gm4JMBtBZxdFi6uDXFAAQK1TmPOsxBai0/kd6m6Sk+H9v983jAGGS+c8JhOm86aVcz9OSdfkC+iLhDfyXtHcTFpibpUsZx5af+loiveKz4r+DXsVejVpdcz1iPWp96g3Yy4XXpXcX/j/v9ezkPwkPquYiN685nHHm1/af5j3kbHFf+V8DX8uui6o0nSJG0OtUraJO34jRWv5b+edc/VueE99v13P6j24MGOB6f1fPzRJx+XR9ZQPUStz0s4/n8BZLdNw5kk8fihdcwFfxjKuZliqK+2Xa3/BOfSGQA3XOlLQhSz++aLg1mX4h9bddqwOJKLz/7ZB+65Me+/tdcpMGDYbn0OeFT7lK8pKLZOTA3dAz0HXARc6vY2O/a4LR0ug9n0fbBrYPqzRQ3yFKCdudkA1iaBX1p571ueGNgcueqVTLkBAW66KJRt2AJ4yRvuWAMSsVuebCvNES3MWJ4cGaMQJH4AAQJBdlpVPxp3XBGNOyz7G7dfKjzb1Q81xIQKR/s0bpNt49ZqqGErSY8KSkaRhsZ2Qf72ufjXDtVe2C8WGZ7qvyvLy/VVPltz3ZpuJwW1hy5H1+9P8x/ed8+tjJKtAo8nN2W5vPQts8v8CqJoSkjZXSQRB4hDxGlCRigJDWEgsogQkS94XW2rfkf9s0ae6d0BrM2DrxKVubPy5RLDwwBVKe6kU4SEwJ+zhwhCnfL/FHIZjzT7v8PPwnL26a++RjgIO3E7gF8dTIwymvD+SPjRTnoMX5qelA5PLVD/FAz7imdqoTs9T2ZXq/P4I4Kdy8Nu0+ZrwWXFNtilKlr0hYqumqpuUUFLxv2pkGANfU/eOejIyGd5bbb9WK/+uUSJ1vKbDc5PqDFhnbSf87WV9AHngkxwD+8lhcaLVGUP49AFeBweTSfqqi5F31WftN7k7a4rfR1eRN3X3Upbfd93pXRt8X7i6AOfwtFjyJQZc0O4GsaNS/eNFSxEqEAB0Qkyy2xzzJWpX5PN1tsg30Z5Cvxsn/0O2OuUCqf9YsAlt9SodcP17HLTS6+89sxXO3SY6k4BeE53Pvd0NZTubpZXc6gMlkYgBSGuMYchCeRu0GabS9AdLNWt52D4otlGsjm2xd3YDn8z20s5GTvgQ7Oj1LWxU1lA/7vObQOUEYC2OECOAcu9BWCt64AlDwaLNgAsCpR+S5baTGpm55Emeqly8ikJWYpDjzL4raqTufMgoTw8EXoE7pvsNnsQ6y3Wqd9AyxlwsNHUVdTrsdm0SvrflWTdNb+MmUBJBAEQaj+ogpCg66vfMtpBdjMwIlCrCb3CwqrGRpMjPZdskk2KCQIkApKtxIdPoFEYxXT1kk2lqXYwjeYPvy6uoE7ZMaPwzKTuLY0WE0Ah/qKoPZARVHPezHc4CGBN0ByQIESbun5x2jEKGejLKKWaW0sv1uJp67CZpXZX/k0ib+Nmdsib5wy8AYeHZp9cm5HTCfFlN2E1Ghg1hoQnNhhvGTG8WUO/nb1Jb5fZFjvbvgMrAht9wSMs2jnbYuWXnvLlhY/p+HTWmqjCzNnQDVvatpPrmYix+/wq9nPl8Sl2fPkYY4cz6eXU21lpzT02IWPMlUBye7ajkdPAixObr5fe0qLH3HWJgwhja8dtaZHIPIjMsyLvzOWlEIKHZDEHXE14SUWYLSVgZCA0DypgcuR+GZKRXLKbbP3SLOwo6qOGu4gKAyzMemXIJwrHdlFovVOhE+5B7Neg97YjTXqdCManGpTDJ8E2rOHa5G8Yx/7nTkNDU58PpDbyC0S0x8mGguWuLBAbvwf4ky9M/AqB/RM5EpaSWH6+NimOXbw8hwVqj/2YVCnNjtLFlOSlstRGERlaBAfiMA+1kAYOeIedDd7cI2xbkqjoVGHbuvqTqmY8d2+YigfT/RFxYNWgbPyUh8q7y34hRfehOvIfbLrfyNWzklQwqz//I0xvc1lZrQLTTK7uVOlR24Nc0XkNU72Vp+sVmiX417PB+mKfzCWK+0C0exUWeH6pLaXiW6ExEmJciGEJcrzRtal9uf60nXuCZciZ0idrWsu0nqQfuyD/FCJ2G/tL1wqHXo5iirVzKnSxiAVawC+cTC97wfqV6Gj2oy46hV9wMxdNF9KgZhgajdkUozwPPLmLUB7LEPpQnVL3uAATbbWd9T0Gke8R43X5ODOjQNkBCiE9A76RNcJbEK4d1m0Yp7qUy2owqwO1Kp+qD/hkolKdSY2iE1rrkclKKnps5nfNuvwYAhJO8dM3Sdu4glOxUd0yX2qKWDgYQD6n7uPXqSetO1BrBJWj2fEjpCdgcEY/LJCwpOI6n1Mgj244PvFwdds8zcBirX0svsQ+WUYi64B0xwT6GFY31a1tZLNxkhCxQjUdXw95uNGTzug1iZDZkgZygzdpzgebC3YraJ19YndCxTKNWlt7zWC3ga/d1w2SbNYH+cJg9oDaY1SzTOwo3VCXEx+OCod5HiZowbYDbrNLRUPMt4ggHeXVSwTVtJ4p1jb5VFHwyjVTi9E1xcQOpHVmAx5qwZzjSP3IxEcxl2GaU9A8U5qHKMkVX4qTePdMa40ZKB2qFri/pY+c8SLe5WdG3anQTwfv8yFV+57ruL0r3FQLrG/vbXkO58kEdVf59vBPb+gMXUFPyyiYxxKEUIAe52ZlIkI9UVbNRuhYreO5r8WH+/VXCJd+jIWdiWey8MxBh9aV4lTkGl8stBnKLkERHRTRYmqbWp+5pZp6V4+0p7DU2ehy1kIowhKIKlonto54r8uqXKgNwnu1JGfV0znxiZ9J0zjF2BzUP7VyGts95DQUILVz12HERyoa8I78Tw5QGCiEEkwn7TA7Bpxq+XmmXoJ8hd+npBtShkq8ipG3rj/mrtuKYsUAUEv2rVrMdHkSW3lUPc/kc9EN6IN45GlLjUcX+ujgzLvIWILIxJU6pjnaO4TQRz/5i+lIEEqs//LUCvM2Muy+lU0CfkhrJY1uhitEoW5ywz4d+sU4mtOOtjmstOUNrxt3ROqx4VHn0U5BxGGl7QlJBSLAb+iivGxwHqS1/W/k0CjlbtBwEeTbGdejb6usYkAiiXy2Hsd+3/UxQy35VVMf9wcx48W/GQ7N/0NiyhcPyDH4yELoOR22XJu0I/kCRNZM5jsdQi90TPHxjDHRXREcpNvZ/7d4N0fqN7osr+D3CiNbVmFGWoti7vIJwFwUY3V4hNqchCTeGgWc6selKL0UsRPII8LIdIQbyrFvV3Gdx0ZBLUtPWOfjT802eHrGNmZ5ZrqOAqt7wh5rICFujOKOdXT1QHKou5LlzHq0uRKKKFE3FxrR5/Q8n3Rt6FugO7KwmuZUkMaa+ltvf1Plnhkb5jtfegYtyTyWEiUopoeXnG7yPFW50gzGzdSknXitMaXHJ9SkvxJc/VWAE1c5cY0T6O7ttf6G6X6mNaxzaa/T7Rl+w3fjRDOGcxflaOS8CzSx7j+cKV6RcNbuSY39gMdyaU558rOKSU7MogfSCsmjqWagHjOIvN2q3yxTLyB52OTaNNmNqWc5E7VhjEOXNYMQAUlQloFf7slEJiuYllzGgb+vFwq7ta8Sl/XPmfxOKn/PjNCxPoiwr589oeWWGn33rVp/UgLvpzPyqeVr/ni2ZChNCq1g4/3Qy98splbAIN24gH8NjbBwL/8WwtCI/boQirycHQqdNjAlqTqTVRnMYl4psGAIJr7RIXynCWcfti57VYtNBqqABwoPTXPmSa7kC7WtR5jAg5zi21vB2da+EsB9tJ9iiCu66wf7PRDmJv6gnJr7iRCfiZ9lXAL56lCvXzo4BxNa4z0TR+pVq4jqpX7gw4RLp9KcmsQCbHyvc1SsigiIxNkaBPCldmcSZV1zpzV8nugHXKnnIaBOzTHDgA4AXBv3iMQ+X3jEVfbjlt0afvfVemzci7Y7fvsldyYPZNqhtL1bqx+0ed2xr/+QCmEEr+yfcUwizDdxvr59cYEIXHf6Zrhp5m12c2vWDAdYgbKx70coOveo+DtjaATLnXDv9KP3Gu/6tRttye0JEcqON5rGTXjz7GPGmd3b8eeEKCrCss6NElV02qFNvpqKVzk5EzhZK1DJlzvI7i1lfjqz5ZKj723Cgn4CVA489lfkzHlKNo+G+selhYuPuQ/t/3Mx293vqHDwLjy10sPSufPnyC9IGLAPZOKbHpDzZO/+W5B1wh92j/P1yhWMl2klZgBCn9o9sFBKru6aBrdF49xgNAxS12RqNBDU5KyoARszEM11GYjwA7XJJtypJ7sAfyP6OC8ZyuqjWWW/0x27fwCPM/XNANjWPRtAnGeePTWg8os+f2YESJC0ula19v9GHARn2S7RWpIRZz5E9v1vq2t9xT7JYaQEaUz68NXoWzVeGu2S9vw/UrEEwLye1L32xm3cdr7+5CEW9Rf4FZ+oVfofbhTnSDWud+jfIeANulGXOXL/256Rnu+fjbQA6qQ0389mmHt7pnrAX4DKXjpzV545VyjB6BUk5G5HnHUTX3SutFg2/yp3JnNYPHXUnEGhVDZRJLl9RKYpkVJCy6gzd9BB2I+C1YCLY8nffjeWHLC0qryN6jXIF5xLVpyoVJWCYfYl1T2rr9y6umLY+myTmWT2U9CpaifKyh6lfL7XeBsNzB+PiC5831RqvTivBp83TmpGal7CZs9Tv/hqkJ4w7yndALYsF1CZgs+ARh5+fnbk7C/PRj5fuXHk1n9469ha4Ga63LIuDSd/8518Br5Lq5r7uHMm+Zxz/vo+AkWZy6oJYNQ8qavcupZrsH2xudGwKpev1zVdGoofWDrrtOc4n25urWPtSrbfkOMQEEOqbGYWh51vDJ55ylxhNlhaVSV0JA1+K35PH54BUaP3InDZxjxtxeUP/9w12u5x3Vx+P/9Z9bUSwR/Lfn3qmF9WE9fTAbXlnLTvRC/se/vT2uFMH5VXyVrAG3Wxj9pLenXfwIQTsGWUEwLSrExWZsddLtiQ1qBa38JNl80pg3uPcDYg8qDq0HZX4p79VqYttVt04ZzhjGzIJ3vUGBW9A8I+uJ237cyWmpCjEs807HV9MpmsTx/DVx6xUWy7ZGPxY4NwYCUY58bpVf+lseTvvhWW/8WVafPTOsPWlTUjq2Cue1YvrK4YbAuBeN2+PEZ//yNgBy+tHx453P6iRWs1O2VSL35pn05AtMbP9D4JfWgoeGI2Fzz7wDiVNyzRtDGRzQIBsqmdUQYHTCtw772bgy9O/k66ee5F15WT0oT5ezQFj2Zx74OSqROjzZpWLMrAF6Kq24iD+TqV0/O0sAe8vfzctznm5e3669s4GQXdML60D5VWxiAyheYYxt75iPGD4NaB44b6y1/ktB/7KKd6zrp42b5gUWOWtCcyCvB0ibgWJj7ut9oeXSPitubqDNd/+gZs/TRgRDayCWxbrgBqS9DXzGxtbPvh5LOV2/nioel0nW4qPW0o//bKs5NtP9g0ggp/3O28+gCF+W/UEiRqhTGwfdfrszpw1026cc3x+h97iF6dnqccWPsdWXf9SOeU7eR89LnjW6Uz0bvT69RC/MD8/Ws30XH+6LqbeePNLusZ19Tg58IWv71m/w08z+ltBAR9VKgW7yyP15fjQnHx6RGp/6u7JzVREop7GfdMw9nX7ONMfGWjPRsjCBd85//SI4hNWdmqBYJMb0zxa+iHbib1qF8R1U9JOx5ChXx4zc85E1QT/gMfBKGldREoWqrtkpVo54h9g7/1o3Z4eQsMG9GFDwbHEXDZTT7BkJ5USChlBuxJL9qOLPtKh6tfbsVHSnIi6UxlOJ68bwIRIO0omQ5NRrQeqGUkn6n5aLbbHsphm6OTerIbaQQ99vQEyUXsJLA7itxWDMWQkbFxtBxf8MhNPsnXkme0kIcPs7mcRIcC1GSLlH8D3ZFJ60mV6nnjJ4VSTD6ETiVOBblxK6reIap1a6yKDpd0D5gPS13Wg8wWjsdaqtlPTlMuMer82Bwkv1qQnd1Aw+ux6biIDJmE712oLu9quafce9jFkcVWJTYeAaXlchMRJwpxmZwCVJbm6xiMSTESCpsfW8qtZufKrB//PNSX11yMXylV45abC+U5lhz8Rb2ecKVZTvep0JGxAOhrWNn7uz9tM1pPTBtt9K+mblabv4bOK9lHnAhbDifgYamHoovb1LgrxQrc5TZVMSLNnQgPp1weD9tLTlaXsTsCgGa/5UlLmfXcbLnVk+2WQiMBm+Lu6LsAqOzMpIsHXlRFZPTJLHLCFb0ef9GSkyNvLsQtq0vxKy3FQLW//+s2w5aJiQrbj//sFk7ENldznpymZHdbc6IV2LF6iVTalkkxvzhxSiBDI9oH9GSoG6fCeIEAArLFp46ecliX32akmDpQLCTHBRF+8vE9KIfCZd0DmUv6hcSynKCONCOeVg7PrJswNn24OxTLr0IX1D0xVLydntT+99RiKajC41KDd89PV7SbLrzmNefLLCLClK4Mv2CR5chbCvCLxSrCdEsmYJ3tqdO7YVqNZ8SpyyajckwkXm69ufiOqa6jlGnEkczgkzcXxGBHibw4BVaQujoYhT5DXnSCgAPwHR94ven8wGaPSyEZ2LI0QGUvjnsbDXvOASFk4yL47n03DYbDGymZmto4oq7zxF6tqzMnT9uJEmb0csSj1T8vfKetz0mhFCTGFhJeLvxvF2U6qiQeVyZck+xs8SRgv4UcowELxWysn/ysEDbTE0brzz72PmWHCndZUYRb6VArLf1VB2cdgAamYi6O1N4MtSsVHQCpzbCm/gWGo+0nyAfHl5DL/JTH9UuQ+Mu9582pCXsPbo8s2yXjx0Xl7z5MA5qgpl4G0v2qObSqxjl9zG9/ai0vu7QpCxfLpLL3LAV2HTnWqZHkH11ml6n6sNnlrvR+/3x5RkF2bSo+UUjO2Dfi23Wko1OVqei+yQcLz1UqFtYlVYabItV4ud4wJfdxbHeYXT+lyV9az6sdHB5UNzXmK0921JjGUom5RIQanVPfqik+WitnAki2+BT61PCOBTwlHkvYTeD4dC3hdxzpONfdCCQOg+SlFr1DPTLsti69Z1E85eQaeWbFqM95WnDnEmt08RSqJgFbnTu0kBH9V8T9tI+l0VghDShKaJUw5YeDg8VmOjOhtcjPCnx0YEF847tOiAx2H09HW3nQdbKpemPFPjhZChOv1n9xMCvpH2Wvp3t3wr94nvmLtZphb7L4fxRnDnueSvwHz63/YrXF1nz7n3up/r2+wy7Jfs48vxH/c3vJ/TsEQF2sBq/Yszeankdx6B3+GHEABt8B57Q8f9hfYF4ofW/gLxiL2uyHTPdD4pqjWIN/AYs6+LRPodCeQDnA8BQdWMiWrDEn8t7/m+yHznWPRVsvgbikEs4IwzkAQ51vJHRn+jChDersvrN0GCAbN9aALcu3XThnBH1z6pKrmrKSa69UfVVDVbLmBIKKzSaUNSNlVSBSWp9yJKRQeMQF6tD5prH8pzM9ZT/erddz9TE8rm7X4dSa995/OMoj6vXxb4/cstFg1xZ0/18XHO3NtWQQBmVi5GJTeXFekxw7nZOZNN4kB9wXYNumcrBtU9xqz53zBAxLkmuw3WBCPQpSd2y/CtGGOlij8ziC2F+D2JAf04HFgiuOANJAaIApD1//PABrykKFVKmVxGXcurrg0YPy1pILqZqhXcUTB/fIayvz0yuoMaYtTJfRLejIFG50+iHuDrey4e0hycGJo6FmfW1dmHdPZ2AnyP3kOqb9AqwdlnEEfRQBO0rwniT2vJMdr/RG6q7WFdlezSvaenWjDlXslRFjIp+hEO4Ri+f3XjyT/O13WN3epXnlHSowFw99NV/BffuzyftqcXDw68UK3s8/68VqfmiwsKuFYXdlhWHf1VJoyFbGzpUrDLsMMD1Jeoj+o8dHdjl29wd8D06JvndlCwvro3U4OklZGc/k6bEYPfdCrfbWewqz+b5CfamUFdPdcbXGgkuxnx4GG52PfpRVO2tTumaL58qa4DxxO5JTSmMxdSdxRdpBLb82kaSkkZGFZfEsai2cK7UivmOtrpl9nlVjuV2Uvyg31E4rvezFjnUZ+BNiXc3qZwpQFnLabx1WfU/zUFnZrxo2hqQBYtAioDLAca55JKuYs1FetEXRcvSxlJRmDuOYWMLpak8W41oCZ2f38j/aNVwcMbf9yfYwmmyCZKzDLxa0VX3wQRXYUpy2hOnuTd398AQ5rHXjToGx8kZW5exu9bKrxGJSl5w38/+Zt68sEjSG0Ko2Kw3vt1sqPv6ormsopU3I6UxLZR5v4adg1TC+KEyDErA620Tgtr/U0/4fz/VZf54XyHTu+lxedUkrpvTV5LMdty89aFzSlJTOPZCZa3BeNHMlmqqlvIPbmY41+bQ+sbb60ufyE+ez2pB0NYPDMXQQRWJjl2PgMGjqDmTWCkObiFdSKJhCXTyLbXRMIb4jY5UViSDW2Xgjq3J+t+byvkxLjaZkwCz4d8FeXyRoCKNXPTEY3m+zVH76cV23VSp4p7LrbKrTQ5Mc3rJxp6BwBVsaxReFa9DJ7OOtIlFKq4DTKUplHrfwQRdsfLW8n382eF96vlrURTVQhkYzfeeVVVGG0RZyrV75KjWDtr6TfS6/Qmd+WeZ0XXq25nOZ37EU8fHg/C4DEKuNHjHuIham08eDczb/eFCK2O9Yzqdl6dImm9pOCAvrnoY4ZBSXGtNmL8xfAOfMWisP8uEKMR6GNHVVV/6x4AFT9rlGkq2DfJLWVKWl6Q8h3NNY2E6INl0H0qWaT3Oq+gvgWJBnJHEe7IwBwHM+9qSg5KIqk9HSrBWgXvcP/B5EgxHEqSwELziECUdESPmF0ZiAT+IvYIMMiaGbeEKYJew6z1MUn0vmtwuxESpBxin/17MxZDWOhFNUJrCFA0RTPWW1fPI45kpy4b14Iv0lDdx7H1x/OwI23770DYJOj5Z6BIKGotNgLXdJjW11M9dsRC8TdFqPaHL5hRMY1nY2wo5nJWP9UL5CHR+PzC6MxsYVhBFybNkrNpWa6asiTfVKdt5siTZvXBL7WynRO0e4k/+A/xRd5p0NsBNZPKw/Dx8cUqqIxniIOTYevWbmk02r0ryZzZG+NIJ3rgC7aYiwVPMHXogH0NkqMlk3TT1TzIkjHzXDnBQhvNlpw/PqqyB9n+BCYViEQ9XRVaOIQzsz3XJ31GSUtP+D2qv6x+CjfUAwsPXkx2DrKx9/ADbue1dbV65Z0AaFJ3rjX3AclOUDvvbrr8uSXz/Rsr78lqZ//BBe+97Hee7d+Xuf5s81FKhhWk8RqWV7r1miNM/VpHzYUiffXNaVSapwg3bcnmPxaCGSRMtyf/Slnv3l8NL/sWcnHHIv3crwuHAxw+Pq8YPSZWa3e5nPHYtlox1y3vUsMUNDg5/RlMfVaeB8toqb0MwVhZ8rygS3nKQbXU64jciPdrieELmeiN99ugpd2HIY6HXtStnXBdqc9c/S+8dSPzGbpVz/6DOxvuK5eGBUlLKiTwfGSqHuXPk1Q8mm0YSMa/rysnW9etNkNBbrBq+3mFpx64G2Ytt5XZdfqr13D1+ln+n3tKy+uZSruPcABOJdPbb+4ZalwIHoOcD44+wbA4eUo+Ojdp1fD48OA9b/dwvDP74w1DoE4lYDArApUQUCK7Zb0MHjdQiEvHYVBMJ2niAU8DqGArsmu07Dm/jwocCHP9xBStef3gu/JqzEtm3l5XfLTj/TAQyo040+Gvj1WsWUr/d9NZUBT1271XwFNggOz69Dq6zeR61dM1PuJvDo23BNmX2PhrtWgXpLGQyOvToudD+QjPbVgKe33Kbg0ZvwY703ekHR3NmJ0QkQ7yuOrEGoSjEvNrJKrVKpPAlu2DgzNjq2wYmm0aLhNGp0NJUKlxQN/usXnooAmkxRxMJg8AA7MjMSZ0XLxzMQ8uv3v4Lh5i0V7BN1aDJZm8DE036FJuKF/PNbdJwTZjSZWoGkosWfQmMpLCAG0bNxTqd7sVPgG2YC3MyEUWClT4PUt4L17Oe/FEYdcFFiH79zjFDp1jHqBONTrrLtO+PtOocxWoky2gJB/9llZWt+ojW03ottecSoV/2SjdGeLqp+yBOZ/GJb79EaND+pmeD7V8o3Unp7UzbKy0VWuSTLtXkQYmFBs+6WRnNLpyOZ1uu0t8cyvN1/maz+t7r23weuu7xpPnBybByCzfSHXJ/Z66YICyvZp7gK/me16vq6qix3SlDS5SCZcSTVpnOJZXhCGYlI0BhrIlctdiTP2EvyTw4JcsvW1Y2s4frevZrNTc3e3l6RUS7j9eZZPZMVT1MHBlKfVlSQTDKNVzF+u4CoyOVv9mf21w3UZXy1P8I13bXYNcO148uML62ujx/kgt/zBfqx0+u463OYN3xyinPPC96uPJGc8HBOJCzpnAjUuRFBh0Xi+wg3HKyo4zXEMpXsdJn0bBBnO2N7pt3X79pg+ZRkvgwb1wf1pJSI2v2pUWWu8kSMMiV4SLXDZGITzeQcGJwbJl/m7E6zuz5qRx4iMVYSD77UV14qkF011ciuXcqvrFzOz7lWYzIy7E3fypHTYdUMRmRNPoPDLqkaJqOW8Z0DZHzhes7V5u1PUJ7PES7UB3sEigFOzuT3va4nq7aeVZNYytYOo1PvLzSegEAQpQIUL0hmw+19pVU+rq9TbrzS9S7v/J3K0X/4RQSXnCNlNu2V9Pm7puTKFWlKJiM6nESI3OM28KtECiuNT4gullJw1j5oBEbJaL13fmhg9lxAZ5eflyRVJpPk8UhR4WRipI/bIAoqlkUoY5NiFTICyhb6NkJz50eIMxonyQ6Wj4SuWBba3wN3+bb7wM+cgwlslJ87/oO/gSd8Kmjy5PaXsPthBdg2t7qCY//rX7EHPC0RRxAkwodKLjS0dy3U5no5o6Mo0lRWXLdi26IF4APlmb0x4twtuJn9eREkemZCaLg8QUStoNKy4sOCeQgsPhN+aBgUpOR1x4kz2uMZOSisNIVtt3WxvTKDhhPl98eDQth247hUBerZ3ec27t3tf9LV1f/0zt2+ze46KrmtvpHcQcV/yj3a0EBuBfKsoKBz53es/dXXrwfyAicoMZYbEkqODI341X26sEev0p2oSYN4MoVlyel5ajt8PXiTzakJoSeTB3KZnmGxDEQIjIClcQ3caGwiLKg2PJAPiTgVz0o1RVJ5JUlx2dF4YtobO94OtoyeNV4DZulNmOC8NczttJ0PN/2jHwigdwUBbQ6tHI5LCzwdjg0IjGNQEhJ5XMyuBWWLZ4z2Zj3uwIVtr8X9EKoGh9XS6FSdmQBa2SGKg1nMpDOmTuFaZ6qQqo2jS+2QvZ+iwiMp6Xr9Th9pNBKvwuDKGJqB85bqJC4vKZ7BQ0KRPlP4vOQMYEg+tbO1DtEs6AVJtqgplipDh/ty8DEXd/Sgs+OTCBn6aBazEkHISEzAZBl2dOFiAjgRaLqsKTZFjyUnwBAsbEISE4uAkRJweTBsbEQEChGNQCIiItCxIH0HTRtHy7VD9T1BRsIiqNGBRRw7bE5cIr4Uiyunc+jVTSShVZXcLZuGPlPbLbx6LJV3LAgV4IvxxnIlWCQ7OTGBxgNUo1+VH+ep1lcLusdrIbVgywGjo9HBGjpWgWolH3orfzkQfTSpjnK4FHPIkjAUln+UWEr/BcTRI4viRw40IEvJh5F1RwNRmGXfWxWl1F/IZeCbHcHf2xcFQOqBXx/Ur6+0NOIm9uH5pPRqNrqRTWdjGh55YkkVG9UwqUc3Vn3fqKYm5GLo6Lg8OgWZh6ZjEnNRmA/KPq8mNnJD0i6Zi7LtNvxogdw5AgFG6h/XCL12FN0/q28NaAUmsxcE7/phsfMB0yGDlZBeyvRFubWT3NxOkCus0thKkGzhn5qoVBvveVcXmXLhq91sB/Z2f6shK3/2drZj12qBiJTFFrGlG++V61L2gW+kRNmuqDVaB8nXvvfu7ikGwH2SX6OuWXm6e3qeOHR+sJoJhjCWOPHlIAkmMGdKRewstohUsFrPdgy5AKshq4BU6NCwCq3ONRVFePnAF8tiAU8jQcmwKiVLf3Y8V8Au5KmcKJBftVWldLq7e2XZ1pFmsh5ifggGXXiTeCj3ngZPfbije3q6EJnetgXJaiY47yrfkigHjy3RyYT86oNcSlnE3yaavnqaAcen1gzMzZgkD33UCqnyPnDTFMtYdqMu/QNM+JTO9rsmgat/1t0tWYdqYjlY720cKTLlVmf+3eAQfdgBLkMuAZvY5X/fJMkXTd48E4i91SWX9i6uzjFl/a11BH/k/2wO7EY60nZvOA4XLgjLYS8P9zRPASd1bySpMyJI2EgY6hHhxT7YXWo1u+PrZ8a/sduR2jIF+C6DxDIMXonnaLGmiCQNQjGv1OiVUV0OBiMSoyRIv/whAZfsHxvwDQPXXCwaSyL9MGI7ZRR86MjTRE9AIOPRbPfP5oclZ1inUFkCBaschH62qzWg9UGXxfnOEWfgZfOnpFcLm0c3Xrd09u+qgKpuII235nznNWcRV+mbukztvJ9564rQ4U0UlzHcZ5sjXonLFmvQpBVFzw48Ll9KntoJuGhEvmvUNlpQEvN9Jt6y9Mj1JXRgK6u2WE0NxsLuZWrba48geDj5ysRXJ/SvkH5opXn9qzd3mVE0Tde3b302Osb+nJvDGr7DmLUfaI5AAIAAO2BeSTUuD66HDNeijmvwDHei/GoQ3wFQrYMZe/U7LMbVVzz/vfCpG3cBetU6qgDTGtovWQi2Qf7TQyh8N55qiAQy8sImbyK/C8eMSfllxZ3QxB1gS3WgXSI0bBvitzxW9DXuxien9VAjO4llHk3rkPCODF1CkaMMHPDOdFNXzb26v7iWz3ENrOJOfjXX8ye5jh+33cAldMFa6nzhlNSJ4uxfn1jysaNKvoQv5JsavtYPOcGi+aHMMmwtLk0BjvHHuRxUj8xrBOEoIGXA4zm4hki5E1dwHRr5O1xgHmXxgZhuidCoGuK3XH4Ut92EunMSvCfOR6kOvt+H6c2taYbxu2Lt+MDE4hMlEL7QzGxgrpkJiplZngrugGKuh9+5Dnn8HY7Fe+N9PAD9th/5aW5AD2d28cHtstXIkVs5kDKtJVNycA0ZsR24NWXHqNJSQwIyqjV4mLgDYrkO9tpalKYycEwZgvGTyUBU69j9G6oIwavS2t/8AGQ7YfMXix33uiIgGuRaUHA3am1dENUuGLR26p1RMK3Dvbma1pCftD0OPkXRuAdnZ8ikYq12eWG+34NApz3ikNGegPJiw3ZCVWK7lVRwNZelKWEy9nTqo3UEWOqPBAepphQrVLpq4sCuHJ2vROXWfwcxuF7XP63lrXlAtIY7+fJqHX/aZ9DdunWMkq2hYFC+MupnNyzfgOQIVR0gU1Urq4HzJ0vQkyxPyXmlyNhA6a/y4ZXwry553V/MWxDTvPhLUS20u7F+rcbecWAY1s+aEoJFaL0/Va4yHOadcDErULDGXMNjOS66cRaAjeNfdiwGjmFbnqb/IuBz36D6EN/LR/iwi57wYRd9/jGGsDGthfEfEvnmpAMIm3cxD5cpN7os5rCdUL2qR9OMlWpOFOW+hXnn+yh8MB4fth3aGbYWv0vLjEnmA8rR2ulo8O0D/i+EoiS32rrp2FogUyYsVjvBF7YHo9U7wqte2WM07hkm0nY+I2M2KYsq8FTOUoVRKrIaxZa0m83f85+Mq5e0945kBB/xH1BmcOrvwD8mbkW/gC2wdzsWAx3Ao0EyDdY8CukGNs6r5x0aLQHGKrrpWPKIhTHVnnT7WTCmGdCYfm/SjK+a2eExVpHFatbY2msEmAdq1I40KALHQjr/YMjgPwqZ/IfpqjQrXW1rbI+tve4gTMyngIQC5SoIBBNCqI2/WoBhAOClOxYDn8EMi+2EFnd+D1ugOaLOzsEoAMasMAtTmM3siZzaExOjQvUEyrEEC/OFeNUEcTVeIOUpAgCnGpm0Nkl6DSUWWhQDVImTETzpt9AU0DAKsWqXEUQkDA7MFfEK3C3IXOmvNHySTwNAYhozIBMOqFWmygKuhjWwB9bCQWN/npThATyIh7AYD2MJHsGjeAxL8TiW4YlM+XGwFToQ7yPhKW05SDUm2Q4tpsKyh7A9+LL10EmYWh061avTddKzphV8YLEB3sB9DzzU6JEmjz3xVLNnHGQ877AFGMn7iYR5DQB9ft/OD9ac9Ohp7/3E6Viq+8qPu19n1VT1w7nb72OXxM6Ox0fX3tgIOv+dH+N7wfpwoWr5L7IOAMB67L5+GMA6AQAAqAEwUwTpGhd9MXnYZ4XkuEW5zDM3Yhp8KoJlLkpRHsTJd2p2rKmP9FrItJDzHdeW7zWxGwfQ481kwnQrZBP3iIR+/c54uYgbNrgkQ2JYY22KgnT+rjyJh/tPnM09gtwargwNiRl5nkEU1JzkLVjEf9dRCULg8wyULxqO08pOLuWUAjoF9uaGjv0GdpM9mW97qmARsnkkFKYSqe2vBOkEi4yH6iyY1yQPVsjX4xbho9JhcOTqM6QEnEM+RISwUr1PAd7H3/uaTXzvReWJereUYXze+HFK1piOi6yQjdyiL+aRPJwL0FDiNafX2DpBpa79dJeNg7GtzoypZeELVdzEEJnHBb66D8n5DIDeZiRH9nR2P9irvlZbWREMko3NLaBXo87Um/hRZqAy9tmIcjIvVnyc1slmGuDj+nzHjV5Kzjccg4UQSsx2IUvoizCuMvd9ZXCoZoNuu4owo9rJgHVHS6aB/78AioJ02H0mzGAp/sxZiD9L+EbP4uQsfA8ARopiDD7HX5EnvvBKR8rch2cR23ZL19RnShZLwQt0AJ3IvzabV9I9UTN0qCBPbgpE1chLKqMuMn7aUDJrbFIObFXplSEtC6YbjnHkjtNYanY2IORo76k+3KrofNs1MCaWGzOJkhviusqTHVqwHuVOdqw8eWisPVPrIb0WPg9rPfbM1WeK9GoouVArjVnI39s/Kgok8MmxtIIlG5huJ5uMydxvpRNtHW8A9PgT4Q2Mn90BYP/XTF/E2DYbhwIHYJBc5nEOy/hGzH2Tcq3iOms3ZAOoL142nexqf4HM4JVMC2jnivb2VP/nm6qZBoiqVYBO/SCCZlgFenWbWrH/D/B5/auKYD+KuR4/QVQ87eIiEnvnUqttMN8/qH9jh0GKkPpSaAtelVkCPCEoPwjYjH0W6M6ToK1LdfmTiDPVTC6AdpalQnCJWyjL6TnQViDZ7oTkdDz1I8R5v7OKdoFr6qFXk0MlwdcZ1YroI5agQ05ge+XZoFMhvZuSIEsK1uxghPZ1MQwcnLCWbtBBOp42loUE9Cr6X+hOW+mllAZCfHo5fUXngvehP0I783PphT3Jld5NlUMfi7GIvg+zs9Ty2Xx4GzCA45ACu0AIirZWwGPrGncGDZsNirSTsqJ8AXgADcBVRoB+oXJoZ2jIO8jaHLXzpJS3b3X9a5bCxXJ/UzEc4MP2ecoxQohLZX3tcz07DhEC/kK78IyuZmiXVmfy6Yey1AR4H0WZQWvgaUHQ0iH2lXkMA13wsd12HaQX08ZwjcXYQt+AsbSVXk1pCiE+nU1f0bmAD/0R9jI/w14oS670caocdrYOkavMNXi8VYa1Fn1PCVIo9f0ILqHXXKTO+L51gFRI8YWL6OE1ZJ2C87LUg9HReAH/azuSEmYSfD+5z2/911WDF+v3fXz9gY3lpZrWi4gAskccD8De5QbshsUhjsHftavV1l78H5TfSwkonG9EAxmtyHs70nZ+OCYO4AEH9X8MwbK+7gf0EXbM5P6ExxZRsdL/PY256ucPNOhiw/K5GbvVrPD+wa4CO/NcCpgfpUA/ZsP0qDzBN7qC0i3wrNoZfqm3AgDm3l5jSb4f5su5+dCsB/TJZQk7zuL132ZoMAnzsAob8YrtvrXTCTTU02hS+nqjTM0ghq3uxV3S7W3tQCd7oMs62nUDrLdSFuOfL6dx2md+7k/DGqBNln5lrcRirLSVv7SrfmVIY+TUMMACcvkFXWnYWVJIrybp9Zs1AgOrbHfYJeY72yWussxm+9zqPpeme6piTndncCDGuOjIa0cODfw3MDzIQ8aR249+c/Tno3U5O3K+z9mVc2KwfrBtsHtwdIipV5kXHXv92GfHTg31D5ONHLoH2s57N+/EcMNwx3DvFsjMsMZYB7OeyH8r/5MCA/tI9uknnz755snPT9acFBVsK/i6cM2pXadEhb3bAWfF6TOcq5w73JIzM87sLDrOreO2cu9z0zuRnISn560628V7tIuRL22c07iycUPjq8Xbi78p/qv4KP8iv5nfyc/sRgs+QV5TVdOWkvdKvir5q+So4KKwsHla8+Lm70t3lZ4Q1gvbRAFRYcvUlsqWx1peaHmjbEfZ92W7ympEl8Xx1tLWX8sfHJU5Gq1sbHtp2fvLkWp5+6L2x9t/X35w+VmZS5Yjm9Axq2NFR1XHlhW/rTi04rw8JC/unN65uPPxzkMrz+My3IwH8KKu6V1Lup7sSq36bdWBVWcUrGb1GnbrqZ5f1xpV76+9RdDG5ws61GL1pg3Y7k7NKe3EgS821mgvadu13dr06Yw9RTqtzqWL6ooHZwwuH9wwmNr0xqZtwVu9EJINKYLoIGZIK6QL0g+ZhCxD7uif6j/R/6j/12AH3Q/1gYZDE6FkqBCaC9VAa6FHoeeg09AV6APDS/oPXqPed9L3Q5PI74XZyR/tL/Iv9f/OkhkIC0QG0gKFgdJAZWBloCVwPsgzKCwIHSQKUgQZg1qCTgctB922bdret31ltwp2Cw4LRgYzgyXB6uDa4LPB48GXgt+3/2D/P9mGeIeEheBDRCEFIfqQ4ZD7js8cfzvtQ4NCFaFNoY+cb5zfOP9w2YbtCTscFhwWF0YKE4UVhB0Lu+92CleG33H/5cFHLEVujQyLzI40wggwKWwmyi3KLyo7yhR1IzsQzoePRTtGB0QPIRwRPogoBAVRjhhE3Ai8CnwV+D1oG+Mc4xUTGpMQQ4kRxuTElMbUxHTE9MZMxjwIfhL8PWQfezj2cejD0LehP8I2cbvi3OP84+Bx5DhxXGHcSNyFuJW4mwY9OK6RoHhL/HT8+9H4hFMJlxO+zTmUeDtwrGLl5h8VIyPbiAfhd+HP4R/hv3VtPz0/k0RfYiKxmBAlpKSGdJIp89fqT6Y7pzc4UvdcN3Xx7t7dx7yheVL6x0+8Vjkmv8z89sl7nnyx8r3Kf27ro4EOkAQoeABCHAASqVWuZMMvwfYZR1p+oDGXHj82mYDBfG6RogR2afx4CgnJUZpDRTRNP9io77KuSKCpXlu8YK2gQkMExof8WiZHkBAgCJgp8znV1xV602sS1ynuvl/DVpVlNXy11Q10YFTKSQ/A4FoEcgWecWt34CfLXeagcboYtilGcHutu5ng6yugj6XODxzgYaUbUXKO+TRE4geNoRgffuF0UgjQEBw6fBAK9qE9gBQmEww5HmgxCpTItUlPAhB51fDnrzGc1LcYIZEG9n2NaXt8awHNybr6nxfBk/Nw9lVA3zSz4mMaO9OYJHIJwBmy4S2+zKhHI/8esQbHCpWSdNtogoPuMYDzp9HmwpeFmY2fBryCKbCOdvZ6+zuj8GpryP4gBPlsi2T7qT1freAk/OeknK+oOwoVhP2jf46B48HzOVKulLIjJ3VpquRWnyx+ETFxZcgWQjUiMyAsL/sdFP8U2OCa6PKxKRa9pa6K8vUSApja/8o1TkkTpQ7rgD18arX9gWs+rcaj+zMOsCqJ52N1sV7G0JjKzCpGn+RiBGq7SLkErjZ0eV9R+7FxrhEY0zTlpLkOaN8A/bmqgApYbWi7B3VZs2aORBXkooEXXHZ5R/d1o5yqwnPisSU2l/OBS4VRcDUog87Q0N8O6044raFn/9kUsHzZUjkGGs5xrWYHaqqt/7hFUp1P5UnPTAlFUiV0BjVZz1JN1Dgo8jxHIQZvyvr8HJYEtPX/HGvkc2Riwr8C7JIo41s3SMRa5luLa65Jv10eC+psipxdg/sKUEskuz9cyOqCCUoHN1iNywW1aVcxIaFMNkIGOvfKoX3xbdgIWVBYMOTuCarCjs9q/pIexqdPyoMXaJ8oMUbd4/30es4mCeec2pxYns0lBSmiG9xSzD6c23O+0j1MNFtaXvp2VxbkOXjXaqNUl0auqAC0O+PcJvcvS4zTzO+58nyVx8LrBgZ1WzTlVrTXPSCAIckaAdttZsCqr1KDY/sSv6Zn/f34iyhUEakJ9Hi3gkw3dQrXxOrxLLXXE541FMEyMxvbS17BvZJHMCd5EcdKBuAZK+9vVot79LNFJaZmHuzhrDcTLA3ggYWEHSyjzrKM+l9qeOwXmLIe7IyucXmIF53/RHeH02XJWLmAubDWcO76E5XFmtXfjaMfYPeLu/3y1n7Pf+SwrP2FnbHphrmGCYjVUa7bIJYf/ucJPjczKohxS2yeZgo+/smal3e3nLD+GbtJhY4e8fdmP25IaBcskm7uNkopDta08bU8IJQqa9yxL+VGy1O5+eZW4fbpEiEODIbb53U6AV3L9nd+ymRsP1QaWD1O3m7QsQBIFny52uzyTPSRJaNCygYlcQ8a7kKRmY0DAyIBu6AQlT8JlD728PO3/Pdr0GXwnyQIjGCpYM5VExgFObAzRKxPt2frU6mUenn4wXMbCjjAI0oeVcYYkxzSZAGdICF2dLIKt82c3k6wGNtBE7hNjniGLdmIFZK/Y0yyFXdIHsbDkkpcILkIy2vvmZXm3ruxbt9tYAJ/lk8vR4J+Eqb7/JXoYXYNZYLmDJEoSq4LYLUd10Pt9UkM853jhAcSo1aMPVoww0VAp03LcHcSzRKYfD6aR0ynoMr6K9o2CbkY4QX8UGCPfXo7nCTZ43PrLgrk5mr1V5TneF+wGjfC2stoqNbk+3ttFoceUnBa8vmfhbUKrOMzExJ0G+Hya3c4iaBWRUWlSWg/vcxd1zImNSAcDJiYYa3RohOuLNrXqT8xmDZFflxY75bf7H47w+lI6zv8rNATdNfExsDDQgI4myGnBT2AWAwgeBklApcANDWcUpfNNzdBuFUl4ad2m7xp0ygjohUH1SODvmuD2Y5KRFce3QF9vQDBexDYAlurQLU6Xg8s+wZ62z8Vuvj3t7ZSHNHNvcmHY1fCkIQ4d9vitF3zyHaN3tmYaIpFwkFsgMvGeB7lhbwTes/dJuP/SJuZmB2RaH1gsUQT6OQG9crKYqDhgChog5a5zEe0RQ7+xUCKSXJBguo2QBUVcLEQe/nkyhTSYY3W7MnOraulg45NR5tbJsfnpYGezrbCLdTNYXywvDq9UJFACCEZKfKiqgCfZ19ZnuAhjIdLyJWZyUDJ9bIAL2/YXM+rhU4vryfu5+ogI0+exd4dVP3Vrwt/KHoVmhA9dHexqA3yWkHrDhFWY949orXu5VKYDjP2I1SrN72yIxYM8Ls00NJSHR0aPJttP8ldfVMBtzNJsPlYMlRsoiSvu3YNdy6DiD5GGq+YoRwG+VMpKTT8LKodmhwrJvyzr9j8Hq+dsqja0B+O/f71dTpfsYbXjIi6sjDA+iT2aEnBMeeAAB6DMSEUp/8pu/65Guj08iJ6aYUvajdHdP93zkvrtQaHBiOwMbPxCMlHOKC23Kwk90SHumobmARzDZv7vzFkIZDuVhY2EzAr7IxMJDZ494f/K5+ZbRDMG2VwIhj8W1u/fwOhABJnqXNFxQdQNuX85Yo2QzDVziC6l54i0h1EpB43ZFGEfDzI1UsHxMGPg7bVY77r5dWuwNjF6yeWQP8fMDJ6HGEaBTeftLiglOwWbEtAQKRL6+2G5oY7UGZm435JfTwgeQlbSx7FBpL38FvJ33BIwFQnNa4tJqzlwD2/a0QEB698pBk7blXzojPGZh5sCU9NNjaUJ/PA8YoSH9qlBy8BAD+9O0VlF5iKASKSSqHt5HWugnediMyc2fluxEp+d2dcLqfO3GGF/yLQDYUHJMNQM5JBXe6QmVky97V6CdT9pUCeYTfqqSkjdWk6PTOOAU4DLcCGQLtV0Vt7W4qEyU4lJf3syYmJuBODvT3ACbSj8QGx5xMoXjZOz3aOnsnPJ0687B4H65hDqAFifcy83s6U8VVPXjib/bWy36wl3Nrz1Y+gzfhSTOloi2tATxC5YYPGX/I7d7Ki4g5T3FFJpFAjoqaTCNcc7Ws5p2Z1YF4e2kQXDryBJq22Qnf1CjqGZnADKmopvEZwcfG/sAnmQ9XXtvPSpzZRnsyfGzPuL1vQ/ho9pOwy8m+60h3/fn5A4T5P6zlp8N/luyWh6GgCZCZWVrw4CPOHEJSMtVQ8T5IwwDGsds7828+gz/hSlqWt2R8P0rRbiWS/JlJZ+qz7EF3RAJ+dXYMilLvFxvwted9pwF1JvDCThxc8PtFDvbK7dUuEXJ9thVimLrwIOrnDZnCXAbnrJ+v23QXr4GULQ9PDisnyvtqcPNSo6BvhUg9p4d0tWJ2464DOuMWEbAge0cGCLa/QpiEhZ/4bVmQ76MldJAgyGObeJ6S8rZ/g+m3hSFyoF9IGisqUHvKs8+AT4irqWq95lnR20rk6pBh2dNl63wjway9YZo3kn0QQ4fGAkDBPj7QaOZXJ2J98ix/1aNQSpuxSpbQSNRI2pG215S1i4EnSYZYvloKAk7S48M1auC7pHYbNaz5HaDBachjdjnE3xtOWfR+qblrm+9yxWCkzzMF2ZyA4pTYvHR1fgQ5343jtSUARbzWVYjVmRlvfGG48vom+ETVAl39JQK2Dz0+AlaqEIEe97sKj4EH5FBDfHM0KgqoJ1zhT37sYXWGd3gtGwiABTtt69n3/PxGsLPsEPX20C1k763ZkLUC4c7xeXth1+0+eKdTqeUvNSjAI4DBoMjGaScg1jUE9cbrA9Zo2m6QrUCKHDz0icPaLCVsrYMzT5s5O+AsbX5d8E3dK/oh7JTtxjqQLD/6u+SbDXZK3cbTWadaoe+zsojfGzDxYELAbrMj5zkEyAE2lGr4w/9wWNYWWXQ2bXoPdKxiMcauka+1yWl3NVdqFTu8m1fXl8w/JSNAjKzPCd9IvczgkcXj4Ow7GKZ5wNYeH2bMT6JJnU9j3IqwIowbKYY22sXlgxd5bNPzngdxYBPFB2/rKlcX1S8mmeI/VvJZaaqWrSi0FT55E0MWWSJwAUmNcBcxh8vWHLPgKpisS1L+zGgc79rwufKvwgJTVHaC2vgL+YTMS6lCgrnGzgzH+Ag10rqb3v1j5o4uBUDh2lsMIM6VrxtwtmkBtSstKEZgNmD5j3BKBrnA5z/whOpNCh2wYkUus1k918lhDUocsXHc7/TjeQVXeb1AA/Y4+8w78YQVc8L9OJw60McIFqjYxELApRUMkwPCkPsEAoBwWHGdK+OlTPa5+Xf9HcybRa3ZajBurFQrY4mLIP8NeBzTXEmvpGzFcQI1A14cnYSPD5t22WMyuE5TfelY5/YNmp88yqNZC43XO/Lnc7THLKWgQwve4cGDBUDVjw9meizy6iBHj6NA4OjrO6knmaQjQoOOXC0cOGoEmlTk7a5WJ3N6mzKXyvqonJG3aQvDMYMVKyrSbCL7s3hpAYRgcjAQEwPUOQGxt2Ro+sq74pTn1W1xACyn9TAmiRsDbGdqgOI8+kxb14O2LEmKfP3/xC+qWlpTziK3nuYxwkIM6DrYiys/aq8DrpWdU41P17+wAnNVO40uIlohILPaEs88xQF9cxOfoLwUPNDwr0RfnoFZt3oFbWiyECMyeXz1T0wVmkVPnKFQPG3a3cnQRi8IjASsfNu9VVWDCSHb57FUKOpkrhrG/jNn4eTglFxHcKT705s2I/GzTFYJBl/2XhXsgIWWMBE62hgoJzgmAvejDHZoBAl6dVLeR0r2nKw3jxVPOoOKdcFGvRVMZ6LBgzYoajFcMDaA/IaEWt+oBaq8hYCO8Yozu+hsVxLdzEOnrGVBYjiBmy5RBVUJ5cdNBx2ZlDC7iiuHPr31IdacAGeLlV5+tr9O2rQ00ex2J6Hraa+c68VSMLvW5E04eMhdSjzH6yXx8etWTyL0wTjHMIDt2NLPCpu+IpFWrlFQfFKQm6/GSf076MHyhleb2RICcccuZrYHVJMRoauOaZ+yYCgZiZCCUdWZPIhNyNt7Uv+K2gqO/fYA99hQFC9jPLyjxSJbDLK1UB0ITcplZEUvfcFDsT4zuXmguODFK7/BnTkiW0WRXZsuCmwy+1OHyw0EYk8ueaUFnxEtGOxsgVGxm438l2/BtyJQcoLidT6X+zjiXx1lnJhhbDtPBcAQ/Rxg8nrB6wn2AuwJisA/+ycQ6R5BQPp0Vt/qeCor50NAxxvabjvbZJui0d56mAGuAIAT/dOK0CqETDOnh+n9ecpG9ia4ILv1oL3Ls1vCluelsAykmIPAoN0lkoON9xO2FFdq4LkuqDtWquDWyO9TYM9F+XrMZHsqDhaljHx++7wTjYxM7FFG0MTvu/vaGcUaYewJZtu4cC3MLhwCup6X2pPXC1/eDmHckEGTUebwYPRJcq5L6ashlqlsdcE0SHIM4Lgqd8E5nRCBt49FuyFHYKtBnvWr4ypaUp77N7PH+VS+Ml2yJVVQR0C4Xkr632mOxFDiVTTBLq1WPiHQKPvRngmxd4F6mTK6SSdXiQqqNYrnmP7AVe3iBv3lV59V4aR2bSGUsEWx/lx7qaJ33B/vIF5LfBnaJCku5YNyj52IDN+MwO+AHKIMnbZlq27z7jF7vDaYvSCO1j4Vdc+4QTYN8o+IkxEN8YpWykZwFHUHp0EGroger3tdMqEhY+GW0BUFvfNgw39ltRg5bmvYMNVmH70COnygkVry9j2qct8Nd3oqDRkKoT1WFEyDuttz8WjCcOrm3kAGGFY4ITfmoTBaieSWd2aZ3i4OYkyXCScOGljjiA8qqAdByLhJKh2YK3PwEsTF+Nx938zD/e2VJSf/UkWQWkvB3CEA5WkIBYxckkMVaAHUaw2Uz9s32LCOjk1muZ8bJM4V+o8eu/zw2LXE0580wsywlVjpLn/TghAAlkoFyz9FXHtRU5eiw+e/NCwYCbpfIR+OZs0q16zkwK6vl+D//7qWH1PEMrCRKe9ZtvA3y6soh6pNj5ZAI+KXRNNNPi7w2t94ZkxICjOcuOXjsqPzaXBrLQL5gItC2enXeviCkrLdOXiv4ndcvwfHK4Pcxr9lQBpXtqqi0nVa8hA8rldv1yyQGuQT7kgjTi4egbERcB+uT3j5d0rmIifr+AMvgRX/U4CWrolMQNIVPdKplorEvEz/Yte7vQRTsxbxGrcrptlp3n/2N2e1QGm4bOzbO8K7OwQsZ2MnQu2FL81EZJqIFZcBFm+mY1hUNDKber5y6T3liAvx784mmI2DjqhLW3l0+XNdyK0yFuRlzv1avtIQ+VLxNSMottq6aY1umDpkFpTk852i5GkwQVyTGBHA+6CaGJScdS/i6urpqodRu4lOFXby2uhwJCLRIBpSGZ7sst/NEY3ebLn75mHwWBD46Db7O4Q75p7yvr5YNA9fJ7R+3ZTp1VvdMvafrHJTvbJgbnnr9rQWnCtWog75uBORC0RJ3xHVsyR+xSPIqvie5F0+onWNWsPuge4v23GHmwRrnDXPwVWEGSCACucqFr+zs9+pE6GXTboJjoF82xARRX881YVVgDY2vBrR06f4JG31+QFGIZGblKIv83EStKbManUGiO/r5OAEkZ6b4MjRkRMEvwKcJjvmhNeVXnR2FBnWBrnipQ63X/dfcaKiCTZV8mv7mtip2tU7lE23+dUbF/RkpoEfHi+J+sfj/ycUnEVIz76G8eeA40CHq+0Fb/uo+Ufnto9qaHmqNn3PyQ2sjFPJQxzfChoYvNSidkXCQcK+nVwfuyQJ1zioMnf2Bv8HutWI24F4c1mFEeN9jkta+cfoa9RJtc2/IeAo9Rp3a5bXZ9kjEqcnM5li2o21zPjltVtaUCDviMrZX9KSjLC0pbe4rP6WUg/6cbUpaNtOlorY2fU6IrxRknbb0PoT/0I2+qGn/46pYV0aa1xwuPpduCI5HsAMywAPj46ZnArrJ3dbWYXUFPWjZ2h9fIMG18HSzsLamEPx0eqZcps+k/Bl+7cHUy6fvxjxW9mJCBIWPEOFMrw2V6nGEX4H4hxTgxzDZaR0dD0dpHa3qJP6zPdS1g4KEhiy3Vwf/KqNEYIa79lw6IcOrhLrrPIcvY98cKyTXGjAESahp9hV82WNO3NBz+Q7J8Xa2pC9WSP6LWckB/ESyGY+RzMbyABaYHDOdlZYui4JNqWXJ8xfgy4nYVnaRZV1NMijBOGOpe7nX4xsokkidve4z4K5RWmWtMMq4ZNoTwsHgTt8Vca1SVaQHD4i4yyW8l+aCXdqLepNqmicWvSq4O+ZlQ8EEnorUkSNKph8fhs85J4fNuOFnCFMBM82jpkAhS5NqKOh//o74+m6ts1+M6+xUTQ3ufhycnzsJ5zAGqMpoXtPS9lVb+ym0x7va5Ytv9jIk0936Wv5herGEiZA5rAV1EEJ6LBlM8fHQVY/7Q6yTgINWUXirVnxaMtltU7fK3iYdwAx4KWp9sPGtm6KCLYnUeCiKIcEAFrAG3S0u0EaBGbRNlPRHZkkGuBisqFcKE0HO30QLdS0Y9sWTLGj/x015VgWPru7Lj6lJ6KiGapyPQIgDFTrMkHigsNGCE4IASTpI0kMfXaVeb9SQU3MW0FDgB72+cMgOTwkNBDcwA0ZsbMnZEao2Yq6r8u/Zhk7R3qHF9qRJLITO6MGzKKj75Sx99mktvR388JrDZ9CbUOyHu4d/Rp9BXMJiLfreq9ugRGAlrz+rGlM8HMMqAitXbdYy19uggWozxK3YkgRbbnPUl7CCjt6aT6AA5qxSu7qpiHk1RDdWKDfzO7p6R7zsxGkwGXQ1Q6dhE7QIG5Spojc+dM1qbfNyTGGfoKzYV4cvxTPjW6PTCE5zOGRnFW/ZzrVMR7j+yPEzGJhGutczpRnCwj3ObSbxCJqfKzuwJFjS2k5yn4mTrb2KBKKoYrxd0PhcXsA98T52gLIWgbZuiJD13Qepi3FhK+c5M8Eyydf4jeRVHFybZNaF26lx0RW1mQdbBHxehUZ3tbYPkqQRGZJ0XWOWS3iHALO4FCagDJ6KqnKZ77wTtLDfVspPuwyW66EltQqvrQRRJmbP4sXrbMU8uAu5nKjF9x4alrR6bRcaSIk0Ne5JjwDyI14cVHartq9R+i3m6cwOJZLtfoxG91wuqPVmrgAtnMhknv3d1xMXsz+zk2bzbrLauVMX83TmQuuJsgInKkyCkbYqk/72vZbfSSSynpR32kYjncHq6xvQxR/QD4QQNTsTkc1b5M67sJeDbdRSA8JPOrI2L4+x8zRUtlYHP3QGq7GxnsnA3o5g1Zjt6Rc5RFXEB58ivmfIkU7j9tS9SoM58ARzWPPlAdziU3v7UcXQROSrzmiQzelJWw6Q1HJ2y4s1M2Jjh+Oggd0wABJGbxj7ooPXhYsKMukL/f9ntaJLI2MCYVf47kXxqsjWTACyu5EUW5nEiMlu/OPUoZ66U4t07RcRKXkbauoJtvcuonrbEVhLC6ccNDe5bgqtkrHA0RIsrerSHOxKCYWWPfGtYL7ZWeYPw27L+ggudpziIQLaXK1j4Xoyw1a/PxpfUTNp23/hEp4+8LMSfie3p+7yz6ASNupMbxGK4Wx0Vtcl4Bp26dwaA5Iv6LN/0TlofAlr3a5ZfWxBpQBt3AjYBwEjNLsKcXJpOTm9L4n+1my+5pS8hNB6+thSdJ8YH/BX4iqJ5tlqZsXwAZVryhYMDOee41xouMxR1iANGM4u8tBDGXWV8jOrHH9E2WdXcBoFYX7wAWM2QvvSldauqW+vJDJXT0HDf/+P3oRobKZ7UC4V2tZX0NT9L65usk7zSvEC0ViBFyckSFj3V39jxJbtPGbkWSDMNp60+8wBqRceHap9X7I9tx/R6jWyV/1LY6ouumm44WMzg9Mz0UMO0o+UOiwosbQnyWnyFhbAqD25M0eoIH4hJKqobGOg0ewg40ilHqJBToV6QF0sdRF2ciqQgtqcbmJIsjx2U0NfiLPtYniyvTtP3SUXTRSCnjAyHejD9KxT02JoUzCC09uI31Q7q97nchq/ubNR7XH5RD+spvNkZtduxANJCX0clIZlM3ooL02DKhdIpPLxFA2zD6pGGndtQshHidPYAbkwHtbH9E2lmuYqdmBS0J1kLEOSwgnjWSy7qqP7jHPa7T5J4xh7d8dhuX6+jkWUceqIygJjtrq3c4Rc2GHAWeFXyKKc8vFofpsiVHTXt87bEaaiHRx7djvEU5Yt9ZkpX6701mioAVH7CBi7MYgoZyDElFUUqFyQBD9MQR2aLLsv0CUUiDWvK+UNxZeitidukc95yczGuCQFP1jODQfDUd4NQ8S6VFI01/NUej6OmwQGsEEB1t8oYw7HB5PeANyPmJKu+J/+C8wZY20tncrnI2MiAvqjcYSWRWyUmttWsJvNHBJMBIzcGAcD8rw8iE2SkGGIYHv74SmES8rdqqdqK5msDSw/Vg40w/WXGOfqAedM4L4//hvUyd06Br/o//RTb0xzDei/TrLA8j1wMerud+h4oSvVY8dSqh78oflvDf6uop7rfsvOK/PRDy6jUlISDeWXKjj+G3TiAoxlMW0yI/RYrcZOGOFiQoic2nRr5PUcOhhd3RDzLE2OQs7oDRNQBKjOHkZc0xdEo4kKaP4Tv2qxK7Zbtj9qHgdm1MyP6jZGXX+K4sE7CJ+fiw4y405syQZsVotmjbs9Ptc1ZUIejPsfRaq/59s3jY7zwZDfcyUnJq/7xuv1VNSfLg39ei85OqKvQBqB6jyTrAN/nZL7366YUMj3EcpKi+xjS20ic+dy401HaAT3YtY07dao3qFv4xEhSpTA4qmDzWSeqJHrCJABgxmBYsrNmhDSSWPNQ5T7+m1eht//vvY0o+Pvu5FHbxOQQNdgEEBT3g0ACz6SDFMtnX2EY8ekPxTso+vSqf81O1tnJRlF18Kiv6AWyO32P5OsVxyjiYT3PyKUVs82p7Kv9Rjcfnm/C6/HkiZWs/2+m/no5AhHGEKeyzbSYASdQVEeVIgRIErrqAvQllwvy4+hNJJ/FU1LbKpwbwbMwHS8E89g6NCZd2B9h3HxKLUaBGF4jnp0cUs+x7tS4G56imIkdPEhUKs0Q/z7DmcUB3gNwduIoQKlcpxiOXuHKT79C57Ljx8HvUbo5dmnSvt5pvZtAT+bAwgJQSQUdnVpDFt73BqiAaAZ4Rfz8qR6mVzBMEEgCcvP9e6wD8LR6ta7Ufd/OPghzhhi2a6/6e4J56Q72cZhilvIunTSZhM97AMo46VnJtrZh90SY6Yv9DOROdrMZ+V3H4DkdA4dUPauVCXS4wHj1GNkr/xnClmx3PTZwcUCPB+81B8IZBFMnyb0f8Xrsy4zN6xGWzUMy2BjIcY6uGyOWSdkVqV2BoPjowSQmxsiUvH0br9XPNKKeKzJy/YgFI1IZPmjjYEuOCdvc046dQlAdIOBYmM/n45EdpQY1Q2XvOYYYFLxs4rGSztjK3LYsY7T1xxQ4ODMxLpr91a5mL4dxZ7XT9gPe0IhLU8lm6oXhcnktUtlCeuKZsB0YGDmumY8A/RMZEecpqMiuea/1zpPAlC6hcSv8k6/NVDAmoUdP1zZFUgsW0x86JQUEJvFQpO8cYevN9insMwmQEgKVfD2bWNhmX9bEgpv9fuI1taTkwoTbCtt78RCjfXuvy2SC2EGrLx1rBxOTU0k7WLB6a26zGy2Wq+nXTI4BRdkzyRu+lSjY6PpDzrN5putO5uL+dWxATVB6HfOBXcCWb5B2d9E89Cv1m0sC1Iw3b1LnwDMV3ceIjtR3/WulheX33oCdLDzepr2/FMARjjyV7U9lP2bm88lYacV5qHq+QB2HNcHvDqNiNTPR51mHdv8gFg02cKRcbXJLRD0HxsLOq7HmqvVSBPR2fy2QBAY7aGDsIcKtaHy4AxjnDQt6Fl0KIDAev+Y5egQerr37NnLU7kdFCbw8VCxbowtI4EhLIcGeh3TGEjwOLYTavUsccFRklS3e8zcDD2khsm9v8R2jN5KisQhvanS/mseMFpvSPmndWm6ViZozGxHRy0/QaC5ig+eku9ZXFa5XOqZJL3xbFOjrLAEVtJY8yBvwCY9jijvqxNS4uAfLwSxLu8faBOu2tQjxeFS+f2gUJ1zkjktN1PPH1yvPvjX6gIN9IZpoqwRdN3JU0rbNRcbs2GHwTSRWP1/aFloTviqURMH3jjl9OOOITu6IoMe/gDG9fMbdDpmCJ0W8V+KHBbngA0JnXkH20N5kmkCb/8Fa6sr9cCRx48NjR1tgUV0FnYIfejaXHp7dCxNCwXrIcTW1IWgrOtpvIpSzLamzf+pi3C0T+cGFDnGxyb7PhBcfSBkk8EIIP2/9vyoAiwDL7/jOQw2VhSchXkAPP9FiJfwIURCI1Jo+2PUt1nTzl9GPD+fjFamaWmrPSmfPmmfCITdCO6aDSpYhPAgBOKQOdPjogDWGVvuXrxB8SAFacrP3cnuwHFmXDvcowO/GoOerxIwwarm0Ig+NHaMZkjB3GAc9a5XvDD0CsUwh5brdFxHNFBWZpSz9unogyEdZZgyT9PZ3IfF8qz9WgkdlUSWfNx6YlihyZ5TsAqHOCtLTnWymTVCpbG6kgIBv7Smpueue519T4Flvrk8/w9v6sKuRJmGmvoKtHAtD7+ib6YL8HgQGEOdILh7fNZ2wrU4HGyqDXRu4rLDHM0h/o1YlIsBE6bGwhp4wyK7pd9Uat+R2vvJVsMaf2SN92LXuVu7s6xkfbEN0mTdrKFtimxOeCB0YnGdxmLRuB+0GF0PYaGsPSSA8BzM99pi6HR3Qo175Jk3g4BMcDqah5Z4bEC00bJbqMSTGHZsHeTXwYXt4vPbi+wFP+rf3zkANQ7g3K49BHaHMy9NQoO+nXFgPdaC8g1W/Z/yeHYZqP80G/BUjk+CMoTBUlWEgQxbSRMnpq8Img81dFc/+f3zRj7vKBwklbAmEqMFQ25vMi2qKbJZELPJCiyrXcB1IXLu3t29TRctTG+SId80jKkCoDPk3IlykCFrvzU33w6whs+zrscPPLPom1vqizr1y31lIU5DJ30h+C7Qnpev1VWo5ydyvSvBhVEvBuO4JyrVNNZswat8qX+Abvl3hLwW3mhr2aj+1uNXKoxk2KmtB8GRAH6tOAaRWj4mCOGertTyDKxNmyaZX1W46WgggX2KlwajeBIjwr9yoEMHJdLNk5oN4kGYivK+xVySAKoLUxx83G6em82GZRARxIcbZy80vSwtxBdBs3i+UpW9REFS0ovVQvmofawNUcJWJWROT2Ys9/r4XfYTKzQ6Md35hmdhK4XW2FNghcdgJLjY3qjgmCYwu65q3mjQq9Uy2KqjaouSZ40spVeC4AAuJc7DdteCWwy7m9F6X6cDyIwyeUpur3VlbnQrBIQcvxGSffJFQhXssLAGE3wLffG2rT9RH/djoaevc/2bL8BzC/t6Ih4OJtFouWdSqIPCWk5jbmy7VVu3HezZjQkLAWKkiPrvtHCd6D/Ui1SPeHJ0Wi1yHGssDU2aC187C6ZUOdQkgVFLv72+lNDzVEMBv/6rJzbAINlMamqNDMJRpbcLh3P71r9yZHQSFDuWEJDYchABPjehXfhWj3JfSgpmjNDWrSrtj6AHZuMW4ST6WuvQUICHkgjXoILl7TXGMQlb4HNj3F1IZB5CZXa7ra5YIgITXMS2QQRJMtCcINonuNY+RcQkaXvoQB0RnuW6tiDGRrnIYen8+g6qQH3QPFIsdwtyyCkrh4BzK1nPsQlveq4oxwBeedc3w7d3D2OhGeWjh0Q9Vnor4Zmdp5x1nmBvshqKokQX5eIVQu5rV+7E6Pz/xLDCRkq0ochCgP1iCK1YzREJmo5kOHlctJKBmQylydUKkfphwuHlsehcBiLsUJUwzcauoHlUlclJnYfegEeJc2umyfveaMUTGVYl9Nghp0hDWrBQFuMaTXRBetYl70OX1QgD1MnJcsOlbngcXrGJn2vuKpsPZY2jVIXzxEaDUmTL7E9da7ZNyrit0Or8fttkJKvls2Laa7PNXtktkzn7Huk7ITT6//+fNzJ9w8ZyXEvaEbkNYkoMVD100YoWDoFTL+GHrG/RXsnq3Rt6ZL3LwIhKOs7BOlCYzj0hIu4etzqRoHkl3jbCCHa7YWKVgaHlFaq2T2sW8J7Amr1zW+wT9i7O7ju/oMHXYaaVajiPDtAIlAXSm/mH2ZhX6qB7W9NVgKg0IkNopibEbW7lyCgX+PvYoH/S7S0Mxd2uGuRDhaEe3eOOFuEUjLLOFaKfbtuOPGIai/PQXPdQHvw51LaUkZfbwJv60R3G0nRokpIIjil7j9f3KobS0b8vEHKuMM0o43NnoCTnCgRZ0kkYjTVZY11gSSgBOS1b1vSD5pu4OkeG+jDYsIYAqS1QAnF4LJnsj6hGs0Gjm8CJwVAQ6E0ZfuYtyP/Ou2N6NvvrZDKZ/h3Km47Xh1+gAS1B6t1O82lt+SmTSVFnuOsAS53iq+M41YJ/OySIv5oBQikw8IJ0aJ0CQAHKrgE7xQeuPg8dYBbEttoIjKlDX2+fhgB+J4C0IU86KOgdDb3g74n1msB2hHdTiJcCA1TcZsMholiNsKSmBUhAObP6AFb8HeZAZc46Wa1XsS87MQLDKbQvVji5buSAgoeH06vVgq5GPQUvx2k1mLq5+2BbLPHMBDkD4/vDbv0nTIoVu2O9rGPy0QUM08hX6JTsL+16/fbHMtubmz+2aOTo2/aXBsf1wb4ubh2uGV4nUc2JzNgOF+h6fJHPZVPsrkdjJX9ZlqVMcszAZ3n0jnVW5I6+sMOXOWFPMBAo5mfoAHw/fw32i5B/fm7Jf3E5cr8d3WWykC/hcNCXrMb0QGTRiL8+nInf+lskmJ+e7PttwGmkqrrZFCNf6YlEGiC1Hiq7MtbWtoj19kCBUqfoGPmsWv7/frae5o/Rtsotmrp/0c6+OE0n+/J4PeJZNPyvDxcQLljkiabpiw6HSi8fsLoKGmWW6w+FFKlMZa9ZWUeJPjF8bBvnHlc9dJHu5Pk/BUOJ1bfPU+BzkueWHmgPZjn6TAxg1uaW1nQN5VosNmsgaSQS5FJ/27b1RszBIQh4AHA7zOwEi816MnBrisehcp40EQcm1e8QSV13iH8vNGUXuflwJzWWXHHvFlENp0IQdxLOmnc4sRb9DppZCZcF5x7NT1sPtXC4tu3BhQ5xzRNf2dFGF1l71WzRA/6Bt+A7Q9g+Jp4N+ShJU1u0CrH7kvlffJpnhSo/eqMe8hO1ki4h9/ANh5awGQVTR+TzEZwWNWyrbPnR0XYkJgELbTFalq50A0utmfYjA0pVUQZb9lWd3mYQJDkoEd5ZIdbLUBmLvEptdmgFE6cQL2msZzq1ViUl5k7Akb1t1csypb6Rth6yl+KkzYrbzLHFRWY2nSagOXP972k+A9GsOsKlpv52h0lFQ+AHlR1ekI9IEQJwBlTjnXSA1mgPUUJvpSCtYLoSCGl/J+2HjVKewczGXrI1d3sRXF929XtDJDMi9tc+edLvsyzEW44fZS7eZWGAw9GjolZP5wmI6ozvUC+ptIO9KCsUyg1tglwNOzzns+CS+D0fHwLjodVr34F16wQAEGVQ9F4ybf4yx97s+QxE7qG1KGDaDX5JXl/Fy2bPynseyzJ3wACELycgnOT60YbuLatJn2NOj8CUjUPvGL5HfVKK0d4L0AKn2CHuoQ+oSd4iXxVqZmo/MUrr2DCd7ZQVrISkzjZHlKLZnKAdzUh6UcyxSPWJrfJM2jUXRmwlLXaq/mRvtkDbZP79tF0g4+LhR08ey8pVpcg+I8X0YBvJxKs6hfSCIjRt3WXInvqllrJopv7qcL7Xxya0qXwUEyqMxWbbOHCCi4IYH5E6UjH8pSEFrHTSmPv2z0yYEGTb7Hm0bX74bAa1+CEUsXsjLc7hmsRcDpK5d3ESOa3fq9kw99oy3c1liNylWCpfVk3cY6vIDCugWqdujR8VDcDWHtVWpu5Ejzd/89d4byQhMzaiVFcppPVXdgmElpnm/trIPZP+5TWVGN1K5kIH5VKJy+1YR9z/ME/ZD/cGcNcEK60cMDFJTceH53VbE2nD4/jKx04wwXGOMK+1XQKzYZpClTOQoQs/6HbFdvvDiFk5xtQzbmRASNtJtDlHQAOf+nayu7GsKFZ7JVcZIzgQnNLSkjQ6LIGO0w60DLplCgHa0yQOMVvrxme4rBsShgBc4LCgFUbkto864/Ch/Sma6JLPMYvHRygFB7zEahjNqiCB/Qgr/+6Jbp21XM8sK3O53B8coIEgKo0he5n/b3Vw4PYkQmM4JpelRRyQDeRJqKvH/oAR3IbcoeCwJc2cHb8HdIIjsDQCk5GCF/9vs3nrYUI+6EyTGuYGru5ylKIg3AHdgQjxHC6iErV4j9tl6ol0wInoXIbhWBj5y5YBdxVnNno+KPPqRf5As/114NKdMyiV0RMhVLT7Jo45kfgJsFXY4fnErv80sl7x9TsXF2br8YkZHSi3JyDpx4xhWLwlQcjYVzXcQfu/rH5yKSpx8V99tazMl8Dxzj0Uqfuty61IldCROHM51nAjwTjo+FIQ9DDoPrGXA7lu9HBnPT0Qi9ABuaQRnC4dVnU/Z3sZLGqnTaRuo4Ah7e7BPHghz/71wX6Fin2FWm3aPeXVHa5FE/714RTw4n0uMr9xWPkok3H9rdvQ4RsE07BZePRIkEfGo9HUCStYkDRL0bD8rcX/OS81uFCCBmx3vXSlFd0t59JiqFmRcjs5g3AIGqnYVbrJKIuf3sTtrgvme622epHmxP4r+KylX+U2C/GXSoXmpbXd3WOiV5XzC35cU/dAsH7NIWbmjrtZz8hvI+0gqKPxcTkIlYAPzTlgObsDEMktY2OG65JhMsY18esvnyBk6esyQhct1w6NEpHfFSsi+zNHvqdeaPLSAynJbiM/XZBr8xNL0h24tWa2siWP3DbCSH+nTJ7MZM9cAps5fgbap8RzNcKhhIcp4czuUKkEUga5DtZ25BdW7BqlMNtoMOhZRJT/fqc6FILEpqZLJBiwDNSb5YWpHL5+PJ5IJkrNyrcnFZKSMIm4VDToAdtAdQ6vmIdMYDg+Nb8MBxrAexDb+hWtbJxtrjh2DIqwopzNmlB+ekVb077kTJNAquHG5jyRTov9hNHPQFf2M6O7LSBFvbOHsj7joNSBIhUFytrn0+zoXC9fdVuetrCNd/ablxW53jGuceisdCugGklM5r+i21sfx9JZ68Fisy518NYTBw06Q2i68HwAugPW1o28NFQFHeD3HNSgLsP1+86eHR6tMZ+y+4crFEBJnJ517txlg5XvzJkrUkVX/n3V8xb5SsK0Mf+av/W1Rd0PGL0p/BEy48roX9V2tQ2FlbCQsmqYjBNM/Ig4iiB+p0V3+j8rl9XrkYi6F1kQc02Xd2yVVz1yOlIpsr8dMl61RtyzpvYPk42C2yjE89ufX5d65sCm6ak274ZB8PQX6VO/x67Aug/dLfz90G+jR1/7LfXoBOlGlsPpyIoUcWqTOxAMuE1qTsYyEKyM4zTGg9RwCYU2r1Uk8kSXoXgYj8sAI33zApdLCcPQRwErpeuAs/LoLuS2XfmmF2FjEFpVBAxA7TAlJSUCUGUBBynS/Pw5+HQtMtfiUfLzF+Kw8VH9oX0uobkgx/ZvCuTjvFFV2rE2KMwN5AhbsvNBDDGCDwa1cixCofjECqKd0PPnd7EoTK61Utu3FfnTooEWuwVoDt9PPLTDbJnb7OZ8a9wJAxfQzXZ0K57iQNyYwLCJEyBSZQV0mEOgNs15ah2A2373O4J1K95cgEMI3ETd1I0Wui6XCbyvWuP5mf3SizIxgMTRlj2gcDWaDwDPI950fAIAUbzlwxYLMoMfwg9NoQAiBEVj/dBKJh8CC+BgJ3Z9RqGsjm3yEZEA4m8NPhlDKjUm2IAAHsXS7dMIGM0Iv4aykqpIuUsAy+eqrntAzpujnwHWtVjyZArK3QXlNcvPe1qrzrIqLjeZGthpIjoLGjHX41toAL9PRB1wmZIrpdLP4pB6EWwvGOhQD2iIjc61wAX+cJRINHzeTkK/MhzcnoIsrBKgZjZ09RhkPkvMnFkQP36yG81hSG/m1tSggGZoQSG0jgO8iEjqCLSrFB8QLdPcY55XUQo1uvQBZHOIhC5N+8g4/ioa1o/pR0KLbnNTpWLqGJAHUBs5ufkCUJtAOIQUnzO2RKs5KVJZKk0JpGnYRwg9tAMa2aUDyLj54SyI2bpesYD2oxSfwYBJPq2lFcCYk2ODyYqieY6HQqf2dFwBh9LujBKaQ1/M01nfZZhjDjp3pMe2qEKAy2HDAUKKEIWJYMLzrZkKBSSKYE+PH31EMRVW/HciS4/qAaJUgItjbu0uDuENYKgWAFAq1Vb1kkNqdtRTvs4VjJrm2ARgZPn7IFI1PC//NPnr1zVnaRixg27M7h+c4B4hhvgzFxWYSfZDqgIC8ALx8VHBWWaz5a3Kr8GoIceBEXlncPC7BlmA6Z47+UbvAafTy7f8AThZlDX8cjhmafLb6xNBYHEM2x1G5mlyak+enlncq/1585UyME5/NHxFJAF57rnhY6CnyMEG3fP7jT9cKBy9/qT//qr74M0K8vydzy28C1hF4vuSc6Scw1+0JU8lDg2+gqjPzFn2r4lMIetHMBqWxVTXeG5j3dkpGvX7bfYtHdyVdd9zAE5Yvy08O/vbHc9+pUfwovwkxhauNCZ0OssTsL4vgY8N3N6mO9Ofq+zzDkaPPD/FWrOlVKD6FbZm4bUAKJb4n7p6CmlZBLU6Z0VarCYXj0Yds9oEiZRUPNLw5B8cw/l+jyPhne7/Lgzvnee56neevIgeHjYMKRfgL6yrV/6aLDZ8O9p77o7/3TCKA+bVV9n9A2vIhm/ejAPJtGNKHyEH5cwTUEi0EkgorssUTItHm/+mQqNRRqWxYR52hASjWenumXdH8I0zqXmPQ+tQXKvVSwRYTYbzranVnXfihb2sLBZLg3VY+DGzRz3hsjoipdvWSAycO7NHrp40VcHpTMaRo56t3yWYTXPRSROdhkECjQKEOBf1LDuQGuMXJ/+50rVscw58aMIrOaY7rwIDIeGFZMlDbH+NqoI1X1l98QHyvND2FwF3GL36HDCJ1aFNQIfQj6AFRV/q8YlAz1ZGwsIc3HF4Ji0HsMnKzM6eosOiuVCZ5ly+khl3+s7VfXASXoKHTpCnoc1NUC5ec6jdrQQzhI8H36m5JSpsuaVxXrh29J3dZ4++dgH8G4QZtVwGtzQc0zOPIeeDyyOj1VCCI8BP04en3xmaQMpgQM7Lqw/N8Hk5Ywi4R5avTuFnghcymmRGDVdB27HaIAKRD1eMFAT40/rKu9+92IB3Tb0TsBklSVg+NfT+XQk0Ls/vsZV9kNuLfjlBrqaPIxN5onsPLptU5h8U3teEPPcQZNuFIbLLYM2OuWgcuGbPJoDWUcOX7eGzXLxwwnVwk7Z55rGxCrdb4Z/25OHTdN8PUn4DhlloHgVkd+t98kJnCEknuPWok5k+fU3o3n/bObcehTvxU5DwKbXdn7OXAPs/u0F14+eO1GmwouAwz3b0ecSRNdyQgMDUbhj0aETQsaJj99T2WiWJgiJhTKiroWKIkZ+higJoDTV5HZvhdqpj14kDQ2JKYQDOUEqntpmp79zRa1ghFnNGuD5q1Hp7KqkDmTDPTjme72k+VKAJZ8plZAwxoGHgK9T7qMy2RCyYfJoeYX+jVscLjFMi77VSigXiIAGQfZE832aLlcuWgeZvCUJNkqnTemjTjuQy8UdUBD4QSAZwdXWUNZJMnoj/zf5vkUf6HW70XSyOkm3fLnuy9SETT9HZrPMfravH+XyrIpHcYHhyNTIPFmzvjuxLxNRE9f9gPr+cvCyspFDonFdPv+AHKWMg+D5dIgG6JNiUggqiBOR11mBJnKZJEBDZ4ViX3Ify6H16Ho2vgoGKN8H+gP0ahUJUuF4kBGqI40oxtvsCSDHTJyIIUaa6NZHIVJPDC+YznqWRdnE8Ry9qeTDLab153KuDpzrTzslBsFcIvYbl92ACwVu2mObpEvhejfWua2i+O9Yr8Ra0YcW/2/fhdFkMN+H+jVLR1Z9NpuCFvXiH1bDa8A5rsYI+d5q2jPbJLTproXFrCdLHEQJZsOBfJpIx+xFCJSO4hIHzt9FeO+jMXYM1f+B67dFknOT4Pa7pEFtLKkZQz7q5rvJMdh8jPLpz+tRf5kjA53EZoa7vn/g97W3ebV4CTcbDPrLI9huKNG9f87FbneM4Fv+nryWCoaNHYgHCI+wSGqfbWwCG5F2oIQNJB05cdk6AWR0nBJ1P42L/wQdCqwIzXQ+H48QYSjawBUEQ60VL3LZBISqkgPo+KJZI8CE37rIQrrjQ3D2X6BsWqCW9RetxMJe1D6tREgyGHIvBIEiE/4LKP9uo5Fth0q3D+GEVvp6diByE2LFUjizCoWK7rkViQNjqKPc+vHYa4Mm1SD1TmDwzNU3XrtpZkzBTfM1dzXR0SWjagb0EbQGXIH70n27VFB6x8Ey5MZA0nqvVUbrx4+x5sVeXKmpuvo09+W9aQbH0BekhsGibaiNatjbhGUNYTIgDO9hTop+Do/onCvFwKIjW2R276f0RdAbckqLBTHIgmv1kliU6B0OUKiuRPxfoSClLSBVSC59rToBy2zh8eCEaqx9pxnxaTF2HJmzrqwN4SRYItAdjsC8EOLWeTBu1uhft0Rymff8JVF3KDrecsrtiqds/AqNvc8Af6CIbYMPbZBzkZef5SqUijCDz1Qj01xZMyCBcuWsBH481nImsRtdoM5T5D7AUvmldXWjd5cs4pEujUvsHUSLGHTm8w5Bk/L7cYHYbY9oByw/tnY69QSuGm/Tmj6fsDck78tuiN+gY0cYlI2Ihm2v1hOKEaQktf3uNQrG0ZLmsX2z2VsdlmSUBRO0UlK/BW3taOh5b2bBWTY/ykVkpXiEYq1vIfLR8DeubIMPpQHkz4iGwTC6zIGO1nt0+XrjZkjq9JQJpNYZFKruXtBMSedwbu4eGmeHtnYds7kC6e7VEXWDRKlhqPcUkQd4ezg3dHFr1/4zrOAPeEHHMU1AMtKjSXfRsIYed55yY0Nr3fVNgnCtPf44Puyo68Hx5wXE5ZCioZRdinHgIEqW+zo+j2kmZGhAtM6SfR+p6d7MZ/JRSxZ1wugKnGnHS2W3ZksWwIhEHv5v1Vs4rkcteP+VeaVjgNzr8oLGyWALW5svol39KdjyOShWBfFoik43uUmuSovejUne62X3Xfmlv4xCpq6d6S+93gNNZxdu7P98nkBpjigSPN8jaaehoQWXz/hGPL00tG6qX0aAIS5M7J3Cv3OhU4w5Ocxnm0ZvqLXO5FpVZ1X/LOE7tMZhVkSwPFd6eaJ60JY5Td0mln0gDi2AR03n9vx6ReLs+NdMYl+wL99EXFyvsAWyddC6X0rZh9gkbotvvNxss/IMg7Ft5PKYo9hZPIUzkew2oUZB0TYLoZ6iJyFZRaFEqRErgjTArl7rdoKb3y3f7hFpkM+Tu+GH2qb297KzaW2H5sJiU9VkTHYjbUqnDbaFdAZW5tV8mcpPJW4AwjqM+UoUJOrKemxaEppbKoknZjwkgwTpwNCdnWG0q6W/qgMQClF4kxcMfCkA2+LLSppFShOGE6f9C26FyXuhLOMZZ/SDh8rGxvlwsDCORa6TfekZzfVb84R3e/fhyA9YRthpi8wWRgTcq5AzhSYxVMCFoKcvOK2HwMQNFowQWE5zTttXRFGo4UdXbdAyKkuNJwQGD8TDM5tClekN2kfTLBteQDNBsoDW97WS5qZQFYhCmRHw+ZczQWJzBpMl0tok+xNbo7IRZ/9PKj6bBH0GW7WmZ5SvMpEgaSCsRS7bYKTP8q4YG/qqmJhW0BVZdyALB2bOxatPP4GzJ/UKJMADY7+XFcGzECyC2CDmjJIUQ6nkvcGXY2YMFMI/puHa7paJvG9JzjbLk7bp+eEGlzO4Jz1OefMRPhjang2i+AL4suxekfMvYGAmA5fsRRulWgTx5wkwUFTORjsWwMGI/yXE8ny2wbL6Spm4bbm30BE9X0BLeAxmpuEJla5LNyYOi9MIZmC4FRQsilwRlC5MDxEn0Rnrd6QzGEDxG/ggaF3hjfQxBc1wzp9yTHA1BH8vSa1KGHKAH/XHnsswD29oGvm+wWLKoAO/YQMAFmtP1oZtiJ896TgWMtlDo0+wbNHW+jX6Mv1CynwWz8+RYkyy4c5JSWVt7y94BCwP6sEiYABOYuobWKqG+ZWqaEIdjY1vMvpHMoXzhD5P2SCzmc5L0CfeBVm+IrmR9f8mEwsHCkH6ogNINhc61XLhwu46dZDZXCnFqk1UyyPI3BF0WJVPW3gGrwzfC3iFt1yCOz/FurQW3DmLJDSTIGNxumxtBI+MOslatnjlRefu2ycTsYZdyQsGnQcI/N9eou0CDMu31eGH7YY18gdQVXg4FPVa3hzSoEeLjjDKj1e5lh7khMwp8vnlsTLQJ48vpbmGwHDfglu9bQz0sJ4wXuj/6hxJyFmYm7Z/y47dK6J5QwJ6Etql9QV/7vWZVWyJn56e6nUohgkZMd2eg5kutkbhkFOiT6I2MokLOancUFskTXa+iI5Xi+1l6TgIhu13CxB3OLgmJZzcnEHLCKHriLcPh7E+bwEiQLKfFUl9/QXX2bY+HZY+RZoGxIFkPeP5EZaeG4Gl4ygjefWSJGiGW4rhCQDA5hzvWidampmQmLfZiXNcmULf7x4UJTmUSxu4ih+yNg7HcPzbWL3e4TJZjODaTxsKsxsk/sTMZriBH6e+N44ycl9HPhKa6LUxF1sOgeYzFsE0uHOuCqCVCoBKR8ud0wWJCGA6HchWnrenk5F5dd5coCOUsIWhyZ8SWHfiT6L10Q2OaoZtaViCUKmFIBQIeYuq6qmwUKEivV4novgxFROilUj51VOJ0LgmkqmpfaOdtXWpv5yU/e9LjmVoUpcwESkZUJGVzKBUwqpnJuWRew0Td76PWCZgjwGf05mExl4P+D9FZKQpFPJtsKvIYjIStK/trdSk4/myo0CUaskxOWg+2+OQuV7gxYGSQXdFovDTPbMMLklxO0oy+ADNLy6MOWCpVNwkfKR3QW5BWTLXR6JgooVOJok6xTQFL0TIytV7BBpxFxaUevZDP6eEmZZ7CkwomfT8t12B1hPZQ2QkuoHSe13eGhLJn77ldGTFrRxNJcpQw9h5Dcs8uKUjfZ89EHdX+shi8RP3G5co++MTRE1vAgAwMwGVbUlB5WUdlXpwW7W9gK/jDhQyyBY5G6T4G6vkrw2Fr7aK6uhAS3i02kVUJBZd+fN8Cf6WQKhOMMaJRmWVgjMgpoVmcx7KKqOAHEkEqGckAzenPKSpz+54OZbUMZmTM3mzHgu1EkjndYNR0wIRUTZZkBEGIRFUHLAd4PjFGHc61pHte3jmrhb5WHQMALZxklXBgobPKdgJG4tzBWtFe6ON0yZRwUNHARpxZAarMf7wB0JL0AWngtRn95cd29r9x+uljZadDJygBt6Inxj/OxhnJDfgPyQKckizHAck1uFWyAvskN+MRyUU8drHeLw4fk1yGD0kuv7BHeXD0ovxFthgLL9176+Tunn8cTLv0XxDuzCjjgBeDJYkJu9nwD5HDAKU3ERsVf83dS9/g1q87/YqeAAxqcPziQ2rYaHFRTXeCW+JXgcdxPTlQlIKNeFaYS/x4gAJ2wlc52R8jaZJ9Uu5pHR9vqtVHE5cHLEQb3rdAH//fi92VEyCU9qOZbVRgQHqIE2F9zJOgiqp1ztoG+6m79W0jRwKqwDWvr3A69UoNiQFPMLN2V+qdV69WdycdOkGLWdLuD/EtLCJA+os0ShBY4J8264fWCXC0n8Vy7HVg4kHB2ruXV0PGJzPNtaumJmmai24uiXLgTeFSmRGUbd084x4DSqAocdPJAZruwjVLY3kxpqXAynonbblNT7WwqPTi5wyHDwe6fL54eXPrbP4gTIdt6M039UV7izYdWAzIYuQqrzfXHFA3U4/1Bi41qvwwlDSWHdImHR/4fmTb4QXHVrEcVLh+BaA6Qu5YOn70UO5qze81tMyoil6BCSEOwvGv+YGr1JVlgB8F7McCWaDeGsbp/LExw1+IhOLI+bGhDx0tGTIc8hBK6x1rxi5IzPYxwQXg6NuUuzyscl2Ezv8HunDOGrzgrVrcw1dQ90dsJgLoMAfdv6vCsnpuNaUN5VKpzh2JmIXjtO31KdhpICTZqG7aRnnRD/vbcPx3ygPZhgJTqaSSL/aPYvzzD0zwiozbvS2r3oLzb9zkdg844mColtuEwogdYtzfdIJyAeSMmmoHf+Zo14LyzFuYVYWW4HPV1Gns9uChiA01IiYQ1MfmoKoiUm1r0wVZ5Tzd/c4REOgYeP5id2H1sPOs3IS6rUHXv6N4jWrEUD2PhBADwQ4jjB2IOEGSJkxI0Gl1OoUAVwtI7gqAdiqUvloCHTL0+EmT5Hi/nmwxIrzkoPA93ymriz9PdPUC9odCTRKZ7+tvaDgKvWA2O1dWNuQMveCFHF8pAmSgpqg+6LtjHNQqdqS8s1kYmf9M93Xhv3AYLLgQzLOQSaf5zxCrZQSpKmHxaRGgr7Exd9r4B7JMGUw9ZBx/22IKml/79MRTI771rH1xVKrNosWHu97744i/+aYf00oFT75ZLv30zEubXlcvzJhzDs/PbhiHw2CQWxgQQhGmkwmO+lGOMlHmHIZCiJXjMqEGnrs4QHDCgPDMvEU+YuPkTdHjOWpuNCHfmedYJSDPX/yMRXqQwLBDCJ6wbtzKVccpHhJCjam6deOOrTyy+FE0dXVTmIh5q/t7hCeTvvshx0qC8G20YrGSv/fwFDcNhAfQ7JPp2SYjjoPI322h7PnqoegkQALKfGRjNThuKa9Z7AYBWzU6fKz7/n8a6MlBDuf6KY/TIZJzgK2mJkaJ0Xg16jtozE6PYmi3Ylgt3ERAvSGKm1L5bDXs/AfAIr/SKoNwslR1ZGiUq2kZ6pCxJ8Dy1GAtS/B2UOhGIJ8zyY0egOyQgpecmsEVHYSv4h+HtuQLW2C3z0UPzy6z9NYlgtptkU1bjyPUni4eKZpobuBeYJpgNgKDwO25ot2DsXsx18HbtySt7FrY764HtzaklAhsrvdgGLj/EKRMqeYPHVwNCaFVJW6P2liIvQX6yCcPobk89JMQ96eKg8AUh02hMJnmQEwukE8tT4vcH4LZHBylUvT2VyUS+pziEi5DmAnrtrqT1em9CucdKWxWgw9awxO0IJjxkGCEaT/GNCMk8GAGoZ52fit69IGwJp5EKCnsRIqAPaBIiBGlnWGq1zwHbVutLDDEq6pAjxauWICLNJfkcDlBDqNCS5w90vrTDq5WWjmc6+9hY1h1x087HgZRJoUdrmnjcAMSOR7ffWDCCH6mpB21c/YNDEM8WKra5fkfp2fR5dmKcrFZPb66Om3dYSJczDxMsCwwqjwHVWVr1bdGeyE5pnt61V0EzZ1TpPBigJenAkOAHBl4jYvbpmma+1Qzo50oMaTwwREgRUI8iupCQeYGyGGWKEFU4Mj1YzIFirP8aYI/9fsEpeQfJZBDoMBJnCizfV5i0P0ZCK2Hv2/5PLptKAboQO+k3lr/e0yf5Y3w1oKwgOyN6hOBZiNgpNO5LvCFtpc9cMCRysUJlNdpBNKR9xvWlrySZIX+nzDwa6rgeheARGB6OFYciEOcMXfbwouGlENuZ6M8eSSpp5Dp2wrj7Jccs/yZ3r64pvjCLASRMab0GiH72BkEbHVfqjwabQMxCZDPL3xwW7Diypnoo4dxNoSTHmqigg5P0WffcPi0XCi4jlRmmg/Yt1jqaEnHWzyR4AYWZOGZSOg9jxWRKMFkxSn0D7kWsFPw1i6beTD3/IAmMH7efzcFSWNggvcIfZp792A4TKEWDRq9kCWBI1oiRbFKwFNJkEqqGhA2qT+zHu7gNSezmuH1kNuL5/P596QlQXUmNbOsdtaMIyXMkuEcYZiUSrmtxlB9tCUiOnoDZWciEAIWyKH47e2+SFn/pY5kdjZuUpoI76gBWXJCoCR0StmODnDl5x1lsuU5tO5ED0Y0QQVP2kE/nJimmZFgUTMno7IIUh5TG8HrSOlDlhP9g6xdvODJm9PHQ3FOV7dRaKyLF7suQmNdbIzzvv/YNbAF7QobWPb6+gu4JMgqF6zItZaFYkNJgmg3Wsi51to+Tc4PoyQkKLRfuK0oEMYLN1Rsf3S7mQC2OQ/u/q8KvcdqACjokcnFRMJ0LWibMzuP6R0sktSv9wg/BiH8yLUzjWMbjor9PPMnAjT+FbQm8GPry9Lt2mgfY8dhOzxppyo75ZSe+ujx2ozmkw4xRLW446LukGahat3zFDkK5Dn/CcvC0ItO41dieqSeWIxfkLm4sjMfA5LuuMgW+evUBaGfB8CChkSidYUjeuRy6rb6ZNCxKUQQ9YquL9RKzz3bdChHccY4fTpMi03M+nw7s+vtKlGP1esdguTEKbCh8WVRJoIomGBCCdz6/D53Cv1DjtEJkUm02xmabnjjyOHOo2lJMyQAfiEdCrcRoXRNAhlaNNNaZMMLNd5o9a2TgrRk/dyspCsQK5E/qAp+JGKg53iQuAJ9Rk1gXv2wGC3kCVUQnyLgyAmIjR2pEqsKJxS9tPu2io9dzbF1KRI5RRtPUgKBRcR3AVAqY1rKNK/OP4jWzrvv570nK++KrLpPii3crLaFZl9mt/s07cv4Zxb165dRIrl3T7ivkT+RQ9rwtFYd1YRQa3SnfhFWAbqTQ99UD4fR3irqtr5UHtuymzpJmS+Gjne2F0bhieSJ/Z6c/FlFCoRmidbrKZ+Cw4K6reWkJbn9U7NI+6KtcgsGNk1N34IkM6ZUbW3X0Vmj4IYw8A8PzqhJCTARs3WGxGHWvbzXnVag4bpv8Xff3nyyTS6AxQtU8Jj0rPNnFbfvszz93v/9jWl5BCXu/NmcG/zI8ZZb7l4DOXn87kOhvwAEaPz/u5MIHz4V//uU4gDw6xu/uFvv/4kZ1nWX/wGeAioCAlo/QKO+whsb18DqccDtu5AyMpqI6xkwLKR+a9zX54RNRFXjtCzvTVXPqLYPJR46/Clr8c+q3GWLay6gK2uITWBqDeiJy9In3NfqJQ0SVY2N0Dh50FMbWS/UNbL4qd0nDYdUyQQXgkaocYPUhgBzXuC/qDKXYYJ2nLB5yqjnfS31YhiyXu5mENs44Xto+1xxo9JC5+crOUaV3yjWdyyCT7ik2GdIV61Bxa4xAtpWMmER0WtEumGdxtJD1u8rDvkly1GtUGrtxIpT8NRa8llHLBxvqmm285P/R6feu7BaQ7F62NoWY+kjf6+qWCmSczmtCCCyIqnFP/N+iXuvCz6hifkp7i3F4lWyqWGf8tZgofpTSnSsZazWHZIHHvUGhayKMqt9ZH+7Zu0QKLOtymm/y2r15rS3sh5dQ5htN7yCf2A3rIKzsAeqtb0It+PYQmpaWg/jISUeqd1ptsh2+hBWKblcgovwAKpqr7Xa1T2Zk4HWx82yBdAyw0YWFpqSJa1cZNP88o0nMAteN62ueQpv9urJsiya0bCb7easzPIxt+X7mMTZ5ce36eoXhQ2AKdDmBMzTyIpKVNOHGmqygVDS9KbMfC/eNr82CYUuR1AynpcVRvzTZVctlkRTRBuV1BQxUFTCF3gN1wIb4M7FUebe28vqBvVzIpsVrBz8M8f/eUkTpvJ2QmQdpK0OAfW1STkhplaY1TYkt2ZZpcjc2iildliQxh2mdplUDppQforKO0BS9RJX/pJa7cvgm0KqLUyq9pZzs6o6kH/AplywkaYxNcq5xOeHE+MtE8b8shNHSJq80lI0yqF3t2Qlq9KdjWYHr+uYB+VdLoveAVB4EAS+u+yvc0VWQQK+6cz1btTkWXWLJulYQa1lzwf4wNoG8AjZzlwSwJdVxxh42+Zhw4djFOtNqtyOMMsDtwIXApsC5wOPAd9tkUrSCukhqzqlDcCv3UG0Dx/Tls2y2xlsqxWZfLH+3zv1E54QlBFiicRioFusmpkVY88jmhDA3VH0zUiUTc2ENJnNFI+Km2nmOZoZ3nqbWeaeq9IIlw9ABImDaHbH2dnsQSGneTiR9DGeMRPodeZc3KwmE9s8Aiey2ZucptmHiHfzSKas1FE4jZs1JETgtzdwrOWWmS3ZeKlzuqUWmWs4tRSpJnehhWJNK01duSzz+Dd1dpBbIkjmVl2ptL/lWpWk1amZjcssMiEcktQ0Uyfa9RZYKDV09DIdZeE6J9l08xB6k6tvih/5cleXW26eZPPr+mSpkkML9cdHdQt6VlpgvD1IbqVhIlvnAmmiZYtFq84fLQrNV1Jz4zFyw422QGpqOuZNcujxMVedwyiu5SjNoblIU4XfF3Z0bLMx2icWkNTGVVYm3ankydnpTZkVdd40SVAjenq5xS4217PTT1quYstTm1RJlbcwhi+UZg43c4sfc/dUl91Rd0WYT3NG3F7b7AMFDqmMAMLeHJVOq3XL3KvoSUJhf4/AIRgcJRnkFANU6s1Toy45KL5on25w5nLZPklD+/1wdScl/nPbvym9XJ8KhnFLmoz7RfwkeXSnGW7+lfzsW83TAr/a4b677mXDxfz012fImAkVnOGVjdqIMcm7j9LCuo3U6IGHFibiqn4SRjVvhO9vUsWKG13CGJ/8FW6YsOHC+6GiiAItssTSkCwOOYpky5TkiWiCQtcq2HI6IWEI9aMVUqwMM1bsOMYLCzeeCUmOb6JHMiKQJlX6BbikhONscekm//UFkiL6zUyRGekFhN3nkdZY64gsq6xObnnJy/ebqSkQZVoKU4hOUcW2mh5lJWLk5rvU1smWk0sASprRrxXb8+J2Id6fPl/iT1JCnwU/sC8+Ethgt40hGFIwYszko9u2LXrp70JQkvSxovo/1r+nTpP2A+FeveEiAHpUrtzXASAaWuKf9v+voqnmWmotQYh2jK2jxCTG0kg0i117S5UuU1vtdWD9Q26m98aROeuczemsq+56VDtPhFHldzdcT2999Bk4xbJ/WLnmokt+cZI1G0pSbdpd8LPZf1OuvwSONNre9rVfKX9+9HJPnnwF1jukOGON22JTJjrYpL8z1d8JVjS8WPESJUuVvhQh+tfz+utcjOKkLw1ZTq5U+304QGaJwiUk0yiruqHpd6QQJVlRNd0wLdtxPVw8fAJCImISUjJyOEXIciIVgpqGlo6egZGJmYWVjZ2Dk4ubR5b0j1it6nZn1/C4NmlWlPq4rFRpgGxhiTJG2ToeetRToto5LEMpQUbJYhu1QBXkXKpSdZQSEmR/RAmeHcyy6+GzH7Duei5gqY04vSMCLwdWxwxW6ZEt8zVr2RIeOZJ+M/I2QspSedYkrHIjTS20Mc9/Zum/2S/r/az9B1EC3vsvrsCHOkOilYNPYxz+dAQUFcgDLepcwFIbS2KxjTw/oARf/u/qU29pi092v3Sm36A67m9dCOkeiR7CCHwr6u6wgorKOwrwveco6yrDnTCs96L0Q/15gnRCAfu6lhK1KtbGonWUAWmLAzNTw+Z8QFnXgfCTj93EJqX4WaAy+TPxo2VnD2A5NJ5tVQ8iGKzPFJT2MGy7xOKuK98e+QkU7CZosEfMKs9LDo6joiKfaq0V+11mKS5VgUsq93xMa+B8rM0zO7JKSlUsw50wuB5hpMgnSHD79z7Gj9SBXcJ/n8Xl4R+gsjePD+dA5Sh0XX5LqOdFrBNzykr25oI+G2WPchpln6zNeuNs85GU2tX7ogvvLe26DiGqXUwtD/L5ysTXwYYyERUuShF8tmv0OGg0zZhJRIZRdLfoD78W+zPuDWvU7ppRoz5cDRsLcxAJYeNGA7ZJNOQfd3bdzBbFIkdjS6glx7Sap15IWRI0+ijJyWZ5fHFWZm1vfBW8l9fGnAYfWZ70T7L037Det+ZSkdwH1fGh1zek5KETbdPitrJgFXYnB9+Yj3f1KppB+xqqoyH4OfM98WgNxtfg+6SoHH0+yhxwFRyrtNaOIxSLKTqY9/iQItH6xWI6hbXV949G7kPeWZt5+1bZ5icZH6rHSqmsfV1E7va8k7dxF3gQUM+jxqWeR8OQ+j5FIorFNAzpGpjkw16dgLVZOtft1/642TsNu/IYrtyLWz4MluTBFgCFcOVe5DgwRYQB7FzY5RIGjBMH6J55AK31xR9AgubfJqjAvQMwaD86bAFQCDNoHAAE7BQwAAAHAKB7AFrAH0CCCjwFDXKPTf1x496Mcbg/P+OUuMeTyIvT2YPyKw1eCGLlyBnCVH5qt97tGqQHRJ55RSOfKMO7VImG6ER4ueib7o9ZHGjvqzD9T9csjVo2Lkq3nMBzHnA7Zq3g6XGTV9Rt2UT9cteBDg1Exj0MUseiifsaVhyzapLUtR+MBh6WGMsmmkKQPOabYbXOv7G6fPSyW9PFtmKlTFhTPkX/qXBm7aJu7LrW6Bn7XuRk8sT2p8B7smynMe6xr/vZRM4Rn8+lZ/EqqvCkob7UmTeIl+TYTmK7Co5HYTfuDeFZ6+DP9utwr7Pqm1jGfsKzl6vam0jBjqqhxjrz5lD+Z7+wyeNjCwAA";

  window.TokenWidgets = {
    PALETTE, LINE, AVG_LINE, YEAR, WEEKS, FETCH_DAYS, VIEW_H, MIN_STEP,
    compact, longDay, scale, rolling, niceAxis, geometry, yearWeeks, totalLine, yearStart, fetchDays,
    useStart, pictureStart, MIN_SILENCE, MIN_SHOWN, GAP_DAYS, MARK_AFTER, seriesOf, spreadOf,
    fullness, calmOf, FULL_DAYS, FULL_EVEN, screenMarks, pictureMarks,
    SHAPES, SHAPE_OF, PIC_SCALE, DICE, LOOK_NAMES, SHOW_NAMES, LOOK, lookOf, paintLook, pictureCanvas,
    pictureName, pictureCount, PICTURES_KEY, picture, overlay, nextLook, sharePicture, ROLL_MS, SHOT_TITLES,
    SHOT_GLIDE_MS, SHOT_GLIDE_EASE, SHOT_STILL_MS, SHOT_COVER_MS, SHOT_COVER_EASE,
    heatmapModel, heatmapSvg, heatPin, heatTip, drawHeatmap,
    lineModel, lineSvg, linePin, lineTip, drawLine,
    viewHtml, seat, panel, limitRows, ago, limits, LIMIT_FILL, LIMIT_TRACK, LIMITS_KEY, TOKENS_KEY,
  };
})();
