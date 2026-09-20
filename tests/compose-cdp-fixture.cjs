// The invented board, and the background tabs the compose checks read it in.
//
// THIS IS NOT A TEST FILE. It is the harness the compose-*-browser tests share,
// and it has to be copied along with them.
//
// HOW THE BROWSER IS USED. Nothing here launches, activates, brings forward or
// closes a browser. It CONNECTS to a Chrome that is already running with a
// remote debugging port, and every tab it needs is made with CDP
// Target.createTarget({ background: true }) on the browser's own session. The
// tab is created ON the fixture url it is going to read, with a nonce in the
// query so the target that comes back can be recognised for certain: the
// listener for targetcreated is hung before the target is asked for, and the
// page is the one whose url carries that nonce and no other. If no such target
// turns up, the helper says so and stops; it never picks a tab it cannot name.
// At the end the handle is disconnected and the browser is left standing.
//
//   CHROME_CDP_URL   http://127.0.0.1:9222   the browser to connect to
//   CHROME_CDP_WS    ws://...                used instead when it is set
//   COMPOSE_AUDIT_SHOTS  a directory         pictures, when a reader wants them
//
// The board is invented, seeded in a temp directory and served on an ephemeral
// port by a copy of server.py with its port patched. No live board, no real
// card, no port 8877, and none of the owner's own tabs are touched.
"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9222";
const CDP_WS = process.env.CHROME_CDP_WS || "";
const SHOTS = process.env.COMPOSE_AUDIT_SHOTS || "";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const ROW = "article.box.sel textarea";   // the card's typing row, whichever face it wears
const EDGE = 0.75;                        // px two edges may differ by and still be one edge
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];

const board = { browser: null, child: null, dir: "", origin: "", session: null, made: 0 };

function origin() { return board.origin; }

