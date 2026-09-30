// Parked for v0: the right toolbar's and the notes panel's script. index.html does not load this file.
// ---- the right toolbar ---------------------------------------------------------
// railTool.open("notes") opens a tool's panel and focuses its room, close()
// shuts it; the room to fill is the data-tool element inside #railpanel
const RAIL_KEY = "railtool";
const railRoot = document.documentElement;
const railPanel = document.getElementById("railpanel");
const railButtons = [...document.querySelectorAll("#toolbar .tool")];
const railRoom = tool => [...railPanel.children].find(p => p.dataset.tool === tool);
function railCurrent(){ return railRoot.dataset.rail || ""; }
function railSet(tool){
  if (tool && !railRoom(tool)) tool = "";
  if (tool){
    railRoot.dataset.rail = tool;
    for (const p of railPanel.children) p.hidden = p.dataset.tool !== tool;
  } else delete railRoot.dataset.rail;
  try { if (tool) localStorage.setItem(RAIL_KEY, tool); else localStorage.removeItem(RAIL_KEY); } catch (e) {}
  for (const b of railButtons){
    const on = b.dataset.tool === tool;
    b.classList.toggle("on", on);
    b.setAttribute("aria-expanded", on ? "true" : "false");
  }
}
const railTool = {
  open(tool){ railSet(tool); const room = railRoom(railCurrent()); if (room) room.focus({ preventScroll: true }); },
  close(){
    const was = railCurrent();
    railSet("");
    railButtons.find(b => b.dataset.tool === was)?.focus({ preventScroll: true });
  },
  toggle(tool){ if (railCurrent() === tool) railTool.close(); else railTool.open(tool); },
  get current(){ return railCurrent(); },
};
window.railTool = railTool;
railSet(railCurrent());   // draw the state the page was restored to
for (const b of railButtons) b.addEventListener("click", () => railTool.toggle(b.dataset.tool));
// Escape shuts the panel unless an inner handler already answered the key
for (const el of [railPanel, document.getElementById("toolbar")]){
  el.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || !railCurrent()) return;
    e.preventDefault();
    railTool.close();
  });
}
// refit on every frame the frame's width changes; height-only changes stay frozen
if (FOCUS && window.ResizeObserver){
  let railSeenW = null;
  new ResizeObserver(entries => {
    const w = entries[0].contentRect.width;
    const first = railSeenW === null;
    if (!first && Math.abs(w - railSeenW) < 0.01) return;
    railSeenW = w;
    if (!first) fitStage();
  }).observe(document.getElementById("appframe"));
}

// ---- the notes panel -----------------------------------------------------------
// the notes tool's room (#railnotes) laid out as a phone notes app: a search pill
// with a grid or list switch and a sort, the notes as cards in two staggered
// columns or one, a large button that starts a note, and an editor the card
// grows into. it works from what a quick note stores and nothing more: the
// words, when the note was made and last changed, and the card it is attached
// to. it is built the first time the tool opens, reads the notes again whenever
// the board's reading of them changes, and saves through the quick note's own
// session (quickNoteSession in card-logic.js). each editor gets a session of its
// own with a memory of its own, so the corner quick note keeps its place.
// nothing here is a status line: a state shows on the element that has it.
// a delete asks nothing; the notes deleted since the page loaded are held here,
// and command Z in the list writes the last of them back as a new note
const NP_VIEW = "notes.view", NP_SORT = "notes.sort", NP_DIR = "notes.dir";
const NP_GROW_MS = 450, NP_SHRINK_MS = 300, NP_SHEET_IN = 350, NP_SHEET_OUT = 200;
const NP_SPATIAL_MS = 435, NP_FX_MS = 150;
const NP_ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  list: '<rect x="4" y="4.5" width="16" height="6.5" rx="1.6"/><rect x="4" y="13" width="16" height="6.5" rx="1.6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.6"/><rect x="13" y="4" width="7" height="7" rx="1.6"/><rect x="4" y="13" width="7" height="7" rx="1.6"/><rect x="13" y="13" width="7" height="7" rx="1.6"/>',
  sort: '<g class="up"><path d="M8.5 19V5"/><path d="M5 8.5L8.5 5 12 8.5"/></g><g class="down"><path d="M15.5 5v14"/><path d="M12 15.5l3.5 3.5 3.5-3.5"/></g>',
  add: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  more: '<circle cx="12" cy="5.5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.7" fill="currentColor" stroke="none"/>',
  trash: '<path d="M5 7h14"/><path d="M10 7V5h4v2"/><path d="M7 7l1 12.5h8L17 7"/><path d="M10.5 10.5v5.5M13.5 10.5v5.5"/>',
  copy: '<rect x="8.5" y="8" width="11" height="12.5" rx="2"/><path d="M5 15.5V6a2 2 0 0 1 2-2h8.5"/>',
  up: '<path d="M6 14.5l6-6 6 6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  tick: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
