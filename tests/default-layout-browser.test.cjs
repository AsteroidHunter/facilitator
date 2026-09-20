// A clean browser sees the four board regions, a newly opened project starts
// the same way, and an older browser keeps the visibility it already had.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const SHOTS = process.env.M710_SHOTS || path.join(tmpdir(), "facilitator-default-layout-shots");
const REGIONS = ["clockbox", "tickets", "magic1", "magic2", "magic3", "magic4", "goalbox", "rail", "main"];
const FOUR = ["clockbox", "tickets", "magic1", "main"];
let fixtureDir, origin, child, browser, firstProject;

async function freePort(){
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function post(route, body){
  const response = await fetch(origin + route, { method:"POST", body });
  const result = await response.json();
  assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`);
  return result;
}
async function makeProject(name){
  const dir = path.join(fixtureDir, "projects", name);
  await mkdir(dir, { recursive:true });
  return (await post("/project?name=" + encodeURIComponent(name), dir)).id;
}
async function openBoard(storage){
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width:1440, height:900 });
  if (storage) await page.evaluateOnNewDocument(entries => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(origin + "/", { waitUntil:"domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
  return { context, page };
}
async function visibleRegions(page){
  return page.evaluate(ids => ids.filter(id => {
    const el = document.querySelector(id === "main" ? "main" : "#" + id);
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility === "visible" &&
      rect.width > 0 && rect.height > 0;
  }), REGIONS);
}
async function assertVisible(page, expected){
  const actual = await visibleRegions(page);
  const details = await page.evaluate(() => ({
    classes:document.body.className, owner:activeOwner,
    page:localStorage.getItem("activepage." + activeOwner),
    stage:getComputedStyle(document.getElementById("stage")).visibility,
  }));
  assert.deepEqual(actual, expected, JSON.stringify(details));
}
async function selectProject(page, id){
  await page.waitForSelector(`#tabbar .ptab[data-owner="${id}"]`);
  await page.click(`#tabbar .ptab[data-owner="${id}"]`);
  await page.waitForFunction(owner => activeOwner === owner, {}, id);
}

before(async () => {
  fixtureDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-default-layout-")));
  await mkdir(SHOTS, { recursive:true });
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  await writeFile(path.join(fixtureDir, "server.py"),
    source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])"));
  for (const name of ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js",
    "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
    "compose-format.js", "cm-markdown.js"])
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title:"Default layout fixture", items:[{ id:"0", bucket:"meta", owner:"facilitator", title:"Welcome card" }],
  }));
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd:fixtureDir, env:{ ...process.env, HOME:fixtureDir, FACILITATOR_TEST_PORT:String(port),
      FACILITATOR_LOG_DIR:fixtureDir }, stdio:["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline){
    if (child.exitCode !== null) throw new Error(`fixture exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  if (!(await fetch(origin + "/state")).ok) throw new Error(`fixture did not start:\n${output}`);
  browser = await puppeteer.launch({ executablePath:CHROME, headless:true,
    args:["--disable-background-networking", "--no-first-run", "--no-sandbox"] });
});
after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive:true, force:true });
});

test("fresh and newly opened projects show four regions; a restored region persists", async () => {
  const { context, page } = await openBoard();
  try {
    await assertVisible(page, FOUR);
    await page.screenshot({ path:path.join(SHOTS, "fresh-board.png") });
    firstProject = await makeProject("Fresh Project");
    await selectProject(page, firstProject);
    await assertVisible(page, FOUR);
    await page.screenshot({ path:path.join(SHOTS, "new-project.png") });
    await page.click("#editbtn");
    await page.waitForSelector('.rkill.restore[data-region="magic2"]', { visible:true });
    await page.click('.rkill.restore[data-region="magic2"]');
    await page.click("#editbtn");
    await assertVisible(page, ["clockbox", "tickets", "magic1", "magic2", "main"]);
    await page.reload({ waitUntil:"domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    await assertVisible(page, ["clockbox", "tickets", "magic1", "magic2", "main"]);
    await selectProject(page, "facilitator");
    await assertVisible(page, FOUR);
  } finally { await context.close(); }
});

test("existing browser keeps visible regions while its future project gets the new default", async () => {
  const { context, page } = await openBoard({
    "layoutsync.1":"1", "hide.facilitator.magic2":"1",
    "pos.facilitator.goalbox":JSON.stringify({ x:1158, y:742 }),
  });
  try {
    await assertVisible(page, ["clockbox", "tickets", "magic1", "magic3", "goalbox", "rail", "main"]);
    await page.screenshot({ path:path.join(SHOTS, "legacy-board.png") });
    await selectProject(page, firstProject);
    await assertVisible(page, FOUR);
    const laterOwner = await makeProject("Later Project");
    await selectProject(page, laterOwner);
    await assertVisible(page, FOUR);
    await page.screenshot({ path:path.join(SHOTS, "legacy-new-project.png") });
    await page.reload({ waitUntil:"domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    await assertVisible(page, FOUR);
  } finally { await context.close(); }
});
