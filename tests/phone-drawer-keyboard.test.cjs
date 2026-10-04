// Opening either drawer lets go of whatever is being typed in, so the
// phone's on-screen keyboard collapses instead of standing over the menu that
// was just pulled out.
//
// Headless checks editor focus release and viewport reconciliation. It does
// not raise a system keyboard; keyboard dismissal needs device confirmation.
//
// WHY THE GESTURES ARE DISPATCHED RATHER THAN DRIVEN. A real pointer press on a
// blank part of the page also moves the focus, which is the browser's doing and
// not the page's, and it would hide whether the page does anything at all. The
// cases below dispatch the touch and mouse events the drag handlers listen for,
// which run the page's own path and leave the browser's default focus handling
// out of it. Those handlers are the real opening path: a pull travels through
// paintMenu and lands through runMenu, and never goes near showMenu.
//
// The board is invented and lives in a temp directory. Nothing here touches the
// real board, the owner's browser or port 8877.
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
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const SHOTS = process.env.DRAWER_KEYBOARD_SHOTS || "";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];

let browser = null;
let child = null;
let fixtureDir = "";
let origin = "";

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function settle(ms = 150) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function card(title, reply) {
  const made = await api("/create?owner=facilitator", title);
  assert.equal(made.status, 200);
  if (reply) await api(`/reply?box=${made.body.id}`, reply);
  return made.body.id;
}

// formatting is written out rather than left to the default, so each case says
// which of the two rows it is about
async function openPhone(id, { formatted }) {
  const page = await browser.newPage();
  const problems = [];
  const sends = [];
  await page.setViewport(PHONE);
  await page.evaluateOnNewDocument(on => {
    try { localStorage.clear(); localStorage.setItem("composeformat", on ? "1" : "0"); } catch (error) {}
  }, !!formatted);
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push("console: " + message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  page.on("request", request => {
    const where = new URL(request.url()).pathname;
    if (where === "/send") sends.push(request.url());
  });
  await page.goto(origin + "/m?box=" + id, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 8000 });
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
  if (formatted) await page.waitForSelector("article.box.sel .cffield", { timeout: 30000 });
  else {
    await settle(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "the row wore an editor with the setting off");
  }
  return { page, problems, sends };
}

// everything the caret question turns on, read the way the page reads it
function caretState(page) {
  return page.evaluate(() => {
    const row = els[selectedId].ta;
    const at = document.activeElement;
    return {
      inRow: ComposeFormat.focused(row),
      editing: editing(),
      active: at ? (at.className || at.tagName) : null,
      value: row.value,
      from: row.selectionStart,
      to: row.selectionEnd,
      drawerOpen: document.getElementById("tickets").classList.contains("open"),
      settingsOpen: document.getElementById("settings").classList.contains("open"),
      dragging: document.body.classList.contains("menudrag"),
      menuOut: document.body.classList.contains("menuout"),
    };
  });
}

// put words in the row and pick some of them out, the way a reader would be
// left mid thought when they reach for the menu
async function typeInRow(page, words, from, to) {
  await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
  await page.keyboard.type(words);
  await page.evaluate(range => els[selectedId].ta.setSelectionRange(range[0], range[1]), [from, to]);
  await settle(120);
  const before = await caretState(page);
  assert.equal(before.inRow, true, "the row never took the caret");
  assert.equal(before.editing, true, "the page did not read the row as being typed in");
  assert.equal(before.value, words);
  assert.deepEqual([before.from, before.to], [from, to], "the fixture could not pick words out");
  return before;
}

// one step of a drag, through the events the page's own handlers listen for.
// a dispatched event carries no default focus behaviour with it, so what these
// show is what the page does and nothing the browser did underneath it
function touchStep(page, kind, x, y) {
  return page.evaluate(step => {
    const target = document.documentElement;
    const options = { bubbles: true, cancelable: true };
    if (step.kind !== "touchend" && step.kind !== "touchcancel") {
      const spot = new Touch({ identifier: 7, target, clientX: step.x, clientY: step.y,
                               pageX: step.x, pageY: step.y });
      options.touches = [spot];
      options.targetTouches = [spot];
      options.changedTouches = [spot];
    }
    target.dispatchEvent(new TouchEvent(step.kind, options));
  }, { kind, x, y });
}

function mouseStep(page, kind, x, y) {
  return page.evaluate(step => {
    document.documentElement.dispatchEvent(new MouseEvent(step.kind, {
      bubbles: true, cancelable: true, button: 0, clientX: step.x, clientY: step.y,
    }));
  }, { kind, x, y });
}

