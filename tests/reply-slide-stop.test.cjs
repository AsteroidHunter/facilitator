// Where a new reply's slide stops. The messages just sent are carried up until
// they stand at the top of the reading area, the new reply starts right under
// them, and the slide goes no further: the reading area's own scroll stays at the
// head of the page, so a reply that fits never slides past the bottom.
// A card that is shown again after its reply changed opens the same way, at the
// latest message with the new reply under it, however it was left and however the
// reader comes back to it: a key, a click, a swipe or another project tab.
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
let browser, child, fixtureDir, origin;

const SURFACES = {
  desktop: { path: "/", viewport: { width: 1512, height: 982, deviceScaleFactor: 2 } },
  phone: { path: "/m", viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
};
const SENTENCE = "This is invented text that fills a whole line or two so that the answer is long enough to scroll well past the message above it.";
const paragraphs = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}. ${SENTENCE}`).join("\n\n");

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
async function claim(id, owner = "facilitator"){
  const response = await fetch(origin + `/wait?owner=${owner}&timeout=1&agent=slide-stop`);
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, id);
  await api(`/ack?owner=${owner}&token=${encodeURIComponent(delivery.ack)}`, "");
}

// a card with one earlier exchange and a message sent since that the agent has
// taken: the reply the caller delivers next is the answer to that message
async function seededCard(title){
  const id = (await api("/create?owner=facilitator", title)).id;
  await api(`/send?box=${id}`, "Invented earlier message.");
  await claim(id);
  await api(`/reply?box=${id}`, paragraphs("First reply", 30));
  await api(`/send?box=${id}`, "Invented latest message: please take the next step.");
  await claim(id);
  return id;
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-slide-stop-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js",
      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented slide stop fixture",
    items:[{ id:"1.1", bucket:"now", title:"Invented second lane card", owner:"pastureland" }] }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{ ...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs") },
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++){ try { if ((await fetch(origin + "/state")).ok) break; } catch {} await wait(25); }
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive:true, force:true });
});

async function openCard(surface, id){
  const page = await browser.newPage();
  await page.setViewport(SURFACES[surface].viewport);
  await page.evaluateOnNewDocument(cardId => { localStorage.clear(); localStorage.setItem("facilitator-selected", cardId); }, id);
  await page.goto(origin + SURFACES[surface].path, { waitUntil:"domcontentloaded" });
  await page.waitForFunction(cardId => typeof lastState !== "undefined" && lastState && typeof els !== "undefined" && els[cardId], {}, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  // the sent message is standing at the foot, and the reader is not busy with the card
  await page.waitForFunction(cardId => {
    const el = els[cardId];
    return el.sent && el.sentwrap.getBoundingClientRect().height > 0 && !turnHolding(el, cardId);
  }, { timeout:8000 }, id);
  await wait(300);
  return page;
}

// every animation frame from the moment the reply is delivered: the reading
// area's scroll, where the rising sent panel stands in the sheet, and where the
// card's own panel and reply stand
const RECORD = id => {
  const el = els[id], view = el.replyview || el.reply;
  const frames = [];
  const read = () => {
    const top = view.getBoundingClientRect().top;
    const rising = document.querySelector(".turnsheet .answered.sent");
    frames.push({
      shown: view.getBoundingClientRect().height > 0,
      scroll: view.scrollTop,
      range: view.scrollHeight - view.clientHeight,
      sheet: !!document.querySelector(".turnsheet"),
      rising: rising ? rising.getBoundingClientRect().top - top : null,
      panel: el.answ ? el.answwrap.getBoundingClientRect().top - top : null,
      gap: el.answ ? el.reply.getBoundingClientRect().top - el.answwrap.getBoundingClientRect().bottom : null,
    });
  };
  let live = true;
  const tick = () => { read(); if (live) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__slide = { stop(){ live = false; read(); return frames; } };
};

async function deliver(page, id, reply, opening){
  await page.evaluate(RECORD, id);
  await api(`/reply?box=${id}`, reply);
  // the new reply is on the card, its slide has run, and the sheet is gone
  await page.waitForFunction((cardId, words) => {
    const el = els[cardId];
    return el.reply.textContent.includes(words) && el.answ && !el.turning && !document.querySelector(".turnsheet");
  }, { timeout:8000 }, id, opening);
  await wait(400);
  return page.evaluate(() => window.__slide.stop());
}

for (const surface of ["desktop", "phone"]) {
  test(`${surface}: a long reply slides the sent messages up to the top of the reading area and stops`, async () => {
    const id = await seededCard(`Invented long slide card ${surface}`);
    const page = await openCard(surface, id);
    const frames = await deliver(page, id, paragraphs("Second reply", 30), "Second reply paragraph 1.");
    const sliding = frames.filter(f => f.sheet && f.rising != null);
    assert.ok(sliding.length > 8, `the slide was not seen: ${sliding.length} frames`);
    assert.ok(sliding[0].rising > 200, `the sent messages did not start low in the reading area: ${sliding[0].rising}`);
    for (let i = 1; i < sliding.length; i++)
      assert.ok(sliding[i].rising <= sliding[i - 1].rising + 0.5, `the slide turned back at frame ${i}`);
    const lowest = Math.min(...sliding.map(f => f.rising));
    assert.ok(lowest >= -2, `the slide went past the top of the reading area: ${lowest}`);
    assert.ok(sliding.at(-1).rising <= 6, `the slide stopped short of the top: ${sliding.at(-1).rising}`);
    assert.ok(frames.every(f => f.scroll === 0), "the reading area itself was scrolled");
    const end = frames.at(-1);
    assert.ok(end.range > 500, `the new reply was not long: ${end.range}`);
    assert.ok(Math.abs(end.panel) <= 1, `the latest message did not stand at the top: ${end.panel}`);
    assert.ok(end.gap >= -1 && end.gap <= 40, `the reply did not start right under it: ${end.gap}`);
    await page.close();
  });

  test(`${surface}: a reply that fits stops in the same place and never slides past the bottom`, async () => {
    const id = await seededCard(`Invented short slide card ${surface}`);
    const page = await openCard(surface, id);
    const frames = await deliver(page, id, "A short invented reply.", "A short invented reply.");
    const sliding = frames.filter(f => f.sheet && f.rising != null);
    assert.ok(sliding.length > 8, `the slide was not seen: ${sliding.length} frames`);
    assert.ok(Math.min(...sliding.map(f => f.rising)) >= -2, "the slide went past the top of the reading area");
    assert.ok(sliding.at(-1).rising <= 6, `the slide stopped short of the top: ${sliding.at(-1).rising}`);
    assert.ok(frames.every(f => f.scroll === 0), "the reading area itself was scrolled");
    const end = frames.at(-1);
    assert.ok(end.range <= 1, `the short reply left room to scroll: ${end.range}`);
    assert.ok(Math.abs(end.panel) <= 1, `the latest message did not stand at the top: ${end.panel}`);
    assert.ok(end.gap >= -1 && end.gap <= 40, `the reply did not start right under it: ${end.gap}`);
    await page.close();
  });
}

// ---- a card shown again after its reply changed -----------------------------

async function openPage(surface, id, opts = {}){
  const page = await browser.newPage();
  await page.setViewport(SURFACES[surface].viewport);
  if (opts.reducedMotion) await page.emulateMediaFeatures([{ name:"prefers-reduced-motion", value:"reduce" }]);
  await page.evaluateOnNewDocument(cardId => { localStorage.clear(); localStorage.setItem("facilitator-selected", cardId); }, id);
  await page.goto(origin + SURFACES[surface].path, { waitUntil:"domcontentloaded" });
  await page.waitForFunction(cardId => typeof lastState !== "undefined" && lastState && typeof els !== "undefined" && els[cardId], {}, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(900);
  return page;
}

// a card that shows a long reply to its first message
async function answeredCard(title, owner = "facilitator"){
  const id = (await api(`/create?owner=${owner}`, title)).id;
  await api(`/send?box=${id}`, "Invented earlier message.");
  await claim(id, owner);
  await api(`/reply?box=${id}`, paragraphs("First reply", 30));
  return id;
}

// the agent takes a new message on card id and answers it with a long reply
async function answerAgain(page, id, owner = "facilitator"){
  await api(`/send?box=${id}`, "Invented latest message: please take the next step.");
  await claim(id, owner);
  await api(`/reply?box=${id}`, paragraphs("Second reply", 30));
  await page.waitForFunction(cardId => els[cardId].reply.textContent.includes("Second reply paragraph 1."),
    { timeout:9000 }, id);
  await wait(600);
}

async function leaveAt(page, id, where){
  await page.evaluate((cardId, to) => {
    const view = els[cardId].replyview;
    view.scrollTop = to === "end" ? view.scrollHeight : to;
  }, id, where);
  await wait(300);
}

async function chord(page, modifiers, key){
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

// one step the same way again and again until card id is the one on show
async function walkTo(page, id, step){
  for (let i = 0; i < 40; i++){
    if (await page.evaluate(want => selectedId === want, id)) return;
    await step();
    await wait(650);
  }
  assert.fail(`never came to card ${id}`);
}

async function swipeLeft(page){
  await page.touchscreen.touchStart(320, 420);
  for (let i = 1; i <= 10; i++){ await page.touchscreen.touchMove(320 - 26 * i, 420 + i / 2); await wait(16); }
  await page.touchscreen.touchEnd();
}

// the ways the reader comes to card b from card a
const ARRIVALS = {
  select: (page, a, b) => page.evaluate(id => select(id), b),
  arrows: (page, a, b) => walkTo(page, b, () => page.keyboard.press("ArrowRight")),
  controlShift: (page, a, b) => walkTo(page, b, () => chord(page, ["Control", "Shift"], "ArrowRight")),
  ticketClick: (page, a, b) => page.click(`#tiklist .trow[data-id="${b}"]`),
  swipe: (page, a, b) => walkTo(page, b, () => swipeLeft(page)),
  drawerTap: async (page, a, b) => {
    await page.evaluate(() => openDrawer());
    await wait(600);
    await page.tap(`#tiklist .trow[data-id="${b}"]`);
  },
};

