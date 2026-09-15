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
const SHOTS = process.env.DESKTOP_SPACING_SHOTS || "";
const FONT_ASSETS = process.env.DESKTOP_SPACING_FONT_ASSETS || "";
const MEASURES = [];
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=1&agent=spacing-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function wait(ms = 180){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-desktop-spacing-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"), source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "page.html", "m.html", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  if (FONT_ASSETS) {
    const fontFiles = await readdir(FONT_ASSETS);
    for (const name of fontFiles.filter(name => name.endsWith(".woff2")))
      await copyFile(path.join(FONT_ASSETS, name), path.join(fixtureDir, "assets", name));
    const css = (await Promise.all(["stylesheet-1.css", "stylesheet-2.css"].map(name =>
      readFile(path.join(FONT_ASSETS, name), "utf8")))).join("\n").replaceAll("/probe-fonts/", "/assets/");
    const indexPath = path.join(fixtureDir, "index.html");
    let html = await readFile(indexPath, "utf8");
    html = html.replace(/<link rel="preconnect"[^>]+>\s*/g, "")
      .replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2\?[^>]+>\s*/g, "")
      .replace("</head>", `<style data-local-fonts>\n${css}\n</style>\n</head>`);
    await writeFile(indexPath, html);
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented spacing fixture", items:[] }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd:fixtureDir,
    env:{ ...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:logs },
    stdio:["ignore", "pipe", "pipe"],
  });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await wait(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented response spacing card")).id;
  await api(`/send?box=${cardId}`, "Please compare the two message boxes around the response.");
  await claim();
  const answer = Array.from({length:8}, (_, i) =>
    `Invented paragraph ${i + 1} exercises the responsive reply line grid.`).join("\n\n");
  await api(`/reply?box=${cardId}`, answer);
  await api(`/send?box=${cardId}`, "This invented follow-up is waiting to be read.");
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"] });
});

after(async () => {
  if (SHOTS) await writeFile(path.join(SHOTS, "measurements.json"), JSON.stringify(MEASURES, null, 2));
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive:true, force:true });
});

async function open(width, height){
  const page = await browser.newPage();
  page._spacingFontResponses = [];
  page.on("response", response => {
    if (response.url().includes("/assets/") && response.url().endsWith(".woff2"))
      page._spacingFontResponses.push({url:response.url(), status:response.status()});
  });
  if (FONT_ASSETS) {
    await page.setRequestInterception(true);
    page.on("request", async request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/assets/") && url.pathname.endsWith(".woff2")) {
        const name = path.basename(url.pathname);
        try {
          await request.respond({status:200, contentType:"font/woff2",
            body:await readFile(path.join(FONT_ASSETS, name))});
        } catch { await request.abort(); }
      } else await request.continue();
    });
  }
  await page.setViewport({ width, height });
  await page.evaluateOnNewDocument(id => {
    localStorage.clear();
    localStorage.setItem("facilitator-selected", id);
  }, cardId);
  await page.goto(origin + "/", { waitUntil:"domcontentloaded" });
  await page.waitForFunction(id => typeof lastState !== "undefined" && lastState && typeof els !== "undefined" && els[id], {}, cardId);
  await page.evaluate(id => select(id), cardId);
  await page.waitForFunction(id => {
    const el = els[id];
    return el?.answ && el?.pend && !el.answ.classList.contains("rising") && !el.pend.classList.contains("rising");
  }, {}, cardId);
  await page.evaluate(() => document.fonts.ready);
  await wait(350);
  return page;
}

