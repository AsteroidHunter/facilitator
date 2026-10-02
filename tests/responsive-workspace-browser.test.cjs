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

// ---- portrait (phone-style) ----------------------------------------------
async function portraitSnap(page) {
  return page.evaluate(() => {
    const rectOf = sel => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), disp: getComputedStyle(el).display };
    };
    return {
      mode: document.body.dataset.respMode, pathname: location.pathname,
      drawerOpen: document.body.classList.contains("resp-drawer-open"),
      drawerBtnShown: (() => { const b = document.getElementById("respdrawerbtn"); return b && getComputedStyle(b).display !== "none"; })(),
      main: rectOf("main"), frame: rectOf("#appframe"), tickets: rectOf("#tickets"), clockShown: rectOf("#clockbox").disp !== "none",
    };
  });
}

test("a portrait window becomes a phone-style column, not a tiny board, without leaving /", async () => {
  const { context, page } = await fx.openBoard(null, { width: 900, height: 1400 });
  try {
    const s = await portraitSnap(page);
    assert.equal(s.mode, "portrait");
    assert.equal(s.pathname, "/", "portrait must not navigate to /m");
    // the conversation is a contained card sitting inside the workspace frame,
    // inset from the window edge on both sides, not a full-bleed sheet
    assert.ok(s.main.x >= 7 && s.main.x <= 20,
      `the conversation should sit inside the frame, not on the window edge (x=${s.main.x})`);
    assert.equal(s.frame.x + s.frame.w - (s.main.x + s.main.w), s.main.x - s.frame.x,
      "the column fills the width between its frame insets");
    assert.equal(s.clockShown, false, "the landscape clock is not part of the phone column");
    assert.equal(s.drawerBtnShown, true, "the drawer button is offered in portrait");
    assert.ok(s.tickets.x <= -s.tickets.w + 1, "the ticket drawer starts off-canvas");
  } finally { await context.close(); }
});

test("the drawer opens and closes, and picking a ticket closes it", async () => {
  const { context, page } = await fx.openBoard(null, { width: 560, height: 1000 });
  try {
    assert.equal((await portraitSnap(page)).tickets.x <= -300, true);
    await page.click("#respdrawerbtn");
    await page.evaluate(() => new Promise(r => setTimeout(r, 320)));
    assert.equal((await portraitSnap(page)).tickets.x, 0, "the drawer slides fully in");
    // choosing a ticket closes the drawer to reveal the chosen conversation
    await page.click(".trow");
    await page.evaluate(() => new Promise(r => setTimeout(r, 340)));
    assert.equal((await portraitSnap(page)).drawerOpen, false, "picking a ticket closes the drawer");
  } finally { await context.close(); }
});

test("an unsent draft, the selected card and focus survive wide -> portrait -> wide", async () => {
  // the formatting editor is off until a browser turns it on
  const { context, page } = await fx.openBoard({ composeformat: "1" }, { width: 1440, height: 900 });
  try {
    // put a draft in the live CodeMirror composer of the selected card
    await page.waitForSelector("main .cm-content", { visible: true });
    await page.click("main .cm-content");
    await page.type("main .cm-content", "draftMarker4917");
    const wideState = await page.evaluate(() => ({
      draft: document.querySelector("main .cm-content").textContent,
      selbox: localStorage.getItem("selbox"),
      focusInComposer: !!document.activeElement.closest(".cm-editor"),
    }));
    assert.ok(wideState.draft.includes("draftMarker4917"), "the draft was entered");

    await page.setViewport({ width: 560, height: 1000 });   // to portrait
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const portraitState = await page.evaluate(() => ({
      mode: document.body.dataset.respMode,
      draft: document.querySelector("main .cm-content").textContent,
      selbox: localStorage.getItem("selbox"),
      focusInComposer: !!document.activeElement.closest(".cm-editor"),
    }));
    assert.equal(portraitState.mode, "portrait");
    assert.ok(portraitState.draft.includes("draftMarker4917"), "the draft survives into portrait");
    assert.equal(portraitState.selbox, wideState.selbox, "the same card stays selected");
    assert.equal(portraitState.focusInComposer, true, "focus stays in the composer across the mode change");

    await page.setViewport({ width: 1440, height: 900 });   // back to wide
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const backState = await page.evaluate(() => ({
      mode: document.body.dataset.respMode,
      draft: document.querySelector("main .cm-content").textContent,
      selbox: localStorage.getItem("selbox"),
    }));
    assert.equal(backState.mode, "wide");
    assert.ok(backState.draft.includes("draftMarker4917"), "the draft is still there back in wide");
    assert.equal(backState.selbox, wideState.selbox, "the same card is still selected");
  } finally { await context.close(); }
});

