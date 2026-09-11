// The composer's list column, and the four chords the card pages own, driven
// headless against their own fixture board on the phone card and the desktop
// card.
//
// Two reports are pinned here. A wrapped list item started its first line on
// the width of a dash and a space and its later lines on a column counted in
// noughts, and in a proportional face those are two different places, so the
// item had two left edges. And control with shift and an arrow, which is a card
// command on both pages, was also read by the editor as one of its own
// selection commands wherever it takes itself for a mac, which is an iPhone or
// an iPad with a keyboard as much as a desktop: the reader asked for an older
// reply and had his words picked out instead. The other shapes one item can be
// written in, continued over source lines and quoted, are pinned beside them.
//
// Everything here types or presses the way a reader does and then measures what
// was actually drawn, so the checks read the row and never the file. The board
// is invented and lives in a temp directory. Nothing here touches the real
// board, the owner's browser or port 8877.
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
// where the pictures of the drawn row are put, for a reader who wants to look
// at them rather than at the numbers underneath
const SHOTS = process.env.COMPOSE_COLUMN_SHOTS ||
  path.join(tmpdir(), "facilitator-compose-column-shots");
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ROW = "article.box.sel textarea";   // the card's typing row, whichever face it wears
const EDGE = 0.75;                        // px two edges may differ by and still be one edge
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];

// invented content, long enough to wrap several times at the width of a phone
const WRAPPER = "- An ordinary list item that wraps across several lines at phone " +
  "width and should keep the words aligned on every line.";
// one list of each marker width the row draws, and one level inside another
const LEVELS = [
  "- a plain bullet with enough words on it to wrap once at this width",
  "  - a nested bullet with its own words and its own wrap to read",
  "1. a numbered item whose words also run past the edge of the row",
  "10. the widest marker in that same list, and the column comes off it",
].join("\n");

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

async function card(title, ...replies) {
  const made = await api("/create?owner=facilitator", title);
  assert.equal(made.status, 200);
  for (const reply of replies) await api(`/reply?box=${made.body.id}`, reply);
  return made.body.id;
}

// every card an earlier check left is put out of the doing view, so each one
// walks only the cards it made itself
async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

function settle(ms = 150) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- the platform the editor reads before any of this runs ------------------
// The vendored bundle works out which keyboard it is on once, while its own
// module runs, and never again. An iPhone and an iPad are a mac to it: safari's
// vendor with a mobile build in the agent string. Both of these are installed
// before a single script on the page, so the bundle finds what the phone's own
// browser would have shown it.
function wearIphone() {
  const agent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  for (const [name, value] of [["userAgent", agent], ["vendor", "Apple Computer, Inc."],
                               ["platform", "iPhone"], ["maxTouchPoints", 5]])
    Object.defineProperty(navigator, name, { get: () => value, configurable: true });
}

function wearMac() {
  Object.defineProperty(navigator, "platform", { get: () => "MacIntel", configurable: true });
}

// what the page says it is standing on, so a setup that quietly failed shows up
// as a failed setup and not as a passing check
function machine(page) {
  return page.evaluate(() => ({
    vendor: navigator.vendor,
    platform: navigator.platform,
    mobile: /Mobile\/\w+/.test(navigator.userAgent),
  }));
}

