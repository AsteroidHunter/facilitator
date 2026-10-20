/* A card's magic box: where it stands beside the card on the Mac board, how big
   what it shows is in any room (the phone's drawer is one), and the sealed
   frames it shows pages in. What can be worked out without a page is kept
   here, so it is tested without a browser; card-tokens.css holds its look,
   card-logic.js its drawing, and each page its element and wiring. Every
   length on the board is in the 1440 by 900 stage's own pixels. */
(function (root) {
  "use strict";
  // the box at full size, as shares of the card's height: the size the owner
  // set in the layout mock (m1330), 67 by 125 edit steps (385.92 by 720)
  // beside the starting card, 133 steps (766.08) tall. SHAPE is width over
  // height. Shares only, so the box's size always comes from the card and the
  // window
  const TALL = 125 / 133;
  const WIDE = 67 / 133;
  const SHAPE = WIDE / TALL;
  // the most the box stands from its card at the board's full size, as a share
  // of the card's width: the gap the Mac laptop's window gives the box, never
  // more, so on a larger window it stays as near its card as it is there. with
  // the starting card that is 52.19, where the owner set it in the mock
  const GAP = 0.1007;
  // card: the card's rectangle, {left, top, width, height}. fit: the stage's
  // transform and the workspace, {scale, tx, right, clear}, right the screen x
  // of the workspace's inner right edge and clear the room the fit keeps
  // between the board and it (FRAME_CLEAR), all screen pixels. want: what the
  // box shows asks for, in stage pixels:
  // {width, height} for a picture (its own shape, and at most its own size so it
  // is never drawn past its sharpness), {height} for words (their own height at
  // the box's full width) and for an agent's page that has said its height,
  // nothing for a site or a page that has not, which take the whole of it. A
  // picture's want may carry head, the
  // height of the box's own top bar: the bar keeps its height while the
  // picture under it is fitted to what is left.
  // The whole box keeps its shape. It is at full size when that leaves at least
  // `clear` on each side of it in the room right of the card, and as much
  // smaller as it must be when it does not; the board never shrinks for it.
  // Less than half the card's height is too small to read beside it, and the
  // box never stands over the card: then it is not shown at all (shown is
  // false). It stays open, and shows again by itself once the window gives it
  // that room. Inside that whole box, what it shows takes its own size: a
  // picture its own shape, as large as fits, and words their own height, then
  // scroll. The whole box stands with its middle level with the card's.
  // Whatever size results stands in the middle of the room right of the card,
  // so the gap to the card and the gap to the workspace's edge are equal, with
  // its top on the whole box's top. The stage never grows, so once the window
  // is big enough for the board at its full size (scale 1) more window is only
  // more room, and the box would drift from its card with it: there the gap to
  // the card stops at GAP of the card's width, and the gap to the workspace's
  // edge takes the rest. Under that share, and wherever the board is shrunk to
  // fit, the box stands as it always has.
  // side "left" stands it in the room left of the card instead, the same way
  // turned over: fit.left is then the screen x of the workspace's inner left
  // edge, and the gap is kept to the card's left edge. The agent's response
  // piped out beside a long reply (index.html) stands either side
  function place(card, fit, want, side) {
    const scale = fit.scale || 1;
    const leftward = side === "left";
    const edge = ((leftward ? fit.left : fit.right) - fit.tx) / scale;   // the workspace's edge, on the stage
    const clear = (fit.clear || 0) / scale;
    const middle = card.top + card.height / 2;
    const near = leftward ? card.left : card.left + card.width;
    const room = leftward ? near - edge : edge - near;
    let width = Math.max(0, Math.min(card.height * WIDE, room - 2 * clear)), height = width / SHAPE;
    const shown = height >= card.height / 2;
    const top = middle - height / 2;
    // the whole box's gap to the card with the room shared evenly, and what it
    // is held to; what the box shows is centred in the whole box as before
    const spare = (room - width) / 2;
    const held = scale >= 1 ? Math.min(spare, GAP * card.width) : spare;
    ({ width, height } = fitRoom({ width, height }, want));
    const gap = (room - width) / 2 - (spare - held);
    const left = leftward ? near - gap - width : near + gap;
    return { left, top, width, height, shown };
  }
  // what the box shows, at its own size inside a room {width, height}: want as
  // place() takes it. The phone's drawer is such a room, with no card beside it.
  // MagicBox.fit
  function fitRoom(room, want) {
    let { width, height } = room;
    if (want && want.width > 0 && want.height > 0) {
      const head = Math.min(want.head || 0, height);
      const s = Math.min(1, width / want.width, (height - head) / want.height);
      width = want.width * s;
      height = want.height * s + head;
    } else if (want && want.height > 0) {
      height = Math.min(height, want.height);
    }
    return { width, height };
  }
  // the box expanded over the dimmed board, by the green button at the other
  // end of its bar from the cross: BIG of the room's width and of its height,
  // centred in it. the room is the Mac's window and the phone's screen,
  // {left, top, width, height}. inside: the part of the room it must keep to
  // (the phone's screen inside its safe areas, clear of the notch and the home
  // bar), whose edges cut it. square: a site that will not be framed, which
  // stays a square, as large as the shorter side allows, in the middle
  const BIG = { mac: 0.9, phone: 0.95 };
  function grow(room, share, square, inside) {
    let width = room.width * share, height = room.height * share;
    let left = room.left + (room.width - width) / 2, top = room.top + (room.height - height) / 2;
    if (inside) {
      const right = Math.min(left + width, inside.left + inside.width), bottom = Math.min(top + height, inside.top + inside.height);
      left = Math.max(left, inside.left); top = Math.max(top, inside.top);
      width = Math.max(0, right - left); height = Math.max(0, bottom - top);
    }
    if (square) {
      const side = Math.min(width, height);
      left += (width - side) / 2; top += (height - side) / 2;
      width = height = side;
    }
    return { left, top, width, height };
  }
  // the box poured between its expanded place (big) and its own (small) as a
  // Mac window pours into the Dock and back out (the Dock's Genie effect),
  // drawn as thin level strips, each with its own left and right ends. s is
  // how far it has gone, 0 at big and 1 at small; the way out is the same
  // played backwards. each row of the box sets off on a clock of its own, the
  // bottom row at once and the top row a share of the way later (stagger),
  // and goes the rest of the way eased in and out, so the bottom narrows and
  // swings toward the place first while the top holds, the two sides bend
  // into curves between them, and the top follows the bottom in. a place
  // wholly above the box is led into by the top row. the rows stand evenly
  // between the box's top and bottom edges, which each go with the row at
  // that edge, so no row ever crosses another. rows: how many strips. gives
  // rows + 1 edges, top to bottom, {v, y, left, right, q}: v the row's place
  // down the box (0 to 1), and q how far it has gone, which says how much of
  // the place's look it wears
  const GENIE = { stagger: 0.45 };
  function genie(big, small, s, rows) {
    const K = GENIE.stagger, up = small.top + small.height <= big.top;
    const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
    const gone = v => ease((s - K * (up ? v : 1 - v)) / (1 - K));
    const go = (a, b, p) => a + (b - a) * p;
    const top = go(big.top, small.top, gone(0)), bottom = go(big.top + big.height, small.top + small.height, gone(1));
    const edges = [];
    for (let i = 0; i <= rows; i++) {
      const v = i / rows, q = gone(v);
      edges.push({ v, q, y: go(top, bottom, v), left: go(big.left, small.left, q),
        right: go(big.left + big.width, small.left + small.width, q) });
    }
    return edges;
  }
  // a page an agent wrote runs sealed off: its frame has scripts and nothing
  // else, so its origin is its own and never the board's (no same origin, no
  // forms, no popups, no way to the top window). Its buttons, fields and
  // drawings work, since they are its own script. This policy stands first
  // in the page, ahead of anything the agent wrote, so the page loads nothing
  // from anywhere and sends nothing anywhere. A second policy the agent adds
  // can only narrow it further
  const PAGE_SANDBOX = "allow-scripts";
  const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; " +
    "form-action 'none'; base-uri 'none'";
  // the page may not take the keys by itself: it comes beside the card while the
  // owner may be typing there. Run ahead of anything the agent wrote, this
  // makes focusing anything in the page, or the page itself, do nothing unless
  // the owner has just clicked or typed in it, so a field the owner clicks
  // still takes the caret and a widget may still move it on after a click.
  // A browser that cannot tell whether the owner did leaves focus alone
  const KEYS_GUARD = "(() => {" +
    "const ua = navigator.userActivation, asked = () => !!ua && ua.isActive;" +
    "for (const P of [HTMLElement.prototype, SVGElement.prototype, globalThis.MathMLElement && MathMLElement.prototype]) {" +
    "const real = P && P.focus; if (!real) continue;" +
    "Object.defineProperty(P, 'focus', { value: function focus(o) { if (asked()) return real.call(this, o); } }); }" +
    "const win = window.focus;" +
    "Object.defineProperty(window, 'focus', { value: function focus() { if (asked()) return win.call(window); } });" +
    "})();";
  // the page's own height, for a board that sizes the box to it: how far down
  // its words and pictures reach, with the body's own white under them, which
  // does not grow with the frame, so a box made shorter to fit it measures the
  // same again. Said as the word, a space and the height in the page's pixels,
  // once it has loaded and again whenever it changes (a picture arriving)
  const PAGE_HEIGHT = "const say = () => { const b = document.body; if (!b) return;" +
    "const r = document.createRange(); r.selectNodeContents(b);" +
    "const s = getComputedStyle(b), d = getComputedStyle(document.documentElement), n = v => parseFloat(v) || 0;" +
    "const h = Math.ceil(r.getBoundingClientRect().bottom + scrollY + n(s.paddingBottom) + n(s.borderBottomWidth) +" +
    " n(s.marginBottom) + n(d.paddingBottom) + n(d.borderBottomWidth));" +
    "if (h > 0 && h !== say.h) { say.h = h; parent.postMessage(W + ' ' + h, '*'); } };" +
    "addEventListener('load', () => { say(); if (window.ResizeObserver) new ResizeObserver(say).observe(document.body); });" +
    "document.addEventListener('load', say, true);";
  // control+option+left typed in the page never reaches the board, since a
  // sealed frame keeps its keys to itself, so the page says it to the board:
  // the word, a space and "back". It stands ahead of the agent's own script, in
  // capture on the window, which the agent's listeners cannot get in front of
  const PAGE_BACK = "addEventListener('keydown', e => {" +
    "if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft') {" +
    "e.preventDefault(); parent.postMessage(W + ' back', '*'); } }, true);";
  // Escape typed in the page puts the expanded box back to its size, and it too
  // never reaches the board from a sealed frame: the page says it, the word, a
  // space and "escape". It is read once every listener has had the key, so a
  // page that answers Escape itself (by preventDefault) keeps it
  const PAGE_ESCAPE = "addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing)" +
    " setTimeout(() => { if (!e.defaultPrevented) parent.postMessage(W + ' escape', '*'); }); }, true);";
  // command+T, the board's key for a new card, typed in the page would never
  // reach the board either, and Chrome would open a tab for it: the page stops
  // it and says it to the board, the word, a space and "create". Command alone,
  // and the T read as the board reads it (cardCommandKey): the character the
  // layout gives, or the physical key when that is no plain character
  const PAGE_CREATE = "addEventListener('keydown', e => { const k = (e.key || '').toLowerCase();" +
    "if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (k === 't' || (!/^[ -~]$/.test(k) && e.code === 'KeyT'))) {" +
    "e.preventDefault(); parent.postMessage(W + ' create', '*'); } }, true);";
  // control+S scrolls the page in the box as it scrolls the card. The board
  // cannot reach into a sealed frame, so the page is the one that scrolls, and
  // everything between is a short word to and fro (never a handle on either
  // side): the page says how far it has scrolled, how tall it is and how tall
  // its window is, "scroll top whole window n", each time any of them changes;
  // the board asks it to go somewhere, "to top n" (n counts the asks, and the
  // page gives the last one it has done back in its next word, so a report
  // that was in the air when the board moved on is never taken for where the
  // page is), and to give at an end, "bounce" with the keyframes. The page
  // also says the keys typed in it, for the board's own hold-to-scroll motion
  // to follow: "key" and a list of the kind (down or up), the key when it is
  // S or Control and nothing else, the four modifiers and whether it repeats.
  // A field in the page keeps control+S to itself
  const PAGE_SCROLL = "(() => {" +
    "const R = () => document.scrollingElement || document.documentElement; let done = 0, last = '', wait = 0, bounce = null;" +
    "const tell = () => { wait = 0; const r = R(), m = Math.round(r.scrollTop) + ' ' + r.scrollHeight + ' ' + r.clientHeight + ' ' + done;" +
    "if (m !== last) { last = m; parent.postMessage(W + ' scroll ' + m, '*'); } };" +
    "const soon = () => { if (!wait) wait = setTimeout(tell, 16); };" +
    "addEventListener('scroll', soon, true); addEventListener('resize', soon);" +
    "addEventListener('load', () => { soon(); if (window.ResizeObserver) { const o = new ResizeObserver(soon);" +
    "o.observe(document.documentElement); if (document.body) o.observe(document.body); }" +
    "new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true }); });" +
    "document.addEventListener('load', soon, true);" +
    "addEventListener('message', e => { if (e.source !== parent || typeof e.data !== 'string' || !e.data.startsWith(W + ' ')) return;" +
    "const w = e.data.slice(W.length + 1);" +
    "if (w.startsWith('to ')) { const [y, n] = w.slice(3).split(' ').map(Number);" +
    "if (isFinite(y) && isFinite(n)) { done = n; R().scrollTo({ top: y, behavior: 'instant' }); soon(); } }" +
    "else if (w.startsWith('bounce ')) { try { const [k, o] = JSON.parse(w.slice(7));" +
    "if (bounce) bounce.cancel(); bounce = document.documentElement.animate(k, o); } catch (_) {} } });" +
    "const say = (t, e) => parent.postMessage(W + ' key ' + JSON.stringify([t, e.key === 's' || e.key === 'S' || e.key === 'Control' ? e.key : ''," +
    "!!e.ctrlKey, !!e.shiftKey, !!e.metaKey, !!e.altKey, !!e.repeat]), '*');" +
    "addEventListener('keydown', e => { const t = e.target, field = t && t.closest && t.closest('input, textarea, select, [contenteditable]');" +
    "if (field && (e.key === 's' || e.key === 'S')) return say('down', { key: '' });" +
    "if (e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing && (e.key === 's' || e.key === 'S')) e.preventDefault();" +
    "say('down', e); }, true);" +
    "addEventListener('keyup', e => say('up', e), true);" +
    "addEventListener('blur', e => { if (e.target === window) say('up', { key: '' }); }, true);" +
    "})();";
  // the Mac's box shows no scrollbar inside a page, the board's rule for every
  // scroller (card-tokens.css) restated for the frame, which the board's sheet
  // does not reach. A page wider than the box scrolls sideways inside it, as
  // quietly as it scrolls down, so none of it is out of reach; a page that fits
  // has nothing to scroll and looks as it always did. It stands ahead of the
  // agent's own styles, which may still say otherwise
  const CALM = "<style>*{scrollbar-width:none}*::-webkit-scrollbar{display:none}html{overflow-x:auto}</style>";
  // the phone's page takes a finger itself, and a quick second tap on one of
  // its buttons would zoom the whole phone page: the phone's rule for every
  // element (m.html), which its sheet does not reach in the frame, restated
  // there. It stands ahead of the agent's own styles, which may still say
  // otherwise
  const TAPS = "<style>*{touch-action:manipulation}</style>";
  // word: when given, the page tells the board it is still itself each time it
  // finishes loading, by posting the word to it. A page that has sent its frame
  // elsewhere loads without saying it, and the board puts the page back.
  // sized: the page says its own height too (PAGE_HEIGHT), and relays the
  // board's keys a sealed frame keeps (PAGE_BACK, PAGE_CREATE, PAGE_ESCAPE) and
  // scrolls and says its keys for control+S (PAGE_SCROLL); the Mac's box asks
  // for it. tall: the page says its height and Escape and nothing more, for the
  // phone's drawer, which lays the page out that tall and scrolls the box, and
  // keeps a second tap from zooming (TAPS)
  function pageDoc(html, word, sized, tall) {
    const W = JSON.stringify(String(word)).replace(/</g, "\\u003c");
    const told = sized ? PAGE_BACK + PAGE_CREATE + PAGE_ESCAPE + PAGE_HEIGHT + PAGE_SCROLL : tall ? PAGE_HEIGHT + PAGE_ESCAPE : "";
    const hello = word ? '<script>addEventListener("load", () => parent.postMessage(' + W + ', "*"))' +
      (told ? ';(() => { const W = ' + W + '; ' + told + ' })()' : "") + '</script>' : "";
    return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">' +
      '<meta name="referrer" content="no-referrer">' + (sized ? CALM : tall ? TAPS : "") + '<script>' + KEYS_GUARD + '</script>' + hello +
      String(html == null ? "" : html);
  }
  // a website runs as itself, on its own origin, which is never the board's;
  // its frame is credentialless, so the owner's cookies, storage and saved
  // passwords stay out of it, and it may not open windows or move the board
  const SITE_SANDBOX = "allow-scripts allow-same-origin allow-forms";
  root.MagicBox = { TALL, WIDE, SHAPE, GAP, place, fit: fitRoom, BIG, grow, GENIE, genie, PAGE_SANDBOX, PAGE_POLICY, KEYS_GUARD, pageDoc, SITE_SANDBOX };
})(globalThis);
