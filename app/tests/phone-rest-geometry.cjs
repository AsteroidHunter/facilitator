// Where the phone page stands at rest, from the one number m.html keeps for it:
// each screen edge steps in by half of --sink of that side, and the page is
// laid out at 1 - sink of its full size, its type included. A length the page
// states in page pixels is therefore that many times REST of a real pixel.
const { readFileSync } = require("node:fs");
const path = require("node:path");

const SINK = parseFloat(/--sink:([\d.]+);/.exec(readFileSync(path.join(__dirname, "..", "m.html"), "utf8"))[1]);
const REST = 1 - SINK;

// the figures a test needs for a screen of this size
function restAt(width, height) {
  const stepX = width * SINK / 2, stepY = height * SINK / 2;
  return {
    stepX, stepY,
    inset: 6 * REST,              // the card's thin margin from an edge
    dockFoot: stepY + 10 * REST,  // the row of buttons' foot off the screen's bottom
    dockSide: stepX + 16 * REST,  // the row's side off the screen's edge
    band: stepY + 68 * REST,      // the card's foot off the screen's bottom: the row's 10 + 48 + 10
  };
}

module.exports = { SINK, REST, restAt };
