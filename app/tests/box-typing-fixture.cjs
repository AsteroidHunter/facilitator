// The typing box checks' board and background tabs.
//
// THIS IS NOT A TEST FILE. It is the harness the box-*-browser tests share.
//
// The board is a copy of the server on a free pair of ports in a throwaway
// folder (board-fixture.cjs), seeded with nothing but a standing card. The
// browser is one already running with a remote debugging port: nothing here
// launches, activates, brings forward or closes a browser. Every tab is made
// with CDP Target.createTarget({ background: true }) on the fixture's own url
// with a nonce in it, so the target that comes back is known for certain, and
// only the tabs made here are ever closed.
//
//   CHROME_CDP_URL   http://127.0.0.1:9222   the browser to connect to
"use strict";
const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { startBoard } = require("./board-fixture.cjs");

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const SEED = { title: "typing box fixture", items: [
  { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Invented." },
] };

const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

// formatted: whether the board turns the typed formatting on for its rows
async function start({ formatted = false } = {}) {
  // a home of its own, so nothing the server reads or writes is the machine's
  const home = await mkdtemp(path.join(tmpdir(), "facilitator-box-home-"));
  const board = await startBoard({ seed: SEED, config: { compose_format_default: !!formatted },
    env: { HOME: home } });
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null });
  const session = await browser.target().createCDPSession();
  const pages = new Set();
  let made = 0;

  async function api(route, body) {
    const response = await fetch(board.origin + route, { method: "POST", body });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  // a card in the open lane with one reply, so the board answers and the
  // card waits on the reader
  async function card(title, reply = "A reply to answer.") {
    const made = await api("/create?owner=facilitator", title);
    assert.equal(made.status, 200);
    if (reply) await api(`/reply?box=${made.body.id}`, reply);
    return made.body.id;
  }
  async function state() { return (await fetch(board.origin + "/state")).json(); }
  async function sentTexts(id) {
    const box = (await state()).boxes.find(entry => entry.id === id);
    return (box && box.pendingTexts) || [];
  }

  // one background tab on the board's own url, found by its nonce
  async function backgroundPage(href, nonce) {
    let stop = null, timer = null;
    const found = new Promise((resolve, reject) => {
      const onCreated = async target => {
        if (target.type() !== "page") return;
        for (let tries = 0; tries < 50; tries++) {
          if ((target.url() || "").includes(nonce)) {
            const page = await target.page().catch(() => null);
            if (page) { resolve(page); return; }
          }
          await settle(60);
        }
      };
      browser.on("targetcreated", onCreated);
      stop = () => browser.off("targetcreated", onCreated);
      timer = setTimeout(() => reject(new Error("no background target came back for " + nonce)), 30000);
    });
    try {
      await session.send("Target.createTarget", { url: href, background: true });
      return await found;
    } finally { clearTimeout(timer); stop(); }
  }

  // opts.fresh: the browser's storage for the board emptied first.
  // opts.fakeViewport: a stand-in visual viewport the phone keyboard is played on
  async function open(route, viewport, opts = {}) {
    const nonce = "boxcheck" + Date.now().toString(36) + (made++).toString(36);
    const href = board.origin + route + (route.includes("?") ? "&" : "?") + "boxcheck=" + nonce;
    const page = await backgroundPage(href, nonce);
    pages.add(page);
    // the tab's own first load is let finish before it is loaded again with
    // the hooks below, so nothing is asked of a page on its way out
    for (const deadline = Date.now() + 20000; ;) {
      const done = await page.evaluate(n => location.href.includes(n) && document.readyState === "complete", nonce)
        .catch(() => false);
      if (done) break;
      if (Date.now() > deadline) throw new Error("the background tab did not finish its first load");
      await settle(80);
    }
    const problems = [];
    await page.setViewport(viewport);
    // a background tab is hidden and unfocused, and the board keeps the caret
    // out of a page nobody is looking at. the tab is told it is the one in
    // front, inside its own renderer, which brings nothing forward
    const cdp = await page.target().createCDPSession();
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    if (opts.fakeViewport) await page.evaluateOnNewDocument(fakeViewport);
    if (opts.fresh !== false) await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    page.on("pageerror", error => problems.push("pageerror: " + error.message));
    page.on("console", message => {
      if (message.type() !== "error") return;
      const where = (message.location() && message.location().url) || "";
      // the copy leaves tokens.py out on purpose (fixture-auth.cjs), so the
      // home page's token chart is refused, which is nothing to do with typing
      if (!where.startsWith(board.origin) || /favicon|\/tokens\//.test(where)) return;
      problems.push("console: " + message.text() + " @ " + where);
    });
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await until(page, () => typeof lastState !== "undefined" && lastState !== null, "the board's state", 20000);
    return { page, problems };
  }
  async function reload(page) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await until(page, () => typeof lastState !== "undefined" && lastState !== null, "the board's state", 20000);
  }
  async function close(page) {
    pages.delete(page);
    try { await page.close(); } catch (e) {}
  }
  async function stop() {
    for (const page of [...pages]) await close(page);
    try { await session.detach(); } catch (e) {}
    await browser.disconnect();
    await board.stop();
    await rm(home, { recursive: true, force: true });
  }
  return { board, origin: board.origin, browser, api, card, state, sentTexts, open, reload, close, stop };
}

