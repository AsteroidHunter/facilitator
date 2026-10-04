// The word under a sent message ("Read") has nothing left to say once the reply
// to it lands. On the phone page and on the Mac board, a page that is on show when
// the reply comes in watches the word fade out over about 0.4s with only its
// strength changing, and the reply stands where it stood with the word, so nothing
// moves. A page drawn with the reply already there shows no word and no fade, and a
// message sent after the newest reply keeps its "Delivered" and "Read" until a
// reply comes after it. Every frame of the fade is read from inside the page, so a
// slow machine cannot miss it. Every card, message and answer below is invented.
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
async function claim(id){
  const response = await fetch(origin + "/wait?owner=facilitator&timeout=1&agent=read-fade");
  assert.equal(response.status, 200);
  const delivery = await response.json();
  assert.equal(delivery.box, id);
  await api(`/ack?owner=facilitator&token=${encodeURIComponent(delivery.ack)}`, "");
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-read-fade-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title:"Invented read mark fixture", items:[] }));
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

// a card with one message that an agent has picked up, so the panel says Read
async function readCard(kind, text){
  const id = (await api("/create?owner=facilitator", `Invented read mark card ${kind}`)).id;
  await api(`/send?box=${id}`, text);
  await claim(id);
  return id;
}

async function drawn(page, kind, id, reload){
  if (reload) await page.reload({ waitUntil:"domcontentloaded" });
  else await page.goto(origin + (kind === "phone" ? "/m" : "/"), { waitUntil:"domcontentloaded" });
  await page.waitForFunction(card => typeof lastState !== "undefined" && lastState && typeof els !== "undefined" && els[card], {}, id);
  await page.evaluate(card => select(card), id);
  await page.waitForFunction(card => {
    const el = els[card];
    const stage = document.getElementById("stage");
    return el && !document.querySelector(".turnsheet") && (!el.sent || !el.sent.classList.contains("motion")) &&
      (!stage || getComputedStyle(stage).visibility === "visible");
  }, {}, id);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await wait(350);
}

// a page that notes every change to a word's attribute, and every fade, from the
// first line of the page on, so a mark that shows for one frame is not missed
async function openPage(kind, id){
  const page = await browser.newPage();
  await page.setViewport(kind === "phone"
    ? { width:375, height:812, isMobile:true, hasTouch:true, deviceScaleFactor:2 }
    : { width:1440, height:900 });
  await page.evaluateOnNewDocument(card => {
    localStorage.clear();
    localStorage.setItem("facilitator-selected", card);
    window.__marks = [];
    new MutationObserver(records => {
      for (const r of records){
        if (r.attributeName === "data-mark") window.__marks.push(`data-mark ${r.oldValue} to ${r.target.getAttribute("data-mark")}`);
        else if (/markgone/.test((r.oldValue || "") + " " + r.target.className)) window.__marks.push("markgone");
      }
    }).observe(document, { subtree:true, attributes:true, attributeOldValue:true, attributeFilter:["data-mark", "class"] });
  }, id);
  await drawn(page, kind, id, false);
  return page;
}

const markOf = (page, id) => page.evaluate(card => {
  const el = els[card];
  const read = panel => panel ? { mark: panel.dataset.mark ?? null, tag: panel.dataset.tag ?? null, kept: panel.classList.contains("kept"),
    after: getComputedStyle(panel, "::after").content } : null;
  return { sent: read(el.sent), answ: read(el.answ), words: document.querySelectorAll(`#box-${card} [data-mark]`).length };
}, id);

