// The phone page's shell, built along a proven full-screen design: the
// standalone metas that hand the app the whole screen, the room the card keeps
// under its own foot so the composer clears the keyboard while the card's top
// and title stand still, the close that lands with no jump and no bare strip,
// the focus locks keyed to whichever field is actually focused, and the guard
// that stops a size watcher from chasing its own writes. Grown one unit at a
// time.
//
// What only an iPhone can show, the keyboard's own motion beside the card's and
// the status bar's inset on the reported height, is proven on the simulator.
// Here the source and the headless geometry are pinned.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const KEYBOARD = 336;          // an iPhone keyboard with its accessory bar, in css px
const ACCESSORY = 54;          // a small reported obstruction, such as a hardware-keyboard accessory strip
const INSET = 6;               // --app-inset, the card's thin margin from an edge
const SEL = "article.box.sel textarea";

let browser, child, fixtureDir, origin;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}
async function create(title) {
  const result = await api("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}
async function settle(ms = 250) { await new Promise(resolve => setTimeout(resolve, ms)); }

// the stand-in visual viewport the tests move, since headless chrome cannot raise
// a keyboard; set(height, offsetTop) is one keyboard report, a resize and a scroll
function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height; geom.offsetTop = offsetTop; geom.scale = scale;
      vv.dispatchEvent(new Event("resize")); vv.dispatchEvent(new Event("scroll"));
    },
  };
}

