// The Deferred tab lists cards by when each was deferred and the Done tab by when
// each was marked done, most recent first, on the Mac board and on the phone, while
// Doing keeps its order. The rule is covered without a browser in tab-order-logic.test.cjs. Both pages are
// driven in a real browser against a copy of the board server: the Mac board at
// 1512 by 982 and the phone at 390 by 844. The arrows and the phone's swipe walk the
// same order the lists show.
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
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- both pages, in a browser -----------------------------------------------------
const CARDS = ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11"];
const DEFERRED_IN_ORDER = ["1.2", "1.4", "1.1"];   // the order they are deferred in
const DONE_IN_ORDER = ["1.5", "1.3", "1.6"];       // the order they are marked done in
const DOCKED_IN_ORDER = ["1.9", "1.11", "1.10"];
const SHOWN = { docked: ["1.10", "1.11", "1.9"], deferred: ["1.1", "1.4", "1.2"], done: ["1.6", "1.3", "1.5"] };
let browser, child, fixture, origin;

const post = async (route, body = "") => {
  const response = await fetch(origin + route, { method: "POST", body });
  assert.equal(response.status, 200, route);
};

async function arrange() {
  for (const id of CARDS) { await post(`/dock?box=${id}&v=0`); await post(`/park?box=${id}&v=0`); await post(`/done?box=${id}&v=0`); }
  for (const id of DOCKED_IN_ORDER) { await post(`/dock?box=${id}&v=1`); await pause(25); }
  for (const id of DEFERRED_IN_ORDER) { await post(`/park?box=${id}&v=1`); await pause(25); }
  for (const id of DONE_IN_ORDER) { await post(`/done?box=${id}&v=1`); await pause(25); }
}

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "tab-order-"));
  const port = await freePortPair();
  const source = (await readFile(path.join(ROOT, "server.py"), "utf8")).replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  await writeFile(path.join(fixture, "server.py"), source);
  copyBridgeFiles(fixture);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js", "index.html", "page.html"])
    await copyFile(path.join(ROOT, name), path.join(fixture, name));
  await mkdir(path.join(fixture, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) await copyFile(path.join(ROOT, "assets", name), path.join(fixture, "assets", name));
  await writeFile(path.join(fixture, "seed.json"), JSON.stringify({
    title: "tab order fixture",
    items: CARDS.map(id => ({ id, bucket: "meta", title: `Card ${id}`, owner: "facilitator", context: "" })),
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(PYTHON, [path.join(fixture, "server.py")], {
    cwd: fixture, env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: fixture }, stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    assert.ok(i < 400 && child.exitCode === null, "the fixture server did not start");
    await pause(25);
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

// what the page holds for each section, and what its lists show for it
const pooled = (page, view) => page.evaluate(v => viewPoolFor(lastState, v).map(b => b.id), view);
const rows = (page, view) => page.evaluate(v =>
  [...document.querySelectorAll(`.tikpane[data-view="${v}"] .trow`)].map(r => r.dataset.id), view);

async function listsShow(page, view, want, what) {
  await page.waitForFunction((v, ids) =>
    viewPoolFor(lastState, v).map(b => b.id).join() === ids &&
    [...document.querySelectorAll(`.tikpane[data-view="${v}"] .trow`)].map(r => r.dataset.id).join() === ids,
    { timeout: 10000 }, view, want.join()).catch(async () => {
      assert.deepEqual([await pooled(page, view), await rows(page, view)], [want, want], `${what}: ${view}`);
    });
  assert.deepEqual(await pooled(page, view), want, `${what}: ${view} pool`);
  assert.deepEqual(await rows(page, view), want, `${what}: ${view} rows`);
}

const SURFACES = {
  "Mac board": {
    viewport: { width: 1512, height: 982, deviceScaleFactor: 1 },
    async open() {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(this.viewport);
      await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof ownerReady !== "undefined" && ownerReady && activeOwner === "facilitator" && lastState !== null, { timeout: 8000 });
      await pause(600);
      return { page, context };
    },
    async showTabs() {},
    async chooseView(page, view) {
      await page.evaluate(v => document.getElementById("tv-" + v).click(), view);
      await page.waitForFunction(v => curView() === v, { timeout: 5000 }, view);
      await pause(450);
    },
    // an arrow key, as the board takes it
    async step(page, dir) { await page.keyboard.press(dir > 0 ? "ArrowRight" : "ArrowLeft"); await pause(200); },
  },
  "phone": {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    async open() {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(this.viewport);
      await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 10000 });
      await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 15000 });
      await pause(600);
      return { page, context };
    },
    // the lists are drawn only while the drawer is out
    async showTabs(page) {
      await page.evaluate(() => openDrawer());
      await page.waitForFunction(() => ticketsShown(), { timeout: 5000 });
      await page.evaluate(() => renderTickets(lastState));
    },
    async chooseView(page, view) {
      await page.evaluate(v => document.getElementById("tv-" + v).click(), view);
      await page.waitForFunction(v => curView() === v, { timeout: 5000 }, view);
      await pause(450);
    },
    // a swipe across the card: left shows the next one, right the one before
    async step(page, dir) {
      await page.evaluate(() => { if (menuOut()) closeDrawer(); });
      await page.waitForFunction(() => !menuOut(), { timeout: 5000 });
      await pause(800);
      const y = await page.evaluate(() => {
        const blocked = "button,input,textarea,a,[contenteditable],[role='textbox'],.cm-editor,.answered.sent.open";
        for (let y = 120; y < 700; y += 10) {
          const el = document.elementFromPoint(200, y);
          if (el && el.closest("#cards") && !el.closest(blocked)) return y;
        }
        return null;
      });
      assert.ok(y, "no open spot on the card to swipe from");
      const from = dir > 0 ? 330 : 60, to = dir > 0 ? 60 : 330;
      await page.touchscreen.touchStart(from, y);
      for (let i = 1; i <= 8; i++) { await page.touchscreen.touchMove(from + (to - from) * i / 8, y); await pause(16); }
      await page.touchscreen.touchEnd();
      await pause(600);
    },
  },
};

