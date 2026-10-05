// Responsive workspace: the wide-landscape fit shows the whole board without
// clipping the foot, a height-only window resize freezes everything (the user's
// explicit constraint), a width change re-fits, and drag stays under the pointer
// while the stage is scaled below 1:1. These drive user-visible invariants, not
// the fit's internal numbers.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;
const DESIGN_CONTENT_BOTTOM = 789;   // the default board's real foot, in design px

function scaleOf(matrix) { return Number(matrix.replace(/^matrix\(/, "").split(",")[0]); }

async function regionRects(page) {
  return page.evaluate(() => {
    const ids = ["clockbox", "tickets", "magic1", "main"];
    const out = {};
    for (const id of ids) {
      const el = id === "main" ? document.querySelector("main") : document.getElementById(id);
      const r = el.getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    }
    return out;
  });
}
async function transform(page) {
  return page.evaluate(() => getComputedStyle(document.getElementById("stage")).transform);
}
function clipped(rects, iw, ih) {
  return Object.entries(rects)
    .filter(([, r]) => r.bottom > ih + 0.5 || r.right > iw + 0.5 || r.y < -0.5 || r.x < -0.5)
    .map(([k]) => k);
}

before(async () => { fx = await launch(); });
after(async () => { if (fx) await fx.stop(); });

test("design 1440x900 stays at 1:1 and never clips (no regression)", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 900 });
  try {
    assert.equal(scaleOf(await transform(page)), 1, "1440x900 should not shrink the board");
    assert.deepEqual(clipped(await regionRects(page), 1440, 900), [], "nothing should clip at design size");
  } finally { await context.close(); }
});

test("a shorter windowed height (leaving a larger window) fits so the foot is not clipped", async () => {
  // Simulated by shrinking a large (fullscreen-sized) viewport down to a windowed
  // one: exiting native macOS fullscreen changes the window WIDTH, which is what
  // drives the re-fit. This is a synthetic viewport test and does not exercise
  // real native fullscreen; see report for that limit.
  const { context, page } = await fx.openBoard(null, { width: 2560, height: 1400 });
  try {
    assert.equal(scaleOf(await transform(page)), 1, "a large window shows the board at 1:1");
    await page.setViewport({ width: 1440, height: 820 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const s = scaleOf(await transform(page));
    assert.ok(s < 1 && s > 0.9, `expected a small shrink to fit 820px tall, got ${s}`);
    assert.deepEqual(clipped(await regionRects(page), 1440, 820), [],
      "the player and conversation foot must stay visible after leaving the larger window");
  } finally { await context.close(); }
});

test("a height-only resize freezes the board; a later width change re-fits", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 900 });
  try {
    const before = await transform(page);
    const beforeRects = await regionRects(page);
    // shrink only the height: the user asked that nothing move or rescale here,
    // even though it means the foot may clip. Heights are kept in the landscape
    // range so this stays a wide-mode freeze, not a portrait switch.
    await page.setViewport({ width: 1440, height: 760 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await transform(page), before, "height-only resize must not change the transform");
    const frozenRects = await regionRects(page);
    for (const id of Object.keys(beforeRects))
      assert.ok(Math.abs(frozenRects[id].y - beforeRects[id].y) < 0.5,
        `${id} must not move vertically on a height-only resize`);
    // now change the width: this is allowed to re-fit
    await page.setViewport({ width: 1180, height: 760 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.notEqual(await transform(page), before, "a width change should re-fit");
    assert.deepEqual(clipped(await regionRects(page), 1180, 760), [],
      "after a width-driven re-fit the board should fit the new window");
  } finally { await context.close(); }
});

test("a growing height alone does not enlarge or move the board", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 820 });
  try {
    const before = await transform(page);
    await page.setViewport({ width: 1440, height: 1300 });   // taller, same width
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await transform(page), before,
      "extra vertical space alone must not enlarge or recenter the board");
  } finally { await context.close(); }
});

test("a region a user dragged low is still fully visible after fitting", async () => {
  // main is normally the tallest region; drop the clock far down instead so the
  // saved custom layout, not the default, drives the content foot.
  const { context, page } = await fx.openBoard(
    { "pos.facilitator.clockbox": JSON.stringify({ x: 40, y: 860 }) },
    { width: 1440, height: 820 });
  try {
    const rects = await page.evaluate(() => {
      const c = document.getElementById("clockbox").getBoundingClientRect();
      return { clockBottom: c.bottom };
    });
    assert.ok(rects.clockBottom <= 820 + 0.5,
      `a low custom region must be fit into view, clock bottom was ${rects.clockBottom}`);
  } finally { await context.close(); }
});

