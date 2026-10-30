// An agent's page kept out of sight once its card is left (magicView's keep),
// in a real browser, on the Mac board and on the phone page. Typed in, and its
// box then gone without a click on the board (the agent closes it, the card is
// done, another card or project is put on screen, or it goes while expanded),
// the page has given the keys back and the next key is the board's. Set
// sounding, and its card left, its Web Audio and its clips stop, a sound a
// timer starts meanwhile waits, and all of it goes on as the card is shown
// again. Every sound is at zero volume. Its own headless Chrome on a copy of
// the board on spare ports.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SEED = { title: "kept page browser fixture", items: [
  { id: "k1", bucket: "now", title: "Typing card", owner: "facilitator" },
  { id: "k2", bucket: "now", title: "Sound card", owner: "facilitator" },
  { id: "k3", bucket: "now", title: "Words card", owner: "facilitator" },
  { id: "k4", bucket: "now", title: "Other project card", owner: "pastureland" },
] };
// a widget the person types in, which notes every key it hears
const TYPE = `<!doctype html><textarea id=field></textarea><script>
  facilitator.ready().catch(() => {});
  addEventListener("keydown", e => { field.dataset.keys = (field.dataset.keys || "") + e.key; }, true);
</script>`;
// a click sets a tone, a looping clip and a clip in the page going, and a
// timer sets another tone and clip going later
const SOUND = `<!doctype html><button id=go>Play</button><script>
  const wav = () => { const n = 8000, b = new ArrayBuffer(44 + n * 2), v = new DataView(b), s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 4) * 8000, true);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" })); };
  const src = wav(), S = window.S = {};
  const tone = () => { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); g.gain.value = 0; o.connect(g).connect(c.destination); o.start(); return c; };
  const clip = () => { const a = new Audio(src); a.loop = true; a.volume = 0; a.play().catch(() => {}); return a; };
  go.addEventListener("click", () => {
    S.tone = tone(); S.clip = clip();
    const el = document.createElement("audio"); el.src = src; el.loop = true; el.volume = 0; document.body.append(el); el.play().catch(() => {}); S.inPage = el;
    setTimeout(() => { S.later = tone(); S.laterClip = clip(); }, 2500);
  });
</script>`;
let board, browser, page, home;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const agent = (method, route, body) => fetch(board.origin + route, { method, body });

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-kept-home-"));
  board = await startBoard({ seed: SEED, config: { navigator_lanes: ["facilitator", "pastureland"] }, extra: ["hover-labels.js"], env: { HOME: home } });
  await agent("POST", "/magic?box=k2&kind=html", SOUND);
  await agent("POST", "/magic?box=k3&kind=text", "Words in a box.");
  await agent("POST", "/magic?box=k4&kind=text", "Another project's box.");
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--disable-background-networking"] });
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => addEventListener("keydown", e => { (window.boardKeys = window.boardKeys || []).push(e.key); }, true));
});
after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// the board's box on either page: MB on the Mac, PB on the phone
const box = phone => phone ? "PB" : "MB";
async function onPage(phone) {
  if (phone) {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true });
    await page.goto(board.origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState && typeof PB !== "undefined", { timeout: 60000 });
  } else {
    await page.setViewport({ width: 1512, height: 949 });
    await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState && ownerReady, { timeout: 60000 });
  }
  await page.evaluate(() => setTab("facilitator"));
  await pause(1000);
}
// the card on screen with its box shown, on the phone out in the drawer by the
// period's own way (drawerKey), and the page in it, loaded
async function open(id, phone) {
  await page.evaluate(id => select(id), id);
  await page.waitForFunction((id, B, phone) => { const b = eval(B); return b.id === id && (phone ? b.drawn : b.el.classList.contains("on") && b.el.style.visibility !== "hidden"); },
    { timeout: 15000 }, id, box(phone), phone);
  if (phone) {
    await page.evaluate(() => { if (!(drawerOpen() && tickets.classList.contains("boxface"))) drawerKey(null, true); });
    await page.waitForFunction(() => drawerOpen() && tickets.classList.contains("boxface"), { timeout: 15000 });
  } else await page.waitForFunction(() => !MB.el.classList.contains("rising"), { timeout: 15000 });
  await pause(700);
}
// the page in the box's shown holder (MagicBox.holderDoc) holding marker
async function shown(marker) {
  for (let i = 0; i < 100; i++) {
    for (const f of page.frames()) {
      if (f.detached || !f.parentFrame() || f.parentFrame() === page.mainFrame()) continue;
      const holder = await f.parentFrame().frameElement().catch(() => null);
      const inBox = holder && await holder.evaluate(e => e.classList.contains("mbframe") && !!e.closest("#magicbox, #mbface")).catch(() => false);
      if (inBox && await f.$(marker).catch(() => null)) return f;
    }
    await pause(100);
  }
  throw new Error("the box shows no page with " + marker);
}
// a click as the person's: the pointer comes over the box first, so its cover
// comes off, at the element's place on screen (its holder's place on the
// board, which the page fills, and its own in the page)
async function click(frame, selector) {
  const at = await page.evaluate(() => { const r = document.querySelector("#magicbox iframe.mbframe, #mbface iframe.mbframe").getBoundingClientRect(); return [r.x, r.y]; });
  const r = await frame.evaluate(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, selector);
  await page.mouse.move(at[0] + r[0], at[1] + r[1], { steps: 4 });
  await pause(250);
  await page.mouse.click(at[0] + r[0], at[1] + r[1]);
  await pause(150);
}
const field = async frame => { try { return await frame.$eval("#field", e => e.dataset.keys || ""); } catch (_) { return null; } };

