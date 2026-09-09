// The phone page's motion, driven headless at an iPhone size against its own
// fixture server: the card's two fades, the sent box's arrival, the send that
// lands at once and moves on, both drawers crossing the page on one straight
// sideways line at full strength while the shade under them grows and the page
// itself draws back towards the middle of the screen, the tab bar keeping its
// scroll, and settings.
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
// grows a little smaller about its own middle
const PAGE_SINK = 0.015;
const pageSizeAt = v => 1 - PAGE_SINK * v;

// the page at one moment of a run: drawn back by exactly what the menu is worth,
// evenly on all four sides, around the middle of the screen, and laid out at the
// full size of the screen throughout
function assertPageDrewBack(shape, v, where) {
  const want = pageSizeAt(v);
  if (v === 0) assert.equal(shape.pageScale, 1, `the page did not come back to its full size ${where}`);
  assert.ok(Math.abs(shape.pageScale - want) < 0.0015,
    `the page is not drawn back to ${want.toFixed(4)} ${where} (${shape.pageScale})`);
  assert.equal(shape.pageScale, shape.pageScaleY, `the page drew back unevenly ${where}`);
  assert.equal(shape.pageShift, 0, `the page moved sideways ${where}`);
  assert.equal(shape.pageLift, 0, `the page moved up or down ${where}`);
  // nothing was laid out again: the page still owns the whole screen
  assert.equal(shape.pageLayoutWidth, shape.viewportWidth, `the page's laid-out width changed ${where}`);
  assert.equal(shape.pageLayoutHeight, shape.viewportHeight, `the page's laid-out height changed ${where}`);
  // and the picture steps in by the same amount on facing edges, about the middle
  assert.ok(Math.abs(shape.pageLeft - shape.pageRight) < 0.01,
    `the page's side steps differ ${where} (${shape.pageLeft} and ${shape.pageRight})`);
  assert.ok(Math.abs(shape.pageTop - shape.pageFoot) < 0.01,
    `the page's top and foot steps differ ${where} (${shape.pageTop} and ${shape.pageFoot})`);
  assert.ok(Math.abs(shape.pageMidX - shape.viewportWidth / 2) < 0.01,
    `the page left the middle of the screen sideways ${where} (${shape.pageMidX})`);
  assert.ok(Math.abs(shape.pageMidY - shape.viewportHeight / 2) < 0.01,
    `the page left the middle of the screen up or down ${where} (${shape.pageMidY})`);
  const sideStep = shape.viewportWidth * (1 - want) / 2;
  const endStep = shape.viewportHeight * (1 - want) / 2;
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
      for (const one of ["#drawer", "#settings"]) {
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
    assert.equal(s.layoutWidth, s.viewportWidth, `the page's laid-out width changed at frame ${i} ${where}`);
    assert.equal(s.layoutHeight, s.viewportHeight, `the page's laid-out height changed at frame ${i} ${where}`);
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

// a pull from an edge, held at a fraction of the menu's width so the frame it
// stands on can be looked at, and then let go
async function pull(page, side, fraction, hold) {
  const width = await page.evaluate(one => document.querySelector(one).getBoundingClientRect().width,
    side === "right" ? "#settings" : "#drawer");
  const from = side === "right" ? 384 : 6;
  const travel = Math.round(width * fraction) * (side === "right" ? -1 : 1);
  await page.touchscreen.touchStart(from, 500);
  for (let step = 1; step <= 8; step++) await page.touchscreen.touchMove(from + Math.round(travel * step / 8), 500);
  if (hold) await hold();
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
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "index.html", "page.html"]) {
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
    await page.waitForSelector(`#box-${id}.sel .pendlist`, { timeout: 5000 });
    await settle(300);
    const rest = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const reply = box.querySelector(".reply");
      const wrap = box.querySelector(".pendwrap");
      const cs = getComputedStyle(reply);
      return {
        wrapPosition: getComputedStyle(wrap).position,
        overlap: reply.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top,
        band: cs.getPropertyValue("--boxband").trim(),
        wrapHeight: Math.round(wrap.getBoundingClientRect().height),
        up: cs.getPropertyValue("--upband").trim(),
        fade: cs.getPropertyValue("--replyfade").trim(),
        air: cs.getPropertyValue("--replyair").trim(),
        mask: cs.webkitMaskImage,
        composite: cs.webkitMaskComposite || cs.maskComposite,
        runout: cs.paddingBottom,
        scrolls: reply.scrollHeight > reply.clientHeight + 1,
      };
    });
    assert.equal(rest.wrapPosition, "absolute", "the sent box is not laid over the answer");
    assert.ok(rest.overlap > 40, `the answer does not run on under the box (${rest.overlap})`);
    assert.equal(rest.fade, "22px", "the ramp is not the desktop's depth");
    assert.equal(rest.air, "3.5px", "the clear air over the box is not the desktop's");
    assert.equal(rest.band, rest.wrapHeight + "px", "the ramp's top edge is not the box's top edge");
    assert.ok(rest.up === "" || rest.up === "0px", `an answer at rest carries a band under the title (${rest.up})`);
    assert.match(rest.mask, /linear-gradient/, "the answer carries no mask");
    assert.equal(rest.mask.match(/linear-gradient/g).length, 3, "the mask is not the desktop's three layers");
    assert.match(rest.composite, /intersect/);
    assert.equal(rest.runout, (parseFloat(rest.band) + 22).toFixed(0) + "px", "the scroll's run-out is not the band plus the ramp");
    assert.equal(rest.scrolls, true, "the answer under test does not scroll");
    await shot(page, "fade-rest");

    // one pixel of scroll buys one pixel of ramp, and the ramp stops at its depth
    const scrolled = await page.evaluate(async () => {
      const reply = document.querySelector("article.box.sel .reply");
      const read = () => getComputedStyle(reply).getPropertyValue("--upband").trim();
      const step = async to => {
        reply.scrollTop = to;
        await new Promise(r => setTimeout(r, 60));
        return read();
      };
      return { small: await step(7), deep: await step(400) };
    });
    assert.equal(scrolled.small, "7px", "the band under the title does not follow the scroll");
    assert.equal(scrolled.deep, "22px", "the band under the title is not capped at the ramp's depth");
    await shot(page, "fade-scrolled");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the sent line lands on the tap, the box rises into it, and the poll reconciles", async () => {
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
      const pend = box.querySelector(".pendlist");
      return {
        rows: [...box.querySelectorAll(".pendmsg")].map(r => r.dataset.text),
        rising: pend.classList.contains("rising"),
        timed: pend.classList.contains("timed"),
        height: pend.style.height,
        moving: getComputedStyle(pend).transitionProperty,
        field: box.querySelector("textarea").value,
        square: box.querySelector(".sendbtn").classList.contains("show"),
      };
    });
    assert.deepEqual(atOnce.rows, ["Landed before the server answered"], "the line waited on the server");
    assert.equal(atOnce.rising, true, "the box did not arrive on the shared rising dress");
    assert.equal(atOnce.timed, true, "the arrival was not put on the clock");
    assert.match(atOnce.moving, /height/, "the arrival is not a timed run");
    assert.notEqual(atOnce.height, "0px", "the box was left at no height");
    assert.equal(atOnce.field, "", "the words were left in the row he types on");
    assert.equal(atOnce.square, false, "the send square stayed up with nothing to send");
    // a burst over the arrival: the room opening under the answer, then the box
    // coming up in it
    await shot(page, "send-mid-1");
    await settle(120);
    await shot(page, "send-mid-2");
    await settle(140);
    await shot(page, "send-mid-3");

    // the box is still on its way up a beat later, and standing on its own at the end
    const mid = await page.evaluate(() => {
      const pend = document.querySelector("article.box.sel .pendlist");
      return { height: pend.getBoundingClientRect().height, rising: pend.classList.contains("rising") };
    });
    assert.ok(mid.height > 0, "the box never left the floor");
    await settle(500);
    const settled = await page.evaluate(() => {
      const pend = document.querySelector("article.box.sel .pendlist");
      const cs = getComputedStyle(pend);
      return {
        classes: pend.className,
        inlineHeight: pend.style.height,
        height: Math.round(pend.getBoundingClientRect().height),
        bar: Math.round(parseFloat(cs.getPropertyValue("--pend-bar"))),
        opacity: cs.opacity,
        rows: [...document.querySelectorAll("article.box.sel .pendmsg")].map(r => r.dataset.text),
        word: document.querySelector("article.box.sel .pendmsg .rcpt").textContent,
      };
    });
    assert.equal(settled.classes, "pendlist", "the arrival left its dress on the box");
    assert.equal(settled.inlineHeight, "", "the arrival left an inline height on the box");
    assert.equal(settled.opacity, "1");
    assert.ok(Math.abs(settled.height - settled.bar) <= 2, `the box did not land on its own folded height (${settled.height})`);
    assert.deepEqual(settled.rows, ["Landed before the server answered"], "the poll doubled the sent line");
    assert.equal(settled.word, "Delivered");
    const saved = await (await fetch(origin + "/state")).json();
    assert.deepEqual(saved.boxes.find(b => b.id === id).pendingTexts, ["Landed before the server answered"]);
    const stamp = await page.evaluate(() => document.querySelector("article.box.sel .pendstamp").textContent);
    assert.match(stamp, /\d{1,2}:\d{2} (AM|PM)$/, "the run's time was not taken over by the server's");
    await shot(page, "send-settled");
    assert.equal(await page.evaluate(() => selectedId), id, "the send left the card it was sent from");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("a send moves on to the card that has waited longest, on the desktop's wait", async () => {
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

test("the card list crosses the page on one line, at full strength, over a growing shade and a page drawn back", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readMenu(page, "#drawer");
    assert.equal(shut.open, false);
    assertPageDrewBack(shut, 0, "with the card list closed");
    // the page's own depth is on the menu's clock and nobody else's
    assert.match(shut.pageMoves, /transform/, "the page's size is not a timed part of the run");
    assert.match(shut.pageMs, /0\.55s/, "the page's depth is on another clock than the menu");
    assert.equal(shut.scrim, "0.00");
    assert.equal(shut.lift, 0, "the menu waits off its own line");
    assert.equal(shut.top, 0, "the menu waits below the top of the screen");
    assert.equal(shut.fade, "1.00", "the menu waits at less than its full strength");
    assert.equal(shut.depth, 0, "the menu waits with a shade already under it");
    assert.equal(shut.left, -shut.width, "the card list does not wait beyond the left edge");
    assert.equal(shut.width, 278, "the card list is not about 15% narrower than its former 328px width");
    // the two exposed corners are rounder, and the two at the screen edge stay square
    assert.deepEqual(shut.corners, ["0px", "12px", "12px", "0px"], "the card list's exposed corners are not 12px");
    assert.match(shut.ms, /0\.55s/, "the run is not 550ms");
    assert.match(shut.curve, /cubic-bezier\(0\.445, 0\.05, 0\.55, 0\.95\)/, "a tap does not open on the ease in and out");
    assert.match(shut.panelMs, /0\.55s/, "the menu itself is on another clock than the page");
    // nothing about the menu itself fades or lifts: its own transition list is
    // the sideways travel and the taking away, and the depth is on its shade
    assert.equal(shut.shade, "none", "the depth is still on the menu instead of its own layer");
    assert.match(shut.depthMs, /0\.55s/, "the shade is on another clock than the travel");
    await shot(page, "drawer-closed");

    await startPageSamples(page);
    await startMenuSamples(page, "#drawer");
    await page.evaluate(() => openDrawer());
    await settle(250);
    const half = await readMenu(page, "#drawer");
    assert.ok(half.shift < 0 && half.shift > -half.width, `the card list did not travel over time (${half.shift})`);
    assert.equal(half.fade, "1.00", `the menu went see-through on the way in (${half.fade})`);
    assert.equal(half.lift, 0, `the menu left its line on the way in (${half.lift})`);
    assert.equal(half.top, 0, `the menu's head moved on the way in (${half.top})`);
    assert.ok(half.depth > 0 && half.depth < 1, `the shade under the menu did not grow over time (${half.depth})`);
    assert.ok(half.pageScale < 1 && half.pageScale > pageSizeAt(1),
      `the page did not draw back part of the way over time (${half.pageScale})`);
    assertPageDrewBack(half, half.out, "while the card list was opening");
    await shot(page, "drawer-half");

    await settle(500);
    const out = await readMenu(page, "#drawer");
    assert.equal(out.open, true);
    assert.equal(out.shift, 0, "the card list did not land against the left edge");
    assert.equal(out.left, 0);
    assertPageDrewBack(out, 1, "with the card list open");
    assert.equal(out.pageScale, 0.985, "the page did not land on the depth it was given");
    // about three pixels off each side and six off the top and the foot at this size
    assert.ok(Math.abs(out.pageWidth - 390 * 0.985) < 0.01, `the open page's picture is not 98.5% of the screen (${out.pageWidth})`);
    assert.ok(Math.abs(out.pageLeft - 2.925) < 0.01, `the open page does not step in about 3px at the side (${out.pageLeft})`);
    assert.ok(Math.abs(out.pageTop - 6.33) < 0.01, `the open page does not step in about 6px at the top (${out.pageTop})`);
    assert.match(out.depthShade, /rgba\(0, 0, 0, 0\.1\) 2px 0px 6px/, "the card list has no close shade under its edge");
    assert.match(out.depthShade, /rgba\(0, 0, 0, 0\.2\) 10px 0px 26px/, "the card list has no wide shade past its edge");
    assert.equal(out.depth, 1, "the shade did not come up to its full weight");
    assert.equal(out.lift, 0, "the menu did not land on its own line");
    assert.equal(out.top, 0, "the menu did not land against the top of the screen");
    assert.equal(out.foot, out.height, "the menu did not land against the foot of the screen");
    assert.equal(out.fade, "1.00", "the menu is not at its full strength");
    assert.equal(out.scrim, "1.00");
    const opening = await assertMenuHeldItsLine(page, "while the card list opened");
    assert.ok(opening.first < 0.15, `the shade was already deep as the run began (${opening.first})`);
    assert.equal(opening.last, 1, `the shade did not finish at its full weight (${opening.last})`);
    const drewBack = await assertPageStayedCentred(page, "while the card list opened");
    assert.ok(drewBack.high > 0.999, `the page had already drawn back as the run began (${drewBack.high})`);
    assert.ok(drewBack.low < 0.9855, `the page never drew back over the run (${drewBack.low})`);
    await shot(page, "drawer-open");

    await startPageSamples(page);
    await startMenuSamples(page, "#drawer");
    await page.evaluate(() => closeDrawer());
    await settle(750);
    const back = await readMenu(page, "#drawer");
    assert.equal(back.open, false);
    assert.equal(back.shift, -back.width, "the card list did not leave the screen");
    assertPageDrewBack(back, 0, "with the card list closed again");
    assert.equal(back.lift, 0);
    assert.equal(back.top, 0);
    assert.equal(back.fade, "1.00");
    assert.equal(back.depth, 0, "the shade did not go back to nothing");
    const closing = await assertMenuHeldItsLine(page, "while the card list closed");
    assert.ok(closing.first > 0.85, `the shade was not deep as the leaving began (${closing.first})`);
    assert.ok(closing.last < 0.15, `the shade was still deep as the leaving ended (${closing.last})`);
    const cameBack = await assertPageStayedCentred(page, "while the card list closed");
    assert.ok(cameBack.low < 0.9855, `the page was not drawn back as the leaving began (${cameBack.low})`);
    assert.ok(cameBack.high > 0.9999, `the page did not come back towards its full size (${cameBack.high})`);
    // and where it settled is exactly its full size, which the reading above shows
    assert.equal(back.pageScale, 1, "the page did not come back to exactly its full size");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a run cut short partway turns back on the same line, at the same strength", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    // an opening stopped and sent back before it arrives
    await startPageSamples(page, 1100);
    await startMenuSamples(page, "#drawer", 1100);
    await page.evaluate(() => { openDrawer(); setTimeout(() => closeDrawer(), 180); });
    await settle(1200);
    const cutOpen = await assertMenuHeldItsLine(page, "when an opening card list was sent back");
    const cutPage = await assertPageStayedCentred(page, "when an opening card list was sent back");
    assert.ok(cutOpen.high < 0.6, `the shade ran past the travel it was cut at (${cutOpen.high})`);
    // the page went back from where it had got to, so it never reached the full depth
    assert.ok(cutPage.low > pageSizeAt(0.6), `the page ran past the depth it was cut at (${cutPage.low})`);
    assert.ok(cutPage.low < 1, `the page did not draw back at all before it was cut (${cutPage.low})`);
    const backAgain = await readMenu(page, "#drawer");
    assert.equal(backAgain.open, false, "the card list did not go back where it came from");
    assert.equal(backAgain.shift, -backAgain.width);
    assert.equal(backAgain.lift, 0);
    assert.equal(backAgain.fade, "1.00");
    assert.equal(backAgain.depth, 0);
    assertPageDrewBack(backAgain, 0, "after an opening card list was sent back");

    // and a closing stopped and brought back out again
    await page.evaluate(() => openDrawer());
    await settle(750);
    await startPageSamples(page, 1100);
    await startMenuSamples(page, "#drawer", 1100);
    await page.evaluate(() => { closeDrawer(); setTimeout(() => openDrawer(), 180); });
    await settle(1200);
    await assertMenuHeldItsLine(page, "when a closing card list was brought back");
    const backOut = await assertPageStayedCentred(page, "when a closing card list was brought back");
    // it was turned around before it was all the way back, so it never sat at full size
    assert.ok(backOut.high < 1, `the page came the whole way back before it was turned around (${backOut.high})`);
    const outAgain = await readMenu(page, "#drawer");
    assert.equal(outAgain.open, true, "the card list did not come back out");
    assert.equal(outAgain.shift, 0);
    assert.equal(outAgain.lift, 0);
    assert.equal(outAgain.top, 0);
    assert.equal(outAgain.fade, "1.00");
    assert.equal(outAgain.depth, 1);
    assertPageDrewBack(outAgain, 1, "after a closing card list was brought back");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull past the middle opens the card list and one short of it goes back", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await pull(page, "left", 0.4);
    const shy = await readMenu(page, "#drawer");
    assert.equal(shy.open, false, "a pull short of the middle opened the menu");
    assert.equal(shy.shift, -shy.width);
    assert.equal(shy.lift, 0);
    assert.equal(shy.fade, "1.00");
    assert.equal(shy.depth, 0, "the shade stayed behind after a pull that went back");
    assertPageDrewBack(shy, 0, "after a short card-list pull");

    let midway = null;
    await pull(page, "left", 0.6, async () => {
      midway = await readMenu(page, "#drawer");
      await shot(page, "drawer-dragged");
    });
    assert.ok(midway.shift < 0 && midway.shift > -midway.width, "the card list does not follow the finger");
    assert.equal(midway.ms, "0s", "the card list is on a clock while the finger holds it");
    assert.equal(midway.depthMs, "0s", "the shade is on a clock while the finger holds it");
    assert.equal(midway.pageMs, "0s", "the page's depth is on a clock while the finger holds it");
    // the frame the finger stands on is the whole point: sideways only, full
    // strength, and a shade that has come up as far as the pull has
    assert.equal(midway.lift, 0, `the card list left its line under the finger (${midway.lift})`);
    assert.equal(midway.top, 0, `the card list's head moved under the finger (${midway.top})`);
    assert.equal(midway.foot, midway.height, "the card list's foot moved under the finger");
    assert.equal(midway.fade, "1.00", `the card list went see-through under the finger (${midway.fade})`);
    assert.ok(midway.depth > 0.3 && midway.depth < 0.9, `the shade does not follow the finger (${midway.depth})`);
    assert.ok(Math.abs(midway.depth - (1 - Math.abs(midway.shift) / midway.width)) < 0.03,
      `the shade is not worth what the finger has pulled out (${midway.shift}px of ${midway.width}, shade ${midway.depth})`);
    // the frame the finger stands on for the page too: drawn back by exactly
    // what the finger has pulled out, evenly, and nowhere else
    assert.ok(midway.pageScale < 1 && midway.pageScale > pageSizeAt(1),
      `the page is not partly drawn back under the finger (${midway.pageScale})`);
    assertPageDrewBack(midway, midway.out, "during a card-list pull");
    const held = await readMenu(page, "#drawer");
    assert.equal(held.open, true, "a pull past the middle did not open the menu");
    assert.equal(held.shift, 0);
    assert.equal(held.lift, 0);
    assert.equal(held.fade, "1.00");
    assert.equal(held.depth, 1, "the shade did not finish coming up after the finger let go");
    assertPageDrewBack(held, 1, "after a card-list pull");
    assert.match(held.curve, /cubic-bezier\(0\.215, 0\.61, 0\.355, 1\)/, "a released drag does not finish on the ease out");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the overlaid card list still scrolls vertically and every uncovered pixel, edge strip and all, dismisses it", async () => {
  const ids = [];
  for (let n = 1; n <= 18; n++) ids.push(await create(`Scrollable card ${n}`));
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await page.evaluate(() => openDrawer());
    await settle(750);
    const before = await page.evaluate(() => {
      const list = document.getElementById("tiklist");
      return { top: list.scrollTop, room: list.scrollHeight - list.clientHeight };
    });
    assert.ok(before.room > 300, `the card-list fixture does not overflow enough to scroll (${before.room})`);

    await page.touchscreen.touchStart(120, 720);
    for (let y = 660; y >= 240; y -= 60) await page.touchscreen.touchMove(120, y);
    await page.touchscreen.touchEnd();
    await settle(300);
    const scrolled = await page.evaluate(() => ({
      top: document.getElementById("tiklist").scrollTop,
      open: document.getElementById("drawer").classList.contains("open"),
    }));
    assert.ok(scrolled.top > 100, `the overlaid card list did not scroll (${scrolled.top})`);
    assert.equal(scrolled.open, true, "a vertical scroll dismissed the card list");
    assertPageDrewBack(await readMenu(page, "#drawer"), 1, "after a vertical card-list scroll");

    // a control on the open list is worked by a real touch: the shade lies under
    // the list, not over it
    await page.touchscreen.tap(...await page.evaluate(() => {
      const r = document.getElementById("tv-deferred").getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }));
    await settle(300);
    const switched = await page.evaluate(() => ({
      view: document.getElementById("tv-deferred").classList.contains("on"),
      open: document.getElementById("drawer").classList.contains("open"),
    }));
    assert.equal(switched.view, true, "a touch on a control in the open card list did nothing");
    assert.equal(switched.open, true, "a touch on the card list's own control dismissed it");
    await page.evaluate(() => document.getElementById("tv-todo").click());

    // a touch over a control on the page behind is taken by the shade: it shuts
    // the list, and the control it landed on is left alone. the point is picked
    // clear of the open list, so what stops it is the shade and not the list
    const covered = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel textarea").getBoundingClientRect();
      return { x: box.right - 6, y: box.top + box.height / 2,
               edge: document.getElementById("drawer").getBoundingClientRect().right };
    });
    assert.ok(covered.x > covered.edge,
      `the covered control under test is not clear of the open card list (${covered.x} of ${covered.edge})`);
    await page.touchscreen.tap(covered.x, covered.y);
    await settle(750);
    const inert = await readMenu(page, "#drawer");
    assert.equal(inert.open, false, "a touch over the covered page did not dismiss the card list");
    assert.equal(await page.evaluate(() =>
      document.activeElement === document.querySelector("article.box.sel textarea")), false,
      "a covered control took the touch through the shade");

    await page.evaluate(() => openDrawer());
    await settle(750);
    // the thin strip the drawn-back page leaves along the screen's own edge is
    // part of what shuts the list, so nothing on show is a dead spot
    const strip = await readMenu(page, "#drawer");
    assert.ok(strip.pageRight > 2 && strip.pageFoot > 6,
      `the open page left no edge strip to test (${strip.pageRight}, ${strip.pageFoot})`);
    const corner = [strip.viewportWidth - 1, strip.viewportHeight - 1];
    assert.ok(corner[0] > strip.viewportWidth - strip.pageRight && corner[1] > strip.viewportHeight - strip.pageFoot,
      "the corner under test is not outside the page's own picture");
    await page.touchscreen.tap(...corner);
    await settle(750);
    const dismissed = await readMenu(page, "#drawer");
    assert.equal(dismissed.open, false, "a tap on the strip the page left did not dismiss the card list");
    assert.equal(dismissed.shift, -dismissed.width);
    assertPageDrewBack(dismissed, 0, "after card-list dismissal");

    // and the middle of what is left of the page shuts it too
    await page.evaluate(() => openDrawer());
    await settle(750);
    await page.touchscreen.tap(360, 700);
    await settle(750);
    const shut = await readMenu(page, "#drawer");
    assert.equal(shut.open, false, "a tap on the uncovered page did not dismiss the card list");
    assertPageDrewBack(shut, 0, "after a tap on the uncovered page");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    for (const id of ids) await api(`/close?box=${id}`);
  }
});

