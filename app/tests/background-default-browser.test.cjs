// The colour a board's pages start on when no background has been saved.
//
// A board says so with background_default in run.config.json: a #rrggbb string
// counts, and a config without the key, with any other value, or no config file
// at all leaves the pages on their own paper colour. A background saved with the
// board's settings beats the key either way. The Mac board and the typed page
// are each read from a browser profile of their own, against a copy of the
// server on a spare port.
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
const MAC = { width: 1512, height: 982 };
const WHITE = "rgb(255, 255, 255)";
const CREAM = "rgb(245, 244, 241)";
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
    title: "background default fixture",
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
  return { origin };
}

async function paperOn(board, route) {
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewport(MAC);
    await page.setRequestInterception(true);
    page.on("request", req => {
      const url = req.url();
      if (url.startsWith(board.origin + "/") || /^(data|blob):/.test(url)) req.continue();
      else req.abort();
    });
    await page.goto(board.origin + route, { waitUntil: "load" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 20000 });
    const got = await page.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      inline: document.body.style.getPropertyValue("--paper"),
      picker: document.getElementById("bgpick").value,
      stored: settingsStore.getItem("bgcolor"),
    }));
    assert.deepEqual(errors, [], route + " raised an error");
    return got;
  } finally {
    await context.close();
  }
}

async function served(board) {
  const response = await fetch(board.origin + "/board-settings.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  return response.text();
}

before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "facilitator-background-default-"));
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  serverSource = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(serverSource, source, "fixture server port was not patched");

  const example = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  const lanes = example.lanes.map((lane, n) => ({ ...lane, dir: path.join(baseDir, "lane-" + n) }));
  const shipped = { ...example, lanes };
  const noKey = { ...shipped };
  delete noKey.background_default;
  boards.shipped = await startServer(shipped);
  boards.noKey = await startServer(noKey);
  boards.noFile = await startServer(null);
  boards.upper = await startServer({ ...shipped, background_default: "#E8F0FF" });
  boards.saved = await startServer(shipped);
  const set = await fetch(boards.saved.origin + "/settings", { method: "POST", body: JSON.stringify({ bgcolor: "#102030" }) });
  assert.equal(set.status, 200);

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

test("the example config ships a white background", async () => {
  const example = JSON.parse(await readFile(path.join(ROOT, "run.config.example.json"), "utf8"));
  assert.equal(example.background_default, "#ffffff");
});

// the typed page draws its document view on a paper of its own, so on that page
// the colour is read from the page's setting rather than from the body
test("a fresh install with the example config opens white on the board and the typed page", async () => {
  for (const route of ["/", "/page"]) {
    const got = await paperOn(boards.shipped, route);
    if (route === "/") assert.equal(got.background, WHITE, `${route} is ${got.background}`);
    assert.equal(got.inline, "#ffffff");
    assert.equal(got.picker, "#ffffff");
    assert.equal(got.stored, null, `${route} saved a colour nobody picked`);
  }
});

test("a config with no key, or no config file, keeps the cream paper", async () => {
  for (const name of ["noKey", "noFile"]) {
    for (const route of ["/", "/page"]) {
      const got = await paperOn(boards[name], route);
      if (route === "/") assert.equal(got.background, CREAM, `${name} ${route} is ${got.background}`);
      assert.equal(got.inline, "", `${name} ${route} set a colour on the page`);
      assert.equal(got.stored, null);
    }
  }
});

test("a saved background beats the key", async () => {
  for (const route of ["/", "/page"]) {
    const got = await paperOn(boards.saved, route);
    if (route === "/") assert.equal(got.background, "rgb(16, 32, 48)", `${route} is ${got.background}`);
    assert.equal(got.inline, "#102030");
    assert.equal(got.picker, "#102030");
    assert.equal(got.stored, "#102030");
  }
});

test("a colour in capitals is served and shown in lower case", async () => {
  const lead = (await served(boards.upper)).split("\n")[0];
  assert.ok(lead.includes('globalThis.BOARD_BGCOLOR_DEFAULT="#e8f0ff";'), lead.slice(0, 200));
  const got = await paperOn(boards.upper, "/");
  assert.equal(got.background, "rgb(232, 240, 255)");
});

test("the served settings file carries the colour after the settings and is otherwise the file", async () => {
  const original = await readFile(path.join(ROOT, "board-settings.js"), "utf8");
  const text = await served(boards.shipped);
  const mark = 'globalThis.BOARD_BGCOLOR_DEFAULT="#ffffff";';
  const at = text.indexOf(mark);
  assert.ok(at > 0, "the colour is not in front of the file");
  assert.ok(text.startsWith("globalThis.BOARD_SETTINGS="), "the settings do not come first");
  assert.equal(text.slice(at + mark.length), original, "the file behind the colour was changed");
  const bare = await served(boards.noKey);
  assert.ok(!bare.includes("BOARD_BGCOLOR_DEFAULT"), "a board without the key still names a colour");
  assert.ok(bare.endsWith(original), "the file behind the settings was changed");
});

test("a value that is not a #rrggbb string leaves the paper alone", async () => {
  for (const value of ["white", "#fff", "#ffffffff", "#gg0000", "ffffff", 16777215, null, ["#ffffff"], ""]) {
    const board = await startServer({ background_default: value });
    const text = await served(board);
    assert.ok(!text.includes("BOARD_BGCOLOR_DEFAULT"), `${JSON.stringify(value)} was taken as a colour`);
  }
});
