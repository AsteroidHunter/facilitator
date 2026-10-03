// The panel of waiting messages at a card's foot, when it folds open or shut, must
// never draw a scrollbar for the length of the motion, and its messages must not
// slide sideways. Open, a long batch stops at the card's cap and scrolls inside the
// cut; at every frame of either run that lane hides its bar and holds no gutter,
// so the column of messages keeps one x with no bar ever drawn. Every frame of
// each run is read from inside the page, so a slow machine cannot miss the motion.
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
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js",
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
  // enough messages on each side that both panels overflow their open height
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
    const stage = document.getElementById("stage");
    return el?.answ && el?.sent && !el.answ.classList.contains("motion") && !el.sent.classList.contains("motion") &&
      (!stage || getComputedStyle(stage).visibility === "visible");
  }, {}, cardId);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(350);
  return page;
}
// the answered messages over the reply are a plain panel with no lane of its own,
// so the waiting panel is the one panel here whose cut scrolls once it is open
const PANEL = ".sentwrap .answered";
function readLane(id){
  const panel = els[id].sent;
  const lane = panel.querySelector(".answclip");
  const rows = panel.querySelectorAll(".answmsg");
  const row = rows[rows.length - 1];
  const cs = getComputedStyle(lane);
  return {
    motion: panel.classList.contains("motion"),
    open: panel.classList.contains("open"),
    overflows: lane.scrollHeight > lane.clientHeight + 1,
    overflowY: cs.overflowY,
    scrollbarWidth: cs.scrollbarWidth,
    gutter: lane.offsetWidth - lane.clientWidth,
    rowRight: row ? Math.round(row.getBoundingClientRect().right * 100) / 100 : null,
  };
}
// one press on the panel, with every frame of the run it starts read as it is
// drawn, and the panel read again once the run has landed
async function pressAndWatch(page){
  await page.evaluate((id, source) => {
    const read = eval("(" + source + ")");
    window.__frames = [];
    window.__watching = true;
    const frame = () => {
      const now = read(id);
      if (now.motion) window.__frames.push(now);
      if (window.__watching) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, cardId, readLane.toString());
  await page.click(`#box-${cardId} ${PANEL}`);
  await wait(900);
  const frames = await page.evaluate(() => { window.__watching = false; return window.__frames; });
  return { frames, settled: await page.evaluate(readLane, cardId) };
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the waiting panel shows no scrollbar while it folds and never shifts its messages`, async () => {
    const page = await openCard(kind);
    try {
      if ((await page.evaluate(readLane, cardId)).open) await pressAndWatch(page);
      const cut = await page.evaluate(readLane, cardId);
      assert.ok(cut.rowRight != null, "the waiting panel holds no messages");

      const opening = await pressAndWatch(page);
      // the run was caught while the lane was shorter than its messages
      assert.ok(opening.frames.some(f => f.overflows),
        `did not catch the fold mid-motion with the lane overflowing: ${opening.frames.length} frames read`);
      // settled and genuinely scrolling, the lane hides its bar and reserves no
      // gutter for one
      assert.ok(opening.settled.open && !opening.settled.motion, "the panel did not open and settle");
      assert.ok(opening.settled.overflows, "the panel did not stay tall enough to scroll when open");
      assert.equal(opening.settled.scrollbarWidth, "none",
        `the open lane still shows a bar: scrollbar-width is ${opening.settled.scrollbarWidth}`);
      assert.equal(opening.settled.gutter, 0, `the open lane still holds a gutter: ${opening.settled.gutter}px`);

      const closing = await pressAndWatch(page);
      console.log(`  ${kind}: ${opening.frames.length} frames read opening, ${closing.frames.length} cutting back, ` +
        `open lane ${JSON.stringify(opening.settled)}`);
      assert.ok(closing.frames.length > 0, "did not catch the cut back mid-motion");
      assert.ok(!closing.settled.open && !closing.settled.motion, "the panel did not cut back and settle");

      // no frame of either run draws a bar or holds a gutter, and the messages
      // stand at one x through both runs
      for (const [run, seen] of [["opening", opening.frames], ["cutting back", closing.frames]])
        for (const f of seen) {
          assert.equal(f.scrollbarWidth, "none", `a scrollbar can show while the panel is ${run}: ${JSON.stringify(f)}`);
          assert.equal(f.gutter, 0, `the lane holds a gutter while the panel is ${run}: ${JSON.stringify(f)}`);
          assert.ok(Math.abs(f.rowRight - cut.rowRight) <= 0.5,
            `messages slid sideways while the panel is ${run}: ${f.rowRight} against ${cut.rowRight}`);
        }
      assert.ok(Math.abs(opening.settled.rowRight - cut.rowRight) <= 0.5,
        `messages slid sideways once open: ${opening.settled.rowRight} against ${cut.rowRight}`);
    } finally { await page.close(); }
  });
}
