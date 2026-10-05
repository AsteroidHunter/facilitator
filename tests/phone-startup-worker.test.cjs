// The phone page's service worker, against a real board server in a temp
// directory: what it keeps, what it refuses to keep, and what an installed open
// does when the server cannot be reached at all.
//
// Three things are being proved, all of them changed by the startup work:
//   the shell and the squid are kept, so an installed open still has a page to
//     open with when nothing answers, and that page shows the stopped red globe
//     rather than a browser error;
//   a new cache version replaces the old one and the page that comes back is the
//     one on the server, not the one that was kept, so no shell can go stale;
//   /m/state is never intercepted and never kept, so no reading of the board can
//     be answered out of a cache and mistaken for a live one.
//
// The board is invented and lives in a temp directory. Nothing here touches the
// real board, the owner's browser or port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = path.join(ROOT, ".venv", "bin", "python3");
const SHOTS = process.env.M627_SHOTS || "/tmp/m627-startup-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true };
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];
const ASSETS = ["m-icon-180.png", "m-icon-192.png", "m-icon-512.png", "m-splash-squid.png"];

let child = null;
let fixtureDir = "";
let origin = "";
let profiles = [];

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// an app window, which is the only place chrome reports display-mode standalone
async function openApp(url) {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "m627-sw-"));
  profiles.push(userDataDir);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new", userDataDir, defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=390,844", "--app=" + url],
  });
  const deadline = Date.now() + 10000;
  let page = null;
  while (Date.now() < deadline) {
    page = (await browser.pages()).pop();
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(page, "the app window never appeared");
  const cdp = await page.createCDPSession();
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: PHONE.width, height: PHONE.height,
    deviceScaleFactor: PHONE.deviceScaleFactor, mobile: true,
  });
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return { browser, page, problems };
}

// the worker registers on load; this waits for it to be the one in charge, which
// is when the next navigation will go through it
async function workerReady(page) {
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/m");
    return !!(reg && reg.active && navigator.serviceWorker.controller);
  }, { timeout: 20000 });
}

// page.setOfflineMode leaves the worker's own fetches online, so the worker is
// put offline through its own target, and the same session takes it back
async function workerNetwork(browser, session, offline) {
  const cdp = session || await (await browser.waitForTarget(
    target => target.type() === "service_worker", { timeout: 10000 })).createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions",
    { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  return cdp;
}

async function keptPaths(page) {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const out = {};
    for (const name of names) {
      const cache = await caches.open(name);
      out[name] = (await cache.keys()).map(request => new URL(request.url).pathname).sort();
    }
    return out;
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-m627-sw-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of ASSETS) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "startup worker fixture",
    items: [
      { id: "0", bucket: "meta", title: "A standing card", owner: "facilitator",
        context: "Invented content for the fixture board." },
      { id: "1.1", bucket: "now", title: "A card in the other lane", owner: "pastureland",
        context: "Its own lane." },
    ],
  }));
  origin = "http://127.0.0.1:" + port;
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("fixture server exited early:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) break; } catch (_) {}
    if (Date.now() > deadline) throw new Error("fixture server never answered:\n" + output);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

after(async () => {
  if (child) { child.kill("SIGTERM"); await new Promise(resolve => setTimeout(resolve, 400)); }
  for (const dir of profiles) await rm(dir, { recursive: true, force: true });
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the server hands out the squid the startup screen is painted from", async () => {
  const answer = await fetch(origin + "/m-splash-squid.png");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await answer.arrayBuffer());
  assert.deepEqual(Array.from(bytes.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "that route did not answer with a png");
  // the file on disk, unchanged, and it carries an alpha channel: colour type 6
  // is RGBA, which is what a squid with no background behind it needs
  const onDisk = await readFile(path.join(ROOT, "assets", "m-splash-squid.png"));
  assert.deepEqual(bytes, onDisk, "the route answered with something other than the file");
  assert.equal(onDisk[25], 6, "the squid has no alpha channel");
});

test("the launch image is painted from the real squid, with no background behind it", async () => {
  const { browser, page } = await openApp(origin + "/m");
  try {
    await page.waitForFunction(() => !!document.querySelector("link[rel=apple-touch-startup-image]"),
      { timeout: 20000 });
    const out = await page.evaluate(async () => {
      const link = document.querySelector("link[rel=apple-touch-startup-image]");
      const img = new Image();
      img.src = link.href;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const at = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data);
      const shortEdge = Math.min(canvas.width, canvas.height);
      // just outside the logo's own box, which is 0.32 of the shorter edge: a
      // squid still carrying a white card or a window frame would paint here
      const edge = at(canvas.width / 2, canvas.height / 2 - shortEdge * 0.32 * 0.62);
      return { size: [canvas.width, canvas.height], media: link.media,
               corner: at(4, 4), edge, data: link.href.split(",")[1] };
    });
    assert.deepEqual(out.corner, [255, 255, 255, 255], "the launch image is not painted on white");
    // the ground just above the squid is the panel's own white, unbroken
    assert.deepEqual(out.edge, [255, 255, 255, 255],
      "something other than the squid was drawn on the launch image: " + out.edge);
    assert.match(out.media, /^\(device-width: 390px\) and \(device-height: 844px\)/);
    await mkdir(SHOTS, { recursive: true });
    await writeFile(path.join(SHOTS, "launch-image-real-squid.png"), Buffer.from(out.data, "base64"));
  } finally {
    await browser.close();
  }
});

