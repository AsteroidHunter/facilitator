/* A card's magic box: where it stands beside the card on the Mac board, how big
   what it shows is in any room (the phone's drawer is one), and the sealed
   frames it shows pages in. What can be worked out without a page is kept
   here, so it is tested without a browser; card-tokens.css holds its look,
   card-logic.js its drawing, and each page its element and wiring. Every
   length on the board is in the 1440 by 900 stage's own pixels. */
(function (root) {
  "use strict";
  // the box at full size, as shares of the card's height: an iPhone 13 mini
  // screen's shape (375 by 812 points) as tall as the card, then 5% taken off
  // its top and 5% off its foot, and 7% of its width added on each side. SHAPE
  // is width over height. Shares only, so the box's size always comes from the
  // card and the window
  const TALL = 0.9;
  const WIDE = 375 / 812 * 1.14;
  const SHAPE = WIDE / TALL;
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
  // its top on the whole box's top
  function place(card, fit, want) {
    const scale = fit.scale || 1;
    const edge = (fit.right - fit.tx) / scale;   // the workspace's right edge, on the stage
    const clear = (fit.clear || 0) / scale;
    const middle = card.top + card.height / 2;
    const right = card.left + card.width;
    const room = edge - right;
    let width = Math.max(0, Math.min(card.height * WIDE, room - 2 * clear)), height = width / SHAPE;
    const shown = height >= card.height / 2;
    const top = middle - height / 2;
    ({ width, height } = fitRoom({ width, height }, want));
    const left = right + (room - width) / 2;
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
  // word: when given, the page tells the board it is still itself each time it
  // finishes loading, by posting the word to it. A page that has sent its frame
  // elsewhere loads without saying it, and the board puts the page back.
  // sized: the page says its own height too (PAGE_HEIGHT), and relays the
  // board's keys a sealed frame keeps (PAGE_BACK, PAGE_CREATE) and scrolls and
  // says its keys for control+S (PAGE_SCROLL); the Mac's box asks for it.
  // tall: the page says its height and nothing more, for the phone's drawer,
  // which lays the page out that tall and scrolls the box
  function pageDoc(html, word, sized, tall) {
    const W = JSON.stringify(String(word)).replace(/</g, "\\u003c");
    const told = sized ? PAGE_BACK + PAGE_CREATE + PAGE_HEIGHT + PAGE_SCROLL : tall ? PAGE_HEIGHT : "";
    const hello = word ? '<script>addEventListener("load", () => parent.postMessage(' + W + ', "*"))' +
      (told ? ';(() => { const W = ' + W + '; ' + told + ' })()' : "") + '</script>' : "";
    return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">' +
      '<meta name="referrer" content="no-referrer">' + (sized ? CALM : "") + '<script>' + KEYS_GUARD + '</script>' + hello +
      String(html == null ? "" : html);
  }
  // a website runs as itself, on its own origin, which is never the board's;
  // its frame is credentialless, so the owner's cookies, storage and saved
  // passwords stay out of it, and it may not open windows or move the board
  const SITE_SANDBOX = "allow-scripts allow-same-origin allow-forms";
  root.MagicBox = { TALL, WIDE, SHAPE, place, fit: fitRoom, PAGE_SANDBOX, PAGE_POLICY, KEYS_GUARD, pageDoc, SITE_SANDBOX };
})(globalThis);
