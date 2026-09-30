// The phone page across a bad radio, driven headless at an iPhone size against
// its own fixture server, with the network between them held, cut or made to
// lose answers by request interception. What is pinned: a press on the plus
// shows at once and makes one card however many times it is pressed while the
// card is on its way; a send shows at once as on its way and one message lands
// when the reply is lost, when the board is unreachable, and across a reload;
// a wake reconciles from the board's receipts without a send getting through;
// readings never overlap, name the revision, cost little when nothing changed
// and say plainly when the board is not answering; and the desktop board on the
// same server still draws and sends. What only a phone can show, the tunnel,
// the lock screen and a paired keyboard, is not here. Screenshots land under
// /tmp/m552-bridge-shots.
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
const SHOTS = "/tmp/m552-bridge-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1 };

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

async function boardState() {
  return (await fetch(origin + "/state")).json();
}

async function pendingOn(id) {
  return (await boardState()).boxes.find(box => box.id === id).pendingTexts;
}

function settle(ms = 250) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// a page at phone size with the network under the test's hand: page.rule is
// asked about every request and answers continue, hold (deliver after a
// wait), abort (the request never leaves) or lose (deliver to the board and
// lose the answer on the way back). Every request and every answer is written
// down for the assertions. The service worker is bypassed so the page's own
// requests are the ones intercepted
async function openPhone(route, viewport = PHONE, seedOps = null, initialRule = null) {
  const page = await browser.newPage();
  const problems = [];
  // a store of operations left from before, written before the page's own
  // scripts run, the way a reload finds them
  // the script also runs on the blank document a fresh tab starts on, where
  // storage is off limits; only the board's own document keeps the store
  if (seedOps) await page.evaluateOnNewDocument(kept => {
    try { localStorage.setItem("pendops", JSON.stringify(kept)); } catch (e) {}
  }, seedOps);
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    if (/net::ERR_/.test(message.text())) return;   // requests this test cuts on purpose
    if (/Failed to load resource/.test(message.text())) return;   // a request this test refused (a 503, an abort); the page's own catch handles it, and a real page fault comes through pageerror
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  page.seen = [];
  page.answers = [];
  // a rule in force from the first request, for a page that must open onto a
  // network the test has already cut
  page.rule = initialRule || (() => ({ act: "continue" }));
  await page.setBypassServiceWorker(true);
  await page.setRequestInterception(true);
  page.on("request", async request => {
    const url = new URL(request.url());
    const entry = { path: url.pathname, search: url.search, method: request.method(), at: Date.now() };
    page.seen.push(entry);
    const rule = page.rule(entry) || { act: "continue" };
    try {
      if (rule.act === "hold") await settle(rule.ms);
      if (rule.act === "abort") return await request.abort("connectionreset");
      if (rule.act === "status") {
        // the shape of uvicorn's own global-cap answer: a bare text/plain 503,
        // not the board's JSON, with no Retry-After
        return await request.respond({ status: rule.status, contentType: "text/plain", body: "Service Unavailable" });
      }
      if (rule.act === "lose") {
        await fetch(request.url(), { method: request.method(), body: request.postData() });
        return await request.abort("connectionreset");
      }
      await request.continue();
    } catch (error) {
      // the page went away under the request
    }
  });
  page.on("response", async response => {
    const url = new URL(response.url());
    const entry = { path: url.pathname, search: url.search, status: response.status(), at: Date.now() };
    if (/json/.test(response.headers()["content-type"] || "")) {
      try { entry.body = await response.json(); } catch (error) {}
    }
    page.answers.push(entry);
  });
  await page.setViewport(viewport);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

function rows(page) {
  return page.evaluate(() => ({
    field: document.querySelector("article.box.sel textarea").value,
    delivered: [...document.querySelectorAll("article.box.sel .sentwrap .answmsg:not([data-op])")].map(r => ({
      text: r.dataset.text, rcpt: r.querySelector(".answnote")?.textContent || "" })),
    local: [...document.querySelectorAll("article.box.sel .sentwrap .answmsg[data-op]")].map(r => ({
      text: r.dataset.text, op: r.dataset.op, rcpt: r.querySelector(".answnote")?.textContent || "",
      pending: r.classList.contains("pending"), failed: r.classList.contains("failed") })),
    stored: JSON.parse(localStorage.getItem("pendops") || "[]"),
  }));
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-bridge-"));
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
    title: "phone bridge test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
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

test("the plus shows the card being made, and every press while it is on its way is the same press", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const before = (await boardState()).boxes.length;
    page.rule = r => r.path === "/create" ? { act: "hold", ms: 700 } : null;
    await page.evaluate(() => openDrawer());
    // three presses at once: two taps on the plus and the keyboard's own new-card key
    await page.evaluate(() => { const plus = document.getElementById("tikadd"); plus.click(); plus.click(); });
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    const pending = await page.evaluate(() => ({
      pending: document.getElementById("tikadd").classList.contains("pending"),
      busy: document.getElementById("tikadd").getAttribute("aria-busy"),
      stored: JSON.parse(localStorage.getItem("pendops") || "[]").length,
    }));
    assert.equal(pending.pending, true, "the plus does not show the card being made");
    assert.equal(pending.busy, "true");
    assert.equal(pending.stored, 1, "a second press minted a second card");
    await page.screenshot({ path: path.join(SHOTS, "create-pending.png") });

    await page.waitForFunction(() => document.querySelector("article.box.sel .title")?.isContentEditable, { timeout: 5000 });
    const creates = page.seen.filter(r => r.path === "/create");
    assert.equal(creates.length, 1, `three presses made ${creates.length} requests`);
    const firstOp = new URLSearchParams(creates[0].search).get("op");
    assert.ok(firstOp && firstOp.length >= 8, "the create carried no operation id");
    assert.equal((await boardState()).boxes.length, before + 1, "three presses made more than one card");
    const landed = await page.evaluate(() => ({
      pending: document.getElementById("tikadd").classList.contains("pending"),
      stored: JSON.parse(localStorage.getItem("pendops") || "[]").length,
      drawerOpen: document.getElementById("drawer").classList.contains("open"),
      title: document.querySelector("article.box.sel .title").textContent,
    }));
    assert.equal(landed.pending, false, "the plus still breathes after the card landed");
    assert.equal(landed.stored, 0, "the landed card is still in the phone's store");
    assert.equal(landed.drawerOpen, false);
    assert.equal(landed.title, "");
    await page.keyboard.type("Named once");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => lastState.boxes.some(b => b.title === "Named once"), { timeout: 5000 });

    // the card is there: the next press is a deliberate second card
    page.rule = () => null;
    await page.evaluate(() => openDrawer());
    await page.evaluate(() => document.getElementById("tikadd").click());
    await page.waitForFunction(count => lastState.boxes.length >= count, { timeout: 5000 }, before + 2);
    const again = page.seen.filter(r => r.path === "/create");
    assert.equal(again.length, 2);
    assert.notEqual(new URLSearchParams(again[1].search).get("op"), firstOp, "the second card reused the first card's id");
    assert.equal((await boardState()).boxes.length, before + 2);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a send shows faded at once, with no word, and lands once however many times Enter is pressed", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    page.rule = r => r.path === "/send" ? { act: "hold", ms: 600 } : null;
    await page.type("article.box.sel textarea", "Sent from the phone");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const now = await rows(page);
    assert.equal(now.field, "", "the words stayed in the row after Enter");
    assert.equal(now.local.length, 1, `Enter three times drew ${now.local.length} rows`);
    assert.equal(now.local[0].text, "Sent from the phone");
    assert.equal(now.local[0].rcpt, "", "a send on its way carries a word");
    assert.equal(now.local[0].pending, true);
    assert.equal(now.stored.length, 1);
    const onWay = await page.evaluate(() => {
      const panel = document.querySelector("article.box.sel .sentwrap .answered");
      return { faded: panel.classList.contains("undelivered"), tag: panel.dataset.tag || "" };
    });
    assert.deepEqual(onWay, { faded: true, tag: "" }, "a send the board has not saved is not faded, or carries a mark");
    await page.screenshot({ path: path.join(SHOTS, "send-pending.png") });

    await page.waitForFunction(() =>
      document.querySelectorAll("article.box.sel .sentwrap .answmsg:not([data-op])").length === 1 &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]"), { timeout: 5000 });
    const landed = await rows(page);
    // confirmed, the message keeps its words and loses its line; the board has
    // it, so the panel is at full ink and says Delivered
    assert.deepEqual(landed.delivered, [{ text: "Sent from the phone", rcpt: "" }]);
    assert.equal(landed.stored.length, 0);
    const saved = await page.evaluate(() => {
      const panel = document.querySelector("article.box.sel .sentwrap .answered");
      return { faded: panel.classList.contains("undelivered"), tag: panel.dataset.tag || "" };
    });
    assert.deepEqual(saved, { faded: false, tag: "Delivered" }, "a send the board saved is not at full ink with Delivered");
    const sends = page.seen.filter(r => r.path === "/send");
    assert.equal(sends.length, 1, `Enter three times sent ${sends.length} requests`);
    assert.ok(new URLSearchParams(sends[0].search).get("op"), "the send carried no operation id");
    assert.deepEqual(await pendingOn("0"), ["Sent from the phone"]);
    await page.screenshot({ path: path.join(SHOTS, "send-delivered.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("a reply lost on the way is retried under the same id, and the message lands once", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    // the readings are cut too, so the retry is the only way the message can
    // be confirmed here; a wake reconciling it from the receipt is its own test
    let lost = 0;
    page.rule = r => {
      if (r.path === "/m/state") return { act: "abort" };
      return (r.path === "/send" && lost++ === 0) ? { act: "lose" } : null;
    };
    await page.type("article.box.sel textarea", "Reply lost on the way");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Not sent yet, retrying", { timeout: 5000 });
    const retrying = await rows(page);
    assert.equal(retrying.local[0].text, "Reply lost on the way");
    assert.equal(retrying.field, "", "the words went back to the row while the send was still being retried");
    await page.screenshot({ path: path.join(SHOTS, "send-retrying.png") });

    await page.waitForFunction(() =>
      !!document.querySelector("article.box.sel .sentwrap .answmsg:not([data-op])") &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]"), { timeout: 10000 });
    page.rule = () => null;
    const sends = page.seen.filter(r => r.path === "/send");
    assert.equal(sends.length, 2, `the lost reply led to ${sends.length} sends`);
    const ops = sends.map(r => new URLSearchParams(r.search).get("op"));
    assert.equal(ops[0], ops[1], "the retry minted a new id");
    const replayed = page.answers.filter(a => a.path === "/send" && a.status === 200);
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].body.replayed, true, "the retry was not answered from the receipt");
    assert.deepEqual(await pendingOn("0"), ["Reply lost on the way"], "the message landed twice, or not at all");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("with the board unreachable the words stay on the card, survive a reload, and land when it is back", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    page.rule = r => r.path === "/send" ? { act: "abort" } : null;
    await page.type("article.box.sel textarea", "Kept through a reload");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Not sent yet, retrying", { timeout: 5000 });
    const before = await rows(page);
    assert.equal(before.stored.length, 1);
    assert.equal(before.stored[0].text, "Kept through a reload");
    const op = before.local[0].op;

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
    await page.waitForSelector("#box-0.sel .sentwrap .answmsg[data-op]", { timeout: 5000 });
    const restored = await rows(page);
    assert.equal(restored.local.length, 1, "the unsent message did not come back after the reload");
    assert.equal(restored.local[0].text, "Kept through a reload");
    assert.equal(restored.local[0].op, op, "the reload minted a new id for the same message");
    assert.equal(restored.delivered.length, 0);
    assert.deepEqual(await pendingOn("0"), [], "a send got through while the board was unreachable");

    page.rule = () => null;
    await page.evaluate(() => resume());
    await page.waitForFunction(() =>
      !!document.querySelector("article.box.sel .sentwrap .answmsg:not([data-op])") &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]"), { timeout: 10000 });
    assert.deepEqual(await pendingOn("0"), ["Kept through a reload"]);
    assert.equal((await rows(page)).stored.length, 0);
    const sent = page.seen.filter(r => r.path === "/send" && r.at > (page.seen.find(r => r.path === "/m/state") || {}).at);
    assert.ok(sent.every(r => new URLSearchParams(r.search).get("op") === op), "a retry after the reload used another id");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("waking reconciles a send that landed while the phone was away, without a send getting through", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    let first = true;
    page.rule = r => {
      if (r.path !== "/send") return null;
      if (first) { first = false; return { act: "lose" }; }
      return { act: "abort" };
    };
    await page.type("article.box.sel textarea", "Landed while away");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Not sent yet, retrying", { timeout: 5000 });
    assert.deepEqual(await pendingOn("0"), ["Landed while away"], "the lost-reply send did not reach the board");

    await page.evaluate(() => resume());
    await page.waitForFunction(() =>
      !!document.querySelector("article.box.sel .sentwrap .answmsg:not([data-op])") &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]"), { timeout: 8000 });
    assert.equal(page.answers.filter(a => a.path === "/send" && a.status === 200).length, 0,
      "a send got through: the reconciliation was not what confirmed the message");
    const asked = page.seen.filter(r => r.path === "/m/state" && /ops=/.test(r.search));
    assert.ok(asked.length >= 1, "the wake's reading did not ask after the pending operation");
    assert.deepEqual(await pendingOn("0"), ["Landed while away"]);
    assert.equal((await rows(page)).stored.length, 0);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("readings never overlap, name the revision, cost little unchanged, and say when the board is not answering", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    // every reading held longer than the gap between readings: without a
    // guard they would pile up
    page.rule = r => r.path === "/m/state" ? { act: "hold", ms: 1500 } : null;
    const started = Date.now();
    let inFlight = 0, most = 0;
    const onRequest = request => { if (new URL(request.url()).pathname === "/m/state") { inFlight++; most = Math.max(most, inFlight); } };
    const onDone = response => { if (new URL(response.url()).pathname === "/m/state") inFlight--; };
    page.on("request", onRequest);
    page.on("response", onDone);
    page.on("requestfailed", request => { if (new URL(request.url()).pathname === "/m/state") inFlight--; });
    await settle(4500);
    page.off("request", onRequest);
    assert.equal(most, 1, `${most} readings were in flight at once`);
    const readings = page.seen.filter(r => r.path === "/m/state" && r.at > started);
    assert.ok(readings.length >= 2, "no readings happened at all");
    assert.ok(readings.every(r => /since=\d+/.test(r.search)), "a reading after the first did not name the revision it held");
    const unchanged = page.answers.filter(a => a.path === "/m/state" && a.body && a.body.changed === false);
    assert.ok(unchanged.length >= 1, "no reading came back unchanged");
    assert.ok(unchanged.every(a => a.body.boxes === undefined), "an unchanged reading carried the cards");
    assert.equal(await page.evaluate(() => document.body.classList.contains("offline")), false);

    // the board stops answering: the note says so, and since when
    page.rule = r => r.path === "/m/state" ? { act: "abort" } : null;
    await page.waitForFunction(() => document.body.classList.contains("offline"), { timeout: 12000 });
    const note = await page.evaluate(() => ({
      text: document.getElementById("offline").textContent,
      stale: document.getElementById("offline").classList.contains("stale"),
    }));
    assert.match(note.text, /^Reconnecting to the board\. Last update \d{1,2}:\d{2} (AM|PM)\.$/, note.text);
    assert.equal(note.stale, true);
    await page.screenshot({ path: path.join(SHOTS, "reconnecting.png") });
    // and after long enough, that the board is gone and what happens to a send meanwhile
    const gone = await page.evaluate(() => { lastGood = Date.now() - 40000; linkStatus(); return document.getElementById("offline").textContent; });
    assert.match(gone, /^The facilitator server is not answering\. Messages you send are kept on this phone and delivered when it is back\./);
    assert.equal(await page.evaluate(() => document.getElementById("offline").classList.contains("stale")), false);
    await page.screenshot({ path: path.join(SHOTS, "not-answering.png") });

    // the board answers again: one wake, and the note goes
    page.rule = () => null;
    await page.evaluate(() => resume());
    await page.waitForFunction(() => !document.body.classList.contains("offline"), { timeout: 8000 });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a bare text-plain 503 from the global cap is handled: the phone reconnects and the send stays pending, never lost or doubled", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    // both the reading and the command answer as uvicorn's own overload 503,
    // which is text/plain and carries no Retry-After
    page.rule = r => (r.path === "/m/state" || r.path === "/send") ? { act: "status", status: 503 } : null;
    await page.type("article.box.sel textarea", "Sent into an overloaded board");
    await page.keyboard.press("Enter");
    // the send is on this phone, marked as on its way, and the board has nothing
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Not sent yet, retrying", { timeout: 6000 });
    assert.deepEqual(await pendingOn("0"), [], "a send got through the 503");
    // the reading of the board is refused too, so the reconnecting note shows;
    // the phone never tried to read the text/plain body as JSON
    await page.waitForFunction(() => document.body.classList.contains("offline"), { timeout: 12000 });
    const note = await page.evaluate(() => document.getElementById("offline").textContent);
    assert.ok(/Reconnecting to the board|not answering/.test(note), note);
    const rowText = await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op]").dataset.text);
    assert.equal(rowText, "Sent into an overloaded board", "the words were lost under the 503");

    // the load clears: one wake, the message lands exactly once, the note goes
    page.rule = () => null;
    await page.evaluate(() => resume());
    await page.waitForFunction(() =>
      !!document.querySelector("article.box.sel .sentwrap .answmsg:not([data-op])") &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]") &&
      !document.body.classList.contains("offline"), { timeout: 10000 });
    assert.deepEqual(await pendingOn("0"), ["Sent into an overloaded board"]);
    assert.equal((await rows(page)).stored.length, 0);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

// fifty operations already kept on this phone, in the state the test names
function fiftyKept(state) {
  return Array.from({ length: 50 }, (_, n) => ({
    id: `kept-${state}-${String(n).padStart(2, "0")}`, kind: "send", box: "0", text: `kept ${n}`,
    ts: Date.now() - 60000, tries: 1, waiting: state === "pending", asked: 0, state,
  }));
}

for (const kept of ["pending", "failed"]) {
  test(`with fifty ${kept} sends kept, one more is held with its words in place and the page does not hang`, async () => {
    // the sends are cut from the first request, so the kept ones may keep
    // retrying but none may land and thin the store before the test looks
    const { page, problems } = await openPhone("/m?box=0", PHONE, fiftyKept(kept), r => r.path === "/send" ? { act: "abort" } : null);
    try {
      await page.waitForSelector("#box-0.sel", { timeout: 5000 });
      await page.waitForFunction(() => document.querySelectorAll("article.box.sel .sentwrap .answmsg[data-op]").length === 50, { timeout: 5000 });
      await page.type("article.box.sel textarea", "the fifty-first");
      await page.keyboard.press("Enter");
      // the page is still answering, the words are still in the row, nothing was minted
      const now = await page.evaluate(() => ({
        field: document.querySelector("article.box.sel textarea").value,
        note: document.querySelector("article.box.sel .meta").textContent,
        kept: ops.length,
        ids: ops.map(o => o.id),
        states: [...new Set(ops.map(o => o.state))],
        stored: JSON.parse(localStorage.getItem("pendops") || "[]").length,
      }));
      assert.equal(now.field, "the fifty-first", "the held send lost its words");
      assert.match(now.note, /^send held: fifty messages are still unconfirmed/, now.note);
      assert.equal(now.kept, 50, "a kept operation was dropped to make room");
      assert.deepEqual(now.ids, fiftyKept(kept).map(o => o.id), "the kept operations lost their identities");
      assert.deepEqual(now.states, [kept], "a kept operation changed state to make room");
      assert.equal(now.stored, 50);
      assert.equal(page.seen.filter(r => r.path === "/send" && /the%20fifty/.test(r.search)).length, 0);
      await page.screenshot({ path: path.join(SHOTS, `held-${kept}.png`) });
      // taking one back makes room, and the held words then go on their own next Enter
      if (kept === "failed") {
        await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op].failed").click());
        assert.equal(await page.evaluate(() => ops.length), 49);
        assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .meta").textContent), "", "the held note did not clear once there was room");
        await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.value = "the fifty-first"; ta.dispatchEvent(new Event("input")); });
        await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => ops.length), 50);
        assert.equal(await page.evaluate(() => ops.at(-1).text), "the fifty-first");
      }
      assert.deepEqual(problems, []);
    } finally {
      await page.evaluate(() => localStorage.removeItem("pendops")).catch(() => {});
      await page.close();
      await api("/dismiss?box=0");
    }
  });
}

