// The row of buttons along the foot of the phone page: four glass buttons in
// the band iOS gives a paired keyboard's bar, from left to right the card
// list's ticket (a circle), the open project's capsule (the long oval), a new
// card's plus (a short oval) and the settings' squid (a circle). Held here two
// ways: m.html read as text, and the page itself at an iPhone 13 mini's size
// (375 by 812, device scale 3, touch) on an invented board of five projects,
// driven by taps and held presses. Nothing reads the real board, and port 8877
// is never touched.
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
  open: document.body.classList.contains("projopen"),
  owner: activeOwner, home: homeOpen, name: document.getElementById("projname").textContent,
  drawer: drawerOpen(), settings: document.getElementById("settings").classList.contains("open"),
}));
// the capsule's drawn width and whether it wears its press
const capsule = page => page.$eval("#projbtn", b => ({ width: b.getBoundingClientRect().width,
  pressed: b.classList.contains("pressed"), classes: b.className }));
// the shade under the list as drawn: its weight, whether it shows, and its colour
const shade = page => page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById("projshade"));
  return { opacity: Number(cs.opacity), visible: cs.visibility === "visible", colour: cs.backgroundColor };
});

// ---- the markup and the sheet -----------------------------------------------------------
test("the row holds four glass buttons in the owner's order, three drawn as inline svg and the settings circle as the logo png", () => {
  const dock = /<nav id="dock"[^>]*>([\s\S]*?)<\/nav>/.exec(PHONE);
  assert.ok(dock, "the row of buttons is not in the page");
  const buttons = [...dock[1].matchAll(/<button id="(\w+)" class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.deepEqual(buttons.map(b => b[1]), ["tikbtn", "projbtn", "tikadd", "setbtn"]);
  for (const [, id, cls, inside] of buttons){
    assert.match(cls, /\bqn-glass\b/, `${id} does not wear the board's glass`);
    assert.match(cls, /\bdockbtn\b/);
    if (id === "setbtn"){
      assert.match(inside, /^<span class="squidmark" aria-hidden="true"><img src="\/m-splash-squid\.png"[^>]*><\/span>$/, "setbtn is not the logo png in its cropping box");
      assert.doesNotMatch(inside, /<svg|url\(/, "setbtn also carries a drawn mark");
      continue;
    }
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
    // at rest the page stands in half of --sink of each side from the screen's
    // edge and is laid out at 1 - sink of its full size
    const sink = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sink")));
    assert.ok(sink > 0 && sink < 0.05, `the page's rest step is not a small share (${sink})`);
    const rest = 1 - sink, stepX = IPHONE_13_MINI.width * sink / 2, stepY = IPHONE_13_MINI.height * sink / 2;
    const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 0.1, `${what}: ${actual} is not ${expected}`);
    for (const b of shape){
      near(b.height, 48 * rest, `${b.id} is not the bar's 48px at rest`);
      near(IPHONE_13_MINI.height - b.bottom, stepY + 10 * rest, `${b.id} is not 10px off the bottom edge at rest`);
      near(parseFloat(b.radius), 24 * rest, `${b.id} is not round at its ends`);
      assert.match(b.glass, /blur\(15px\)/, `${b.id} is not the board's glass`);
    }
    near(ticket.left, stepX + 16 * rest, "the row does not start 16px in at rest");
    near(IPHONE_13_MINI.width - gear.right, stepX + 16 * rest, "the row does not end 16px in at rest");
    near(ticket.width, 48 * rest, "the ticket is not a circle");
    near(gear.width, 48 * rest, "the gear is not a circle");
    assert.ok(plus.width > 48 * rest && plus.width < capsule.width, "the plus is not an oval shorter than the capsule");
    assert.ok(capsule.width / capsule.height > 2.5, "the capsule is not the long oval");
    assert.ok(plus.width / plus.height < 2, "the plus is as long as the capsule");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("the settings circle holds the logo's own squid png, cut to the squid, 30 units tall", async () => {
  const { page, problems } = await openPhone();
  try {
    const button = await page.$eval("#setbtn", el => ({
      tag: el.tagName, type: el.getAttribute("type"), title: el.title, label: el.getAttribute("aria-label"),
      classes: el.className, marks: el.querySelectorAll("svg").length, hidden: el.querySelector(".squidmark").getAttribute("aria-hidden"),
      images: el.querySelectorAll("img").length,
    }));
    assert.deepEqual(button, { tag: "BUTTON", type: "button", title: "Settings", label: "Settings",
      classes: "dockbtn round qn-glass", marks: 0, hidden: "true", images: 1 });
    await page.waitForFunction(() => document.querySelector("#setbtn img").complete);
    const mark = await page.evaluate(() => {
      const img = document.querySelector("#setbtn img"), box = document.querySelector("#setbtn .squidmark").getBoundingClientRect();
      return { src: new URL(img.src).pathname, natural: [img.naturalWidth, img.naturalHeight], w: box.width, h: box.height };
    });
    assert.equal(mark.src, "/m-splash-squid.png", "the mark is not the logo's own png");
    assert.deepEqual(mark.natural, [1247, 1261], "the logo png did not load");
    assert.ok(mark.h > 28 && mark.h <= 30, "the squid is not 30 units tall at the row's rest size: " + mark.h);
    assert.ok(Math.abs(mark.w / mark.h - 917 / 1126) < 0.02, "the cut is not the squid's own proportions");
    // drawn at the row's rest size, and still inside its circle
    const fit = await page.evaluate(() => {
      const b = document.getElementById("setbtn").getBoundingClientRect(), s = document.querySelector("#setbtn .squidmark").getBoundingClientRect();
      return { inside: s.left > b.left && s.right < b.right && s.top > b.top && s.bottom < b.bottom,
        dx: (s.left + s.right) / 2 - (b.left + b.right) / 2, dy: (s.top + s.bottom) / 2 - (b.top + b.bottom) / 2 };
    });
    assert.equal(fit.inside, true, "the mark is not inside its circle");
    assert.ok(Math.abs(fit.dx) < 0.5 && Math.abs(fit.dy) < 0.5, `the mark is not centred in its circle (${fit.dx}, ${fit.dy})`);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("the glass's top rim is one line on every button and on the list: the grey ring, with no white or dark line along it", async () => {
  const { page, problems } = await openPhone();
  try {
    await page.tap("#projbtn");
    await settle(400);
    const shadows = await page.evaluate(() => ["tikbtn", "projbtn", "tikadd", "setbtn", "projmenu"].map(id =>
      [id, getComputedStyle(document.getElementById(id)).boxShadow]));
    for (const [id, shadow] of shadows){
      // the ring, one pixel all round, is drawn
      assert.match(shadow, /rgb\(199, 199, 204\) 0px 0px 0px 1px inset/, `${id} has lost the grey ring`);
      // and nothing lies along the top of it: no inset line offset down by one
      // or two pixels, which is what drew the white line and the dark one
      assert.doesNotMatch(shadow, /\) 0px [12]px 0px 0px inset/, `${id} draws a line along its top rim: ${shadow}`);
      // the bottom rim, the inner glow and the outer shadow are the glass's own
      assert.match(shadow, /0px -1px 0px 0px inset/, `${id} has lost the bottom rim`);
      assert.match(shadow, /0px 8px 20px 0px/, `${id} has lost the glass's outer shadow`);
    }
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("the ticket opens the card list, the gear the settings, and the plus makes a card to name", async () => {
  const { page, problems } = await openPhone();
  try {
    await page.tap("#tikbtn");
    await settle(800);
    assert.equal((await state(page)).drawer, true, "the ticket did not open the card list");
    // the card is down, below the box; a tap on the card shuts the list
    await page.touchscreen.tap(IPHONE_13_MINI.width / 2, IPHONE_13_MINI.height * 0.8);
    await settle(800);
    assert.equal((await state(page)).drawer, false, "a tap on the card did not shut the list");
    await page.tap("#setbtn");
    await settle(800);
    assert.equal((await state(page)).settings, true, "the gear did not open the settings");
    // the settings fill the screen, so there is no shade to tap: a swipe to the right puts them away
    await page.touchscreen.touchStart(100, 400);
    for (let x = 140; x <= 380; x += 40) await page.touchscreen.touchMove(x, 402);
    await page.touchscreen.touchEnd();
    await settle(800);
    assert.equal((await state(page)).settings, false, "a swipe to the right did not put the settings away");

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

test("opening the list dims the page a little, and the dim fades away however the list is shut", async () => {
  const { page, problems } = await openPhone();
  try {
    const rest = await shade(page);
    assert.equal(rest.opacity, 0, "the page is dimmed with the list shut");
    assert.equal(rest.visible, false);
    // the drawers' shade, lighter: the same warm ink at a smaller weight
    const scrim = await page.$eval("#scrim", s => getComputedStyle(s).backgroundColor);
    const ink = c => /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(c).slice(1).map(Number);
    const [sr, sg, sb, sa] = ink(scrim), [r, g, b, a] = ink(rest.colour);
    assert.deepEqual([r, g, b], [sr, sg, sb], "the list's shade is not the drawers' colour");
    assert.ok(a > 0 && a < sa, `the list's shade (${a}) is not lighter than the drawers' (${sa})`);
    // its fade out runs however it is shut, so the shut state carries a timing
    assert.notEqual(await page.$eval("#projshade", s => getComputedStyle(s).transitionDuration), "0s, 0s");

    const dimmed = async how => {
      await page.tap("#projbtn");
      await settle(400);
      const on = await shade(page);
      assert.equal(on.opacity, 1, `the list opened (${how}) without its shade`);
      assert.equal(on.visible, true);
      assert.equal((await state(page)).open, true);
    };
    const back = async how => {
      await settle(400);
      assert.equal((await state(page)).open, false, `the list stayed open after ${how}`);
      assert.deepEqual(await shade(page), rest, `the page stayed dimmed after ${how}`);
    };
    // a tap outside the list
    await dimmed("for a tap outside");
    await page.touchscreen.tap(IPHONE_13_MINI.width / 2, 100);
    await back("a tap outside");
    // a project chosen in it
    await dimmed("for a choice");
    const other = await page.$eval("#projlist .projrow:not(.on)", r => r.dataset.owner);
    await page.tap(`#projlist .projrow[data-owner="${other}"]`);
    await back("a project was chosen");
    assert.equal((await state(page)).owner, other);
    // Escape, from a paired keyboard
    await dimmed("for Escape");
    await page.keyboard.press("Escape");
    await back("Escape");
    // Home chosen in it
    await dimmed("for Home");
    await page.tap("#homeico");
    await back("Home was chosen");
    assert.equal((await state(page)).home, true);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a held press on the capsule does no more than a tap: it grows a little, opens nothing while held, and its lift is a tap", async () => {
  const { page, problems } = await openPhone();
  try {
    const at = await middle(page, "#projbtn");
    const rest = await capsule(page);
    assert.equal(rest.pressed, false);
    await page.touchscreen.touchStart(at.x, at.y);
    await settle(200);
    const pressed = await capsule(page);
    assert.equal(pressed.pressed, true, "the capsule did not take its press under the finger");
    assert.ok(pressed.width > rest.width, "the capsule did not grow under the finger");
    // held past the old hold's 380 ms and well past the press's own rise: no
    // list, no state of its own, no growth past the press
    await settle(900);
    const held = await capsule(page);
    assert.equal((await state(page)).open, false, "the list popped under a held finger");
    assert.deepEqual(held.classes.split(/\s+/).filter(c => !["dockbtn", "qn-glass"].includes(c)), ["pressed"],
      "the capsule wears something besides its press while held");
    assert.ok(held.width <= rest.width * 1.1 + 0.5, "the capsule grew past its press");
    // the lift is a tap's: the list opens, and the capsule settles back
    await page.touchscreen.touchEnd();
    await settle(50);
    assert.equal((await state(page)).open, true, "the lift after a hold did not open the list as a tap does");
    await settle(750);
    const after = await capsule(page);
    assert.equal(after.pressed, false, "the capsule kept its press once let go");
    assert.equal(after.width, rest.width, "the capsule did not settle back to its own size");
    // shutting the list leaves the capsule at its size
    await page.touchscreen.tap(IPHONE_13_MINI.width / 2, 100);
    await settle(800);
    assert.equal((await state(page)).open, false);
    assert.equal((await capsule(page)).width, rest.width, "the capsule stayed grown after the list shut");
    // the tap: the press shows, the list opens at the lift, and the press settles
    await page.tap("#projbtn");
    await settle(40);
    assert.equal((await capsule(page)).pressed, true, "a tap showed no press");
    assert.equal((await state(page)).open, true, "a tap did not open the list at its lift");
    await settle(800);
    assert.deepEqual(await capsule(page), rest, "the capsule did not settle back after a tap");
    await page.touchscreen.tap(IPHONE_13_MINI.width / 2, 100);
    await settle(800);
    assert.equal((await capsule(page)).width, rest.width);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("a press ends wherever its finger lifts, and a page put away with a finger still down drops it, so nothing comes back grown", async () => {
  const { page, problems } = await openPhone();
  try {
    const rest = await capsule(page);
    const at = await middle(page, "#projbtn");
    // the phone sends a lift to whatever is under the finger by then, which on
    // the old hold was the list's shade: the capsule never heard it and stayed
    // grown. a lift landing on the card ends the press all the same
    await page.$eval("#projbtn", b => b.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 41, pointerType: "touch", isPrimary: true })));
    assert.equal((await capsule(page)).pressed, true);
    await page.$eval("article.box.sel .reply", r => r.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 41, pointerType: "touch", isPrimary: true })));
    await settle(800);
    const lifted = await capsule(page);
    assert.equal(lifted.pressed, false, "a lift that landed on the card left the capsule pressed");
    assert.equal(lifted.width, rest.width, "a lift that landed on the card left the capsule grown");
    // the phone's own swipe home can take a touch that started on the row, and
    // the page then hears no end to it, only that it was put away
    await page.touchscreen.touchStart(at.x, at.y);
    await settle(200);
    assert.equal((await capsule(page)).pressed, true);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
    });
    const dropped = await capsule(page);
    assert.equal(dropped.pressed, false, "the press outlived the page being put away");
    await settle(800);
    assert.equal((await capsule(page)).width, rest.width, "the capsule came back grown");
    await page.touchscreen.touchEnd();
    // the other three drop theirs the same way
    for (const id of ["tikbtn", "tikadd", "setbtn"]){
      await page.$eval("#" + id, b => b.classList.add("pressed"));
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        delete document.visibilityState;
      });
      assert.equal(await page.$eval("#" + id, b => b.classList.contains("pressed")), false, `${id} kept its press`);
    }
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

test("a finger sliding along the capsule opens nothing, and the capsule alone refuses the touch's default", async () => {
  const { page, problems } = await openPhone();
  try {
    const at = await middle(page, "#projbtn");
    await page.touchscreen.touchStart(at.x, at.y);
    for (let i = 1; i <= 6; i++){ await page.touchscreen.touchMove(at.x + i * 8, at.y); await settle(16); }
    await settle(600);
    assert.equal((await state(page)).open, false, "a sideways slide opened the list");
    await page.touchscreen.touchEnd();
    await settle(800);
    assert.equal((await state(page)).open, false);
    assert.equal((await capsule(page)).pressed, false, "the slide left the capsule pressed");
    // the touch's own default, which is the click the phone would hand on a
    // third of a second later to whatever lies under the finger by then (the
    // list's shade, which would shut the list again) and the phone's
    // long-press selection and callout, is refused on the capsule alone
    const touch = await page.evaluate(() => {
      const refused = el => !el.dispatchEvent(new TouchEvent("touchstart", { cancelable: true, bubbles: true,
        touches: [new Touch({ identifier: 7, target: el, clientX: 10, clientY: 10 })] }));
      return { onCapsule: refused(projBtn), onTicket: refused(document.getElementById("tikbtn")),
        onCard: refused(document.querySelector("article.box.sel .reply")), select: getComputedStyle(projBtn).userSelect };
    });
    assert.equal(touch.onCapsule, true, "the capsule left the touch's default to the phone");
    assert.equal(touch.onTicket, false, "a touch on the ticket had its default taken");
    assert.equal(touch.onCard, false, "a touch on the card had its default taken");
    assert.equal(touch.select, "none");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});
