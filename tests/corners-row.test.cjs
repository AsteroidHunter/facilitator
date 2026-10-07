// The Mac board's corners and top row. The workspace and the open project's lens
// turn 7px at every corner (a box with slightly rounded corners, not the 12px
// workspace and the capsule lens the glass port made), and the bar's row stands
// 1px lower so the paper above the lens and the paper below it, down to the
// workspace's top line, are as even as the screen can draw them. Source and
// synthetic-geometry checks, like project-lens.test.cjs: nothing starts a browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { fixture, html, PANE, ROW_TOP } = require("./project-lens-fixture.cjs");

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

test("the workspace turns 7px, and the lens on a project's name and its tab turn the same 7px at all four corners", () => {
  assert.equal(decl(rules("body.focus #appframe"), "border-radius"), "7px", "the workspace");
  assert.equal(decl(rules("body.focus #tabrow .projectlens"), "border-radius"), "7px", "the lens");
  assert.equal(decl(rules("body.focus #tabbar .ptab"), "border-radius"), "7px", "the tab under it");
  // the clear face, the rim's glass and the dragged copies are one rule: the copy takes the lens's own corner
  assert.equal(decl(rules("body.focus #tabrow .lensclear"), "border-radius"), "inherit");
  // one corner is written in the script and in the sheet, and they agree
  const f = fixture();
  assert.equal(f.get("LENS_CORNER"), 7);
  assert.equal(parseFloat(decl(rules("body.focus #tabrow .projectlens"), "border-radius")), f.get("LENS_CORNER"));
  // no rule of the bar's is left at the glass port's 12px or 16px
  for (const selector of ["body.focus #appframe", "body.focus #tabrow .projectlens", "body.focus #tabbar .ptab"])
    assert.doesNotMatch(rules(selector), /border-radius:\s*(12|16)px/, selector);
});

test("the house, speaker, squid and plus stay circles, and so does the lens over the house", () => {
  const circles = rules("body.focus :is(#homeico, #chimebtn, #setbtn, #tabbar .ptabplus)");
  assert.equal(decl(circles, "border-radius"), "50%");
  assert.equal(decl(circles, "width"), "32px"); assert.equal(decl(circles, "height"), "32px");
  // the lens on the house: half the lens's 32px, the circle it was before the 7px corners, and only
  // while its seat is .round (set down on Home, or carried over the house)
  assert.equal(decl(rules("body.focus #tabrow .tabseat.round .projectlens"), "border-radius"), "16px");
  assert.equal(decl(rules("body.focus #tabrow .projectlens"), "height"), "32px");
  assert.equal(decl(rules("body.focus #tabrow .projectlens"), "border-radius"), "7px", "a name's lens is not 7px by default");
  assert.equal(decl(rules("body.focus #tabrow .lensclear"), "border-radius"), "inherit", "the clear face takes the lens's circle too");
});

test("the lens turns between a name's corner and the circle over the width's own .28s, but only when it slides", () => {
  // a drag's release slides the seat (it is not .still) and its lens turns as it resizes
  const sliding = rules("body.focus #tabrow .tabseat:not(.still) .seatlens");
  assert.match(decl(sliding, "transition"), /border-radius \.28s var\(--gentle\)/);
  assert.match(rules("body.focus #tabrow .tabseat"), /width \.28s var\(--gentle\)/, "the seat's width runs on the same .28s");
  // a click or key sets it down at once: no transition of the corner at rest, nor when pressed
  assert.doesNotMatch(decl(rules("body.focus #tabrow .seatlens"), "transition"), /border-radius/);
  assert.doesNotMatch(decl(rules("body.focus #tabrow .tabseat.pressed .seatlens"), "transition"), /border-radius/);
  // and the seat is only ever .round where the script says: set down on Home, carried over the house
  const script = sheet.slice(sheet.indexOf("function placeSeat("));
  assert.match(script, /el\.classList\.toggle\("round", owner === HOME_SEAT\)/);
  assert.match(script, /el\.classList\.toggle\("round", onHouse\)/);
  assert.match(script, /el\.classList\.remove\("round"\)/);
});

test("a lens of any width is a box with 7px corners to the rim's map and the clean middle", () => {
  const f = fixture();
  assert.equal(f.context.lensRadius(100), 7);
  assert.equal(f.context.lensRadius(28), 7);
  assert.equal(f.context.lensRadius(10), 5, "never more than half a side");
  assert.equal(f.context.lensRadius(100, 8), 4);
  // depth in from the edge: straight along a side, and round a corner at 7px
  assert.equal(f.context.lensDepth(50, 2, 100), 2);
  assert.equal(f.context.lensDepth(2, 16, 100), 2);
  assert.ok(Math.abs(f.context.lensDepth(5, 5, 100) - (7 - Math.hypot(2, 2))) < 1e-9, "a point 5px in from both sides of a corner");
  assert.ok(f.context.lensDepth(1, 1, 100) < 0, "the corner's own point is outside the rounded box");
  assert.equal(f.context.lensDepth(50, 16, 100), 7, "inside, past the corner's reach");
  // the rim's map bends light only where the box's edge is: not at (5,5), which a
  // capsule's curve would have passed through, and so it does at (1,16) on the straight side
  f.context.lensMap(100);
  const rim = f.images[1], at = (x, y) => (y * 100 + x) * 4;
  assert.equal(rim.data[at(5, 5)], 128); assert.equal(rim.data[at(5, 5) + 1], 128);
  assert.notEqual(rim.data[at(1, 16)], 128);
  assert.notEqual(rim.data[at(16, 1) + 1], 128);
  // the bend near a corner pulls inward, toward that corner's centre
  assert.ok(rim.data[at(3, 2)] > 128 && rim.data[at(3, 2) + 1] > 128, "pulled right and down at the top left");
});

