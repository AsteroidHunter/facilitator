// The phone page's shell, built along a proven full-screen design: the
// standalone metas that hand the app the whole screen, the transform lift that
// carries the composer over the keyboard without resizing any box, the close
// that lands with no jump and no bare strip, the focus locks keyed to whichever
// field is actually focused, and the guard that stops a size watcher from
// chasing its own writes. Grown one unit at a time.
//
// What only an iPhone can show, the keyboard's own motion beside the card's and
// the status bar's inset on the reported height, is proven on the simulator.
// Here the source and the headless geometry are pinned.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ---- unit 1: the viewport model and the full-screen start ----------------------------

test("the installed shell asks the phone for a full-screen web view", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  // A standalone home-screen app whose status bar style is the plain default
  // starts BELOW the status bar, so it reads a viewport shorter than the screen
  // and centres its start screen in that shorter box, low on the real screen.
  // The full-screen style hands the app the whole screen top to bottom, with the
  // safe areas carried by the page's own padding, so the reported height is the
  // screen's own and the start screen is centred on it.
  assert.match(source, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/,
    "the shell does not ask for the full-screen status-bar style");
  assert.match(source, /name="apple-mobile-web-app-capable" content="yes"/,
    "the shell is not installable as a standalone app");
  assert.match(source, /viewport-fit=cover/,
    "the viewport does not cover the whole screen");
});

test("the start globe is centred on its own full-screen box", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  const curtain = source.slice(source.indexOf("#loading{"), source.indexOf("/* card prose"));
  // The curtain is pinned to all four edges and the globe is centred in it by
  // half its own size, so once the web view is the whole screen the globe sits
  // at the screen's own centre. This pins the centring mechanism; the on-device
  // shift the plain status-bar style caused is measured on the simulator.
  assert.match(curtain, /#loading\{[^}]*position:fixed; inset:0/,
    "the curtain is not pinned to all four screen edges");
  assert.match(curtain, /left:50%; top:50%/, "the globe is not centred in the curtain");
  assert.match(curtain, /margin:-7vmin 0 0 -7vmin/, "the globe is not pulled back by half its own size");
});