async function openPhone(route, { fake = false, roWatch = false } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  if (fake) await page.evaluateOnNewDocument(fakeViewport);
  if (roWatch) await page.evaluateOnNewDocument(() => {
    // the browser reports a size watcher that keeps resizing what it watches as
    // a window error with this exact message; count them and keep them off the
    // console so the count is the only reading
    window.__roErrors = 0;
    window.addEventListener("error", e => {
      if (/ResizeObserver loop/.test(e.message || "")) { window.__roErrors++; e.preventDefault(); }
    });
  });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

// the measure the root takes its height from, and the boxes that take it
function rootMeasure(page) {
  return page.evaluate(() => ({
    measure: getComputedStyle(document.documentElement).getPropertyValue("--root-h").trim(),
    root: Math.round(document.documentElement.getBoundingClientRect().height),
    body: Math.round(document.body.getBoundingClientRect().height),
    inner: window.innerHeight,
    standalone: matchMedia("(display-mode: standalone)").matches,
  }));
}

// the card's foot, the composer's foot, and the close's own leftovers, read in
// the visual viewport's coordinates
function shellShape() {
  const vvTop = window.visualViewport.offsetTop;
  const pane = document.getElementById("pane").getBoundingClientRect();
  const ta = document.querySelector("article.box.sel textarea").getBoundingClientRect();
  const view = document.querySelector("article.box.sel .replyview");
  const page = document.getElementById("page");
  const body = document.body;
  return {
    foot: pane.bottom - vvTop, rowBottom: ta.bottom - vvTop,
    kb: body.classList.contains("kb"), obstructed: body.classList.contains("obstructed"),
    lifting: body.classList.contains("lifting"),
    kbInset: page.style.getPropertyValue("--kb-inset"),
    kbLift: getComputedStyle(page).getPropertyValue("--kb-lift").trim(),
    // the room the card keeps under its own foot for the keyboard, which is the
    // whole of the lift now
    paneRoom: getComputedStyle(document.getElementById("pane")).marginBottom,
    answer: Math.round(view.getBoundingClientRect().height),
    replyScroll: view.scrollTop, winX: window.scrollX, winY: window.scrollY,
    shellH: body.style.getPropertyValue("--shell-h"),
  };
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-shell-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone shell test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Meta." }],
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir, env: { ...process.env, FACILITATOR_TEST_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { const response = await fetch(origin + "/state"); if (response.ok) { ready = true; break; } } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- unit 1: the viewport model and the full-screen start ----------------------------

test("the installed shell asks the phone for a full-screen web view", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  // A standalone home-screen app whose status bar style is the plain default
  // starts BELOW the status bar, so it reads a viewport shorter than the screen
  // and centres its start screen in that shorter box, low on the real screen.
  // The full-screen style hands the app the whole screen top to bottom, with the
  // safe areas carried by the page's own padding, so the reported height is the
  // screen's own and the start screen is centred on it.
  assert.match(source, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/,
    "the shell does not ask for the full-screen status-bar style");
  assert.match(source, /name="apple-mobile-web-app-capable" content="yes"/,
    "the shell is not installable as a standalone app");
  assert.match(source, /viewport-fit=cover/,
    "the viewport does not cover the whole screen");
});

test("the installed display mode measures the root by the screen, a tab by its box", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  const sheet = source.slice(source.indexOf("<style>"), source.indexOf("</style>"));
  // A percentage on the root resolves against the box the web view first offers
  // the page, which in a home-screen app is the screen less the status bar. A
  // root that exactly fills that shorter box is what the web view settles to,
  // and it then reports a viewport missing the top safe area, however
  // full-screen the metas above asked to be. A root measured by the screen
  // overhangs the first offer and the web view opens to the whole screen. Only
  // the root changes measure: everything under it, the body included, still
  // follows its containing block, which can be shorter than a unit reads.
  assert.match(sheet, /html\{height:var\(--root-h\)/, "the root does not take the display mode's measure");
  assert.match(sheet, /body\{[^}]*height:100%/, "the body no longer follows its containing block");
  const { page, problems } = await openPhone("/m");
  try {
    const tab = await rootMeasure(page);
    assert.equal(tab.measure, "100%", "a browser tab does not measure the root by its own box");
    assert.equal(tab.standalone, false, "the tab reported itself as an installed app");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
  // No media-feature emulation carries a display mode, so the installed reading
  // is taken from a window the browser itself opened in that mode.
  const installedBrowser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run", `--app=${origin}/m`] });
  try {
    const [appPage] = await installedBrowser.pages();
    await appPage.setViewport(PHONE);
    await appPage.goto(`${origin}/m`, { waitUntil: "domcontentloaded" });
    await appPage.waitForFunction(() => lastState !== null, { timeout: 5000 });
    const installed = await rootMeasure(appPage);
    assert.equal(installed.standalone, true, "the app window did not report the installed display mode");
    assert.equal(installed.measure, "100vh", "an installed app does not measure the root by the screen");
    assert.equal(installed.root, installed.inner, "the root box is not the whole reported viewport");
    assert.equal(installed.body, installed.inner, "the body box is not the whole reported viewport");
  } finally {
    await installedBrowser.close();
  }
});

test("the start globe is centred on its own full-screen box", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  const curtain = source.slice(source.indexOf("#loading{"), source.indexOf("/* card prose"));
  // The curtain is pinned to all four edges and the globe is centred in it by
  // half its own size, so once the web view is the whole screen the globe sits
  // at the screen's own centre. This pins the centring mechanism; the on-device
  // shift the plain status-bar style caused is measured on the simulator.
  assert.match(curtain, /#loading\{[^}]*position:fixed; left:0; right:0; top:0; height:var\(--screen-h, var\(--root-h\)\)/,
    "the curtain is not measured by the screen, falling back to the root's own height");
  assert.match(source, /if \(navigator\.standalone\) \{\s*\n\s*document\.documentElement\.style\.setProperty\("--screen-h", screen\.height \+ "px"\);/,
    "the screen's height is not handed to the sheet before the page is laid out");
  // the curtain still needs no script to exist: its markup comes first, and the
  // one line that measures it stands after the curtain it measures
  assert.ok(source.indexOf('<div id="loading"') < source.indexOf('setProperty("--screen-h"'),
    "the screen's height is written before the curtain it measures");
  assert.match(curtain, /left:50%; top:50%/, "the globe is not centred in the curtain");
  assert.match(curtain, /margin:-7vmin 0 0 -7vmin/, "the globe is not pulled back by half its own size");
});

// ---- unit 2: the card's foot takes the keyboard ---------------------------------------

test("the card keeps the keyboard's room under its own foot, and nothing above it moves", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  const sheet = source.slice(source.indexOf("<style>"), source.indexOf("</style>"));
  // the pane stands in the page's own column: the clip box a whole-card lift
  // needed is gone, because nothing above the card's bottom edge moves any more
  assert.doesNotMatch(sheet, /#shelf\{/, "the clip box for a whole-card lift is still in the sheet");
  assert.doesNotMatch(source, /id="shelf"/, "the clip box for a whole-card lift is still in the markup");
  // the card holds the keyboard's room under its own foot, on the keyboard's own
  // clock, so its foot and the typing row come up and its top edge does not
  assert.match(sheet, /main\{[^}]*margin-bottom:calc\(0px - var\(--kb-lift, 0px\)\)/,
    "the card's foot does not keep the lift as its own room");
  assert.match(sheet, /main\{[^}]*transition:margin-bottom var\(--kb-anim\)/,
    "the card's foot is not on the keyboard clock");
  assert.doesNotMatch(sheet, /main\{[^}]*transform:\s*translateY\(var\(--kb-lift/,
    "the whole card still rides the keyboard's lift");
  assert.doesNotMatch(sheet, /\.body\{[^}]*transform:\s*translateY\(var\(--kb-lift/,
    "the card body still lifts on its own, under a title that stays put");
  // the reachability padding went with the lift it answered: an answer whose top
  // never moves needs nothing given back, and the padding drew as a blank band
  assert.doesNotMatch(sheet, /--lift-pad/, "the answer still takes a lift's reachability padding");
  // the lift distance: the resting clearance less the gap less the keyboard
  // inset, floored at nothing so the rise can never come out a fall
  assert.match(sheet, /--kb-lift:min\(0px, calc\(var\(--pad-b\)\s*-\s*var\(--kb-gap\)\s*-\s*var\(--kb-inset\)\)\)/,
    "the lift distance is not the resting clearance less the gap less the inset, floored at nothing");
  // the page's own bottom padding still never grows with the keyboard: the room
  // is the card's, so the strip and the page under it are left alone
  assert.doesNotMatch(sheet, /body\.obstructed[^{]*#page\{[^}]*--pad-b:/,
    "the page still grows its padding at the keyboard edge");
});

test("the keyboard raises the card's bottom edge and the typing row, and nothing above them", async () => {
  const id = await create("Bottom rise on the phone");
  const paras = [];
  for (let n = 1; n <= 40; n++) paras.push(`Paragraph ${n} of an answer long enough to scroll on a phone.`);
  await api(`/reply?box=${id}`, paras.join("\n\n"));
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  // the edges the order names, in the visible viewport's own coordinates
  const marks = () => page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    const view = box.querySelector(".replyview");
    const round = value => Math.round(value * 10) / 10;
    const edge = (el, side) => round(el.getBoundingClientRect()[side]);
    const bar = document.querySelector(".bar"), pane = document.getElementById("pane");
    const topbar = box.querySelector(".topbar");
    return {
      barTop: edge(bar, "top"), barBottom: edge(bar, "bottom"),
      cardTop: edge(pane, "top"), cardBottom: edge(pane, "bottom"),
      titleBarTop: edge(topbar, "top"), titleBarBottom: edge(topbar, "bottom"),
      rowBottom: edge(box.querySelector(".compose"), "bottom"),
      answer: round(view.getBoundingClientRect().height),
      answerPad: getComputedStyle(view).paddingTop,
      answerTravel: Math.round(view.scrollHeight - view.clientHeight),
      visible: window.visualViewport.height,
    };
  });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const rest = await marks();
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(450);
    const up = await marks();
    const rose = Math.round(rest.rowBottom - up.rowBottom);
    assert.ok(Math.abs(rose - KEYBOARD) <= 2, `the typing row rose ${rose}, not the keyboard's ${KEYBOARD}`);
    // the card's own bottom edge comes up with the row it carries, so the row
    // sits on the keyboard with the card's edge just under it
    assert.equal(Math.round(rest.cardBottom - up.cardBottom), rose,
      "the card's bottom edge did not rise with the typing row");
    // and nothing above that edge moves: the strip keeps its place, the card
    // keeps its gap under the strip, and the title bar never leaves
    for (const key of ["barTop", "barBottom", "cardTop", "titleBarTop", "titleBarBottom"]) {
      assert.equal(up[key], rest[key], `${key} moved with the keyboard: ${rest[key]} to ${up[key]}`);
    }
    assert.ok(up.titleBarBottom <= up.visible,
      `the title bar (${up.titleBarBottom}) is below the visible viewport (${up.visible})`);
    // what gives is the answer between them: it is shorter by exactly the rise,
    // and it keeps every word by handing the loss to its own scroll
    assert.equal(Math.round(rest.answer - up.answer), rose, "the answer did not shorten by the keyboard's rise");
    assert.equal(up.answerPad, "0px", "the answer took top padding, which reads as a blank band under the title");
    assert.equal(up.answerTravel, rest.answerTravel + rose, "the shortened answer did not gain the travel it lost");

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(600);
    const down = await marks();
    assert.deepEqual(down, rest, "the card did not come back to the shape it rests in");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the keyboard curve is the measured one and the settle clock matches it", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.match(source, /--kb-anim:\.22s cubic-bezier\(\.45,0,\.55,1\)/, "the keyboard curve is not the measured one");
  assert.match(source, /const KB_ANIM_MS = 220/, "the settle clock does not match the css curve");
  // the lift's landing is watched on the pane's own room, not the page's padding
  assert.match(source, /e\.target\.id === "pane" && e\.propertyName === "margin-bottom"/,
    "the lift landing is not watched on the card's own room");
  assert.doesNotMatch(source, /propertyName === "padding-bottom"/, "the lift landing still watches the old padding");
});

// ---- unit 3: the close ---------------------------------------------------------------

test("the close never carries the card below where it rests", async () => {
  const id = await create("Shell close travel on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  // a headless window has no home indicator, so the clearance the arithmetic
  // subtracts is nothing and the fault cannot appear. the phone's own clearance
  // is written in here, which is the whole of what the device adds
  const PAD_B = 40;
  const lift = () => page.evaluate(() => {
    const room = parseFloat(getComputedStyle(document.getElementById("pane")).marginBottom) || 0;
    return {
      declared: getComputedStyle(document.getElementById("page")).getPropertyValue("--kb-lift").trim(),
      moved: -Math.round(room),
      lifting: document.body.classList.contains("lifting"),
    };
  });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.addStyleTag({ content: `#page{--pad-b:${PAD_B}px}` });
    await settle(60);
    assert.equal((await lift()).moved, 0, "the card's foot is not at rest before the keyboard");
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(450);
    assert.ok((await lift()).moved < 0, "the card's foot did not rise for the keyboard");
    // the inset goes to nothing at focus loss while the pane is still held for
    // the settle window. what is held there must be the rise ending, not a fall
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(260);
    const held = await lift();
    assert.equal(held.lifting, true, "the settle window closed before the reading");
    // the reading is the room the pane actually keeps, since a custom property
    // hands back its own text rather than a resolved length
    assert.ok(held.moved <= 0,
      `the card's foot was carried ${held.moved} points below where it rests, on a lift of ${held.declared}`);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(500);
    assert.equal((await lift()).moved, 0, "the card's foot did not land back at rest");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the close starts at focus loss and leaves no residue", async () => {
  const id = await create("Shell close on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(450);
    const up = await page.evaluate(shellShape);
    assert.ok(up.rowBottom <= PHONE.height - KEYBOARD, "the composer did not rise over the keyboard");
    // the return begins at focus loss, before the viewport has reported anything:
    // the inset is already zero and the box is still held for the settle window
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(40);
    const atLoss = await page.evaluate(shellShape);
    assert.equal(atLoss.kbInset, "0px", "the inset did not go to zero at focus loss");
    assert.equal(atLoss.lifting, true, "the box was not held through the close");
    assert.equal(atLoss.shellH, `${PHONE.height}px`, "the box was dropped before the keyboard was gone");
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(500);
    const down = await page.evaluate(shellShape);
    assert.equal(down.obstructed, false);
    assert.equal(down.lifting, false, "the settle window did not close");
    assert.equal(down.kbInset, "0px", "the keyboard inset was left on after the close");
    assert.equal(down.paneRoom, "0px", "the card kept the keyboard's room after the close");
    assert.equal(down.answer, up.answer + KEYBOARD, "the answer did not get its height back after the close");
    assert.equal(down.winX, 0, "a window scroll was left after the close");
    assert.equal(down.winY, 0, "a window scroll was left after the close");
    assert.equal(down.foot, PHONE.height - INSET, "the card foot moved across the close");
    assert.ok(down.rowBottom > PHONE.height - KEYBOARD, "the composer did not come back down");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("repeated keyboard cycles keep the answer's place and accumulate nothing", async () => {
  const id = await create("Shell cycles on the phone");
  const paras = [];
  for (let n = 1; n <= 40; n++) paras.push(`Paragraph ${n} of an answer long enough to scroll on a phone.`);
  await api(`/reply?box=${id}`, paras.join("\n\n"));
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const place = await page.evaluate(() => {
      const v = document.querySelector("article.box.sel .replyview"); v.scrollTop = 120; return v.scrollTop;
    });
    assert.ok(place > 100, "the answer did not take a reading position");
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.focus(SEL);
      await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
      await settle(400);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await settle(60);
      await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
      await settle(400);
    }
    const after = await page.evaluate(shellShape);
    assert.equal(after.obstructed, false);
    assert.equal(after.lifting, false, "the settle window never closed across the cycles");
    assert.equal(after.kbInset, "0px", "the keyboard inset accumulated across cycles");
    assert.equal(after.paneRoom, "0px", "the keyboard's room accumulated across cycles");
    assert.equal(after.winX, 0);
    assert.equal(after.winY, 0);
    assert.equal(after.foot, PHONE.height - INSET, "the card foot drifted across cycles");
    assert.ok(Math.abs(after.replyScroll - place) <= 1, `the answer's place drifted to ${after.replyScroll} from ${place}`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the accessory strip going while the field stays focused returns the composer cleanly", async () => {
  const id = await create("Shell accessory close on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - ACCESSORY);
    await settle(400);
    const up = await page.evaluate(shellShape);
    assert.equal(up.obstructed, true);
    assert.equal(up.kb, false, "the accessory strip was read as a full keyboard");
    assert.ok(up.rowBottom <= PHONE.height - ACCESSORY, "the composer did not rise over the accessory strip");
    assert.equal(await page.evaluate(() => editing()), true, "the field was not focused for the accessory test");
    // the strip goes but the field keeps its focus, the way a hardware keyboard leaves it
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(500);
    const down = await page.evaluate(shellShape);
    assert.equal(down.obstructed, false, "the card stayed obstructed after the strip went");
    assert.equal(down.kbInset, "0px", "the inset was left on after the strip went");
    assert.equal(down.paneRoom, "0px", "the card kept the strip's room after the strip went");
    assert.equal(down.foot, PHONE.height - INSET, "the card foot moved after the strip went");
    assert.ok(down.rowBottom > PHONE.height - ACCESSORY, "the composer did not return after the strip went");
    assert.equal(await page.evaluate(() => editing()), true, "the field lost focus when only the strip went");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a card switch while the keyboard is up hands the new card the shorter answer", async () => {
  const a = await create("Card A on the phone");
  await api(`/reply?box=${a}`, "Answer A, long enough to hold a reading position.");
  const b = await create("Card B on the phone");
  await api(`/reply?box=${b}`, "Answer B.");
  const { page, problems } = await openPhone(`/m?box=${a}`, { fake: true });
  const answer = () => page.evaluate(() => {
    const view = document.querySelector("article.box.sel .replyview");
    return { height: Math.round(view.getBoundingClientRect().height), pad: getComputedStyle(view).paddingTop };
  });
  try {
    await page.waitForSelector(`#box-${a}.sel`, { timeout: 5000 });
    const rest = await answer();
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(450);
    const upA = await answer();
    assert.ok(Math.abs((rest.height - upA.height) - KEYBOARD) <= 2,
      `card A's answer lost ${rest.height - upA.height}, not the keyboard's ${KEYBOARD}`);
    // move to card B while the keyboard is still up, the way a hardware-keyboard
    // hotkey move does, carrying the caret into the next card's row so the
    // keyboard never goes; then close and come back to A
    await page.evaluate(box => select(box), b);
    await page.focus(SEL);
    await settle(450);
    const upB = await answer();
    assert.equal(upB.height, upA.height, "card B came in at its resting height with the keyboard still up");
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(400);
    await page.evaluate(box => select(box), a);
    await settle(200);
    const back = await answer();
    assert.equal(back.height, rest.height, "card A came back short after a switch away while the keyboard was up");
    assert.equal(back.pad, "0px", "card A came back with padding standing over its answer");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- unit 4: the focus locks ---------------------------------------------------------

test("the caret-reveal blink is keyed to whichever field is focused", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  // the blink that keeps the phone from scrolling the page on a focus is keyed to
  // the owned-focus mark, so it covers whichever field is actually focused, the
  // plain textarea or the editor content, and not the textarea alone
  assert.match(source, /\[data-owned-focus\]:focus\{animation:focus-blink/, "the blink is not keyed to the owned-focus mark");
  assert.doesNotMatch(source, /\btextarea:focus\{animation:focus-blink/, "the blink is still keyed to the textarea alone");
});

test("the blink holds the focused field at nothing for the whole of its run", async () => {
  const id = await create("Blink hold on the phone");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.waitForFunction(() => {
      const c = document.querySelector("article.box.sel .cm-content");
      return c && c.hasAttribute("data-owned-focus");
    }, { timeout: 5000 });
    // A blink that rises from nothing is at nothing for an instant only, and a
    // reveal worked out a frame later finds a field partly there and brings it
    // into view. The run is sampled at its own clock rather than in real time,
    // so the reading is the animation's shape and not a race.
    const read = await page.evaluate(() => {
      const content = document.querySelector("article.box.sel .cm-content");
      content.focus();
      const blink = content.getAnimations().find(a => a.animationName === "focus-blink");
      if (!blink) return null;
      blink.pause();
      const at = time => { blink.currentTime = time; return getComputedStyle(content).opacity; };
      return { duration: blink.effect.getTiming().duration, start: at(0), mid: at(10), late: at(19) };
    });
    assert.ok(read, "no blink ran on the focused editor content");
    assert.equal(read.duration, 20, "the blink is not the one-frame run the sheet describes");
    assert.equal(read.start, "0", "the blink does not begin at nothing");
    assert.equal(read.mid, "0", "the blink let the field back partway through its run");
    assert.equal(read.late, "0", "the blink let the field back before its run was out");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("both the plain field and the editor content carry the owned-focus mark", async () => {
  const id = await create("Owned focus on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    // formatting is on by default, so the editor content is the focusable field;
    // it carries the mark once the editor has mounted
    await page.waitForFunction(() => {
      const c = document.querySelector("article.box.sel .cm-content");
      return c && c.hasAttribute("data-owned-focus");
    }, { timeout: 5000 });
    // the plain textarea kept as the model is marked too, so formatting off leaves
    // the focused field covered as well
    assert.equal(await page.evaluate(() =>
      document.querySelector("article.box.sel textarea").hasAttribute("data-owned-focus")), true,
      "the plain field is not marked");
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await settle(150);
    const off = await page.evaluate(() => ({
      marked: document.querySelector("article.box.sel textarea").hasAttribute("data-owned-focus"),
      mirror: !!document.querySelector("article.box.sel .cm-content"),
    }));
    assert.equal(off.marked, true, "the plain field lost its mark when formatting went off");
    assert.equal(off.mirror, false, "the editor content stayed after formatting went off");
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a keystroke while the keyboard is up re-arms the blink on the focused editor content", async () => {
  const id = await create("Blink rearm on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.waitForFunction(() => {
      const c = document.querySelector("article.box.sel .cm-content");
      return c && c.hasAttribute("data-owned-focus");
    }, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(400);
    // the re-arm puts its one-frame opacity blink on the focused editor content,
    // not on the scroller around it, so the reveal has nothing to centre on
    const blinked = await page.evaluate(() => {
      const c = document.querySelector("article.box.sel .cm-content");
      const before = c.getAnimations().length;
      window.blinkRow(document.querySelector("article.box.sel textarea"));
      return c.getAnimations().length > before;
    });
    assert.equal(blinked, true, "the blink did not re-arm on the focused editor content");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- unit 5: no resize loop ----------------------------------------------------------

test("a keyboard cycle over an open sent box drives no resize-observer loop", async () => {
  const id = await create("Resize loop on the phone");
  const paras = [];
  for (let n = 1; n <= 24; n++) paras.push(`Paragraph ${n} of a long answer that scrolls on a phone.`);
  await api(`/reply?box=${id}`, paras.join("\n\n"));
  for (let n = 1; n <= 15; n++) await api(`/send?box=${id}`, `Sent line ${n} in the box that keys its height off the viewport.`);
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true, roWatch: true });
  try {
    await page.waitForSelector(`#box-${id}.sel .pendlist`, { timeout: 5000 });
    // open the sent box so its capped height reads off the viewport height, then
    // start the count clean
    await page.evaluate(() => {
      const pend = document.querySelector("article.box.sel .pendlist");
      if (!pend.classList.contains("open")) pend.click();
    });
    await settle(450);
    await page.focus(SEL);
    await settle(120);
    await page.evaluate(() => { window.__roErrors = 0; });
    // drive the reported height down and back up frame by frame, the way the
    // keyboard's own animation moves it, while the open box's cap and the answer's
    // run-out both read the viewport
    await page.evaluate(async () => {
      const full = window.innerHeight, drop = Math.round(full * 0.42);
      const step = () => new Promise(r => requestAnimationFrame(r));
      for (let f = 1; f <= 14; f++) { window.__keyboard.set(full - Math.round(drop * f / 14), 0); await step(); }
      for (let f = 0; f < 6; f++) await step();
      for (let f = 14; f >= 0; f--) { window.__keyboard.set(full - Math.round(drop * f / 14), 0); await step(); }
      for (let f = 0; f < 6; f++) await step();
    });
    await settle(300);
    const roErrors = await page.evaluate(() => window.__roErrors);
    assert.equal(roErrors, 0, `the keyboard cycle drove ${roErrors} resize-observer loop errors`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
