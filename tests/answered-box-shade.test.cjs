// The box above the answer, holding the messages that answer was given, casts
// no shade around itself on either page: folded, its shut bar carries none, and
// opened by hand the whole strip carries none. None is asserted rather than
// "not the raised pair", because the sheet's own sunk pair would be just as
// wrong on a box that stands out of the card. Every card and message here is
// invented. The small card's own box in the left column is a different surface
// and keeps the shade it has always worn; the last test holds it to that.
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
const RAISED = "rgba(60, 45, 20, 0.11) 0px 2px 6px 0px, rgba(60, 45, 20, 0.07) 0px 1px 2px 0px";
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=2&agent=shade-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-answered-shade-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js",
      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented shade fixture", items:[]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs")},
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented card with an answered batch")).id;
  await api(`/send?box=${cardId}`, "First invented message this reply answers.");
  await api(`/send?box=${cardId}`, "Second invented message this reply answers.");
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:4}, (_, i) =>
    `Invented answer paragraph ${i + 1}, written to give the card some prose.`).join("\n\n"));
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
    const strip = els[id].answ;
    return strip && ["motion", "opening", "closing", "rising"].every(name => !strip.classList.contains(name));
  }, {}, cardId);
  return page;
}
async function shade(page, selector){
  return page.evaluate((id, selector) => {
    const strip = els[id].answ, node = selector ? strip.querySelector(selector) : strip;
    const style = getComputedStyle(node);
    return { boxShadow:style.boxShadow, filter:style.filter,
             height:node.getBoundingClientRect().height, open:strip.classList.contains("open") };
  }, cardId, selector);
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the folded box carries no shade around its bar`, async () => {
    const page = await openPage(kind);
    const strip = await shade(page, null);
    const bar = await shade(page, ".pendhead");
    assert.equal(strip.open, false, "the box was not folded to start with");
    assert.equal(bar.boxShadow, "none", "the shut bar is still casting a shade");
    assert.equal(bar.filter, "none", "the shut bar is carrying a filter");
    assert.equal(strip.boxShadow, "none", "the folded strip is still casting a shade");
    assert.equal(strip.filter, "none", "the folded strip is carrying a filter");
    assert.ok(bar.height > 0, `the folded bar is not on screen: ${bar.height}`);
    await page.close();
  });

  test(`${kind}: the box opened by hand carries no shade either`, async () => {
    const page = await openPage(kind);
    await page.click(`#box-${cardId} .pendwrap-answered .pendlist`);
    await page.waitForFunction(id => {
      const strip = els[id].answ;
      return strip.classList.contains("open") &&
        ["motion", "opening", "closing"].every(name => !strip.classList.contains(name));
    }, {}, cardId);
    const strip = await shade(page, null);
    assert.equal(strip.open, true, "the hand did not open the box");
    assert.equal(strip.boxShadow, "none", "the open box is still casting a shade");
    assert.equal(strip.filter, "none", "the open box is carrying a filter");
    await page.close();
  });
}

test("desktop: the small card's own box keeps the shade it has always worn", async () => {
  const page = await openPage("desktop");
  await page.waitForFunction(() => {
    const node = document.querySelector("#magic2 .manswered");
    return node && node.textContent.trim().length > 0;
  });
  await page.click("#magic2 .manswered");
  const small = await page.$eval("#magic2 .manswered", node => ({
    open:node.classList.contains("open"), boxShadow:getComputedStyle(node).boxShadow }));
  assert.equal(small.open, true, "the small card's box did not open under the click");
  assert.equal(small.boxShadow, RAISED, "the small card's box lost its own shade");
  await page.close();
});
