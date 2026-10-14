// The phone page's compose bar and keyboard, driven headless at an iPhone size
// against its own fixture server. Headless Chrome cannot raise a keyboard, so
// the keyboard is played by a stand-in visual viewport the tests shrink and
// grow themselves (overlay and slid modes), and by the window itself for the
// mode where the window shrinks with the keyboard. What only the phone can
// show is the keyboard's own motion beside the card's; the tests pin what the
// page does with the numbers the phone reports. Screenshots land under
// /tmp/m362-keyboard-shots.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { REST, restAt } = require("./phone-rest-geometry.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = "/tmp/m362-keyboard-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LANDSCAPE = { ...PHONE, width: 844, height: 390, isLandscape: true };
const KEYBOARD = 336;          // an iPhone keyboard with its accessory bar, in css px
const ACCESSORY = 54;          // a small reported obstruction, such as a hardware-keyboard accessory strip
const FOCUS_PAN = 32;          // a visual-viewport offset while the focused row is being revealed
// at rest the page stands in from each screen edge and is laid out at REST of
// full size, so the figures below are the full-size ones carried by that
const WHOLE = 1.01;            // what a figure taken from offsets, which round to whole pixels, can be off by
const AT = restAt(PHONE.width, PHONE.height);
const AT_LANDSCAPE = restAt(LANDSCAPE.width, LANDSCAPE.height);
const INSET = AT.inset;        // --app-inset, the card's thin margin from an edge
// the band the row of buttons stands in, 10 + 48 + 10 and the step in, which is
// the band iOS 26 gives a paired keyboard's bar: the card's foot stands on it at
// rest, and an obstruction no taller than it moves nothing but the row's fade
const BAND = AT.band;
const BAND_LANDSCAPE = AT_LANDSCAPE.band;
const HEAD = AT.stepY + AT.inset;   // the card's top edge at the visible top: the step in and the thin margin
const STRIP = 90;              // an obstruction taller than the band and short of a keyboard
const LIFT = KEYBOARD + INSET - BAND;   // how far the keyboard lifts the card's foot off the band
const DOCK_FOOT = AT.dockFoot; // the row's foot off the screen's bottom edge
const OPEN_LINES = 5;          // the row's cap under the keyboard, in lines
const ROW_FLOOR = 44 * REST;   // an empty row's height
const CLOSED_SHARE = 0.28;    // the row's cap with the keyboard down: this share of the viewport's height
const SEL = "article.box.sel textarea";

let browser;
let child;
let fixtureDir;
let origin;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

// the stand-in visual viewport: the page reads window.visualViewport, and this
// puts an object the test moves in its place before the page's scripts run.
// set(height, offsetTop) is one keyboard report: a resize and a scroll event
// on the new numbers, the way the phone reports its keyboard
function fakeViewport() {
  const vv = new EventTarget();
  // the window's own size until the test moves it: read live, since the
  // phone emulation lands after the document is made
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height;
      geom.offsetTop = offsetTop;
      geom.scale = scale;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
}