function settle(ms = 130) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function api(route, body) {
  const response = await fetch(board.origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function card(title, ...replies) {
  const made = await api("/create?owner=facilitator", title);
  assert.equal(made.status, 200);
  for (const reply of replies) await api(`/reply?box=${made.body.id}`, reply);
  return made.body.id;
}

async function sentTexts(id) {
  const state = await (await fetch(board.origin + "/state")).json();
  const box = state.boxes.find(entry => entry.id === id);
  return (box && box.pendingTexts) || [];
}

// every card an earlier check left is put out of the doing view, so each one
// walks only the cards it made itself
async function clearLane() {
  const state = await (await fetch(board.origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

// ---- the board itself -------------------------------------------------------

async function start() {
  board.dir = await mkdtemp(path.join(tmpdir(), "facilitator-compose-audit-"));
  await mkdir(path.join(board.dir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(board.dir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(board.dir, "server.py")));
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(board.dir, name));
  await mkdir(path.join(board.dir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(board.dir, "assets", name));
  }
  await writeFile(path.join(board.dir, "seed.json"), JSON.stringify({
    title: "compose audit fixture",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator",
        context: "Invented content for the fixture board." },
      { id: "1.1", bucket: "now", title: "A card in the other lane", owner: "pastureland",
        context: "Its own lane." },
    ],
  }));
  board.origin = "http://127.0.0.1:" + port;
  board.child = spawn(PYTHON, [path.join(board.dir, "server.py")], {
    cwd: board.dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(board.dir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [board.child.stdout, board.child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (board.child.exitCode !== null) throw new Error("fixture server exited early:\n" + output);
    try { if ((await fetch(board.origin + "/state")).ok) { ready = true; break; } } catch (error) {}
    await settle(30);
  }
  if (!ready) { await stopFixture(); throw new Error("fixture server did not start:\n" + output); }
  try {
    board.browser = await puppeteer.connect(CDP_WS
      ? { browserWSEndpoint: CDP_WS, defaultViewport: null }
      : { browserURL: CDP_URL, defaultViewport: null });
  } catch (error) {
    await stopFixture();
    throw new Error("could not connect to a running browser at " + (CDP_WS || CDP_URL) +
      ". Nothing here launches one: start Chrome with a remote debugging port and point " +
      "CHROME_CDP_URL or CHROME_CDP_WS at it. " + error.message);
  }
  // the browser's own session, which is where Target.createTarget lives
  board.session = await board.browser.target().createCDPSession();
  return board.origin;
}

async function stopFixture() {
  if (!board.child || board.child.exitCode !== null || board.child.signalCode !== null) return;
  const ended = new Promise(resolve => board.child.once("exit", resolve));
  board.child.kill("SIGTERM");
  const quit = await Promise.race([
    ended.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!quit) { board.child.kill("SIGKILL"); await ended; }
}

async function stop() {
  // the browser belongs to whoever is looking at it: the handle is let go of
  // and the browser is left exactly as it was found
  if (board.session) { try { await board.session.detach(); } catch (error) {} }
  if (board.browser) await board.browser.disconnect();
  board.browser = null;
  await stopFixture();
  if (board.dir) await rm(board.dir, { recursive: true, force: true });
}

// ---- one background tab, made on the url it is going to read ----------------

async function backgroundPage(url) {
  const browser = board.browser;
  const seen = [];
  let stopListening = null;
  let timer = null;
  const found = new Promise((resolve, reject) => {
    const onCreated = async target => {
      if (target.type() !== "page") return;
      let page = null;
      try { page = await target.page(); } catch (error) { return; }
      if (!page) return;
      // a target can answer with its opening url a moment after it is made, so
      // both faces of it are read, for a while, for the nonce this tab was
      // asked for. A target that never carries it is not this tab and is left
      // to whoever opened it
      for (let tries = 0; tries < 50; tries++) {
        const where = target.url() || page.url() || "";
        if (where.includes(url.nonce)) { resolve(page); return; }
        await settle(60);
      }
      seen.push(target.url() || page.url() || "");
    };
    browser.on("targetcreated", onCreated);
    stopListening = () => browser.off("targetcreated", onCreated);
    timer = setTimeout(() => reject(new Error(
      "no background target came back carrying " + url.nonce + ". Asked for " + url.href +
      "; page targets that turned up while waiting: " + JSON.stringify(seen))), 30000);
  });
  const done = () => {
    if (timer) clearTimeout(timer);
    if (stopListening) stopListening();
  };
  let targetId = null;
  try {
    ({ targetId } = await board.session.send("Target.createTarget",
      { url: url.href, background: true }));
  } catch (error) {
    found.catch(() => {});
    done();
    throw error;
  }
  try {
    const page = await found;
    page.__targetId = targetId;
    return page;
  } finally {
    done();
  }
}

// A condition polled from here rather than inside the page. Both work in a
// background target; polling from here keeps the wait independent of anything
// the page's own clock is doing.
async function until(page, fn, what, timeout = 30000, arg) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > deadline) throw new Error("waited " + timeout + "ms for " + what);
    await settle(120);
  }
}

// the stand-in visual viewport the phone's keyboard is played with
function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"])
    Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height; geom.offsetTop = offsetTop; geom.scale = scale;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
}

async function open(route, viewport, opts = {}) {
  const sep = route.includes("?") ? "&" : "?";
  const nonce = "cfaudit" + Date.now().toString(36) + (board.made++).toString(36);
  const url = { nonce, href: board.origin + route + sep + "cfaudit=" + nonce };
  const page = await backgroundPage(url);
  const problems = [];
  await page.setViewport(viewport);
  // The tab was made on the fixture's own url, so the hooks below have to be
  // hung and the page read again for them to be on its first script. Nothing
  // about this brings the tab forward.
  await page.evaluateOnNewDocument(setting => {
    try {
      localStorage.clear();
      if (setting !== null) localStorage.setItem("composeformat", setting);
    } catch (error) {}
  }, opts.setting === undefined ? null : opts.setting);
  if (opts.fakeViewport) await page.evaluateOnNewDocument(fakeViewport);
  page.on("console", message => {
    if (message.type() !== "error") return;
    const where = (message.location() && message.location().url) || "";
    // a browser the owner also uses carries console noise from extensions and
    // from pages this file never opened. Only the fixture's own scripts count.
    if (!where.startsWith(board.origin)) return;
    if (/favicon/.test(message.text() + " " + where)) return;
    problems.push("console: " + message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await until(page, () => typeof lastState !== "undefined" && lastState !== null,
    "the board to answer with its state", 20000);
  return { page, problems };
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

// ---- the row, whichever face it is wearing ----------------------------------

async function pickDesktopCard(page, id) {
  await until(page, cardId => typeof els !== "undefined" && !!els[cardId],
    "the card to reach the board", 15000, id);
  await page.evaluate(cardId => select(cardId), id);
  await until(page, cardId => !!document.querySelector(`#box-${cardId}.sel`),
    "the card to be the picked one", 10000, id);
}

async function pickPhoneCard(page, id) {
  await until(page, cardId => !!document.querySelector(`#box-${cardId}.sel`),
    "the phone card to be the picked one", 15000, id);
}

async function editorOn(page, selector = "article.box.sel .cffield") {
  await until(page, where => !!document.querySelector(where),
    "the editor to stand in for the row (" + selector + ")", 30000, selector);
}

// The layer only puts raw markers back while the row is awake, and it wakes on
// a focus event. Writing the row's value builds the editor's state afresh and
// leaves it asleep however the caret stands, so the words go in first and the
// caret is taken afterwards.
async function lay(page, text, selector = ROW) {
  await page.evaluate(([where, value]) => {
    const row = document.querySelector(where);
    row.value = value;
    row.dispatchEvent(new Event("input", { bubbles: true }));
    row.blur();
  }, [selector, text]);
  await page.evaluate(where => document.querySelector(where).focus(), selector);
  await until(page, where => ComposeFormat.focused(document.querySelector(where)),
    "the prepared row to hold the caret", 10000, selector);
  await settle(180);
}

function caretTo(page, from, to = from, selector = ROW) {
  return page.evaluate(([where, a, b]) => {
    document.querySelector(where).setSelectionRange(a, b);
  }, [selector, from, to]);
}

// what the row holds and what is actually drawn on it. textContent and not
// innerText: a replaced range is out of the DOM altogether, so what is left in
// the line is exactly the characters the reader can see, and a painted bullet
// is a pseudo element that was never in it either way.
function rowRead(page, selector = ROW) {
  return page.evaluate(where => {
    const row = document.querySelector(where);
    const shell = row.closest(".cffield") || document;
    const content = shell.querySelector(".cm-content");
    const value = row.value == null ? row.textContent : row.value;
    const painted = (node, pseudo) => {
      const style = getComputedStyle(node, pseudo || null);
      return style.webkitTextFillColor || style.color;
    };
    return {
      payload: value,
      from: row.selectionStart, to: row.selectionEnd,
      picked: row.selectionStart == null ? null
        : String(value).slice(row.selectionStart, row.selectionEnd),
      angles: content ? (content.textContent.match(/>/g) || []).length : null,
      italic: content ? [...content.querySelectorAll(".cf-em")].map(n => n.textContent) : [],
      strong: content ? [...content.querySelectorAll(".cf-strong")].map(n => n.textContent) : [],
      lines: !content ? [] : [...content.querySelectorAll(".cm-line")].map(line => {
        const style = getComputedStyle(line);
        const box = line.getBoundingClientRect();
        const words = line.querySelector(".cf-first");
        return {
          text: line.textContent,
          quote: line.classList.contains("cf-quote"),
          item: line.classList.contains("cf-li"),
          bullets: line.querySelectorAll(".cf-bullet").length,
          border: parseFloat(style.borderLeftWidth) || 0,
          padding: parseFloat(style.paddingLeft) || 0,
          left: box.left, top: box.top, height: box.height,
          ink: painted(line),
          wordInk: words ? painted(words) : null,
          markers: [...line.querySelectorAll(".cf-mark")].map(mark => ({
            text: mark.textContent,
            bullet: mark.classList.contains("cf-bullet"),
            ink: painted(mark),
            pseudoInk: painted(mark, "::before"),
            content: getComputedStyle(mark, "::before").content,
            width: mark.getBoundingClientRect().width,
            left: mark.getBoundingClientRect().left,
          })),
        };
      }),
    };
  }, selector);
}

// where a known run of the reader's own words actually starts, found by the
// words themselves and never by a span the drawing puts around anything
function wordsAt(page, needle, selector = ROW) {
  return page.evaluate(([where, text]) => {
    const row = document.querySelector(where);
    const shell = row.closest(".cffield") || document;
    const line = [...shell.querySelectorAll(".cm-line")]
      .find(node => node.textContent.includes(text));
    if (!line) return null;
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walk.nextNode())) nodes.push(node);
    let offset = line.textContent.indexOf(text);
    let at = 0;
    while (at < nodes.length && offset >= nodes[at].data.length) {
      offset -= nodes[at].data.length;
      at++;
    }
    if (at === nodes.length) return null;
    const range = document.createRange();
    range.setStart(nodes[at], offset);
    range.setEnd(nodes[at], Math.min(offset + 1, nodes[at].data.length));
    const box = range.getBoundingClientRect();
    const style = getComputedStyle(line);
    const lineBox = line.getBoundingClientRect();
    return {
      left: box.left, top: box.top, width: box.width, height: box.height,
      source: line.textContent,
      quote: line.classList.contains("cf-quote"),
      border: parseFloat(style.borderLeftWidth) || 0,
      // the x this line's own words are supposed to begin on
      column: lineBox.left + (parseFloat(style.borderLeftWidth) || 0) +
        (parseFloat(style.paddingLeft) || 0),
    };
  }, [selector, needle]);
}

module.exports = {
  DESKTOP, PHONE, ROW, EDGE, SHOTS,
  origin, settle, until, api, card, sentTexts, clearLane,
  start, stop, open, shot,
  pickDesktopCard, pickPhoneCard, editorOn, lay, caretTo, rowRead, wordsAt,
};
