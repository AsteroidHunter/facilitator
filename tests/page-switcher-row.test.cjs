// The row of page marks under a poll. A page added or deleted in another window
// arrives here as a row change, and a row change used to rebuild every mark in
// the pill: a mark the keyboard was holding was taken out and made again, so the
// keys fell on the floor and every node identity changed under whatever was
// watching them. These cases hold a mark, change the row from outside the
// browser, and check that the very same element is still there and still has the
// keys, that only a mark that has actually arrived plays the entrance, and that
// the marks say where they now stand.
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

const settle = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));

async function post(route) {
  const response = await fetch(origin + route, { method: "POST" });
  return { status: response.status, body: await response.json() };
}

async function pagesOf(owner) {
  return (await (await fetch(origin + "/state")).json()).pages[owner];
}

async function until(check, ms = 6000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await settle(60);
  }
  throw new Error("the page never got there; last answer " + JSON.stringify(last));
}

async function openBoard() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [];
  page.on("console", m => {
    if (m.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(m.text())) return;
    problems.push(m.text());
  });
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  await page.setViewport(DESK);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 8000 });
  await settle(500);
  return { page, problems, context };
}

async function addPage(page) {
  await page.click("#pagepill .pageadd");
  await until(async () => (await page.evaluate(() => pageBusy)) === false);
  await settle(400);
}

// every mark that ever carries the entrance class, whether it was inserted
// already wearing it or had it put on afterwards
const watchEntrance = page => page.evaluate(() => {
  window.__grew = [];
  const note = n => {
    if (n && n.classList && n.classList.contains("fresh") && !window.__grew.includes(n.dataset.page))
      window.__grew.push(n.dataset.page);
  };
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes || []) note(n);
      if (m.type === "attributes") note(m.target);
    }
  }).observe(document.getElementById("pagepill"),
    { attributes: true, attributeFilter: ["class"], subtree: true, childList: true });
});

// mark the element the keys are on, so the same element can be recognised later
const tagFocused = page => page.evaluate(() => {
  const el = document.activeElement;
  el.dataset.probe = "held";
  return { page: el.dataset.page, tag: el.tagName, cls: el.className };
});

const focusedNow = page => page.evaluate(() => {
  const el = document.activeElement;
  return { probe: el.dataset ? el.dataset.probe || null : null,
           page: el.dataset ? el.dataset.page || null : null,
           cls: el.className || null,
           stillInPill: !!el.closest && !!el.closest("#pagepill") };
});

const rowNow = page => page.evaluate(() => [...document.querySelectorAll("#pagepill .pdot")]
  .map(d => ({ page: d.dataset.page, label: d.getAttribute("aria-label"),
               probe: d.dataset.probe || null })));

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(r => child.once("exit", r));
}

// the board back at its first migration. The board page a project is given
// there is the one page no route can make again, so a case that removes it is
// put right by starting the fixture over rather than by faking one
async function resetBoard() {
  await stopServer();
  await rm(path.join(fixtureDir, "state.json"), { force: true });
  await rm(path.join(fixtureDir, "transcript.jsonl"), { force: true });
  await startServer();
}