// every frame of the picture of the sent panel that the page turn carries up
function watchSheet(){
  window.__frames = [];
  window.__watching = true;
  const frame = () => {
    const picture = document.querySelector(".turnsheet .answered.sent");
    if (picture){
      const cs = getComputedStyle(picture, "::after"), r = picture.getBoundingClientRect();
      const fresh = document.querySelector(".turnsheet .answered:not(.sent)");
      window.__frames.push({
        at: performance.now(), content: cs.content, opacity: parseFloat(cs.opacity), gone: picture.classList.contains("markgone"),
        props: cs.transitionProperty, size: `${Math.round(r.width * 100) / 100}x${Math.round(r.height * 100) / 100}`,
        freshMark: fresh ? fresh.dataset.mark ?? null : "no picture",
      });
    }
    if (window.__watching) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// the reply lands while the page is on show: every frame of the sheet is read
async function landReply(page, id, text, said){
  await page.evaluate(watchSheet);
  await api(`/reply?box=${id}`, text);
  await page.waitForFunction((card, word) => els[card].reply.textContent.includes(word) && !document.querySelector(".turnsheet"), {}, id, said);
  await wait(700);
  return page.evaluate(() => { window.__watching = false; return window.__frames; });
}

function assertFades(kind, frames){
  const ramp = frames.filter(f => f.gone);
  assert.ok(frames.some(f => f.content.includes("Read")), `${kind}: the picture of the messages never showed Read`);
  assert.ok(ramp.length >= 3, `${kind}: caught ${ramp.length} frames of the fade`);
  assert.ok(ramp[0].opacity > 0.5, `${kind}: the word was already fading out when first seen: ${ramp[0].opacity}`);
  assert.ok(ramp.some(f => f.opacity > 0 && f.opacity < 1), `${kind}: the word never showed part way`);
  for (let i = 1; i < ramp.length; i++)
    assert.ok(ramp[i].opacity <= ramp[i - 1].opacity + 0.001, `${kind}: the word got stronger part way through the fade`);
  assert.equal(ramp[ramp.length - 1].opacity, 0, `${kind}: the word was still on show when the sheet went`);
  const first = ramp.find(f => f.opacity === 0);
  assert.ok(first.at - ramp[0].at >= 340, `${kind}: the word went in ${Math.round(first.at - ramp[0].at)}ms, about 400 was asked`);
  assert.ok(ramp.every(f => f.props === "opacity"), `${kind}: the fade runs more than strength: ${ramp[0].props}`);
  assert.equal(new Set(frames.map(f => f.size)).size, 1, `${kind}: the picture changed size while the word went`);
  assert.ok(frames.every(f => f.freshMark === null || f.freshMark === "no picture"), `${kind}: the new page carries a word`);
}

for (const kind of ["phone", "desktop"]){
  test(`${kind}: the Read mark fades out when the reply comes in and stays gone`, async () => {
    const id = await readCard(kind, "Invented message that an agent has picked up and read.");
    const page = await openPage(kind, id);
    try {
      await page.waitForFunction(card => els[card].sent && els[card].sent.dataset.mark === "Read", {}, id);
      const before = await markOf(page, id);
      assert.equal(before.sent.mark, "Read");
      assert.equal(before.answ, null);
      const sentRoom = await page.evaluate(card => parseFloat(getComputedStyle(els[card].sent).marginBottom), id);
      assert.ok(sentRoom > 10, `the word has no room under the panel: ${sentRoom}`);

      const frames = await landReply(page, id, "Invented reply under the message. It is a short answer so the card reads quickly.", "short answer");
      assertFades(kind, frames);

      const live = await markOf(page, id);
      assert.equal(live.sent, null, "the sent panel is still on the card");
      assert.equal(live.answ.mark, null, "the panel over the reply still carries a word");
      assert.equal(live.answ.after, "none", "the panel over the reply still draws a word");
      assert.equal(live.words, 0, "a word is still on the card");
      assert.ok(live.answ.kept, "the room for the word was given up");

      // the room stays, so the reply stands exactly where it stood with the word
      // under the panel, and it would stand higher with neither
      const room = await page.evaluate(card => {
        const el = els[card], panel = el.answ, top = () => el.reply.getBoundingClientRect().top;
        panel.style.transition = "none";
        const kept = top();
        panel.classList.remove("kept");
        panel.dataset.mark = "Read";
        const withWord = top();
        delete panel.dataset.mark;
        const neither = top();
        panel.classList.add("kept");
        const margin = parseFloat(getComputedStyle(panel).marginBottom);
        panel.style.transition = "";
        return { kept, withWord, neither, margin };
      }, id);
      assert.ok(Math.abs(room.kept - room.withWord) <= 0.5, `the reply moved when the word went: ${room.withWord} to ${room.kept}`);
      assert.ok(room.kept - room.neither >= 10, `the kept room is not what holds the reply: ${room.kept} against ${room.neither}`);
      assert.ok(Math.abs(room.margin - sentRoom) <= 0.5, `the room differs from the word's: ${room.margin} against ${sentRoom}`);
      const replyTop = await page.evaluate(card => els[card].reply.getBoundingClientRect().top - els[card].box.getBoundingClientRect().top, id);

      // a page drawn with the reply already there: no word, no fade, same place
      await drawn(page, kind, id, true);
      const reloaded = await markOf(page, id);
      assert.equal(reloaded.sent, null);
      assert.equal(reloaded.answ.mark, null, "a card drawn with its reply shows a word");
      assert.equal(reloaded.answ.after, "none");
      assert.equal(reloaded.words, 0);
      assert.ok(reloaded.answ.kept);
      assert.deepEqual(await page.evaluate(() => window.__marks), [], "a word or a fade showed on the page drawn with its reply");
      const reloadedTop = await page.evaluate(card => els[card].reply.getBoundingClientRect().top - els[card].box.getBoundingClientRect().top, id);
      assert.ok(Math.abs(reloadedTop - replyTop) <= 0.5, `the reply stands differently drawn fresh: ${reloadedTop} against ${replyTop}`);
    } finally { await page.close(); }
  });

  test(`${kind}: a message sent after the newest reply keeps Delivered and Read until a reply follows it`, async () => {
    const id = await readCard(kind, "Invented first message that is answered below.");
    await api(`/reply?box=${id}`, "Invented first reply that answers the first message.");
    const page = await openPage(kind, id);
    try {
      let now = await markOf(page, id);
      assert.equal(now.answ.mark, null, "the first reply is drawn with a word");
      assert.equal(now.words, 0);

      await api(`/send?box=${id}`, "Invented second message sent after the first reply.");
      await page.waitForFunction(card => els[card].sent && els[card].sent.dataset.mark === "Delivered", {}, id);
      now = await markOf(page, id);
      assert.equal(now.sent.mark, "Delivered");
      assert.equal(now.answ.mark, null, "the panel over the first reply carries a word");

      await claim(id);
      await page.waitForFunction(card => els[card].sent && els[card].sent.dataset.mark === "Read", {}, id);
      now = await markOf(page, id);
      assert.equal(now.sent.mark, "Read");
      assert.equal(now.answ.mark, null);

      // drawn fresh with the first reply above it, the later message is still marked
      await drawn(page, kind, id, true);
      now = await markOf(page, id);
      assert.equal(now.sent.mark, "Read", "a message sent after the newest reply lost its word on a reload");
      assert.equal(now.answ.mark, null);

      const frames = await landReply(page, id, "Invented second reply that answers the second message.", "second message");
      assertFades(kind, frames);
      now = await markOf(page, id);
      assert.equal(now.sent, null);
      assert.equal(now.words, 0, "a word is still on the card after the second reply");
    } finally { await page.close(); }
  });
}
