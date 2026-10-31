// A setting turned in one Mac board window is drawn in another open window as
// soon as that window has read it from the board, with nothing else on the
// board changing: the New layout (developer mode's switch) and the order of
// the Cards waiting on you. The other window hears that the settings moved on
// the live line and fetches them; the fetched value is what it draws with.
//
// Nothing here launches a browser: it connects to the test Chrome already
// running with a remote debugging port (CHROME_CDP_URL, http://127.0.0.1:9222
// unless set), opens two background windows of its own with
// Target.createTarget, never brings one forward, closes only those, clears
// what the board copy's pages kept for its own origin and leaves the browser
// running. Port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const EXTRA = ["board-settings.js", "mac-phone-view.js", "board-line.js", "board-line-worker.js", "magic-box.js",
  "hover-labels.js", "home-widgets.js"];
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, session, board;
const made = [], cards = [];

before(async () => {
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  } catch (error) {
    throw new Error(`could not connect to the test Chrome at ${CDP_URL}; nothing here starts one. ${error.message}`);
  }
  session = await browser.target().createCDPSession();
  board = await startBoard({ extra: EXTRA, config: { compose_format_default: false } });
  // two cards waiting on the reader, the first one's turn the older
  for (const title of ["Older turn", "Newer turn"]) {
    const madeCard = await board.call("POST", "/create?owner=facilitator", title);
    assert.equal(madeCard.status, 200);
    const id = JSON.parse(madeCard.text).id;
    cards.push(id);
    await board.call("POST", "/reply?box=" + id, "A reply to " + title + ".");
    await settle(1100);
  }
});
after(async () => {
  for (const targetId of made) await session.send("Target.closeTarget", { targetId }).catch(() => {});
  if (session && board) await session.send("Storage.clearDataForOrigin", { origin: board.origin, storageTypes: "all" }).catch(() => {});
  if (session) await session.detach().catch(() => {});
  if (browser) await browser.disconnect();
  if (board) await board.stop();
});

// one board window of its own, in developer mode, on the facilitator lane
async function open() {
  const { targetId } = await session.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
  made.push(targetId);
  const target = await browser.waitForTarget(t => t._targetId === targetId);
  const page = await target.page();
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.setViewport({ width: 1512, height: 949 });
  await page.evaluateOnNewDocument(() => localStorage.setItem("macDeveloperMode", "on"));
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" &&
    lastState && deskLine && deskLine.up);
  await page.evaluate(id => { setHome(false); select(id); }, cards[0]);
  return page;
}
// a switch in Settings, pressed as a reader presses it, in its own section
async function flip(page, id) {
  await page.click("#setbtn");
  await page.waitForFunction(() => document.querySelector(".sp-veil.open"));
  await page.evaluate(id => {
    const section = document.getElementById(id).closest(".sp-pane").id.slice("settings-".length);
    document.querySelector('.sp-item[data-section="' + section + '"]').click();
  }, id);
  await page.waitForFunction(id => document.getElementById(id).offsetParent, {}, id);
  await page.click("#" + id);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".sp-veil.open") && !boardSettings.busy);
}
// the other window has fetched the board's settings as they now stand
async function caughtUp(page) {
  const rev = (await (await fetch(board.origin + "/settings")).json()).rev;
  await page.waitForFunction(rev => boardSettings.rev >= rev, { timeout: 10000 }, rev);
}
const order = page => page.evaluate(ids => [...document.querySelectorAll('.tikpane[data-view="todo"] .trow.yours')]
  .map(r => r.dataset.id).filter(id => ids.includes(id)), cards);

test("another window takes the New layout and the waiting order once it has read them", async () => {
  const one = await open(), two = await open();
  assert.equal(await two.evaluate(() => document.body.classList.contains("newlayout")), false);
  assert.deepEqual(await order(two), cards, "the waiting cards are not oldest first to begin with");

  await flip(one, "setlayout");
  assert.equal(await one.evaluate(() => document.body.classList.contains("newlayout")), true);
  await caughtUp(two);
  await settle(300);
  assert.equal(await two.evaluate(() => settingsStore.getItem("newlayout")), "1");
  assert.equal(await two.evaluate(() => document.body.classList.contains("newlayout")), true,
    "the other window read the New layout but kept the old one");

  await flip(one, "setwait");
  assert.deepEqual(await order(one), [...cards].reverse());
  await caughtUp(two);
  await settle(300);
  assert.equal(await two.evaluate(() => settingsStore.getItem("waitnewest")), "1");
  assert.deepEqual(await order(two), [...cards].reverse(), "the other window read newest first but kept the old order");

  // and back off, both
  await flip(one, "setlayout");
  await flip(one, "setwait");
  await caughtUp(two);
  await settle(300);
  assert.equal(await two.evaluate(() => document.body.classList.contains("newlayout")), false);
  assert.deepEqual(await order(two), cards);
});
