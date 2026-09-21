// The card pages' shared keyboard shortcuts, driven headless against their own
// fixture server at desktop and iPhone sizes. What only the phone itself can
// show is which command
// combinations the system answers before the page is shown them, so what these
// pin is what the page does with the events it is handed. The on-screen
// keyboard is played by a window that shrinks with it, the way the phone
// reports a keyboard that resizes the window.
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
const DESKTOP = { width: 1440, height: 900 };
const KEYBOARD = 336;   // an iPhone keyboard with its accessory bar, in css px
const SEL = "article.box.sel textarea";
const HISTORY_SHOTS = process.env.DESKTOP_HISTORY_SHOTS || "";

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

async function create(title, owner = "facilitator") {
  const result = await api("/create?owner=" + encodeURIComponent(owner), title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function savedBox(id) {
  const state = await (await fetch(origin + "/state")).json();
  return state.boxes.find(box => box.id === id);
}

// every card a test before left is put out of the doing view, so each test
// walks only the cards it made itself
async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

async function openPhone(route) {
  return openCardPage(route, PHONE);
}

async function openDesktop(route = "/") {
  return openCardPage(route, DESKTOP);
}

async function openCardPage(route, viewport) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(viewport);
  // each page starts where a browser that has never been opened starts: the
  // remembered tab and card of the test before are no part of this one
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (err) {} });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function historyShot(page, name) {
  if (!HISTORY_SHOTS) return;
  await mkdir(HISTORY_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(HISTORY_SHOTS, name + ".png") });
}

// one chord: the modifiers held, the key pressed, the modifiers let go
async function chord(page, key, ...mods) {
  for (const mod of mods) await page.keyboard.down(mod);
  await page.keyboard.press(key);
  for (const mod of [...mods].reverse()) await page.keyboard.up(mod);
}

function shownId(page) {
  return page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    return box ? box.id.replace(/^box-/, "") : null;
  });
}

// command+z and control+z belong to whatever is being typed in. This listener
// goes on last, so a page that still had a card command on the chord would show
// up here as a canceled event, or as no event at all where a handler stopped it.
// A field that keeps its own stop against the board is watched on the field, its
// barrier left exactly as it was, and what got past the stop watched separately.
function watchUndoKeys(page, selector) {
  return page.evaluate(sel => {
    const note = list => event => {
      if (event.key === "z" || event.key === "Z")
        list.push({
          key: event.key, meta: event.metaKey, ctrl: event.ctrlKey,
          shift: event.shiftKey, prevented: event.defaultPrevented,
        });
    };
    window.__undoKeys = [];
    window.__undoKeysBeyond = [];
    const field = sel ? document.querySelector(sel) : null;
    if (sel && !field) throw new Error("nothing to watch at " + sel);
    (field || window).addEventListener("keydown", note(window.__undoKeys));
    if (field) addEventListener("keydown", note(window.__undoKeysBeyond));
  }, selector || null);
}

function undoKeysSeen(page) {
  return page.evaluate(() => window.__undoKeys.splice(0));
}

function undoKeysBeyond(page) {
  return page.evaluate(() => window.__undoKeysBeyond.splice(0));
}

// both keyboards' undo, both cases a caps lock or a shifted key delivers, and
// the shifted redo beside each
async function pressUndoChords(page) {
  for (const modifiers of [["Meta"], ["Control"], ["Meta", "Shift"], ["Control", "Shift"]]) {
    await chord(page, "z", ...modifiers);
    await chord(page, "Z", ...modifiers);
  }
  await settle(150);
  return undoKeysSeen(page);
}

// The same question asked of a row wearing its typed-formatting editor. That
// editor claims the chords it acts on, exactly as the markdown panel's does in
// the last test in this file, so what is asked here is that every chord still
// reached the end of the page's own handling and that nothing took one the
// editor does not bind. The card assertion beside each call is what proves the
// board itself stayed where it was.
function assertLeftToTheField(seen, where) {
  assert.equal(seen.length, 8, `${where}: an undo chord never reached the end of the page's own handling`);
  assert.deepEqual([...new Set(seen.map(entry => entry.key))].sort(), ["Z", "z"], `${where}: both cases were not pressed`);
  assert.equal(seen.filter(entry => entry.meta && !entry.ctrl).length, 4, `${where}: command z did not arrive four times`);
  assert.equal(seen.filter(entry => entry.ctrl && !entry.meta).length, 4, `${where}: control z did not arrive four times`);
  assert.deepEqual(seen.filter(entry => entry.ctrl && entry.prevented), [],
    `${where}: something canceled a chord no editor on this keyboard binds`);
}

function assertLeftToTheEditor(seen, where) {
  assert.equal(seen.length, 8, `${where}: an undo chord never reached the end of the page's own handling`);
  assert.deepEqual(seen.filter(entry => entry.prevented), [], `${where}: the page canceled an undo chord`);
  assert.deepEqual([...new Set(seen.map(entry => entry.key))].sort(), ["Z", "z"], `${where}: both cases were not pressed`);
  assert.equal(seen.filter(entry => entry.meta && !entry.ctrl).length, 4, `${where}: command z did not arrive four times`);
  assert.equal(seen.filter(entry => entry.ctrl && !entry.meta).length, 4, `${where}: control z did not arrive four times`);
}

// the field's own undo, run the way a browser menu runs it, since a driven
// browser is handed the chord without the system edit command behind it. A page
// that broke editing undo cannot pass this by merely ignoring the keys.
async function editorUndoRedo(page, selector) {
  const read = () => page.$eval(selector, el => (el.value === undefined ? el.textContent : el.value));
  await page.focus(selector);
  const before = await read();
  // a row wearing its editor answers the chord itself; a plain field is handed
  // the chord without the system edit command behind it, so its own undo is
  // run the way a browser menu runs it
  await chord(page, "z", "Meta");
  let undone = await read();
  if (undone === before) {
    await page.evaluate(() => document.execCommand("undo"));
    undone = await read();
  }
  await chord(page, "z", "Meta", "Shift");
  let redone = await read();
  if (redone === undone) {
    await page.evaluate(() => document.execCommand("redo"));
    redone = await read();
  }
  // the two chords above are this helper's own and are no part of the record
  // the chord assertions read
  await page.evaluate(() => {
    if (window.__undoKeys) window.__undoKeys.splice(0);
    if (window.__undoKeysBeyond) window.__undoKeysBeyond.splice(0);
  });
  return { before, undone, redone };
}

function assertUndoStackIntact(stack, where) {
  assert.ok(stack.before.length > 0, `${where}: nothing was typed to undo`);
  assert.ok(stack.undone.length < stack.before.length, `${where}: the field's own undo took nothing back`);
  assert.ok(stack.before.startsWith(stack.undone), `${where}: the field's undo changed words it had not typed`);
  assert.equal(stack.redone, stack.before, `${where}: the field's redo did not put the words back`);
}

// the cards the list is showing, in the order it shows them, which is the order
// the walking keys have to keep. the sheet draws all three sections at once, so
// the shown cards are the current section's pane
function listOrder(page) {
  return page.evaluate(() => {
    const sheet = document.getElementById("tiksheet");
    const view = typeof curView === "function" ? curView() : null;
    const scope = sheet && view ? sheet.querySelector('.tikpane[data-view="' + view + '"]') : document.getElementById("tiklist");
    return scope ? [...scope.querySelectorAll(".trow")].map(row => row.dataset.id) : [];
  });
}

function activeElement(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest ? el.closest("article.box") : null;
    return { tag: el ? el.tagName : null, box: box ? box.id.replace(/^box-/, "") : null };
  });
}

// The card's typing row answers to two shapes: the plain textarea, and the
// editor the typed-formatting setting puts in its place. Both are the row, so
// what the walking keys are asked is whether the caret is in a row and which
// card's row it is, not which element the row happens to be made of.
function activeRow(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest ? el.closest("article.box") : null;
    const row = !!el && (el.tagName === "TEXTAREA"
      ? !el.classList.contains("cfmirror")
      : !!(el.closest && el.closest(".cffield")));
    return { row, box: box ? box.id.replace(/^box-/, "") : null };
  });
}

