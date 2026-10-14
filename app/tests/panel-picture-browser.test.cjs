// The picture panel in a real Chrome. A picture that carries script is shown
// in the panel like any other, from its own address and not from a copy the
// page made in its own origin, and opening that address by itself runs
// nothing. The panel still follows the file: it fills, redraws when the file
// changes, and empties when the file goes.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { mkdir, mkdtemp, rm, unlink, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHRASE = "panel-svg-ran-in-board";
const svg = extra => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
<script>fetch("/send?box=0", { method: "POST", body: "${PHRASE}" });</script>
<rect width="40" height="40" fill="#336699"/>${extra}</svg>`;

let board, browser, profile, picture;

before(async () => {
  board = await startBoard({ config: { image_panel_lane: "facilitator" } });
  await mkdir(path.join(board.app, "facilitator-internal"), { recursive: true });
  picture = path.join(board.app, "facilitator-internal", "panel.svg");
  await writeFile(picture, svg(""));
  profile = await mkdtemp(path.join(tmpdir(), "facilitator-panel-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking"] });
});

after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  if (profile) await rm(profile, { recursive: true, force: true });
});

const panel = page => page.evaluate(() => {
  const img = document.querySelector("#magic3 img.p3img");
  return img ? { src: img.getAttribute("src"), hidden: img.hidden, width: img.naturalWidth,
    filled: document.getElementById("magic3").classList.contains("filled") } : null;
});

const thread = async () => (await fetch(board.origin + "/thread?box=0")).text();

test("the panel shows a picture that carries script from its own address, not from a copy in the board's origin", async () => {
  const page = await browser.newPage();
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#magic3 img.p3img")?.hidden === false, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector("#magic3 img.p3img").naturalWidth > 0, { timeout: 10000 });
  const shown = await panel(page);
  assert.ok(shown.filled);
  assert.equal(shown.width, 40, "the picture is drawn");
  assert.ok(!/^blob:/.test(shown.src), `a copy in the board's own origin: ${shown.src}`);
  assert.match(shown.src, /^\/laneimg\/facilitator\/panel\.svg(\?|$)/);
  assert.ok(!(await thread()).includes(PHRASE), "showing the picture ran its script");
  await page.close();
});

test("opening a panel picture by itself, as 'open image in new tab' does, runs nothing", async () => {
  const opened = await browser.newPage();
  await opened.goto(`${board.origin}/laneimg/facilitator/panel.svg`, { waitUntil: "load" });
  await new Promise(resolve => setTimeout(resolve, 800));
  await opened.close();
  assert.ok(!(await thread()).includes(PHRASE), "the picture's script ran in the board's origin");
});

test("the panel redraws when the file changes and empties when it goes", async () => {
  const page = await browser.newPage();
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#magic3 img.p3img")?.hidden === false, { timeout: 20000 });
  const first = (await panel(page)).src;
  await writeFile(picture, svg('<circle cx="20" cy="20" r="9" fill="#ffcc00"/>'));
  await page.waitForFunction(was => document.querySelector("#magic3 img.p3img").getAttribute("src") !== was,
    { timeout: 15000 }, first);
  assert.equal((await panel(page)).hidden, false);
  await unlink(picture);
  await page.waitForFunction(() => document.querySelector("#magic3 img.p3img").hidden === true, { timeout: 15000 });
  assert.equal((await panel(page)).filled, false);
  await page.close();
});
