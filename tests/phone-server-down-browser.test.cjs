// The phone page when the board does not answer: a plain white screen with one
// line, "Is the Facilitator server down?", and a knocked out face drawn as a line
// icon, shown only while the app is being opened (the page loads, or comes back
// on screen) and the first reading of the board is not answered. An app in use is
// never covered, however long the board stays gone, and neither is one that has
// been touched or typed in before the first reading was answered. No reconnecting bar
// stands under the tabs. When the board answers the screen goes away on its own
// with the open card and the unsent words exactly as they were. Driven headless
// at an iPhone size against its own fixture server, which is stopped and started
// again on the same port.
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
// or left hanging, a set number of times, on the test's say. mode is how the
// reads are treated from the first one on
async function openPhone(route, { mode = "pass", status = 0, ms = 0 } = {}) {
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
  const reads = { mode, left: Infinity, status, ms };
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
    // "hang": the board takes the connection and never answers
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

// the app put away and brought back: the page is hidden, then visible again
async function leaveAndReturn(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await settle(200);
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
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

test("no reconnecting bar is in the page source", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  // the bar's own "Last update <time>." line; the limits box's "Last updated" is a different line
  for (const gone of ['id="offline"', "#offline", "body.offline", "Reconnecting to the board", "The facilitator server is not answering", "delivered when it is back", /Last update(?!d)/]) {
    const found = typeof gone === "string" ? source.includes(gone) : gone.test(source);
    assert.equal(found, false, `${gone} is still in the page source`);
  }
});

test("the rule: only a reading asked after the opening decides, and the screen goes on any answer", async () => {
  const { page } = await openPhone("/m?box=1.1");
  try {
    await boardDrawn(page);
    const steps = await page.evaluate(() => {
      const down = () => document.body.classList.contains("down");
      const out = {};
      linkOpened();
      out.beforeEarlierFailure = down();
      linkDown(openedAt - 1000, null);
      out.afterEarlierFailure = down();
      linkDown(openedAt, null);
      out.afterOpeningFailure = down();
      linkUp(openedAt - 1000);
      out.afterEarlierAnswer = { down: down(), opening };
      linkDown(openedAt + 5, null);
      linkUp(openedAt + 10);
      out.afterOpeningAnswer = { down: down(), opening };
      linkDown(openedAt + 20, null);
      out.afterAnsweredOpening = down();
      linkOpened();
      linkDown(openedAt, { status: 401 });
      out.afterRefusal = { down: down(), opening };
      linkOpened();
      linkDown(openedAt, { status: 403 });
      out.afterForbidden = { down: down(), opening };
      linkOpened();
      linkDown(openedAt, { status: 502 });
      out.afterBadGateway = down();
      linkUp(openedAt);
      linkOpened();
      linkTouched();
      linkDown(openedAt + 5, null);
      out.afterTouch = { down: down(), opening };
      linkOpened();
      linkDown(openedAt, null);
      linkTouched();
      out.afterTouchOnTheScreen = { down: down(), opening };
      linkUp(openedAt);
      return out;
    });
    assert.deepEqual(steps, {
      beforeEarlierFailure: false,
      afterEarlierFailure: false,
      afterOpeningFailure: true,
      afterEarlierAnswer: { down: false, opening: true },
      afterOpeningAnswer: { down: false, opening: false },
      afterAnsweredOpening: false,
      afterRefusal: { down: false, opening: false },
      afterForbidden: { down: false, opening: false },
      afterBadGateway: true,
      afterTouch: { down: false, opening: false },
      afterTouchOnTheScreen: { down: true, opening: true },
    });
  } finally {
    await page.close();
  }
});

test("opening: the first reading decides, an app in use is never covered", async () => {
  // each case gets its own page; the reads are steered per page, the board stays up
  const cases = {
    async openedWhileBoardRefuses() {
      const { page, reads } = await openPhone("/m?box=1.1", { mode: "abort" });
      const took = await waitDown(page, true, 15000);
      assert.ok(took <= 4000, `the screen came up ${took} ms after the page opened, too late for a first reading`);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await boardDrawn(page);
      assert.deepEqual(await downLog(page), [true, false]);
      await page.close();
    },
    async openedBehindBadGateway() {
      const { page, reads } = await openPhone("/m?box=1.1", { mode: "status", status: 502 });
      const took = await waitDown(page, true, 15000);
      assert.ok(took <= 4000, `the screen came up ${took} ms after the page opened, too late for a first reading`);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await page.close();
    },
    async openedWhileBoardNeverAnswers() {
      // the connection is taken and nothing comes back: the first reading's own
      // deadline of eight seconds is the whole wait
      const { page, reads } = await openPhone("/m?box=1.1", { mode: "hang" });
      await settle(5000);
      assert.deepEqual(await downLog(page), [], "the screen came up before the first reading's deadline");
      const took = await waitDown(page, true, 12000);
      assert.ok(took <= 6000, `the screen came up ${took} ms after the deadline was due`);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await page.close();
    },
    async openedHangingThenTapped() {
      // a hand on the app before the first reading is answered is an app in use
      const { page, reads } = await openPhone("/m?box=1.1", { mode: "hang" });
      await settle(2000);
      await page.touchscreen.tap(PHONE.width / 2, PHONE.height / 2);
      await settle(11000);
      assert.deepEqual(await downLog(page), [], "the screen came up over a tapped app");
      reads.mode = "pass";
      await boardDrawn(page);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async openedHangingThenAKeyPress() {
      const { page } = await openPhone("/m?box=1.1", { mode: "hang" });
      await settle(2000);
      await page.keyboard.press("a");
      await settle(11000);
      assert.deepEqual(await downLog(page), [], "the screen came up over an app with a key pressed");
      await page.close();
    },
    async aTouchOnTheWhiteScreenIsNotUse() {
      const { page, reads } = await openPhone("/m?box=1.1", { mode: "abort" });
      await waitDown(page, true, 15000);
      await page.touchscreen.tap(PHONE.width / 2, PHONE.height / 2);
      await settle(500);
      assert.equal(await isDown(page), true, "a tap took the screen away");
      assert.equal(await page.evaluate(() => opening), true, "a tap on the screen counted as use");
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await page.close();
    },
    async returnedHangingWithNoTouch() {
      // back on the screen with the board taking the connection and saying nothing:
      // the screen comes up when the reading is given up, and not before
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "hang";
      await leaveAndReturn(page);
      await settle(5000);
      assert.deepEqual(await downLog(page), [], "the screen came up before a reading was given up");
      await waitDown(page, true, 20000);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      await page.close();
    },
    async returnedHangingThenTyped() {
      // the words typed at two seconds are use: the screen never comes up, the words stay
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      await page.type("article.box.sel textarea", "words from before ");
      reads.mode = "hang";
      await leaveAndReturn(page);
      await settle(2000);
      await page.type("article.box.sel textarea", "and words typed at two seconds");
      await settle(20000);
      assert.deepEqual(await downLog(page), [], "the screen came up over typing");
      const kept = await page.evaluate(() => ({
        draft: document.querySelector("article.box.sel textarea").value,
        sel: document.querySelector("article.box.sel").id,
      }));
      assert.equal(kept.draft, "words from before and words typed at two seconds");
      assert.equal(kept.sel, "box-1.1");
      await page.close();
    },
    async openedWithASlowFirstAnswer() {
      // a slow answer is an answer: never the screen
      const { page } = await openPhone("/m?box=1.1", { mode: "delay", ms: 3500 });
      await boardDrawn(page);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async openedWithARefusal() {
      for (const status of [401, 403]) {
        const { page } = await openPhone("/m?box=1.1", { mode: "status", status });
        await settle(5000);
        assert.deepEqual(await downLog(page), [], `a ${status} on the first reading is the board answering`);
        await page.close();
      }
    },
    async inUseWhileTyping() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort";
      const typed = "words typed while the board is gone, for a good while";
      await page.type("article.box.sel textarea", typed, { delay: 300 });
      assert.deepEqual(await downLog(page), [], "the screen covered an app in use");
      const kept = await page.evaluate(() => ({
        draft: document.querySelector("article.box.sel textarea").value,
        sel: document.querySelector("article.box.sel").id,
        bar: document.getElementById("offline"),
        said: document.body.innerText,
      }));
      assert.equal(kept.draft, typed);
      assert.equal(kept.sel, "box-1.1");
      assert.equal(kept.bar, null, "a bar stands under the tabs");
      assert.doesNotMatch(kept.said, /Reconnecting|not answering|Last update/);
      await page.close();
    },
    async inUseBehindBadGateway() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "status"; reads.status = 502;
      await settle(14000);
      assert.deepEqual(await downLog(page), [], "a 502 on an app in use brought the screen up");
      await page.close();
    },
    async inUseRefused() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "status"; reads.status = 401;
      await settle(8000);
      assert.deepEqual(await downLog(page), [], "a 401 is the board answering");
      await page.close();
    },
    async inUseSlowRead() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "delay"; reads.ms = 3500; reads.left = 1;
      await settle(7000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async wakeWithoutAnOpening() {
      // the phone coming back online is a wake, not an opening
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort";
      await page.evaluate(() => resume());
      await settle(3000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async comingBackToTheScreenWhileBoardRefuses() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort";
      await settle(3000);
      assert.deepEqual(await downLog(page), [], "the screen came up before the app was opened again");
      await leaveAndReturn(page);
      const took = await waitDown(page, true, 12000);
      assert.ok(took <= 4000, `the screen came up ${took} ms after the app came back`);
      reads.mode = "pass";
      await waitDown(page, false, 30000);
      assert.deepEqual(await downLog(page), [true, false]);
      await page.close();
    },
    async comingBackToTheScreenWithTheBoardUp() {
      const { page } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      await leaveAndReturn(page);
      await settle(4000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async comingBackToTheScreenWithARefusal() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "status"; reads.status = 401;
      await leaveAndReturn(page);
      await settle(4000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
    async aPageBroughtBackFromTheBrowsersKeep() {
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      reads.mode = "abort";
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await waitDown(page, true, 12000);
      await page.close();
    },
    async anAppInUseStaysUncoveredAfterItsOpeningWasAnswered() {
      // opened, answered, then put away and brought back with the board up, and only
      // then does the board go: that last stretch is use, however long it lasts
      const { page, reads } = await openPhone("/m?box=1.1");
      await boardDrawn(page);
      await leaveAndReturn(page);
      await settle(1500);
      reads.mode = "abort";
      await settle(12000);
      assert.deepEqual(await downLog(page), []);
      await page.close();
    },
  };
  // a few at a time: the board answers at most 32 readings at once, its own files
  // included, and turns the rest away, so a crowd of pages opening together
  // loses scripts the page cannot start without
  const waiting = Object.entries(cases);
  const failures = [];
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let next = waiting.shift(); next; next = waiting.shift()) {
      const [name, run] = next;
      try { await run(); } catch (error) { failures.push(`${name}: ${error.message}`); }
    }
  }));
  if (failures.length) throw new Error(failures.join("\n"));
});

test("the server stops and starts again: an app in use is never covered, an opening is, and the card and the words stay", async () => {
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
  await settle(12000);
  assert.deepEqual(await downLog(page), [], "the screen covered an app in use");
  assert.equal(await page.evaluate(() => document.querySelector("article.box.sel textarea").value), "a draft still being written");

  // the app is put away and brought back with the board still gone: now it is an opening
  await leaveAndReturn(page);
  const took = await waitDown(page, true, 15000);
  assert.ok(took <= 4000, `the screen came up ${took} ms after the app came back`);

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
    // the line as it is seen: the words with the face hanging at their left
    const lineBox = screen.querySelector(".say").getBoundingClientRect();
    const firstLeft = node => {
      const range = document.createRange();
      const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
      range.setStart(text, 0);
      range.setEnd(text, 1);
      return [range.toString(), range.getBoundingClientRect().left];
    };
    const retry = screen.querySelector(".retry");
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
      letters: [firstLeft(line), firstLeft(retry)],
      retryBelow: retry.getBoundingClientRect().top >= line.getBoundingClientRect().bottom - 0.5,
      retryWords: retry.textContent,
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
  assert.equal(shown.extras, 0, "no buttons, no links, no images");
  assert.deepEqual(shown.children, ["DIV"]);
  assert.match(shown.retryWords, /^Retrying in (3 seconds|2 seconds|1 second)$/);
  assert.equal(shown.retryBelow, true, "the count is not under the words");
  assert.deepEqual(shown.letters.map(([letter]) => letter), ["I", "R"]);
  assert.equal(shown.letters[0][1], shown.letters[1][1], "the R of Retrying does not stand under the I of Is");

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
