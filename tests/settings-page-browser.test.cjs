// The settings page, driven headless against its own fixture board on the two
// surfaces that carry it: the Mac board, where it is an overlay, and the phone
// app, where it fills the screen.
//
// What is being proved is what was asked for: on the Mac one page centred over
// the board at about seven tenths of the window each way, in the quick note's
// glass and with its corners, a column of sections beside the chosen section
// when the page itself is wider than 989px, only the list when it is not, with a
// way back from a section, a way to put the whole page away (the close mark,
// Escape, a click outside it), every setting still writing what it always wrote,
// the colour picker gone from the bar and the pen a plain mark like the gear, and
// the phone's page left as it was.
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

// the phone opens its settings the way it always did, with a pull from the right edge
async function openPhone(page) {
  const from = PHONE.width - 6, y = 500;
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

test("phone: a pull from the right edge opens the page over the screen with the list of sections", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    assert.equal(await page.evaluate(() => document.querySelectorAll(".sp-page").length), 1);
    assert.deepEqual(await page.evaluate(() => [...document.getElementById("tabrow").children].map(one => one.id || one.className)),
      ["homeico", "bar"], "the tab row holds something besides the house and the tabs");
    await openPhone(page);
    const box = await cover(page, "#settings");
    assert.ok(box.left <= 0 && box.right >= box.width && box.top <= 0 && box.bottom >= box.height,
      "the page does not cover the screen: " + JSON.stringify(box));
    // and it is still the right hand menu, not an overlay: no veil, no round corners, no focus seat of its own
    const seat = await page.evaluate(() => {
      const el = document.getElementById("settings");
      return { veil: !!document.querySelector(".sp-veil"), inVeil: !!el.closest(".sp-veil"),
               radius: getComputedStyle(el).borderRadius, tabindex: el.getAttribute("tabindex") };
    });
    assert.equal(seat.veil, false, "the phone has an overlay veil");
    assert.equal(seat.inVeil, false, "the phone's page sits in a veil");
    assert.equal(seat.radius, "0px", "the phone's page has round corners");
    assert.equal(seat.tabindex, null, "the phone's page took a focus seat");
    const glass = await page.evaluate(() => {
      const style = getComputedStyle(document.getElementById("settings"));
      return { filter: style.backdropFilter, tint: style.backgroundColor, page: document.getElementById("settings").classList.contains("sp-page") };
    });
    assert.equal(glass.page, true, "the phone's settings are not the shared page");
    assert.match(glass.filter, /blur\(15px\)/, "the phone page is not blurred like the note: " + glass.filter);
    assert.equal(glass.tint, "rgba(255, 255, 255, 0.77)");
    assert.deepEqual(await labels(page), ["Editor", "Notifications", "Account", "Diagnostics"]);
    assert.equal(await shown(page, ".sp-list"), true);
    assert.equal(await shown(page, ".sp-panes"), false, "settings show beside the list on a phone");
    assert.equal(await shown(page, ".sp-back"), false);
    assert.equal(await title(page), "Settings");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: the page still turns between its layouts on the window's width", async () => {
  const wider = { width: 1100, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const { page, problems } = await open("/m", wider);
  try {
    await page.evaluate(() => showMenu(settings));
    await page.waitForSelector("#settings.open", { timeout: 5000 });
    await settle(700);
    const box = await cover(page, "#settings");
    assert.ok(box.left <= 0 && box.right >= box.width && box.top <= 0 && box.bottom >= box.height,
      "the phone's page does not cover a wider screen: " + JSON.stringify(box));
    assert.equal(await shown(page, ".sp-panes"), true, "the sections did not stand beside the settings at 1100px");
    await page.setViewport({ ...wider, width: 900 });
    await settle(400);
    assert.equal(await shown(page, ".sp-panes"), false, "the list did not hold at 900px");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone: a section opens on tap, holds its settings, and goes back", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    await openPhone(page);
    const homes = { editor: "#setformat", notifications: "#notify", account: "#signout", diagnostics: "#savediagnostic" };
    for (const [section, control] of Object.entries(homes)) {
      await page.tap(`.sp-item[data-section="${section}"]`);
      await settle(200);
      assert.equal(await shown(page, ".sp-list"), false, section + ": the list stayed under the section");
      assert.equal(await shown(page, "#settings-" + section), true, section + ": the section did not show");
      assert.equal(await page.evaluate(sel => !!document.querySelector(sel).closest(".sp-pane"), control), true,
        section + ": " + control + " is not in its section");
      assert.equal(await shown(page, ".sp-back"), true, section + ": no way back");
      assert.equal(await page.$eval(".sp-back", el => el.getAttribute("aria-label")), "Back to settings");
      await page.tap(".sp-back");
      await settle(200);
      assert.equal(await shown(page, ".sp-list"), true, section + ": back did not return to the list");
      assert.equal(await title(page), "Settings");
    }
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
    await settle(200);
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

test("phone: the close mark and a swipe put the page away, a swipe in a section goes back first", async () => {
  const { page, problems } = await open("/m", PHONE);
  try {
    const out = () => page.evaluate(() => document.getElementById("settings").classList.contains("open"));
    await openPhone(page);
    await page.tap(".sp-close");
    await settle(700);
    assert.equal(await out(), false, "the close mark left the page open");

    await openPhone(page);
    await page.tap('.sp-item[data-section="editor"]');
    await settle(200);
    await swipeRight(page);
    assert.equal(await out(), true, "a swipe inside a section closed the whole page");
    assert.equal(await shown(page, ".sp-list"), true, "a swipe inside a section did not go back to the list");
    assert.equal(await title(page), "Settings");

    await swipeRight(page);
    assert.equal(await out(), false, "a swipe on the list did not put the page away");

    // it opens on the list again
    await openPhone(page);
    assert.equal(await shown(page, ".sp-list"), true);
    assert.equal(await shown(page, ".sp-panes"), false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
