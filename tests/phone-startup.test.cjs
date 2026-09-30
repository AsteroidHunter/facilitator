// The phone page's startup, driven headless in a standalone app window against
// its own fixture board: the curtain the installed page opens with, the globe
// that says whether the board has been reached, the red stop when it has not,
// and the one thing that takes the curtain down, which is a live reading that
// has been drawn and has stopped moving.
//
// Chrome only reports display-mode standalone in a real app window, so every
// installed-open test launches with --app. A plain tab is launched normally and
// must show no curtain at all.
//
// The board here is invented and lives in a temp directory. The launch image's
// squid is a fixture PNG built in this file, not the product asset.
// Screenshots land under /tmp/m627-startup-shots unless M627_SHOTS says otherwise.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
// the read-only scope copy of the pastureland phone app, which is where the
// curtain's picture and its numbers were taken from. the one test that compares
// against it is skipped where it is not present, so this file still runs from a
// checkout on its own
const PASTURELAND_REF = path.resolve(
  ROOT, "..", "facilitator-internal", "phone-startup-reference",
  "sources", "pastureland", "pwa", "index.html");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.M627_SHOTS || "/tmp/m627-startup-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const PAGE_FILES = ["card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css",
                    "compose-format.js", "m-splash.js"];
// the vendored editor the composer's typed formatting is drawn with. it is
// served on a route of its own rather than out of the map above, because the
// startup gate has to be asked what it does while this one file is still on
// its way: the row starts as the plain field and swaps in the editor when this
// lands, and a curtain lifted before that swap hands over a card whose typing
// row then changes height under the reader
const EDITOR_FILE = "cm-markdown.js";

let profiles = [];
let fixture = null;
let mHtml = "";

// ---- a squid stand-in ---------------------------------------------------------------
// The product asset is a transparent cutout of the board's own mark, prepared
// outside this repo's code. What the page needs from it is only a file with an
// alpha channel and an aspect ratio, so the fixture writes the smallest thing
// that has both: an opaque orange block on transparent ground, taller than it is
// wide so a centred draw that ignored the ratio would show up as a square.
function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC = crcTable();
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function fixtureSquid(width = 60, height = 90) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);   // one filter byte, then RGBA
    for (let x = 0; x < width; x++) {
      const inside = x >= width * 0.2 && x < width * 0.8 && y >= height * 0.15 && y < height * 0.85;
      const at = 1 + x * 4;
      row[at] = inside ? 0xef : 0;
      row[at + 1] = inside ? 0x9a : 0;
      row[at + 2] = inside ? 0x1f : 0;
      row[at + 3] = inside ? 0xff : 0;   // transparent everywhere else
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the fixture board --------------------------------------------------------------
// A board that answers however the test tells it to. "ok" and "empty" answer a
// reading; "fail" cuts the connection the way a bridge that is off or a phone in
// airplane mode does; "hang" answers nothing at all, which is the slow start.
function boardState(boxes, rev = 7) {
  return {
    rev, changed: true, now: Date.now() / 1000,
    title: "startup fixture board",
    tabs: { order: ["facilitator", "pastureland"], closed: [] },
    pwds: { facilitator: "", pastureland: "" },
    projects: [
      { id: "facilitator", label: "facilitator" },
      { id: "pastureland", label: "pastureland" },
    ],
    paused: false,
    boxes,
    live: {
      listening: { facilitator: true, pastureland: true },
      listenerGap: { facilitator: 0.2, pastureland: 0.2 },
      agents: {
        facilitator: { name: "claude", alive: true },
        pastureland: { name: "claude", alive: true },
      },
    },
  };
}
function fixtureBox(id, title, owner, reply) {
  return {
    id, title, owner, bucket: "now", ball: "you", state: "queued",
    context: "An invented card for the startup fixture.",
    reply, replies: reply ? 1 : 0, pending: [], pendingOps: [],
    agentTs: 0, seen: 0, turnTs: 0, writing: false, bg: false,
    queuePos: 0, done: false, park: false, ws: "",
  };
}
const FIXTURE_BOXES = [
  fixtureBox("f1", "A card the fixture made up", "facilitator",
    "The answer the fixture board holds, long enough to lay out on more than one line " +
    "so the card has real height to settle at."),
  fixtureBox("p1", "Another lane's card", "pastureland", "Its own lane's answer."),
];

async function startFixture() {
  const control = {
    mode: "ok",
    rev: 7,
    boxes: FIXTURE_BOXES,
    holdDoc: false,
    splash: fixtureSquid(),
    picture: fixtureSquid(120, 80),
    holdImage: false,
    holdEditor: false,
    editor: "ok",        // "ok" or "gone": the editor asset arrives, or never can
    reads: 0,
    waitingDocs: [],
    waitingImages: [],
    waitingEditors: [],
    hung: [],
  };
  const files = new Map();
  for (const name of PAGE_FILES) files.set("/" + name, await readFile(path.join(ROOT, name)));
  // a board whose default has typed formatting on: the server writes this ahead
  // of the file, and the readiness checks below need the editor to be coming
  files.set("/compose-format.js", Buffer.concat([
    Buffer.from("globalThis.COMPOSE_FORMAT_DEFAULT=true;"), files.get("/compose-format.js")]));
  const editorSource = await readFile(path.join(ROOT, EDITOR_FILE));
  const manifest = await readFile(path.join(ROOT, "m-manifest.json"));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (code, body, type) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (url.pathname === "/m") {
      const write = () => send(200, mHtml, "text/html; charset=utf-8");
      if (control.holdDoc) control.waitingDocs.push(write);
      else write();
      return;
    }
    if (files.has(url.pathname)) {
      const type = url.pathname.endsWith(".css") ? "text/css" : "application/javascript";
      return send(200, files.get(url.pathname), type + "; charset=utf-8");
    }
    if (url.pathname === "/m-manifest.json") return send(200, manifest, "application/manifest+json");
    if (url.pathname === "/m-splash-squid.png") {
      if (!control.splash) return send(404, "{}", "application/json");
      return send(200, control.splash, "image/png");
    }
    // A picture the test can hold back, and one that will never arrive. They are
    // not the same thing to a startup gate: the first is still on its way, and
    // the second has finished, in failure, and has nothing left to wait for.
    if (url.pathname === "/uploads/slow.png") {
      const write = () => send(200, control.picture, "image/png");
      if (control.holdImage) control.waitingImages.push(write);
      else write();
      return;
    }
    if (url.pathname === "/uploads/broken.png") return send(404, "{}", "application/json");
    // The editor, held back or refused on the test's word. A refusal is an
    // ending and the row stays the plain field; a hold has no ending yet.
    if (url.pathname === "/" + EDITOR_FILE) {
      if (control.editor === "gone") return send(404, "{}", "application/json");
      const write = () => send(200, editorSource, "application/javascript; charset=utf-8");
      if (control.holdEditor) control.waitingEditors.push(write);
      else write();
      return;
    }
    // A worker that does nothing: it registers, so the page's own registration
    // is not a failed fetch, and it has no fetch handler, so nothing here is
    // served from a cache and every mode this fixture is put in is the mode the
    // page actually sees. The real worker is exercised in its own file.
    if (url.pathname === "/m-sw.js") {
      return send(200, "self.addEventListener('install', () => self.skipWaiting());\n",
        "application/javascript; charset=utf-8");
    }
    if (url.pathname === "/m/state") {
      control.reads += 1;
      if (control.mode === "fail") return req.socket.destroy();
      if (control.mode === "hang") { control.hung.push(res); return; }
      // The revision, answered the way the board answers it: a reader that names
      // the revision it already holds is told there is nothing new and gets no
      // cards at all. Everything about a startup that never draws hangs on this,
      // so the fixture has to do it rather than hand the whole board back every
      // time (server.py: _phone_state, changed = since is None or since != rev).
      const since = url.searchParams.get("since");
      if (since !== null && since !== "" && since === String(control.rev)) {
        return send(200, JSON.stringify({
          rev: control.rev, changed: false, now: Date.now() / 1000,
          live: boardState([]).live,
        }), "application/json");
      }
      const boxes = control.mode === "empty" ? [] : control.boxes;
      return send(200, JSON.stringify(boardState(boxes, control.rev)), "application/json");
    }
    send(404, "{}", "application/json");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  control.origin = "http://127.0.0.1:" + server.address().port;
  control.releaseDoc = () => {
    control.holdDoc = false;
    for (const write of control.waitingDocs.splice(0)) write();
  };
  control.releaseImage = () => {
    control.holdImage = false;
    for (const write of control.waitingImages.splice(0)) write();
  };
  control.releaseEditor = () => {
    control.holdEditor = false;
    for (const write of control.waitingEditors.splice(0)) write();
  };
  control.reset = () => {
    control.mode = "ok";
    control.rev = 7;
    control.boxes = FIXTURE_BOXES;
    control.holdImage = false;
    control.holdEditor = false;
    control.editor = "ok";
    control.splash = fixtureSquid();
    for (const res of control.hung.splice(0)) res.destroy();
    control.waitingImages.length = 0;
    control.waitingEditors.length = 0;
  };
  control.close = () => {
    for (const res of control.hung.splice(0)) res.destroy();
    return new Promise(resolve => server.close(resolve));
  };
  return control;
}

// ---- the browser --------------------------------------------------------------------
async function launchApp(url) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "m627-app-"));
  profiles.push(userDataDir);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new", userDataDir, defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=390,844",
           ...(url ? ["--app=" + url] : [])],
  });
  return browser;
}

