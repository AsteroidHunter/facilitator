// The Mac board's corners and top row. The workspace pane is no longer drawn,
// but its box still turns 7px and keeps the rectangle the stage is fitted to;
// the bar's glass pieces are 32px circles and a 32px capsule on one centre
// line, and the row stands 1px lower so the paper above it and below it are
// as even as the screen can draw them. Source checks only: nothing starts a
// browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const html = readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const tokens = readFileSync(path.join(__dirname, "..", "card-tokens.css"), "utf8");
const sheet = html.replace(/\/\*[^]*?\*\//g, "");
// every declaration block written for exactly this selector, joined
const rules = selector => {
  const found = []; let at = -1;
  while ((at = sheet.indexOf(selector + "{", at + 1)) >= 0) {
    if (at > 0 && !/[\s}]/.test(sheet[at - 1])) continue;   // a longer selector that ends the same way
    found.push(sheet.slice(at + selector.length + 1, sheet.indexOf("}", at)));
  }
  assert.ok(found.length, selector + " has no rule");
  return found.join(";");
};
const decl = (block, property) => {
  const m = block.match(new RegExp("(?:^|[;\\s])" + property + ":([^;]+)"));
  return m && m[1].trim().replace(/\s+/g, " ");
};

test("the workspace pane paints nothing but keeps its 7px box, so the stage is fitted where it was", () => {
  const pane = rules("body.focus #appframe");
  assert.equal(decl(pane, "border-radius"), "7px");
  assert.equal(decl(pane, "visibility"), "hidden", "the pane is still drawn");
  assert.equal(decl(pane, "border"), "var(--edge) solid transparent", "the border the stage's inner box is measured inside");
  assert.match(html, /<div id="appframe" aria-hidden="true"><\/div>/, "the pane still wears the glass");
  assert.doesNotMatch(sheet, /#appframe\)\{\s*box-shadow/, "the pane's glass edge is still drawn");
  // frameLimits still measures the pane's box
  assert.match(html, /function frameLimits\(\)\{\s*const frame = document\.getElementById\("appframe"\)/);
});

test("the house, magnifier, speaker and squid are glass circles, and the pill a glass capsule at their height", () => {
  const circles = rules("body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn)");
  assert.equal(decl(circles, "border-radius"), "50%");
  assert.equal(decl(circles, "width"), "32px"); assert.equal(decl(circles, "height"), "32px");
  for (const id of ["homeico", "projpill", "searchbtn", "chimebtn", "feedbackbtn", "setbtn"])
    assert.match(html, new RegExp(`<button id="${id}" class="qn-glass"`), id + " is not glass");
  const pill = rules("body.focus #projpill");
  assert.equal(decl(pill, "height"), "32px");
  assert.equal(decl(pill, "border-radius"), "16px", "half its height: a capsule");
  // the lens and its joint are gone with the row of names
  assert.doesNotMatch(html, /projectlens|tabseat|seatjoin|LENS_CORNER/);
});

test("the row stands 1px lower under the same 40px bar, so the paper above and below it is even", () => {
  const inset = parseFloat(tokens.match(/--app-inset:\s*([\d.]+)px/)[1]);
  const barH = parseFloat(sheet.match(/--bar-h:\s*([\d.]+)px/)[1]);
  const bar = rules("body.focus .bar");
  const [top, , foot] = decl(bar, "padding").split(" ").map(parseFloat);
  assert.equal(decl(bar, "padding"), "1px 0 6px");
  assert.equal(decl(bar, "height"), "40px");
  // the padding is shared out, not grown: the row's own 32px and the bar's height are what they were
  assert.equal(top + foot, 7);
  assert.equal(40 - (top + foot) - 1, 32, "the row is still 32px in a 40px bar with its 1px bottom row");
  assert.match(bar, /margin:var\(--app-inset\) var\(--app-inset\) 0/);
  assert.equal(barH, 41);
  // the pane and the stage do not move: the pane's top is still what the bar's height gives it
  assert.match(rules("body.focus #appframe"), /top:calc\(var\(--app-inset\) \+ var\(--bar-h\) - 1px - var\(--edge-drawn\)\)/);
  assert.match(rules("body.focus #appframe"), /left:var\(--app-inset\); right:var\(--app-inset\); bottom:var\(--app-inset\)/);
  // every piece of the row is 32px high on the one centre line the padding moves
  assert.match(rules(".bar"), /align-items:center/);
  assert.equal(decl(rules("body.focus #tabrow"), "height"), "32px");
  assert.equal(decl(rules("body.focus #tabbar"), "height"), "32px");
  assert.equal(decl(rules("body.focus #tabbar .psug"), "height"), "32px");
  // the paper above the row (window top to its top) and below it (its foot to
  // the pane's top line) on the Mac's 1x and 2x screens: one device pixel apart
  // at most, the two adding to an odd number of device pixels on both
  const edgeDrawn = { 1: 1, 2: .5 };
  for (const dpr of [1, 2]) {
    assert.equal(((inset + barH - 1 - edgeDrawn[dpr]) - 32) * dpr % 2, 1, `${dpr}x: the two gaps add to an odd number of device pixels`);
    const rowTop = inset + top, rowFoot = rowTop + 32, paneTop = inset + barH - 1 - edgeDrawn[dpr];
    const above = rowTop, below = paneTop - rowFoot;
    assert.ok(Math.abs(above - below) <= 1 / dpr + 1e-9, `${dpr}x: ${above} above, ${below} below`);
  }
});
