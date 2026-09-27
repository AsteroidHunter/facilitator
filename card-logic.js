// The card's shared logic: what the desktop board (index.html) and the phone
// page (m.html) do to a card in common, kept once, as plain global functions.
// Each page loads it after card-markdown.js and before its own script. The
// functions here read the names each page declares itself: els (box id to the
// card's parts), lastState, selectedId, activeOwner, lastSel, and the page's own
// poll, select, growPend and boxHasSelection. The chosen list view is the other way round: it is
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
// pendTimes: the desktop's sent rows each carry the time a drag reveals; a page
// without that gesture leaves its rows bare
let pendTimes = false;
// pendRoomChanged: what a page does once the sent box has taken its room or
// given it back. the desktop re-snaps the answer's lines against the box
let pendRoomChanged = null;
// answeredRoomChanged: the same, for the panel that stands ABOVE the answer
// holding the messages that answer was given. it rides at the head of the
// answer's own scroller rather than being laid over the answer, so the room it
// takes is room the answer does not have, and the desktop re-snaps its lines
// against it whenever the panel arrives, leaves, or is opened or cut back
let answeredRoomChanged = null;

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
  // control+n moves the selected card to Doing ("now") and control+l to
  // Deferred ("later"). Plain letters are no command: a stray n or s used to
  // move a card. Inside a text box macOS keeps control+n and control+l for the
  // caret, so the pages act on these only when nothing is being typed
  {
    action: "destination", mini: false,
    match: e => e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey &&
      !e.repeat && !e.isComposing && !e.defaultPrevented &&
      (e.key === "n" || e.key === "N" || e.key === "l" || e.key === "L")
      ? ((e.key === "l" || e.key === "L") ? "deferred" : "doing") : null,
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

// what a press means now. a run wears the open class through a shutting as well,
// so the class on its own reads a box that is shutting as one to shut again; the
// direction the run is going is the answer for as long as it is going
function foldWants(pend){
  if (pend.classList.contains("closing")) return true;
  if (pend.classList.contains("opening")) return false;
  return !pend.classList.contains("open");
}

// the fold's one run, the card's own: the box's height and padding and the
// column inside it move over one length on one curve, so they start and settle
// together, and a press that catches a run freezes it where it stands and
// re-aims from there rather than starting it over. the page hands in its run
// counter and the rule its lane opens on; the sheet holds the length, the curve
// and the travel. motion the reader has asked not to see is a plain flip.
const FOLD_TIMER_MS = 430;   // behind the sheet's run, for a fold with nothing to transition
function foldStrip(el, pend, runKey, open, place){
  if (!pend) return;
  const mine = ++el[runKey];
  const body = pend.querySelector(".pendbody");
  const settle = () => {
    pend.classList.remove("motion", "opening", "closing", "offseat");
    pend.style.height = "";
    pend.style.paddingTop = "";
    pend.style.paddingBottom = "";
    body.style.transform = "";
    body.style.opacity = "";
  };
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches){
    settle();
    pend.classList.toggle("open", open);
    if (open) place(pend);
    return;
  }
  const was = getComputedStyle(body);
  const held = was.transform, heldFade = was.opacity;
  const from = pend.getBoundingClientRect().height;
  const csFrom = getComputedStyle(pend);
  const padFrom = [csFrom.paddingTop, csFrom.paddingBottom];
  settle();
  pend.classList.toggle("open", open);
  if (open) place(pend);
  const to = pend.getBoundingClientRect().height;
  const csTo = getComputedStyle(pend);
  const padTo = [csTo.paddingTop, csTo.paddingBottom];
  if (!open) pend.classList.add("open");   // it shuts with its rows still in it
  pend.style.height = from + "px";
  pend.style.paddingTop = padFrom[0];
  pend.style.paddingBottom = padFrom[1];
  if (held && held !== "none"){ body.style.transform = held; body.style.opacity = heldFade; }
  else pend.classList.toggle("offseat", open);
  void pend.offsetWidth;   // the start values land untimed
  pend.classList.add("motion");
  pend.classList.add(open ? "opening" : "closing");
  pend.style.height = to + "px";
  pend.style.paddingTop = padTo[0];
  pend.style.paddingBottom = padTo[1];
  body.style.transform = "";
  body.style.opacity = "";   // the class below is the column's own far end
  pend.classList.toggle("offseat", !open);
  const done = e => {
    if (e && (e.target !== pend || e.propertyName !== "height")) return;
    pend.removeEventListener("transitionend", done);
    clearTimeout(timer);
    if (mine !== el[runKey]) return;   // a newer fold owns the box now
    pend.classList.remove("motion");
    pend.style.height = "";
    pend.style.paddingTop = "";
    pend.style.paddingBottom = "";
    pend.classList.remove("offseat");
    body.style.transform = "";
    body.style.opacity = "";
    pend.classList.toggle("open", open);
    if (open) place(pend);
    setTimeout(() => {
      if (mine !== el[runKey]) return;
      pend.classList.remove("opening", "closing");
    }, 40);
  };
  pend.addEventListener("transitionend", done);
  const timer = setTimeout(done, FOLD_TIMER_MS);
}