// The phone's screen, set straight through the protocol. page.setViewport would
// reload the page to change the mobile and touch flags, and the document these
// tests open with is deliberately held back, so a reload would wait forever on a
// navigation nothing is answering.
async function phoneScreen(page, viewport = PHONE) {
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor, mobile: !!viewport.isMobile,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled",
    { enabled: !!viewport.hasTouch, maxTouchPoints: 5 });
}

// Open the page the way the phone does, with the document held back until the
// window is a phone and the watchers are on it, so the first frames are the
// test's to look at.
async function openInstalled(control, opts = {}) {
  control.holdDoc = true;
  const browser = await launchApp(control.origin + "/m");
  const deadline = Date.now() + 10000;
  let page = null;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    page = pages[pages.length - 1];
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(page, "the app window never appeared");
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/fonts\.g(oogleapis|static)\.com/.test(text)) return;      // no web fonts in here
    if (/^Failed to load resource/.test(text)) return;             // the fixture cuts these on purpose
    problems.push(text);
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await phoneScreen(page, opts.viewport || PHONE);
  if (opts.reducedMotion) {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  }
  if (opts.restlessLayout) {
    // a block inside the shown card's answer whose height moves every frame, so
    // the answer's scroll height never reads the same twice. taking the rule out
    // again is what lets the layout finally stop
    await page.evaluateOnNewDocument(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.id = "restless";
        style.textContent =
          "#cards .box.sel .reply::after{content:'';display:block;" +
          "animation:restless 3s linear infinite}" +
          // it starts taller than the answer's own box and grows from there, so
          // the answer always overflows: a block small enough to fit would let
          // the scroll height clamp to the box and read as genuinely still
          "@keyframes restless{from{height:900px}to{height:1800px}}";
        document.head.appendChild(style);
      });
    });
  }
  // when the curtain began to fade, read from the page itself
  await page.evaluateOnNewDocument(() => {
    window.__liftAt = null;
    window.__loadAt = performance.now();
    const watch = () => {
      const el = document.getElementById("loading");
      if (!el) return;
      new MutationObserver(() => {
        if (window.__liftAt === null && el.style.opacity === "0") window.__liftAt = performance.now();
      }).observe(el, { attributes: true, attributeFilter: ["style"] });
    };
    document.addEventListener("DOMContentLoaded", watch);
  });
  control.releaseDoc();
  await page.waitForFunction(() => document.readyState !== "loading", { timeout: 10000 });
  const standalone = await page.evaluate(() => matchMedia("(display-mode: standalone)").matches);
  assert.equal(standalone, true, "the app window did not report standalone display-mode");
  return { browser, page, problems };
}

// what the curtain looks like this instant
async function readCurtain(page) {
  return page.evaluate(() => {
    const el = document.getElementById("loading");
    if (!el) return { present: false };
    const globe = el.querySelector(".globe");
    const coast = el.querySelector(".coast");
    const earth = el.querySelector(".earth");
    const style = getComputedStyle(el);
    const globeStyle = getComputedStyle(globe);
    const rect = el.getBoundingClientRect();
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      present: true,
      parent: el.parentElement.tagName,
      down: el.classList.contains("down"),
      opacity: Number(style.opacity),
      background: style.backgroundColor,
      zIndex: style.zIndex,
      covers: rect.width >= innerWidth - 0.5 && rect.height >= innerHeight - 0.5,
      onTop: !!middle && el.contains(middle),
      border: globeStyle.borderTopColor,
      diameter: globe.getBoundingClientRect().width,
      stroke: getComputedStyle(coast).stroke,
      transform: getComputedStyle(earth).transform,
      play: earth.getAnimations().map(a => a.playState),
      // A pending play or pause has not yet been applied.
      pending: earth.getAnimations().map(a => a.pending),
      clock: earth.getAnimations().map(a => Number(a.currentTime)),
      names: earth.getAnimations().map(a => a.animationName),
      sceneNames: el.querySelector(".scene").getAnimations().map(a => a.animationName),
    };
  });
}

// the globe is turning if its own clock moved on, which a compositor-driven
// animation reports even where a computed transform is slow to catch up
async function movedSince(page, before, ms = 400) {
  await new Promise(resolve => setTimeout(resolve, ms));
  const now = await readCurtain(page);
  const ticked = now.clock[0] !== undefined && before.clock[0] !== undefined &&
                 now.clock[0] > before.clock[0];
  return { moved: ticked || now.transform !== before.transform, now };
}

// Wait for pending pause tasks and rendered frames before sampling motion.
async function pausedAndSettled(page, selector, timeout = 20000) {
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const list = el.getAnimations();
    return list.length > 0 && list.every(a => a.playState === "paused");
  }, { timeout, polling: "raf" }, selector);
  await page.evaluate(async sel => {
    const list = document.querySelector(sel).getAnimations();
    await Promise.all(list.map(a => a.ready));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, selector);
  const state = await page.evaluate(sel => {
    const list = document.querySelector(sel).getAnimations();
    return { pending: list.map(a => a.pending), play: list.map(a => a.playState) };
  }, selector);
  assert.deepEqual(state.pending.filter(Boolean), [],
    "a pause was still pending when the stopped sample was taken: " +
    JSON.stringify(state));
  assert.deepEqual(state.play.filter(p => p !== "paused"), [],
    "an animation left the paused state before the stopped sample: " +
    JSON.stringify(state));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  mHtml = await readFile(path.join(ROOT, "m.html"), "utf8");
  fixture = await startFixture();
});

after(async () => {
  if (fixture) await fixture.close();
  for (const dir of profiles) await rm(dir, { recursive: true, force: true });
});

// ---- what the document itself carries ------------------------------------------------

