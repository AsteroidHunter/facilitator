// The phone page's motion, driven headless at an iPhone size against its own
// fixture server: the card's two fades, the sent box's arrival, the send that
// lands at once and moves on, the card list (the card goes down by 55% of the
// screen while the ticket box comes in from the left above it, both on one
// fraction), the settings crossing the page from the right on one straight
// sideways line at full strength while the shade under them grows and the page
// itself draws back towards the middle of the screen, and the tab bar keeping
// its scroll.
// Screenshots land under /tmp/m362-motion-shots.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { REST, SINK } = require("./phone-rest-geometry.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = "/tmp/m362-motion-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LONG_REPLY = Array.from({ length: 16 }, (_, i) =>
  `Paragraph ${i + 1}. The answer runs on for long enough to scroll under the title and to end against the sent box at the foot of the card.`).join("\n\n");

let browser;
let child;
let fixtureDir;
let origin;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const result = await api("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function openPhone(route, { viewport = PHONE, reduced = false } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(viewport);
  if (reduced) await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

// every part of a menu's motion, read off the menu and off the page it draws
// back. the page is read twice over: the picture, which is what the eye sees
// and what the transform changes, and the layout, which must not move at all
async function readMenu(page, sel) {
  return page.evaluate(one => {
    const panel = document.querySelector(one);
    const surface = document.getElementById("page");
    const p = getComputedStyle(surface), q = getComputedStyle(panel);
    const shade = getComputedStyle(panel, "::after");   // the depth lives on its own layer
    const pageRect = surface.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const pm = new DOMMatrix(p.transform);
    const qm = new DOMMatrix(q.transform);
    return {
      open: panel.classList.contains("open"),
      shift: Math.round(qm.m41),
      // the fraction the menu is out by, off the menu's own geometry
      out: 1 - Math.abs(qm.m41) / panelRect.width,
      pageScale: pm.a,
      pageScaleY: pm.d,
      pageShift: pm.m41,
      pageLift: pm.m42,
      radius: p.borderTopLeftRadius,
      pageShade: p.boxShadow,
      pageLeft: pageRect.left,
      pageRight: innerWidth - pageRect.right,
      pageTop: pageRect.top,
      pageFoot: innerHeight - pageRect.bottom,
      pageWidth: pageRect.width,
      pageHeight: pageRect.height,
      pageMidX: (pageRect.left + pageRect.right) / 2,
      pageMidY: (pageRect.top + pageRect.bottom) / 2,
      // the layout the picture is drawn from, which the transform cannot touch
      pageLayoutWidth: surface.offsetWidth,
      pageLayoutHeight: surface.offsetHeight,
      pageMs: p.transitionDuration,
      pageMoves: p.transitionProperty,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      shade: q.boxShadow,
      width: Math.round(panelRect.width),
      height: Math.round(panelRect.height),
      top: Math.round(panelRect.top),
      foot: Math.round(panelRect.bottom),
      left: Math.round(panelRect.left),
      right: Math.round(innerWidth - panelRect.right),
      corners: [q.borderTopLeftRadius, q.borderTopRightRadius, q.borderBottomRightRadius, q.borderBottomLeftRadius],
      lift: Math.round(new DOMMatrix(q.transform).m42),
      fade: Number(q.opacity).toFixed(2),
      depth: Number(shade.opacity),
      depthShade: shade.boxShadow,
      depthMs: shade.transitionDuration,
      scrim: Number(getComputedStyle(document.getElementById("scrim")).opacity).toFixed(2),
      ms: q.transitionDuration,
      curve: q.transitionTimingFunction,
      panelMs: q.transitionDuration,
    };
  }, sel);
}

// how far in the page is drawn with a menu the whole way out, and the size it
// is drawn at for any fraction of the run. the page keeps its place: it only
// grows a little smaller about its own middle. it starts from its resting size,
// which is already REST of the screen and laid out that way, so the picture is
// that much of the screen times the drawing back
const PAGE_SINK = SINK;
const pageSizeAt = v => 1 - PAGE_SINK * v;
const pictureAt = v => REST * pageSizeAt(v);

// a laid-out size is a whole number of pixels, so it is off the true one by up to one
const WHOLE = 1.01;

// the page at one moment of a run: drawn back by exactly what the menu is worth,
// evenly on all four sides, around the middle of the screen, and laid out at its
// resting size, a share of the screen's own, throughout
function assertPageDrewBack(shape, v, where) {
  const want = pageSizeAt(v);
  if (v === 0) assert.equal(shape.pageScale, 1, `the page did not come back to its resting size ${where}`);
  assert.ok(Math.abs(shape.pageScale - want) < 0.0015,
    `the page is not drawn back to ${want.toFixed(4)} ${where} (${shape.pageScale})`);
  assert.equal(shape.pageScale, shape.pageScaleY, `the page drew back unevenly ${where}`);
  assert.equal(shape.pageShift, 0, `the page moved sideways ${where}`);
  assert.equal(shape.pageLift, 0, `the page moved up or down ${where}`);
  // nothing was laid out again: the page still owns its resting share of the screen
  assert.ok(Math.abs(shape.pageLayoutWidth - shape.viewportWidth * REST) <= WHOLE,
    `the page's laid-out width changed ${where} (${shape.pageLayoutWidth})`);
  assert.ok(Math.abs(shape.pageLayoutHeight - shape.viewportHeight * REST) <= WHOLE,
    `the page's laid-out height changed ${where} (${shape.pageLayoutHeight})`);
  // and the picture steps in by the same amount on facing edges, about the middle
  assert.ok(Math.abs(shape.pageLeft - shape.pageRight) < 0.01,
    `the page's side steps differ ${where} (${shape.pageLeft} and ${shape.pageRight})`);
  assert.ok(Math.abs(shape.pageTop - shape.pageFoot) < 0.01,
    `the page's top and foot steps differ ${where} (${shape.pageTop} and ${shape.pageFoot})`);
  assert.ok(Math.abs(shape.pageMidX - shape.viewportWidth / 2) < 0.01,
    `the page left the middle of the screen sideways ${where} (${shape.pageMidX})`);
  assert.ok(Math.abs(shape.pageMidY - shape.viewportHeight / 2) < 0.01,
    `the page left the middle of the screen up or down ${where} (${shape.pageMidY})`);
  const sideStep = shape.viewportWidth * (1 - pictureAt(v)) / 2;
  const endStep = shape.viewportHeight * (1 - pictureAt(v)) / 2;
  assert.ok(Math.abs(shape.pageLeft - sideStep) < 0.05,
    `the page's side step is not what its size is worth ${where} (${shape.pageLeft} for ${sideStep})`);
  assert.ok(Math.abs(shape.pageTop - endStep) < 0.05,
    `the page's top step is not what its size is worth ${where} (${shape.pageTop} for ${endStep})`);
  assert.equal(shape.radius, "0px", `the page rounded ${where}`);
  assert.equal(shape.pageShade, "none", `the page took the drawer shade ${where}`);
}

// the page, the menu's travel, the shade over the page and the shade under the
// menu, all read in the same frame, so what is proved of them is proved of one
// moment and not of four readings taken apart
async function startPageSamples(page, duration = 700) {
  await page.evaluate(ms => {
    window.__pageSamples = [];
    const until = performance.now() + ms;
    const take = () => {
      const el = document.getElementById("page");
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const m = new DOMMatrix(style.transform);
      let out = 0, depth = 0;
      for (const one of ["#settings"]) {
        const panel = document.querySelector(one);
        const at = 1 - Math.abs(new DOMMatrix(getComputedStyle(panel).transform).m41) /
          panel.getBoundingClientRect().width;
        if (at > out) { out = at; depth = Number(getComputedStyle(panel, "::after").opacity); }
      }
      window.__pageSamples.push({
        left: rect.left, right: innerWidth - rect.right,
        top: rect.top, foot: innerHeight - rect.bottom,
        midX: (rect.left + rect.right) / 2, midY: (rect.top + rect.bottom) / 2,
        layoutWidth: el.offsetWidth, layoutHeight: el.offsetHeight,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        scale: m.a, scaleY: m.d, shift: m.m41, lift: m.m42,
        radius: style.borderTopLeftRadius,
        out, depth,
        scrim: Number(getComputedStyle(document.getElementById("scrim")).opacity),
      });
      if (performance.now() < until) requestAnimationFrame(take);
    };
    requestAnimationFrame(take);
  }, duration);
}

// every frame of a menu's run, so the line it holds is read and not inferred
async function startMenuSamples(page, sel, duration = 900) {
  await page.evaluate((one, ms) => {
    window.__menuSamples = [];
    const panel = document.querySelector(one);
    const until = performance.now() + ms;
    const take = () => {
      const style = getComputedStyle(panel);
      const shade = getComputedStyle(panel, "::after");
      const rect = panel.getBoundingClientRect();
      const m = new DOMMatrix(style.transform);
      window.__menuSamples.push({
        x: m.m41, y: m.m42, top: rect.top, bottom: rect.bottom,
        height: rect.height, width: rect.width,
        opacity: Number(style.opacity), visibility: style.visibility,
        depth: Number(shade.opacity),
      });
      if (performance.now() < until) requestAnimationFrame(take);
    };
    requestAnimationFrame(take);
  }, sel, duration);
}

// the whole of what was asked of the run: it goes sideways and only sideways,
// at full strength for every frame of it, and the one thing that grows on the
// way is the shade underneath, which is worth exactly how far out the menu is.
// what it hands back is the shade's own story
async function assertMenuHeldItsLine(page, where) {
  const samples = await page.evaluate(() => window.__menuSamples || []);
  assert.ok(samples.length >= 20, `too few menu frames sampled ${where}: ${samples.length}`);
  const seen = samples.filter(s => s.visibility === "visible");
  assert.ok(seen.length >= 20, `the menu was not on show through the run ${where}: ${seen.length}`);
  for (const [i, s] of samples.entries()) {
    assert.ok(Math.abs(s.y) < 0.01, `the menu left its line at frame ${i} ${where} (${s.y})`);
    assert.ok(Math.abs(s.top) < 0.01, `the menu's head moved at frame ${i} ${where} (${s.top})`);
    assert.ok(Math.abs(s.bottom - s.height) < 0.01, `the menu's foot moved at frame ${i} ${where}`);
  }
  for (const [i, s] of seen.entries()) {
    assert.equal(s.opacity, 1, `the menu was see-through at frame ${i} ${where} (${s.opacity})`);
  }
  const xs = samples.map(s => s.x);
  const travel = Math.max(...xs) - Math.min(...xs);
  assert.ok(travel > 40, `the menu did not travel sideways ${where} (${travel})`);
  // the shade and the travel are one thing seen twice. a frame where they part
  // is a frame where the depth ran ahead of the menu or lagged behind it, which
  // is what a run cut short or turned around would show first
  let apart = 0;
  for (const [i, s] of seen.entries()) {
    const out = 1 - Math.abs(s.x) / s.width;
    apart = Math.max(apart, Math.abs(s.depth - out));
    assert.ok(Math.abs(s.depth - out) < 0.03,
      `the shade parted from the travel at frame ${i} ${where} (out ${out.toFixed(3)}, shade ${s.depth.toFixed(3)})`);
  }
  const depths = seen.map(s => s.depth);
  return { travel, apart, first: depths[0], last: depths[depths.length - 1],
           low: Math.min(...depths), high: Math.max(...depths) };
}

// the whole of what was asked of the page: it draws back and does nothing else,
// it stays in the middle of the screen and square to it, it is never laid out
// again, and on every frame the size it is drawn at is worth exactly what the
// menu's travel, the shade over it and the shade under the menu are worth. a
// frame where those four part is a frame where something is on a clock of its own
async function assertPageStayedCentred(page, where) {
  const samples = await page.evaluate(() => window.__pageSamples || []);
  assert.ok(samples.length >= 20, `too few page frames sampled ${where}: ${samples.length}`);
  let apart = 0;
  for (const [i, s] of samples.entries()) {
    assert.ok(Math.abs(s.shift) < 0.01, `the page moved sideways at frame ${i} ${where} (${s.shift})`);
    assert.ok(Math.abs(s.lift) < 0.01, `the page moved up or down at frame ${i} ${where} (${s.lift})`);
    assert.ok(Math.abs(s.scale - s.scaleY) < 1e-6, `the page drew back unevenly at frame ${i} ${where}`);
    assert.ok(s.scale <= 1 && s.scale >= pageSizeAt(1) - 0.0005,
      `the page left the depth it was given at frame ${i} ${where} (${s.scale})`);
    assert.ok(Math.abs(s.layoutWidth - s.viewportWidth * REST) <= WHOLE, `the page's laid-out width changed at frame ${i} ${where}`);
    assert.ok(Math.abs(s.layoutHeight - s.viewportHeight * REST) <= WHOLE, `the page's laid-out height changed at frame ${i} ${where}`);
    assert.ok(Math.abs(s.left - s.right) < 0.01, `the page's side steps parted at frame ${i} ${where}`);
    assert.ok(Math.abs(s.top - s.foot) < 0.01, `the page's top and foot steps parted at frame ${i} ${where}`);
    assert.ok(Math.abs(s.midX - s.viewportWidth / 2) < 0.01, `the page left the middle sideways at frame ${i} ${where}`);
    assert.ok(Math.abs(s.midY - s.viewportHeight / 2) < 0.01, `the page left the middle up or down at frame ${i} ${where}`);
    assert.equal(s.radius, "0px", `page rounded at frame ${i} ${where}`);
    const v = (1 - s.scale) / PAGE_SINK;
    apart = Math.max(apart, Math.abs(v - s.out), Math.abs(s.scrim - s.out), Math.abs(s.depth - s.out));
    assert.ok(Math.abs(v - s.out) < 0.05,
      `the page's depth parted from the travel at frame ${i} ${where} (out ${s.out.toFixed(3)}, page ${v.toFixed(3)})`);
    assert.ok(Math.abs(s.scrim - s.out) < 0.05,
      `the shade over the page parted from the travel at frame ${i} ${where} (out ${s.out.toFixed(3)}, shade ${s.scrim.toFixed(3)})`);
    assert.ok(Math.abs(s.depth - s.out) < 0.05,
      `the shade under the menu parted from the travel at frame ${i} ${where} (out ${s.out.toFixed(3)}, shade ${s.depth.toFixed(3)})`);
  }
  const sizes = samples.map(s => s.scale);
  return { frames: samples.length, apart, low: Math.min(...sizes), high: Math.max(...sizes) };
}

// the card list at one moment: the card (#pane) and the ticket box (#tickets)
// each read for how far it has gone, as a share of its own full run. the card's
// run is --list-drop down, the box's is its right edge's way in from the page's
// left edge, so both shares are read off the pictures and not off the number the
// script wrote. the box is seen through a window (#tikwin) that goes down with
// the card while the box goes up by as much: boxY is the two together, how far
// the box stands from its own place on the screen, and windowFoot is where the
// window ends, which is where the box stops being seen
async function readList(page) {
  return page.evaluate(() => {
    const surface = document.getElementById("page");
    const pane = document.getElementById("pane");
    const box = document.getElementById("tickets");
    const win = document.getElementById("tikwin");
    const sheet = document.querySelector("#dockbed > i");
    const ps = getComputedStyle(pane), bs = getComputedStyle(box), ws = getComputedStyle(win);
    const drop = parseFloat(getComputedStyle(surface).getPropertyValue("--list-drop"));
    const dm = new DOMMatrix(ps.transform), bm = new DOMMatrix(bs.transform), wm = new DOMMatrix(ws.transform);
    const run = box.offsetLeft + box.offsetWidth;
    const pr = pane.getBoundingClientRect(), br = box.getBoundingClientRect(), sr = surface.getBoundingClientRect();
    const wr = win.getBoundingClientRect();
    const tabs = box.querySelector("#tikhead").getBoundingClientRect();
    return {
      open: box.classList.contains("open"),
      live: box.classList.contains("live"),
      v: Number(ps.getPropertyValue("--list-v")),
      boxV: Number(bs.getPropertyValue("--list-v")),
      windowV: Number(ws.getPropertyValue("--list-v")),
      // how far the bed's second sheet stands below its raised place: nothing with the list out
      bedLift: new DOMMatrix(getComputedStyle(sheet).transform).m42,
      drop, run,
      down: dm.m42, across: dm.m41,
      cardAt: drop ? dm.m42 / drop : 0,
      boxAt: 1 + bm.m41 / run,
      boxY: wm.m42 + bm.m42, windowFoot: wr.bottom, windowClip: ws.overflowY, windowPointer: ws.pointerEvents,
      boxVisibility: bs.visibility,
      boxOpacity: Number(bs.opacity), cardOpacity: Number(ps.opacity),
      boxShade: bs.boxShadow, boxFill: bs.backgroundColor, boxAfter: getComputedStyle(box, "::after").content,
      paneMs: ps.transitionDuration, paneMoves: ps.transitionProperty, paneCurve: ps.transitionTimingFunction,
      boxMs: bs.transitionDuration, boxMoves: bs.transitionProperty, boxCurve: bs.transitionTimingFunction,
      cardPointer: ps.pointerEvents,
      cardLeft: pr.left, cardRight: pr.right, cardTop: pr.top, cardFoot: pr.bottom,
      boxLeft: br.left, boxRight: br.right, boxTop: br.top, boxFoot: br.bottom,
      boxWidth: br.width, boxHeight: br.height,
      tabsTop: tabs.top,
      cardRestTop: pane.offsetTop, cardRestLeft: pane.offsetLeft, cardWidth: pane.offsetWidth, cardHeight: pane.offsetHeight,
      pageLeft: sr.left, pageTop: sr.top, pageFoot: sr.bottom,
      pageScale: new DOMMatrix(getComputedStyle(surface).transform).a,
      scrim: Number(getComputedStyle(document.getElementById("scrim")).opacity),
      scrimPointer: getComputedStyle(document.getElementById("scrim")).pointerEvents,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      bodyHeight: document.body.clientHeight,
      shown: document.querySelector("article.box.sel")?.id || null,
      selected: selectedId,
    };
  });
}

// every frame of a run of the card list, card and box read in the same frame
async function startListSamples(page, duration = 900) {
  await page.evaluate(ms => {
    window.__listSamples = [];
    const surface = document.getElementById("page");
    const pane = document.getElementById("pane");
    const box = document.getElementById("tickets");
    const win = document.getElementById("tikwin");
    const until = performance.now() + ms;
    const take = () => {
      const ps = getComputedStyle(pane), bs = getComputedStyle(box);
      const drop = parseFloat(getComputedStyle(surface).getPropertyValue("--list-drop"));
      const dm = new DOMMatrix(ps.transform), bm = new DOMMatrix(bs.transform);
      const wm = new DOMMatrix(getComputedStyle(win).transform);
      const run = box.offsetLeft + box.offsetWidth;
      const br = box.getBoundingClientRect();
      window.__listSamples.push({
        cardAt: drop ? dm.m42 / drop : 0, boxAt: 1 + bm.m41 / run,
        across: dm.m41, boxY: wm.m42 + bm.m42,
        cardTop: pane.getBoundingClientRect().top, windowFoot: win.getBoundingClientRect().bottom,
        boxTop: br.top, boxFoot: br.bottom, boxLeft: br.left, boxRight: br.right,
        visibility: bs.visibility, boxOpacity: Number(bs.opacity), cardOpacity: Number(ps.opacity),
        paneTop: pane.offsetTop, paneHeight: pane.offsetHeight, paneWidth: pane.offsetWidth,
        boxOffsetW: box.offsetWidth, boxOffsetH: box.offsetHeight, boxOffsetLeft: box.offsetLeft,
        windowOffsetH: win.offsetHeight,
        pageScale: new DOMMatrix(getComputedStyle(surface).transform).a,
        scrim: Number(getComputedStyle(document.getElementById("scrim")).opacity),
      });
      if (performance.now() < until) requestAnimationFrame(take);
    };
    requestAnimationFrame(take);
  }, duration);
}

// the whole of what was asked of the card list's run: the card goes down and
// the box comes in on one fraction in every frame, straight down and straight
// across, at full strength, and nothing on the page is laid out again
async function assertListInStep(page, where) {
  const samples = await page.evaluate(() => window.__listSamples || []);
  assert.ok(samples.length >= 20, `too few card-list frames sampled ${where}: ${samples.length}`);
  let apart = 0;
  for (const [i, s] of samples.entries()) {
    assert.ok(Math.abs(s.cardAt - s.boxAt) < 0.03,
      `the card and the ticket box parted at frame ${i} ${where} (card ${s.cardAt.toFixed(3)}, box ${s.boxAt.toFixed(3)})`);
    apart = Math.max(apart, Math.abs(s.cardAt - s.boxAt));
    assert.ok(Math.abs(s.across) < 0.01, `the card moved sideways at frame ${i} ${where} (${s.across})`);
    assert.ok(Math.abs(s.boxY) < 0.01, `the ticket box moved up or down at frame ${i} ${where} (${s.boxY})`);
    // the box is seen down to the card's top edge and no further, so none of it
    // shows beside the card or under it
    assert.ok(Math.abs(s.windowFoot - s.cardTop) < 0.6,
      `the box is seen below the card's top edge at frame ${i} ${where} (window ends ${s.windowFoot}, card top ${s.cardTop})`);
    assert.equal(s.cardOpacity, 1, `the card was see-through at frame ${i} ${where}`);
    assert.equal(s.boxOpacity, 1, `the ticket box was see-through at frame ${i} ${where}`);
    assert.ok(Math.abs(s.pageScale - 1) < 1e-6, `the page drew back at frame ${i} ${where} (${s.pageScale})`);
    assert.equal(s.scrim, 0, `a shade came over the page at frame ${i} ${where}`);
  }
  // nothing was laid out again: every layout measure is the same in every frame
  for (const key of ["paneTop", "paneHeight", "paneWidth", "boxOffsetW", "boxOffsetH", "boxOffsetLeft", "windowOffsetH"])
    assert.equal(new Set(samples.map(s => s[key])).size, 1, `${key} changed while the card list ran ${where}`);
  const cards = samples.map(s => s.cardAt);
  const seen = samples.filter(s => s.visibility === "visible");
  return { frames: samples.length, apart, low: Math.min(...cards), high: Math.max(...cards), seen: seen.length };
}

// the box with the list out: nine tenths of the space the card's drop opens,
// each way, in the middle of it, with paper all round. the space is the card's
// own column across, and down from the top the card rests at to the top it has
// come down to; the box is seen down to that top and no further
function assertBoxInSpace(s, where) {
  const restTop = s.cardTop - s.down;
  const across = s.cardRight - s.cardLeft, down = s.cardTop - restTop;
  assert.ok(Math.abs(s.boxWidth - 0.9 * across) < 0.6, `the box is not nine tenths of the card's width ${where} (${s.boxWidth} of ${across})`);
  assert.ok(Math.abs(s.boxHeight - 0.9 * down) < 0.6, `the box is not nine tenths of the space's height ${where} (${s.boxHeight} of ${down})`);
  const left = s.boxLeft - s.cardLeft, right = s.cardRight - s.boxRight;
  const top = s.boxTop - restTop, foot = s.cardTop - s.boxFoot;
  assert.ok(left > 0 && Math.abs(left - right) < 0.6, `the box is not in the middle across ${where} (${left}, ${right})`);
  assert.ok(top > 0 && Math.abs(top - foot) < 0.6, `the box is not in the middle down ${where} (${top}, ${foot})`);
  assert.ok(Math.abs(s.windowFoot - s.cardTop) < 0.6, `the window does not end at the card's top ${where} (${s.windowFoot}, ${s.cardTop})`);
  assert.ok(Math.abs(s.boxY) < 0.01, `the box stands off its place ${where} (${s.boxY})`);
}

// a pull from an edge, held at a fraction of the menu's travel so the frame it
// stands on can be looked at, and then let go
async function pull(page, side, fraction, hold) {
  const width = await page.evaluate(right => right ? settings.offsetWidth : menuTravel(tickets), side === "right");
  const from = side === "right" ? 384 : 6;
  const travel = Math.round(width * fraction) * (side === "right" ? -1 : 1);
  await page.touchscreen.touchStart(from, 500);
  for (let step = 1; step <= 8; step++) await page.touchscreen.touchMove(from + Math.round(travel * step / 8), 500);
  if (hold) { await settle(100); await hold(); }   // the last move is taken on the next frame
  await page.touchscreen.touchEnd();
  await settle(750);
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-motion-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone motion test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the answer dissolves under the title as it scrolls and into the sent box at its foot", async () => {
  const id = await create("The card wears both fades");
  await api(`/reply?box=${id}`, LONG_REPLY);
  await api(`/send?box=${id}`, "A line sent and waiting");

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel .sentwrap .answered`, { timeout: 5000 });
    await settle(300);
    const rest = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const view = box.querySelector(".replyview");   // the answer's scroller owns the fades
      const wrap = box.querySelector(".pendwrap");
      const cs = getComputedStyle(view);
      return {
        wrapPosition: getComputedStyle(wrap).position,
        overlap: view.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top,
        band: cs.getPropertyValue("--boxband").trim(),
        wrapHeight: Math.round(wrap.getBoundingClientRect().height),
        up: cs.getPropertyValue("--upband").trim(),
        fade: cs.getPropertyValue("--replyfade").trim(),
        air: cs.marginBottom,   // --replyair is the answer's margin, and a length only once it is used
        mask: cs.webkitMaskImage,
        composite: cs.webkitMaskComposite || cs.maskComposite,
        runout: getComputedStyle(view, "::after").height,
        padding: cs.paddingBottom,
        scrolls: view.scrollHeight > view.clientHeight + 1,
      };
    });
    assert.equal(rest.wrapPosition, "absolute", "the sent box is not laid over the answer");
    assert.ok(rest.overlap > 40, `the answer does not run on under the box (${rest.overlap})`);
    assert.ok(Math.abs(parseFloat(rest.fade) - 22 * REST) < 0.01, `the ramp is not the desktop's depth at the page's size (${rest.fade})`);
    assert.ok(Math.abs(parseFloat(rest.air) - 3.5 * REST) < 0.01, `the clear air over the box is not the desktop's at the page's size (${rest.air})`);
    assert.ok(Math.abs(parseFloat(rest.band) - rest.wrapHeight) <= 0.51, "the ramp's top edge is not the box's top edge");
    assert.ok(rest.up === "" || rest.up === "0px", `an answer at rest carries a band under the title (${rest.up})`);
    assert.match(rest.mask, /linear-gradient/, "the answer carries no mask");
    assert.equal(rest.mask.match(/linear-gradient/g).length, 3, "the mask is not the desktop's three layers");
    assert.match(rest.composite, /intersect/);
    assert.ok(Math.abs(parseFloat(rest.runout) - (parseFloat(rest.band) + 22 * REST)) <= 0.51, `the scroll's run-out is not the band plus the ramp (${rest.runout})`);
    assert.equal(rest.padding, "0px", "the run-out is still the scroller's padding and not content");
    assert.equal(rest.scrolls, true, "the answer under test does not scroll");
    await shot(page, "fade-rest");

    // one pixel of scroll buys one pixel of ramp, and the ramp stops at its depth
    const scrolled = await page.evaluate(async () => {
      const view = document.querySelector("article.box.sel .replyview");
      const read = () => getComputedStyle(view).getPropertyValue("--upband").trim();
      // the band is written by the scroll event, which comes on the next frame, so
      // the read waits for that event and not for a fixed time
      const step = async to => {
        const landed = new Promise(r => { view.addEventListener("scroll", r, { once: true }); setTimeout(r, 2000); });
        view.scrollTop = to;
        await landed;
        return read();
      };
      return { small: await step(7), deep: await step(400) };
    });
    assert.equal(scrolled.small, "7px", "the band under the title does not follow the scroll");
    assert.ok(Math.abs(parseFloat(scrolled.deep) - 22 * REST) < 0.01, `the band under the title is not capped at the ramp's depth (${scrolled.deep})`);
    await shot(page, "fade-scrolled");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the sent line lands on the tap, the panel comes up with it cut, and the poll reconciles", async () => {
  // the seeded card is put out of the doing view so nothing else is waiting on
  // him and the send stays on the card it was sent from, which is the card this
  // test watches. the move to the next card has its own test below
  await api("/park?box=0&v=1");
  const id = await create("The send answers at once");
  await api(`/reply?box=${id}`, LONG_REPLY);

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.type("article.box.sel textarea", "Landed before the server answered");
    // the click and the reading of the card happen in one turn of the event
    // loop, so nothing the server says can have arrived in between
    const atOnce = await page.evaluate(() => {
      document.querySelector("article.box.sel .sendbtn").click();
      const box = document.querySelector("article.box.sel");
      const panel = box.querySelector(".sentwrap .answered");
      return {
        rows: [...box.querySelectorAll(".sentwrap .answmsg")].map(r => r.dataset.text),
        arriving: panel.classList.contains("arrive"),
        open: panel.classList.contains("open"),
        animation: getComputedStyle(panel).animationName,
        field: box.querySelector("textarea").value,
        square: box.querySelector(".sendbtn").classList.contains("show"),
      };
    });
    assert.deepEqual(atOnce.rows, ["Landed before the server answered"], "the line waited on the server");
    assert.equal(atOnce.arriving, true, "the panel did not come in on the shared arrival");
    assert.equal(atOnce.animation, "answarrive", "the arrival is not the shared rise and fade");
    assert.equal(atOnce.open, false, "the send landed the panel open");
    assert.equal(atOnce.field, "", "the words were left in the row he types on");
    // the arrow stays up for a quick second press, which is how a send moves on
    // (393061c), and goes back down once that window has passed
    assert.equal(atOnce.square, true, "the send square went down at once instead of waiting for a second press");
    // a burst over the arrival: the panel coming up out of the row
    await shot(page, "send-mid-1");
    await settle(120);
    await shot(page, "send-mid-2");
    await settle(140);
    await shot(page, "send-mid-3");

    await settle(500);
    const settled = await page.evaluate(() => {
      const panel = document.querySelector("article.box.sel .sentwrap .answered");
      const cs = getComputedStyle(panel);
      return {
        classes: panel.className,
        opacity: cs.opacity,
        transform: cs.transform,
        rows: [...document.querySelectorAll("article.box.sel .sentwrap .answmsg")].map(r => r.dataset.text),
        line: document.querySelector("article.box.sel .sentwrap .answmark"),
      };
    });
    assert.equal(settled.classes, "answered sent", "the arrival left its dress on the panel");
    assert.equal(settled.opacity, "1");
    assert.equal(settled.transform, "none");
    assert.deepEqual(settled.rows, ["Landed before the server answered"], "the poll doubled the sent line");
    assert.equal(settled.line, null, "a confirmed message kept the mark an unconfirmed one wears");
    await page.waitForFunction(() => !document.querySelector("article.box.sel .sendbtn").classList.contains("show"),
      { timeout: 3000 }).catch(() => assert.fail("the send square stayed up with nothing to send, past the second press's window"));
    const saved = await (await fetch(origin + "/state")).json();
    assert.deepEqual(saved.boxes.find(b => b.id === id).pendingTexts, ["Landed before the server answered"]);
    await shot(page, "send-settled");
    assert.equal(await page.evaluate(() => selectedId), id, "the send left the card it was sent from");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("a second press of the send arrow moves on to the card that has waited longest, on the desktop's wait", async () => {
  const board = await readFile(path.join(ROOT, "index.html"), "utf8");
  const phone = await readFile(path.join(ROOT, "m.html"), "utf8");
  const wait = source => source.match(/const AUTONEXT_MS = (\d+)/)[1];
  assert.equal(wait(phone), wait(board), "the phone waits a different time than the board before moving on");

  // the seeded card also waits on him and was made before either of these, so it
  // is put out of the doing view and the two under test are the only ones left
  await api("/park?box=0&v=1");
  const waiting = await create("The card that waits");
  await api(`/reply?box=${waiting}`, "Waiting on him");
  const from = await create("The card he sends from");
  await api(`/reply?box=${from}`, "Also waiting on him");

  const { page, problems } = await openPhone(`/m?box=${from}`);
  try {
    await page.waitForSelector(`#box-${from}.sel`, { timeout: 5000 });
    await page.type("article.box.sel textarea", "Off you go");
    // the first press of the arrow sends and stays on the card (393061c); a second
    // press inside the quick window is the one that moves on
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    const stayed = await page.evaluate(() => ({
      selected: selectedId,
      up: document.querySelector("article.box.sel .sendbtn").classList.contains("show"),
    }));
    assert.equal(stayed.selected, from, "the first press of the send arrow moved on");
    assert.equal(stayed.up, true, "the send arrow did not stay up for a second press");
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);
    const landed = await page.evaluate(() => ({
      selected: selectedId,
      shown: document.querySelector("article.box.sel")?.id,
      only: document.querySelectorAll("article.box.sel").length,
    }));
    assert.equal(landed.selected, waiting, "the send did not move on to the waiting card");
    assert.equal(landed.shown, "box-" + waiting, "the card on screen is not the one it moved to");
    assert.equal(landed.only, 1);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("the card list drops the card by 55% of the screen while the ticket box comes in above it, on one fraction", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readList(page);
    assert.equal(shut.open, false);
    assert.equal(shut.live, false);
    assert.equal(shut.v, 0);
    assert.equal(shut.down, 0, "the card waits off its resting place");
    assert.equal(shut.across, 0);
    assert.equal(shut.boxVisibility, "hidden", "the ticket box is on show with the list shut");
    assert.ok(shut.boxRight <= shut.pageLeft + 0.5,
      `the shut ticket box is not wholly beyond the page's left edge (${shut.boxRight} of ${shut.pageLeft})`);
    assert.ok(Math.abs(shut.drop - 0.55 * shut.viewportHeight) <= 1,
      `the card's drop is not 55% of the screen's height (${shut.drop} of ${shut.viewportHeight})`);
    assert.ok(shut.bedLift > 10, `the bed's second sheet is up with the list shut (${shut.bedLift})`);
    // the window the box is seen through ends at the card's resting top, clips, and takes no touch
    assert.ok(Math.abs(shut.windowFoot - shut.cardTop) < 0.6, `the window does not end at the card's top (${shut.windowFoot}, ${shut.cardTop})`);
    assert.equal(shut.windowClip, "clip");
    assert.equal(shut.windowPointer, "none", "the window over the page takes a touch");
    assert.equal(shut.pageScale, 1, "the page is not at its resting size with the list shut");
    // the list is the board's holder: nothing painted behind the names and rows,
    // no shade of its own, and no second layer over it
    assert.equal(shut.boxFill, "rgba(0, 0, 0, 0)", "the ticket box paints a ground of its own");
    assert.equal(shut.boxShade, "none", "the ticket box casts a shade");
    assert.match(shut.boxAfter, /^(none|normal)$/, "the ticket box carries a layer over itself");
    // one clock, the same for the card and the box, and only a transform on it
    assert.match(shut.paneMoves, /transform/);
    assert.match(shut.boxMoves, /transform/);
    assert.match(shut.paneMs, /0\.55s/, "the card's run is not 550ms");
    assert.match(shut.boxMs, /0\.55s/, "the box's run is not 550ms");
    assert.match(shut.paneCurve, /cubic-bezier\(0\.445, 0\.05, 0\.55, 0\.95\)/, "a tap does not move the card on the ease in and out");
    assert.match(shut.boxCurve, /cubic-bezier\(0\.445, 0\.05, 0\.55, 0\.95\)/, "a tap does not move the box on the ease in and out");
    await shot(page, "list-closed");

    await startListSamples(page);
    await page.evaluate(() => openDrawer());
    await settle(250);
    const half = await readList(page);
    assert.ok(half.cardAt > 0 && half.cardAt < 1, `the card did not travel over time (${half.cardAt})`);
    assert.ok(Math.abs(half.cardAt - half.boxAt) < 0.03,
      `the card and the box are not at the same place in their runs (${half.cardAt}, ${half.boxAt})`);
    assert.equal(half.across, 0, "the card moved sideways on the way down");
    assert.ok(Math.abs(half.boxY) < 0.01, `the box moved up or down on the way in (${half.boxY})`);
    assert.ok(Math.abs(half.windowFoot - half.cardTop) < 0.6, "the box is seen below the card's top edge on the way in");
    assert.ok(half.boxFoot > half.cardTop, "the box is not cut by the card's top edge part of the way in");
    // the row's band is up for the whole slide, not only once the card has landed
    assert.ok(Math.abs(half.bedLift) < 0.5, `the bed's second sheet was not up part of the way in (${half.bedLift})`);
    assert.equal(half.cardOpacity, 1);
    assert.equal(half.boxOpacity, 1);
    assert.equal(half.boxVisibility, "visible", "the box was not on show part of the way in");
    await shot(page, "list-half");

    await settle(500);
    const out = await readList(page);
    assert.equal(out.open, true);
    assert.equal(out.v, 1);
    assert.equal(out.boxV, 1, "the box was not written the card's fraction");
    assert.equal(out.windowV, 1, "the window was not written the card's fraction");
    assert.ok(Math.abs(out.bedLift) < 0.5, `the bed's second sheet is not up with the list out (${out.bedLift})`);
    assert.ok(Math.abs(out.down - out.drop) < 0.5, `the card did not land its drop below its place (${out.down} of ${out.drop})`);
    assert.ok(Math.abs(out.down - 0.55 * out.viewportHeight) <= 1, "the card is not down 55% of the screen");
    assert.equal(out.across, 0);
    assert.equal(out.boxVisibility, "visible");
    assertBoxInSpace(out, "with the list out");
    assert.equal(out.cardPointer, "none", "the card with the list out still takes a touch");
    // no side drawer's company: no shade over the page, no page drawn back
    assert.equal(out.scrim, 0, "a shade lies over the page with the list out");
    assert.equal(out.scrimPointer, "none");
    assert.equal(out.pageScale, 1, "the page drew back for the card list");
    assert.equal(out.cardOpacity, 1);
    const opening = await assertListInStep(page, "while the card list opened");
    assert.ok(opening.low < 0.35, `the run was already well along as the samples began (${opening.low})`);
    assert.ok(opening.high > 0.999, `the run did not finish (${opening.high})`);
    assert.ok(opening.seen >= 15, `the box was on show for too few frames (${opening.seen})`);
    await shot(page, "list-open");

    await startListSamples(page);
    await page.evaluate(() => closeDrawer());
    await settle(750);
    const back = await readList(page);
    assert.equal(back.open, false);
    assert.equal(back.down, 0, "the card did not come back to its place");
    assert.equal(back.v, 0);
    assert.ok(back.bedLift > 10, `the bed's second sheet did not settle back with the card home (${back.bedLift})`);
    assert.equal(back.boxVisibility, "hidden", "the box was left on show after it went");
    assert.ok(back.boxRight <= back.pageLeft + 0.5, "the box did not leave past the page's left edge");
    const closing = await assertListInStep(page, "while the card list closed");
    assert.ok(closing.high > 0.65, `the run was not well out as the leaving began (${closing.high})`);
    assert.ok(closing.low < 0.001, `the card did not come all the way back (${closing.low})`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a run cut short partway turns back on the same fraction for the card and the box", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    // an opening stopped and sent back before it arrives
    await startListSamples(page, 1100);
    await page.evaluate(() => { openDrawer(); setTimeout(() => closeDrawer(), 180); });
    await settle(1200);
    const cutOpen = await assertListInStep(page, "when an opening card list was sent back");
    assert.ok(cutOpen.high < 0.6, `the run went past the place it was cut at (${cutOpen.high})`);
    assert.ok(cutOpen.high > 0.02, `the run did not start before it was cut (${cutOpen.high})`);
    const backAgain = await readList(page);
    assert.equal(backAgain.open, false, "the card list did not go back where it came from");
    assert.equal(backAgain.down, 0);
    assert.equal(backAgain.boxVisibility, "hidden");

    // and a closing stopped and brought back out again
    await page.evaluate(() => openDrawer());
    await settle(750);
    await startListSamples(page, 1100);
    await page.evaluate(() => { closeDrawer(); setTimeout(() => openDrawer(), 180); });
    await settle(1200);
    const backOut = await assertListInStep(page, "when a closing card list was brought back");
    assert.ok(backOut.low > 0.3, `the card came too far back before it was turned around (${backOut.low})`);
    assert.ok(backOut.low < 1, `the card did not start back before it was turned around (${backOut.low})`);
    const outAgain = await readList(page);
    assert.equal(outAgain.open, true, "the card list did not come back out");
    assert.ok(Math.abs(outAgain.down - outAgain.drop) < 0.5);
    assert.equal(outAgain.boxVisibility, "visible");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull past the middle opens the card list, both parts follow the finger, and the reverse swipe undoes both", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await pull(page, "left", 0.4);
    const shy = await readList(page);
    assert.equal(shy.open, false, "a pull short of the middle opened the list");
    assert.equal(shy.down, 0, "the card stayed down after a pull that went back");
    assert.equal(shy.v, 0);
    assert.equal(shy.boxVisibility, "hidden");

    let midway = null;
    await pull(page, "left", 0.6, async () => {
      midway = await readList(page);
      // asked of the browser directly: the page's own screenshot, taken with a
      // finger down, makes this Chrome send the touch again at a third of its place
      const cdp = await page.createCDPSession();
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      await cdp.detach();
      await writeFile(path.join(SHOTS, "list-dragged.png"), Buffer.from(data, "base64"));
    });
    assert.ok(Math.abs(midway.cardAt - 0.6) < 0.02, `the card is not where 60% of the pull puts it (${midway.cardAt})`);
    assert.ok(Math.abs(midway.boxAt - 0.6) < 0.02, `the box is not where 60% of the pull puts it (${midway.boxAt})`);
    assert.equal(midway.boxVisibility, "visible", "the box was not on show under the finger");
    // only a transform changes, and not on a clock while the finger holds it
    assert.doesNotMatch(midway.paneMoves, /transform/, "the card is on a clock while the finger holds it");
    assert.doesNotMatch(midway.boxMoves, /transform/, "the box is on a clock while the finger holds it");
    assert.equal(midway.across, 0);
    assert.ok(Math.abs(midway.boxY) < 0.01, `the box moved up or down under the finger (${midway.boxY})`);
    assert.ok(Math.abs(midway.windowFoot - midway.cardTop) < 0.6, "the box is seen below the card's top edge under the finger");
    assert.equal(midway.cardOpacity, 1);
    assert.equal(midway.pageScale, 1);
    assert.equal(midway.scrim, 0);
    const held = await readList(page);
    assert.equal(held.open, true, "a pull past the middle did not open the list");
    assert.ok(Math.abs(held.down - held.drop) < 0.5, "the card did not finish its drop after the finger let go");
    assert.equal(held.boxVisibility, "visible");
    assert.match(held.paneCurve, /cubic-bezier\(0\.215, 0\.61, 0\.355, 1\)/, "a released drag does not finish the card on the ease out");
    assert.match(held.boxCurve, /cubic-bezier\(0\.215, 0\.61, 0\.355, 1\)/, "a released drag does not finish the box on the ease out");

    // the reverse swipe, over the card, short of the middle: it stays out
    const run = await page.evaluate(() => menuTravel(tickets));
    const swipe = async (fraction, hold) => {
      const from = 330, travel = -Math.round(run * fraction);
      await page.touchscreen.touchStart(from, 600);
      for (let step = 1; step <= 8; step++) await page.touchscreen.touchMove(from + Math.round(travel * step / 8), 600);
      if (hold) { await settle(100); await hold(); }
      await page.touchscreen.touchEnd();
      await settle(750);
    };
    await swipe(0.3);
    const stayed = await readList(page);
    assert.equal(stayed.open, true, "a reverse swipe short of the middle shut the list");
    assert.ok(Math.abs(stayed.down - stayed.drop) < 0.5);

    let undoing = null;
    await swipe(0.6, async () => { undoing = await readList(page); });
    assert.ok(Math.abs(undoing.cardAt - 0.4) < 0.03, `the card is not where 60% of the swipe back puts it (${undoing.cardAt})`);
    assert.ok(Math.abs(undoing.boxAt - 0.4) < 0.03, `the box is not where 60% of the swipe back puts it (${undoing.boxAt})`);
    const shutAgain = await readList(page);
    assert.equal(shutAgain.open, false, "the reverse swipe did not shut the list");
    assert.equal(shutAgain.down, 0, "the reverse swipe did not bring the card back");
    assert.equal(shutAgain.boxVisibility, "hidden", "the reverse swipe left the box on show");
    assert.equal(shutAgain.shown, shy.shown, "a swipe over the card changed the card shown");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the box scrolls on its own, a tap on a ticket switches the card and leaves the list out, and a tap on the card shuts it", async () => {
  const ids = [];
  for (let n = 1; n <= 18; n++) ids.push(await create(`Scrollable card ${n}`));
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await page.evaluate(() => openDrawer());
    await settle(750);
    // the groups sit side by side on one sheet and each group scrolls on its own,
    // so the pane of the open view is the list that scrolls
    const before = await page.evaluate(() => {
      const list = document.querySelector('#tiklist .tikpane[data-view="todo"]');
      return { top: list.scrollTop, room: list.scrollHeight - list.clientHeight };
    });
    assert.ok(before.room > 200, `the ticket box under test does not overflow enough to scroll (${before.room})`);

    const lane = await page.evaluate(() => {
      const r = document.querySelector('#tiklist .tikpane[data-view="todo"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, top: r.top, bottom: r.bottom };
    });
    assert.ok(lane.bottom - lane.top > 150, `the box's list is too short to scroll in (${lane.bottom - lane.top})`);
    await page.touchscreen.touchStart(lane.x, lane.bottom - 20);
    for (let y = lane.bottom - 70; y >= lane.top + 20; y -= 50) await page.touchscreen.touchMove(lane.x, y);
    await page.touchscreen.touchEnd();
    await settle(300);
    const scrolled = await readList(page);
    const scrollTop = await page.evaluate(() => document.querySelector('#tiklist .tikpane[data-view="todo"]').scrollTop);
    assert.ok(scrollTop > 100, `the box's list did not scroll (${scrollTop})`);
    assert.equal(scrolled.open, true, "a vertical scroll shut the card list");
    assert.ok(Math.abs(scrolled.down - scrolled.drop) < 0.5, "a vertical scroll moved the card");

    // a control in the box is worked by a real touch
    await page.touchscreen.tap(...await page.evaluate(() => {
      const r = document.getElementById("tv-deferred").getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }));
    await settle(300);
    const switched = await page.evaluate(() => ({
      view: document.getElementById("tv-deferred").classList.contains("on"),
      open: tickets.classList.contains("open"),
    }));
    assert.equal(switched.view, true, "a touch on a name in the box did nothing");
    assert.equal(switched.open, true, "a touch on the box's own name shut the list");
    await page.evaluate(() => document.getElementById("tv-todo").click());
    await settle(400);

    // a tap on a ticket in view switches the card and the list stays out
    const target = await page.evaluate(() => {
      const view = document.querySelector('#tiklist .tikpane[data-view="todo"]');
      const pane = view.getBoundingClientRect();
      const row = [...view.querySelectorAll(".trow")].find(t => {
        const r = t.getBoundingClientRect();
        return r.top >= pane.top + 4 && r.bottom <= pane.bottom - 4 && !t.classList.contains("on");
      });
      const r = row.getBoundingClientRect();
      return { id: row.dataset.id, x: r.left + 40, y: r.top + r.height / 2, was: selectedId };
    });
    await shot(page, "list-before-ticket-tap");
    await page.touchscreen.tap(target.x, target.y);
    await settle(750);
    const picked = await readList(page);
    assert.equal(picked.selected, target.id, "the tap did not switch the card");
    assert.equal(picked.shown, "box-" + target.id, "the card on screen is not the ticket that was tapped");
    assert.notEqual(target.id, target.was);
    assert.equal(picked.open, true, "the list shut when a ticket was tapped");
    assert.ok(Math.abs(picked.down - picked.drop) < 0.5, "the card came back up when a ticket was tapped");
    assert.equal(picked.boxVisibility, "visible");
    assert.equal(await page.evaluate(() => document.querySelector("#tiklist .trow.on")?.dataset.id), target.id,
      "the row that was tapped is not the one marked");
    await shot(page, "list-ticket-switched");

    // a tap on the card that shows, below the box, shuts the list and leaves
    // the card as it was switched
    await page.touchscreen.tap(195, 740);
    await settle(750);
    const shut = await readList(page);
    assert.equal(shut.open, false, "a tap on the visible card did not shut the list");
    assert.equal(shut.down, 0);
    assert.equal(shut.boxVisibility, "hidden");
    assert.equal(shut.selected, target.id, "shutting the list changed the card");
    assert.equal(shut.shown, "box-" + target.id);
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector("article.box.sel textarea")),
      false, "a tap that shut the list went through to the card's field");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    for (const id of ids) await api(`/close?box=${id}`);
  }
});

test("the ticket circle opens the list and shuts it again, and the row stands on its own layer above the card on a fuzzy top edge that is higher while the list is out, with no shadow", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    // the depth at which a fade's mask comes to the whole of the paper, in pixels
    const whole = mask => Number((mask.match(/rgb\(0, 0, 0\) ([\d.]+)px|rgba\(0, 0, 0, 1\) ([\d.]+)px/) || []).slice(1).find(Boolean));
    const bed = () => page.evaluate(() => {
      const el = document.getElementById("dockbed");
      const own = getComputedStyle(el), before = getComputedStyle(el, "::before"), after = getComputedStyle(el, "::after");
      const sheet = getComputedStyle(el.firstElementChild);
      const buttons = document.querySelectorAll("#dock .dockbtn");
      return {
        z: own.zIndex, dockZ: getComputedStyle(document.getElementById("dock")).zIndex,
        paneZ: getComputedStyle(document.getElementById("pane")).zIndex,
        touch: own.pointerEvents, parent: el.parentElement.id,
        mask: before.webkitMaskImage || before.maskImage,
        sheetMask: sheet.webkitMaskImage || sheet.maskImage, sheetOpacity: Number(sheet.opacity),
        sheetMoves: sheet.transitionProperty,
        shadow: after.content, shadowFill: after.backgroundImage,
        bedTop: el.getBoundingClientRect().top, sheetTop: el.firstElementChild.getBoundingClientRect().top,
        buttonsTop: Math.min(...[...buttons].map(b => b.getBoundingClientRect().top)),
        cardFoot: document.getElementById("pane").getBoundingClientRect().bottom,
        buttons: buttons.length,
      };
    });
    const rest = await bed();
    assert.equal(rest.parent, "page");
    assert.equal(rest.buttons, 4, "the row is not four buttons");
    assert.equal(rest.touch, "none", "the bed takes a touch");
    assert.ok(Number(rest.z) > 0 && (rest.paneZ === "auto" || Number(rest.paneZ) < Number(rest.z)),
      `the bed is not on a layer above the card (${rest.z} over ${rest.paneZ})`);
    assert.ok(Number(rest.dockZ) > Number(rest.z), "the buttons are not above their bed");
    // the Mac card's fade: the paper's top edge is a four-step ramp from nothing
    for (const one of [rest.mask, rest.sheetMask]) {
      assert.match(one, /linear-gradient/, "the bed's top edge is not a fade");
      assert.match(one, /rgba\(0, 0, 0, 0\) 0px/, "the fade does not begin at nothing");
      assert.match(one, /rgba\(0, 0, 0, 0\.35\)/);
      assert.match(one, /rgba\(0, 0, 0, 0\.8\)/);
    }
    // the bed casts nothing: no band of shade along it, at rest or with the list out
    assert.match(rest.shadow, /^(none|normal)$/, "the bed draws a shadow along its edge");
    assert.equal(rest.shadowFill, "none");
    // at rest the card's foot stands on the bed's edge, and the paper is whole from
    // the buttons' tops down, so no line of a card going down shows beside them
    assert.ok(Math.abs(rest.cardFoot - rest.bedTop) < 0.6, `the card's foot is not on the bed's edge (${rest.cardFoot}, ${rest.bedTop})`);
    assert.ok(rest.bedTop + whole(rest.mask) <= rest.buttonsTop + 0.5,
      `the paper is not whole at the buttons' tops (${rest.bedTop} + ${whole(rest.mask)} against ${rest.buttonsTop})`);
    // and the second sheet rests lowered, its top edge on the card's foot
    assert.ok(Math.abs(rest.sheetTop - rest.bedTop) < 0.6, `the second sheet is not lowered at rest (${rest.sheetTop}, ${rest.bedTop})`);
    assert.equal(rest.sheetOpacity, 1);
    assert.match(rest.sheetMoves, /^transform$/, "the second sheet moves on more than its transform");

    const circle = await page.evaluate(() => {
      const r = document.getElementById("tikbtn").getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    // the band stands up while the card is still on its way down
    await page.touchscreen.tap(...circle);
    await settle(250);
    const going = await readList(page);
    const rising = await bed();
    assert.ok(going.cardAt > 0.05 && going.cardAt < 0.95, `the card is not on its way down (${going.cardAt})`);
    assert.ok(rest.bedTop - rising.sheetTop > 20,
      `the band did not stand up while the card went down (${rising.sheetTop} against ${rest.bedTop})`);
    await settle(500);
    const out = await readList(page);
    assert.equal(out.open, true, "the ticket circle did not open the list");
    assert.ok(Math.abs(out.down - out.drop) < 0.5);
    const raised = await bed();
    // with the list out the white band and the start of its fade stand higher:
    // the paper is whole a clear stretch above the buttons' tops, and its fade
    // starts higher still
    const wholeAt = raised.sheetTop + whole(raised.sheetMask);
    assert.ok(raised.buttonsTop - wholeAt > 12, `the paper is not whole well above the buttons (${wholeAt}, buttons ${raised.buttonsTop})`);
    assert.ok(rest.bedTop - raised.sheetTop > 20, `the fade does not start higher with the list out (${raised.sheetTop} against ${rest.bedTop})`);
    assert.match(raised.shadow, /^(none|normal)$/, "the bed draws a shadow with the list out");
    // the circle still takes a touch with the card down, and a second touch shuts the list
    await shot(page, "list-open-bed");
    await page.touchscreen.tap(...circle);
    await settle(200);
    const coming = await readList(page);
    const stillUp = await bed();
    assert.ok(coming.cardAt > 0.2, `the card came home too soon to look (${coming.cardAt})`);
    assert.ok(Math.abs(stillUp.sheetTop - raised.sheetTop) < 0.6, "the band came down before the card was home");
    await settle(550);
    const shut = await readList(page);
    assert.equal(shut.open, false, "the ticket circle did not shut the list");
    assert.equal(shut.down, 0);
    const resting = await bed();
    assert.ok(Math.abs(resting.sheetTop - resting.bedTop) < 0.6, "the second sheet did not settle back with the card home");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the project list stays where he scrolled it, across a poll and a rebuild, and a row in view switches lane", async () => {
  // enough lanes to run the list past the room over the row of buttons. the
  // folder each lane is given is only a name to the page, and nothing is
  // written in it
  const home = require("node:os").homedir();
  for (let n = 2; n <= 17; n++) {
    const made = await fetch(`${origin}/project?name=${encodeURIComponent("Lane " + n)}`, { method: "POST", body: home });
    assert.equal(made.status, 200, "the fixture could not add a lane");
  }
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#projlist .projrow").length >= 18, { timeout: 5000 });
    await page.evaluate(() => openProjects());
    await settle(300);
    const room = await page.evaluate(() => {
      const list = document.getElementById("projmenu");
      return list.scrollHeight - list.clientHeight;
    });
    assert.ok(room > 60, `the list under test does not overflow (${room})`);
    const place = Math.floor(room / 2);

    await page.evaluate(at => { document.getElementById("projmenu").scrollTop = at; }, place);
    await page.evaluate(() => poll());
    await settle(1600);   // a hand-run poll and the clock's own one behind it
    const afterPoll = await page.evaluate(() => ({
      at: document.getElementById("projmenu").scrollTop,
      open: document.body.classList.contains("projopen"),
      polls: !!lastState,
    }));
    assert.equal(afterPoll.polls, true);
    assert.equal(afterPoll.open, true, "a poll shut the list");
    assert.equal(afterPoll.at, place, "a poll yanked the list back to its head");
    await shot(page, "projlist-scrolled");

    // the list keeps its place when the lanes themselves are drawn again
    await page.evaluate(() => { document.getElementById("projlist").dataset.sig = ""; renderTabs(lastState); });
    assert.equal(await page.evaluate(() => document.getElementById("projmenu").scrollTop), place,
      "a rebuild of the list lost the place he scrolled to");

    // a tap on a row standing in view switches lane and shuts the list
    const tapped = await page.evaluate(() => {
      const list = document.getElementById("projmenu").getBoundingClientRect();
      const row = [...document.querySelectorAll("#projlist .projrow")].find(t => {
        const r = t.getBoundingClientRect();
        return r.top >= list.top + 2 && r.bottom <= list.bottom - 2 && !t.classList.contains("on");
      });
      row.click();
      return row.dataset.owner;
    });
    await settle(300);
    const afterTap = await page.evaluate(() => ({
      owner: activeOwner,
      on: document.querySelector("#projlist .projrow.on").dataset.owner,
      open: document.body.classList.contains("projopen"),
    }));
    assert.equal(afterTap.owner, tapped, "the tap did not change lane");
    assert.equal(afterTap.on, tapped);
    assert.equal(afterTap.open, false, "the list stayed open after the choice");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the settings come in from the right, holding the header, the list of sections and the notifications control", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readMenu(page, "#settings");
    assert.equal(shut.open, false);
    assert.equal(shut.right, -shut.width, "the settings panel does not wait beyond the right edge");
    assert.equal(shut.width, 278, "settings is not about 15% narrower than its former 328px width");
    assert.deepEqual(shut.corners, ["12px", "0px", "0px", "12px"], "the settings panel's exposed corners are not 12px");
    assert.equal(shut.lift, 0, "settings waits off its own line");
    assert.equal(shut.top, 0, "settings waits below the top of the screen");
    assert.equal(shut.fade, "1.00", "settings waits at less than its full strength");
    assert.equal(shut.depth, 0, "settings waits with a shade already under it");
    assert.equal(shut.shade, "none", "the depth is still on the panel instead of its own layer");
    assertPageDrewBack(shut, 0, "with settings closed");

    const made = await page.evaluate(() => {
      const head = document.querySelector("#setpage .sp-head");
      const gear = document.querySelector("#setpage .sp-item .sp-next svg");
      const button = document.getElementById("notify");
      const ink = getComputedStyle(document.documentElement);
      const own = getComputedStyle(button);
      return {
        header: head.querySelector(".sp-title").textContent.trim(),
        items: [...document.querySelectorAll("#setpage .sp-item")].map(one => one.textContent.trim()),
        gear: !!gear,
        gearStroke: gear && gear.getAttribute("stroke"),
        gearFill: gear && gear.getAttribute("fill"),
        gearWeight: gear && gear.getAttribute("stroke-width"),
        label: document.querySelector('label[for="notify"] span').textContent,
        role: button.getAttribute("role"),
        type: button.type,
        indent: getComputedStyle(document.querySelector("#setpage .sp-item")).paddingLeft,
        headPad: getComputedStyle(head).paddingLeft,
        fill: own.backgroundColor,
        border: own.borderStyle,
        knob: getComputedStyle(button, "::before").backgroundColor,
        paper: ink.getPropertyValue("--paper").trim(),
        ink: ink.getPropertyValue("--ink").trim(),
        accent: ink.getPropertyValue("--accent").trim(),
        gone: !document.getElementById("drawerfoot") && !document.querySelector("#tickets #notify"),
      };
    });
    assert.equal(made.header, "Settings", "the panel's header is not Settings");
    assert.deepEqual(made.items, ["Editor", "Notifications", "Improvements", "Diagnostics"], "the panel does not list the sections");
    assert.equal(made.gear, true, "a section in the list carries no mark");
    assert.equal(made.gearStroke, "currentColor", "the mark is not drawn in the card's line style");
    assert.equal(made.gearFill, "none");
    assert.equal(made.gearWeight, "1.9", "the mark is not the weight the plus is drawn at");
    assert.equal(made.label, "Notifications");
    assert.equal(made.role, "switch", "the control is not a switch");
    assert.equal(made.type, "checkbox");
    assert.equal(made.indent, made.headPad, "the list is not lined up under the header");
    assert.equal(made.border, "none", "the control has a border");
    assert.equal(made.fill, "rgb(202, 202, 202)", "the switch is not the light grey when off");
    assert.equal(made.knob, "rgb(255, 255, 255)", "the switch's knob is not white");
    assert.equal(made.gone, true, "the old button is still in the card list");

    // the mark and the fill are the app's own and nothing new
    assert.equal(made.paper, "#F5F4F1");
    assert.equal(made.ink, "#211D17");

    await startPageSamples(page);
    await startMenuSamples(page, "#settings");
    await page.evaluate(() => showMenu(settings));
    await settle(750);
    const out = await readMenu(page, "#settings");
    assert.equal(out.open, true);
    assert.equal(out.shift, 0, "settings did not land against the right edge");
    assert.equal(out.right, 0);
    assert.equal(out.scrim, "1.00", "the shade over the page did not come up with the settings");
    assertPageDrewBack(out, 1, "with settings open");
    assert.equal(out.pageScale, 0.985, "the page did not land on the depth it was given for settings");
    assert.match(out.depthShade, /rgba\(0, 0, 0, 0\.1\) -2px 0px 6px/, "settings has no close shade under its edge");
    assert.match(out.depthShade, /rgba\(0, 0, 0, 0\.2\) -10px 0px 26px/, "settings has no wide shade past its edge");
    assert.equal(out.depth, 1, "the shade under settings did not come up to its full weight");
    assert.equal(out.lift, 0);
    assert.equal(out.top, 0);
    assert.equal(out.foot, out.height);
    assert.equal(out.fade, "1.00");
    const cameIn = await assertMenuHeldItsLine(page, "while settings came in");
    assert.ok(cameIn.first < 0.15, `the shade was already deep as settings began (${cameIn.first})`);
    assert.equal(cameIn.last, 1, `the shade did not finish at its full weight (${cameIn.last})`);
    const sank = await assertPageStayedCentred(page, "while settings opened");
    assert.ok(sank.high > 0.999 && sank.low < 0.9855,
      `the page did not draw back over the settings run (${sank.low} to ${sank.high})`);
    await shot(page, "settings-open");

    // turning the switch on does what the button in the card list did: it asks,
    // and says what it was told. the headless browser has no push service, so
    // what is proved here is the ask, the answer being shown and the switch
    // going back off
    const asked = await page.evaluate(async () => {
      const said = [];
      const real = Notification.requestPermission;
      Notification.requestPermission = async () => { said.push("asked"); return "denied"; };
      document.getElementById("notify").click();
      await new Promise(r => setTimeout(r, 200));
      Notification.requestPermission = real;
      return { said, note: document.getElementById("notifynote").textContent,
               on: document.getElementById("notify").checked };
    });
    assert.deepEqual(asked.said, ["asked"], "the control did not ask for notifications");
    assert.match(asked.note, /Notifications are off/, "the control did not show what it was told");
    assert.equal(asked.on, false, "the switch stayed on after a refusal");
    await shot(page, "settings-refused");

    await startPageSamples(page);
    await startMenuSamples(page, "#settings");
    await page.evaluate(() => hideMenu(settings));
    await settle(750);
    const back = await readMenu(page, "#settings");
    assert.equal(back.open, false);
    assert.equal(back.shift, back.width);
    assert.equal(back.lift, 0);
    assert.equal(back.top, 0);
    assert.equal(back.fade, "1.00");
    assert.equal(back.depth, 0, "the shade under settings did not go back to nothing");
    await assertMenuHeldItsLine(page, "while settings left");
    assertPageDrewBack(back, 0, "with settings closed again");
    const rose = await assertPageStayedCentred(page, "while settings closed");
    assert.ok(rose.high > 0.9999, `the page did not come back towards its full size after settings (${rose.high})`);
    assert.equal(back.pageScale, 1, "the page did not come back to exactly its full size after settings");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull from the right edge brings the settings in", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await shot(page, "settings-closed");
    let midway = null;
    await pull(page, "right", 0.6, async () => {
      midway = await readMenu(page, "#settings");
      await shot(page, "settings-half");
    });
    assert.ok(midway.shift > 0 && midway.shift < midway.width, "settings does not follow the finger from the right");
    assert.equal(midway.lift, 0, `settings left its line under the finger (${midway.lift})`);
    assert.equal(midway.top, 0, `settings' head moved under the finger (${midway.top})`);
    assert.equal(midway.fade, "1.00", `settings went see-through under the finger (${midway.fade})`);
    assert.ok(midway.depth > 0.3 && midway.depth < 0.9, `the shade does not follow the finger (${midway.depth})`);
    assert.ok(Math.abs(midway.depth - (1 - Math.abs(midway.shift) / midway.width)) < 0.03,
      `the shade is not worth what the finger has pulled out (${midway.shift}px of ${midway.width}, shade ${midway.depth})`);
    assert.equal(midway.pageMs, "0s", "the page's depth is on a clock while the finger holds settings");
    assertPageDrewBack(midway, midway.out, "during a settings pull");
    const out = await readMenu(page, "#settings");
    assert.equal(out.open, true, "a pull past the middle did not bring the settings in");
    assert.equal(out.shift, 0);
    assertPageDrewBack(out, 1, "after a settings pull");
    // and a tap on what is left of the page shuts it again, the strip the page
    // has drawn back from included
    await page.touchscreen.tap(0, 0);
    await settle(750);
    const shut = await readMenu(page, "#settings");
    assert.equal(shut.open, false, "a tap on the strip the page left did not shut the settings");
    assert.equal(shut.shift, shut.width);
    assertPageDrewBack(shut, 0, "after settings dismissal");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("turned on its side the card goes down 55% of the shorter screen, and the settings keep the same sideways run", async () => {
  const sideOn = { ...PHONE, width: 844, height: 390 };
  const { page, problems } = await openPhone("/m", { viewport: sideOn });
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readList(page);
    assert.ok(Math.abs(shut.drop - 0.55 * 390) <= 1, `the side-on drop is not 55% of the screen's height (${shut.drop})`);
    assert.equal(shut.boxVisibility, "hidden");
    assert.equal(shut.down, 0);

    await startListSamples(page);
    await page.evaluate(() => openDrawer());
    await settle(750);
    const left = await readList(page);
    assert.equal(left.open, true);
    assert.ok(Math.abs(left.down - left.drop) < 0.5, `the side-on card did not land its drop (${left.down} of ${left.drop})`);
    assertBoxInSpace(left, "side-on");
    assert.ok(left.boxWidth > 650, `the side-on box does not follow the wider card (${left.boxWidth})`);
    assert.ok(left.boxHeight > 100, `the side-on box does not fit above the card (${left.boxHeight})`);
    assert.equal(left.pageScale, 1, "the page drew back for the side-on card list");
    await assertListInStep(page, "while the side-on card list opened");
    await shot(page, "sideon-list-open");

    // and the settings, over the same wider page
    await page.evaluate(() => closeDrawer());
    await settle(750);
    await startPageSamples(page);
    await startMenuSamples(page, "#settings");
    await page.evaluate(() => showMenu(settings));
    await settle(750);
    const right = await readMenu(page, "#settings");
    assert.equal(right.width, 289, "the side-on settings did not keep the narrower cap");
    assert.equal(right.right, 0, "the side-on settings did not land against the right edge");
    assert.equal(right.top, 0, "the side-on settings did not land against the top of the screen");
    assert.equal(right.foot, right.height, "the side-on settings does not run the whole height");
    assert.equal(right.fade, "1.00", "the side-on settings is not at its full strength");
    assert.equal(right.depth, 1, "the shade under the side-on settings did not come up");
    assertPageDrewBack(right, 1, "with the side-on settings open");
    await assertMenuHeldItsLine(page, "while the side-on settings came in");
    await assertPageStayedCentred(page, "while the side-on settings came in");
    await shot(page, "sideon-settings-open");

    // turned back upright with settings still out: the depth is a size and not a
    // measured offset, so it is worth the new screen at once and leaves nothing
    // stale behind
    await page.setViewport(PHONE);
    await settle(300);
    const upright = await readMenu(page, "#settings");
    assert.equal(upright.viewportWidth, PHONE.width, "the page did not take the upright screen");
    assert.equal(upright.open, true, "the turn shut settings");
    assertPageDrewBack(upright, 1, "with settings open after the turn back upright");
    await shot(page, "turned-back-settings-open");
    await page.evaluate(() => hideMenu(settings));
    await settle(750);
    const done = await readMenu(page, "#settings");
    assert.equal(done.open, false);
    assertPageDrewBack(done, 0, "with settings shut after the turn back upright");

    // and the card's drop is the upright screen's 55% once the list is opened again
    await page.evaluate(() => openDrawer());
    await settle(750);
    const again = await readList(page);
    assert.ok(Math.abs(again.drop - 0.55 * PHONE.height) <= 1, `the drop kept the side-on screen's measure (${again.drop})`);
    assert.ok(Math.abs(again.down - again.drop) < 0.5, `the card did not land the upright drop (${again.down})`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("reduced motion keeps both overlays immediate, and the settings keep the wide-phone cap narrower", async () => {
  const widePhone = { ...PHONE, width: 430, height: 932 };
  const { page, problems } = await openPhone("/m", { viewport: widePhone, reduced: true });
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await page.evaluate(() => openDrawer());
    const left = await readList(page);
    assert.equal(left.open, true);
    assert.ok(Math.abs(left.drop - 0.55 * 932) <= 1, `the wide phone's drop is not 55% of its screen (${left.drop})`);
    assert.ok(Math.abs(left.down - left.drop) < 0.5, "reduced motion did not put the card down at once");
    assert.equal(left.paneMs, "0s", "reduced motion left a card transition running");
    assert.equal(left.boxMs, "0s", "reduced motion left a box transition running");
    assert.equal(left.boxVisibility, "visible", "the box was not on show at once");
    assert.ok(Math.abs(left.boxAt - 1) < 0.001, "the box did not arrive at once");
    assertBoxInSpace(left, "under reduced motion");
    assert.ok(Math.abs(left.bedLift) < 0.5, `the bed's second sheet did not come up at once (${left.bedLift})`);
    assert.equal(left.pageScale, 1, "the page drew back for the card list under reduced motion");

    await page.evaluate(() => { closeDrawer(); showMenu(settings); });
    const right = await readMenu(page, "#settings");
    assert.equal(right.width, 289, "the wide-phone settings panel did not keep the 15% narrower cap");
    assert.equal(right.shift, 0);
    assert.equal(right.ms, "0s", "reduced motion left a settings transition running");
    assert.equal(right.depthMs, "0s", "reduced motion left settings' shade running");
    assert.equal(right.depth, 1, "settings arrived without its shade");
    assert.equal(right.lift, 0);
    assert.equal(right.top, 0);
    assert.equal(right.fade, "1.00");
    assert.equal(right.pageMs, "0s", "reduced motion left the page's depth running under settings");
    assertPageDrewBack(right, 1, "with reduced-motion settings open");
    const gone = await readList(page);
    assert.equal(gone.open, false, "opening the settings left the card list out");
    assert.equal(gone.down, 0, "the card did not come back at once under reduced motion");
    assert.equal(gone.boxVisibility, "hidden", "the box lingered under reduced motion");
    // and it comes back to its full size at once when the settings go
    await page.evaluate(() => hideMenu(settings));
    const flat = await readMenu(page, "#settings");
    assert.equal(flat.shift, flat.width, "settings did not leave at once under reduced motion");
    assertPageDrewBack(flat, 0, "with both menus shut under reduced motion");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
