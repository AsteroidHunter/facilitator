// The board's tab bar and its read marks, driven headless against a real
// fixture server: the bar draws the order the board holds, a drag and a close
// are written back to it, an outside change lands on the next poll, opening a
// card marks it read for every device, and the one-time carry-over out of this
// browser's own storage happens once and never again.
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

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function state() {
  return (await fetch(origin + "/state")).json();
}

async function tabs() {
  return (await state()).tabs;
}

async function seenOf(id) {
  return (await state()).boxes.find(box => box.id === id).seen;
}

// the board's own record, put back the way each test wants to start
async function setTabs(order, closed) {
  const written = await post("/tabs", JSON.stringify({ order, closed }));
  assert.equal(written.status, 200);
}

async function until(check, ms = 4000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await settle(60);
  }
  throw new Error("the page never got there; last answer " + JSON.stringify(last));
}

// a desktop board, optionally with keys already in this browser's storage, the
// way his own browser carries them from before the records moved to the board.
// each one gets its own browsing context, so what one test leaves in storage
// is never what the next test starts from
async function openBoard(storage) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  if (storage) {
    await page.evaluateOnNewDocument(items => {
      try {
        for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
      } catch (err) {}
    }, storage);
  }
  await page.setViewport(DESK);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
  await settle(400);
  return { page, problems, context };
}

const barOrder = page => page.$$eval("#tabbar .ptab:not(.draft)", tabs => tabs.map(t => t.dataset.owner));
const barShown = page => page.$$eval("#tabbar .ptab:not(.draft)",
  tabs => tabs.filter(t => t.getBoundingClientRect().width > 0).map(t => t.dataset.owner));

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-tabbar-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "m.html", "m-sw.js", "m-manifest.json", "page.html",
                      "card-markdown.js", "card-tokens.css", "card-logic.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Tab bar test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator" },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland" },
    ],
  }));

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

  // one answered card in each lane, so the read marks have something to mark
  await post("/send?box=0", "a question on the meta card");
  await post("/reply?box=0", "the answer on the meta card");
  await post("/send?box=1.1", "a question in the other lane");
  await post("/reply?box=1.1", "the answer in the other lane");

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

test("the bar draws the order the board holds, not the browser's own", async () => {
  await setTabs(["pastureland", "facilitator"], []);
  const { page, problems, context } = await openBoard();
  try {
    assert.deepEqual(await barOrder(page), ["pastureland", "facilitator"]);
    await setTabs(["facilitator", "pastureland"], []);
    const { page: second, problems: alsoProblems, context: alsoContext } = await openBoard();
    try {
      assert.deepEqual(await barOrder(second), ["facilitator", "pastureland"]);
      assert.deepEqual(alsoProblems, []);
    } finally {
      await alsoContext.close();
    }
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a tab dragged along the bar is written back to the board", async () => {
  await setTabs(["facilitator", "pastureland"], []);
  const { page, problems, context } = await openBoard();
  try {
    const boxes = await page.$$eval("#tabbar .ptab:not(.draft)", tabs =>
      tabs.map(t => { const r = t.getBoundingClientRect(); return { owner: t.dataset.owner, x: r.x, y: r.y, w: r.width, h: r.height }; }));
    const [first, second] = boxes;
    await page.mouse.move(first.x + first.w / 2, first.y + first.h / 2);
    await page.mouse.down();
    // sideways past the neighbour's midpoint: the desktop's own reorder gesture
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(first.x + first.w / 2 + (second.x + second.w - first.x - first.w / 2) * step / 8,
                            first.y + first.h / 2);
      await settle(20);
    }
    await page.mouse.up();
    await settle(500);   // the drop glides for a quarter second before the bar repaints
    assert.deepEqual((await tabs()).order, ["pastureland", "facilitator"]);
    assert.deepEqual(await barOrder(page), ["pastureland", "facilitator"]);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a tab closed on the board is written back to it", async () => {
  await setTabs(["facilitator", "pastureland"], []);
  const { page, problems, context } = await openBoard();
  try {
    await page.evaluate(() =>
      document.querySelector('#tabbar .ptab[data-owner="pastureland"] .ptabx').click());
    await settle(400);
    assert.deepEqual((await tabs()).closed, ["pastureland"]);
    assert.deepEqual(await barShown(page), ["facilitator"]);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("a change made elsewhere reaches the open board on its next poll", async () => {
  await setTabs(["facilitator", "pastureland"], []);
  const { page, problems, context } = await openBoard();
  try {
    await setTabs(["pastureland", "facilitator"], []);
    await until(async () => (await barOrder(page)).join(",") === "pastureland,facilitator");
    await setTabs(["pastureland", "facilitator"], ["facilitator"]);
    await until(async () => (await barShown(page)).join(",") === "pastureland");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("opening a card marks its replies read on the board", async () => {
  await setTabs(["facilitator", "pastureland"], []);
  await post("/seen", JSON.stringify({ "0": 0 }));
  const { page, problems, context } = await openBoard();
  try {
    assert.equal(await seenOf("0"), 0);
    await page.evaluate(() => document.querySelector('#tiklist .trow[data-id="0"]').click());
    await until(async () => (await seenOf("0")) === 1);
    // and a read mark made elsewhere reaches this page too
    await post("/seen", JSON.stringify({ "1.1": 1 }));
    await until(async () => page.evaluate(() => seenReplies["1.1"] === 1));
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the browser's own arrangement and read marks carry over once, then never again", async () => {
  // a board with no arrangement of its own, as it stands the first time a
  // browser that has one opens it
  await post("/tabs", JSON.stringify({ order: [], closed: [] }));
  await post("/seen", JSON.stringify({ "0": 0, "1.1": 0 }));
  const answered = (await state()).boxes.find(box => box.id === "1.1").agentTs;
  const { page, problems, context } = await openBoard({
    taborder: JSON.stringify(["pastureland", "facilitator"]),
    "tabhide.pastureland": "1",
    // the old mark was the time of the viewing: this card was opened after its
    // answer landed, the other one never was
    seenReplies: JSON.stringify({ "1.1": answered + 60 }),
  });
  try {
    await until(async () => (await tabs()).order.length > 0);
    assert.deepEqual(await tabs(), { order: ["pastureland", "facilitator"], closed: ["pastureland"] });
    await until(async () => (await seenOf("1.1")) === 1);
    assert.equal(await seenOf("0"), 0, "a card never opened here was carried over as read");

    // the board is the only source now: a record written elsewhere is not
    // overwritten by the same browser's storage on the next load
    await setTabs(["facilitator", "pastureland"], []);
    await post("/seen", JSON.stringify({ "1.1": 0 }));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
    await settle(1500);
    assert.deepEqual(await tabs(), { order: ["facilitator", "pastureland"], closed: [] });
    assert.equal(await seenOf("1.1"), 0);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
