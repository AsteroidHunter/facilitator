// The phone page when the board stops answering: after a few seconds of failed
// reads a plain white screen with one line, "Is the Facilitator server down?",
// and a knocked out face drawn as a line icon. A single dropped or slow read must
// not bring it up, and when the board answers again it goes away on its own with
// the open card and the unsent words exactly as they were. Driven headless at an
// iPhone size against its own fixture server, which is stopped and started again
// on the same port.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const WORDS = "Is the Facilitator server down?";

let browser;
let child;
let fixtureDir;
let origin;
let port;
let output = "";

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer() {
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await settle(25);
  }
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

// a page whose /m/state reads can be aborted, answered with a status, delayed
// or left hanging, a set number of times, on the test's say
async function openPhone(route, { held = false } = {}) {
  // a context of its own: the retry store and the open card live in local storage,
  // and pages that share it would steer one another
  const context = await (browser.createBrowserContext || browser.createIncognitoBrowserContext).call(browser);
  const page = await context.newPage();
  page.once("close", () => { context.close().catch(() => {}); });
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com|Failed to load resource/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.evaluateOnNewDocument(() => {
    window.__down = [];
    document.addEventListener("DOMContentLoaded", () => {
      let was = false;
      new MutationObserver(() => {
        const now = document.body.classList.contains("down");
        if (now !== was) { was = now; window.__down.push(now); }
      }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    });
  });
  const reads = { mode: held ? "abort" : "pass", left: Infinity, status: 0, ms: 0 };
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (!request.url().includes("/m/state") || reads.mode === "pass" || reads.left <= 0) {
      return request.continue().catch(() => {});
    }
    if (reads.left !== Infinity) reads.left--;
    if (reads.mode === "abort") return request.abort("connectionrefused").catch(() => {});
    if (reads.mode === "status") {
      return request.respond({ status: reads.status, contentType: "text/plain", body: "refused" }).catch(() => {});
    }
    if (reads.mode === "delay") return void setTimeout(() => request.continue().catch(() => {}), reads.ms);
  });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  return { page, reads, problems };
}

const isDown = page => page.evaluate(() => document.body.classList.contains("down"));
const downLog = page => page.evaluate(() => window.__down);
const boardDrawn = page => page.waitForFunction(
  () => lastState !== null && document.querySelector("article.box.sel"), { timeout: 10000 });

