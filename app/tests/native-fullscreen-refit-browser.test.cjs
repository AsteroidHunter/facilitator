// Regression for the native macOS fullscreen refit. Entering fullscreen from a
// maximized window, or leaving back to one, keeps the SAME width and changes only
// the height, and the window reaches its final height a few frames AFTER the
// (display-mode: fullscreen) flip. A single fit on that flip lands on an
// intermediate height and the later final-height resize is dropped by the
// width-only freeze, so the board stays at the wrong size until a reload.
//
// This reproduces that exact captured event ordering deterministically: a
// same-width resize to an intermediate height, the display-mode change firing
// mid-animation, then a same-width resize to the final height. It does NOT drive
// real OS fullscreen (no Spaces switch, no focus). The display-mode change is
// delivered through a controllable matchMedia the app subscribes to; the height
// changes come from setViewport. The fix must settle to the final size in both
// directions while a plain vertical resize (no display-mode change) stays frozen.
//
// Runs against the shared background Chrome when FACILITATOR_CDP_ENDPOINT is set
// (background target, no activation); otherwise the harness launches a private
// headless Chrome. Both avoid taking focus.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

const W = 1512, H_WIN = 744, H_MID = 820, H_FULL = 949;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Installed before the app loads: the app subscribes to this controllable
// (display-mode: fullscreen) MediaQueryList, so window.__fireFs(matches) delivers
// the same change event a real native fullscreen flip would, with no OS state
// change. All other media queries pass through to the real matchMedia.
function fsMatchMediaShim() {
  const realMM = window.matchMedia.bind(window);
  const listeners = new Set();
  let matches = false;
  const mql = {
    media: "(display-mode: fullscreen)",
    get matches() { return matches; },
    onchange: null,
    addEventListener: (t, cb) => { if (t === "change") listeners.add(cb); },
    removeEventListener: (t, cb) => { if (t === "change") listeners.delete(cb); },
    addListener: cb => listeners.add(cb),
    removeListener: cb => listeners.delete(cb),
    dispatchEvent: () => true,
  };
  window.__fireFs = m => {
    matches = m;
    const ev = { matches, media: mql.media };
    if (typeof mql.onchange === "function") mql.onchange(ev);
    listeners.forEach(cb => { try { cb(ev); } catch (e) {} });
  };
  window.matchMedia = q => (q === "(display-mode: fullscreen)" ? mql : realMM(q));
}

const scale = page => page.evaluate(() => {
  const n = getComputedStyle(document.getElementById("stage")).transform
    .replace(/^matrix\(/, "").split(",").map(parseFloat);
  return +n[0].toFixed(5);
});
const transform = page => page.evaluate(() =>
  getComputedStyle(document.getElementById("stage")).transform);
const fireFs = (page, m) => page.evaluate(v => window.__fireFs(v), m);

// Whether the settled fit already matches a fresh fit at the current size. A real
// mis-fit (stuck at an intermediate height) differs by a lot; a ~1e-6 rounding
// difference does not, so compare scale and translation with a small tolerance.
const fitsCurrentSize = page => page.evaluate(() => {
  const parse = t => { const n = t.replace(/^matrix\(/, "").split(",").map(parseFloat); return { s: n[0], tx: n[4], ty: n[5] }; };
  const before = getComputedStyle(document.getElementById("stage")).transform;
  fitStage();
  const after = getComputedStyle(document.getElementById("stage")).transform;
  const a = parse(before), b = parse(after);
  return Math.abs(a.s - b.s) <= 0.005 && Math.abs(a.tx - b.tx) <= 1 && Math.abs(a.ty - b.ty) <= 1;
});

async function enterOrdering(page) {
  await page.setViewport({ width: W, height: H_MID }); await sleep(30);   // intermediate, same width
  await fireFs(page, true); await sleep(30);                              // display-mode flip mid-animation
  await page.setViewport({ width: W, height: H_FULL }); await sleep(30);  // final size, same width
  await sleep(450);                                                       // past the quiet window
}
async function exitOrdering(page) {
  await page.setViewport({ width: W, height: H_MID }); await sleep(30);
  await fireFs(page, false); await sleep(30);
  await page.setViewport({ width: W, height: H_WIN }); await sleep(30);
  await sleep(450);
}

let fx;
before(async () => { fx = await launch(); });
after(async () => { if (fx) await fx.stop(); });

test("same-width fullscreen ENTER settles to the final larger size", async () => {
  const { context, page } = await fx.openBoard(null, { width: W, height: H_WIN }, fsMatchMediaShim);
  try {
    await page.setViewport({ width: W, height: H_WIN }); await sleep(120);
    const windowed = await scale(page);
    await enterOrdering(page);
    assert.equal(await fitsCurrentSize(page), true,
      "after entering fullscreen the board must be fitted to the final height, not an intermediate one");
    const full = await scale(page);
    assert.ok(full - windowed > 0.02,
      `entering fullscreen must enlarge the board (windowed ${windowed} -> fullscreen ${full})`);
  } finally { await context.close(); }
});

test("same-width fullscreen EXIT settles to the final smaller size", async () => {
  const { context, page } = await fx.openBoard(null, { width: W, height: H_WIN }, fsMatchMediaShim);
  try {
    // begin in fullscreen, correctly fitted
    await enterOrdering(page);
    const full = await scale(page);
    await exitOrdering(page);
    assert.equal(await fitsCurrentSize(page), true,
      "after leaving fullscreen the board must be fitted to the shorter window, not left at the fullscreen size");
    const windowed = await scale(page);
    assert.ok(full - windowed > 0.02,
      `leaving fullscreen must shrink the board back (fullscreen ${full} -> windowed ${windowed})`);
  } finally { await context.close(); }
});

test("a quick reversal inside the settle lands on the final size", async () => {
  const { context, page } = await fx.openBoard(null, { width: W, height: H_WIN }, fsMatchMediaShim);
  try {
    // enter then immediately reverse to exit, all inside one settle window
    await page.setViewport({ width: W, height: H_MID }); await sleep(20);
    await fireFs(page, true); await sleep(20);
    await page.setViewport({ width: W, height: H_FULL }); await sleep(40);
    await fireFs(page, false); await sleep(20);
    await page.setViewport({ width: W, height: H_WIN }); await sleep(30);
    await sleep(450);
    assert.equal(await fitsCurrentSize(page), true,
      "after a quick enter/exit the board must be fitted to the final windowed size");
  } finally { await context.close(); }
});

test("an ordinary vertical resize stays frozen, before and after a transition", async () => {
  const { context, page } = await fx.openBoard(null, { width: 1400, height: H_WIN }, fsMatchMediaShim);
  try {
    await page.setViewport({ width: 1400, height: H_WIN }); await sleep(120);
    // height-only drag with NO display-mode change: must not refit
    const before = await transform(page);
    await page.setViewport({ width: 1400, height: 560 }); await sleep(300);
    assert.equal(await transform(page), before, "a height-only resize must not rescale the board");
    assert.equal(await fitsCurrentSize(page), false,
      "the freeze must actually hold a non-fitting scale, not coincidentally match a fresh fit");

    // run a full fullscreen transition, then confirm the freeze is restored
    // (the settle disarmed) so a later height-only drag is frozen again
    await enterOrdering(page);
    assert.equal(await fitsCurrentSize(page), true, "the transition settled correctly");
    const afterSettle = await transform(page);
    await page.setViewport({ width: W, height: H_FULL - 120 }); await sleep(300);
    assert.equal(await transform(page), afterSettle,
      "once the settle has ended a height-only resize must be frozen again");
  } finally { await context.close(); }
});
