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
  // card: the card's rectangle, {left, top, width, height}. fit: the stage's
  // transform and the room the window gives it, {scale, tx, left, right}, the
  // last two the screen x of the frame's inner edges (frameLimits). bar: the
  // height of the card's top bar. The box is as tall as the card, two thirds as
  // wide in whole cells, and one cell to its right. When that runs past the
  // frame it slides left, onto a star line, and floats over the card's right
  // edge instead; the board never shrinks for it. Over the card it starts on the
  // first star row under the card's top bar, so the card's own chips stay in
  // reach
  function place(card, fit, bar = 0) {
    const width = Math.max(1, Math.round(card.width * 2 / 3 / CELL)) * CELL;
    const scale = fit.scale || 1;
    const room = (fit.right - fit.tx) / scale;   // the frame's inner right edge, on the stage
    const seen = (fit.left - fit.tx) / scale;    // and its left one
    let left = card.left + card.width + CELL;
    let top = card.top;
    let floating = false;
    if (left + width > room) {
      left = Math.max(onStar(room - width), onStar(seen) + CELL);
      top = onStar(card.top + bar) + CELL;
      floating = true;
    }
    return { left, top, width, height: card.top + card.height - top, floating };
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
  root.MagicBox = { CELL, onStar, place, PAGE_SANDBOX, PAGE_POLICY, pageDoc, SITE_SANDBOX };
})(globalThis);
