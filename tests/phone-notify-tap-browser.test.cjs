// What the phone page writes about a tapped notification, driven headless
// against its own fixture server: a notifyarrive line when the card reaches the
// page, by the worker's message or by the address the notification opened, and
// a notifyresult line once the card is drawn or two seconds later. The lines are
// read from the client file the fixture server writes, so what is checked is
// what the board really took. Nothing here starts the real board.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

let browser;
let child;
let outer;
let fixtureDir;
let logs;
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

async function create(title) {
  const response = await fetch(origin + "/create?owner=facilitator", { method: "POST", body: title });
  assert.equal(response.status, 200);
  return (await response.json()).id;
}

async function reports() {
  const out = [];
  for (const name of (await readdir(logs).catch(() => [])).sort()) {
    if (!name.startsWith("client-")) continue;
    for (const line of (await readFile(path.join(logs, name), "utf8")).split("\n")) {
      if (line !== "") out.push(JSON.parse(line));
    }
  }
  return out;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// the lines of one kind that match, waited for until the board has one
async function linesOf(kind, match, within = 6000) {
  const deadline = Date.now() + within;
  for (;;) {
    const found = (await reports()).filter(line => line.kind === kind && match(line));
    if (found.length) return found;
    if (Date.now() > deadline) assert.fail(`no ${kind} line for ${match}`);
    await pause(50);
  }
}

// the one line of a kind that carries a tap id, and no more than one
async function lineOf(kind, tap, within = 6000) {
  const found = await linesOf(kind, line => line.tap === tap, within);
  assert.equal(found.length, 1, `${kind} ${tap} was written ${found.length} times`);
  return found[0];
}

async function openPhone(route) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  return { page, problems };
}

async function readyPhone(route = "/m") {
  const opened = await openPhone(route);
  await opened.page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return opened;
}

const tapFrom = (page, box, tap) => page.evaluate((id, word) => {
  const data = { box: id };
  if (word !== undefined) data.tap = word;
  navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data }));
}, box, tap);

before(async () => {
  outer = await mkdtemp(path.join(tmpdir(), "facilitator-tapbrowser-"));
  fixtureDir = path.join(outer, "app");
  logs = path.join(outer, "logs");
  await mkdir(fixtureDir);
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js",
                      "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "tap logging test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      if ((await fetch(origin + "/state")).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await pause(25);
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
    await once(child, "exit");
  }
  if (outer) await rm(outer, { recursive: true, force: true });
});

