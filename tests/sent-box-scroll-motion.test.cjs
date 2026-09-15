// A sent box that folds open or shut must never flash a scrollbar for the length
// of the motion, and its rows must not slide sideways. The lane inside the box
// scrolls once the box is settled; while it moves it is clipped, and it hides its
// bar and holds no gutter, so the row column keeps one x with no bar ever drawn.
// Every card, message and answer below is invented.
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
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
let browser, child, fixtureDir, origin, cardId;

async function wait(ms = 120){ await new Promise(resolve => setTimeout(resolve, ms)); }
async function freePort(){
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function api(route, body){
  const response = await fetch(origin + route, { method:"POST", body });
  assert.equal(response.status, 200, `${route} returned ${response.status}`);
  return response.json();
}
async function claim(){
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=1&agent=scroll-motion");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-scroll-motion-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "card-markdown.js",
      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented scroll motion fixture", items:[] }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{ ...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir,"logs") },
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++){ try { if ((await fetch(origin + "/state")).ok) break; } catch {} await wait(25); }
  cardId = (await api("/create?owner=facilitator", "Invented scroll motion card")).id;
  // enough messages on each side that both boxes overflow their open height
  for (let i = 1; i <= 10; i++)
    await api(`/send?box=${cardId}`, `Invented earlier message ${i} that the reply below answers and fills the box.`);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:6}, (_, i) =>
    `Invented reply paragraph ${i + 1} keeps the card tall.`).join("\n\n"));
  for (let i = 1; i <= 10; i++)
    await api(`/send?box=${cardId}`, `Invented follow-up message ${i} is still waiting to be read in the box.`);
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive:true, force:true });
});

async function openCard(kind){
  const page = await browser.newPage();
  await page.setViewport(kind === "phone"
    ? { width:375, height:812, isMobile:true, hasTouch:true, deviceScaleFactor:2 }
    : { width:1440, height:900 });
  await page.evaluateOnNewDocument(id => { localStorage.clear(); localStorage.setItem("facilitator-selected", id); }, cardId);
  await page.goto(origin + (kind === "phone" ? "/m" : "/"), { waitUntil:"domcontentloaded" });
  await page.waitForFunction(id => typeof lastState !== "undefined" && lastState && typeof els !== "undefined" && els[id], {}, cardId);
  await page.evaluate(id => select(id), cardId);
  await page.waitForFunction(id => {
    const el = els[id];
    return el?.answ && el?.pend && !el.answ.classList.contains("rising") && !el.pend.classList.contains("rising");
  }, {}, cardId);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(350);
  return page;
}
function laneSelector(which){ return (which === "answ" ? ".pendwrap-answered" : ".pendwrap") + " .pendlist"; }
async function boxOpen(page, which){
  return page.evaluate((id, which) => {
    const el = els[id]; const p = which === "answ" ? el.answ : el.pend;
    return !!(p && p.classList.contains("open"));
  }, cardId, which);
}
function readLane(id, which){
  const el = els[id];
  const pend = which === "answ" ? el.answ : el.pend;
  const lane = pend.querySelector(".pendscroll");
  const rows = pend.querySelectorAll(".pendmsg");
  const row = rows[rows.length - 1];
  const cs = getComputedStyle(lane);
  return {
    motion: pend.classList.contains("motion"),
    overflows: lane.scrollHeight > lane.clientHeight + 1,
    overflowY: cs.overflowY,
    scrollbarWidth: cs.scrollbarWidth,
    gutter: lane.offsetWidth - lane.clientWidth,
    rowRight: row ? Math.round(row.getBoundingClientRect().right * 100) / 100 : null,
  };
}

for (const kind of ["desktop", "phone"]) {
  for (const which of ["answ", "pend"]) {
    test(`${kind}: the ${which === "answ" ? "answered" : "waiting"} box shows no scrollbar while it folds and never shifts its rows`, async () => {
      const page = await openCard(kind);
      const selector = `#box-${cardId} ${laneSelector(which)}`;
      if (await boxOpen(page, which)) { await page.click(selector); await wait(700); }

      await page.click(selector);   // fold open
      // sample partway through the run, where the lane is shorter than its rows
      let motion = null;
      for (let t = 0; t < 6 && !motion; t++) {
        await wait(t === 0 ? 70 : 35);
        const s = await page.evaluate(readLane, cardId, which);
        if (s.motion && s.overflows) motion = s;
      }
      assert.ok(motion, "did not catch the fold mid-motion with the lane overflowing");
      // the lane must not present a scrollbar for the length of the motion
      assert.equal(motion.overflowY, "hidden",
        `a scrollbar shows while the box folds: overflow-y is ${motion.overflowY}`);

      await wait(700);
      const settled = await page.evaluate(readLane, cardId, which);
      // settled and genuinely scrolling, the lane hides its bar and reserves no
      // gutter for one, and the rows still sit at one x through the fold
      assert.ok(settled.overflows, "the box did not stay tall enough to scroll when settled");
      assert.equal(settled.scrollbarWidth, "none",
        `the settled lane still shows a bar: scrollbar-width is ${settled.scrollbarWidth}`);
      assert.equal(settled.gutter, 0,
        `the settled lane still holds a gutter: ${settled.gutter}px`);
      assert.ok(motion.rowRight != null && settled.rowRight != null &&
        Math.abs(settled.rowRight - motion.rowRight) <= 0.5,
        `rows slid sideways: motion ${motion.rowRight} settled ${settled.rowRight}`);
      await page.close();
    });
  }
}
