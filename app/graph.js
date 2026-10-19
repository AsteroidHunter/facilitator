/* The links between cards, drawn: a graph and a timeline of one reading.
   Agents link related cards (POST /link), and GET /links/all hands over every
   link and every card at either end of one, each card with its properties.
   The Mac board's bar opens this on a sheet over the board (LinkGraph.open),
   in two views of that reading:
   - the graph: a dot for each card and a line for each link, laid out by
     d3-force (graph-force.js), the physics Obsidian's graph view uses. Global
     is every linked card; local is one card and the cards within one to three
     links of it. Dots take their lane's colour or their section's; a pointer
     over a card lights it and its neighbours and fades the rest; a click opens
     the card on the board, and Option and a click makes it the local graph's
     centre
   - the timeline: time runs across and each card is a row, its line running
     from when it was made to when it last changed; each link is an arc between
     the two cards' rows at the moment it was made (the TimeArcs layout)
   One slider at the foot replays the links one at a time in the order they
   were made, in either view. LinkGraph.logic is the part with no page in it,
   and the tests load the file for it alone */
(function (root) {
"use strict";

// ---- the logic ----------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SECTIONS = ["doing", "docked", "deferred", "done"];
const SECTION_NAMES = { doing: "Doing", docked: "Docked", deferred: "Deferred", done: "Done" };
// card-tokens.css's own colours: the ink, the sub ink and the paper, and the
// green, rust, ochre and slate the board's tags wear. the lanes take those four
// first and four more of the same weight after them; nothing here is --accent
const INK = "#211D17", SUB = "#75695A", PAPER = "#F5F4F1";
const LANE_COLOURS = ["#2F6B3C", "#A8442A", "#8A6D1F", "#5A6473", "#2D6E73", "#7A5838", "#66762B", "#3C5A88"];
const SECTION_COLOURS = { doing: INK, docked: "#8A6D1F", deferred: "#5A6473", done: "#2F6B3C" };
const HOUR = 3600, DAY = 86400;

const isTime = t => typeof t === "number" && isFinite(t) && t > 0;
// the number the board shows a card by: m12 is 12, and a seed card's id is its own
const number = id => { const m = /^m(\d+)$/.exec(id); return m ? m[1] : id; };
const idNumber = id => { const m = /^m(\d+)$/.exec(id); return m ? +m[1] : -1; };
const idOrder = (a, b) => (idNumber(a) - idNumber(b)) || (a < b ? -1 : a > b ? 1 : 0);

function mix(a, b, t){
  const p = x => [1, 3, 5].map(i => parseInt(x.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
// a lane past the palette's end takes a palette colour lifted toward the paper,
// a step further each time round, so no two lanes on one board share a colour
function laneColour(i){
  const base = LANE_COLOURS[i % LANE_COLOURS.length];
  const round = Math.floor(i / LANE_COLOURS.length);
  return round ? mix(base, PAPER, Math.min(0.6, 0.28 * round)) : base;
}

// the reading as the views use it. answer is /links/all's; lanes is the board's
// own [{id, name}] in its tab order, so the colours and names follow the bar.
// a card keeps its fields, plus how many links leave it (out) and reach it
// (in), and its first link: the time and the place in order (step) of the
// oldest link at either end of it. a link keeps its own, plus its step (1 for
// the oldest), whether the reverse link is there too (mutual), and at, the
// time it is drawn at: its own, or for a link with no good time, the later of
// its two cards' made times
function model(answer, lanes){
  const nodes = [], byId = new Map();
  for (const c of (answer && answer.cards) || []){
    if (!c || typeof c.id !== "string" || byId.has(c.id)) continue;
    const n = { id: c.id, title: typeof c.title === "string" ? c.title : "",
      owner: typeof c.owner === "string" && c.owner ? c.owner : "facilitator",
      section: SECTIONS.includes(c.section) ? c.section : "doing",
      made: isTime(c.made) ? c.made : null, changed: isTime(c.changed) ? c.changed : null,
      branch: (c.branch && c.branch.value) || "", status: (c.status && c.status.value) || "",
      out: 0, in: 0, degree: 0, first: null, firstStep: Infinity };
    nodes.push(n);
    byId.set(n.id, n);
  }
  const edges = [], seen = new Set();
  for (const l of (answer && answer.links) || []){
    if (!l || !byId.has(l.from) || !byId.has(l.to) || l.from === l.to) continue;
    const key = l.from + " " + l.to;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: l.from, to: l.to, ts: isTime(l.ts) ? l.ts : null,
      agent: typeof l.agent === "string" ? l.agent : "", step: edges.length + 1, mutual: false, at: null });
  }
  const adj = new Map(nodes.map(n => [n.id, new Set()]));
  for (const e of edges){
    e.mutual = seen.has(e.to + " " + e.from);
    const a = byId.get(e.from), b = byId.get(e.to);
    a.out++; b.in++; a.degree++; b.degree++;
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
    for (const n of [a, b]) if (e.step < n.firstStep){ n.firstStep = e.step; n.first = e.ts; }
    e.at = e.ts != null ? e.ts : (Math.max(a.made || 0, b.made || 0) || null);
  }
  const names = new Map(), order = [];
  for (const l of Array.isArray(lanes) ? lanes : [])
    if (l && typeof l.id === "string" && !names.has(l.id)) names.set(l.id, l.name || l.id);
  const present = new Set(nodes.map(n => n.owner));
  for (const id of names.keys()) if (present.has(id)) order.push(id);
  for (const n of nodes) if (!order.includes(n.owner)) order.push(n.owner);
  const laneList = order.map((id, i) => ({ id, name: names.get(id) || id, colour: laneColour(i) }));
  return { nodes, edges, byId, adj, lanes: laneList, laneOf: new Map(laneList.map(l => [l.id, l])),
    now: isTime(answer && answer.now) ? answer.now : null };
}

// the cards within depth links of one, either way, the card itself included
function neighbours(m, id, depth){
  const out = new Set();
  if (!m.byId.has(id)) return out;
  out.add(id);
  let ring = [id];
  for (let d = 0; d < depth && ring.length; d++){
    const next = [];
    for (const at of ring) for (const n of m.adj.get(at)) if (!out.has(n)){ out.add(n); next.push(n); }
    ring = next;
  }
  return out;
}

// the links among a set of cards (every card for none), oldest first
function within(m, ids){
  return ids ? m.edges.filter(e => ids.has(e.from) && ids.has(e.to)) : m.edges.slice();
}

// what a replay step shows of a list of links in order: the first step of them,
// and the cards they touch. step past the end is all of them
function upTo(edges, step){
  const shown = edges.slice(0, Math.max(0, step));
  const ids = new Set();
  for (const e of shown){ ids.add(e.from); ids.add(e.to); }
  return { edges: shown, ids, last: shown.length ? shown[shown.length - 1] : null };
}

function colourOf(node, by, m){
  if (by === "section") return SECTION_COLOURS[node.section] || INK;
  const lane = m.laneOf.get(node.owner);
  return lane ? lane.colour : SUB;
}

// a dot's radius at zoom 1 from how many links it has, as Obsidian sizes its
// notes: the square root, so a hub stands out without swallowing its ring
const radius = degree => Math.min(14, 3.2 + 1.7 * Math.sqrt(Math.max(0, degree)));

// the timeline of a set of cards (every card for none): the rows, oldest made
// first (a card with no made time at its first link, and by number after
// that), each link's two rows, and the span of time to draw, padded a little
// at each end and never under an hour across
function timeline(m, ids){
  const rows = m.nodes.filter(n => !ids || ids.has(n.id));
  const key = n => (n.made != null ? n.made : n.first != null ? n.first : Number.MAX_VALUE);
  rows.sort((a, b) => (key(a) - key(b)) || idOrder(a.id, b.id));
  const index = new Map(rows.map((n, i) => [n.id, i]));
  const arcs = m.edges.filter(e => index.has(e.from) && index.has(e.to))
    .map(e => ({ edge: e, a: index.get(e.from), b: index.get(e.to) }));
  let t0 = Infinity, t1 = -Infinity;
  for (const n of rows) for (const t of [n.made, n.changed]) if (t != null){ t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
  for (const { edge } of arcs) if (edge.at != null){ t0 = Math.min(t0, edge.at); t1 = Math.max(t1, edge.at); }
  if (!isFinite(t0)){ t1 = m.now || DAY; t0 = t1 - DAY; }
  if (t1 - t0 < HOUR){ const mid = (t0 + t1) / 2; t0 = mid - HOUR / 2; t1 = mid + HOUR / 2; }
  const pad = (t1 - t0) * 0.03;
  return { rows, index, arcs, t0: t0 - pad, t1: t1 + pad };
}

// the axis's marks between two times across px pixels, about gap pixels apart
// at the least: hours, days, weeks (from a Monday), months or years, each on
// its own boundary in the board's local time. major marks start a day (for
// hours), a month (for days and weeks) or a year (for months)
const TICK_STEPS = [[HOUR, "h", 1], [3 * HOUR, "h", 3], [6 * HOUR, "h", 6], [12 * HOUR, "h", 12],
  [DAY, "d", 1], [2 * DAY, "d", 2], [7 * DAY, "w", 7], [14 * DAY, "w", 14],
  [30 * DAY, "m", 1], [91 * DAY, "m", 3], [365 * DAY, "y", 1]];
function ticks(t0, t1, px, gap = 84){
  const per = (t1 - t0) / Math.max(1, px);
  // past a year a mark, as many years a mark as keep them apart
  const years = Math.max(1, Math.ceil(gap * per / (365 * DAY)));
  const [step, unit, n] = TICK_STEPS.find(([s]) => s / per >= gap) || [years * 365 * DAY, "y", years];
  const d = new Date(t0 * 1000);
  d.setMinutes(0, 0, 0);
  if (unit === "h") d.setHours(d.getHours() - d.getHours() % n);
  else {
    d.setHours(0);
    if (unit === "w") d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    if (unit === "m"){ d.setDate(1); d.setMonth(d.getMonth() - d.getMonth() % n); }
    if (unit === "y"){ d.setDate(1); d.setMonth(0); d.setFullYear(d.getFullYear() - d.getFullYear() % n); }
  }
  const out = [];
  for (let guard = 0; guard < 1000; guard++){
    const t = d.getTime() / 1000;
    if (t > t1) break;
    if (t >= t0){
      const midnight = d.getHours() === 0;
      const major = unit === "h" ? midnight : unit === "d" || unit === "w" ? d.getDate() <= n : unit === "m" ? d.getMonth() === 0 : true;
      const label = unit === "h" ? (midnight ? dayName(d) : hourName(d))
        : unit === "m" ? (d.getMonth() === 0 ? MONTHS[0] + " " + d.getFullYear() : MONTHS[d.getMonth()])
        : unit === "y" ? String(d.getFullYear()) : dayName(d);
      out.push({ t, label, major });
    }
    if (unit === "h") d.setHours(d.getHours() + n);
    else if (unit === "d" || unit === "w") d.setDate(d.getDate() + n);
    else if (unit === "m") d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
  }
  return { step, unit, ticks: out };
}
const dayName = d => MONTHS[d.getMonth()] + " " + d.getDate();
const hourName = d => (d.getHours() % 12 || 12) + " " + (d.getHours() < 12 ? "am" : "pm");

// the find box: every word typed is somewhere in the card's title, its number
// or its lane's name, in any case
function matches(node, text, laneName){
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = (node.title + " " + node.id + " " + number(node.id) + " " + (laneName || node.owner)).toLowerCase();
  return words.every(w => hay.includes(w));
}

// a time as the sheet writes it: "Oct 3, 2:20 pm", with the year when it is
// not now's year
function when(ts, now){
  if (!isTime(ts)) return "an unknown time";
  const d = new Date(ts * 1000);
  const year = isTime(now) && new Date(now * 1000).getFullYear() !== d.getFullYear() ? " " + d.getFullYear() : "";
  return dayName(d) + year + ", " + (d.getHours() % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0") +
    " " + (d.getHours() < 12 ? "am" : "pm");
}
function day(ts, now){
  if (!isTime(ts)) return "an unknown day";
  const d = new Date(ts * 1000);
  return dayName(d) + (isTime(now) && new Date(now * 1000).getFullYear() !== d.getFullYear() ? " " + d.getFullYear() : "");
}

const logic = { model, neighbours, within, upTo, colourOf, radius, timeline, ticks, matches, when, day,
  number, laneColour, SECTIONS, SECTION_NAMES, SECTION_COLOURS, LANE_COLOURS };

// ---- the sheet ----------------------------------------------------------------
// everything below needs a page. the sheet is made once, on the first open, and
// kept; each open reads the links afresh
const KEEP = "linkgraph";   // the reader's choices: view, scope, depth, colour
// the timeline's title column, rows and axis, and the band at its foot the
// legend stands in, so the legend never covers a row. a row is ROW_H tall, or
// down to ROW_MIN while that brings every row into view
const LABEL_W = 300, ROW_H = 26, ROW_MIN = 19, AXIS_H = 34, LEGEND_H = 54;
const TIP_GAP = 14;
const WAYPOINTS = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.586 5.414-5.172 5.172"/>' +
  '<path d="m18.586 13.414-5.172 5.172"/><path d="M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/>' +
  '<circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/></svg>';
const PLAY = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.8v8.4L10.2 6z" fill="currentColor"/></svg>';
const PAUSE = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.8 1.8h2.2v8.4H2.8zM7 1.8h2.2v8.4H7z" fill="currentColor"/></svg>';
const FIT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>' +
  '<path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const S = {
  built: false, open: false, opts: {}, ui: null, m: null, error: "",
  view: "graph", scope: "global", depth: 1, colour: "lane", find: "", hidden: new Set(),
  focus: null, ids: null, edges: [], step: 0, shown: null, hits: null,
  play: 0, pulse: { step: 0, at: 0 },
  hover: null, hoverArc: null, lit: null, mix: 0, press: null, frame: 0,
  sim: null, tf: { k: 1, x: 0, y: 0 }, moved: false, pos: new Map(), labelW: new Map(),
  tl: null, tv: null, scroll: 0,
  back: null, reduce: false,
};

function readChoices(){
  try {
    const kept = JSON.parse((S.opts.store || localStorage).getItem(KEEP) || "{}");
    if (["graph", "timeline"].includes(kept.view)) S.view = kept.view;
    if (["global", "local"].includes(kept.scope)) S.scope = kept.scope;
    if ([1, 2, 3].includes(kept.depth)) S.depth = kept.depth;
    if (["lane", "section"].includes(kept.colour)) S.colour = kept.colour;
  } catch (err) {}
}
function keepChoices(){
  try { (S.opts.store || localStorage).setItem(KEEP, JSON.stringify({ view: S.view, scope: S.scope, depth: S.depth, colour: S.colour })); }
  catch (err) {}
}

// a row of choices in the home chart's pill: a white seat under the one on
function pill(name, options, pick){
  const box = el("div", "lg-pill");
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", name);
  box.style.setProperty("--n", options.length);
  box.appendChild(el("span", "lg-thumb"));
  const buttons = options.map(([value, label]) => {
    const b = el("button", "lg-opt", label);
    b.type = "button";
    b.dataset.value = String(value);
    b.addEventListener("click", () => { if (!b.disabled) pick(value); });
    box.appendChild(b);
    return b;
  });
  return {
    box,
    set(value){
      const i = Math.max(0, buttons.findIndex(b => b.dataset.value === String(value)));
      box.style.setProperty("--i", i);
      buttons.forEach((b, j) => { b.classList.toggle("on", j === i); b.setAttribute("aria-pressed", String(j === i)); });
    },
    disable(value, off, why){
      const b = buttons.find(x => x.dataset.value === String(value));
      if (!b) return;
      b.disabled = off;
      if (off && why) b.title = why; else b.removeAttribute("title");
    },
  };
}

function lights(close){
  if (typeof root.settingsLights === "function"){
    const group = root.settingsLights(close);
    const red = group.querySelector(".sp-red");
    if (red) red.setAttribute("aria-label", "Close");
    return group;
  }
  const red = el("button", "lg-close", "×");
  red.type = "button";
  red.setAttribute("aria-label", "Close");
  red.addEventListener("click", close);
  return red;
}

function build(){
  const veil = el("div", "qn-veil sp-veil lg-veil");
  veil.setAttribute("aria-hidden", "true");
  const page = el("div", "qn-glass sp-page sp-mac lg-page");
  page.setAttribute("role", "dialog");
  page.setAttribute("aria-modal", "true");
  page.setAttribute("aria-label", "Links between cards");
  page.tabIndex = -1;

  const head = el("div", "sp-head lg-head");
  const title = el("h2", "sp-title lg-title", "Links");
  const view = pill("View", [["graph", "Graph"], ["timeline", "Timeline"]], v => { S.view = v; keepChoices(); refresh(true); });
  const scope = pill("Cards", [["global", "Global"], ["local", "Local"]], v => { S.scope = v; keepChoices(); refresh(true); });
  const depthWrap = el("div", "lg-depth");
  const depthLabel = el("span", "lg-label", "Depth");
  const depth = pill("Depth", [[1, "1"], [2, "2"], [3, "3"]], v => { S.depth = v; keepChoices(); refresh(true); });
  depthWrap.append(depthLabel, depth.box);
  const colour = pill("Colour by", [["lane", "Lane"], ["section", "Section"]], v => { S.colour = v; S.hidden.clear(); keepChoices(); refresh(false); });
  const find = el("input", "lg-find");
  find.type = "search";
  find.placeholder = "Find a card";
  find.setAttribute("aria-label", "Find a card");
  find.spellcheck = false;
  find.addEventListener("input", () => { S.find = find.value; refresh(false); });
  const count = el("span", "lg-count");
  const tools = el("div", "lg-tools");
  tools.append(view.box, scope.box, depthWrap, colour.box, find);
  head.append(lights(close), title, count, tools);

  const body = el("div", "lg-body");
  const canvas = el("canvas", "lg-canvas");
  const legend = el("div", "lg-legend");
  const zoom = el("div", "lg-zoom");
  const zoomButton = (label, html, act) => {
    const b = el("button", "lg-zbtn qn-glass");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.innerHTML = html;
    b.addEventListener("click", act);
    zoom.appendChild(b);
  };
  zoomButton("Zoom in", '<span aria-hidden="true">+</span>', () => zoomBy(1.4));
  zoomButton("Zoom out", '<span aria-hidden="true">−</span>', () => zoomBy(1 / 1.4));
  zoomButton("Fit to the sheet", FIT, () => fit(true));
  const tip = el("div", "lg-tip qn-glass");
  tip.setAttribute("aria-hidden", "true");
  const note = el("div", "lg-note");
  body.append(canvas, legend, zoom, tip, note);

  const foot = el("div", "lg-foot");
  const play = el("button", "lg-play");
  play.type = "button";
  play.setAttribute("aria-label", "Replay the links in the order they were made");
  play.title = "Replay the links in the order they were made";
  play.innerHTML = PLAY;
  play.addEventListener("click", togglePlay);
  const slider = el("input", "lg-slider");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  slider.setAttribute("aria-label", "Links shown, oldest first");
  slider.addEventListener("input", () => { stopPlay(); setStep(+slider.value); });
  const at = el("span", "lg-at");
  foot.append(play, slider, at);

  page.append(head, body, foot);
  veil.appendChild(page);
  document.body.appendChild(veil);
  S.ui = { veil, page, head, view, scope, depth, depthWrap, colour, find, count, body, canvas, legend, zoom, tip, note,
    play, slider, at, ctx: canvas.getContext("2d") };

  veil.addEventListener("keydown", onKey);
  let downOutside = false;
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => { if (downOutside && e.target === veil) close(); downOutside = false; });
  document.addEventListener("focusin", e => { if (S.open && !page.contains(e.target)) page.focus({ preventScroll: true }); });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", () => { if (!S.press) setHover(null, null); });
  canvas.addEventListener("wheel", onWheel, { passive: false });
  if (typeof ResizeObserver === "function") new ResizeObserver(() => { if (S.open){ size(); draw(); } }).observe(body);
  S.reduce = !!(root.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  S.built = true;
}

function onKey(e){
  e.stopPropagation();
  if (e.key === "Escape"){
    e.preventDefault();
    if (S.ui.find === document.activeElement && S.ui.find.value){ S.ui.find.value = ""; S.find = ""; refresh(false); return; }
    close();
    return;
  }
  if (e.target === S.ui.find || e.metaKey || e.ctrlKey) return;
  if (e.key === "+" || e.key === "="){ e.preventDefault(); zoomBy(1.4); }
  else if (e.key === "-" || e.key === "_"){ e.preventDefault(); zoomBy(1 / 1.4); }
  else if (e.key === "0"){ e.preventDefault(); fit(true); }
}

// ---- opening, reading and closing -------------------------------------------
// opts: lanes, the board's [{id, name}] in its tab order; focus, the card on
// screen ({id, title}) or none; openCard(id), the board's own way to show a
// card, answering whether it could; onOpen and onClose for the page's own
// bookkeeping; store, where the reader's choices are kept
async function open(opts){
  S.opts = opts || {};
  if (!S.built) build();
  readChoices();
  S.focus = S.opts.focus && typeof S.opts.focus.id === "string" ? S.opts.focus : null;
  if (S.scope === "local" && !S.focus) S.scope = "global";
  S.find = ""; S.ui.find.value = "";
  S.hidden.clear();
  S.hover = S.hoverArc = null; S.lit = null; S.mix = 0;
  S.m = null; S.shown = null; S.error = "";
  if (!S.open){
    S.open = true;
    S.back = document.activeElement;
    S.ui.veil.classList.add("open");
    S.ui.veil.setAttribute("aria-hidden", "false");
    if (S.opts.onOpen) S.opts.onOpen();
  }
  S.ui.page.focus({ preventScroll: true });
  paintControls();
  size();
  say("Reading the links…", "");
  let answer = null;
  try {
    const r = await (S.opts.fetch || fetch)("/links/all", { cache: "no-store" });
    if (r.status === 404) S.error = "old";
    else if (!r.ok) S.error = "failed";
    else answer = await r.json();
  } catch (err) { S.error = "failed"; }
  if (!S.open) return;
  if (answer) S.m = model(answer, S.opts.lanes);
  refresh(true);
}

function close(how){
  if (!S.open) return;
  S.open = false;
  stopPlay();
  if (S.sim) S.sim.stop();
  cancelAnimationFrame(S.frame);
  S.frame = 0;
  S.press = null;
  setHover(null, null);
  S.ui.veil.classList.remove("open");
  S.ui.veil.setAttribute("aria-hidden", "true");
  if (S.opts.onClose) S.opts.onClose();
  const to = S.back;
  S.back = null;
  if (how !== "card" && to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
  else if (S.ui.page.contains(document.activeElement)) document.activeElement.blur();
}

// a card picked on the sheet: the board shows it, and the sheet goes. a card the
// board cannot show (another lane, in a project's own window) leaves the sheet up
function pickCard(id){
  if (typeof S.opts.openCard !== "function") return;
  close("card");
  if (!S.opts.openCard(id)) open(S.opts);
}

function say(head, line, retry){
  const n = S.ui.note;
  n.textContent = "";
  if (!head){ n.hidden = true; return; }
  n.hidden = false;
  n.append(el("div", "lg-note-head", head));
  if (line) n.append(el("div", "lg-note-line", line));
  if (retry){
    const b = el("button", "lg-retry", "Try again");
    b.type = "button";
    b.addEventListener("click", () => open(S.opts));
    n.append(b);
  }
}

// what is on the sheet follows from the reading and the choices: the cards in
// scope, their links, the replay's step and what it shows. laid out again only
// when the cards in scope change (again)
function refresh(again){
  if (!S.open) return;
  const m = S.m;
  paintControls();
  stopPlay();
  if (!m){
    S.ui.canvas.hidden = true;
    S.ui.legend.textContent = "";
    S.ui.count.textContent = "";
    S.ui.slider.disabled = true;
    S.ui.at.textContent = "";
    S.ui.play.disabled = true;
    if (S.error === "old") say("This board needs a restart to draw its links.",
      "Its server is older than the graph. Restart the board, then open this again.");
    else if (S.error) say("Could not read the links.", "The board did not answer.", true);
    return;
  }
  const local = S.scope === "local" && S.focus;
  S.ids = local ? neighbours(m, S.focus.id, S.depth) : null;
  S.edges = within(m, S.ids);
  const cards = S.ids ? S.ids.size : m.nodes.length;
  S.ui.count.textContent = cards ? plural(cards, "card") + " · " + plural(S.edges.length, "link") : "";
  if (!m.edges.length) say("No links yet.", "Agents link related cards as they work; each link shows here as it is made.");
  else if (local && !S.ids.size) say("“" + (S.focus.title || number(S.focus.id)) + "” has no links yet.",
    "Switch to Global for every linked card.");
  else say("");
  S.ui.canvas.hidden = !!(S.ui.note.hidden === false);
  if (again){
    S.shown = null;
    S.step = S.edges.length;
    S.tl = timeline(m, S.ids);
    S.tv = { t0: S.tl.t0, t1: S.tl.t1 };
    S.scroll = 0;
    layout();
  } else S.step = Math.min(S.step, S.edges.length);
  S.hits = S.find.trim() ? new Set(m.nodes.filter(n => matches(n, S.find, laneName(n.owner))).map(n => n.id)) : null;
  paintLegend();
  setStep(S.step, true);
}

const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
const laneName = owner => { const l = S.m && S.m.laneOf.get(owner); return l ? l.name : owner; };
const group = n => (S.colour === "section" ? n.section : n.owner);
const nodeHidden = n => S.hidden.has(group(n));

function paintControls(){
  const u = S.ui;
  u.view.set(S.view);
  u.scope.set(S.scope);
  u.scope.disable("local", !S.focus, "Open a card on the board first");
  u.depth.set(S.depth);
  u.depthWrap.hidden = S.scope !== "local";
  u.colour.set(S.colour);
  u.page.dataset.view = S.view;
  u.zoom.hidden = S.view !== "graph";
}

// the legend: a glass chip for each lane or section on the sheet, with how
// many of its cards are in scope. a click hides that group's cards and shows
// them again
function paintLegend(){
  const u = S.ui, m = S.m;
  u.legend.textContent = "";
  if (!m || !m.edges.length) return;
  const counts = new Map();
  for (const n of m.nodes) if (!S.ids || S.ids.has(n.id)) counts.set(group(n), (counts.get(group(n)) || 0) + 1);
  const groups = S.colour === "section"
    ? SECTIONS.filter(s => counts.has(s)).map(s => ({ key: s, name: SECTION_NAMES[s], colour: SECTION_COLOURS[s] }))
    : m.lanes.filter(l => counts.has(l.id)).map(l => ({ key: l.id, name: l.name, colour: l.colour }));
  for (const g of groups){
    const chip = el("button", "lg-chip qn-glass");
    chip.type = "button";
    chip.classList.toggle("off", S.hidden.has(g.key));
    chip.setAttribute("aria-pressed", String(!S.hidden.has(g.key)));
    chip.title = (S.hidden.has(g.key) ? "Show " : "Hide ") + g.name;
    const dot = el("span", "lg-dot");
    dot.style.setProperty("--c", g.colour);
    chip.append(dot, el("span", "lg-chip-name", g.name), el("span", "lg-chip-n", String(counts.get(g.key))));
    chip.addEventListener("click", () => {
      if (S.hidden.has(g.key)) S.hidden.delete(g.key); else S.hidden.add(g.key);
      refresh(false);
    });
    u.legend.appendChild(chip);
  }
}

// ---- the replay -------------------------------------------------------------
function setStep(step, quiet){
  const n = S.edges.length;
  const prev = S.step;
  S.step = clamp(Math.round(step), 0, n);
  const shown = upTo(S.edges, S.step);
  const visible = shown.edges.filter(e => !nodeHidden(S.m.byId.get(e.from)) && !nodeHidden(S.m.byId.get(e.to)));
  const ids = new Set();
  for (const e of visible){ ids.add(e.from); ids.add(e.to); }
  if (S.scope === "local" && S.focus && S.m.byId.has(S.focus.id) && !nodeHidden(S.m.byId.get(S.focus.id))) ids.add(S.focus.id);
  S.shown = { edges: visible, ids, last: shown.last };
  if (!quiet && S.step > prev && !S.reduce) S.pulse = { step: S.step, at: performance.now() };
  const u = S.ui;
  u.slider.max = String(n);
  u.slider.value = String(S.step);
  u.slider.disabled = n < 1;
  u.play.disabled = n < 1;
  u.slider.style.setProperty("--p", n ? (100 * S.step / n) + "%" : "0%");
  const now = S.m.now;
  if (!n) u.at.textContent = "";
  else if (S.step === n) u.at.textContent = (n === 1 ? "1 link, " : "All " + n + " links, ") +
    (n === 1 ? when(S.edges[0].at, now) : day(S.edges[0].at, now) + " to " + day(S.edges[n - 1].at, now));
  else if (S.step === 0) u.at.textContent = "No links yet · 0 of " + n;
  else u.at.textContent = when(shown.last.at, now) + " · " + S.step + " of " + n;
  if (S.hover && !S.shown.ids.has(S.hover)) setHover(null, null);
  draw();
  if (S.pulse.step === S.step) kick();
}

function togglePlay(){
  if (S.play){ stopPlay(); return; }
  if (S.step >= S.edges.length) setStep(0, true);
  const every = clamp(9000 / Math.max(1, S.edges.length), 70, 600);
  S.ui.play.innerHTML = PAUSE;
  S.ui.play.classList.add("on");
  S.play = setInterval(() => {
    if (S.step >= S.edges.length){ stopPlay(); return; }
    setStep(S.step + 1);
  }, every);
}
function stopPlay(){
  if (!S.play) return;
  clearInterval(S.play);
  S.play = 0;
  if (S.ui){ S.ui.play.innerHTML = PLAY; S.ui.play.classList.remove("on"); }
}

// ---- drawing ------------------------------------------------------------------
let W = 0, H = 0, DPR = 1;
function size(){
  const r = S.ui.body.getBoundingClientRect();
  DPR = root.devicePixelRatio || 1;
  W = Math.max(1, Math.round(r.width));
  H = Math.max(1, Math.round(r.height));
  const c = S.ui.canvas;
  if (c.width !== Math.round(W * DPR) || c.height !== Math.round(H * DPR)){
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
}

// one frame now, and frames after it while something is moving: the layout
// settling, the fade under a pointer, a card just come in on the replay
function draw(){
  if (!S.open || !S.m || !S.shown || !S.ui.note.hidden) return;
  const ctx = S.ui.ctx;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  if (S.view === "graph") drawGraph(ctx); else drawTimeline(ctx);
}
function kick(){
  if (S.frame || !S.open) return;
  // a page out of sight gets no frames, so it is drawn as the fade would end
  if (document.hidden){ S.mix = S.lit ? 1 : 0; draw(); return; }
  S.frame = requestAnimationFrame(function tick(){
    S.frame = 0;
    const want = S.lit ? 1 : 0;
    S.mix = S.reduce ? want : S.mix + (want - S.mix) * 0.28;
    if (Math.abs(S.mix - want) < 0.01) S.mix = want;
    draw();
    const pulsing = performance.now() - S.pulse.at < 700;
    if (S.mix !== want || pulsing) S.frame = requestAnimationFrame(tick);
  });
}

function setHover(id, arc){
  if (S.hover === id && S.hoverArc === arc) return;
  S.hover = id;
  S.hoverArc = arc;
  if (id && S.m){
    const lit = new Set([id]);
    for (const e of S.shown.edges){ if (e.from === id) lit.add(e.to); if (e.to === id) lit.add(e.from); }
    S.lit = lit;
  } else if (arc){
    S.lit = new Set([arc.from, arc.to]);
  } else S.lit = null;
  showTip();
  if (S.ui) S.ui.canvas.style.cursor = id || arc ? "pointer" : "";
  kick();
}

// the hover card: the card's lane and section, its number, its title, when it
// was made and last changed, its links each way, and its branch and status
function showTip(){
  const tip = S.ui && S.ui.tip;
  if (!tip) return;
  const m = S.m;
  tip.textContent = "";
  if (!m || (!S.hover && !S.hoverArc)){ tip.classList.remove("on"); return; }
  if (S.hover){
    const n = m.byId.get(S.hover);
    const top = el("div", "lg-tip-top");
    const dot = el("span", "lg-dot");
    dot.style.setProperty("--c", colourOf(n, S.colour, m));
    top.append(dot, el("span", "", laneName(n.owner) + " · " + SECTION_NAMES[n.section]), el("span", "lg-tip-num", number(n.id)));
    tip.append(top, el("div", "lg-tip-title", n.title || "Untitled"));
    tip.append(el("div", "lg-tip-line", "Made " + day(n.made, m.now) + " · changed " + day(n.changed, m.now)));
    tip.append(el("div", "lg-tip-line", plural(n.out, "link") + " out · " + plural(n.in, "link") + " in"));
    if (n.branch || n.status) tip.append(el("div", "lg-tip-mono", [n.branch, n.status].filter(Boolean).join(" · ")));
    tip.append(el("div", "lg-tip-hint", S.opts.openCard ? "Click to open · Option-click for its local graph" : "Option-click for its local graph"));
  } else {
    const e = S.hoverArc, a = m.byId.get(e.from), b = m.byId.get(e.to);
    tip.append(el("div", "lg-tip-top lg-tip-line", "Linked " + when(e.ts, m.now) + (e.agent ? " by " + e.agent : "")));
    tip.append(el("div", "lg-tip-title", a.title || "Untitled"));
    tip.append(el("div", "lg-tip-line", (e.mutual ? "↔ " : "→ ") + (b.title || "Untitled")));
  }
  tip.classList.add("on");
  placeTip();
}
// the hover card stands in a corner of the drawing, the first of top right, top
// left, bottom right and bottom left that keeps clear of what is lit, so it
// never covers the cards it is about; with none clear, the one covering least.
// on the timeline it stays right of the title column and above the legend
function placeTip(){
  const tip = S.ui.tip;
  if (!tip.classList.contains("on")) return;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const timeline = S.view === "timeline";
  const left = timeline ? LABEL_W + TIP_GAP : TIP_GAP, top = timeline ? AXIS_H + TIP_GAP : TIP_GAP;
  const right = W - w - TIP_GAP, bottom = H - h - (timeline ? LEGEND_H : 0) - (timeline ? 8 : 56);
  const corners = [[right, top], [left, top], [timeline ? right : right - 44, bottom], [left, bottom]];
  const keep = litBoxes();
  const cost = ([x, y]) => keep.reduce((sum, b) => sum + Math.max(0, Math.min(b.x1, x + w) - Math.max(b.x0, x)) *
    Math.max(0, Math.min(b.y1, y + h) - Math.max(b.y0, y)), 0);
  let best = corners[0], least = Infinity;
  for (const c of corners){ const v = cost(c); if (v < least){ least = v; best = c; } if (!v) break; }
  tip.style.transform = "translate(" + Math.round(best[0]) + "px," + Math.round(best[1]) + "px)";
}
// the places on the drawing the hover card keeps clear of, with room round them
function litBoxes(){
  const out = [], pad = 12;
  if (!S.m || !S.lit) return out;
  if (S.view === "graph"){
    for (const id of S.lit){
      const n = S.m.byId.get(id);
      if (!n || n.x == null) continue;
      const x = sx(n.x), y = sy(n.y);
      out.push({ x0: x - 90, x1: x + 90, y0: y - 30, y1: y + 30 });
    }
    return out;
  }
  for (const id of S.lit){
    const i = S.tl.index.get(id);
    if (i != null) out.push({ x0: LABEL_W, x1: W, y0: ry(i) - rowH() / 2 - pad, y1: ry(i) + rowH() / 2 + pad });
  }
  for (const arc of S.tl.arcs){
    const e = arc.edge;
    if (e.at == null || !(S.lit.has(e.from) && S.lit.has(e.to)) || !(e === S.hoverArc || e.from === S.hover || e.to === S.hover)) continue;
    const x = tx(e.at), b = bulgeOf(arc);
    out.push({ x0: Math.min(x, x + b) - pad, x1: Math.max(x, x + b) + pad,
      y0: Math.min(ry(arc.a), ry(arc.b)) - pad, y1: Math.max(ry(arc.a), ry(arc.b)) + pad });
  }
  return out;
}

// how strongly a card is drawn: faded under a pointer elsewhere, and faint when
// the find box has words it does not match
function weight(id){
  let a = 1;
  if (S.lit) a *= 1 - 0.85 * S.mix * (S.lit.has(id) ? 0 : 1);
  if (S.hits && !S.hits.has(id)) a *= 0.16;
  return a;
}
function pulseOf(e){
  if (!S.pulse.at || e.step !== S.pulse.step) return 0;
  const t = (performance.now() - S.pulse.at) / 700;
  return t >= 1 ? 0 : 1 - t;
}

// ---- the graph ----------------------------------------------------------------
function layout(){
  const m = S.m, d3 = root.d3;
  if (S.sim){ S.sim.stop(); S.sim.on("tick", null); }
  for (const n of m.nodes){ n.fx = n.fy = null; }
  if (!d3 || !d3.forceSimulation){ S.sim = null; return; }
  const nodes = m.nodes.filter(n => !S.ids || S.ids.has(n.id));
  // a card keeps where it stood the last time the sheet drew it
  for (const n of nodes){
    n.r = radius(n.degree);
    const at = S.pos.get(n.id);
    if (at && n.x == null){ n.x = at.x; n.y = at.y; }
  }
  const links = S.edges.map(e => ({ source: e.from, target: e.to }));
  const local = S.ids && S.focus && m.byId.get(S.focus.id);
  if (local){ local.fx = 0; local.fy = 0; }
  S.sim = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links).id(n => n.id).distance(l => 30 + 2.2 * (l.source.r + l.target.r)))
    .force("charge", d3.forceManyBody().strength(n => -60 - 14 * Math.sqrt(n.degree)).distanceMax(520))
    .force("x", d3.forceX(0).strength(0.045))
    .force("y", d3.forceY(0).strength(0.045))
    .force("collide", d3.forceCollide(n => n.r + 4))
    .alphaDecay(0.035)
    .stop();
  // settle most of the way before the first frame, so the sheet opens on a
  // shape rather than a burst; the rest of the settling is drawn
  const ticks = Math.min(260, Math.ceil(52000 / Math.max(40, nodes.length)));
  for (let i = 0; i < ticks && S.sim.alpha() > 0.02; i++) S.sim.tick();
  S.sim.on("tick", () => { remember(); draw(); });
  // once it has settled it is fitted again, unless the reader has moved the view
  S.moved = false;
  S.sim.on("end", () => { if (S.open && S.view === "graph" && !S.moved) fit(true); });
  remember();
  fit(false);
  if (S.sim.alpha() > S.sim.alphaMin()) S.sim.restart();
}
function remember(){ for (const n of S.sim.nodes()) S.pos.set(n.id, { x: n.x, y: n.y }); }

const sx = x => x * S.tf.k + S.tf.x;
const sy = y => y * S.tf.k + S.tf.y;
// the cards in scope the replay shows now
function graphNodes(){
  if (!S.sim) return [];
  return S.sim.nodes().filter(n => S.shown && S.shown.ids.has(n.id));
}
// the cards in view, with room round them for the legend below and the labels
function fit(animate){
  if (S.view !== "graph"){ if (S.tl){ S.tv = { t0: S.tl.t0, t1: S.tl.t1 }; S.scroll = 0; draw(); } return; }
  const all = S.sim ? S.sim.nodes() : [];
  let b = null;
  for (const n of all){
    b = b || { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, n.x - n.r); b.y0 = Math.min(b.y0, n.y - n.r);
    b.x1 = Math.max(b.x1, n.x + n.r); b.y1 = Math.max(b.y1, n.y + n.r);
  }
  if (!b) return;
  const padX = 90, padTop = 56, padBottom = 76;
  const k = clamp(Math.min((W - 2 * padX) / Math.max(1, b.x1 - b.x0), (H - padTop - padBottom) / Math.max(1, b.y1 - b.y0)), 0.15, 2.4);
  const to = { k, x: W / 2 - k * (b.x0 + b.x1) / 2, y: padTop + (H - padTop - padBottom) / 2 - k * (b.y0 + b.y1) / 2 };
  if (!animate || S.reduce){ S.tf = to; draw(); return; }
  const from = { ...S.tf }, t0 = performance.now();
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / 320), e = t * (2 - t);
    S.tf = { k: from.k + (to.k - from.k) * e, x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    draw();
    if (t < 1 && S.open) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function zoomBy(f, at){
  if (S.view !== "graph"){
    const c = at ? at.x : LABEL_W + (W - LABEL_W) / 2;
    zoomTime(f, c);
    return;
  }
  const p = at || { x: W / 2, y: H / 2 };
  const k = clamp(S.tf.k * f, 0.12, 6);
  S.moved = true;
  const wx = (p.x - S.tf.x) / S.tf.k, wy = (p.y - S.tf.y) / S.tf.k;
  S.tf = { k, x: p.x - wx * k, y: p.y - wy * k };
  draw();
}

function drawGraph(ctx){
  const m = S.m, nodes = graphNodes(), k = S.tf.k;
  const lit = S.lit, hov = S.hover ? m.byId.get(S.hover) : null;
  const font = cssFont();
  // the lines: the ink, faint, and those of the card under the pointer in its
  // colour. an arrowhead at the card linked to once the dots are big enough
  ctx.lineCap = "round";
  const lw = clamp(0.7 + 0.35 * k, 0.8, 1.6);
  for (const e of S.shown.edges){
    const a = m.byId.get(e.from), b = m.byId.get(e.to);
    if (a.x == null || b.x == null) continue;
    const on = hov && (e.from === hov.id || e.to === hov.id);
    const alpha = Math.min(weight(e.from), weight(e.to));
    const pulse = pulseOf(e);
    const colour = on ? colourOf(hov, S.colour, m) : pulse ? colourOf(a, S.colour, m) : INK;
    const base = on ? 0.9 : pulse ? 0.25 + 0.65 * pulse : 0.2;
    edgeLine(ctx, a, b, colour, (on ? 1 : alpha) * base, on ? lw + 0.8 : lw, k >= 0.55);
  }
  // the dots, each ringed in the paper so touching dots stay apart. the local
  // graph's centre wears the ink's ring
  const focus = S.scope === "local" && S.focus ? S.focus.id : null;
  for (const n of nodes){
    const x = sx(n.x), y = sy(n.y), r = Math.max(2.2, n.r * Math.sqrt(k));
    ctx.globalAlpha = weight(n.id);
    ctx.beginPath();
    ctx.arc(x, y, r + 1.5, 0, 2 * Math.PI);
    ctx.fillStyle = PAPER;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fillStyle = colourOf(n, S.colour, m);
    ctx.fill();
    if (n.id === focus || n === hov){
      ctx.beginPath();
      ctx.arc(x, y, r + 3.5, 0, 2 * Math.PI);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
    if (n.firstStep === S.pulse.step && S.pulse.at){
      const p = pulseOf({ step: n.firstStep });
      if (p){
        ctx.globalAlpha = p * 0.6;
        ctx.beginPath();
        ctx.arc(x, y, r + 4 + 14 * (1 - p), 0, 2 * Math.PI);
        ctx.strokeStyle = colourOf(n, S.colour, m);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
  drawLabels(ctx, nodes, font, focus);
}

function edgeLine(ctx, a, b, colour, alpha, width, arrow){
  const x1 = sx(a.x), y1 = sy(a.y), x2 = sx(b.x), y2 = sy(b.y);
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, k = S.tf.k;
  const ra = Math.max(2.2, a.r * Math.sqrt(k)) + 1.5, rb = Math.max(2.2, b.r * Math.sqrt(k)) + 2;
  if (len <= ra + rb) return;
  const ex = x2 - ux * rb, ey = y2 - uy * rb;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1 + ux * ra, y1 + uy * ra);
  ctx.lineTo(arrow ? ex - ux * 4 : ex, arrow ? ey - uy * 4 : ey);
  ctx.stroke();
  if (arrow){
    const s = 5.5;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - ux * s * 1.5 - uy * s * 0.75, ey - uy * s * 1.5 + ux * s * 0.75);
    ctx.lineTo(ex - ux * s * 1.5 + uy * s * 0.75, ey - uy * s * 1.5 - ux * s * 0.75);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function cssFont(){
  const css = getComputedStyle(document.documentElement);
  return { sans: css.getPropertyValue("--sans").trim() || "sans-serif", mono: css.getPropertyValue("--mono").trim() || "monospace" };
}
const short = (t, n) => (t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t);

// the titles by the dots. they come in with the zoom, as Obsidian's fade in
// past its threshold; the card under the pointer and its neighbours always have
// theirs, as does the local graph. the card under the pointer goes first, then
// its neighbours, then what the find box matches, then the most linked. each
// title takes the first place free of the titles and dots already there:
// under its dot, over it, to its right or to its left. one with no free place
// is left out, but for the card under the pointer's, which is never left out.
// with words in the find box only the cards they match have titles
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
function drawLabels(ctx, nodes, font, focus){
  const k = S.tf.k;
  const fadeIn = clamp((k - 0.75) / 0.45, 0, 1);
  const local = S.scope === "local";
  const rank = n => (n.id === S.hover ? 3 : S.lit && S.lit.has(n.id) ? 2 : S.hits && S.hits.has(n.id) ? 1 : 0);
  const order = nodes.slice().sort((a, b) => (rank(b) - rank(a)) || (b.degree - a.degree));
  ctx.font = "500 11.5px " + font.sans;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  // the dots stand in the titles' way as much as other titles do
  const taken = nodes.map(n => {
    const r = Math.max(2.2, n.r * Math.sqrt(k)) + 1.5, x = sx(n.x), y = sy(n.y);
    return { x0: x - r, x1: x + r, y0: y - r, y1: y + r };
  });
  let drawn = 0;
  for (const n of order){
    const lit = S.lit && S.lit.has(n.id);
    if (S.hits && !S.hits.has(n.id) && !lit) continue;
    let a = lit ? 1 : local || n.id === focus ? 1 : Math.max(fadeIn, n.degree >= 5 ? clamp((k - 0.45) / 0.3, 0, 1) : 0);
    a *= weight(n.id);
    if (S.lit && !lit) a *= 1 - S.mix;
    if (a < 0.05) continue;
    const text = short(n.title || number(n.id), lit ? 48 : 30);
    let w = S.labelW.get(text);
    if (w == null){ w = ctx.measureText(text).width; S.labelW.set(text, w); }
    const x = sx(n.x), y = sy(n.y), r = Math.max(2.2, n.r * Math.sqrt(k));
    const spots = [[x, y + r + 4], [x, y - r - 17], [x + r + 6 + w / 2, y - 7], [x - r - 6 - w / 2, y - 7]]
      .map(([cx, top]) => ({ cx, top, x0: cx - w / 2 - 2, x1: cx + w / 2 + 2, y0: top - 1, y1: top + 14 }));
    let spot = spots.find(s => !taken.some(t => overlaps(s, t)));
    if (!spot && n.id === S.hover) spot = spots[0];
    if (!spot || spot.x1 < 0 || spot.x0 > W || spot.y0 > H || spot.y1 < 0) continue;
    taken.push(spot);
    ctx.globalAlpha = a;
    ctx.strokeStyle = PAPER;
    ctx.lineWidth = 3.5;
    ctx.strokeText(text, spot.cx, spot.top);
    ctx.fillStyle = lit || n.id === focus ? INK : "#3E372E";
    ctx.fillText(text, spot.cx, spot.top);
    if (++drawn >= 160) break;
  }
  ctx.globalAlpha = 1;
}

function nodeAt(p){
  const k = S.tf.k;
  let best = null, bestD = Infinity;
  for (const n of graphNodes()){
    if (S.hits && !S.hits.has(n.id)) continue;
    const d = Math.hypot(sx(n.x) - p.x, sy(n.y) - p.y);
    const r = Math.max(2.2, n.r * Math.sqrt(k)) + 5;
    if (d <= r && d < bestD){ best = n; bestD = d; }
  }
  return best;
}

// ---- the timeline ---------------------------------------------------------------
// time runs across the plot, right of the title column; the rows run down it
// under the axis and scroll. tx is a time's place across, ry a row's middle
const plotRight = () => W - 22;
const tx = t => LABEL_W + (t - S.tv.t0) / (S.tv.t1 - S.tv.t0) * (plotRight() - LABEL_W);
const txBack = x => S.tv.t0 + (x - LABEL_W) / (plotRight() - LABEL_W) * (S.tv.t1 - S.tv.t0);
const ry = i => AXIS_H + 10 + i * rowH() + rowH() / 2 - S.scroll;
const rowsEnd = () => H - LEGEND_H;
const rowH = () => clamp(Math.floor((rowsEnd() - AXIS_H - 26) / Math.max(1, S.tl ? S.tl.rows.length : 1)), ROW_MIN, ROW_H);
const maxScroll = () => Math.max(0, AXIS_H + 10 + (S.tl ? S.tl.rows.length : 0) * rowH() + 16 - rowsEnd());
// how far an arc bends from its time and which way: to the right, later, and
// further the more rows it spans; to the left where the right would run out
// of the plot, as the newest links do
function bulgeOf(arc){
  const x = tx(arc.edge.at);
  const b = Math.min(150, 10 + Math.abs(ry(arc.b) - ry(arc.a)) * 0.42);
  return x + b > plotRight() + 14 ? -b : b;
}

function drawTimeline(ctx){
  const m = S.m, T = S.tl, font = cssFont();
  const shownIds = S.shown.ids, hov = S.hover, arcOn = S.hoverArc;
  const right = plotRight();
  const cursor = S.step < S.edges.length && S.shown.last ? S.shown.last.at : null;
  const tk = ticks(S.tv.t0, S.tv.t1, right - LABEL_W);
  const end = rowsEnd();
  // the day lines down the plot
  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, AXIS_H, right - LABEL_W + 22, end - AXIS_H);
  ctx.clip();
  for (const t of tk.ticks){
    const x = Math.round(tx(t.t)) + 0.5;
    ctx.strokeStyle = t.major ? "rgba(33,29,23,.13)" : "rgba(33,29,23,.06)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, end); ctx.stroke();
  }
  // each card's row: its life line from made to last changed
  T.rows.forEach((n, i) => {
    const y = ry(i);
    if (y < AXIS_H - rowH() || y > end + rowH()) return;
    const here = shownIds.has(n.id) || (S.scope === "local" && S.focus && S.focus.id === n.id);
    const colour = colourOf(n, S.colour, m);
    let a = weight(n.id) * (here && !nodeHidden(n) ? 1 : 0.28);
    if (hov === n.id){ ctx.fillStyle = "rgba(33,29,23,.045)"; ctx.fillRect(LABEL_W, y - rowH() / 2, right - LABEL_W + 22, rowH()); }
    if (n.made == null) return;
    const x0 = tx(n.made);
    const last = n.changed != null ? n.changed : n.made;
    const x1 = Math.max(x0 + 1, tx(cursor != null ? Math.min(last, Math.max(cursor, n.made)) : last));
    ctx.globalAlpha = a * 0.55;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.globalAlpha = a;
    ctx.fillStyle = colour;
    ctx.beginPath(); ctx.arc(x0, y, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
  });
  // the links: an arc at the moment each was made, from the row of the card it
  // leaves to the row of the card it reaches, with a mark on both rows there
  for (const arc of T.arcs){
    const e = arc.edge;
    if (e.step > S.step || e.at == null) continue;
    const a = m.byId.get(e.from), b = m.byId.get(e.to);
    if (nodeHidden(a) || nodeHidden(b)) continue;
    const on = arcOn === e || (hov && (e.from === hov || e.to === hov));
    const pulse = pulseOf(e);
    let alpha = Math.min(weight(e.from), weight(e.to));
    if (on) alpha = 1;
    arcPath(ctx, arc);
    ctx.globalAlpha = alpha * (on ? 0.95 : pulse ? 0.4 + 0.6 * pulse : 0.55);
    ctx.strokeStyle = colourOf(a, S.colour, m);
    ctx.lineWidth = on ? 2.2 : 1.4;
    ctx.stroke();
    const x = tx(e.at), y1 = ry(arc.a), y2 = ry(arc.b), side = Math.sign(bulgeOf(arc));
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(x, y1, on ? 3 : 2.3, 0, 2 * Math.PI); ctx.fill();
    // the arrowhead, coming back into the card linked to from the side it bent to
    ctx.beginPath();
    ctx.moveTo(x + side * 2.5, y2);
    ctx.lineTo(x + side * 9, y2 - 3.6);
    ctx.lineTo(x + side * 9, y2 + 3.6);
    ctx.closePath();
    ctx.fillStyle = colourOf(a, S.colour, m);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // the replay's place in time
  if (cursor != null){
    const x = Math.round(tx(cursor)) + 0.5;
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, AXIS_H); ctx.lineTo(x, end); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  // the title column, over the rows' left ends
  ctx.fillStyle = "#FBFAF8";
  ctx.fillRect(0, AXIS_H, LABEL_W, end - AXIS_H);
  ctx.fillStyle = "rgba(0,0,0,.08)";
  ctx.fillRect(LABEL_W - 1, AXIS_H, 1, end - AXIS_H);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, AXIS_H, LABEL_W - 1, end - AXIS_H); ctx.clip();
  ctx.textBaseline = "middle";
  T.rows.forEach((n, i) => {
    const y = ry(i);
    if (y < AXIS_H - rowH() || y > end + rowH()) return;
    const here = shownIds.has(n.id) || (S.scope === "local" && S.focus && S.focus.id === n.id);
    let a = weight(n.id) * (here && !nodeHidden(n) ? 1 : 0.35);
    ctx.globalAlpha = a;
    if (hov === n.id){ ctx.fillStyle = "rgba(33,29,23,.05)"; ctx.fillRect(0, y - rowH() / 2, LABEL_W - 1, rowH()); }
    ctx.fillStyle = colourOf(n, S.colour, m);
    ctx.beginPath(); ctx.arc(20, y, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.font = "400 10.5px " + font.mono;
    ctx.textAlign = "right";
    ctx.fillStyle = SUB;
    ctx.fillText(number(n.id), 62, y + 0.5);
    ctx.font = (hov === n.id || (S.scope === "local" && S.focus && S.focus.id === n.id) ? "600 " : "400 ") + "12.5px " + font.sans;
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    ctx.fillText(fitText(ctx, n.title || "Untitled", LABEL_W - 86), 72, y + 0.5);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
  // the legend's band under the rows, and the axis band over them
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, end, W, H - end);
  ctx.fillRect(0, 0, W, AXIS_H);
  ctx.fillStyle = "rgba(0,0,0,.08)";
  ctx.fillRect(0, end, W, 1);
  ctx.fillRect(0, AXIS_H - 1, W, 1);
  ctx.font = "400 10.5px " + font.mono;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = SUB;
  ctx.fillText(plural(T.rows.length, "card") + ", oldest first", 20, AXIS_H / 2);
  ctx.save();
  ctx.beginPath(); ctx.rect(LABEL_W, 0, right - LABEL_W + 22, AXIS_H); ctx.clip();
  for (const t of tk.ticks){
    const x = tx(t.t);
    ctx.fillStyle = t.major ? INK : SUB;
    // a name that would run off the right edge is left off, its mark kept
    if (x + 5 + ctx.measureText(t.label).width <= W - 8) ctx.fillText(t.label, x + 5, AXIS_H / 2);
    ctx.fillRect(Math.round(x), AXIS_H - 7, 1, 6);
  }
  if (cursor != null){
    const x = tx(cursor), label = when(cursor, m.now);
    const w = ctx.measureText(label).width + 12;
    ctx.fillStyle = INK;
    roundRect(ctx, clamp(x - w / 2, LABEL_W + 2, right - w), 7, w, AXIS_H - 14, 4);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, clamp(x, LABEL_W + 2 + w / 2, right - w / 2), AXIS_H / 2);
  }
  ctx.restore();
}

// an arc's curve: from the card it leaves, out to its bend and back into the
// card it reaches, at its time. points(arc, n) walks it, for the pointer
function arcEnds(arc){
  const x = tx(arc.edge.at), b = bulgeOf(arc);
  return { x, b, y1: ry(arc.a), y2: ry(arc.b), x2: x + Math.sign(b) * 3 };
}
function arcPath(ctx, arc){
  const { x, b, y1, y2, x2 } = arcEnds(arc);
  ctx.beginPath();
  ctx.moveTo(x, y1);
  ctx.bezierCurveTo(x + b, y1, x + b, y2, x2, y2);
}
function arcPoints(arc, n){
  const { x, b, y1, y2, x2 } = arcEnds(arc), out = [];
  for (let i = 0; i <= n; i++){
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * u * x + 3 * u * u * t * (x + b) + 3 * u * t * t * (x + b) + t * t * t * x2,
      y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 });
  }
  return out;
}
function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fitText(ctx, text, max){
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi){
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid).trimEnd() + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

function zoomTime(f, x){
  if (!S.tl) return;
  const t = txBack(clamp(x, LABEL_W, plotRight()));
  const span = clamp((S.tv.t1 - S.tv.t0) / f, HOUR, (S.tl.t1 - S.tl.t0) * 4);
  const share = (t - S.tv.t0) / (S.tv.t1 - S.tv.t0);
  S.tv = { t0: t - share * span, t1: t - share * span + span };
  draw();
}
function panTime(px){
  const per = (S.tv.t1 - S.tv.t0) / (plotRight() - LABEL_W);
  S.tv = { t0: S.tv.t0 + px * per, t1: S.tv.t1 + px * per };
  draw();
}

// what is under a point on the timeline: an arc first, then a row
function timelineAt(p){
  if (p.y < AXIS_H || p.y > rowsEnd()) return null;
  if (p.x > LABEL_W){
    let best = null, bestD = 6;
    for (const arc of S.tl.arcs){
      const e = arc.edge;
      if (e.step > S.step || e.at == null) continue;
      if (nodeHidden(S.m.byId.get(e.from)) || nodeHidden(S.m.byId.get(e.to))) continue;
      const { x, b, y1, y2 } = arcEnds(arc);
      if (p.x < Math.min(x, x + b) - 6 || p.x > Math.max(x, x + b) + 6 ||
          p.y < Math.min(y1, y2) - 6 || p.y > Math.max(y1, y2) + 6) continue;
      for (const q of arcPoints(arc, 24)){
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD){ bestD = d; best = e; }
      }
    }
    if (best) return { arc: best };
  }
  const i = Math.floor((p.y - (AXIS_H + 10) + S.scroll) / rowH());
  const n = S.tl.rows[i];
  if (!n || nodeHidden(n) || (S.hits && !S.hits.has(n.id))) return null;
  return { id: n.id };
}

// ---- the pointer ----------------------------------------------------------------
const point = e => { const r = S.ui.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

function onDown(e){
  if (e.button !== 0 || !S.m) return;
  const p = point(e);
  S.ui.canvas.setPointerCapture(e.pointerId);
  if (S.view === "graph"){
    const n = nodeAt(p);
    S.press = n ? { node: n, p, moved: false } : { pan: true, p, from: { ...S.tf }, moved: false };
  } else {
    const hit = timelineAt(p);
    S.press = { hit, p, pan: true, from: { tv: { ...S.tv }, scroll: S.scroll }, moved: false };
  }
}
function onMove(e){
  if (!S.m) return;
  const p = point(e);
  const press = S.press;
  if (press){
    if (!press.moved && Math.hypot(p.x - press.p.x, p.y - press.p.y) < 4) return;
    press.moved = true;
    S.moved = true;
    if (S.view === "graph" && press.node){
      const n = press.node;
      n.fx = (p.x - S.tf.x) / S.tf.k;
      n.fy = (p.y - S.tf.y) / S.tf.k;
      if (S.sim) S.sim.alphaTarget(0.25).restart();
      setHover(n.id, null);
      placeTip();   // the lit cards move with it
    } else if (S.view === "graph"){
      S.tf = { k: press.from.k, x: press.from.x + p.x - press.p.x, y: press.from.y + p.y - press.p.y };
      S.ui.canvas.style.cursor = "grabbing";
      draw();
    } else {
      const per = (press.from.tv.t1 - press.from.tv.t0) / (plotRight() - LABEL_W);
      const dt = (p.x - press.p.x) * per;
      S.tv = { t0: press.from.tv.t0 - dt, t1: press.from.tv.t1 - dt };
      S.scroll = clamp(press.from.scroll - (p.y - press.p.y), 0, maxScroll());
      setHover(null, null);
      S.ui.canvas.style.cursor = "grabbing";
      draw();
    }
    return;
  }
  if (S.view === "graph"){
    const n = nodeAt(p);
    setHover(n ? n.id : null, null);
  } else {
    const hit = timelineAt(p);
    setHover(hit && hit.id || null, hit && hit.arc || null);
  }
}
function onUp(e){
  const press = S.press;
  S.press = null;
  if (!press) return;
  if (S.ui.canvas.hasPointerCapture(e.pointerId)) S.ui.canvas.releasePointerCapture(e.pointerId);
  S.ui.canvas.style.cursor = S.hover || S.hoverArc ? "pointer" : "";
  if (e.type === "pointercancel") return;
  if (press.node){
    const n = press.node;
    const pinned = S.scope === "local" && S.focus && S.focus.id === n.id;
    if (press.moved){
      if (!pinned){ n.fx = n.fy = null; }
      if (S.sim) S.sim.alphaTarget(0);
      return;
    }
    choose(n.id, e.altKey);
    return;
  }
  if (press.moved) return;
  const hit = press.hit;
  if (hit && hit.id) choose(hit.id, e.altKey);
  else if (hit && hit.arc) choose(hit.arc.from, e.altKey);
}
// a click opens the card; Option and a click makes it the local graph's centre
function choose(id, centre){
  const n = S.m.byId.get(id);
  if (!n) return;
  if (centre){
    S.focus = { id, title: n.title };
    S.scope = "local";
    keepChoices();
    setHover(null, null);
    refresh(true);
    return;
  }
  pickCard(id);
}
function onWheel(e){
  if (!S.m) return;
  e.preventDefault();
  const p = point(e);
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
  if (S.view === "graph"){
    zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0022)), p);
  } else if (e.ctrlKey){
    zoomTime(Math.exp(-dy * 0.01), p.x);
  } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)){
    panTime(e.shiftKey && !dx ? dy : dx);
  } else {
    S.scroll = clamp(S.scroll + dy, 0, maxScroll());
    draw();
  }
  if (S.hover || S.hoverArc){ setHover(null, null); }
}

root.LinkGraph = { logic, open, close, isOpen: () => S.open, ICON: WAYPOINTS,
  // for the checks on the page: what the sheet is showing
  peek: () => S.m && { view: S.view, scope: S.scope, depth: S.depth, colour: S.colour, step: S.step,
    steps: S.edges.length, cards: S.ids ? S.ids.size : S.m.nodes.length, shown: S.shown ? S.shown.ids.size : 0,
    focus: S.focus && S.focus.id, tf: { ...S.tf },
    at: id => { const n = S.m.byId.get(id); return n && n.x != null ? { x: sx(n.x), y: sy(n.y) } : null; },
    row: id => { const i = S.tl && S.tl.index.get(id); return i == null ? null : { x: 40, y: ry(i) }; } },
};
})(globalThis);
