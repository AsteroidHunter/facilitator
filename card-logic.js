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
function attachmentNotice(ta, text){
  const parent = ta.closest(".pendwrap") || ta.closest(".c3bar") || ta.parentElement;
  let note = parent.querySelector(".attachment-status");
  if (!note){
    note = document.createElement("div");
    note.className = "attachment-status";
    note.setAttribute("role", "status");
    parent.appendChild(note);
  }
  note.textContent = text;
}

async function uploadAttachment(file){
  const info = CardMarkdown.attachmentFile(file);
  if (info.error) throw new Error(info.error);
  const response = await fetch("/upload?name=" + encodeURIComponent(info.name), { method: "POST", body: file });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.url) throw new Error(result?.error || "Upload failed. Please try again.");
  return result.url;
}

async function attach(files, ta){
  const errors = [];
  for (const file of files){
    try {
      const url = await uploadAttachment(file);
      const start = ta.selectionStart, end = ta.selectionEnd, direction = ta.selectionDirection;
      ta.value += (ta.value && !ta.value.endsWith("\n") ? "\n" : "") + url + "\n";
      ta.setSelectionRange(start, end, direction);
      const field = globalThis.ComposeFormat?.fieldOf(ta);
      if (field) field.changed();
      else ta.dispatchEvent(new Event("input"));
    } catch (error){
      errors.push((file.name || "Attachment") + ": " + (error.message || "Upload failed. Please try again."));
    }
  }
  attachmentNotice(ta, errors.join("\n"));
}