async function open(route, viewport, opts = {}) {
  const page = await browser.newPage();
  const problems = [];
  await page.setViewport(viewport);
  if (opts.machine === "ios") await page.evaluateOnNewDocument(wearIphone);
  if (opts.machine === "mac") await page.evaluateOnNewDocument(wearMac);
  // each page starts where a browser that has never been opened starts
  await page.evaluateOnNewDocument(setting => {
    try {
      localStorage.clear();
      if (setting !== null) localStorage.setItem("composeformat", setting);
    } catch (error) {}
  }, opts.setting === undefined ? null : opts.setting);
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

async function pickDesktopCard(page, id) {
  await page.waitForFunction(cardId => !!els[cardId], { timeout: 10000 }, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
}

async function editorOn(page) {
  await page.waitForSelector("article.box.sel .cffield", { timeout: 30000 });
}

// one chord: the modifiers held, the key pressed, the modifiers let go. these
// are the browser's own key events, delivered through the driver, and not an
// event made up in the page or a call to the command behind the key. a letter
// is pressed by its physical key, since the driver's entry for a bare letter
// carries no shifted form and would deliver the lower case one under shift
async function chord(page, key, ...modifiers) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(/^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  await settle(120);
}

async function shot(page, name) {
  await mkdir(SHOTS, { recursive: true });
  const clip = await page.evaluate(() => {
    const row = document.querySelector("article.box.sel .compose");
    if (!row) return null;
    const box = row.getBoundingClientRect();
    const pad = 12;
    return { x: Math.max(0, box.left - pad), y: Math.max(0, box.top - pad),
             width: Math.min(box.width + pad * 2, innerWidth), height: box.height + pad * 2 };
  });
  await page.screenshot({ path: path.join(SHOTS, name + ".png"), ...(clip ? { clip } : {}) });
}

// ---- where a drawn line's words actually begin ------------------------------
// Every visual line one source line wraps onto, in the order they are drawn,
// each answering with the x the reader's own words start on. The words are
// found by their own text rather than by any span the drawing puts around the
// marker, so the same reading is taken on a build that has no such span and on
// a quoted line whose angles are hidden by a replacement.
function itemEdges(page, head) {
  return page.evaluate(marker => {
    const firstWords = marker.replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?/, "");
    const line = [...document.querySelectorAll("article.box.sel .cm-line")]
      .find(node => node.textContent.includes(firstWords));
    if (!line) return null;
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const words = [];
    let node;
    while ((node = walk.nextNode())) words.push(node);
    let offset = line.textContent.indexOf(firstWords);
    let first = 0;
    while (first < words.length && offset >= words[first].data.length) {
      offset -= words[first].data.length;
      first++;
    }
    if (first === words.length) return null;
    const range = document.createRange();
    range.setStart(words[first], offset);
    range.setEnd(words[words.length - 1], words[words.length - 1].data.length);
    const rows = new Map();   // one row of the wrap -> the leftmost x on it
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.01) continue;
      const row = Math.round(rect.top);
      const at = rows.get(row);
      if (at === undefined || rect.left < at) rows.set(row, rect.left);
    }
    const style = getComputedStyle(line);
    const column = line.querySelector(".cf-mark");
    return {
      edges: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]),
      lineLeft: line.getBoundingClientRect().left,
      border: parseFloat(style.borderLeftWidth) || 0,   // a quoted line's bar
      padding: parseFloat(style.paddingLeft),
      indent: parseFloat(style.textIndent),
      markerWidth: column ? column.getBoundingClientRect().width : null,
      bullets: line.querySelectorAll(".cf-bullet").length,
      source: line.textContent,
    };
  }, head);
}

// the room the raw angles of a quoted line are taking right now, which is none
// at all while they are hidden
function rawPrefixWidth(page, head) {
  return page.evaluate(marker => {
    const firstWords = marker.replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?/, "");
    const line = [...document.querySelectorAll("article.box.sel .cm-line")]
      .find(node => node.textContent.includes(firstWords));
    if (!line) return null;
    const angles = /^[ \t]*(?:>[ \t]?)+/.exec(line.textContent);
    if (!angles) return 0;
    const node = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) return null;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(angles[0].length, node.data.length));
    return range.getBoundingClientRect().width;
  }, head);
}

function spread(edges) {
  return Math.max(...edges) - Math.min(...edges);
}

// the x this line's own words are supposed to begin on
function columnOf(item) {
  return item.lineLeft + item.border + item.padding;
}

