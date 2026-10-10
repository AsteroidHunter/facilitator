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
  // the box's full width), nothing for a page or a site, which have no size of
  // their own and take the whole of it. A picture's want may carry head, the
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
  // word: when given, the page tells the board it is still itself each time it
  // finishes loading, by posting the word to it. A page that has sent its frame
  // elsewhere loads without saying it, and the board puts the page back
  function pageDoc(html, word) {
    const hello = word ? '<script>addEventListener("load", () => parent.postMessage(' +
      JSON.stringify(String(word)).replace(/</g, "\\u003c") + ', "*"))</script>' : "";
    return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">' +
      '<meta name="referrer" content="no-referrer"><script>' + KEYS_GUARD + '</script>' + hello +
      String(html == null ? "" : html);
  }
  // a website runs as itself, on its own origin, which is never the board's;
  // its frame is credentialless, so the owner's cookies, storage and saved
  // passwords stay out of it, and it may not open windows or move the board
  const SITE_SANDBOX = "allow-scripts allow-same-origin allow-forms";
  root.MagicBox = { TALL, WIDE, SHAPE, place, fit: fitRoom, PAGE_SANDBOX, PAGE_POLICY, KEYS_GUARD, pageDoc, SITE_SANDBOX };
})(globalThis);