for (const [name, surface] of Object.entries(SURFACES)) {
  test(`${name}: Deferred and Done list the newest first, and a card deferred again moves to the top`, async () => {
    await arrange();
    const p = await surface.open();
    try {
      await surface.showTabs(p.page);
      await listsShow(p.page, "deferred", SHOWN.deferred, `${name}, as arranged`);
      await listsShow(p.page, "done", SHOWN.done, `${name}, as arranged`);
      assert.deepEqual((await pooled(p.page, "todo")).sort(), ["1.7", "1.8"], `${name}: Doing holds the two untouched cards`);

      // let go of the second card deferred and defer it again: it takes the top
      await post("/park?box=1.4&v=0");
      await listsShow(p.page, "deferred", ["1.1", "1.2"], `${name}, 1.4 let go`);
      await pause(25);
      await post("/park?box=1.4&v=1");
      await listsShow(p.page, "deferred", ["1.4", "1.1", "1.2"], `${name}, 1.4 deferred again`);

      // and the same for a card marked done
      await post("/done?box=1.3&v=0");
      await listsShow(p.page, "done", ["1.6", "1.5"], `${name}, 1.3 reopened`);
      await pause(25);
      await post("/done?box=1.3&v=1");
      await listsShow(p.page, "done", ["1.3", "1.6", "1.5"], `${name}, 1.3 done again`);

      // a card moved from one section to the other lands on top of its new one
      await pause(25);
      await post("/park?box=1.6&v=1");
      await listsShow(p.page, "deferred", ["1.6", "1.4", "1.1", "1.2"], `${name}, 1.6 moved to Deferred`);
      await listsShow(p.page, "done", ["1.3", "1.5"], `${name}, 1.6 moved out of Done`);
    } finally {
      await p.context.close();
    }
  });

  test(`${name}: stepping through the Deferred and Done tabs follows the order they list`, async () => {
    await arrange();
    const p = await surface.open();
    try {
      await surface.showTabs(p.page);
      for (const view of ["docked", "deferred", "done"]) {
        await listsShow(p.page, view, SHOWN[view], `${name}, as arranged`);
        await surface.chooseView(p.page, view);
        const want = SHOWN[view];
        await p.page.evaluate(id => browse(id), want[0]);
        await pause(300);
        const at = () => p.page.evaluate(() => selectedId);
        assert.equal(await at(), want[0], `${name}, ${view}: the first card is not on screen`);
        // forward through the list, round to the top, then back from the top round to the last
        const forward = [];
        for (let i = 0; i < want.length; i++) { await surface.step(p.page, 1); forward.push(await at()); }
        assert.deepEqual(forward, [...want.slice(1), want[0]], `${name}, ${view}: stepping on`);
        const back = [];
        for (let i = 0; i < want.length; i++) { await surface.step(p.page, -1); back.push(await at()); }
        assert.deepEqual(back, [want[want.length - 1], ...want.slice(0, -1).reverse()], `${name}, ${view}: stepping back`);
      }
    } finally {
      await p.context.close();
    }
  });
}

test("a card deferred on the phone's own page takes the top of Deferred there", async () => {
  await arrange();
  const p = await SURFACES["phone"].open();
  try {
    await SURFACES["phone"].showTabs(p.page);
    await listsShow(p.page, "deferred", SHOWN.deferred, "phone, as arranged");
    await p.page.evaluate(() => { toggleFlag("1.7", "park"); });
    await p.page.waitForFunction(() => viewPoolFor(lastState, "deferred")[0]?.id === "1.7", { timeout: 10000 });
    await listsShow(p.page, "deferred", ["1.7", ...SHOWN.deferred], "phone, 1.7 deferred on the page");
    assert.ok((await (await fetch(origin + "/m/state?since=")).json()).boxes.find(b => b.id === "1.7").parkedTs > 0,
      "the board did not stamp the card the page deferred");
  } finally {
    await p.context.close();
  }
});
