// No scroller on the board may draw a scrollbar or hold a gutter for one, at any
// width, while every one of them still scrolls. This walks every scrolling
// element on the Mac page, the phone page at two widths and the pages panel,
// proves each one hides its bar (scrollbar-width none and the webkit bar not
// drawn) and reserves no gutter beyond its border (offsetWidth minus clientWidth
// is only the border), and proves the reply, a sent-message lane, the compose
// field with long text and the ticket list still move. The measuring browser
// keeps the bars Chrome would otherwise hide, so the state before the fix shows
// real bars and gutters and this test is red on it. Every card, message and
// answer below is invented.
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
const SHOTS = process.env.SCROLLBAR_SHOTS || "";
const LABEL = process.env.SCROLLBAR_LABEL || "state";
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=1&agent=no-scrollbars");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-no-scrollbars-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "m.html", "page.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json",
      "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
      "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented scrollbar fixture", items:[] }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{ ...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir,"logs") },
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++){ try { if ((await fetch(origin + "/state")).ok) break; } catch {} await wait(25); }
  // one rich card, tall on both sides so the reply and both lanes overflow
  cardId = (await api("/create?owner=facilitator", "Invented scrollbar card")).id;
  for (let i = 1; i <= 10; i++)
    await api(`/send?box=${cardId}`, `Invented earlier message ${i} that the reply below answers and fills the box.`);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:8}, (_, i) =>
    `Invented reply paragraph ${i + 1} keeps the answer tall enough to scroll well past its own edge.`).join("\n\n"));
  for (let i = 1; i <= 10; i++)
    await api(`/send?box=${cardId}`, `Invented follow-up message ${i} is still waiting to be read in the box.`);
  // enough more cards that the ticket list overflows its column at 900px
  for (let i = 1; i <= 24; i++){
    const id = (await api("/create?owner=facilitator", `Invented filler card ${i}`)).id;
    await api(`/send?box=${id}`, `Invented waiting line on filler card ${i}.`);
  }
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    ignoreDefaultArgs:["--hide-scrollbars"],
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox", "--disable-setuid-sandbox"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive:true, force:true });
});

// walk every laid-out scroller and read, off each, the gutter it holds
// (offsetWidth-clientWidth, and the part of that beyond its border), the standard
// scrollbar-width, and whether Chrome would still paint a webkit bar over it
function scan(){
  const out = [];
  for (const el of document.querySelectorAll("*")){
    if (el.clientWidth === 0 || el.clientHeight === 0) continue;
    const cs = getComputedStyle(el);
    const scrolls = ["auto", "scroll"].includes(cs.overflowY) || ["auto", "scroll"].includes(cs.overflowX);
    if (!scrolls) continue;
    const bL = parseFloat(cs.borderLeftWidth) || 0, bR = parseFloat(cs.borderRightWidth) || 0;
    const bT = parseFloat(cs.borderTopWidth) || 0, bB = parseFloat(cs.borderBottomWidth) || 0;
    let webkit = "";
    try { webkit = getComputedStyle(el, "::-webkit-scrollbar").display; } catch {}
    let inner = null;
    for (const kid of el.children){
      const r = kid.getBoundingClientRect();
      if (r.width > 1 && r.height > 1){ inner = r; break; }
    }
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".") : "";
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (cls ? "." + cls : ""),
      overflowX: cs.overflowX, overflowY: cs.overflowY,
      scrollbarWidth: cs.scrollbarWidth, webkitDisplay: webkit,
      gutterX: el.offsetWidth - el.clientWidth,
      gutterY: el.offsetHeight - el.clientHeight,
      barX: (el.offsetWidth - el.clientWidth) - bL - bR,
      barY: (el.offsetHeight - el.clientHeight) - bT - bB,
      innerLeft: inner ? Math.round(inner.left * 100) / 100 : null,
      innerRight: inner ? Math.round(inner.right * 100) / 100 : null,
      overflows: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
    });
  }
  return out;
}

