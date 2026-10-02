// The composer's typed formatting, driven headless against its own fixture
// board on all three card surfaces: the desktop card, the small card beside it,
// the phone card and the typed page's reply line.
//
// What is being proved is the behaviour that was asked for, not the shape of
// the editor underneath it. Every check types or presses the way a reader does,
// reads the words the row will actually send, and looks at what is drawn.
//
// The board is invented and lives in a temp directory. Nothing here touches the
// real board, the owner's browser or port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const SHOTS = process.env.COMPOSE_FORMAT_SHOTS || "";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const KEYBOARD = 336;                     // an iPhone keyboard with its accessory bar, in css px
const ROW = "article.box.sel textarea";   // the card's typing row, whichever face it wears
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

async function sentTexts(id) {
  const state = await (await fetch(origin + "/state")).json();
  const box = state.boxes.find(entry => entry.id === id);
  return (box && box.pendingTexts) || [];
}

// every card an earlier check left is put out of the doing view, so each one
// walks only the cards it made itself
async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

function settle(ms = 120) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function open(route, viewport, opts = {}) {
  const page = await browser.newPage();
  const problems = [];
  await page.setViewport(viewport);
  // each page starts where a browser that has never been opened starts, and only
  // on its first document: a reload inside a check is one of the things being
  // asked about, so it must find what the page itself wrote down. The desktop
  // pages keep the choice with the board's settings and the phone keeps its
  // own, so the case's choice goes to both
  await fetch(origin + "/settings", { method: "POST",
    body: JSON.stringify({ composeformat: opts.setting === undefined ? null : opts.setting }) });
  await page.evaluateOnNewDocument(setting => {
    try {
      if (sessionStorage.getItem("compose-format-check")) return;
      sessionStorage.setItem("compose-format-check", "1");
      localStorage.clear();
      if (setting !== null) localStorage.setItem("composeformat", setting);
    } catch (error) {}
  }, opts.setting === undefined ? null : opts.setting);
  if (opts.fakeViewport) await page.evaluateOnNewDocument(fakeViewport);
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

// the stand-in visual viewport the phone's keyboard is played with, the same
// one the phone keyboard checks use
function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"])
    Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height; geom.offsetTop = offsetTop; geom.scale = scale;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
}

async function pickDesktopCard(page, id) {
  await page.waitForFunction(cardId => !!els[cardId], { timeout: 10000 }, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
}

async function editorOn(page, selector = "article.box.sel .cffield") {
  await page.waitForSelector(selector, { timeout: 30000 });
}

// what the row holds and what is drawn on it
function drawn(page) {
  return page.evaluate(() => {
    const row = document.querySelector("article.box.sel textarea");
    const content = document.querySelector("article.box.sel .cm-content");
    const text = node => node.textContent;
    return {
      payload: row.value,
      shown: content ? content.innerText : row.value,
      italic: content ? [...content.querySelectorAll(".cf-em")].map(text) : [],
      bold: content ? [...content.querySelectorAll(".cf-strong")].map(text) : [],
      struck: content ? [...content.querySelectorAll(".cf-strike")].map(text) : [],
      quoted: content ? [...content.querySelectorAll(".cf-quote")].map(node => node.innerText) : [],
      bullets: content ? content.querySelectorAll(".cf-bullet").length : 0,
    };
  });
}

async function chord(page, key, ...modifiers) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

async function shot(page, name, clip) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), ...(clip ? { clip } : {}) });
}

// the box the row is drawn in, read the way the card's own code reads it
function rowBox(page) {
  return page.evaluate(() => {
    const row = document.querySelector("article.box.sel textarea");
    const send = document.querySelector("article.box.sel .sendbtn");
    const rect = row.getBoundingClientRect();
    const style = getComputedStyle(row);
    return {
      height: Math.round(rect.height), top: Math.round(rect.top),
      left: Math.round(rect.left), right: Math.round(rect.right),
      lineHeight: style.lineHeight, fontSize: style.fontSize,
      seat: send ? send.style.marginBottom : "",
    };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-compose-format-"));
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
  // a board that has formatting on for a browser that has chosen nothing; the
  // default a board ships with is off and is covered by the format-default checks
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ compose_format_default: true }));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "compose formatting fixture",
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

// ---- the desktop card ----------------------------------------------------------------

