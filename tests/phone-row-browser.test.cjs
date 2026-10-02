// The row of buttons along the foot of the phone page: four glass buttons in
// the band iOS gives a paired keyboard's bar, from left to right the card
// list's ticket (a circle), the open project's capsule (the long oval), a new
// card's plus (a short oval) and the settings' gear (a circle). Held here two
// ways: m.html read as text, and the page itself at an iPhone 13 mini's size
// (375 by 812, device scale 3, touch) on an invented board of five projects,
// driven by taps, a held press and a drag. Nothing reads the real board, and
// port 8877 is never touched.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { boardState, startBoard } = require("./phone-board-fixture.cjs");

const ROOT = path.resolve(__dirname, "..");
const PHONE = fs.readFileSync(path.join(ROOT, "m.html"), "utf8");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const IPHONE_13_MINI = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PAGE_FILES = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
  "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js", "index.html", "page.html"];
const settle = ms => new Promise(r => setTimeout(r, ms));

let outer, board, browser;

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-phone-row-"));
  const app = path.join(outer, "app");
  fs.mkdirSync(path.join(app, "assets"), { recursive: true });
  for (const name of PAGE_FILES) fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  for (const name of fs.readdirSync(path.join(ROOT, "assets")))
    fs.copyFileSync(path.join(ROOT, "assets", name), path.join(app, "assets", name));
  const state = boardState({ cards: 40, dir: outer });
  for (const b of state.boxes.slice(-12)){ b.done = false; b.parked = false; }
  board = await startBoard(outer, { state });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  const within = (work, ms, what) => Promise.race([work, settle(ms).then(() => { throw new Error(what + " did not finish"); })]);
  if (browser) await within(browser.close(), 15000, "closing the browser");
  if (board) await within(board.stop(), 15000, "stopping the fixture server");
  if (outer) await rm(outer, { recursive: true, force: true });
});

