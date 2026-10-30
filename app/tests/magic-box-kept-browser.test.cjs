// An agent's page kept out of sight once its card is left (magicView's keep),
// in a real browser, on the Mac board and on the phone page. Typed in, and its
// box then gone without a click on the board (the agent closes it, the card is
// done, another card or project is put on screen, or it goes while expanded),
// the page has given the keys back and the next key is the board's. Set
// sounding, and its card left, its Web Audio and its clips are muted and run
// on, its audio clock keeping time, and as the card is shown again what still
// sounds is heard. A sound a timer sets off while it is hidden plays unheard
// and is over, and is never heard when the card comes back. What each page's
// Web Audio sends to the speakers is measured instead of heard, and its clips
// are at zero volume, so nothing is heard. Its own headless Chrome on a copy
// of the board on spare ports.
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
  { id: "k5", bucket: "now", title: "Beep card", owner: "facilitator" },
] };
// a widget the person types in, which notes every key it hears
const TYPE = `<!doctype html><textarea id=field></textarea><script>
  facilitator.ready().catch(() => {});
  addEventListener("keydown", e => { field.dataset.keys = (field.dataset.keys || "") + e.key; }, true);
</script>`;
// a short clip, made in the page: a looping one, or one of half a second
const WAV = `const wav = (n = 8000) => { const b = new ArrayBuffer(44 + n * 2), v = new DataView(b), s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 4) * 8000, true);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" })); };
  // a tone loud enough to measure only where the test measures it (__tap), and silent otherwise
  const LOUD = window.__tap ? 0.05 : 0;`;