test("a send whose reply was lost, then a sleep past the horizon: nothing more is sent, the reading asks, and the board's receipt lands it", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    let first = true;
    page.rule = r => {
      if (r.path === "/m/state") return { act: "abort" };   // no reading yet: the phone is on its own
      if (r.path !== "/send") return null;
      if (first) { first = false; return { act: "lose" }; }   // the board applies it, the reply is lost
      return { act: "abort" };
    };
    await page.type("article.box.sel textarea", "Landed, then the phone slept");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Not sent yet, retrying", { timeout: 6000 });
    assert.deepEqual(await pendingOn("0"), ["Landed, then the phone slept"], "the first try did not reach the board");
    // half a day passes on the phone's clock
    const opId = await page.evaluate(() => {
      const op = ops.find(o => o.state === "pending");
      op.ts = Date.now() - OP_GIVE_UP_MS - 1000;
      saveOps();
      wakeOps();
      return op.id;
    });
    await page.waitForFunction(() =>
      document.querySelector("article.box.sel .sentwrap .answmsg[data-op] .answnote")?.textContent === "Could not confirm it was sent", { timeout: 6000 });
    const sendsAtHorizon = page.seen.filter(r => r.path === "/send").length;
    const unsure = await rows(page);
    assert.equal(unsure.local[0].text, "Landed, then the phone slept", "the words left the card");
    assert.equal(unsure.stored[0].state, "unsure");
    assert.equal(unsure.field, "", "the words were handed back on their own");
    await page.screenshot({ path: path.join(SHOTS, "send-unsure.png") });
    await settle(3500);
    assert.equal(page.seen.filter(r => r.path === "/send").length, sendsAtHorizon, "a send went out for an unsure operation");

    // the phone wakes where the board answers readings: it asks after the
    // unsure id, and the receipt lands the message without a send
    page.rule = r => r.path === "/send" ? { act: "abort" } : null;
    await page.evaluate(() => resume());
    await page.waitForFunction(() =>
      !!document.querySelector("article.box.sel .sentwrap .answmsg:not([data-op])") &&
      !document.querySelector("article.box.sel .sentwrap .answmsg[data-op]"), { timeout: 8000 });
    const asked = page.seen.filter(r => r.path === "/m/state" && r.search.includes(opId));
    assert.ok(asked.length >= 1, "no reading asked the board about the unsure operation");
    assert.equal(page.seen.filter(r => r.path === "/send").length, sendsAtHorizon, "the reconciliation sent again");
    assert.deepEqual(await pendingOn("0"), ["Landed, then the phone slept"]);
    assert.equal((await rows(page)).stored.length, 0);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("an unsure send the board has no receipt of is settled as not sent inside the window, and stays unsure past it, taken back only by two taps", async () => {
  const { page, problems } = await openPhone("/m?box=0");
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    page.rule = r => (r.path === "/send" || r.path === "/m/state") ? { act: "abort" } : null;
    // two sends that never reach the board
    for (const words of ["Never reached the board", "Older than the window"]) {
      await page.type("article.box.sel textarea", words);
      await page.keyboard.press("Enter");
    }
    await page.waitForFunction(() => document.querySelectorAll("article.box.sel .sentwrap .answmsg[data-op]").length === 2, { timeout: 5000 });
    // the first is half a day old, the second older than the window where
    // "unknown" still proves anything
    await page.evaluate(() => {
      const [young, old] = ops;
      young.ts = Date.now() - OP_GIVE_UP_MS - 1000;
      old.ts = Date.now() - OP_CERTAIN_MS - 1000;
      saveOps();
      wakeOps();
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("article.box.sel .sentwrap .answmsg[data-op] .answnote")].every(r => r.textContent === "Could not confirm it was sent"), { timeout: 6000 });
    assert.deepEqual(await pendingOn("0"), []);

    // the board answers readings again, with no receipt for either
    page.rule = r => r.path === "/send" ? { act: "abort" } : null;
    await page.evaluate(() => resume());
    await page.waitForFunction(() =>
      document.querySelectorAll("article.box.sel .sentwrap .answmsg[data-op].failed").length === 1, { timeout: 8000 });
    const settled = await rows(page);
    assert.deepEqual(settled.local.map(r => [r.text, r.rcpt]), [
      ["Never reached the board", "Not sent, tap to take the words back"],
      ["Older than the window", "Could not confirm it was sent"],
    ]);
    await page.screenshot({ path: path.join(SHOTS, "send-settled.png") });
    const sendsSoFar = page.seen.filter(r => r.path === "/send").length;

    // the not-sent one gives its words back on one tap; the unsure one needs
    // two, says so in between, and stands down if the second never comes
    await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op].failed").click());
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "Never reached the board");
    await page.evaluate(() => { const ta = document.querySelector("article.box.sel textarea"); ta.value = ""; ta.dispatchEvent(new Event("input")); });
    await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op].unsure").click());
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op].unsure .answnote").textContent),
      "Tap again to take the words back; it may already have gone");
    await settle(5500);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sentwrap .answmsg[data-op].unsure .answnote").textContent),
      "Could not confirm it was sent", "the armed row did not stand down");
    await page.evaluate(() => { const row = document.querySelector("article.box.sel .sentwrap .answmsg[data-op].unsure"); row.click(); row.click(); });
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "Older than the window");
    assert.equal(await page.evaluate(() => ops.length), 0);
    assert.equal(page.seen.filter(r => r.path === "/send").length, sendsSoFar, "taking the words back sent something on its own");
    assert.deepEqual(await pendingOn("0"), []);
    assert.deepEqual(problems, []);
  } finally {
    await page.evaluate(() => localStorage.removeItem("pendops")).catch(() => {});
    await page.close();
  }
});