function wireAttachmentTransfer(ta, pick = files => attach(files, ta)){
  ta.addEventListener("dragover", event => {
    if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
    event.preventDefault(); ta.classList.add("dropping");
  });
  ta.addEventListener("dragleave", () => ta.classList.remove("dropping"));
  for (const type of ["drop", "paste"]){
    ta.addEventListener(type, event => {
      const data = type === "drop" ? event.dataTransfer : event.clipboardData;
      const files = [...(data?.files || [])];
      if (!files.length) return;
      event.preventDefault(); ta.classList.remove("dropping");
      pick(files);
    }, true);
  }
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

// ---- the moon: the tap is the state, the board is the witness -----------------
// A tap on the moon changes the card on screen at once and the board is told
// after, because the board's answer can be a second or more away while the card
// being tapped is the card being looked at. What stands on screen until the
// board answers is this page's own held tap, kept card by card the way the tab
// bar's record and the read marks are kept here: the newest tap wins, a reading
// asked for before the board answered that tap may not repaint the card, and an
// answer to a tap that has since been reversed changes nothing.
//
// Reversing is what the second tap is for, not an accident of it: a tap while
// the first request is still out flips the card back at once and the board is
// told the latest requested value. The chip is never disabled, every tap is
// drawn immediately, and pending taps keep the latest value to send next.
//
// One request per card at a time. A newer tap while one is out is drawn at once
// and sent the moment that one answers, because two requests for one card carry
// two absolute values and can land in the other order, and then the board would
// keep the value that was undone.
//
// That is not enough on its own, and this is the part worth stating plainly:
// GIVING UP ON AN ANSWER DOES NOT STOP THE REQUEST. A deadline here abandons
// the answer; the bytes are already travelling and the board will still act on
// them. So a snooze that timed out can arrive after the unsnooze that replaced
// it and overwrite it, and no amount of care on this side can prevent that.
// Every attempt therefore names this page's own command stream and its place in
// it, and the board refuses a place it has already passed. Ordering is the
// board's to enforce because only the board sees the arrivals.
//
// Nothing here says the board has it until the board has said so, and a 2xx
// alone is not the board saying so: an answer that cannot be read, an empty
// one, or one that never says it did the thing leaves this page not knowing,
// which is held as not knowing rather than called a success. A tap still
// travelling wears flagwait, a tap the board refused goes back to the board's
// word with the reason left on the card, and a tap nobody can confirm is held,
// plainly unconfirmed, until a reading settles it or the window ends it.
//
// And a tap is never quietly dropped for looking unnecessary. A tap whose value
// happens to match the last reading is still sent, because a reading is not a
// promise about what an older command still in transit will do when it lands.
// Until the board has answered the value on screen, the hold belongs to the tap
// and no reading may retire it.
const FLAG_KINDS = {
  park: { kind: "park", field: "parked", cls: "parked", word: "snooze" },
  done: { kind: "done", field: "done", cls: "done", word: "done" },
};
const FLAG_DEADLINE_MS = 8000;   // the phone's own reading carries the same one
const FLAG_HOLD_MS = 20000;      // the longest an unanswered tap may stand on screen
const flagHolds = {};            // id + "/" + kind -> the tap this page is standing behind
let flagTaps = 0;                // every attempt is numbered: its place in this page's stream
let flagStream = "";             // this page load's own name for that stream

function flagKey(id, kind){ return id + "/" + kind; }
function flagSpec(kind){ return FLAG_KINDS[kind] || FLAG_KINDS.park; }
// what a note calls the tap it is about, which is the direction it asked for.
// Neither "tap" nor "click": one line serves the phone and the desktop
function flagWord(spec, want){
  return spec.kind === "park" ? (want ? "snooze" : "unsnooze") : want ? spec.word : "un" + spec.word;
}
// why the board says it kept what it had, in the words of the tap it is about
function flagStaleWord(spec, sent, why){
  const word = flagWord(spec, sent);
  if (why === "message") return spec.kind === "park"
    ? "snooze skipped: a new message arrived" : word + " skipped: a new message arrived";
  if (why === "superseded") return word + " skipped: a newer tap replaced it";
  return word + " skipped: the card changed";
}
function flagDeadline(){
  try { return AbortSignal.timeout(FLAG_DEADLINE_MS); } catch (err) { return undefined; }
}
// this page load's name for its own command stream, made on the first tap, so
// nothing in this file still runs on load. Letters and digits only, short, and
// this page load's alone: it names who is asking, never what is being asked
// for. A reload is a new stream, and a command left over from before a reload
// is therefore not ordered against the new page's commands
function flagStreamOf(){
  if (!flagStream) flagStream = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return flagStream;
}

// what the card is showing this moment: this page's held tap where there is
// one, the class the last reading painted otherwise. The tap is read from here
// rather than from the class alone, so two taps inside one request's time ask
// for two different things instead of the same thing twice
function flagShown(id, kind){
  const hold = flagHolds[flagKey(id, kind)];
  if (hold) return hold.want;
  const spec = flagSpec(kind);
  const el = els[id];
  if (el && el.box) return el.box.classList.contains(spec.cls);
  const b = lastState && lastState.boxes.find(x => x.id === id);
  return !!(b && b[spec.field]);
}

function toggleFlag(id, kind){ return setFlag(id, kind, !flagShown(id, kind)); }

// one card's wanted state, true on screen at once and asked of the board after.
//
// The order of the steps below is load bearing. The intent is written down and
// sent BEFORE anything is redrawn, because redrawing runs the pass that
// reconciles holds, and a hold reconciled away in the middle of this function
// is an intent that is never sent at all. That is not hypothetical: a reversal
// whose value happens to agree with the last reading looks like nothing to do
// to that pass, exactly when it matters most, since the older command it is
// there to overtake may still be on its way to the board.
function setFlag(id, kind, want){
  const spec = flagSpec(kind);
  const key = flagKey(id, kind);
  const hold = flagHolds[key] || (flagHolds[key] = { id, kind, truth: null, boxRef: null, sending: 0 });
  hold.want = want;
  hold.owed = true;           // said on screen, not yet said to the board
  hold.until = Date.now() + FLAG_HOLD_MS;
  hold.basis = serverNow();   // the board's own clock at this tap, for the board to judge it by
  hold.settled = false;
  clearTimeout(hold.timer); hold.timer = null;
  flagNote(id, "");           // the last failure is answered by this tap
  paintFlag(id, spec, want, true);                                  // the card, in this same turn
  const going = hold.sending ? Promise.resolve() : sendFlag(key);   // the board, before any redraw
  flagRepaint();                                                    // the list, the tabs, the place
  return going;
}

// a hold with a command owed or a command out is nobody else's to retire: the
// board has not answered the value this page is holding, and an older command
// of this page's own may still be travelling towards it
function flagBusy(hold){ return !!hold.sending || !!hold.owed; }

async function sendFlag(key){
  const hold = flagHolds[key];
  if (!hold || hold.sending) return;
  const want = hold.want, tap = ++flagTaps;
  hold.sending = tap;
  hold.guard = Infinity;   // while this is out, no reading knows enough to repaint the card
  const url = "/" + hold.kind + "?box=" + encodeURIComponent(hold.id) + "&v=" + (want ? 1 : 0) +
    // this page's own command stream and this attempt's place in it. Abandoning
    // an answer does not recall a request, so an attempt this page has already
    // replaced can still arrive last; the board refuses a place it has passed
    "&sid=" + encodeURIComponent(flagStreamOf()) + "&seq=" + tap +
    // the moment of the tap, on the board's clock: a snooze that crossed a
    // message on the way is a snooze decided before that message existed
    (want && hold.basis ? "&after=" + encodeURIComponent(hold.basis.toFixed(3)) : "");
  let status = 0, body = null, lost = "";
  try {
    const r = await fetch(url, { method: "POST", signal: flagDeadline() });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (err){
    lost = err && err.name === "TimeoutError" ? "timeout" : "network";
  }
  flagAnswered(key, tap, want, status, body, lost);
}

// What an answer is worth, in one place. The four outcomes are kept apart on
// purpose, because they call for four different things: an acknowledgment, a
// refusal, a reason for keeping the old value, and not knowing.
function flagAnswered(key, tap, sent, status, body, lost){
  const hold = flagHolds[key];
  if (!hold || hold.sending !== tap) return;   // a newer tap owns this card; this answer is history
  hold.sending = 0;
  const spec = flagSpec(hold.kind);
  const ok = status >= 200 && status < 300;
  // only an object can be read as an answer. A body that is null (unreadable
  // JSON), a string, or anything else is no answer at all, whatever the status
  const answer = body && typeof body === "object" ? body : null;
  const said = answer && typeof answer[spec.field] === "boolean" ? answer[spec.field] : null;
  const why = answer && answer.ok === false && typeof answer.stale === "string" ? answer.stale : "";
  if (hold.want !== sent){ sendFlag(key); return; }   // the card was tapped again; that is what goes
  // from here the value on screen is the value the board has been told, so the
  // hold stops being this page's to protect and becomes the board's to answer
  hold.owed = false;
  if (lost){ flagUnsure(key, spec); return; }         // the request may well have landed
  if (!ok){
    // a definite refusal: the board answered and did not do it. The card goes
    // back to the board's word with the reason in plain sight, and the chip is
    // live, so one more tap asks again for exactly the same thing
    flagTell(hold.id, spec, said,
      flagWord(spec, sent) + " failed (" + (status || "no answer") + "): try again");
    poll();
    return;
  }
  if (why === "superseded" && said != null && said === hold.want){
    // an attempt this page itself replaced, arriving after the one that
    // replaced it. The board is already on the value the card is showing, so
    // there is nothing to undo and nothing worth saying
    hold.guard = Date.now();
    hold.settled = true;
    paintFlag(hold.id, spec, hold.want, false);
    poll();
    return;
  }
  if (why){
    // the board kept what it had and said why: a message reached the card
    // first, or a newer tap of this page's own got there first. Nothing was
    // applied, and this is not a failure to retry
    flagTell(hold.id, spec, said, flagStaleWord(spec, sent, why));
    poll();
    return;
  }
  if (answer && answer.ok === false){
    // an explicit no with no reason given. Nothing was applied, so the card
    // goes back to the board's word and the chip asks again
    flagTell(hold.id, spec, said,
      flagWord(spec, sent) + " refused by the board: try again");
    poll();
    return;
  }
  if (!answer || answer.ok !== true){
    // 2xx and nothing else. An answer that cannot be read, an empty one, or one
    // that never says it did the thing is not an acknowledgment, and calling it
    // one would leave a snooze on screen that the board may never have made.
    // The request may still have landed, so nothing is taken back either
    flagUnsure(key, spec);
    return;
  }
  // ok:true, which is the acknowledgment, and all an older board ever sent. The
  // moment it answered is the guard: a reading asked for before now knows
  // nothing of this card and may not repaint it
  hold.guard = Date.now();
  hold.settled = true;
  paintFlag(hold.id, spec, hold.want, false);
  poll();
}

// the board has not said yes and has not said no. Nothing is taken back, since
// the request may have landed, and nothing is called confirmed, since it may
// not have: the card keeps the tap, keeps saying it is unconfirmed, and the
// readings that follow settle it. If none ever does, the window ends it with a
// plain word rather than leaving a snooze standing on an unchanged board
function flagUnsure(key, spec){
  const hold = flagHolds[key];
  if (!hold) return;
  hold.guard = Date.now();
  hold.settled = false;
  paintFlag(hold.id, spec, hold.want, true);
  flagWindow(key);
  poll();
}

// an answer that never came cannot hold a card for ever
function flagWindow(key){
  const hold = flagHolds[key];
  if (!hold) return;
  clearTimeout(hold.timer);
  hold.timer = setTimeout(() => flagExpire(key), Math.max(0, hold.until - Date.now()));
}
function flagExpire(key){
  const hold = flagHolds[key];
  if (!hold || flagBusy(hold) || hold.settled) return;
  const spec = flagSpec(hold.kind);
  flagTell(hold.id, spec, null, flagWord(spec, hold.want) + " not confirmed: try again");
}

// the board's word wins and the reason stays on the card: the hold ends, the
// card goes back to what the board last said (or to what this very answer
// said, which is newer), and the note stands until the next tap. No reading
// clears it, which is the whole of its worth
function flagTell(id, spec, said, text){
  const key = flagKey(id, spec.kind);
  const hold = flagHolds[key];
  if (hold && hold.truth && said != null && hold.truth[spec.field] !== said){
    hold.truth[spec.field] = said;
    hold.truth.state = null;   // the flag this answer named is newer than the state beside it
  }
  // the board's word for this card: the answer's own, else the last reading's,
  // else the state the card stood in before the tap that has just been refused
  const back = said != null ? said
             : hold && hold.truth ? !!hold.truth[spec.field]
             : hold ? !hold.want : flagShown(id, spec.kind);
  dropFlag(key);
  paintFlag(id, spec, back, false);
  flagNote(id, text);
  flagRepaint();
}

// the card's own note line, under whichever of the two names the page gives it.
// A note written here is this page's record of a tap the board refused or never
// answered, so the pass over the cards is told to leave it where it is.
//
// The order of the two names matters and is not a preference. metaNote is the
// note element itself, which is the node the desktop's own pass reads and
// writes; meta is the phone's note element under its own name, but on the
// desktop that name belongs to the box the note element lives in. Writing text
// to a box throws away the children it has, so choosing it first would delete
// the very note element the page holds a reference to: the page would keep a
// detached node, its guard would sit on the wrong node, and nothing written
// through that reference afterwards would ever be seen again. The note element
// is chosen where the page has one, its wrapper is left alone, and the text,
// the guard and the clearing all land on that one connected node.
function flagNote(id, text){
  const el = els[id];
  const note = el && (el.metaNote || el.meta);
  if (!note) return;
  note.textContent = text || "";
  if (text) note.dataset.flagnote = "1";
  else delete note.dataset.flagnote;
}

function paintFlag(id, spec, want, waiting){
  const el = els[id];
  if (!el || !el.box) return;
  el.box.classList.remove("peek");   // the desktop's peek; nothing on the phone wears it
  el.box.classList.toggle(spec.cls, want);
  if (spec.cls === "parked" && want) el.box.classList.remove("done");   // the board's own rule
  el.box.classList.toggle("flagwait", !!waiting);
}

// the hold is over: what the board said goes back into the card it was taken
// from, so the pass that draws next draws the board and not this page's tap
function dropFlag(key){
  const hold = flagHolds[key];
  if (!hold) return;
  clearTimeout(hold.timer);
  if (hold.boxRef && hold.truth){
    hold.boxRef.parked = hold.truth.parked;
    hold.boxRef.done = hold.truth.done;
    hold.boxRef.state = hold.truth.state;
  }
  delete flagHolds[key];
  const el = els[hold.id];
  if (el && el.box) el.box.classList.remove("flagwait");
}

// the pass a reading goes through before anything is drawn from it. A card this
// page is holding a tap for is shown the way it was left, with the reading's own
// word for it kept aside to go back to; a reading new enough to judge the tap
// either agrees with it, which ends the hold, or carries something newer, which
// ends it too. Every colour, list, sort and tab reads the boxes, so holding the
// tap here is the whole board following the tap rather than the chip alone
let flagDrawing = false;   // a pass is running; a repaint asked for inside it is that pass's own
function holdFlags(state){
  if (!state || !Array.isArray(state.boxes)) return state;
  const asked = state.fetchedAt || 0;
  flagDrawing = true;
  try { holdFlagsPass(state, asked); } finally { flagDrawing = false; }
  return state;
}
function holdFlagsPass(state, asked){
  for (const key of Object.keys(flagHolds)){
    const hold = flagHolds[key];
    if (!hold) continue;   // an end reached inside this same pass
    const spec = flagSpec(hold.kind);
    const b = state.boxes.find(x => x.id === hold.id);
    if (!b){ dropFlag(key); continue; }   // the card is gone and so is the tap
    // a box this page has not already written into is the reading's own word
    // for the card. A pass over cards this page has already held (a redraw, or
    // the phone's unchanged answer, which moves the clock and brings no cards)
    // carries no word about this card at all, and a hold may never be judged
    // by a word its reading did not bring
    const fresh = hold.boxRef !== b;
    if (fresh) hold.truth = { parked: b.parked, done: b.done, state: b.state };
    if (fresh && !flagBusy(hold) && asked >= hold.guard){
      if (hold.truth[spec.field] === hold.want){ dropFlag(key); continue; }   // the board agrees
      // the board had this tap and something newer has changed the card since:
      // a message sent to it, a close, another device. That is the board's to
      // say, and a held tap must not put it back
      if (hold.settled){ dropFlag(key); continue; }
      if (Date.now() >= hold.until){ flagExpire(key); continue; }
    }
    b[spec.field] = hold.want;
    if (spec.cls === "parked" && hold.want) b.done = false;
    b.state = hold.want ? spec.cls : cardState({ ...b, [spec.field]: false, state: null });
    hold.boxRef = b;
  }
}

// what the page draws from, drawn again now. The tapped card has already
// changed; this is the list, the tabs and the card's place following it
function flagRepaint(){
  if (flagDrawing) return;   // the pass that is running draws it
  if (typeof apply !== "function") return;
  const state = typeof lastState === "undefined" ? null : lastState;
  if (!state) return;
  try { apply(holdFlags(state)); }
  catch (err){ if (typeof reportProblem === "function") reportProblem("render", err); }
}

// the board's clock, now, as this page can best tell it: the last reading
// carried the board's own time and the moment it was asked for. It is the
// board's clock and not this device's, which is what makes it safe to compare
// against times the board itself wrote. Zero when no reading has carried one,
// and a request with no basis simply sends none and is judged as it always was
function serverNow(){
  const state = typeof lastState === "undefined" ? null : lastState;
  if (!state || typeof state.now !== "number" || !state.fetchedAt) return 0;
  return state.now + (Date.now() - state.fetchedAt) / 1000;
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
// actual new reply changes the raw, which drops the cached history and snaps
// the card back to live.
const histCache = {};   // box id -> promise of past agent replies, oldest first, live excluded
let hist = null;        // {id, step} while an older reply shows; step 1 = one back from live
// what a history request that failed answers with. Every caller that only
// walks the list sees the empty list it always saw, and a caller that has to
// tell "nothing older" apart from "could not find out" compares against this
// exact list: a request that failed says nothing about the card, so it must
// not be read as the card having no older replies
const HIST_UNKNOWN = Object.freeze([]);

// the pages this card's arrows can step back to, oldest first. The board
// answers it whole: only final replies, the live page already left out, and
// its length is the olderReplies count the card was sent with. Which rows are
// pages of a history, and which one the card is on, are decided in the one
// place that can be right about both, so a page never has to filter a window
// of mixed rows or guess the live page by matching its text
function histList(id){
  if (!histCache[id]){
    let request;
    request = fetch("/history?box=" + encodeURIComponent(id))
      .then(x => {
        if (!x.ok) throw new Error("history request failed");
        return x.json();
      })
      .then(r => r.replies || [])
      .catch(() => {
        // A newer card version may already own this slot. An older rejection
        // must clear only its own failed request, then a later sync can retry.
        if (histCache[id] === request) delete histCache[id];
        return HIST_UNKNOWN;
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