// a click sets a tone, a looping clip and a clip in the page going, and a
// timer sets another tone and clip going later
const SOUND = `<!doctype html><button id=go>Play</button><script>
  ${WAV}
  const src = wav(), S = window.S = {};
  const tone = () => { const c = new AudioContext(), o = c.createOscillator(), g = c.createGain(); g.gain.value = LOUD; o.connect(g).connect(c.destination); o.start(); return c; };
  const clip = () => { const a = new Audio(src); a.loop = true; a.volume = 0; a.play().catch(() => {}); return a; };
  go.addEventListener("click", () => {
    S.tone = tone(); S.clip = clip();
    const el = document.createElement("audio"); el.src = src; el.loop = true; el.volume = 0; document.body.append(el); el.play().catch(() => {}); S.inPage = el;
    setTimeout(() => { S.later = tone(); S.laterClip = clip(); }, 2500);
  });
</script>`;
// a click makes a context with nothing sounding, and a timer three seconds on
// beeps three times and plays a clip of half a second, as a kitchen timer
// would: set off while the card is left, none of it is to be heard
const BEEP = `<!doctype html><button id=go>Start</button><script>
  ${WAV}
  const src = wav(4000), S = window.S = {};
  go.addEventListener("click", () => {
    const c = S.c = new AudioContext();
    S.ding = new Audio(src); S.ding.volume = 0;
    setTimeout(() => {
      const t = c.currentTime;
      for (let i = 0; i < 3; i++) { const o = c.createOscillator(), g = c.createGain(); g.gain.value = LOUD; o.connect(g).connect(c.destination); o.start(t + i * 0.15); o.stop(t + i * 0.15 + 0.1); }
      S.ding.play().catch(() => {});
      S.beepEnd = t + 0.4;
    }, 3000);
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
  await agent("POST", "/magic?box=k5&kind=html", BEEP);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--disable-background-networking"] });
  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => addEventListener("keydown", e => { (window.boardKeys = window.boardKeys || []).push(e.key); }, true));
  // in every page, ahead of the hush: what a context sends to its own output
  // goes to a meter in its place (__tap.peak, the loudest sample of about the
  // last two thirds of a second), and on to the speakers at nothing, and a
  // clip's muted is read as the browser has it (__tap.muted), past the page's own
  await page.evaluateOnNewDocument(() => {
    if (typeof AudioNode === "undefined") return;
    const join = AudioNode.prototype.connect, M = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted"), taps = new Map();
    AudioNode.prototype.connect = function connect(t) {
      if (!(t instanceof AudioDestinationNode)) return join.apply(this, arguments);
      let tap = taps.get(t);
      if (!tap) {
        const c = t.context, z = c.createGain();
        tap = c.createAnalyser(); tap.fftSize = 32768; z.gain.value = 0;
        join.call(tap, z); join.call(z, t); taps.set(t, tap);
      }
      join.call(this, tap);
      return t;
    };
    window.__tap = {
      peak: c => { const tap = taps.get(c.destination); if (!tap) return 0; const b = new Float32Array(tap.fftSize); tap.getFloatTimeDomainData(b); return b.reduce((m, x) => Math.max(m, Math.abs(x)), 0); },
      muted: m => M.get.call(m),
    };
  });
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
// the page's card left, and the board's frame for it out of sight, which it
// tells the page as it hides it (magicView's hide)
async function leave(frame) {
  const holder = await frame.parentFrame().frameElement();
  await page.evaluate(() => select("k3"));
  for (let i = 0; i < 100 && !await holder.evaluate(e => e.style.display === "none"); i++) await pause(50);
  assert.equal(await holder.evaluate(e => e.style.display), "none", "the page is kept, out of sight");
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

  test(`${where}: a page left is muted and runs on, and what still sounds is heard as its card is shown again`, async () => {
    await onPage(phone);
    await open("k2", phone);
    const frame = await shown("#go");
    await frame.waitForFunction(() => document.readyState === "complete");
    assert.equal(await frame.evaluate(() => !!window.__tap), true, "the page's output is measured, not heard");
    await click(frame, "#go");
    await pause(900);
    // read in the page at once, not off a timer of its own, which Chrome slows in a hidden frame
    const read = () => frame.evaluate(() => {
      const clip = m => m ? { on: !m.paused, muted: __tap.muted(m), says: m.muted } : null;
      return { tone: S.tone.state, at: S.tone.currentTime, loud: __tap.peak(S.tone), clip: clip(S.clip), inPage: clip(S.inPage),
        later: S.later ? { state: S.later.state, loud: __tap.peak(S.later) } : null, laterClip: clip(S.laterClip), wall: performance.now() / 1000 };
    });
    const playing = await read();
    const heard = { on: true, muted: false, says: false }, unheard = { on: true, muted: true, says: false };
    assert.equal(playing.tone, "running");
    assert.ok(playing.loud > 0.01, "the tone is heard: " + playing.loud);
    assert.deepEqual([playing.clip, playing.inPage], [heard, heard]);
    await leave(frame);
    await pause(900);
    // left: nothing is heard, nothing is stopped, and the page reads its own muted
    const left = await read();
    assert.equal(left.tone, "running", "the tone's context runs on");
    assert.ok(left.loud < 1e-4, "and is not heard: " + left.loud);
    assert.deepEqual([left.clip, left.inPage], [unheard, unheard], "the clips play on, muted");
    // the timer's sound, set going while the page is hidden, plays unheard too
    let hidden;
    for (let i = 0; i < 60 && !((hidden = await read()).later && hidden.laterClip && hidden.laterClip.on); i++) await pause(150);
    await pause(900);
    hidden = await read();
    assert.deepEqual([hidden.later && hidden.later.state, hidden.laterClip], ["running", unheard]);
    assert.ok(hidden.loud < 1e-4 && hidden.later.loud < 1e-4, "nothing heard while hidden");
    assert.ok(hidden.at - left.at > 0.8 * (hidden.wall - left.wall), "the page's audio clock keeps time while hidden");
    // the card again: the same page, heard as it is now
    await open("k2", phone);
    await pause(900);
    const back = await read();
    assert.deepEqual([back.tone, back.later.state], ["running", "running"]);
    assert.ok(back.loud > 0.01 && back.later.loud > 0.01, "what still sounds is heard: " + back.loud + ", " + back.later.loud);
    assert.deepEqual([back.clip, back.inPage, back.laterClip], [heard, heard, heard]);
  });

  test(`${where}: a sound a hidden page sets off is over unheard, and is never heard when its card comes back`, async () => {
    await onPage(phone);
    await open("k5", phone);
    const frame = await shown("#go");
    await frame.waitForFunction(() => document.readyState === "complete");
    assert.equal(await frame.evaluate(() => !!window.__tap), true, "the page's output is measured, not heard");
    await click(frame, "#go");
    // left at once, before the page's timer goes off
    await leave(frame);
    const read = () => frame.evaluate(() => ({ state: S.c.state, at: S.c.currentTime, loud: __tap.peak(S.c), end: S.beepEnd || null,
      ding: { on: !S.ding.paused, ended: S.ding.ended, muted: __tap.muted(S.ding) }, wall: performance.now() / 1000 }));
    let r = await read(), loudest = 0;
    const start = r;
    assert.equal(r.end, null, "hidden before the timer went off");
    // hidden: the beeps and the clip go off when the timer says, unheard, and are over
    for (let i = 0; i < 100 && !(r.end && r.at > r.end + 0.3 && r.ding.ended); i++) { await pause(150); r = await read(); loudest = Math.max(loudest, r.loud); }
    assert.ok(r.end, "the page's timer went off while it was hidden");
    assert.equal(r.state, "running");
    assert.ok(r.at > r.end + 0.3, "the beeps' time has passed, on the page's own clock");
    assert.ok(r.at - start.at > 0.8 * (r.wall - start.wall), "which kept time while hidden");
    assert.deepEqual(r.ding, { on: false, ended: true, muted: true }, "the clip played to its end, muted");
    assert.ok(loudest < 1e-4, "nothing was heard while hidden: " + loudest);
    // the card again: nothing held back plays
    await open("k5", phone);
    const shownAt = await read();
    loudest = 0;
    for (let i = 0; i < 10; i++) { await pause(150); r = await read(); loudest = Math.max(loudest, r.loud); }
    assert.ok(loudest < 1e-4, "nothing played as the card came back: " + loudest);
    assert.deepEqual(r.ding, { on: false, ended: true, muted: false }, "the clip is not played again");
    assert.ok(r.at - shownAt.at > 0.8 * (r.wall - shownAt.wall), "and the page's clock keeps time shown");
  });
}