async function startServer() {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", c => { output += c; });
  child.stderr.on("data", c => { output += c; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await settle(40);
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-row-"));
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "page.html", "m.html", "m-manifest.json", "m-sw.js",
                      "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css",
                      "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [
      { id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" },
      { id: "t0", bucket: "meta", title: "Standing note for the project lane", owner: "pastureland" },
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

beforeEach(async () => {
  const pages = (await (await fetch(origin + "/state")).json()).pages;
  if (Object.values(pages).some(list => !list.some(p => p.id === "pg1"))) {
    await resetBoard();
    return;
  }
  for (const [owner, list] of Object.entries(pages)) {
    for (const p of list) if (p.id !== "pg1") await post(`/pages/del?owner=${owner}&id=${p.id}`);
  }
});

test("a page added in another window leaves a held mark held, and only the new one grows", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await addPage(page);
    await addPage(page);
    const before = await rowNow(page);
    assert.equal(before.length, 3);

    // the keys go on the middle mark and stay there for the rest of this
    await page.focus(`#pagepill .pdot[data-page="${before[1].page}"]`);
    const held = await tagFocused(page);
    assert.equal(held.page, before[1].page);
    await watchEntrance(page);

    // another window adds a page; this one only ever sees it on a poll
    const made = await post("/pages/new?owner=facilitator");
    assert.equal(made.status, 200);
    await until(async () => (await rowNow(page)).length === 4);
    await settle(500);

    const after = await focusedNow(page);
    assert.equal(after.probe, "held",
      "the poll took the keys off the mark that had them: " + JSON.stringify(after));
    assert.equal(after.page, held.page, "the keys landed on a different page's mark");
    assert.equal(after.stillInPill, true);

    const row = await rowNow(page);
    assert.deepEqual(row.map(r => r.page), [...before.map(b => b.page), made.body.id],
      "the row is not what the board says it is");
    assert.equal(row.filter(r => r.probe === "held").length, 1,
      "the held mark was duplicated or lost");

    const grew = await page.evaluate(() => window.__grew);
    assert.deepEqual(grew, [made.body.id],
      "the entrance played on marks that did not arrive: " + JSON.stringify(grew));
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a page deleted in another window leaves a held mark held, and nothing grows", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await addPage(page);
    await addPage(page);
    const before = await rowNow(page);
    assert.equal(before.length, 3);

    // hold the last mark, then have another window remove the middle one
    await page.focus(`#pagepill .pdot[data-page="${before[2].page}"]`);
    const held = await tagFocused(page);
    await watchEntrance(page);

    const gone = before[1].page;
    assert.equal((await post(`/pages/del?owner=facilitator&id=${gone}`)).status, 200);
    await until(async () => (await rowNow(page)).length === 2);
    await settle(500);

    const after = await focusedNow(page);
    assert.equal(after.probe, "held",
      "the poll took the keys off a mark whose page never went: " + JSON.stringify(after));
    assert.equal(after.page, held.page);

    const row = await rowNow(page);
    assert.deepEqual(row.map(r => r.page), [before[0].page, before[2].page]);
    assert.ok(!row.some(r => r.page === gone), "the deleted page still has a mark");

    const grew = await page.evaluate(() => window.__grew);
    assert.deepEqual(grew, [], "something played the entrance on a deletion: " + JSON.stringify(grew));
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("a mark says where it now stands after a page before it goes", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await addPage(page);
    await addPage(page);
    const before = await rowNow(page);
    assert.deepEqual(before.map(r => r.label),
      ["Board page 1 of 3", "Blank page 2 of 3", "Blank page 3 of 3"]);

    assert.equal((await post(`/pages/del?owner=facilitator&id=${before[0].page}`)).status, 200);
    await until(async () => (await rowNow(page)).length === 2);
    await settle(400);
    const after = await rowNow(page);
    assert.deepEqual(after.map(r => r.label), ["Blank page 1 of 2", "Blank page 2 of 2"],
      "the marks still say the places they used to stand in");
    assert.deepEqual(after.map(r => r.page), before.slice(1).map(r => r.page),
      "relabelling moved the pages around");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the mark the keys are on survives a whole run of outside changes", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await addPage(page);
    const anchor = (await rowNow(page))[1].page;
    await page.focus(`#pagepill .pdot[data-page="${anchor}"]`);
    await tagFocused(page);

    // adds and deletes from outside, one after another, with the keys never
    // leaving the same element
    const made = [];
    for (let i = 0; i < 3; i++) {
      const r = await post("/pages/new?owner=facilitator");
      assert.equal(r.status, 200);
      made.push(r.body.id);
      await until(async () => (await rowNow(page)).some(x => x.page === r.body.id));
      await settle(250);
      const now = await focusedNow(page);
      assert.equal(now.probe, "held", `the keys were lost on add ${i}: ` + JSON.stringify(now));
    }
    for (const id of made) {
      assert.equal((await post(`/pages/del?owner=facilitator&id=${id}`)).status, 200);
      await until(async () => !(await rowNow(page)).some(x => x.page === id));
      await settle(250);
      const now = await focusedNow(page);
      assert.equal(now.probe, "held", `the keys were lost deleting ${id}: ` + JSON.stringify(now));
    }
    const row = await rowNow(page);
    assert.equal(row.length, 2);
    assert.equal((await focusedNow(page)).page, anchor);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("the plus keeps the keys through an outside row change as well", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await page.focus("#pagepill .pageadd");
    const held = await page.evaluate(() => {
      document.activeElement.dataset.probe = "plus";
      return document.activeElement.className;
    });
    assert.equal(held, "pageadd");
    const made = await post("/pages/new?owner=facilitator");
    await until(async () => (await rowNow(page)).length === 2);
    await settle(400);
    const now = await focusedNow(page);
    assert.equal(now.probe, "plus", "an outside add took the keys off the plus");
    assert.equal(now.cls, "pageadd");
    assert.equal((await post(`/pages/del?owner=facilitator&id=${made.body.id}`)).status, 200);
    await until(async () => (await rowNow(page)).length === 1);
    await settle(400);
    assert.equal((await focusedNow(page)).probe, "plus",
      "an outside delete took the keys off the plus");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});
