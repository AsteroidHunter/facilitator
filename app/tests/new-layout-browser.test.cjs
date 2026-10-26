// The new layout, switched on and off from Settings on a copy of the board in
// a headless Chrome of the test's own: the card on the left, the ticket list
// at the upper right and the card's typing row in a box of its own under the
// list. The three stand as one group in the middle of the window, the list and
// the box share one centre line, the list stands in front, the row still sends
// to the open card, and with the switch off the board is laid out as before.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");
const { isSetting } = require("../board-settings.js");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let board, browser, profile, home, cardId;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "facilitator-new-layout-home-"));
  board = await startBoard({ config: { compose_format_default: false }, env: { HOME: home }, extra: ["hover-labels.js"] });
  for (const title of ["Issue creation task", "New facilitator UI"]) {
    const made = await board.call("POST", "/create?owner=facilitator", title);
    assert.equal(made.status, 200);
    cardId = JSON.parse(made.text).id;
    await board.call("POST", "/reply?box=" + cardId, "A reply to " + title + ".");
  }
  profile = mkdtempSync(path.join(tmpdir(), "facilitator-new-layout-chrome-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--disable-background-networking"] });
});
after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  for (const dir of [profile, home]) if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open(width = 1512, height = 949) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
  await page.evaluate(id => { setHome(false); select(id); }, cardId);
  await shown(page);
  return { context, page };
}
// the card on screen and the stage faded in, so a press lands on what it shows
async function shown(page) {
  await page.waitForFunction(() => document.querySelector(".box.sel .title") &&
    getComputedStyle(document.getElementById("stage")).visibility === "visible" &&
    getComputedStyle(document.getElementById("stage")).opacity === "1");
  await frames(page);
}
// a resize is heard at the next frame, and the fit runs then
function frames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
// the switch in Settings, pressed as a reader presses it
async function flip(page) {
  await page.click("#setbtn");
  await page.waitForFunction(() => document.querySelector(".sp-veil.open"));
  await page.evaluate(() => [...document.querySelectorAll(".sp-veil.open button")]
    .find(b => b.textContent.trim() === "Appearance").click());
  await page.waitForFunction(() => document.getElementById("setlayout").offsetParent);
  await page.click("#setlayout");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".sp-veil.open"));
}
async function settled(page) {
  await page.waitForFunction(() => !globalThis.boardSettings || !boardSettings.busy);
}
// the three boxes as they show, in window pixels: the list across its names
// and rows, from its holder's top
function geometry(page) {
  return page.evaluate(() => {
    const r = el => { const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
      return { left, top, right, bottom, width, height }; };
    const card = r(document.querySelector("main")), holder = r(document.getElementById("tickets"));
    const head = r(document.getElementById("tikhead")), box = r(document.querySelector(".box.sel .composebox"));
    const list = { left: head.left, right: head.right, top: holder.top, bottom: holder.bottom };
    const all = [card, list, box];
    const group = { left: Math.min(...all.map(b => b.left)), right: Math.max(...all.map(b => b.right)),
                    top: Math.min(...all.map(b => b.top)), bottom: Math.max(...all.map(b => b.bottom)) };
    return { W: innerWidth, H: innerHeight, card, list, box, group,
             bar: document.querySelector(".bar").getBoundingClientRect().bottom };
  });
}
function assertLaidOut(g, label) {
  const mid = (a, b) => (a + b) / 2;
  assert.ok(Math.abs(mid(g.group.left, g.group.right) - g.W / 2) < 1, `${label}: the group is not centred across`);
  assert.ok(Math.abs(mid(g.group.top, g.group.bottom) - g.H / 2) < 1, `${label}: the group is not centred down`);
  assert.ok(Math.abs(mid(g.list.left, g.list.right) - mid(g.box.left, g.box.right)) < 1,
    `${label}: the list and the composer do not share a centre line`);
  assert.ok(g.group.top >= g.bar, `${label}: the group reaches under the bar`);
  // the shares the owner set: the card, the list's holder and the box
  assert.ok(Math.abs(g.card.width / g.W - 0.31) < 0.002 && Math.abs(g.card.height / g.H - 0.77) < 0.002, `${label}: card size`);
  assert.ok(Math.abs(g.box.width / g.W - 0.28) < 0.002 && Math.abs(g.box.height / g.H - 0.25) < 0.002, `${label}: composer size`);
  assert.ok(g.card.right < g.box.left && g.list.bottom < g.box.top, `${label}: the boxes overlap`);
}

test("the switch is one of the board's settings, in the browser's list and the server's", () => {
  assert.equal(isSetting("newlayout"), true);
  assert.equal(isSetting("newlayout.2"), false);
  const server = readFileSync(path.join(ROOT, "server.py"), "utf8");
  const keys = server.slice(server.indexOf("SETTINGS_KEY = re.compile("), server.indexOf("SPOTIFY_FIELDS"));
  assert.match(keys, /\|newlayout\|/);
});

