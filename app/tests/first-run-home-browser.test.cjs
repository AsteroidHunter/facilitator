// What a brand-new user sees when the board first opens, and what an install
// that already has projects keeps seeing.
//
// A fresh board runs on the example config and the example seed exactly as they
// ship: no lane and no card, so the tab bar is empty and the board opens on the
// home page, white, with the folder picker. Adding a folder there makes the one
// project tab. A board that already has projects (the old example content, which
// an existing install still holds) opens on its board with its tabs and keeps
// the cream paper, since its config has no background_default. Leaving home by
// the plus on an empty board is not undone by the next poll.
//
// This launches its own headless Chrome. The fixture boards run on free ports and
// never on 8877 or 8878; no window is opened.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WHITE = "rgb(255, 255, 255)";
const CREAM = "rgb(245, 244, 241)";
const COPIED = ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json",
                "cm-markdown.js", "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js",
                "card-tokens.css"];

let baseDir, serverSource, browser, seq = 0;
const running = [];
const boards = {};

async function startServer({ config, seed }) {
  const dir = path.join(baseDir, "srv-" + (++seq));
  const home = path.join(dir, "home");
  await mkdir(path.join(home, "chosen-folder"), { recursive: true });
  const port = await freePortPair();
  await writeFile(path.join(dir, "server.py"), serverSource);
  copyBridgeFiles(dir);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(dir, name));
  await mkdir(path.join(dir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(dir, "assets", name));
  await writeFile(path.join(dir, "run.config.json"), config);
  await writeFile(path.join(dir, "seed.json"), seed);

  const origin = "http://127.0.0.1:" + port;
  const child = spawn(PYTHON, [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, HOME: home, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited early:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) break; } catch (error) {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (child.exitCode !== null || Date.now() >= deadline) {
    child.kill("SIGKILL");
    throw new Error("server did not start:\n" + output);
  }
  return { origin, chosen: path.join(home, "chosen-folder") };
}

async function openBoard(board, viewport = { width: 1512, height: 982 }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", error => page.errors.push(error.message));
  await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url === board.origin + "/pickdir") {
      req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ path: board.chosen }) });
    } else if (url.startsWith(board.origin + "/") || /^(data|blob):/.test(url)) req.continue();
    else req.abort();
  });
  await page.goto(board.origin + "/", { waitUntil: "load" });
  await page.waitForFunction(
    () => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState,
    { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, 600));
  return { page, context };
}

function facts(page) {
  return page.evaluate(() => {
    const visible = el => !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden";
    return {
      home: document.body.classList.contains("home"),
      tabs: [...document.querySelectorAll("#tabbar .ptab:not(.draft)")].map(t => t.querySelector(".plabel").textContent),
      draft: !!document.querySelector("#tabbar .ptab.draft"),
      picker: visible(document.getElementById("npstart")),
      background: getComputedStyle(document.body).backgroundColor,
      homeKey: localStorage.getItem("homeopen"),
    };
  });
}

before(async () => {
  baseDir = await realpath(await mkdtemp(path.join(tmpdir(), "facilitator-first-run-home-")));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  serverSource = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(serverSource, source, "fixture server port was not patched");

  boards.fresh = await startServer({
    config: await readFile(path.join(ROOT, "run.config.example.json"), "utf8"),
    seed: await readFile(path.join(ROOT, "seed.example.json"), "utf8"),
  });
  boards.plus = await startServer({
    config: await readFile(path.join(ROOT, "run.config.example.json"), "utf8"),
    seed: await readFile(path.join(ROOT, "seed.example.json"), "utf8"),
  });
  // the example files as they shipped before: two lanes, a standing card and three project cards
  boards.existing = await startServer({
    config: JSON.stringify({
      port: 8877,
      navigator_lanes: ["example"],
      lanes: [
        { owner: "facilitator", tmux: "one", dir: baseDir, instruction: "attach", prompt: "start" },
        { owner: "example", tmux: "two", dir: baseDir, instruction: "attach", prompt: "start" },
      ],
    }),
    seed: JSON.stringify({
      title: "Example project board",
      items: [
        { id: "0", bucket: "meta", owner: "facilitator", title: "Board notes: drop meta thoughts here" },
        { id: "1.1", bucket: "must", owner: "example", title: "Fix the login timeout", context: "Sessions expire." },
        { id: "2.1", bucket: "could", owner: "example", title: "Dark mode", context: "Requested twice." },
        { id: "3.1", bucket: "later", owner: "example", title: "Export to PDF", context: "Nice to have." },
      ],
    }),
  });

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-first-run", "--disable-background-networking"],
  });
});

