// Developer mode on the Mac board, on a copy of the board in a headless Chrome
// of the test's own. Seven clicks on the home page's version, each within a
// second of the last, turn it on and seven more turn it off, the way seven taps
// do on the phone; fewer clicks, or a pause between them, change nothing. It is
// kept in this browser (macDeveloperMode in its localStorage), never in the
// board's settings, and another window of the same browser follows it. The New
// layout switch in Settings shows only while it is on, and the new layout is
// drawn only while it is on: with it off the board shows today's layout though
// the board keeps newlayout on, and the kept value stands for the next time.
// MAC_DEVELOPER_EVIDENCE names a folder for a few frames of Settings.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EVIDENCE = process.env.MAC_DEVELOPER_EVIDENCE;
let board, browser, profile, home, cardId;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "facilitator-developer-mode-home-"));
  board = await startBoard({ config: { compose_format_default: false }, env: { HOME: home }, extra: ["hover-labels.js"] });
  const made = await board.call("POST", "/create?owner=facilitator", "Issue creation task");
  assert.equal(made.status, 200);
  cardId = JSON.parse(made.text).id;
  await board.call("POST", "/reply?box=" + cardId, "A reply to the card.");
  profile = mkdtempSync(path.join(tmpdir(), "facilitator-developer-mode-chrome-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--disable-background-networking"] });
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
});
after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  for (const dir of [profile, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

// a page in a context of its own: a browser with nothing kept in it yet
async function open(context) {
  const page = await context.newPage();
  await page.setViewport({ width: 1512, height: 949 });
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await ready(page);
  return page;
}
// the first reading drawn and the startup curtain gone
async function ready(page) {
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState &&
    !document.getElementById("loading"));
}
function frames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
// the card's board, faded in
async function toBoard(page) {
  await page.evaluate(id => { if (homeOpen) setHome(false); select(id); }, cardId);
  await page.waitForFunction(() => document.querySelector(".box.sel .title") &&
    getComputedStyle(document.getElementById("stage")).visibility === "visible" &&
    getComputedStyle(document.getElementById("stage")).opacity === "1");
  await frames(page);
}
// the home page, with the version under the name standing where a click lands on it
async function toHome(page) {
  await page.evaluate(() => { if (!homeOpen) setHome(true); });
  await page.waitForFunction(() => {
    const v = document.getElementById("homeversion"), r = v.getBoundingClientRect();
    return r.width > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === v;
  });
}
// clicks on the version as a reader makes them, gap ms apart, in the tab in
// front of this headless Chrome (a tab behind draws no frames to click on)
async function clickVersion(page, times, gap = 60) {
  await page.bringToFront();
  for (let i = 0; i < times; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, gap));
    await page.click("#homeversion");
  }
}
function mode(page) {
  return page.evaluate(() => ({ on: document.body.classList.contains("mac-developer-mode"),
    kept: localStorage.getItem("macDeveloperMode"), layout: document.body.classList.contains("newlayout") }));
}
async function boardSettings() {
  return (await (await fetch(board.origin + "/settings")).json()).values;
}
// Settings at Appearance: whether the New layout switch shows, and how it stands
async function appearance(page, frame) {
  await page.click("#setbtn");
  await page.waitForFunction(() => document.querySelector(".sp-veil.open"));
  await page.evaluate(() => [...document.querySelectorAll(".sp-veil.open button")]
    .find(b => b.textContent.trim() === "Appearance").click());
  await page.waitForFunction(() => document.getElementById("setwait").offsetParent);
  await frames(page);
  const seen = await page.evaluate(() => ({ shown: !!document.getElementById("setlayout").offsetParent,
    display: getComputedStyle(document.getElementById("setlayoutrow")).display,
    checked: document.getElementById("setlayout").checked,
    rows: [...document.querySelectorAll("#settings-appearance .setrow")].filter(r => r.offsetParent)
      .map(r => r.querySelector(".setlabel span").textContent) }));
  if (EVIDENCE && frame) {
    // the page has faded all the way in
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".sp-veil.open .sp-page")).opacity === "1");
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.screenshot({ path: path.join(EVIDENCE, frame + ".png") });
  }
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".sp-veil.open"));
  return seen;
}
// today's layout: the typing row in the card, the clock up, the card where it stands
function todays(page) {
  return page.evaluate(() => ({ layout: document.body.classList.contains("newlayout"),
    display: getComputedStyle(document.querySelector(".box.sel .composebox")).display,
    clock: document.getElementById("clockbox").classList.contains("region-off"),
    card: (({ left, top, width, height }) => ({ left, top, width, height }))(document.querySelector("main").getBoundingClientRect()) }));
}

