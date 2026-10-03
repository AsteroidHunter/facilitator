// The new-project tab on the desktop board, driven headless against a real
// fixture server. The plus opens a tab labelled "New Project", upright and in
// the board's bold, drawn in the open tab's own ink and size. The landing under
// it (the logo with its name and version, the box listing the projects, and
// the start button) stands in the middle of the page's frame, the rectangle
// under the bar that the home page's panels also stand in: the air above the
// logo equals the air below the button at three window sizes, with a short
// project list and a long one, and after the window is resized with the tab
// still open. The long list scrolls inside its box and never moves the stack.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [[1512, 982], [1280, 800], [1920, 1080]];
const LONG_LIST = 26;

let browser;
let child;
let fixtureDir;
let home;
let origin;

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  assert.equal(response.status, 200, `${route} answered ${response.status}`);
  return response.json();
}

async function addProject(name) {
  const folder = path.join(home, name);
  await mkdir(folder, { recursive: true });
  return (await post("/project?name=" + encodeURIComponent(name), folder)).id;
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-newtab-"));
  await mkdir(path.join(fixtureDir, "home"));
  home = await realpath(path.join(fixtureDir, "home"));
  const port = await freePortPair();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "page.html",
                      "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
                      "compose-format.js", "cm-markdown.js", "home-widgets.js", "home-widgets.css",
                      "tokens.py", "limits.py"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "New tab test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" }],
  }));

  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs"), HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);

  for (const name of ["atlas", "birchwood"]) await addProject(name);

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

// a desktop board at one window size, with the new tab not yet open
async function openBoard(width, height) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport({ width, height });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
  await settle(400);
  return { page, problems, context };
}

// press the plus and wait until the landing has finished its arrival, which
// moves its three pieces by a few pixels while it runs
async function pressPlus(page) {
  await page.click(".ptabplus");
  await page.waitForFunction(() =>
    document.body.classList.contains("choosing") &&
    document.getAnimations().filter(a => a.effect?.target?.closest?.("#newproj"))
      .every(a => a.playState === "finished"), { timeout: 4000 });
  await page.evaluate(() => document.fonts.ready);
  await settle(100);
}

// where the stack stands in the frame, in css pixels
const landing = page => page.evaluate(() => {
  const box = selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width };
  };
  const frame = box("#appframe");
  const brand = box("#npbrand");
  const start = box("#npstart");
  const home = box("#nphome");
  const rows = document.getElementById("nprows");
  return {
    above: brand.top - frame.top,
    below: frame.bottom - start.bottom,
    centreOff: (home.left + home.right) / 2 - innerWidth / 2,
    homeWidth: home.width,
    frame, brand, start, home,
    scrollHeight: rows.scrollHeight, clientHeight: rows.clientHeight,
    pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  };
});

function assertCentred(got, say) {
  assert.ok(Math.abs(got.above - got.below) <= 1,
    `${say}: ${got.above.toFixed(2)}px above the logo and ${got.below.toFixed(2)}px below the button`);
  assert.ok(Math.abs(got.centreOff) <= 1, `${say}: the stack is ${got.centreOff.toFixed(2)}px off the middle sideways`);
  assert.ok(got.brand.top >= got.frame.top && got.start.bottom <= got.frame.bottom, `${say}: the stack leaves the frame`);
}

test("the plus opens a tab labelled New Project, upright and bold", async () => {
  const { page, problems, context } = await openBoard(1512, 982);
  try {
    const face = sel => page.$eval(sel, el => {
      const c = getComputedStyle(el);
      return { text: el.textContent, style: c.fontStyle, weight: c.fontWeight, size: c.fontSize, color: c.color, family: c.fontFamily };
    });
    const open = await face("#tabbar .ptab.on .plabel");
    await pressPlus(page);
    const label = await face("#tabbar .ptab.draft .plabel");
    const tab = await face("#tabbar .ptab.draft");
    assert.equal(label.text, "New Project");
    assert.equal(label.style, "normal", "the label is italic");
    assert.equal(tab.style, "normal", "the tab is italic");
    assert.equal(label.weight, "600", "the label is not in the board's bold");
    assert.ok(Number(open.weight) < Number(label.weight), "the label is no bolder than the open tab's name");
    assert.equal(open.style, "normal");
    assert.equal(label.size, open.size, "the label is not the open tab's size");
    assert.equal(label.color, open.color, "the label is not the open tab's ink");
    assert.equal(label.family, open.family, "the label is not the open tab's face");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

for (const [width, height] of SIZES) {
  test(`the landing is centred in the frame at ${width} by ${height} with a short list`, async () => {
    const { page, problems, context } = await openBoard(width, height);
    try {
      await pressPlus(page);
      const got = await landing(page);
      assertCentred(got, `${width}x${height}`);
      assert.equal(got.homeWidth, 480, "the stack's width changed");
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  });
}

test("the stack stays centred when the window is resized with the tab open", async () => {
  const { page, problems, context } = await openBoard(1512, 982);
  try {
    await pressPlus(page);
    assertCentred(await landing(page), "1512x982");
    for (const [width, height] of [[1280, 800], [1920, 1080], [1400, 900]]) {
      await page.setViewport({ width, height });
      await settle(200);
      assertCentred(await landing(page), `after resizing to ${width}x${height}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("only the stack takes the pointer, not the rest of the frame", async () => {
  const { page, context } = await openBoard(1512, 982);
  try {
    await pressPlus(page);
    const hit = await page.evaluate(() => {
      const frame = document.getElementById("appframe").getBoundingClientRect();
      const start = document.getElementById("npstart").getBoundingClientRect();
      const corner = document.elementFromPoint(frame.left + 24, frame.top + 24);
      const button = document.elementFromPoint((start.left + start.right) / 2, (start.top + start.bottom) / 2);
      return { corner: corner ? corner.id || corner.tagName : null, inLanding: !!corner?.closest("#newproj"), button: button?.id };
    });
    assert.equal(hit.inLanding, false, "the frame's empty corner lands on " + hit.corner);
    assert.equal(hit.button, "npstart");
  } finally {
    await context.close();
  }
});

test("a long list scrolls inside its box and the stack stays centred", async () => {
  const names = ["cedar", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kestrel", "lantern",
    "meadow", "nimbus", "orchard", "pinnacle", "quarry", "riverbend", "saffron", "tundra", "umber", "vesper",
    "willow", "xenon", "yarrow", "zephyr", "alpine", "basalt"].slice(0, LONG_LIST);
  for (const name of names) await addProject(name);
  const all = (await (await fetch(origin + "/state")).json()).projects.map(p => p.id);
  assert.equal(all.length, LONG_LIST + 2);
  // the bar keeps its first three tabs; the others are closed, which leaves their rows in the box
  const order = ["facilitator", ...all];
  await post("/tabs", JSON.stringify({ order, closed: order.slice(3) }));
  for (const [width, height] of SIZES) {
    const { page, problems, context } = await openBoard(width, height);
    try {
      await pressPlus(page);
      const got = await landing(page);
      assertCentred(got, `${width}x${height} with ${LONG_LIST + 3} rows`);
      assert.ok(got.scrollHeight > got.clientHeight, "the list did not need to scroll");
      assert.equal(got.pageScroll, 0, "the page itself scrolled");
      assert.deepEqual(problems, []);
    } finally {
      await context.close();
    }
  }
});
