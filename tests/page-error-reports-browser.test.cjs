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
async function newReports(wanted = 1, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const all = await reports();
    if (all.length - readSoFar >= wanted) {
      const fresh = all.slice(readSoFar);
      readSoFar = all.length;
      return fresh;
    }
    if (Date.now() > deadline) {
      const fresh = all.slice(readSoFar);
      readSoFar = all.length;
      throw new Error(`expected ${wanted} reports, saw ${fresh.length}: ${JSON.stringify(fresh)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function settleReports() {
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
  await page.addScriptTag({
    content: "(function () { const trip = () => { throw new Error(" +
      JSON.stringify(message) + "); };\n" +
      "for (let n = 0; n < " + times + "; n++) setTimeout(trip); })();",
  });
  await new Promise(resolve => setTimeout(resolve, 100 + times * 4));
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
  for (const name of ["index.html", "m.html", "page.html", "m-sw.js", "m-manifest.json",
                      "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js"]) {
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
    const fresh = await newReports(1);
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
    await new Promise(resolve => setTimeout(resolve, 200));
    await hide(page);
    const fresh = await newReports(1);
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
    const fresh = await newReports(1);
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
    const fresh = await newReports(1);
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
    const fresh = await newReports(1);
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
    await throwInPage(page, "the sandbox tripped");
    await page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await new Promise(resolve => setTimeout(resolve, 300));
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
    const fresh = await newReports(1);
    const thrown = fresh.find(report => /the page view tripped/.test(report.message));
    assert.ok(thrown, `no report from the page view: ${JSON.stringify(fresh)}`);
    assert.equal(thrown.page, "page");
  } finally {
    await context.close();
  }
});