async function waitDown(page, want, timeout) {
  const started = Date.now();
  await page.waitForFunction(w => document.body.classList.contains("down") === w,
    { polling: 50, timeout }, want);
  return Date.now() - started;
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-down-"));
  port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "server down test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A card that stays open", owner: "facilitator", context: "It holds a reply." },
    ],
  }));
  origin = `http://127.0.0.1:${port}`;
  await startServer();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("readings that fail briefly, slowly or with an answer never show the white screen for the wrong reason", async () => {
  // each case gets its own page; the reads are steered per page, the board stays up
  const cases = {
    async oneDropped() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort"; reads.left = 1;
      await settle(6000);
      assert.deepEqual(await downLog(page), [], "one dropped read must not bring the screen up");
      await page.close();
    },
    async oneSlow() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "delay"; reads.ms = 3500; reads.left = 1;
      await settle(7000);
      assert.deepEqual(await downLog(page), [], "one slow read must not bring the screen up");
      await page.close();
    },
    async twoDropped() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort"; reads.left = 2;
      await page.waitForFunction(() => document.body.classList.contains("offline"), { polling: 50, timeout: 12000 });
      assert.equal(await isDown(page), false, "the reconnecting note is for short gaps");
      await page.waitForFunction(() => !document.body.classList.contains("offline"), { polling: 100, timeout: 20000 });
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async refused() {
      // an answer that refuses is still an answer: the board is there
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "status"; reads.status = 401;
      await settle(11000);
      assert.deepEqual(await downLog(page), [], "a 401 is the board answering");
      await page.close();
    },
    async badGateway() {
      // what a proxy in front of a stopped server says: the screen after the wait, gone on the next answer
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "status"; reads.status = 502;
      const took = await waitDown(page, true, 25000);
      assert.ok(took >= 4000, `the screen came up after ${took} ms, too soon`);
      assert.ok(took <= 12000, `the screen came up after ${took} ms, too late`);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      assert.deepEqual(await downLog(page), [true, false]);
      await page.close();
    },
    async openedWhileDown() {
      // the page arrives and every reading then fails
      const { page, reads } = await openPhone("/m?box=1.1", { held: true });
      await waitDown(page, true, 30000);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await boardDrawn(page);
      await page.close();
    },
    async wakeStartsTheCountAgain() {
      // one failure from before the phone slept plus one after it is not enough
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      await page.evaluate(() => { downSince = Date.now() - 600000; downReads = 1; });
      reads.mode = "abort"; reads.left = 1;
      await page.evaluate(() => resume());
      await settle(3000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
  };
  const results = await Promise.allSettled(Object.entries(cases).map(async ([name, run]) => {
    try { await run(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
});

test("the server stops and starts again: the white screen comes and goes, the card and the words stay", async () => {
  const { page, problems } = await openPhone("/m?box=1.1");
  await boardDrawn(page);
  await page.type("article.box.sel textarea", "sent while the board was gone");
  const open = await page.evaluate(() => ({ selectedId, sel: document.querySelector("article.box.sel").id }));
  assert.equal(open.selectedId, "1.1");
  assert.equal(await isDown(page), false, "board up: no white screen");

  await stopServer();
  // a send that lands moves on to the next card by design; this one stays put so
  // the card can only move if the white screen moves it
  await page.evaluate(() => doSend(selectedId, { advance: false }));
  await page.type("article.box.sel textarea", "a draft still being written");
  const took = await waitDown(page, true, 30000);
  assert.ok(took >= 2000, `the screen came up ${took} ms after the last good read, too soon`);

  const shown = await page.evaluate(() => {
    const screen = document.getElementById("serverdown");
    const line = screen.querySelector("p");
    const icon = line.querySelector("svg");
    const style = getComputedStyle(line);
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
    line.appendChild(probe);
    const baseline = probe.getBoundingClientRect().bottom;
    probe.remove();
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const capHeight = canvas.measureText("H").actualBoundingBoxAscent;
    const box = icon.getBoundingClientRect();
    const lineBox = line.getBoundingClientRect();
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const corner = document.elementFromPoint(4, 4);
    return {
      words: line.textContent,
      fontSize: parseFloat(style.fontSize),
      iconWidth: box.width, iconHeight: box.height,
      centreAboveBaseline: baseline - (box.top + box.bottom) / 2,
      halfCapHeight: capHeight / 2,
      oneLine: lineBox.height < parseFloat(style.fontSize) * 2,
      lineCentreX: (lineBox.left + lineBox.right) / 2,
      lineCentreY: (lineBox.top + lineBox.bottom) / 2,
      background: getComputedStyle(screen).backgroundColor,
      covers: screen.getBoundingClientRect().width === innerWidth && screen.getBoundingClientRect().height === innerHeight,
      onTop: !!middle.closest("#serverdown") && !!corner.closest("#serverdown"),
      strokeIcon: icon.getAttribute("fill") === "none" && icon.getAttribute("stroke") === "currentColor",
      emoji: /\p{Extended_Pictographic}/u.test(line.textContent),
      extras: screen.querySelectorAll("button,a,input,progress,textarea,img").length,
      children: [...screen.children].map(node => node.tagName),
    };
  });
  assert.equal(shown.words, WORDS);
  assert.equal(shown.emoji, false, "the face is drawn, not a colour emoji");
  assert.equal(shown.strokeIcon, true, "the face is a line icon in the app's stroke style");
  assert.equal(shown.iconHeight, shown.fontSize, "the icon is as tall as the text");
  assert.equal(shown.iconWidth, shown.fontSize);
  assert.ok(Math.abs(shown.centreAboveBaseline - shown.halfCapHeight) <= 1.2,
    `the icon sits ${shown.centreAboveBaseline}px above the baseline, the letters' middle is ${shown.halfCapHeight}px`);
  assert.equal(shown.oneLine, true, "one line");
  assert.ok(Math.abs(shown.lineCentreX - PHONE.width / 2) <= 1, "centred across");
  assert.ok(Math.abs(shown.lineCentreY - PHONE.height / 2) <= 2, "centred down");
  assert.equal(shown.background, "rgb(255, 255, 255)", "plain white");
  assert.equal(shown.covers, true);
  assert.equal(shown.onTop, true, "it is over everything");
  assert.equal(shown.extras, 0, "no buttons, no explanation, no spinner");
  assert.deepEqual(shown.children, ["P"]);

  await settle(1500);
  assert.equal(await isDown(page), true, "it stays while the board stays gone");

  await startServer();
  await waitDown(page, false, 40000);
  assert.deepEqual(await downLog(page), [true, false], "one appearance, one going away");

  const back = await page.evaluate(() => ({
    selectedId,
    sel: document.querySelector("article.box.sel").id,
    draft: document.querySelector("article.box.sel textarea").value,
    rows: document.querySelector("article.box.sel").textContent,
  }));
  assert.equal(back.selectedId, "1.1", "the app is where it was");
  assert.equal(back.sel, "box-1.1");
  assert.equal(back.draft, "a draft still being written", "the unsent words are kept");
  assert.match(back.rows, /sent while the board was gone/, "the message held by the retry store is still there");

  // the held message reaches the board on its own, once
  const deadline = Date.now() + 40000;
  let landed = 0;
  while (Date.now() < deadline) {
    const state = await (await fetch(origin + "/state")).json();
    landed = JSON.stringify(state.boxes.find(box => box.id === "1.1")).split("sent while the board was gone").length - 1;
    if (landed) break;
    await settle(500);
  }
  assert.equal(landed, 1, "the message sent while the board was gone lands exactly once");
  assert.deepEqual(problems, []);
  await page.close();
});
