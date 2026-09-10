// The card's shared logic: what the desktop board (index.html) and the phone
// page (m.html) do to a card in common, kept once, as plain global functions.
// Each page loads it after card-markdown.js and before its own script. The
// functions here read the names each page declares itself: els (box id to the
// card's parts), lastState, selectedId, activeOwner, lastSel, and the page's own
// poll, select and growPend. The chosen list view is the other way round: it is
// held here, one per project, and each page reads it through curView(). Nothing
// here runs on load.

// ---- what a page may set ----------------------------------------------------
// poolScope: a page that narrows the lane's pool further hands back the test to
// keep a card by, or null for the whole lane. the desktop narrows to the chosen
// workspace; the phone shows the lane whole
let poolScope = null;
// keyboardTitle: the desktop's keyboard path through a card's title. Tab commits
// the name and moves on to the composer, or back to the defer chip with shift,
// and Escape hands focus back to the composer. the phone has no keyboard path
let keyboardTitle = false;
// pendTimes: the desktop's sent rows each carry the time a drag reveals; a page
// without that gesture leaves its rows bare
let pendTimes = false;
// pendRoomChanged: what a page does once the sent box has taken its room or
// given it back. the desktop re-snaps the answer's lines against the box
let pendRoomChanged = null;

// ---- the card pages' keyboard commands ------------------------------------------
// Recognition is shared; listeners, state guards, cancellation and effects stay
// with each page. The order is part of the contract because some modifier
// predicates deliberately overlap or ignore extra modifiers.
const CARD_SHORTCUT_DEFINITIONS = [
  {
    action: "diagnostic", mini: false,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented &&
      (e.key === "m" || e.key === "M") ? true : null,
  },
  {
    action: "navigate", mini: true,
    match: e => e.ctrlKey && !e.metaKey && e.shiftKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ? (e.key === "ArrowLeft" ? -1 : 1) : null,
  },
  {
    action: "plainNavigate", mini: true,
    match: e => !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight")
      ? (e.key === "ArrowLeft" ? -1 : 1) : null,
  },
  {
    action: "history", mini: false,
    match: e => e.ctrlKey && !e.metaKey && e.shiftKey &&
      (e.key === "ArrowUp" || e.key === "ArrowDown")
      ? (e.key === "ArrowUp" ? 1 : -1) : null,
  },
  {
    action: "navigate", mini: false,
    match: e => e.metaKey && e.shiftKey && ["[", "]", "{", "}"].includes(e.key)
      ? (e.key === "[" || e.key === "{" ? -1 : 1) : null,
  },
  // command+z and control+z are the editor's undo and nothing of ours. The card
  // pages had a return-to-the-previous-card on that chord until 20260910; it
  // took the key away from the text being typed, so it is gone with no
  // replacement chord.
  {
    action: "create", mini: true,
    match: e => e.metaKey && (e.key === "t" || e.key === "T") ? true : null,
  },
  {
    action: "tab", mini: false,
    match: e => e.metaKey && /^[1-9]$/.test(e.key) ? +e.key - 1 : null,
  },
  {
    action: "escape", mini: false,
    match: e => e.key === "Escape" ? true : null,
  },
  {
    action: "close", mini: false,
    match: e => e.key === "Backspace" || e.key === "Delete" ? true : null,
  },
];

// Pure recognition over key/modifier fields. The finite mini scope sees only
// the two command families the existing mini capture listener owns.
function cardShortcut(event, scope = "card"){
  if (scope !== "card" && scope !== "mini") return null;
  for (const definition of CARD_SHORTCUT_DEFINITIONS){
    if (scope === "mini" && !definition.mini) continue;
    const value = definition.match(event);
    if (value !== null) return { action: definition.action, value };
  }
  return null;
}

// True means a callable page action was invoked. Dispatch does not cancel the
// event, stop propagation, schedule work, or imply that an async action ended.
function dispatchCardShortcut(event, actions, scope = "card"){
  const shortcut = cardShortcut(event, scope);
  const action = shortcut && actions && actions[shortcut.action];
  if (typeof action !== "function") return false;
  action(event, shortcut);
  return true;
}

