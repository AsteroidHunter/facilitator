// The selected ticket tab (doing, deferred, done) is meant to be drawn from the
// same shape as the selected project tab across the top of the board: the 7px
// top corners and the browser-style bottom notch that flares the tab open into
// the surface under it. This drives a real board headless and reads the computed
// shape off both selected tabs, so a drift on either row is caught here.
//
// The one thing that is allowed to differ is the surface each tab opens into: a
// project tab opens into the board's paper and a ticket tab into the panel's
// white, so the notch's own seat fill is read against each tab's own fill rather
// than against the other row's.
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

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tab-corners-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "page.html",
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

    const project = await tabShape(page, "#tabbar .ptab.on");
    const ticket = await tabShape(page, "#tikhead .tvb.on");
    assert.ok(project && ticket, "a selected project tab and a selected ticket tab are both on the page");

    // the corners: the ticket tab's top two match the project tab's, and are no
    // longer the square zero they used to be
    assert.equal(ticket.tlr, project.tlr, "top-left radius drifted from the project tab");
    assert.equal(ticket.trr, project.trr, "top-right radius drifted from the project tab");
    assert.equal(ticket.tlr, "7px", "the top-left corner is not the board's 7px");
    assert.notEqual(ticket.tlr, "0px", "the top-left corner is still square");
    assert.notEqual(ticket.trr, "0px", "the top-right corner is still square");

    // the joint: each bottom notch is the same box in the same place as the
    // project tab's, and is painted with the same hairline. the seat colour in
    // the gradient is each tab's own fill, since the two open into two surfaces
    for (const side of ["before", "after"]) {
      const t = ticket[side], p = project[side];
      assert.equal(t.width, p.width, `${side} notch width drifted from the project tab`);
      assert.equal(t.height, p.height, `${side} notch height drifted from the project tab`);
      assert.equal(t.bottom, p.bottom, `${side} notch does not seat where the project tab's does`);
      assert.equal(t.anchor, p.anchor, `${side} notch is not offset like the project tab's`);
      assert.equal(t.anchor, "-8px", `${side} notch is not flared 8px past the tab edge`);
      assert.ok(/radial-gradient/.test(t.bg), `${side} notch on the ticket tab is not painted`);
      assert.ok(/radial-gradient/.test(p.bg), `${side} notch on the project tab is not painted`);
      assert.ok(t.bg.includes(LINE), `${side} ticket notch hairline is not the board's line`);
      assert.ok(p.bg.includes(LINE), `${side} project notch hairline is not the board's line`);
      // each tab opens into its own fill: the notch's seat colour is the tab's
      // own background, the relationship that reads as one continuous surface
      assert.ok(t.bg.includes(ticket.fill), "the ticket notch does not open into the ticket tab's own fill");
      assert.ok(p.bg.includes(project.fill), "the project notch does not open into the project tab's own fill");
    }

    // the seat: the head the tabs sit on carries the board's own 1px line, the
    // same hairline the project tab's joint runs its border out into
    assert.equal(await seatLine(page, "#tikhead"), `1px solid rgb(${LINE})`, "the ticket head's seat line is not the board's 1px line");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
