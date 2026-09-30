// Parked for v0: the quick note's corner peek, card chip and overlay wiring. index.html does not load this file.
// Three small hooks went out of index.html with it, and come back with it: the `qnOpen` flag (declared beside
// `setOpen`, and `!qnOpen &&` in boardKeysLive), `const noteCards = quickNotesByCard(state.quicknotes);` before the
// per-card loop in the board refresh, and `syncQuickNoteChip(el, noteCards[b.id] || []);` after syncOmniCard(el, b).
// The styles are in parked/quick-note.css. The server side is behind QUICK_NOTES_ON in server.py.
// ---- the quick note ------------------------------------------------------------
// the overlay and the session that saves it are the shared ones in card-logic.js;
// this page's own part is the way in, its bottom right corner, and the chip on a
// card a note is attached to. while the overlay is up the board's keys are off
// (qnOpen in boardKeysLive), since the board they would act on is covered
const quickNote = quickNoteOverlay(document.body, {
  fetch: (url, init) => fetch(url, init),
  storage: localStorage,
  boxes: () => (lastState && lastState.boxes) || [],
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: id => clearTimeout(id),
  onOpen(){ qnOpen = true; qnPeekHide(); },
  onClose(){ qnOpen = false; },
  // the card's one warning, words that could not be saved, is worn by the peek
  // too, so a note put away with its words unsaved still says so at the corner
  onChange(session){ qnPeek.classList.toggle("failed", session.status === "failed"); },
  // the block caret is the board's own, drawn over the field; it is placed
  // again once the card has glided into the middle
  onMoved(){ queueFatCaret(); },
});
// the corner: the pointer going into the window's bottom right corner brings a
// small piece of the note's card peeking out of it, and a press on that piece
// pulls the note into the middle of the window. the corner is read off where
// the pointer is rather than caught by an element laid over it, so nothing on
// the board ever loses a click to an invisible catcher, and the piece itself is
// wholly past the corner until it is called. only a mouse has a corner to go
// to: a touch, a pressed button (a drag or a selection running into the
// corner), the layout being edited and a window already holding the keys never
// wake it
const QN_CORNER = 12;           // px: the square at the corner that wakes the peek
const QN_PEEK_LEAVE_MS = 450;   // how long the pointer may be off the peek before it goes
const qnPeek = h("button", "qnpeek qn-glass");
qnPeek.type = "button";
qnPeek.tabIndex = -1;
qnPeek.setAttribute("aria-label", "open a quick note");
document.body.appendChild(qnPeek);
let qnPeekOut = false, qnPeekTimer = null;
function qnCornerLive(){
  return !qnOpen && !setOpen && !editMode && !pageWarn && !pageMenu && !p3Zoom &&
         !document.body.classList.contains("dragging");
}
function qnPeekShow(){
  clearTimeout(qnPeekTimer);
  qnPeekTimer = null;
  if (qnPeekOut) return;
  qnPeekOut = true;
  qnPeek.classList.add("out");
}
function qnPeekHide(){
  clearTimeout(qnPeekTimer);
  qnPeekTimer = null;
  if (!qnPeekOut) return;
  qnPeekOut = false;
  qnPeek.classList.remove("out");
}
addEventListener("pointermove", e => {
  if (e.pointerType !== "mouse") return;
  const root = document.documentElement;
  if (e.clientX >= root.clientWidth - QN_CORNER && e.clientY >= root.clientHeight - QN_CORNER &&
      !e.buttons && qnCornerLive()){
    qnPeekShow();
    return;
  }
  if (!qnPeekOut) return;
  if (qnPeek.contains(e.target)){ clearTimeout(qnPeekTimer); qnPeekTimer = null; }
  else if (qnPeekTimer == null) qnPeekTimer = setTimeout(qnPeekHide, QN_PEEK_LEAVE_MS);
}, { passive: true });
qnPeek.addEventListener("click", () => quickNote.open(null, qnPeek.getBoundingClientRect()));
// a card with a quick note attached carries the chip in its top bar, the
// plainest mark there is, and a press opens the newest of its notes. the chip is
// made the first time the card has a note, so a card that never has one carries
// nothing extra, and it stands left of the three section chips, which keep their
// seats. where it finally sits is still to be settled with the owner
function syncQuickNoteChip(el, notes){
  if (!notes.length){
    if (el.qnchip) el.qnchip.hidden = true;
    return;
  }
  if (!el.qnchip){
    const made = el.qnchip = h("button", "qnchip");
    made.type = "button";
    made.tabIndex = -1;   // the card's own focus ring stays as it is
    made.addEventListener("click", e => {
      e.stopPropagation();
      if (made.dataset.note) quickNote.open(made.dataset.note, made.getBoundingClientRect());
    });
    el.topbar.insertBefore(made, el.sun);
  }
  const chip = el.qnchip;
  const label = notes.length === 1 ? "note" : notes.length + " notes";
  if (chip.textContent !== label) chip.textContent = label;
  chip.dataset.note = notes[0].id;
  chip.title = notes.length === 1 ? "open the note attached to this card"
                                  : "open the newest note attached to this card";
  chip.hidden = false;
}