test("the worker keeps static assets but no page or reading of the board", async () => {
  const { browser, page } = await openApp(origin + "/m");
  try {
    await workerReady(page);
    const workerIdentity = await page.evaluate(() => new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = e => resolve(e.data);
      navigator.serviceWorker.controller.postMessage({ kind: "diagnostic-worker" }, [channel.port2]);
    }));
    assert.deepEqual(workerIdentity, { kind: "diagnostic-worker", cache: "facilitator-m-9" });
    // let the page take several readings, so anything that was going to be kept
    // has had every chance to be
    await page.waitForFunction(() => lastState !== null, { timeout: 20000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    const kept = await keptPaths(page);
    const names = Object.keys(kept);
    assert.deepEqual(names, ["facilitator-m-9"], "the worker kept more than one cache: " + names);
    const paths = kept["facilitator-m-9"];
    for (const want of ["/card-logic.js", "/card-markdown.js", "/card-tokens.css",
                        "/m-splash-squid.png",
                        // the composer's typed formatting and the editor it is drawn
                        // with: an installed open that cannot reach the board must get
                        // the same row it had, not a shell with the setting missing
                        "/compose-format.js", "/cm-markdown.js"]) {
      assert.ok(paths.includes(want), "the worker did not keep " + want + ": " + paths);
    }
    // THE BOARD IS NEVER KEPT. Not the reading, not the page's own commands.
    assert.equal(paths.some(p => p.startsWith("/m/state")), false,
      "a reading of the board was kept: " + paths);
    assert.equal(paths.includes("/m"), false, "a cached board could bypass sign-out");
    assert.equal(paths.includes("/m-manifest.json"), false, "a cached manifest could retain a private board title");
    assert.equal(paths.some(p => p === "/state" || p.startsWith("/send") || p.startsWith("/create")), false,
      "board traffic was kept: " + paths);
    // and it is not merely unkept, it is not answered by the worker at all
    const straight = await page.evaluate(async () => {
      const answer = await fetch("/m/state?since=", { cache: "no-store" });
      return { ok: answer.ok, fromWorker: !!answer.headers.get("x-from-worker"),
               cached: await caches.match("/m/state?since=") !== undefined };
    });
    assert.equal(straight.ok, true);
    assert.equal(straight.cached, false, "a reading of the board was answerable from a cache");
  } finally {
    await browser.close();
  }
});

test("an offline navigation cannot reopen a cached authenticated board", async () => {
  const { browser, page } = await openApp(origin + "/m");
  try {
    await workerReady(page);
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    // Navigation must ask the server whether to show the app or the sign-in
    // page. An offline reload cannot use an old authenticated shell.
    const kept = await keptPaths(page);
    assert.equal(Object.values(kept).flat().includes("/m"), false);
    await page.setOfflineMode(true);
    const worker = await workerNetwork(browser, null, true);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => null);
    const offline = await page.evaluate(() => ({
      board: !!document.getElementById("cards"),
      title: document.title,
    }));
    assert.equal(offline.board, false, "an offline reload displayed an old board: " + JSON.stringify(offline));
    await workerNetwork(browser, worker, false);
    await page.setOfflineMode(false);
    await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 30000 });
    const back = await page.evaluate(() => ({
      cards: document.getElementById("cards").childElementCount,
      stated: document.body.classList.contains("stated"),
    }));
    assert.ok(back.cards > 0, "the board never arrived after the network came back");
    assert.equal(back.stated, true);
  } finally {
    await browser.close();
  }
});