async function geometry(page, label){
  const result = await page.evaluate((id, label) => {
    const el = els[id];
    const first = [...el.reply.children].find(node => node.getBoundingClientRect().height > 2);
    const range = document.createRange();
    range.selectNodeContents(first);
    const firstInk = [...range.getClientRects()].find(rect => rect.height > 2);
    const answerBottom = el.answwrap.getBoundingClientRect().bottom;
    const visibleAnswerBottom = el.answ.getBoundingClientRect().bottom;
    const pendingTop = el.pend.getBoundingClientRect().top;
    const cs = getComputedStyle(el.reply);
    const topGap = firstInk.top - answerBottom;
    const bottomGap = parseFloat(cs.marginBottom);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = cs.font;
    const metrics = context.measureText(first.textContent || "Invented response");
    const baseline = firstInk.top + metrics.fontBoundingBoxAscent;
    const visibleFirstInkTop = baseline - metrics.actualBoundingBoxAscent;
    const textRects = [];
    const walker = document.createTreeWalker(el.reply, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const one = document.createRange();
      one.selectNodeContents(node);
      textRects.push(...one.getClientRects());
    }
    const replyRect = el.reply.getBoundingClientRect();
    const actualBottom = rect => rect.top + metrics.fontBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    const lastLine = textRects.filter(rect => rect.height > 2 &&
      rect.bottom > replyRect.top && rect.top < replyRect.bottom && actualBottom(rect) <= pendingTop)
      .sort((a,b) => actualBottom(b) - actualBottom(a))[0];
    const lastBaseline = lastLine ? lastLine.top + metrics.fontBoundingBoxAscent : 0;
    const visibleLastInkBottom = lastBaseline + metrics.actualBoundingBoxDescent;
    const visibleInkGaps = {
      top:visibleFirstInkTop - visibleAnswerBottom,
      bottom:pendingTop - visibleLastInkBottom,
      visibleAnswerBottom, firstLine:{top:firstInk.top,bottom:firstInk.bottom},
      lastLine:lastLine && {top:lastLine.top,bottom:lastLine.bottom},
      metrics:{actualAscent:metrics.actualBoundingBoxAscent,
        actualDescent:metrics.actualBoundingBoxDescent,
        fontAscent:metrics.fontBoundingBoxAscent,
        fontDescent:metrics.fontBoundingBoxDescent}
    };
    const fontProof = { status:document.fonts.status,
      plexSans:document.fonts.check('18px "IBM Plex Sans"'),
      plexMono:document.fonts.check('14px "IBM Plex Mono"'),
      inter:document.fonts.check('30px Inter'),
      replyFamily:cs.fontFamily };
    return { label, viewport:[innerWidth, innerHeight], topGap, bottomGap,
      difference:Math.abs(topGap - bottomGap), lineHeight:parseFloat(cs.lineHeight),
      marginTop:parseFloat(cs.marginTop), marginBottom:parseFloat(cs.marginBottom),
      answerBottom, pendingTop, fontProof, visibleInkGaps };
  }, cardId, label);
  result.fontResponses = page._spacingFontResponses;
  if (FONT_ASSETS) {
    assert.equal(result.fontProof.status, "loaded", JSON.stringify(result.fontProof));
    assert.equal(result.fontProof.plexSans, true, JSON.stringify(result.fontProof));
    assert.equal(result.fontProof.plexMono, true, JSON.stringify(result.fontProof));
    assert.equal(result.fontProof.inter, true, JSON.stringify(result.fontProof));
    assert.ok(result.fontResponses.length >= 3, JSON.stringify(result.fontResponses));
    assert.ok(result.fontResponses.every(item => item.status === 200), JSON.stringify(result.fontResponses));
  }
  MEASURES.push(result);
  return result;
}

async function showFormerSpacing(page){
  await page.evaluate(id => {
    // the snap now spends its upper share on the prose block's top margin and its
    // lower share on the scroller's own bottom margin. put the whole remainder
    // back above the answer to recover the former, unbalanced spacing.
    const el = els[id];
    const view = el.replyview || el.reply;
    const base = parseFloat(getComputedStyle(view).getPropertyValue("--replyair"));
    const upper = parseFloat(getComputedStyle(el.reply).marginTop) || 0;
    const lower = (parseFloat(getComputedStyle(view).marginBottom) || 0) - base;
    el.reply.style.marginTop = (upper + Math.max(0, lower)).toFixed(2) + "px";
    view.style.marginBottom = base.toFixed(2) + "px";
  }, cardId);
}

for (const [label, width, height] of [["desktop-1440",1440,900], ["desktop-1728",1728,1117], ["desktop-1200",1200,800]]) {
  test(`${label}: upper and lower response gaps share the line-grid remainder`, async () => {
    const page = await open(width, height);
    const measured = await geometry(page, label);
    assert.ok(Math.abs(measured.visibleInkGaps.top - measured.visibleInkGaps.bottom) <= 1.1,
      JSON.stringify(measured.visibleInkGaps));
    assert.ok(measured.visibleInkGaps.top < measured.lineHeight, JSON.stringify(measured.visibleInkGaps));
    if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${label}-after.png`)}); }
    await showFormerSpacing(page);
    const before = await geometry(page, label + "-before");
    assert.ok(before.topGap >= measured.topGap, JSON.stringify({before, measured}));
    if (SHOTS) await page.screenshot({path:path.join(SHOTS, `${label}-before.png`)});
    await page.close();
  });
}

test("short invented response keeps the same balanced boundary spacing", async () => {
  const page = await open(1440, 900);
  await page.evaluate(id => {
    const reply = els[id].reply;
    reply.dataset.raw = "A short invented response.";
    reply.innerHTML = fmt(reply.dataset.raw);
    snapCard();
  }, cardId);
  await wait(100);
  const measured = await geometry(page, "desktop-1440-short");
  assert.ok(Number.isFinite(measured.visibleInkGaps.top), JSON.stringify(measured.visibleInkGaps));
  assert.ok(measured.visibleInkGaps.top < measured.lineHeight, JSON.stringify(measured.visibleInkGaps));
  if (SHOTS) await page.screenshot({path:path.join(SHOTS, "desktop-1440-short-after.png")});
  await page.close();
});

test("phone card keeps its own spacing rules", async () => {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  await page.goto(origin + "/m", {waitUntil:"domcontentloaded"});
  await page.waitForFunction(() => document.querySelector(".box.sel .reply"));
  const inline = await page.$eval(".box.sel .reply", node => ({top:node.style.marginTop,bottom:node.style.marginBottom}));
  assert.deepEqual(inline, {top:"",bottom:""});
  await page.close();
});
