// The settings page on the Mac board, where it is an overlay, and on the phone
// app, where the same page fills the right drawer, driven headless against its
// own fixture board.
//
// What is being proved is what was asked for: on the Mac one page centred over
// the board at about seven tenths of the window each way, in the quick note's
// glass and with its corners, a column of sections beside the chosen section
// when the page itself is wider than 989px, only the list when it is not, with a
// way back from a section, a way to put the whole page away (the close mark,
// Escape, a click outside it), every setting still writing what it always wrote,
// the colour picker gone from the bar and the pen a plain mark like the gear. On
// the phone the drawer keeps its own size, white, edge and corners, and holds the
// list of sections, each one opening inside it with a way back.
//
// The board is invented and lives in a temp directory. Nothing here touches the
// real board, the owner's browser or port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const WIDE = { width: 1440, height: 900 };
const TALL = { width: 820, height: 1180 };
const OWNER = { width: 1512, height: 982, deviceScaleFactor: 2 };
const NARROW = { width: 900, height: 982, deviceScaleFactor: 2 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];

let browser = null;
let child = null;
let fixtureDir = "";
let origin = "";

// the fixture server is stopped through the handle this file started it with,
// and its exit is waited for, so nothing is ever looked up by name
async function stopFixture() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const quit = await Promise.race([
    ended.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!quit) { child.kill("SIGKILL"); await ended; }
}

function settle(ms = 120) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function open(route, viewport, opts = {}) {
  const page = await browser.newPage();
  const problems = [];
  await page.setViewport(viewport);
  // each page starts where a browser that has never been opened starts, and only
  // on its first document: a reload inside a check must find what the page wrote
  await page.evaluateOnNewDocument(() => {
    try {
      if (sessionStorage.getItem("settings-page-check")) return;
      sessionStorage.setItem("settings-page-check", "1");
      localStorage.clear();
    } catch (error) {}
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    const where = (message.location() && message.location().url) || "";
    if (/fonts\.g(oogleapis|static)\.com|favicon/.test(message.text() + " " + where)) return;
    problems.push("console: " + message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 15000 });
  return { page, problems };
}

// drawn and reachable: not hidden by display, visibility or a zero box
function shown(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  }, selector);
}

function labels(page) {
  return page.evaluate(() => [...document.querySelectorAll(".sp-item")].map(item => item.textContent.trim()));
}

function title(page) {
  return page.evaluate(() => document.querySelector(".sp-title").textContent);
}

// the page's own box, and where the window ends
function cover(page, selector) {
  return page.evaluate(sel => {
    const box = document.querySelector(sel).getBoundingClientRect();
    return { left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right),
             bottom: Math.round(box.bottom), width: innerWidth, height: innerHeight };
  }, selector);
}

// the overlay's own box in fractions of the window: how much of it each way, and
// how far it stands from each edge
function share(page) {
  return page.evaluate(() => {
    const box = document.querySelector(".sp-page").getBoundingClientRect();
    return { across: box.width / innerWidth, down: box.height / innerHeight,
             left: box.left, right: innerWidth - box.right, top: box.top, bottom: innerHeight - box.bottom };
  });
}

function assertSeventhTenths(box, where) {
  assert.ok(Math.abs(box.across - 0.7) < 0.01, where + ": not about 70% across: " + box.across);
  assert.ok(Math.abs(box.down - 0.7) < 0.01, where + ": not about 70% down: " + box.down);
  assert.ok(Math.abs(box.left - box.right) <= 1, where + ": not centred across: " + box.left + " and " + box.right);
  assert.ok(Math.abs(box.top - box.bottom) <= 1, where + ": not centred down: " + box.top + " and " + box.bottom);
}

async function openMac(page) {
  await page.click("#setbtn");
  await page.waitForSelector(".sp-veil.open", { timeout: 5000 });
  await settle(200);
}

async function openIfShut(page) {
  if (!(await shown(page, ".sp-page"))) await openMac(page);
}

// the phone opens its settings drawer with a pull from the right edge
async function openPhone(page, width = PHONE.width) {
  const from = width - 6, y = 500;
  await page.touchscreen.touchStart(from, y);
  for (let step = 1; step <= 8; step++) {
    await page.touchscreen.touchMove(from - 30 * step, y);
    await settle(16);
  }
  await page.touchscreen.touchEnd();
  await page.waitForSelector("#settings.open", { timeout: 5000 });
  await settle(700);
}