test("a changed page is served over the kept one, and a new cache version replaces the old", async () => {
  const { browser, page } = await openApp(origin + "/m");
  try {
    await workerReady(page);
    await page.waitForFunction(() => lastState !== null, { timeout: 20000 });
    const first = await page.evaluate(() => document.documentElement.outerHTML.includes("m627-stale-check"));
    assert.equal(first, false, "the fixture page already carried the marker");

    // the page and the worker both change under the installed app, which is what
    // a deploy looks like from the phone: a new cache name and a new page
    const pageSource = await readFile(path.join(fixtureDir, "m.html"), "utf8");
    await writeFile(path.join(fixtureDir, "m.html"),
      pageSource.replace("<body>", "<body>\n<!-- m627-stale-check -->"));
    const workerSource = await readFile(path.join(fixtureDir, "m-sw.js"), "utf8");
    assert.ok(workerSource.includes('const CACHE = "facilitator-m-9"'), "the cache name moved");
    await writeFile(path.join(fixtureDir, "m-sw.js"),
      workerSource.replace('const CACHE = "facilitator-m-9"', 'const CACHE = "facilitator-m-10"'));

    await page.reload({ waitUntil: "domcontentloaded" });
    // network first: the page that comes back is the server's, not the kept one
    const second = await page.evaluate(() => document.documentElement.outerHTML.includes("m627-stale-check"));
    assert.equal(second, true, "the kept page was served over the changed one");
    // and the new worker drops the cache the old one filled
    await page.waitForFunction(async () => (await caches.keys()).includes("facilitator-m-10"),
      { timeout: 25000 });
    await page.waitForFunction(async () => !(await caches.keys()).includes("facilitator-m-9"),
      { timeout: 25000 });
    const kept = await keptPaths(page);
    assert.deepEqual(Object.keys(kept), ["facilitator-m-10"]);
    assert.ok(kept["facilitator-m-10"].includes("/m-splash-squid.png"),
      "the new cache did not take the squid with it");
    assert.ok(kept["facilitator-m-10"].includes("/cm-markdown.js"),
      "the new cache did not take the composer's editor with it");
    // The authenticated page is intentionally absent from the new cache.
    const keptPage = await page.evaluate(async () => {
      const answer = await caches.match("/m");
      return answer ? (await answer.text()).includes("m627-stale-check") : null;
    });
    assert.equal(keptPage, null, "the worker cached an authenticated page");
  } finally {
    await browser.close();
  }
});

test("a page whose worker cannot be fetched still opens and still starts", async () => {
  // The deliberate opposite of the three cases above, and kept apart from them
  // on purpose: those prove what the cache does, and this one proves the page's
  // own claim that it works with no worker at all. The file is taken off the
  // server rather than intercepted in the page, because a worker script is
  // fetched by the browser and never passes through the page's requests.
  const workerFile = path.join(fixtureDir, "m-sw.js");
  const saved = await readFile(workerFile);
  await rm(workerFile);
  let browser = null;
  try {
    assert.equal((await fetch(origin + "/m-sw.js")).status, 404, "the worker is still being served");
    const opened = await openApp(origin + "/m");
    browser = opened.browser;
    await opened.page.waitForFunction(() => !document.getElementById("loading"), { timeout: 25000 });
    const out = await opened.page.evaluate(async () => ({
      cards: document.getElementById("cards").childElementCount,
      worker: !!(await navigator.serviceWorker.getRegistration("/m")),
      caches: (await caches.keys()).length,
      stated: document.body.classList.contains("stated"),
    }));
    assert.ok(out.cards > 0, "the board did not draw without a worker");
    assert.equal(out.worker, false, "a worker registered after all, so this proves nothing");
    assert.equal(out.caches, 0, "something was kept without a worker to keep it");
    assert.equal(out.stated, true);
    assert.deepEqual(opened.problems, [], "a refused worker threw inside the page");
  } finally {
    if (browser) await browser.close();
    await writeFile(workerFile, saved);
  }
});