function npIcon(name, size){
  const s = size || 24;
  const wrap = document.createElement("span");
  wrap.innerHTML = '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + NP_ICONS[name] + "</svg>";
  return wrap.firstChild;
}
function npButton(cls, icon, label, size){
  const b = h("button", cls);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  if (icon) b.append(npIcon(icon, size));
  return b;
}
const npRead = (key, fallback, ok) => { try { const v = localStorage.getItem(key); return ok.includes(v) ? v : fallback; } catch (e){ return fallback; } };
const npWrite = (key, v) => { try { localStorage.setItem(key, v); } catch (e){} };
const npStill = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const npVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const npSleep = ms => new Promise(r => setTimeout(r, ms));
// a motion's end, or its planned length and a little more if the page never
// gets to play it (a tab in the background runs no animations)
const npEnd = (anim, ms) => Promise.race([anim.finished.catch(() => {}), npSleep(ms + 120)]);
// a session's memory of which note it is on, kept for that session alone
function npMemory(){ const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; }

const np = {
  built: false, notes: [], sig: "", q: "", cards: new Map(), drawn: false,
  view: npRead(NP_VIEW, "grid", ["grid", "list"]),
  sort: npRead(NP_SORT, "modified", ["modified", "created"]),
  dir: npRead(NP_DIR, "desc", ["desc", "asc"]),
  ed: null, moving: false, sheet: "", deleted: [], find: null, fetching: null,
};

function npCardOf(id){ return (id && lastState && lastState.boxes.find(b => b.id === id)) || null; }
function npCardName(id){ const b = npCardOf(id); return b ? (b.title || ticketNum(b.id) || "") : ""; }
// what the board's reading says of the notes, card names included, so a note
// changed anywhere, or a card renamed, reads the list again
function npSigOf(st){
  return ((st && st.quicknotes) || []).map(n => n.id + ":" + n.updated + ":" + (n.card || "") + ":" + npCardName(n.card)).join("|");
}
function npOrder(notes){
  const key = np.sort === "created" ? "created" : "updated";
  const seq = n => Number(String((n && n.id) || "").slice(2)) || 0;
  const out = notes.filter(Boolean).slice().sort((a, b) => (b[key] || 0) - (a[key] || 0) || seq(b) - seq(a));
  return np.dir === "asc" ? out.reverse() : out;
}
function npMatches(n){
  if (!np.q) return true;
  if (String(n.text || "").toLowerCase().includes(np.q)) return true;
  return npCardName(n.card).toLowerCase().includes(np.q);
}

