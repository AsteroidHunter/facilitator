// Both boxes on the card read left to right. A message block is still only as
// wide as its own words and still stands against the right edge, but the words
// inside it start at the block's left edge instead of ending at its right one,
// so a list marker sits beside its text rather than out at the edge of the box
// with white space between them. The measures are printed before they are
// asserted, so one run records the numbers whether it passes or fails. Every
// card, message and answer here is invented.
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
const SHOTS = process.env.PEND_ALIGN_SHOTS || "";
// the three shapes each box is measured in: a list whose marker used to stand
// out at the far left, a short line, and a line long enough to wrap
const LIST = "1. Invented short option.";
const SHORT = "Invented short line.";
const WRAPPED = "Invented message long enough to need more than one line inside the box, " +
  "so its second line can be measured against its first.";
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=2&agent=align-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pend-align-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented alignment fixture", items:[]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs")},
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented card for both message boxes")).id;
  // the three the reply answers: they end up in the box above the answer
  for (const text of [LIST, SHORT, WRAPPED]) await api(`/send?box=${cardId}`, text);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:3}, (_, i) =>
    `Invented answer paragraph ${i + 1}, written to give the card some prose.`).join("\n\n"));
  // and the same three again, waiting: they end up in the box under the answer
  for (const text of [LIST, SHORT, WRAPPED]) await api(`/send?box=${cardId}`, text);
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
// both strips opened by hand, and left alone until each run has stopped
async function openBoxes(page){
  for (const seat of [".pendwrap-answered", ".pendwrap"]) {
    await page.click(`#box-${cardId} ${seat} .pendlist`);
    await page.waitForFunction((id, seat) => {
      const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
      return strip.classList.contains("open") &&
        ["motion", "opening", "closing"].every(name => !strip.classList.contains(name));
    }, {}, cardId, seat);
  }
  await pause(120);
}
// one box's rows: the block each message is drawn in, every line of ink in it,
// and the list it holds when it holds one
async function rowsOf(page, seat){
  return page.evaluate((id, seat) => {
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    const lane = strip.querySelector(".pendslide").getBoundingClientRect();
    const round = n => Math.round(n * 100) / 100;
    return {
      lane:{left:round(lane.left), right:round(lane.right)},
      rows:[...strip.querySelectorAll(".pendmsg")].map(row => {
        const content = row.querySelector(".pendcontent");
        const block = content.getBoundingClientRect();
        const list = content.querySelector("ol, ul");
        // one entry per line of ink: the rects on a line are gathered by their
        // own top and the line's beginning is the leftmost of them, so a space
        // left hanging at the end of a wrapped line cannot be read as a start
        const seen = new Map();
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()){
          if (!node.textContent.trim()) continue;
          if (node.parentElement.closest(".ptime")) continue;   // the drag's own time, pinned right
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()){
            if (rect.width <= 0.5) continue;
            const key = Math.round(rect.top);
            const line = seen.get(key);
            if (!line) seen.set(key, {left:rect.left, right:rect.right, top:rect.top});
            else { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); }
          }
        }
        const lines = [...seen.values()].sort((a, b) => a.top - b.top)
          .map(line => ({left:round(line.left), right:round(line.right), top:round(line.top)}));
        return { text:(row.dataset.text || "").slice(0, 28),
                 textAlign:getComputedStyle(content).textAlign,
                 block:{left:round(block.left), right:round(block.right), width:round(block.width)},
                 list:list ? {left:round(list.getBoundingClientRect().left)} : null,
                 lines };
      }),
    };
  }, cardId, seat);
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: both boxes read left to right with no white space before the words`, async () => {
    const page = await openPage(kind);
    await openBoxes(page);
    const boxes = { top:await rowsOf(page, ".pendwrap-answered"), bottom:await rowsOf(page, ".pendwrap") };
    console.log(`  ${kind} :: ${JSON.stringify(boxes)}`);
    if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${kind}-both-boxes.png`)}); }

    for (const [name, box] of Object.entries(boxes)) {
      assert.equal(box.rows.length, 3, `the ${name} box is not holding the three invented messages`);
      const [list, short, wrapped] = box.rows;
      for (const row of box.rows) {
        assert.equal(row.textAlign, "left", `the ${name} box still ends its words at the right edge`);
        // the block still stands against the box's right edge, as it always has
        assert.ok(Math.abs(row.block.right - box.lane.right) <= 1,
          `the ${name} box moved a message off the right edge: ${JSON.stringify(row)}`);
        // and every line in it begins at that block's own left edge, or one
        // list indent in from it on a message that is a list
        const start = row.list ? row.list.left : row.block.left;
        const indent = row.list ? 24 : 1.5;
        for (const line of row.lines)
          assert.ok(line.left - start >= -1.5 && line.left - start <= indent,
            `the ${name} box left white space before a line: ${JSON.stringify({row:row.text, line, block:row.block})}`);
      }
      assert.ok(list.list, `the ${name} box's first message did not render as a list`);
      // the marker stands at the block's own left edge and its text one indent
      // in from it, so the two are beside each other and not a box apart
      assert.ok(Math.abs(list.list.left - list.block.left) <= 1,
        `the ${name} box moved the list off its block's left edge: ${JSON.stringify(list)}`);
      assert.ok(list.lines[0].left - list.list.left <= 24,
        `the ${name} box left a gap between the marker and its text: ${JSON.stringify(list)}`);
      // a short line is narrower than the box and still ends at its right edge
      assert.ok(short.block.width < (box.lane.right - box.lane.left) * 0.8,
        `the short message is wider than its own words: ${JSON.stringify(short)}`);
      // and a wrapped one takes more than one line, each beginning on the same edge
      assert.ok(wrapped.lines.length >= 2, `the long message did not wrap: ${JSON.stringify(wrapped)}`);
      const lefts = new Set(wrapped.lines.map(line => Math.round(line.left)));
      assert.equal(lefts.size, 1, `the wrapped lines do not share one left edge: ${JSON.stringify(wrapped.lines)}`);
    }
    await page.close();
  });
}
