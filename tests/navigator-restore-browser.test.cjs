// The board's own tab gets its file navigator box back once per browser when it
// was put away by hand, in the place and size it had. The cross keeps working
// after that, another tab's hidden navigator is left alone, and a browser with
// no saved keys is not changed.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const SHOTS = process.env.FACILITATOR_NAV_RESTORE_SHOTS || path.join(tmpdir(), "facilitator-nav-restore-shots");
const FLAG = "navrestore.1";
const HIDDEN_BY_HAND = {
  "hide.facilitator.magic4": "1",
  "pos.facilitator.magic4": JSON.stringify({ x: 1054.08, y: 40.32 }),
  "size.facilitator.magic4": JSON.stringify({ w: 380.16, h: 403.2 }),
  "hide.pastureland.magic4": "1",
};
let fixtureDir, origin, child, browser;

async function mkfile(file, text){
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
async function openBoard(storage){
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1512, height: 982 });
  // seeded on the first document of the tab only, so a reload sees what the page kept
  if (storage) await page.evaluateOnNewDocument(entries => {
    if (sessionStorage.getItem("__seeded")) return;
    sessionStorage.setItem("__seeded", "1");
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await ready(page);
  return { context, page };
}
async function ready(page){
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
  await page.waitForFunction(() => lastState.navigatorLanes && lastState.navigatorLanes.length === 3);
  await new Promise(resolve => setTimeout(resolve, 500));
}
async function reload(page){
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
}
async function selectProject(page, id){
  await page.waitForSelector(`#tabbar .ptab[data-owner="${id}"]`);
  await page.click(`#tabbar .ptab[data-owner="${id}"]`);
  await page.waitForFunction(owner => activeOwner === owner, {}, id);
  await new Promise(resolve => setTimeout(resolve, 600));
}
async function navigator(page){
  return page.evaluate(() => {
    const el = document.getElementById("magic4");
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      off: el.classList.contains("region-off"),
      style: { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height },
      shown: getComputedStyle(el).display !== "none" && rect.width > 0 && rect.height > 0,
    };
  });
}
async function stored(page, key){
  return page.evaluate(k => localStorage.getItem(k), key);
}
async function shot(page, name){
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

before(async () => {
  fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-nav-restore-")));
  await mkdir(SHOTS, { recursive: true });
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  copyBridgeFiles(fixtureDir);
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js",
    "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
    "compose-format.js", "cm-markdown.js", "limits.py", "tokens.py", "qr.py", "shell_integration.py",
    "home-widgets.css", "home-widgets.js"])
    if (existsSync(path.join(ROOT, name))) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Navigator restore fixture",
    items: [
      { id: "0", bucket: "meta", owner: "facilitator", title: "Welcome card" },
      { id: "1", bucket: "meta", owner: "website", title: "Website card" },
      { id: "2", bucket: "meta", owner: "pastureland", title: "Pastureland card" },
    ],
  }));
  const lanes = [];
  for (const owner of ["website", "pastureland", "facilitator"]){
    const dir = path.join(fixtureDir, "projects", owner);
    await mkfile(path.join(dir, owner + "-internal", "notes.md"), "# " + owner + " notes\n");
    await mkfile(path.join(dir, owner + "-wiki", "home.md"), "# " + owner + " wiki\n");
    lanes.push({ owner, dir, tmux: "x-" + owner, instruction: "x", prompt: "x" });
  }
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({
    log_level: "info", lanes, navigator_lanes: ["website", "pastureland", "facilitator"],
  }, null, 2));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: fixtureDir, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: fixtureDir },
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline){
    if (child.exitCode !== null) throw new Error(`fixture exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!(await fetch(origin + "/state")).ok) throw new Error(`fixture did not start:\n${output}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run", "--no-sandbox"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a navigator put away on the board's own tab comes back once, where it was", async () => {
  const { context, page } = await openBoard(HIDDEN_BY_HAND);
  try {
    const own = await navigator(page);
    assert.ok(own, "the navigator box is on the board's own tab");
    assert.equal(own.off, false);
    assert.equal(own.shown, true);
    assert.equal(own.style.width, "380.16px");
    assert.equal(own.style.height, "403.2px");
    assert.ok(Math.abs(parseFloat(own.style.left) - 1054.08) < 12, own.style.left);
    assert.ok(Math.abs(parseFloat(own.style.top) - 40.32) < 12, own.style.top);
    assert.equal(await stored(page, "hide.facilitator.magic4"), null);
    assert.equal(await stored(page, "pos.facilitator.magic4"), HIDDEN_BY_HAND["pos.facilitator.magic4"]);
    assert.equal(await stored(page, "size.facilitator.magic4"), HIDDEN_BY_HAND["size.facilitator.magic4"]);
    assert.equal(await stored(page, FLAG), "1");
    await shot(page, "restored-facilitator");

    await selectProject(page, "pastureland");
    const other = await navigator(page);
    assert.ok(other && other.off, "the other tab's navigator stays put away");
    assert.equal(await stored(page, "hide.pastureland.magic4"), "1");
    await shot(page, "restored-pastureland-still-hidden");
    await selectProject(page, "facilitator");

    // the cross still puts it away, and it stays away on later loads
    await page.click("#editbtn");
    await page.waitForSelector('.rkill[data-region="magic4"]', { visible: true });
    await page.click('.rkill[data-region="magic4"]');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await navigator(page)).off, true);
    assert.equal(await stored(page, "hide.facilitator.magic4"), "1");
    await reload(page);
    assert.equal((await navigator(page)).off, true, "stays hidden after a reload");
    assert.equal(await stored(page, "hide.facilitator.magic4"), "1");
    assert.equal(await stored(page, FLAG), "1");
    await shot(page, "hidden-again-after-reload");
  } finally { await context.close(); }
});

test("a browser with no saved keys is not changed", async () => {
  const { context, page } = await openBoard();
  try {
    const own = await navigator(page);
    assert.ok(own && !own.off && own.shown, JSON.stringify(own));
    assert.equal(await stored(page, FLAG), "1");
    assert.equal(await stored(page, "hide.facilitator.magic4"), null);
    assert.equal(await stored(page, "pos.facilitator.magic4"), null);
    assert.equal(await stored(page, "size.facilitator.magic4"), null);
    await shot(page, "fresh-facilitator");
  } finally { await context.close(); }
});
