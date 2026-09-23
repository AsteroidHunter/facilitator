// The selected list tab (doing, deferred, done) is a depressed pill on the
// phone's card drawer, not a browser-style tab that flares open into the list.
// Only the selected name carries the pill: white fill, the board's hairline on
// all four sides, the board's one sunk shade, the 7px corner on all four
// corners, and no bottom notch. The two unselected names stay bare. The list is
// its own recessed well carrying that same sunk shade, so the pill and the well
// read at one depth, and the head draws no seat line under the names.
// 20260922, m807: the Mac board dropped the pill. Its names read Doing, Deferred
// and Done at 14px, the selected one at weight 700 in ink with no fill, border
// or standing shade, the others at 500; any name dips into a 0.6-depth sunk
// shade while pressed, for at least 80ms; the well's shade is --sunk-deep at
// 90% depth; and selecting a name moves no name and not the well. Both surfaces
// are driven headless here so a drift on either is caught.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LINE = "rgb(230, 223, 210)";   // var(--line), the board's own hairline
const CARD = "rgb(255, 255, 255)";   // var(--card), the pill and well fill

let browser;
let child;
let fixtureDir;
let origin;

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

// the pill a selected tab draws, the well it sits over, and the head that holds
// the names: their corners, borders on every side, fills, sunk shades and the
// two notch pseudo-elements read off in one pass
async function surfaces(page, tabSel, headSel, wellSel) {
  return page.evaluate(sels => {
    const box = el => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const notch = which => getComputedStyle(el, which).display;
      return {
        radii: [cs.borderTopLeftRadius, cs.borderTopRightRadius,
          cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
        borders: ["Top", "Right", "Bottom", "Left"].map(s =>
          [cs["border" + s + "Width"], cs["border" + s + "Style"], cs["border" + s + "Color"]].join(" ")),
        fill: cs.backgroundColor, shadow: cs.boxShadow,
        before: notch("::before"), after: notch("::after"),
        seatLine: [cs.borderBottomWidth, cs.borderBottomStyle].join(" "),
      };
    };
    const head = document.querySelector(sels.head);
    const bare = [...head.querySelectorAll(".tvb")].filter(t => !t.classList.contains("on"));
    return {
      pill: box(document.querySelector(sels.tab)),
      well: box(document.querySelector(sels.well)),
      headSeat: [getComputedStyle(head).borderBottomWidth, getComputedStyle(head).borderBottomStyle].join(" "),
      bare: bare.map(box),
    };
  }, { tab: tabSel, head: headSel, well: wellSel });
}

