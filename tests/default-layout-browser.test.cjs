// A clean browser sees the clock, the ticket list and the card at the places and
// sizes the board's default layout names, a newly opened project starts the same
// way, and an older browser keeps the visibility and the layout it already had.
// The layout is the board's (settings.json, through board-settings.js): each
// case starts the board's settings empty and plants what an older browser had
// saved in that browser's own storage, which the one-time copy then hands to
// the board, exactly as an existing browser's first load of this code does.
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
const SHOTS = process.env.FACILITATOR_LAYOUT_SHOTS || path.join(tmpdir(), "facilitator-default-layout-shots");
const REGIONS = ["clockbox", "tickets", "magic1", "magic2", "magic3", "magic4", "goalbox", "rail", "main"];
const THREE = ["clockbox", "tickets", "main"];
// the default places and sizes in stage pixels, the stage being 1440 by 900
const DEFAULT_RECTS = {
  clockbox:{ x:28.8, y:40.32, w:218.88, h:103.68 },
  tickets:{ x:51.84, y:190.08, w:357.12, h:587.52 },
  main:{ x:466.56, y:74.88, w:506.88, h:748.8 },
};
// the same arrangement written out as a saved layout, with the other boxes put away
const SAVED_SAME_AS_DEFAULT = {
  "pos.facilitator.clockbox":JSON.stringify({ x:28.8, y:40.32 }),
  "size.facilitator.clockbox":JSON.stringify({ w:218.88, h:103.68 }),
  "pos.facilitator.tickets":JSON.stringify({ x:51.84, y:190.08 }),
  "size.facilitator.tickets":JSON.stringify({ w:357.12, h:587.52 }),
  "pos.facilitator.main":JSON.stringify({ x:466.56, y:74.88 }),
  "size.facilitator.main":JSON.stringify({ w:506.88, h:748.8 }),
  "hide.facilitator.magic1":"1", "hide.facilitator.magic2":"1", "hide.facilitator.magic3":"1",
  "hide.facilitator.rail":"1", "hide.facilitator.goalbox":"1",
};
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
// the board's settings emptied, so the next browser is the first to load the
// settings code against this board; asked until it stays empty, since a page
// just closed may still have a write on its way
async function clearBoardSettings(){
  for (let quiet = 0; quiet < 2;){
    const { values } = await (await fetch(origin + "/settings")).json();
    const keys = Object.keys(values);
    if (keys.length) await post("/settings", JSON.stringify(Object.fromEntries(keys.map(k => [k, null]))));
    quiet = keys.length ? 0 : quiet + 1;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}
async function boardSettings(){
  return (await (await fetch(origin + "/settings")).json()).values;
}
// every setting this page wrote has been answered by the board
async function settled(page){
  await page.waitForFunction(() => !globalThis.boardSettings || !boardSettings.busy);
}
async function openBoard(storage, viewport){
  await clearBoardSettings();
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport || { width:1440, height:900 });
  if (storage) await page.evaluateOnNewDocument(entries => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, storage);
  await page.goto(origin + "/", { waitUntil:"domcontentloaded" });
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
  await settled(page);
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
async function stageRects(page){
  return page.evaluate(() => {
    const stage = document.getElementById("stage").getBoundingClientRect();
    const scale = stage.width / 1440;
    const out = { scale };
    for (const id of ["clockbox", "tickets", "main"]){
      const r = document.querySelector(id === "main" ? "main" : "#" + id).getBoundingClientRect();
      out[id] = { x:(r.x - stage.x) / scale, y:(r.y - stage.y) / scale, w:r.width / scale, h:r.height / scale };
    }
    return out;
  });
}
function assertRects(actual, expected, label){
  for (const id of Object.keys(expected))
    for (const k of ["x", "y", "w", "h"])
      assert.ok(Math.abs(actual[id][k] - expected[id][k]) < 0.1,
        `${label}: ${id}.${k} is ${actual[id][k]}, expected ${expected[id][k]}`);
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
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
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

test("fresh and newly opened projects show three regions; a restored region persists", async () => {
  const { context, page } = await openBoard();
  try {
    await assertVisible(page, THREE);
    assertRects(await stageRects(page), DEFAULT_RECTS, "fresh board");
    await page.screenshot({ path:path.join(SHOTS, "fresh-board.png") });
    firstProject = await makeProject("Fresh Project");
    await selectProject(page, firstProject);
    await assertVisible(page, THREE);
    assertRects(await stageRects(page), DEFAULT_RECTS, "new project");
    await page.screenshot({ path:path.join(SHOTS, "new-project.png") });
    // Edit mode now shows only the boxes that are on screen: a removed box is
    // not resurrected as a faint ghost, and the in-canvas restore cross was
    // removed along with the ghosts. A reveal is exercised through the same
    // persisted show key the board writes; see the m797 report for the tradeoff.
    await page.evaluate(owner => {
      settingsStore.setItem("show." + owner + ".magic2", "1");
      applySavedLayout();
    }, firstProject);
    await assertVisible(page, ["clockbox", "tickets", "magic2", "main"]);
    await settled(page);
    assert.equal((await boardSettings())["show." + firstProject + ".magic2"], "1", "the reveal did not reach the board");
    await page.reload({ waitUntil:"domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    await assertVisible(page, ["clockbox", "tickets", "magic2", "main"]);
    await selectProject(page, "facilitator");
    await assertVisible(page, THREE);
  } finally { await context.close(); }
});

test("the default layout holds its places and sizes at other window sizes", async () => {
  for (const [width, height] of [[1512, 982], [1280, 800], [1920, 1080]]){
    const { context, page } = await openBoard(null, { width, height });
    try {
      await assertVisible(page, THREE);
      assertRects(await stageRects(page), DEFAULT_RECTS, width + "x" + height);
      await page.screenshot({ path:path.join(SHOTS, `fresh-${width}x${height}.png`) });
    } finally { await context.close(); }
  }
});

test("a saved layout wins over the default and is not rewritten", async () => {
  const { "hide.facilitator.magic2":_hidden, ...rest } = SAVED_SAME_AS_DEFAULT;
  // places are on star lines (a half cell past a whole one) and sizes are whole cells
  const saved = {
    ...rest,
    "pos.facilitator.clockbox":JSON.stringify({ x:86.4, y:97.92 }),
    "size.facilitator.clockbox":JSON.stringify({ w:241.92, h:115.2 }),
    "pos.facilitator.main":JSON.stringify({ x:570.24, y:63.36 }),
    "hide.facilitator.tickets":"1",
    "show.facilitator.magic2":"1",
  };
  const { context, page } = await openBoard(saved);
  try {
    await assertVisible(page, ["clockbox", "magic2", "main"]);
    const rects = await stageRects(page);
    assertRects(rects, {
      clockbox:{ x:86.4, y:97.92, w:241.92, h:115.2 },
      main:{ x:570.24, y:63.36, w:506.88, h:748.8 },
    }, "saved layout");
    const kept = await page.evaluate(keys => keys.map(k => settingsStore.getItem(k)), Object.keys(saved));
    assert.deepEqual(kept, Object.values(saved), "every saved key reads back as it was written");
    const board = await boardSettings();
    assert.deepEqual(Object.keys(saved).map(k => board[k]), Object.values(saved), "the board does not hold the saved layout");
    // and the browser's own copy is left where it was
    const local = await page.evaluate(keys => keys.map(k => localStorage.getItem(k)), Object.keys(saved));
    assert.deepEqual(local, Object.values(saved), "the one-time copy took the browser's own keys away");
  } finally { await context.close(); }
});

test("a saved layout equal to the default looks the same as the default", async () => {
  const { context, page } = await openBoard(SAVED_SAME_AS_DEFAULT);
  try {
    await assertVisible(page, THREE);
    assertRects(await stageRects(page), DEFAULT_RECTS, "saved copy of the default");
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
    await assertVisible(page, THREE);
    const laterOwner = await makeProject("Later Project");
    await selectProject(page, laterOwner);
    await assertVisible(page, THREE);
    assertRects(await stageRects(page), DEFAULT_RECTS, "legacy browser, new project");
    await page.screenshot({ path:path.join(SHOTS, "legacy-new-project.png") });
    await page.reload({ waitUntil:"domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    await assertVisible(page, THREE);
  } finally { await context.close(); }
});

test("a browser that already ran the first visibility pass keeps magic box 1 where it was showing", async () => {
  const { context, page } = await openBoard({
    "layoutsync.1":"1", "layoutvisibility.1":"1",
    "pos.facilitator.magic1":JSON.stringify({ x:97.92, y:650.88 }),
    "size.facilitator.magic1":JSON.stringify({ w:276.48, h:138.24 }),
  });
  try {
    await assertVisible(page, ["clockbox", "tickets", "magic1", "main"]);
    const rect = await page.evaluate(() => {
      const stage = document.getElementById("stage").getBoundingClientRect();
      const r = document.getElementById("magic1").getBoundingClientRect();
      const scale = stage.width / 1440;
      return { x:(r.x - stage.x) / scale, y:(r.y - stage.y) / scale, w:r.width / scale, h:r.height / scale };
    });
    for (const [k, v] of Object.entries({ x:97.92, y:650.88, w:276.48, h:138.24 }))
      assert.ok(Math.abs(rect[k] - v) < 0.1, `magic1.${k} is ${rect[k]}, expected ${v}`);
    await selectProject(page, firstProject);
    await assertVisible(page, THREE);
  } finally { await context.close(); }
});

test("a browser that hid magic box 1 keeps it hidden after the second visibility pass", async () => {
  const { context, page } = await openBoard({
    "layoutsync.1":"1", "layoutvisibility.1":"1", "hide.facilitator.magic1":"1",
  });
  try {
    await assertVisible(page, THREE);
    assert.equal(await page.evaluate(() => settingsStore.getItem("show.facilitator.magic1")), null);
    assert.equal((await boardSettings())["show.facilitator.magic1"], undefined);
  } finally { await context.close(); }
});
