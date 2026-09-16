// The header row of each sent-message box, on both pages: the time stands at
// the row's left end and the collapse arrow at its right end, the two on one
// line, and a tap on the arrow still folds and unfolds the box. The arrow keeps
// its size and the turn it is drawn with. The measures are printed before they
// are asserted, so one run records the numbers whether it passes or fails.
// Every card, message and answer here is invented.
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
const SHOTS = process.env.PEND_HEAD_SHOTS || "";
const SENT = "Invented message for the header row.";
let browser, child, fixtureDir, origin, cardId;

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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=2&agent=header-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pend-header-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "card-markdown.js",
      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented header fixture", items:[]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs")},
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented card for the header row")).id;
  // one message the reply answers, so the box above the answer has a run to head
  await api(`/send?box=${cardId}`, SENT);
  await claim();
  await api(`/reply?box=${cardId}`, "Invented answer, one paragraph long, so the card carries both boxes.");
  // and one still waiting, so the box under the answer has one too
  await api(`/send?box=${cardId}`, SENT);
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, {recursive:true, force:true});
});

async function openPage(kind){
  const page = await browser.newPage();
  await page.setViewport(kind === "phone"
    ? {width:375,height:812,isMobile:true,hasTouch:true,deviceScaleFactor:2}
    : {width:1440,height:900});
  await page.evaluateOnNewDocument(id => {
    localStorage.clear();
    localStorage.setItem("facilitator-selected", id);
  }, cardId);
  await page.goto(origin + (kind === "phone" ? "/m" : "/"), {waitUntil:"domcontentloaded"});
  await page.waitForFunction(id => typeof els !== "undefined" && els[id], {}, cardId);
  await page.evaluate(id => select(id), cardId);
  await page.waitForFunction(id => {
    const el = els[id];
    return el.answ && el.pend &&
      ["motion", "opening", "closing", "rising"].every(name =>
        !el.answ.classList.contains(name) && !el.pend.classList.contains(name));
  }, {}, cardId);
  await page.evaluate(() => document.fonts.ready);
  return page;
}
async function settled(page, seat, open){
  await page.waitForFunction((id, seat, open) => {
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    return strip.classList.contains("open") === open &&
      ["motion", "opening", "closing"].every(name => !strip.classList.contains(name));
  }, {timeout:5000}, cardId, seat, open);
  await pause(120);
}
// both strips opened by hand, and left alone until each run has stopped
async function openBoxes(page){
  for (const seat of [".pendwrap-answered", ".pendwrap"]) {
    await page.click(`#box-${cardId} ${seat} .pendlist`);
    await settled(page, seat, true);
  }
}
// one open box's header row: the row's own span, the ink of the printed time,
// and the arrow standing on that line
async function headerOf(page, seat){
  return page.evaluate((id, seat) => {
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    const round = n => Math.round(n * 100) / 100;
    const edges = el => { const r = el.getBoundingClientRect();
      return {left:round(r.left), right:round(r.right), top:round(r.top),
              bottom:round(r.bottom), width:round(r.width), height:round(r.height)}; };
    const stamp = strip.querySelector(".pendstamp");
    const range = document.createRange();
    range.selectNodeContents(stamp);
    const ink = range.getClientRects()[0];
    const chev = strip.querySelector(".chevtop");
    const style = getComputedStyle(chev);
    return {
      row:edges(stamp),
      time:{text:stamp.textContent,
            ink:ink ? {left:round(ink.left), right:round(ink.right),
                       top:round(ink.top), bottom:round(ink.bottom)} : null,
            font:getComputedStyle(stamp).font, color:getComputedStyle(stamp).color},
      arrow:{...edges(chev), transform:style.transform, color:style.color},
    };
  }, cardId, seat);
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the time heads both boxes and the arrow ends the row`, async () => {
    const page = await openPage(kind);
    await openBoxes(page);
    const heads = { top:await headerOf(page, ".pendwrap-answered"), bottom:await headerOf(page, ".pendwrap") };
    console.log(`  ${kind} :: ${JSON.stringify(heads)}`);
    if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${kind}-header.png`)}); }

    for (const [name, head] of Object.entries(heads)) {
      assert.ok(head.time.text.trim(), `the ${name} box printed no time to head it`);
      assert.ok(head.time.ink, `the ${name} box's time has no ink to measure`);
      // the time at the left end of the row
      assert.ok(Math.abs(head.time.ink.left - head.row.left) <= 1,
        `the ${name} box did not put its time at the left end: ${JSON.stringify(head)}`);
      // the arrow at the right end of it
      assert.ok(Math.abs(head.arrow.right - head.row.right) <= 1,
        `the ${name} box did not put its arrow at the right end: ${JSON.stringify(head)}`);
      // the two on one line, in that order, with room between them
      assert.ok(head.time.ink.right < head.arrow.left,
        `the ${name} box's time and arrow are not in that order: ${JSON.stringify(head)}`);
      assert.ok(head.arrow.top >= head.row.top && head.arrow.bottom <= head.row.bottom,
        `the ${name} box took its arrow off the time's own line: ${JSON.stringify(head)}`);
      // the arrow is the same 11x7 glyph, turned the way it has always been
      assert.equal(head.arrow.width, 11, `the ${name} box resized its arrow: ${JSON.stringify(head.arrow)}`);
      assert.equal(head.arrow.height, 7, `the ${name} box resized its arrow: ${JSON.stringify(head.arrow)}`);
      assert.ok(head.arrow.transform.startsWith("matrix(-1"),
        `the ${name} box turned its arrow another way: ${JSON.stringify(head.arrow)}`);
    }
    await page.close();
  });

  test(`${kind}: a tap on the arrow's new seat still folds and unfolds`, async () => {
    const page = await openPage(kind);
    await openBoxes(page);
    for (const [name, seat] of [["top", ".pendwrap-answered"], ["bottom", ".pendwrap"]]) {
      const head = await headerOf(page, seat);
      const x = (head.arrow.left + head.arrow.right) / 2;
      const y = (head.arrow.top + head.arrow.bottom) / 2;
      console.log(`  ${kind} ${name} :: tap at ${x}, ${y}`);
      await page.mouse.click(x, y);
      await settled(page, seat, false);
      assert.equal(await page.evaluate((id, seat) =>
        document.querySelector(`#box-${id} ${seat} .pendlist`).classList.contains("open"), cardId, seat),
        false, `a tap on the ${name} box's arrow did not fold it`);
      // and the bar it folded to opens it again, as it always did
      await page.click(`#box-${cardId} ${seat} .pendlist`);
      await settled(page, seat, true);
      assert.equal(await page.evaluate((id, seat) =>
        document.querySelector(`#box-${id} ${seat} .pendlist`).classList.contains("open"), cardId, seat),
        true, `the ${name} box did not open again`);
    }
    await page.close();
  });
}