test("the lens over the house is the circle premain drew: its depth, rim map and radius are the pill's, to the pixel", () => {
  const f = fixture();
  // premain's own depth and rim map for a lens, written out here from its page
  const pillDepth = (x, y, width, height = 32) => {
    const radius = Math.min(width, height) / 2, axis = Math.max(radius, Math.min(width - radius, x)), axisY = Math.max(radius, Math.min(height - radius, y));
    return radius - Math.hypot(x - axis, y - axisY);
  };
  const pillRim = (width, density) => {
    const height = 32, pw = Math.ceil(width * density), ph = Math.ceil(height * density), radius = Math.min(width, height) / 2, out = new Uint8ClampedArray(pw * ph * 4);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const px = (x + .5) * width / pw, py = (y + .5) * height / ph, i = (y * pw + x) * 4;
      const nx = px - Math.max(radius, Math.min(width - radius, px)), ny = py - Math.max(radius, Math.min(height - radius, py));
      const length = nx ? Math.hypot(nx, ny) : Math.abs(ny), depth = radius - length, t = Math.max(0, Math.min(1, depth / 2.5));
      const bend = length ? .7 * 16 * t * t * (1 - t) * (1 - t) / length : 0;
      out[i] = Math.round(128 - 254 * nx * bend / 2); out[i + 1] = Math.round(128 - 254 * ny * bend / 2); out[i + 2] = 128; out[i + 3] = 255;
    }
    return out;
  };
  for (const width of [32, 32.5, 60, 143]) {
    for (let y = .5; y < 32; y += 1.5) for (let x = .5; x < width; x += 1.5)
      assert.equal(f.context.lensDepth(x, y, width, 32, 16), pillDepth(x, y, width), `depth at ${x},${y} of ${width}`);
    f.context.devicePixelRatio = 2; f.images.length = 0;
    f.context.lensMap(width, 16);
    const rim = f.images.at(-1).data, expected = pillRim(width, 2);
    assert.equal(rim.length, expected.length);
    for (let i = 0; i < rim.length; i++) if (rim[i] !== expected[i]) assert.fail(`the circle's rim map differs from premain's pill at byte ${i} of width ${width}`);
  }
  assert.equal(f.context.lensRadius(32, 32, 16), 16, "half the house's 32px: a circle");
  assert.equal(f.context.lensRadius(32, 32, 7), 7);
  assert.equal(f.context.lensRadius(32, 32, NaN), 7, "a corner that cannot be read is a name's");
  assert.equal(f.context.lensRadius(20, 32, 16), 10, "never more than half a side");
  // the joint of a lens that wears the circle (a split still running as it is carried over the house)
  const radius = box => f.get("jointRadius(" + JSON.stringify(box) + ")");
  assert.equal(radius({ left: 0, top: 0, right: 32, bottom: 32, corner: 16 }), 16);
  assert.equal(radius({ left: 0, top: 0, right: 32, bottom: 32 }), 7);
  assert.equal(radius({ left: 0, top: 0, right: 100, bottom: 32, corner: NaN }), 7);
});

test("the joint takes the lens's 7px corner, grown with the press and never past half a side", () => {
  const f = fixture();
  const radius = box => f.get("jointRadius(" + JSON.stringify(box) + ")");
  assert.equal(radius({ left: 0, top: 0, right: 100, bottom: 32 }), 7);
  assert.ok(Math.abs(radius({ left: 0, top: 0, right: 110, bottom: 35.2 }) - 7.7) < 1e-9, "pressed 10% larger");
  assert.equal(radius({ left: 0, top: 0, right: 10, bottom: 32 }), 5);
  // the joint's own self-calibration stands on the page's gap and corner
  assert.match(html, /pane = \{ left: -200, top: 39, right: 320, bottom: 400, corner: 7 \}/);
  assert.match(html, /jointField\(60, 35\.5, jointMoment/);
});

test("the row stands 1px lower under the same 40px bar, so the lens has even paper above and below", () => {
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
  // the paper above the lens (window top to lens top) and below it (lens foot to
  // the pane's top edge) on the Mac's 1x and 2x screens: one device pixel apart
  // at most, the two adding to an odd number of device pixels on both
  const edgeDrawn = { 1: 1, 2: .5 };
  for (const dpr of [1, 2]) {
    assert.equal(((inset + barH - 1 - edgeDrawn[dpr]) - 32) * dpr % 2, 1, `${dpr}x: the two gaps add to an odd number of device pixels`);
    const lensTop = inset + top, lensFoot = lensTop + 32, paneTop = inset + barH - 1 - edgeDrawn[dpr];
    const above = lensTop, below = paneTop - lensFoot;
    assert.ok(Math.abs(above - below) <= 1 / dpr + 1e-9, `${dpr}x: ${above} above, ${below} below`);
    if (dpr > 1) {
      // and nearer than the row's old place, with no paper above it but the inset
      const old = Math.abs(inset - (paneTop - (inset + 32)));
      assert.ok(Math.abs(above - below) < old, `${dpr}x: ${Math.abs(above - below)} is not nearer than ${old}`);
    }
  }
  // the synthetic bar the node tests run on stands where the sheet puts it
  assert.equal(ROW_TOP, inset + top);
  assert.equal(PANE.top, inset + barH - 1 - edgeDrawn[1]);
});