test("the tab bar stays where he scrolled it, across a poll and a tap", async () => {
  // enough lanes to fill the bar past the width of the screen. the folder each
  // lane is given is only a name to the page, and nothing is written in it
  const home = require("node:os").homedir();
  for (const name of ["Lane two", "Lane three", "Lane four", "Lane five", "Lane six"]) {
    const made = await fetch(`${origin}/project?name=${encodeURIComponent(name)}`, { method: "POST", body: home });
    assert.equal(made.status, 200, "the fixture could not add a lane");
  }
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tabbar .ptab").length >= 7, { timeout: 5000 });
    const room = await page.evaluate(() => {
      const lane = document.querySelector(".bar");
      return lane.scrollWidth - lane.clientWidth;
    });
    assert.ok(room > 60, `the bar under test does not overflow (${room})`);

    await page.evaluate(() => { document.querySelector(".bar").scrollLeft = 120; });
    await page.evaluate(() => poll());
    await settle(1600);   // a hand-run poll and the clock's own one behind it
    const afterPoll = await page.evaluate(() => ({
      at: document.querySelector(".bar").scrollLeft,
      polls: !!lastState,
    }));
    assert.equal(afterPoll.polls, true);
    assert.equal(afterPoll.at, 120, "a poll yanked the bar back to the start");
    await shot(page, "tabbar-scrolled");

    // a tap on a tab standing in view leaves the bar exactly where it is
    const tapped = await page.evaluate(() => {
      const lane = document.querySelector(".bar").getBoundingClientRect();
      const tab = [...document.querySelectorAll("#tabbar .ptab")].find(t => {
        const r = t.getBoundingClientRect();
        return r.left >= lane.left + 2 && r.right <= lane.right - 2 && !t.classList.contains("on");
      });
      tab.click();
      return tab.dataset.owner;
    });
    await settle(300);
    const afterTap = await page.evaluate(() => ({
      at: document.querySelector(".bar").scrollLeft,
      owner: activeOwner,
      on: document.querySelector("#tabbar .ptab.on").dataset.owner,
    }));
    assert.equal(afterTap.owner, tapped, "the tap did not change lane");
    assert.equal(afterTap.on, tapped);
    assert.equal(afterTap.at, 120, "a tap yanked the bar back to the start");

    // and the bar keeps its place when the lanes themselves are drawn again
    await page.evaluate(() => { document.getElementById("tabbar").dataset.sig = ""; renderTabs(lastState); });
    assert.equal(await page.evaluate(() => document.querySelector(".bar").scrollLeft), 120,
      "a rebuild of the tabs lost the place he scrolled to");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the settings come in from the right, with the header, its mark and the notifications control", async () => {
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
      const head = document.getElementById("sethead");
      const gear = document.querySelector("#setmark svg");
      const button = document.getElementById("notify");
      const ink = getComputedStyle(document.documentElement);
      const own = getComputedStyle(button);
      return {
        header: head.textContent.trim(),
        gear: !!gear,
        gearStroke: gear && gear.getAttribute("stroke"),
        gearFill: gear && gear.getAttribute("fill"),
        gearWeight: gear && gear.getAttribute("stroke-width"),
        label: button.textContent,
        indent: getComputedStyle(document.getElementById("setgroup")).paddingLeft,
        headPad: getComputedStyle(head).paddingLeft,
        fill: own.backgroundColor,
        border: own.borderStyle,
        colour: own.color,
        paper: ink.getPropertyValue("--paper").trim(),
        ink: ink.getPropertyValue("--ink").trim(),
        accent: ink.getPropertyValue("--accent").trim(),
        gone: !document.getElementById("drawerfoot") && !document.querySelector("#drawer #notify"),
      };
    });
    assert.equal(made.header, "Settings", "the panel's header is not Settings");
    assert.equal(made.gear, true, "the header carries no gear");
    assert.equal(made.gearStroke, "currentColor", "the gear is not drawn in the card's line style");
    assert.equal(made.gearFill, "none");
    assert.equal(made.gearWeight, "1.9", "the gear is not the weight the plus is drawn at");
    assert.equal(made.label, "Notifications");
    assert.ok(parseFloat(made.indent) > parseFloat(made.headPad), "Notifications is not stepped in under the header");
    assert.equal(made.border, "none", "the control has a border");
    assert.equal(made.fill, "rgb(245, 244, 241)", "the control is not on the board's own paper tint");
    assert.equal(made.colour, "rgb(33, 29, 23)", "the control is not in the board's own ink");
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

    // the control does what the button in the card list did: it asks, and says
    // what it was told. the headless browser has no push service, so what is
    // proved here is the ask and the answer being shown
    const asked = await page.evaluate(async () => {
      const said = [];
      const real = Notification.requestPermission;
      Notification.requestPermission = async () => { said.push("asked"); return "denied"; };
      document.getElementById("notify").click();
      await new Promise(r => setTimeout(r, 200));
      Notification.requestPermission = real;
      return { said, note: document.getElementById("notifynote").textContent };
    });
    assert.deepEqual(asked.said, ["asked"], "the control did not ask for notifications");
    assert.match(asked.note, /Notifications are off/, "the control did not show what it was told");
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

