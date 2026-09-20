// What the three pages say when something breaks in them, driven headless
// against their own fixture server: a thrown error, a rejected promise, the
// same throw over and over, the card that was open at the time, and the page
// view's sandbox, which reports nothing because it asks the board for nothing.
// The suite never touches port 8877 and opens no window.
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

let browser;
let child;
let outer;
let fixtureDir;
let logs;
let origin;

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const chosen = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return chosen;
}

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const made = await api("/create?owner=facilitator", title);
  assert.equal(made.status, 200);
  return made.body.id;
}

// every report the pages have sent so far
async function reports() {
  const out = [];
  for (const name of (await readdir(logs)).sort()) {
    if (!name.startsWith("client-")) continue;
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

let readSoFar = 0;

// the reports this case has caused, once the ones it is waiting for are there.
// A batch is sent by a beacon and written by another process, so a case waits
// for what it asked for rather than for a length of time
async function newReports(match = () => true, wanted = 1, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const all = await reports();
    const fresh = all.slice(readSoFar);
    if (fresh.filter(match).length >= wanted) {
      readSoFar = all.length;
      return fresh;
    }
    if (Date.now() > deadline) {
      readSoFar = all.length;
      throw new Error(`expected ${wanted} of a kind, saw ${JSON.stringify(fresh)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// everything reported up to now belongs to the cases before this one. The wait
// is for a batch the last page sent as it closed, which would otherwise land
// inside this case's window and be read as its own
async function settleReports() {
  await new Promise(resolve => setTimeout(resolve, 500));
  readSoFar = (await reports()).length;
}

// a page in its own browsing context, so one test's storage is never the next
// test's starting point
async function open(route, viewport) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (viewport) await page.setViewport(viewport);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof startReporter === "function", { timeout: 5000 });
  // the tests count the same events the reporter does, so a case can wait for
  // the page to have noticed rather than for a length of time to have passed
  await page.evaluate(() => {
    window.thrown = 0;
    window.rejected = 0;
    addEventListener("error", () => { window.thrown++; });
    addEventListener("unhandledrejection", () => { window.rejected++; });
  });
  return { page, context };
}

// the page going away, which is when a batch is sent
async function hide(page) {
  await page.evaluate(() => dispatchEvent(new Event("pagehide")));
}

// a throw that really comes from the page. Script handed to the browser through
// the developer tools is cross-origin to the document, so the browser masks its
// errors as "Script error." with no file and no line; an inline script in the
// page throws the way a card failing to draw throws.
async function throwInPage(page, message, times = 1) {
  const before = await page.evaluate(() => window.thrown);
  await page.addScriptTag({
    content: "(function () { const trip = () => { throw new Error(" +
      JSON.stringify(message) + "); };\n" +
      "for (let n = 0; n < " + times + "; n++) setTimeout(trip); })();",
  });
  await page.waitForFunction(wanted => window.thrown >= wanted, { timeout: 10000 }, before + times);
}

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-page-reports-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["index.html", "m.html", "page.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json",
                      "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
                      "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "page reports fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "1.1", bucket: "now", title: "A lane card", owner: "pastureland" },
    ],
  }));

  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }

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
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("an error thrown on the board reaches the file with its message, file and line", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    await throwInPage(page, "the board tripped over a card");
    await hide(page);
    const fresh = await newReports(report => /the board tripped over a card/.test(report.message));
    const thrown = fresh.find(report => /the board tripped over a card/.test(report.message));
    assert.ok(thrown, `the throw was not reported: ${JSON.stringify(fresh)}`);
    assert.equal(thrown.kind, "error");
    assert.equal(thrown.page, "board");
    assert.match(thrown.message, /the board tripped over a card/);
    // where it happened, as the browser gives it: a script put into the page at
    // run time has no address of its own, so the file is empty here and the
    // line and column are the ones inside it. A card failing to draw in the
    // page's own script carries that file, which the render case below shows
    assert.equal(typeof thrown.file, "string");
    assert.ok(thrown.line > 0, "the report says nothing about where it happened");
    assert.ok(thrown.col > 0);
    assert.equal(thrown.count, 1);
  } finally {
    await context.close();
  }
});

test("a promise nobody caught reaches the file as a rejection", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    await page.addScriptTag({
      content: 'Promise.reject(new Error("the reply never came back"));',
    });
    await page.waitForFunction(() => window.rejected >= 1, { timeout: 10000 });
    await hide(page);
    const fresh = await newReports(report => report.kind === "rejection");
    const rejected = fresh.find(report => report.kind === "rejection");
    assert.ok(rejected, `no rejection was reported: ${JSON.stringify(fresh)}`);
    assert.match(rejected.message, /the reply never came back/);
    assert.equal(rejected.page, "board");
  } finally {
    await context.close();
  }
});

test("the same throw fifty times is one report with a count of fifty", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    // one line, thrown over and over: one thing is wrong, not fifty
    await throwInPage(page, "the same card, again", 50);
    await hide(page);
    const fresh = await newReports(report => /the same card, again/.test(report.message));
    const repeated = fresh.filter(report => /the same card, again/.test(report.message));
    assert.equal(repeated.length, 1, `${repeated.length} lines for one repeated throw`);
    assert.equal(repeated[0].count, 50);
  } finally {
    await context.close();
  }
});

test("a report names the card that was open at the time", async () => {
  const id = await create("The card that was open");
  await settleReports();
  const { page, context } = await open(`/m?box=${id}`, PHONE);
  try {
    await page.waitForFunction(box => selectedId === box, { timeout: 5000 }, id);
    await throwInPage(page, "the phone tripped with a card open");
    await hide(page);
    const fresh = await newReports(report => /the phone tripped/.test(report.message));
    const thrown = fresh.find(report => /the phone tripped/.test(report.message));
    assert.ok(thrown, `no report from the phone: ${JSON.stringify(fresh)}`);
    assert.equal(thrown.page, "phone");
    assert.equal(thrown.box, id, "the report does not say which card was open");
  } finally {
    await context.close();
  }
});

test("a page becoming hidden sends the batch, without going away first", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    await throwInPage(page, "hidden, not closed");
    assert.equal((await reports()).length - readSoFar, 0, "the batch went out before the page hid");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
      Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const fresh = await newReports(report => /hidden, not closed/.test(report.message));
    assert.ok(fresh.some(report => /hidden, not closed/.test(report.message)));
  } finally {
    await context.close();
  }
});

test("the page view's sandbox reports nothing at all", async () => {
  await settleReports();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(origin + "/page?mock=1", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof MOCK !== "undefined", { timeout: 5000 });
    assert.equal(await page.evaluate(() => MOCK), true, "the sandbox was not on");
    await page.addScriptTag({
      content: 'setTimeout(() => { throw new Error("the sandbox tripped"); });',
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal((await reports()).length - readSoFar, 0,
      "the sandbox, which asks the board for nothing, sent something");
  } finally {
    await context.close();
  }
});

test("the page view outside the sandbox reports like the other two", async () => {
  await settleReports();
  const { page, context } = await open("/page");
  try {
    await throwInPage(page, "the page view tripped");
    await hide(page);
    const fresh = await newReports(report => /the page view tripped/.test(report.message));
    const thrown = fresh.find(report => /the page view tripped/.test(report.message));
    assert.ok(thrown, `no report from the page view: ${JSON.stringify(fresh)}`);
    assert.equal(thrown.page, "page");
  } finally {
    await context.close();
  }
});

// ---- the banner and the render ------------------------------------------------
// One try used to wrap the fetch and the render together, so three throws from
// anywhere in the render path painted "the server is unreachable" over a server
// that was answering perfectly, and the owner was sent to restart a healthy
// process. The banner keeps its wording and its three strikes; what changes is
// when it is right.

const UNREACHABLE =
  "The facilitator server is unreachable. Nothing sent now will arrive; ask in the terminal to restart it.";

// the poll's fetch, refused at the browser: the same thing the page sees when
// the server is down, without taking the server away from the other tests
async function cutTheWire(page, off) {
  if (!off) {
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.url().includes("/state")) request.abort("failed").catch(() => {});
      else request.continue().catch(() => {});
    });
    return;
  }
  await page.setRequestInterception(false);
}

async function banner(page) {
  return page.evaluate(() => ({
    shown: document.body.classList.contains("offline"),
    said: (document.getElementById("offline") || {}).textContent || "",
  }));
}

async function untilBanner(page, shown, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const now = await banner(page);
    if (now.shown === shown) return now;
    if (Date.now() > deadline) throw new Error(`the banner never turned ${shown ? "on" : "off"}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// the phone reads the board through its own short reading, and draws only
// when the board has changed: its render runs once per change, and its note
// for a board that stopped answering says so in its own words
const PHONE_STALE = /^Reconnecting to the board\. Last update \d{1,2}:\d{2} (AM|PM)\.$/;

for (const [name, route, viewport, readRoute, saidWhenGone] of [
  ["board", "/", null, "/state", UNREACHABLE],
  ["phone page", "/m", PHONE, "/m/state", PHONE_STALE],
]) {
  test(`a render that throws on the ${name} leaves the banner alone and is reported`, async () => {
    await settleReports();
    const { page, context } = await open(route, viewport);
    try {
      await page.evaluate(() => {
        // the card will not draw. The server is answering perfectly
        window.apply = () => { throw new Error("the card would not draw"); };
      });
      if (readRoute === "/m/state") {
        // the phone draws on a change: three changes, each landing before the next reading
        for (let n = 0; n < 3; n++) {
          await fetch(origin + "/send?box=0", { method: "POST", body: `change ${n}` });
          await new Promise(resolve => setTimeout(resolve, 1400));
        }
      }
      await new Promise(resolve => setTimeout(resolve, 4200));   // three polls and a margin
      const shown = await banner(page);
      assert.equal(shown.shown, false, "a card that would not draw painted the unreachable banner");
      assert.ok(!shown.said.includes("unreachable"), shown.said);

      await hide(page);
      const fresh = await newReports(report => report.kind === "render");
      const failed = fresh.filter(report => report.kind === "render");
      assert.equal(failed.length, 1, `${failed.length} render reports for one broken render`);
      assert.match(failed[0].message, /the card would not draw/);
      assert.ok(failed[0].count >= 3,
        `three polls drew three times, and the report counted ${failed[0].count}`);
      assert.ok(!fresh.some(report => report.kind === "fetch"),
        "a render failure was reported as a failed request");
    } finally {
      await context.close();
    }
  });

  test(`a server the ${name} cannot reach paints the banner, and it clears when it comes back`, async () => {
    await settleReports();
    const { page, context } = await open(route, viewport);
    try {
      await cutTheWire(page, false);
      const gone = await untilBanner(page, true);
      if (typeof saidWhenGone === "string") assert.equal(gone.said, saidWhenGone, "the banner does not say what it always said");
      else assert.match(gone.said, saidWhenGone, "the note does not say the board is being reached for again");

      await cutTheWire(page, true);
      if (readRoute === "/m/state") await page.evaluate(() => resume());   // the phone reads again on a wake, not on a clock it has backed off
      await untilBanner(page, false);

      await hide(page);
      const fresh = await newReports(report => report.kind === "fetch");
      const failed = fresh.filter(report => report.kind === "fetch");
      assert.ok(failed.length >= 1, `no failed request was reported: ${JSON.stringify(fresh)}`);
      assert.equal(failed[0].route, readRoute, "the report does not say which route failed");
      assert.ok(failed[0].count >= 1);
      assert.ok(!fresh.some(report => report.kind === "render"),
        "a request that failed was reported as a broken render");
    } finally {
      await context.close();
    }
  });
}

// ---- the freeze watchdog ------------------------------------------------------
// A one second timer that says when it ran late. It cannot say what blocked the
// main thread, only that something did, for how long, and what the page thought
// it was doing; on a phone that is the whole of what can be measured, since the
// long task observer the desktop has does not exist in Safari.

// a block has to run longer than a tick plus the two second bar, or whether it
// is reported depends on where in the second it started: a tick due in a
// moment leaves only what is left of the block to count as lateness
async function blockFor(page, ms) {
  await page.evaluate(howLong => {
    const until = Date.now() + howLong;
    while (Date.now() < until) { /* the thread is busy, which is the point */ }
  }, ms);
}

test("a main thread blocked for three seconds is reported as a freeze", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));   // the watchdog is running
    await blockFor(page, 3600);
    await new Promise(resolve => setTimeout(resolve, 1200));   // its next tick, late
    await hide(page);

    const fresh = await newReports(report => report.kind === "slow");
    const frozen = fresh.filter(report => report.kind === "slow");
    assert.equal(frozen.length, 1, `${frozen.length} freeze reports for one block`);
    assert.ok(frozen[0].late > 2000, `the lateness reads ${frozen[0].late} ms`);
    assert.ok(frozen[0].late < 10000, `an unbelievable lateness: ${frozen[0].late} ms`);
    assert.ok(["poll", "render", "card", "idle"].includes(frozen[0].doing),
      `the report says the page was doing ${JSON.stringify(frozen[0].doing)}`);
    assert.equal(frozen[0].page, "board");
  } finally {
    await context.close();
  }
});

test("a page left alone for ten seconds reports nothing at all", async () => {
  await settleReports();
  const { page, context } = await open("/");
  try {
    await new Promise(resolve => setTimeout(resolve, 10000));
    await hide(page);
    await new Promise(resolve => setTimeout(resolve, 400));
    const fresh = (await reports()).slice(readSoFar);
    readSoFar = (await reports()).length;
    assert.deepEqual(fresh.filter(report => report.kind === "slow"), [],
      "a page doing nothing wrong reported a freeze");
  } finally {
    await context.close();
  }
});

test("two blocks in a row are two reports, because a freeze is an event", async () => {
  await settleReports();
  const { page, context } = await open("/m", PHONE);
  try {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await blockFor(page, 3600);
    await new Promise(resolve => setTimeout(resolve, 1400));
    await blockFor(page, 3600);
    await new Promise(resolve => setTimeout(resolve, 1400));
    await hide(page);

    const fresh = await newReports(report => report.kind === "slow", 2);
    const frozen = fresh.filter(report => report.kind === "slow");
    assert.equal(frozen.length, 2, `${frozen.length} reports for two blocks`);
    for (const report of frozen) {
      assert.ok(report.late > 2000);
      assert.equal(report.count, 1, "two freezes were counted as one thing happening twice");
      assert.equal(report.page, "phone");
    }
  } finally {
    await context.close();
  }
});