test("the served page carries the curtain before any script, and it fetches nothing", async () => {
  const served = await (await fetch(fixture.origin + "/m")).text();
  const curtain = served.indexOf('<div id="loading"');
  assert.ok(curtain > 0, "the served page has no curtain");
  assert.ok(curtain < served.indexOf("<script"), "the curtain is drawn after the first script");
  const block = served.slice(curtain, served.indexOf("<div id=\"page\">"));
  assert.ok(/<div class="scene">/.test(block) && /<div class="globe">/.test(block), "no globe in the curtain");
  assert.equal(/\ssrc=/.test(block), false, "the curtain asks for a file");
  // the only addresses in it are the two references to the shape written beside them
  assert.deepEqual(block.match(/href="[^"]*"/g), ['href="#land"', 'href="#land"']);
  assert.ok(/vector-effect="non-scaling-stroke"/.test(block),
    "the coastline's stroke is not pinned to the screen");
  // the curtain is a child of the body: the page is scaled while a menu is out,
  // and a fixed layer inside a scaled element stops covering the screen
  assert.ok(served.indexOf("<body>") < curtain && curtain < served.indexOf('<div id="page">'),
    "the curtain is not a plain child of the body, before the page");
});

test("the picture and its timings are the ones taken from the pastureland page", async (t) => {
  const sheet = mHtml.slice(mHtml.indexOf("#loading{"), mHtml.indexOf("/* card prose"));
  for (const [what, pattern] of [
    ["the panel is white", /background:#ffffff/],
    ["the panel stands over everything", /z-index:40/],
    ["the fade is 260ms", /transition:opacity 260ms ease/],
    ["the scene arrives over 620ms after 80ms", /animation:ld-appear 620ms ease-out 80ms both/],
    ["the globe is 14vmin across", /width:14vmin; height:14vmin/],
    ["its border is 0.4vmin of black", /border:0\.4vmin solid #000000/],
    ["the strip is four circles wide", /width:400%/],
    ["one turn every 5200ms, linear, forever", /animation:ld-spin 5200ms linear infinite/],
    ["the coastline is 0.2vmin of black", /stroke:#000000; stroke-width:0\.2vmin/],
    ["the turn slides by one whole world", /from\{transform:translateX\(-50%\)\}\s*to\{transform:translateX\(0\)\}/],
    ["a browser tab hides it", /@media \(display-mode: browser\)\{\s*#loading\{display:none\}/],
  ]) assert.ok(pattern.test(sheet), what);
  // the loop closes on itself: the strip carries the world twice over and is
  // four circles wide, so sliding by half of it puts the second copy exactly
  // where the first stood and no seam can walk across the globe
  const copies = (mHtml.match(/<use href="#land"/g) || []).length;
  assert.equal(copies, 2, "the strip does not carry the world twice");
  const stripWidth = Number(/width:(\d+)%/.exec(sheet)[1]);
  const slide = Number(/translateX\(-(\d+)%\)/.exec(sheet)[1]);
  assert.equal(slide, 100 / copies, "the turn does not slide by exactly one copy of the map");
  assert.equal(stripWidth / copies, 200, "one copy of the map is not two circles wide");

  if (!existsSync(PASTURELAND_REF)) {
    t.diagnostic("the pastureland reference is not in this checkout: the shape was not compared");
    return;
  }
  const reference = await readFile(PASTURELAND_REF, "utf8");
  const shapeOf = text => /<path id="land"[^>]* d="([^"]+)"/.exec(text)[1];
  assert.equal(shapeOf(mHtml), shapeOf(reference), "the coastline is not the shape it was copied from");
});

test("the launch image's numbers and the stillness rule, on their own", async () => {
  const { browser, page } = await openInstalled(fixture);
  try {
    const out = await page.evaluate(() => {
      const g = splashLayout({ screenW: 390, screenH: 844, dpr: 3, logoAspect: 60 / 90 });
      const square = splashLayout({ screenW: 375, screenH: 667, dpr: 2, logoAspect: 1 });
      const wide = splashLayout({ screenW: 844, screenH: 390, dpr: 3, logoAspect: 1 });
      // a recording stand-in, so the draw can be read without a real canvas
      const calls = [];
      const stub = {
        fillStyle: "", font: "", textAlign: "", textBaseline: "",
        fillRect: (...a) => calls.push(["fillRect", stub.fillStyle, ...a]),
        drawImage: (...a) => calls.push(["drawImage", ...a.slice(1)]),
        fillText: (...a) => calls.push(["fillText", stub.fillStyle, stub.textAlign, stub.textBaseline, ...a]),
        save: () => calls.push(["save"]), restore: () => calls.push(["restore"]),
        scale: (...a) => calls.push(["scale", ...a]),
      };
      paintSplash(stub, { width: 60, height: 90 }, g);
      // a context that refuses everything but the plainest family must still
      // come back with the size that was asked for
      const fussy = { _f: "10px sans-serif",
        set font(v){ this._f = /system-ui|SF Pro|apple-system/.test(v) ? this._f : v; },
        get font(){ return this._f; } };
      return {
        canvas: [g.canvasW, g.canvasH],
        logo: [g.logoW, g.logoH, g.logoX, g.logoY],
        centred: [g.logoX + g.logoW / 2 === g.canvasW / 2, g.logoY + g.logoH / 2 === g.canvasH / 2],
        squareLogo: [square.logoW, square.logoH],
        handle: [g.handleFont, g.handleCenterX, g.handleCenterY],
        handleBox: splashHandleBox(g),
        media: g.media,
        wideMedia: wide.media,
        calls,
        ladder: applySplashFont(fussy, 13.6667),
        text: SPLASH_HANDLE, ink: SPLASH_HANDLE_COLOR, bg: SPLASH_BG,
        quiet: (() => {
          const w = createQuietWatch(3);
          const same = { ph: 1, pw: 1, sh: 2, st: 0, ch: 3, vh: 4, art: 0 };
          const moved = { ...same, sh: 9 };
          return [w.frame(same), w.frame(same), w.frame(same), w.frame(same),
                  w.frame(moved), w.frame(same), w.frame(same), w.frame(same), w.frame(same)];
        })(),
        // a picture still on its way is never a still frame, however long the
        // geometry has been holding its breath
        art: (() => {
          const w = createQuietWatch(3);
          const waiting = { ph: 1, pw: 1, sh: 2, st: 0, ch: 3, vh: 4, art: 1 };
          const done = { ...waiting, art: 0 };
          return [w.frame(waiting), w.frame(waiting), w.frame(waiting), w.frame(waiting),
                  w.frame(waiting), w.frame(done), w.frame(done), w.frame(done), w.frame(done)];
        })(),
      };
    });
    // the canvas is the screen in device pixels
    assert.deepEqual(out.canvas, [1170, 2532]);
    // the longer side spans 0.32 of the shorter edge, the other side follows the ratio
    const shortEdge = 1170;
    assert.equal(out.logo[1], shortEdge * 0.32);
    assert.ok(Math.abs(out.logo[0] - shortEdge * 0.32 * (60 / 90)) < 1e-9);
    assert.deepEqual(out.centred, [true, true], "the logo is not dead centre");
    assert.deepEqual(out.squareLogo, [750 * 0.32, 750 * 0.32], "a square logo does not fill the box");
    // the credit line: 0.035 of the shorter edge, centred, its middle 0.12 up
    assert.equal(out.handle[0], Math.round(shortEdge * 0.035));
    assert.equal(out.handle[1], 1170 / 2);
    assert.equal(out.handle[2], 2532 - shortEdge * 0.12);
    // clear of the logo above it, both read in the canvas's own device pixels
    assert.ok(out.handle[2] - out.handle[0] / 2 > out.logo[3] + out.logo[1],
      "the credit line runs into the logo");
    // and clear of the home indicator's 34pt inset at the bottom
    assert.ok(2532 - (out.handle[2] + out.handle[0] / 2) > 34 * 3,
      "the credit line sits under the home indicator");
    // the same line restated in the screen's own CSS pixels: the device-pixel
    // anchor through the canvas-to-screen ratio, measured from the box's top
    const toScreen = 844 / 2532;
    assert.ok(Math.abs(out.handleBox.fontPx - out.handle[0] * toScreen) < 1e-9);
    assert.ok(Math.abs(out.handleBox.top - (out.handle[2] * toScreen - out.handleBox.fontPx / 2)) < 1e-9);
    // it reads smaller than the card's own 17px prose, and never turns tiny
    assert.ok(out.handleBox.fontPx < 17 && out.handleBox.fontPx > 11,
      "the credit line is the wrong size on the screen: " + out.handleBox.fontPx);
    assert.equal(out.media,
      "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)");
    assert.match(out.wideMedia, /orientation: landscape\)$/);
    assert.equal(out.text, "@theonetrueakash");
    assert.equal(out.ink, "#aeaeb2");
    assert.equal(out.bg, "#ffffff");
    // white first, then the logo at its rect, then the line, in that order
    assert.deepEqual(out.calls[0], ["fillRect", "#ffffff", 0, 0, 1170, 2532]);
    assert.deepEqual(out.calls[1].slice(0, 1), ["drawImage"]);
    const text = out.calls.find(c => c[0] === "fillText");
    assert.equal(text[1], "#aeaeb2");
    assert.deepEqual(text.slice(2, 4), ["center", "middle"]);
    assert.equal(text[4], "@theonetrueakash");
    assert.ok(out.calls.some(c => c[0] === "save") && out.calls.some(c => c[0] === "restore"),
      "the credit line's transform was not put back");
    // a refused font stack steps down rather than silently painting the default
    assert.match(out.ladder, /^13\.6667px sans-serif$/);
    // three unchanged frames in a row, and any change starts the count over
    assert.deepEqual(out.quiet, [false, false, false, true, false, false, false, false, true]);
    // and no run of unchanged frames counts while a picture is still coming: the
    // count can only begin once the last one has an answer
    // the count starts on the first frame after the last picture answered, so
    // the fourth frame from there is the first still one
    assert.deepEqual(out.art, [false, false, false, false, false, false, false, true, true]);
  } finally {
    await browser.close();
  }
});

// ---- what an installed open actually shows -------------------------------------------

test("the curtain holds past the old two second cap while the board has not answered", async () => {
  fixture.mode = "hang";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await new Promise(resolve => setTimeout(resolve, 2600));
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true, "the curtain went before the board answered");
    assert.equal(curtain.opacity, 1, "the curtain started fading before the board answered");
    assert.equal(curtain.down, false, "the globe reddened while the reading was still out");
    assert.equal(curtain.covers, true, "the curtain does not cover the screen");
    assert.equal(curtain.onTop, true, "something is drawn over the curtain");
    assert.equal(curtain.parent, "BODY", "the curtain is not a child of the body");
    assert.deepEqual(curtain.play, ["running"], "the globe stopped while the phone was still trying");
    assert.deepEqual(curtain.names, ["ld-spin"]);
    assert.equal(curtain.background, "rgb(255, 255, 255)");
    assert.equal(curtain.border, "rgb(0, 0, 0)", "the globe is not black while it is still trying");
    // the diameter is 14vmin of a 390 wide phone
    assert.ok(Math.abs(curtain.diameter - 390 * 0.14) < 0.5, "the globe is the wrong size: " + curtain.diameter);
    const { moved } = await movedSince(page, curtain);
    assert.equal(moved, true, "the globe was not turning");
    assert.equal(await page.evaluate(() => document.body.classList.contains("stated")), false,
      "the page claimed a reading it never got");
    await shot(page, "pending");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
    for (const res of fixture.hung.splice(0)) res.destroy();
  }
});

test("a reading that fails stops the globe where it stands and turns it red", async () => {
  fixture.mode = "fail";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("down"),
      { timeout: 10000 });
    await pausedAndSettled(page, "#loading .earth");
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true, "the curtain went when the board could not be reached");
    assert.equal(curtain.opacity, 1);
    assert.equal(curtain.border, "rgb(168, 68, 42)", "the globe did not turn red");
    assert.equal(curtain.stroke, "rgb(168, 68, 42)", "the coastline did not turn red");
    assert.deepEqual(curtain.play, ["paused"], "the globe did not stop");
    const { moved, now } = await movedSince(page, curtain, 600);
    assert.equal(moved, false, "the globe kept turning after the reading failed");
    assert.equal(now.transform, curtain.transform, "the globe snapped somewhere else when it stopped");
    assert.notEqual(curtain.transform, "none", "the globe stopped before it had turned at all");
    assert.equal(await page.evaluate(() => document.body.classList.contains("stated")), false);
    await shot(page, "failure");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("nothing but a live reading takes the curtain down", async () => {
  fixture.mode = "fail";
  const { browser, page } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("down"),
      { timeout: 10000 });
    const before = fixture.reads;
    await new Promise(resolve => setTimeout(resolve, 6000));
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true, "the curtain came down without a reading");
    assert.equal(curtain.down, true, "the globe stopped saying the board was unreachable");
    assert.equal(curtain.opacity, 1);
    assert.ok(fixture.reads > before, "the page stopped asking for the board");
    const inside = await page.evaluate(() => ({
      stated: document.body.classList.contains("stated"),
      cards: document.getElementById("cards").childElementCount,
      lifted: window.__liftAt,
    }));
    assert.deepEqual(inside, { stated: false, cards: 0, lifted: null });
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("the globe turns again and the board arrives when the connection comes back", async () => {
  fixture.mode = "fail";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("down"),
      { timeout: 10000 });
    const stopped = await readCurtain(page);
    fixture.mode = "ok";
    await page.waitForFunction(() => {
      const el = document.getElementById("loading");
      return el && !el.classList.contains("down");
    }, { timeout: 20000 });
    const turning = await readCurtain(page);
    assert.deepEqual(turning.play, ["running"], "the globe did not start turning again");
    assert.equal(turning.border, "rgb(0, 0, 0)", "the globe stayed red after the board answered");
    assert.equal(turning.present, true, "the curtain went the instant the reading landed");
    assert.ok(turning.clock[0] >= stopped.clock[0], "the globe went back to where it started");
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    const after = await page.evaluate(() => ({
      lift: window.__liftAt - window.__loadAt,
      cards: document.getElementById("cards").childElementCount,
      shown: !!document.querySelector("#cards .box.sel"),
      blank: document.getElementById("pane").classList.contains("blank"),
      emptyShown: getComputedStyle(document.getElementById("empty")).display !== "none",
      stated: document.body.classList.contains("stated"),
      frames: startupFrames,
    }));
    assert.ok(after.lift >= 1000, "the curtain came down inside the minimum hold: " + after.lift);
    assert.equal(after.cards, FIXTURE_BOXES.length, "the board was not drawn");
    assert.equal(after.shown, true, "no card was on show when the curtain came down");
    assert.equal(after.blank, false, "the curtain came down onto a blank card");
    assert.equal(after.emptyShown, false, "the curtain came down onto the empty line");
    assert.equal(after.stated, true);
    assert.ok(after.frames >= 4, "the stillness watch read too few frames: " + after.frames);
    await shot(page, "recovery-live");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("a slow first answer is waited for, and released the moment it settles", async () => {
  fixture.mode = "hang";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal((await readCurtain(page)).present, true, "the curtain went while the answer was still out");
    fixture.mode = "ok";
    for (const res of fixture.hung.splice(0)) res.destroy();   // the hung read fails, the next one lands
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const after = await page.evaluate(() => ({
      lift: window.__liftAt - window.__loadAt,
      cards: document.getElementById("cards").childElementCount,
    }));
    assert.ok(after.lift > 2500, "the curtain came down before the answer did");
    assert.equal(after.cards, FIXTURE_BOXES.length);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("a board that really is empty says so, and only once a reading proves it", async () => {
  // held first, so the page is looked at while it has read nothing at all
  fixture.mode = "hang";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    const early = await page.evaluate(() => ({
      stated: document.body.classList.contains("stated"),
      emptyShown: getComputedStyle(document.getElementById("empty")).display !== "none",
      blank: document.getElementById("pane").classList.contains("blank"),
    }));
    assert.deepEqual(early, { stated: false, emptyShown: false, blank: true },
      "the page said the tab was empty before it had read one");
    fixture.mode = "empty";
    for (const res of fixture.hung.splice(0)) res.destroy();
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const after = await page.evaluate(() => ({
      stated: document.body.classList.contains("stated"),
      emptyShown: getComputedStyle(document.getElementById("empty")).display !== "none",
      text: document.getElementById("empty").textContent,
      cards: document.getElementById("cards").childElementCount,
    }));
    assert.equal(after.stated, true);
    assert.equal(after.emptyShown, true, "a board that is really empty did not say so");
    assert.equal(after.text, "no cards on this tab yet");
    assert.equal(after.cards, 0);
    await shot(page, "empty-live");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("a connection lost after the start never brings the curtain back", async () => {
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    fixture.mode = "fail";
    await page.waitForFunction(() => document.body.classList.contains("offline"), { timeout: 30000 });
    const after = await page.evaluate(() => ({
      curtain: !!document.getElementById("loading"),
      note: document.getElementById("offline").textContent,
      noteShown: getComputedStyle(document.getElementById("offline")).display !== "none",
      cards: document.getElementById("cards").childElementCount,
    }));
    assert.equal(after.curtain, false, "the startup curtain came back after a later drop");
    assert.equal(after.noteShown, true, "the reconnecting note did not appear");
    assert.match(after.note, /Reconnecting to the board|not answering/);
    assert.equal(after.cards, FIXTURE_BOXES.length, "the board it had read was taken away");
    await shot(page, "later-drop");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("reduced motion keeps the globe turning, and a failed reading still stops it", async t => {
  fixture.mode = "hang";
  const { browser, page } = await openInstalled(fixture, { reducedMotion: true });
  try {
    const reduced = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    assert.equal(reduced, true, "reduced motion was not in force");
    const curtain = await readCurtain(page);
    assert.deepEqual(curtain.names, ["ld-spin"], "the globe's turn was taken away under reduced motion");
    assert.deepEqual(curtain.play, ["running"]);
    assert.deepEqual(curtain.sceneNames, ["ld-appear"]);
    const { moved } = await movedSince(page, curtain);
    assert.equal(moved, true, "the globe held still under reduced motion, which is what failure means here");
    // the rest of the page keeps the blanket rule
    const still = await page.evaluate(() => getComputedStyle(document.getElementById("page")).transitionDuration);
    assert.equal(still, "0s", "reduced motion stopped applying to the page itself");
    fixture.mode = "fail";
    for (const res of fixture.hung.splice(0)) res.destroy();
    await page.waitForFunction(() => document.getElementById("loading")?.classList.contains("down"),
      { timeout: 20000 });
    // A paused playState can precede the applied pause.
    await pausedAndSettled(page, "#loading .earth");
    const down = await readCurtain(page);
    assert.deepEqual(down.play, ["paused"], "a failed reading did not stop the globe under reduced motion");
    assert.deepEqual(down.pending, [false], "the globe's pause was still pending when it was sampled");
    assert.equal(down.border, "rgb(168, 68, 42)");
    const after = await movedSince(page, down, 600);
    const sample = value => ({ clock: value.clock, transform: value.transform, pending: value.pending });
    t.diagnostic(JSON.stringify({ stoppedBefore: sample(down), stoppedAfter: sample(after.now) }));
    // both halves of stopped, named separately so a failure says which moved
    assert.equal(after.now.clock[0], down.clock[0],
      "the stopped globe's clock moved on: " + down.clock[0] + " to " + after.now.clock[0]);
    assert.equal(after.now.transform, down.transform,
      "the stopped globe's transform moved on: " + down.transform +
      " to " + after.now.transform);
    assert.equal(after.moved, false, "the stopped globe moved");
  } finally {
    await browser.close();
    fixture.mode = "ok";
  }
});

test("the phone's own launch image is painted for this device and registered", async () => {
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !!document.querySelector("link[rel=apple-touch-startup-image]"),
      { timeout: 20000 });
    const out = await page.evaluate(async () => {
      const link = document.querySelector("link[rel=apple-touch-startup-image]");
      const layout = splashLayout({ screenW: screen.width, screenH: screen.height,
        dpr: devicePixelRatio, logoAspect: 60 / 90 });
      const img = new Image();
      img.src = link.href;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      // the middle of the logo's box, a corner well outside it, and the row the
      // credit line sits on
      const mid = at(canvas.width / 2, canvas.height / 2);
      const corner = at(4, 4);
      let handleInk = null;
      const row = ctx.getImageData(0, Math.round(layout.handleCenterY), canvas.width, 1).data;
      for (let x = 0; x < canvas.width; x++) {
        const p = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]];
        if (p[0] !== 255 || p[1] !== 255 || p[2] !== 255) { handleInk = p; break; }
      }
      return { media: link.media, href: link.href.slice(0, 22), size: [img.naturalWidth, img.naturalHeight],
               expect: [layout.canvasW, layout.canvasH], mid, corner, handleInk,
               links: document.querySelectorAll("link[rel=apple-touch-startup-image]").length };
    });
    assert.equal(out.href, "data:image/png;base64,", "the launch image was not painted into the page");
    assert.deepEqual(out.size, out.expect, "the launch image is not this device's exact pixel size");
    assert.equal(out.media, "(device-width: 390px) and (device-height: 844px) " +
      "and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)");
    assert.deepEqual(out.corner, [255, 255, 255, 255], "the launch image is not painted on white");
    assert.deepEqual(out.mid.slice(0, 3), [239, 154, 31], "the squid is not centred on it");
    assert.equal(out.mid[3], 255, "the squid was drawn see-through");
    assert.ok(out.handleInk, "the credit line was not drawn");
    // apple's systemGray2, give or take the rasterizer's edge blending: the
    // first ink found on that row is the darkest part of a glyph
    assert.ok(out.handleInk.every(c => c > 120 && c < 220),
      "the credit line is not the faint grey it should be: " + out.handleInk);
    assert.equal(out.links, 1, "the launch image was registered more than once");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test("a missing squid costs the launch image and nothing else", async () => {
  fixture.splash = null;
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    const out = await page.evaluate(() => ({
      links: document.querySelectorAll("link[rel=apple-touch-startup-image]").length,
      cards: document.getElementById("cards").childElementCount,
    }));
    assert.equal(out.links, 0, "a launch image was registered from a file that is not there");
    assert.equal(out.cards, FIXTURE_BOXES.length, "a missing squid stopped the board being drawn");
    assert.deepEqual(problems, [], "a missing squid was reported as a page problem");
  } finally {
    await browser.close();
    fixture.splash = fixtureSquid();
  }
});

test("a normal browser tab shows no curtain at all", async () => {
  const browser = await launchApp(null);
  try {
    const page = await browser.newPage();
    const problems = [];
    page.on("console", m => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (/fonts\.g(oogleapis|static)\.com/.test(text)) return;
      if (/^Failed to load resource/.test(text)) return;
      problems.push(text);
    });
    page.on("pageerror", e => problems.push("pageerror: " + e.message));
    await phoneScreen(page);
    await page.goto(fixture.origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null, { timeout: 20000 });
    const out = await page.evaluate(() => ({
      standalone: matchMedia("(display-mode: standalone)").matches,
      curtain: !!document.getElementById("loading"),
      cards: document.getElementById("cards").childElementCount,
      shown: !!document.querySelector("#cards .box.sel"),
      launchImage: document.querySelectorAll("link[rel=apple-touch-startup-image]").length,
      appleTarget: /iP(hone|od|ad)/.test(navigator.userAgent) ||
                   (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    }));
    assert.equal(out.standalone, false, "a plain tab reported itself installed");
    assert.equal(out.curtain, false, "a plain tab was left holding the curtain");
    assert.equal(out.cards, FIXTURE_BOXES.length);
    assert.equal(out.shown, true);
    // This tab reports what iPadOS reports, a Macintosh with a touch screen, so
    // it is an Apple home screen target and the launch image IS painted here.
    // That is the point of painting it in a tab: iOS reads the tag off the page
    // it is asked to install, so a first installed launch has a picture only if
    // the tab that installed it had already registered one. It changes nothing
    // on screen, which is what the curtain check above is for.
    assert.equal(out.appleTarget, true, "the tab was not standing in for an apple target");
    assert.equal(out.launchImage, 1, "the tab registered no launch image to install with");
    await shot(page, "browser-tab");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

test("the curtain sits outside the page the menus scale, and the menus still work after it", async () => {
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    const held = await page.evaluate(() => {
      const el = document.getElementById("loading");
      const page_ = document.getElementById("page");
      return { parent: el.parentElement.id || el.parentElement.tagName,
               insidePage: page_.contains(el),
               scrimParent: document.getElementById("scrim").parentElement.tagName };
    });
    assert.equal(held.insidePage, false, "the curtain is inside the page, which is scaled while a menu is out");
    assert.equal(held.parent, "BODY");
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    // the drawer still opens on the page the curtain was over
    await page.evaluate(() => openDrawer());
    await new Promise(resolve => setTimeout(resolve, 800));
    const open = await page.evaluate(() => ({
      shift: getComputedStyle(document.getElementById("drawer")).transform,
      scale: getComputedStyle(document.getElementById("page")).transform,
      rows: document.querySelectorAll("#tiklist .trow").length,
      visible: getComputedStyle(document.getElementById("drawer")).visibility,
    }));
    assert.equal(open.visible, "visible", "the drawer did not open after the curtain went");
    assert.notEqual(open.scale, "none", "the page did not draw back for the drawer");
    assert.ok(open.rows > 0, "the drawer's list was empty after a live reading");
    await page.evaluate(() => closeDrawer());
    await new Promise(resolve => setTimeout(resolve, 800));
    // and a send still reaches the composer it always did
    const composer = await page.evaluate(() => !!document.querySelector("#cards .box.sel textarea"));
    assert.equal(composer, true, "the card lost its composer");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
  }
});

// ---- readiness: what "the board has stopped moving" is allowed to mean ---------------
// Elapsed time is not one of the things it may mean. These four are the cases a
// clock would have got wrong: a picture the reader can see that has not arrived,
// a picture on a card nobody is looking at, a layout that will not hold still,
// and a picture whose loading is over because it failed.

// where the shown card's own pictures stand this instant
async function readArt(page) {
  return page.evaluate(() => {
    const card = document.querySelector("#cards .box.sel");
    const shown = card ? Array.from(card.querySelectorAll("img")) : [];
    const hidden = Array.from(document.querySelectorAll("#cards .box:not(.sel) img"));
    const state = img => ({ complete: img.complete, natural: img.naturalWidth,
                            src: new URL(img.src).pathname });
    return { shown: shown.map(state), hidden: hidden.map(state),
             cardShown: !!card && card.getClientRects().length > 0 };
  });
}

test("a picture the reader can see holds the curtain past the old three second bound", async () => {
  fixture.holdImage = true;
  fixture.boxes = [
    fixtureBox("f1", "A card with a picture on it", "facilitator",
      "Before the picture.\n\n![a shot](/uploads/slow.png)\n\nAfter the picture."),
    fixtureBox("p1", "Another lane's card", "pastureland", "Plain words."),
  ];
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    // well past the three second image bound and the 180 frame layout bound
    await new Promise(resolve => setTimeout(resolve, 4200));
    const art = await readArt(page);
    assert.equal(art.cardShown, true, "no card was on show to be waited for");
    assert.equal(art.shown.length, 1, "the card's picture was not drawn: " + JSON.stringify(art));
    assert.equal(art.shown[0].complete, false, "the fixture let the picture through");
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true,
      "the curtain came down while a picture the reader can see was still on its way");
    assert.equal(curtain.opacity, 1, "the curtain began fading over an unfinished card");
    assert.equal(curtain.down, false, "the globe reddened over a connection that was fine");
    assert.deepEqual(curtain.play, ["running"], "the globe stopped while the card was still arriving");
    assert.equal(await page.evaluate(() => startupStill), false,
      "the page called itself still with a picture still on its way");
    // the picture lands: the card finishes, goes still, and only then is it shown
    fixture.releaseImage();
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    const after = await readArt(page);
    assert.equal(after.shown[0].complete, true, "the curtain went before the picture arrived");
    assert.ok(after.shown[0].natural > 0, "the picture that arrived had no pixels");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("a picture on a card nobody is looking at holds nothing up", async () => {
  fixture.holdImage = true;
  fixture.boxes = [
    fixtureBox("f1", "The card on show", "facilitator", "Plain words, and no picture."),
    fixtureBox("p1", "A card behind it", "pastureland",
      "![a shot nobody is looking at](/uploads/slow.png)"),
  ];
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    const art = await readArt(page);
    assert.equal(art.shown.length, 0, "the card on show had a picture after all");
    assert.equal(art.hidden.length, 1, "the hidden card's picture was not drawn");
    assert.equal(art.hidden[0].complete, false,
      "the hidden picture arrived, so this proves nothing");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("a layout that will not hold still keeps the curtain up, and lifts when it does", async () => {
  const { browser, page, problems } = await openInstalled(fixture, {
    // a block inside the shown card's answer that grows every frame, for as long
    // as the rule is in the page: the answer's scroll height never repeats
    restlessLayout: true,
  });
  try {
    // 180 frames is about three seconds at sixty a second, so this is well past
    // the frame bound the old code would have given up at
    await new Promise(resolve => setTimeout(resolve, 5200));
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true, "the curtain came down over a layout that was still moving");
    assert.equal(curtain.opacity, 1);
    const inside = await page.evaluate(() => ({
      still: startupStill, drew: startupDrew, stated: document.body.classList.contains("stated"),
    }));
    assert.deepEqual(inside, { still: false, drew: true, stated: true },
      "the page called a moving layout still");
    // and it does come down, the moment the layout really stops
    await page.evaluate(() => document.getElementById("restless").remove());
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    assert.equal(await page.evaluate(() => document.getElementById("cards").childElementCount),
      FIXTURE_BOXES.length);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("a picture whose loading ended in failure is finished, and holds nothing up", async () => {
  fixture.boxes = [
    fixtureBox("f1", "A card whose picture will not come", "facilitator",
      "Before.\n\n![a shot that fails](/uploads/broken.png)\n\nAfter."),
    fixtureBox("p1", "Another lane's card", "pastureland", "Plain words."),
  ];
  const { browser, page } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 20000 });
    const art = await readArt(page);
    assert.equal(art.shown.length, 1, "the failing picture was not drawn at all");
    assert.equal(art.shown[0].complete, true, "a failed picture was left looking unfinished");
    assert.equal(art.shown[0].natural, 0, "the fixture served the picture after all");
  } finally {
    await browser.close();
    fixture.reset();
  }
});

// ---- readiness: the typing row's own two faces ---------------------------------------
// On a board that has the composer's typed formatting on, the row wears it only
// once the vendored editor has landed. That file is fetched on its own, so a
// board can be drawn and still while the row is the plain field it started as,
// and the swap that follows changes the row's height. A curtain lifted in
// between hands the reader a card that then moves, which is the one thing this
// gate exists to prevent.

// what the shown card's typing row is made of right now, and how tall it is
async function readRow(page) {
  return page.evaluate(() => {
    const card = document.querySelector("#cards .box.sel");
    if (!card) return { card: false };
    const compose = card.querySelector(".compose");
    const editor = card.querySelector(".cffield");
    const plain = card.querySelector("textarea:not(.cfmirror)");
    return {
      card: true,
      formatted: !!editor,
      plain: !!plain,
      height: compose ? Math.round(compose.getBoundingClientRect().height) : 0,
    };
  });
}

test("the curtain waits for the typing row's editor, and the row is the one it hands over", async () => {
  fixture.holdEditor = true;
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    // the board is read and drawn, and the layout has had every chance to settle
    await page.waitForFunction(() => lastState !== null, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 3500));
    const waiting = await readRow(page);
    assert.equal(waiting.card, true, "no card was on show to have a row at all");
    assert.equal(waiting.formatted, false, "the fixture let the editor through");
    assert.equal(waiting.plain, true, "the row was neither the plain field nor the editor");
    const curtain = await readCurtain(page);
    assert.equal(curtain.present, true,
      "the curtain came down while the row was still going to change under it");
    assert.equal(curtain.opacity, 1, "the curtain began fading over a row that had not settled");
    assert.equal(curtain.down, false, "the globe reddened over a connection that was fine");
    assert.deepEqual(curtain.play, ["running"], "the globe stopped while the row was still arriving");
    assert.equal(await page.evaluate(() => startupStill), false,
      "the page called itself still while the row was still to change");
    await shot(page, "startup-editor-held");

    // the editor lands: the row takes its final face, and only then is it shown
    fixture.releaseEditor();
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 30000 });
    const shown = await readRow(page);
    assert.equal(shown.formatted, true, "the curtain went without the editor the setting asks for");
    assert.ok(shown.height >= waiting.height,
      `the row shrank under the reader: ${waiting.height} then ${shown.height}`);
    // and the row that was handed over is the row that stays: nothing moves after
    const settled = await page.evaluate(() => ({
      still: startupStill, drew: startupDrew,
      rowH: Math.round(document.querySelector("#cards .box.sel .compose").getBoundingClientRect().height),
    }));
    await new Promise(resolve => setTimeout(resolve, 700));
    const after = await page.evaluate(() =>
      Math.round(document.querySelector("#cards .box.sel .compose").getBoundingClientRect().height));
    await shot(page, "startup-editor-landed");
    assert.deepEqual({ still: settled.still, drew: settled.drew }, { still: true, drew: true });
    assert.equal(after, settled.rowH, "the row moved after the curtain had gone");
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("an editor that can never arrive is an ending, and the plain row is handed over", async () => {
  // the honest fallback. a refusal is an answer, so the wait ends, the row stays
  // the field it already was and the reader gets a working board rather than a
  // curtain held for a file that is never coming
  fixture.editor = "gone";
  const { browser, page } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const row = await readRow(page);
    assert.equal(row.card, true);
    assert.equal(row.formatted, false, "the fixture served the editor after all");
    assert.equal(row.plain, true, "the row was left with nothing to type in");
    const typed = await page.evaluate(async () => {
      const ta = document.querySelector("#cards .box.sel textarea:not(.cfmirror)");
      ta.focus();
      ta.value = "typed with no editor at all";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return { value: ta.value, available: ComposeFormat.available() };
    });
    assert.equal(typed.value, "typed with no editor at all", "the plain row would not take words");
    assert.equal(typed.available, false, "the page did not know the editor could not be had");
  } finally {
    await browser.close();
    fixture.reset();
  }
});

// ---- readiness: a reading that was fetched but never drawn ---------------------------
// The last thing elapsed time could have been mistaken for. A reading arrives,
// the pass over the cards throws part way through, and nothing is on the screen.
// Holding that reading's revision would tell the board the phone has it, the next
// reading would answer "nothing new", and the pass would never be tried again, so
// the curtain has to answer to the drawing rather than to the holding.

// serve a page whose pass over the cards throws the first `times` times it runs.
// the count lives in the page so a test can set it again later
function faultingPage(source, times) {
  return source.replace("function apply(state){", `function apply(state){
    if (window.__faultApply > 0){ window.__faultApply -= 1; throw new Error("fixture apply fault"); }`)
    .replace("<body>", `<body>\n<script>window.__faultApply = ${times};</script>`);
}

test("a reading that would not draw never releases the curtain, and is asked for again", async () => {
  const original = mHtml;
  // three passes throw, so the curtain has to stand through several ordinary
  // polls rather than through one
  mHtml = faultingPage(original, 3);
  const { browser, page } = await openInstalled(fixture);
  try {
    // the board answers, the pass throws, and the page has drawn nothing
    await page.waitForFunction(() => window.__faultApply < 3, { timeout: 15000 });
    const readsAtFault = fixture.reads;
    // past the minimum hold and the fade, so the curtain being here is the
    // curtain having stayed rather than the curtain not having had time to go
    await page.waitForFunction(() => performance.now() - window.__loadAt > 1800, { timeout: 10000 });
    const held = await page.evaluate(() => ({
      curtain: !!document.getElementById("loading"),
      down: document.getElementById("loading")?.classList.contains("down"),
      liftedAt: window.__liftAt,
      drewBoard, still: startupStill,
      stated: document.body.classList.contains("stated"),
      cards: document.getElementById("cards").childElementCount,
      lastRev, hasState: !!lastState,
    }));
    assert.equal(held.curtain, true, "the curtain came down over a board that was never drawn");
    assert.equal(held.liftedAt, null, "the curtain began to fade over a board that was never drawn");
    assert.equal(held.drewBoard, false, "a pass that threw was counted as a drawing");
    assert.equal(held.still, false, "an undrawn page was called settled");
    assert.equal(held.stated, false, "the page claimed a reading it never drew");
    assert.equal(held.cards, 0);
    // the failed reading's revision is not held: the next poll takes the whole
    // board again rather than being told there is nothing new
    assert.equal(held.lastRev, null, "the page held the revision of a reading it could not draw");
    assert.equal(held.hasState, false, "the page kept a reading that never reached the screen");
    // A SUCCESSFUL FETCH THAT WOULD NOT DRAW IS NOT A CONNECTION FAILURE. The
    // board answered, so the globe stays black and turning rather than going red.
    assert.equal(held.down, false, "a render fault was reported as an unreachable board");
    const curtain = await readCurtain(page);
    assert.deepEqual(curtain.play, ["running"], "the globe stopped over a board that answered");
    assert.equal(curtain.border, "rgb(0, 0, 0)");
    const { moved } = await movedSince(page, curtain);
    assert.equal(moved, true, "the globe was not turning while the page was still trying");

    // it keeps asking, on the ordinary poll, and every answer is a whole board
    await page.waitForFunction(() => window.__faultApply === 0, { timeout: 20000 });
    const stillHeld = await page.evaluate(() => ({
      curtain: !!document.getElementById("loading"),
      stated: document.body.classList.contains("stated"),
    }));
    assert.equal(stillHeld.curtain, true, "the curtain went while passes were still throwing");
    assert.equal(stillHeld.stated, false);
    assert.ok(fixture.reads > readsAtFault + 1,
      "the page stopped asking after the pass threw: " + fixture.reads + " vs " + readsAtFault);

    // the next ordinary poll draws it, with nothing reset by hand and no special
    // answer from the board, and only then does the curtain go
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const done = await page.evaluate(() => ({
      cards: document.getElementById("cards").childElementCount,
      shown: !!document.querySelector("#cards .box.sel"),
      blank: document.getElementById("pane").classList.contains("blank"),
      stated: document.body.classList.contains("stated"),
      drewBoard, still: startupStill, lastRev, frames: startupFrames,
    }));
    assert.equal(done.cards, FIXTURE_BOXES.length, "the board never drew");
    assert.equal(done.shown, true, "no card was on show when the curtain came down");
    assert.equal(done.blank, false);
    assert.deepEqual([done.stated, done.drewBoard, done.still], [true, true, true]);
    assert.equal(done.lastRev, 7, "the revision was not held once it had really been drawn");
    assert.ok(done.frames >= 4, "the stillness watch did not run on the drawn board");
  } finally {
    await browser.close();
    mHtml = original;
    fixture.reset();
  }
});

test("a pass that throws after the start never brings the curtain back", async () => {
  const original = mHtml;
  mHtml = faultingPage(original, 0);   // the start itself goes normally
  const { browser, page } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const before = await page.evaluate(() => ({
      cards: document.getElementById("cards").childElementCount,
      title: document.querySelector("#cards .box.sel .title")?.textContent,
    }));
    assert.equal(before.cards, FIXTURE_BOXES.length);

    // a new reading arrives and its pass throws twice
    await page.evaluate(() => { window.__faultApply = 2; });
    fixture.boxes = [
      fixtureBox("f1", "The card, renamed by the board", "facilitator", "A newer answer."),
      fixtureBox("p1", "Another lane's card", "pastureland", "Its own lane's answer."),
    ];
    fixture.rev = 8;
    await page.waitForFunction(() => window.__faultApply < 2, { timeout: 20000 });
    const during = await page.evaluate(() => ({
      curtain: !!document.getElementById("loading"),
      cards: document.getElementById("cards").childElementCount,
      stated: document.body.classList.contains("stated"),
      lastRev,
    }));
    assert.equal(during.curtain, false, "a later pass that threw brought the startup curtain back");
    assert.equal(during.cards, FIXTURE_BOXES.length, "the board already on screen was taken away");
    assert.equal(during.stated, true);
    assert.equal(during.lastRev, null, "the revision of a reading that would not draw was held");

    // and the ordinary poll keeps trying until it draws, with the curtain still gone
    await page.waitForFunction(
      () => document.querySelector("#cards .box.sel .title")?.textContent === "The card, renamed by the board",
      { timeout: 25000 });
    const after = await page.evaluate(() => ({
      curtain: !!document.getElementById("loading"),
      lastRev, cards: document.getElementById("cards").childElementCount,
    }));
    assert.equal(after.curtain, false, "the curtain came back on the recovery");
    assert.equal(after.lastRev, 8, "the newer revision was not held once it had drawn");
    assert.equal(after.cards, FIXTURE_BOXES.length);
  } finally {
    await browser.close();
    mHtml = original;
    fixture.reset();
  }
});

// ---- where the globe sits, and where the card's foot lands ---------------------------
// These cover one conditional relationship: when a fixed containing block is
// shorter than a viewport-height unit reads, a box sized from the block stays
// inside it and a box sized from the unit does not.
//
// The cases fall into two kinds.
//
//   The plain ones run in an ordinary window, where the two numbers are equal.
//   They cannot separate a page sized one way from a page sized the other, so
//   they are a floor and not a proof. The earlier pair passed on both sources,
//   which is that limit.
//
//   The divergent ones create the inequality with a mechanism this engine
//   implements: a transform on the root makes the root the containing block for
//   fixed children, so a fixed child sized in per cent follows the root while
//   the same child sized in vh keeps reading the window. This is a deliberately
//   introduced condition. It shows what the page does when a block is shorter
//   than the unit. It does not show that any device produces that condition, and
//   a pass here is not a pass on a phone. Each case asserts the condition took
//   hold first, so an engine that declines it fails loudly rather than passing
//   on a condition it never created.

// the curtain's box and the globe's centre, against the viewport
async function readGlobeBox(page) {
  return page.evaluate(() => {
    const el = document.getElementById("loading");
    const globe = el.querySelector(".globe");
    const panel = el.getBoundingClientRect();
    const ball = globe.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      // the document's own box: a root shorter than the viewport is the shape of
      // the iOS letterbox, and the curtain would inherit it
      root: [document.documentElement.clientWidth, document.documentElement.clientHeight],
      body: [Math.round(document.body.getBoundingClientRect().width),
             Math.round(document.body.getBoundingClientRect().height)],
      panel: [panel.left, panel.top, panel.width, panel.height],
      centre: [ball.left + ball.width / 2, ball.top + ball.height / 2],
      size: [ball.width, ball.height],
    };
  });
}

test("the curtain is the whole viewport and the globe is its exact middle", async () => {
  fixture.mode = "hang";   // the curtain stays up while it is measured
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    // a tall phone, a small one, and a large one. the globe is centred on every
    // one of them, and its size follows the shorter edge the way it is written
    for (const shape of [
      { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      { width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      { width: 430, height: 932, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    ]) {
      await phoneScreen(page, shape);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
      const box = await readGlobeBox(page);
      const where = shape.width + "x" + shape.height;
      // the document is the viewport, not something shorter standing in it
      assert.deepEqual(box.root, box.viewport, "the document's box is not the viewport at " + where);
      assert.deepEqual(box.body, box.viewport, "the body's box is not the viewport at " + where);
      // the curtain is the whole of it, from the very corner
      const wanted = [0, 0, box.viewport[0], box.viewport[1]];
      for (const [i, name] of ["left", "top", "width", "height"].entries()) {
        assert.ok(Math.abs(box.panel[i] - wanted[i]) < 0.5,
          "the curtain's " + name + " is not the viewport's at " + where +
          ": " + box.panel[i] + " against " + wanted[i]);
      }
      // and the globe's middle is the viewport's middle
      assert.ok(Math.abs(box.centre[0] - box.viewport[0] / 2) < 0.5,
        "the globe is off centre across at " + where + ": " + box.centre[0]);
      assert.ok(Math.abs(box.centre[1] - box.viewport[1] / 2) < 0.5,
        "the globe is off centre down at " + where + ": " + box.centre[1]);
      // 14vmin of the shorter edge, border included
      const vmin = Math.min(box.viewport[0], box.viewport[1]) / 100;
      assert.ok(Math.abs(box.size[0] - vmin * 14) < 0.5,
        "the globe is the wrong size at " + where + ": " + box.size[0]);
      assert.ok(Math.abs(box.size[0] - box.size[1]) < 0.5, "the globe is not round at " + where);
    }
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("nothing the app does to its own layout moves the globe", async () => {
  fixture.mode = "hang";
  const { browser, page } = await openInstalled(fixture);
  try {
    const before = await readGlobeBox(page);
    // the page's safe-area padding, the drawer's scale on the page, and the
    // keyboard's shell box are the three things that change the app's own
    // geometry. none of them is an ancestor of the curtain, so none may move it
    await page.evaluate(() => {
      const page_ = document.getElementById("page");
      page_.style.setProperty("--app-inset", "24px");
      page_.style.setProperty("--page-scale", "0.85");
      document.body.classList.add("obstructed");
      document.body.style.setProperty("--shell-top", "40px");
      document.body.style.setProperty("--shell-h", "500px");
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));
    const after = await readGlobeBox(page);
    assert.deepEqual(after.centre, before.centre,
      "the app's own layout moved the startup globe");
    assert.deepEqual(after.panel, before.panel,
      "the app's own layout resized the startup curtain");
    // and the curtain is still a child of the body rather than of the scaled page
    const parent = await page.evaluate(() => document.getElementById("loading").parentElement.tagName);
    assert.equal(parent, "BODY");
  } finally {
    await browser.close();
    fixture.reset();
  }
});

// Resolve CSS lengths by measuring them, one probe per length.
//
// innerHeight and innerWidth are NOT usable as stand-ins for these here. Under
// the synthetic root below the mobile layout viewport can be reported as
// something else entirely, and a run showed innerHeight at 1446 while a real
// 100vh measured 844. So every length a case needs is read off a probe carrying
// that exact length.
//
// The probe is absolutely positioned inside the body, which is fixed and clips
// its overflow, so it adds nothing scrollable. Its height is a non-percentage
// length, which resolves against the unit rather than against any containing
// block, so it reads the unit itself.
async function cssLength(page, lengths) {
  return page.evaluate(list => {
    const out = {};
    for (const [name, css] of Object.entries(list)) {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;left:0;top:0;width:1px;visibility:hidden;" +
        "pointer-events:none;height:" + css;
      document.body.appendChild(probe);
      out[name] = probe.getBoundingClientRect().height;
      probe.remove();
    }
    return out;
  }, lengths);
}

// Make the fixed containing block shorter than the viewport units, and prove the
// condition took before anything is measured against it.
//
// The synthetic root is also pinned to the viewport's width and clipped. Without
// that, the drawers parked off both edges push the mobile layout viewport out
// and the numbers stop meaning anything. None of the rules under test is
// touched: the root gets a height, a width, a clip and a transform, and the root
// is not one of them.
const SHORT_BLOCK_PX = 700;
async function shortenFixedBlock(page, blockPx = SHORT_BLOCK_PX) {
  await page.evaluate(px => {
    const style = document.createElement("style");
    style.id = "divergent-block";
    style.textContent =
      "html{height:" + px + "px !important; width:100% !important;" +
      "max-width:100% !important; overflow:hidden !important;" +
      "transform:translateZ(0) !important}";
    document.head.appendChild(style);
  }, blockPx);
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r())));

  const units = await cssLength(page, { vh: "100vh", lvh: "100lvh", vmin14: "14vmin" });
  const block = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;left:0;top:0;width:1px;visibility:hidden;" +
      "pointer-events:none;height:100%";
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    probe.remove();
    return h;
  });

  assert.ok(Math.abs(block - blockPx) < 1,
    "the condition did not take: a fixed child sized in per cent measured " +
    block + " rather than the root's " + blockPx +
    ". This engine did not make the transformed root the containing block, so " +
    "nothing below would be testing what it says it tests.");
  assert.ok(units.vh - block > 50,
    "the fixed block is not shorter than a resolved 100vh by enough to tell " +
    "anything: block " + block + " against vh " + units.vh);
  assert.ok(units.lvh - block > 50,
    "the fixed block is not shorter than a resolved 100lvh by enough to tell " +
    "anything: block " + block + " against lvh " + units.lvh);
  return { block, ...units };
}

// Wait for a transitioned length to stop moving. #page transitions its bottom
// padding on the keyboard's own clock, so a value read in the same task as the
// change is the value before the change. Product code keeps that transition.
async function settledPaddingBottom(page, atLeast) {
  await page.waitForFunction(floor => {
    const el = document.getElementById("page");
    const now = parseFloat(getComputedStyle(el).paddingBottom);
    const was = window.__lastFoot;
    window.__lastFoot = now;
    return now >= floor - 0.5 && was !== undefined && Math.abs(now - was) < 0.05;
  }, { timeout: 8000, polling: "raf" }, atLeast);
  await page.evaluate(() => { delete window.__lastFoot; });
  return page.evaluate(() =>
    parseFloat(getComputedStyle(document.getElementById("page")).paddingBottom));
}

test("a window shorter than its own vh keeps the card's foot inside it", async () => {
  // the board drawn and the curtain gone, so the card is at its full height
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const took = await shortenFixedBlock(page);
    const box = await page.evaluate(() => {
      const body = document.body.getBoundingClientRect();
      const pane = document.getElementById("pane").getBoundingClientRect();
      const page_ = document.getElementById("page");
      const composer = document.querySelector("#cards .box.sel .compose");
      return {
        body: body.height,
        paneBottom: pane.bottom,
        foot: parseFloat(getComputedStyle(page_).paddingBottom),
        hasComposer: !!composer,
        composerBottom: composer ? composer.getBoundingClientRect().bottom : null,
      };
    });
    // the page's column is the box it was given, not the number a unit reads
    assert.ok(Math.abs(box.body - took.block) < 1,
      "the page's column is not the box it was given: " + box.body +
      " against " + took.block + ", with a resolved 100vh of " + took.vh +
      ". A column sized from a viewport-height unit lands here.");
    // and the card's foot, plus the clearance under it, is inside that box
    assert.ok(box.paneBottom <= took.block + 0.5,
      "the card's foot is below the box it was given: " + box.paneBottom +
      " against " + took.block);
    assert.ok(box.paneBottom + box.foot <= took.block + 0.5,
      "the card's foot clearance runs past the box: " +
      (box.paneBottom + box.foot) + " against " + took.block);
    // the composer has to be there for its position to mean anything
    assert.ok(box.hasComposer,
      "no composer on the shown card, so this case would prove nothing about it");
    assert.ok(box.composerBottom <= took.block + 0.5,
      "the composer is below the box it was given: " + box.composerBottom +
      " against " + took.block);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

test("a window shorter than its own vh still centres the globe on the window", async () => {
  fixture.mode = "hang";   // the curtain stays up while it is measured
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    // the globe's size before the condition is introduced, to compare against
    const before = await readGlobeBox(page);
    const took = await shortenFixedBlock(page);
    const box = await readGlobeBox(page);
    // everything below is taken from the panel's own rectangle and from measured
    // lengths, never from innerHeight or innerWidth
    const panelTop = box.panel[1], panelLeft = box.panel[0];
    const panelH = box.panel[3], panelW = box.panel[2];
    // Installed, the curtain is the screen's own measure and not the box it is
    // offered. Those are two different boxes for the first frames of a cold open:
    // the web view hands the page the screen less the status bar and only settles
    // to the whole screen once the root has overhung it, and a curtain pinned to
    // the offered box is drawn short, with the globe in the middle of it sitting
    // high until the settle lands. A browser tab keeps no curtain at all, so the
    // containing-block rule this case was written for is unaffected there.
    assert.ok(Math.abs(panelH - took.vh) < 1,
      "the curtain is not the screen's own measure: " + panelH +
      " against a resolved 100vh of " + took.vh + ", with the offered box at " + took.block);
    // and the globe's middle is the panel's middle, not half of what a unit reads
    const wanted = panelTop + panelH / 2;
    const lvhWould = panelTop + took.lvh / 2;
    assert.ok(Math.abs(box.centre[1] - wanted) < 0.5,
      "the globe is off centre down by " + (box.centre[1] - wanted).toFixed(1) +
      "px: it sits at " + box.centre[1] + ", the panel's middle is " + wanted +
      ", and half of a resolved 100lvh below the panel's top would be " + lvhWould);
    // across, against the panel's own width
    assert.ok(Math.abs(box.centre[0] - (panelLeft + panelW / 2)) < 0.5,
      "the globe moved sideways: " + box.centre[0] +
      " against the panel's middle at " + (panelLeft + panelW / 2));
    // the size follows a length, not the block: it must read the same as the
    // measured 14vmin and as the size it had before the condition
    assert.ok(Math.abs(box.size[0] - took.vmin14) < 0.5,
      "the globe is not the size a measured 14vmin resolves to: " + box.size[0] +
      " against " + took.vmin14);
    assert.ok(Math.abs(box.size[0] - before.size[0]) < 0.5,
      "the globe changed size when the block shortened: " + before.size[0] +
      " became " + box.size[0]);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});

const FOOT_INSET_PX = 40;

test("the card's foot clears the bottom inset it is given, before and after the curtain", async () => {
  // No synthetic condition here. This is the clearance arithmetic on its own:
  // whatever --pad-b resolves to has to stay between the card's foot and the
  // bottom of the page's box, with the curtain up and again once it has gone.
  //
  // #page transitions its bottom padding, so every reading below waits for that
  // transition to finish first. The transition is product behaviour and stays.
  fixture.mode = "hang";
  const { browser, page, problems } = await openInstalled(fixture);
  try {
    const read = () => page.evaluate(() => {
      const page_ = document.getElementById("page");
      const box = page_.getBoundingClientRect();
      const pane = document.getElementById("pane").getBoundingClientRect();
      return {
        pageBottom: box.bottom,
        paneBottom: pane.bottom,
        foot: parseFloat(getComputedStyle(page_).paddingBottom),
        body: document.body.getBoundingClientRect().height,
      };
    });
    const setInset = () => page.evaluate(px => {
      document.getElementById("page").style.setProperty("--app-inset", px + "px");
    }, FOOT_INSET_PX);

    // a generous bottom inset, written where the safe area is added, so the same
    // calc is exercised without claiming to be a notch
    await setInset();
    const coveredFoot = await settledPaddingBottom(page, FOOT_INSET_PX);
    const covered = await read();
    const units = await cssLength(page, { vh: "100vh" });
    assert.ok(coveredFoot >= FOOT_INSET_PX - 0.5,
      "the bottom inset never settled at its target: " + coveredFoot);
    assert.ok(Math.abs(covered.foot - coveredFoot) < 0.5,
      "the bottom padding moved again after it settled: " + coveredFoot +
      " then " + covered.foot);
    assert.ok(covered.paneBottom + covered.foot <= covered.pageBottom + 0.5,
      "with the curtain up the card's foot ate its clearance: foot at " +
      covered.paneBottom + " plus " + covered.foot + " against " + covered.pageBottom);
    assert.ok(covered.body <= units.vh + 0.5,
      "the page's column is taller than a resolved 100vh: " + covered.body +
      " against " + units.vh);

    // now let the board arrive and the curtain go, and check the same thing
    fixture.mode = "ok";
    for (const res of fixture.hung.splice(0)) res.destroy();
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    await setInset();
    const loadedFoot = await settledPaddingBottom(page, FOOT_INSET_PX);
    const loaded = await read();
    assert.ok(loadedFoot >= FOOT_INSET_PX - 0.5,
      "the bottom inset never settled at its target once the board was drawn: " + loadedFoot);
    assert.ok(loaded.paneBottom + loaded.foot <= loaded.pageBottom + 0.5,
      "with the board drawn the card's foot ate its clearance: foot at " +
      loaded.paneBottom + " plus " + loaded.foot + " against " + loaded.pageBottom);
    assert.ok(loaded.body <= units.vh + 0.5,
      "the page's column is taller than a resolved 100vh once the board is drawn: " +
      loaded.body + " against " + units.vh);
    const composer = await page.evaluate(() => {
      const el = document.querySelector("#cards .box.sel .compose");
      return el ? el.getBoundingClientRect().bottom : null;
    });
    assert.ok(composer !== null,
      "no composer on the shown card, so this case would prove nothing about it");
    assert.ok(composer <= loaded.pageBottom + 0.5,
      "the composer is past the foot of the page: " + composer +
      " against " + loaded.pageBottom);
    assert.deepEqual(problems, []);
  } finally {
    await browser.close();
    fixture.reset();
  }
});