async function openPhone(route, { fake = false, viewport = PHONE, reducedMotion = false } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(viewport);
  if (reducedMotion) {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  }
  if (fake) await page.evaluateOnNewDocument(fakeViewport);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// a length at rest is fractional; layout keeps sixty-fourths of a pixel, and the
// laid-out figures come from offsets, which are whole pixels
function near(actual, expected, message, tolerance = 0.1) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} (${actual}, not ${expected})`);
}

// the row as the page lays it out. the tests type short lines, so a line of
// text is a line of the row, the caret's line is a count of returns, and the
// text's true height is a count of lines; the box is its rectangle, since the
// cap can be a fraction of a pixel that clientHeight rounds away
function rowShape() {
  const ta = document.querySelector("article.box.sel textarea");
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight), pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const rect = ta.getBoundingClientRect();
  const lines = ta.value.split("\n").length;
  const caretLine = ta.value.slice(0, ta.selectionEnd).split("\n").length;
  const content = lines * lh + pt + pb;
  return {
    lh, pt, pb,
    box: rect.height, top: rect.top, bottom: rect.bottom, cap: cs.maxHeight,
    sh: ta.scrollHeight, ch: ta.clientHeight, st: ta.scrollTop,
    maxScroll: ta.scrollHeight - ta.clientHeight,
    lines, content,
    leftBelow: content - ta.scrollTop - rect.height,
    caretLine,
    caretTop: pt + (caretLine - 1) * lh - ta.scrollTop,
    caretBottom: pt + caretLine * lh - ta.scrollTop,
    // the row answers to two shapes, the plain field and the editor the
    // typed-formatting setting puts in its place; both are this row
    focused: !!document.activeElement && document.activeElement !== document.body &&
      document.activeElement.closest(".compose") === ta.closest(".compose"),
    selectionEnd: ta.selectionEnd,
  };
}

function caretInside(s) {
  return s.caretTop >= -0.5 && s.caretBottom <= s.box + 0.5;
}

// where the card's foot, its top edge, the title and the row of buttons
// stand, in the visual viewport's own coordinates, plus the page's keyboard
// state and the row's own: faded out, and how far it was moved while out
function shellShape() {
  const vvTop = window.visualViewport.offsetTop;
  const paneEl = document.getElementById("pane");
  const pageEl = document.getElementById("page");
  const pane = paneEl.getBoundingClientRect();
  const dockEl = document.getElementById("dock");
  const title = document.querySelector("article.box.sel .title").getBoundingClientRect();
  const ta = document.querySelector("article.box.sel textarea").getBoundingClientRect();
  const body = document.body;
  return {
    foot: pane.bottom - vvTop, head: pane.top - vvTop, title: title.top - vvTop,
    dock: dockEl.getBoundingClientRect().bottom - vvTop,
    // the page writes the rise only once it has moved the row, so none is 0px
    away: dockEl.classList.contains("away"), rise: dockEl.style.getPropertyValue("--dock-rise") || "0px",
    // the card's own two edges as they are laid out, which a menu's depth cannot
    // touch: the measured foot above is the picture, and the page's picture draws
    // back towards the middle of the screen while a menu is out. the head is the
    // edge nothing may move; the foot is the edge the keyboard's room comes out of
    footLaidOut: pageEl.offsetTop + paneEl.offsetTop + paneEl.offsetHeight,
    headLaidOut: pageEl.offsetTop + paneEl.offsetTop,
    answer: Math.round(document.querySelector("article.box.sel .replyview").getBoundingClientRect().height),
    row: ta.height, rowBottom: ta.bottom - vvTop,
    bodyTop: body.getBoundingClientRect().top, bodyHeight: body.getBoundingClientRect().height,
    kb: body.classList.contains("kb"), obstructed: body.classList.contains("obstructed"),
    lifting: body.classList.contains("lifting"),
    inset: document.getElementById("page").style.getPropertyValue("--kb-inset"),   // the clearance is the page's own
    shellTop: body.style.getPropertyValue("--shell-top"), shellH: body.style.getPropertyValue("--shell-h"),
    vvh: document.documentElement.style.getPropertyValue("--vvh"),
  };
}

// a frame by frame record while the keyboard moves; the reader is handed over
// as source, since the page has no sight of this file
async function startSampling(page, reader = shellShape) {
  await page.evaluate(src => {
    const read = new Function("return (" + src + ")")();
    window.__samples = [];
    window.__sampling = true;
    const step = () => {
      if (!window.__sampling) return;
      window.__samples.push(read());
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, reader.toString());
}

// the motion in one direction only: nothing moves down then up, or up then down
function assertOneWay(values, direction, what) {
  for (let i = 1; i < values.length; i++) {
    const step = values[i] - values[i - 1];
    if (direction === "up") assert.ok(step <= 0.5, `${what} moved down at frame ${i}: ${values[i - 1]} -> ${values[i]}`);
    else assert.ok(step >= -0.5, `${what} moved up at frame ${i}: ${values[i - 1]} -> ${values[i]}`);
  }
}

function assertStill(values, what) {
  for (let i = 1; i < values.length; i++) {
    assert.ok(Math.abs(values[i] - values[0]) <= 0.5, `${what} moved at frame ${i}: ${values[0]} -> ${values[i]}`);
  }
}

// the new lines are made with shift and return: with no on-screen keyboard the
// row reads a plain return as the send, the way the desktop composer does
async function typeLines(page, count, from = 1) {
  for (let n = from; n <= count; n++) {
    if (n > 1) {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    }
    await page.keyboard.type(`line ${n}`);
  }
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-keyboard-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone keyboard test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: process.env.FACILITATOR_LOG_DIR || path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the row grows to its text exactly, one to twelve lines, the caret's line inside the box every time", async () => {
  const id = await create("Row growth on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    // the focusing tap on the empty row: taken over by the page, the caret at
    // its one position, the row focused inside the tap
    const box = await page.$(SEL);
    const rect = await box.boundingBox();
    await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await settle(100);
    const focused = await page.evaluate(rowShape);
    assert.equal(focused.focused, true, "the tap did not focus the row");
    assert.equal(focused.selectionEnd, 0);
    near(focused.box, ROW_FLOOR, "an empty row is not the row's floor");

    const closedCap = CLOSED_SHARE * PHONE.height * REST;   // the cap as it was: 28vh, about nine lines, at the page's size
    for (let n = 1; n <= 12; n++) {
      await typeLines(page, n, n);
      await settle(60);
      const s = await page.evaluate(rowShape);
      assert.equal(s.lines, n);
      assert.equal(s.caretLine, n);
      const wanted = Math.max(ROW_FLOOR, Math.min(Math.ceil(s.content), closedCap));
      assert.ok(Math.abs(s.box - wanted) <= 0.1, `at ${n} lines the row is ${s.box}, not ${wanted}`);
      if (s.content <= closedCap) {
        assert.ok(s.sh <= s.ch, `at ${n} lines the row still scrolls: content ${s.sh} in a box of ${s.ch}`);
        assert.equal(s.st, 0);
      } else {
        assert.ok(s.maxScroll > 0, `at ${n} lines the row does not scroll inside`);
        assert.ok(s.leftBelow <= 0.5, `at ${n} lines there is ${s.leftBelow}px left to scroll below the caret`);
      }
      assert.ok(caretInside(s), `at ${n} lines the caret's line (${s.caretTop} to ${s.caretBottom}) is not inside the box of ${s.box}`);
      if ([1, 3, 6, 12].includes(n)) await page.screenshot({ path: path.join(SHOTS, `composer-${String(n).padStart(2, "0")}.png`) });
    }
    // the last lines, deleted back: the row shrinks with the text and never scrolls
    for (let n = 12; n > OPEN_LINES; n--) {
      for (let k = 0; k < `line ${n}`.length + 1; k++) await page.keyboard.press("Backspace");
    }
    await settle(60);
    const back = await page.evaluate(rowShape);
    assert.equal(back.lines, OPEN_LINES);
    assert.equal(back.box, Math.ceil(OPEN_LINES * back.lh + back.pt + back.pb));
    assert.ok(back.sh <= back.ch, "the shrunken row is left scrolling");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the composer rises over the keyboard on its own curve while the card's top stands still (overlay mode)", async () => {
  const id = await create("Keyboard overlay on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await typeLines(page, 3);
    await settle(100);
    const rest = await page.evaluate(shellShape);
    near(rest.foot, PHONE.height - BAND, "at rest the card foot does not stand on the row's band");
    near(rest.dock, PHONE.height - DOCK_FOOT, "the row of buttons is not 10px off the bottom edge, less the page's step in");
    assert.equal(rest.away, true, "the row of buttons stayed in sight with the composer focused on a touch screen");
    assert.equal(rest.rise, "0px", "the row was moved with nothing over it");
    assert.equal(rest.kb, false);

    // the open: the phone reports the shorter viewport once the keyboard starts
    await startSampling(page);
    await page.evaluate(k => window.__keyboard.set(k.height, 0), { height: PHONE.height - KEYBOARD });
    await settle(600);
    await page.evaluate(() => { window.__sampling = false; });
    const open = await page.evaluate(() => window.__samples);
    const up = await page.evaluate(shellShape);
    assert.equal(up.kb, true, "the shrunken viewport with the row focused is not read as the keyboard");
    assert.equal(up.inset, `${KEYBOARD}px`);
    // the card's room comes out of its own foot: the laid-out foot is up by the
    // keyboard, the laid-out top is exactly where it was, and the shell keeps its
    // full height, so no box of the page itself resizes at a keyboard edge
    near(up.footLaidOut, PHONE.height - INSET - KEYBOARD, "the card's foot did not take the keyboard's room", WHOLE);
    near(up.headLaidOut, rest.headLaidOut, "the card's top edge moved at the keyboard edge", WHOLE);
    near(rest.answer - up.answer, LIFT, "the answer did not shorten by the keyboard's room beyond the band", WHOLE);
    assert.ok(Math.abs((rest.foot - up.foot) - LIFT) <= 2,
      `the card's foot rose ${rest.foot - up.foot}, not the keyboard's ${KEYBOARD} less the band`);
    assert.equal(up.bodyHeight, PHONE.height, "the box did not keep its full-screen height");
    assert.equal(up.shellH, `${PHONE.height}px`);
    assert.equal(up.row, rest.row, "the row changed size at the keyboard edge");
    // the composer alone rises, by the keyboard's inset, to a thin gap above its edge
    assert.ok(up.rowBottom <= PHONE.height - KEYBOARD,
      `the composer's foot (${up.rowBottom}) is not above the keyboard's edge (${PHONE.height - KEYBOARD})`);
    assert.ok(up.rowBottom >= PHONE.height - KEYBOARD - INSET - 2,
      `the composer's foot (${up.rowBottom}) is more than the thin gap above the keyboard`);
    assert.ok(Math.abs((rest.rowBottom - up.rowBottom) - LIFT) <= 2,
      `the composer rose ${rest.rowBottom - up.rowBottom}, not the keyboard's ${KEYBOARD} less the band`);
    // the row of buttons: out of sight, and moved while out of sight into the
    // band the keyboard's own toolbar takes on top of it, so it lies under the
    // toolbar and not under the keyboard
    assert.equal(up.away, true, "the row of buttons is in sight over the keyboard");
    near(parseFloat(up.rise), KEYBOARD - BAND, "the row was not laid in the keyboard's toolbar band", WHOLE);
    near(up.dock, PHONE.height - KEYBOARD + BAND - DOCK_FOOT, "the row's foot is not in the toolbar's band", WHOLE);
    assert.ok(open.length >= 8, `too few frames sampled (${open.length})`);
    // the motion is the card's foot and the composer standing on it, one way and
    // together; the card's top edge and the title hold on every frame, and the
    // row of buttons is out of sight on every one of them
    assertOneWay(open.map(s => s.rowBottom), "up", "the composer");
    assertOneWay(open.map(s => s.foot), "up", "the card foot");
    assertStill(open.map(s => s.title), "the title");
    assertStill(open.map(s => s.head), "the card's top edge");
    assertStill(open.map(s => s.row), "the row's height");
    assert.ok(open.every(s => s.away), "the row of buttons came back into sight while the keyboard rose");
    const between = open.filter(s => s.rowBottom < rest.rowBottom - 1 && s.rowBottom > up.rowBottom + 1).length;
    assert.ok(between >= 3, `the composer jumped instead of gliding: ${between} frames between the two edges`);
    assert.ok(Math.min(...open.map(s => s.rowBottom)) >= up.rowBottom - 0.5, "the composer overshot the keyboard's edge");
    await page.screenshot({ path: path.join(SHOTS, "keyboard-overlay-up.png") });

    // the close: focus leaves first, the viewport reports whole a little later
    await startSampling(page);
    await page.evaluate(() => document.activeElement.blur());
    await settle(40);
    const justClosed = await page.evaluate(shellShape);
    assert.equal(justClosed.kb, false, "the close did not start at the focus loss");
    assert.equal(justClosed.lifting, true, "the box was not held through the close");
    assert.equal(justClosed.shellH, `${PHONE.height}px`, "the box was dropped before the keyboard was gone");
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(700);
    await page.evaluate(() => { window.__sampling = false; });
    const close = await page.evaluate(() => window.__samples);
    const down = await page.evaluate(shellShape);
    near(down.foot, PHONE.height - BAND, "after the close the card foot does not stand on the row's band");
    assert.ok(Math.abs(down.rowBottom - rest.rowBottom) <= 1, "the composer did not return to rest after the close");
    assert.equal(down.kb, false);
    assert.equal(down.lifting, false, "the settle window did not close");
    assert.equal(down.shellTop, "", "the box's top was not dropped after the close");
    assert.equal(down.shellH, "", "the box's height was not dropped after the close");
    assert.equal(down.bodyHeight, PHONE.height);
    // the row of buttons back down in its own band and back in sight once the
    // keyboard has gone, and never moved while it could be seen
    assert.equal(down.away, false, "the row of buttons did not come back after the close");
    assert.equal(down.rise, "0px");
    near(down.dock, PHONE.height - DOCK_FOOT, "the row of buttons did not return to its own foot");
    assert.ok(close.every(s => s.away || s.rise === "0px"), "the row of buttons was seen away from its band");
    assertOneWay(close.map(s => s.rowBottom), "down", "the composer");
    assertOneWay(close.map(s => s.foot), "down", "the card foot");
    assertStill(close.map(s => s.title), "the title");
    assertStill(close.map(s => s.head), "the card's top edge");
    assertStill(close.map(s => s.row), "the row's height");
    assert.ok(Math.max(...close.map(s => s.rowBottom)) <= down.rowBottom + 0.5, "the composer overshot the rest edge");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a paired keyboard's bar no taller than the row's band leaves the card where it is, and the row of buttons fades under it", async () => {
  const id = await create("Keyboard accessory on the phone");
  const paragraphs = Array.from({ length: 24 }, (_, n) =>
    `Paragraph ${n + 1} gives the reading pane enough room to hold a stable scroll position.`).join("\n\n");
  await api(`/reply?box=${id}`, paragraphs);
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const replyAt = await page.evaluate(() => {
      const reply = document.querySelector("article.box.sel .replyview");
      reply.scrollTop = 180;
      return reply.scrollTop;
    });
    assert.ok(replyAt > 100, "the reading fixture did not take a scroll position");
    await page.focus(SEL);
    await typeLines(page, 3);
    await page.evaluate(() => {
      const ta = document.querySelector("article.box.sel textarea");
      ta.setSelectionRange(2, 8);
    });
    await settle(100);
    const rest = await page.evaluate(shellShape);
    const held = await page.evaluate(() => {
      const ta = document.querySelector("article.box.sel textarea");
      return { draft: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    });

    await startSampling(page);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - ACCESSORY);
    await settle(600);
    await page.evaluate(() => { window.__sampling = false; });
    const frames = await page.evaluate(() => window.__samples);
    const up = await page.evaluate(shellShape);
    await page.screenshot({
      path: path.join(SHOTS, "keyboard-accessory-up.png"),
      clip: { x: 0, y: 0, width: PHONE.width, height: PHONE.height - ACCESSORY },
    });
    assert.equal(up.obstructed, true, "the focused accessory-sized viewport loss was ignored");
    assert.equal(up.kb, false, "the accessory strip was mistaken for a full soft keyboard");
    assert.equal(up.inset, `${ACCESSORY}px`, "the card did not use the measured obstruction");
    // the strip takes the row's own band: the card's foot and the composer stay
    // exactly where they were, and the row of buttons is out of sight, unmoved
    near(rest.footLaidOut, PHONE.height - BAND, "at rest the card's foot does not stand on the row's band", WHOLE);
    assert.equal(up.footLaidOut, rest.footLaidOut, "the card's foot moved for a strip inside the row's band");
    assert.equal(up.rowBottom, rest.rowBottom, "the composer moved for a strip inside the row's band");
    assert.equal(up.headLaidOut, rest.headLaidOut, "the card's top edge moved at the accessory edge");
    assert.equal(up.head, rest.head, "the card's top edge moved under the strip");
    assert.equal(up.title, rest.title, "the card title moved under the accessory strip");
    assert.equal(up.row, rest.row, "the hardware-keyboard composer took the soft-keyboard cap");
    assert.equal(up.away, true, "the row of buttons stayed in sight under the strip");
    assert.equal(up.rise, "0px", "the row of buttons was moved out of the band the strip covers");
    assert.ok(frames.length >= 8, `too few accessory frames sampled (${frames.length})`);
    assertStill(frames.map(s => s.rowBottom), "the accessory composer");
    assertStill(frames.map(s => s.foot), "the accessory card foot");
    assertStill(frames.map(s => s.title), "the accessory card title");
    assertStill(frames.map(s => s.head), "the card's top edge under the strip");

    await page.evaluate(v => window.__keyboard.set(v.height, v.top), {
      height: PHONE.height - ACCESSORY, top: FOCUS_PAN,
    });
    await settle(80);
    const panned = await page.evaluate(shellShape);
    assert.equal(panned.bodyTop, FOCUS_PAN, "the shell did not follow the focused viewport pan");
    assert.equal(panned.head, rest.head, "the focused viewport pan clipped the card's top edge");
    // the card stands still under the strip; the pan must not move it either
    assert.equal(panned.title, up.title, "the focused viewport pan moved the card title");
    assert.equal(panned.foot, up.foot, "the focused viewport pan changed the measured bottom clearance");

    // the card list is pulled over the page. a menu coming out lets go of
    // whatever is being typed in, which is what puts a keyboard away, so the
    // strip measured off a focused row is no longer something to keep clear of:
    // the page hands that room back and says so. the list does not draw the page
    // back: the card goes down and the page keeps its size
    await page.evaluate(() => openDrawer());
    await settle(750);
    assert.equal(await page.evaluate(() => drawerOpen()), true, "the card drawer did not open over the adjusted page");
    assert.equal(await page.evaluate(() => editing()), false,
      "the open drawer left the row holding the caret, so a keyboard would still stand under it");
    const behind = await page.evaluate(shellShape);
    assert.equal(behind.obstructed, false, "the page kept clear of a strip nothing holds up any more");
    assert.equal(behind.inset, "0px", "the accessory inset stayed on with nothing focused");
    const size = await page.evaluate(() => new DOMMatrix(getComputedStyle(document.getElementById("page")).transform).a);
    near(size, 1, "the open list drew the page back, which only the settings do", 0.0005);

    // the strip goes with the focus on a phone, so the viewport reports itself
    // whole again, and the card keeps the room whether the menu is out or not
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(700);
    await page.evaluate(() => closeDrawer());
    await settle(750);
    const down = await page.evaluate(shellShape);
    const preserved = await page.evaluate(() => {
      const ta = document.querySelector("article.box.sel textarea");
      const reply = document.querySelector("article.box.sel .replyview");
      return {
        draft: ta.value, start: ta.selectionStart, end: ta.selectionEnd,
        replyAt: reply.scrollTop,
      };
    });
    assert.equal(down.obstructed, false);
    assert.equal(down.kb, false);
    near(down.foot, PHONE.height - BAND, "the card foot did not stay on the band after accessory dismissal");
    assert.equal(down.head, rest.head);
    assert.equal(down.title, rest.title);
    assert.equal(down.away, false, "the row of buttons did not come back after the strip went");
    assert.deepEqual({ draft: preserved.draft, start: preserved.start, end: preserved.end }, held,
      "the accessory adjustment changed the draft or its selection");
    assert.ok(Math.abs(preserved.replyAt - replyAt) <= 0.5,
      `the reading position moved from ${replyAt} to ${preserved.replyAt}`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the row of buttons comes back about 220 ms after a paired keyboard's bar has gone, not after the lift's whole settle", async () => {
  const id = await create("Row return on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    // the milliseconds from the viewport reporting itself whole to the row being in sight
    const back = async lost => {
      await page.focus(SEL);
      await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - lost);
      await settle(700);
      await page.evaluate(height => {
        window.__back = null;
        document.activeElement.blur();
        setTimeout(() => {
          const t0 = performance.now();
          window.__keyboard.set(height, 0);
          const look = () => {
            if (!document.getElementById("dock").classList.contains("away")) window.__back = performance.now() - t0;
            else requestAnimationFrame(look);
          };
          requestAnimationFrame(look);
        }, 40);
      }, PHONE.height);
      await page.waitForFunction(() => window.__back !== null, { timeout: 3000 });
      const ms = await page.evaluate(() => window.__back);
      await settle(700);
      return ms;
    };
    const bar = await back(ACCESSORY);
    assert.ok(bar >= 180 && bar <= 340, `the row came back ${Math.round(bar)} ms after the bar's viewport was whole`);
    const keyboard = await back(KEYBOARD);
    assert.ok(keyboard >= 180 && keyboard <= 340, `the row came back ${Math.round(keyboard)} ms after the keyboard's viewport was whole`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a viewport the phone slides under the keyboard: the box follows its top, the card's top stays at the visible top, and the box stands until the slide is undone", async () => {
  const id = await create("Keyboard slide on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const rest = await page.evaluate(shellShape);
    await page.focus(SEL);
    await page.evaluate(k => window.__keyboard.set(k.height, k.top), { height: PHONE.height - KEYBOARD, top: KEYBOARD });
    await settle(600);
    const up = await page.evaluate(shellShape);
    assert.equal(up.kb, true);
    assert.equal(up.bodyTop, KEYBOARD, "the box's top did not follow the slid viewport");
    assert.equal(up.bodyHeight, PHONE.height);
    near(up.head, HEAD, "the card's top edge is not at the visible top");
    near(up.footLaidOut, PHONE.height - INSET - KEYBOARD, "the card's foot did not take the keyboard's room in slide mode", WHOLE);
    near(up.headLaidOut, rest.headLaidOut, "the card's top edge moved in slide mode", WHOLE);
    assert.ok(up.rowBottom <= PHONE.height - KEYBOARD && up.rowBottom >= PHONE.height - KEYBOARD - INSET - 2,
      `the composer (${up.rowBottom}) is not just above the slid keyboard edge (${PHONE.height - KEYBOARD})`);
    // the row of buttons rides the box down the slide too: out of sight, in the
    // band the keyboard's toolbar takes in the visible picture
    assert.equal(up.away, true);
    near(up.dock, PHONE.height - KEYBOARD + BAND - DOCK_FOOT, "the slid row is not in the toolbar's band", WHOLE);

    await page.evaluate(() => document.activeElement.blur());
    await settle(400);   // the transition is over, the viewport still slid
    const held = await page.evaluate(shellShape);
    assert.equal(held.kb, false);
    assert.equal(held.bodyTop, KEYBOARD, "the box's top was dropped while the viewport was still slid");
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(100);
    const back = await page.evaluate(shellShape);
    assert.equal(back.bodyTop, 0);
    near(back.head, HEAD, "the card's top edge did not return to rest");
    near(back.foot, PHONE.height - BAND, "the card's foot did not return to the band");
    await settle(200);
    assert.equal((await page.evaluate(shellShape)).lifting, false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a focused shortfall inside the row's band moves nothing, one beyond it seats the foot at its edge, and an unfocused shrink is never trusted", async () => {
  const id = await create("Keyboard lies on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - 24);
    await settle(300);
    const small = await page.evaluate(shellShape);
    assert.equal(small.obstructed, true, "a focused 24px viewport loss was ignored");
    assert.equal(small.kb, false, "a focused 24px loss was mistaken for a full soft keyboard");
    assert.equal(small.inset, "24px");
    near(small.footLaidOut, PHONE.height - BAND, "the card's foot moved for a loss inside the row's band", WHOLE);
    assert.equal(small.away, true, "the row of buttons stayed in sight under the small obstruction");
    assert.equal(small.rise, "0px");
    // taller than the band and short of a keyboard: the foot stands on its
    // measured edge, with no gap, as it stands on the band, and the row is
    // moved, out of sight, up to that edge
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - STRIP);
    await settle(300);
    const strip = await page.evaluate(shellShape);
    assert.equal(strip.kb, false, `a focused ${STRIP}px loss was mistaken for a full soft keyboard`);
    assert.equal(strip.inset, `${STRIP}px`);
    near(strip.footLaidOut, PHONE.height - STRIP, "the card's foot did not take the room beyond the band", WHOLE);
    assert.ok(strip.rowBottom <= PHONE.height - STRIP && strip.rowBottom >= PHONE.height - STRIP - INSET - 2,
      `the composer (${strip.rowBottom}) is not just above the measured obstruction (${PHONE.height - STRIP})`);
    near(parseFloat(strip.rise), STRIP - BAND, "the row of buttons was not moved with the obstruction's edge", WHOLE);
    await page.evaluate(() => document.activeElement.blur());
    await settle(50);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await settle(300);
    const unfocused = await page.evaluate(shellShape);
    assert.equal(unfocused.obstructed, false, "a shrink with nothing focused adjusted the card");
    assert.equal(unfocused.kb, false, "a shrink with nothing focused was read as a keyboard");
    near(unfocused.foot, PHONE.height - BAND, "a shrink with nothing focused moved the card's foot");
    // the shrunken viewport with nothing focused does not become the baseline
    await page.focus(SEL);
    await settle(50);
    const focused = await page.evaluate(shellShape);
    assert.equal(focused.obstructed, true, "the full-screen height was forgotten under the stale shrink");
    assert.equal(focused.kb, true, "the full viewport loss was not classified as the soft keyboard");
    await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(600);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("landscape relearns its clear height and reduced motion applies the measured clearance directly", async () => {
  const id = await create("Reduced landscape keyboard on the phone");
  await api(`/reply?box=${id}`, "A reply to answer in either orientation.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true, reducedMotion: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    near((await page.evaluate(shellShape)).foot, PHONE.height - BAND, "the card's foot is not on the band at the start");

    await page.setViewport(LANDSCAPE);
    await settle(80);
    const rest = await page.evaluate(shellShape);
    near(rest.foot, LANDSCAPE.height - BAND_LANDSCAPE, "the card did not relearn the landscape height");

    await page.focus(SEL);
    await page.keyboard.type("landscape draft");
    await page.evaluate(h => window.__keyboard.set(h, 0), LANDSCAPE.height - STRIP);
    await settle(40);
    const up = {
      ...await page.evaluate(shellShape),
      ...await page.evaluate(() => ({
        transition: getComputedStyle(document.getElementById("pane")).transitionDuration,
        draft: document.querySelector("article.box.sel textarea").value,
      })),
    };
    await page.screenshot({
      path: path.join(SHOTS, "keyboard-accessory-landscape-reduced.png"),
      clip: { x: 0, y: 0, width: LANDSCAPE.width, height: LANDSCAPE.height - STRIP },
    });
    assert.equal(up.obstructed, true);
    assert.equal(up.kb, false);
    assert.equal(up.inset, `${STRIP}px`);
    near(up.footLaidOut, LANDSCAPE.height - STRIP,
      "the landscape card's foot did not take the strip's room beyond the band", WHOLE);
    assert.ok(Math.abs((rest.rowBottom - up.rowBottom) - (STRIP - BAND_LANDSCAPE)) <= 2,
      `the landscape composer rose ${rest.rowBottom - up.rowBottom}, not the strip's ${STRIP} less the band`);
    assert.equal(up.head, rest.head, "the landscape card's top edge moved under the strip");
    assert.equal(up.title, rest.title, "the landscape card title moved under the strip");
    assert.equal(up.bodyHeight, LANDSCAPE.height);
    assert.equal(up.transition, "0s", "reduced motion left the lift transition running");
    assert.equal(up.draft, "landscape draft");

    await page.evaluate(h => window.__keyboard.set(h, 0), LANDSCAPE.height);
    await settle(40);
    const restored = {
      ...await page.evaluate(shellShape),
      draft: await page.$eval(SEL, ta => ta.value),
    };
    assert.equal(restored.obstructed, false);
    near(restored.foot, LANDSCAPE.height - BAND_LANDSCAPE, "the landscape card's foot did not return to the band");
    assert.equal(restored.head, rest.head);
    assert.equal(restored.title, rest.title);
    assert.equal(restored.draft, "landscape draft");
    await page.evaluate(() => document.activeElement.blur());
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("page zoom is not classified as an obstruction and does not pollute the clear-height baseline", async () => {
  const id = await create("Page zoom on the phone");
  await api(`/reply?box=${id}`, "A reply to read while zoomed.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });

    // A zoomed-out visual viewport can be taller than the layout viewport. It
    // must not inflate the learned clear height and leave a false obstruction
    // after scale 1 returns.
    await page.evaluate(v => window.__keyboard.set(v.height, 0, v.scale), {
      height: PHONE.height / 0.8, scale: 0.8,
    });
    await settle(80);
    await page.evaluate(h => window.__keyboard.set(h, 0, 1), PHONE.height);
    await settle(80);
    await page.focus(SEL);
    const portraitRest = await page.evaluate(shellShape);
    assert.equal(portraitRest.obstructed, false, "a prior zoom-out inflated the clear-height baseline");
    assert.equal(portraitRest.kb, false);
    assert.equal(portraitRest.inset, "");
    near(portraitRest.foot, PHONE.height - BAND, "the card's foot is off the band after a zoom-out");
    await page.evaluate(() => document.activeElement.blur());

    // Rotation clears the baseline. If it happens while page zoom is active,
    // the zoomed visual height still must not become the new clear height.
    await page.evaluate(v => window.__keyboard.set(v.height, 0, v.scale), {
      height: LANDSCAPE.height / 0.8, scale: 0.8,
    });
    await page.setViewport(LANDSCAPE);
    await settle(80);
    await page.evaluate(h => window.__keyboard.set(h, 0, 1), LANDSCAPE.height);
    await settle(80);
    await page.focus(SEL);
    const rest = await page.evaluate(shellShape);
    assert.equal(rest.obstructed, false, "zoom during rotation became the landscape baseline");
    assert.equal(rest.kb, false);
    assert.equal(rest.inset, "");
    near(rest.foot, LANDSCAPE.height - BAND_LANDSCAPE, "the landscape card's foot is off the band after a zoom-out");

    await page.evaluate(v => window.__keyboard.set(v.height, v.top, v.scale), {
      height: LANDSCAPE.height / 1.2, top: 20, scale: 1.2,
    });
    await settle(80);
    const zoomed = await page.evaluate(shellShape);
    assert.equal(zoomed.obstructed, false, "page zoom was mistaken for a bottom obstruction");
    assert.equal(zoomed.kb, false, "page zoom was mistaken for a soft keyboard");
    assert.equal(zoomed.inset, "", "page zoom changed the card's bottom clearance");
    assert.equal(zoomed.shellTop, "", "page zoom made the app take over viewport panning");

    await page.evaluate(h => window.__keyboard.set(h, 0, 1), LANDSCAPE.height);
    await settle(80);
    const restored = await page.evaluate(shellShape);
    near(restored.foot, rest.foot, "the card's foot did not come back after the zoom");
    near(restored.head, rest.head, "the card's top edge did not come back after the zoom");
    near(restored.title, rest.title, "the card title did not come back after the zoom");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("focus brings the caret's line into view, a tapped line is where the caret is, and the row keeps that line when it shrinks at the keyboard edge", async () => {
  const id = await create("Caret line on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await typeLines(page, 12);
    await settle(60);
    const typed = await page.evaluate(rowShape);
    assert.equal(typed.caretLine, 12);
    assert.ok(Math.abs(typed.st - typed.maxScroll) <= 0.5);

    // the keyboard closed, the row scrolled up by hand, the caret on the last
    // line out of view; a focus without a tap brings that line back
    await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.blur(); ta.scrollTop = 0; });
    await settle(50);
    assert.equal((await page.evaluate(rowShape)).st, 0);
    await page.focus(SEL);
    await settle(80);
    const refocused = await page.evaluate(rowShape);
    assert.equal(refocused.caretLine, 12);
    assert.ok(Math.abs(refocused.st - refocused.maxScroll) <= 0.5, `focus left the caret's line out of view (scroll ${refocused.st} of ${refocused.maxScroll})`);
    assert.ok(caretInside(refocused));

    // a tap on the third line, with the row scrolled to its top: the caret
    // lands on that line and the row does not move under the finger
    await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.blur(); ta.scrollTop = 0; });
    await settle(50);
    const before = await page.evaluate(rowShape);
    const box = await page.$(SEL);
    const rect = await box.boundingBox();
    await page.touchscreen.tap(rect.x + 30, before.top + before.pt + 2.5 * before.lh);
    await settle(120);
    const tapped = await page.evaluate(rowShape);
    assert.equal(tapped.focused, true);
    assert.equal(tapped.caretLine, 3, `the tap put the caret on line ${tapped.caretLine}, not the third`);
    assert.equal(tapped.st, 0, "the row scrolled under the tap");
    assert.ok(caretInside(tapped));

    // the keyboard rises and the row shrinks to its five lines: the tapped
    // line is still the line in view when the keyboard has landed
    await page.evaluate(k => window.__keyboard.set(k.height, 0), { height: PHONE.height - KEYBOARD });
    await settle(600);
    const landed = await page.evaluate(rowShape);
    assert.ok(Math.abs(landed.box - (OPEN_LINES * landed.lh + landed.pt + landed.pb)) <= 0.1, `the row is ${landed.box} under the keyboard, not five lines`);
    assert.equal(landed.st, 0, "the row scrolled away from the tapped line at the keyboard edge");
    assert.equal(landed.caretLine, 3);
    assert.ok(caretInside(landed));
    assert.equal((await page.evaluate(shellShape)).kb, true);

    // the caret on the last line, scrolled out of view by hand before the
    // keyboard lands: the landing brings it back
    await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.blur(); });
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(700);
    await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.setSelectionRange(ta.value.length, ta.value.length); });
    await page.focus(SEL);
    await settle(80);
    await page.evaluate(() => { document.querySelector("article.box.sel textarea").scrollTop = 0; });
    await page.evaluate(k => window.__keyboard.set(k.height, 0), { height: PHONE.height - KEYBOARD });
    await settle(600);
    const relanded = await page.evaluate(rowShape);
    assert.equal(relanded.caretLine, 12);
    assert.ok(Math.abs(relanded.st - relanded.maxScroll) <= 0.5, `the landing left the caret's line out of view (scroll ${relanded.st} of ${relanded.maxScroll})`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the row's cap is the desktop's share of the height with the keyboard down, five lines under it, and the caret's line stays in view on every frame of the rise", async () => {
  const id = await create("Row cap on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await typeLines(page, 12);
    await settle(60);
    const closed = await page.evaluate(rowShape);
    const closedCap = CLOSED_SHARE * PHONE.height * REST;
    assert.ok(Math.abs(parseFloat(closed.cap) - closedCap) <= 0.01, `the cap with the keyboard down is ${closed.cap}, not the ${closedCap}px share of the viewport it was`);
    assert.ok(Math.abs(closed.box - closedCap) <= 0.1, `the row is ${closed.box} with the keyboard down, not ${closedCap}`);
    assert.equal(closed.caretLine, 12);
    assert.ok(caretInside(closed));
    assert.ok(closed.leftBelow <= 0.5, `${closed.leftBelow}px left below the caret with the keyboard down`);

    await startSampling(page, rowShape);
    await page.evaluate(k => window.__keyboard.set(k.height, 0), { height: PHONE.height - KEYBOARD });
    await settle(600);
    await page.evaluate(() => { window.__sampling = false; });
    const frames = await page.evaluate(() => window.__samples);
    assert.ok(frames.length >= 8, `too few frames sampled (${frames.length})`);
    frames.forEach((f, i) => {
      assert.ok(caretInside(f), `frame ${i}: the caret's line (${f.caretTop} to ${f.caretBottom}) left the box of ${f.box}`);
    });
    const open = await page.evaluate(rowShape);
    const openCap = OPEN_LINES * open.lh + open.pt + open.pb;
    assert.ok(Math.abs(open.box - openCap) <= 0.1, `the row is ${open.box} under the keyboard, not ${openCap}`);
    assert.equal(open.caretLine, 12);
    assert.ok(caretInside(open));
    assert.ok(open.leftBelow <= 0.5, `${open.leftBelow}px left below the caret under the keyboard`);
    assert.ok(open.box < closed.box, "the row did not shrink under the keyboard");

    await page.evaluate(() => document.activeElement.blur());
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(700);
    const again = await page.evaluate(rowShape);
    assert.ok(Math.abs(again.box - closedCap) <= 0.1, `the row is ${again.box} after the close, not ${closedCap}`);
    assert.ok(caretInside(again));
    assert.ok(again.leftBelow <= 0.5, `${again.leftBelow}px left below the caret after the close`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("after a close the answer's scroll is back in bounds and its place is kept", async () => {
  const id = await create("Snap back on the phone");
  const paragraphs = [];
  for (let n = 1; n <= 40; n++) paragraphs.push(`Paragraph ${n} of a long answer that has to be scrolled to be read on a phone.`);
  await api(`/reply?box=${id}`, paragraphs.join("\n\n"));
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(k => window.__keyboard.set(k.height, 0), { height: PHONE.height - KEYBOARD });
    await settle(600);
    const shrunk = await page.evaluate(() => {
      const r = document.querySelector("article.box.sel .replyview");
      r.scrollTop = 1e6;
      return { st: r.scrollTop, max: r.scrollHeight - r.clientHeight, box: r.clientHeight };
    });
    assert.ok(shrunk.max > 0 && Math.abs(shrunk.st - shrunk.max) <= 0.5, "the answer did not scroll to its end under the keyboard");
    await page.evaluate(() => document.activeElement.blur());
    await settle(60);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
    await settle(800);
    const grown = await page.evaluate(() => {
      const r = document.querySelector("article.box.sel .replyview");
      return { st: r.scrollTop, max: r.scrollHeight - r.clientHeight, box: r.clientHeight };
    });
    near(grown.box, shrunk.box + LIFT, "the answer did not get the keyboard's room back after the close", WHOLE);
    assert.ok(grown.st <= grown.max + 0.5, `the answer sits ${grown.st - grown.max}px past its end after the close`);
    assert.ok(Math.abs(grown.st - grown.max) <= 0.5, "the answer lost its place at the end");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a window that shrinks with the keyboard: the box keeps the full-screen height, the foot lands on the visible bottom, and the close hands the window back", async () => {
  const id = await create("Keyboard window shrink on the phone");
  await api(`/reply?box=${id}`, "A reply to answer, with a few lines under it.\n\nOne.\n\nTwo.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await typeLines(page, 3);
    await settle(60);
    const rest = await page.evaluate(shellShape);
    await page.setViewport({ ...PHONE, height: PHONE.height - KEYBOARD });
    await settle(600);
    const up = await page.evaluate(shellShape);
    assert.equal(up.kb, true, "the shrunken window with the row focused is not read as the keyboard");
    assert.equal(up.inset, `${KEYBOARD}px`);
    assert.equal(up.bodyHeight, PHONE.height, "the box shrank with the window");
    near(up.footLaidOut, PHONE.height - INSET - KEYBOARD, "the card's foot did not take the keyboard's room", WHOLE);
    near(up.headLaidOut, rest.headLaidOut, "the card's top edge moved with the window", WHOLE);
    assert.ok(Math.abs((rest.rowBottom - up.rowBottom) - LIFT) <= 2,
      `the composer rose ${rest.rowBottom - up.rowBottom}, not the keyboard's ${KEYBOARD} less the band`);
    assert.equal(up.row, rest.row);
    assert.equal(up.vvh, `${PHONE.height - KEYBOARD}px`, "--vvh, the sent box's measure, does not follow the viewport");
    await page.screenshot({ path: path.join(SHOTS, "keyboard-window-up.png") });

    await page.evaluate(() => document.activeElement.blur());
    await settle(60);
    await page.setViewport(PHONE);
    await settle(800);
    const down = await page.evaluate(shellShape);
    assert.equal(down.kb, false);
    assert.equal(down.lifting, false);
    assert.equal(down.shellH, "");
    near(down.foot, PHONE.height - BAND, "the card's foot did not return to the band after the window came back");
    assert.equal(down.bodyHeight, PHONE.height);
    await page.screenshot({ path: path.join(SHOTS, "keyboard-window-down.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a new height under a bar already up, reported with the window shoved, leaves the box where it stood and the shove is still taken back", async () => {
  const id = await create("Shove under a bar on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - Math.floor(BAND));
    await settle(300);
    const bar = await page.evaluate(shellShape);
    assert.equal(bar.obstructed, true);
    assert.equal(bar.kb, false);
    assert.equal(bar.shellTop, "0px");

    // the bar becomes a keyboard, and iOS shoves the window to keep the caret
    // in view in the same report: the window is scrolled and the viewport's top
    // is the scroll. the box is not carried down with it, since the scroll is
    // taken back on the scroll report that follows the resize and the box would
    // be left 39 px low; every write of the box's top is recorded
    const SHOVE = 39;
    await page.evaluate(shove => {
      let scroll = shove;
      window.__scrollCalls = 0;
      window.__tops = [];
      Object.defineProperty(window, "scrollY", { get: () => scroll, configurable: true });
      window.scrollTo = () => { window.__scrollCalls++; scroll = 0; };
      const write = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        if (name === "--shell-top") window.__tops.push(value);
        return write.call(this, name, value, priority);
      };
    }, SHOVE);
    await page.evaluate(v => window.__keyboard.set(v.height, v.top), { height: PHONE.height - KEYBOARD, top: SHOVE });
    await settle(60);
    const shoved = await page.evaluate(shellShape);
    assert.equal(shoved.kb, true);
    assert.equal(await page.evaluate(() => window.__scrollCalls), 1, "the shove was not taken back");
    assert.deepEqual(await page.evaluate(() => window.__tops), [], "the box followed the shove into the viewport's top");
    assert.equal(shoved.shellTop, "0px");

    // the phone's viewport comes back to the top once the scroll is undone
    await page.evaluate(v => window.__keyboard.set(v.height, v.top), { height: PHONE.height - KEYBOARD, top: 0 });
    await settle(60);
    const back = await page.evaluate(shellShape);
    assert.deepEqual(await page.evaluate(() => window.__tops), [], "the box moved when the shove was undone");
    assert.equal(back.shellTop, "0px");
    near(back.head, HEAD, "the card's top edge is not at the visible top");
    assert.equal(await page.evaluate(() => window.__scrollCalls), 1);
    await page.evaluate(() => document.activeElement.blur());
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("Tab out of the card's name takes the focus into the typing row without scrolling, and the name is kept", async () => {
  const id = await create("Name to be typed on the phone");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.evaluate(cardId => editTitle(cardId), id);
    await page.evaluate(() => {
      window.__focusCalls = [];
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (options) {
        window.__focusCalls.push({ ta: this === els[selectedId].ta, preventScroll: !!(options && options.preventScroll) });
        return focus.apply(this, arguments);
      };
    });
    await page.keyboard.type(" and its name");
    const named = page.waitForResponse(response => new URL(response.url()).pathname === "/title", { timeout: 8000 });
    await page.keyboard.press("Tab");
    assert.equal((await named).status(), 200, "the name was not kept");
    await settle(150);
    const after = await page.evaluate(() => ({
      calls: window.__focusCalls,
      inRow: document.activeElement === els[selectedId].ta,
      open: els[selectedId].titleEl.isContentEditable,
      text: els[selectedId].titleEl.textContent,
    }));
    assert.deepEqual(after.calls, [{ ta: true, preventScroll: true }], "the typing row was not focused once, without scrolling");
    assert.equal(after.inRow, true, "the focus did not land in the typing row");
    assert.equal(after.open, false, "the name was left open for typing");
    assert.match(after.text, /and its name$/);

    // Shift+Tab is left to the phone: it goes backwards, not into the row
    await page.evaluate(cardId => editTitle(cardId), id);
    await page.evaluate(() => { window.__focusCalls = []; });
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    assert.deepEqual(await page.evaluate(() => window.__focusCalls), [], "Shift+Tab was taken from the phone");
    await page.evaluate(() => document.activeElement.blur());
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a tap on a card's name leaves it focused with the caret in it, so the Tab out of it is always the page's own", async () => {
  const id = await create("Name tapped on the phone");
  const { page, problems } = await openPhone(`/m?box=${id}`, { fake: true });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.evaluate(() => {
      window.__focusCalls = [];
      const focus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function (options) {
        window.__focusCalls.push({ ta: this === els[selectedId].ta, preventScroll: !!(options && options.preventScroll) });
        return focus.apply(this, arguments);
      };
    });
    const where = await page.evaluate(() => {
      const r = els[selectedId].titleEl.getBoundingClientRect();
      return { x: r.left + 6, y: r.top + r.height / 2 };
    });
    // the second round starts with the typing row focused, the third with nothing focused, as the toolbar's checkmark leaves it
    for (const round of [1, 2, 3]) {
      if (round === 3) await page.evaluate(() => document.activeElement.blur());
      assert.equal(await page.evaluate(() => els[selectedId].titleEl.isContentEditable), false, `round ${round}: the name was open before the tap`);
      await page.mouse.click(where.x, where.y);
      await settle(80);
      const tapped = await page.evaluate(() => {
        const t = els[selectedId].titleEl, s = getSelection();
        return { open: t.isContentEditable, focused: document.activeElement === t, caretInside: s.rangeCount > 0 && s.isCollapsed && t.contains(s.anchorNode) };
      });
      assert.deepEqual(tapped, { open: true, focused: true, caretInside: true }, `round ${round}: the tap did not leave the name focused with a caret`);
      await page.evaluate(() => { window.__focusCalls = []; });
      await page.keyboard.press("Tab");
      await settle(150);
      const after = await page.evaluate(() => ({
        calls: window.__focusCalls,
        inRow: document.activeElement === els[selectedId].ta,
        open: els[selectedId].titleEl.isContentEditable,
      }));
      assert.deepEqual(after.calls, [{ ta: true, preventScroll: true }], `round ${round}: the Tab did not go through the page's own focus`);
      assert.equal(after.inRow, true, `round ${round}: the focus did not land in the typing row`);
      assert.equal(after.open, false, `round ${round}: the name was left open`);
    }
    await page.evaluate(() => document.activeElement.blur());
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the phone page's own words carry no em dash", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.doesNotMatch(source, /—/, "an em dash in the phone page");
  assert.match(source, /--kb-anim:\.22s cubic-bezier/, "the keyboard's curve is not the platform's");
  assert.match(source, /const KB_ANIM_MS = 220/, "the settle clock and the css curve do not carry the same duration");
});