function npBuild(){
  if (np.built) return;
  const room = document.getElementById("railnotes");
  if (!room) return;
  np.built = true;
  const root = np.root = h("div", "np");

  const top = h("div", "np-top"), pill = h("div", "np-pill");
  const q = np.qEl = h("input", "np-q");
  q.type = "search"; q.placeholder = "Search your notes"; q.setAttribute("aria-label", "Search your notes");
  q.autocomplete = "off"; q.spellcheck = false;
  const clear = np.clearEl = npButton("np-ib", "close", "Clear search");
  clear.hidden = true;
  const view = np.viewEl = npButton("np-ib np-view", null, "");
  const sort = np.sortEl = npButton("np-ib np-sort", "sort", "Sort");
  pill.append(q, clear, view, sort);
  top.append(pill);

  const scroll = np.scrollEl = h("div", "np-scroll");
  const grid = np.gridEl = h("div", "np-grid");
  scroll.append(grid);
  const fab = np.fabEl = npButton("np-fab", "add", "Create", 28);
  const dim = np.dimEl = h("div", "np-dim");

  const ed = np.edEl = h("div", "np-ed");
  const etop = np.etopEl = h("div", "np-ebar np-etop");
  const back = npButton("np-ib np-back", "back", "Back");
  etop.append(back);
  const field = h("div", "np-field");
  const hl = np.hlEl = h("div", "np-hl");
  const hlIn = np.hlIn = h("div");
  hl.append(hlIn);
  const ta = np.taEl = h("textarea", "np-ta");
  ta.setAttribute("aria-label", "Note");
  field.append(hl, ta);
  const ebot = np.ebotEl = h("div", "np-ebar np-ebot");
  const echip = np.echipEl = h("button", "np-chip");
  echip.type = "button"; echip.hidden = true;
  const more = np.moreEl = npButton("np-more", "more", "Action");
  const find = np.findEl = h("div", "np-find");
  find.hidden = true;
  const ff = h("label", "np-ff");
  const fq = np.fqEl = h("input", "np-fq");
  fq.type = "search"; fq.placeholder = "Find in note"; fq.autocomplete = "off"; fq.spellcheck = false;
  ff.append(npIcon("search"), fq);
  const fup = np.fupEl = npButton("np-ib", "up", "Previous");
  const fdown = np.fdownEl = npButton("np-ib", "down", "Next");
  const fclose = npButton("np-ib", "close", "Close");
  find.append(ff, fup, fdown, fclose);
  ebot.append(echip, more, find);
  ed.append(etop, field, ebot);

  const scrim = np.scrimEl = h("div", "np-scrim");
  const sheet = np.sheetEl = h("div", "np-sheet");
  sheet.setAttribute("role", "menu");
  root.append(top, scroll, fab, dim, ed, scrim, sheet);
  room.append(root);
  npPaintBar();

  q.addEventListener("input", () => {
    np.q = q.value.trim().toLowerCase();
    clear.hidden = !q.value;
    npRender();
  });
  clear.addEventListener("click", () => { q.value = ""; q.dispatchEvent(new Event("input")); q.focus(); });
  view.addEventListener("click", () => npSetView(np.view === "grid" ? "list" : "grid"));
  sort.addEventListener("click", () => npSheetOpen("sort"));
  fab.addEventListener("click", () => npOpen(null, fab, 20));
  back.addEventListener("click", () => npClose());
  more.addEventListener("click", () => npSheetOpen("more"));
  echip.addEventListener("click", () => { if (np.ed) npGoCard(np.ed.s.card); });
  ta.addEventListener("input", () => {
    if (!np.ed) return;
    np.ed.s.input(ta.value);
    if (np.find) npFindRun(false);
    npBars();
  });
  ta.addEventListener("scroll", () => { npBars(); npHlScroll(); queueFatCaret(); });
  fq.addEventListener("input", () => npFindRun(true));
  fup.addEventListener("click", () => npFindStep(-1));
  fdown.addEventListener("click", () => npFindStep(1));
  fclose.addEventListener("click", () => { npFindClose(); ta.focus({ preventScroll: true }); });
  scrim.addEventListener("click", () => npSheetClose());
  // the room keeps its keys: nothing typed or pressed in it reaches the board's
  // own shortcuts. an Escape the room did not use goes on to the toolbar, which
  // shuts the panel
  room.addEventListener("keydown", e => {
    if (npKey(e)){ e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== "Escape") e.stopPropagation();
  });
}

// the two icons in the pill say what they do next and how the list runs now:
// the switch shows the layout it would change to, and the sort shows its arrow
// for the way the dates run, the other arrow faded
function npPaintBar(){
  const v = np.viewEl;
  v.textContent = "";
  v.append(npIcon(np.view === "grid" ? "list" : "grid"));
  v.setAttribute("aria-label", np.view === "grid" ? "List view" : "Grid view");
  const svg = np.sortEl.querySelector("svg");
  svg.querySelector(".up").classList.toggle("dim", np.dir === "desc");
  svg.querySelector(".down").classList.toggle("dim", np.dir === "asc");
}
function npSetView(v){
  np.view = v; npWrite(NP_VIEW, v);
  npPaintBar();
  npRender();
}

