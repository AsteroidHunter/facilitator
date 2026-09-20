// The raised answered box sits at the very top of the reply's scrolling content:
// scrolling the reply down carries it up and out of view exactly as the first
// paragraphs go, whether the box is collapsed or open, and scrolling back brings
// it home. Every card, message and answer below is invented.
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=1&agent=scroll-with-reply");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-scroll-with-reply-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented scroll-with-reply fixture", items:[] }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{ ...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir,"logs") },
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++){ try { if ((await fetch(origin + "/state")).ok) break; } catch {} await wait(25); }
  cardId = (await api("/create?owner=facilitator", "Invented scroll-with-reply card")).id;
  for (let i = 1; i <= 3; i++)
    await api(`/send?box=${cardId}`, `Invented earlier message ${i} that the reply below answers.`);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:20}, (_, i) =>
    `Invented reply paragraph ${i + 1} makes the answer tall enough to scroll well past its own top edge.`).join("\n\n"));
  await api(`/send?box=${cardId}`, "Invented follow-up message still waiting to be read.");
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
  await wait(400);
  return page;
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the answered box scrolls up with the reply, open or shut`, async () => {
    const page = await openCard(kind);
    // the answer's own scroll container, found from a prose line so the test does
    // not care which element on the page happens to own the scroll
    const scrollable = await page.evaluate(id => {
      const p = els[id].reply.querySelector("p") || els[id].reply.children[0];
      let node = p;
      while (node && node !== document.body){
        const oy = getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll") return node.scrollHeight - node.clientHeight;
        node = node.parentElement;
      }
      return 0;
    }, cardId);
    assert.ok(scrollable > 200, `the answer is not scrollable enough to test: ${scrollable}`);

    for (const wantOpen of [false, true]) {
      await page.evaluate((id, want) => {
        const el = els[id];
        if (el.answ.classList.contains("open") !== want) foldAnswered(el, want);
      }, cardId, wantOpen);
      await wait(650);
      const moved = await page.evaluate(id => {
        const el = els[id];
        const p = el.reply.querySelector("p") || el.reply.children[0];
        let sc = p;
        while (sc && sc !== document.body){
          const oy = getComputedStyle(sc).overflowY;
          if (oy === "auto" || oy === "scroll") break;
          sc = sc.parentElement;
        }
        sc.scrollTop = 0;
        const boxTop0 = el.answ.getBoundingClientRect().top;
        sc.scrollTop = 220;
        const applied = sc.scrollTop;
        const boxTop1 = el.answ.getBoundingClientRect().top;
        sc.scrollTop = 0;
        const boxTop2 = el.answ.getBoundingClientRect().top;
        return { applied, down: Math.round((boxTop0 - boxTop1) * 100) / 100,
          back: Math.round((boxTop2 - boxTop0) * 100) / 100 };
      }, cardId);
      assert.ok(moved.applied > 150, `the answer did not accept the scroll: ${moved.applied}`);
      assert.ok(moved.down > moved.applied - 20,
        `box stayed put while the reply scrolled (open=${wantOpen}): moved ${moved.down} of ${moved.applied}`);
      assert.ok(Math.abs(moved.back) <= 1.5,
        `box did not return when the reply scrolled back (open=${wantOpen}): ${moved.back}`);
    }

    // folding the box while the reader is scrolled past it must not jump the text
    await page.evaluate(id => { const el = els[id]; if (!el.answ.classList.contains("open")) foldAnswered(el, true); }, cardId);
    await wait(650);
    const anchor = await page.evaluate(id => {
      const el = els[id];
      let sc = el.reply.querySelector("p");
      while (sc && sc !== document.body){ const oy = getComputedStyle(sc).overflowY; if (oy === "auto" || oy === "scroll") break; sc = sc.parentElement; }
      sc.scrollTop = Math.round(el.answ.getBoundingClientRect().height) + 130;   // scroll clear of the open box
      const scRect = sc.getBoundingClientRect();
      const ps = [...el.reply.querySelectorAll("p")];
      const idx = ps.findIndex(p => { const r = p.getBoundingClientRect(); return r.top > scRect.top + 30 && r.bottom < scRect.bottom - 30; });
      return { idx, before: idx >= 0 ? ps[idx].getBoundingClientRect().top : 0 };
    }, cardId);
    assert.ok(anchor.idx >= 0, "no reply line was in view to anchor to");
    await page.evaluate(id => { foldAnswered(els[id], false); }, cardId);   // shut while scrolled
    await wait(700);
    const jump = await page.evaluate((id, idx) => {
      const p = [...els[id].reply.querySelectorAll("p")][idx];
      return p.getBoundingClientRect().top;
    }, cardId, anchor.idx);
    assert.ok(Math.abs(jump - anchor.before) <= 4,
      `visible text jumped by ${Math.round((jump - anchor.before) * 100) / 100}px when the box folded shut`);
    await page.close();
  });
}