// What the real pointer hits at a selector's center: the element on top there,
// whether it is the scrim, and whether it belongs to the drawer. A DOM .click()
// dispatches to the element no matter what covers it, so it cannot see a scrim
// painting over the drawer; document.elementFromPoint and a real mouse click can.
async function hitInfo(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, top: top ? (top.id || top.className) : null,
      isScrim: !!(top && top.id === "respscrim"),
      inDrawer: !!(top && top.closest && top.closest("#tickets")) };
  }, selector);
}
const wait = (page, ms) => page.evaluate(t => new Promise(r => setTimeout(r, t)), ms);

test("in portrait a real pointer reaches the drawer's tabs and rows, not the scrim", async () => {
  // two extra cards so a row that is not already selected exists to click
  await fx.post("/create?owner=facilitator", "Hit-test card A");
  await fx.post("/create?owner=facilitator", "Hit-test card B");
  const { context, page } = await fx.openBoard(null, { width: 560, height: 1000 });
  try {
    await page.waitForFunction(() => document.body.dataset.respMode === "portrait");
    await page.waitForFunction(() => document.querySelectorAll("#tiklist .trow").length >= 2);

    // open the drawer with a real click on the app-bar button
    const btn = await hitInfo(page, "#respdrawerbtn");
    await page.mouse.click(btn.x, btn.y);
    await wait(page, 340);
    assert.equal((await portraitSnap(page)).tickets.x, 0, "the drawer did not open on a real click");

    // an opaque drawer surface: the conversation must not bleed through the strip
    const bg = await page.evaluate(() => getComputedStyle(document.getElementById("tickets")).backgroundColor);
    assert.notEqual(bg, "rgba(0, 0, 0, 0)", "the portrait drawer must have an opaque background");

    // the scrim must not be the pointer target over the drawer's own controls
    const tabHit = await hitInfo(page, "#tv-deferred");
    assert.ok(tabHit.inDrawer && !tabHit.isScrim, "a drawer tab is covered by the scrim: " + JSON.stringify(tabHit));
    const rowHit = await hitInfo(page, "#tiklist .trow");
    assert.ok(rowHit.inDrawer && !rowHit.isScrim, "a drawer row is covered by the scrim: " + JSON.stringify(rowHit));

    // a real click on the deferred tab switches the group (a scrim would eat it)
    await page.mouse.click(tabHit.x, tabHit.y);
    await wait(page, 320);
    assert.equal(await page.evaluate(() => curView()), "deferred", "a real tab click did not switch the group");

    // back to doing, then a real click on an unselected row selects that card and
    // closes the drawer, rather than the scrim merely dismissing it
    const todoHit = await hitInfo(page, "#tv-todo");
    await page.mouse.click(todoHit.x, todoHit.y);
    await wait(page, 320);
    const target = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#tiklist .trow")];
      const pick = rows.find(r => r.dataset.id !== selectedId) || rows[0];
      const rect = pick.getBoundingClientRect();
      return { id: pick.dataset.id, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    });
    await page.mouse.click(target.x, target.y);
    await wait(page, 340);
    const afterRow = await page.evaluate(() => ({ sel: selectedId, open: document.body.classList.contains("resp-drawer-open") }));
    assert.equal(afterRow.sel, target.id, "a real row click did not select that card");
    assert.equal(afterRow.open, false, "a real row click did not close the drawer");

    // an outside click, over the scrim, dismisses without selecting anything behind
    await page.mouse.click(btn.x, btn.y);   // reopen
    await wait(page, 340);
    const selAtOpen = await page.evaluate(() => selectedId);
    await page.mouse.click(540, 500);       // far right, over the scrim beyond the drawer
    await wait(page, 340);
    const afterOutside = await page.evaluate(() => ({ sel: selectedId, open: document.body.classList.contains("resp-drawer-open") }));
    assert.equal(afterOutside.open, false, "an outside click did not dismiss the drawer");
    assert.equal(afterOutside.sel, selAtOpen, "an outside click selected background content");
  } finally { await context.close(); }
});

test("the desktop holder stays transparent while only the portrait drawer is opaque", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 900 });
  try {
    const ticketsBg = () => page.evaluate(() => getComputedStyle(document.getElementById("tickets")).backgroundColor);
    assert.equal(await ticketsBg(), "rgba(0, 0, 0, 0)", "the desktop holder must be transparent");
    await page.setViewport({ width: 560, height: 1000 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.notEqual(await ticketsBg(), "rgba(0, 0, 0, 0)", "the portrait drawer must be opaque");
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(await ticketsBg(), "rgba(0, 0, 0, 0)", "returning to wide restores the transparent holder");
  } finally { await context.close(); }
});

