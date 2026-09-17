// When the desktop card's reply-history arrows are allowed to arrive.
//
// A card that already holds more than one final reply must draw its arrows in
// the very frame it first appears: opening it, coming back to it after a
// reload, stepping to it from another card, and switching to another project
// all count as first appearances. Only history that is genuinely new while the
// card is already on screen may use the fade.
//
// Every check here samples the control on each animation frame rather than
// waiting for it to settle, because the bug being pinned was entirely a
// question of timing: the arrows did end up visible either way.
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
const DESKTOP = { width: 1440, height: 900 };
const SHOTS = process.env.HISTORY_ARRIVAL_SHOTS || "";

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

async function boardBox(id) {
  const state = await (await fetch(origin + "/state")).json();
  return state.boxes.find(box => box.id === id);
}

// every card a test before left is put out of the doing view, so each test
// walks only the cards it made itself
async function clearLane(owner = "facilitator") {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === owner && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// the sampler: one reading of the shown card's history control per animation
// frame, from the page's first frame onwards. It is installed before any of
// the page's own script runs, so nothing the page draws happens unwatched
function installSampler() {
  window.__histSamples = [];
  const tick = () => {
    const box = document.querySelector("article.box.sel");
    const control = box ? box.querySelector(".histctl") : null;
    if (control) {
      const style = getComputedStyle(control);
      window.__histSamples.push({
        id: box.id.replace(/^box-/, ""),
        opacity: Number(style.opacity),
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function sampleCount(page) {
  return page.evaluate(() => window.__histSamples.length);
}

function samplesFor(page, id, from = 0) {
  return page.evaluate((cardId, start) =>
    window.__histSamples.slice(start).filter(sample => sample.id === cardId), id, from);
}

// the readings are kept from the page's first frame, so waiting for one to
// exist loses no frame: it only makes sure a frame has been drawn at all
// before the readings are read, on a machine where the card can appear
// between two frames
async function sampled(page, id, from = 0) {
  await page.waitForFunction((cardId, start) =>
    window.__histSamples.slice(start).some(sample => sample.id === cardId),
  { timeout: 5000 }, id, from);
  return samplesFor(page, id, from);
}

function describe(samples) {
  return samples.map(sample => `${sample.opacity}/${sample.visibility}`).join(" ");
}

function assertShownThroughout(samples, what) {
  assert.ok(samples.length >= 1, `${what}: the card was never sampled on screen`);
  const dim = samples.filter(sample => sample.opacity < 1 || sample.visibility !== "visible");
  assert.equal(dim.length, 0,
    `${what}: the arrows were not already there in every frame (${describe(samples)})`);
}

function assertHiddenThroughout(samples, what) {
  assert.ok(samples.length >= 1, `${what}: the card was never sampled on screen`);
  const lit = samples.filter(sample => sample.opacity > 0 || sample.visibility !== "hidden");
  assert.equal(lit.length, 0,
    `${what}: an empty history showed its arrows (${describe(samples)})`);
}

// what the control reads as in the same breath as the change that shows it: a
// fade that has just begun reads as its starting value here, a control that
// was already there reads as fully there
function readNow(page, id) {
  return page.evaluate(cardId => {
    const element = els[cardId];
    const style = getComputedStyle(element.histctl);
    return {
      hasHistory: element.box.classList.contains("hashist"),
      selected: element.box.classList.contains("sel"),
      opacity: Number(style.opacity),
      visibility: style.visibility,
      olderDisabled: element.histUp.disabled,
    };
  }, id);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function openDesktop(remember = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(DESKTOP);
  // a browser opened on the card it was last left on, which is the reading
  // this bug was reported from: the card is on screen before any history
  // request this page makes could possibly have answered
  await page.evaluateOnNewDocument(stored => {
    try {
      localStorage.clear();
      for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
    } catch (err) {}
  }, remember);
  await page.evaluateOnNewDocument(installSampler);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-history-arrival-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js",
                      "index.html", "page.html", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "history arrival test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Meta notes." },
      { id: "1.1", bucket: "now", title: "A second lane card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
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

// a card the board already holds several final replies for, the shape the
// report was written about: two answers with an owner message between them
async function cardWithHistory(title, replies, owner = "facilitator") {
  const id = await create(title, owner);
  for (let i = 0; i < replies; i++) {
    assert.equal((await api(`/send?box=${id}`, `Owner message ${i + 1} on ${title}.`)).status, 200);
    assert.equal((await api(`/reply?box=${id}`, `Reply ${i + 1} on ${title}.`)).status, 200);
  }
  return id;
}

test("the board counts final replies apart from progress notes", async () => {
  await clearLane();
  const id = await create("Counting final replies");
  assert.deepEqual(await boardBox(id).then(box => ({ replies: box.replies, older: box.olderReplies })),
    { replies: 0, older: 0 }, "a card with nothing said on it claimed an older reply");

  await api(`/send?box=${id}`, "The opening owner message.");
  await api(`/note?box=${id}`, "Still reading the notes.");
  await api(`/note?box=${id}`, "Halfway through.");
  await api(`/reply?box=${id}`, "The first final reply.");
  assert.deepEqual(await boardBox(id).then(box => ({ replies: box.replies, older: box.olderReplies })),
    { replies: 3, older: 0 },
    "progress notes were counted as pages of the reply history");

  await api(`/note?box=${id}`, "Picking the next piece up.");
  assert.deepEqual(await boardBox(id).then(box => box.olderReplies), 1,
    "a note over a final reply hid the reply underneath it");

  await api(`/send?box=${id}`, "A second owner message.");
  await api(`/reply?box=${id}`, "The second final reply.");
  assert.deepEqual(await boardBox(id).then(box => box.olderReplies), 1,
    "a card with two final replies did not offer exactly one older page");

  await api(`/reply?box=${id}`, "The third final reply.");
  assert.deepEqual(await boardBox(id).then(box => box.olderReplies), 2);
});

test("an existing card with two replies opens with its arrows already there", async () => {
  await clearLane();
  const id = await cardWithHistory("An older conversation", 2);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const first = await sampled(page, id);
    const atArrival = await readNow(page, id);
    await shot(page, "cold-reload-two-replies");   // the card as it first stands
    assertShownThroughout(first, "cold reload onto a card with two replies");
    assert.deepEqual(atArrival, {
      hasHistory: true, selected: true, opacity: 1, visibility: "visible", olderDisabled: false,
    });

    // and the history request that follows must not disturb what is already right
    await settle(400);
    assertShownThroughout(await sampled(page, id), "the frames after the history answered");
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id),
      ["Reply 1 on An older conversation."],
      "the stepper and the board disagreed about the card's older replies");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("stepping to another card and another project brings the arrows with them", async () => {
  await clearLane();
  await clearLane("pastureland");
  const plain = await create("One answer only");
  await api(`/send?box=${plain}`, "The only owner message.");
  await api(`/reply?box=${plain}`, "The only reply.");
  const deep = await cardWithHistory("Three answers deep", 3);
  const other = await cardWithHistory("Another lane entirely", 2, "pastureland");
  const { page, problems } = await openDesktop({ selbox: plain, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${plain}.sel`, { timeout: 5000 });
    await settle(400);   // the single-reply card settles with no marks at all
    assertHiddenThroughout(await sampled(page, plain), "a card with one reply");

    const beforeStep = await sampleCount(page);
    const atSwitch = await page.evaluate(cardId => {
      select(cardId);
      const element = els[cardId];
      const style = getComputedStyle(element.histctl);
      return { hasHistory: element.box.classList.contains("hashist"), opacity: Number(style.opacity),
               visibility: style.visibility };
    }, deep);
    await shot(page, "stepped-to-deep-card");   // the frame the step landed on
    assert.deepEqual(atSwitch, { hasHistory: true, opacity: 1, visibility: "visible" },
      "the arrows were not there in the same breath as the card being shown");
    await settle(400);
    assertShownThroughout(await sampled(page, deep, beforeStep), "stepping to a card with three replies");

    const beforeTab = await sampleCount(page);
    await page.evaluate((owner, cardId) => { setTab(owner); select(cardId); }, "pastureland", other);
    await page.waitForSelector(`#box-${other}.sel`, { timeout: 5000 });
    await settle(400);
    assertShownThroughout(await sampled(page, other, beforeTab), "switching to another project");
    await shot(page, "switched-project");

    const beforeBack = await sampleCount(page);
    await page.evaluate((owner, cardId) => { setTab(owner); select(cardId); }, "facilitator", deep);
    await page.waitForSelector(`#box-${deep}.sel`, { timeout: 5000 });
    await settle(300);
    assertShownThroughout(await sampled(page, deep, beforeBack), "coming back to the first project");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a slow history answer never delays the arrows of a card that has history", async () => {
  await clearLane();
  const id = await cardWithHistory("A slow history to read", 2);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.setRequestInterception(true);
    const held = [];
    const hold = request => {
      if (new URL(request.url()).pathname === "/history") {
        held.push(request);
        setTimeout(() => request.continue().catch(() => {}), 900);
        return;
      }
      request.continue().catch(() => {});
    };
    page.on("request", hold);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const early = await sampled(page, id);
    await shot(page, "slow-thread-still-marked");   // with the history answer still held
    assertShownThroughout(early, "a reload whose history request is held for most of a second");
    assert.ok(held.length >= 1, "the reload made no history request to hold");
    await settle(1200);
    assertShownThroughout(await sampled(page, id), "the frames either side of the slow answer");
    page.off("request", hold);
    await page.setRequestInterception(false);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// The two orderings are not the same card and never were. Progress notes
// written while the one answer was being worked out are behind that answer,
// so there is nowhere to step back to. A note written after it puts the answer
// one page back, and that page is a real destination.
test("progress notes written before the card's only answer leave no arrows", async () => {
  await clearLane();
  const id = await create("Working on it");
  await api(`/send?box=${id}`, "The owner's question.");
  await api(`/note?box=${id}`, "Reading the first half.");
  await api(`/note?box=${id}`, "Reading the second half.");
  await api(`/reply?box=${id}`, "The only final reply.");
  assert.equal((await boardBox(id)).olderReplies, 0);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await settle(500);
    assertHiddenThroughout(await sampled(page, id), "a card whose only reply sits over its notes");
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id), []);
    await shot(page, "notes-over-one-reply");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a progress note written after the only answer makes that answer an older page", async () => {
  await clearLane();
  const id = await create("Back on it");
  await api(`/send?box=${id}`, "The owner's question.");
  await api(`/reply?box=${id}`, "The answer, later stepped back to.");
  await api(`/send?box=${id}`, "A follow-up question.");
  await api(`/note?box=${id}`, "Started on the follow-up.");
  assert.equal((await boardBox(id)).olderReplies, 1);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    assertShownThroughout(await sampled(page, id), "a card showing a note over its one answer");
    await settle(500);
    assertShownThroughout(await sampled(page, id), "the frames after the history answered");
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id),
      ["The answer, later stepped back to."]);
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "Started on the follow-up.");
    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.id === cardId && hist.step === 1, { timeout: 5000 }, id);
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "The answer, later stepped back to.");
    assert.equal(await page.$eval(`#box-${id} .histpos`, node => node.textContent), "1 of 2");
    await shot(page, "note-over-answer-stepped-back");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// The two shapes where the page's own reading of the transcript used to
// disagree with the count sent with the card, which showed the arrows and then
// took them away again a moment later. Both are decided on the board now.
test("a long run of progress notes since the last answer keeps the arrows", async () => {
  await clearLane();
  const id = await create("A long run of notes");
  await api(`/send?box=${id}`, "The question this answers.");
  await api(`/reply?box=${id}`, "The answer under the long run.");
  await api(`/send?box=${id}`, "One more thing.");
  for (let i = 0; i < 201; i++) await api(`/note?box=${id}`, `Progress note number ${i + 1}.`);
  assert.equal((await boardBox(id)).olderReplies, 1);
  // the shape that made this hard: a window of the last 200 rows of this
  // card's conversation holds no answer at all
  const window200 = await (await fetch(origin + `/thread?box=${id}&n=200`)).json();
  assert.equal(window200.messages.filter(message => message.kind === "agent").length, 0,
    "the fixture did not push the answer out of the plain thread window");
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    assertShownThroughout(await sampled(page, id), "a card with a long run of notes, at first display");
    await settle(600);
    assertShownThroughout(await sampled(page, id),
      "a card with a long run of notes, once its history had answered");
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id),
      ["The answer under the long run."],
      "the answer behind the long run of notes was not reachable");
    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.id === cardId && hist.step === 1, { timeout: 5000 }, id);
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "The answer under the long run.");
    assert.equal(await page.$eval(`#box-${id} .histpos`, node => node.textContent), "1 of 2");
    await shot(page, "long-note-run-still-marked");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a progress note repeating the answer word for word keeps the arrows", async () => {
  await clearLane();
  const id = await create("The same words twice");
  const words = "The same words, in the answer and in the note.";
  await api(`/send?box=${id}`, "The question.");
  await api(`/reply?box=${id}`, words);
  await api(`/send?box=${id}`, "A follow-up.");
  await api(`/note?box=${id}`, words);
  assert.equal((await boardBox(id)).olderReplies, 1);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    assertShownThroughout(await sampled(page, id), "a note repeating its answer, at first display");
    await settle(600);
    assertShownThroughout(await sampled(page, id),
      "a note repeating its answer, once its history had answered");
    assert.deepEqual(await page.evaluate(cardId => histList(cardId), id), [words],
      "the answer was mistaken for the note that repeats it");
    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.id === cardId && hist.step === 1, { timeout: 5000 }, id);
    assert.equal(await page.$eval(`#box-${id} .histpos`, node => node.textContent), "1 of 2");
    await shot(page, "identical-note-still-marked");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("history that is genuinely new fades in on the card the owner is looking at", async () => {
  await clearLane();
  const id = await create("Watching it arrive");
  await api(`/send?box=${id}`, "The first owner message.");
  await api(`/reply?box=${id}`, "The first reply, alone for now.");
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await settle(400);
    assertHiddenThroughout(await sampled(page, id), "before the second reply landed");

    const beforeReply = await sampleCount(page);
    await api(`/send?box=${id}`, "A second owner message.");
    await api(`/reply?box=${id}`, "The second reply, which makes a history.");
    await page.evaluate(() => poll());
    await page.waitForFunction(cardId => els[cardId].box.classList.contains("hashist"),
      { timeout: 5000 }, id);
    await settle(500);
    const arriving = await sampled(page, id, beforeReply);
    assert.ok(arriving.some(sample => sample.opacity > 0 && sample.opacity < 1),
      `new history did not fade in on the open card (${describe(arriving)})`);
    assert.equal(arriving[arriving.length - 1].opacity, 1, "the fade did not finish");
    await shot(page, "new-history-faded-in");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the arrows still walk the card's older replies and come back to live", async () => {
  await clearLane();
  const id = await cardWithHistory("Walking back and forth", 3);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.waitForFunction(cardId => els[cardId].hasHistory === true, { timeout: 5000 }, id);
    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.id === cardId && hist.step === 1, { timeout: 5000 }, id);
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "Reply 2 on Walking back and forth.");
    assert.equal(await page.$eval(`#box-${id} .histpos`, node => node.textContent), "2 of 3");
    await page.click(`#box-${id} .histbtn.older`);
    await page.waitForFunction(cardId => hist?.step === 2, { timeout: 5000 }, id);
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "Reply 1 on Walking back and forth.");
    assert.deepEqual(await page.evaluate(cardId => ({
      position: els[cardId].histPos.textContent,
      olderDisabled: els[cardId].histUp.disabled,
      newerDisabled: els[cardId].histDown.disabled,
    }), id), { position: "1 of 3", olderDisabled: true, newerDisabled: false });
    await shot(page, "stepped-to-oldest");
    await page.click(`#box-${id} .histbtn.newer`);
    await page.click(`#box-${id} .histbtn.newer`);
    await page.waitForFunction(() => hist === null, { timeout: 5000 });
    assert.equal(await page.$eval("article.box.sel .reply", node => node.textContent),
      "Reply 3 on Walking back and forth.");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a history request that fails leaves the arrows the board vouches for standing", async () => {
  await clearLane();
  const id = await cardWithHistory("A history that fails once", 2);
  const { page, problems } = await openDesktop({ selbox: id, activeproj: "facilitator" });
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    let requests = 0;
    const fail = request => {
      const url = new URL(request.url());
      if (url.pathname === "/history" && url.searchParams.get("box") === id) {
        requests += 1;
        if (requests === 1) {
          request.respond({ status: 503, contentType: "application/json",
                            body: JSON.stringify({ error: "temporary overload" }) }).catch(() => {});
          return;
        }
      }
      request.continue().catch(() => {});
    };
    page.on("request", fail);
    await page.setRequestInterception(true);
    const beforeReload = await sampleCount(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const firstDeadline = Date.now() + 3000;
    while (requests < 1 && Date.now() < firstDeadline) await settle(25);
    assert.equal(requests, 1, "the shown card did not ask for its history");
    await settle(200);
    assert.deepEqual(await page.evaluate(cardId => ({
      hasHistory: els[cardId].box.classList.contains("hashist"),
      cached: Object.prototype.hasOwnProperty.call(histCache, cardId),
    }), id), { hasHistory: true, cached: false },
    "a failed history request either erased the board's own answer or was kept as one");

    const retryDeadline = Date.now() + 4000;
    while (requests < 2 && Date.now() < retryDeadline) await settle(25);
    assert.equal(requests, 2, "ordinary polling did not retry the failed history request");
    await page.waitForFunction(cardId => els[cardId].hasHistory === true, { timeout: 3000 }, id);
    await settle(200);
    assertShownThroughout(await sampled(page, id, beforeReload),
      "a card whose first history request failed");
    page.off("request", fail);
    await page.setRequestInterception(false);
    assert.equal(problems.length, 1, "the injected failure produced unexpected console output");
    assert.match(problems[0], /503 \(Service Unavailable\)/);
  } finally {
    await page.close();
  }
});
