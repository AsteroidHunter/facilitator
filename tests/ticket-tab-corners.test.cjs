// The selected list tab (doing, deferred, done) is meant to be drawn from the
// same shape as the selected project tab on the same page: the 7px top corners
// and the browser-style bottom notch that flares the tab open into the surface
// under it. This holds on the Mac board's ticket panel and on the phone's card
// drawer, so both are driven headless here and the computed shape is read off
// both selected tabs, so a drift on either surface is caught.
//
// The one thing that is allowed to differ is the surface each tab opens into, so
// the notch's own seat fill is read against each tab's own fill rather than
// against the other row's. On the Mac a project tab opens into the board's paper
// and a ticket tab into the panel's white; on the phone the page is white
// throughout, so both open into the same white.
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
const LINE = "230, 223, 210";   // var(--line), the board's own hairline

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

// the shape a selected tab draws: the two top radii, its own fill, and each
// bottom notch as its box, its anchored offset and the paint inside it. the
// notch's unanchored side resolves against the tab's own width, so it is left
// out of what one row is expected to share with the other
async function tabShape(page, sel) {
  return page.evaluate(one => {
    const el = document.querySelector(one);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const notch = (which, anchor) => {
      const p = getComputedStyle(el, which);
      return { width: p.width, height: p.height, bottom: p.bottom, anchor: p[anchor], bg: p.backgroundImage };
    };
    return {
      tlr: cs.borderTopLeftRadius, trr: cs.borderTopRightRadius,
      fill: cs.backgroundColor,
      before: notch("::before", "left"), after: notch("::after", "right"),
    };
  }, sel);
}

async function seatLine(page, sel) {
  return page.evaluate(one => {
    const cs = getComputedStyle(document.querySelector(one));
    return [cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor].join(" ");
  }, sel);
}

// the shared check: a selected list tab wears the same corners and bottom notch
// as the selected project tab on the same page. the notch's own seat colour is
// each tab's own fill, so the fill is read off each tab rather than assuming the
// two open into one shared surface
async function assertSameJoint(page, refSel, tabSel, headSel, where) {
  const ref = await tabShape(page, refSel);
  const tab = await tabShape(page, tabSel);
  assert.ok(ref && tab, `${where}: a selected project tab and a selected list tab are both on the page`);

  // the corners: the list tab's top two match the project tab's, no longer square
  assert.equal(tab.tlr, ref.tlr, `${where}: top-left radius drifted from the project tab`);
  assert.equal(tab.trr, ref.trr, `${where}: top-right radius drifted from the project tab`);
  assert.equal(tab.tlr, "7px", `${where}: the top-left corner is not the board's 7px`);
  assert.notEqual(tab.tlr, "0px", `${where}: the top-left corner is still square`);
  assert.notEqual(tab.trr, "0px", `${where}: the top-right corner is still square`);

  // the joint: each bottom notch is the same box in the same place as the project
  // tab's and is painted with the same hairline, and opens into the tab's own fill
  for (const side of ["before", "after"]) {
    const t = tab[side], p = ref[side];
    assert.equal(t.width, p.width, `${where}: ${side} notch width drifted from the project tab`);
    assert.equal(t.height, p.height, `${where}: ${side} notch height drifted from the project tab`);
    assert.equal(t.bottom, p.bottom, `${where}: ${side} notch does not seat where the project tab's does`);
    assert.equal(t.anchor, p.anchor, `${where}: ${side} notch is not offset like the project tab's`);
    assert.equal(t.anchor, "-8px", `${where}: ${side} notch is not flared 8px past the tab edge`);
    assert.ok(/radial-gradient/.test(t.bg), `${where}: ${side} notch on the list tab is not painted`);
    assert.ok(/radial-gradient/.test(p.bg), `${where}: ${side} notch on the project tab is not painted`);
    assert.ok(t.bg.includes(LINE), `${where}: ${side} list notch hairline is not the board's line`);
    assert.ok(p.bg.includes(LINE), `${where}: ${side} project notch hairline is not the board's line`);
    assert.ok(t.bg.includes(tab.fill), `${where}: ${side} list notch does not open into the tab's own fill`);
    assert.ok(p.bg.includes(ref.fill), `${where}: ${side} project notch does not open into its own fill`);
  }

  // the seat: the head the tabs sit on carries the board's own 1px line
  assert.equal(await seatLine(page, headSel), `1px solid rgb(${LINE})`, `${where}: the head's seat line is not the board's 1px line`);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tab-corners-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
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

test("the selected ticket tab wears the selected project tab's corners and joint", async () => {
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
    await settle(300);

    await assertSameJoint(page, "#tabbar .ptab.on", "#tikhead .tvb.on", "#tikhead", "the board");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the selected drawer tab wears the phone project tab's corners and joint", async () => {
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
    await assertSameJoint(page, "#tabbar .ptab.on", "#tikhead .tvb.on", "#tikhead", "the phone drawer");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
