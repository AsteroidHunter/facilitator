const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

// The box above the answer no longer opens on its own: ANSWERED_AUTO_EXPAND in
// card-logic.js is false, so every scenario the minute's own logic used to open
// the box in is kept here and now proves the box stays folded. The last test
// serves the same file with that one constant flipped and proves the logic
// underneath is whole, which is what keeps these scenarios worth their room.
const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const SHOTS = process.env.ANSWERED_VISIT_SHOTS || "";
const SWITCH_OFF = "const ANSWERED_AUTO_EXPAND = false;";
const SWITCH_ON = "const ANSWERED_AUTO_EXPAND = true;";
let fixtureDir, child, browser, origin, flippedLogic;
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
  const logic = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  assert.equal(logic.split(SWITCH_OFF).length - 1, 1, "the switch is not written once in card-logic.js");
  flippedLogic = logic.replace(SWITCH_OFF, SWITCH_ON);
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

// flip serves the page the same card logic with the one switch turned on, so
// the behaviour kept under it can be driven without the app carrying a seat for
// a test to reach into
async function openPage(kind, flip){
  const page = await browser.newPage();
  await page.setViewport(kind === "phone"
    ? {width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2}
    : {width:1440,height:900});
  await page.evaluateOnNewDocument(() => localStorage.clear());
  if (flip) {
    // the phone's worker keeps its own copy of the shell, so this page is sent
    // past it to the server, where the rewrite below is waiting
    await page.setBypassServiceWorker(true);
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.pathname === "/card-logic.js")
        request.respond({status:200, contentType:"application/javascript", body:flippedLogic}).catch(() => {});
      // these cards carry no reply of their own, so a reading of the board takes
      // away a box installed by hand. this scenario runs longer than the poll's
      // own gap, so once the board is drawn the readings are refused
      else if (page._frozen && (url.pathname === "/state" || url.pathname === "/m/state"))
        request.abort().catch(() => {});
      else request.continue().catch(() => {});
    });
  }
  await page.goto(origin + (kind === "phone" ? "/m" : "/"), {waitUntil:"domcontentloaded"});
  await page.waitForFunction(id => typeof els !== "undefined" && els[id], {}, ids[0]);
  await page.evaluate(id => select(id), ids[0]);
  page._frozen = true;
  return page;
}

async function install(page, replyId, ageMs){
  await page.evaluate((id, replyId, ageMs) => {
    syncAnswered(els[id], {id:replyId, ts:(Date.now() - ageMs) / 1000,
      answered:[{text:"Invented message that this reply answered.", ts:Date.now()/1000 - 70}]});
  }, ids[0], replyId, ageMs);
}
async function isOpen(page){
  return page.evaluate(id => {
    const el = els[id];
    if (!el.answ) throw new Error("the card is carrying no answered box");
    return el.answ.classList.contains("open");
  }, ids[0]);
}
// a fold that is still running ends by setting the class itself, so one scenario
// waits for the box to stand still before the next installs another reply in it
async function settle(page){
  await page.waitForFunction(id => {
    const strip = els[id].answ;
    return strip && ["motion", "opening", "closing", "rising"].every(name => !strip.classList.contains(name));
  }, {}, ids[0]);
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
  test(`${kind}: editing, and then leaving and returning, all keep the box folded`, async () => {
    const page = await openPage(kind);
    await install(page, `${kind}-suppressed`, 59800);
    await typeAndClear(page);
    await pause(350);
    assert.equal(await isOpen(page), false, "the deadline moved the selected card after editing");
    await shot(page, `${kind}-protected-after-deadline`);
    await page.evaluate(id => select(id), ids[1]);
    assert.equal(await isOpen(page), false, "leaving applied the elapsed deadline offscreen");
    await page.evaluate(id => select(id), ids[0]);
    assert.equal(await isOpen(page), false, "returning showed the box expanded");
    await shot(page, `${kind}-returned-folded`);
    await page.close();
  });

  test(`${kind}: a reply already past its minute is still mounted folded`, async () => {
    const page = await openPage(kind);
    await install(page, `${kind}-past-minute`, 61000);
    assert.equal(await isOpen(page), false, "visiting a card past the deadline expanded the box");
    const strip = await page.evaluate(id => {
      const head = els[id].answ.querySelector(".pendhead");
      return {shown:head.getBoundingClientRect().height > 0,
              visibility:getComputedStyle(els[id].answ).visibility};
    }, ids[0]);
    assert.equal(strip.shown, true, "the folded strip lost its bar");
    assert.equal(strip.visibility, "visible", "the folded strip was hidden outright");
    await page.close();
  });

  test(`${kind}: a stored open word does not reopen the box on a later visit`, async () => {
    const page = await openPage(kind);
    await page.evaluate(() => localStorage.setItem("answbox.stored-open", "open"));
    await install(page, "stored-open", 2000);
    assert.equal(await isOpen(page), false, "a stored word opened the box without a hand");
    await page.close();
  });
}

