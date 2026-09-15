// Doing, deferred and done belong to one project at a time, driven headless
// against a real fixture server with four invented lanes. Picking done in one
// project must leave every other project on the view it was left on, and a
// project this browser has never opened must start on doing. The same record
// is checked on the three surfaces that draw the list: the board, the phone's
// drawer and the page view's document, whose two sets of buttons share it.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { homedir, tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.M636_SHOTS || "/tmp/m636-shots";
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// the four lanes, and what each is for. the last three are made through
// /project, so their ids are the slugs the server hands out: a plain word, one
// that reads as a view name, and one that opens with a digit
const A = "facilitator";          // the project a view is picked in
const B = "greenhouse";           // the project the pick must not follow
const C = "done";                 // a lane whose id is one of the view names
const D = "2026-q1-review";       // the lane no test opens until it has to

let browser;
let child;
let fixtureDir;
let laneDirs = [];
let origin;
const cards = {};                 // "<lane> <shape> <n>" -> the id the board gave it

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

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

async function post(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function state() {
  return (await fetch(origin + "/state")).json();
}

// one card in a lane, put into the shape the view it belongs to needs
async function makeCard(owner, shape, n) {
  const title = `${owner} ${shape} ${n}`;
  const made = await post(`/create?owner=${encodeURIComponent(owner)}`, title);
  assert.equal(made.status, 200, `card ${title} was refused`);
  if (shape === "deferred") assert.equal((await post(`/park?box=${made.body.id}&v=1`)).status, 200);
  if (shape === "done") assert.equal((await post(`/done?box=${made.body.id}&v=1`)).status, 200);
  cards[title] = made.body.id;
  return title;
}

// what a lane's list is expected to hold, newest card of the view on top: the
// board sorts every group by its stamp, and these are made oldest first
const expected = {
  todo: owner => [`${owner} todo 2`, `${owner} todo 1`],
  deferred: owner => [`${owner} deferred 1`],
  done: owner => [`${owner} done 2`, `${owner} done 1`],
};
// the page view's document keeps the board's own order instead, which is the
// order the cards were made in
const docExpected = {
  todo: owner => [`${owner} todo 1`, `${owner} todo 2`],
  deferred: owner => [`${owner} deferred 1`],
  done: owner => [`${owner} done 1`, `${owner} done 2`],
};

async function openPage(route, viewport, storage) {
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
  await page.setViewport(viewport);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
  await settle(400);
  return { page, problems, context };
}

const openBoard = storage => openPage("/", DESK, storage);
const openPhone = storage => openPage("/m", PHONE, storage);
const openPageView = storage => openPage("/page", DESK, storage);

// the button standing lit, the rows the list is showing, and the set the arrow
// keys walk: the three that have to agree
const litButton = page => page.$$eval("#tikhead .tvb.on", buttons => buttons.map(b => b.textContent));
const rowTitles = page => page.$$eval("#tiklist .trow .ttl", rows => rows.map(r => r.textContent));
const walkTitles = page => page.evaluate(() => viewPool(lastState).map(b => b.title));
const openTab = page => page.evaluate(() => activeOwner);
const stored = (page, owner) => page.evaluate(key => localStorage.getItem(key), "tikview." + owner);

async function clickTab(page, owner) {
  await page.click(`#tabbar .ptab[data-owner="${owner}"]`);
  await settle(350);
  assert.equal(await openTab(page), owner, `the bar did not switch to ${owner}`);
}

// the phone's bar scrolls, so the tab is brought into the screen before the
// finger goes down on it
async function tapTab(page, owner) {
  const selector = `#tabbar .ptab[data-owner="${owner}"]`;
  await page.$eval(selector, t => t.scrollIntoView({ inline: "center", block: "nearest" }));
  await settle(250);
  const spot = await page.$eval(selector,
    t => { const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.touchscreen.tap(spot.x, spot.y);
  await settle(350);
  assert.equal(await openTab(page), owner, `the phone's bar did not switch to ${owner}`);
}

async function clickView(page, view) {
  await page.click("#tv-" + view);
  await settle(350);
}

// one project's whole list state in one read, so a failure says which of the
// three disagreed rather than only that something did
async function listState(page) {
  return { lit: await litButton(page), rows: await rowTitles(page), walk: await walkTitles(page) };
}

// the lane is showing exactly the view named: its button is lit alone, its rows
// are that view's cards, and the arrow keys walk exactly those rows
async function assertShowing(page, owner, view, where) {
  const label = { todo: "doing", deferred: "deferred", done: "done" }[view];
  const { lit, rows, walk } = await listState(page);
  assert.deepEqual(lit, [label], `${where}: ${owner} lit ${lit.join()} instead of ${label}`);
  assert.deepEqual(rows, expected[view](owner), `${where}: ${owner} listed the wrong cards for ${label}`);
  assert.deepEqual(walk, rows, `${where}: ${owner}'s arrow keys and its list walk different cards`);
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-listview-"));
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
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({ title: "List view test", items: [] }));

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

  // the standing meta card a fresh board gives its second lane goes, so every
  // lane in this fixture holds exactly the five cards made below
  for (const box of (await state()).boxes) {
    if (box.bucket === "meta" && box.id !== "q") assert.equal((await post(`/close?box=${box.id}`)).status, 200);
  }

  // the two made-up project lanes. the server only takes a folder under the
  // home directory, so each gets a throwaway one that is removed again below
  for (const name of ["Greenhouse", "Done", "2026 Q1 Review"]) {
    const dir = await mkdtemp(path.join(homedir(), ".facilitator-listview-fixture-"));
    laneDirs.push(dir);
    const made = await post(`/project?name=${encodeURIComponent(name)}`, dir);
    assert.equal(made.status, 200, `lane ${name} was refused: ${JSON.stringify(made.body)}`);
  }
  const lanes = Object.keys((await state()).pwds);
  for (const owner of [B, C, D]) assert.ok(lanes.includes(owner), `lane ${owner} is not on the board`);

  // five cards per lane, oldest first, so every view has something in it and
  // two of them have enough for the arrow keys to walk
  for (const owner of [A, B, C, D]) {
    for (const [shape, n] of [["todo", 1], ["todo", 2], ["deferred", 1], ["done", 1], ["done", 2]]) {
      await makeCard(owner, shape, n);
    }
  }

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
  for (const dir of laneDirs) await rm(dir, { recursive: true, force: true });
});

test("the board: done picked in one project does not follow the switch to another", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, A);
    await assertShowing(page, A, "todo", "before anything is picked");
    await page.screenshot({ path: path.join(SHOTS, "board-1-a-doing.png") });

    await clickView(page, "done");
    await assertShowing(page, A, "done", "after picking done");
    await page.screenshot({ path: path.join(SHOTS, "board-2-a-done.png") });

    // the reported failure: the other project used to open on done as well
    await clickTab(page, B);
    await assertShowing(page, B, "todo", "the first visit to another project");
    await page.screenshot({ path: path.join(SHOTS, "board-3-b-doing.png") });

    // and going back finds the view that was picked here still standing
    await clickTab(page, A);
    await assertShowing(page, A, "done", "going back to the project done was picked in");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: three projects hold three views through switches in both directions", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, A);
    await clickView(page, "done");
    await clickTab(page, B);
    await clickView(page, "deferred");
    await clickTab(page, C);          // picked for nothing: this one stays on doing

    for (let round = 0; round < 2; round++) {
      for (const [owner, view] of [[A, "done"], [B, "deferred"], [C, "todo"]]) {
        await clickTab(page, owner);
        await assertShowing(page, owner, view, `round ${round} forwards`);
      }
      for (const [owner, view] of [[C, "todo"], [B, "deferred"], [A, "done"]]) {
        await clickTab(page, owner);
        await assertShowing(page, owner, view, `round ${round} backwards`);
      }
    }
    await page.screenshot({ path: path.join(SHOTS, "board-4-three-views.png") });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: the arrow keys walk the rows the open project is showing", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, A);
    await clickView(page, "done");
    await clickTab(page, B);

    // a switch may land the card on one outside the list; the keys still walk
    // the list itself and never leave it
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const rows = await rowTitles(page);
    const walked = [];
    for (let step = 0; step < rows.length + 1; step++) {
      await page.keyboard.press("ArrowRight");
      await settle(120);
      walked.push(await page.evaluate(() => lastState.boxes.find(b => b.id === selectedId).title));
    }
    for (const title of walked) assert.ok(rows.includes(title), `the keys left ${B}'s doing list for ${title}`);
    assert.equal(new Set(walked).size, rows.length, "the keys did not walk every row of the list");
    await assertShowing(page, B, "todo", "after walking with the keys");

    // and the same walk inside the project that is on done
    await clickTab(page, A);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const doneRows = await rowTitles(page);
    const doneWalk = [];
    for (let step = 0; step < doneRows.length; step++) {
      await page.keyboard.press("ArrowRight");
      await settle(120);
      doneWalk.push(await page.evaluate(() => lastState.boxes.find(b => b.id === selectedId).title));
    }
    for (const title of doneWalk) assert.ok(doneRows.includes(title), `the keys left ${A}'s done list for ${title}`);
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: a reload puts each project back on its own view, and the board is never told", async () => {
  const before = (await state()).rev;
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, A);
    await clickView(page, "done");
    await clickTab(page, B);
    await clickView(page, "deferred");
    // the choice is this browser's own: nothing about it is sent to the board
    const after = await state();
    assert.equal(after.rev, before, "picking a view moved the board's revision");
    assert.ok(!JSON.stringify(after).includes("tikview"), "the board was told about a view choice");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
    await settle(600);
    assert.equal(await openTab(page), B, "the reload did not come back to the open project");
    await assertShowing(page, B, "deferred", "after a reload");
    await clickTab(page, A);
    await assertShowing(page, A, "done", "the other project after a reload");
    await clickTab(page, C);
    await assertShowing(page, C, "todo", "a project no view was picked for, after a reload");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: a project this browser has never opened starts on doing", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, A);
    await clickView(page, "done");
    assert.equal(await stored(page, D), null, "a lane nobody has opened already had a view written down");
    await clickTab(page, D);
    await assertShowing(page, D, "todo", "the first visit of all to a project");
    assert.equal(await stored(page, D), null, "opening a project wrote a view nobody picked");
    await page.screenshot({ path: path.join(SHOTS, "board-5-unseen-project.png") });
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: each lane is keyed by its own id, however the id reads", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickTab(page, C);          // a lane whose id is itself a view name
    await clickView(page, "deferred");
    await clickTab(page, D);          // and one that opens with a digit
    await clickView(page, "done");
    assert.equal(await stored(page, C), "deferred");
    assert.equal(await stored(page, D), "done");
    assert.equal(await stored(page, A), null, "a lane nobody picked for was written down");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 8000 });
    await settle(600);
    await clickTab(page, C);
    await assertShowing(page, C, "deferred", "the lane called done, after a reload");
    await clickTab(page, D);
    await assertShowing(page, D, "done", "the lane whose id opens with a digit, after a reload");
    await clickTab(page, A);
    await assertShowing(page, A, "todo", "a lane neither of those two belongs to");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the board: a stored view that is not one of the three counts as no choice", async () => {
  const { page, problems, context } = await openBoard({
    activeproj: A,
    ["tikview." + A]: "everything",
    ["tikview." + B]: "done",
  });
  try {
    await assertShowing(page, A, "todo", "a project whose stored view is a word nobody wrote");
    await clickTab(page, B);
    await assertShowing(page, B, "done", "a project whose stored view is one of the three");
    await clickTab(page, A);
    await clickView(page, "deferred");
    assert.equal(await stored(page, A), "deferred", "picking a view did not replace the bad one");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the phone: the drawer's tabs are one project's choice, not the phone's", async () => {
  const { page, problems, context } = await openPhone();
  try {
    await tapTab(page, A);
    await page.evaluate(() => showMenu(drawer));
    await settle(700);
    await assertShowing(page, A, "todo", "the phone before anything is picked");
    await page.screenshot({ path: path.join(SHOTS, "phone-1-a-doing.png") });

    await clickView(page, "done");
    await assertShowing(page, A, "done", "the phone after picking done");
    await page.screenshot({ path: path.join(SHOTS, "phone-2-a-done.png") });

    await page.evaluate(() => hideMenu(drawer));
    await settle(700);
    await tapTab(page, B);
    await page.evaluate(() => showMenu(drawer));
    await settle(700);
    await assertShowing(page, B, "todo", "the phone's first visit to another project");
    await page.screenshot({ path: path.join(SHOTS, "phone-3-b-doing.png") });

    await clickView(page, "deferred");
    await page.evaluate(() => hideMenu(drawer));
    await settle(700);
    await tapTab(page, A);
    await page.evaluate(() => showMenu(drawer));
    await settle(700);
    await assertShowing(page, A, "done", "the phone going back to the first project");
    await page.evaluate(() => hideMenu(drawer));
    await settle(700);
    await tapTab(page, C);
    await assertShowing(page, C, "todo", "a project the phone has picked nothing for");
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});

