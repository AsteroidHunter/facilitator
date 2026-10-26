// A magic box picture in a real Chrome, on the Mac board and the phone page.
// The box shows the picture from its own address, which the server sandboxes,
// and never from a copy the page made in its own origin, so the picture
// opened by itself (as "open image in new tab" or a drag out does) runs in no
// origin and reads no storage. The box still takes the picture's shape in the
// first frame it is shown, with the picture in it, and a new revision shows
// the new picture. Its own headless Chrome on a copy of the board on spare ports.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SEED = { title: "box picture browser fixture", items: [
  { id: "p1", bucket: "now", title: "Picture card", owner: "facilitator" },
  { id: "p2", bucket: "now", title: "Plain card", owner: "facilitator" },
] };
// a drawing with its own width and height, which is the shape the box takes
const svg = (w, h, fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
  `<rect width="${w}" height="${h}" fill="${fill}"/><circle cx="${w / 2}" cy="${h / 2}" r="${h / 3}" fill="#f2c94c"/></svg>`;
const ADDRESS = /^\/magic\/img\?box=p1&rev=\d+$/;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

let board, browser, profile, home;

const fill = async (w, h, colour) => {
  const r = await fetch(`${board.origin}/magic?box=p1&kind=image&title=Drawing`, { method: "POST", body: svg(w, h, colour) });
  assert.equal(r.status, 200);
  return (await r.json()).rev;
};

// every animation frame from now on, what the box shows: whether it is on
// screen (on the Mac board the box is on and not hidden; on the phone it is
// out in the drawer and not hidden), its picture's address and whether it is
// in, and the box's and the picture's sizes
function watchFrames(phone) {
  window.boxFrames = [];
  const frame = () => {
    const box = document.querySelector(phone ? "#mbface" : "#magicbox"), img = box && box.querySelector(".mbimg");
    const r = box && box.getBoundingClientRect(), p = img && img.getBoundingClientRect();
    const out = phone ? tickets.classList.contains("boxface") && tickets.classList.contains("open") : box && box.classList.contains("on");
    window.boxFrames.push({ shown: !!box && !!out && box.style.visibility !== "hidden",
      src: img ? img.getAttribute("src") : null, complete: !!img && img.complete, natural: img ? img.naturalWidth : 0,
      w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0, pw: p ? p.width : 0, ph: p ? p.height : 0 });
    if (window.boxFrames.length < 90) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// the first frame the box is on screen: its picture is in and drawn at the
// picture's own shape (w by h), and the box keeps that size from then on
function firstFrame(frames, w, h) {
  const at = frames.findIndex(f => f.shown);
  assert.ok(at >= 0, "the box never came on screen");
  const first = frames[at];
  assert.ok(first.complete && first.natural === w, `the box came on screen without its picture: ${JSON.stringify(first)}`);
  assert.ok(Math.abs(first.pw / first.ph - w / h) < 0.02, `the picture is not at its own shape: ${JSON.stringify(first)}`);
  for (const f of frames.slice(at).filter(f => f.shown))
    assert.deepEqual([f.w, f.h], [first.w, first.h], "the box changed size after it was shown");
  return first;
}

// a picture's address opened as a page of its own, as a new tab would open it
async function openAlone(src) {
  const tab = await browser.newPage();
  const response = await tab.goto(new URL(src, board.origin).href, { waitUntil: "load" });
  const seen = await tab.evaluate(() => ({ origin: self.origin,
    storage: (() => { try { return typeof localStorage.length === "number"; } catch (e) { return false; } })() }));
  const policy = response.headers()["content-security-policy"] || null;
  await tab.close();
  return { ...seen, policy };
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-box-picture-home-"));
  board = await startBoard({ seed: SEED, extra: ["hover-labels.js"], env: { HOME: home } });
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-box-picture-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking"] });
  await fill(300, 150, "#2d6a4f");
});

after(async () => {
  if (browser) await browser.close();
  if (board) await board.stop();
  for (const dir of [profile, home]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const shown = {};

test("the Mac board shows a box picture from its own address, at its own shape the moment it is shown", async () => {
  const page = shown.mac = await browser.newPage();
  await page.setViewport({ width: 1512, height: 949 });
  await page.goto(board.origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
  // on another card while the picture is read ahead, as it is for every open box
  await page.evaluate(() => select("p2"));
  await page.waitForFunction(() => [...MB.pictures.values()].some(v => v && v.natural), { timeout: 15000 });
  await page.evaluate(watchFrames, false);
  await page.evaluate(() => select("p1"));
  await page.waitForFunction(() => window.boxFrames.length >= 60, { timeout: 10000 });
  const kept = await page.evaluate(() => [...MB.pictures.values()].map(v => v.src));
  assert.ok(kept.every(src => ADDRESS.test(src)), `the picture is kept as a copy of the page's own: ${kept}`);
  const first = firstFrame(await page.evaluate(() => window.boxFrames), 300, 150);
  assert.match(first.src, ADDRESS, `the box shows a copy of the page's own: ${first.src}`);
  assert.match(await page.$eval("#magicbox img.mbimg", img => img.getAttribute("src")), ADDRESS);
});

test("the phone page shows a box picture from its own address, at its own shape the moment it comes out", async () => {
  const page = shown.phone = await browser.newPage();
  await page.setViewport(PHONE);
  await page.goto(`${board.origin}/m?box=p1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof PB !== "undefined" && PB.drawn && PB.id === "p1", { timeout: 15000 });
  await page.evaluate(watchFrames, true);
  // the box brought out in the drawer, as control+shift+period brings it
  await page.evaluate(() => drawerKey(null, true));
  await page.waitForFunction(() => window.boxFrames.length >= 60, { timeout: 10000 });
  const first = firstFrame(await page.evaluate(() => window.boxFrames), 300, 150);
  assert.match(first.src, ADDRESS, `the box shows a copy of the page's own: ${first.src}`);
  assert.match(await page.evaluate(() => PB.seen.src), ADDRESS);
});

test("the picture each page shows, opened by itself, runs in no origin and reads no storage", async () => {
  for (const [name, page, sel] of [["Mac", shown.mac, "#magicbox img.mbimg"], ["phone", shown.phone, "#mbface img.mbimg"]]) {
    const src = await page.$eval(sel, img => img.src);
    assert.deepEqual(await openAlone(src), { origin: "null", storage: false, policy: "sandbox" }, `${name}: ${src}`);
    assert.ok(!src.startsWith("blob:"), `${name}: the box shows a copy of the page's own: ${src}`);
  }
});

test("a new revision shows the new picture at its own shape, and the old one is let go", async () => {
  const mac = shown.mac, phone = shown.phone;
  const rev = await fill(200, 200, "#9b2226");
  const want = `/magic/img?box=p1&rev=${rev}`;
  // both pages are open at once, so one is a page in the background, where
  // animation frames do not run: the waits below read on a timer instead
  const every = { polling: 100, timeout: 15000 };
  // the Mac board, with the card on screen
  await mac.waitForFunction(src => {
    const img = document.querySelector("#magicbox img.mbimg"), box = document.getElementById("magicbox");
    return img && img.getAttribute("src") === src && img.complete && img.naturalWidth === 200 && box.style.visibility !== "hidden";
  }, every, want);
  const macPicture = await mac.$eval("#magicbox img.mbimg", img => { const r = img.getBoundingClientRect(); return r.width / r.height; });
  assert.ok(Math.abs(macPicture - 1) < 0.02, `the new picture is not at its own shape: ${macPicture}`);
  await mac.waitForFunction(() => !MB.pictures.has("p1:1"), every);
  // the phone, with the box out in the drawer
  await phone.waitForFunction(src => {
    const img = document.querySelector("#mbface img.mbimg");
    return img && img.getAttribute("src") === src && img.complete && img.naturalWidth === 200;
  }, every, want);
  const phonePicture = await phone.$eval("#mbface img.mbimg", img => { const r = img.getBoundingClientRect(); return r.width / r.height; });
  assert.ok(Math.abs(phonePicture - 1) < 0.02, `the new picture is not at its own shape: ${phonePicture}`);
  assert.equal(await phone.evaluate(() => PB.seen.src), want);
  assert.equal(await phone.evaluate(() => [...PB.bodies.values()].some(h => h.seen && h.seen.src.endsWith("rev=1"))), false,
    "the old revision's picture is still held");
});