// one card per note, kept by id so a card that stays keeps its element
function npCardEl(n){
  let el = np.cards.get(n.id);
  if (!el){
    el = h("div", "np-card");
    el.tabIndex = 0;
    el.dataset.id = n.id;
    el.append(h("div", "np-text"));
    const chip = h("button", "np-chip");
    chip.type = "button"; chip.tabIndex = -1; chip.hidden = true;
    el.append(chip);
    el.addEventListener("click", e => {
      const id = el.dataset.id;
      if (e.target.closest(".np-chip")){ const note = np.notes.find(x => x.id === id); if (note) npGoCard(note.card); return; }
      npOpen(id, el, 12);
    });
    np.cards.set(n.id, el);
  }
  const tx = el.firstChild, words = String(n.text || "");
  if (tx.textContent !== words) tx.textContent = words;
  npChip(el.lastChild, n.card);
  return el;
}
function npChip(chip, card){
  const name = card ? npCardName(card) : "";
  chip.hidden = !name;
  if (!name) return;
  let span = chip.firstChild;
  if (!span){ span = h("span"); chip.append(span); }
  if (span.textContent !== name) span.textContent = name;
}
// a note attached to a card takes you to that card on the board, on its own tab
function npGoCard(id){
  const b = npCardOf(id);
  if (!b) return;
  if (b.owner !== activeOwner) setTab(b.owner);
  else if (homeOpen) setHome(false);
  select(b.id);
}

// the notes drawn in order, each card going into whichever column is shorter at
// that point, so the columns keep their own heights and never line up in rows.
// a card that stays slides from where it was to where it lands, and a card new
// to the view fades in
function npRender(opts){
  if (!np.built) return;
  const grid = np.gridEl;
  const moving = np.drawn && !(opts && opts.still) && !npStill();
  const before = new Map();
  if (moving) for (const [id, el] of np.cards) if (el.isConnected) before.set(id, el.getBoundingClientRect());
  const live = new Set(np.notes.map(n => n.id));
  for (const [id, el] of np.cards) if (!live.has(id)){ el.remove(); np.cards.delete(id); }
  const list = npOrder(np.notes).filter(npMatches);
  const cols = np.view === "list" ? 1 : 2;
  grid.textContent = "";
  const colEls = [];
  for (let i = 0; i < cols; i++){ const c = h("div", "np-col"); colEls.push(c); grid.append(c); }
  for (const n of list){
    const el = npCardEl(n);
    let into = colEls[0];
    if (cols === 2 && colEls[1].offsetHeight < colEls[0].offsetHeight) into = colEls[1];
    into.append(el);
  }
  np.drawn = true;
  if (!moving) return;
  for (const n of list){
    const el = np.cards.get(n.id), was = before.get(n.id);
    if (!el) continue;
    if (!was){
      el.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }],
                 { duration: NP_SPATIAL_MS, easing: npVar("--np-fx") });
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left, dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: "translate(" + dx + "px, " + dy + "px)" }, { transform: "none" }],
               { duration: NP_SPATIAL_MS, easing: npVar("--np-spatial") });
  }
}

// read the notes again; one reading at a time, and a reading that fails leaves
// the cards as they were. opts.fresh waits out a reading already under way and
// takes one of its own, for a caller that has just changed a note
function npRefresh(opts){
  if (np.fetching){
    if (!(opts && opts.fresh)) return np.fetching;
    return np.fetching.then(() => npRefresh({ ...opts, fresh: false }));
  }
  const sig = npSigOf(lastState);
  np.fetching = fetch("/quicknotes", { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !Array.isArray(data.notes)) return;
      np.notes = data.notes.filter(n => n && typeof n.id === "string");
      np.sig = sig;
      npRender(opts);
    })
    .catch(() => {})
    .finally(() => { np.fetching = null; });
  return np.fetching;
}
function npRail(){
  if (typeof railCurrent !== "function" || railCurrent() !== "notes") return;
  npBuild();
  npRefresh({ still: true });
}
new MutationObserver(npRail).observe(document.documentElement, { attributes: true, attributeFilter: ["data-rail"] });
setTimeout(npRail, 0);   // a page restored with the panel open
setInterval(() => {
  if (!np.built || np.moving || railCurrent() !== "notes" || !lastState) return;
  if (npSigOf(lastState) !== np.sig) npRefresh();
}, 1200);