async function openPage(cfg){
  const page = await browser.newPage();
  await page.setViewport(cfg.mobile
    ? { width:cfg.w, height:cfg.h, isMobile:true, hasTouch:true, deviceScaleFactor:2 }
    : { width:cfg.w, height:cfg.h });
  await page.evaluateOnNewDocument(id => { localStorage.clear(); localStorage.setItem("facilitator-selected", id); }, cardId);
  await page.goto(origin + cfg.route, { waitUntil:"domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout:8000 });
  if (cfg.route === "/page"){
    // the panel opens straight into its document view; drop that class to lay out
    // the board stage beneath so the list and tab scrollers are walked too. the
    // document view's own scrollers get their own test below
    await page.evaluate(() => document.body.classList.remove("docview"));
    await wait(250);
  } else {
    await page.waitForFunction(id => typeof els !== "undefined" && els[id], { timeout:8000 }, cardId);
    await page.evaluate(id => select(id), cardId);
    await page.waitForFunction(id => {
      const el = els[id];
      return el?.answ && el?.pend && !el.answ.classList.contains("rising") && !el.pend.classList.contains("rising");
    }, {}, cardId);
    // open both sent boxes so their lanes are live, not folded to nothing
    for (const which of ["answ", "pend"]){
      const lane = `#box-${cardId} ${which === "answ" ? ".pendwrap-answered" : ".pendwrap"} .pendlist`;
      const open = await page.evaluate((id, w) => {
        const p = w === "answ" ? els[id].answ : els[id].pend;
        return !!(p && p.classList.contains("open"));
      }, cardId, which);
      if (!open){ try { await page.click(lane); } catch {} await wait(650); }
    }
  }
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(350);
  return page;
}

async function stillScrolls(page, selector, opts = {}){
  return page.evaluate((sel, opts) => {
    const el = document.querySelector(sel);
    if (!el) return { found:false };
    if (opts.longText){
      el.value = Array.from({ length:40 }, (_, i) => `Invented composed line ${i + 1} typed into the field.`).join("\n");
      el.dispatchEvent(new Event("input", { bubbles:true }));
    }
    const overflows = el.scrollHeight > el.clientHeight + 1;
    el.scrollTop = 0;
    el.scrollTop = 90;
    const moved = el.scrollTop;
    el.scrollTop = 0;
    return { found:true, overflows, moved };
  }, selector, opts);
}

const PAGES = [
  { name:"mac", route:"/", w:1440, h:900 },
  { name:"phone-375", route:"/m", w:375, h:812, mobile:true },
  { name:"phone-402", route:"/m", w:402, h:874, mobile:true },
  { name:"pages", route:"/page", w:1440, h:900 },
];

for (const cfg of PAGES){
  test(`${cfg.name}: every scroller hides its bar and holds no gutter`, async () => {
    const page = await openPage(cfg);
    const found = await page.evaluate(scan);
    console.log(`\n[no-scrollbars ${LABEL}] ${cfg.name} ${cfg.w}x${cfg.h}: ${found.length} scrollers`);
    for (const s of found)
      console.log(`  ${s.sel} | oy=${s.overflowY} ox=${s.overflowX} sw=${s.scrollbarWidth} wk=${s.webkitDisplay} ` +
        `gutterX=${s.gutterX} gutterY=${s.gutterY} barX=${s.barX} barY=${s.barY} ` +
        `x=[${s.innerLeft},${s.innerRight}] overflows=${s.overflows}`);
    assert.ok(found.length > 0, `no scrollers were found on ${cfg.name}`);
    for (const s of found){
      // this Chrome honours scrollbar-width:none (the panel's own #docscroll shows
      // it), so a hidden bar reads as none here and an unhidden one as auto; the
      // gutter beyond the border must also be nothing, on both axes
      assert.equal(s.scrollbarWidth, "none", `${cfg.name} ${s.sel}: scrollbar-width is ${s.scrollbarWidth}, not none`);
      assert.ok(Math.abs(s.barX) <= 0.5, `${cfg.name} ${s.sel}: holds a ${s.barX}px vertical-bar gutter`);
      assert.ok(Math.abs(s.barY) <= 0.5, `${cfg.name} ${s.sel}: holds a ${s.barY}px horizontal-bar gutter`);
    }
    await page.close();
  });
}

test("pages: the document view scrollers hide their bars and hold no gutter", async () => {
  const page = await browser.newPage();
  await page.setViewport({ width:1440, height:900 });
  await page.evaluateOnNewDocument(id => { localStorage.clear(); localStorage.setItem("facilitator-selected", id); }, cardId);
  await page.goto(origin + "/page", { waitUntil:"domcontentloaded" });
  await page.waitForFunction(id => typeof docEls !== "undefined" && docEls[id], { timeout:8000 }, cardId);
  await page.evaluate(id => docSelect(id), cardId);
  await page.waitForFunction(() => document.body.classList.contains("docview"), { timeout:8000 });
  await wait(350);
  const found = await page.evaluate(scan);
  console.log(`\n[no-scrollbars ${LABEL}] pages document view: ${found.length} scrollers`);
  for (const s of found)
    console.log(`  ${s.sel} | sw=${s.scrollbarWidth} wk=${s.webkitDisplay} barX=${s.barX} barY=${s.barY} overflows=${s.overflows}`);
  assert.ok(found.length > 0, "no scrollers were found in the pages document view");
  for (const s of found){
    assert.equal(s.scrollbarWidth, "none", `pages doc ${s.sel}: scrollbar-width is ${s.scrollbarWidth}, not none`);
    assert.ok(Math.abs(s.barX) <= 0.5, `pages doc ${s.sel}: holds a ${s.barX}px vertical-bar gutter`);
    assert.ok(Math.abs(s.barY) <= 0.5, `pages doc ${s.sel}: holds a ${s.barY}px horizontal-bar gutter`);
  }
  await page.close();
});

test("the reply, a sent lane, the compose field and the ticket list all still scroll", async () => {
  const page = await openPage(PAGES[0]);
  const reply = await stillScrolls(page, `#box-${cardId} .replyview`);
  assert.ok(reply.found && reply.overflows && reply.moved > 40,
    `the reply scroller did not move: ${JSON.stringify(reply)}`);
  const lane = await stillScrolls(page, `#box-${cardId} .pendwrap .pendlist .pendscroll`);
  assert.ok(lane.found && lane.overflows && lane.moved > 40,
    `a sent-message lane did not move: ${JSON.stringify(lane)}`);
  const compose = await stillScrolls(page, `#box-${cardId} textarea`, { longText:true });
  assert.ok(compose.found && compose.overflows && compose.moved > 40,
    `the compose field did not move with long text: ${JSON.stringify(compose)}`);
  const list = await stillScrolls(page, "#tiklist");
  assert.ok(list.found && list.overflows && list.moved > 40,
    `the ticket list did not move: ${JSON.stringify(list)}`);
  await page.close();
});

// flag every scroller as scrolling so a board that still styles a bar paints its
// thumb for the capture, which is how a scrollbar looks at rest for the reader;
// where the bar is hidden this class carries no rule and changes nothing
function revealBars(page){
  return page.evaluate(() => {
    for (const el of document.querySelectorAll("*")){
      const cs = getComputedStyle(el);
      if (["auto", "scroll"].includes(cs.overflowY) || ["auto", "scroll"].includes(cs.overflowX))
        el.classList.add("scrolling");
    }
  });
}

test("screenshots, when a directory is given", async t => {
  if (!SHOTS){ t.skip("SCROLLBAR_SHOTS not set"); return; }
  await mkdir(SHOTS, { recursive:true });
  const mac = await openPage(PAGES[0]);
  await mac.evaluate(() => {
    const ta = document.querySelector("article.box.sel textarea");
    if (ta){ ta.value = Array.from({ length:6 }, (_, i) => `Invented composed line ${i + 1} being typed.`).join("\n");
      ta.dispatchEvent(new Event("input", { bubbles:true })); }
  });
  await revealBars(mac);
  await wait(300);
  await mac.screenshot({ path:path.join(SHOTS, `mac-${LABEL}.png`) });
  await mac.close();
  const phone = await openPage(PAGES[1]);
  await revealBars(phone);
  await wait(300);
  await phone.screenshot({ path:path.join(SHOTS, `phone-${LABEL}.png`) });
  await phone.close();
});