test("seven quick clicks on the version turn it on and seven more off; fewer, or a pause, change nothing", async () => {
  const context = await browser.createBrowserContext();
  try {
    const page = await open(context);
    await toHome(page);
    assert.deepEqual(await mode(page), { on: false, kept: null, layout: false }, "a fresh browser is not in developer mode");
    if (EVIDENCE) {
      await new Promise(resolve => setTimeout(resolve, 800));   // the board's crossfade to home has run
      await page.screenshot({ path: path.join(EVIDENCE, "0-home-version-label.png") });
    }

    await clickVersion(page, 6);
    assert.equal((await mode(page)).on, false, "six clicks turned it on");
    // a click more than a second after the last starts the count again
    await new Promise(resolve => setTimeout(resolve, 1100));
    await clickVersion(page, 1);
    assert.equal((await mode(page)).on, false, "a slow seventh click turned it on");
    await new Promise(resolve => setTimeout(resolve, 1100));

    await clickVersion(page, 7);
    assert.deepEqual(await mode(page), { on: true, kept: "on", layout: false });
    // the clicks select nothing, and the mode is the browser's, not the board's
    assert.equal(await page.evaluate(() => String(getSelection())), "");
    assert.equal(Object.keys(await boardSettings()).some(k => /developer/i.test(k)), false, "the board kept the mode");

    // another window of this browser follows it
    const other = await open(context);
    assert.equal((await mode(other)).on, true, "a window opened later is not in it");
    await new Promise(resolve => setTimeout(resolve, 1100));
    await clickVersion(page, 7);
    assert.deepEqual(await mode(page), { on: false, kept: "off", layout: false });
    await other.waitForFunction(() => !document.body.classList.contains("mac-developer-mode"), { polling: 50, timeout: 5000 });

    // a browser of its own has its own mode
    const elsewhere = await browser.createBrowserContext();
    try {
      await new Promise(resolve => setTimeout(resolve, 1100));
      await clickVersion(page, 7);
      assert.equal((await mode(page)).on, true);
      assert.equal((await mode(await open(elsewhere))).on, false, "another browser took the mode");
    } finally { await elsewhere.close(); }
  } finally { await context.close(); }
});

test("Settings shows the New layout switch only in developer mode", async () => {
  const context = await browser.createBrowserContext();
  try {
    const page = await open(context);
    await toBoard(page);
    const off = await appearance(page, "1-settings-developer-mode-off");
    assert.deepEqual(off, { shown: false, display: "none", checked: false, rows: ["Background colour", "Cards waiting on you"] });

    await toHome(page);
    await clickVersion(page, 7);
    await toBoard(page);
    const on = await appearance(page, "2-settings-after-seven-clicks");
    assert.deepEqual(on, { shown: true, display: "flex", checked: false,
      rows: ["Background colour", "Cards waiting on you", "New layout"] });

    await new Promise(resolve => setTimeout(resolve, 1100));
    await toHome(page);
    await clickVersion(page, 7);
    await toBoard(page);
    const again = await appearance(page, "3-settings-after-seven-more");
    assert.deepEqual(again, off);
  } finally { await context.close(); }
});

test("with developer mode off the board shows today's layout though the board keeps the new one on", async () => {
  // today's layout, with the new one off on the board, to hold the rest to
  const plain = await browser.createBrowserContext();
  let today;
  try {
    const page = await open(plain);
    await toBoard(page);
    today = await todays(page);
    assert.deepEqual([today.layout, today.display, today.clock], [false, "contents", false]);
  } finally { await plain.close(); }

  await board.call("POST", "/settings", JSON.stringify({ newlayout: "1" }));
  const context = await browser.createBrowserContext();
  try {
    const page = await open(context);
    await toBoard(page);
    assert.deepEqual(await todays(page), today, "the new layout was drawn outside developer mode");
    if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, "4-board-developer-mode-off.png") });

    // on: the kept choice is drawn at once, and the switch shows it on
    await toHome(page);
    await clickVersion(page, 7);
    await toBoard(page);
    const on = await todays(page);
    assert.deepEqual([on.layout, on.clock], [true, true], "turning developer mode on did not draw the kept layout");
    assert.equal((await appearance(page)).checked, true);
    if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, "5-board-developer-mode-on.png") });

    // a reload keeps the mode, and opens in the new layout from its first lines
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.evaluate(() => document.body.classList.contains("newlayout")), true, "a reload lost it");
    await ready(page);

    // off again: today's layout, and the board still keeps the new one on
    await new Promise(resolve => setTimeout(resolve, 1100));
    await toHome(page);
    await clickVersion(page, 7);
    await toBoard(page);
    assert.deepEqual(await todays(page), today, "turning developer mode off did not put today's layout back");
    assert.equal((await boardSettings()).newlayout, "1", "turning developer mode off lost the kept choice");
  } finally {
    await context.close();
    await board.call("POST", "/settings", JSON.stringify({ newlayout: null }));
  }
});