// the check: the selected name is a depressed pill (four 7px corners, a full
// hairline on every side, the sunk shade, a white fill, no notch), the two
// unselected names are bare, the well carries the same sunk shade so the two
// read at one depth, and the head draws no seat line
async function assertPill(page, tabSel, headSel, wellSel, where) {
  const s = await surfaces(page, tabSel, headSel, wellSel);
  assert.ok(s.pill && s.well, `${where}: the selected pill and the list well are both on the page`);

  // four 7px corners: a pill is a plain rounded rectangle, not a tab
  for (const r of s.pill.radii) assert.equal(r, "7px", `${where}: a pill corner is not the board's 7px (${s.pill.radii})`);
  // a full hairline on every side, the bottom one included, unlike the old tab
  for (let i = 0; i < 4; i++)
    assert.equal(s.pill.borders[i], `1px solid ${LINE}`, `${where}: the pill's ${["top", "right", "bottom", "left"][i]} border is not the board's hairline`);
  assert.equal(s.pill.fill, CARD, `${where}: the pill is not filled white`);
  assert.ok(s.pill.shadow.includes("inset"), `${where}: the pill carries no sunk shade`);
  // no browser-tab notch on the pill
  assert.equal(s.pill.before, "none", `${where}: the pill still draws a ::before notch`);
  assert.equal(s.pill.after, "none", `${where}: the pill still draws a ::after notch`);

  // the two unselected names are bare: no shade, no fill, no visible border
  assert.equal(s.bare.length, 2, `${where}: there are not two unselected names`);
  for (const b of s.bare) {
    assert.equal(b.shadow, "none", `${where}: an unselected name carries a shade`);
    assert.ok(b.fill === "rgba(0, 0, 0, 0)" || b.fill === "transparent", `${where}: an unselected name has a fill (${b.fill})`);
    // a border is invisible when it has no width, no style, or a clear colour
    for (const border of b.borders)
      assert.ok(/^0px|\bnone\b|transparent|rgba\(0, 0, 0, 0\)/.test(border), `${where}: an unselected name has a visible border (${border})`);
  }

  // the well reads at the pill's depth: it carries the same sunk-shade string
  assert.ok(s.well.shadow.includes("inset"), `${where}: the list well carries no sunk shade`);
  assert.equal(s.well.shadow, s.pill.shadow, `${where}: the well and the pill do not read at one depth`);
  assert.equal(s.well.borders[0], `1px solid ${LINE}`, `${where}: the well's top border is not the board's hairline`);
  assert.equal(s.well.radii[0], "7px", `${where}: the well's corner is not the board's 7px`);

  // the head no longer draws a seat line under the names
  assert.ok(/^0px|none$/.test(s.headSeat) || s.headSeat === "0px none",
    `${where}: the head still draws a seat line under the names (${s.headSeat})`);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tab-corners-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "page.html",
                      "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
                      "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title: "Tab corners test", items: [] }));

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
      if ((await fetch(origin + "/state")).ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);

  // one card so the board opens on a real lane with a list under the tabs
  assert.equal((await post("/create?owner=facilitator", "corner probe")).status, 200);

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
    await new Promise(resolve => child.once("exit", resolve));
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// a box-shadow as its layers of [alpha, x, y, blur, spread], read off the
// computed string so a colour serialised a hair differently still compares
function layers(shadow) {
  if (shadow === "none") return [];
  return shadow.split(/,(?![^(]*\))/).map(layer => {
    const alpha = /rgba?\(([^)]+)\)/.exec(layer)[1].split(",").map(Number)[3] ?? 1;
    const lengths = [...layer.replace(/rgba?\([^)]+\)/, "").matchAll(/(-?[\d.]+)px/g)].map(m => Number(m[1]));
    return [alpha, ...lengths];
  });
}
function assertShade(shadow, want, what) {
  const got = layers(shadow);
  assert.equal(got.length, want.length, `${what}: ${shadow}`);
  got.forEach((layer, i) => layer.forEach((n, j) =>
    assert.ok(Math.abs(n - want[i][j]) < 0.006, `${what}: layer ${i} reads ${shadow}`)));
}
// --sunk-deep is inset 0 3px 7px .22 over inset 0 1px 2px .14; these are its
// y offset, blur and alpha scaled by one depth
const sunkAt = d => [[.22 * d, 0, 3 * d, 7 * d, 0], [.14 * d, 0, 1 * d, 2 * d, 0]];

// every name's look and box, and the well's, read in one pass
const boardTabs = page => page.evaluate(() => [...document.querySelectorAll("#tikhead .tvb")].map(t => {
  const cs = getComputedStyle(t);
  const r = t.getBoundingClientRect();
  const drawn = (el, which) => {
    const p = getComputedStyle(el, which);
    return p.display === "none" || p.content === "none" || p.content === "normal" ? "none" : p.display;
  };
  return {
    id: t.id, on: t.classList.contains("on"), label: t.textContent,
    weight: cs.fontWeight, size: cs.fontSize, color: cs.color, fill: cs.backgroundColor, shadow: cs.boxShadow,
    borders: ["Top", "Right", "Bottom", "Left"].map(s => [cs["border" + s + "Width"], cs["border" + s + "Color"]].join(" ")),
    // a pseudo with no content draws nothing, whatever its display reads
    before: drawn(t, "::before"), after: drawn(t, "::after"),
    rect: [r.left, r.top, r.width, r.height],
  };
}));
const wellBox = page => page.evaluate(() => {
  const w = document.getElementById("tiklist");
  const r = w.getBoundingClientRect();
  return { shadow: getComputedStyle(w).boxShadow, rect: [r.left, r.top, r.width, r.height] };
});