// a condition polled from here, which a background tab's own clock cannot slow
async function until(page, fn, what, timeout = 15000, arg) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    // a page between two loads has no context to ask, which is not an answer
    const ok = await page.evaluate(fn, arg).catch(error => { last = error; return false; });
    if (ok) return;
    if (Date.now() > deadline) throw new Error("waited " + timeout + "ms for " + what + (last ? " (" + last.message + ")" : ""));
    await settle(80);
  }
}

// the stand-in visual viewport the phone's keyboard is played with
function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, offsetTop: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => window.innerWidth });
  for (const key of ["offsetTop", "scale"]) Object.defineProperty(vv, key, { get: () => geom[key] });
  for (const key of ["offsetLeft", "pageTop", "pageLeft"]) Object.defineProperty(vv, key, { get: () => 0 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0) {
      geom.height = height; geom.offsetTop = offsetTop;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
}

// the Mac board's card made the one on screen and chosen
async function pickDesktop(page, id) {
  await until(page, cardId => typeof els !== "undefined" && !!els[cardId], "card " + id + " on the board", 15000, id);
  await page.evaluate(cardId => select(cardId), id);
  await until(page, cardId => !!document.querySelector(`#box-${cardId}.sel`), "card " + id + " selected", 10000, id);
}
async function pickPhone(page, id) {
  await until(page, cardId => !!document.querySelector(`#box-${cardId}.sel`), "phone card " + id + " selected", 15000, id);
}
// the row wearing its formatting editor, once the board has it on
async function editorOn(page) {
  await until(page, () => !!document.querySelector("article.box.sel .cffield"), "the editor on the row", 20000);
}

// the caret put in the selected card's row, asked again until it is there: a
// card just shown can still be settling, and a focus made then is let go
async function focusRow(page) {
  const sel = "article.box.sel textarea:not(.twin)";
  const deadline = Date.now() + 8000;
  for (;;) {
    const there = await page.evaluate(where => {
      const ta = document.querySelector(where);
      if (!ComposeFormat.focused(ta)) ta.focus({ preventScroll: true });
      return ComposeFormat.focused(ta);
    }, sel);
    if (there) { await settle(150); if (await page.evaluate(where => ComposeFormat.focused(document.querySelector(where)), sel)) return; }
    if (Date.now() > deadline) throw new Error("the row would not take the caret");
    await settle(120);
  }
}

// what the selected card's row says of itself, whichever face it wears
function row(page) {
  return page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    const ta = box.querySelector("textarea:not(.twin)");
    const shell = box.querySelector(".cffield");
    const seen = shell ? shell.querySelector(".cm-scroller") : ta;
    const r = seen.getBoundingClientRect();
    const cs = getComputedStyle(seen);
    const ph = shell ? shell.querySelector(".cm-placeholder") : null;
    const send = box.querySelector(".sendbtn");
    const id = box.id.slice(4);
    return {
      id, value: ta.value, start: ta.selectionStart, end: ta.selectionEnd,
      height: r.height, scrollHeight: seen.scrollHeight, clientHeight: seen.clientHeight,
      scrollTop: seen.scrollTop, lineHeight: parseFloat(getComputedStyle(ta).lineHeight),
      maxHeight: cs.maxHeight, formatted: !!shell,
      focused: ComposeFormat.focused(ta),
      placeholder: shell ? (ph ? ph.textContent : null) : ta.placeholder,
      placeholderShown: shell ? !!ph : ta.value === "",
      sendShown: send.classList.contains("show"),
      tray: box.querySelectorAll(".tray .tsq").length,
      draft: JSON.parse(localStorage.getItem("composedrafts") || "{}")[id] || null,
    };
  });
}

module.exports = { DESKTOP, PHONE, settle, until, start, pickDesktop, pickPhone, editorOn, focusRow, row };