// each page in a context of its own, so what one test keeps in the phone's
// storage, home left open or a project chosen, never opens the next
async function openPhone(){
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const close = page.close.bind(page);
  page.close = async () => { await close(); await context.close(); };
  const problems = [];
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  page.on("console", m => {
    if (m.type() !== "error") return;
    // the fixture has no web fonts and no token logs for the home page's chart
    if (/fonts\.g(oogleapis|static)\.com|status of 500/.test(m.text())) return;
    problems.push(m.text());
  });
  await page.setViewport(IPHONE_13_MINI);
  await page.goto(board.origin + "/m", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
  await page.waitForSelector("#projlist .projrow.on", { timeout: 8000 });
  await settle(300);
  return { page, problems };
}
const middle = (page, sel) => page.$eval(sel, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
const state = page => page.evaluate(() => ({
  open: document.body.classList.contains("projopen"), held: document.getElementById("projbtn").classList.contains("held"),
  hot: [...document.querySelectorAll(".projrow.hot")].map(r => r.dataset.owner || r.id),
  owner: activeOwner, home: homeOpen, name: document.getElementById("projname").textContent,
  drawer: drawerOpen(), settings: document.getElementById("settings").classList.contains("open"),
}));

// ---- the markup and the sheet -----------------------------------------------------------
test("the row holds four glass buttons in the owner's order, each drawn as inline svg", () => {
  const dock = /<nav id="dock"[^>]*>([\s\S]*?)<\/nav>/.exec(PHONE);
  assert.ok(dock, "the row of buttons is not in the page");
  const buttons = [...dock[1].matchAll(/<button id="(\w+)" class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map(b => b[1]), ["tikbtn", "projbtn", "tikadd", "setbtn"]);
  for (const [, id, cls, inside] of buttons){
    assert.match(cls, /\bqn-glass\b/, `${id} does not wear the board's glass`);
    assert.match(cls, /\bdockbtn\b/);
    assert.match(inside, /<svg[^>]*aria-hidden="true"/, `${id} carries no inline mark`);
    assert.doesNotMatch(inside, /<img|url\(/, `${id} fetches its mark`);
  }
  // the capsule is the name and the arrows, with no dot beside the name; the ticket
  // is one outline with its side notches and no tear line
  assert.deepEqual([...buttons[1][3].matchAll(/<(\w+)/g)].map(m => m[1]), ["span", "svg", "path"], "the capsule carries more than the name and the arrows");
  assert.equal([...buttons[0][3].matchAll(/<path\b/g)].length, 1, "the ticket is more than one outline");
  // the two ends are circles
  assert.match(buttons[0][2], /\bround\b/);
  assert.match(buttons[3][2], /\bround\b/);
  // the row, the list and every rule written for them carry no purple
  const sheet = [...PHONE.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n");
  const ours = [...sheet.matchAll(/([^{}]*(?:#dock|\.dockbtn|#projbtn|#projmenu|#projshade|\.projrow|#projsep|#projlist|#tikadd)[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(ours.length >= 10, "the row's rules were not found");
  for (const [, sel, body] of ours)
    assert.doesNotMatch(body, /--accent|#432BFF|purple|violet/i, `${sel.trim()} uses a purple`);
  // nothing on the row or in the list can be long-pressed into a selection
  assert.match(sheet, /#dock\{[^}]*-webkit-user-select:none; user-select:none; -webkit-touch-callout:none/);
  assert.match(sheet, /#projmenu\{[^}]*-webkit-user-select:none; user-select:none; -webkit-touch-callout:none/);
});

// ---- the page --------------------------------------------------------------------------
test("the row's shape: two circles at the ends, the long capsule, the short plus, in the bar's band", async () => {
  const { page, problems } = await openPhone();
  try {
    const shape = await page.evaluate(() => [...document.querySelectorAll("#dock .dockbtn")].map(b => {
      const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      return { id: b.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
        radius: cs.borderTopLeftRadius, glass: cs.backdropFilter || cs.webkitBackdropFilter };
    }));
    const [ticket, capsule, plus, gear] = shape;
    for (const b of shape){
      assert.equal(b.height, 48, `${b.id} is not the bar's 48px`);
      assert.equal(b.bottom, IPHONE_13_MINI.height - 10, `${b.id} is not 10px off the bottom edge`);
      assert.equal(b.radius, "24px", `${b.id} is not round at its ends`);
      assert.match(b.glass, /blur\(15px\)/, `${b.id} is not the board's glass`);
    }
    assert.equal(ticket.left, 16, "the row does not start 16px in");
    assert.equal(gear.right, IPHONE_13_MINI.width - 16, "the row does not end 16px in");
    assert.equal(ticket.width, 48, "the ticket is not a circle");
    assert.equal(gear.width, 48, "the gear is not a circle");
    assert.ok(plus.width > 48 && plus.width < capsule.width, "the plus is not an oval shorter than the capsule");
    assert.ok(capsule.width / capsule.height > 2.5, "the capsule is not the long oval");
    assert.ok(plus.width / plus.height < 2, "the plus is as long as the capsule");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("the ticket opens the card list, the gear the settings, and the plus makes a card to name", async () => {
  const { page, problems } = await openPhone();
  try {
    await page.tap("#tikbtn");
    await settle(800);
    assert.equal((await state(page)).drawer, true, "the ticket did not open the card list");
    await page.touchscreen.tap(IPHONE_13_MINI.width - 20, 300);   // the shade shuts it
    await settle(800);
    assert.equal((await state(page)).drawer, false);
    await page.tap("#setbtn");
    await settle(800);
    assert.equal((await state(page)).settings, true, "the gear did not open the settings");
    await page.touchscreen.tap(20, 300);
    await settle(800);
    assert.equal((await state(page)).settings, false);

    const created = page.waitForResponse(r => new URL(r.url()).pathname === "/create");
    await page.tap("#tikadd");
    const made = (await (await created).json()).id;
    await page.waitForFunction(id => document.querySelector(`#box-${id}.sel .title`)?.isContentEditable, { timeout: 5000 }, made);
    // naming it is typing: the row is out of sight while the title takes the words
    assert.equal(await page.evaluate(() => document.getElementById("dock").classList.contains("away")), true,
      "the row of buttons stayed in sight while the new card's title was being named");
    await page.keyboard.type("Named from the row");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => lastState?.boxes.find(b => b.id === id)?.title === "Named from the row", { timeout: 5000 }, made);
    await settle(300);
    // the caret goes on from the title into the card's composer, still typing,
    // so the row stays out of sight until nothing is being typed in
    assert.equal(await page.evaluate(() => typingFocus() && document.getElementById("dock").classList.contains("away")), true,
      "the row of buttons came back while the new card was still being typed in");
    await page.evaluate(() => document.activeElement.blur());
    await settle(500);
    assert.equal(await page.evaluate(() => document.getElementById("dock").classList.contains("away")), false,
      "the row of buttons did not come back once nothing was being typed");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a tap on the capsule opens the list over the row, a tap on a project switches to it, and the shade shuts it", async () => {
  const { page, problems } = await openPhone();
  try {
    const before = await state(page);
    await page.tap("#projbtn");
    await settle(400);
    const open = await page.evaluate(() => {
      const menu = document.getElementById("projmenu").getBoundingClientRect();
      const dock = document.getElementById("dock").getBoundingClientRect();
      return { open: document.body.classList.contains("projopen"), expanded: document.getElementById("projbtn").getAttribute("aria-expanded"),
        first: document.querySelector("#projmenu .projrow").id, bottom: menu.bottom, dockTop: dock.top,
        rows: [...document.querySelectorAll("#projlist .projrow")].map(r => r.dataset.owner) };
    });
    assert.equal(open.open, true);
    assert.equal(open.expanded, "true");
    assert.equal(open.first, "homeico", "Home does not head the list");
    assert.ok(open.bottom <= open.dockTop, "the list does not stand over the row");
    assert.ok(open.rows.length >= 2);
    // the shade: a tap anywhere else shuts it and changes nothing
    await page.touchscreen.tap(IPHONE_13_MINI.width / 2, 100);
    await settle(300);
    assert.deepEqual(await state(page), { ...before, open: false });
    // a tap on another project's row
    const other = open.rows.find(ow => ow !== before.owner);
    await page.tap("#projbtn");
    await settle(400);
    await page.tap(`#projlist .projrow[data-owner="${other}"]`);
    await settle(400);
    const after = await state(page);
    assert.equal(after.owner, other, "the tap did not switch project");
    assert.equal(after.open, false, "the list stayed open after the choice");
    assert.equal(after.name, await page.$eval(`#projlist .projrow[data-owner="${other}"] .pname`, n => n.textContent),
      "the capsule does not name the project chosen");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a held press grows the capsule and pops the list, a drag lights a row, and lifting on it chooses it", async () => {
  const { page, problems } = await openPhone();
  try {
    const before = await state(page);
    const at = await middle(page, "#projbtn");
    const size = () => page.$eval("#projbtn", b => b.getBoundingClientRect().width);
    const rest = await size();
    await page.touchscreen.touchStart(at.x, at.y);
    await settle(200);
    assert.ok(await size() > rest, "the capsule did not grow under the held finger");
    assert.equal((await state(page)).open, false, "the list popped before the hold was up");
    await settle(400);
    const held = await state(page);
    assert.equal(held.open, true, "the list did not pop under the held finger");
    assert.equal(held.held, true);
    // up over the list, finger still down
    const rows = await page.$$eval("#projlist .projrow", rs => rs.map(r => {
      const b = r.getBoundingClientRect();
      return { owner: r.dataset.owner, x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }));
    const target = rows.find(r => r.owner !== before.owner);
    for (let i = 1; i <= 10; i++){
      await page.touchscreen.touchMove(at.x + (target.x - at.x) * i / 10, at.y + (target.y - at.y) * i / 10);
      await settle(25);
    }
    assert.deepEqual((await state(page)).hot, [target.owner], "the row under the finger is not lit");
    await page.touchscreen.touchEnd();
    await settle(500);
    const after = await state(page);
    assert.equal(after.owner, target.owner, "lifting on the row did not choose it");
    assert.equal(after.open, false);
    assert.equal(after.held, false);
    assert.deepEqual(after.hot, []);
    // a hold let go on nothing leaves the list open for a tap
    await page.touchscreen.touchStart(at.x, at.y);
    await settle(600);
    await page.touchscreen.touchEnd();
    await settle(300);
    assert.equal((await state(page)).open, true, "a hold let go on the capsule shut the list");
    await page.tap("#homeico");
    await settle(600);
    const home = await state(page);
    assert.equal(home.home, true, "Home in the list did not open home");
    assert.equal(home.name, "Home", "the capsule does not read Home");
    assert.equal(home.open, false);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a finger on the composer fades the row before the focus comes, and a touch that brings no focus lets it back", async () => {
  const { page, problems } = await openPhone();
  try {
    const row = () => page.evaluate(() => ({ away: document.getElementById("dock").classList.contains("away"),
      typing: typingFocus() }));
    const at = await page.$eval("article.box.sel .compose", c => { const r = c.getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
    // the finger is down and nothing is focused yet: the fade has begun
    await page.touchscreen.touchStart(at.x, at.y);
    await settle(60);
    assert.deepEqual(await row(), { away: true, typing: false }, "the row did not start its fade from the touch");
    // a touch that turns into nothing: no focus, and the row comes back on its own
    await page.touchscreen.touchMove(at.x, at.y - 80);
    await page.touchscreen.touchEnd();
    await settle(900);
    assert.deepEqual(await row(), { away: false, typing: false }, "a touch that brought no focus left the row out of sight");
    // the touch on the reading area is not a touch on the typing row
    const reading = await middle(page, "article.box.sel .reply");
    await page.touchscreen.touchStart(reading.x, reading.y);
    await settle(60);
    assert.equal((await row()).away, false, "a touch on the answer faded the row");
    await page.touchscreen.touchEnd();
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a finger sliding off the capsule before the hold is up opens nothing, and the capsule refuses the phone's long press", async () => {
  const { page, problems } = await openPhone();
  try {
    const at = await middle(page, "#projbtn");
    await page.touchscreen.touchStart(at.x, at.y);
    for (let i = 1; i <= 6; i++){ await page.touchscreen.touchMove(at.x + i * 8, at.y); await settle(16); }
    await settle(600);
    assert.equal((await state(page)).open, false, "a sideways slide opened the list");
    await page.touchscreen.touchEnd();
    await settle(200);
    assert.equal((await state(page)).open, false);
    // the touch's own default, which is the phone's long-press selection and
    // callout and the click it would make, is refused on the capsule alone
    const refused = await page.evaluate(() => {
      const touch = new Touch({ identifier: 7, target: projBtn, clientX: 10, clientY: 10 });
      const onCapsule = !projBtn.dispatchEvent(new TouchEvent("touchstart", { cancelable: true, bubbles: true, touches: [touch] }));
      const reply = document.querySelector("article.box.sel .reply");
      const elsewhere = !reply.dispatchEvent(new TouchEvent("touchstart", { cancelable: true, bubbles: true,
        touches: [new Touch({ identifier: 8, target: reply, clientX: 10, clientY: 10 })] }));
      return { onCapsule, elsewhere, action: getComputedStyle(projBtn).touchAction };
    });
    assert.equal(refused.onCapsule, true, "the capsule left the touch's default to the phone");
    assert.equal(refused.elsewhere, false, "a touch on the card had its default taken");
    assert.equal(refused.action, "none");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});