// the room a rectangle stands in, as the clip that shows only that rectangle
function npClipOf(r, radius){
  const room = np.root.getBoundingClientRect();
  return "inset(" + (r.top - room.top) + "px " + (room.right - r.right) + "px " +
         (room.bottom - r.bottom) + "px " + (r.left - room.left) + "px round " + radius + "px)";
}
const NP_FULL = "inset(0px 0px 0px 0px round 0px)";
function npBars(){
  const ta = np.taEl;
  np.etopEl.classList.toggle("under", ta.scrollTop > 0);
  np.ebotEl.classList.toggle("under", ta.scrollTop + ta.clientHeight < ta.scrollHeight - 1);
}
function npEdSync(){
  if (!np.ed) return;
  const s = np.ed.s;
  np.edEl.classList.toggle("failed", s.status === "failed");
  npChip(np.echipEl, s.card);
}
// keep a card in the scroller's view without moving anything outside it
function npReveal(el){
  const sc = np.scrollEl, r = el.getBoundingClientRect(), v = sc.getBoundingClientRect();
  if (r.top < v.top) sc.scrollTop -= v.top - r.top + 8;
  else if (r.bottom > v.bottom) sc.scrollTop += r.bottom - v.bottom + 8;
}

// a note opens by growing from its card (or from the large button, for a new
// note) to the whole room: the editor is clipped to the card's rectangle and
// the clip opens on the emphasized curve while the notes behind dim and the
// editor's words fade in over the first quarter
function npOpen(id, fromEl, radius){
  if (np.ed || np.moving) return;
  const note = id ? np.notes.find(n => n.id === id) : null;
  if (id && !note) return;
  npSheetClose(true);
  const s = quickNoteSession({
    fetch: (url, init) => fetch(url, init), storage: npMemory(),
    boxes: () => (lastState && lastState.boxes) || [],
    schedule: (fn, ms) => setTimeout(fn, ms), cancel: t => clearTimeout(t),
  });
  np.ed = { s, from: id };
  s.onChange = npEdSync;
  const ta = np.taEl;
  ta.value = note ? String(note.text || "") : "";
  ta.scrollTop = 0;
  np.hlIn.textContent = "";
  npChip(np.echipEl, note ? note.card : null);
  np.edEl.classList.remove("failed");
  np.edEl.classList.add("open");
  np.moreEl.hidden = false; np.findEl.hidden = true; np.find = null;
  npBars();
  // the board's words are put in once the session has read them; the field takes
  // no typing while that is under way
  ta.readOnly = true;
  (id ? s.openNote(id) : s.open()).then(() => {
    ta.readOnly = false;
    if (np.ed && np.ed.s === s && ta.value !== s.text){ ta.value = s.text; npBars(); }
    npEdSync();
  });
  let landed = false;
  const land = () => {
    if (landed) return;
    landed = true;
    np.moving = false;
    if (!np.ed || np.ed.s !== s) return;
    ta.focus({ preventScroll: true });
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
    queueFatCaret();
  };
  if (npStill() || !fromEl){ land(); return; }
  np.moving = true;
  const from = npClipOf(fromEl.getBoundingClientRect(), radius);
  const grow = np.edEl.animate([{ clipPath: from }, { clipPath: NP_FULL }], { duration: NP_GROW_MS, easing: npVar("--np-emph") });
  np.edEl.querySelectorAll(":scope > *").forEach(part =>
    part.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1 }], { duration: NP_GROW_MS }));
  np.dimEl.animate([{ opacity: 0, visibility: "visible" }, { opacity: 1, visibility: "visible" }], { duration: NP_GROW_MS, easing: npVar("--np-emph") });
  npEnd(grow, NP_GROW_MS).then(land);
}

// closing saves (an emptied note is removed, as the quick note does), reads the
// notes again, and shrinks the editor back into the note's card, wherever the
// sort has put it now. a note that is gone fades away instead
async function npClose(){
  const e = np.ed;
  if (!e || np.moving) return;
  np.moving = true;
  npFindClose();
  npSheetClose(true);
  // the block caret goes with the field, not after the motion, and the room
  // keeps the keys meanwhile
  document.getElementById("railnotes").focus({ preventScroll: true });
  const s = e.s;
  const saved = s.close();
  await Promise.race([saved, npSleep(900)]);
  await Promise.race([npRefresh({ still: true, fresh: true }), npSleep(900)]);
  const target = s.id && np.cards.get(s.id);
  const shown = target && target.isConnected;
  if (shown) npReveal(target);
  const done = () => {
    np.edEl.classList.remove("open", "failed");
    np.edEl.style.opacity = "";
    np.ed = null;
    np.moving = false;
    np.taEl.blur();
    (shown ? target : document.getElementById("railnotes")).focus({ preventScroll: true });
  };
  if (npStill()){ done(); return; }
  if (shown){
    const to = npClipOf(target.getBoundingClientRect(), 12), white = npVar("--card");
    // the clip reaches the card at six tenths, then the editor's white thins
    // away over it so the card's own words and edge come through
    const shrink = np.edEl.animate([{ clipPath: NP_FULL, backgroundColor: white },
                                    { clipPath: to, backgroundColor: white, offset: 0.6 },
                                    { clipPath: to, backgroundColor: "transparent" }],
                                   { duration: NP_SHRINK_MS, easing: npVar("--np-emph") });
    np.edEl.querySelectorAll(":scope > *").forEach(part =>
      part.animate([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], { duration: NP_SHRINK_MS }));
    np.dimEl.animate([{ opacity: 1, visibility: "visible" }, { opacity: 0, visibility: "visible" }], { duration: NP_SHRINK_MS, easing: npVar("--np-emph") });
    await npEnd(shrink, NP_SHRINK_MS);
  } else {
    await npEnd(np.edEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: NP_SHEET_OUT, easing: npVar("--np-acc") }), NP_SHEET_OUT);
  }
  done();
}

