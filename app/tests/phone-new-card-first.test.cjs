// A new card's box goes to the front of #cards on the phone page, so nothing
// hidden stands in front of the title being named. The page is driven headless
// at an iPhone size against its own fixture server; the cards are invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  process.env.FACILITATOR_BROWSER_EXECUTABLE ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

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
  assert.equal(response.status, 200);
  return response.json();
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-new-first-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js", "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone new card first test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." }],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) { ready = true; break; } } catch {}
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

test("a card made with the plus, and a card that arrives from the board, are each the first box in #cards", async () => {
  for (let n = 1; n <= 6; n++) await api("/create?owner=facilitator", `Invented card ${n}`);
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  try {
    await page.setViewport(PHONE);
    await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    // the page builds only the card on show and the ones around it, so the
    // board's size is what it holds, not what is built
    const board = await page.evaluate(() => lastState.boxes.length);
    assert.ok(board >= 7, `only ${board} cards were on the board`);

    await page.evaluate(() => openDrawer());
    const created = page.waitForResponse(r => new URL(r.url()).pathname === "/create");
    await page.evaluate(() => document.getElementById("tikadd").click());
    const made = (await (await created).json()).id;
    await page.waitForFunction(id => document.querySelector(`#box-${id}.sel .title`)?.isContentEditable, { timeout: 3000 }, made);
    const afterPlus = await page.evaluate(() => {
      const cards = document.getElementById("cards");
      return { first: cards.firstElementChild.id, board: lastState.boxes.length };
    });
    assert.equal(afterPlus.first, `box-${made}`, "the card made with the plus is not the first box");
    assert.equal(afterPlus.board, board + 1);

    const sent = (await api("/create?owner=facilitator", "Arrived from the board")).id;
    await page.waitForFunction(id => !!document.getElementById(`box-${id}`), { timeout: 6000 }, sent);
    const afterArrival = await page.evaluate(() => {
      const cards = document.getElementById("cards");
      return { ids: [...cards.children].slice(0, 2).map(box => box.id), board: lastState.boxes.length };
    });
    assert.deepEqual(afterArrival.ids, [`box-${sent}`, `box-${made}`], "a card that arrived is not the first box");
    assert.equal(afterArrival.board, board + 2);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
