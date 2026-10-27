// Settings' Shut down Facilitator on the Mac board, in Chrome. The button
// shows in Settings, in a section of its own. With agents listening on two
// projects the click asks first, naming the two; Cancel leaves the board
// running, and Shut down stops it and the page says it is shut down and how to
// start it again. With no agent the board shuts down at once. A window opened
// straight on the board, as facilitator run opens one, closes itself.
//
// Each board is a locked fixture copy with the command beside it
// (shutdown-fixture.cjs). Nothing here launches a browser: it connects to the
// test Chrome already running with a remote debugging port (CHROME_CDP_URL,
// http://127.0.0.1:9222 unless set), makes every tab with Target.createTarget
// in the background in the browser's own context, never brings one forward,
// closes only the tabs it made, clears what its boards' pages kept for their
// own origins (the window cookie among them) and leaves the browser running. SHUTDOWN_EVIDENCE names a folder for a picture
// of the button, the question and the shut down words.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { request } = require("node:http");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const fixture = require("./shutdown-fixture.cjs");
const { raw, key, canBind, events, called } = fixture;

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const EVIDENCE = process.env.SHUTDOWN_EVIDENCE || "";
const VIEW = { width: 1512, height: 949 };
const QUESTION = "The board stops: the agents listening on 2 projects lose it, and your phone cannot reach it "
  + "until you open Facilitator again.";
let browser, session;
const boards = [], made = [];

before(async () => {
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  } catch (error) {
    throw new Error(`could not connect to the test Chrome at ${CDP_URL}; nothing here starts one. ${error.message}`);
  }
  session = await browser.target().createCDPSession();
  if (EVIDENCE) await mkdir(EVIDENCE, { recursive: true });
});
after(async () => {
  for (const targetId of made) await session.send("Target.closeTarget", { targetId }).catch(() => {});
  // what each board's page left in the browser, its cookie, its storage and
  // its service worker, goes with it, for that board's own origin alone
  for (const board of boards) {
    if (session) await session.send("Storage.clearDataForOrigin", { origin: board.origin, storageTypes: "all" })
      .catch(() => {});
    if (browser) await browser.deleteMatchingCookies({ name: `facilitator_window_${board.port}`, domain: "127.0.0.1" })
      .catch(() => {});
    await board.end();
  }
  if (session) await session.detach().catch(() => {});
  if (browser) await browser.disconnect();
});

async function shutdownBoard() {
  const board = await fixture.shutdownBoard();
  boards.push(board);
  return board;
}
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

// clicks are the pointer's, sent to this tab alone (Input.dispatchMouseEvent),
// which moves no cursor and brings nothing forward

// a condition read from here, every 100ms, until it holds
async function until(page, fn, what, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() > deadline) throw new Error(`waited ${timeout}ms for ${what}`);
    await settle(100);
  }
}

// the board's window, opened as facilitator run opens it: on a launch code,
// which sets the window's cookie and sends it on to /. The tab is made in the
// background and told it has the focus, a setting on this one tab that moves
// no window, so the board draws in it. kept: the window's own close is written
// down instead of closing it, so the words it leaves can be read and kept
async function open(board, { kept = true } = {}) {
  const asked = await raw(board, "POST", "/window/launch", { headers: key(board) });
  assert.equal(asked.status, 200, asked.text);
  const { targetId } = await session.send("Target.createTarget",
    { url: `${board.origin}/?launch=${JSON.parse(asked.text).code}`, background: true, newWindow: false });
  made.push(targetId);
  const target = await browser.waitForTarget(t => t._targetId === targetId, { timeout: 20000 });
  const page = await target.page();
  const cdp = await target.createCDPSession();
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.setViewport(VIEW);
  if (kept) await page.evaluateOnNewDocument(() => { window.closes = 0; window.close = () => { window.closes++; }; });
  await page.reload({ waitUntil: "domcontentloaded" });
  await until(page, () => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" &&
    !!lastState && !document.getElementById("loading"), "the board to draw");
  return page;
}

// Settings, open on its Shut down section, with the page faded in
async function toShutdown(page) {
  await page.click("#setbtn");
  await until(page, () => !!document.querySelector(".sp-veil.open .sp-item[data-section='shutdown']"), "Settings");
  await page.click(".sp-item[data-section='shutdown']");
  await until(page, () => {
    const b = document.getElementById("setshutdown"), r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b;
  }, "the Shut down button");
  await settle(400);
}

// what the shut down's pop-up shows: whether it is up, its words and its buttons
function popup(page) {
  return page.evaluate(() => {
    const title = document.getElementById("sdtitle");
    const veil = title.closest(".up-veil"), shown = el => !el.hidden && !el.closest("[hidden]");
    return { open: veil.classList.contains("open"), title: title.textContent,
             line: document.getElementById("sdline").textContent,
             buttons: [...veil.querySelectorAll("button")].filter(shown).map(b => b.textContent) };
  });
}
function press(page, words) {
  return page.click(`.up-box:has(#sdtitle) ${words === "Cancel" ? ".up-later" : ".up-yes"}`);
}

async function picture(page, name) {
  if (EVIDENCE) await page.screenshot({ path: path.join(EVIDENCE, name) });
}

// an agent's listen, as the skill's helper makes it: the key and no page headers
function listen(board, owner) {
  return new Promise(resolve => {
    const req = request({ host: "127.0.0.1", port: board.port, path: `/wait?owner=${owner}&timeout=90&agent=fixture`,
      headers: { Host: `127.0.0.1:${board.port}`, ...key(board) } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", error => resolve({ error: error.code || error.message }));
    });
    req.on("error", error => resolve({ error: error.code || error.message }));
    req.end();
  });
}