// delete asks nothing: the note is removed from the board and the editor fades
// away. words that were still waiting to be saved are dropped with it
async function npDeleteOpen(){
  const e = np.ed;
  if (!e || np.moving) return;
  np.moving = true;
  npSheetClose(true);
  npFindClose();
  document.getElementById("railnotes").focus({ preventScroll: true });
  const s = e.s, words = np.taEl.value;
  // nothing unsaved may land after the delete: a note never saved has nothing to
  // send, and a saved one keeps the words the board already has
  if (s.id == null) s.text = ""; else s.text = s.saved;
  await s.flush();
  if (s.id) await npDrop(s.id, words, s.card);
  np.moving = false;
  np.ed = null;
  np.taEl.blur();
  if (!npStill())
    await npEnd(np.edEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: NP_SHEET_OUT, easing: npVar("--np-acc") }), NP_SHEET_OUT);
  np.edEl.classList.remove("open", "failed");
  document.getElementById("railnotes").focus({ preventScroll: true });
}
async function npDrop(id, words, card){
  np.deleted.push({ text: words, card: card || null });
  await fetch("/quicknote/del?id=" + encodeURIComponent(id), { method: "POST" }).catch(() => {});
  np.notes = np.notes.filter(n => n.id !== id);
  npRender();
}
// the focused card deleted from the list: it fades, then the others close up
async function npDeleteCard(el){
  const id = el.dataset.id, n = np.notes.find(x => x.id === id);
  if (!n || np.moving) return;
  const cards = [...np.gridEl.querySelectorAll(".np-card")];
  const next = cards[cards.indexOf(el) + 1] || cards[cards.indexOf(el) - 1] || null;
  if (!npStill()) await npEnd(el.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.96)" }], { duration: NP_FX_MS, easing: npVar("--np-fx"), fill: "forwards" }), NP_FX_MS);
  await npDrop(id, n.text, n.card);
  (next && next.isConnected ? next : document.getElementById("railnotes")).focus({ preventScroll: true });
}
// command Z in the list: the last note deleted since the page loaded is written
// back as a new note, on its card if that card is still there
async function npRestore(){
  const d = np.deleted.pop();
  if (!d) return;
  const card = d.card && npCardOf(d.card) ? d.card : null;
  const r = await fetch("/quicknote/new" + (card ? "?card=" + encodeURIComponent(card) : ""), { method: "POST", body: d.text })
    .then(x => x.ok ? x.json() : null).catch(() => null);
  if (!r || !r.note){ np.deleted.push(d); return; }
  await npRefresh({ fresh: true });
  const el = np.cards.get(r.note.id);
  if (el && el.isConnected){ npReveal(el); el.focus({ preventScroll: true }); }
}
// a copy is a new note with the same words on the same card. the editor goes
// back into the note first, and the copy then joins the list
async function npCopy(){
  const e = np.ed;
  if (!e || np.moving) return;
  const words = np.taEl.value, card = e.s.card;
  if (!words.trim()) return;
  npSheetClose(true);
  await npClose();
  await fetch("/quicknote/new" + (card ? "?card=" + encodeURIComponent(card) : ""), { method: "POST", body: words }).catch(() => {});
  await npRefresh({ fresh: true });
}