test("with fifty unsure sends kept, the readings go round past the first batch, and a receipt for one at the back lands it", async () => {
  // the board already applied one of the sends kept at the back of the store
  assert.equal((await api("/send?box=0&op=kept-unsure-45", "kept 45")).status, 200);
  const kept = fiftyKept("unsure");
  const { page, problems } = await openPhone("/m?box=0", PHONE, kept, r => r.path === "/send" ? { act: "abort" } : null);
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    // the one at the back is settled by its receipt within a few readings,
    // although the first reading can ask about only thirty-two
    await page.waitForFunction(() => !ops.some(o => o.id === "kept-unsure-45") &&
      [...document.querySelectorAll("article.box.sel .sentwrap .answmsg:not([data-op])")].some(r => r.dataset.text === "kept 45"), { timeout: 8000 });
    // and every kept id has been asked about by then
    const askedAll = await page.evaluate(() => ops.every(o => o.asked > 0));
    assert.equal(askedAll, true, "an operation beyond the first batch was never asked about");
    const readings = page.seen.filter(r => r.path === "/m/state" && /ops=/.test(r.search));
    const askedIds = new Set(readings.flatMap(r => decodeURIComponent(new URLSearchParams(r.search).get("ops") || "").split(",")));
    for (const op of kept) assert.ok(askedIds.has(op.id), `${op.id} was never named in a reading`);
    assert.ok(readings.every(r => (new URLSearchParams(r.search).get("ops") || "").split(",").length <= 32), "a reading asked past the board's cap");
    assert.equal(await page.evaluate(() => ops.length), 49);
    assert.equal(page.seen.filter(r => r.path === "/send").length, 0, "a kept unsure send was sent again");
    assert.deepEqual(problems, []);
  } finally {
    await page.evaluate(() => localStorage.removeItem("pendops")).catch(() => {});
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("a record an earlier page marked failed for a timeout is loaded as unsure and settled by its receipt; one the board refused stays not sent", async () => {
  // the board applied the first before the reply was lost; the second the
  // board refused outright, which an earlier page recorded as such
  assert.equal((await api("/send?box=0&op=old-page-timeout-01", "gave up too soon")).status, 200);
  const legacy = [
    { id: "old-page-timeout-01", kind: "send", box: "0", text: "gave up too soon", ts: Date.now() - 7200000, tries: 9, waiting: false, state: "failed",
      why: "the board could not be reached for half a day" },
    { id: "old-page-refused-01", kind: "send", box: "0", text: "refused by the board", ts: Date.now() - 7200000, tries: 1, waiting: false, state: "failed",
      why: "bad box or empty text", by: "board" },
  ];
  const { page, problems } = await openPhone("/m?box=0", PHONE, legacy, r => r.path === "/send" ? { act: "abort" } : null);
  try {
    await page.waitForSelector("#box-0.sel", { timeout: 5000 });
    // the timeout one is asked about and lands from the board's receipt; the
    // refused one is left exactly as the board decided
    await page.waitForFunction(() => !ops.some(o => o.id === "old-page-timeout-01") &&
      [...document.querySelectorAll("article.box.sel .sentwrap .answmsg:not([data-op])")].some(r => r.dataset.text === "gave up too soon"), { timeout: 8000 });
    const left = await rows(page);
    assert.deepEqual(left.local.map(r => [r.text, r.rcpt, r.failed]), [["refused by the board", "Not sent, tap to take the words back", true]]);
    assert.equal(page.seen.filter(r => r.path === "/send").length, 0, "a loaded record was sent again on its own");
    assert.deepEqual(await pendingOn("0"), ["gave up too soon"]);
    assert.deepEqual(problems, []);
  } finally {
    await page.evaluate(() => localStorage.removeItem("pendops")).catch(() => {});
    await page.close();
    await api("/dismiss?box=0");
  }
});

test("the desktop board on the same server still draws the cards and sends", async () => {
  const { page, problems } = await openPhone("/", DESKTOP);
  try {
    await page.waitForSelector("article.box", { timeout: 5000 });
    const shape = await page.evaluate(() => ({
      rev: typeof lastState.rev,
      cards: document.querySelectorAll("article.box").length,
      reads: 0,
    }));
    assert.equal(shape.rev, "number", "the desktop's reading carries no revision");
    assert.ok(shape.cards >= 2);
    await page.evaluate(() => { const el = els["0"]; el.ta.value = "From the desktop"; return doSend("0"); });
    const deadline = Date.now() + 5000;
    for (;;) {
      if ((await pendingOn("0")).includes("From the desktop")) break;
      assert.ok(Date.now() < deadline, "the desktop's send never landed");
      await settle(50);
    }
    const reads = page.seen.filter(r => r.path === "/state").length;
    assert.ok(reads >= 1, "the desktop never read the board");
    assert.equal(page.seen.filter(r => r.path === "/m/state").length, 0, "the desktop read the phone's reading");
    await page.screenshot({ path: path.join(SHOTS, "desktop-board.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/dismiss?box=0");
  }
});