test("leaving fullscreen refits at constant width, though a bare height shrink stays frozen", {
  // This test drives the REAL Fullscreen API. Against the shared background Chrome
  // (connect mode) the browser-testing policy forbids any real fullscreen, so skip
  // it explicitly with a reported reason rather than letting it attempt fullscreen
  // and silently pass when refused. The same-width refit is covered without any
  // real fullscreen by tests/native-fullscreen-refit-browser.test.cjs.
  skip: process.env.FACILITATOR_CDP_ENDPOINT
    ? "connect mode forbids the real Fullscreen API; covered by native-fullscreen-refit-browser"
    : false,
}, async () => {
  // The user leaves native macOS fullscreen at the same window width and only the
  // height drops. A plain same-width resize is frozen on purpose, so the refit
  // must come from the fullscreen signal. Here we drive the Fullscreen API, which
  // in Chrome fires BOTH fullscreenchange and a (display-mode: fullscreen) change;
  // native macOS fullscreen fires only the display-mode one (see report evidence),
  // and this test confirms the board refits off a fullscreen transition with the
  // width held constant the whole time.
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 1300 });
  try {
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "fsbtn"; b.style.cssText = "position:fixed;left:0;top:0;z-index:99999;width:24px;height:24px";
      b.addEventListener("click", () => document.documentElement.requestFullscreen().catch(() => {}));
      document.body.appendChild(b);
    });
    await page.click("#fsbtn");
    await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
    const reallyFs = await page.evaluate(() => !!document.fullscreenElement);
    if (!reallyFs) { console.log("      (skipped: this Chrome refused Fullscreen API)"); return; }
    // shrink the height at the SAME width; the plain resize is frozen, so the
    // board keeps its fullscreen scale and the foot clips
    await page.setViewport({ width: 1440, height: 820 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const frozenClip = clipped(await regionRects(page), 1440, 820);
    assert.ok(frozenClip.length > 0, "a bare same-width height shrink should stay frozen and clip");
    // now leave fullscreen: the fullscreen signal must refit at the same width
    await page.evaluate(() => document.exitFullscreen().catch(() => {}));
    await page.evaluate(() => new Promise(r => setTimeout(r, 250)));
    assert.deepEqual(clipped(await regionRects(page), 1440, 820), [],
      "leaving fullscreen must refit so the foot is visible, at the same width");
  } finally { await context.close(); }
});

// ---- two-pane (near 6:5) --------------------------------------------------
async function twoPaneSnap(page) {
  return page.evaluate(() => {
    const nav = document.getElementById("respnav");
    const rectOf = id => {
      const el = id === "main" ? document.querySelector("main") : document.getElementById(id);
      const r = el.getBoundingClientRect();
      const sr = document.getElementById("stage").getBoundingClientRect();
      const scale = sr.width / 1440;
      return {
        onScreen: r.right > 0.5 && r.left < innerWidth - 0.5,
        fullyOn: r.left >= -0.5 && r.right <= innerWidth + 0.5,
        designX: Math.round((r.x - sr.x) / scale),
      };
    };
    return {
      mode: document.body.dataset.respMode,
      navShown: nav && getComputedStyle(nav).display !== "none",
      navText: nav ? nav.textContent : null,
      paneStored: localStorage.getItem("pane.facilitator"),
      main: rectOf("main"), magic2: rectOf("magic2"), clock: rectOf("clockbox"),
    };
  });
}

test("two-pane shows left+middle with an arrow; the right column waits off-screen", async () => {
  const { context, page } = await fx.openBoard({ "show.facilitator.magic2": "1" }, { width: 1000, height: 900 });
  try {
    const s = await twoPaneSnap(page);
    assert.equal(s.mode, "twopane");
    assert.equal(s.navShown, true, "the pan arrow should be offered when right content exists");
    assert.ok(s.main.fullyOn && s.clock.fullyOn, "left+middle should be fully visible in the first pane");
    assert.equal(s.magic2.onScreen, false, "the right column should be off-screen in the first pane");
  } finally { await context.close(); }
});

test("the arrow pans to middle+right and keeps the conversation visible, then returns", async () => {
  const { context, page } = await fx.openBoard({ "show.facilitator.magic2": "1" }, { width: 1000, height: 900 });
  try {
    const before = await twoPaneSnap(page);
    await page.click("#respnav");
    await page.evaluate(() => new Promise(r => setTimeout(r, 380)));
    const panned = await twoPaneSnap(page);
    assert.equal(panned.paneStored, "1");
    assert.ok(panned.magic2.fullyOn, "the right column should be fully visible after panning");
    assert.ok(panned.main.onScreen, "the conversation must stay visible in the second pane");
    assert.equal(panned.navText, "‹", "the arrow should reverse to point back");
    // a view transform, not an edit: the region's stage-local position is unchanged
    assert.equal(panned.magic2.designX, before.magic2.designX,
      "panning must not move the saved region position");
    await page.click("#respnav");
    await page.evaluate(() => new Promise(r => setTimeout(r, 380)));
    const back = await twoPaneSnap(page);
    assert.ok(back.main.fullyOn && back.magic2.onScreen === false, "returning shows the first pane again");
    assert.equal(back.paneStored, null, "returning to the first pane clears the stored offset");
  } finally { await context.close(); }
});