for (const phone of [false, true]) {
  const where = phone ? "the phone" : "the Mac";
  test(`${where}: a page typed in gives the keys back to the board, whichever way its box goes`, async () => {
    await onPage(phone);
    const ways = ["the agent closes the box", "the card is done", "another card", "another project", "expanded, the agent closes the box"];
    for (const [n, way] of ways.entries()) {
      await agent("POST", "/done?box=k1&v=0");
      await agent("POST", "/magic?box=k1&kind=html&widget=demo", TYPE + "<!-- " + n + " -->");
      await page.evaluate(() => { setTab("facilitator"); poll(); });
      await pause(1200);
      await open("k1", phone);
      const frame = await shown("#field");
      await frame.waitForFunction(() => document.readyState === "complete");
      if (way.startsWith("expanded")) {
        await page.evaluate(phone => phone ? phoneMagicBig(document.activeElement) : magicBig(document.activeElement), phone);
        await pause(900);
      }
      await click(frame, "#field");
      await page.keyboard.type("ab");
      assert.equal(await field(frame), "ab", way + ": typed in the page");
      if (way.includes("agent closes")) await agent("POST", "/magic/close?box=k1");
      else if (way === "the card is done") await agent("POST", "/done?box=k1");
      else if (way === "another card") await page.evaluate(() => select("k3"));
      else await page.evaluate(() => setTab("pastureland"));
      await page.evaluate(() => poll());
      await page.waitForFunction(B => eval(B).id !== "k1", { timeout: 15000 }, box(phone));
      await pause(phone ? 300 : 1300);   // the Mac's box sinks for a second before it goes
      const focus = await page.evaluate(() => document.activeElement === document.body || !document.activeElement);
      await page.evaluate(() => { window.boardKeys = []; });
      await page.keyboard.type("Z");
      await pause(200);
      assert.equal(focus, true, way + ": the keys are the board's");
      assert.deepEqual(await page.evaluate(() => window.boardKeys), ["Z"], way + ": the next key reached the board");
      const got = await field(frame);
      assert.ok(got === null || got === "ab", way + ": the hidden page heard " + got);
    }
  });

  test(`${where}: a page left makes no sound, and goes on as its card is shown again`, async () => {
    await onPage(phone);
    await open("k2", phone);
    const frame = await shown("#go");
    await frame.waitForFunction(() => document.readyState === "complete");
    await click(frame, "#go");
    await pause(700);
    // read in the page at once, not off a timer of its own, which Chrome slows in a hidden frame
    const read = () => frame.evaluate(() => ({ tone: S.tone && S.tone.state, clip: S.clip && !S.clip.paused, inPage: S.inPage && !S.inPage.paused,
      later: S.later ? S.later.state : null, laterClip: S.laterClip ? !S.laterClip.paused : null, at: S.tone ? S.tone.currentTime : 0 }));
    const playing = await read();
    assert.deepEqual([playing.tone, playing.clip, playing.inPage], ["running", true, true]);
    await page.evaluate(() => select("k3"));
    await pause(700);
    const left = await read();
    assert.deepEqual([left.tone, left.clip, left.inPage], ["suspended", false, false], "stopped as the card is left");
    // the timer's sound, set going while the page is hidden, waits
    await pause(2600);
    const hidden = await read();
    assert.deepEqual([hidden.tone, hidden.clip, hidden.inPage, hidden.later, hidden.laterClip], ["suspended", false, false, "suspended", false]);
    assert.equal(hidden.at, left.at, "no sound was made meanwhile");
    // the card again: the same page, its sound going on
    await open("k2", phone);
    await pause(500);
    const back = await read();
    assert.deepEqual([back.tone, back.clip, back.inPage, back.later, back.laterClip], ["running", true, true, "running", true]);
    assert.ok(back.at > hidden.at, "sounding again");
  });
}
