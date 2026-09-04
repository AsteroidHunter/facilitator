// The phone page's keyboard shortcuts: the board's own keys, for a keyboard
// paired with the phone, driven headless at an iPhone size against its own
// fixture server. What only the phone itself can show is which command
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
const KEYBOARD = 336;   // an iPhone keyboard with its accessory bar, in css px
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
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  // each page starts where a phone that has never been opened starts: the
  // remembered tab and card of the test before are no part of this one
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (err) {} });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
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

// the cards the list is showing, in the order it shows them, which is the order
// the walking keys have to keep
function listOrder(page) {
  return page.evaluate(() => [...document.querySelectorAll("#tiklist .trow")].map(row => row.dataset.id));
}

function activeElement(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest ? el.closest("article.box") : null;
    return { tag: el ? el.tagName : null, box: box ? box.id.replace(/^box-/, "") : null };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-shortcuts-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
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
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
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
    assert.equal((await activeElement(page)).tag, "TEXTAREA");
    await chord(page, "ArrowRight", "Control", "Shift");
    const landed = await shownId(page);
    assert.deepEqual(await activeElement(page), { tag: "TEXTAREA", box: landed },
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
    assert.deepEqual(await activeElement(page), { tag: "TEXTAREA", box: await shownId(page) },
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
    assert.equal((await activeElement(page)).tag, "TEXTAREA", "the step took the caret out of the row");
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
    assert.deepEqual(await activeElement(page), { tag: "TEXTAREA", box: madeId },
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

test("command z bounces back to the card the send's own move left, and back again", async () => {
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
    assert.equal((await sent).status(), 200);
    await page.waitForFunction(id => document.querySelector("article.box.sel")?.id === "box-" + id, { timeout: 3000 }, waiting);

    await chord(page, "z", "Meta");
    await settle(150);
    assert.equal(await shownId(page), from, "command z did not bounce back to the card the move left");
    await chord(page, "z", "Meta");
    await settle(150);
    assert.equal(await shownId(page), waiting, "the second bounce did not go back again");
    // control z is the same bounce, for a keyboard laid out without a command key
    await chord(page, "z", "Control");
    await settle(150);
    assert.equal(await shownId(page), from);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("enter sends and shift enter makes a line, and the return key still makes a line under the on-screen keyboard", async () => {
  await clearLane();
  const id = await create("The composer on a keyboard");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  const sends = [];
  page.on("response", response => { if (new URL(response.url()).pathname === "/send") sends.push(response.status()); });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.focus(SEL);
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
    await settle(400);
    assert.deepEqual((await savedBox(id)).pendingTexts, ["first line\nsecond line"], "the return key did not send both lines");
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "",
      "the send did not empty the row");

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

test("a plain arrow belongs to the caret, and walks no card", async () => {
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

    // and with the row let go of, a bare arrow still walks nothing: the cards
    // are walked by the pairs above and by the list, never by an arrow alone
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press("ArrowRight");
    await settle(120);
    assert.equal(await shownId(page), first, "a bare arrow walked the cards");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