test("Settings turns the new layout on and off at once, and the board keeps the choice", async () => {
  const { context, page } = await open();
  try {
    // off: today's board, with the typing row in the card
    const before = await page.evaluate(() => ({ on: document.body.classList.contains("newlayout"),
      display: getComputedStyle(document.querySelector(".box.sel .composebox")).display,
      rowInCard: (() => { const m = document.querySelector("main").getBoundingClientRect(),
        r = document.querySelector(".box.sel .bottombar").getBoundingClientRect();
        return r.top >= m.top && r.bottom <= m.bottom && r.left >= m.left && r.right <= m.right; })(),
      clock: document.getElementById("clockbox").classList.contains("region-off"),
      card: (({ left, top, width, height }) => ({ left, top, width, height }))(document.querySelector("main").getBoundingClientRect()) }));
    assert.deepEqual([before.on, before.display, before.rowInCard, before.clock], [false, "contents", true, false]);

    await flip(page);
    await settled(page);
    assert.equal((await (await fetch(board.origin + "/settings")).json()).values.newlayout, "1", "the board did not keep it");
    const on = await page.evaluate(() => ({ on: document.body.classList.contains("newlayout"),
      clock: document.getElementById("clockbox").classList.contains("region-off"),
      title: getComputedStyle(document.querySelector("#tickets .ttl")).fontSize,
      text: getComputedStyle(document.querySelector(".box.sel .composebox textarea")).fontSize,
      front: [getComputedStyle(document.getElementById("tickets")).zIndex, getComputedStyle(document.querySelector("main")).zIndex] }));
    assert.deepEqual(on, { on: true, clock: true, title: "19px", text: "18px", front: ["2", "auto"] });
    assertLaidOut(await geometry(page), "1512 by 949");

    // a reload keeps it
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    await page.evaluate(id => { setHome(false); select(id); }, cardId);
    await shown(page);
    assert.equal(await page.evaluate(() => document.body.classList.contains("newlayout")), true, "a reload lost it");

    // and off again puts every region back where it was
    await flip(page);
    await settled(page);
    const off = await page.evaluate(() => ({ on: document.body.classList.contains("newlayout"),
      clock: document.getElementById("clockbox").classList.contains("region-off"),
      display: getComputedStyle(document.querySelector(".box.sel .composebox")).display,
      card: (({ left, top, width, height }) => ({ left, top, width, height }))(document.querySelector("main").getBoundingClientRect()) }));
    assert.deepEqual([off.on, off.clock, off.display], [false, false, "contents"]);
    assert.deepEqual(off.card, before.card, "the card did not go back to its place");
    assert.equal((await (await fetch(board.origin + "/settings")).json()).values.newlayout, undefined);
  } finally { await context.close(); }
});

test("the group stays centred at other window sizes and follows a height-only resize", async () => {
  await board.call("POST", "/settings", JSON.stringify({ newlayout: "1" }));
  const { context, page } = await open(1440, 900);
  try {
    assertLaidOut(await geometry(page), "1440 by 900");
    await page.setViewport({ width: 1800, height: 1100 });
    await page.waitForFunction(() => innerWidth === 1800);
    await frames(page);
    assertLaidOut(await geometry(page), "1800 by 1100");
    // only the height: the other layout stands still for this, the new one
    // stays in the middle of the window
    await page.setViewport({ width: 1800, height: 820 });
    await page.waitForFunction(() => innerHeight === 820);
    await frames(page);
    assertLaidOut(await geometry(page), "1800 by 820");
  } finally {
    await context.close();
    await board.call("POST", "/settings", JSON.stringify({ newlayout: null }));
  }
});

test("the composer box types and sends to the open card, and the card keeps the sent message", async () => {
  await board.call("POST", "/settings", JSON.stringify({ newlayout: "1" }));
  const { context, page } = await open();
  try {
    const box = await page.evaluate(() => (({ x, y, width, height }) => ({ x, y, width, height }))(
      document.querySelector(".box.sel .composebox").getBoundingClientRect()));
    // a click low in the box still lands in the words
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
    const hit = await page.evaluate(() => ({ active: document.activeElement === els[shownId].ta,
      at: document.activeElement && (document.activeElement.className || document.activeElement.tagName), shown: shownId }));
    assert.equal(hit.active, true, "the click missed the field " + JSON.stringify(hit));
    await page.keyboard.type("Sent from the new composer");
    assert.equal(await page.evaluate(() => els[shownId].send.classList.contains("show")), true);
    // the send square inside the box at its bottom right, the paperclip outside it at its left
    const marks = await page.evaluate(() => {
      const b = document.querySelector(".box.sel .composebox").getBoundingClientRect();
      const s = els[shownId].send.getBoundingClientRect(), c = els[shownId].clip.getBoundingClientRect();
      return { send: s.right <= b.right && s.bottom <= b.bottom && s.left > b.left + b.width / 2 && s.top > b.top + b.height / 2,
               clip: c.right <= b.left && c.bottom <= b.bottom && c.top > b.top + b.height / 2 };
    });
    assert.deepEqual(marks, { send: true, clip: true });
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (els[shownId].field ? els[shownId].field.text() : els[shownId].ta.value) === "");
    let texts = [];
    for (let i = 0; i < 40 && !texts.length; i++) {
      const state = JSON.parse((await board.call("GET", "/state")).text);
      texts = (state.boxes.find(b => b.id === cardId) || {}).pendingTexts || [];
      if (!texts.length) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.deepEqual(texts, ["Sent from the new composer"]);
    // what was sent waits at the card's own foot, inside the card
    await page.waitForFunction(() => document.querySelector(".box.sel .sentwrap").children.length);
    const inCard = await page.evaluate(() => {
      const m = document.querySelector("main").getBoundingClientRect(), s = document.querySelector(".box.sel .sentwrap").getBoundingClientRect();
      return s.top >= m.top && s.bottom <= m.bottom;
    });
    assert.equal(inCard, true);
  } finally {
    await context.close();
    await board.call("POST", "/settings", JSON.stringify({ newlayout: null }));
  }
});