// Plain arrows belong to the caret anywhere inside an editor, including a
// decorated contenteditable whose key target is one of its descendants.
function cardShortcutEditing(target){
  return !!target && typeof target.closest === "function" &&
    !!target.closest("textarea, input, [contenteditable], [role='textbox'], .cm-editor");
}

// ---- the small helpers --------------------------------------------------------
function h(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

// One renderer and one URL policy serve every card surface. The server exposes
// short and full reply variants separately, so authored Markdown is never
// inspected here for transport punctuation.
function fmt(t){ return CardMarkdown.render(t || ""); }
function replyFull(b){ return b.replyFull == null ? (b.reply || "") : b.replyFull; }

// ---- the one state a card's colour and place come from ---------------------------
function cardState(b){
  // the server's state machine ships the one authoritative state per card;
  // the inline derivation below serves only queueState's unpark recompute
  // (state nulled in a copy) and an older server that omits the field
  const s = b.state || (
         b.done ? "done"
       : b.parked ? "parked"
       : (b.writing || b.bg) ? "working"
       // a card with prior replies was answered before, so it is never new even when a seeded board left its agent stamp at 0
       : (!b.agentTs && !b.pending && !b.replies) ? "new"
       : b.ball === "you" ? "yours"
       : "queued");
  // note is its own server-side progress state. It shares working's green
  // presentation without losing the semantic distinction on the wire.
  const shown = s === "note" ? "working" : s;
  // the machine never ships yours with messages still queued; this guard
  // covers the recomputed path, where an older reply can leave the ball on
  // his side while a newer message is still in line, and that used to paint
  // the card yellow. only yours is rewritten, so done, parked and every
  // green state keep exactly the state they had
  return (shown === "yours" && b.pending > 0) ? "queued" : shown;
}
// the queue panel's view: a parked card sorts and colors as if open. state is
// nulled in the copy so cardState recomputes from the flags instead of handing
// back the server's "parked" when we peel the park off
function queueState(b){ return b.parked ? cardState({ ...b, parked: false, state: null }) : cardState(b); }
// the strict await of the bar count and auto-select: pending vetoes it, and
// so does work in flight, claimed or registered; green outranks the ball
function awaitsYou(b){
  const s = cardState(b);
  // done/parked and work-in-flight are all folded into the state; a still-new
  // card only awaits you when the ball sits with you, and pending vetoes the
  // strict await either way
  return (s === "yours" || (s === "new" && b.ball === "you")) && !(b.pending > 0);
}
// ---- the chosen view, one per project ----------------------------------------
// doing, deferred and done choose a view of one project's cards, so the choice
// belongs to that project and not to the page. it used to be a single variable
// the whole page shared, which is why picking done in one project opened every
// other project on done as well. it is kept per lane now, written the moment a
// button is pressed and read again wherever the list is drawn or walked, so a
// project nobody has chosen a view for opens on doing.
//
// the record is this browser's own, kept the way the open tab ("activeproj") and
// the small card ("minibox.<lane>") already are, so a reload puts each project
// back on the view it was left on rather than on another project's view. only
// the three names below are ever written or believed: anything else found in
// storage counts as no choice at all, and so does anything a lane id borrowed
// from the record's own object (a lane may legitimately be called "constructor"):
// every answer is checked against the three before it is given.
const TICKET_VIEWS = ["todo", "deferred", "done"];
const TICKET_VIEW_KEY = "tikview.";   // + the lane's own id, which is never parsed back out
const ticketViews = {};               // lane id -> the view chosen for it
function ticketViewOf(owner){
  if (!owner) return TICKET_VIEWS[0];
  let view = ticketViews[owner];
  if (!TICKET_VIEWS.includes(view)){
    try { view = localStorage.getItem(TICKET_VIEW_KEY + owner); } catch (err) { view = null; }
    view = TICKET_VIEWS.includes(view) ? view : TICKET_VIEWS[0];
    ticketViews[owner] = view;
  }
  return view;
}
// one lane's choice, refused unless it is one of the three views
function setTicketViewOf(owner, view){
  if (!owner || !TICKET_VIEWS.includes(view)) return false;
  ticketViews[owner] = view;
  try { localStorage.setItem(TICKET_VIEW_KEY + owner, view); } catch (err) {}
  return true;
}
// the view of the project being looked at. everything that draws or walks the
// list reads it here, so a tab switch needs nothing carried across: the answer
// changes with the lane on its own
function curView(){ return ticketViewOf(activeOwner); }
// the three buttons say which view is showing, painted from the same read the
// list is drawn from and on every pass, so a button can never sit on one view
// while the list shows another
function paintViewTabs(){
  const view = curView();
  for (const name of TICKET_VIEWS){
    const b = document.getElementById("tv-" + name);
    if (b) b.classList.toggle("on", name === view);
  }
}
// the doing, deferred and done tabs are a filter over the lane's pool. the left
// list and the arrow keys have to walk the same set, or the arrows cycle into
// cards the list is not showing
function viewFilter(b){
  const s = cardState(b);
  const view = curView();
  return view === "done" ? s === "done"
       : view === "deferred" ? s === "parked"
       : (s !== "done" && s !== "parked");
}
function viewPool(state){ return poolOf(state).filter(viewFilter); }

function poolOf(state){
  const keep = poolScope ? poolScope(state) : null;
  return state.boxes.filter(b =>
    b.owner === activeOwner && b.id !== "q" && (!keep || keep(b)))
    .sort((a, b) => {
      // an untouched new card stays on top; the first send drops it into the
      // waiting group; anything green (in progress) sinks below all of that
      const g = x => ({ "new": 0, yours: 1, queued: 2, working: 3, done: 4 })[queueState(x)];
      if (g(a) !== g(b)) return g(a) - g(b);
      if (g(a) === 0) return (b.ts || 0) - (a.ts || 0);   // newest created on top
      if (g(a) === 1) return (b.agentTs || 0) - (a.agentTs || 0);   // newest reply on top: latest cards come to the top. it was oldest first for a day so a batch came back in send order, which was not wanted
      return (b.ts || 0) - (a.ts || 0);                    // waiting, working and done: newest first
    });
}

// ---- the lanes ------------------------------------------------------------------
// project rows in fixed order: tool meta on top, the rest as the board lists them
function allRowsOf(state){
  const owners = [];
  for (const b of state.boxes)
    if (b.owner !== "qchat" && !owners.includes(b.owner)) owners.push(b.owner);   // the quick chat lane never gets a tab
  // stored project lanes keep their tab even with every card deleted
  for (const p of (state.projects || []))
    if (!owners.includes(p.id)) owners.push(p.id);
  owners.sort((a, b) => (a === "facilitator" ? -1 : b === "facilitator" ? 1 : 0));
  // a dragged tab order outlives reloads, server restarts and the device it
  // was dragged on: saved lanes lead in their saved sequence, lanes the record
  // does not know keep the natural order after them, and stale saved ids must
  // never throw
  const saved = tabRecord(state).order;
  const lead = saved.filter(ow => owners.includes(ow));
  return [...lead, ...owners.filter(ow => !lead.includes(ow))];
}

// ---- the tab bar's record ---------------------------------------------------------
// which lanes the bar shows and in what order is the board's own record, kept
// on the server and handed out with the state, so the desktop and the phone
// draw one bar and either of them may reorder it. an empty order is a board
// that has never had an arrangement written, and both pages then fall back to
// the natural lane order they always used.
const TAB_HOLD = 3000;   // ms a page's own write outranks a poll already in flight
let tabsHeld = null;     // {rec, until}: this page's write, until a poll carries it back
function tabRecord(state){
  const rec = (state && state.tabs) || {};
  const now = {
    order: Array.isArray(rec.order) ? rec.order : [],
    closed: Array.isArray(rec.closed) ? rec.closed : [],
  };
  // a poll that left before this page's write must not undo it; once the
  // record agrees, or the hold runs out, the server's answer is the truth
  if (tabsHeld && Date.now() < tabsHeld.until &&
      JSON.stringify(now) !== JSON.stringify(tabsHeld.rec)) return tabsHeld.rec;
  return now;
}
function tabShut(state, ow){ return tabRecord(state).closed.includes(ow); }
// one write, the whole record at once, so a reorder can never half land. what
// the server answers is what the page keeps, never the copy it sent
function writeTabs(rec){
  const clean = { order: (rec.order || []).slice(), closed: (rec.closed || []).slice() };
  tabsHeld = { rec: clean, until: Date.now() + TAB_HOLD };
  return fetch("/tabs", { method: "POST", body: JSON.stringify(clean) })
    .then(r => r.json())
    .then(r => { if (r && r.tabs) tabsHeld = { rec: r.tabs, until: Date.now() + TAB_HOLD }; })
    .catch(() => {});
}
function labelOf(state, owner){
  const dir = (state.pwds || {})[owner] || "";
  return dir.split("/").filter(Boolean).pop() || owner;
}

// which replies the owner has laid eyes on: box id -> how many replies the
// card carried when he last opened it; selecting a card counts as reading the
// reply it shows. the board keeps this, one record per card, so a card opened
// on the phone counts as read on the desktop too. the map below is this page's
// copy of what the state last said, with its own writes held on top of it
const SEEN_HOLD = 3000;   // ms a page's own write outranks a poll already in flight
const seenReplies = {};
const seenHeld = {};      // id -> {n, until}: this page's write, until a poll carries it back
const seenTotals = {};    // id -> the replies the card carried at the last sync
function seenSync(state){
  const now = Date.now();
  for (const b of (state.boxes || [])){
    const said = b.seen || 0;
    const held = seenHeld[b.id];
    if (held && (said >= held.n || now >= held.until)) delete seenHeld[b.id];
    seenReplies[b.id] = seenHeld[b.id] ? Math.max(said, seenHeld[b.id].n) : said;
    seenTotals[b.id] = b.replies || 0;
  }
}
// these cards are read now, up to the replies they are showing: the page marks
// them at once and the board is told in one write, so the other device sees it
// on its next poll. a mark that would lower a count is dropped, never sent
function setSeenMany(marks){
  const send = {};
  for (const id of Object.keys(marks)){
    const n = marks[id];
    if (!(n > 0) || (seenReplies[id] || 0) >= n) continue;
    seenReplies[id] = n;
    seenHeld[id] = { n: n, until: Date.now() + SEEN_HOLD };
    send[id] = n;
  }
  if (!Object.keys(send).length) return Promise.resolve();
  return fetch("/seen", { method: "POST", body: JSON.stringify(send) })
    .then(r => r.json())
    .then(r => {
      for (const [id, n] of Object.entries((r && r.seen) || {})){
        if (typeof n !== "number") continue;
        seenReplies[id] = n;
        seenHeld[id] = { n: n, until: Date.now() + SEEN_HOLD };
      }
    })
    .catch(() => {});
}
function markSeen(id){
  if (seenTotals[id] != null) setSeenMany({ [id]: seenTotals[id] });
}

// does this lane still hold a reply he has not opened? this is the left
// list's own seen test, card by card, so the tab and the row can never
// disagree about what unread means: the agent has answered, the ball is with
// him, nothing of his is still queued behind it, and he has not opened the
// card since that answer landed. cardState keeps done and deferred cards out,
// so a lane he has finished with never asks for him again
function laneUnread(state, owner){
  return !!state && state.boxes.some(b =>
    b.owner === owner && b.id !== "q" && cardState(b) === "yours" &&
    (seenReplies[b.id] || 0) < (b.replies || 0));
}

function pickInRow(state, owner){
  const row = state.boxes.filter(b => b.owner === owner && b.id !== "q");
  if (!row.length) return null;
  return (lastSel[owner] && row.find(b => b.id === lastSel[owner]))
      || row.find(awaitsYou)
      || row[0];
}

// ---- times ------------------------------------------------------------------------
const MONTHS3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// the stamp on a sent-and-waiting message: a short clock time, plus a plain
// month-and-day date in front only when the send was not today; empty when
// the send time is unknown (entries queued before the server recorded times)
function stampText(ts){
  if (!ts) return "";
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return "";
  const hr = d.getHours();
  const clock = (hr % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0") + " " + (hr < 12 ? "AM" : "PM");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock;
  const day = MONTHS3[d.getMonth()] + " " + d.getDate() + (d.getFullYear() === now.getFullYear() ? "" : " " + d.getFullYear());
  return day + ", " + clock;
}

function shortAge(ts){
  if (!ts) return "";
  const sec = Date.now() / 1000 - ts;
  if (sec < 60) return "now";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86400) + "d";
}

// ---- the card's row ---------------------------------------------------------------
// a picked or dropped file goes up the board's own upload road and its address
// joins the text, which is what the card has always done with a dropped image
async function attach(files, ta){
  for (const f of files.filter(x => x.type.startsWith("image/"))){
    const r = await fetch("/upload?name=" + encodeURIComponent(f.name || "picture"), { method: "POST", body: f })
      .then(x => x.json()).catch(() => null);
    if (r?.url) ta.value = (ta.value ? ta.value.trimEnd() + "\n" : "") + r.url + "\n";
  }
  ta.dispatchEvent(new Event("input"));
}

// the send square's seat. it is bottom aligned in the row, the way the chat
// panel pins its arrow to the pill's bottom edge so it holds still while the
// box grows, and the margin written here drops it so its middle lands on the
// middle of the last line of type. while the field is at its cap and scrolling,
// the last line on screen is the one it takes, which is the line being written.
// the plus is not seated here: it has left the row for a bar of its own, and
// that bar stands it on the row's own floor, so it holds
// the bottom however many lines the row has grown to. css alone puts it there,
// so a margin written onto it here could only lift it off the floor it keeps
function seatSquare(ta, square){
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  const pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const hgt = ta.getBoundingClientRect().height;
  if (!lh || !hgt) return;
  const lines = Math.max(1, Math.round((ta.scrollHeight - pt - pb) / lh));
  const foot = ta.scrollHeight > ta.clientHeight + 1 ? hgt - pb : pt + lines * lh;
  const mid = foot - lh / 2;
  square.style.marginBottom = (hgt - mid - square.offsetHeight / 2) + "px";
}

// the thumb shows while its own scroller is actually moving and fades out 700ms
// after it rests, which is the ticket list's own trick and the markdown panes'
// after it. restated here rather than shared with them for the reason the
// markdown pane restated it: those two are wired once over elements that exist
// from the first paint, and a card is built and rebuilt long after that block
// has run. both scrollers on the card come through here, the answer and the row
// he types in, and the class and the 700ms are the same in all of them, so
// every bar on the board comes and goes alike
function barFade(node){
  let t = null;
  node.addEventListener("scroll", () => {
    node.classList.add("scrolling");
    clearTimeout(t);
    t = setTimeout(() => node.classList.remove("scrolling"), 700);
  }, { passive: true });
}

// ---- the sent-and-waiting box -----------------------------------------------------
// the box itself is each page's own to build (growPend): the desktop wires the
// fold gesture over it and the phone a plain tap. what stands below is the box's
// arrival, its rows, the delivery words, the run stamp and the poll's own pass
// over it, which the two pages share.
//
// the two beats of the first arrival. the css carries the curve, the 260ms and
// the dress; this hands it the two ends and the handover.
// the far end is measured on the mounted strip while it still stands at its own
// height and before any clock is armed, so the number the run lands on is the
// number the strip holds once the inline height comes off and the handover moves
// nothing. the strip is never painted at that height: the reading, the pinning
// to nothing and the arming all happen inside this one step. the start value is
// pinned while the strip wears the untimed dress and only then is the timing put
// on, or pinning it would itself become a run, from the far end down to nothing,
// in front of the one that matters.
// rows sent while it rises land in a body that is display:none folded, so they
// add nothing to the height and the measured end stays true
const PEND_RISE_MS = 260;   // the number the css rule carries
function risePend(el, pend){
  const to = pend.getBoundingClientRect().height;
  const gap = getComputedStyle(pend).marginBottom;   // the band under the box,
  // read rather than typed here, so it travels with the box on one run
  pend.style.height = "0px";
  pend.style.marginBottom = "0px";
  void pend.offsetWidth;            // the start values land untimed
  pend.classList.add("timed");
  pend.style.height = to + "px";
  pend.style.marginBottom = gap;
  const land = e => {
    if (e && (e.target !== pend || e.propertyName !== "height")) return;
    pend.removeEventListener("transitionend", land);
    clearTimeout(timer);
    // beat two. the room is standing clear and the height it was held at is the
    // height it holds on its own, so the inline numbers, the clipping and the
    // timing all come off in one step and nothing shifts by a pixel; what is
    // left is the strength alone
    pend.style.height = "";
    pend.style.marginBottom = "";
    pend.classList.remove("rising", "timed");
    pend.classList.add("appear");
    pend.addEventListener("animationend", function off(ev){
      if (ev.target !== pend) return;
      pend.removeEventListener("animationend", off);
      pend.classList.remove("appear");   // so a later reflow cannot replay it
    });
    if (pendRoomChanged) pendRoomChanged();   // the box has taken its room; the answer ends against it again
  };
  // two ends can finish the run, the transition and a timer behind it, for the
  // same reason the fold carries both
  pend.addEventListener("transitionend", land);
  const timer = setTimeout(land, PEND_RISE_MS + 40);
}

function dropPend(el){
  if (!el.pend) return;
  el.pend.remove();
  el.pend = null;
  el.pendRaw = "";
  if (pendRoomChanged) pendRoomChanged();   // the room the box held is the answer's again
}

// one row: the words, the time that comes up on a drag where the page keeps
// one, and the delivery word
function pendRow(text, ts){
  const row = h("div", "pendmsg");
  row.dataset.text = text;
  const content = h("div", "pendcontent cardmd");
  content.innerHTML = fmt(text);
  if (pendTimes){
    const t = h("span", "ptime", stampText(ts));
    content.appendChild(t);
  }
  row.append(content, h("span", "rcpt"));
  row.addEventListener("animationend", () => row.classList.remove("pop"));
  return row;
}

// the delivery words: one of each on screen, ever. the newest line
// carries Delivered, the line before it carries Read and stands for the whole
// run behind it, and the rest carry nothing. the pass runs over the entire
// column rather than editing the two rows that changed, so the pair cannot
// drift onto the wrong lines however long the run gets.
// the board has no per message read receipt to draw on, so the pair is
// positional, which is what the design asks for
function stampRcpts(pend){
  const rows = pend.querySelector(".pendslide").children, n = rows.length;
  for (let i = 0; i < n; i++){
    const want = i === n - 1 ? "Delivered" : i === n - 2 ? "Read" : "";
    const r = rows[i].querySelector(".rcpt");
    if (r.textContent !== want) r.textContent = want;
  }
}

// newest at the foot. the lane is pinned to its own bottom after a line lands
// and again the moment the box is opened, so the thing last sent is the thing
// on screen. a folded box has a lane with no height, and setting the top of a
// lane that cannot scroll is simply nothing
function pendBottom(pend){
  const lane = pend.querySelector(".pendscroll");
  if (lane) lane.scrollTop = lane.scrollHeight;
}

// the run's one time tag: the first send of the run, since that is when the run
// he is waiting on began. an entry queued before the server recorded times
// carries none, and the tag is simply blank rather than wrong
function stampRun(pend, stamps){
  const s = pend.querySelector(".pendstamp");
  const want = stampText(stamps && stamps[0]);
  if (s.textContent !== want) s.textContent = want;
}

// the poll's own pass over the box. it is the only thing that may add or remove
// rows on a redraw, and it adds nothing a send has already put there
function syncPend(el, texts, stamps){
  texts = texts || []; stamps = stamps || [];
  if (!texts.length){ dropPend(el); return; }
  const pend = el.pend || growPend(el, false);
  const slide = pend.querySelector(".pendslide");
  const have = [...slide.children];
  // a list that still begins with what is on screen only grows; anything else
  // is a list that changed underneath and is drawn again
  const grows = texts.length >= have.length &&
                have.every((row, i) => row.dataset.text === texts[i]);
  if (!grows){
    slide.textContent = "";
    texts.forEach((t, i) => slide.appendChild(pendRow(t, stamps[i])));
  } else {
    // the times come from the server now, so an optimistic row's client clock
    // is corrected in place without touching anything else about the row
    have.forEach((row, i) => {
      const t = row.querySelector(".ptime"), want = stampText(stamps[i]);
      if (t && t.textContent !== want) t.textContent = want;
    });
    for (let i = have.length; i < texts.length; i++){
      const row = pendRow(texts[i], stamps[i]);
      if (pend.classList.contains("open")) row.classList.add("pop");
      slide.appendChild(row);
    }
    if (texts.length > have.length) pendBottom(pend);
  }
  stampRcpts(pend);
  stampRun(pend, stamps);
  el.pendRaw = texts.join("\n\n");
}

// ---- sending, parking, naming ---------------------------------------------------------
// writing to a done or parked card takes it back to doing: the done flag is
// read before the send and flipped after the message is in, so a flip that
// fails can never eat it
function boxDone(id){
  const b = lastState && lastState.boxes.find(x => x.id === id);
  return !!(b && b.done);
}

async function toggleFlag(id, kind){
  const cls = kind === "done" ? "done" : "parked";
  const on = els[id].box.classList.contains(cls);
  els[id].box.classList.remove("peek");   // the desktop's peek; nothing on the phone wears it
  await fetch("/" + kind + "?box=" + encodeURIComponent(id) + "&v=" + (on ? 0 : 1), { method: "POST" }).catch(() => {});
  poll();
}

// a just-created card: the cursor starts in the title; Enter saves the name
// and drops the cursor into the message input
function editTitle(id, opts){
  opts = opts || {};
  const el = els[id]; if (!el) return;
  const t = el.titleEl, old = t.textContent;
  t.setAttribute("contenteditable", "plaintext-only");
  if (old === "…") t.textContent = "";
  // a click edits in place with the caret where you click; other entries (new card, tab) focus and select all
  if (!opts.fromClick){
    t.focus();
    if (t.textContent){
      const range = document.createRange();
      range.selectNodeContents(t);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
  }
  const end = () => { t.removeAttribute("contenteditable"); t.onkeydown = null; t.onblur = null; };
  const commit = () => {
    const name = t.textContent.trim();
    end();
    if (name && name !== old){
      t.textContent = name;
      if (el.tocTitle) el.tocTitle.textContent = name;
      fetch("/title?box=" + encodeURIComponent(id), { method: "POST", body: name })
        .then(() => poll()).catch(() => {});
    } else if (!name && !old){
      // naming walked away from: the server hands out a whimsical name
      fetch("/title?box=" + encodeURIComponent(id), { method: "POST" })
        .then(() => poll()).catch(() => {});
    } else t.textContent = old;
  };
  t.onkeydown = e => {
    e.stopPropagation();   // card-switching keys must not fire while naming
    if (e.key === "Enter"){ e.preventDefault(); commit(); el.ta.focus(); }
    else if (keyboardTitle && e.key === "Tab"){ e.preventDefault(); commit(); (e.shiftKey ? el.arc : el.ta).focus(); }
    else if (e.key === "Escape"){
      if (!old && !t.textContent.trim()) commit();
      else { end(); t.textContent = old; }
      if (keyboardTitle) el.ta.focus();
    }
  };
  t.onblur = () => { if (t.isContentEditable) commit(); };
}

// after a send, move to the next YELLOW card: one awaiting his read, never a
// green working card or a grey queued one. opts go to select as they are; the
// desktop asks for focus. answers with the card it landed on, or nothing when
// there was none to land on
function jumpNextYellow(fromId, opts, source){
  if (!lastState) return;
  // stay inside the tab being looked at: sending from doing must never land on
  // a deferred or done card
  const p = (source || viewPool(lastState)).filter(b =>
    !b.done && !(b.writing || b.bg) && b.ball === "you" && b.id !== fromId);
  if (!p.length) return;
  // the send should land on the card that has waited on him
  // longest, not the newest. agentTs is written in the same breath as the turn
  // going back to him, so it marks when a card became his to read; ts moves on
  // his own sends and on progress notes too, so it cannot mean that. a card the
  // agent has never answered has only its own ts to age by, and one carrying
  // neither stamp cannot be aged, so it sorts last instead of posing as the
  // oldest thing here. the filter above already made a fresh array, so nothing
  // else sees this sort, and equal stamps keep the list's own order
  const waitingSince = b => b.agentTs || b.ts || Number.MAX_SAFE_INTEGER;
  const listOrder = new Map(p.map((b, i) => [b.id, i]));
  p.sort((a, b) => waitingSince(a) - waitingSince(b) || listOrder.get(a.id) - listOrder.get(b.id));
  select(p[0].id, opts);
  return p[0].id;
}

// ---- older replies --------------------------------------------------------------------
// the card steps back through its past agent replies and returns toward live:
// the desktop on control shift up and down, the phone on the two arrows in the
// card's top bar. While an older reply shows, dataset.raw keeps holding the
// live text, so apply()'s rewrite guard leaves the view alone across polls; an
// actual new reply changes the raw, which drops the cached thread and snaps the
// card back to live.
const histCache = {};   // box id -> promise of past agent replies, oldest first, live excluded
let hist = null;        // {id, step} while an older reply shows; step 1 = one back from live

function histList(id){
  if (!histCache[id]){
    let request;
    request = fetch("/thread?box=" + encodeURIComponent(id) + "&n=200")
      .then(x => {
        if (!x.ok) throw new Error("history request failed");
        return x.json();
      })
      .then(r => {
        const list = (r.messages || []).filter(m => m.kind === "agent").map(m => m.replyFull ?? m.text);
        // the newest transcript entry is normally the live reply itself
        if (list.length && els[id] && list[list.length - 1] === els[id].reply.dataset.raw) list.pop();
        return list;
      })
      .catch(() => {
        // A newer card version may already own this slot. An older rejection
        // must clear only its own failed request, then a later sync can retry.
        if (histCache[id] === request) delete histCache[id];
        return [];
      });
    histCache[id] = request;
  }
  return histCache[id];
}

function histExit(id){
  const was = hist && hist.id === id;
  if (was) hist = null;
  const el = els[id];
  if (!el) return;
  el.box.classList.remove("histview");
  el.histPos.textContent = "";
  el.histUp.disabled = false;
  el.histDown.disabled = true;
  if (was){
    el.reply.innerHTML = fmt(el.reply.dataset.raw);
    el.reply.scrollTop = 0;
  }
}

async function histStep(id, dir){   // +1 steps older, -1 steps back toward live
  if (!id || !els[id]) return;
  const list = await histList(id);
  if (id !== selectedId || !els[id] || !list.length) return;   // card changed or nothing older
  const cur = hist && hist.id === id ? hist.step : 0;
  const step = Math.min(Math.max(cur + dir, 0), list.length);
  if (step === cur) return;
  if (!step){ histExit(id); return; }
  hist = { id, step };
  const el = els[id];
  el.reply.innerHTML = fmt(list[list.length - step]);
  el.reply.scrollTop = 0;
  el.box.classList.add("histview");
  el.histPos.textContent = (list.length - step + 1) + " of " + (list.length + 1);
  el.histUp.disabled = step >= list.length;
  el.histDown.disabled = false;
}

// ---- the list's spinner ----------------------------------------------------------------
// while a row works its age is noise; the slot carries a terminal spinner
// instead. one interval serves every green row and only lives while one
// exists; each rebuild stamps the current frame itself, so the ticker and the
// poll-driven re-renders never fight over the text. ages return on the next
// quiet poll.
const SPIN_FRAMES = ["|","/","-","\\"];   // the classic terminal spinner, bolder than braille dots
let spinFrame = 0, spinTimer = null;
function syncSpinner(){
  const has = document.querySelector("#tiklist .trow.working");
  if (has && spinTimer == null){
    spinTimer = setInterval(() => {
      const ages = document.querySelectorAll("#tiklist .trow.working .tage");
      if (!ages.length){ clearInterval(spinTimer); spinTimer = null; return; }
      spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
      for (const a of ages) a.textContent = SPIN_FRAMES[spinFrame];
    }, 180);
  } else if (!has && spinTimer != null){
    clearInterval(spinTimer); spinTimer = null;
  }
}