test("a card that reaches a warm page is told of twice, as arrived and as shown, under the tap id", async () => {
  const id = await create("Warm tap card");
  const { page, problems } = await readyPhone();
  try {
    const visible = await page.evaluate(() => !document.hidden);
    await tapFrom(page, id, "cafe0001");
    const arrived = await lineOf("notifyarrive", "cafe0001");
    const result = await lineOf("notifyresult", "cafe0001");
    const kept = line => ({ ...line, ts: undefined, window: undefined, client: undefined });
    assert.deepEqual(kept(arrived), {
      ts: undefined, level: "info", kind: "notifyarrive", box: id, page: "phone", client: undefined, window: undefined,
      tap: "cafe0001", via: "message", reading: "yes", found: "yes", visible: visible ? "yes" : "no",
      menu: "none", home: "no", hist: "no",
    });
    assert.deepEqual(kept(result), {
      ts: undefined, level: "info", kind: "notifyresult", box: id, page: "phone", client: undefined, window: undefined,
      tap: "cafe0001", shown: "yes", covered: "none", pending: "no",
    });
    assert.match(arrived.window, /^[a-f0-9]{16}$/);
    assert.equal(result.window, arrived.window, "the two lines came from different windows");
    assert.equal(await page.evaluate(() => selectedId), id, "the card was not the one shown");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("what stands over the card is named: the card list, the settings, the project list or nothing", async () => {
  const id = await create("Covered tap card");
  const { page, problems } = await readyPhone();
  try {
    const covers = [
      ["cards", "cafe0010", () => drawer.classList.add("open")],
      ["settings", "cafe0011", () => settings.classList.add("open")],
      ["projects", "cafe0012", () => document.body.classList.add("projopen")],
    ];
    for (const [word, tap, cover] of covers) {
      // each is put over the page as the page itself would have it: its panel open
      await page.evaluate(`(${cover})()`);
      const stood = await page.evaluate(() => ({
        panel: menuOut() === drawer ? "cards" : menuOut() === settings ? "settings" : null,
        projects: projOpen(),
      }));
      await tapFrom(page, id, tap);
      const arrived = await lineOf("notifyarrive", tap);
      const result = await lineOf("notifyresult", tap);
      assert.equal(arrived.menu, word, `the arrival did not name the ${word}`);
      assert.deepEqual([result.shown, result.pending], ["yes", "no"]);
      // and the result names what is over the card once it is drawn, as the page then has it
      const after = await page.evaluate(() => (menuOut() === drawer ? "cards" : menuOut() === settings ? "settings"
        : projOpen() ? "projects" : "none"));
      assert.equal(result.covered, after, `the result named ${result.covered} over the card, the page had ${after}`);
      assert.ok(stood.panel === word || (word === "projects" && stood.projects), "the cover was not put on");
      await page.evaluate(() => {
        for (const panel of [drawer, settings]) panel.classList.remove("open");
        document.body.classList.remove("projopen");
      });
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a card the phone has not read yet is waited for, and the result says so after two seconds", async () => {
  const { page, problems } = await readyPhone();
  try {
    const began = Date.now();
    await tapFrom(page, "m999999", "cafe0020");
    const arrived = await lineOf("notifyarrive", "cafe0020");
    assert.deepEqual([arrived.reading, arrived.found, arrived.box], ["yes", "no", "m999999"]);
    const result = await lineOf("notifyresult", "cafe0020", 6000);
    assert.ok(Date.now() - began >= 1900, "the result was written before the two seconds were up");
    assert.deepEqual([result.shown, result.pending, result.covered], ["no", "yes", "none"]);
    assert.equal(await page.evaluate(() => wantBox), "m999999", "the tap no longer waits for the card");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a page opened by the notification's address says it arrived by url, and keeps the address", async () => {
  const id = await create("Cold tap card");
  const { page, problems } = await openPhone(`/m?box=${encodeURIComponent(id)}&tap=cafe0030`);
  try {
    const arrived = await lineOf("notifyarrive", "cafe0030");
    const result = await lineOf("notifyresult", "cafe0030");
    assert.deepEqual([arrived.via, arrived.box, arrived.found, arrived.menu, arrived.home],
      ["url", id, "no", "none", "no"]);
    assert.deepEqual([result.box, result.shown, result.pending, result.covered], [id, "yes", "no", "none"]);
    assert.equal(await page.evaluate(() => selectedId), id);
    assert.match(page.url(), new RegExp(`[?&]box=${id}(&|$)`), "the address no longer names the card");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("an address with no tap id, from an older worker, logs the tap as none", async () => {
  const id = await create("Untagged tap card");
  const { page, problems } = await openPhone(`/m?box=${encodeURIComponent(id)}`);
  try {
    await page.waitForFunction(i => selectedId === i, { timeout: 5000 }, id);
    const [arrived] = await linesOf("notifyarrive", line => line.tap === "none" && line.box === id);
    assert.equal(arrived.via, "url");
    const [result] = await linesOf("notifyresult", line => line.tap === "none" && line.box === id);
    assert.equal(result.shown, "yes");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a message that is not a card id and a tap id is logged as none and still handled as before", async () => {
  const { page, problems } = await readyPhone();
  try {
    await tapFrom(page, "Private card title", "not-a-tap");
    assert.equal(await page.evaluate(() => wantBox), "Private card title", "the tap was handled differently");
    const [result] = await linesOf("notifyresult", line => line.tap === "none" && line.shown === "no");
    const written = JSON.stringify(await reports());
    assert.ok(!written.includes("Private card title") && !written.includes("not-a-tap"),
      "text from a message reached the client file");
    assert.equal(result.box, undefined);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a page nobody tapped for writes no tap line", async () => {
  const before = (await reports()).length;
  const { page } = await readyPhone();
  try {
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { kind: "x" } })));
    await pause(500);
    const fresh = (await reports()).slice(before);
    assert.deepEqual(fresh.filter(line => /^notify(arrive|result|tap)$/.test(line.kind)), []);
  } finally {
    await page.close();
  }
});