test("the desktop row draws the five forms and sends the markdown itself", async () => {
  await clearLane();
  const id = await card("Desktop formatting", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.focus(ROW);
    // the strike is the two tilde form the sent card reads, and one pair is
    // words with two tildes in them and nothing more
    await page.keyboard.type("a *word*, **two words**, ~~a cut~~, ~not cut~ and plain");
    await settle();
    const typed = await drawn(page);
    assert.equal(typed.payload, "a *word*, **two words**, ~~a cut~~, ~not cut~ and plain",
      "the row did not keep the markdown that was typed");
    assert.deepEqual(typed.italic, ["word"], "one star did not italicise its word");
    assert.deepEqual(typed.bold, ["two words"], "two stars did not embolden their words");
    assert.deepEqual(typed.struck, ["a cut"],
      "two tildes on either side did not strike their words, or one pair struck words of its own");
    assert.equal(typed.shown, "a word, two words, a cut, ~not cut~ and plain",
      "the markers were left standing in the drawn line, or the lone pair of tildes was taken " +
      "away from words nobody asked to strike: " + typed.shown);
    // and they are really drawn, not merely marked
    const faces = await page.evaluate(() => {
      const content = document.querySelector("article.box.sel .cm-content");
      const of = selector => {
        const node = content.querySelector(selector);
        const style = getComputedStyle(node);
        return { style: style.fontStyle, weight: Number(style.fontWeight),
                 line: style.textDecorationLine };
      };
      return { em: of(".cf-em"), strong: of(".cf-strong"), strike: of(".cf-strike") };
    });
    assert.equal(faces.em.style, "italic", "the italic span was not drawn in italic");
    assert.ok(faces.strong.weight >= 600, "the bold span was not drawn heavier");
    assert.match(faces.strike.line, /line-through/, "the struck span was not drawn struck");
    await shot(page, "desktop-inline");

    // the send is the card's own key, and what leaves is the markdown
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(300);
    assert.equal((await sentTexts(id)).slice(-1)[0],
      "a *word*, **two words**, ~~a cut~~, ~not cut~ and plain",
      "the board was sent something other than the markdown in the row");
    assert.equal(await page.$eval(ROW, row => row.value), "", "the row kept the words it sent");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a quote bar, bullets, a carried marker and an empty bullet that ends the list", async () => {
  await clearLane();
  const id = await card("Desktop blocks", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type("> a quoted line");
    await chord(page, "Enter", "Shift");
    await page.keyboard.type("- first");
    await chord(page, "Enter", "Shift");            // the marker is carried down
    await page.keyboard.type("second");
    await settle();
    const list = await drawn(page);
    assert.equal(list.payload, "> a quoted line\n- first\n- second",
      "the new line did not carry the bullet");
    assert.deepEqual(list.quoted, ["a quoted line"], "the angle did not draw a quoted line");
    assert.equal(list.bullets, 2, "the dashes were not drawn as bullets");
    const bar = await page.evaluate(() => {
      const line = document.querySelector("article.box.sel .cm-quote, article.box.sel .cf-quote");
      const style = getComputedStyle(line);
      return { width: style.borderLeftWidth, pad: style.paddingLeft, text: line.innerText };
    });
    assert.ok(parseFloat(bar.width) >= 2, "the quoted line carries no bar");
    assert.equal(bar.text, "a quoted line", "the angle was left standing in the quoted line");
    await shot(page, "desktop-blocks");

    // an empty bullet ends the list rather than laying another one out
    await chord(page, "Enter", "Shift");
    assert.equal(await page.$eval(ROW, row => row.value), "> a quoted line\n- first\n- second\n- ",
      "the empty new line did not start a bullet of its own");
    await chord(page, "Enter", "Shift");
    assert.equal(await page.$eval(ROW, row => row.value), "> a quoted line\n- first\n- second\n",
      "the empty bullet did not end the list");
    // an ordinary line still breaks plainly
    await page.keyboard.type("plain again");
    await chord(page, "Enter", "Shift");
    assert.equal(await page.$eval(ROW, row => row.value),
      "> a quoted line\n- first\n- second\nplain again\n",
      "a new line after plain words started a list nobody asked for");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the setting follows a board that turns it on, turns off to a plain field and keeps the draft either way", async () => {
  await clearLane();
  const id = await card("Desktop setting", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  const words = "keep *these* bytes\n- and this bullet";
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    assert.equal(await page.evaluate(() => (globalThis.boardSettings || localStorage).getItem("composeformat")), null,
      "the setting wrote itself down before anybody touched it");
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), true,
      "the setting did not stand on from the board's default");
    assert.equal(await page.evaluate(() => document.getElementById("setformat").checked), true,
      "the settings panel did not show the setting on");

    await page.focus(ROW);
    await page.keyboard.type("keep *these* bytes");
    await chord(page, "Enter", "Shift");   // the return key is this row's send
    await page.keyboard.type("- and this bullet");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), words, "the draft was not laid out");
    const on = await rowBox(page);

    // off: the row is the plain field again, with the same words and the same box
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await settle(200);
    const off = await page.evaluate(() => ({
      payload: document.querySelector("article.box.sel textarea").value,
      editors: document.querySelectorAll(".cffield").length,
      tag: document.activeElement.tagName,
      mirror: document.querySelector("article.box.sel textarea").classList.contains("cfmirror"),
      stored: (globalThis.boardSettings || localStorage).getItem("composeformat"),
      checked: document.getElementById("setformat").checked,
    }));
    assert.equal(off.payload, words, "the draft did not come back byte for byte");
    assert.equal(off.editors, 0, "an editor was left standing with the setting off");
    assert.equal(off.mirror, false, "the plain row was left wearing the editor's mirror");
    assert.equal(off.tag, "TEXTAREA", "the caret did not come back to the plain field");
    assert.equal(off.stored, "0");
    assert.equal(off.checked, false);
    const plainBox = await rowBox(page);
    assert.deepEqual(
      { h: plainBox.height, t: plainBox.top, l: plainBox.left, r: plainBox.right, s: plainBox.seat },
      { h: on.height, t: on.top, l: on.left, r: on.right, s: on.seat },
      "the row moved when the setting changed");
    // and it is a working plain field
    await page.focus(ROW);
    await page.keyboard.type(" typed plainly");
    assert.equal(await page.$eval(ROW, row => row.value), words + " typed plainly");
    await shot(page, "desktop-plain");

    // the words the reader had selected, the lane, the list and the page are
    // all the same on the other side of the change
    const before = await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.setSelectionRange(5, 16);
      return { owner: activeOwner, view: curView(), card: selectedId,
               page: curPage(lastState, activeOwner)?.id || null,
               start: row.selectionStart, end: row.selectionEnd,
               picked: row.value.slice(row.selectionStart, row.selectionEnd) };
    });
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await editorOn(page);
    await settle(200);
    const after = await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      return { owner: activeOwner, view: curView(), card: selectedId,
               page: curPage(lastState, activeOwner)?.id || null,
               start: row.selectionStart, end: row.selectionEnd,
               picked: row.value.slice(row.selectionStart, row.selectionEnd) };
    });
    assert.deepEqual(after, before, "the change of setting moved something it had no business moving");
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await settle(200);

    // on again: the same words, drawn again. the caret is taken off the span
    // first, since a span the caret is in or beside keeps its markers on show
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await editorOn(page);
    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.setSelectionRange(row.value.length, row.value.length);
    });
    await settle(150);
    const back = await drawn(page);
    assert.equal(back.payload, words + " typed plainly", "turning the setting back on lost words");
    assert.deepEqual(back.italic, ["these"], "the words were not drawn again");

    // and the choice is kept across a reload, with the board's settings
    await page.waitForFunction(() => !globalThis.boardSettings || !boardSettings.busy);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => (globalThis.boardSettings || localStorage).getItem("composeformat")), "1",
      "the setting did not keep the reader's word");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("undo and redo are the row's own, and no board command answers the chord", async () => {
  await clearLane();
  const first = await card("Undo source", "A reply to answer.");
  const second = await card("Undo neighbour", "Another reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, first);
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type("first run");
    await settle(700);              // past the editor's own grouping window
    await page.keyboard.type(" second run");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "first run second run");

    await chord(page, "z", "Meta");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "first run",
      "the chord did not undo the words the row had just taken");
    assert.equal(await page.evaluate(() => selectedId), first,
      "an undo chord moved the board instead of the words");
    await chord(page, "z", "Meta");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "",
      "a second undo did not reach the first run of words");
    await chord(page, "z", "Meta", "Shift");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "first run",
      "the shifted chord did not redo");
    await chord(page, "z", "Meta", "Shift");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "first run second run");
    assert.equal(await page.evaluate(() => selectedId), first,
      "a redo chord moved the board");

    // the card the board is not on kept its own row, and the chord never
    // reached the board's own commands at all
    assert.equal(await page.$eval(`#box-${second} textarea`, row => row.value), "",
      "the chord put words into a card nobody was typing in");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pasted block lands whole, and a composing key never sends", async () => {
  await clearLane();
  const id = await card("Paste and compose", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.focus(ROW);
    // a paste of several lines, markers and all
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/plain", "**one**\n- two\n- three");
      document.querySelector("article.box.sel .cm-content").dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "**one**\n- two\n- three",
      "the pasted block did not land whole");
    const pasted = await drawn(page);
    assert.deepEqual(pasted.bold, ["one"], "the pasted markdown was not drawn");
    assert.equal(pasted.bullets, 2, "the pasted bullets were not drawn");

    // A key pressed while an input method is composing belongs to the method.
    // The composition is a real one, driven through the browser, because the
    // composing flag on a made-up keyboard event is not the browser's word.
    //
    // What is asked of the page is that it keeps its hands off: no send, and no
    // new line of its own. The line break the browser itself puts in is not
    // asked about, because a composition driven from outside has no real input
    // method behind it to swallow that key, and a real one does.
    const cdp = await page.target().createCDPSession();
    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = "- a bullet";
      row.setSelectionRange(row.value.length, row.value.length);
    });
    await page.focus(ROW);
    await settle(150);
    await cdp.send("Input.imeSetComposition",
      { text: "\u306b\u307b", selectionStart: 2, selectionEnd: 2 });
    await settle(200);
    const composing = await page.$eval(ROW, row => row.value);
    assert.equal(composing, "- a bullet\u306b\u307b",
      "the input method's marks never reached the row: " + composing);
    await page.keyboard.press("Enter");
    await settle(250);
    assert.deepEqual(sends, [], "a composing Enter sent the half-written words");
    const afterCompose = await page.$eval(ROW, row => row.value);
    assert.ok(afterCompose.startsWith("- a bullet\u306b\u307b"),
      "a composing Enter changed the words the method had written: " + afterCompose);
    assert.equal(/\n-\s/.test(afterCompose), false,
      "a composing Enter carried a bullet down, which is the page answering a key that was not its own");
    await cdp.detach();
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a send that fails keeps the words, and an attachment still joins them", async () => {
  await clearLane();
  const id = await card("Failed send", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.setRequestInterception(true);
    const refuse = request => {
      if (new URL(request.url()).pathname === "/send") return request.abort();
      return request.continue();
    };
    page.on("request", refuse);
    await page.focus(ROW);
    await page.keyboard.type("words that will not go");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const note = document.querySelector("article.box.sel .meta span");
      return !!note && note.textContent.length > 0;
    }, { timeout: 8000 });
    assert.equal(await page.$eval(ROW, row => row.value), "words that will not go",
      "a failed send lost the words it could not deliver");
    // the refusal is taken off before the interception is, or a request still on
    // its way reaches a handler with nothing left to answer it
    page.off("request", refuse);
    await page.setRequestInterception(false);

    // the upload road still puts its address into the row
    const address = await page.evaluate(async () => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = "";
      // the board reads a file's kind from its first bytes, so these are a PNG's
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
      await attach([new File([png], "shot.png", { type: "image/png" })], row);
      return row.value;
    });
    assert.match(address, /^\/uploads\/.+\n$/, "the attachment did not join the row: " + address);
    // the refused send is this check's own doing and reports itself as one
    assert.deepEqual(problems.filter(note => !/net::ERR_FAILED/.test(note)), []);
  } finally {
    await page.close();
  }
});

