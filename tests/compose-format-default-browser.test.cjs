// Where "Format text while typing" starts on a browser that has stored no choice.
//
// A board says so with compose_format_default in run.config.json: only true turns
// it on, and a config without the key, or with any other value, starts it off. A
// choice a browser has stored as `composeformat` beats the board either way. Each
// case is read on the Mac board, the phone app and the typed page, from a browser
// profile of its own, against a copy of the server on a spare port.
//
// This launches its own headless Chrome. The fixture boards run on free ports and
// never on 8877 or 8878.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv", "bin", "python3");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAC = { width: 1512, height: 982, deviceScaleFactor: 2 };
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const ROW = "article.box.sel textarea";
const TYPED = "a *word*, **two words** and ~~a cut~~ done";
const COPIED = ["index.html", "page.html", "m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json",
                "cm-markdown.js", "compose-format.js", "card-markdown.js", "card-logic.js", "card-report.js",
                "card-tokens.css"];

let baseDir, serverSource, browser, seq = 0;
const running = [];
const boards = {};

async function startServer(config) {
  const dir = path.join(baseDir, "srv-" + (++seq));
  await mkdir(dir, { recursive: true });
  const port = await freePortPair();
  await writeFile(path.join(dir, "server.py"), serverSource);
  copyBridgeFiles(dir);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(dir, name));
  await mkdir(path.join(dir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets")))
    await copyFile(path.join(ROOT, "assets", name), path.join(dir, "assets", name));
  if (config !== null) await writeFile(path.join(dir, "run.config.json"), JSON.stringify(config));
  await writeFile(path.join(dir, "seed.json"), JSON.stringify({
    title: "compose format default fixture",
    items: [{ id: "0", bucket: "meta", title: "Standing card", owner: "facilitator" }],
  }));

  const origin = "http://127.0.0.1:" + port;
  const child = spawn(PYTHON, [path.join(dir, "server.py")], {
    cwd: dir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: dir },
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
  const made = await fetch(origin + "/create?owner=facilitator", { method: "POST", body: "A card to type on" });
  const card = (await made.json()).id;
  await fetch(origin + `/reply?box=${card}`, { method: "POST", body: "A reply to answer." });
  return { origin, card };
}

// A page in a browser profile of its own, so no stored choice is left over from
// another case. `stored` is written once, before the page's own scripts run.
async function openPage(board, route, viewport, stored) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", error => page.errors.push(error.message));
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(value => {
    try {
      if (sessionStorage.getItem("default-check")) return;
      sessionStorage.setItem("default-check", "1");
      if (value !== null) localStorage.setItem("composeformat", value);
    } catch (error) {}
  }, stored);
  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (url.startsWith(board.origin + "/") || /^(data|blob):/.test(url)) req.continue();
    else req.abort();
  });
  await page.goto(board.origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 20000 });
  return { page, context };
}

async function readSetting(page) {
  return page.evaluate(() => ({
    stored: localStorage.getItem("composeformat"),
    enabled: ComposeFormat.enabled(),
    checkbox: document.getElementById("setformat").checked,
    editors: document.querySelectorAll(".cffield").length,
  }));
}

async function pickCard(page, board) {
  await page.waitForSelector(`#box-${board.card}`, { timeout: 15000 });
  await page.evaluate(id => { if (typeof select === "function") select(id); }, board.card);
  await page.waitForSelector(`#box-${board.card}.sel`, { timeout: 10000 });
}

// The three pages, each read the way a reader meets it. `want` is whether the
// typing box is the formatting editor.
async function checkAllPages(board, stored, want, label) {
  for (const [name, route, viewport] of [
    ["the Mac board", "/", MAC],
    ["the phone app", `/m?box=${board.card}`, PHONE],
    ["the typed page", "/page", MAC],
  ]) {
    const { page, context } = await openPage(board, route, viewport, stored);
    try {
      if (name !== "the typed page") {
        await pickCard(page, board);
        if (want) await page.waitForSelector("article.box.sel .cffield", { timeout: 30000 });
        await page.evaluate(() => ComposeFormat.settled());
      } else {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      const got = await readSetting(page);
      assert.equal(got.enabled, want, `${label}: ${name} reports formatting ${got.enabled}`);
      assert.equal(got.checkbox, want, `${label}: ${name} shows the setting ${got.checkbox}`);
      if (name !== "the typed page") {
        assert.equal(got.editors > 0, want,
          `${label}: ${name} ${want ? "has no" : "has a"} formatting editor in its typing box`);
      }
      assert.equal(got.stored, stored, `${label}: ${name} wrote its own choice without being asked`);
      assert.deepEqual(page.errors, [], `${label}: ${name} raised an error`);
    } finally {
      await context.close();
    }
  }
}

// what the row holds and what is drawn on it after a markdown line is typed
async function typeOnBoard(board, want) {
  const { page, context } = await openPage(board, "/", MAC, null);
  try {
    await pickCard(page, board);
    if (want) await page.waitForSelector("article.box.sel .cffield", { timeout: 30000 });
    await page.evaluate(() => ComposeFormat.settled());
    await page.focus(ROW);
    await page.keyboard.type(TYPED);
    await new Promise(resolve => setTimeout(resolve, 400));
    return await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      const content = document.querySelector("article.box.sel .cm-content");
      return {
        payload: row.value,
        shown: content ? content.innerText : row.value,
        italic: content ? content.querySelectorAll(".cf-em").length : 0,
        bold: content ? content.querySelectorAll(".cf-strong").length : 0,
        struck: content ? content.querySelectorAll(".cf-strike").length : 0,
      };
    });
  } finally {
    await context.close();
  }
}

