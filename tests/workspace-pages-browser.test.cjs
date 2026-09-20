// The switcher at the foot of the desktop workspace, driven headless against a
// real fixture board: the plus on its left and one dot for the board page, a
// press that makes a blank page and opens it, a dot that goes back to the board
// with the card exactly as it was left, the right-click menu, the question a
// deletion has to answer, and what the keyboard can and cannot do while a blank
// page or that question is on screen.
const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// tall enough to hold the whole 1440x900 stage, which is what the app is drawn
// for; the narrow case gets its own test below
const DESK = { width: 1440, height: 1000 };

let browser;
let child;
let fixtureDir;
let origin;
let port;

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

async function pagesOf(owner) {
  return (await state()).pages[owner];
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

// its own browsing context each time, so what one test leaves in storage is
// never what the next one starts from
async function openBoard(storage, { revealPill = true } = {}) {
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
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 8000 });
  if (revealPill) {
    // The desktop pill is hidden by default; reveal it only to exercise the
    // retained page creation, navigation and deletion controls in this fixture.
    await page.addStyleTag({ content: "body.focus #pagepill:not(.off){display:flex}" });
    await page.evaluate(() => seatPagePill());
  }
  await settle(500);
  return { page, problems, context };
}

// what the pill is showing right now
function pillShape(page) {
  return page.evaluate(() => {
    const pill = document.getElementById("pagepill");
    const box = pill.getBoundingClientRect();
    return {
      off: pill.classList.contains("off"),
      first: pill.firstElementChild ? pill.firstElementChild.className : null,
      firstLeft: pill.firstElementChild
        ? Math.round(pill.firstElementChild.getBoundingClientRect().left) : null,
      dots: [...pill.querySelectorAll(".pdot")].map(d => ({
        id: d.dataset.page,
        on: d.classList.contains("on"),
        left: Math.round(d.getBoundingClientRect().left),
        current: d.getAttribute("aria-current"),
      })),
      centre: Math.round(box.left + box.width / 2),
      window: innerWidth,
      blank: document.body.classList.contains("pageblank"),
      stage: getComputedStyle(document.getElementById("stage")).visibility,
    };
  });
}

async function clickPlus(page) {
  await page.click("#pagepill .pageadd");
  await settle(500);
}

async function clickDot(page, index) {
  const dots = await page.$$("#pagepill .pdot");
  await dots[index].click();
  await settle(350);
}

// the right-click that opens a dot's menu
async function openMenu(page, index) {
  const spot = await page.$$eval("#pagepill .pdot", (dots, i) => {
    const r = dots[i].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, index);
  await page.mouse.click(spot.x, spot.y, { button: "right" });
  await settle(200);
  return spot;
}

async function startServer() {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) return;
    } catch {}
    await settle(40);
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
}

// the board back at its first migration. The board page a project is given on
// that migration is the one page no route can make, so a test that removes it
// is put right by starting the fixture over rather than by faking one
async function resetBoard() {
  await stopServer();
  await rm(path.join(fixtureDir, "state.json"), { force: true });
  await rm(path.join(fixtureDir, "transcript.jsonl"), { force: true });
  await startServer();
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-pages-ui-"));
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "page.html", "m.html", "m-manifest.json", "m-sw.js", "manifest.json", "sw.js",
                      "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css",
                      "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [
      { id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" },
      { id: "m40", bucket: "meta", title: "Sanding the oar handle", owner: "facilitator" },
      { id: "t0", bucket: "meta", title: "Standing note for the project lane", owner: "pastureland" },
      { id: "n1", bucket: "now", title: "Rope ladder, second rung", owner: "pastureland" },
    ],
  }));
  await startServer();
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"],
  });
});