// sheets: the sort, over the list, and the note's menu, over the editor
function npSheetOpen(kind){
  if (np.moving) return;
  const sheet = np.sheetEl;
  sheet.textContent = "";
  sheet.className = "np-sheet" + (kind === "sort" ? " sort" : "");
  const row = (icon, words, act, on) => {
    const b = h("button", "np-row" + (on ? " on" : ""));
    b.type = "button";
    b.setAttribute("role", kind === "sort" ? "menuitemradio" : "menuitem");
    if (kind === "sort") b.setAttribute("aria-checked", on ? "true" : "false");
    const ic = npIcon(icon);
    if (kind === "sort") ic.classList.add("tick");
    b.append(ic, document.createTextNode(words));
    b.addEventListener("click", act);
    sheet.append(b);
    return b;
  };
  if (kind === "sort"){
    const pick = key => () => {
      if (np.sort === key) np.dir = np.dir === "desc" ? "asc" : "desc";
      else { np.sort = key; np.dir = "desc"; }
      npWrite(NP_SORT, np.sort); npWrite(NP_DIR, np.dir);
      npPaintBar();
      npSheetClose();
      npRender();
    };
    row("tick", "Date created", pick("created"), np.sort === "created");
    row("tick", "Date modified", pick("modified"), np.sort === "modified");
  } else {
    row("search", "Find in note", () => { npSheetClose(); npFindOpen(); });
    row("trash", "Delete", () => npDeleteOpen());
    const copy = row("copy", "Make a copy", () => npCopy());
    copy.disabled = !np.taEl.value.trim();
  }
  np.sheet = kind;
  np.sheetReturn = document.activeElement;
  np.scrimEl.getAnimations().forEach(a => a.cancel());
  np.scrimEl.classList.add("open");
  sheet.classList.add("open");
  if (!npStill()){
    np.scrimEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: NP_SHEET_IN, easing: npVar("--np-dec"), fill: "forwards" });
    sheet.animate([{ transform: "translateY(100%)" }, { transform: "none" }], { duration: NP_SHEET_IN, easing: npVar("--np-dec") });
  } else np.scrimEl.style.opacity = "1";
  const first = sheet.querySelector(".np-row.on") || sheet.querySelector(".np-row:not(:disabled)");
  if (first) first.focus({ preventScroll: true });
}
function npSheetClose(instant){
  if (!np.sheet) return;
  np.sheet = "";
  const sheet = np.sheetEl, scrim = np.scrimEl;
  const hide = () => {
    if (np.sheet) return;
    sheet.classList.remove("open"); scrim.classList.remove("open");
    scrim.getAnimations().forEach(a => a.cancel()); scrim.style.opacity = "";
    sheet.getAnimations().forEach(a => a.cancel());
  };
  const back = np.sheetReturn;
  np.sheetReturn = null;
  if (!instant && back && back.isConnected && np.root.contains(back)) back.focus({ preventScroll: true });
  if (instant || npStill()){ hide(); return; }
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: NP_SHEET_OUT, easing: npVar("--np-acc"), fill: "forwards" });
  npEnd(sheet.animate([{ transform: "none" }, { transform: "translateY(100%)" }], { duration: NP_SHEET_OUT, easing: npVar("--np-acc"), fill: "forwards" }), NP_SHEET_OUT)
    .then(hide);
}