// how far the menu travels from off the page to where it rests, which is what a finger is measured against
function menuWidth(page, which) {
  return page.evaluate(name => menuTravel(name === "settings" ? settings : tickets), which);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-drawer-keyboard-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "drawer keyboard fixture",
    items: [
      { id: "0", bucket: "meta", title: "A standing card", owner: "facilitator",
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
    if (child.exitCode !== null) throw new Error("fixture server exited:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) { ready = true; break; } } catch (error) {}
    await settle(25);
  }
  if (!ready) throw new Error("fixture server did not start:\n" + output);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
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

// ---- the plain row -------------------------------------------------------------------

test("opening the card drawer lets the plain row go, and the words and the caret stay", async () => {
  const id = await card("Plain row and the card list", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    const before = await typeInRow(page, "half a thought, unsent", 5, 10);
    assert.equal(before.active, "TEXTAREA", "the plain row is not a textarea");

    await page.evaluate(() => openDrawer());
    await settle(200);
    const after = await caretState(page);
    assert.equal(after.drawerOpen, true, "the drawer did not open");
    assert.equal(after.inRow, false, "the row kept the caret under the open drawer");
    assert.equal(after.editing, false,
      "the page still reads something as being typed in, which is a keyboard still up");
    assert.equal(after.value, before.value, "the drawer took the words with it");
    assert.deepEqual([after.from, after.to], [before.from, before.to],
      "the drawer moved the caret inside the row");
    await shot(page, "plain-drawer-open");

    // and the row is exactly where it was left when the reader comes back to it
    await page.evaluate(() => { closeDrawer(); els[selectedId].ta.focus({ preventScroll: true }); });
    await settle(200);
    const back = await caretState(page);
    assert.equal(back.inRow, true, "the row would not take the caret back");
    assert.equal(back.value, before.value);
    assert.deepEqual([back.from, back.to], [before.from, before.to],
      "the words came back picked out differently");

    assert.deepEqual(sends, [], "opening a drawer sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("opening settings lets the plain row go as well", async () => {
  const id = await card("Plain row and settings", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    const before = await typeInRow(page, "words left mid thought", 6, 10);

    await page.evaluate(() => showMenu(settings));
    await settle(200);
    const after = await caretState(page);
    assert.equal(after.settingsOpen, true, "settings did not open");
    assert.equal(after.inRow, false, "the row kept the caret under open settings");
    assert.equal(after.editing, false, "the page still reads something as being typed in");
    assert.equal(after.value, before.value, "settings took the words with it");
    assert.deepEqual([after.from, after.to], [before.from, before.to]);

    assert.deepEqual(sends, [], "opening a drawer sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the row wearing its typed formatting --------------------------------------------

test("opening the card drawer lets the formatted row go, and the words and the caret stay", async () => {
  const id = await card("Formatted row and the card list", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: true });
  try {
    const before = await typeInRow(page, "a *word* and **two words**", 2, 8);
    assert.match(before.active, /cm-content/,
      "the formatted row's caret is not in the editor's own content");

    await page.evaluate(() => openDrawer());
    await settle(200);
    const after = await caretState(page);
    assert.equal(after.drawerOpen, true, "the drawer did not open");
    assert.equal(after.inRow, false, "the editor kept the caret under the open drawer");
    assert.equal(after.editing, false, "the page still reads something as being typed in");
    assert.equal(after.value, before.value, "the drawer took the markdown with it");
    assert.deepEqual([after.from, after.to], [before.from, before.to],
      "the drawer moved the caret inside the editor");
    // the editor is still the row's face, and still holds the same words
    const still = await page.evaluate(() => ({
      editors: document.querySelectorAll("article.box.sel .cffield").length,
      drawn: document.querySelector("article.box.sel .cm-content").innerText,
    }));
    assert.equal(still.editors, 1, "the row lost its editor when the drawer opened");
    assert.equal(still.drawn, "a word and two words",
      "the drawn line changed when the drawer opened");
    await shot(page, "formatted-drawer-open");

    assert.deepEqual(sends, [], "opening a drawer sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("opening settings lets the formatted row go as well", async () => {
  const id = await card("Formatted row and settings", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: true });
  try {
    const before = await typeInRow(page, "still ~a cut~ here", 6, 13);

    await page.evaluate(() => showMenu(settings));
    await settle(200);
    const after = await caretState(page);
    assert.equal(after.settingsOpen, true, "settings did not open");
    assert.equal(after.inRow, false, "the editor kept the caret under open settings");
    assert.equal(after.editing, false, "the page still reads something as being typed in");
    assert.equal(after.value, before.value);
    assert.deepEqual([after.from, after.to], [before.from, before.to]);

    assert.deepEqual(sends, [], "opening a drawer sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the pull, which is the way a reader actually opens one --------------------------

test("an edge pull lets the row go as the drawer starts to travel, before it lands", async () => {
  const id = await card("Pulled open by hand", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: true });
  try {
    const before = await typeInRow(page, "mid thought when the list is wanted", 4, 11);
    const width = await menuWidth(page, "tickets");

    // a finger lands on the left edge and has asked for nothing yet
    await touchStep(page, "touchstart", 6, 500);
    await settle(60);
    const resting = await caretState(page);
    assert.equal(resting.inRow, true, "a finger resting on the edge threw the caret away");
    assert.equal(resting.dragging, false, "a touch that has not moved was read as a pull");

    // it travels sideways: that is a pull, and the row lets go here, while the
    // drawer is on its way and has not landed
    await touchStep(page, "touchmove", 6 + Math.round(width * 0.3), 500);
    await settle(60);
    const pulling = await caretState(page);
    assert.equal(pulling.dragging, true, "the sideways travel was not read as a pull");
    assert.equal(pulling.drawerOpen, false,
      "the drawer had already landed, so this proves nothing about the pull itself");
    assert.equal(pulling.menuOut, true, "the drawer was not travelling");
    assert.equal(pulling.inRow, false, "the row kept the caret while the drawer came out");
    assert.equal(pulling.editing, false, "the page still reads something as being typed in");
    assert.equal(pulling.value, before.value, "the pull took the words with it");
    await shot(page, "pull-mid-travel");

    // and it lands open with the words untouched
    await touchStep(page, "touchmove", 6 + Math.round(width * 0.8), 500);
    await touchStep(page, "touchend", 0, 0);
    await settle(250);
    const landed = await caretState(page);
    assert.equal(landed.drawerOpen, true, "the pull did not land the drawer open");
    assert.equal(landed.inRow, false);
    assert.equal(landed.value, before.value);
    assert.deepEqual([landed.from, landed.to], [before.from, before.to]);

    assert.deepEqual(sends, [], "a pull sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull from the right edge opens settings and lets the row go the same way", async () => {
  const id = await card("Settings pulled open by hand", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    const before = await typeInRow(page, "a draft on the way to settings", 2, 7);
    const width = await menuWidth(page, "settings");
    const edge = PHONE.width - 6;

    await touchStep(page, "touchstart", edge, 500);
    await touchStep(page, "touchmove", edge - Math.round(width * 0.3), 500);
    await settle(60);
    const pulling = await caretState(page);
    assert.equal(pulling.dragging, true, "the sideways travel was not read as a pull");
    assert.equal(pulling.settingsOpen, false, "settings had already landed");
    assert.equal(pulling.inRow, false, "the row kept the caret while settings came out");
    assert.equal(pulling.editing, false);
    assert.equal(pulling.value, before.value);

    await touchStep(page, "touchmove", edge - Math.round(width * 0.8), 500);
    await touchStep(page, "touchend", 0, 0);
    await settle(250);
    const landed = await caretState(page);
    assert.equal(landed.settingsOpen, true, "the pull did not land settings open");
    assert.equal(landed.inRow, false);
    assert.equal(landed.value, before.value);

    assert.deepEqual(sends, [], "a pull sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the mouse a desktop browser opens this page with pulls it open the same way", async () => {
  const id = await card("Pulled open with a pointer", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    const before = await typeInRow(page, "typed before the pull", 3, 9);
    const width = await menuWidth(page, "tickets");

    await mouseStep(page, "mousedown", 6, 500);
    await mouseStep(page, "mousemove", 6 + Math.round(width * 0.7), 500);
    await settle(60);
    const pulling = await caretState(page);
    assert.equal(pulling.dragging, true, "the pointer travel was not read as a pull");
    assert.equal(pulling.inRow, false, "the row kept the caret while the drawer came out");
    assert.equal(pulling.value, before.value);

    await mouseStep(page, "mouseup", 6 + Math.round(width * 0.7), 500);
    await settle(250);
    const landed = await caretState(page);
    assert.equal(landed.drawerOpen, true, "the pointer pull did not land the drawer open");
    assert.equal(landed.inRow, false);
    assert.equal(landed.value, before.value);

    assert.deepEqual(sends, [], "a pull sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull let go before the middle keeps the caret away, since the menu was on its way out", async () => {
  const id = await card("Pulled and let go", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    const before = await typeInRow(page, "a draft and a change of mind", 2, 8);
    const width = await menuWidth(page, "tickets");

    await touchStep(page, "touchstart", 6, 500);
    await touchStep(page, "touchmove", 6 + Math.round(width * 0.2), 500);
    await settle(60);
    assert.equal((await caretState(page)).inRow, false,
      "the row kept the caret while the drawer came out");
    await touchStep(page, "touchend", 0, 0);
    await settle(250);

    // the menu goes back, and the row is not grabbed at again on the way: the
    // reader put the caret there and only the reader puts it back
    const back = await caretState(page);
    assert.equal(back.drawerOpen, false, "a pull let go early still landed the drawer open");
    assert.equal(back.inRow, false, "closing the menu took the caret back on its own");
    assert.equal(back.value, before.value, "the words did not survive the pull");
    assert.deepEqual([back.from, back.to], [before.from, before.to]);

    assert.deepEqual(sends, []);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- what must NOT take the caret ----------------------------------------------------

test("a finger on the edge and a scroll down the page both leave the caret where it is", async () => {
  const id = await card("Touched but not pulled", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: true });
  try {
    const before = await typeInRow(page, "a thought nobody interrupted", 2, 9);

    // resting on the edge
    await touchStep(page, "touchstart", 4, 500);
    await settle(60);
    assert.equal((await caretState(page)).inRow, true, "a resting finger threw the caret away");

    // a twitch too small to be a pull
    await touchStep(page, "touchmove", 7, 501);
    await settle(60);
    let now = await caretState(page);
    assert.equal(now.inRow, true, "a twitch on the edge threw the caret away");
    assert.equal(now.dragging, false, "a twitch was read as a pull");

    // and a scroll straight down the page, which is not a menu at all
    await touchStep(page, "touchmove", 6, 560);
    await settle(60);
    now = await caretState(page);
    assert.equal(now.inRow, true, "a scroll down the page threw the caret away");
    assert.equal(now.dragging, false, "a scroll was read as a pull");
    assert.equal(now.drawerOpen, false);

    // sideways afterwards changes nothing: the scroll already ended the gesture
    await touchStep(page, "touchmove", 200, 560);
    await touchStep(page, "touchend", 0, 0);
    await settle(200);
    const after = await caretState(page);
    assert.equal(after.inRow, true, "the gesture that was a scroll still took the caret");
    assert.equal(after.drawerOpen, false, "a scroll opened the drawer");
    assert.equal(after.value, before.value);
    assert.deepEqual([after.from, after.to], [before.from, before.to]);

    assert.deepEqual(sends, []);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("closing a menu never reaches for the caret", async () => {
  const id = await card("Closing takes nothing", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    await typeInRow(page, "a draft under an open drawer", 4, 9);
    await page.evaluate(() => openDrawer());
    await settle(200);
    assert.equal((await caretState(page)).inRow, false, "the drawer left the caret in the row");

    // the reader puts it back by hand while the drawer is still out, and the
    // closing run must leave it exactly there
    await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
    await settle(100);
    assert.equal((await caretState(page)).inRow, true, "the row would not take the caret back");
    await page.evaluate(() => closeDrawer());
    await settle(250);
    const after = await caretState(page);
    assert.equal(after.drawerOpen, false, "the drawer did not close");
    assert.equal(after.inRow, true, "closing the drawer took the caret out of the row");
    assert.equal(after.editing, true, "closing the drawer stopped the row being typed in");

    assert.deepEqual(sends, []);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the card's name, which is typed in too ------------------------------------------

test("opening the drawer while naming a card hands the name over and lets the title go", async () => {
  const id = await card("The name before it changed", "A reply to answer.");
  const { page, problems, sends } = await openPhone(id, { formatted: false });
  try {
    await page.evaluate(cardId => editTitle(cardId), id);
    await page.keyboard.type("The name after it changed");
    await settle(120);
    const naming = await page.evaluate(() => ({
      editing: editing(),
      titleFocused: document.activeElement === els[selectedId].titleEl,
      text: els[selectedId].titleEl.textContent,
    }));
    assert.equal(naming.titleFocused, true, "the title never took the caret");
    assert.equal(naming.editing, true, "the page did not read the title as being typed in");
    assert.equal(naming.text, "The name after it changed");

    // the name lands the way any other blur lands it, which is what the title's
    // own handler has always done when the reader goes elsewhere
    // a short wait on purpose: a page that never lets the title go never posts
    // the name, and that should read as this case failing rather than as a run
    // that hangs
    const named = page.waitForResponse(
      response => new URL(response.url()).pathname === "/title", { timeout: 8000 });
    await page.evaluate(() => openDrawer());
    assert.equal((await named).status(), 200, "the name was not handed over");
    await settle(250);
    const after = await page.evaluate(() => ({
      editing: editing(),
      titleFocused: document.activeElement === els[selectedId].titleEl,
      contentEditable: els[selectedId].titleEl.isContentEditable,
      drawerOpen: document.getElementById("tickets").classList.contains("open"),
      text: els[selectedId].titleEl.textContent,
    }));
    assert.equal(after.drawerOpen, true, "the drawer did not open");
    assert.equal(after.titleFocused, false, "the title kept the caret under the open drawer");
    assert.equal(after.editing, false,
      "the page still reads something as being typed in, which is a keyboard still up");
    assert.equal(after.contentEditable, false, "the title was left open for typing");
    assert.equal(after.text, "The name after it changed", "the name was not the one typed");
    await shot(page, "title-drawer-open");

    assert.deepEqual(sends, [], "opening a drawer sent a message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