test("desktop: the deadline passing offscreen leaves the box folded", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-remaining", 59200);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  await pause(100);
  await page.evaluate(id => select(id), ids[1]);
  assert.equal(await isOpen(page), false, "leaving early expanded before the original deadline");
  await pause(850);
  assert.equal(await isOpen(page), false, "the original deadline expanded the box offscreen");
  await page.evaluate(id => select(id), ids[0]);
  assert.equal(await isOpen(page), false, "returning showed the box expanded");
  await page.close();
});

test("desktop: a quick return and a second visit both leave the box folded", async () => {
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
  assert.equal(await isOpen(page), false, "leaving after the original deadline expanded the box");
  await page.close();
});

test("desktop: focus alone leaves the box folded too", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-focus-only", 59800);
  await page.focus(`#box-${ids[0]} textarea`);
  await pause(350);
  assert.equal(await isOpen(page), false, "an unprotected visit expanded the box");
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

test("desktop: a new reply is mounted folded like the reply before it", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-old-reply", 59800);
  await page.type(`#box-${ids[0]} textarea`, "draft");
  await install(page, "desktop-new-reply", 59800);
  await pause(350);
  assert.equal(await isOpen(page), false, "a new reply expanded on its own deadline");
  await page.close();
});

test("desktop: a box opened by hand stays expanded when editing begins", async () => {
  const page = await openPage("desktop");
  await install(page, "desktop-already-open", 61000);
  assert.equal(await isOpen(page), false, "a reply past its minute expanded on its own");
  await page.click(`#box-${ids[0]} .pendwrap-answered .pendlist`);
  assert.equal(await isOpen(page), true, "the hand did not open the box");
  await page.type(`#box-${ids[0]} textarea`, "draft");
  assert.equal(await isOpen(page), true, "typing collapsed a box opened by hand");
  await page.close();
});

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the switch turned on opens the box on every path it used to`, async () => {
    const page = await openPage(kind, true);
    assert.equal(await page.evaluate(() => ANSWERED_AUTO_EXPAND), true, "the flipped logic was not served");

    await install(page, `${kind}-flip-past-minute`, 61000);
    assert.equal(await isOpen(page), true, "a reply past its minute was not mounted open");

    await install(page, `${kind}-flip-deadline`, 59300);
    assert.equal(await isOpen(page), false, "a reply inside its minute was mounted open");
    await pause(1000);
    assert.equal(await isOpen(page), true, "the minute running out on screen did not open the box");
    await settle(page);

    await page.evaluate(() => localStorage.setItem("answbox.flip-stored-open", "open"));
    await install(page, "flip-stored-open", 2000);
    assert.equal(await isOpen(page), true, "a stored open word did not reopen the box");
    await settle(page);

    await install(page, `${kind}-flip-protected`, 59800);
    await typeAndClear(page);
    await pause(350);
    assert.equal(await isOpen(page), false, "editing did not hold the deadline off");
    await page.evaluate(id => select(id), ids[1]);
    assert.equal(await isOpen(page), true, "leaving did not apply the elapsed deadline offscreen");
    await page.evaluate(id => select(id), ids[0]);
    assert.equal(await isOpen(page), true, "returning did not show the box already expanded");
    await page.close();
  });
}
