// Each sent message in the two boxes on the card is one bubble: a rounded,
// filled block around the whole message, as wide as its longest line, capped at
// four fifths of the lane, hugging the right edge, with the words left aligned
// inside it so a list, a code block and a short line under a long paragraph all
// start on one left edge. The last bubble in a box carries the tail and no
// other does; Delivered and Read sit under the bubble's straight bottom edge,
// in from the corner. Both pages, both boxes. The measures are printed before
// they are asserted, so one run records the numbers whether it passes or fails.
// Every card, message and answer here is invented.
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
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
const SHOTS = process.env.PEND_BUBBLE_SHOTS || "";
const FILL = "rgb(243, 243, 243)";
// the long paragraph is wider than four fifths of either box, so it must wrap;
// the short line and the list are one message with it, typed with plain line
// breaks, so the renderer joins the paragraph and the short line with a <br>
const LONG = "This is an invented long paragraph written to be wide enough that it " +
  "must wrap onto more than one line inside the narrow sent message box on the card.";
const SHORT = "Short line.";
const ITEM1 = "First invented option here.";
const ITEM2 = "Second invented option here.";
const MIXED = `${LONG}\n${SHORT}\n1. ${ITEM1}\n2. ${ITEM2}`;
const SECOND = "One short second message.";
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
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=2&agent=bubble-fixture");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, cardId);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}
async function pause(ms){ await new Promise(resolve => setTimeout(resolve, ms)); }

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pend-bubbles-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js",
      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({title:"Invented bubble fixture", items:[]}));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], { cwd:fixtureDir,
    env:{...process.env, FACILITATOR_TEST_PORT:String(port), FACILITATOR_LOG_DIR:path.join(fixtureDir, "logs")},
    stdio:["ignore", "pipe", "pipe"] });
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await pause(25);
  }
  cardId = (await api("/create?owner=facilitator", "Invented card for the bubbles")).id;
  // the two messages the reply answers: they end up in the box above the answer
  await api(`/send?box=${cardId}`, MIXED);
  await api(`/send?box=${cardId}`, SECOND);
  await claim();
  await api(`/reply?box=${cardId}`, Array.from({length:3}, (_, i) =>
    `Invented answer paragraph ${i + 1}, written to give the card some prose.`).join("\n\n"));
  // and the same two again, waiting: they end up in the box under the answer
  await api(`/send?box=${cardId}`, MIXED);
  await api(`/send?box=${cardId}`, SECOND);
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
// one box: the lane, the header row, the page's own two air tokens resolved in
// the strip, and every row's bubble, tail, receipt, blocks and lines of ink
async function measure(page, seat){
  return page.evaluate((id, seat) => {
    const r = n => Math.round(n * 100) / 100;
    const box = e => { const b = e.getBoundingClientRect(); return {left:r(b.left), right:r(b.right), top:r(b.top), bottom:r(b.bottom), width:r(b.width), height:r(b.height)}; };
    const strip = document.querySelector(`#box-${id} ${seat} .pendlist`);
    const lane = box(strip.querySelector(".pendslide"));
    // the scroller the lane slides in: a box pinned to its newest line has its
    // lane's top above the scroller's, so the header is measured against this
    const scroller = box(strip.querySelector(".pendscroll"));
    // the two tokens the bubble's air is written in, read as lengths
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute; width:var(--sp-x); height:var(--sp-s)";
    strip.appendChild(probe);
    const air = {x:r(probe.getBoundingClientRect().width), y:r(probe.getBoundingClientRect().height)};
    probe.remove();
    const stamp = strip.querySelector(".pendstamp"), chev = strip.querySelector(".chevtop");
    const rectsOf = node => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].filter(x => x.width > 0.5); };
    // one entry per line of ink, gathered by the line's own top, so a space
    // hanging off the end of a wrapped line cannot be read as a start
    const linesOf = (el, pred) => {
      const seen = new Map();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()){
        if (!n.textContent.trim() || n.parentElement.closest(".ptime")) continue;
        if (pred && !pred(n.textContent.trim())) continue;
        for (const rect of rectsOf(n)){
          const key = Math.round(rect.top);
          const line = seen.get(key);
          if (!line) seen.set(key, {left:rect.left, right:rect.right, top:rect.top});
          else { line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right); }
        }
      }
      return [...seen.values()].sort((a, b) => a.top - b.top).map(l => ({left:r(l.left), right:r(l.right), width:r(l.right - l.left)}));
    };
    // the ink's own air: the first line's tallest glyph top and the last line's
    // deepest glyph foot, each read from the line's content rect (a Range on
    // the text) and the font's own metrics for that text (a canvas), against
    // the bubble's edges. equal padding is not the measure, since the font's
    // ink stands high in its line
    const ctx = document.createElement("canvas").getContext("2d");
    const inkAir = (c, b) => {
      const cs = getComputedStyle(c);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const nodes = [];
      const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n.textContent.trim() && !n.parentElement.closest(".ptime")) nodes.push(n);
      const first = rectsOf(nodes[0])[0], lastRects = rectsOf(nodes[nodes.length - 1]), last = lastRects[lastRects.length - 1];
      const mf = ctx.measureText(nodes[0].textContent), ml = ctx.measureText(nodes[nodes.length - 1].textContent);
      return { topAir:r(first.top + (mf.fontBoundingBoxAscent - mf.actualBoundingBoxAscent) - b.top),
               bottomAir:r(b.bottom - (last.bottom - (ml.fontBoundingBoxDescent - ml.actualBoundingBoxDescent))) };
    };
    const rows = [...strip.querySelectorAll(".pendmsg")].map(row => {
      const c = row.querySelector(".pendcontent"), cs = getComputedStyle(c), after = getComputedStyle(c, "::after");
      const rc = row.querySelector(".rcpt"), rcs = getComputedStyle(rc);
      const rcText = rc.firstChild ? rectsOf(rc.firstChild) : [];
      return {
        ink:inkAir(c, c.getBoundingClientRect()),
        text:(row.dataset.text || "").slice(0, 24),
        bubble:{...box(c), fill:cs.backgroundColor, radius:cs.borderRadius, align:cs.textAlign,
                pad:{top:parseFloat(cs.paddingTop), right:parseFloat(cs.paddingRight), bottom:parseFloat(cs.paddingBottom), left:parseFloat(cs.paddingLeft)}},
        tail:{content:after.content, position:after.position, bottom:after.bottom, height:after.height, width:after.width,
              fill:after.backgroundColor, image:(after.maskImage || after.webkitMaskImage || "").slice(0, 24),
              size:after.maskSize || after.webkitMaskSize, at:after.maskPosition || after.webkitMaskPosition},
        rcpt:{text:rc.textContent, display:rcs.display, padding:rcs.padding,
              textRight:rcText.length ? r(Math.max(...rcText.map(x => x.right))) : null,
              textTop:rcText.length ? r(Math.min(...rcText.map(x => x.top))) : null},
        blocks:[...c.children].filter(e => !e.classList.contains("ptime")).map(e => ({tag:e.tagName.toLowerCase(), ...box(e)})),
        plines:c.querySelectorAll(".pline").length,
        long:linesOf(c, t => t.startsWith("This is an invented long")),
        short:linesOf(c, t => t === "Short line."),
        item1:linesOf(c, t => t.startsWith("First invented option")),
        lines:linesOf(c),
      };
    });
    return { lane, scroller, air, rows,
      head:{stamp:{...box(stamp), align:getComputedStyle(stamp).textAlign, text:stamp.textContent}, chev:chev ? box(chev) : null} };
  }, cardId, seat);
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} against ${b}`);

for (const kind of ["desktop", "phone"]) {
  describe(kind, () => {
    let page, boxes;
    before(async () => {
      page = await openPage(kind);
      await openBoxes(page);
      boxes = { top:await measure(page, ".pendwrap-answered"), bottom:await measure(page, ".pendwrap") };
      console.log(`  ${kind} :: ${JSON.stringify(boxes)}`);
      if (SHOTS) { await mkdir(SHOTS, {recursive:true}); await page.screenshot({path:path.join(SHOTS, `${kind}-bubbles.png`)}); }
    });
    after(async () => { if (page) await page.close(); });

    test("one bubble per message: filled, rounded, padded with the page's own air, hugging the right edge", () => {
      for (const [name, box] of Object.entries(boxes)) {
        assert.equal(box.rows.length, 2, `the ${name} box is not holding the two invented messages`);
        const cap = box.lane.width * 0.8;
        for (const row of box.rows) {
          const b = row.bubble;
          assert.equal(b.fill, FILL, `the ${name} box's bubble is not filled: ${JSON.stringify(b)}`);
          assert.equal(b.radius, "18px", `the ${name} box's bubble corner is not 18px: ${JSON.stringify(b)}`);
          // the air above and below the line boxes is the small step twice,
          // split unevenly so the ink inside them is centred (the test below)
          near(b.pad.top + b.pad.bottom, 2 * box.air.y, 0.05, `${name} box, bubble air above and below the words together`);
          assert.ok(b.pad.top < box.air.y && b.pad.bottom > box.air.y, `the ${name} box's bubble does not give the ink's low seat back: ${JSON.stringify(b.pad)}`);
          near(b.pad.left, box.air.x, 0.05, `${name} box, bubble air left of the words`);
          near(b.pad.right, box.air.x, 0.05, `${name} box, bubble air right of the words`);
          assert.equal(b.align, "left", `the ${name} box ends its words at the right edge`);
          near(b.right, box.lane.right, 1, `${name} box, bubble right edge against the lane's`);
          assert.ok(b.width <= cap + 1, `the ${name} box's bubble is wider than four fifths of the lane: ${b.width} of ${box.lane.width}`);
        }
        // the long message fills the cap; the short one is exactly its words
        // plus the air either side, and no wider
        const [mixed, short] = box.rows;
        near(mixed.bubble.width, cap, 1, `${name} box, the wrapped message's bubble at the cap`);
        assert.ok(short.bubble.width < cap - 20, `the ${name} box's short bubble is as wide as the cap: ${JSON.stringify(short.bubble)}`);
        near(short.bubble.width, short.lines[0].width + 2 * box.air.x, 1.5, `${name} box, the short bubble around its one line`);
      }
    });

    test("inside the bubble every block starts on one left edge and keeps its formatting", () => {
      for (const [name, box] of Object.entries(boxes)) {
        const [mixed] = box.rows;
        assert.equal(mixed.plines, 0, `the ${name} box still splits a paragraph into lines`);
        const inner = {left:mixed.bubble.left + box.air.x, right:mixed.bubble.right - box.air.x};
        assert.equal(mixed.blocks.map(b => b.tag).join(","), "p,ol", `the ${name} box did not render a paragraph and a list: ${JSON.stringify(mixed.blocks)}`);
        for (const block of mixed.blocks) {
          near(block.left, inner.left, 0.5, `${name} box, ${block.tag} left edge against the bubble's inner edge`);
          near(block.right, inner.right, 0.5, `${name} box, ${block.tag} right edge against the bubble's inner edge`);
        }
        assert.ok(mixed.long.length >= 2, `the ${name} box did not wrap the long paragraph: ${JSON.stringify(mixed.long)}`);
        const lefts = new Set(mixed.long.map(l => Math.round(l.left)));
        assert.equal(lefts.size, 1, `the ${name} box gave the long paragraph a ragged left edge: ${JSON.stringify(mixed.long)}`);
        near(mixed.long[0].left, inner.left, 0.5, `${name} box, the long paragraph's left edge`);
        // the short line under it begins where the paragraph begins, not flush right
        assert.equal(mixed.short.length, 1, `the ${name} box did not draw the short line: ${JSON.stringify(mixed.short)}`);
        near(mixed.short[0].left, inner.left, 0.5, `${name} box, the short line's left edge`);
        // the list keeps its indent: its marker stands at the block's edge and
        // its text one indent in
        const ol = mixed.blocks.find(b => b.tag === "ol");
        assert.ok(mixed.item1.length >= 1, `the ${name} box did not draw the list: ${JSON.stringify(mixed.item1)}`);
        assert.ok(mixed.item1[0].left - ol.left > 0 && mixed.item1[0].left - ol.left <= 24,
          `the ${name} box did not seat the marker beside its text: ${JSON.stringify({item1:mixed.item1, ol})}`);
        // the single short message's words sit inside its own bubble's air
        const [, short] = box.rows;
        near(short.lines[0].left, short.bubble.left + box.air.x, 0.5, `${name} box, the short message's words inside its bubble`);
      }
    });

    test("the ink of the words has the same air over it as under it, one line or many", () => {
      for (const [name, box] of Object.entries(boxes))
        for (const row of box.rows)
          assert.ok(Math.abs(row.ink.topAir - row.ink.bottomAir) <= 1,
            `the ${name} box's words sit off centre in their bubble: ${JSON.stringify({text:row.text, ink:row.ink, pad:row.bubble.pad})}`);
    });

    test("the tail hangs under the last bubble of each box and under no other", () => {
      for (const [name, box] of Object.entries(boxes)) {
        const last = box.rows[box.rows.length - 1];
        for (const row of box.rows.slice(0, -1))
          assert.equal(row.tail.content, "none", `the ${name} box gave a tail to a bubble that is not the last: ${JSON.stringify(row.tail)}`);
        const t = last.tail;
        assert.equal(t.content, '""', `the ${name} box's last bubble has no tail: ${JSON.stringify(t)}`);
        assert.equal(t.position, "absolute", `the ${name} box's tail is not the bubble's own box: ${JSON.stringify(t)}`);
        assert.equal(t.bottom, "-7px", `the ${name} box's tail does not hang 7px under: ${JSON.stringify(t)}`);
        assert.equal(t.height, "25px", `the ${name} box's tail box is not 25px tall: ${JSON.stringify(t)}`);
        near(parseFloat(t.width), last.bubble.width, 0.5, `${name} box, the tail box spans the bubble`);
        assert.equal(t.fill, FILL, `the ${name} box's tail is not painted in the bubble's fill: ${JSON.stringify(t)}`);
        assert.equal(t.image, 'url("data:image/svg+xml,', `the ${name} box's tail is not cut by the mask: ${JSON.stringify(t)}`);
        assert.equal(t.size, "24px 25px", `the ${name} box's tail mask is not 24 by 25: ${JSON.stringify(t)}`);
        assert.equal(t.at, "100% 0px", `the ${name} box's tail is not at the right end: ${JSON.stringify(t)}`);
        // the lane keeps the 7px the tail hangs into, with or without a
        // delivery word under the bubble, so the hook is never cut on the
        // lane's edge
        assert.ok(box.lane.bottom - last.bubble.bottom >= 6.95,
          `the ${name} box's lane cuts the tail off: ${JSON.stringify({lane:box.lane, bubble:last.bubble})}`);
      }
    });

    test("Delivered and Read sit under the bubble's straight bottom edge, in from the corner", () => {
      // the box above the answer carries no delivery word: everything in it has
      // been answered
      for (const row of boxes.top.rows) {
        assert.equal(row.rcpt.text, "", `the top box carries a delivery word: ${JSON.stringify(row.rcpt)}`);
        assert.equal(row.rcpt.display, "none");
      }
      const [read, delivered] = boxes.bottom.rows;
      assert.equal(read.rcpt.text, "Read");
      assert.equal(delivered.rcpt.text, "Delivered");
      // Delivered sits under the bubble that carries the tail, as Messages
      // hangs both on the last bubble of a run
      assert.equal(delivered.tail.content, '""', "the bubble under which Delivered sits carries no tail");
      for (const row of boxes.bottom.rows) {
        assert.equal(row.rcpt.padding, "7px 18px 0px", `the bottom box's delivery word keeps the old seat: ${JSON.stringify(row.rcpt)}`);
        // the word ends where the bubble's straight bottom edge ends, one
        // corner radius in, so it stands clear of the corner's arc and, on the
        // last bubble, of the hook that leaves the edge just past that point
        near(row.rcpt.textRight, row.bubble.right - 18, 0.6, `bottom box, ${row.rcpt.text}'s right end 18px in from the bubble's edge`);
        near(row.rcpt.textTop, row.bubble.bottom + 7, 0.6, `bottom box, ${row.rcpt.text} starting 7px under the bubble`);
      }
    });

    test("the header row is as it was: the time at the right, the arrow at the left, above the rows", () => {
      for (const [name, box] of Object.entries(boxes)) {
        assert.equal(box.head.stamp.align, "right", `the ${name} box's time is not right aligned`);
        assert.match(box.head.stamp.text, /\d:\d\d [AP]M/, `the ${name} box's time is not printed: ${JSON.stringify(box.head.stamp)}`);
        near(box.head.stamp.right, box.lane.right, 0.5, `${name} box, the time's right end against the lane's`);
        assert.ok(box.head.chev, `the ${name} box has no corner arrow`);
        near(box.head.chev.left, box.lane.left, 0.5, `${name} box, the arrow's left end against the lane's`);
        assert.ok(box.head.stamp.bottom <= box.scroller.top + 0.5, `the ${name} box's time is not above its rows: ${JSON.stringify({stamp:box.head.stamp, scroller:box.scroller})}`);
      }
    });

    if (kind === "phone") test("a row waiting in the phone's unsent holder takes the tail from the confirmed row above it", async () => {
      const seen = await page.evaluate(id => {
        const pend = els[id].pend;
        const confirmed = pend.querySelector(".pendslide .pendmsg:last-child .pendcontent");
        const holder = pend.querySelector(".pendlocal");
        const tailOf = c => getComputedStyle(c, "::after").content;
        const before = tailOf(confirmed);
        const row = pendRow("Invented line still on its way");
        holder.appendChild(row);
        const during = {confirmed:tailOf(confirmed), local:tailOf(row.querySelector(".pendcontent"))};
        row.remove();
        return {before, during, afterwards:tailOf(confirmed)};
      }, cardId);
      console.log(`  phone unsent row :: ${JSON.stringify(seen)}`);
      assert.equal(seen.before, '""', "the confirmed row had no tail before the unsent row arrived");
      assert.equal(seen.during.local, '""', "the unsent row did not take the tail");
      assert.equal(seen.during.confirmed, "none", "the confirmed row kept its tail beside the unsent row's");
      assert.equal(seen.afterwards, '""', "the confirmed row did not get its tail back");
    });
  });
}

test("the per-paragraph sizing and the line split are gone from both pages and the shared logic", async () => {
  for (const name of ["card-logic.js", "index.html", "m.html"]) {
    const text = await readFile(path.join(ROOT, name), "utf8");
    assert.ok(!/pline/.test(text), `${name} still names the per-line span`);
    assert.ok(!/splitPendLines/.test(text), `${name} still names the line split`);
  }
});