after(async () => {
  if (browser) await browser.close();
  for (const child of running) {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
  if (baseDir) await rm(baseDir, { recursive: true, force: true });
});

test("the example files name no lane and no card", async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  const seed = JSON.parse(await readFile(path.join(ROOT, "seed.example.json"), "utf8"));
  assert.deepEqual(config.lanes, []);
  assert.deepEqual(config.navigator_lanes, []);
  assert.equal(config.background_default, "#ffffff");
  assert.equal(config.app_fullscreen, true);
  assert.deepEqual(seed.items, []);
});

test("a fresh board holds no card and no project, and an ownerless wait still answers", async () => {
  const state = await (await fetch(boards.fresh.origin + "/state")).json();
  assert.deepEqual(state.boxes, []);
  assert.deepEqual(state.projects, []);
  const wait = await fetch(boards.fresh.origin + "/wait?timeout=1&agent=test");
  assert.equal(wait.status, 200);
  assert.deepEqual(await wait.json(), { idle: true });
});

test("a fresh board opens on the home page, white, with no tab", async () => {
  for (const viewport of [{ width: 1512, height: 982 }, { width: 1280, height: 800 }]) {
    const { page, context } = await openBoard(boards.fresh, viewport);
    try {
      const got = await facts(page);
      assert.equal(got.home, true, "the board did not open on the home page");
      assert.deepEqual(got.tabs, [], "a tab is showing: " + got.tabs.join(", "));
      assert.equal(got.draft, false);
      assert.equal(got.picker, true, "the folder picker is not showing");
      assert.equal(got.background, WHITE);
      assert.deepEqual(page.errors, []);
    } finally {
      await context.close();
    }
  }
});

test("a reload of a fresh board comes back to the home page", async () => {
  const { page, context } = await openBoard(boards.fresh);
  try {
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && lastState, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 400));
    const got = await facts(page);
    assert.equal(got.home, true);
    assert.deepEqual(got.tabs, []);
  } finally {
    await context.close();
  }
});

test("a folder added on the home page becomes the one project tab and leaves home", async () => {
  const { page, context } = await openBoard(boards.fresh);
  try {
    await page.click("#npstart");
    await page.waitForFunction(() => document.querySelectorAll("#tabbar .ptab").length === 1, { timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 800));
    const got = await facts(page);
    assert.equal(got.home, false, "home stayed up over the new project");
    assert.deepEqual(got.tabs, ["chosen-folder"]);
    assert.equal(got.homeKey, null);
    assert.deepEqual(page.errors, []);
  } finally {
    await context.close();
  }
});

test("the plus on an empty board starts a new project and home does not come back over it", async () => {
  const { page, context } = await openBoard(boards.plus);
  try {
    assert.equal((await facts(page)).home, true);
    await page.click(".ptabplus");
    await new Promise(resolve => setTimeout(resolve, 2500));
    const got = await facts(page);
    assert.equal(got.home, false, "home came back over the new project");
    assert.equal(got.draft, true, "the new project's tab is gone");
    assert.equal(got.picker, true);
  } finally {
    await context.close();
  }
});

test("a board that already has projects opens on its board, with its tabs and its own paper", async () => {
  const { page, context } = await openBoard(boards.existing);
  try {
    const got = await facts(page);
    assert.equal(got.home, false, "an existing board opened on the home page");
    assert.equal(got.tabs.length, 2, "tabs: " + got.tabs.join(", "));
    assert.match(got.tabs[0], /facilitator/i);
    assert.equal(got.background, CREAM, "a config without background_default changed colour");
    assert.equal(got.homeKey, null);
    assert.deepEqual(page.errors, []);
  } finally {
    await context.close();
  }
});