// every visual line of one source line begins on that line's own column
function assertOnColumn(item, where) {
  assert.ok(item, `${where}: the line was not drawn at all`);
  const column = columnOf(item);
  for (const edge of item.edges)
    assert.ok(Math.abs(edge - column) <= EDGE,
      `${where}: a line of words starts on ${edge.toFixed(2)} and the column is ` +
      `${column.toFixed(2)}: ` + JSON.stringify(item.edges));
}

// one item, asked the one question: does every line of it start on one edge,
// and is that edge the column the line itself hangs on
function assertOneEdge(item, where) {
  assert.ok(item, `${where}: the item was not drawn at all`);
  assert.ok(item.edges.length >= 2,
    `${where}: the item did not wrap, so there is no second line to line up: ` +
    JSON.stringify(item.edges));
  assert.ok(spread(item.edges) <= EDGE,
    `${where}: the item's lines start on ${item.edges.length} different edges, ` +
    `${spread(item.edges).toFixed(2)}px apart: ` + JSON.stringify(item.edges));
  assertOnColumn(item, where);
}

// the row's own face, measured off a copy of it outside the editor. nothing is
// ever put inside the content the editor is watching
function faceOf(page) {
  return page.evaluate(() => {
    const content = document.querySelector("article.box.sel .cm-content");
    const style = getComputedStyle(content);
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute; visibility:hidden; white-space:pre; left:-9999px";
    for (const name of ["fontFamily", "fontSize", "fontWeight", "letterSpacing"])
      probe.style[name] = style[name];
    document.body.appendChild(probe);
    const width = text => { probe.textContent = text; return probe.getBoundingClientRect().width; };
    const out = { zero: width("0"), dash: width("- "), family: style.fontFamily };
    probe.remove();
    return out;
  });
}

// what the row holds and what it has picked out, read through the one public
// face a composer has always had
function rowState(page, selector = ROW) {
  return page.evaluate(sel => {
    const row = document.querySelector(sel);
    return {
      payload: row.value,
      from: row.selectionStart, to: row.selectionEnd, way: row.selectionDirection,
      inRow: !!document.activeElement &&
        (document.activeElement === row ||
         !!(document.activeElement.closest && document.activeElement.closest(".cffield"))),
    };
  }, selector);
}

// the cards the list is showing, in the order it shows them, which is the order
// the walking keys keep on both pages
function listOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll("#tiklist .trow")].map(row => row.dataset.id));
}

function shownCard(page) {
  return page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    return box ? box.id.replace(/^box-/, "") : null;
  });
}

function historyMark(page) {
  return page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    const pos = box && box.querySelector(".histpos");
    return { at: pos ? pos.textContent : "", past: !!box && box.classList.contains("histview") };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-compose-column-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "compose column fixture",
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
  await mkdir(SHOTS, { recursive: true });
  console.log("pictures of the drawn row: " + SHOTS);
});