// one row: the words, the time that comes up on a drag where the page keeps
// one, and the delivery word. the time goes in FRONT of the words: it is
// positioned absolutely, so its place in the order draws nothing differently,
// and standing last it would be the bubble's last child, leaving the last
// block of prose its own bottom margin inside the bubble's air, which the
// card prose rules zero on the last child alone
function pendRow(text, ts){
  const row = h("div", "pendmsg");
  row.dataset.text = text;
  const content = h("div", "pendcontent cardmd");
  content.innerHTML = fmt(text);
  if (pendTimes){
    const t = h("span", "ptime", stampText(ts));
    content.prepend(t);
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
// being waited on began. an entry queued before the server recorded times
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
// order they were sent, with a hairline between one message and the next. a
// batch taller than the panel's preview is shown cut to its first lines, fading
// out over a small arrow, and a click or a tap anywhere on it shows the whole
// batch in place; another cuts it back. a batch that fits the preview is simply
// shown whole, with no arrow and nothing to press. the desktop card, the phone
// card and the small card all build it here and draw it from the one set of
// rules in card-tokens.css, each at its own size.

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

// the panel's one arrow, centred under a cut batch and pointing down at the
// rest of it. a path and not a font glyph, so its weight holds at any scale; it
// is the sent box's own chevron turned over
const ANSWERED_CHEV = '<svg class="answchev" width="11" height="7" viewBox="0 0 11 7"' +
  ' fill="none" aria-hidden="true"><path d="M1 1.35 5.5 5.65 10 1.35" stroke="currentColor"' +
  ' stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// the panel's markup, built here so no surface can drift from another: the cut,
// the column of messages inside it, and the arrow. room is who the surface
// wants told when the panel changes its own height, which only an opening or a
// cutting back does: the desktop card re-snaps the answer's lines on it, and
// the small card has nobody to tell
function answeredPanel(room){
  const panel = h("div", "answered");
  panel.innerHTML = '<div class="answclip"><div class="answstack"></div></div>' + ANSWERED_CHEV;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "your messages that the reply below answers");
  panel.addEventListener("click", e => {
    // a batch shown whole has nothing more to show
    if (!panel.classList.contains("more")) return;
    // a link or a player inside a message keeps its own press, and a press that
    // ends picking out some of the words is a copy rather than a request
    if (e.target && e.target.closest && e.target.closest("a, button, audio, video")) return;
    if (boxHasSelection(panel)) return;
    openAnswered(panel, !panel.classList.contains("open"));
    if (room) room();
  });
  // whether a batch runs past the preview can only be read off a panel that is
  // laid out, and a card that is not on screen is not. so it is read again
  // whenever the column of messages changes size: the card coming on screen,
  // the window being resized, a picture in a message landing
  if (typeof ResizeObserver !== "undefined"){
    panel.answWatch = new ResizeObserver(() => fitAnswered(panel));
    panel.answWatch.observe(panel.querySelector(".answstack"));
  }
  return panel;
}

// open shows the whole batch in place and shut cuts it back to the preview. the
// fade and the arrow are the sheet's, worn off the classes alone
function openAnswered(panel, open){
  panel.classList.toggle("open", open);
  // the column may have been resized while it stood open
  if (!open) fitAnswered(panel);
}

// whether the batch runs past the preview. an open panel shows everything and
// so cannot say: it keeps the word it was opened under, since only a batch
// that ran past could be opened at all. a panel that is not laid out measures
// nothing and says nothing, and the observer asks again once it is
function fitAnswered(panel){
  if (panel.classList.contains("open")) return;
  const clip = panel.querySelector(".answclip");
  if (!clip || !clip.clientHeight) return;
  panel.classList.toggle("more", clip.scrollHeight > clip.clientHeight + 1);
}

// one message is one block of the card's own prose: the same markdown, the same
// attachment markup and the same wrapping the sent rows below are drawn in, and
// nothing around it. the hairline the sheet draws between two blocks is the
// whole of what tells one message from the next. another batch starts cut to
// the preview again, and is measured for it
function fillAnswered(panel, batch){
  const stack = panel.querySelector(".answstack");
  stack.textContent = "";
  for (const m of batch){
    const msg = h("div", "answmsg cardmd");
    msg.innerHTML = fmt((m && m.text) || "");
    stack.appendChild(msg);
  }
  panel.classList.remove("open", "more");
  fitAnswered(panel);
}

function dropAnswered(el, room){
  if (!el || !el.answ) return;
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
// names nobody
function syncAnswered(el, meta, room = answeredRoomChanged){
  if (!el || !el.answwrap) return;
  const batch = answeredBatch(meta);
  if (!batch || !batch.length){ dropAnswered(el, room); return; }
  if (el.answ && el.answId === meta.id) return;
  if (!el.answ){
    el.answ = answeredPanel(room);
    el.answwrap.appendChild(el.answ);
  }
  el.answId = meta.id;
  fillAnswered(el.answ, batch);
  if (room) room();
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

// Control+n and control+l name destinations, unlike the moon's reversible tap. Read
// the held value so a second key during an unanswered request is judged against
// what the card already shows, then use the same ordered flag requests as a tap.
function setCardDestination(id, destination){
  if (destination === "deferred"){
    if (!flagShown(id, "park")) return setFlag(id, "park", true);
  } else if (destination === "doing"){
    const parked = flagShown(id, "park"), done = flagShown(id, "done");
    if (parked) setFlag(id, "park", false);
    if (done) return setFlag(id, "done", false);
  }
}

// Closing a card and snoozing the card on screen use the same Doing fallback.
function selectNextDoing(id){
  const doing = lastState ? poolOf(lastState).filter(b =>
    !b.done && !b.parked && b.id !== id && b.id !== "0" && b.id !== "t0") : [];
  if (doing.length) select(doing[0].id); else deselect();
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
  sun.title = "move to doing";
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
// and control+n's read of it sees none; the reading's own park flag is asked as
// well here, or the sun would lift the done and leave the card in deferred
function wakeCard(id){
  const b = typeof lastState === "undefined" ? null : lastState?.boxes.find(x => x.id === id);
  if (b && b.parked && !flagHolds[flagKey(id, "park")] && !flagShown(id, "park")) setFlag(id, "park", false);
  return setCardDestination(id, "doing");
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
  if (advance) selectNextDoing(id);
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
    if (e.key === "Enter"){ e.preventDefault(); commit(); el.ta.focus(); }
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
    (el.replyview || el.reply).scrollTop = 0;   // the answer's own scroller back to its top
    // back on the live reply, so the panel over it is the live reply's own batch
    // again. the card is read out of the state the page is holding rather than
    // remembered from the step away, so a reply that landed while an older page
    // was being read is the one that comes back
    syncAnswered(el, liveAnswered(stateBoxOf(id)));
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
  (el.replyview || el.reply).scrollTop = 0;   // the answer's own scroller back to its top
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
