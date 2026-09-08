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
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "index.html", "page.html", "cm-markdown.js"]) {
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
      field.value = "the send button still moves";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await shownId(page), from, "the send button moved before delivery");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);
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
    assert.deepEqual(await activeElement(page), {
      tag: "TEXTAREA", box: order[(start + 1) % order.length],
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

test("desktop history works from the composer and keeps its caret", async () => {
  await clearLane();
  const id = await create("Desktop reply history");
  await api(`/reply?box=${id}`, "First desktop reply.");
  await api(`/reply?box=${id}`, "Second desktop reply.");
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, id);
    await page.focus(SEL);
    await chord(page, "ArrowUp", "Control", "Shift");
    await settle(300);
    assert.equal(await page.$eval("article.box.sel .reply", el => el.textContent), "First desktop reply.",
      "the first history step did not show the older reply");
    assert.deepEqual(await page.evaluate(() => hist && ({ id: hist.id, step: hist.step })), { id, step: 1 });
    assert.equal((await activeElement(page)).tag, "TEXTAREA");
    await chord(page, "ArrowUp", "Control", "Shift");
    assert.equal(await page.evaluate(() => hist.step), 1,
      "history stepped beyond its oldest reply");
    await chord(page, "ArrowDown", "Control", "Shift");
    await page.waitForFunction(() => !document.querySelector("article.box.sel").classList.contains("histview"));
    assert.equal((await activeElement(page)).tag, "TEXTAREA");
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

test("desktop send-return preserves drafts and missing targets leave undo native", async () => {
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

    await page.keyboard.type("unsent draft stays here");
    await chord(page, "z", "Meta");
    assert.equal(await shownId(page), from,
      "a valid return target did not outrank native undo while typing");
    assert.equal(await page.$eval(`#box-${waiting} textarea`, field => field.value), "unsent draft stays here");
    await chord(page, "z", "Control");
    assert.equal(await shownId(page), waiting);
    assert.equal(await page.$eval(SEL, field => field.value), "unsent draft stays here");

    await page.evaluate(() => { lastLeftId = null; });
    await page.evaluate(() => {
      window.shortcutObserved = null;
      addEventListener("keydown", event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
          window.shortcutObserved = { prevented: event.defaultPrevented };
        }
      });
    });
    await page.keyboard.type(" plus native undo");
    await chord(page, "z", "Control");
    assert.equal(await shownId(page), waiting, "an unavailable return target moved the selection");
    assert.deepEqual(await page.evaluate(() => window.shortcutObserved), { prevented: false },
      "native undo was claimed without a return target");
    await page.keyboard.type(" shifted");
    await chord(page, "z", "Meta", "Shift");
    assert.equal(await shownId(page), waiting, "shift-command-z triggered the board bounce");
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
    assert.equal(await page.evaluate(() => document.activeElement === miniEls[miniId].ta), true,
      "mini stepping from typing did not carry its caret");

    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/create");
    await chord(page, "t", "Meta");
    assert.equal((await created).status(), 200);
    await settle(250);
    assert.equal(creates.length, 1, "mini command-T created more than one card");
    assert.equal(await shownId(page), mainBefore, "mini creation moved the main selection");

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
  const returnTo = await create("Barrier return target");
  await api(`/reply?box=${returnTo}`, "Return target reply.");
  const current = await create("Barrier current card");
  await api(`/reply?box=${current}`, "Current reply.");
  const { page, problems } = await openDesktop();
  const creates = createRequests(page);
  try {
    await selectDesktop(page, current);
    await page.evaluate(({ from, at }) => { lastLeftId = from; select(at); editTitle(at); }, {
      from: returnTo, at: current,
    });
    await chord(page, "z", "Meta");
    assert.equal(await shownId(page), current, "the shared title let board bounce escape its barrier");

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
    assert.equal(await page.evaluate(id => document.activeElement === els[id].ta, current), true,
      "picture Escape leaked to the board blur action");
    assert.equal(await page.$eval(`#box-${current} textarea`, field => field.value), "picture draft");
    await page.waitForFunction(() => p3Zoom === null, { timeout: 1500 });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("CodeMirror undo and a valid board return target both run", async () => {
  const from = await create("CodeMirror return target", "pastureland");
  await api(`/reply?box=${from}`, "Return target reply.");
  const current = await create("CodeMirror current card", "pastureland");
  await api(`/reply?box=${current}`, "Current editor reply.");
  const { page, problems } = await openDesktop("/?project=pastureland");
  try {
    await selectDesktop(page, current);
    await page.evaluate(async ({ fromId, currentId }) => {
      lastLeftId = fromId;
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
    }, { fromId: from, currentId: current });
    await page.click("#magic4 .cm-content");
    await page.keyboard.type("X");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor textX");
    await chord(page, "z", "Meta");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), "editor text",
      "CodeMirror did not perform its own undo");
    assert.equal(await shownId(page), from,
      "the same default-prevented event did not reach the board return action");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