after(async () => {
  if (browser) await browser.close();
  await stopFixture();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- the item's one left edge -----------------------------------------------

test("a wrapped bullet keeps one left edge at phone width, and the markdown is untouched", async () => {
  await clearLane();
  const id = await card("Wrapped bullet", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type(WRAPPER);
    await settle(250);

    // the face the row is drawn in, and why a column counted in noughts is not
    // the width of a dash and a space in it
    const face = await faceOf(page);
    assert.ok(face.zero > 0 && face.dash > 0, "the row's face could not be measured");
    assert.ok(Math.abs(face.dash - 2 * face.zero) > 1,
      "the row is drawn in a face where a marker happens to be exactly two noughts wide, " +
      `so this check proves nothing: ${face.family}`);

    // recorded before anything is asked of it, so a build that fails here is
    // still inspectable in the numbers and in the picture
    const item = await itemEdges(page, "- An ordinary");
    console.log("wrapped bullet text edges: " + JSON.stringify(item && item.edges));
    await shot(page, "phone-wrapped-bullet");
    assertOneEdge(item, "the phone's wrapped bullet");
    assert.equal(item.bullets, 1, "the dash was not drawn as a round marker");
    // the column is the two the row has always hung a dash and a space on, and
    // the marker's own room is exactly that column
    assert.ok(Math.abs(item.padding - 2 * face.zero) <= 1,
      `the item's column moved off the two noughts it has always been: ${item.padding}`);
    assert.ok(Math.abs(item.markerWidth - item.padding) <= EDGE,
      `the marker was given ${item.markerWidth}px of room on a ${item.padding}px column`);
    assert.ok(Math.abs(item.indent + item.padding) <= EDGE,
      "the line's first line is not pulled back by the column it is padded with");

    // nothing was taken out of the document to do it, and the row still sends
    // exactly what was typed
    assert.equal(item.source, WRAPPER, "the drawn line is not the line that was typed");
    assert.equal((await rowState(page)).payload, WRAPPER, "the row changed the markdown in it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("two marker widths and a level inside another all keep one edge each", async () => {
  await clearLane();
  const id = await card("Marker widths", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    // laid in through the row's own face, because a return key on this card is
    // the send and this check is not about the send
    await page.evaluate(text => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = text;
      // the row is told the way any other writer tells it, so it takes the
      // height its words need and the picture shows the whole list
      row.dispatchEvent(new Event("input", { bubbles: true }));
    }, LEVELS);
    await settle(300);

    const plain = await itemEdges(page, "- a plain bullet");
    const nested = await itemEdges(page, "  - a nested bullet");
    const one = await itemEdges(page, "1. a numbered item");
    const ten = await itemEdges(page, "10. the widest marker");
    console.log("marker width text edges: " + JSON.stringify(
      [plain, nested, one, ten].map(item => item && item.edges)));
    await shot(page, "phone-marker-widths");
    assertOneEdge(plain, "the plain bullet");
    assertOneEdge(nested, "the nested bullet");
    assertOneEdge(one, "the numbered item");
    assertOneEdge(ten, "the wider numbered item");

    // one column per list, off its widest marker, so the two numbers put their
    // words in one place instead of two
    assert.ok(Math.abs(one.edges[0] - ten.edges[0]) <= EDGE,
      `1. and 10. started their words ${Math.abs(one.edges[0] - ten.edges[0]).toFixed(2)}px apart`);
    // and a level is a level: the nested item's words start one column further
    // in than its parent's
    assert.ok(nested.edges[0] > plain.edges[0] + 1,
      "the nested bullet did not step in from the one it is inside");
    assert.ok(Math.abs((nested.padding - plain.padding) - plain.padding) <= 1,
      `a level stepped by ${(nested.padding - plain.padding).toFixed(2)}px ` +
      `on a ${plain.padding.toFixed(2)}px column`);
    assert.equal(plain.bullets + nested.bullets, 2, "the two dashes were not drawn as markers");
    assert.equal(one.bullets + ten.bullets, 0, "a number was drawn as a round marker");
    assert.equal((await rowState(page)).payload, LEVELS, "the row changed the markdown in it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the edge holds when the row is made narrower and wider again", async () => {
  await clearLane();
  const id = await card("Reflowed bullet", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type(WRAPPER);
    await settle(250);
    const counts = [];
    for (const width of [390, 320, 430, 390]) {
      await page.setViewport({ ...PHONE, width });
      await settle(300);
      const item = await itemEdges(page, "- An ordinary");
      console.log(`bullet text edges at ${width}px: ` + JSON.stringify(item && item.edges));
      counts.push(item ? item.edges.length : 0);
      if (width !== 390 || counts.length === 1) await shot(page, "phone-bullet-" + width);
      assertOneEdge(item, `the bullet at ${width}px`);
    }
    assert.ok(new Set(counts).size > 1,
      "the row never actually reflowed, so nothing was asked of the reflow: " +
      JSON.stringify(counts));
    assert.equal((await rowState(page)).payload, WRAPPER, "a reflow changed the markdown in the row");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the other shapes one item is written in --------------------------------
// An item can run over several source lines, and any of them can be quoted.
// Every line of it begins on the item's own column: a line carrying a marker or
// an indent is pulled back by what stands there, and a line carrying neither is
// not pulled back at all.
const SHAPES = [
  {
    name: "a list item continued on an indented source line keeps one edge",
    file: "indented-continuation",
    text: "- A bullet with a short first line.\n  Continued words on another source " +
      "line that should stay aligned through every wrap at this phone width.",
    heads: ["- A bullet", "  Continued"],
  },
  {
    name: "a list item continued on an unindented source line keeps one edge",
    file: "lazy-continuation",
    text: "- A bullet with a short first line.\nContinued words on another source " +
      "line that should stay aligned through every wrap at this phone width.",
    heads: ["- A bullet", "Continued"],
  },
  {
    name: "a quoted list item keeps one edge",
    file: "quoted-list",
    text: "> - An ordinary quoted list item that wraps across several lines at phone " +
      "width and should keep its words aligned on every line.",
    heads: ["> - An ordinary"],
  },
  {
    name: "a quoted list item continued on another source line keeps one edge",
    file: "quoted-continuation",
    text: "> - A bullet with a short first line.\n>   Continued words on another source " +
      "line that should stay aligned through every wrap at this phone width.",
    heads: ["> - A bullet", ">   Continued"],
  },
];

for (const shape of SHAPES) {
  test(shape.name, async t => {
    await clearLane();
    const id = await card("List shape fixture", "A fixture reply.");
    const { page, problems } = await open(`/m?box=${id}`, PHONE);
    try {
      await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
      await editorOn(page);
      await page.evaluate(value => {
        const row = document.querySelector("article.box.sel textarea");
        row.value = value;
        row.dispatchEvent(new Event("input", { bubbles: true }));
      }, shape.text);
      await settle(300);
      const readings = [];
      for (const head of shape.heads) readings.push(await itemEdges(page, head));
      // written down before anything is asked of it, so a build that fails here
      // is still inspectable in the numbers and in the picture
      t.diagnostic(JSON.stringify({ shape: shape.file, readings }));
      await shot(page, "phone-" + shape.file);
      assert.ok(readings.every(Boolean), "a source line of the item was not found in the row");
      for (const reading of readings) assertOnColumn(reading, shape.file);
      const edges = readings.flatMap(reading => reading.edges);
      assert.ok(edges.length >= 2, "the item never wrapped, so nothing was asked of it");
      assert.ok(spread(edges) <= EDGE,
        `${shape.file}: the item's lines start on different edges: ` + JSON.stringify(edges));
      assert.equal((await rowState(page)).payload, shape.text, "the row changed the markdown in it");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

// the line the caret is on puts its raw angles back, which is what a quote has
// always done here; it must be moved by those angles and by nothing else, and
// every other line stays on the column
function assertQuoteStates(hotLine, coldLine, angles, where) {
  assert.ok(hotLine && coldLine, `${where}: a line of the item was not drawn`);
  assert.ok(hotLine.source.startsWith(">"),
    `${where}: the raw angles did not come back under the caret: ` + hotLine.source);
  assert.ok(!coldLine.source.startsWith(">"),
    `${where}: the angles came back on a line the caret was not on: ` + coldLine.source);
  assertOnColumn(coldLine, `${where}: the line the caret is away from`);
  assert.ok(hotLine.edges.length >= 2,
    `${where}: the line under the caret did not wrap: ` + JSON.stringify(hotLine.edges));
  const column = columnOf(hotLine);
  for (const edge of hotLine.edges.slice(1))
    assert.ok(Math.abs(edge - column) <= EDGE,
      `${where}: a wrapped line moved when the angles came back: ` + JSON.stringify(hotLine.edges));
  assert.ok(angles > 0, `${where}: the angles under the caret took no room at all`);
  assert.ok(Math.abs((hotLine.edges[0] - column) - angles) <= EDGE,
    `${where}: the first line moved by ${(hotLine.edges[0] - column).toFixed(2)}px and the ` +
    `angles it is showing are ${angles.toFixed(2)}px wide`);
}

test("a quoted list shows its raw angles on the line the caret is on and stays typeable", async t => {
  await clearLane();
  const id = await card("Quoted list under the caret", "A fixture reply.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE);
  const text = "> - An ordinary quoted list item that wraps across several lines at this width.\n" +
    ">   Continued words on another source line that also wrap at this phone width.";
  const caretTo = at => page.evaluate(offset => {
    document.querySelector("article.box.sel textarea").setSelectionRange(offset, offset);
  }, at);
  const readBoth = async () => ({
    first: await itemEdges(page, "> - An ordinary"),
    second: await itemEdges(page, ">   Continued"),
    firstAngles: await rawPrefixWidth(page, "> - An ordinary"),
    secondAngles: await rawPrefixWidth(page, ">   Continued"),
  });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    await page.evaluate(value => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = value;
      row.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await page.focus(ROW);
    await settle(250);

    // the caret on the second source line: the first is drawn and on its column
    await caretTo(text.length);
    await settle(200);
    const onSecond = await readBoth();
    t.diagnostic(JSON.stringify({ caret: "second line", readings: onSecond }));
    await shot(page, "phone-quoted-caret-second-line");
    assertQuoteStates(onSecond.second, onSecond.first, onSecond.secondAngles,
      "with the caret on the second source line");

    // and the other way round
    await caretTo(0);
    await settle(200);
    const onFirst = await readBoth();
    t.diagnostic(JSON.stringify({ caret: "first line", readings: onFirst }));
    await shot(page, "phone-quoted-caret-first-line");
    assertQuoteStates(onFirst.first, onFirst.second, onFirst.firstAngles,
      "with the caret on the first source line");

    // and a quoted item is still an ordinary line to type in
    await caretTo(text.length);
    await page.keyboard.type(" typed in.");
    await settle(200);
    assert.equal((await rowState(page)).payload, text + " typed in.",
      "typing in a quoted list line did not land where the caret was");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the four chords the page owns ------------------------------------------

test("on an iPhone keyboard control shift up and down step the replies and leave the row alone", async () => {
  await clearLane();
  await card("The card next door", "A reply on the card next door.");
  const id = await card("Older replies on a phone keyboard", "First reply.", "Second reply, the live one.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE, { machine: "ios" });
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  const draft = "a draft nobody asked to lose";
  try {
    assert.deepEqual(await machine(page),
      { vendor: "Apple Computer, Inc.", platform: "iPhone", mobile: true },
      "the page was not standing on the phone this check is about");
    await page.waitForSelector(`#box-${id}.sel.hashist`, { timeout: 10000 });
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type(draft);
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 6);
    });
    await settle(150);

    // the older reply, and the words and the caret exactly as they were
    await chord(page, "ArrowUp", "Control", "Shift");
    await page.waitForFunction(
      () => document.querySelector("article.box.sel .histpos").textContent === "1 of 2",
      { timeout: 3000 });
    const older = await page.evaluate(() => ({
      reply: document.querySelector("article.box.sel .reply").textContent,
      past: document.querySelector("article.box.sel").classList.contains("histview"),
    }));
    assert.equal(older.reply, "First reply.", "the chord did not show the older reply");
    assert.equal(older.past, true, "the older reply is not shown as one");
    const stepped = await rowState(page);
    assert.deepEqual(
      { payload: stepped.payload, from: stepped.from, to: stepped.to, inRow: stepped.inRow },
      { payload: draft, from: 6, to: 6, inRow: true },
      "the chord picked out the words in the row instead of leaving them alone");

    // and back toward live, on the same terms
    await chord(page, "ArrowDown", "Control", "Shift");
    await page.waitForFunction(
      () => document.querySelector("article.box.sel .reply").textContent === "Second reply, the live one.",
      { timeout: 3000 });
    assert.deepEqual(await historyMark(page), { at: "", past: false },
      "the step back toward live left the card in the past");
    const back = await rowState(page);
    assert.deepEqual({ payload: back.payload, from: back.from, to: back.to },
      { payload: draft, from: 6, to: 6 },
      "the step back toward live picked out the words in the row");

    // command and shift with the same arrow is the editor's own and still picks
    // out words, and moves no reply at all
    await chord(page, "ArrowUp", "Meta", "Shift");
    const picked = await rowState(page);
    assert.deepEqual({ from: picked.from, to: picked.to, way: picked.way, payload: picked.payload },
      { from: 0, to: 6, way: "backward", payload: draft },
      "command and shift with an arrow stopped picking out words in the row");
    assert.deepEqual(await historyMark(page), { at: "", past: false },
      "command and shift with an arrow stepped the card's replies");
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 6);
    });

    // the sideways pair still walks the cards, and the row it walked out of is
    // left with its words and its caret untouched
    const order = await listOrder(page);
    assert.ok(order.length >= 2, "the walk has nowhere to go: " + JSON.stringify(order));
    const next = order[(order.indexOf(id) + 1) % order.length];
    await chord(page, "ArrowRight", "Control", "Shift");
    assert.equal(await shownCard(page), next, "control shift right did not walk to the next card");
    await chord(page, "ArrowLeft", "Control", "Shift");
    assert.equal(await shownCard(page), id, "control shift left did not walk back");
    const walkedBack = await rowState(page);
    assert.deepEqual({ payload: walkedBack.payload, from: walkedBack.from, to: walkedBack.to },
      { payload: draft, from: 6, to: 6 },
      "walking the cards picked out the words in the row it left");
    assert.deepEqual(sends, [], "a card chord sent the draft");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the keys the editor keeps still work on the same phone keyboard", async () => {
  await clearLane();
  const id = await card("The editor's own keys", "A reply to answer.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE, { machine: "ios" });
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 10000 });
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type("first run");
    await settle(700);            // past the editor's own grouping window
    await page.keyboard.type(" second run");
    await settle(150);

    // a plain arrow is the caret's
    await page.keyboard.press("ArrowLeft");
    await settle(120);
    const moved = await rowState(page);
    assert.deepEqual({ from: moved.from, to: moved.to }, { from: 19, to: 19 },
      "a plain arrow stopped moving the caret in the row");
    // and shift with one still picks out a letter at a time
    await chord(page, "ArrowLeft", "Shift");
    const one = await rowState(page);
    assert.deepEqual({ from: one.from, to: one.to, way: one.way },
      { from: 18, to: 19, way: "backward" }, "shift and an arrow stopped picking out words");

    // the row's own undo and redo
    await chord(page, "z", "Meta");
    assert.equal((await rowState(page)).payload, "first run",
      "the chord did not undo the words the row had just taken");
    await chord(page, "z", "Meta", "Shift");
    assert.equal((await rowState(page)).payload, "first run second run",
      "the shifted chord did not redo");

    // shift and return is still a new line, and sends nothing
    await chord(page, "Enter", "Shift");
    await page.keyboard.type("- a bullet");
    await settle(150);
    assert.equal((await rowState(page)).payload, "first run second run\n- a bullet",
      "shift and return stopped making a line");
    // and return inside a list still carries the marker down and ends the list
    await chord(page, "Enter", "Shift");
    assert.equal((await rowState(page)).payload, "first run second run\n- a bullet\n- ",
      "the new line did not carry the bullet");
    await chord(page, "Enter", "Shift");
    assert.equal((await rowState(page)).payload, "first run second run\n- a bullet\n",
      "the empty bullet did not end the list");
    assert.deepEqual(sends, [], "a line break sent the draft");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the same chords on a desktop mac step the replies and walk the cards without picking out words", async () => {
  await clearLane();
  await card("Desktop card next door", "A reply on the card next door.");
  const id = await card("Desktop older replies", "First desktop reply.", "Second desktop reply.");
  const { page, problems } = await open("/", DESKTOP, { machine: "mac" });
  const draft = "a desktop draft to keep";
  try {
    assert.equal((await machine(page)).platform, "MacIntel",
      "the page was not standing on the keyboard this check is about");
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.waitForSelector(`#box-${id}.sel.hashist`, { timeout: 10000 });
    await page.focus(ROW);
    await page.keyboard.type(draft);
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 6);
    });
    await settle(150);

    await chord(page, "ArrowUp", "Control", "Shift");
    await page.waitForFunction(
      () => document.querySelector("article.box.sel .histpos").textContent === "1 of 2",
      { timeout: 3000 });
    const stepped = await rowState(page);
    assert.deepEqual({ payload: stepped.payload, from: stepped.from, to: stepped.to },
      { payload: draft, from: 6, to: 6 },
      "the desktop chord picked out the words in the row");
    await chord(page, "ArrowDown", "Control", "Shift");
    assert.deepEqual(await historyMark(page), { at: "", past: false },
      "the desktop step back toward live left the card in the past");

    // command and shift with the arrow is still the editor's
    await chord(page, "ArrowUp", "Meta", "Shift");
    const picked = await rowState(page);
    assert.deepEqual({ from: picked.from, to: picked.to, way: picked.way },
      { from: 0, to: 6, way: "backward" },
      "command and shift with an arrow stopped picking out words on the desktop");
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 6);
    });

    const order = await listOrder(page);
    assert.ok(order.length >= 2, "the desktop walk has nowhere to go: " + JSON.stringify(order));
    const next = order[(order.indexOf(id) + 1) % order.length];
    await chord(page, "ArrowRight", "Control", "Shift");
    assert.equal(await shownCard(page), next, "the desktop walk did not reach the next card");
    await chord(page, "ArrowLeft", "Control", "Shift");
    assert.equal(await shownCard(page), id, "the desktop walk did not come back");
    const walkedBack = await rowState(page);
    assert.deepEqual({ payload: walkedBack.payload, from: walkedBack.from, to: walkedBack.to },
      { payload: draft, from: 6, to: 6 },
      "the desktop walk picked out the words in the row it left");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("with the setting off the plain row answers the same chords the same way", async () => {
  await clearLane();
  const id = await card("Plain row chords", "First plain reply.", "Second plain reply.");
  const { page, problems } = await open(`/m?box=${id}`, PHONE, { machine: "ios", setting: "0" });
  const draft = "a plain draft to keep";
  try {
    await page.waitForSelector(`#box-${id}.sel.hashist`, { timeout: 10000 });
    await settle(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".cffield").length), 0,
      "an editor was put on with the setting off, so this asks nothing about the plain row");
    await page.focus(ROW);
    await page.keyboard.type(draft);
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 6);
    });
    await chord(page, "ArrowUp", "Control", "Shift");
    await page.waitForFunction(
      () => document.querySelector("article.box.sel .histpos").textContent === "1 of 2",
      { timeout: 3000 });
    const stepped = await rowState(page);
    assert.deepEqual({ payload: stepped.payload, from: stepped.from, to: stepped.to },
      { payload: draft, from: 6, to: 6 },
      "the plain row lost its words or its caret to the chord");
    await chord(page, "ArrowDown", "Control", "Shift");
    assert.deepEqual(await historyMark(page), { at: "", past: false },
      "the plain row did not come back toward live");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