async function swipeRight(page, y = 500, from = 80, to = 320) {
  await page.touchscreen.touchStart(from, y);
  for (let step = 1; step <= 8; step++) {
    await page.touchscreen.touchMove(from + (to - from) * step / 8, y);
    await settle(16);
  }
  await page.touchscreen.touchEnd();
  await settle(700);
}

before(async () => {
  const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-settings-page-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "settings page fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator",
        context: "Invented content for the fixture board." },
      { id: "1.1", bucket: "now", title: "A card in the other lane", owner: "pastureland",
        context: "Its own lane." },
    ],
  }));
  origin = "http://127.0.0.1:" + port;
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("fixture server exited early:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) { ready = true; break; } } catch (error) {}
    await settle(30);
  }
  if (!ready) { await stopFixture(); throw new Error("fixture server did not start:\n" + output); }
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  await stopFixture();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- the bar ------------------------------------------------------------------------

test("the bar has no colour picker and the pen is a plain mark like the gear", async () => {
  const { page, problems } = await open("/", WIDE);
  try {
    const bar = await page.evaluate(() => {
      const dress = el => {
        const style = getComputedStyle(el);
        const svg = el.querySelector("svg").getBoundingClientRect();
        return { background: style.backgroundColor, border: style.borderTopStyle, shadow: style.boxShadow,
                 color: style.color, mark: Math.round(svg.width) + "x" + Math.round(svg.height),
                 inBar: !!el.closest(".bar") };
      };
      const pick = document.getElementById("bgpick");
      return { pen: dress(document.getElementById("editbtn")), gear: dress(document.getElementById("setbtn")),
               pickInBar: !!document.querySelector(".bar #bgpick"), pickInPage: !!pick.closest(".sp-page") };
    });
    assert.equal(bar.pickInBar, false, "the colour picker is still on the bar");
    assert.equal(bar.pickInPage, true, "the colour picker is not in the settings page");
    assert.equal(bar.pen.inBar, true, "the pen left the bar");
    assert.equal(bar.pen.background, "rgba(0, 0, 0, 0)", "the pen still sits on a tinted box");
    assert.equal(bar.pen.border, "none", "the pen still has a border");
    assert.equal(bar.pen.shadow, "none", "the pen still has a shadow");
    assert.equal(bar.pen.mark, bar.gear.mark, "the pen mark is not the gear's size");
    assert.equal(bar.pen.color, bar.gear.color, "the pen mark is not the gear's colour");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the Mac board, wide --------------------------------------------------------------

test("wide: the gear opens one page, centred at about 70% of the window, in the quick note's glass and corners", async () => {
  const { page, problems } = await open("/", OWNER);
  try {
    assert.equal(await shown(page, ".sp-page"), false, "the page was already on show");
    // the quick note's dress in this same window, to set the page's against
    await page.evaluate(() => quickNote.open(null, document.querySelector(".qnpeek").getBoundingClientRect()));
    await page.waitForFunction(() => document.querySelector(".qn-veil.open:not(.sp-veil)"), { timeout: 5000 });
    await settle(500);
    const dress = selector => page.evaluate(sel => {
      const style = getComputedStyle(document.querySelector(sel));
      return { radius: style.borderRadius, shadow: style.boxShadow, filter: style.backdropFilter,
               tint: style.backgroundColor, layers: style.backgroundImage };
    }, selector);
    const note = await dress(".qn-card");
    await page.keyboard.press("Escape");
    await settle(300);

    await openMac(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".sp-page").length), 1,
      "there is not exactly one settings page");
    assertSeventhTenths(await share(page), "at the owner's window");
    const glass = await dress(".sp-page");
    assert.match(glass.filter, /blur\(15px\)/, "the page is not blurred like the note: " + glass.filter);
    assert.match(glass.filter, /saturate\((1\.8|180%)\)/, "the page is not saturated like the note: " + glass.filter);
    assert.equal(glass.tint, "rgba(255, 255, 255, 0.77)", "the page's tint is not the note's");
    assert.equal(glass.radius, note.radius, "the page's corners are not the note's");
    assert.equal(glass.shadow, note.shadow, "the page's edge is not the note's");
    assert.equal(glass.layers, note.layers, "the page's surface is not the note's");
    assert.equal(glass.filter, note.filter);
    assert.equal(glass.tint, note.tint);
    assert.match(await page.$eval(".sp-page", el => el.className), /qn-glass/, "the page does not wear the note's glass");
    // the veil is the note's own and still covers the window, so a press outside
    // the page lands on it and the board stays drawn under it
    const around = await page.evaluate(() => {
      const veil = document.querySelector(".sp-veil").getBoundingClientRect();
      const corner = document.elementFromPoint(6, 6);
      return { veil: getComputedStyle(document.querySelector(".sp-veil")).position,
               covers: veil.left === 0 && veil.top === 0 && veil.right === innerWidth && veil.bottom === innerHeight,
               cornerIsVeil: corner === document.querySelector(".sp-veil"),
               ink: getComputedStyle(document.querySelector(".sp-veil")).backgroundColor,
               boardStillThere: !!document.getElementById("stage") && document.getElementById("stage").getBoundingClientRect().width > 0 };
    });
    assert.equal(around.veil, "fixed");
    assert.equal(around.covers, true, "the veil no longer covers the window");
    assert.equal(around.cornerIsVeil, true, "a press near the window's corner would reach the board");
    assert.notEqual(around.ink, "rgba(0, 0, 0, 0)", "nothing veils the board around the page");
    assert.equal(around.boardStillThere, true);
    assert.equal(await page.$eval("#setbtn", el => el.getAttribute("aria-expanded")), "true");
    assert.equal(await page.evaluate(() => document.body.classList.contains("setopen")), true);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the overlay is about 70% of the window each way, centred, and follows the window", async () => {
  const { page, problems } = await open("/", OWNER);
  try {
    await openMac(page);
    assertSeventhTenths(await share(page), "1512 by 982");
    for (const size of [{ width: 1200, height: 800 }, { width: 1800, height: 1000 }, { width: 900, height: 982 }]) {
      await page.setViewport({ ...size, deviceScaleFactor: 2 });
      await settle(300);
      assertSeventhTenths(await share(page), size.width + " by " + size.height);
      assert.equal(await shown(page, ".sp-page"), true, "the page went away with the resize");
    }
    await page.setViewport(OWNER);
    await settle(300);
    assertSeventhTenths(await share(page), "back at 1512 by 982");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a narrow window gets the same overlay, at 70%, with the list", async () => {
  const { page, problems } = await open("/", NARROW);
  try {
    await openMac(page);
    assertSeventhTenths(await share(page), "at 900 by 982");
    assert.equal(await shown(page, ".sp-list"), true, "the list is not showing");
    assert.equal(await shown(page, ".sp-panes"), false, "settings show beside a list that has no room");
    assert.equal(await page.evaluate(() => document.querySelector(".sp-page").hasAttribute("data-narrow")), true);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the two layouts turn on the overlay's own width, 989px, and not on the window's", async () => {
  const { page, problems } = await open("/", OWNER);
  try {
    await openMac(page);
    const state = async () => ({
      width: await page.evaluate(() => document.querySelector(".sp-page").getBoundingClientRect().width),
      window: await page.evaluate(() => innerWidth),
      panes: await shown(page, ".sp-panes"),
    });
    // a window well past 989px whose overlay is not: seven tenths of 1200 is 840
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
    await settle(300);
    let now = await state();
    assert.ok(now.window > 989 && now.width < 989, "the fixture window is not the case it is meant to be");
    assert.equal(now.panes, false, "the window's width, and not the page's, chose the layout: " + JSON.stringify(now));
    assert.equal(await shown(page, ".sp-list"), true);
    // and either side of the switch, an overlay of 989px or narrower gets the list
    await page.setViewport({ width: 1412, height: 900, deviceScaleFactor: 2 });
    await settle(300);
    now = await state();
    assert.ok(now.width <= 989, "the fixture is not on the narrow side: " + JSON.stringify(now));
    assert.equal(now.panes, false, "the list did not hold at " + now.width + "px");
    await page.setViewport({ width: 1414, height: 900, deviceScaleFactor: 2 });
    await settle(300);
    now = await state();
    assert.ok(now.width > 989, "the fixture is not on the wide side: " + JSON.stringify(now));
    assert.equal(now.panes, true, "the sections did not stand beside the settings at " + now.width + "px");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("wide: sections stand on the left and the chosen one's settings on the right", async () => {
  const { page, problems } = await open("/", WIDE);
  try {
    await openMac(page);
    assert.deepEqual(await labels(page), ["Appearance", "Editor"], "the sections are not the settings' own groups");
    assert.equal(await shown(page, ".sp-list"), true, "the list of sections is not showing");
    assert.equal(await shown(page, ".sp-panes"), true, "the settings are not showing beside the list");
    assert.equal(await shown(page, ".sp-back"), false, "a back mark shows where there is nothing to go back to");
    assert.equal(await title(page), "Settings");
    const beside = await page.evaluate(() => {
      const list = document.querySelector(".sp-list").getBoundingClientRect();
      const panes = document.querySelector(".sp-panes").getBoundingClientRect();
      return { listRight: list.right, panesLeft: panes.left, listLeft: list.left };
    });
    assert.ok(beside.listRight <= beside.panesLeft + 1, "the list is not to the left of the settings");
    assert.ok(beside.listLeft < beside.panesLeft, "the list does not lead");
    // the first section is showing and the second is not
    assert.equal(await shown(page, "#settings-appearance"), true);
    assert.equal(await shown(page, "#settings-editor"), false);
    assert.equal(await shown(page, "#bgpick"), true, "the colour picker is not in the first section");
    await page.click('.sp-item[data-section="editor"]');
    await settle();
    assert.equal(await shown(page, "#settings-editor"), true, "the editor section did not show");
    assert.equal(await shown(page, "#settings-appearance"), false, "the first section stayed on show");
    assert.equal(await shown(page, "#setformat"), true);
    assert.equal(await shown(page, ".sp-list"), true, "the list went away when a section was chosen");
    assert.equal(await page.$eval('.sp-item[data-section="editor"]', el => el.getAttribute("aria-current")), "true");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("wide: each setting still writes what it always wrote", async () => {
  const { page, problems } = await open("/", WIDE);
  try {
    await openMac(page);
    // the colour behind the board: the custom property and the stored colour
    await page.$eval("#bgpick", el => { el.value = "#e8f0e0"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const picked = await page.evaluate(() => ({
      stored: localStorage.getItem("bgcolor"),
      paper: document.body.style.getPropertyValue("--paper"),
    }));
    assert.equal(picked.stored, "#e8f0e0", "the colour was not stored as bgcolor");
    assert.equal(picked.paper, "#e8f0e0", "the colour did not reach the board");
    // and typed formatting: on until it is turned off, stored as it always was
    await page.click('.sp-item[data-section="editor"]');
    await settle();
    assert.equal(await page.$eval("#setformat", el => el.checked), true, "formatting does not start on");
    await page.click("#setformat");
    assert.equal(await page.evaluate(() => localStorage.getItem("composeformat")), "0");
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), false);
    await page.click("#setformat");
    assert.equal(await page.evaluate(() => localStorage.getItem("composeformat")), "1");
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), true);
    // the colour is still what the browser remembered after a reload
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
    const kept = await page.evaluate(() => ({
      paper: document.body.style.getPropertyValue("--paper"),
      value: document.getElementById("bgpick").value,
    }));
    assert.equal(kept.paper, "#e8f0e0", "the colour was not restored on load");
    assert.equal(kept.value, "#e8f0e0", "the picker does not show the stored colour");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("wide: the close mark and Escape put the page away, and Escape stays off the board", async () => {
  const made = await fetch(origin + "/create?owner=facilitator", { method: "POST", body: "Card behind the page" });
  const { id } = await made.json();
  const { page, problems } = await open("/", WIDE);
  try {
    await page.waitForFunction(cardId => !!els[cardId], { timeout: 10000 }, id);
    await page.evaluate(cardId => select(cardId), id);
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
    await openMac(page);
    await page.click(".sp-close");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false, "the close mark left the page on show");
    assert.equal(await page.$eval("#setbtn", el => el.getAttribute("aria-expanded")), "false");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "setbtn",
      "focus did not return to the gear");
    await openMac(page);
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false, "Escape left the page on show");
    assert.equal(await page.evaluate(cardId => document.getElementById("box-" + cardId).classList.contains("sel"), id), true,
      "the Escape that closed the page also cleared the card behind it");
    // opened again, it is still one page with its first section showing
    await openMac(page);
    assert.equal(await shown(page, "#settings-appearance"), true);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a press outside the page puts it away; a press inside it, or a drag out of it, does not", async () => {
  const made = await fetch(origin + "/create?owner=facilitator", { method: "POST", body: "Card behind the overlay" });
  const { id } = await made.json();
  const { page, problems } = await open("/", OWNER);
  try {
    await page.waitForFunction(cardId => !!els[cardId], { timeout: 10000 }, id);
    await page.evaluate(cardId => select(cardId), id);
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
    await openMac(page);
    const box = await page.evaluate(() => {
      const r = document.querySelector(".sp-page").getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
    });
    const outside = {
      left: [box.left / 2, box.height / 2], right: [(box.right + box.width) / 2, box.height / 2],
      top: [box.width / 2, box.top / 2], bottom: [box.width / 2, (box.bottom + box.height) / 2],
      corner: [4, 4],
    };
    for (const [side, [x, y]] of Object.entries(outside)) {
      await openIfShut(page);
      await page.mouse.click(x, y);
      await settle(200);
      assert.equal(await shown(page, ".sp-page"), false, "a click outside on the " + side + " left the page on show");
      assert.equal(await page.$eval("#setbtn", el => el.getAttribute("aria-expanded")), "false");
      assert.equal(await page.evaluate(() => document.body.classList.contains("setopen")), false);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "setbtn",
        "focus did not return to the gear after a click on the " + side);
    }
    // the click did not go on to the board behind the page
    assert.equal(await page.evaluate(cardId => document.getElementById("box-" + cardId).classList.contains("sel"), id), true,
      "a click outside the page reached the card behind it");

    await openIfShut(page);
    // on the page's own bar, and on bare glass under the sections, it stays
    await page.click(".sp-title");
    await settle(100);
    assert.equal(await shown(page, ".sp-page"), true, "a click on the page's bar put it away");
    await page.mouse.click(box.left + (box.right - box.left) / 2, box.bottom - 30);
    await settle(100);
    assert.equal(await shown(page, ".sp-page"), true, "a click on bare glass put the page away");
    // the page keeps focus after that, so Escape still puts it away and no key reaches the board
    assert.equal(await page.evaluate(() => !!document.querySelector(".sp-veil").contains(document.activeElement)), true,
      "a click on bare glass took focus out of the page");
    // a press that starts inside and lets go on the veil, as a text selection dragged out would, does not close it
    await page.mouse.move(box.left + 100, box.bottom - 50);
    await page.mouse.down();
    await page.mouse.move(2, 2, { steps: 5 });
    await page.mouse.up();
    await settle(150);
    assert.equal(await shown(page, ".sp-page"), true, "a drag out of the page put it away");
    await page.mouse.click(box.left + (box.right - box.left) / 2, box.bottom - 30);
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false, "Escape after a click on bare glass left the page on show");
    assert.equal(await page.evaluate(cardId => document.getElementById("box-" + cardId).classList.contains("sel"), id), true,
      "the Escape that closed the page also cleared the card behind it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("no key reaches the board while the page is open", async () => {
  const { page, problems } = await open("/", OWNER);
  try {
    await openMac(page);
    await page.evaluate(() => {
      window.__keysAtDocument = [];
      document.addEventListener("keydown", e => window.__keysAtDocument.push(e.key));
      document.querySelector(".sp-item").focus();
    });
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "j", "Backspace", "Enter", " "]) {
      await page.keyboard.press(key);
      await settle(40);
    }
    assert.deepEqual(await page.evaluate(() => window.__keysAtDocument), [],
      "a key went on past the page to the board");
    assert.equal(await page.evaluate(() => document.querySelector(".sp-veil").contains(document.activeElement)), true,
      "focus left the page");
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the Mac board, narrow -----------------------------------------------------------

test("narrow Mac: only the list, a section on tap, a way back, and a way out", async () => {
  const { page, problems } = await open("/", TALL);
  try {
    await openMac(page);
    assertSeventhTenths(await share(page), "at the tall window");
    assert.deepEqual(await labels(page), ["Appearance", "Editor"]);
    assert.equal(await shown(page, ".sp-list"), true, "the list is not showing");
    assert.equal(await shown(page, ".sp-panes"), false, "settings show beside a list that has no room");
    assert.equal(await shown(page, ".sp-back"), false, "the list has a back mark");
    assert.equal(await title(page), "Settings");

    await page.click('.sp-item[data-section="appearance"]');
    await settle(200);
    assert.equal(await shown(page, ".sp-list"), false, "the list stayed under an opened section");
    assert.equal(await shown(page, "#settings-appearance"), true);
    assert.equal(await shown(page, "#bgpick"), true, "the colour picker is not in the opened section");
    assert.equal(await shown(page, ".sp-back"), true, "an opened section has no way back");
    assert.equal(await page.$eval(".sp-back", el => el.getAttribute("aria-label")), "Back to settings");
    assert.equal(await title(page), "Appearance", "the heading does not name the section");
    await page.$eval("#bgpick", el => { el.value = "#dde6f2"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    assert.equal(await page.evaluate(() => localStorage.getItem("bgcolor")), "#dde6f2");

    await page.click(".sp-back");
    await settle(200);
    assert.equal(await shown(page, ".sp-list"), true, "back did not return to the list");
    assert.equal(await shown(page, ".sp-panes"), false);
    assert.equal(await title(page), "Settings");

    await page.click('.sp-item[data-section="editor"]');
    await settle(200);
    assert.equal(await shown(page, "#setformat"), true);
    await page.click("#setformat");
    assert.equal(await page.evaluate(() => localStorage.getItem("composeformat")), "0");
    // Escape puts the whole page away, not just the section
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false, "Escape from a section left the page on show");
    // and it opens again on the list
    await openMac(page);
    assert.equal(await shown(page, ".sp-list"), true);
    assert.equal(await shown(page, ".sp-panes"), false);
    await page.click(".sp-close");
    await settle(200);
    assert.equal(await shown(page, ".sp-page"), false, "the close mark left the page on show");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the same page changes layout when the window does", async () => {
  const { page, problems } = await open("/", TALL);
  try {
    await openMac(page);
    await page.click('.sp-item[data-section="editor"]');
    await settle(200);
    assert.equal(await shown(page, ".sp-list"), false);
    await page.setViewport(WIDE);
    await settle(300);
    assert.equal(await shown(page, ".sp-list"), true, "the list did not come back on a wide window");
    assert.equal(await shown(page, "#settings-editor"), true, "the chosen section was lost on a wide window");
    assert.equal(await shown(page, ".sp-back"), false, "the back mark stayed on a wide window");
    assert.equal(await title(page), "Settings");
    await page.setViewport(TALL);
    await settle(300);
    assert.equal(await shown(page, ".sp-list"), false, "the list stayed beside a section on a narrow window");
    assert.equal(await shown(page, ".sp-back"), true);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the phone app ------------------------------------------------------------------
// a pull from the right edge brings in the narrow white panel the phone has always had,
// and the settings page fills it; the tab row holds only the house and the tabs

// the controls each section holds, and the ones of them that always draw a box (the
// notes and the status line are empty until there is something to say)
const HELD = {
  editor: ["setformat"],
  notifications: ["notify", "notifynote"],
  account: ["signout", "signoutnote"],
  diagnostics: ["savediagnostic", "diagnostichelp", "diagnosticstatus"],
};
const SECTIONS = {
  editor: ["setformat"],
  notifications: ["notify"],
  account: ["signout"],
  diagnostics: ["savediagnostic", "diagnostichelp"],
};

// what shows in the drawer's page: the header's words and marks, and each control's box
function drawerView(page) {
  return page.evaluate((sections, held) => {
    const drawer = document.getElementById("settings").getBoundingClientRect();
    const seen = el => {
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const inside = el => {
      const box = el.getBoundingClientRect();
      return box.left >= drawer.left && box.right <= drawer.right && box.top >= drawer.top && box.bottom <= drawer.bottom;
    };
    const page = document.getElementById("setpage");
    return {
      view: page.dataset.view,
      title: page.querySelector(".sp-title").textContent,
      back: seen(page.querySelector(".sp-back")),
      close: seen(page.querySelector(".sp-close")),
      items: [...page.querySelectorAll(".sp-item")].filter(seen).map(one => one.textContent.trim()),
      panes: [...page.querySelectorAll(".sp-pane")].filter(seen).map(one => one.id),
      shown: Object.fromEntries(Object.entries(sections).map(([name, ids]) => [name, ids.every(id => seen(document.getElementById(id)) && inside(document.getElementById(id)))])),
      anyShown: Object.values(sections).flat().filter(id => seen(document.getElementById(id))),
      inPane: Object.fromEntries(Object.entries(held).map(([name, ids]) => [name, ids.every(id => document.getElementById("settings-" + name).contains(document.getElementById(id)))])),
      across: page.scrollWidth > page.clientWidth,
    };
  }, SECTIONS, HELD);
}

test("phone: a pull from the right edge brings in the drawer, in its own size and style, holding the page", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    const wide = Math.min(PHONE.width * 0.714, 289);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#setico, #sethead, #setgroup").length), 0,
      "the phone carries a gear or the drawer's old header and controls");
    assert.equal(await page.evaluate(() => document.querySelectorAll("#settings .sp-page").length), 1,
      "the drawer does not hold the settings page");
    assert.deepEqual(await page.evaluate(() => [...document.getElementById("tabrow").children].map(one => one.id || one.className)),
      ["homeico", "bar"], "the tab row holds something besides the house and the tabs");
    const shut = await cover(page, "#settings");
    assert.ok(shut.left >= shut.width, "the drawer does not wait beyond the right edge: " + JSON.stringify(shut));
    await openPhone(page);
    const box = await cover(page, "#settings");
    assert.equal(box.right, box.width, "the drawer does not stand on the right edge");
    assert.equal(box.right - box.left, Math.round(wide), "the drawer is not about 71% of the screen wide");
    assert.ok(box.left > 0 && box.top <= 0 && box.bottom >= box.height, "the drawer is not a full-height panel: " + JSON.stringify(box));
    const look = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("settings"));
      return { fill: style.backgroundColor, filter: style.backdropFilter, edge: style.borderLeftStyle,
               corners: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius],
               scrim: getComputedStyle(document.getElementById("scrim")).backgroundColor,
               veil: document.getElementById("scrim").dataset.for || null,
               glass: document.getElementById("settings").classList.contains("qn-glass") };
    });
    assert.equal(look.fill, "rgb(255, 255, 255)", "the drawer is not the card list's white");
    assert.equal(look.filter, "none", "the drawer blurs the board behind it");
    assert.equal(look.glass, false, "the drawer wears the note's glass");
    assert.equal(look.edge, "solid", "the drawer has no edge line on its left");
    assert.deepEqual(look.corners, ["12px", "0px", "0px", "12px"], "the drawer's exposed corners are not 12px");
    assert.equal(look.scrim, "rgba(33, 29, 23, 0.18)", "the shade over the page is not the drawer's");
    assert.equal(look.veil, null, "the shade was told which side is coming");
    const bare = await page.evaluate(() => {
      const one = document.getElementById("setpage"), style = getComputedStyle(one);
      const inner = one.getBoundingClientRect(), outer = document.getElementById("settings").getBoundingClientRect();
      return { fill: style.backgroundColor, filter: style.backdropFilter, shadow: style.boxShadow,
               veil: getComputedStyle(one, "::before").display, left: inner.left - outer.left,
               right: outer.right - inner.right, top: inner.top - outer.top, bottom: outer.bottom - inner.bottom };
    });
    assert.equal(bare.fill, "rgba(0, 0, 0, 0)", "the page paints over the drawer's white");
    assert.equal(bare.filter, "none", "the page blurs what is under it");
    assert.equal(bare.shadow, "none", "the page throws a shadow inside the drawer");
    assert.equal(bare.veil, "none", "the page keeps the glass's sheen");
    assert.ok(bare.left >= 0 && bare.left <= 2 && bare.right === 0 && bare.bottom >= 0,
      "the page does not fill the drawer: " + JSON.stringify(bare));
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: the drawer opens on the list of sections and each one opens inside it, with a way back", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    await openPhone(page);
    const drawer = await cover(page, "#settings");
    const list = await drawerView(page);
    assert.equal(list.view, "list");
    assert.equal(list.title, "Settings");
    assert.deepEqual(list.items, ["Editor", "Notifications", "Account", "Diagnostics"]);
    assert.deepEqual(list.panes, [], "a section shows over the list");
    assert.equal(list.back, false, "the list has a way back");
    assert.equal(list.close, false, "the page carries a close mark of its own");
    assert.deepEqual(list.anyShown, [], "a control shows before its section is opened");
    const words = { editor: "Editor", notifications: "Notifications", account: "Account", diagnostics: "Diagnostics" };
    for (const [name, ids] of Object.entries(SECTIONS)) {
      await page.tap('.sp-item[data-section="' + name + '"]');
      await settle(80);
      const one = await drawerView(page);
      assert.equal(one.view, "pane", name + ": did not open");
      assert.equal(one.title, words[name], name + ": the title is not the section's");
      assert.equal(one.back, true, name + ": no way back");
      assert.equal(one.close, false, name + ": a close mark shows");
      assert.deepEqual(one.items, [], name + ": the list shows beside the section");
      assert.deepEqual(one.panes, ["settings-" + name], name + ": the wrong section shows");
      assert.deepEqual(one.anyShown, ids, name + ": the wrong controls show");
      assert.equal(one.shown[name], true, name + ": a control is out of the drawer");
      assert.deepEqual(Object.entries(one.inPane).filter(([, ok]) => !ok), [], "a control is not in its own section");
      assert.equal(one.across, false, name + ": the page runs past the drawer's width");
      assert.deepEqual(await cover(page, "#settings"), drawer, name + ": the drawer changed size or place");
      await page.tap(".sp-back");
      await settle(80);
      const back = await drawerView(page);
      assert.equal(back.view, "list", name + ": the way back did not return to the list");
      assert.equal(back.title, "Settings");
      assert.equal(await page.evaluate(() => document.getElementById("settings").classList.contains("open")), true,
        name + ": the way back put the drawer away");
    }
    const text = await page.evaluate(() => ({
      format: document.querySelector('label[for="setformat"]').textContent.trim().split("\n")[0],
      notify: document.getElementById("notify").textContent.trim(),
      signout: document.getElementById("signout").textContent.trim(),
      save: document.getElementById("savediagnostic").textContent.trim(),
    }));
    assert.deepEqual(text, { format: "Format text while typing", notify: "Notifications", signout: "Sign out",
                             save: "Save diagnostic history" });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: the drawer stays narrow, with the list and sections, in a wide window", async () => {
  const wide = { ...PHONE, width: 1100, height: 800 };
  const { page, problems } = await open("/m", wide);
  try {
    await openPhone(page, wide.width);
    const box = await cover(page, "#settings");
    assert.equal(box.right - box.left, 289, "the drawer is not capped at 289px");
    const list = await drawerView(page);
    assert.deepEqual(list.items, ["Editor", "Notifications", "Account", "Diagnostics"]);
    assert.deepEqual(list.panes, [], "a section shows beside the list");
    await page.tap('.sp-item[data-section="account"]');
    await settle(80);
    const one = await drawerView(page);
    assert.deepEqual(one.items, [], "the list shows beside the section");
    assert.deepEqual(one.panes, ["settings-account"]);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: typed formatting is still stored as it was", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    await openPhone(page);
    await page.tap('.sp-item[data-section="editor"]');
    await settle(80);
    assert.equal(await page.$eval("#setformat", el => el.checked), true, "formatting does not start on");
    await page.tap("#setformat");
    assert.equal(await page.evaluate(() => localStorage.getItem("composeformat")), "0");
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), false);
    await page.tap("#setformat");
    assert.equal(await page.evaluate(() => localStorage.getItem("composeformat")), "1");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: a tap on the shade and a swipe toward the edge put the drawer away", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    const out = () => page.evaluate(() => document.getElementById("settings").classList.contains("open"));
    await openPhone(page);
    assert.equal(await out(), true);
    await page.touchscreen.tap(20, 400);
    await settle(700);
    assert.equal(await out(), false, "a tap on the shade left the drawer open");

    await openPhone(page);
    await swipeRight(page);
    assert.equal(await out(), false, "a swipe toward the edge did not put the drawer away");
    assert.equal(await page.evaluate(() => document.body.classList.contains("menuout")), false);

    // a short swipe is turned back and the drawer stays
    await openPhone(page);
    await swipeRight(page, 500, 150, 190);
    assert.equal(await out(), true, "a short swipe put the drawer away");
    await swipeRight(page);
    assert.equal(await out(), false);

    // inside a section the shade and a swipe still put the whole drawer away, and it
    // opens on the list the next time
    for (const how of ["shade", "swipe"]) {
      await openPhone(page);
      await page.tap('.sp-item[data-section="diagnostics"]');
      await settle(80);
      assert.equal((await drawerView(page)).view, "pane");
      if (how === "shade") await page.touchscreen.tap(20, 400);
      else await swipeRight(page, 600, 170, 370);
      await settle(700);
      assert.equal(await out(), false, "a " + how + " in a section left the drawer open");
      await openPhone(page);
      const again = await drawerView(page);
      assert.equal(again.view, "list", "the drawer did not open on the list after a " + how);
      assert.equal(again.title, "Settings");
      await swipeRight(page);
    }

    // a drag up the drawer in a section does not put it away
    await openPhone(page);
    await page.tap('.sp-item[data-section="notifications"]');
    await settle(80);
    await page.touchscreen.touchStart(250, 600);
    for (let step = 1; step <= 6; step++) { await page.touchscreen.touchMove(250, 600 - 30 * step); await settle(16); }
    await page.touchscreen.touchEnd();
    await settle(700);
    assert.equal(await out(), true, "a vertical drag put the drawer away");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