function assertOpensAtHead(frames, what){
  const shown = frames.filter(f => f.shown);
  assert.ok(shown.length > 3, `${what}: the card was never shown`);
  const worst = Math.max(...shown.map(f => f.scroll));
  assert.ok(worst <= 1, `${what}: the reading area was scrolled to ${worst} while the card was on show`);
  const end = shown.at(-1);
  assert.ok(end.range > 500, `${what}: the new reply was not long: ${end.range}`);
  assert.ok(Math.abs(end.panel) <= 1, `${what}: the latest message did not stand at the top: ${end.panel}`);
  assert.ok(end.gap >= -1 && end.gap <= 40, `${what}: the reply did not start right under it: ${end.gap}`);
}

const ARRIVAL_CASES = {
  desktop: [["select", "end"], ["arrows", "end"], ["arrows", 1200], ["controlShift", "end"],
    ["controlShift", 1200], ["ticketClick", "end"]],
  phone: [["select", "end"], ["swipe", "end"], ["swipe", 1200], ["controlShift", "end"],
    ["controlShift", 1200], ["drawerTap", "end"]],
};
for (const surface of ["desktop", "phone"]) {
  for (const [how, left] of ARRIVAL_CASES[surface]) {
    test(`${surface}: a card left ${left === "end" ? "at the end of its reply" : "part way down its reply"} opens at the latest message when its new reply landed while it was away (${how})`, async () => {
      const a = await answeredCard(`Invented away card ${surface} A`);
      const b = await answeredCard(`Invented away card ${surface} B`);
      const page = await openPage(surface, b);
      await leaveAt(page, b, left);
      await page.evaluate(id => select(id), a);
      await wait(400);
      await answerAgain(page, b);
      await page.evaluate(RECORD, b);
      await ARRIVALS[how](page, a, b);
      await wait(2000);
      assertOpensAtHead(await page.evaluate(() => window.__slide.stop()), how);
      await page.close();
    });
  }

  test(`${surface}: a card in another project tab opens at the latest message when its new reply landed while it was away`, async () => {
    const home = await answeredCard(`Invented tab card ${surface}`);
    const other = await answeredCard(`Invented other lane card ${surface}`, "pastureland");
    const page = await openPage(surface, home);
    await page.evaluate(() => setTab("pastureland"));
    await wait(500);
    await page.evaluate(id => select(id), other);
    await wait(500);
    await leaveAt(page, other, "end");
    await page.evaluate(() => setTab("facilitator"));
    await wait(700);
    await answerAgain(page, other, "pastureland");
    await page.evaluate(RECORD, other);
    const tab = '#tabbar .ptab[data-owner="pastureland"]';
    if (surface === "phone") await page.tap(tab); else await page.click(tab);
    await wait(2000);
    assertOpensAtHead(await page.evaluate(() => window.__slide.stop()), "tab");
    await page.close();
  });

  test(`${surface}: with less motion asked for, a reply landing on the card on show opens at the latest message`, async () => {
    const id = await answeredCard(`Invented still card ${surface}`);
    const page = await openPage(surface, id, { reducedMotion:true });
    await leaveAt(page, id, "end");
    await answerAgain(page, id);
    await page.evaluate(RECORD, id);
    await wait(800);
    assertOpensAtHead(await page.evaluate(() => window.__slide.stop()), "reduced motion");
    await page.close();
  });
}