test("the board's ticket names carry no pill, read by weight, and dip on press", async () => {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  try {
    await page.setViewport(DESK);
    await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
    await settle(400);
    if (!(await page.$("#tabbar .ptab.on"))) {
      await page.click("#tabbar .ptab");
      await settle(300);
    }
    await page.click("#tv-todo");
    // the pointer is taken off the names so a hover's ink cannot pass as selection
    await page.mouse.move(DESK.width / 2, DESK.height - 4);
    await settle(400);

    const ink = await page.evaluate(() => getComputedStyle(document.body).color);
    const before = await boardTabs(page);
    const wellBefore = await wellBox(page);
    assert.deepEqual(before.map(t => t.label), ["Doing", "Deferred", "Done"]);
    assert.deepEqual(before.map(t => t.on), [true, false, false]);
    for (const t of before) {
      assert.equal(t.size, "14px", `${t.id} is not at 14px`);
      assert.equal(t.weight, t.on ? "700" : "500", `${t.id} has the wrong weight`);
      // no pill: no fill, no visible border, no standing shade, no notch
      assert.ok(t.fill === "rgba(0, 0, 0, 0)" || t.fill === "transparent", `${t.id} has a fill (${t.fill})`);
      for (const border of t.borders)
        assert.ok(/^0px|transparent|rgba\(0, 0, 0, 0\)/.test(border), `${t.id} has a visible border (${border})`);
      assertShade(t.shadow, sunkAt(0), `${t.id} carries a standing shade`);
      assert.equal(t.before, "none", `${t.id} draws a ::before notch`);
      assert.equal(t.after, "none", `${t.id} draws a ::after notch`);
    }
    assert.equal(before[0].color, ink, "the selected name is not in the board's ink");
    assert.notEqual(before[1].color, ink, "an unselected name is in the selected ink");
    // 700 is a weight the page asks the font service for, not one the browser fakes
    const plex = await page.$eval('link[href*="IBM+Plex+Sans"]', l => l.getAttribute("href"));
    assert.match(plex, /IBM\+Plex\+Sans:wght@[\d;]*\b700\b/, "IBM Plex Sans is not loaded at 700");

    // the well sits at 90% of --sunk-deep
    assertShade(wellBefore.shadow, sunkAt(.9), "the list well is not at 90% depth");

    // a click still selects, and selecting moves no name and not the well
    await page.click("#tv-done");
    await settle(400);
    const after = await boardTabs(page);
    assert.deepEqual(after.map(t => t.on), [false, false, true], "a click on Done did not select it");
    assert.equal(await page.evaluate(() => curView()), "done");
    assert.deepEqual(after.map(t => t.weight), ["500", "500", "700"]);
    assert.deepEqual(after.map(t => t.rect), before.map(t => t.rect), "a name moved when the selection changed");
    assert.deepEqual((await wellBox(page)).rect, wellBefore.rect, "the well moved when the selection changed");

    // a press brings the 0.6-depth shade in and a release takes it back out, on
    // the selected name and an unselected one alike, by pointer and by key. the
    // events are dispatched without bubbling so the board's own keys never see them
    for (const id of ["tv-done", "tv-deferred"]) {
      const held = await page.evaluate(async id => {
        const t = document.getElementById(id);
        const wait = ms => new Promise(r => setTimeout(r, ms));
        t.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
        await wait(200);
        const down = getComputedStyle(t).boxShadow;
        t.dispatchEvent(new PointerEvent("pointerup", { pointerType: "mouse" }));
        await wait(450);
        const up = getComputedStyle(t).boxShadow;
        t.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
        await wait(200);
        const key = getComputedStyle(t).boxShadow;
        t.dispatchEvent(new KeyboardEvent("keyup", { key: " " }));
        await wait(450);
        return { down, up, key, left: t.classList.contains("pressed") };
      }, id);
      assertShade(held.down, sunkAt(.6), `${id} held by a pointer`);
      assertShade(held.up, sunkAt(0), `${id} after the pointer let go`);
      assertShade(held.key, sunkAt(.6), `${id} held by Space`);
      assert.equal(held.left, false, `${id} stayed pressed after the key came up`);
    }

    // a quick tap still shows the dip: the press is held for at least 80ms
    const tap = await page.evaluate(async () => {
      const t = document.getElementById("tv-todo");
      const wait = ms => new Promise(r => setTimeout(r, ms));
      t.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
      t.dispatchEvent(new PointerEvent("pointerup", { pointerType: "touch" }));
      const at0 = t.classList.contains("pressed");
      await wait(20);
      const at20 = t.classList.contains("pressed");
      await wait(300);
      return { at0, at20, later: t.classList.contains("pressed") };
    });
    assert.deepEqual(tap, { at0: true, at20: true, later: false }, "a quick tap did not hold the press for its 80ms");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the selected drawer tab is a depressed pill over a recessed well", async () => {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  try {
    await page.setViewport(PHONE);
    await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
    await settle(400);
    if (!(await page.$("#tabbar .ptab.on"))) {
      await page.click("#tabbar .ptab");
      await settle(300);
    }
    // the card drawer holds the doing, deferred and done row; open it and pick doing
    await page.evaluate(() => showMenu(drawer));
    await settle(600);
    await page.click("#tv-todo");
    await settle(300);
    await assertPill(page, "#tikhead .tvb.on", "#tikhead", "#tiklist", "the phone drawer");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
