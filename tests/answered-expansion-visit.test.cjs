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
const SHOTS = process.env.ANSWERED_VISIT_SHOTS || "";
let fixtureDir, child, browser, origin;
const ids = ["m1", "m2"];

async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }
async function freePort(){
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-answered-visit-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented expansion fixture", items:[
    {id:ids[0], bucket:"meta", title:"Invented editing card", owner:"facilitator", context:""},
    {id:ids[1], bucket:"meta", title:"Invented offscreen card", owner:"facilitator", context:""},
  ]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir,"logs")},
    stdio:["ignore", "pipe", "pipe"]});
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  browser = await puppeteer.launch({executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"]});
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, {recursive:true, force:true});
});

async function openPage(kind){
  const page = await browser.newPage();
  await page.setViewport(kind === "phone"
    ? {width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2}
    : {width:1440,height:900});
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(origin + (kind === "phone" ? "/m" : "/"), {waitUntil:"domcontentloaded"});
  await page.waitForFunction(id => typeof els !== "undefined" && els[id], {}, ids[0]);
  await page.evaluate(id => select(id), ids[0]);
  return page;
}

async function install(page, replyId, ageMs){
  await page.evaluate((id, replyId, ageMs) => {
    syncAnswered(els[id], {id:replyId, ts:(Date.now() - ageMs) / 1000,
      answered:[{text:"Invented message that this reply answered.", ts:Date.now()/1000 - 70}]});
  }, ids[0], replyId, ageMs);
}
async function isOpen(page){
  return page.evaluate(id => els[id].answ.classList.contains("open"), ids[0]);
}
async function typeAndClear(page){
  await page.type(`#box-${ids[0]} textarea`, "invented draft");
  await page.$eval(`#box-${ids[0]} textarea`, node => {
    node.value = "";
    node.dispatchEvent(new Event("input", {bubbles:true}));
  });
}
async function shot(page, name){
  if (!SHOTS) return;
  await mkdir(SHOTS, {recursive:true});
  await page.screenshot({path:path.join(SHOTS, name + ".png")});
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: editing and clearing suppresses expiry until the card is left`, async () => {
    const page = await openPage(kind);
    await install(page, `${kind}-suppressed`, 59800);
    await typeAndClear(page);
    await pause(350);
    assert.equal(await isOpen(page), false, "the deadline moved the selected card after editing");
    await shot(page, `${kind}-protected-after-deadline`);
    await page.evaluate(id => select(id), ids[1]);
    assert.equal(await isOpen(page), true, "leaving did not apply the elapsed deadline offscreen");
    await page.evaluate(id => select(id), ids[0]);
    assert.equal(await isOpen(page), true, "returning did not show the box already expanded");
    await shot(page, `${kind}-returned-expanded`);
    await page.close();
  });
}

test("desktop: leaving before expiry keeps the original remaining deadline", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-remaining", 59200);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  await pause(100);
  await page.evaluate(id => select(id), ids[1]);
  assert.equal(await isOpen(page), false, "leaving early expanded before the original deadline");
  await pause(850);
  assert.equal(await isOpen(page), true, "the original deadline did not finish offscreen");
  await page.evaluate(id => select(id), ids[0]);
  assert.equal(await isOpen(page), true);
  await page.close();
});

test("desktop: quick return is a new visit and keeps the original deadline", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-quick-return", 59200);
  await page.type(`#box-${ids[0]} textarea`, "first visit");
  await page.evaluate(id => select(id), ids[1]);
  await pause(100);
  await page.evaluate(id => select(id), ids[0]);
  assert.equal(await isOpen(page), false, "a quick return expanded before the deadline");
  await page.type(`#box-${ids[0]} textarea`, " second visit");
  await pause(800);
  assert.equal(await isOpen(page), false, "the original deadline moved the second editing visit");
  await page.evaluate(id => select(id), ids[1]);
  assert.equal(await isOpen(page), true, "leaving after the original deadline did not catch up offscreen");
  await page.close();
});

test("desktop: focus alone does not protect a visit", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-focus-only", 59800);
  await page.focus(`#box-${ids[0]} textarea`);
  await pause(350);
  assert.equal(await isOpen(page), true, "focus was mistaken for editing");
  await page.close();
});

test("desktop: manual expansion remains available during a protected visit", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-manual", 1000);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  await page.click(`#box-${ids[0]} .pendwrap-answered .pendlist`);
  assert.equal(await isOpen(page), true, "editing blocked the manual fold control");
  await page.$eval(`#box-${ids[0]} textarea`, node => node.dispatchEvent(new Event("input", {bubbles:true})));
  assert.equal(await isOpen(page), true, "typing collapsed an already expanded box");
  await page.close();
});

test("desktop: a new reply gets a new timer rather than inheriting visit protection", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-old-reply", 59800);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  await install(page, "desktop-new-reply", 59800);
  await pause(350);
  assert.equal(await isOpen(page), true, "the new reply inherited the old reply's protection");
  await page.close();
});

test("desktop: an already expanded box stays expanded when editing begins", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-already-open", 61000);
  assert.equal(await isOpen(page), true);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  assert.equal(await isOpen(page), true);
  await page.close();
});
