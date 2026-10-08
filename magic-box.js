/* A card's magic box on the Mac board: where it stands beside the card, and the
   sealed frames it shows pages in. What can be worked out without a page is
   kept here, so it is tested without a browser; index.html holds the element,
   its looks and its wiring. Every length is in the 1440 by 900 stage's own
   pixels. */
(function (root) {
  "use strict";
  // one star cell: the stars sit at CELL * (n + 0.5) across the stage, and every
  // box edge on the board lands on one of them
  const CELL = 11.52;
  function onStar(x) { return (Math.floor(x / CELL - 0.5 + 1e-6) + 0.5) * CELL; }
  // the shape of an iPhone 13 mini's screen, 375 by 812 points: width over
  // height and nothing else, so the box's size always comes from the card and
  // the window
  const SHAPE = 375 / 812;
  // card: the card's rectangle, {left, top, width, height}. fit: the stage's
  // transform and the workspace, {scale, tx, left, right, clear}, left and right
  // the screen x of the workspace's inner edges and clear the room the fit keeps
  // between the board and them (FRAME_CLEAR), all screen pixels. bar: the height
  // of the card's top bar.
  // The box keeps the phone's shape. It is as tall as the card when that leaves
  // at least `clear` on each side of it in the room right of the card, and as
  // much smaller as it must be when it does not. It stands in the middle of that
  // room, so the gap to the card and the gap to the workspace's edge are always
  // equal, with its middle level with the card's; the board never shrinks for
  // it. Less than half the card's height is too small to read beside it: then
  // it floats over the card's right part, `clear` in from the edge, below the
  // first star row under the card's top bar so the card's own chips stay in
  // reach, and still level with the card's middle
  function place(card, fit, bar = 0) {
    const scale = fit.scale || 1;
    const edge = (fit.right - fit.tx) / scale;   // the workspace's right edge, on the stage
    const seen = (fit.left - fit.tx) / scale;    // and its left one
    const clear = (fit.clear || 0) / scale;
    const middle = card.top + card.height / 2;
    const right = card.left + card.width;
    const room = edge - right;
    const width = Math.min(card.height * SHAPE, room - 2 * clear);
    if (width / SHAPE >= card.height / 2) {
      const height = width / SHAPE;
      return { left: right + (room - width) / 2, top: middle - height / 2, width, height, floating: false };
    }
    const under = onStar(card.top + bar) + CELL - card.top;
    const across = Math.max(1, Math.min((card.height - 2 * under) * SHAPE, edge - seen - 2 * clear));
    const tall = across / SHAPE;
    return { left: edge - clear - across, top: middle - tall / 2, width: across, height: tall, floating: true };
  }
  // a page an agent wrote runs sealed off: its frame has scripts and nothing
  // else, so its origin is its own and never the board's (no same origin, no
  // forms, no popups, no way to the top window), and this policy stands first
  // in the page, ahead of anything the agent wrote, so the page loads nothing
  // from anywhere and sends nothing anywhere. A second policy the agent adds
  // can only narrow it further
  const PAGE_SANDBOX = "allow-scripts";
  const PAGE_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; " +
    "form-action 'none'; base-uri 'none'";
  // word: when given, the page tells the board it is still itself each time it
  // finishes loading, by posting the word to it. A page that has sent its frame
  // elsewhere loads without saying it, and the board puts the page back
  function pageDoc(html, word) {
    const hello = word ? '<script>addEventListener("load", () => parent.postMessage(' +
      JSON.stringify(String(word)).replace(/</g, "\\u003c") + ', "*"))</script>' : "";
    return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + PAGE_POLICY + '">' +
      '<meta name="referrer" content="no-referrer">' + hello + String(html == null ? "" : html);
  }
  // a website runs as itself, on its own origin, which is never the board's;
  // its frame is credentialless, so the owner's cookies, storage and saved
  // passwords stay out of it, and it may not open windows or move the board
  const SITE_SANDBOX = "allow-scripts allow-same-origin allow-forms";
  root.MagicBox = { CELL, onStar, SHAPE, place, PAGE_SANDBOX, PAGE_POLICY, pageDoc, SITE_SANDBOX };
})(globalThis);