// find in note: the matches are marked on a layer under the words, the current
// one darker, and the arrows step through them
function npFindOpen(){
  if (!np.ed) return;
  np.find = { at: 0, hits: [] };
  np.moreEl.hidden = true; np.echipEl.hidden = true;
  np.findEl.hidden = false;
  np.fqEl.value = "";
  npFindRun(false);
  np.fqEl.focus({ preventScroll: true });
}
function npFindClose(){
  if (!np.find) return;
  np.find = null;
  np.findEl.hidden = true; np.moreEl.hidden = false;
  np.hlIn.textContent = "";
  if (np.ed) npChip(np.echipEl, np.ed.s.card);
}
function npFindRun(jump){
  const f = np.find;
  if (!f) return;
  const text = np.taEl.value, want = np.fqEl.value.toLowerCase();
  f.hits = [];
  if (want){
    const low = text.toLowerCase();
    for (let i = low.indexOf(want); i >= 0; i = low.indexOf(want, i + want.length)) f.hits.push(i);
  }
  if (jump || f.at >= f.hits.length) f.at = 0;
  npFindPaint(want.length, jump);
}
function npFindStep(d){
  const f = np.find;
  if (!f || !f.hits.length) return;
  f.at = (f.at + d + f.hits.length) % f.hits.length;
  npFindPaint(np.fqEl.value.length, true);
}
function npFindPaint(len, jump){
  const f = np.find, text = np.taEl.value, box = np.hlIn;
  box.textContent = "";
  let from = 0, cur = null;
  f.hits.forEach((at, i) => {
    box.append(document.createTextNode(text.slice(from, at)));
    const m = h("mark", i === f.at ? "cur" : null, text.slice(at, at + len));
    if (i === f.at) cur = m;
    box.append(m);
    from = at + len;
  });
  box.append(document.createTextNode(text.slice(from)));
  np.fupEl.disabled = np.fdownEl.disabled = !f.hits.length;
  npHlScroll();
  if (jump && cur){
    const ta = np.taEl;
    ta.scrollTop = Math.max(0, cur.offsetTop - ta.clientHeight / 2);
    npHlScroll();
  }
}
function npHlScroll(){ np.hlIn.style.transform = "translateY(" + (-np.taEl.scrollTop) + "px)"; }

// the room's keys. the list's are the ones a web notes app uses: slash to
// search, c for a new note, j and k (or the arrows) to walk the cards, Enter to
// open one, # to delete it, command G to switch the layout, command Z to bring
// the last deleted note back. in the editor Escape or command Enter closes the
// note. true when the key was used
function npKey(e){
  if (e.isComposing) return false;
  const k = e.key, cmd = e.metaKey || e.ctrlKey, plain = !cmd && !e.altKey;
  const t = e.target;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  if (np.sheet){
    if (k === "Escape"){ npSheetClose(); return true; }
    if (k === "ArrowDown" || k === "ArrowUp"){
      const rows = [...np.sheetEl.querySelectorAll(".np-row:not(:disabled)")];
      const i = rows.indexOf(document.activeElement);
      const to = rows[(i + (k === "ArrowDown" ? 1 : -1) + rows.length) % rows.length];
      if (to) to.focus({ preventScroll: true });
      return true;
    }
    return false;
  }
  if (np.ed){
    if (np.moving) return k === "Escape";
    if (t === np.fqEl){
      if (k === "Escape"){ npFindClose(); np.taEl.focus({ preventScroll: true }); return true; }
      if (k === "Enter"){ npFindStep(e.shiftKey ? -1 : 1); return true; }
      return false;
    }
    if (k === "Escape" || (k === "Enter" && cmd)){ npClose(); return true; }
    return false;
  }
  if (t === np.qEl){
    if (k === "Escape"){
      if (np.qEl.value){ np.qEl.value = ""; np.qEl.dispatchEvent(new Event("input")); }
      else document.getElementById("railnotes").focus({ preventScroll: true });
      return true;
    }
    if (k === "ArrowDown"){ npWalk(1); return true; }
    return false;
  }
  if (typing) return false;
  if (k === "/" && plain){ np.qEl.focus({ preventScroll: true }); return true; }
  if ((k === "c" || k === "C") && plain){ npOpen(null, np.fabEl, 20); return true; }
  if ((k === "j" || k === "ArrowDown") && plain){ npWalk(1); return true; }
  if ((k === "k" || k === "ArrowUp") && plain){ npWalk(-1); return true; }
  const card = t && t.classList && t.classList.contains("np-card") ? t : null;
  if (card && (k === "Enter" || k === " ") && plain){ npOpen(card.dataset.id, card, 12); return true; }
  if (card && k === "#" && !cmd){ npDeleteCard(card); return true; }
  if (cmd && !e.shiftKey && (k === "z" || k === "Z")){ npRestore(); return true; }
  if (cmd && (k === "g" || k === "G")){ npSetView(np.view === "grid" ? "list" : "grid"); return true; }
  return false;
}
// the cards in the order the notes run, not column by column
function npWalk(d){
  const order = npOrder(np.notes).filter(npMatches).map(n => np.cards.get(n.id)).filter(Boolean);
  if (!order.length) return;
  const i = order.indexOf(document.activeElement);
  const to = order[i < 0 ? (d > 0 ? 0 : order.length - 1) : Math.min(Math.max(i + d, 0), order.length - 1)];
  npReveal(to);
  to.focus({ preventScroll: true });
}
