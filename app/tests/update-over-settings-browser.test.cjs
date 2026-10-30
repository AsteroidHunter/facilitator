// The update's pop-up put up over an open Settings on the Mac board, in
// Chrome. With Settings open, a reading that offers a newer version puts the
// "Update Facilitator?" pop-up over it: the keyboard focus goes to the pop-up
// and stays there, so Tab walks its buttons and Escape is its Remind me later,
// which leaves Settings open with the focus back where it was.
//
// Nothing here launches a browser: it connects to the test Chrome already
// running with a remote debugging port (CHROME_CDP_URL, http://127.0.0.1:9222
// unless set), opens one background window of its own with
// Target.createTarget, never brings it forward, closes only that window,
// clears what the board copy's page kept for its own origin and leaves the
// browser running. Port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const EXTRA = ["board-settings.js", "mac-phone-view.js", "board-line.js", "board-line-worker.js", "magic-box.js",
  "hover-labels.js", "home-widgets.js"];
let browser, session, board, targetId, page;
const errors = [];

before(async () => {
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  } catch (error) {
    throw new Error(`could not connect to the test Chrome at ${CDP_URL}; nothing here starts one. ${error.message}`);
  }
  session = await browser.target().createCDPSession();
  board = await startBoard({ extra: EXTRA });
  ({ targetId } = await session.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true }));
  const target = await browser.waitForTarget(t => t._targetId === targetId);
  page = await target.page();
  const cdp = await page.createCDPSession();
  // drawn as the window in front, without being brought forward
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.setViewport({ width: 1512, height: 949 });
  page.on("pageerror", e => errors.push(String(e && e.message || e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
});
after(async () => {
  if (session && targetId) await session.send("Target.closeTarget", { targetId }).catch(() => {});
  if (session && board) await session.send("Storage.clearDataForOrigin", { origin: board.origin, storageTypes: "all" }).catch(() => {});
  if (session) await session.detach().catch(() => {});
  if (browser) await browser.disconnect();
  if (board) await board.stop();
});

// where the focus is: in the update's pop-up, in Settings, or elsewhere
function focus() {
  return page.evaluate(() => {
    const a = document.activeElement;
    const where = a && a.closest && a.closest(".up-veil") ? "update" : a && a.closest && a.closest(".sp-veil") ? "settings" : "board";
    return { where, what: a ? (a.id || a.className || a.tagName) + (a.textContent && a.tagName === "BUTTON" ? " " + a.textContent.trim() : "") : null };
  });
}
const shown = () => page.evaluate(() => ({ update: !!document.querySelector(".up-veil.open"), settings: !!document.querySelector(".sp-veil.open") }));

test("with Settings open, the update's pop-up over it keeps the keyboard", async () => {
  await page.click("#setbtn");
  await page.waitForFunction(() => document.querySelector(".sp-veil.open"));
  // the reader switches Check for updates back on, in Improvements
  await page.evaluate(() => [...document.querySelectorAll(".sp-veil.open button")]
    .find(b => b.textContent.trim() === "Improvements").click());
  await page.waitForFunction(() => document.getElementById("setupdates").offsetParent);
  await page.click("#setupdates");
  await page.click("#setupdates");
  const before = await focus();
  assert.equal(before.where, "settings");
  // the next reading offers a newer version: the call every reading makes
  errors.length = 0;
  await page.evaluate(() => {
    globalThis.__focusins = 0;
    document.addEventListener("focusin", () => { globalThis.__focusins++; }, true);
    updateWatch({ update: { offer: "9.9.9", version: "0.3.62" } });
  });
  const up = await focus();
  const focusins = await page.evaluate(() => globalThis.__focusins);
  console.log("after the pop-up came up:", JSON.stringify({ up, focusins, errors: errors.slice(0, 3) }));
  assert.deepEqual(await shown(), { update: true, settings: true });
  assert.equal(up.where, "update", "the focus went behind the pop-up: " + JSON.stringify(up));
  assert.deepEqual(errors, [], "the page threw while the pop-up came up");

  // Tab walks the pop-up's buttons, not Settings behind it
  await page.keyboard.press("Tab");
  const tabbed = await focus();
  console.log("after Tab:", JSON.stringify(tabbed));
  assert.equal(tabbed.where, "update", "Tab landed behind the pop-up: " + JSON.stringify(tabbed));
  // Escape is the pop-up's Remind me later: it goes, Settings stays open
  await page.keyboard.press("Escape");
  const after = await shown();
  console.log("after Escape:", JSON.stringify({ after, focus: await focus() }));
  assert.deepEqual(after, { update: false, settings: true }, "Escape went to Settings behind the pop-up");
  assert.equal((await focus()).where, "settings");
});