test("a wide enough window shows the whole board with no arrow", async () => {
  const { context, page } = await fx.openBoard({ "show.facilitator.magic2": "1" }, { width: 1320, height: 900 });
  try {
    const s = await twoPaneSnap(page);
    assert.equal(s.mode, "wide");
    assert.equal(s.navShown, false, "no arrow when the whole board fits");
    assert.ok(s.main.fullyOn && s.magic2.fullyOn, "both the conversation and the right column are visible");
  } finally { await context.close(); }
});

test("no right content means no arrow, even in a narrow window", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1000, height: 900 });
  try {
    const s = await twoPaneSnap(page);
    assert.equal(s.navShown, false, "a board with no visible right column offers no arrow");
  } finally { await context.close(); }
});

test("a right region moved into the left area creates no arrow", async () => {
  const { context, page } = await fx.openBoard(
    // magicrename.1 is set so the one-time key migration does not rename this
    // injected magic2 position onto magic3
    { "magicrename.1": "1", "show.facilitator.magic2": "1",
      "pos.facilitator.magic2": JSON.stringify({ x: 360, y: 300 }) },
    { width: 1000, height: 900 });
  try {
    const s = await twoPaneSnap(page);
    assert.equal(s.navShown, false, "a right region dragged into the first pane must not create an arrow");
  } finally { await context.close(); }
});

test("hiding the right region clears the arrow and any stored pane offset", async () => {
  const { context, page } = await fx.openBoard({ "show.facilitator.magic2": "1" }, { width: 1000, height: 900 });
  try {
    await page.click("#respnav");   // go to pane 1, storing the offset
    await page.evaluate(() => new Promise(r => setTimeout(r, 380)));
    assert.equal((await twoPaneSnap(page)).paneStored, "1");
    // hide the right region through the same code path the edit-mode cross uses;
    // clicking the cross itself is awkward here because it sits just past the
    // window edge when the region is panned against it
    await page.evaluate(() => toggleRegionHidden("magic2"));
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const s = await twoPaneSnap(page);
    assert.equal(s.navShown, false, "hiding the only right region removes the arrow");
    assert.equal(s.paneStored, null, "and clears the now-unreachable pane offset");
  } finally { await context.close(); }
});

test("option-drag keeps the box under the pointer while the stage is scaled", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1280, height: 700 });
  try {
    const result = await page.evaluate(() => {
      const el = document.getElementById("magic1");
      const before = el.getBoundingClientRect();
      const stage = document.getElementById("stage").getBoundingClientRect();
      const scale = stage.width / 1440;
      const startX = before.x + 8, startY = before.y + 8;
      const dx = 140, dy = 60;   // screen-pixel drag
      const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type,
        { clientX: x, clientY: y, altKey: true, bubbles: true, button: 0 }));
      fire("pointerdown", startX, startY);
      // pointermove is bound on window; dispatch there so it is heard
      window.dispatchEvent(new PointerEvent("pointermove",
        { clientX: startX + dx, clientY: startY + dy, altKey: true, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const after = el.getBoundingClientRect();
      return { scale, movedX: after.x - before.x, movedY: after.y - before.y, dx, dy,
        gridScreen: 1440 * 0.008 * scale };
    });
    assert.ok(result.scale < 0.9, `expected a scaled stage, got ${result.scale}`);
    // the box should follow the pointer 1:1 on screen (within one snapped grid
    // cell). The pre-fix code moved it by delta/scale, which at this scale would
    // be far outside the tolerance.
    const tol = result.gridScreen + 3;
    assert.ok(Math.abs(result.movedX - result.dx) <= tol,
      `x should move ~${result.dx} screen px, moved ${result.movedX} (buggy would be ~${result.dx / result.scale})`);
    assert.ok(Math.abs(result.movedY - result.dy) <= tol,
      `y should move ~${result.dy} screen px, moved ${result.movedY} (buggy would be ~${result.dy / result.scale})`);
  } finally { await context.close(); }
});

// The former imitation portrait drawer tests were removed with that renderer.
// mac-phone-view.test.cjs exercises the real phone handoff without a browser.
