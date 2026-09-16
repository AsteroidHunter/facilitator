// Both sent-message boxes are plainly left aligned on both pages. Every block a
// message is drawn in -- a paragraph, a list, a code block, a single line --
// begins at the box's left content edge, the same x for all of them, and a line
// too long for the row wraps at the row's right edge instead of at a cap set
// short of it. Nothing hugs the right edge any more, and no message is broken
// into one block per typed line. The measures are printed before they are
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
// one message holding the three shapes that used to be sized apart: a paragraph
// long enough to wrap, a short line typed under it, and a two-item list. the
// line breaks are plain ones, as a keyboard's own return makes them, so the
// renderer joins the long paragraph and the short line into one <p> with a <br>
// and draws the list on its own
const LONG = "This is an invented long paragraph written to be wide enough that it " +
  "must wrap onto more than one line inside the narrow sent message box on the card.";
const SHORT = "Short line.";
const ITEM1 = "First invented option here.";
const ITEM2 = "Second invented option here.";
const MIXED = `${LONG}\n${SHORT}\n1. ${ITEM1}\n2. ${ITEM2}`;
// and the two other shapes, each as its own message: a single line, and a code
// block, which the renderer draws in a block with padding of its own
const SINGLE = "Invented single line.";
const CODE = "```\nconst invented = 1;\n```";
const SENT = [MIXED, SINGLE, CODE];
const INDENT = 24;   // the list's own indent, the furthest an item's text may sit in
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
  for (const text of SENT) await api(`/send?box=${cardId}`, text);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:3}, (_, i) =>
    `Invented answer paragraph ${i + 1}, written to give the card some prose.`).join("\n\n"));
  // and the same three again, waiting: they end up in the box under the answer
  for (const text of SENT) await api(`/send?box=${cardId}`, text);
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
// one box's rows: the lane they stand in, the block each message is drawn in,
// every block inside that one, and every line of ink with the kind of block it
// belongs to, so a line inside a list or a code block is judged by that block's
// own indent rather than by the box's edge
async function rowsOf(page, seat){
  return page.evaluate((id, seat) => {
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    const lane = strip.querySelector(".pendslide").getBoundingClientRect();
    const round = n => Math.round(n * 100) / 100;
    const edges = el => { const r = el.getBoundingClientRect();
      return {left:round(r.left), right:round(r.right), width:round(r.width)}; };
    return {
      lane:{left:round(lane.left), right:round(lane.right), width:round(lane.width)},
      splits:strip.querySelectorAll(".pline").length,
      rows:[...strip.querySelectorAll(".pendmsg")].map(row => {
        const content = row.querySelector(".pendcontent");
        const list = content.querySelector("ol, ul");
        const lines = [];
        const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
        // one entry per line of ink, gathered by the line's own top so a space
        // left hanging at the end of a wrapped line cannot be read as a start
        const seen = new Map();
        for (let node = walker.nextNode(); node; node = walker.nextNode()){
          if (!node.textContent.trim()) continue;
          if (node.parentElement.closest(".ptime")) continue;   // the drag's own time, pinned right
          const inList = !!node.parentElement.closest("li");
          const inCode = !!node.parentElement.closest(".codeblock");
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()){
            if (rect.width <= 0.5) continue;
            const key = Math.round(rect.top);
            const line = seen.get(key);
            if (!line) seen.set(key, {left:rect.left, right:rect.right, top:rect.top, inList, inCode,
                                      text:node.textContent.trim().slice(0, 20)});
            else { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); }
          }
        }
        for (const line of [...seen.values()].sort((a, b) => a.top - b.top))
          lines.push({text:line.text, left:round(line.left), right:round(line.right),
                      inList:line.inList, inCode:line.inCode});
        const rcpt = row.querySelector(".rcpt"), ptime = row.querySelector(".ptime");
        return {
          text:(row.dataset.text || "").slice(0, 24),
          textAlign:getComputedStyle(content).textAlign,
          content:edges(content),
          blocks:[...content.children].filter(child => !child.classList.contains("ptime"))
            .map(child => ({tag:child.tagName.toLowerCase(), ...edges(child)})),
          list:list ? edges(list) : null,
          lines,
          rcpt:rcpt && rcpt.textContent ? edges(rcpt) : null,
          ptime:ptime ? edges(ptime) : null,
        };
      }),
    };
  }, cardId, seat);
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: every block in both boxes begins at the box's left edge`, async () => {
    const page = await openPage(kind);
    await openBoxes(page);
    const boxes = { top:await rowsOf(page, ".pendwrap-answered"), bottom:await rowsOf(page, ".pendwrap") };
    console.log(`  ${kind} :: ${JSON.stringify(boxes)}`);
    if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${kind}-both-boxes.png`)}); }

    for (const [name, box] of Object.entries(boxes)) {
      assert.equal(box.rows.length, SENT.length, `the ${name} box is not holding the invented messages`);
      // no message is broken into one block per typed line any more
      assert.equal(box.splits, 0, `the ${name} box is still splitting messages line by line`);
      const [mixed, single, code] = box.rows;

      for (const row of box.rows) {
        assert.equal(row.textAlign, "left", `the ${name} box is not left aligning its words`);
        // the row's own column starts and ends on the lane, so nothing is pushed
        // off the left edge by a margin of its own
        assert.ok(Math.abs(row.content.left - box.lane.left) <= 1,
          `the ${name} box left white space before a message: ${JSON.stringify(row)}`);
        assert.ok(Math.abs(row.content.right - box.lane.right) <= 1,
          `the ${name} box stopped a message short of the right edge: ${JSON.stringify(row)}`);
        // and every block inside it begins on that same x, whatever it holds
        for (const block of row.blocks)
          assert.ok(Math.abs(block.left - box.lane.left) <= 1,
            `the ${name} box moved a ${block.tag} off the left edge: ${JSON.stringify({row:row.text, block, lane:box.lane})}`);
        // every line of ink starts there too, except a list's own items, which
        // stand one indent in from the marker beside them, and a code block's,
        // which stand inside that block's own padding
        for (const line of row.lines) {
          if (line.inCode) continue;
          const room = line.inList ? INDENT : 1.5;
          assert.ok(line.left - box.lane.left >= -1.5 && line.left - box.lane.left <= room,
            `the ${name} box left white space before a line: ${JSON.stringify({row:row.text, line, lane:box.lane})}`);
        }
      }

      // the list: its block on the box's edge, its marker inside that edge and
      // its text one indent in, so the marker reads first and the text beside it
      assert.ok(mixed.list, `the ${name} box's first message did not render as a list`);
      assert.ok(Math.abs(mixed.list.left - box.lane.left) <= 1,
        `the ${name} box moved the list off the left edge: ${JSON.stringify({list:mixed.list, lane:box.lane})}`);
      const items = mixed.lines.filter(line => line.inList);
      assert.equal(items.length, 2, `the ${name} box did not draw the two invented items: ${JSON.stringify(mixed.lines)}`);
      for (const item of items)
        assert.ok(item.left - mixed.list.left > 0 && item.left - mixed.list.left <= INDENT,
          `the ${name} box did not seat the marker beside its text: ${JSON.stringify({item, list:mixed.list})}`);

      // the short line typed under the long paragraph begins on the same x as
      // the paragraph above it instead of standing off at the right edge
      const prose = mixed.lines.filter(line => !line.inList && !line.inCode);
      const shortLine = prose.find(line => line.text.startsWith("Short line"));
      const longLines = prose.filter(line => line.text.startsWith("This is an invented"));
      assert.ok(shortLine, `the ${name} box did not draw the short line: ${JSON.stringify(prose)}`);
      assert.ok(longLines.length >= 2, `the ${name} box did not wrap the long paragraph: ${JSON.stringify(prose)}`);
      assert.ok(Math.abs(shortLine.left - longLines[0].left) <= 1,
        `the ${name} box sized the short line apart from the paragraph above it: ${JSON.stringify({shortLine, longLines})}`);
      // and the paragraph wraps at the row's right edge, not at a cap short of it
      const reach = Math.max(...longLines.map(line => line.right));
      assert.ok(reach > box.lane.left + box.lane.width * 0.85,
        `the ${name} box wrapped the paragraph short of the right edge: ${JSON.stringify({reach, lane:box.lane})}`);

      // the single line and the code block are blocks like any other: both begin
      // on the box's edge, and neither is as wide as its own words alone
      assert.equal(single.blocks.length, 1, `the ${name} box drew the single line in more than one block: ${JSON.stringify(single)}`);
      assert.ok(Math.abs(single.blocks[0].width - box.lane.width) <= 1,
        `the ${name} box sized the single line to its own words: ${JSON.stringify({block:single.blocks[0], lane:box.lane})}`);
      assert.ok(code.lines.some(line => line.inCode), `the ${name} box did not draw the code block: ${JSON.stringify(code)}`);
      assert.ok(Math.abs(code.blocks[0].width - box.lane.width) <= 1,
        `the ${name} box sized the code block to its own words: ${JSON.stringify({block:code.blocks[0], lane:box.lane})}`);

      // the delivery word under a row and the time a drag brings up are not part
      // of this change: both stay at the box's right edge
      const delivered = box.rows.map(row => row.rcpt).filter(Boolean);
      for (const rcpt of delivered)
        assert.ok(Math.abs(rcpt.right - box.lane.right) <= 1,
          `the ${name} box moved the delivery word off the right edge: ${JSON.stringify(rcpt)}`);
      for (const row of box.rows)
        if (row.ptime) assert.ok(Math.abs(row.ptime.right - box.lane.right) <= 1,
          `the ${name} box moved the drag's own time off the right edge: ${JSON.stringify(row.ptime)}`);
    }
    await page.close();
  });
}