async function gone(board, why) {
  const deadline = Date.now() + 15000;
  while (board.child.exitCode === null && board.child.signalCode === null && Date.now() < deadline) await settle(50);
  assert.ok(board.child.exitCode !== null || board.child.signalCode !== null, `${why}: the board is still running`);
  for (let i = 0; i < 40 && !(await canBind(board.port + 1)); i++) await settle(50);
  assert.equal(await canBind(board.port), true, `${why}: the board's port is still held`);
  assert.equal(await canBind(board.port + 1), true, `${why}: the phone's port is still held`);
  const said = (await events(board)).filter(e => e.kind === "shutdown").map(e => e.reason);
  assert.deepEqual(said, ["board"], `${why}: the log does not say shutdown reason=board`);
  assert.deepEqual((await called(board)).filter(c => c.startsWith("osascript")), [], `${why}: Chrome was asked`);
}

async function running(board, why) {
  assert.equal(board.child.exitCode, null, `${why}: the board ended`);
  assert.equal((await raw(board, "GET", "/state", { headers: key(board) })).status, 200, `${why}: the board does not answer`);
  assert.deepEqual((await events(board)).filter(e => e.kind === "shutdown"), [], `${why}: a shut down was started`);
}

test("with agents listening on two projects it asks first; Cancel keeps the board, Shut down stops it", async () => {
  const board = await shutdownBoard();
  const listens = [listen(board, "facilitator"), listen(board, "pastureland")];
  for (let i = 0; i < 100; i++) {
    const st = JSON.parse((await raw(board, "GET", "/state", { headers: key(board) })).text);
    if (st.listening.facilitator && st.listening.pastureland) break;
    await settle(50);
  }
  const page = await open(board);
  await toShutdown(page);
  assert.equal(await page.$eval("#setshutdown", b => b.textContent), "Shut down Facilitator");
  assert.deepEqual(await page.$$eval(".sp-item", items => items.map(i => i.textContent)),
                   ["Profile", "Appearance", "Editor", "Improvements", "Bin", "Shut down"]);
  await picture(page, "shutdown-button.png");

  await page.click("#setshutdown");
  await until(page, () => document.getElementById("sdtitle").textContent === "Quit Facilitator?" &&
    document.getElementById("sdtitle").closest(".up-veil").classList.contains("open"), "the question");
  await settle(400);
  assert.deepEqual(await popup(page), { open: true, title: "Quit Facilitator?", line: QUESTION,
                                        buttons: ["Cancel", "Shut down"] });
  await picture(page, "shutdown-question.png");

  await press(page, "Cancel");
  await until(page, () => !document.getElementById("sdtitle").closest(".up-veil").classList.contains("open"), "Cancel");
  await until(page, () => !document.getElementById("setshutdown").disabled, "the button back");
  await settle(1500);
  await running(board, "after Cancel");
  assert.equal(await page.evaluate(() => window.closes), 0, "the window was closed after Cancel");

  await page.click("#setshutdown");
  await until(page, () => document.getElementById("sdtitle").textContent === "Quit Facilitator?" &&
    document.getElementById("sdtitle").closest(".up-veil").classList.contains("open"), "the question again");
  await press(page, "Shut down");
  await until(page, () => document.getElementById("sdtitle").textContent === "Facilitator is shut down", "the shut down words");
  await settle(400);
  assert.deepEqual(await popup(page), { open: true, title: "Facilitator is shut down",
                                        line: "To start it again, run facilitator run in Terminal.", buttons: [] });
  assert.equal(await page.evaluate(() => window.closes), 1, "the window did not close itself");
  await picture(page, "shutdown-message.png");
  await gone(board, "after Shut down");
  // the agents' listens were answered as a stop answers them, and the page
  // says nothing of an unreachable board once it knows it shut it down
  for (const heard of await Promise.all(listens)) assert.ok(heard.error || heard.status === 200, JSON.stringify(heard));
  await settle(4500);
  assert.equal(await page.evaluate(() => document.body.classList.contains("offline")), false,
               "the unreachable banner came up over the shut down words");
  assert.equal((await popup(page)).title, "Facilitator is shut down");
});

test("with no agent listening or holding a card it shuts down at once", async () => {
  const board = await shutdownBoard();
  const page = await open(board);
  await toShutdown(page);
  await page.click("#setshutdown");
  // no question is answered here: one that came up would hold the shut down
  await until(page, () => document.getElementById("sdtitle").textContent === "Facilitator is shut down", "the shut down words");
  assert.deepEqual(await popup(page), { open: true, title: "Facilitator is shut down",
                                        line: "To start it again, run facilitator run in Terminal.", buttons: [] });
  assert.equal(await page.evaluate(() => window.closes), 1);
  await gone(board, "at once");
});

test("a window opened straight on the board closes itself once the board has shut down", async () => {
  const board = await shutdownBoard();
  const page = await open(board, { kept: false });
  assert.equal(await page.evaluate(() => history.length), 1, "the window has more than one history entry");
  await toShutdown(page);
  const closed = new Promise(resolve => page.once("close", () => resolve(true)));
  await page.click("#setshutdown");
  assert.equal(await Promise.race([closed, settle(20000).then(() => false)]), true, "the window did not close");
  await gone(board, "the window that closed itself");
});
