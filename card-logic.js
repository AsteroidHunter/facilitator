// The card's shared logic: what the desktop board (index.html) and the phone
// page (m.html) do to a card in common, kept once, as plain global functions.
// Each page loads it after card-markdown.js and before its own script. The
// functions here read the names each page declares itself: els (box id to the
// card's parts), lastState, selectedId, activeOwner, lastSel, and the page's own
// poll, select, boxBand and boxHasSelection. The chosen list view is the other way round: it is
// held here, one per project, and each page reads it through curView(). Nothing
// here runs on load.

// ---- what a page may set ----------------------------------------------------
// poolScope: a page that narrows the lane's pool further hands back the test to
// keep a card by, or null for the whole lane. the desktop narrows to the chosen
// workspace; the phone shows the lane whole
let poolScope = null;
// keyboardTitle: the desktop's keyboard path through a card's title. Tab commits
// the name and moves on to the composer, or back to the sun chip with shift,
// and Escape hands focus back to the composer. the phone has no keyboard path
let keyboardTitle = false;
// answeredRoomChanged: what a page does once the panel that stands ABOVE the
// answer, holding the messages that answer was given, has taken its room or
// given it back. it rides at the head of the answer's own scroller rather than
// being laid over the answer, so the room it takes is room the answer does not
// have, and the desktop re-snaps its lines against it whenever the panel
// arrives, leaves, or is opened or cut back. the panel of sent messages at the
// foot is told per card instead (el.sentRoom), since its room is a measure
// each card keeps for itself
let answeredRoomChanged = null;
// turnAgain: how a page draws its cards again from the board, once a new answer
// it held back while the reader was busy can be shown. the desktop asks the
// board; the phone draws the reading it already holds
let turnAgain = null;

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
  // Enter alone selects the card on screen and puts the caret in its
  // composer. only the desktop board answers it, and only where nothing is
  // being typed; the composers take their own Enter before it gets here
  {
    action: "enter", mini: false,
    match: e => e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented ? true : null,
  },
  // control+u unfolds the selected card's ticket while it wears the
  // ready-to-test fold, as a click on the folded corner does. nothing on this
  // mac, in chrome or in either shape of the composer answers control+u, so,
  // like control+s, it works from the card's own composer as well as anywhere
  // nothing is being typed
  {
    action: "unfold", mini: false,
    match: e => e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented &&
      (e.key === "u" || e.key === "U") ? true : null,
  },
  // control+enter moves to the card that has waited longest, as the second
  // Enter of a double Enter does. a composer sends what it holds and takes the
  // key itself, so only a press nothing else answered gets here. a held key's
  // repeats are recognized so the page can keep them from the browser
  {
    action: "advance", mini: false,
    match: e => controlEnter(e) && !e.isComposing && !e.defaultPrevented ? true : null,
  },
  // control+r jumps to a random card in the list whose ticket is neither green
  // nor grey
  {
    action: "random", mini: false,
    match: e => e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey &&
      !e.isComposing && !e.defaultPrevented &&
      (e.key === "r" || e.key === "R") ? true : null,
  },
  // control+shift+[, ] and \ move the selected card to Doing, Deferred and
  // Done, typing or not. macOS text boxes give these chords no meaning and the
  // composer's editor is told to leave them to the page (PAGE_CHORDS in
  // compose-format.js), which cancels them on the way, so an event already
  // cancelled still counts here
  {
    action: "sectionChord", mini: true,
    match: e => e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey &&
      !e.repeat && !e.isComposing ? sectionChordOf(e) : null,
  },
  // the same three keys alone do the same, but only while nothing is being
  // typed, which each page checks against where the key landed
  {
    action: "sectionKey", mini: true,
    match: e => !e.ctrlKey && !e.metaKey && !e.repeat && !e.isComposing &&
      !e.defaultPrevented ? sectionKeyOf(e) : null,
  },
  // control+s scrolls the selected card's response while held: down, or up
  // when a tap is followed at once by a hold. A held key's repeats are
  // recognized too, so the page can keep them from the editor and the browser,
  // and responseScrollKey never counts them as presses
  {
    action: "responseScroll", mini: false,
    match: e => responseScrollChord(e) && !e.defaultPrevented ? true : null,
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

// control and enter and nothing else: shift keeps its new line, command sends
// as plain Enter does, and option does nothing of the page's
function controlEnter(e){
  return e.key === "Enter" && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey;
}

// the two standing boxes sit in the lists but are not cards to walk to
function isStandingBox(id){ return id === "0" || id === "t0"; }

// a green ticket: work is under way on the card. a done card the agent still
// holds keeps its green, as its row keeps pulsing
function ticketGreen(b){
  return queueState(b) === "working" ||
    (queueState(b) === "done" && cardState({ ...b, done: false, parked: false, state: null }) === "working");
}

// a grey ticket: a message is waiting for the agent to pick it up
function ticketQueued(b){ return queueState(b) === "queued"; }

// the id of a random card in pool, never the one on screen, a standing box, a
// green ticket or a grey one; null when none is left
function pickRandomCard(pool, currentId, random = Math.random){
  const open = pool.filter(b => b.id !== currentId && !isStandingBox(b.id) && !ticketGreen(b) && !ticketQueued(b));
  return open.length ? open[Math.floor(random() * open.length)].id : null;
}

// ---- the three section keys ------------------------------------------------------
// The chord is read off the physical key first, since shift turns e.key into
// {, } or | and control can leave it unusual, and off the character when the
// event names no such key. A key alone is read off the character it types, so
// a layout whose bracket key types a letter never moves a card.
const SECTION_KEY_CODES = new Map([["BracketLeft", "doing"], ["BracketRight", "deferred"], ["Backslash", "done"]]);
const SECTION_KEY_CHARS = new Map([["[", "doing"], ["]", "deferred"], ["\\", "done"]]);
const SECTION_KEY_SHIFTED = new Map([["{", "doing"], ["}", "deferred"], ["|", "done"]]);

function sectionChordOf(e){
  return SECTION_KEY_CODES.get(e.code) || SECTION_KEY_CHARS.get(e.key) ||
    SECTION_KEY_SHIFTED.get(e.key) || null;
}
function sectionKeyOf(e){ return SECTION_KEY_CHARS.get(e.key) || null; }

// what each section's chip names in its tooltip, so the keys are written once
const SECTION_KEY_HINTS = {
  doing: "Control + Shift + [, or [ when not typing",
  deferred: "Control + Shift + ], or ] when not typing",
  done: "Control + Shift + \\, or \\ when not typing",
};

// Where the chord may come from: anywhere nothing is being typed, and the
// card's own composer in either shape (its textarea, or the editor that holds
// it). A title being renamed and every other field keep the chord.
function sectionChordSource(target, el){
  if (!cardShortcutEditing(target)) return true;
  if (!el || !el.ta) return false;
  if (target === el.ta) return true;
  const editor = target.closest(".cm-editor");
  return !!editor && editor.contains(el.ta);
}

// ---- scrolling the response with control+s ---------------------------------------
// Holding the chord scrolls the selected card's response slowly down from the
// first frame. Tapping s and pressing it again within the double tap window,
// with control still held, scrolls up instead. Letting go of s or control
// stops the motion at once. The response scroller (el.replyview) holds the
// live reply and a history step alike. macOS text boxes give control+s no
// meaning, so the chord works from the card's composer too.
const RESPONSE_TAP_MS = 300;
// CSS pixels per second
const RESPONSE_SCROLL_SPEED = 150;
// the longest frame gap counted, so a stalled page never catches up in a jump
const RESPONSE_FRAME_MAX_MS = 50;
// a press that finds nothing to scroll that way, or a hold that reaches the
// end, nudges the response's content this far along the pressed direction and
// back, so the key is seen to have landed
const RESPONSE_BOUNCE_PX = 7;
const RESPONSE_BOUNCE_MS = 250;
// the motion under way, or null
let responseScrolling = null;
// the last down press, kept so a quick second press can turn it into an up
let responseLastPress = null;
// the bounce's running animations, so a quick second one replaces the first
let responseBouncing = [];

function stopResponseScroll(){
  if (responseScrolling && responseScrolling.frame) cancelAnimationFrame(responseScrolling.frame);
  responseScrolling = null;
}

function dropResponseScroll(){
  stopResponseScroll();
  responseLastPress = null;
}

// control and s and nothing else, so control+shift+s is not the chord
function responseScrollChord(e){
  return e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing &&
    (e.key === "s" || e.key === "S");
}

// Whether the response can move at all in dir (1 down, -1 up): false when it
// does not scroll, or already stands at that end.
function responseCanScroll(view, dir){
  const room = Math.max(0, view.scrollHeight - view.clientHeight);
  return dir > 0 ? view.scrollTop < room : view.scrollTop > 0;
}

// The edge bounce: the content inside the scroller (the answered panel and the
// answer) goes RESPONSE_BOUNCE_PX the way the scroll would have carried it and
// eases back. It runs on the independent translate property through the
// animation API, so no scroll position, style, focus, caret or draft is
// written. Reduced motion gets none. True means a bounce was started.
function responseScrollBounce(view, dir){
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const parts = [...(view.children || [])].filter(part => typeof part.animate === "function");
  if (!parts.length) return false;
  for (const running of responseBouncing) running.cancel();
  const out = `0 ${-dir * RESPONSE_BOUNCE_PX}px`;
  responseBouncing = parts.map(part => part.animate([
    { translate: "0 0", easing: "cubic-bezier(.25, .8, .4, 1)" },
    { translate: out, offset: .4, easing: "cubic-bezier(.45, 0, .55, 1)" },
    { translate: "0 0" },
  ], { duration: RESPONSE_BOUNCE_MS }));
  return true;
}

// Where the chord may come from: the page itself, the card's own composer
// (its textarea, or the editor standing in for it), or the response. The sent
// box, the answered panel, the title and every other field keep the chord.
function responseScrollSource(target, el){
  const doc = el.replyview.ownerDocument;
  if (!target || target === doc || target === doc.body || target === doc.documentElement) return true;
  if (el.ta && target === el.ta) return true;
  const editor = typeof target.closest === "function" && target.closest(".cm-editor");
  if (editor) return !!el.ta && editor.contains(el.ta);
  return el.replyview.contains(target) && !cardShortcutEditing(target) &&
    !(el.pendwrap && el.pendwrap.contains(target)) &&
    !(el.answwrap && el.answwrap.contains(target));
}

// A press or a motion still stands only for the same card, drawn by the same
// render, in the same project, with the same focus, on a visible page, with its
// response still connected and laid out.
function responseScrollStands(was, card){
  const view = card && card.el && card.el.replyview;
  return !!view && card.id === was.id && card.owner === was.owner && card.el === was.el &&
    was.doc.activeElement === was.focus && was.doc.visibilityState !== "hidden" &&
    !(card.el.box && card.el.box.isConnected === false) && view.isConnected !== false &&
    view.clientHeight > 0;
}

function responseScrollFrame(at){
  const run = responseScrolling;
  if (!run) return;
  run.frame = 0;
  if (!responseScrollStands(run, run.find())){
    dropResponseScroll();
    return;
  }
  const view = run.el.replyview;
  const dt = Math.min(RESPONSE_FRAME_MAX_MS, Math.max(0, at - run.last));
  run.last = at;
  // the position is kept unrounded so slow motion is not lost to whole pixels,
  // and taken afresh when something else has moved the response
  if (Math.abs(view.scrollTop - run.pos) >= 1) run.pos = view.scrollTop;
  const room = Math.max(0, view.scrollHeight - view.clientHeight);
  run.pos = Math.max(0, Math.min(room, run.pos + run.dir * RESPONSE_SCROLL_SPEED * dt / 1000));
  if (run.pos !== view.scrollTop) view.scrollTop = run.pos;
  if ((run.dir < 0 && run.pos === 0) || (run.dir > 0 && run.pos === room)){
    // the motion stops here, so the hold that reached the end bounces once
    stopResponseScroll();
    responseScrollBounce(view, run.dir);
    return;
  }
  run.frame = requestAnimationFrame(responseScrollFrame);
}

// The chord's keydown. find is the page's word on which card may be scrolled
// now: { id, owner, el }, or null while a menu, panel, overlay or swipe stands
// over the card. It is asked on every press and on every frame, so motion stops
// on a card the reader has left. True means the chord was taken from the
// editor and the browser.
function responseScrollKey(event, find){
  const card = find();
  const view = card && card.el && card.el.replyview;
  if (!view || !(view.clientHeight > 0) || !responseScrollSource(event.target, card.el)){
    dropResponseScroll();
    return false;
  }
  event.preventDefault();
  // a held key's repeats neither restart the motion nor turn it round
  if (event.repeat) return true;
  const at = performance.now();
  const doc = view.ownerDocument;
  const press = { id: card.id, owner: card.owner, el: card.el, doc, focus: doc.activeElement, at };
  const last = responseLastPress;
  const up = !!last && last.released != null && at - last.at < RESPONSE_TAP_MS &&
    responseScrollStands(last, card);
  stopResponseScroll();
  // an up is never the first press of the next pair, so the press after it goes down
  responseLastPress = up ? null : press;
  const dir = up ? -1 : 1;
  // nothing to scroll that way: the press still counts toward a double tap,
  // but it bounces instead of starting a motion that would stop at once
  if (!responseCanScroll(view, dir)){
    responseScrollBounce(view, dir);
    return true;
  }
  responseScrolling = {
    ...press, find, dir, last: at, pos: view.scrollTop,
    frame: requestAnimationFrame(responseScrollFrame),
  };
  return true;
}

// Letting go of s stops the motion and keeps the press for the double tap
// window. Letting go of control stops it and forgets the press.
function responseScrollKeyUp(event){
  if (!event.ctrlKey || event.shiftKey || event.metaKey || event.altKey){
    dropResponseScroll();
    return;
  }
  if (event.key === "s" || event.key === "S"){
    stopResponseScroll();
    if (responseLastPress && responseLastPress.released == null) responseLastPress.released = performance.now();
  } else if (event.key === "Control"){
    dropResponseScroll();
  }
}

// Any other key, or the chord with a changed or added modifier (shift
// included), ends the motion and the double tap. The key itself is left alone.
// A repeat of control while it alone is held is not a change.
function responseScrollOtherKey(event){
  if (responseScrollChord(event)) return;
  if (event.key === "Control" && event.ctrlKey && !event.shiftKey &&
      !event.metaKey && !event.altKey) return;
  dropResponseScroll();
}

// The listeners that stop the motion are the page's own and are never gated by
// its overlays, so a release always lands. Losing the window or the page drops
// the motion too, in case its release never arrives.
function listenResponseScroll(){
  addEventListener("keydown", responseScrollOtherKey, true);
  addEventListener("keyup", responseScrollKeyUp, true);
  addEventListener("blur", dropResponseScroll);
  document.addEventListener("visibilitychange", dropResponseScroll);
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
  // the reader's side while a newer message is still in line, and that used to paint
  // the card yellow. only yours is rewritten, so done, parked and every
  // green state keep exactly the state they had
  return (shown === "yours" && b.pending > 0) ? "queued" : shown;
}
// the queue panel's view: a parked card sorts and colors as if open. state is
// nulled in the copy so cardState recomputes from the flags instead of handing
// back the server's "parked" when we peel the park off
function queueState(b){ return b.parked ? cardState({ ...b, parked: false, state: null }) : cardState(b); }
// The visible number a row shows before its title. Cards keep their internal
// ids for routing and never renumber from list position: an m-prefixed id (a
// card made on the board) shows its digits, an already-numeric seeded id shows
// as it is, and a purely non-numeric standing id shows none. The number is a
// plain figure with no # prefix.
// quick notes read card numbers through this function, so a change to the
// numbering has to be carried into the quick note system as well: in this
// file quickNoteRef and QUICK_NOTE_REF (the "card N", "cardN" and "cN" parser),
// quickNoteCard (figure to card), quickNoteAttachStep and the attachStep inside
// quickNoteSession (which card a note attaches to) and quickNotesByCard (the
// chip's grouping); in server.py _post_quicknote_new and _post_quicknote_attach
// (the attach routes, which take a card id) and _remove_empty_meta_box (frees a
// removed card's notes while QUICK_NOTES_ON is set); in parked/quick-note.js
// syncQuickNoteChip (the note chip); and the tests quick-note-refs.test.cjs and
// quick-notes.test.cjs. the quick note is hidden in this version and kept so it
// can come back
function ticketNum(id){
  const s = String(id == null ? "" : id);
  const m = /^m(\d+)$/.exec(s);
  if (m) return m[1];
  if (/^[0-9]/.test(s)) return s;
  return "";
}
// Omni Ticket v0 is a presentation derived from its canonical title. The card
// itself keeps the same id, routes and state as every other card. Three supplied
// artworks are defined today; later ticket numbers cycle through them without
// adding a stored variant field, so adding artwork later stays a local mapping.
function omniTicket(title){
  const match = /^Omni Ticket #([1-9]\d*)$/.exec(String(title == null ? "" : title));
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number)) return null;
  const variant = ((number - 1) % 3) + 1;
  return { number, variant, src: "/assets/ticket-" + variant + ".webp" };
}
function omniArt(info, cls){
  const image = h("img", cls);
  image.src = info.src;
  image.alt = "";
  image.draggable = false;
  image.dataset.variant = String(info.variant);
  image.setAttribute("aria-hidden", "true");
  return image;
}
// The card itself reads "Omni Card #N" while the ticket rows keep the stored
// "Omni Ticket #N", so the two teach a ticket and a card apart. Only the words
// on the card change: the stored title, the numbering and identity all stay
// the canonical ones.
function omniCardTitle(title){
  const info = omniTicket(title);
  return info ? "Omni Card #" + info.number : String(title == null ? "" : title);
}
// The words that ask the board for an Omni ticket, kept character for character
// with the server's _omni_entry so the page and the board can never read one
// title two ways. The title's first line, cut at 80 characters the way a stored
// title is, is split on white space, lowercased and read as a set of words, and
// it asks only when that set is exactly {omni}, {omni, card} or {omni, ticket},
// or one of the last two with one number, written N or #N: a whole number from
// 1 with no leading zero, no larger than a script holds exactly. Order and
// repeats do not matter, so "ticket omni" asks too; any other word, a second
// number or a bare {omni, N} does not.
const OMNI_MAX = Number.MAX_SAFE_INTEGER;
const OMNI_BREAK = /[\n\r\v\f\x1c\x1d\x1e\x85\u{2028}\u{2029}]/u;
const OMNI_SPACE = /[\t\n\v\f\r \xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/u;
const OMNI_NUMBER = /^#?([1-9][0-9]*)$/;
function omniEntry(text){
  const line = String(text == null ? "" : text).split(OMNI_BREAK)[0].slice(0, 80);
  const words = new Set(line.toLowerCase().split(OMNI_SPACE).filter(Boolean));
  if (!words.delete("omni")) return false;
  let kinds = 0, numbers = 0;
  for (const word of words){
    const match = OMNI_NUMBER.exec(word);
    if (word === "card" || word === "ticket") kinds++;
    else if (match && Number(match[1]) <= OMNI_MAX) numbers++;
    else return false;
  }
  return kinds <= 1 && numbers <= (kinds ? 1 : 0);
}
// the number the board gives the next Omni ticket in a lane, counted the way
// the server counts it: the highest canonical number already there, plus one.
// the card shows it the moment the word is committed, and the next reading of
// the board writes the server's own number over it should the two differ
function omniNextNumber(boxes, owner){
  let top = 0;
  for (const b of boxes || []){
    if ((b.owner || "facilitator") !== owner) continue;
    const info = omniTicket(b.title);
    if (info && info.number > top) top = info.number;
  }
  return top + 1;
}
// what a committed title does to the card's Omni face: dir is "in" as the card
// becomes Omni and "out" as it stops being one, and sweep is false where the
// reader asked for reduced motion, so the face simply changes. a name left as
// it was, or one that keeps the card on the side it was on, asks for nothing
function omniRetitle(wasOmni, shown, typed, reduced){
  const name = String(typed == null ? "" : typed).trim();
  if (!name || name === shown) return null;
  const becomes = omniEntry(name);
  const dir = becomes && !wasOmni ? "in" : !becomes && wasOmni ? "out" : null;
  return dir ? { dir, sweep: !reduced } : null;
}
// Keep an expanded card in step when an inline rename crosses into or out of
// the canonical Omni title. Ticket-list rows rebuild on title changes already.
// a sweep in flight owns the card's face until it lands, so a reading that
// arrives meanwhile is kept for it and drawn once the light has passed
function syncOmniCard(el, b){
  if (!el || !el.box || !el.titleEl) return null;
  if (el.omniSweep){ el.omniSweep.latest = b; return omniTicket(b && b.title); }
  return paintOmniCard(el, b);
}
function paintOmniCard(el, b){
  const info = omniTicket(b && b.title);
  el.box.classList.toggle("omni-card", !!info);
  if (el.toc) el.toc.classList.toggle("omni-card", !!info);
  const head = el.titleEl.parentNode;
  let image = head && head.querySelector(".omni-card-art");
  if (!info){ if (image) image.remove(); return null; }
  if (!image){ image = omniArt(info, "omni-card-art"); head.insertBefore(image, el.titleEl); }
  image.src = info.src;
  image.dataset.variant = String(info.variant);
  return info;
}
function appendOmniRowArt(row, inner, b){
  const info = omniTicket(b && b.title);
  if (!info) return null;
  row.classList.add("omni-ticket");
  inner.appendChild(omniArt(info, "omni-art"));
  return info;
}

// ---- the Omni sweep ------------------------------------------------------------
// sunlight crosses the whole card on its diagonal as a committed title makes it
// an Omni card, from the bottom left corner to the top right, and a glint
// tings on that corner the moment the light reaches it. a card leaving Omni
// takes the same light back the other way, top right to bottom left, with no
// glint. the title's words and the art change under the light, in the frame
// its centre passes them. the light itself is drawn by the page's .omni-sweep
// rule and the glint by its .omni-glint; this moves the one and places the other
const OMNI_SWEEP_MS = 600;
// how far the light reaches either side of its centre, on the sweep's own 0..1
// measure: the page's widest falloff, so the run starts and ends with none of it on the card
const OMNI_SWEEP_REACH = 0.24;
const OMNI_GLINT_MS = 300;   // the page's omni-glint keyframes run this long
// ease in and out on a half cosine: quick through the middle, soft at both
// ends, and never past where it is going
function omniEase(x){ return (1 - Math.cos(Math.PI * Math.min(Math.max(x, 0), 1))) / 2; }
// where a point stands on the sweep: 0 at the card's bottom left corner, 1 at
// its top right, and one value along every line parallel to the other diagonal,
// which is exactly how a "to top right" gradient lays out its stops
function omniSweepSpot(frame, x, y){
  return ((x - frame.left) / frame.width + (frame.bottom - y) / frame.height) / 2;
}
// the light's centre at ms into the sweep, run backward on the way out
function omniSweepAt(ms, dir){
  const k = omniEase(ms / OMNI_SWEEP_MS);
  return -OMNI_SWEEP_REACH + (dir === "out" ? 1 - k : k) * (1 + 2 * OMNI_SWEEP_REACH);
}
function omniSweepPassed(at, spot, dir){ return dir === "out" ? at <= spot : at >= spot; }
// the point the glint sits on: the card's top right corner, moved in along the
// diagonal onto the rounded edge itself, where the corner's curve crosses it
function omniGlintPoint(rect, radius){
  const inset = (radius || 0) * (1 - Math.SQRT1_2);
  return { x: rect.right - inset, y: rect.top + inset };
}
// the ting on the card's corner. the card is the frame the page draws it in,
// its main; the glint hangs off the body at that corner's place on the screen,
// so the card's own rounded clip cannot cut the rays that reach past its edge.
// it pops, holds and shrinks away on the page's keyframes, then takes itself away
function omniGlint(el, frame){
  const card = (el.box.closest && el.box.closest("main")) || null;
  const rect = card ? card.getBoundingClientRect() : frame;
  const radius = card && typeof getComputedStyle === "function"
    ? parseFloat(getComputedStyle(card).borderTopRightRadius) || 0 : 0;
  const point = omniGlintPoint(rect, radius);
  const glint = h("div", "omni-glint");
  glint.innerHTML = "<i></i><i></i>";   // the two diagonal rays; the long cross is its own ::before and ::after
  glint.style.left = point.x + "px";
  glint.style.top = point.y + "px";
  document.body.appendChild(glint);
  const gone = () => glint.remove();
  glint.addEventListener("animationend", gone);
  setTimeout(gone, OMNI_GLINT_MS + 200);   // a page out of sight runs no animation to end
  return glint;
}
// a title where the change is seen: the middle of its words, together with the
// art beside them when there is art
function omniTitleCentre(t, art){
  let r = t.getBoundingClientRect();
  if (t.firstChild && typeof document.createRange === "function"){
    const rg = document.createRange();
    rg.selectNodeContents(t);
    const words = rg.getBoundingClientRect();
    if (words.width && words.height) r = words;
  }
  let { left, top, right, bottom } = r;
  const a = art && art.getBoundingClientRect();
  if (a && a.width){
    left = Math.min(left, a.left); top = Math.min(top, a.top);
    right = Math.max(right, a.right); bottom = Math.max(bottom, a.bottom);
  }
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
// the card's title on the sweep's measure
function omniTitleSpot(el, frame){
  const head = el.titleEl.parentNode;
  const c = omniTitleCentre(el.titleEl, head && head.querySelector(".omni-card-art"));
  return omniSweepSpot(frame, c.x, c.y);
}
// the card's words and art as one Omni state. the outline keeps the title as
// it is stored; the words are left alone while the reader is typing in them
function omniFace(el, title){
  if (!el.titleEl.isContentEditable) el.titleEl.textContent = omniCardTitle(title);
  if (el.tocTitle) el.tocTitle.textContent = title;
  return paintOmniCard(el, { title });
}

// ---- the ticket's sweep ----------------------------------------------------------
// the card's row in the ticket list takes the same light in the same frames,
// with no glint, and changes to its Omni name and art, or back, as the light
// passes its own title. the list redraws its rows from each reading of the
// board, so the sweep finds them again every frame by the id each page marks
// them with, lays the light back on a row drawn afresh and puts on it the face
// the light has reached. a row with no size, not drawn or out of the page's
// layout, simply takes the face it ends on
function omniRows(id){
  return [...document.querySelectorAll(".trow")].filter(row => row.dataset && row.dataset.id === id);
}
// a row's place on the sweep. its light is laid at 45 degrees, so a point's
// value is how far it has come along that direction: 0 at the bottom left
// corner, 1 at the top right, the same run a "45deg" gradient lays its stops on
function omniRowSpot(frame, x, y){
  return ((x - frame.left) + (frame.bottom - y)) / (frame.width + frame.height);
}
// a row's words and art as one Omni state, the way appendOmniRowArt draws it.
// the row reads the stored title, Omni Ticket #N, where the card reads Omni Card #N
function omniRowFace(row, title){
  const inner = row.querySelector(".trowin"), ttl = inner && inner.querySelector(".ttl");
  if (!ttl) return;
  const info = omniTicket(title);
  row.classList.toggle("omni-ticket", !!info);
  if (ttl.textContent !== title) ttl.textContent = title;
  let art = inner.querySelector(".omni-art");
  if (!info){ if (art) art.remove(); return; }
  if (!art){ art = omniArt(info, "omni-art"); inner.insertBefore(art, ttl); }
  if (art.dataset.variant !== String(info.variant)){ art.src = info.src; art.dataset.variant = String(info.variant); }
}
function omniRowsFace(id, title){ for (const row of omniRows(id)) omniRowFace(row, title); }
// the title a sweep ends on: becoming Omni, the board's own number once a
// reading has brought it and the page's count of it until then
function omniSweepTo(run){ return omniSweepFresh(run) ? run.latest.title : run.title; }
// one frame of the rows' light, at the light's place `at`
function omniRowsStep(run, at){
  for (const row of omniRows(run.id)){
    const frame = row.getBoundingClientRect();
    let light = row.querySelector(".omni-sweep");
    if (!frame.width || !frame.height){ if (light) light.remove(); omniRowFace(row, omniSweepTo(run)); continue; }
    if (!light){ light = h("div", "omni-sweep"); row.appendChild(light); }
    light.style.setProperty("--omni-p", at.toFixed(4));
    if (!run.rowCrossed){
      const inner = row.querySelector(".trowin"), ttl = inner && inner.querySelector(".ttl");
      const c = ttl && omniTitleCentre(ttl, inner.querySelector(".omni-art"));
      if (c && omniSweepPassed(at, omniRowSpot(frame, c.x, c.y), run.dir)) run.rowCrossed = true;
    }
    omniRowFace(row, run.rowCrossed ? omniSweepTo(run) : run.rowFrom);
  }
}
function omniRowsEnd(run){
  for (const row of omniRows(run.id)){
    const light = row.querySelector(".omni-sweep");
    if (light) light.remove();
    omniRowFace(row, omniSweepTo(run));
  }
}
// a committed name, carried onto the card's face: lit where a card crosses into
// or out of Omni, at once where the reader asked for reduced motion or where
// the card is not laid out. a title that asks for Omni shows the lane's next
// number, whatever number was typed with it, since that is the number the board gives
function omniRetitleCard(id, shown, name){
  const el = els[id];
  if (!el || !el.box || !el.titleEl) return;
  omniSweepEnd(el);   // a sweep still running lands first
  const reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const plan = omniRetitle(el.box.classList.contains("omni-card"), shown, name, reduced);
  let title = name;
  if (omniEntry(name)){
    const b = stateBoxOf(id);
    title = "Omni Ticket #" + omniNextNumber(lastState && lastState.boxes, (b && b.owner) || "facilitator");
  }
  const land = () => { omniFace(el, title); omniRowsFace(id, title); };
  if (!plan){ if (omniTicket(title)) land(); return; }
  if (!plan.sweep || !omniSweep(el, id, plan.dir, title)) land();
}
function omniSweep(el, id, dir, title){
  if (typeof requestAnimationFrame !== "function") return false;
  const light = h("div", "omni-sweep");
  light.style.setProperty("--omni-p", String(omniSweepAt(0, dir)));
  el.box.appendChild(light);
  const frame = light.getBoundingClientRect();
  if (!frame.width || !frame.height){ light.remove(); return false; }
  const spot = omniTitleSpot(el, frame);
  // the row starts from the title the board last gave it
  const was = stateBoxOf(id);
  const run = el.omniSweep = { id, dir, title, light, latest: null, crossed: false, glint: null,
                               rowFrom: was ? String(was.title || "") : "", rowCrossed: false,
                               start: null, frame: 0, timer: 0 };
  const tick = now => {
    if (el.omniSweep !== run) return;
    if (run.start == null) run.start = now;
    const ms = now - run.start;
    const at = omniSweepAt(ms, dir);
    light.style.setProperty("--omni-p", at.toFixed(4));
    if (!run.crossed && omniSweepPassed(at, spot, dir)) omniSweepCross(el, run);
    omniRowsStep(run, at);
    // the light's centre has reached the top right corner: the way in ends on a ting
    if (dir === "in" && !run.glint && at >= 1) run.glint = omniGlint(el, frame);
    if (ms >= OMNI_SWEEP_MS) omniSweepEnd(el);
    else run.frame = requestAnimationFrame(tick);
  };
  run.frame = requestAnimationFrame(tick);
  // a page out of sight draws no frames, and the card still has to land
  run.timer = setTimeout(() => { if (el.omniSweep === run) omniSweepEnd(el); }, OMNI_SWEEP_MS + 250);
  return true;
}
// a reading that arrived during the sweep speaks for the card only when it is
// already on the side the sweep is taking the card to. one fetched before the
// board had the new name would put the old face back under the light
function omniSweepFresh(run){
  return !!(run.latest && (!!omniTicket(run.latest.title)) === (run.dir === "in"));
}
function omniSweepCross(el, run){
  run.crossed = true;
  omniFace(el, omniSweepTo(run));
}
function omniSweepEnd(el){
  const run = el && el.omniSweep;
  if (!run) return;
  if (!run.crossed) omniSweepCross(el, run);
  el.omniSweep = null;
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(run.frame);
  clearTimeout(run.timer);
  run.light.remove();
  omniRowsEnd(run);
  if (omniSweepFresh(run)) omniFace(el, run.latest.title);
}
// The ready-to-test marker's display gate. The board keeps a durable per-card
// flag (b.testing); it paints only while the card is actually awaiting the
// reader, so a card that returns to work, queues or is done keeps its own
// colour. A parked card that still awaits the reader qualifies through queueState.
function testReady(b){ return !!(b && b.testing) && queueState(b) === "yours"; }
// ---- unfolding the ready-to-test fold ------------------------------------------
// the fold is the whole of the marker, so unfolding a ticket is lowering it: the
// page asks the board for /testing v=0, the route the agent lowers it by, and
// draws what the board answers. two ways ask it, a click on the folded corner
// and control+u on the selected card, and only while the ticket wears the fold.
// the folded corner is the top right --fold square of the row's border box, the
// flap and the cut corner beside it together. x is measured in from the row's
// right edge and y down from its top
function foldHit(x, y, fold){ return fold > 0 && x >= 0 && y >= 0 && x <= fold && y <= fold; }
function onFold(row, e){
  if (!row || !row.classList.contains("testc")) return false;
  const r = row.getBoundingClientRect();
  const fold = parseFloat(getComputedStyle(row).getPropertyValue("--fold")) || 0;
  return foldHit(r.right - e.clientX, e.clientY - r.top, fold);
}
function unfoldTicket(id){
  return fetch("/testing?box=" + encodeURIComponent(id) + "&v=0", { method: "POST" })
    .catch(() => {}).then(() => poll());
}
// control+u's one path on either page: the selected card, when the key comes
// from where the section chords may come from and the card wears the fold.
// true means the board was asked
function unfoldSelected(e, id, el){
  if (!id || !el || !sectionChordSource(e.target, el)) return false;
  const b = lastState?.boxes.find(x => x.id === id);
  if (!testReady(b)) return false;
  e.preventDefault();
  unfoldTicket(id);
  return true;
}
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
// doing, deferred and done are three adjacent sections of one horizontal sheet
// under the fixed, clipped well: section i rests at translateX(-i*100%). Pressing
// a tab to the right moves the sheet left so the next section enters from the
// right, pressing one to the left reverses it, and a two-section jump travels
// visibly across the middle section. Only #tiksheet moves; the labels, the pill
// and the well hold still. A poll, a project change and the first render place
// the sheet with no motion (moveTicketSheet(view, false)), and reduced motion
// jumps too; only a tab press animates. A press reads the sheet's live position
// and redirects from exactly there, so a reversal mid-travel never resets.
const TIK_TRAVEL_PER = 0.24, TIK_TRAVEL_MAX = 0.62;   // seconds per section, and the cap
const TIK_EASE = "cubic-bezier(.42,.06,.38,1)";       // the board's --gentle
let tikSheetAnim = null;
let tikShownView = null;      // the section the sheet rests at or is travelling to
let tikTravelIntent = null;   // set while a tab press commits, so a render does not jump the sheet

// the sheet's live translateX in sections (1 == one section to the left), read
// off the composited transform so a redirect begins where the eye sees it
function tikSheetSection(sheet){
  const t = getComputedStyle(sheet).transform;
  const m = t && t.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const tx = parseFloat(m[1].split(",")[4]) || 0;
  const w = sheet.getBoundingClientRect().width || 1;
  return -tx / w;
}
function moveTicketSheet(view, animate){
  const sheet = document.getElementById("tiksheet");
  if (!sheet) return;
  const i = Math.max(0, TICKET_VIEWS.indexOf(view));
  const targetPct = -i * 100;
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!animate || reduce || typeof sheet.animate !== "function"){
    if (tikSheetAnim){ tikSheetAnim.cancel(); tikSheetAnim = null; }
    sheet.style.transform = "translateX(" + targetPct + "%)";
    tikShownView = view;
    return;
  }
  const fromPct = -tikSheetSection(sheet) * 100;   // live, before the cancel below
  if (tikSheetAnim) tikSheetAnim.cancel();
  sheet.style.transform = "translateX(" + targetPct + "%)";   // the resting state after the run
  const dist = Math.abs(i - (-fromPct / 100)) || 1;
  const dur = Math.min(TIK_TRAVEL_MAX, TIK_TRAVEL_PER * dist) * 1000;
  tikSheetAnim = sheet.animate(
    [{ transform: "translateX(" + fromPct + "%)" }, { transform: "translateX(" + targetPct + "%)" }],
    { duration: dur, easing: TIK_EASE });
  tikSheetAnim.addEventListener("finish", () => { tikSheetAnim = null; });
  tikShownView = view;
}
// the doing, deferred and done sections filter the lane's pool. the arrow keys
// walk the current section's set, and each pane is drawn from its own section, so
// the three are computed by view rather than off the one current read
function viewFilterFor(b, view){
  const s = cardState(b);
  return view === "done" ? s === "done"
       : view === "deferred" ? s === "parked"
       : (s !== "done" && s !== "parked");
}
function viewFilter(b){ return viewFilterFor(b, curView()); }
// the one section a card stands in, read off the very filter the three sections
// are drawn from, so a card's chips can never name a section its tab disagrees
// with. done outranks parked there, so a card the board holds both ways is done
function cardSection(b){ return TICKET_VIEWS.find(view => viewFilterFor(b, view)); }
function viewPoolFor(state, view){ return poolOf(state).filter(b => viewFilterFor(b, view)); }
function viewPool(state){ return viewPoolFor(state, curView()); }

// when a card became the reader's turn. agentTs is written as the turn goes back
// to the reader; a card the agent never answered ages by its own ts; one with
// neither stamp cannot be aged and counts as the newest
function waitingSince(b){ return b.agentTs || b.ts || Number.MAX_SAFE_INTEGER; }

// when the board put a card in the section it stands in. a card with no stamp
// yet is one this page has just moved there, ahead of the board's reading, so it
// counts as the most recent
function restedSince(b, field){ return b[field] || Number.MAX_SAFE_INTEGER; }

function poolOf(state){
  const keep = poolScope ? poolScope(state) : null;
  const legacy = (a, b) => {
    // an untouched new card stays on top; the first send drops it into the
    // waiting group; anything green (in progress) sinks below all of that
    const g = x => ({ "new": 0, yours: 1, queued: 2, working: 3, done: 4 })[queueState(x)];
    if (g(a) !== g(b)) return g(a) - g(b);
    if (g(a) === 0) return (b.ts || 0) - (a.ts || 0);   // newest created on top
    // the waiting group is a queue: oldest turn first, so old turns do not go
    // stale below newer ones. this is the same measure the post-send jump uses
    // to pick the longest-waiting card; equal stamps keep the board's order
    if (g(a) === 1) return waitingSince(a) - waitingSince(b);
    return (b.ts || 0) - (a.ts || 0);                    // queued and working: newest first
  };
  // the three sections lie one after another: doing, deferred, done. doing keeps
  // the order above; deferred runs by when each card was deferred and done by
  // when each was marked done, most recent first, and cards with equal stamps
  // fall back to the order above
  const part = x => { const s = cardState(x); return s === "done" ? 2 : s === "parked" ? 1 : 0; };
  const stamp = { 1: "parkedTs", 2: "doneTs" };
  return state.boxes.filter(b =>
    b.owner === activeOwner && b.id !== "q" && (!keep || keep(b)))
    .sort((a, b) => {
      const pa = part(a), pb = part(b);
      if (pa !== pb) return pa - pb;
      if (pa) return restedSince(b, stamp[pa]) - restedSince(a, stamp[pa]) || legacy(a, b);
      return legacy(a, b);
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
// card carried when it was last opened; selecting a card counts as reading the
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
// a click into a card's composer, or a key typed there, is using the card, so
// it counts as read. use is the page's own way of saying so, markSeen unless
// the page does more. the input is asked about the caret, because the
// formatter also says input when it puts its editor on or takes it off, which
// it does to every card on load, and that is nobody reading anything
function readOnCompose(ta, id, use = markSeen){
  ta.addEventListener("focus", () => use(id));
  ta.addEventListener("input", () => { if (ComposeFormat.focused(ta)) use(id); });
}
// a reply that lands on the card the reader has selected, while the page is
// on screen and its window is in front, is read the moment it lands. inUse is
// the page's word that this is the card being used. a window behind another
// app leaves the reply unread until the reader comes back and uses the card.
// el.replyCount is the count this page last drew, so a first drawing or a
// reload has nothing to compare with and marks nothing. called after
// seenSync, so the mark covers the reply that just came
function readOnArrival(el, b, inUse){
  const was = el.replyCount, now = b.replies || 0;
  el.replyCount = now;
  if (was == null || now <= was || !inUse) return false;
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  markSeen(b.id);
  return true;
}

// does this lane still hold a reply the reader has not opened? this is the left
// list's own seen test, card by card, so the tab and the row can never
// disagree about what unread means: the agent has answered, the ball is with
// the reader, nothing of the reader's is still queued behind it, and the reader has not opened the
// card since that answer landed. cardState keeps done and deferred cards out,
// so a lane the reader has finished with never asks again
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

// ---- resizing a box on the board --------------------------------------------------
// the smallest and largest a box may be dragged to, in whole grid cells (one
// cell is the star pitch, 11.52 stage pixels; the stage is 125 by 78 cells).
// the conversation card starts at 46 by 63, the ticket list at 31 by 37, the
// spotify box at about 24 by 12 and the clock sizes itself to about 18 by 9.
// a box not named here keeps the plain two-cell floor and no ceiling. these are
// starting numbers, meant to be tuned
const RESIZE_LIMITS = {
  main:     { minW: 30, maxW: 70, minH: 40, maxH: 76 },   // the conversation card
  tickets:  { minW: 22, maxW: 46, minH: 16, maxH: 63 },   // no taller than the card starts
  magic1:   { minW: 16, maxW: 40, minH: 8,  maxH: 24 },   // the spotify box
  clockbox: { minW: 14, maxW: 34, minH: 7,  maxH: 16 },
};
// one step of an edge-handle drag, as pure arithmetic: s is the box when the
// grab began (left, top, w, h and the snapped far edges right and bottom, all
// in stage pixels), dir the handle ("nw", "e" and so on), dx and dy the pull.
// sizes stay whole cells; a west or north pull moves the origin to a star line
// and keeps the far edge pinned. only the axes the handle pulls are held to the
// limits, so a saved size outside them stays put until that edge is dragged
function clampResize(s, dir, dx, dy, grid, lim){
  const onStar = v => Math.round((v - grid / 2) / grid) * grid + grid / 2;
  const floor = 2 * grid;
  const minW = Math.max(floor, lim ? lim.minW * grid : 0), maxW = lim ? lim.maxW * grid : Infinity;
  const minH = Math.max(floor, lim ? lim.minH * grid : 0), maxH = lim ? lim.maxH * grid : Infinity;
  const out = {};
  let w = Math.max(floor, Math.round(s.w / grid) * grid);
  let h = Math.max(floor, Math.round(s.h / grid) * grid);
  if (dir.includes("e")) w = Math.min(maxW, Math.max(minW, Math.round((s.w + dx) / grid) * grid));
  if (dir.includes("s")) h = Math.min(maxH, Math.max(minH, Math.round((s.h + dy) / grid) * grid));
  if (dir.includes("w")){
    out.left = Math.min(Math.max(grid / 2, s.right - maxW, onStar(s.left + dx)), s.right - minW);
    w = s.right - out.left;
  }
  if (dir.includes("n")){
    out.top = Math.min(Math.max(grid / 2, s.bottom - maxH, onStar(s.top + dy)), s.bottom - minH);
    h = s.bottom - out.top;
  }
  out.w = w; out.h = h;
  return out;
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

// ---- the messages the answer was given ------------------------------------------
// the plain grey panel between the card's title and the completed answer under
// it. it holds exactly the messages THAT answer was given, which is a fact only
// the board can state: the board notes them at the moment it hands them over,
// keeps the note across the progress notes written on the way, and writes it
// down beside the answer when the answer is recorded. nothing here works it out
// from what happens to stand nearby, so a reply the board recorded nothing for
// shows no panel at all rather than a guess.
//
// the panel is one block and nothing else: no frame around it, no bubble inside
// it, no time and no label. the messages stand in it one under another in the
// order they were sent, with a blank line between one message and the next. a
// batch taller than the panel's preview is shown cut to its first lines, fading
// out over a strip at the panel's foot that carries a small arrow pointing down,
// and a click or a tap anywhere on it opens the whole batch in place, on the old
// answered box's own fold run, with the arrow turning to point up; another cuts
// it back the same way. a batch that fits the preview is simply shown whole,
// with no strip, no arrow and nothing to press. the desktop card, the phone card
// and the small card all build it here and draw it from the one set of rules in
// card-tokens.css, each at its own size. the messages sent and still waiting
// for an answer stand at the foot of the card in this very panel (see the
// messages waiting for a reply, below), so the two read as one thing.

// what the board recorded one reply was given, or nothing when it recorded
// none. an empty list is an answer and not a silence: it says that reply was
// handed nothing, and nothing is then what the card shows. a reply with no
// record at all (one answered before the board kept this) is unknown, and
// unknown is never drawn as a batch of none
function answeredBatch(meta){
  return meta && meta.id && Array.isArray(meta.answered) ? meta.answered : null;
}

// one card out of the state the page is holding
function stateBoxOf(id){
  return (lastState && lastState.boxes && lastState.boxes.find(b => b.id === id)) || null;
}
// the reply a card is showing right now, as the panel reads it. the board
// names the card's last COMPLETED reply and what it was given; replyKind says
// whether that reply is the text standing on the card, so a progress note
// written over it is never presented as an answer of its own and never borrows
// the answer's batch
function liveAnswered(b){
  if (!b || b.replyKind !== "agent" || !b.replyId) return null;
  return { id: b.replyId, answered: Array.isArray(b.answered) ? b.answered : null };
}
// and the same for one page of the history. the entries ride beside the
// replies, one per reply and in the same order, so an older page carries its
// own batch rather than the live card's. a reply written before the board kept
// any of this has no entry, and stays exactly as readable as it always was
// with no batch invented for it
function histAnswered(list, step){
  const meta = list && list.meta;
  const one = meta && meta[list.length - step];
  if (!one || !one.id) return null;
  return { id: one.id, answered: Array.isArray(one.answered) ? one.answered : null };
}

// the panel's one arrow, centred in the strip at the panel's foot. it points
// down at the rest of a cut batch, and the sheet turns it over to point up
// while the batch stands open. a path and not a font glyph, so its weight holds
// at any scale; it is the chevron the old sent box drew, turned over
const ANSWERED_CHEV = '<svg class="answchev" width="11" height="7" viewBox="0 0 11 7"' +
  ' fill="none" aria-hidden="true"><path d="M1 1.35 5.5 5.65 10 1.35" stroke="currentColor"' +
  ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// the panel's markup, built here so no surface can drift from another: the cut,
// the column of messages inside it, and the strip at the foot that carries the
// arrow. room is who the surface wants told once the panel has changed its own
// height and stopped: the desktop card re-snaps the answer's lines on it, and
// the small card has nobody to tell
function answeredPanel(room){
  const panel = h("div", "answered");
  panel.innerHTML = '<div class="answclip"><div class="answstack"></div></div>' +
    '<div class="answfoot">' + ANSWERED_CHEV + "</div>";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "your messages that the reply below answers");
  panel.answRoom = room || null;
  panel.addEventListener("click", e => {
    // a batch shown whole has nothing more to show
    if (!panel.classList.contains("more")) return;
    // a link or a player inside a message keeps its own press, and a press that
    // ends picking out some of the words is a copy rather than a request
    if (e.target && e.target.closest && e.target.closest("a, button, audio, video")) return;
    if (boxHasSelection(panel)) return;
    // the class is the way the run is heading, so a press that catches a run
    // turns it round rather than repeating it
    openAnswered(panel, !panel.classList.contains("open"));
  });
  // whether a batch runs past the preview can only be read off a panel that is
  // laid out, and a card that is not on screen is not. so it is read again
  // whenever the column of messages changes size: the card coming on screen,
  // the window being resized, a picture in a message landing. the strip comes
  // and goes with the answer, so a change in it is a change in the room
  if (typeof ResizeObserver !== "undefined"){
    panel.answWatch = new ResizeObserver(() => {
      if (fitAnswered(panel) && panel.answRoom) panel.answRoom();
    });
    panel.answWatch.observe(panel.querySelector(".answstack"));
  }
  return panel;
}

// the open and the cut back, run the way the old answered box ran its fold,
// which is the card's one fold: the height carries the change, over the sheet's
// --answ-move (the old --pend-move, 330ms) on the card's --gentle curve, with
// the edge clipped as it goes. the far end is measured on the real destination
// before the run starts, so the height the run stops on is the height the sheet
// gives anyway and taking the inline numbers off at the end moves nothing. a
// press that catches a run freezes it where it stands and aims it back from
// there, every run is numbered so a finish that belongs to an interrupted run
// changes nothing, and two ends can finish one: the transition, and a timer
// behind it for a run with nothing to transition. whoever wants to know about
// the room is told once, when the run has landed, and never on a frame of it.
// what the old box also moved, its column of rows sliding onto its seat and
// fading in, is not copied: here the first lines are already on screen when
// the batch is cut, and the words being read are not the thing to move.
// the dissolve at the cut is a strip of the panel's grey drawn once over the
// foot of the cut, and the run only fades it: out as the batch opens, back in as
// it is cut. its strength is held inline where it stood while the far end is
// measured, the way the height is, so a press that catches a run turns the
// fade round from where it stands as well. nothing in a run is a mask, so no
// frame of it has a dissolve to draw again.
// change, when given, is what the caller changes in the panel after the run's
// start is read and before its far end is: a send puts its message into an open
// sent panel as it cuts it back, so the run starts from what was on screen.
// the two ends stay on the panel for the length of the run (answSpan), for a
// page that has to hold one of its own measures still while the panel moves.
//
// cutting back is one motion: the panel's foot comes up, and the answer under
// it with it, on the height's run. the panel rides at the head of the answer's
// own scroller (answView), and the arrow of a batch opened taller than the view
// is reached by scrolling the panel's head up out of sight. from there the
// answer under the panel would rise by all the cut takes, so the scroll goes
// back on every frame of the run by as much as the cut has taken so far
// (followCut), read off the height the frame is drawn at, up to the part of the
// panel that stands above the view: the answer and the panel's foot stay
// exactly where they stand on the screen, the panel's head stays above the view
// until the run ends, and the words in the part of the panel still in sight
// slide down as it shortens. a cut longer than the part hidden above scrolls
// back by the hidden part and no further, and the answer rises by the rest. a
// panel whose head is in sight has nothing hidden above it, and is cut from its
// foot with the scroll left alone. the browser pulls a scroll that a shortening
// layout leaves past the end of the answer, and it did so at the start of the
// cut, a step ahead of it, so the view shifted before the panel moved. so room
// is held under the answer for the run (holdSlack), enough that the view is
// never stood past its end at any frame, before anything is measured, kept from
// being let go of while the run is on (answHeld), and once it has landed only
// what the view stands on is kept (trimSlack), which is until the scroll moves
// off it. the room also covers an answer short enough to end in it, and a
// keyboard the press put away giving the view its room back while the run is on.
// a scroll that anything else moves during the run is left to it.
// a panel whose own lane was scrolled while it stood open (the sent panel's
// cut, or a small card's seat) comes down to the head of its batch over the
// same run, on a transform, rather than jumping there first.
// motion the reader has asked not to see is a plain flip, as the old fold's was,
// and the view is held for it too
const FOLD_TIMER_MS = 430;   // behind the sheet's run, for a fold with nothing to transition
function openAnswered(panel, open, change){
  const clip = panel.querySelector(".answclip");
  const mine = panel.answRun = (panel.answRun || 0) + 1;
  // where the run starts: whatever the cut and its dissolve stand at now, mid
  // run included
  const from = clip.getBoundingClientRect().height;
  const shadeFrom = answeredShade(panel);
  // cutting back: how far the batch's own lane is scrolled, read before
  // anything is laid out again
  const lane = open ? null : answeredLane(panel);
  const off = lane ? lane.scrollTop : 0;
  settleAnswered(panel);
  // the scroller the panel rides in, where the reader has it, and how much
  // answer there is with no room held under it, the panel standing as tall as
  // its sheet gives it (wide), which is more than from for a run caught opening
  const seat = panel.answView || null;
  const view = open ? null : seat;
  const at = view ? view.scrollTop : 0;
  // the part of the panel above the top of the view, in whole points so the head
  // is never scrolled into sight
  const hidden = view ?
    Math.floor(Math.max(0, view.getBoundingClientRect().top - panel.getBoundingClientRect().top)) : 0;
  const whole = view ? view.scrollHeight - heldSlack(view) : 0;
  const wide = view ? clip.getBoundingClientRect().height : 0;
  if (view) holdSlack(view, heldSlack(view) + from);   // room enough that no layout below can pull the scroll
  if (change) change();
  // a cut always shows the head of the batch, so a lane that was scrolled while
  // the panel stood open starts there; the run below carries the words down
  // to it rather than the lane jumping
  if (lane) lane.scrollTop = 0;
  panel.classList.toggle("open", open);
  // the column may have been resized while it stood open
  if (!open) fitAnswered(panel);
  const still = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  const to = clip.getBoundingClientRect().height;
  // the room the answer needs under it so the view is never stood past its end,
  // at any frame, most of all at the foot of the run. the view can grow while the
  // run is on, as tall as the window under its top: a press on the phone puts the
  // keyboard away, and the view takes its room back
  const reach = view ? Math.max(view.clientHeight,
    (typeof innerHeight === "number" ? innerHeight : 0) - view.getBoundingClientRect().top) : 0;
  const room = view && at > 0 ? Math.max(0, Math.ceil(at + reach - whole + wide - to)) : 0;
  if (still || !from){
    if (view) view.scrollTop = at - Math.max(0, Math.min(hidden, from - to));
    if (seat) trimSlack(seat);
    if (panel.answRoom) panel.answRoom();
    return;
  }
  const shadeTo = panel.classList.contains("more") && !open ? "1" : "0";
  // the words the lane had scrolled up, held where the reader saw them
  const words = lane === clip ? panel.querySelector(".answstack") : lane ? panel : null;
  clip.style.height = from + "px";
  clip.style.setProperty("--answ-shade", shadeFrom);
  if (words && off) words.style.transform = "translate3d(0, " + (-off) + "px, 0)";
  void clip.offsetWidth;   // the start values land untimed
  panel.answSpan = { from, to, band: null };
  panel.classList.add("motion");
  clip.style.height = to + "px";
  clip.style.setProperty("--answ-shade", shadeTo);
  if (words && off) words.style.transform = "";   // and down to the batch's head on the run
  // the room this run needs in place of what the measuring held, with the
  // reader where they were, in the same step, before any frame is drawn
  if (view){
    holdSlack(view, room);
    view.scrollTop = at;
    view.answHeld = true;
  }
  const follow = view && hidden > 0 ? followCut(panel, view, clip, at, hidden, from) : null;
  const done = e => {
    if (e && (e.target !== clip || e.propertyName !== "height")) return;
    clip.removeEventListener("transitionend", done);
    clearTimeout(timer);
    if (mine !== panel.answRun) return;   // a newer run owns the panel now
    if (follow) follow.land(to);
    settleAnswered(panel);
    if (!open) fitAnswered(panel);
    if (seat) trimSlack(seat);
    if (panel.answRoom) panel.answRoom();
  };
  clip.addEventListener("transitionend", done);
  const timer = setTimeout(done, FOLD_TIMER_MS);
}

// the scroll going back with a cut, on every frame of its run: the frame's own
// height is read in the frame callback, which runs after the transition's value
// for that frame is set and before it is laid out and drawn, so the scroll and
// the height are written for the same frame. land writes the far end, for a run
// that ends between frames or on its timer. a scroll that is not where the last
// write left it has been moved by something else, and is not written again
function followCut(panel, view, clip, at, hidden, from){
  const mine = panel.answRun;
  const run = { seen: view.scrollTop, moved: false };
  const write = height => {
    if (run.moved) return;
    if (Math.abs(view.scrollTop - run.seen) > 1){ run.moved = true; return; }
    view.scrollTop = at - Math.max(0, Math.min(hidden, from - height));
    run.seen = view.scrollTop;
  };
  const frame = () => {
    if (panel.answRun !== mine || !panel.answSpan || run.moved) return;
    write(clip.getBoundingClientRect().height);
    if (!run.moved) requestAnimationFrame(frame);
  };
  run.land = write;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(frame);
  return run;
}

// the run's own dress taken off: the timing and the inline ends, so the panel
// stands at the height and the dissolve the sheet gives it
function settleAnswered(panel){
  const clip = panel.querySelector(".answclip");
  const view = panel.answView;
  // room for all the clip's height that may come off, so no layout on the way
  // can pull the scroll; whoever settles lets go of what the view does not
  // stand on
  if (view && view.answHeld){
    holdSlack(view, heldSlack(view) + clip.getBoundingClientRect().height);
    view.answHeld = false;
  }
  panel.classList.remove("motion");
  panel.answSpan = null;
  clip.style.height = "";
  clip.style.removeProperty("--answ-shade");
  // and the hold a scrolled lane's words were given, if a run was cut short on it
  for (const node of [panel, panel.querySelector(".answstack")])
    if (node.style.transform) node.style.transform = "";
}

// the lane a panel's batch scrolls in while it stands open, if it has been
// scrolled: the cut itself where the page caps the opened batch (the large
// cards' sent panel), or the seat the panel stands in where the seat is capped
// instead (the small card). a panel riding in the answer's own scroller has no
// lane of its own; that scroller is its view
function answeredLane(panel){
  const clip = panel.querySelector(".answclip");
  if (clip.scrollTop > 0) return clip;
  const seat = panel.parentNode;
  if (seat && seat !== panel.answView && seat.scrollTop > 0) return seat;
  return null;
}

// the room held under the answer while a panel over it is cut back, written on
// the answer's scroller as --answ-slack, which each page stands at the foot of
// the scroller's content as a spacer. never as the scroller's own padding: the
// scroller is a flex box, and a flex box cannot stand shorter than its padding,
// so room taller than the view pushed the scroller down past its card, and the
// band the fade over the typing row is cut to, measured off the scroller's
// foot, grew with it and stayed, masking the answer out
function heldSlack(view){
  return parseFloat(view.style.getPropertyValue("--answ-slack")) || 0;
}
function holdSlack(view, held){
  if (held > 0) view.style.setProperty("--answ-slack", Math.ceil(held) + "px");
  else view.style.removeProperty("--answ-slack");
  if (!view.answSlackWatch){
    view.answSlackWatch = true;
    view.addEventListener("scroll", () => trimSlack(view), { passive: true });
  }
}
// and let go of all of it the view is not standing on. the room is at the very
// foot of the scroller, so whatever of it lies below the view goes without a
// pixel on screen moving; what the view does stand on stays until the reader
// scrolls up off it, and goes as they do. a view at its top cannot be pulled,
// so it stands on none
function trimSlack(view){
  const held = heldSlack(view);
  if (!held || view.answHeld) return;
  const need = view.scrollTop > 0 ?
    Math.max(0, Math.ceil(view.scrollTop + view.clientHeight - (view.scrollHeight - held))) : 0;
  if (need >= held) return;
  if (need) view.style.setProperty("--answ-slack", need + "px");
  else view.style.removeProperty("--answ-slack");
}

// the strength the dissolve stands at now. the strip itself says, and a run
// caught part way reports the strength it has reached; where nothing can be
// read off it, the sheet's own word for the panel as it stands is the answer
function answeredShade(panel){
  const clip = panel.querySelector(".answclip");
  const now = parseFloat(getComputedStyle(clip, "::after").opacity);
  if (!isNaN(now)) return String(now);
  return panel.classList.contains("more") && !panel.classList.contains("open") ? "1" : "0";
}

// what counts as something to read. a line or a paragraph holding nothing but
// spaces, breaks or the invisible joiners a paste brings along is blank, and so
// is the air a paragraph break leaves and the air between two messages: a
// blank line of the panel's type, which is exactly what a cut can land in.
// the joiners are named by their code points so none of them sits unseen in
// this file: zero width space, non joiner and joiner, the word joiner and the
// byte order mark
const ANSWERED_JOINERS = String.fromCharCode(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
const ANSWERED_BLANK = new RegExp("^[\\s" + ANSWERED_JOINERS + "]*$");
const ANSWERED_TAIL = new RegExp("[\\s" + ANSWERED_JOINERS + "]+$");
// the things in a message that are seen without being text
const ANSWERED_SEEN = new Set(["IMG", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "HR"]);

// a message as the panel shows it: its words with any blank tail taken off, so
// a message that ends on empty lines ends on its last line with text
function answeredText(m){
  return ((m && m.text) || "").replace(ANSWERED_TAIL, "");
}

// where the batch has ink: one box per line of text that has something on it,
// and one per picture, player or rule, each measured down from the top of the
// column of messages and stood on the whole line it sits in rather than on its
// letters alone, so the boxes meet where the lines do
function answeredInk(stack){
  const top = stack.getBoundingClientRect().top;
  const range = document.createRange();
  const boxes = [];
  const walk = node => {
    for (const child of node.childNodes){
      if (child.nodeType === 3){
        if (ANSWERED_BLANK.test(child.textContent)) continue;
        const line = parseFloat(getComputedStyle(child.parentNode).lineHeight) || 0;
        range.selectNodeContents(child);
        for (const r of range.getClientRects()){
          if (!r.height) continue;
          const spare = line > r.height ? (line - r.height) / 2 : 0;
          boxes.push({ top: r.top - top - spare, bottom: r.bottom - top + spare });
        }
      } else if (child.nodeType === 1){
        if (ANSWERED_SEEN.has(child.tagName.toUpperCase())){
          const r = child.getBoundingClientRect();
          if (r.height) boxes.push({ top: r.top - top, bottom: r.bottom - top });
        } else walk(child);
      }
    }
  };
  walk(stack);
  return boxes;
}

// whether the batch has text past the preview, and where the preview ends.
// the sheet cuts a long batch two and three quarter lines down, so the third
// line is seen dissolving. that cut is kept only while a line of text really
// runs through it with at least half of itself showing: when it lands in blank,
// a paragraph break, the air between two messages or a line with nothing on
// it, the preview is stopped at the foot of the last line that has text
// instead, and it is that line the cut dissolves. a batch with no text
// past the cut is no long batch at all, however tall its blank tail: it gets no
// strip, no arrow and no fade, and it stands exactly as tall as its text.
// an open panel shows everything and so cannot say, and neither can one part
// way through a run: each keeps the word it was opened under. a panel that is
// not laid out measures nothing and says nothing, and the observer asks again
// once it is. answers whether the panel's height changed with it: the strip
// coming or going, or the preview stopping somewhere else
function fitAnswered(panel){
  if (panel.classList.contains("open") || panel.classList.contains("motion")) return false;
  const clip = panel.querySelector(".answclip");
  if (!clip) return false;
  const had = clip.style.getPropertyValue("--answ-stop");
  const long = panel.classList.contains("more");
  clip.style.removeProperty("--answ-stop");   // read the cut the sheet gives
  const cut = clip.clientHeight;
  if (!cut){
    if (had) clip.style.setProperty("--answ-stop", had);
    return false;
  }
  const line = parseFloat(getComputedStyle(clip).lineHeight) || 0;
  const ink = answeredInk(clip.querySelector(".answstack"));
  const end = ink.reduce((low, box) => Math.max(low, box.bottom), 0);
  const more = end > cut + 1;
  let stop = 0;
  if (more){
    const through = ink.some(box => box.bottom > cut + 1 && box.top <= cut - line / 2);
    if (!through) stop = ink.reduce((low, box) => box.bottom <= cut + 1 ? Math.max(low, box.bottom) : low, 0);
  } else if (end && end < cut - 1) stop = end;
  if (stop) clip.style.setProperty("--answ-stop", Math.round(stop * 100) / 100 + "px");
  panel.classList.toggle("more", more);
  return more !== long || clip.style.getPropertyValue("--answ-stop") !== had;
}

// one message is one block of the card's own prose: the same markdown, the same
// attachment markup and the same wrapping the answer is drawn in, and nothing
// around it. the blank line the sheet leaves between two blocks is the whole
// of what tells one message from the next, so a message with nothing to read in
// it adds no block, or it would stand as a second blank line.
// the blocks already standing are kept for as long as they hold the same words
// in the same place, so a pass that only adds a message, or only changes the
// badge on one, draws nothing above it again and leaves a pick of those
// words alone. a message may carry a badge in its row (sentBadge, below) and a
// state the page dresses it in: the phone says so of a message the board has not
// confirmed yet. and a sent message carries its stage (see the delivery marks
// further down): one the board has not saved yet is drawn faded, and takes its
// full ink once the board has it
const ANSWERED_STATES = ["pending", "unsure", "failed"];

// the badge a sent row wears while its message is not through, inside the row
// and with no words on it. ring is the attachment tray's own turning ring, for
// a send the phone is still trying again on its own. fail is a red round mark
// holding a circular arrow that sends it again, with a small cross beside it
// that takes the message back. the press on either is heard in syncSent
const SENT_RING = '<svg class="tsqring" viewBox="0 0 24 24" aria-hidden="true">' +
  '<circle class="track" cx="12" cy="12" r="10.5"/><circle class="arc" cx="12" cy="12" r="10.5"/></svg>';
const SENT_RETRY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
  ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
const SENT_CROSS = '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 1l6 6M7 1L1 7" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
function sentBadge(kind){
  const badge = h("span", "answmark");
  badge.dataset.kind = kind;
  if (kind === "ring"){ badge.innerHTML = SENT_RING; return badge; }
  const cross = h("button", "answcross");
  cross.type = "button"; cross.dataset.act = "cross";
  cross.setAttribute("aria-label", "take the message back");
  cross.innerHTML = SENT_CROSS;
  const retry = h("button", "answretry");
  retry.type = "button"; retry.dataset.act = "retry";
  retry.setAttribute("aria-label", "send again");
  retry.innerHTML = SENT_RETRY;
  badge.append(cross, retry);
  return badge;
}
function stackAnswered(panel, batch){
  const stack = panel.querySelector(".answstack");
  const want = batch.filter(m => !ANSWERED_BLANK.test(answeredText(m)));
  const have = [...stack.children];
  let keep = 0;
  while (keep < have.length && keep < want.length && have[keep].dataset.text === answeredText(want[keep])) keep++;
  for (let i = have.length - 1; i >= keep; i--) have[i].remove();
  want.forEach((m, i) => {
    let msg = have[i];
    if (i >= keep){
      const text = answeredText(m);
      msg = h("div", "answmsg cardmd");
      msg.dataset.text = text;
      msg.innerHTML = fmt(text);
      stack.appendChild(msg);
    }
    for (const state of ANSWERED_STATES) msg.classList.toggle(state, m.state === state);
    msg.classList.toggle("undelivered", sentUndelivered(m));
    if (m.op) msg.dataset.op = m.op;
    else delete msg.dataset.op;
    const kind = m.badge || "";
    if (kind) msg.dataset.badge = kind;
    else delete msg.dataset.badge;
    let badge = [...msg.children].find(node => node.classList.contains("answmark"));
    if (badge && badge.dataset.kind !== kind){ badge.remove(); badge = null; }
    if (kind && !badge) msg.appendChild(sentBadge(kind));
  });
}

// another batch starts cut to the preview again, and is measured for it; a run
// still going on the batch it replaces is finished where it stands
function fillAnswered(panel, batch){
  stackAnswered(panel, batch);
  panel.answRun = (panel.answRun || 0) + 1;
  settleAnswered(panel);
  panel.classList.remove("open", "more");
  const clip = panel.querySelector(".answclip");
  clip.style.removeProperty("--answ-stop");
  clip.scrollTop = 0;
  fitAnswered(panel);
  if (panel.answView) trimSlack(panel.answView);
}

function dropAnswered(el, room){
  if (!el || !el.answ) return;
  el.answ.answRun = (el.answ.answRun || 0) + 1;   // a run still going lands on nothing
  if (el.answ.answWatch) el.answ.answWatch.disconnect();
  el.answ.remove();
  el.answ = null;
  el.answId = null;
  if (room) room();
}

// the one pass over the panel, for the poll, the history stepper and the small
// card alike. the reply's own name is what it is drawn from, so a pass carrying
// the same reply again touches no dom at all: an open panel stays open, nothing
// is redrawn under a selection, and nothing near the composer moves, which is
// why a draft and a caret are never disturbed by one of these passes. a
// different reply, whether it landed live or was stepped back to, takes its own
// messages into the panel already standing, so the panel does not blink out and
// back in between two pages of the history.
// room is who to tell once the panel's height has changed: the page's own
// answeredRoomChanged unless the caller names another, and the small card
// names nobody. a batch whose every message is blank has nothing to show and
// shows no panel, the way an empty batch does
function syncAnswered(el, meta, room = answeredRoomChanged){
  if (!el || !el.answwrap) return;
  const batch = answeredBatch(meta);
  if (!batch || !batch.some(m => !ANSWERED_BLANK.test(answeredText(m)))){ dropAnswered(el, room); return; }
  if (el.answ && el.answId === meta.id) return;
  if (!el.answ){
    el.answ = answeredPanel(room);
    // every message here has been answered by the reply under it, which is the
    // board's one proof that the agent read it: the panel says so, quietly,
    // under its foot (the delivery marks, below)
    setMark(el.answ, SENT_TAGS.read);
    // on a large card the panel rides at the head of the answer's own
    // scroller, whose scroll a cut back must leave where the reader has it
    el.answ.answView = el.replyview || null;
    el.answwrap.appendChild(el.answ);
  }
  el.answId = meta.id;
  fillAnswered(el.answ, batch);
  if (room) room();
}

// ---- the messages waiting for a reply -------------------------------------------------
// what has been sent on a card and not answered yet stands at the card's foot,
// over the row the reader types in, in the very panel the answer's messages
// stand in at its head: built by answeredPanel, filled by stackAnswered, cut to
// its preview by fitAnswered and opened and cut back by openAnswered, so the two
// cannot drift apart. what a page gives it is a seat of its own (el.sentwrap)
// and, on a large card, who to tell once it has taken or given back room
// (el.sentRoom). the board keeps a sent message on the card until the answer to
// it lands, and in that same reading it takes the message off here and hands it
// to the panel over the new answer, which is the page turn further down.
//
// a send the reader has just made on this page is an arrival (arrive): the panel
// comes up out of the row the words were typed in, or the new message comes
// into the panel already standing, and a panel standing open is cut back to its
// preview on the fold's own run, so what has just been sent always stands cut.
// a reading that brings messages sent somewhere else, or a first load, is no
// arrival: it moves nothing and leaves the panel open or cut as it stands
const SENT_ARRIVE_MS = 260;   // the sheet's --answ-come
function sentBatch(texts){ return (texts || []).map(text => ({ text })); }

// ---- the delivery marks ------------------------------------------------------------------
// a sent message is in one of three states, and a page holds it under one of
// four stage names: the first is the page's own, the rest the board's, from its
// record of the message (pendingStates and notedTexts on a reading, server.py's
// _pending_states):
//   local      the board has not saved it yet, so it would be lost if the page
//              were closed: a send still on its way (the phone's own, or the
//              desktop's between the press and the board's answer). drawn
//              faded, the panel's grey and the words both, while every message
//              in the panel is still local, and the words alone when an older
//              message in it is saved. no word stands for it, the fade says it.
//              a send that is not getting through keeps this stage and wears
//              the badge of its row (sentBadge) as well: a failure, not a state
//   sent       the board has saved it: Delivered, at full ink
//   delivered  an agent has picked it up, its listener confirmed the claim
//              carrying it: Read
//   read       the agent has written back since it picked it up: a progress
//              note over its claim, a note that took it toward the answer still
//              to come, or the answer itself. it looks as delivered does, Read
// the panel carries one quiet mark under its foot, the way a chat marks the
// newest message that has got anywhere: Delivered or Read for the newest
// message in it that the board has saved, and nothing while none is. the
// panel over an answer always reads Read, since the answer under it is the
// board's proof. a message with no stage (a board too old to say) is drawn as
// it always was and marks nothing
const SENT_TAGS = { sent: "Delivered", delivered: "Read", read: "Read" };
function sentUndelivered(m){ return m.stage === "local"; }
// a send on its way to the board, drawn faded from the press: el is the card's
// page object, which holds its sentItems and its guard. the board's readings
// are kept from replacing the list for as long as any send is out, since one
// asked before the board had the words knows nothing of them. every send is an
// operation, its id minted here before the first try and kept for every try
// after it; route is the path it is posted to, without the id
function sentLaunch(el, text, route){
  const item = { text, stage: "local", op: newOpId(), ts: Date.now(), route };
  el.sentItems = [...el.sentItems, item];
  el.sendsOut = (el.sendsOut || 0) + 1;
  el.sendGuard = Infinity;
  syncSent(el, el.sentItems, true);
  return item;
}
function sentSettled(el){
  el.sendsOut = Math.max(0, (el.sendsOut || 0) - 1);
  if (!el.sendsOut) el.sendGuard = Date.now();
}
// the board answered: the message is saved, and stands as sent until a reading
// says more. a reading asked before this moment may not take it away
function sentLanded(el, item){
  if (item.stage !== "local") return;
  item.stage = "sent";
  sentSettled(el);
  syncSent(el, el.sentItems);
}
// one try of a send, under the id it was minted with. the board keeps a receipt
// beside the message, so a try asked again after a lost answer is answered from
// the receipt and the words never land twice. landed is the board's yes and
// refused its no, which sending again cannot change. failed is anything else,
// no answer within OP_TRY_MS included, and says nothing about whether the words
// landed
const SENT_REFUSED = new Set([400, 409, 413]);
async function sentTry(item){
  let r;
  try {
    r = await fetch(item.route + "&op=" + encodeURIComponent(item.op),
      { method: "POST", body: item.text, signal: AbortSignal.timeout(OP_TRY_MS) });
  } catch (e) { return "failed"; }
  return r.ok ? "landed" : SENT_REFUSED.has(r.status) ? "refused" : "failed";
}
// the try did not get through. the message stays in the panel, faded as it was,
// with the fail badge, and is held out of the board's readings, which would
// otherwise take it away. refused is the board's own no
function sentFailed(el, item, refused){
  if (item.stage !== "local") return;
  item.badge = "fail"; item.refused = !!refused; item.checked = false;
  el.sentItems = el.sentItems.filter(m => m !== item);
  el.sentHeld = [...(el.sentHeld || []), item];
  sentSettled(el);
  syncSent(el, el.sentItems);
}
function sentHeldOut(el, item){
  el.sentHeld = (el.sentHeld || []).filter(m => m !== item);
}
// the arrow: the held message goes out again under its own id, drawn as any
// send on its way is. a refused message is not sent again
async function sentRetry(el, item){
  if (item.refused || !(el.sentHeld || []).includes(item)) return;
  sentHeldOut(el, item);
  item.badge = "";
  el.sentItems = [...el.sentItems, item];
  el.sendsOut = (el.sendsOut || 0) + 1;
  el.sendGuard = Infinity;
  syncSent(el, el.sentItems);
  const result = await sentTry(item);
  if (result === "landed"){
    sentLanded(el, item);
    if (item.landed) item.landed();
  } else sentFailed(el, item, result === "refused");
}
// the board has the held message after all: it stands as sent, Delivered, and
// nothing is taken back
function sentHeldLanded(el, item){
  sentHeldOut(el, item);
  item.badge = ""; item.stage = "sent";
  el.sentItems = [...el.sentItems, item];
  if (!el.sendsOut) el.sendGuard = Date.now();
  syncSent(el, el.sentItems);
  if (item.landed) item.landed();
}
// the words go back in the typing row, after what is already there and never
// over it, and the message leaves the panel
function sentBack(el, item){
  sentHeldOut(el, item);
  const draft = el.ta.value;
  el.ta.value = draft.trim() ? draft.trimEnd() + "\n\n" + item.text : item.text;
  el.tick();
  syncSent(el, el.sentItems);
}
// what a lookup of the board's receipt for an operation answers, or null when
// the board could not be reached, which is no answer at all
async function askReceipt(id){
  try {
    const r = await fetch("/op?id=" + encodeURIComponent(id), { signal: AbortSignal.timeout(OP_TRY_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
// the cross. a refused message is known not to have landed, so its words come
// back at once. any other failure leaves it unknown, so the board is asked
// first: landed, and the row becomes Delivered with nothing taken back; not
// landed, and the words go back; no answer, and nothing happens
async function sentCross(el, item){
  if (!(el.sentHeld || []).includes(item) || item.asking) return;
  if (item.refused){ sentBack(el, item); return; }
  item.asking = true;
  let said;
  try { said = await askReceipt(item.op); } finally { item.asking = false; }
  if (!said || !(el.sentHeld || []).includes(item)) return;
  if (said.status === "applied") sentHeldLanded(el, item);
  else if (said.status === "unknown" && Date.now() - item.ts < OP_CERTAIN_MS) sentBack(el, item);
}
// a reading the board has just answered asks it once about each held message
// it has not been asked about, so a send whose answer was lost on the way and
// that landed is shown Delivered rather than as failed
async function sentAskHeld(el){
  for (const item of [...(el.sentHeld || [])]){
    if (item.refused || item.checked || item.asking) continue;
    item.asking = true;
    let said;
    try { said = await askReceipt(item.op); } finally { item.asking = false; }
    if (!said) continue;
    item.checked = true;
    if (said.status === "applied" && (el.sentHeld || []).includes(item)) sentHeldLanded(el, item);
  }
}
// how long after the press the board's answer "unknown" still proves the words
// never landed. a receipt is kept at least two days from the moment the board
// committed it, which is never before the press, so inside this window no
// receipt means no commit. past it, unknown proves nothing
const OP_CERTAIN_MS = 36 * 3600 * 1000;
// how long one try waits for the board's answer
const OP_TRY_MS = 10000;
function newOpId(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
}
// the panel's list, out of the board's reading of a card: what a note has
// already taken toward the answer to come, which is read, then the queued
// messages, each where it stands
function sentFrom(b){
  const noted = ((b && b.notedTexts) || []).map(text => ({ text, stage: "read" }));
  const texts = (b && b.pendingTexts) || [], states = (b && b.pendingStates) || [];
  return noted.concat(texts.map((text, i) => ({ text, stage: states[i] || "" })));
}
// the mark's own motion, which the sheet draws (card-tokens.css): a word comes
// in over the fold's run (--answ-move), and one giving way to another goes out
// over half of it first. data-tag is where the board's record has the panel,
// data-mark the word on show, and they part only for the length of a change.
// a panel drawn with its mark, or a reader who asked for no motion, is given the
// word at once; the change of a panel already standing is the one that moves.
// a change that lands while another is going is not started again: the swap
// under way reads the record when it lands. clocks end it, since a page that
// runs no transitions never says so
const MARK_OUT_MS = 165;   // half the sheet's --answ-move
const MARK_IN_MS = 330;    // the sheet's --answ-move
function setMark(panel, tag, live){
  if (tag) panel.dataset.tag = tag;
  else delete panel.dataset.tag;
  if (panel.classList.contains("markout")) return;
  const shown = panel.dataset.mark || "";
  if (tag === shown) return;
  if (!live || stillMotion()){ showMark(panel, tag, false); return; }
  if (!shown){ showMark(panel, tag, true); return; }
  panel.classList.add("markout");
  setTimeout(() => {
    panel.classList.remove("markout");
    showMark(panel, panel.dataset.tag || "", true);
  }, MARK_OUT_MS);
}
function showMark(panel, tag, comes){
  const roomMoves = !panel.dataset.mark !== !tag;
  const run = panel.markRun = (panel.markRun || 0) + 1;
  panel.classList.remove("markin");
  if (tag) panel.dataset.mark = tag;
  else delete panel.dataset.mark;
  if (!comes) return;
  if (tag) panel.classList.add("markin");
  // the room under the foot opens or closes on the same run, and whoever wants
  // to know about the room is told once it has stopped
  setTimeout(() => {
    if (panel.markRun === run) panel.classList.remove("markin");
    if (roomMoves && panel.isConnected && panel.answRoom) panel.answRoom();
  }, MARK_IN_MS + 20);
}
// the panel's one mark, and whether every message in it is still unsaved by the
// board. live is a panel that was standing before this reading
function sentMarks(panel, shown, live){
  const got = [...shown].reverse().find(m => SENT_TAGS[m.stage]);
  const tag = got ? SENT_TAGS[got.stage] : "";
  setMark(panel, tag, live);
  panel.classList.toggle("undelivered", shown.every(sentUndelivered));
  panel.setAttribute("aria-label", "your messages waiting for a reply" + (tag ? ", " + tag.toLowerCase() : ""));
}

// the press on a badge's arrow or cross. the page says what each does to the
// message it belongs to (sentMarkAct), the panel's own press is not given it
function sentBadgePress(el, e){
  const button = e.target && e.target.closest && e.target.closest(".answmark button");
  const row = button && button.closest(".answmsg[data-op]");
  if (!row) return;
  e.stopPropagation();
  sentMarkAct(el, row.dataset.op, button.dataset.act);
}

// the messages this page sent that did not get through (el.sentHeld) stand in
// the panel after what the board has, since a reading of the board knows
// nothing of them
function syncSent(el, batch, arrive){
  if (!el || !el.sentwrap) return;
  const shown = (batch || []).concat(el.sentHeld || []).filter(m => !ANSWERED_BLANK.test(answeredText(m)));
  if (!shown.length){ dropSent(el); return; }
  // what the panel is drawn from: the words, and the state, the badge and the
  // stage of each. a pass bringing the same again touches no dom
  const key = JSON.stringify(shown.map(m => [answeredText(m), m.op || "", m.state || "", m.badge || "", m.stage || ""]));
  if (el.sent && el.sentKey === key) return;
  el.sentKey = key;
  const room = el.sentRoom || null;
  let panel = el.sent;
  if (!panel){
    panel = el.sent = answeredPanel(room);
    panel.classList.add("sent");
    panel.addEventListener("click", e => sentBadgePress(el, e));
    el.sentwrap.appendChild(panel);
    stackAnswered(panel, shown);
    sentMarks(panel, shown);
    fitAnswered(panel);
    if (arrive) arriveSent(panel);
    if (room) room();
    return;
  }
  sentMarks(panel, shown, true);
  const had = panel.querySelector(".answstack").children.length;
  if (arrive && panel.classList.contains("open")){
    // the run tells the room itself once it has landed
    openAnswered(panel, false, () => stackAnswered(panel, shown));
  } else {
    stackAnswered(panel, shown);
    fitAnswered(panel);
    if (room) room();
  }
  if (arrive) [...panel.querySelector(".answstack").children].slice(had).forEach(arriveSent);
}

// the arrival's dress, taken off again by the clock rather than by the end of
// the animation, so a reader who has asked for no motion, whose page runs none,
// is not left holding it
function arriveSent(node){
  node.classList.add("arrive");
  setTimeout(() => node.classList.remove("arrive"), SENT_ARRIVE_MS + 60);
}

function dropSent(el){
  if (!el || !el.sent) return;
  el.sent.answRun = (el.sent.answRun || 0) + 1;   // a run still going lands on nothing
  if (el.sent.answWatch) el.sent.answWatch.disconnect();
  el.sent.remove();
  el.sent = null;
  el.sentKey = "";
  if (el.sentRoom) el.sentRoom();
}

// the band the answer is cut to while the sent panel at the foot runs. the panel
// stands over the answer on an opaque seat, so for the length of a run the band
// is held at the lower of the run's two ends rather than following the panel on
// every frame: opening, the seat rises over words at full ink and the band
// follows once it has landed; cutting back, the words under the seat are put
// back at the start and are uncovered as it comes down. held, the answer's
// fades and its run-out are not drawn and laid out again on every frame of the
// run. band is what the page measured; what comes back is what it should write
function sentBand(el, band){
  const span = el && el.sent && el.sent.answSpan;
  if (!span) return band;
  if (span.band == null){
    const now = el.sent.querySelector(".answclip").getBoundingClientRect().height;
    span.band = Math.max(0, Math.round(band - (now - Math.min(span.from, span.to))));
  }
  return span.band;
}

// ---- the board's refresh and the card's own motion ------------------------------------
// a panel's run and the glide of a page turn are the card's own motion, and the
// board's timed refresh waits them out. a refresh is a whole pass over every
// card on the page's one thread, and one landing inside a third of a second of
// motion costs that motion frames it never gets back. only the timed refresh
// waits, and only until the motion is over; a refresh asked for by something the
// reader did goes at once
function cardsMoving(){
  return typeof document !== "undefined" && typeof document.querySelector === "function" &&
    !!document.querySelector(".answered.motion, .answered.markin, .answered.markout, .turnsheet");
}

// ---- the page turn -----------------------------------------------------------------------
// the answer to what stands in the sent panel lands on the card on show, and the
// card turns to a new page in one motion. what the reader was looking at, the
// answer they were on and the sent panel under it, glides up, eased on the
// card's gentle curve, and the new answer rides up with it, already in place
// under the sent messages: the sent panel is carried up to where the panel of
// answered messages stands at the head of a card, which is what it now is, since
// the board hands those same messages to the new answer, and the answer arrives
// under it as it goes. nothing is faded in after the glide; the answer is there
// the whole way up.
//
// the glide moves pictures and not the card. the page the reader was on is
// copied into a sheet laid over the card's column (the answer as it stood, at
// its scroll and with its fades, and the sent panel on its seat), the card under
// the sheet is drawn as the new page at once, and the new page is copied into
// the sheet too, under the old, one glide's length further down, so its panel
// stands exactly behind the old sent panel and its answer just under it. then
// only the sheet's content moves, on one transform, so no frame of the glide lays
// anything out or draws anything again. it goes up by exactly the distance from
// where the sent panel stood to where the new page's own panel stands, so when
// the sheet is taken away the new page under it is on the same pixels as its
// copy. the large card pictures its answer's scroller and the sent panel's
// seat; the small card, which keeps its panel, its answer and its sent panel as
// three pieces of one column, pictures the three.
//
// the reader is never moved while busy with the card. a new answer is held
// back, the page left exactly as it was, while the reader is reading (the answer
// was scrolled in the last three seconds, words in it are picked out, or an older
// page of its history is on show) or typing (a key went into the row in the last
// two seconds), and the card looks again every half second; the page turns
// once the card has been left still. a card that is not on show has nothing to
// turn and simply shows the new page, and so does a card whose reader asked for
// no motion. a new answer with no sent panel standing has nothing to glide and
// is printed in place instead (printReply). a progress note is not an answer and
// turns nothing
const TURN_GLIDE_MS = 560;    // the sheet's --turn-glide
const PRINT_MS = 780;         // the sheet's print: the last blocks start at 400ms and take 380
const READ_QUIET_MS = 3000;   // this long after the reader last scrolled the answer
const TYPE_QUIET_MS = 2000;   // this long after the last key into the row
const HOLD_LOOK_MS = 500;     // how often a held card looks again
const TURN_HELD = "held";

// the reader's own scrolling of the answer, which is what says they are reading
// it. the page's own moves of the scroll, a history step or a turn, are marked
// quiet as they are made, so they are not taken for the reader's
function watchReading(el){
  (el.replyview || el.reply).addEventListener("scroll", () => {
    if (Date.now() - (el.quietScroll || 0) > 200) el.readAt = Date.now();
  }, { passive: true });
}
function scrollCardTop(el){
  el.quietScroll = Date.now();
  (el.replyview || el.reply).scrollTop = 0;
}
function cardLaidOut(el){
  return !!(el.replyview || el.reply).getBoundingClientRect().height;
}
// a new answer swapped in with no page turn opens at its head: now if the card is laid out, else when it is next shown
function headOnSwap(el, b){
  if (cardOnShow(el) && b.replyKind !== "agent") return;
  if (cardLaidOut(el)) scrollCardTop(el);
  else el.headDue = true;
}
// a card hidden with display:none is handed back the scroll it was left at when it is shown again
function openAtHead(el){
  if (!el.headDue || !cardLaidOut(el)) return;
  el.headDue = false;
  scrollCardTop(el);
}
// and a key into a row, which is what says the reader is typing. each page calls
// it from its rows' input: the card's own bar and the phone's row. the
// formatter also says input when it puts its editor on or takes it off, to
// every card on load, and that is nobody typing, so only a row holding the
// caret counts, the way readOnCompose counts it
function noteTyping(ta){
  if (typeof ComposeFormat === "object" && ComposeFormat && ComposeFormat.focused(ta)) ta.typedAt = Date.now();
}

function stillMotion(){
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// the card on show: the one its page shows, whether chosen or only browsed to
// (a large card wears sel; the small cards show one and set the rest off), laid
// out, and not hidden under something the page lays over its whole board, the
// way the desktop's home page hides the stage
function cardOnShow(el){
  const view = el.replyview || el.reply;
  if (!view || el.box.classList.contains("off")) return false;
  if (el.replyview && !el.box.classList.contains("sel")) return false;
  if (!view.getBoundingClientRect().height) return false;
  return getComputedStyle(el.box).visibility !== "hidden";
}

// whether the reader is busy with the card on show
function turnHolding(el, id){
  if (!cardOnShow(el)) return false;
  if (hist && hist.id === id) return true;
  const now = Date.now();
  if (now - (el.readAt || 0) < READ_QUIET_MS) return true;
  if (el.ta && now - (el.ta.typedAt || 0) < TYPE_QUIET_MS) return true;
  if (typeof boxHasSelection === "function" && boxHasSelection(el.replyview || el.reply)) return true;
  // and a sent panel part way through its own run is let finish it
  if (el.sent && el.sent.classList.contains("motion")) return true;
  return false;
}

// a held card looks again on its own clock, since a page that reads the board by
// its revision is handed nothing new to draw while the board stands still. once
// the reader has let the card be, the page draws its cards again and the turn runs
function turnHold(el, id){
  if (el.turnHeld) return;
  const look = () => {
    if (turnHolding(el, id)){ el.turnHeld = setTimeout(look, HOLD_LOOK_MS); return; }
    el.turnHeld = null;
    if (turnAgain) turnAgain();
  };
  el.turnHeld = setTimeout(look, HOLD_LOOK_MS);
}

// called by the page's pass over a card whose answer has changed, before it
// draws anything of the new one. it answers TURN_HELD when the new answer is to
// wait, and the page then leaves the answer and both panels as they stand; a
// turn, which the page hands to turnGo once it has drawn the new page; or
// nothing, for the plain swap the card always had
function turnBegin(el, b){
  if (el.turning) turnEnd(el);   // a turn still going lands at once
  if (!b || b.replyKind !== "agent" || !cardOnShow(el)) return null;
  if (stillMotion()) return null;
  if (turnHolding(el, b.id)){ turnHold(el, b.id); return TURN_HELD; }
  if (el.turnHeld){ clearTimeout(el.turnHeld); el.turnHeld = null; }
  const turn = { mode: "print" };
  if (el.sent && el.sentwrap && el.sentwrap.getBoundingClientRect().height) turnSheet(el, turn);
  // the new page opens at its head
  scrollCardTop(el);
  return turn;
}

// the pieces of a card's column a turn pictures: where the sheet goes, what the
// page the reader was on is made of, and what the new page is made of
function turnParts(el){
  if (el.replyview)
    return { region: el.replyview.parentElement, before: [el.replyview, el.sentwrap], after: [el.replyview] };
  return { region: el.box, before: [el.answwrap, el.reply, el.sentwrap], after: [el.answwrap, el.reply] };
}

// one still picture of one piece, laid in the sheet where the piece stands, shift
// further down. the answer's scroller keeps the depth its foot is cut to, and a
// picture never starts arriving or printing again
function turnPicture(el, node, turn, shift){
  const r = node.getBoundingClientRect();
  const copy = node.cloneNode(true);
  copy.style.position = "absolute";
  copy.style.top = (r.top + shift - turn.top) + "px";
  copy.style.left = (r.left - turn.left) + "px";
  copy.style.width = r.width + "px";
  copy.style.height = r.height + "px";
  copy.style.margin = "0";
  if (node === el.replyview)
    copy.style.setProperty("--boxband", (typeof boxBand === "function" ? boxBand(node, el.pendwrap) : 0) + "px");
  for (const one of [copy, ...copy.querySelectorAll(".arrive, .printing, .markin, .markout")])
    one.classList.remove("arrive", "printing", "markin", "markout");
  return copy;
}

// the still picture of the page the reader was on, over the card's column: from
// the head of the card's body on a large card, where a fade in the white over
// the answer takes what leaves, and from the first piece down on a small one,
// to the foot of the sent panel's seat either way
function turnSheet(el, turn){
  const parts = turnParts(el);
  // a sent panel caught open, or part way through a run, is cut to its preview
  // where it stands, since what glides up is what stands at the head of the new page
  const sent = el.sent;
  if (sent.classList.contains("open") || sent.classList.contains("motion")){
    sent.answRun = (sent.answRun || 0) + 1;
    settleAnswered(sent);
    sent.querySelector(".answclip").scrollTop = 0;
    sent.classList.remove("open");
    fitAnswered(sent);
  }
  const at = parts.region.getBoundingClientRect(), sr = el.sentwrap.getBoundingClientRect();
  const shown = parts.before.filter(node => node && node.getBoundingClientRect().height);
  const top = el.replyview ? at.top : Math.min(...shown.map(node => node.getBoundingClientRect().top));
  Object.assign(turn, { mode: "glide", top, left: at.left, from: sr.top });
  const sheet = h("div", "turnsheet");
  sheet.setAttribute("aria-hidden", "true");
  sheet.style.top = (top - at.top) + "px";
  sheet.style.height = (sr.bottom - top) + "px";
  const page = h("div", "turnpage");
  const pictures = shown.map(node => [node, turnPicture(el, node, turn, 0)]);
  page.append(...pictures.map(([, copy]) => copy));
  sheet.appendChild(page);
  parts.region.appendChild(sheet);
  // each picture of a scroller stands at the scroll the reader left it at
  for (const [node, copy] of pictures) if (node.scrollTop) copy.scrollTop = node.scrollTop;
  Object.assign(turn, { sheet, page, region: parts.region });
  el.turning = turn;
  // a sheet never outlives its glide, whatever becomes of the pass that laid it
  turn.timer = setTimeout(() => { if (el.turning === turn) turnEnd(el); }, TURN_GLIDE_MS + 80);
}

// called once the page has drawn the new page under the sheet: the glide, which
// brings the new answer up with it, or the print alone where nothing glides
function turnGo(el, turn){
  if (!turn || turn === TURN_HELD) return;
  if (turn.mode !== "glide"){ printReply(el); return; }
  // where the new page's own panel stands: the panel the sent messages have
  // just become. a new page with no panel at its head has nowhere to glide to,
  // and is shown and printed as it stands
  const dest = el.answ && el.answwrap ? el.answwrap.getBoundingClientRect().top : null;
  const lift = dest == null ? 0 : turn.from - dest;
  if (!(lift > 1)){ turnEnd(el); printReply(el); return; }
  // the new page, pictured a glide's length further down and under the picture
  // of the old one, so its panel waits behind the old sent panel and its answer
  // stands just under it, and all of it comes up on the one transform
  const fresh = turnParts(el).after.filter(node => node && node.getBoundingClientRect().height)
    .map(node => turnPicture(el, node, turn, lift));
  // its panel stands exactly behind the sent panel, whose own mark turns on the
  // way up, so its mark is held out and the two words are never drawn together
  for (const copy of fresh)
    for (const one of copy.querySelectorAll(".answered")) one.classList.add("markout");
  turn.page.prepend(...fresh);
  void turn.page.offsetWidth;   // the sheet stands as the reader left it before it moves
  turn.page.classList.add("gliding");
  turn.page.style.transform = "translate3d(0, " + (-lift) + "px, 0)";
  // the sent panel is on its way to being the panel over the answer, which reads
  // Read: its mark turns on the way up, and a panel still faded takes its full
  // grey and ink with it, so the swap when the sheet goes is not one
  const rising = turn.page.querySelector(".answered.sent");
  if (rising){
    setMark(rising, SENT_TAGS.read, true);
    for (const one of [rising, ...rising.querySelectorAll(".undelivered")]) one.classList.remove("undelivered");
  }
  clearTimeout(turn.timer);
  const done = e => {
    if (e && (e.target !== turn.page || e.propertyName !== "transform")) return;
    turn.page.removeEventListener("transitionend", done);
    if (el.turning === turn) turnEnd(el);
  };
  turn.page.addEventListener("transitionend", done);
  turn.timer = setTimeout(done, TURN_GLIDE_MS + 80);
}

// the glide has landed, or is cut short by a newer answer: the pictures go, and
// the new page they were copied from stands where they stood
function turnEnd(el){
  const turn = el.turning;
  if (!turn) return;
  el.turning = null;
  clearTimeout(turn.timer);
  if (turn.sheet) turn.sheet.remove();
}

// the print, for a new answer that has nothing to glide with: its blocks come in
// one after another from the top, each a fade with a small rise (the sheet's
// cardprint), fifty milliseconds apart and all of them under way by the ninth.
// only strength and a transform are drawn, so the answer's layout is final from
// the first frame and nothing under it moves
function printReply(el){
  const reply = el && el.reply;
  if (!reply) return;
  if (stillMotion()) return;
  reply.classList.remove("printing");
  void reply.offsetWidth;   // a print still going starts again from its first block
  reply.classList.add("printing");
  clearTimeout(el.printTimer);
  el.printTimer = setTimeout(() => reply.classList.remove("printing"), PRINT_MS + 60);
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

// A destination is named, unlike the moon's reversible tap. Read the held value
// so a second request during an unanswered one is judged against what the card
// already shows, then use the same ordered flag requests as a tap.
function setCardDestination(id, destination){
  if (destination === "deferred"){
    if (!flagShown(id, "park")) return setFlag(id, "park", true);
  } else if (destination === "doing"){
    const parked = flagShown(id, "park"), done = flagShown(id, "done");
    if (parked) setFlag(id, "park", false);
    if (done) return setFlag(id, "done", false);
  }
}

// the Doing list as both pages draw it, top to bottom, by card id
function doingOrder(state){ return state ? viewPoolFor(state, "todo").map(b => b.id) : []; }

// where the screen goes when a card leaves Doing: the card below it, else the
// one above it, else nothing. order is the list from before the card left; a
// card that was not in it gets the top card; the standing boxes are skipped
function doingNeighbour(id, order){
  const at = order.indexOf(id);
  const open = x => x !== id && !isStandingBox(x);
  if (at < 0) return order.find(open) ?? null;
  return order.slice(at + 1).find(open) ?? order.slice(0, at).reverse().find(open) ?? null;
}

// Closing a card and snoozing the card on screen use the same Doing fallback.
// order is taken at the tap, before the repaint drops the card from the list.
// A card that is not on screen leaves the screen alone. the hop says so to
// select, and both pages show the card they land on browsed
function selectNextDoing(id, order){
  if (selectedId !== id) return;
  const live = new Set(doingOrder(lastState));
  const next = doingNeighbour(id, order.filter(x => x === id || live.has(x)));
  if (next) select(next, { hop: true }); else deselect();
}

// ---- the three section chips ---------------------------------------------------
// every card carries a chip for each section, left to right in the tabs' own
// order: the sun for doing, the moon for deferred, the cross for done. the chip
// that names the section the card already stands in is faded and switched off,
// since pressing it could only ask for what is already true. it is marked with
// aria-disabled rather than the disabled property so it keeps its place in the
// keyboard's path through the card, and each chip's own click reads the mark
// and does nothing while it stands
const SECTION_CHIPS = { todo: "sun", deferred: "arc", done: "x" };
// a large hollow ring with eight short marks around it, drawn on the moon's 24
// unit box at the moon's 9px. the ring and the marks share one stroke, set once
// on the svg, so they are one weight by construction. the ring is the main
// shape: radius 4.35 under the 2.4 stroke leaves a hole 6.3 units across, near
// 2.4px at this size, and puts its outer edge at 5.55. the marks start at 8.55
// so their round inner ends keep 1.8 units of air clear of the ring, and end at
// 10.5 so their round outer ends stay inside the box
const SUN_ICON = '<svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="4.35"></circle>' +
  '<path d="M12 1.5L12 3.45M12 20.55L12 22.5M1.5 12L3.45 12M20.55 12L22.5 12' +
  'M4.58 4.58L5.95 5.95M18.05 18.05L19.42 19.42M4.58 19.42L5.95 18.05M18.05 5.95L19.42 4.58"></path></svg>';

function chipOff(chip){ return !!chip && chip.getAttribute("aria-disabled") === "true"; }

// the sun, built the same on every surface; each page seats it and dresses it
function sunChip(cls, id){
  const sun = h("button", cls);
  sun.type = "button";
  sun.title = "move to doing\n" + SECTION_KEY_HINTS.doing;
  sun.setAttribute("aria-label", "move to doing");
  sun.innerHTML = SUN_ICON;
  sun.addEventListener("click", e => { e.stopPropagation(); if (!chipOff(sun)) wakeCard(id); });
  return sun;
}

// el.sun, el.arc and el.x are the card's three chips under whatever classes the
// surface gives them. only a chip whose state changes is written, so a poll that
// moves nothing leaves a hover where it is
function paintSectionChips(el, b){
  const here = SECTION_CHIPS[cardSection(b)];
  for (const name of ["sun", "arc", "x"]){
    const chip = el && el[name];
    if (!chip || chipOff(chip) === (name === here)) continue;
    if (name === here) chip.setAttribute("aria-disabled", "true");
    else chip.removeAttribute("aria-disabled");
  }
}

// the sun's own move: whatever holds the card out of doing is lifted, through
// the same ordered flag requests a tap on the moon makes. a card the board
// holds both parked and done shows as done, so its face carries no parked class
// and setCardDestination's read of it sees none; the reading's own park flag is asked as
// well here, or the sun would lift the done and leave the card in deferred
function wakeCard(id){
  const b = typeof lastState === "undefined" ? null : lastState?.boxes.find(x => x.id === id);
  if (b && b.parked && !flagHolds[flagKey(id, "park")] && !flagShown(id, "park")) setFlag(id, "park", false);
  return setCardDestination(id, "doing");
}

// a section key asks what that section's chip on the card's face would ask,
// and nothing while that chip stands faded because the card is already there.
// deferred only ever parks, where the moon's tap could also unpark, and done
// is the page's own close, handed in, since each surface closes its own way.
// true means a move was asked for
const SECTION_KEY_CHIPS = { doing: "sun", deferred: "arc", done: "x" };
function sectionKeyMove(id, section, el, close){
  const chip = el && el[SECTION_KEY_CHIPS[section]];
  if (!chip || chipOff(chip)) return false;
  if (section === "doing") wakeCard(id);
  else if (section === "deferred") setCardDestination(id, "deferred");
  else close(id);
  return true;
}

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
  const current = typeof lastState === "undefined" ? null : lastState?.boxes.find(b => b.id === id);
  const advance = kind === "park" && want &&
    typeof selectedId !== "undefined" && selectedId === id &&
    typeof curView === "function" && curView() === "todo" &&
    current && current.owner === activeOwner && !current.done && !current.parked;
  const order = advance ? doingOrder(lastState) : null;   // before the card is painted out of the list
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
  if (advance) selectNextDoing(id, order);
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
  let inputSeen = false;
  t.oninput = () => {
    if (inputSeen) return;
    inputSeen = true;
    try { window.phoneHistory?.note("stage", { stage: "title-input", box: id,
      inputReady: t.isConnected && t.isContentEditable, active: document.activeElement === t }); } catch (_) {}
  };
  const end = () => { t.removeAttribute("contenteditable"); t.onkeydown = null; t.onblur = null; t.oninput = null; };
  const commit = () => {
    const name = t.textContent.trim();
    end();
    if (name && name !== old){
      t.textContent = name;
      if (el.tocTitle) el.tocTitle.textContent = name;
      // focus is leaving the title, by Tab, Enter or a click away, and a name
      // crossing into or out of Omni sweeps the card over in the same moment
      omniRetitleCard(id, old, name);
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
    if (e.key === "Enter" && !e.altKey){ e.preventDefault(); commit(); el.ta.focus(); }
    else if (keyboardTitle && e.key === "Tab"){ e.preventDefault(); commit(); (e.shiftKey ? (el.sun || el.arc) : el.ta).focus(); }
    else if (e.key === "Escape"){
      if (!old && !t.textContent.trim()) commit();
      else { end(); t.textContent = old; }
      if (keyboardTitle) el.ta.focus();
    }
  };
  t.onblur = () => { if (t.isContentEditable) commit(); };
}

// after a send, move to the next YELLOW card: one awaiting the reader's read, never a
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
  // the send should land on the card that has waited
  // longest, not the newest. agentTs is written in the same breath as the turn
  // going back to the reader, so it marks when a card became the reader's to read; ts moves on
  // the reader's own sends and on progress notes too, so it cannot mean that. a card the
  // agent has never answered has only its own ts to age by, and one carrying
  // neither stamp cannot be aged, so it sorts last instead of posing as the
  // oldest thing here. the filter above already made a fresh array, so nothing
  // else sees this sort, and equal stamps keep the list's own order
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
      .then(r => {
        const replies = r.replies || [];
        // what each of those replies was given, and when each was completed,
        // one entry per reply and in the same order. it is carried ON the list
        // rather than in a cache beside it, so it cannot outlive the list: every
        // place that drops this card's cached history drops the batches in the
        // same breath. every caller that only walks the replies still gets
        // exactly the array of strings it always got, and a board too old to
        // send the entries leaves the list bare, which reads as unknown
        // everywhere rather than as a batch of none
        const meta = r.replyMeta;
        if (Array.isArray(meta) && meta.length === replies.length) replies.meta = meta;
        return replies;
      })
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
    scrollCardTop(el);   // the answer's own scroller back to its top
    // back on the live reply, so the panel over it is the live reply's own batch
    // again. the card is read out of the state the page is holding rather than
    // remembered from the step away, so a reply that landed while an older page
    // was being read is the one that comes back. while a new answer is held back
    // for the reader, the live page is still the one the card last drew, and so
    // is its batch, until the page turn brings the new one
    syncAnswered(el, el.turnHeld && el.liveMeta !== undefined ? el.liveMeta : liveAnswered(stateBoxOf(id)));
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
  scrollCardTop(el);   // the answer's own scroller back to its top
  // this page's own batch, so an older answer is read with the messages it was
  // actually given and never with the live card's
  syncAnswered(el, histAnswered(list, step));
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

// ---- quick notes ------------------------------------------------------------------
// a quick note is plain text the owner jots down without leaving what they are
// doing. it stands alone unless its words name a card: "card 12", "card12" or
// "c12" attaches it to the card the board numbers 12, the way a date typed into
// a task is picked out of its words. kept here, where both pages can reach it,
// is everything that is not the desktop's pointer corner or its card chip:
// reading a reference out of the text, finding the card it names, what an edit
// does to the attachment, the session that saves as the owner types, and the
// overlay itself, so the phone can open the same element once it has a way in.
// hidden in this version: no page builds the overlay or starts a session, and
// the server answers 404 on every quick note route (QUICK_NOTES_ON, server.py).

// the reference: card, card and a space, or c, then the number, standing as a
// word of its own. a letter, digit or underscore on either side makes it part of
// a longer word (abc12, c12b, discard 5) and a dot then a digit part of a longer
// number (c1.2), and neither is read as a card. there is no lookbehind in it, so
// an older phone engine can still read this file.
// the number is the board's card numbering, which is defined elsewhere: ids are
// made in server.py _create_box_record (m plus the next_bid counter kept in
// _migrate, and seeded ids as written in _seed_state), and the figure shown for
// an id is ticketNum in this file (copied in page.html). when that numbering
// changes, this parser, quickNoteCard below, the attach routes in server.py and
// parked/quick-note.js syncQuickNoteChip have to change with it
const QUICK_NOTE_REF = /(^|[^\p{L}\p{N}_])(?:card[ \t\u00a0]*|c)(\d+)(?![\p{L}\p{N}_]|\.\d)/iu;
function quickNoteRef(text){
  const m = QUICK_NOTE_REF.exec(String(text == null ? "" : text));
  return m ? m[2] : null;
}
// the card the board numbers num: the figure ticketNum reads off a card's id,
// m12 for a card made on the board and a seeded numeric id as it is. ids are
// never reused, so two cards share a figure only when a seeded 12 and a made m12
// both stand, and then the one made on the board is the one meant
function quickNoteCard(boxes, num){
  const want = String(num == null ? "" : num);
  if (!want) return null;
  let found = null;
  for (const b of boxes || []){
    if (ticketNum(b.id) !== want) continue;
    if (b.id === "m" + want) return b;
    if (!found) found = b;
  }
  return found;
}
// what one saved edit asks of the note's attachment. before and after are the
// note's words when the attachment was last read and now, card the card it is
// attached to. only a change in the reference acts, so a note attached some
// other way, by an agent later, is left where it is until its words name a card
// of their own. all of it happens silently: the note shows none of it:
//   {attach: id}    the words name a card the note is not attached to yet
//   {detach: true}  the reference that attached it has been deleted
//   {missing: "N"}  the words name a figure no card on the board carries
//   null            nothing to do
// the first reference in the words is the one that counts
function quickNoteAttachStep(before, after, card, boxes){
  const was = quickNoteRef(before), now = quickNoteRef(after);
  if (now === was) return null;
  if (now == null){
    const left = quickNoteCard(boxes, was);
    return left && left.id === card ? { detach: true } : null;
  }
  const hit = quickNoteCard(boxes, now);
  if (!hit) return { missing: now };
  return hit.id === card ? null : { attach: hit.id };
}
// the list the way it is read: the note touched last on top
function quickNotesNewestFirst(notes){
  const seq = n => Number(String((n && n.id) || "").slice(2)) || 0;
  return (notes || []).filter(Boolean).slice()
    .sort((a, b) => (b.updated || 0) - (a.updated || 0) || seq(b) - seq(a));
}
// card id to the notes attached to it, newest first
function quickNotesByCard(notes){
  const out = {};
  for (const n of quickNotesNewestFirst(notes)){
    if (!n.card) continue;
    (out[n.card] || (out[n.card] = [])).push(n);
  }
  return out;
}

const QUICK_NOTE_KEY = "quicknote.current";   // the note being written, per browser
const QUICK_NOTE_SAVE_MS = 600;               // a pause in the typing this long saves it
// the note being written, saved as the owner types. one request is out at a
// time and each save sends the words as they are by then, so a slow answer can
// never put older words over newer ones. the first save is the one that makes
// the note, so a note nobody typed in is never stored, and a note emptied and
// put away is removed rather than kept blank. words that could not be saved are
// never overwritten from the board: they stay on screen and go again with the
// next save. deps: fetch, storage (a localStorage), boxes() (the cards the
// board holds now), schedule(fn, ms) and cancel(id) (a timer)
function quickNoteSession(deps){
  const s = { id: null, text: "", saved: "", card: null, status: "", notes: [], onChange: null };
  let readFrom = "", timer = null, chain = Promise.resolve();
  const changed = () => { if (typeof s.onChange === "function") s.onChange(s); };
  const recall = () => { try { return deps.storage.getItem(QUICK_NOTE_KEY); } catch (e){ return null; } };
  const remember = id => {
    try {
      if (id) deps.storage.setItem(QUICK_NOTE_KEY, id);
      else deps.storage.removeItem(QUICK_NOTE_KEY);
    } catch (e){}
  };
  // one step at a time, in the order asked; a step that throws never stops the
  // ones queued behind it
  const run = step => (chain = chain.then(step).catch(() => {}));
  const unsaved = () => (s.id == null ? s.text.trim() !== "" : s.text !== s.saved);
  async function post(url, body){
    const init = { method: "POST" };
    if (body != null) init.body = body;
    const r = await deps.fetch(url, init);
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !data.ok) throw new Error((data && data.error) || "status " + r.status);
    return data;
  }
  async function load(){
    const r = await deps.fetch("/quicknotes", { cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || !Array.isArray(data.notes)) throw new Error("status " + r.status);
    s.notes = quickNotesNewestFirst(data.notes);
  }
  function show(note){
    s.id = note ? note.id : null;
    s.text = s.saved = readFrom = note ? String(note.text || "") : "";
    s.card = note ? note.card || null : null;
    remember(s.id);
  }
  // a figure no card carries asks nothing, and the note says nothing about it
  async function attachStep(text){
    const step = quickNoteAttachStep(readFrom, text, s.card, deps.boxes());
    if (step && !step.missing){
      const card = step.attach || null;
      await post("/quicknote/attach?id=" + encodeURIComponent(s.id) +
                 (card ? "&card=" + encodeURIComponent(card) : ""));
      s.card = card;
    }
    // read only once acted on, so an attach that failed is tried again next save
    readFrom = text;
  }
  async function saveNow(){
    if (timer != null){ deps.cancel(timer); timer = null; }
    const text = s.text;
    try {
      if (s.id == null){
        if (!text.trim()) return;
        s.status = "saving"; changed();
        const made = await post("/quicknote/new", text);
        s.id = made.note.id;
        remember(s.id);
      } else if (text !== s.saved){
        s.status = "saving"; changed();
        await post("/quicknote/save?id=" + encodeURIComponent(s.id), text);
      }
      s.saved = text;
      await attachStep(text);
      s.status = "saved";
    } catch (e){
      s.status = "failed";
    }
    changed();
  }
  async function dropIfEmpty(){
    if (s.id == null || s.text.trim() || unsaved()) return;
    const id = s.id;
    await post("/quicknote/del?id=" + encodeURIComponent(id));
    s.notes = s.notes.filter(n => n.id !== id);
    show(null);
    s.status = "";
  }
  s.input = text => {
    s.text = String(text == null ? "" : text);
    if (timer != null) deps.cancel(timer);
    timer = deps.schedule(() => { timer = null; run(saveNow); }, QUICK_NOTE_SAVE_MS);
  };
  s.flush = () => run(saveNow);
  // opening: words still waiting go first, then the list is read fresh and the
  // note being written is shown as the board holds it now, which is what lets
  // someone else's later edit to it be seen rather than written over
  s.open = () => run(async () => {
    await saveNow();
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    if (!unsaved()){
      const want = s.id || recall();
      show((want && s.notes.find(n => n.id === want)) || null);
    }
    changed();
  });
  s.openNote = id => run(async () => {
    await saveNow();
    if (unsaved()){ changed(); return; }
    if (id !== s.id){ try { await dropIfEmpty(); } catch (e){} }
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    const note = s.notes.find(n => n.id === id);
    if (note) show(note);
    changed();
  });
  s.close = () => run(async () => {
    await saveNow();
    try { await dropIfEmpty(); } catch (e){}
    changed();
  });
  // walking the notes with no chrome to walk them by: dir 1 is the next older
  // note and -1 the next newer, newest first as the board last read them, and
  // one newer than the newest is a blank note, which is how a new one is
  // started. past the oldest, or newer than a blank note, nothing moves. the
  // words on screen go first, and words that cannot be saved hold the note
  // where it is, so a step can never walk away from them
  s.step = dir => run(async () => {
    await saveNow();
    if (unsaved()){ changed(); return; }
    try { await load(); } catch (e){ s.status = "failed"; changed(); return; }
    const at = s.id == null ? -1 : s.notes.findIndex(n => n.id === s.id);
    const to = at + (dir > 0 ? 1 : -1);
    if (to >= s.notes.length || to < -1 || (to === -1 && s.id == null)){ changed(); return; }
    const next = to >= 0 ? s.notes[to] : null;
    try { await dropIfEmpty(); } catch (e){}
    show(next);
    s.status = "";
    changed();
  });
  return s;
}

// the overlay: one plain card in the middle of the window over a veil that
// covers the board, and on the card nothing but the words and the caret. no
// title, no buttons, no status, no hint: the note is the text area, and the
// card's glass is the whole of its look. built once into host by the page that
// shows it. what comes back opens it, on the note being written or on one note
// by id, pulled out of the rectangle it was pressed from when one is given;
// closes it; and says whether it is open. opts carries what the session needs,
// plus onOpen, onClose, onChange and onMoved for the page's own bookkeeping,
// its keys and its caret above all. nothing runs until a page calls this
function quickNoteOverlay(host, opts){
  const session = quickNoteSession(opts);
  const veil = h("div", "qn-veil");
  veil.setAttribute("aria-hidden", "true");
  const card = h("div", "qn-card qn-glass");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "Quick note");
  const ta = h("textarea", "qn-text");
  ta.setAttribute("aria-label", "quick note");
  card.appendChild(ta);
  veil.appendChild(card);
  host.appendChild(veil);

  let open = false, back = null, downOutside = false;
  // the one mark the card ever wears: while words on it could not be saved,
  // its hairline rim turns the board's warning red, and it goes back the
  // moment a save lands. no words, and nothing that stays once it is true again
  function render(){ card.classList.toggle("failed", session.status === "failed"); }
  session.onChange = () => { render(); if (opts.onChange) opts.onChange(session); };
  function caretEnd(){
    ta.focus();
    const end = ta.value.length;
    if (typeof ta.setSelectionRange === "function") ta.setSelectionRange(end, end);
  }
  // a switch of note puts the board's words in the field; the field takes no
  // typing while that is under way, so nothing typed can land in the gap
  async function settle(step){
    ta.readOnly = true;
    await step;
    ta.readOnly = false;
    if (ta.value !== session.text) ta.value = session.text;
    render();
  }
  // the pull from where it was pressed into the middle, as one short glide
  function pull(from){
    if (!from || typeof card.animate !== "function") return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = card.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const scale = Math.min(1, Math.max(.2, from.width / to.width));
    const glide = card.animate([{ transform: "translate(" + dx + "px, " + dy + "px) scale(" + scale + ")", opacity: .6 },
                                { transform: "none", opacity: 1 }],
                               { duration: 220, easing: "cubic-bezier(.42,.06,.38,1)" });
    // a page that draws its own caret over the field placed it while the card
    // was still on its way; it is told once the card has come to rest
    if (glide && glide.finished && opts.onMoved) glide.finished.then(() => opts.onMoved(), () => {});
  }
  async function openOverlay(id, from){
    if (!open){
      open = true;
      back = document.activeElement;
      ta.value = session.text;
      veil.classList.add("open");
      veil.setAttribute("aria-hidden", "false");
      pull(from);
      ta.focus();
      if (opts.onOpen) opts.onOpen();
    }
    await settle(id ? session.openNote(id) : session.open());
    if (open) caretEnd();
  }
  function close(){
    if (!open) return Promise.resolve();
    open = false;
    veil.classList.remove("open");
    veil.setAttribute("aria-hidden", "true");
    if (opts.onClose) opts.onClose();
    const to = back;
    back = null;
    if (to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
    else if (card.contains(document.activeElement)) document.activeElement.blur();
    return session.close();
  }

  ta.addEventListener("input", () => session.input(ta.value));
  // the keys are the note's own while it is open: Escape puts it away, and no
  // key goes on to the board it covers. the board's own reply history chord,
  // control shift up and down, walks the notes the way it walks a card's
  // replies: up is the next older note, down the next newer, and down from the
  // newest is a blank note, which is the whole of starting a new one. nothing
  // on the card names it
  veil.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape"){ e.preventDefault(); close(); return; }
    const shortcut = cardShortcut(e);
    if (!shortcut || shortcut.action !== "history") return;
    e.preventDefault();
    settle(session.step(shortcut.value)).then(() => { if (open) caretEnd(); });
  });
  // a press that starts and ends on the veil, outside the card, puts it away;
  // a selection dragged out of the card and let go on the veil does not
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => {
    if (downOutside && e.target === veil) close();
    downOutside = false;
  });
  // and focus cannot wander onto the board behind it
  document.addEventListener("focusin", e => {
    if (open && !card.contains(e.target)) ta.focus();
  });
  return { open: openOverlay, close, isOpen: () => open, session, root: veil };
}

// ---- the settings page ---------------------------------------------------------
// the board's own choices on one page, the same one on the desktop board, where
// it is an overlay, and on the phone, where it fills the screen. each page keeps
// its controls in the markup, grouped
// under one element per section carrying data-section and data-label, so every
// control keeps its id and its own wiring; this builds the page around them and
// moves each group into its pane. nothing here reads or writes a setting.
// the width it turns from a column of sections beside the settings to a list
// that opens one section at a time is 989px, the board's own single column width
const SETTINGS_NARROW_PX = 989;
const SETTINGS_NARROW = "(max-width: " + SETTINGS_NARROW_PX + "px)";
const SETTINGS_MARKS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
};
function settingsMark(name){
  const svg = h("span");
  svg.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    SETTINGS_MARKS[name] + '</svg>';
  return svg.firstChild;
}

// the three window buttons a Mac window wears at its top left. the red one puts
// the page away, and its x shows while a pointer is over the group; the yellow
// and the green have nothing to do, since the page cannot be minimised or
// zoomed, so they are greyed out, carry no mark, and the keyboard skips them
const SETTINGS_LIGHTS = ["red", "yellow", "green"];
function settingsLights(close){
  const group = h("div", "sp-lights");
  for (const name of SETTINGS_LIGHTS){
    const light = h(name === "red" ? "button" : "span", "sp-light sp-" + name);
    if (name === "red"){
      light.type = "button";
      light.setAttribute("aria-label", "Close settings");
      light.addEventListener("click", close);
      light.innerHTML = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" ' +
        'stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.75 3.75l4.5 4.5M8.25 3.75l-4.5 4.5"/></svg>';
    } else {
      light.setAttribute("role", "button");
      light.setAttribute("aria-disabled", "true");
      light.setAttribute("aria-label", name === "yellow" ? "Minimise" : "Maximise");
    }
    group.appendChild(light);
  }
  return group;
}

// fills root, which becomes the page, from source, the element holding the
// section groups. opts.close puts the whole page away. opts.lights, on the
// desktop, adds the window buttons that do it. opts.narrow, where the
// window is not what decides, is a query like matchMedia's that says when the
// page is narrow. what comes back moves between the list and one section, and
// says where it stands
function settingsPage(root, source, opts){
  const narrow = opts.narrow || matchMedia(SETTINGS_NARROW);
  root.classList.add("qn-glass", "sp-page");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Settings");

  const back = h("button", "sp-icon sp-back");
  back.type = "button";
  back.setAttribute("aria-label", "Back to settings");
  back.appendChild(settingsMark("back"));
  const title = h("h2", "sp-title", "Settings");
  const head = h("div", "sp-head");
  if (opts.lights) head.appendChild(settingsLights(() => opts.close()));
  head.append(back, title);

  const list = h("nav", "sp-list");
  list.setAttribute("aria-label", "Settings sections");
  const panes = h("div", "sp-panes");
  const sections = [...source.querySelectorAll(":scope > [data-section]")].map(group => {
    const id = group.dataset.section, label = group.dataset.label;
    const item = h("button", "sp-item");
    item.type = "button";
    item.dataset.section = id;
    item.append(h("span", "", label));
    const next = h("span", "sp-next");
    next.appendChild(settingsMark("next"));
    item.appendChild(next);
    const pane = h("section", "sp-pane");
    pane.id = "settings-" + id;
    pane.setAttribute("aria-label", label);
    pane.appendChild(h("h3", "sp-panehead", label));
    pane.append(...group.childNodes);
    list.appendChild(item);
    panes.appendChild(pane);
    return { id, label, item, pane };
  });
  source.remove();
  const body = h("div", "sp-body");
  body.append(list, panes);
  root.replaceChildren(head, body);

  let current = sections[0], view = "list";
  function paint(){
    const detail = narrow.matches && view === "pane";
    root.dataset.view = view;
    root.toggleAttribute("data-narrow", narrow.matches);
    back.hidden = !detail;
    title.textContent = detail ? current.label : "Settings";
    for (const s of sections){
      const on = s === current;
      s.item.classList.toggle("on", on);
      s.pane.classList.toggle("on", on);
      if (on && !narrow.matches) s.item.setAttribute("aria-current", "true");
      else s.item.removeAttribute("aria-current");
    }
  }
  function show(id){
    const next = sections.find(s => s.id === id);
    if (!next) return;
    current = next;
    view = "pane";
    panes.scrollTop = 0;
    paint();
    if (narrow.matches) back.focus({ preventScroll: true });
  }
  function toList(){
    view = "list";
    paint();
    if (narrow.matches) current.item.focus({ preventScroll: true });
  }
  for (const s of sections) s.item.addEventListener("click", () => show(s.id));
  back.addEventListener("click", toList);
  if (typeof narrow.addEventListener === "function") narrow.addEventListener("change", paint);
  paint();
  return {
    show, list: toList, root,
    section: () => current.id,
    inDetail: () => narrow.matches && view === "pane",
    // it opens on the list; where the list is not alone, the section last seen shows beside it
    reset(){ view = "list"; panes.scrollTop = 0; paint(); },
    focus(){ current.item.focus({ preventScroll: true }); },
  };
}

// a query like matchMedia's, on the width of one element instead of the window
function widthQuery(el, limit){
  const heard = [];
  if (typeof ResizeObserver === "function") new ResizeObserver(() => heard.forEach(fn => fn())).observe(el);
  return {
    get matches(){ return el.getBoundingClientRect().width <= limit; },
    addEventListener(type, fn){ heard.push(fn); },
  };
}

// the desktop's seat for the page: a veil over the whole window, the same one
// the quick note opens over, with the page centred on it at about seven tenths
// of the window each way. the page turns between its two layouts by its own
// width, not the window's. a press on the veil outside the page, Escape and the
// red window button all put the whole page away from either view, and no key
// goes on to the board it covers. opts carries onOpen and onClose for the page's
// own bookkeeping
function settingsOverlay(host, source, opts){
  const veil = h("div", "qn-veil sp-veil");
  veil.setAttribute("aria-hidden", "true");
  const seat = h("div");
  // a press on bare glass leaves focus on the page, so Escape still reaches the veil
  seat.tabIndex = -1;
  veil.appendChild(seat);
  host.appendChild(veil);
  let open = false, back = null, downOutside = false;
  const page = settingsPage(seat, source, { close, lights: true, narrow: widthQuery(seat, SETTINGS_NARROW_PX) });
  function openOverlay(){
    if (open) return;
    open = true;
    back = document.activeElement;
    veil.classList.add("open");
    page.reset();
    veil.setAttribute("aria-hidden", "false");
    if (opts.onOpen) opts.onOpen();
    page.focus();
  }
  function close(){
    if (!open) return;
    open = false;
    veil.classList.remove("open");
    veil.setAttribute("aria-hidden", "true");
    if (opts.onClose) opts.onClose();
    const to = back;
    back = null;
    if (to && to.isConnected && typeof to.focus === "function") to.focus({ preventScroll: true });
    else if (seat.contains(document.activeElement)) document.activeElement.blur();
  }
  veil.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape"){ e.preventDefault(); close(); }
  });
  // a press that starts and ends on the veil, outside the page, puts it away;
  // a selection dragged out of the page and let go on the veil does not
  veil.addEventListener("pointerdown", e => { downOutside = e.target === veil; });
  veil.addEventListener("click", e => {
    if (downOutside && e.target === veil) close();
    downOutside = false;
  });
  // and focus cannot wander onto the board behind it
  document.addEventListener("focusin", e => {
    if (open && !seat.contains(e.target)) page.focus();
  });
  return { open: openOverlay, close, isOpen: () => open, page, root: veil };
}