after(async () => {
  if (browser) await browser.close();
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// every test starts from the board each project was migrated onto
beforeEach(async () => {
  const pages = (await state()).pages;
  if (Object.values(pages).some(list => !list.some(p => p.id === "pg1"))) {
    await resetBoard();
    return;
  }
  for (const [owner, list] of Object.entries(pages)) {
    for (const page of list) {
      if (page.id !== "pg1") await post(`/pages/del?owner=${owner}&id=${page.id}`);
    }
  }
});

test("the desktop hides the mounted page switcher without reserving card room", async () => {
  const { page, problems, context } = await openBoard(undefined, { revealPill: false });
  try {
    const state = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById("pagepill")).display,
      add: !!document.querySelector("#pagepill .pageadd"),
      dots: document.querySelectorAll("#pagepill .pdot").length,
      maxHeight: document.querySelector("main").style.maxHeight,
    }));
    assert.deepEqual(state, { display: "none", add: true, dots: 1, maxHeight: "" });
    await page.setViewport({ width: 1280, height: 800 });
    await settle(300);
    const short = await page.evaluate(() => ({
      display: getComputedStyle(document.getElementById("pagepill")).display,
      maxHeight: document.querySelector("main").style.maxHeight,
    }));
    assert.deepEqual(short, { display: "none", maxHeight: "" });
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the retained page controls open on one page, with the plus on the pill's left", async () => {
  const { page, problems, context } = await openBoard();
  try {
    const shape = await pillShape(page);
    assert.equal(shape.off, false, "the pill is not on the board");
    assert.equal(shape.first, "pageadd", "the leftmost thing in the pill is not the plus");
    assert.equal(shape.dots.length, 1, "a fresh project shows more than its board page");
    assert.equal(shape.dots[0].on, true, "the one page is not marked as the one being looked at");
    assert.equal(shape.dots[0].current, "page");
    assert.ok(shape.firstLeft < shape.dots[0].left, "the plus is not to the left of the dot");
    assert.ok(Math.abs(shape.centre - shape.window / 2) <= 2, "the pill is not centred");
    assert.equal(shape.blank, false);
    assert.equal(shape.stage, "visible", "the board is not showing on the board page");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the plus makes a blank page in the same project and opens it at once", async () => {
  const { page, problems, context } = await openBoard();
  try {
    const cardBefore = await page.$eval(".box.sel .title", el => el.textContent);
    await clickPlus(page);
    const shape = await pillShape(page);
    assert.equal(shape.dots.length, 2, "the new page did not join the row");
    assert.equal(shape.dots[0].on, false);
    assert.equal(shape.dots[1].on, true, "the new page is not the one being looked at");
    assert.equal(shape.blank, true);
    assert.equal(shape.stage, "hidden", "the board is still showing on a blank page");

    // truly blank: nothing of the board is drawn or reachable, and the card is
    // still there underneath, untouched
    const gone = await page.evaluate(() => {
      const names = ["stage", "tickets", "magic1", "magic2", "magic3", "clockbox", "rail"];
      const shown = names.filter(id => {
        const el = document.getElementById(id);
        return el && getComputedStyle(el).visibility !== "hidden";
      });
      const card = document.querySelector(".box.sel");
      return { shown, card: card ? getComputedStyle(card).visibility : null };
    });
    assert.deepEqual(gone.shown, [], "part of the board is still drawn on a blank page");
    assert.equal(gone.card, "hidden");

    // the project itself did not move: the same lane, the same cards
    const st = await state();
    assert.equal((await page.evaluate(() => activeOwner)), "facilitator");
    assert.equal(st.pages.facilitator.length, 2);
    assert.equal(st.pages.facilitator[1].kind, "blank");
    assert.ok(st.boxes.some(b => b.title === cardBefore), "a card went with the new page");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

// the row of dots is rebuilt whenever a page joins or leaves it. The plus is
// not part of that row and must not be rebuilt with it: a plus replaced on
// every press is a plus the second press misses and the keyboard falls off
test("the plus is one button all along: pressed twice, and worked without a mouse", async () => {
  const { page, problems, context } = await openBoard();
  const idle = () => until(async () => (await page.evaluate(() => pageBusy)) === false);
  try {
    const plus = await page.$("#pagepill .pageadd");
    await plus.click();
    await until(async () => (await pagesOf("facilitator")).length === 2);
    await idle();
    // the same handle as before the row was rebuilt under it
    await plus.click();
    await until(async () => (await pagesOf("facilitator")).length === 3);
    await idle();
    await settle(300);
    assert.equal((await pillShape(page)).dots.length, 3, "the second press made no page");

    await page.focus("#pagepill .pageadd");
    await page.keyboard.press("Enter");
    await until(async () => (await pagesOf("facilitator")).length === 4);
    await idle();
    await settle(300);
    assert.equal(await page.evaluate(() => document.activeElement.className), "pageadd",
      "the plus lost the keys when the row was rebuilt under it");
    assert.equal((await pillShape(page)).dots.length, 4);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the dot goes back to the board, with the card and the list as they were", async () => {
  const { page, problems, context } = await openBoard();
  try {
    const before = await page.evaluate(() => ({
      card: document.querySelector(".box.sel .title").textContent,
      selected: selectedId,
      rows: [...document.querySelectorAll("#tiklist .trow")].length,
      // the chosen view is one per project now, read through curView() rather
      // than off a global; this asks the same question of the open project
      view: curView(),
    }));
    await clickPlus(page);
    assert.equal((await pillShape(page)).blank, true);
    await clickDot(page, 0);
    const after = await page.evaluate(() => ({
      card: document.querySelector(".box.sel .title").textContent,
      selected: selectedId,
      rows: [...document.querySelectorAll("#tiklist .trow")].length,
      view: curView(),
      stage: getComputedStyle(document.getElementById("stage")).visibility,
    }));
    assert.equal(after.stage, "visible", "the board did not come back");
    assert.deepEqual({ card: after.card, selected: after.selected, rows: after.rows, view: after.view },
      before, "the board came back different from how it was left");
    assert.equal((await pillShape(page)).dots[0].on, true);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("each project keeps its own pages and its own place in them", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await clickPlus(page);
    assert.equal((await pillShape(page)).dots.length, 3);

    // the other project is untouched: one page, and its board on screen
    await page.evaluate(() => setTab("pastureland"));
    await settle(400);
    const other = await pillShape(page);
    assert.equal(other.dots.length, 1, "the other project inherited these pages");
    assert.equal(other.blank, false, "the other project was dragged onto a blank page");

    // and coming back lands on the page this project was left on
    await page.evaluate(() => setTab("facilitator"));
    await settle(400);
    const back = await pillShape(page);
    assert.equal(back.dots.length, 3);
    assert.equal(back.dots[2].on, true, "the project did not come back to the page it was on");
    assert.equal(back.blank, true);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the page a project is on, and its row of pages, survive a reload", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await clickPlus(page);
    const chosen = (await pillShape(page)).dots[1].id;
    await clickDot(page, 1);
    assert.equal((await pillShape(page)).dots[1].on, true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
      { timeout: 8000 });
    await settle(500);
    const after = await pillShape(page);
    assert.equal(after.dots.length, 3, "the row of pages did not survive the reload");
    assert.equal(after.dots[1].id, chosen);
    assert.equal(after.dots[1].on, true, "the reload landed on another page");
    assert.equal(after.blank, true);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a right-click on a dot opens one menu, and a press elsewhere or Escape shuts it", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await openMenu(page, 0);
    const menu = await page.evaluate(() => {
      const el = document.getElementById("pagemenu");
      const items = [...el.querySelectorAll("button")].map(b => b.textContent);
      return { on: el.classList.contains("on"), items,
               focused: document.activeElement.className,
               inside: el.getBoundingClientRect().right <= innerWidth &&
                       el.getBoundingClientRect().bottom <= innerHeight };
    });
    assert.equal(menu.on, true, "the right-click opened no menu");
    assert.deepEqual(menu.items, ["Delete page"]);
    assert.equal(menu.focused, "pagemenuitem", "the menu did not take the keys");
    assert.equal(menu.inside, true, "the menu opened off the window");

    await page.keyboard.press("Escape");
    await settle(150);
    assert.equal(await page.evaluate(() => document.getElementById("pagemenu").classList.contains("on")),
      false, "Escape left the menu open");

    await openMenu(page, 1);
    await page.mouse.click(400, 300);
    await settle(150);
    assert.equal(await page.evaluate(() => document.getElementById("pagemenu").classList.contains("on")),
      false, "a press elsewhere left the menu open");
    // and the press that shut it changed nothing else
    assert.equal((await pillShape(page)).dots.length, 2);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the menu asks before anything goes, in those words, and cancel changes nothing", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    const before = await pillShape(page);
    await openMenu(page, 0);
    await page.click("#pagemenu .pagemenuitem");
    await settle(250);
    const asked = await page.evaluate(() => ({
      up: document.body.classList.contains("pagewarn"),
      question: document.getElementById("pagewarnq").textContent,
      kept: document.getElementById("pagewarnkept").textContent,
      buttons: [...document.querySelectorAll("#pagewarnrow button")].map(b => b.textContent),
      focused: document.activeElement.id,
      covers: (() => {
        const r = document.getElementById("pagewarn").getBoundingClientRect();
        return r.width === innerWidth && r.height === innerHeight;
      })(),
    }));
    assert.equal(asked.up, true, "no question was asked");
    assert.equal(asked.question, "Are you sure you want to delete the page?");
    assert.match(asked.kept, /conversation/i, "the question does not say the conversations are kept");
    assert.deepEqual(asked.buttons, ["Cancel", "Delete page"]);
    assert.equal(asked.focused, "pagewarnno", "the question did not open on Cancel");
    assert.equal(asked.covers, true, "the question does not cover the workspace");

    await page.click("#pagewarnno");
    await settle(250);
    assert.equal(await page.evaluate(() => document.body.classList.contains("pagewarn")), false);
    assert.deepEqual(await pillShape(page), before, "cancel changed something");
    assert.equal((await pagesOf("facilitator")).length, 2, "cancel removed a page anyway");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("Escape is cancel too, and Tab cannot leave the two buttons", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await openMenu(page, 0);
    await page.click("#pagemenu .pagemenuitem");
    await settle(250);
    const walked = [];
    for (let step = 0; step < 3; step++) {
      await page.keyboard.press("Tab");
      walked.push(await page.evaluate(() => document.activeElement.id));
    }
    assert.deepEqual(walked, ["pagewarnyes", "pagewarnno", "pagewarnyes"],
      "Tab wandered out of the question");
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
    assert.equal(await page.evaluate(() => document.activeElement.id), "pagewarnno");

    await page.keyboard.press("Escape");
    await settle(250);
    assert.equal(await page.evaluate(() => document.body.classList.contains("pagewarn")), false,
      "Escape left the question up");
    assert.equal((await pagesOf("facilitator")).length, 2, "Escape removed a page");
    // the keys go back where they came from: the dot that opened the menu
    const back = await page.evaluate(() => ({
      dot: document.activeElement.classList.contains("pdot"),
      id: document.activeElement.dataset.page,
    }));
    assert.equal(back.dot, true, "the keys did not go back to the pill");
    assert.equal(back.id, (await pillShape(page)).dots[0].id);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("confirming removes that page only: an inactive one leaves the view where it was", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await clickPlus(page);
    const before = await pillShape(page);
    const doomed = before.dots[1].id;
    const standing = before.dots[2].id;
    assert.equal(before.dots[2].on, true);

    await openMenu(page, 1);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 2);
    await settle(400);
    const after = await pillShape(page);
    assert.deepEqual(after.dots.map(d => d.id), [before.dots[0].id, standing]);
    assert.ok(!after.dots.some(d => d.id === doomed), "the page is still in the row");
    assert.equal(after.dots[1].on, true, "removing another page moved the view");
    assert.equal(after.blank, true);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("removing the page being looked at lands on the one beside it", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    await clickPlus(page);
    await clickDot(page, 1);            // the middle one
    const before = await pillShape(page);
    assert.equal(before.dots[1].on, true);
    const after1 = before.dots[2].id;

    await openMenu(page, 1);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 2);
    await settle(400);
    let shape = await pillShape(page);
    assert.equal(shape.dots.length, 2);
    assert.equal(shape.dots[1].id, after1);
    assert.equal(shape.dots[1].on, true, "the page after it did not take over");

    // and when the one being looked at is last in the row, the one before it does
    await openMenu(page, 1);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 1);
    await settle(400);
    shape = await pillShape(page);
    assert.equal(shape.dots.length, 1);
    assert.equal(shape.dots[0].on, true, "the page before it did not take over");
    assert.equal(shape.blank, false, "the board did not come back");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the original board page may go, and the last page leaves an empty canvas", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await clickPlus(page);
    // the board page is the first dot, and it is as removable as any other
    await openMenu(page, 0);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 1);
    await settle(400);
    let shape = await pillShape(page);
    assert.equal(shape.dots.length, 1);
    assert.equal(shape.blank, true, "the board came back without a board page");

    // the last page goes as well, and the plus is still there to start again
    await openMenu(page, 0);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 0);
    await settle(400);
    shape = await pillShape(page);
    assert.equal(shape.dots.length, 0, "a dot outlived its page");
    assert.equal(shape.first, "pageadd", "the plus went with the last page");
    assert.equal(shape.off, false, "the pill went with the last page");
    assert.equal(shape.blank, true);

    // an empty project is not handed a page back by the next reading
    await settle(1600);
    assert.deepEqual(await pagesOf("facilitator"), []);
    assert.equal((await pillShape(page)).dots.length, 0);

    // and the plus starts the project off again
    await clickPlus(page);
    assert.equal((await pillShape(page)).dots.length, 1);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a deletion takes no card, no message and no workspace with it", async () => {
  await post("/send?box=m40", "the handle wants another pass");
  const { page, problems, context } = await openBoard();
  try {
    const before = await state();
    await clickPlus(page);
    await openMenu(page, 1);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.click("#pagewarnyes");
    await until(async () => (await pagesOf("facilitator")).length === 1);
    const after = await state();
    assert.deepEqual(after.boxes.map(b => b.id), before.boxes.map(b => b.id),
      "a card went with the page");
    assert.deepEqual(after.boxes.find(b => b.id === "m40").pendingTexts,
      before.boxes.find(b => b.id === "m40").pendingTexts, "a message went with the page");
    assert.deepEqual(after.workspaces, before.workspaces, "a workspace went with the page");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the board's own keys are dead on a blank page and while the question is up", async () => {
  const { page, problems, context } = await openBoard();
  try {
    const before = await state();
    await clickPlus(page);
    const selected = await page.evaluate(() => selectedId);

    // a new card, a closed card and a walked selection are all the board's, and
    // the board is not on this page
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ArrowRight");
    await settle(600);
    let now = await state();
    assert.deepEqual(now.boxes.map(b => b.id), before.boxes.map(b => b.id),
      "a board key changed the cards from a blank page");
    assert.equal(await page.evaluate(() => selectedId), selected,
      "a board key walked the selection from a blank page");

    // the same with the question on screen, over the board page this time
    await clickDot(page, 0);
    assert.equal((await pillShape(page)).blank, false);
    await openMenu(page, 1);
    await page.click("#pagemenu .pagemenuitem");
    await settle(200);
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await settle(600);
    now = await state();
    assert.deepEqual(now.boxes.map(b => b.id), before.boxes.map(b => b.id),
      "a board key made a card from under the question");
    await page.click("#pagewarnno");
    await settle(200);

    // and the board's keys work again the moment the board is back
    await page.keyboard.down("Meta");
    await page.keyboard.press("t");
    await page.keyboard.up("Meta");
    await until(async () => (await state()).boxes.length === before.boxes.length + 1);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the pill keeps its seat, clear of the rail, at a normal and a narrow window", async () => {
  const { page, problems, context } = await openBoard();
  try {
    for (const size of [{ width: 1440, height: 1000 }, { width: 1180, height: 900 },
                        { width: 1024, height: 820 }]) {
      await page.setViewport(size);
      await settle(400);
      const seat = await page.evaluate(() => {
        const pill = document.getElementById("pagepill").getBoundingClientRect();
        const rail = document.getElementById("rail").getBoundingClientRect();
        const card = document.querySelector("main").getBoundingClientRect();
        const overlaps = other => pill.right > other.left && pill.left < other.right &&
                                  pill.bottom > other.top && pill.top < other.bottom;
        return {
          onScreen: pill.top >= 0 && pill.bottom <= innerHeight &&
                    pill.left >= 0 && pill.right <= innerWidth,
          centred: Math.abs((pill.left + pill.width / 2) - innerWidth / 2) <= 2,
          onRail: overlaps(rail), onCard: overlaps(card),
        };
      });
      assert.equal(seat.onScreen, true, `the pill left the window at ${size.width}x${size.height}`);
      assert.equal(seat.centred, true, `the pill is off centre at ${size.width}x${size.height}`);
      assert.equal(seat.onRail, false, `the pill covers the rail at ${size.width}x${size.height}`);
      assert.equal(seat.onCard, false, `the pill covers the card at ${size.width}x${size.height}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(DESK);
    await context.close();
  }
});

// Every /state answer is stopped at the wire from before the plus is pressed
// until the test lets it through, so the window that made the page provably
// never reads the board between making it and another window removing it. That
// is the one ordering the hold on a just-made page has to survive, and holding
// the answers rather than racing them is what makes it the same every run.
async function holdReadings(page) {
  const held = [];
  let holding = false;
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (holding && new URL(request.url()).pathname === "/state") held.push(request);
    else request.continue().catch(() => {});
  });
  return {
    async start() {
      holding = true;
      // long enough for any reading already on its way, sent before the stop
      // went on, to have landed: after this nothing is in flight
      await settle(1500);
      held.length = 0;
    },
    held: () => held.length,
    async release() {
      holding = false;
      for (const request of held.splice(0)) await request.continue().catch(() => {});
    },
    async off() { await page.setRequestInterception(false).catch(() => {}); },
  };
}

test("a page deleted in another window before this one has read the board goes", async () => {
  const { page, problems, context } = await openBoard();
  const wire = await holdReadings(page);
  try {
    await wire.start();
    await page.click("#pagepill .pageadd");
    await until(async () => (await pagesOf("facilitator")).length === 2);
    const made = (await pagesOf("facilitator"))[1].id;
    await until(async () => wire.held() > 0);

    // the window is drawing that page from its own hold, having read nothing
    let shape = await pillShape(page);
    assert.equal(shape.dots.length, 2, "the new page was not shown before the board was read");
    assert.equal(shape.dots[1].id, made);
    assert.equal(shape.dots[1].on, true);
    assert.equal(shape.blank, true);
    assert.notEqual(await page.evaluate(() => pageHold), null,
      "the new page was not being held, so this run proves nothing about the hold");

    // another window removes it while this one still holds it, and only then
    // is this one allowed to read the board at all
    assert.equal((await post(`/pages/del?owner=facilitator&id=${made}`)).status, 200);
    await wire.release();

    await until(async () => (await pillShape(page)).dots.length === 1);
    shape = await pillShape(page);
    assert.ok(!shape.dots.some(d => d.id === made), "the deleted page is still a dot");
    assert.equal(shape.dots[0].on, true, "the window did not land on a page that exists");
    assert.equal(shape.dots[0].id, "pg1");
    assert.equal(shape.blank, false, "the window stayed on a page that is gone");
    assert.equal(await page.evaluate(() => pageHold), null,
      "the hold outlived the reading that settled it");

    // and it stays gone: a later reading does not bring the dot back
    await settle(1500);
    assert.equal((await pillShape(page)).dots.length, 1);
    assert.deepEqual(problems, []);
  } finally {
    await wire.off();
    await context.close();
  }
});

test("the same race on a project's only page leaves an empty canvas, not a ghost", async () => {
  // the project is emptied first, so the page made below is the only one it has
  assert.equal((await post("/pages/del?owner=facilitator&id=pg1")).status, 200);
  const { page, problems, context } = await openBoard();
  const wire = await holdReadings(page);
  try {
    assert.equal((await pillShape(page)).dots.length, 0);
    await wire.start();
    await page.click("#pagepill .pageadd");
    await until(async () => (await pagesOf("facilitator")).length === 1);
    const made = (await pagesOf("facilitator"))[0].id;
    await until(async () => wire.held() > 0);
    assert.equal((await pillShape(page)).dots.length, 1, "the only page was not shown");

    assert.equal((await post(`/pages/del?owner=facilitator&id=${made}`)).status, 200);
    await wire.release();

    await until(async () => (await pillShape(page)).dots.length === 0);
    const shape = await pillShape(page);
    assert.equal(shape.dots.length, 0, "a dot outlived the page it stood for");
    assert.equal(shape.first, "pageadd", "the plus went with the page");
    assert.equal(shape.off, false, "the pill went with the page");
    assert.equal(shape.blank, true, "an empty project is not showing an empty canvas");
    assert.equal(await page.evaluate(() => pageHold), null);
    assert.deepEqual(problems, []);
  } finally {
    await wire.off();
    await context.close();
  }
});

test("a blank page in one window is not a blank page in another", async () => {
  const one = await openBoard();
  const two = await openBoard();
  try {
    await clickPlus(one.page);
    assert.equal((await pillShape(one.page)).blank, true);
    // the other window is told about the page, and stays on the board
    await until(async () => (await pillShape(two.page)).dots.length === 2);
    const other = await pillShape(two.page);
    assert.equal(other.blank, false, "one window's page choice moved another window");
    assert.equal(other.dots[0].on, true);
    assert.deepEqual(one.problems, []);
    assert.deepEqual(two.problems, []);
  } finally {
    await one.context.close();
    await two.context.close();
  }
});