// The reported portrait bug: the selected project tab visually "held" the card
// because the full-bleed card was pinned under the bar with its top border on
// the row the seated tab opens onto, hiding the workspace frame. The fix seats
// the card INSIDE the #appframe boundary with a strip of board paper on every
// side. This asserts the observable geometry, at the narrow shape from the
// screenshot, then confirms the portrait inset fully releases back to landscape.
async function portraitFrameGeom(page) {
  return page.evaluate(() => {
    const onTab = document.querySelector("#tabbar .ptab.on");
    const frame = document.getElementById("appframe");
    const main = document.querySelector("main");
    const cs = getComputedStyle(main), fcs = getComputedStyle(frame);
    const t = onTab.getBoundingClientRect(), f = frame.getBoundingClientRect(), m = main.getBoundingClientRect();
    const composer = document.querySelector("main .cm-editor") || document.querySelector("main textarea");
    return {
      frameShown: fcs.display !== "none",
      tabToCardGap: m.top - t.bottom,
      frameTopToCardGap: m.top - f.top,
      cardLeftInset: m.left - f.left,
      cardRightInset: f.right - m.right,
      cardBottomInset: f.bottom - m.bottom,
      cardBorderTop: parseFloat(cs.borderTopWidth),
      cardBorderLeft: parseFloat(cs.borderLeftWidth),
      cardBorderRight: parseFloat(cs.borderRightWidth),
      cardRadius: parseFloat(cs.borderTopLeftRadius),
      titleShown: !!document.querySelector("main .title"),
      composerBottom: composer ? composer.getBoundingClientRect().bottom : null,
      innerHeight, innerWidth,
    };
  });
}

test("in portrait the selected project tab seats on the workspace frame, not on the card", async () => {
  // the failing shape from the screenshot: a narrow portrait desktop window
  const { context, page } = await fx.openBoard(null, { width: 500, height: 900 });
  try {
    await page.waitForFunction(() => document.body.dataset.respMode === "portrait");
    await page.waitForSelector("main .cm-editor", { visible: true }).catch(() => {});
    const g = await portraitFrameGeom(page);

    assert.equal(g.frameShown, true, "the workspace frame must be drawn in portrait");
    // a real strip of board paper between the seated tab's bottom and the card:
    // the tab opens onto the workspace, not onto the card's top border
    assert.ok(g.tabToCardGap > 2,
      `the seated tab must open onto paper above the card, not the card itself (gap=${g.tabToCardGap})`);
    // the card sits inside the frame boundary on every side
    assert.ok(g.frameTopToCardGap > 2, `the card top must sit below the frame's top line (gap=${g.frameTopToCardGap})`);
    assert.ok(g.cardLeftInset > 2 && g.cardRightInset > 2,
      `the card must be inset inside the frame's side lines (l=${g.cardLeftInset}, r=${g.cardRightInset})`);
    assert.ok(g.cardBottomInset > 2, `the card must be inset above the frame's bottom line (b=${g.cardBottomInset})`);
    // it keeps its own full border and rounded corners, so it reads as a
    // contained object rather than a full-bleed sheet
    // the edge is asked for at 0.8px, and chrome may report it as written or as
    // the whole pixel it draws here, so a full border is any visible width
    assert.ok(g.cardBorderTop > 0 && g.cardBorderLeft > 0 && g.cardBorderRight > 0,
      "the card keeps its full border in portrait");
    assert.ok(g.cardRadius >= 4, "the card keeps its rounded corners in portrait");
    // content and composer stay reachable within the window
    assert.equal(g.titleShown, true, "the card title is present");
    assert.ok(g.composerBottom !== null && g.composerBottom <= g.innerHeight + 0.5,
      `the composer must stay within the window (bottom=${g.composerBottom}, h=${g.innerHeight})`);

    // returning to a wide window fully releases the portrait inset: the card is
    // back in the scaled stage at its landscape frame position, well past the
    // small portrait inset
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const back = await page.evaluate(() => ({
      mode: document.body.dataset.respMode,
      mainX: document.querySelector("main").getBoundingClientRect().x,
    }));
    assert.equal(back.mode, "wide", "a wide window returns to the landscape board");
    assert.ok(back.mainX > 100, `the card returns to its landscape frame position, not the portrait inset (x=${back.mainX})`);
  } finally { await context.close(); }
});