test("the page view: the document's tabs and the list panel share one choice per project", async () => {
  const docLit = page => page.$$eval("#doctabs button.on", buttons => buttons.map(b => b.textContent));
  const docRows = page => page.$$eval("#docoutline .docrow .rttl", rows => rows.map(r => r.textContent));
  // the document view's own scrolling wrapper is laid over its left column at
  // every window size, so a pointer never reaches these three buttons: that is
  // this page's own layout and older than this test, and the button's click is
  // raised directly instead of waiting on it
  const clickDocTab = async (page, view) => {
    await page.$eval(`#doctabs button[data-page="${view}"]`, button => button.click());
    await settle(350);
  };
  const { page, problems, context } = await openPageView();
  try {
    await clickTab(page, A);
    assert.deepEqual(await docLit(page), ["Doing"]);
    assert.deepEqual(await docRows(page), docExpected.todo(A));
    await page.screenshot({ path: path.join(SHOTS, "pageview-1-a-doing.png") });

    await clickDocTab(page, "done");
    assert.deepEqual(await docLit(page), ["Done"]);
    assert.deepEqual(await docRows(page), docExpected.done(A));
    // the same page's own list panel is drawn from the same choice. it sorts
    // finished cards oldest first where the board sorts them newest first, so
    // what is compared here is which cards it holds and not their order
    assert.deepEqual(await litButton(page), ["done"], "the two sets of buttons disagree");
    assert.deepEqual((await rowTitles(page)).slice().sort(), expected.done(A).slice().sort());
    await page.screenshot({ path: path.join(SHOTS, "pageview-2-a-done.png") });

    await clickTab(page, B);
    assert.deepEqual(await docLit(page), ["Doing"], "the document view carried done into another project");
    assert.deepEqual(await docRows(page), docExpected.todo(B));
    assert.deepEqual(await litButton(page), ["doing"]);
    await page.screenshot({ path: path.join(SHOTS, "pageview-3-b-doing.png") });

    await clickTab(page, A);
    assert.deepEqual(await docLit(page), ["Done"]);
    assert.deepEqual(await docRows(page), docExpected.done(A));
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