test("the small card beside the big one formats and sends the same way", async () => {
  await clearLane();
  const id = await card("Small card formatting", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  const MINI = "#magic2 .mbox:not(.off) textarea";
  try {
    await page.waitForFunction(() => miniOrder.length > 0, { timeout: 10000 });
    await page.evaluate(cardId => { miniGo(cardId); renderMiniCards(lastState); }, id);
    await page.waitForSelector("#magic2 .mbox:not(.off) .cffield", { timeout: 30000 });
    await page.focus(MINI);
    await page.keyboard.type("small *card* words");
    await settle();
    assert.equal(await page.$eval(MINI, row => row.value), "small *card* words");
    const mini = await page.evaluate(() => {
      const content = document.querySelector("#magic2 .mbox:not(.off) .cm-content");
      return { shown: content.innerText, italic: content.querySelectorAll(".cf-em").length };
    });
    assert.equal(mini.italic, 1, "the small card did not draw its markdown");
    assert.equal(mini.shown, "small card words");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname.startsWith("/send"));
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(300);
    assert.equal((await sentTexts(id)).slice(-1)[0], "small *card* words",
      "the small card sent something other than the markdown in it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the board's own file navigator and the card row keep separate words and separate undo", async () => {
  // the panel mounts on the lane that carries one, so the card is made there too
  const made = await api("/create?owner=pastureland", "Panel and row");
  const id = made.body.id;
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await open("/?project=pastureland", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    // the workspace panel's own editor, opened on an invented file
    await page.evaluate(async () => {
      fileNavBoxes();
      const host = fileNavBuild(FILENAV_MOUNTS.pastureland);
      host.style.left = "32px"; host.style.top = "32px";
      host.style.width = "340px"; host.style.height = "320px";
      if (!await fileNavBundle()) throw new Error("the editor bundle did not load");
      fileNavFor = "pastureland";
      fileNavOpen = { lane: "pastureland", root: "fixture-internal", rel: "fixture.md", mtime: "1" };
      fileNavClean = "panel words";
      fileNavMount(host, "panel words", false);
      host.classList.add("editing");
    });
    await page.click(".fnavedit .cm-content");
    await page.keyboard.type(" typed in the panel");
    await settle();
    assert.equal(await page.evaluate(() => fileNavView.state.sliceDoc()), "panel words typed in the panel");
    assert.equal(await page.$eval(ROW, row => row.value), "", "the panel's words reached the card row");

    await page.focus(ROW);
    await page.keyboard.type("row words");
    await settle();
    assert.equal(await page.evaluate(() => fileNavView.state.sliceDoc()), "panel words typed in the panel",
      "the row's words reached the panel");
    assert.equal(await page.evaluate(() => fileNavView.hasFocus), false,
      "both editors believed they had the caret");

    // undo in the row takes back the row's words and leaves the panel alone
    await chord(page, "z", "Meta");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "", "the row's undo took nothing back");
    assert.equal(await page.evaluate(() => fileNavView.state.sliceDoc()), "panel words typed in the panel",
      "the row's undo reached into the panel");
    // and undo in the panel takes back the panel's words and leaves the row alone
    await page.click(".fnavedit .cm-content");
    await chord(page, "z", "Meta");
    await settle();
    assert.equal(await page.evaluate(() => fileNavView.state.sliceDoc()), "panel words",
      "the panel's undo took nothing back");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the board's settings page opens as an overlay over the board, works and closes", async () => {
  await clearLane();
  const id = await card("Settings page", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.click("#setbtn");
    await settle(250);
    await page.click('.sp-item[data-section="editor"]');
    await settle(100);
    const out = await page.evaluate(() => {
      const view = document.querySelector(".sp-page");
      const mark = document.getElementById("setbtn");
      const rect = view.getBoundingClientRect();
      const middle = document.elementFromPoint(Math.round(rect.left + rect.width / 2),
                                               Math.round(rect.top + rect.height / 2));
      return {
        open: document.body.classList.contains("setopen"),
        shown: getComputedStyle(view.closest(".sp-veil")).display,
        onTop: !!middle && view.contains(middle),
        centredAtSeventhTenths: Math.abs(rect.width / document.documentElement.clientWidth - 0.7) < 0.01
          && Math.abs(rect.height / document.documentElement.clientHeight - 0.7) < 0.01
          && Math.abs(rect.left - (document.documentElement.clientWidth - rect.right)) <= 1
          && Math.abs(rect.top - (document.documentElement.clientHeight - rect.bottom)) <= 1,
        label: view.querySelector(".sp-pane.on .setrow span").textContent,
        checked: document.getElementById("setformat").checked,
        expanded: mark.getAttribute("aria-expanded"),
      };
    });
    assert.equal(out.open, true, "the mark did not open the page");
    assert.equal(out.shown, "block");
    assert.equal(out.onTop, true, "the page was drawn under the board it opens over");
    assert.equal(out.centredAtSeventhTenths, true, "the page is not a centred overlay at about 70% of the window");
    assert.equal(out.label, "Format text while typing");
    assert.equal(out.checked, true);
    assert.equal(out.expanded, "true");
    await shot(page, "desktop-settings");

    // the row follows the mark
    await page.click("#setformat");
    await settle(250);
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), false,
      "the page's mark did not turn the setting off");
    await page.click("#setformat");
    await settle(250);
    assert.equal(await page.evaluate(() => ComposeFormat.enabled()), true);

    // and it closes on the red window button, and on escape, and hands the focus back to its mark
    await page.click(".sp-red");
    await settle(200);
    assert.equal(await page.evaluate(() => document.body.classList.contains("setopen")), false,
      "the red button left the page open");
    assert.equal(await page.evaluate(() => document.activeElement.id), "setbtn");
    await page.click("#setbtn");
    await settle(200);
    await page.keyboard.press("Escape");
    await settle(200);
    assert.equal(await page.evaluate(() => document.body.classList.contains("setopen")), false,
      "escape left the page open");
    await editorOn(page);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- what the reader had picked out --------------------------------------------------
// A draft's bytes surviving a change of face is half of it. The other half is
// the passage the reader had picked out, which is a different thing on each of
// the two kinds of field: a textarea keeps a selection of its own in
// characters, and a line the page writes in has no selection at all, only the
// document's one selection held as nodes and offsets.

test("a picked out passage survives the change of face, both ways and either way round", async () => {
  await clearLane();
  const id = await card("Selection continuity", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP, { setting: "0" });
  const words = "keep these words selected";
  try {
    await pickDesktopCard(page, id);
    await settle(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "the row was already an editor with the setting off");
    const read = () => page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      return { from: row.selectionStart, to: row.selectionEnd,
               way: row.selectionDirection, picked: row.value.slice(row.selectionStart, row.selectionEnd),
               payload: row.value };
    });

    // picked out in the plain field, then the setting goes on
    await page.focus(ROW);
    await page.keyboard.type(words);
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(5, 10);
    });
    const beforeOn = await read();
    assert.equal(beforeOn.picked, "these");
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await editorOn(page);
    await settle(200);
    const onNow = await read();
    assert.deepEqual({ from: onNow.from, to: onNow.to, picked: onNow.picked, payload: onNow.payload },
      { from: 5, to: 10, picked: "these", payload: words },
      "turning the setting on lost the passage the reader had picked out");

    // picked out in the editor, then the setting goes off
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(11, 16);
    });
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await page.waitForFunction(() => document.querySelectorAll(".cffield").length === 0,
      { timeout: 10000 });
    await settle(150);
    const offNow = await read();
    assert.deepEqual({ from: offNow.from, to: offNow.to, picked: offNow.picked, payload: offNow.payload },
      { from: 11, to: 16, picked: "words", payload: words },
      "turning the setting off lost the passage the reader had picked out");

    // and the way round the reader made it, where the field can say so
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(5, 10, "backward");
    });
    assert.equal((await read()).way, "backward", "the fixture could not make a backward selection");
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await editorOn(page);
    await settle(200);
    const backwards = await read();
    assert.deepEqual({ from: backwards.from, to: backwards.to, way: backwards.way },
      { from: 5, to: 10, way: "backward" },
      "the passage came back the other way round");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a passage picked out before a slow editor arrives is still picked out after it", async () => {
  await clearLane();
  const id = await card("Selection before the editor", "A reply to answer.");
  const page = await browser.newPage();
  const problems = [];
  try {
    await page.setViewport(DESKTOP);
    await page.evaluateOnNewDocument(() => {
      try {
        if (sessionStorage.getItem("compose-format-check")) return;
        sessionStorage.setItem("compose-format-check", "1");
        localStorage.clear();
      } catch (error) {}
    });
    // the editor is held back long enough for the reader to be typing in the
    // plain field it starts as, which is the race a real slow first load is
    await page.setRequestInterception(true);
    const slow = request => {
      if (new URL(request.url()).pathname === "/cm-markdown.js") {
        setTimeout(() => request.continue().catch(() => {}), 1500);
        return;
      }
      request.continue().catch(() => {});
    };
    page.on("request", slow);
    page.on("pageerror", error => problems.push("pageerror: " + error.message));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
      { timeout: 15000 });
    await pickDesktopCard(page, id);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "the editor arrived before the words did, so this proves nothing");
    await page.focus(ROW);
    await page.keyboard.type("typed before the editor landed");
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 12);
    });
    const before = await page.$eval(ROW, row => ({
      from: row.selectionStart, to: row.selectionEnd,
      picked: row.value.slice(row.selectionStart, row.selectionEnd) }));
    assert.equal(before.picked, "before");
    await editorOn(page);
    await settle(250);
    const after = await page.$eval(ROW, row => ({
      from: row.selectionStart, to: row.selectionEnd,
      picked: row.value.slice(row.selectionStart, row.selectionEnd), payload: row.value }));
    assert.deepEqual(after, { from: 6, to: 12, picked: "before",
      payload: "typed before the editor landed" },
      "the editor landing on a reader mid selection took the passage away");
    page.off("request", slow);
    await page.setRequestInterception(false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the typed page's line keeps its picked out passage across the change of face", async () => {
  await clearLane();
  const id = await card("Typed page selection", "A reply to answer.");
  const { page, problems } = await open("/page", DESKTOP, { setting: "0" });
  const LINE = `.docsec[data-id="${id}"] .docreply`;
  const words = "keep these words selected";
  try {
    await page.waitForFunction(cardId => !!docEls[cardId], { timeout: 10000 }, id);
    await page.evaluate(cardId => docSelect(cardId), id);
    await page.waitForSelector(LINE, { timeout: 10000 });
    await settle(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "the line was already an editor with the setting off");
    // a line the page writes in has no selection of its own: what is picked out
    // in it is the document's one selection
    const pick = (selector, from, to) => page.evaluate((sel, a, b) => {
      const node = document.querySelector(sel);
      node.focus();
      const text = node.firstChild || node;
      const range = document.createRange();
      range.setStart(text, a);
      range.setEnd(text, b);
      const picked = getSelection();
      picked.removeAllRanges();
      picked.addRange(range);
    }, selector, from, to);
    const read = () => page.evaluate(sel => {
      const node = document.querySelector(sel);
      const picked = getSelection();
      const inside = picked.rangeCount > 0 && node.contains(picked.anchorNode) &&
        node.contains(picked.focusNode);
      return { picked: inside ? picked.toString() : "", payload: node.textContent };
    }, LINE);

    await page.focus(LINE);
    await page.keyboard.type(words);
    await pick(LINE, 5, 10);
    assert.deepEqual(await read(), { picked: "these", payload: words });

    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await page.waitForSelector(`.docsec[data-id="${id}"] .cfline`, { timeout: 30000 });
    await settle(250);
    const on = await page.evaluate(sel => {
      const node = document.querySelector(sel);
      const view = ComposeFormat.fieldOf(node).view;
      const at = view.state.selection.main;
      return { picked: view.state.sliceDoc(at.from, at.to), payload: node.textContent };
    }, LINE);
    assert.deepEqual(on, { picked: "these", payload: words },
      "turning the setting on lost the line's picked out passage");

    // and back the other way
    await page.evaluate(sel => {
      ComposeFormat.fieldOf(document.querySelector(sel)).view
        .dispatch({ selection: { anchor: 11, head: 16 } });
    }, LINE);
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await page.waitForFunction(() => document.querySelectorAll(".cffield").length === 0,
      { timeout: 10000 });
    await settle(200);
    assert.deepEqual(await read(), { picked: "words", payload: words },
      "turning the setting off lost the line's picked out passage");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the phone card ------------------------------------------------------------------

test("the phone row makes a line under its keyboard and sends without it", async () => {
  await clearLane();
  const id = await card("Phone formatting", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE, { fakeViewport: true });
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    await page.focus(ROW);
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height - KEYBOARD);
    await settle(600);
    assert.equal(await page.evaluate(() => document.body.classList.contains("kb")), true,
      "the on-screen keyboard was not read as up");

    // with the keyboard up the return key is a new line, and it carries a bullet
    await page.keyboard.type("- one");
    await page.keyboard.press("Enter");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "- one\n- ",
      "the return key did not carry the bullet under the keyboard");
    await page.keyboard.type("two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settle();
    assert.equal(await page.$eval(ROW, row => row.value), "- one\n- two\n",
      "the empty bullet did not end the list under the keyboard");
    assert.deepEqual(sends, [], "the return key sent while the keyboard was up");

    // the drawn line, and the markdown under it. the phone reads a strike the
    // way the card it sends to does: two tildes, and one pair left standing
    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = "a *word* and **two words** and ~~a cut~~ and ~not cut~";
    });
    await settle(250);
    const phone = await drawn(page);
    assert.equal(phone.payload, "a *word* and **two words** and ~~a cut~~ and ~not cut~");
    assert.deepEqual(phone.italic, ["word"]);
    assert.deepEqual(phone.bold, ["two words"]);
    assert.deepEqual(phone.struck, ["a cut"],
      "the phone struck one pair of tildes, or left two pairs unstruck");
    assert.match(phone.shown, /a cut and ~not cut~/,
      "the lone pair of tildes was taken off words the phone was not asked to strike: " + phone.shown);
    await shot(page, "phone-inline");

    // the keyboard goes down and the return key is the send again
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height);
    await settle(600);
    await page.focus(ROW);
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(400);
    assert.equal((await sentTexts(id)).slice(-1)[0],
      "a *word* and **two words** and ~~a cut~~ and ~not cut~",
      "the phone sent something other than the markdown in the row");
    assert.equal(await page.$eval(ROW, row => row.value), "");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the phone row with the setting off is the plain field it always was", async () => {
  await clearLane();
  const id = await card("Phone plain", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE, { setting: "0" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await settle(600);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "an editor was put on with the setting off");
    await page.focus(ROW);
    await page.keyboard.type("plain *stars* stay stars");
    await settle();
    const row = await page.evaluate(() => {
      const field = document.querySelector("article.box.sel textarea");
      return { payload: field.value, tag: field.tagName, focused: document.activeElement === field };
    });
    assert.equal(row.payload, "plain *stars* stay stars");
    assert.equal(row.tag, "TEXTAREA");
    assert.equal(row.focused, true, "the plain row did not hold the caret");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(300);
    assert.equal((await sentTexts(id)).slice(-1)[0], "plain *stars* stay stars");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the typed page ------------------------------------------------------------------

test("the typed page's reply line formats, sends and keeps its own undo", async () => {
  await clearLane();
  const id = await card("Typed page line", "A reply to answer.");
  const { page, problems } = await open("/page", DESKTOP);
  const LINE = `.docsec[data-id="${id}"] .docreply`;
  try {
    await page.waitForFunction(cardId => !!docEls[cardId], { timeout: 10000 }, id);
    await page.evaluate(cardId => docSelect(cardId), id);
    await page.waitForSelector(`.docsec[data-id="${id}"] .cfline`, { timeout: 30000 });
    await page.focus(LINE);
    await page.keyboard.type("a *word* and **two words**");
    // the markers of the span the caret is in or beside stay visible on purpose,
    // so the caret is taken off the last one before the line is read
    await page.evaluate(selector => document.querySelector(selector).setSelectionRange(0, 0), LINE);
    await settle();
    const line = await page.evaluate(selector => {
      const node = document.querySelector(selector);
      const content = node.closest(".cffield").querySelector(".cm-content");
      return { payload: node.textContent, shown: content.innerText,
               italic: content.querySelectorAll(".cf-em").length,
               bold: content.querySelectorAll(".cf-strong").length };
    }, LINE);
    assert.equal(line.payload, "a *word* and **two words**");
    assert.equal(line.shown, "a word and two words");
    assert.equal(line.italic, 1);
    assert.equal(line.bold, 1);
    await shot(page, "typed-page-line");

    // shift enter carries a bullet here too
    await page.evaluate(selector => { document.querySelector(selector).textContent = "- one"; }, LINE);
    await page.focus(LINE);
    await chord(page, "Enter", "Shift");
    await settle();
    assert.equal(await page.$eval(LINE, node => node.textContent), "- one\n- ",
      "the typed page's line did not carry the bullet");

    // the new-card line is an editor of its own, with its own words and undo
    await page.focus("#docnew");
    await page.keyboard.type("a new card's *first* words");
    await settle();
    assert.equal(await page.$eval("#docnew", node => node.textContent), "a new card's *first* words");
    assert.equal(await page.$eval(LINE, node => node.textContent), "- one\n- ",
      "the new-card line wrote into the reply line");
    await chord(page, "z", "Meta");
    await settle();
    assert.equal(await page.$eval("#docnew", node => node.textContent), "",
      "the new-card line's undo took nothing back");
    assert.equal(await page.$eval(LINE, node => node.textContent), "- one\n- ",
      "one line's undo reached into another");

    // and enter sends the reply line's markdown to that card
    await page.evaluate(selector => { document.querySelector(selector).textContent = "sent as *markdown*"; }, LINE);
    await page.focus(LINE);
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(300);
    assert.equal((await sentTexts(id)).slice(-1)[0], "sent as *markdown*",
      "the typed page sent something other than the markdown in the line");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- what the editor is asked not to do ----------------------------------------------

test("the row draws the five forms and leaves the rest of markdown as characters", async () => {
  await clearLane();
  const id = await card("Only the five", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = "# heading\n`code *stars* here`\n[a link](https://example.invalid)\n" +
        "about ~5 minutes, see ~/notes\n~one pair~ stays and ~~two pairs~~ cut";
    });
    await settle(250);
    const out = await page.evaluate(() => {
      const content = document.querySelector("article.box.sel .cm-content");
      return { shown: content.innerText,
               italic: [...content.querySelectorAll(".cf-em")].map(node => node.textContent),
               struck: [...content.querySelectorAll(".cf-strike")].map(node => node.textContent),
               payload: document.querySelector("article.box.sel textarea").value };
    });
    assert.match(out.shown, /# heading/, "a heading's hash was taken away");
    assert.match(out.shown, /\[a link\]\(https:\/\/example\.invalid\)/, "a link was turned into one");
    assert.deepEqual(out.italic, [], "stars inside a code span were drawn as italic");
    assert.match(out.shown, /about ~5 minutes, see ~\/notes/,
      "a stray tilde in prose was read as a strike");
    // the one form of strike there is, which is the one the sent card reads:
    // a lone pair is left standing, characters and all, and two pairs cut
    assert.match(out.shown, /~one pair~ stays/,
      "one pair of tildes was read as a strike: " + out.shown);
    assert.deepEqual(out.struck, ["two pairs"],
      "the two tilde form the card renderer reads is not the composer's own");
    assert.equal(out.payload.split("\n").length, 5, "the row changed the words it holds");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