test("turned on its side both menus keep the same sideways run", async () => {
  const sideOn = { ...PHONE, width: 844, height: 390 };
  const { page, problems } = await openPhone("/m", { viewport: sideOn });
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readMenu(page, "#drawer");
    assert.equal(shut.width, 289, "the side-on card list did not keep the narrower cap");
    assert.equal(shut.height, 390, "the side-on card list is not the full height of the screen");
    assert.equal(shut.left, -shut.width, "the side-on card list does not wait beyond the left edge");
    assert.equal(shut.depth, 0, "the side-on card list waits with a shade already under it");

    await startPageSamples(page);
    await startMenuSamples(page, "#drawer");
    await page.evaluate(() => openDrawer());
    await settle(750);
    const left = await readMenu(page, "#drawer");
    assert.equal(left.left, 0, "the side-on card list did not land against the left edge");
    assert.equal(left.top, 0, "the side-on card list did not land against the top of the screen");
    assert.equal(left.foot, left.height, "the side-on card list does not run the whole height");
    assert.equal(left.fade, "1.00", "the side-on card list is not at its full strength");
    assert.equal(left.depth, 1, "the shade under the side-on card list did not come up");
    assertPageDrewBack(left, 1, "with the side-on card list open");
    // side on the page is wider than it is tall, so the step in is bigger at the
    // sides than at the top: the same fraction of each of its own measures
    assert.ok(left.pageLeft > left.pageTop,
      `the side-on page did not step in by its own measures (${left.pageLeft} and ${left.pageTop})`);
    await assertMenuHeldItsLine(page, "while the side-on card list opened");
    await assertPageStayedCentred(page, "while the side-on card list opened");
    await shot(page, "sideon-drawer-open");

    // and the right-hand one, over the same wider page
    await page.evaluate(() => closeDrawer());
    await settle(750);
    await startPageSamples(page);
    await startMenuSamples(page, "#settings");
    await page.evaluate(() => showMenu(settings));
    await settle(750);
    const right = await readMenu(page, "#settings");
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
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("reduced motion keeps both overlays immediate and the wide-phone cap narrower", async () => {
  const widePhone = { ...PHONE, width: 430, height: 932 };
  const { page, problems } = await openPhone("/m", { viewport: widePhone, reduced: true });
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await page.evaluate(() => openDrawer());
    const left = await readMenu(page, "#drawer");
    assert.equal(left.width, 289, "the wide-phone card list did not keep the 15% narrower cap");
    assert.equal(left.shift, 0);
    assert.equal(left.ms, "0s", "reduced motion left a card-list transition running");
    // the shade layer is a ::after, which a bare star does not reach, so it is
    // named in the reduced-motion rule and lands with the menu
    assert.equal(left.depthMs, "0s", "reduced motion left the card list's shade running");
    assert.equal(left.depth, 1, "the card list arrived without its shade");
    assert.equal(left.lift, 0);
    assert.equal(left.top, 0);
    assert.equal(left.fade, "1.00");
    assert.equal(left.pageMs, "0s", "reduced motion left the page's depth running");
    assertPageDrewBack(left, 1, "with reduced-motion card list open");
    assert.equal(left.pageScale, 0.985, "the page did not reach its depth at once under reduced motion");

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
    const gone = await readMenu(page, "#drawer");
    assert.equal(gone.shift, -gone.width, "the card list did not leave at once under reduced motion");
    assert.equal(gone.depth, 0, "the card list's shade lingered under reduced motion");
    assert.equal(right.pageMs, "0s", "reduced motion left the page's depth running under settings");
    assertPageDrewBack(right, 1, "with reduced-motion settings open");
    // and it comes back to its full size at once when the last menu goes
    await page.evaluate(() => hideMenu(settings));
    const flat = await readMenu(page, "#settings");
    assert.equal(flat.shift, flat.width, "settings did not leave at once under reduced motion");
    assertPageDrewBack(flat, 0, "with both menus shut under reduced motion");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
