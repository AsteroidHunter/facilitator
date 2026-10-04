// The phone page builds only the card on show and the cards around it. A card
// far from it is taken down and built again as it was left, and a card with a
// send the board has not settled is never taken down. The page is driven
// headless at an iPhone size against its own fixture server; the cards are
// invented.
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
const SEL = "article.box.sel textarea";
const BOARD = 40;

let browser;
let child;
let fixtureDir;
let origin;
let cards = [];

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
  assert.equal(response.status, 200, `${route} returned ${response.status}`);
  return response.json();
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const paragraphs = (label, count) =>
  Array.from({ length: count }, (_, i) => `${label} paragraph ${i + 1}. A sentence long enough to fill a line or two.`).join("\n\n");

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-nearby-"));
  await mkdir(path.join(fixtureDir, "logs"));
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
    title: "phone nearby cards test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." }],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
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

  for (let n = 1; n <= BOARD; n++) cards.push((await api("/create?owner=facilitator", `Invented card ${n}`)).id);
  await api(`/reply?box=${cards[0]}`, paragraphs("Long reply", 30));

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

async function openPhone(card) {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(`${origin}/m?box=${card}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`#box-${card}.sel`, { timeout: 8000 });
  return { page, problems };
}

// a card well clear of the one on show in both orders, so that going there takes
// the first card, and its neighbours, out of the keep
function farFrom(page) {
  return page.evaluate(() => {
    const pools = [navigationPool(lastState), viewPool(lastState)];
    const apart = (pool, id) => {
      const a = pool.findIndex(b => b.id === selectedId);
      const c = pool.findIndex(b => b.id === id);
      if (a < 0 || c < 0) return Infinity;
      const d = Math.abs(a - c);
      return Math.min(d, pool.length - d);
    };
    return lastState.boxes.map(b => b.id).find(id => pools.every(pool => apart(pool, id) > NEAR_KEEP + 1));
  });
}

test("only the card on show and its neighbours are built, however many cards are on the board", async () => {
  const { page, problems } = await openPhone(cards[0]);
  try {
    await page.waitForFunction(() => Object.keys(els).length > 1, { timeout: 5000 });
    await settle(500);
    const seen = await page.evaluate(() => ({
      board: lastState.boxes.length,
      built: Object.keys(els),
      domBoxes: document.querySelectorAll("#cards > article.box").length,
      keep: [...nearbyCards().keep],
      neighbours: [-1, 1].map(dir => cardStepTarget(dir)?.id),
      shown: selectedId,
    }));
    assert.ok(seen.board >= BOARD, `only ${seen.board} cards were on the board`);
    assert.equal(seen.domBoxes, seen.built.length, "a built card is missing from the page or one is left in it without a record");
    assert.ok(seen.built.length < seen.board / 3, `${seen.built.length} of ${seen.board} cards are built`);
    assert.ok(seen.built.every(id => seen.keep.includes(id)), "a card outside the keep is built");
    for (const id of [seen.shown, ...seen.neighbours].filter(Boolean)) assert.ok(seen.built.includes(id), `${id} is not built`);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a draft and the scroll of the reply are back when a card is shown again after a visit far away", async () => {
  const shown = cards[0];
  const { page, problems } = await openPhone(shown);
  try {
    await page.waitForFunction(id => {
      const el = els[id];
      return el && el.replyview.scrollHeight - el.replyview.clientHeight > 700;
    }, { timeout: 8000 }, shown);
    await page.focus(SEL);
    await page.keyboard.type("A half sentence that has to be kept");
    const words = await page.$eval(SEL, field => field.value);
    assert.equal(words, "A half sentence that has to be kept");
    await page.evaluate(id => { els[id].replyview.scrollTop = 600; }, shown);
    await page.waitForFunction(id => els[id].replyTop >= 590, { timeout: 3000 }, shown);
    await page.evaluate(() => document.activeElement.blur());

    const far = await farFrom(page);
    assert.ok(far, "no card is far from the one on show");
    await page.evaluate(id => select(id), far);
    await page.waitForFunction((id, gone) => els[id] && !els[gone], { timeout: 5000 }, far, shown);
    const shelved = await page.evaluate(id => ({ ...shelf[id] }), shown);
    assert.equal(shelved.value, words, "the words were not put on the shelf");
    assert.equal(shelved.start, words.length, "the caret was not put on the shelf");
    assert.ok(shelved.top >= 590, "the answer's scroll was not put on the shelf");

    await page.evaluate(id => select(id), shown);
    await page.waitForFunction(id => els[id] && !shelf[id], { timeout: 5000 }, shown);
    const back = await page.evaluate(id => ({ value: els[id].ta.value, shelf: id in shelf }), shown);
    assert.equal(back.value, words, "the words did not come back");
    assert.equal(back.shelf, false, "the shelf kept what it handed back");
    await page.waitForFunction(id => Math.abs(els[id].replyview.scrollTop - 600) <= 2, { timeout: 5000 }, shown);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a card with a send the board has not settled stays built however far the reader goes", async () => {
  const sender = cards[1];
  const { page, problems } = await openPhone(sender);
  try {
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/send") request.respond({ status: 503, body: "{}" });
      else request.continue();
    });
    await page.waitForFunction(() => Object.keys(els).length > 1, { timeout: 5000 });
    await page.focus(SEL);
    await page.keyboard.type("A message the board will not take yet");
    await page.evaluate(() => document.activeElement.blur());
    const neighbour = await page.evaluate(() => cardStepTarget(1).id);
    await page.evaluate(id => doSend(id, { advance: false }), sender);
    await page.waitForFunction(id => ops.some(op => op.box === id), { timeout: 3000 }, sender);

    const far = await farFrom(page);
    assert.ok(far, "no card is far from the one on show");
    await page.evaluate(id => select(id), far);
    await page.waitForFunction((id, gone) => els[id] && !els[gone], { timeout: 5000 }, far, neighbour);
    const held = await page.evaluate(id => ({ built: !!els[id], pending: ops.some(op => op.box === id) }), sender);
    assert.equal(held.pending, true, "the send was settled");
    assert.equal(held.built, true, "the card with the unsettled send was taken down");
    assert.deepEqual(problems, []);
    await page.evaluate(() => localStorage.clear());
  } finally {
    await page.close();
  }
});