async function selectDesktop(page, id) {
  await page.waitForFunction(cardId => !!els[cardId], { timeout: 5000 }, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
}

function createRequests(page) {
  const requests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/create") requests.push(request.url());
  });
  return requests;
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-shortcuts-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "compose-format.js", "index.html", "page.html", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  try {
    await copyFile(path.join(ROOT, "card-report.js"), path.join(fixtureDir, "card-report.js"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone shortcuts test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: logs,
    },
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

test("control shift left and right walk the cards the list shows, and the caret goes with them", async () => {
  await clearLane();
  const ids = [];
  for (const name of ["First on the walk", "Second on the walk", "Third on the walk"]) {
    const id = await create(name);
    await api(`/reply?box=${id}`, "A reply to answer.");
    ids.push(id);
  }
  const { page, problems } = await openPhone(`/m?box=${ids[0]}`);
  try {
    await page.waitForSelector(`#box-${ids[0]}.sel`, { timeout: 5000 });
    const order = await listOrder(page);
    assert.deepEqual([...order].sort(), [...ids].sort(), "the list is not the three cards of this test");
    let at = order.indexOf(ids[0]);
    for (let step = 1; step <= order.length; step++) {
      await chord(page, "ArrowRight", "Control", "Shift");
      at = (at + 1) % order.length;
      assert.equal(await shownId(page), order[at], `step ${step} did not land on the next card in the list`);
    }
    assert.equal(await shownId(page), ids[0], "the walk did not come back round to where it started");
    await chord(page, "ArrowLeft", "Control", "Shift");
    assert.equal(await shownId(page), order[(at + order.length - 1) % order.length], "the other way did not step back");
    await chord(page, "ArrowRight", "Control", "Shift");
    assert.equal(await shownId(page), ids[0]);

    // the caret in a row goes with the selection, so a message can be carried
    // on in the next card without reaching for the screen
    await page.focus(SEL);
    assert.equal((await activeRow(page)).row, true);
    await chord(page, "ArrowRight", "Control", "Shift");
    const landed = await shownId(page);
    assert.deepEqual(await activeRow(page), { row: true, box: landed },
      "the caret did not land in the row of the card walked to");

    // and from anywhere else the selection moves alone: a key that only walks
    // the cards must never raise the phone's own keyboard
    await page.evaluate(() => document.activeElement.blur());
    await chord(page, "ArrowRight", "Control", "Shift");
    assert.equal((await activeElement(page)).tag, "BODY", "a walk with no caret in a row focused one anyway");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("command shift brackets walk the same cards, in and out of a row", async () => {
  await clearLane();
  const ids = [];
  for (const name of ["First on the brackets", "Second on the brackets", "Third on the brackets"]) {
    const id = await create(name);
    await api(`/reply?box=${id}`, "A reply to answer.");
    ids.push(id);
  }
  const { page, problems } = await openPhone(`/m?box=${ids[0]}`);
  try {
    await page.waitForSelector(`#box-${ids[0]}.sel`, { timeout: 5000 });
    const order = await listOrder(page);
    const at = order.indexOf(ids[0]);
    await chord(page, "]", "Meta", "Shift");
    assert.equal(await shownId(page), order[(at + 1) % order.length], "the right bracket did not step on");
    await chord(page, "[", "Meta", "Shift");
    assert.equal(await shownId(page), ids[0], "the left bracket did not step back");
    await page.focus(SEL);
    await chord(page, "]", "Meta", "Shift");
    assert.deepEqual(await activeRow(page), { row: true, box: await shownId(page) },
      "the caret did not go with the bracket");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("control shift up and down step the card's older replies and come back to live", async () => {
  await clearLane();
  const id = await create("Older replies on the phone");
  await api(`/reply?box=${id}`, "First reply.");
  await api(`/reply?box=${id}`, "Second reply, the live one.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel.hashist`, { timeout: 5000 });
    await chord(page, "ArrowUp", "Control", "Shift");
    await page.waitForFunction(() => document.querySelector("article.box.sel .histpos").textContent === "1 of 2", { timeout: 3000 });
    const older = await page.evaluate(() => ({
      text: document.querySelector("article.box.sel .reply").textContent,
      dim: document.querySelector("article.box.sel").classList.contains("histview"),
    }));
    assert.equal(older.text, "First reply.");
    assert.equal(older.dim, true, "the older reply is not shown as one");
    await chord(page, "ArrowDown", "Control", "Shift");
    await page.waitForFunction(() => document.querySelector("article.box.sel .reply").textContent === "Second reply, the live one.", { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel").classList.contains("histview")), false,
      "the step back toward live left the card in the past");

    // the pair works with the caret in the row, and leaves it there
    await page.focus(SEL);
    await chord(page, "ArrowUp", "Control", "Shift");
    await page.waitForFunction(() => document.querySelector("article.box.sel .histpos").textContent === "1 of 2", { timeout: 3000 });
    assert.equal((await activeRow(page)).row, true, "the step took the caret out of the row");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("command and a number jumps to that tab, counted along the bar", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tabbar .ptab").length >= 2, { timeout: 5000 });
    const bar = await page.evaluate(() => [...document.querySelectorAll("#tabbar .ptab")].map(tab => tab.dataset.owner));
    assert.deepEqual(bar, ["facilitator", "pastureland"], "the bar is not the two lanes this fixture seeds");
    await chord(page, "2", "Meta");
    await page.waitForFunction(() => activeOwner === "pastureland", { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.querySelector("#tabbar .ptab.on").dataset.owner), "pastureland",
      "the bar did not seat the tab the number jumped to");
    await chord(page, "1", "Meta");
    await page.waitForFunction(() => activeOwner === "facilitator", { timeout: 3000 });
    // a number past the end of the bar is nobody's tab, and moves nothing
    await chord(page, "9", "Meta");
    await settle(150);
    assert.equal(await page.evaluate(() => activeOwner), "facilitator", "a number past the end of the bar moved the tab");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("command t makes a card in the lane on show, with its name ready to be typed", async () => {
  await clearLane();
  const { page, problems } = await openPhone("/m");
  try {
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/create");
    await chord(page, "t", "Meta");
    const madeId = (await (await created).json()).id;
    await page.waitForFunction(id => document.querySelector(`#box-${id}.sel .title`)?.isContentEditable, { timeout: 3000 }, madeId);
    assert.equal((await savedBox(madeId)).owner, "facilitator", "the card did not land in the lane on show");
    await page.keyboard.type("Named from the keyboard");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => lastState?.boxes.find(box => box.id === id)?.title === "Named from the keyboard", { timeout: 3000 }, madeId);
    assert.equal((await savedBox(madeId)).title, "Named from the keyboard");
    // naming ends in the row, which is where the message goes
    assert.deepEqual(await activeRow(page), { row: true, box: madeId },
      "naming the new card did not end with the caret in its row");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("escape puts the caret out of the row and leaves the words in it", async () => {
  await clearLane();
  const id = await create("Escape on the phone");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.keyboard.type("half a thought");
    await page.keyboard.press("Escape");
    await settle(120);
    const after = await page.evaluate(() => ({
      tag: document.activeElement.tagName,
      text: document.querySelector("article.box.sel textarea").value,
      sent: document.querySelectorAll("article.box.sel .pendmsg").length,
    }));
    assert.equal(after.tag, "BODY", "escape did not let go of the row");
    assert.equal(after.text, "half a thought", "escape lost the words in the row");
    assert.equal(after.sent, 0, "escape sent the words");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("backspace closes the card on show, and only the cards the board's own key closes", async () => {
  await clearLane();
  const id = await create("Closed from the keyboard");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const keep = await create("Left standing after the close");
  await api(`/reply?box=${keep}`, "Another reply.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    // with the caret in the row the key is the row's, and closes nothing
    await page.focus(SEL);
    await page.keyboard.type("ab");
    await page.keyboard.press("Backspace");
    await settle(200);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "a",
      "the key in the row did not rub out a letter");
    assert.equal((await savedBox(id)).done, false, "a backspace in the row closed the card");

    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      row.value = "";
      row.blur();
    });
    const closed = page.waitForResponse(response => new URL(response.url()).pathname === "/close");
    await page.keyboard.press("Backspace");
    assert.equal((await closed).status(), 200);
    await settle(400);
    assert.equal((await savedBox(id)).done, true, "the key did not close the card");
    assert.equal(await shownId(page), keep, "the close left the screen on the card that has gone");

    // a card an agent dropped is not one the cross appears on, and the key
    // leaves it exactly as the board's key does
    await chord(page, "2", "Meta");
    await page.waitForFunction(() => activeOwner === "pastureland", { timeout: 3000 });
    await page.evaluate(() => {
      [...document.querySelectorAll("#tiklist .trow")].find(row => row.dataset.id === "1.1").click();
    });
    await settle(150);
    assert.equal(await shownId(page), "1.1");
    await page.keyboard.press("Backspace");
    await settle(400);
    assert.equal((await savedBox("1.1")).done, false, "the key closed a card the board's own key leaves alone");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

for (const surface of ["phone", "desktop"]) {
  test(`${surface} S and N move the selected card to Deferred and Doing`, async () => {
    await clearLane();
    const id = await create(`${surface} destination keys`);
    await api(`/reply?box=${id}`, "A reply to answer.");
    const neighbour = await create(`${surface} key repeat neighbour`);
    await api(`/reply?box=${neighbour}`, "A second reply.");
    const { page, problems } = surface === "phone"
      ? await openPhone(`/m?box=${id}`) : await openDesktop();
    const requests = [];
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/park" || url.pathname === "/done") requests.push(url);
    });
    try {
      if (surface === "desktop") await selectDesktop(page, id);
      else await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
      await page.focus(SEL);
      await page.keyboard.type("sn");
      assert.equal(await page.$eval(SEL, field => field.value), "sn",
        "the composer did not receive the destination letters");
      assert.equal(requests.length, 0, "typing in the composer changed card state");
      await page.evaluate(cardId => editTitle(cardId), id);
      await page.keyboard.type("sn");
      assert.equal(await page.evaluate(cardId => els[cardId].titleEl.textContent, id), "sn",
        "the title did not receive the destination letters");
      assert.equal(requests.length, 0, "typing in the title changed card state");
      await page.evaluate(() => document.activeElement.blur());
      await page.evaluate(() => {
        for (const options of [
          { key: "s", metaKey: true }, { key: "n", ctrlKey: true },
          { key: "s", shiftKey: true }, { key: "n", altKey: true },
          { key: "s", isComposing: true }, { key: "n", isComposing: true },
          { key: "s", repeat: true }, { key: "n", repeat: true },
        ]) dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...options }));
      });
      assert.equal(requests.length, 0, "a modified or composing key changed card state");

      let response = page.waitForResponse(r => new URL(r.url()).pathname === "/park");
      await page.keyboard.press("s");
      assert.equal((await response).status(), 200);
      await page.waitForFunction(cardId => els[cardId].box.classList.contains("parked"), {}, id);
      assert.equal((await savedBox(id)).parked, true);
      await page.evaluate(cardId => {
        select(cardId);
        dispatchEvent(new KeyboardEvent("keydown", { key: "s", repeat: true, bubbles: true }));
      }, neighbour);
      assert.equal((await savedBox(neighbour)).parked, false,
        "holding S moved the next selected card to Deferred");
      assert.equal(requests.length, 1, "the repeated S sent another state request");
      await page.evaluate(cardId => select(cardId), id);
      await page.keyboard.press("s");
      await settle(120);
      assert.equal(requests.length, 1, "S toggled an already Deferred card");

      response = page.waitForResponse(r => new URL(r.url()).pathname === "/park" && new URL(r.url()).searchParams.get("v") === "0");
      await page.keyboard.press("n");
      assert.equal((await response).status(), 200);
      await page.waitForFunction(cardId => !els[cardId].box.classList.contains("parked"), {}, id);
      assert.equal((await savedBox(id)).parked, false);
      await page.keyboard.press("n");
      await settle(120);
      assert.equal(requests.length, 2, "N sent a request for an already Doing card");

      await api(`/done?box=${id}&v=1`);
      await page.evaluate(() => poll());
      await page.waitForFunction(cardId => els[cardId].box.classList.contains("done"), {}, id);
      response = page.waitForResponse(r => new URL(r.url()).pathname === "/done" && new URL(r.url()).searchParams.get("v") === "0");
      await page.keyboard.press("n");
      assert.equal((await response).status(), 200);
      assert.equal((await savedBox(id)).done, false, "N did not restore a Done card to Doing");

      await api(`/done?box=${id}&v=1`);
      await page.evaluate(() => poll());
      await page.waitForFunction(cardId => els[cardId].box.classList.contains("done"), {}, id);
      response = page.waitForResponse(r => new URL(r.url()).pathname === "/park" && new URL(r.url()).searchParams.get("v") === "1");
      await page.keyboard.press("s");
      assert.equal((await response).status(), 200);
      const moved = await savedBox(id);
      assert.equal(moved.parked, true, "S did not move a Done card to Deferred");
      assert.equal(moved.done, false, "S left the card in Done");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

for (const { surface, route, action } of [
  { surface: "phone", route: "/m", action: "button" },
  { surface: "phone", route: "/m", action: "shortcut" },
  { surface: "desktop", route: "/", action: "button" },
  { surface: "desktop", route: "/", action: "shortcut" },
  { surface: "document page", route: "/page", action: "button" },
]) {
  test(`${surface} Snooze ${action} shows another Doing card`, async () => {
    await clearLane();
    const deferred = await create(`${surface} ${action} to defer`);
    const next = await create(`${surface} ${action} to show`);
    const { page, problems } = route === "/m"
      ? await openPhone(`${route}?box=${deferred}`) : await openDesktop(route);
    try {
      if (route !== "/m") await selectDesktop(page, deferred);
      else await page.waitForSelector(`#box-${deferred}.sel`, { timeout: 5000 });
      const response = page.waitForResponse(r => {
        const url = new URL(r.url());
        return url.pathname === "/park" && url.searchParams.get("box") === deferred &&
          url.searchParams.get("v") === "1";
      });
      if (action === "button"){
        await page.evaluate(id => document.getElementById("box-" + id).querySelector(".arcbtn").click(), deferred);
      } else {
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press("s");
      }
      assert.equal((await response).status(), 200);
      await page.waitForFunction(id => selectedId === id, { timeout: 5000 }, next);
      assert.equal(await shownId(page), next);
      assert.equal((await savedBox(deferred)).parked, true);
      assert.equal(await page.evaluate(() => activeOwner), "facilitator");

      // Opening the Deferred list is a deliberate selection; a second S is
      // still a destination, and the moon may reverse the park in place.
      await page.evaluate(id => {
        document.getElementById("tv-deferred").click();
        select(id);
      }, deferred);
      await settle(100);
      assert.equal(await shownId(page), deferred);
      if (action === "shortcut"){
        await page.evaluate(() => document.activeElement.blur());
        await page.keyboard.press("s");
        await settle(100);
        assert.equal((await savedBox(deferred)).parked, true);
        assert.equal(await shownId(page), deferred);
      }
      await page.evaluate(id => document.getElementById("box-" + id).querySelector(".arcbtn").click(), deferred);
      await page.waitForFunction(id => !els[id].box.classList.contains("parked"), { timeout: 5000 }, deferred);
      assert.equal(await shownId(page), deferred);
      assert.equal((await savedBox(deferred)).parked, false);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

test("Snooze uses Done's empty-Doing fallback and keeps project selection local", async () => {
  await clearLane();
  const last = await create("Last Doing card");
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, last);
    const atTap = await page.evaluate(id => {
      document.getElementById("box-" + id).querySelector(".arcbtn").click();
      return selectedId;
    }, last);
    assert.equal(atTap, null, "the last Doing card did not use Done's deselection fallback");
    await page.waitForFunction(id => els[id].box.classList.contains("parked"), { timeout: 5000 }, last);
    assert.equal((await savedBox(last)).parked, true);
    await settle(350);
    assert.notEqual(await shownId(page), last, "the only Doing card returned after Snooze settled");

    const pair = await create("A Doing card after the empty lane");
    await page.evaluate(() => poll());
    await selectDesktop(page, pair);
    await page.evaluate(() => setTab("pastureland"));
    assert.equal(await page.evaluate(() => activeOwner), "pastureland");
    await page.evaluate(() => setTab("facilitator"));
    assert.equal(await shownId(page), pair, "the snoozed card replaced this lane's remembered Doing selection");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone Snooze clears the last Doing card from the screen", async () => {
  await clearLane();
  const last = await create("Phone last Doing card");
  const { page, problems } = await openPhone(`/m?box=${last}`);
  try {
    await page.waitForSelector(`#box-${last}.sel`, { timeout: 5000 });
    const atTap = await page.evaluate(id => {
      document.getElementById("box-" + id).querySelector(".arcbtn").click();
      return selectedId;
    }, last);
    assert.equal(atTap, null);
    assert.equal((await savedBox(last)).parked, true);
    await settle(350);
    assert.notEqual(await shownId(page), last);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("destination letters stay in the desktop Markdown editor", async () => {
  await clearLane();
  const id = await create("Markdown destination keys");
  const { page, problems } = await openDesktop();
  const flags = [];
  page.on("request", request => {
    const route = new URL(request.url()).pathname;
    if (route === "/park" || route === "/done") flags.push(route);
  });
  try {
    await selectDesktop(page, id);
    await page.evaluate(async () => {
      mdMounts(["unused", "facilitator"]);
      mdBoxes();
      const host = mdBuild(MD_MOUNTS.facilitator);
      if (!host || !await mdBundle()) throw new Error("Markdown editor could not mount");
      mdFor = "facilitator";
      mdOpen = { lane: mdFor, root: "fixture-internal", rel: "fixture.md", mtime: "1" };
      mdClean = "editor text";
      mdMount(host, mdClean, false);
      host.classList.add("editing");
    });
    await page.click("#magic4 .cm-content");
    await page.keyboard.type("sn");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor textsn");
    assert.deepEqual(flags, [], "typing in Markdown changed card state");
    const state = await savedBox(id);
    assert.equal(state.done, false);
    assert.equal(state.parked, false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// where the phone's old return-to-the-last-card fired: the send has just moved
// the screen on, which is exactly when the chord used to walk back
test("after the phone send's move, command z and control z move no card and stay the row's", async () => {
  await clearLane();
  const from = await create("Sent from here");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Waiting on him");
  await api(`/reply?box=${waiting}`, "Another reply, still waiting.");
  const { page, problems } = await openPhone(`/m?box=${from}`);
  try {
    await page.waitForSelector(`#box-${from}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.keyboard.type("A message typed on a keyboard");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await page.waitForFunction(id => document.querySelector("article.box.sel")?.id === "box-" + id, { timeout: 3000 }, waiting);

    await watchUndoKeys(page);
    await page.focus(SEL);
    await page.keyboard.type("half a thought, unsent");
    assertLeftToTheField(await pressUndoChords(page), "the phone row");
    assert.equal(await shownId(page), waiting, "an undo chord walked back to the card the send's move left");
    // the row's own undo and redo, on words typed after the chords above, since
    // a row that answers them has already taken those words back and forth
    await page.$eval(SEL, field => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.focus(SEL);
    await page.keyboard.type("half a thought, unsent");
    assertUndoStackIntact(await editorUndoRedo(page, SEL), "the phone row");
    assert.equal(await page.$eval(SEL, field => field.value), "half a thought, unsent",
      "the row's redo did not leave the words it started with");

    // with the caret out of the row it is still nobody's card command
    await page.evaluate(() => document.activeElement.blur());
    assertLeftToTheEditor(await pressUndoChords(page), "the phone with no caret in a row");
    assert.equal(await shownId(page), waiting, "an undo chord walked the cards with no caret in a row");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("enter sends and shift enter makes a line, and the return key still makes a line under the on-screen keyboard", async () => {
  await clearLane();
  const id = await create("The composer on a keyboard");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const waiting = await create("Waiting after one Enter");
  await api(`/reply?box=${waiting}`, "A second reply to leave waiting.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  const sends = [];
  page.on("response", response => { if (new URL(response.url()).pathname === "/send") sends.push(response.status()); });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    const composing = await page.$eval(SEL, field => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter", isComposing: true, bubbles: true, cancelable: true,
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(composing, false, "an IME composition Enter was claimed by send");
    assert.deepEqual(sends, []);
    await page.keyboard.type("first line");
    await chord(page, "Enter", "Shift");
    await page.keyboard.type("second line");
    await settle(150);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "first line\nsecond line",
      "shift and return did not make a new line");
    assert.deepEqual(sends, [], "shift and return sent the message");

    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(800);
    assert.deepEqual((await savedBox(id)).pendingTexts, ["first line\nsecond line"], "the return key did not send both lines");
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "",
      "the send did not empty the row");
    assert.equal(await shownId(page), id, "one Enter moved away from the sent card");

    // the on-screen keyboard up, played by the window shrinking with it: the
    // return key is a finger's return again, and sends nothing
    await page.focus(SEL);
    await page.setViewport({ ...PHONE, height: PHONE.height - KEYBOARD });
    await page.waitForFunction(() => document.body.classList.contains("kb"), { timeout: 3000 });
    await page.keyboard.type("by thumb");
    await page.keyboard.press("Enter");
    await page.keyboard.type("a second line");
    await settle(250);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "by thumb\na second line",
      "the return key did not make a line while the on-screen keyboard was up");
    assert.equal(sends.length, 1, "the return key sent while the on-screen keyboard was up");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("phone double Enter waits for delivery, rejects held repeats, and cancels on typing or refusal", async () => {
  await clearLane();
  const from = await create("Phone double Enter source");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Phone double Enter destination");
  await api(`/reply?box=${waiting}`, "Another reply waiting.");
  const { page, problems } = await openPhone(`/m?box=${from}`);
  try {
    await page.waitForSelector(`#box-${from}.sel`, { timeout: 5000 });
    await page.evaluate(() => {
      clearTimeout(pollTimer); pollTimer = null;
      window.__nativeFetch = window.fetch;
      window.__sendReplies = [];
      window.__enterRepeats = [];
      document.querySelector("article.box.sel textarea").addEventListener("keydown", event => {
        if (event.key === "Enter") window.__enterRepeats.push(event.repeat);
      });
      window.fetch = (...args) => {
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
        return new Promise(resolve => window.__sendReplies.push((status = 200) => resolve(new Response(
          JSON.stringify(status === 200 ? { ok: true, rev: lastRev } : { error: "fabricated refusal" }),
          { status, headers: { "Content-Type": "application/json" } }))));
      };
    });

    await page.focus(SEL);
    await page.keyboard.type("held Enter sends once");
    await page.keyboard.down("Enter");
    await page.keyboard.down("Enter");
    await page.keyboard.up("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.deepEqual(await page.evaluate(() => __enterRepeats.slice(-2)), [false, true],
      "the browser did not deliver the held key as a repeated keydown");
    assert.equal(await page.evaluate(() => localSends(selectedId)[0].advance), false,
      "a held Enter requested a card move");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => ops.filter(op => op.kind === "send").length === 0);
    await settle(800);
    assert.equal(await shownId(page), from, "a held Enter moved after delivery");

    await page.focus(SEL);
    await page.keyboard.type("double Enter moves later");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1 && localSends(selectedId)[0]?.advance);
    assert.equal(await shownId(page), from, "the second Enter moved before delivery confirmation");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);

    await page.evaluate(id => select(id), from);
    await page.focus(SEL);
    await page.keyboard.type("typing cancels the move");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("draft after the request");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await page.evaluate(() => localSends(selectedId)[0].advance), false,
      "typing did not cancel the pending move");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => ops.filter(op => op.kind === "send").length === 0);
    await settle(80);
    assert.equal(await shownId(page), from);
    assert.equal(await page.$eval(SEL, field => field.value), "draft after the request");

    await page.$eval(SEL, field => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.keyboard.type("view change cancels the move");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1 && localSends(selectedId)[0]?.advance);
    await page.evaluate(() => setView("deferred"));
    assert.equal(await page.evaluate(id => localSends(id)[0].advance, from), false,
      "changing the phone view did not cancel the pending move");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => ops.filter(op => op.kind === "send").length === 0);
    await settle(80);
    assert.equal(await shownId(page), from);
    await page.evaluate(() => setView("todo"));

    await page.keyboard.type("refused double Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1 && localSends(selectedId)[0]?.advance);
    await page.evaluate(() => window.__sendReplies.shift()(400));
    await page.waitForFunction(id => localSends(id).some(op => op.state === "failed"), { timeout: 3000 }, from);
    assert.equal(await shownId(page), from, "a refused send moved away from its failure");
    assert.match(await page.evaluate(id => els[id].pend.textContent, from), /not sent/i);
    assert.deepEqual(problems.filter(problem => !/status of 400 \(Bad Request\)/.test(problem)), []);
  } finally {
    await page.close();
  }
});

test("phone send arrow sends once, preserves focus, and moves only on a quick second tap", async () => {
  await clearLane();
  const from = await create("Phone arrow source");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Phone arrow destination");
  await api(`/reply?box=${waiting}`, "Another reply waiting.");
  const { page, problems } = await openPhone(`/m?box=${from}`);
  try {
    await page.waitForSelector(`#box-${from}.sel`, { timeout: 5000 });
    await page.evaluate(() => {
      clearTimeout(pollTimer); pollTimer = null;
      window.__nativeFetch = window.fetch;
      window.__sendReplies = [];
      window.fetch = (...args) => {
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
        return new Promise(resolve => window.__sendReplies.push((status = 200) => resolve(new Response(
          JSON.stringify(status === 200 ? { ok: true, rev: lastRev } : { error: "refused" }),
          { status, headers: { "Content-Type": "application/json" } }))));
      };
    });
    await page.focus(SEL);
    await page.setViewport({ ...PHONE, height: PHONE.height - KEYBOARD });
    await page.waitForFunction(() => document.body.classList.contains("kb"), { timeout: 3000 });
    await page.keyboard.type("arrow message");
    await settle(500);
    await page.tap("article.box.sel .sendbtn");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.deepEqual(await page.evaluate(() => ({
      text: document.querySelector("article.box.sel textarea").value,
      shown: document.querySelector("article.box.sel .sendbtn").classList.contains("show"),
      focused: ComposeFormat.focused(document.querySelector("article.box.sel textarea")),
      keyboard: document.body.classList.contains("kb"),
      advance: localSends(selectedId)[0].advance,
    })), { text: "", shown: true, focused: true, keyboard: true, advance: false });
    await page.tap("article.box.sel .sendbtn");
    assert.equal(await page.evaluate(() => window.__sendReplies.length), 1);
    assert.equal(await shownId(page), from);
    assert.equal(await page.evaluate(() => localSends(selectedId)[0].advance), true);
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);
    await page.setViewport(PHONE);
    await settle(500);
    await page.focus(SEL);
    await page.keyboard.type("arrow with closed keyboard");
    await page.evaluate(() => document.activeElement.blur());
    await page.tap("article.box.sel .sendbtn");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await page.evaluate(() => ComposeFormat.focused(document.querySelector("article.box.sel textarea"))), false,
      "the arrow opened an unfocused row");
    assert.equal(await page.$eval(SEL, field => field.value), "");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => ops.filter(op => op.kind === "send").length === 0);
    await settle(800);
    assert.equal(await shownId(page), waiting, "one tap with the keyboard closed moved cards");
    await page.evaluate(id => select(id), from);
    await page.focus(SEL);
    await page.keyboard.type("refused arrow send");
    await page.tap("article.box.sel .sendbtn");
    await page.tap("article.box.sel .sendbtn");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await page.evaluate(() => window.__sendReplies.shift()(400));
    await page.waitForFunction(id => localSends(id).some(op => op.state === "failed"), { timeout: 3000 }, from);
    assert.equal(await shownId(page), from, "a refused arrow send moved away from its failure");
    const refusedArrow = await page.evaluate(() => ({
      shown: document.querySelector("article.box.sel .sendbtn").classList.contains("show"),
      text: document.querySelector("article.box.sel textarea").value,
      armed: !!phoneArrowAgainFor(selectedId),
    }));
    assert.equal(refusedArrow.armed, false, "a refused send left navigation armed");
    assert.equal(refusedArrow.shown, !!refusedArrow.text.trim(), "the arrow did not match the remaining draft");
    assert.deepEqual(problems.filter(problem => !/status of 400 \(Bad Request\)/.test(problem)), []);
  } finally {
    await page.close();
  }
});

test("desktop double Enter waits for delivery and failed sends restore their text", async () => {
  await clearLane();
  const from = await create("Desktop double Enter source");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Desktop double Enter destination");
  await api(`/reply?box=${waiting}`, "Another reply waiting.");
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, from);
    await page.evaluate(() => {
      window.__nativeFetch = window.fetch;
      window.__sendReplies = [];
      window.fetch = (...args) => {
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
        return new Promise(resolve => window.__sendReplies.push((status = 200) => resolve(new Response("", { status }))));
      };
    });
    await page.focus(SEL);
    const composing = await page.$eval(SEL, field => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter", isComposing: true, bubbles: true, cancelable: true,
      });
      field.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(composing, false, "desktop claimed an IME composition Enter");
    assert.equal(await page.evaluate(() => window.__sendReplies.length), 0);
    await page.keyboard.type("single Enter stays");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await page.$eval(SEL, field => field.value), "",
      "the pending desktop send did not leave an empty row for the second Enter");
    await page.evaluate(() => window.__sendReplies.shift()());
    await settle(800);
    assert.equal(await shownId(page), from, "one desktop Enter moved after delivery");

    await page.focus(SEL);
    await page.keyboard.type("double Enter moves later");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await shownId(page), from, "desktop moved before the held response arrived");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);

    await selectDesktop(page, from);
    await page.focus(SEL);
    await page.keyboard.type("manual selection cancels the move");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await selectDesktop(page, waiting);
    await page.evaluate(() => window.__sendReplies.shift()());
    await settle(80);
    assert.equal(await shownId(page), waiting,
      "a delayed desktop confirmation stole a manual selection");

    await selectDesktop(page, from);
    await page.focus(SEL);
    await page.keyboard.type("desktop failure remains visible");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await page.$eval(SEL, field => {
      field.value = "newer draft\n";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => window.__sendReplies.shift()(500));
    await page.waitForFunction(id => els[id].metaNote.textContent.includes("send failed"), { timeout: 3000 }, from);
    assert.equal(await shownId(page), from);
    assert.equal(await page.$eval(SEL, field => field.value),
      "newer draft\n\ndesktop failure remains visible",
      "restoring a failed send changed or replaced text typed while it was pending");

    await page.$eval(SEL, field => {
      field.value = "the first send arrow stays";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await page.$eval(SEL, field => field.value), "");
    assert.equal(await shownId(page), from);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").classList.contains("show")), true);
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    assert.equal(await page.evaluate(() => window.__sendReplies.length), 1,
      "the second arrow sent the message again");
    assert.equal(await shownId(page), from, "the send button moved before delivery");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);
    await selectDesktop(page, from);
    await page.focus(SEL);
    await page.keyboard.type("failed arrow message");
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await page.evaluate(() => window.__sendReplies.shift()(500));
    await page.waitForFunction(id => els[id].metaNote.textContent.includes("send failed"), { timeout: 3000 }, from);
    assert.equal(await shownId(page), from);
    assert.equal(await page.$eval(SEL, field => field.value), "failed arrow message");
    assert.equal(await page.evaluate(() => !!arrowAgainFor(selectedId)), false);
    await page.$eval(SEL, field => {
      field.value = "arrow expires on this card";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await settle(800);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").classList.contains("show")), false);
    await page.evaluate(() => window.__sendReplies.shift()());
    await settle(80);
    assert.equal(await shownId(page), from, "an expired arrow intent moved after delivery");
    assert.deepEqual(problems.filter(problem => !/status of 500/.test(problem)), []);
  } finally {
    await page.close();
  }
});

test("phone plain arrows keep editor cursors and walk cards only without modifiers", async () => {
  await clearLane();
  const first = await create("Arrows on the phone");
  await api(`/reply?box=${first}`, "A reply to answer.");
  const other = await create("The card next door");
  await api(`/reply?box=${other}`, "Another reply.");
  const { page, problems } = await openPhone(`/m?box=${first}`);
  try {
    await page.waitForSelector(`#box-${first}.sel`, { timeout: 5000 });
    await page.focus(SEL);
    await page.keyboard.type("abcd");
    await page.keyboard.press("ArrowLeft");
    await settle(120);
    const typed = await page.evaluate(() => ({
      caret: document.querySelector("article.box.sel textarea").selectionStart,
      id: document.querySelector("article.box.sel").id,
    }));
    assert.equal(typed.caret, 3, "the arrow did not move the caret in the row");
    assert.equal(typed.id, `box-${first}`, "a plain arrow walked the cards while he was typing");

    const order = await page.evaluate(() => navigationPool(lastState).map(box => box.id));
    const start = order.indexOf(first);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("ArrowRight");
    await settle(120);
    const next = order[(start + 1) % order.length];
    assert.equal(await shownId(page), next, "a bare arrow did not walk the cards");

    for (const modifier of ["Alt", "Control", "Meta", "Shift"]){
      await chord(page, "ArrowLeft", modifier);
      assert.equal(await shownId(page), next, `${modifier} and arrow was mistaken for a plain arrow`);
    }

    const descendant = await page.evaluate(() => {
      const title = document.querySelector("article.box.sel .title");
      title.setAttribute("contenteditable", "true");
      const child = document.createElement("span");
      child.textContent = "nested editor target";
      title.textContent = "";
      title.appendChild(child);
      const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
      child.dispatchEvent(event);
      title.removeAttribute("contenteditable");
      return { prevented: event.defaultPrevented, selectedId };
    });
    assert.deepEqual(descendant, { prevented: false, selectedId: next },
      "an editor descendant lost its native plain arrow");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("desktop aliases walk the visible cards and preserve their focus rules", async () => {
  await clearLane();
  const ids = [];
  for (const name of ["First desktop shortcut", "Second desktop shortcut", "Third desktop shortcut"]) {
    const id = await create(name);
    await api(`/reply?box=${id}`, "A reply to answer.");
    ids.push(id);
  }
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, ids[0]);
    const order = await listOrder(page);
    const start = order.indexOf(ids[0]);

    await page.evaluate(() => document.activeElement?.blur());
    await chord(page, "ArrowRight", "Control", "Shift");
    assert.equal(await shownId(page), order[(start + 1) % order.length]);
    assert.deepEqual(await activeRow(page), {
      row: true, box: order[(start + 1) % order.length],
    }, "desktop card stepping did not focus the destination composer");

    await chord(page, "[", "Meta", "Shift");
    assert.equal(await shownId(page), ids[0], "the bracket alias did not step back");
    await page.keyboard.type("abcd");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.$eval(SEL, field => field.selectionStart), 3,
      "a plain arrow did not remain native in the composer");
    assert.equal(await shownId(page), ids[0]);

    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("ArrowRight");
    const plainDestination = order[(start + 1) % order.length];
    assert.equal(await shownId(page), plainDestination,
      "the desktop-only plain-arrow fallback stopped walking cards");
    assert.equal((await activeElement(page)).tag, "BODY",
      "the desktop fallback unexpectedly focused a composer");
    for (const modifier of ["Alt", "Control", "Meta", "Shift"]){
      await chord(page, "ArrowLeft", modifier);
      assert.equal(await shownId(page), plainDestination,
        `${modifier} and arrow was mistaken for a desktop plain arrow`);
    }
    const descendant = await page.evaluate(() => {
      const host = document.createElement("div");
      host.setAttribute("contenteditable", "true");
      const child = document.createElement("span");
      host.appendChild(child);
      document.body.appendChild(host);
      const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
      child.dispatchEvent(event);
      host.remove();
      return { prevented: event.defaultPrevented, selectedId };
    });
    assert.deepEqual(descendant, { prevented: false, selectedId: plainDestination },
      "a desktop editor descendant lost its native plain arrow");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("desktop history controls appear for a prior reply and share keyboard history", async () => {
  await clearLane();
  const id = await create("Desktop reply history");
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, id);
    const hidden = await page.evaluate(cardId => {
      const el = els[cardId], bar = el.topbar.getBoundingClientRect();
      el.histUp.focus();
      const style = getComputedStyle(el.histctl);
      return {
        replies: lastState.boxes.find(box => box.id === cardId).replies,
        branchNodes: el.topbar.querySelectorAll(".branch, .wtpick, .wtmenu").length,
        hasHistory: el.box.classList.contains("hashist"),
        opacity: style.opacity, visibility: style.visibility, pointerEvents: style.pointerEvents,
        upDisabled: el.histUp.disabled, downDisabled: el.histDown.disabled,
        upTab: el.histUp.tabIndex, downTab: el.histDown.tabIndex,
        focused: document.activeElement === el.histUp,
        geometry: { top: bar.top, height: bar.height,
          arcLeft: el.arc.getBoundingClientRect().left, closeLeft: el.x.getBoundingClientRect().left,
          titleTop: el.titleEl.getBoundingClientRect().top },
      };
    }, id);
    assert.equal(hidden.replies, 0);
    assert.equal(hidden.branchNodes, 0, "the dormant branch selector still rendered");
    assert.deepEqual({ hasHistory: hidden.hasHistory, opacity: hidden.opacity,
      visibility: hidden.visibility, pointerEvents: hidden.pointerEvents,
      upDisabled: hidden.upDisabled, downDisabled: hidden.downDisabled,
      upTab: hidden.upTab, downTab: hidden.downTab, focused: hidden.focused }, {
      hasHistory: false, opacity: "0", visibility: "hidden", pointerEvents: "none",
      upDisabled: true, downDisabled: true, upTab: -1, downTab: -1, focused: false,
    });
    await historyShot(page, "after-new-card");

    // A user's message, several progress notes, and one final reply still have
    // only one agent reply. Notes raise the aggregate replies count but are not
    // entries the history stepper can navigate.
    assert.equal((await api(`/send?box=${id}`, "Initial owner message.")).status, 200);
    assert.equal((await api(`/note?box=${id}`, "First progress note.")).status, 200);
    assert.equal((await api(`/note?box=${id}`, "Second progress note.")).status, 200);
    assert.equal((await api(`/reply?box=${id}`, "First desktop reply.")).status, 200);
    await page.evaluate(() => poll());
    await page.waitForFunction(cardId =>
      lastState.boxes.find(box => box.id === cardId)?.replies === 3, { timeout: 5000 }, id);
    const firstThread = await (await fetch(origin + `/thread?box=${id}&n=200`)).json();
    assert.deepEqual(firstThread.messages.map(message => message.kind), ["user", "note", "note", "agent"]);
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id), [],
      "the note-heavy card unexpectedly had an older agent reply");
    assert.equal(await page.evaluate(cardId => els[cardId].box.classList.contains("hashist"), id), false,
      "progress notes plus the live reply exposed an empty history control");

    // The same card must stay correct when it already has those aggregate
    // counts at page load, not only when the entries arrive during a poll.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
    await selectDesktop(page, id);
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id), []);
    assert.equal(await page.evaluate(cardId => els[cardId].box.classList.contains("hashist"), id), false,
      "an existing note-heavy card exposed an empty history control after reload");

    // A user follow-up and its answer create the first actual prior reply. The
    // first attempt to read that history fails with a JSON service error. The
    // marks stand on the count the board sent with the card, so a request that
    // failed neither takes them away nor is kept as an answer about the card,
    // and the list itself recovers through an ordinary poll without another
    // reply, selection change, cache edit, or reload.
    let historyRequests = 0;
    const historyProblemStart = problems.length;
    const interceptHistory = request => {
      const url = new URL(request.url());
      if (url.pathname === "/history" && url.searchParams.get("box") === id){
        historyRequests += 1;
        if (historyRequests === 1){
          request.respond({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "temporary overload" }),
          }).catch(() => {});
          return;
        }
      }
      request.continue().catch(() => {});
    };
    page.on("request", interceptHistory);
    await page.setRequestInterception(true);
    assert.equal((await api(`/send?box=${id}`, "Owner follow-up.")).status, 200);
    assert.equal((await api(`/reply?box=${id}`, "Second desktop reply.")).status, 200);
    await page.evaluate(() => poll());
    await page.waitForFunction(cardId =>
      lastState.boxes.find(box => box.id === cardId)?.replies === 4, { timeout: 5000 }, id);
    const firstRequestDeadline = Date.now() + 2000;
    while (historyRequests < 1 && Date.now() < firstRequestDeadline) await settle(25);
    assert.equal(historyRequests, 1, "the selected card did not request its changed history");
    await settle(80);
    assert.deepEqual(await page.evaluate(cardId => ({
      boardOlder: lastState.boxes.find(box => box.id === cardId).olderReplies,
      hasHistory: els[cardId].box.classList.contains("hashist"),
      olderDisabled: els[cardId].histUp.disabled,
      cached: Object.prototype.hasOwnProperty.call(histCache, cardId),
    }), id), { boardOlder: 1, hasHistory: true, olderDisabled: false, cached: false },
    "a failed history request either erased the board's own count or became a reusable empty result");

    const retryDeadline = Date.now() + 3500;
    while (historyRequests < 2 && Date.now() < retryDeadline) await settle(25);
    assert.equal(historyRequests, 2, "ordinary polling did not retry the failed history request");
    await page.waitForFunction(cardId =>
      els[cardId].box.classList.contains("hashist") && !els[cardId].histUp.disabled,
      { timeout: 3000 }, id);
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id), ["First desktop reply."],
      "the retried request did not restore the reply the stepper walks back to");
    const injectedProblems = problems.splice(historyProblemStart);
    assert.equal(injectedProblems.length, 1,
      "the injected history failure produced unexpected console output");
    assert.match(injectedProblems[0], /503 \(Service Unavailable\)/);
    page.off("request", interceptHistory);
    await page.setRequestInterception(false);
    await settle(80);
    const shown = await page.evaluate(cardId => {
      const el = els[cardId], style = getComputedStyle(el.histctl);
      const bar = el.topbar.getBoundingClientRect();
      const arrowMatrix = button => {
        const transform = getComputedStyle(button.querySelector("svg")).transform;
        const matrix = new DOMMatrix(transform === "none" ? undefined : transform);
        return [matrix.a, matrix.b, matrix.c, matrix.d].map(n => Math.round(n));
      };
      return {
        opacity: style.opacity, visibility: style.visibility, pointerEvents: style.pointerEvents,
        transitions: {
          properties: style.transitionProperty.split(", "),
          durations: style.transitionDuration.split(", "),
          sameTimingAsSend: style.transitionTimingFunction.startsWith(
            getComputedStyle(el.send).transitionTimingFunction),
        },
        upDisabled: el.histUp.disabled, downDisabled: el.histDown.disabled,
        upTab: el.histUp.tabIndex, downTab: el.histDown.tabIndex,
        labels: [el.histUp.getAttribute("aria-label"), el.histDown.getAttribute("aria-label")],
        arrowTransforms: [arrowMatrix(el.histUp), arrowMatrix(el.histDown)],
        geometry: { top: bar.top, height: bar.height,
          arcLeft: el.arc.getBoundingClientRect().left, closeLeft: el.x.getBoundingClientRect().left,
          titleTop: el.titleEl.getBoundingClientRect().top },
      };
    }, id);
    assert.equal(shown.visibility, "visible");
    assert.equal(shown.pointerEvents, "auto");
    assert.ok(Number(shown.opacity) > 0 && Number(shown.opacity) <= 1);
    assert.deepEqual(shown.transitions.properties, ["opacity", "transform", "visibility"]);
    assert.deepEqual(shown.transitions.durations.slice(0, 2), ["0.26s", "0.26s"]);
    assert.equal(shown.transitions.sameTimingAsSend, true,
      "the history controls did not use the composer arrow's fade curve");
    assert.deepEqual({ upDisabled: shown.upDisabled, downDisabled: shown.downDisabled,
      upTab: shown.upTab, downTab: shown.downTab },
    { upDisabled: false, downDisabled: true, upTab: 0, downTab: 0 });
    assert.deepEqual(shown.labels, ["older reply", "newer reply"]);
    assert.deepEqual(shown.arrowTransforms, [[1, 0, 0, 1], [-1, 0, 0, -1]],
      "the older and newer arrows did not point up and down");
    for (const key of ["top", "height", "arcLeft", "closeLeft"])
      assert.ok(Math.abs(hidden.geometry[key] - shown.geometry[key]) < 0.5,
        `${key} moved when reply history appeared`);
    const layout = await page.evaluate(cardId => {
      const el = els[cardId];
      const read = () => {
        const bar = el.topbar.getBoundingClientRect();
        return { top: bar.top, height: bar.height,
          arcLeft: el.arc.getBoundingClientRect().left, closeLeft: el.x.getBoundingClientRect().left,
          titleTop: el.titleEl.getBoundingClientRect().top };
      };
      el.box.classList.remove("hashist");
      getComputedStyle(el.histctl).opacity;
      const withoutMarks = read();
      el.box.classList.add("hashist");
      getComputedStyle(el.histctl).opacity;
      return { withoutMarks, withMarks: read() };
    }, id);
    for (const key of Object.keys(layout.withoutMarks))
      assert.ok(Math.abs(layout.withoutMarks[key] - layout.withMarks[key]) < 0.5,
        `${key} moved when only the history marks changed`);
    await settle(300);
    await historyShot(page, "after-history-available");

    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.id === cardId && hist.step === 1, { timeout: 5000 }, id);
    assert.equal(await page.$eval("article.box.sel .reply", el => el.textContent), "First desktop reply.");
    assert.deepEqual(await page.evaluate(cardId => ({
      position: els[cardId].histPos.textContent,
      upDisabled: els[cardId].histUp.disabled,
      downDisabled: els[cardId].histDown.disabled,
    }), id), { position: "1 of 2", upDisabled: true, downDisabled: false });
    await historyShot(page, "after-older-reply");

    await page.click(`#box-${id} .histbtn.newer`);
    await page.waitForFunction(() => !document.querySelector("article.box.sel").classList.contains("histview"));
    assert.equal(await page.$eval("article.box.sel .reply", el => el.textContent), "Second desktop reply.");

    // The established keyboard path remains the same and keeps the composer caret.
    await page.focus(SEL);
    await chord(page, "ArrowUp", "Control", "Shift");
    await settle(300);
    assert.equal(await page.$eval("article.box.sel .reply", el => el.textContent), "First desktop reply.",
      "the first history step did not show the older reply");
    assert.deepEqual(await page.evaluate(() => hist && ({ id: hist.id, step: hist.step })), { id, step: 1 });
    assert.equal((await activeRow(page)).row, true);
    await chord(page, "ArrowUp", "Control", "Shift");
    assert.equal(await page.evaluate(() => hist.step), 1,
      "history stepped beyond its oldest reply");
    await chord(page, "ArrowDown", "Control", "Shift");
    await page.waitForFunction(() => !document.querySelector("article.box.sel").classList.contains("histview"));
    assert.equal((await activeRow(page)).row, true);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("visible and locked desktop tabs define command-number ordinals", async () => {
  await api("/tabs", JSON.stringify({
    order: ["pastureland", "facilitator"], closed: ["pastureland"],
  }));
  const { page, problems } = await openDesktop("/");
  try {
    await page.waitForFunction(() => activeOwner === "facilitator");
    await page.evaluate(() => {
      window.shortcutObserved = null;
      addEventListener("keydown", event => {
        window.shortcutObserved = { key: event.key, prevented: event.defaultPrevented };
      });
    });
    await chord(page, "2", "Meta");
    assert.equal(await page.evaluate(() => activeOwner), "facilitator",
      "a closed tab still occupied a number ordinal");
    assert.deepEqual(await page.evaluate(() => window.shortcutObserved), { key: "2", prevented: false },
      "an unavailable tab target was claimed");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }

  const locked = await openDesktop("/?project=pastureland");
  try {
    await locked.page.waitForFunction(() => activeOwner === "pastureland");
    await chord(locked.page, "1", "Meta");
    assert.equal(await locked.page.evaluate(() => activeOwner), "pastureland");
    await chord(locked.page, "2", "Meta");
    assert.equal(await locked.page.evaluate(() => activeOwner), "pastureland",
      "a locked window accepted a tab outside its singleton ordinal list");
    assert.deepEqual(locked.problems, []);
  } finally {
    await locked.page.close();
  }

  await api("/tabs", JSON.stringify({
    order: ["pastureland", "facilitator"], closed: ["pastureland", "facilitator"],
  }));
  const phone = await openPhone("/m");
  try {
    await chord(phone.page, "2", "Meta");
    await phone.page.waitForFunction(() => activeOwner === "facilitator");
    assert.deepEqual(phone.problems, []);
  } finally {
    await phone.page.close();
    await api("/tabs", JSON.stringify({ order: ["facilitator", "pastureland"], closed: [] }));
  }
});

// the desktop half of the same moment: the send has moved the board on, and the
// chord that used to walk back is the composer's undo and nothing else
test("after the desktop send's move, command z and control z move no card and stay the composer's", async () => {
  await clearLane();
  const from = await create("Desktop send return source");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Desktop send return destination");
  await api(`/reply?box=${waiting}`, "Another reply to answer.");
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, from);
    await page.focus(SEL);
    await page.keyboard.type("sent from desktop");
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);

    await watchUndoKeys(page);
    await page.focus(SEL);
    await page.keyboard.type("unsent draft stays here");
    assertLeftToTheField(await pressUndoChords(page), "the desktop composer");
    assert.equal(await shownId(page), waiting, "an undo chord walked back to the card the send's move left");
    assert.equal(await page.$eval(`#box-${from} textarea`, field => field.value), "",
      "an undo chord put the sent words back into the card they left");
    await page.$eval(SEL, field => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.focus(SEL);
    await page.keyboard.type("unsent draft stays here");
    assertUndoStackIntact(await editorUndoRedo(page, SEL), "the desktop composer");
    assert.equal(await page.$eval(SEL, field => field.value), "unsent draft stays here",
      "the composer's redo did not leave the draft it started with");

    // out of the composer the board hears the chord and still does nothing
    await page.evaluate(() => document.activeElement.blur());
    assertLeftToTheEditor(await pressUndoChords(page), "the desktop with no caret in a composer");
    assert.equal(await shownId(page), waiting, "an undo chord moved the board with no caret in a composer");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// the typed page is the third client and carried its own copy of this key, so
// it is asked the same question: first with the caret in the line it writes in,
// then straight after the send's own move, which is what the old chord walked
// back from
test("the typed page leaves command z and control z to the line, before and after a send's move", async () => {
  await clearLane();
  const from = await create("Typed page send source");
  await api(`/reply?box=${from}`, "A reply to answer.");
  const waiting = await create("Typed page send destination");
  await api(`/reply?box=${waiting}`, "Another reply to answer.");
  const { page, problems } = await openCardPage("/page", DESKTOP);
  const line = `.docsec[data-id="${from}"] .docreply`;
  try {
    await selectDesktop(page, from);
    await watchUndoKeys(page);
    await page.waitForSelector(line, { timeout: 5000 });
    await page.focus(line);
    await page.keyboard.type("half a thought, unsent");
    assertLeftToTheField(await pressUndoChords(page), "the typed page line");
    assert.equal(await shownId(page), from, "an undo chord walked the cards from the line");
    await page.$eval(line, el => { el.textContent = ""; });
    await page.focus(line);
    await page.keyboard.type("half a thought, unsent");
    assertUndoStackIntact(await editorUndoRedo(page, line), "the typed page line");
    assert.equal(await page.$eval(line, el => el.textContent), "half a thought, unsent",
      "the line's redo did not leave the words it started with");
    await page.$eval(line, el => { el.textContent = ""; el.blur(); });

    // the card's own send is the one that moves this page on, and the move is
    // the state the old chord read
    await page.evaluate(id => { els[id].ta.value = "sent from the typed page"; doSend(id); }, from);
    await page.waitForFunction(id => selectedId !== id, { timeout: 5000 }, from);
    const landed = await shownId(page);
    assert.notEqual(landed, from, "the send did not move on, so there was no move to walk back from");
    assertLeftToTheEditor(await pressUndoChords(page), "the typed page after its send moved on");
    assert.equal(await shownId(page), landed, "an undo chord walked back to the card the send's move left");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("desktop mini capture keeps its subset ahead of typing and the board", async () => {
  await clearLane();
  const first = await create("First mini shortcut");
  await api(`/reply?box=${first}`, "First mini reply.");
  const second = await create("Second mini shortcut");
  await api(`/reply?box=${second}`, "Second mini reply.");
  const { page, problems } = await openDesktop();
  const creates = createRequests(page);
  try {
    await page.waitForFunction(() => miniOrder.length >= 2 && selectedId !== null, { timeout: 5000 });
    await selectDesktop(page, first);
    await page.evaluate(id => { miniGo(id); renderMiniCards(lastState); }, first);
    await page.click("#magic2 .mbox:not(.off) textarea");
    const mainBefore = await shownId(page);
    await chord(page, "ArrowRight", "Control", "Shift");
    const miniAfter = await page.evaluate(() => miniId);
    assert.equal(miniAfter, second, "the mini shortcut did not step exactly once");
    assert.equal(await shownId(page), mainBefore, "mini stepping moved the main selection");
    assert.equal(await page.evaluate(() => ComposeFormat.focused(miniEls[miniId].ta)), true,
      "mini stepping from typing did not carry its caret");

    const flags = [];
    page.on("request", request => {
      const route = new URL(request.url()).pathname;
      if (route === "/park" || route === "/done") flags.push(route);
    });
    await page.evaluate(() => {
      document.activeElement.blur();
      dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
      dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
    });
    assert.deepEqual(flags, [], "mini focus let destination keys change the large card");

    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/create");
    await chord(page, "t", "Meta");
    assert.equal((await created).status(), 200);
    await settle(250);
    assert.equal(creates.length, 1, "mini command-T created more than one card");
    assert.equal(await shownId(page), mainBefore, "mini creation moved the main selection");

    // the capture listener owns two command families and undo is in neither, so
    // the small card's own composer keeps the chord, uncanceled, and the small
    // card's standing stop against the board keeps it there
    const miniComposer = "#magic2 .mbox:not(.off) textarea";
    await watchUndoKeys(page, miniComposer);
    await page.focus(miniComposer);
    const miniBefore = await page.evaluate(() => miniId);
    assertLeftToTheField(await pressUndoChords(page), "the mini composer");
    assert.deepEqual(await undoKeysBeyond(page), [],
      "the mini composer let the undo chords past its own stop");
    assert.equal(await page.evaluate(() => miniId), miniBefore, "an undo chord stepped the small card");
    assert.equal(await shownId(page), mainBefore, "an undo chord in the small card moved the main selection");

    await page.evaluate(() => miniEls[miniId].ta.focus());
    const blockedAt = await shownId(page);
    await chord(page, "]", "Meta", "Shift");
    assert.equal(await shownId(page), blockedAt,
      "a mini textarea let bracket navigation reach the board");
    await page.evaluate(() => document.activeElement.blur());
    await chord(page, "]", "Meta", "Shift");
    assert.notEqual(await shownId(page), blockedAt,
      "a bracket outside mini typing was redirected away from the board");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("desktop capture and component barriers retain keyboard priority", async () => {
  await clearLane();
  const neighbour = await create("Barrier neighbour card");
  await api(`/reply?box=${neighbour}`, "Neighbour reply.");
  const current = await create("Barrier current card");
  await api(`/reply?box=${current}`, "Current reply.");
  const { page, problems } = await openDesktop();
  const creates = createRequests(page);
  try {
    await selectDesktop(page, current);
    await page.evaluate(at => editTitle(at), current);
    await chord(page, "]", "Meta", "Shift");
    assert.equal(await shownId(page), current, "the shared title let board navigation escape its barrier");
    // and the same chord is live the moment the naming ends, so the barrier is
    // what held it, not a key that does nothing
    await page.evaluate(at => els[at].titleEl.blur(), current);
    await settle(120);
    await chord(page, "]", "Meta", "Shift");
    assert.equal(await shownId(page), neighbour, "the bracket outside the naming did not reach the board");
    await selectDesktop(page, current);

    await page.evaluate(() => {
      const host = document.createElement("span");
      host.id = "shortcut-inline-fixture";
      document.body.appendChild(host);
      inlineEdit(host, "local value", () => {});
    });
    await chord(page, "t", "Meta");
    await settle(120);
    assert.equal(creates.length, 0, "the inline editor let command-T reach the board");

    await page.evaluate(() => showOwnerRefusal("fixture refusal"));
    await chord(page, "t", "Meta");
    await settle(120);
    assert.equal(creates.length, 0, "owner refusal did not stop the board shortcut listener");
    await page.evaluate(() => { ownerRefused = false; document.getElementById("owner-refused")?.remove(); });

    await page.focus(`#box-${current} textarea`);
    await page.keyboard.type("picture draft");
    await page.evaluate(async () => {
      const host = document.getElementById("magic3");
      host.textContent = "";
      host.classList.add("filled");
      const img = document.createElement("img");
      img.className = "p3img";
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
      host.appendChild(img);
      await img.decode();
      host._p3 = { img };
      p3ZoomOpen(img);
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => !!p3Zoom?.closing), true,
      "picture Escape did not close through its capture handler");
    assert.equal(await page.evaluate(id => ComposeFormat.focused(els[id].ta), current), true,
      "picture Escape leaked to the board blur action");
    assert.equal(await page.$eval(`#box-${current} textarea`, field => field.value), "picture draft");
    await page.waitForFunction(() => p3Zoom === null, { timeout: 1500 });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("CodeMirror keeps its own undo and redo, and the board stays where it is", async () => {
  const neighbour = await create("CodeMirror neighbour card", "pastureland");
  await api(`/reply?box=${neighbour}`, "Neighbour reply.");
  const current = await create("CodeMirror current card", "pastureland");
  await api(`/reply?box=${current}`, "Current editor reply.");
  const { page, problems } = await openDesktop("/?project=pastureland");
  try {
    await selectDesktop(page, current);
    await watchUndoKeys(page);
    await page.evaluate(async ({ currentId }) => {
      select(currentId);
      mdBoxes();
      const host = mdBuild(MD_MOUNTS.pastureland);
      host.style.left = "32px";
      host.style.top = "32px";
      host.style.width = "340px";
      host.style.height = "520px";
      if (!await mdBundle()) throw new Error("CodeMirror bundle did not load");
      mdFor = "pastureland";
      mdOpen = { lane: "pastureland", root: "fixture-internal", rel: "fixture.md", mtime: "1" };
      mdClean = "editor text";
      mdMount(host, "editor text", false);
      host.classList.add("editing");
    }, { currentId: current });
    await page.click("#magic4 .cm-content");
    await page.keyboard.type("X");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor textX");
    await chord(page, "z", "Meta");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor text",
      "CodeMirror did not perform its own undo");
    await chord(page, "z", "Meta", "Shift");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor textX",
      "the shifted chord did not redo in CodeMirror");
    assert.equal(await shownId(page), current,
      "an undo chord moved the board while the editor was holding the keys");
    // the editor claims the chords it acts on; that claim is the editor's own,
    // and nothing of the board's is waiting behind it
    const seen = await undoKeysSeen(page);
    assert.equal(seen.length, 2, "an undo chord never got past the editor to the page");
    assert.deepEqual(seen.map(entry => entry.prevented), [true, true],
      "CodeMirror did not claim the chords it acted on");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