async function servedFlag(board) {
  const response = await fetch(board.origin + "/compose-format.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  return response.text();
}

before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "facilitator-format-default-"));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  serverSource = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(serverSource, source, "fixture server port was not patched");

  // the example config as it ships, with the lanes' folders moved somewhere that
  // exists so the copy starts the same on any machine
  const example = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  const lanes = example.lanes.map((lane, n) => ({ ...lane, dir: path.join(baseDir, "lane-" + n) }));
  const shipped = { ...example, lanes };
  const noKey = { ...shipped };
  delete noKey.compose_format_default;
  boards.shipped = await startServer(shipped);
  boards.noKey = await startServer(noKey);
  boards.on = await startServer({ ...shipped, compose_format_default: true });
  boards.noFile = await startServer(null);

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

test("the example config ships the key off", async () => {
  const example = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  assert.equal(example.compose_format_default, false);
});

test("a fresh install with the example config types plain on all three pages", async () => {
  await checkAllPages(boards.shipped, null, false, "example config, empty profile");
});

test("a config with no key types plain on all three pages", async () => {
  await checkAllPages(boards.noKey, null, false, "no key, empty profile");
});

test("a board with no config file types plain on all three pages", async () => {
  await checkAllPages(boards.noFile, null, false, "no config file, empty profile");
});

test("the key set true formats on all three pages", async () => {
  await checkAllPages(boards.on, null, true, "key on, empty profile");
});

test("a stored yes beats the key being off", async () => {
  await checkAllPages(boards.shipped, "1", true, "key off, stored on");
});

test("a stored no beats the key being on", async () => {
  await checkAllPages(boards.on, "0", false, "key on, stored off");
});

test("a markdown line typed with the default off stays raw in the box", async () => {
  const got = await typeOnBoard(boards.shipped, false);
  assert.equal(got.payload, TYPED);
  assert.equal(got.shown, TYPED, "the box drew the line another way: " + got.shown);
  assert.deepEqual([got.italic, got.bold, got.struck], [0, 0, 0], "the box styled markers it should leave alone");
});

test("the same line typed with the key on is drawn styled and still sends the markdown", async () => {
  const got = await typeOnBoard(boards.on, true);
  assert.equal(got.payload, TYPED);
  assert.equal(got.shown, "a word, two words and a cut done", "the markers were left standing: " + got.shown);
  assert.deepEqual([got.italic, got.bold, got.struck], [1, 1, 1]);
});

test("the served file carries the board's answer in front and is otherwise the file", async () => {
  const original = await readFile(path.join(ROOT, "compose-format.js"), "utf8");
  for (const [name, expected] of [["shipped", "false"], ["noKey", "false"], ["noFile", "false"], ["on", "true"]]) {
    const served = await servedFlag(boards[name]);
    const lead = `globalThis.COMPOSE_FORMAT_DEFAULT=${expected};`;
    assert.ok(served.startsWith(lead), `${name}: the served file opens with ${served.slice(0, 50)}`);
    assert.equal(served.slice(lead.length), original, `${name}: the file behind the answer was changed`);
  }
});

test("a value other than true leaves it off", async () => {
  for (const value of ["true", 1, "yes", null, [true]]) {
    const board = await startServer({ compose_format_default: value });
    const served = await servedFlag(board);
    assert.ok(served.startsWith("globalThis.COMPOSE_FORMAT_DEFAULT=false;"),
      `${JSON.stringify(value)} turned formatting on: ${served.slice(0, 50)}`);
  }
});
