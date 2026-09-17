// One message can hold several paragraphs, and each must read as its own block
// against the box's right edge. A message here is one long wrapping paragraph, a
// short line under it, and a two-item list, sent as a single message with plain
// line breaks between its parts, so the renderer joins the long paragraph and
// the short line into one <p> with a <br> and draws the list on its own. Before
// the split, the whole message sat in one block as wide as the long paragraph,
// so the short line and the list began at that block's left edge and stopped in
// the middle of the box. After it, the long paragraph fills the cap, the short
// line stands flush right on its own, and the list hugs the right edge beside
// its numbers. The measures are printed before they are asserted, so one run
// records the numbers whether it passes or fails. Every card and message is
// invented.
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
const SHOTS = process.env.PEND_PARA_SHOTS || "";
// the long paragraph is written to be wider than four fifths of either box, so
// it must wrap; the short line and the list items are short enough to stand well
// clear of the right edge if they were left where a wide block begins
const LONG = "This is an invented long paragraph written to be wide enough that it " +
  "must wrap onto more than one line inside the narrow sent message box on the card.";
const SHORT = "Short line.";
const ITEM1 = "First invented option here.";
const ITEM2 = "Second invented option here.";
// one message, plain line breaks between its parts (as a keyboard's own return
// makes them), so the long paragraph and the short line share one <p>
const MIXED = `${LONG}\n${SHORT}\n1. ${ITEM1}\n2. ${ITEM2}`;
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=2&agent=para-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pend-para-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented paragraph fixture", items:[]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs")},
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented card for the paragraph split")).id;
  // the mixed message the reply answers: it ends up in the box above the answer
  await api(`/send?box=${cardId}`, MIXED);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:3}, (_, i) =>
    `Invented answer paragraph ${i + 1}, written to give the card some prose.`).join("\n\n"));
  // and the same message again, waiting: it ends up in the box under the answer
  await api(`/send?box=${cardId}`, MIXED);
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
// the one mixed row in a box, broken into the numbers the split is judged by:
// the lane's right edge, the lines of the long paragraph, the short line, and
// the list's block, first item and its own line
async function measure(page, seat){
  return page.evaluate((id, seat) => {
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    const lane = strip.querySelector(".pendslide").getBoundingClientRect();
    const round = n => Math.round(n * 100) / 100;
    const rows = [...strip.querySelectorAll(".pendmsg")];
    const row = rows.find(r => (r.dataset.text || "").includes("Short line.")) || rows[0];
    const content = row.querySelector(".pendcontent");
    // every text node that carries ink, minus the drag's own pinned-right time
    const textNodes = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()){
      if (n.parentElement.closest(".ptime")) continue;
      if (!n.textContent.trim()) continue;
      textNodes.push(n);
    }
    // one entry per line of ink in a node, gathered by the line's own top so a
    // space hanging off the end of a wrapped line cannot be read as a start
    const linesOf = pred => {
      const node = textNodes.find(n => pred(n.textContent.trim()));
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const seen = new Map();
      for (const rect of range.getClientRects()){
        if (rect.width <= 0.5) continue;
        const key = Math.round(rect.top);
        const line = seen.get(key);
        if (!line) seen.set(key, {left:rect.left, right:rect.right, top:rect.top});
        else { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); }
      }
      return [...seen.values()].sort((a, b) => a.top - b.top)
        .map(l => ({left:round(l.left), right:round(l.right)}));
    };
    const ol = content.querySelector("ol, ul");
    return {
      laneRight: round(lane.right),
      contentLeft: round(content.getBoundingClientRect().left),
      long: linesOf(t => t.startsWith("This is an invented long")),
      short: linesOf(t => t === "Short line."),
      item1: linesOf(t => t.startsWith("First invented option")),
      list: ol ? {left:round(ol.getBoundingClientRect().left), right:round(ol.getBoundingClientRect().right)} : null,
    };
  }, cardId, seat);
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: each paragraph of one message is its own block against the right edge`, async () => {
    const page = await openPage(kind);
    await openBoxes(page);
    const boxes = { top:await measure(page, ".pendwrap-answered"), bottom:await measure(page, ".pendwrap") };
    console.log(`  ${kind} :: ${JSON.stringify(boxes)}`);
    if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${kind}-per-paragraph.png`)}); }

    for (const [name, box] of Object.entries(boxes)) {
      assert.ok(box.long && box.long.length >= 2, `the ${name} box did not wrap the long paragraph: ${JSON.stringify(box)}`);
      assert.ok(box.short && box.short.length === 1, `the ${name} box did not draw the short line: ${JSON.stringify(box)}`);
      assert.ok(box.item1 && box.item1.length >= 1, `the ${name} box did not draw the list: ${JSON.stringify(box)}`);
      // the short line stands on its own block flush against the box's right edge
      // instead of beginning where the long paragraph begins and stopping in the
      // middle of the box
      assert.ok(Math.abs(box.short[0].right - box.laneRight) <= 1.5,
        `the ${name} box left the short line short of the right edge: ${JSON.stringify({short:box.short, laneRight:box.laneRight})}`);
      // the list is its own block against the right edge, and sized to its own
      // items rather than stretched across the column with its items adrift at
      // the left. its block ends on the right edge, and its block begins well in
      // from the column's left edge, where a stretched list would have begun
      assert.ok(Math.abs(box.list.right - box.laneRight) <= 1.5,
        `the ${name} box moved the list off the right edge: ${JSON.stringify({list:box.list, laneRight:box.laneRight})}`);
      assert.ok(box.list.left - box.contentLeft > 20,
        `the ${name} box stretched the list across the column: ${JSON.stringify({list:box.list, contentLeft:box.contentLeft})}`);
      // the marker sits beside its own text, one list indent in from the block's
      // left edge and no more
      assert.ok(box.item1[0].left - box.list.left > 0 && box.item1[0].left - box.list.left <= 24,
        `the ${name} box did not seat the marker beside its text: ${JSON.stringify({item1:box.item1, list:box.list})}`);
      // every line of the long paragraph begins on the same left edge (it fills
      // the cap, so it wraps rather than standing narrow at the right)
      const lefts = new Set(box.long.map(l => Math.round(l.left)));
      assert.equal(lefts.size, 1, `the ${name} box gave the long paragraph a ragged left edge: ${JSON.stringify(box.long)}`);
      // and the long paragraph's block is sized apart from the short line's: the
      // long one begins well to the left of where the short one begins, which is
      // the whole point. sized together, both begin at the same left edge
      assert.ok(box.long[0].left < box.short[0].left - 20,
        `the ${name} box sized the short line with the long paragraph: ${JSON.stringify({long:box.long, short:box.short})}`);
    }
    await page.close();
  });
}
