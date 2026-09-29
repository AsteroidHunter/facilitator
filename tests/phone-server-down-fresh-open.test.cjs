// The phone app opened fresh while the board is down. The page itself cannot
// load then, so the phone's service worker answers the page open with the same
// plain white "Is the Facilitator server down?" screen the page draws over the
// board once its readings have failed. Three layers: the worker's decision run
// on its own, the worker's copy of the screen compared with m.html's, and the
// whole thing driven headless at an iPhone size against its own fixture server
// that is stopped, replaced by a stand-in proxy answering 502, and started again.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const http = require("node:http");
const vm = require("node:vm");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const WORDS = "Is the Facilitator server down?";

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- the worker's decision, run on its own ---------------------------------------------

async function loadWorker(fetchImpl) {
  const handlers = {};
  const context = {
    URL, AbortSignal, Promise, Response, Headers,
    fetch: fetchImpl,
    caches: { keys: async () => [], open: async () => ({ addAll: async () => {} }), match: async () => undefined },
    self: {
      location: { origin: "https://board.test" },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting() {}, registration: {}, clients: { claim: async () => {} },
    },
  };
  vm.runInNewContext(await readFile(path.join(ROOT, "m-sw.js"), "utf8"), context, { filename: "m-sw.js" });
  return handlers;
}

// what the worker answers a request with, or undefined when it leaves the request alone
async function answerTo(handlers, { url = "https://board.test/m", mode = "navigate", method = "GET" } = {}) {
  let answered;
  handlers.fetch({ request: { url, mode, method }, respondWith: promise => { answered = promise; } });
  return answered ? await answered : undefined;
}

test("a page open the board cannot answer gets the white screen, every other answer is passed on untouched", async () => {
  const seen = [];
  const handlers = await loadWorker(async request => {
    seen.push(request);
    throw new TypeError("Failed to fetch");
  });
  const down = await answerTo(handlers);
  assert.equal(down.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(down.headers.get("cache-control"), "no-store");
  const text = await down.text();
  assert.ok(text.includes('<div id="serverdown"'), "the page is the screen");
  assert.ok(text.includes(WORDS));
  assert.equal(seen.length, 1, "the server is asked for the page open once");

  for (const status of [502, 503, 504]) {
    const proxied = { status, ok: false };
    const stood = await (await loadWorker(async () => proxied).then(answerTo)).text();
    assert.ok(stood.includes(WORDS), `a ${status} is not the server answering`);
  }
  for (const status of [200, 301, 302, 304, 401, 403, 404, 500]) {
    const real = { status, ok: status < 300 };
    const passed = await answerTo(await loadWorker(async () => real));
    assert.equal(passed, real, `a ${status} must reach the page as it came`);
  }
  const opaque = { status: 0, type: "opaqueredirect" };
  assert.equal(await answerTo(await loadWorker(async () => opaque)), opaque, "a redirect is followed by the browser, not turned into the screen");
});

test("the worker leaves everything but the app page's own open alone", async () => {
  const handlers = await loadWorker(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(await answerTo(handlers, { method: "POST" }), undefined, "a post is not a page open");
  assert.equal(await answerTo(handlers, { url: "https://elsewhere.test/m" }), undefined, "another site's page");
  assert.equal(await answerTo(handlers, { url: "https://board.test/", mode: "navigate" }), undefined,
    "the desktop page is not the phone app");
  assert.equal(await answerTo(handlers, { url: "https://board.test/m/state", mode: "cors" }), undefined,
    "a reading is never intercepted");
  assert.equal(await answerTo(handlers, { url: "https://board.test/m-manifest.json", mode: "cors" }), undefined,
    "the file the white screen asks for reaches the network as it is");
  const withQuery = await answerTo(handlers, { url: "https://board.test/m?box=1.1" });
  assert.ok((await withQuery.text()).includes(WORDS), "a page open with a card named is the app page as well");
});

// ---- the worker's copy of the screen against the page's own -----------------------------

test("the worker's screen is a copy of m.html's: markup, rules, tokens, font sheet and measure", async () => {
  const html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const tokens = await readFile(path.join(ROOT, "card-tokens.css"), "utf8");
  const handlers = await loadWorker(async () => { throw new TypeError("Failed to fetch"); });
  const page = await (await answerTo(handlers)).text();
  const need = (found, what) => { assert.ok(found, `m.html has no ${what}`); return found[0]; };

  const markup = need(html.match(/<div id="serverdown"[\s\S]*?<\/div>/), "server down markup");
  assert.ok(page.includes(markup), "the markup, the icon and the words differ from the page's");
  assert.ok(markup.includes(WORDS));

  const rules = need(html.match(/ {2}#serverdown\{[\s\S]*?#serverdown svg\{[^}]*\}\n/), "server down rules");
  assert.ok(page.includes(rules), "the rules for the screen differ from the page's");

  for (const [name, pattern] of [
    ["ink", /--ink:[^;]+;/], ["typeface", /--sans:[^;]+;/],
  ]) {
    assert.ok(page.includes(need(tokens.match(pattern), `${name} token`)), `the ${name} differs from card-tokens.css`);
  }
  for (const [name, pattern] of [
    ["root measure", /:root\{--root-h:100%\}/],
    ["standalone measure", /@media \(display-mode:standalone\)\{ :root\{--root-h:100vh\} \}/],
    ["root height", /html\{height:var\(--root-h\); -webkit-text-size-adjust:100%\}/],
    ["screen measure", /document\.documentElement\.style\.setProperty\("--screen-h", screen\.height \+ "px"\);/],
  ]) {
    const line = need(html.match(pattern), name).replace(/^:root\{--root-h:100%\}$/, "--root-h:100%");
    assert.ok(page.includes(line), `the ${name} differs from the page's`);
  }
  const sheet = need(html.match(/"(https:\/\/fonts\.googleapis\.com\/css2\?family=Newsreader[^"]*)"/), "first font sheet");
  assert.ok(page.includes(JSON.stringify(JSON.parse(sheet))), "the font sheet differs from the page's first");
  assert.equal(page.includes("<link "), false, "a stylesheet link would hold the screen back");
  assert.equal(/emoji|\p{Extended_Pictographic}/u.test(page), false, "the face is drawn, not an emoji");
});

// ---- the whole thing, headless ------------------------------------------------------------

let browser;
let child;
let proxy;
let fixtureDir;
let origin;
let port;
let output = "";

async function startServer() {
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error(`fixture server did not start:\n${output}`);
    await settle(25);
  }
}

async function stopServer() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}

// what a proxy in front of a stopped server answers, on the server's own port
async function startProxy(status, body) {
  proxy = http.createServer((request, response) => {
    response.writeHead(status, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(port, "127.0.0.1", resolve);
  });
}

async function stopProxy() {
  if (!proxy) return;
  const closed = once(proxy, "close");
  proxy.close();
  proxy.closeAllConnections();
  await closed;
  proxy = null;
}

// each browser test starts with the board answering, whatever the one before did
async function boardUp() {
  await stopProxy();
  if (!child || child.exitCode !== null) await startServer();
}

async function newContext() {
  const context = await (browser.createBrowserContext || browser.createIncognitoBrowserContext).call(browser);
  const page = await context.newPage();
  page.once("close", () => { context.close().catch(() => {}); });
  await page.setViewport(PHONE);
  return page;
}

// the app opened with the board up, until the worker controls the page
async function installedApp() {
  const page = await newContext();
  await page.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null && document.querySelector("article.box.sel"), { timeout: 20000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 20000 });
  await page.waitForFunction(async () => (await caches.keys()).length > 0 &&
    (await (await caches.open((await caches.keys())[0])).keys()).length >= 5, { timeout: 20000 });
  return page;
}

async function screenState(page) {
  return page.evaluate(() => {
    const screen = document.getElementById("serverdown");
    if (!screen) return { present: false, text: document.body ? document.body.innerText : "" };
    const line = screen.querySelector("p");
    const icon = line.querySelector("svg");
    const pick = (node, names) => Object.fromEntries(names.map(name => [name, getComputedStyle(node)[name]]));
    const rect = node => { const r = node.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
    const middle = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      present: true,
      shown: getComputedStyle(screen).display !== "none",
      words: line.textContent,
      onTop: !!middle.closest("#serverdown") && !!document.elementFromPoint(4, 4).closest("#serverdown"),
      children: [...screen.children].map(node => node.tagName),
      extras: screen.querySelectorAll("button,a,input,progress,textarea,img").length,
      screenStyle: pick(screen, ["display", "position", "zIndex", "height", "paddingLeft", "paddingRight", "backgroundColor",
        "color", "fontFamily", "fontSize", "fontWeight", "lineHeight", "textAlign", "alignItems", "justifyContent"]),
      lineStyle: pick(line, ["margin", "fontSize", "lineHeight", "fontFamily", "color"]),
      iconStyle: pick(icon, ["width", "height", "marginRight", "verticalAlign", "color", "stroke", "fill", "strokeWidth"]),
      rects: { screen: rect(screen), line: rect(line), icon: rect(icon) },
      plexLoaded: [...document.fonts].some(face => face.family.includes("IBM Plex Sans") && face.weight === "400" && face.status === "loaded"),
      viewport: [innerWidth, innerHeight],
    };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-fresh-open-"));
  port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "fresh open test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A card that stays open", owner: "facilitator", context: "It holds a reply." },
    ],
  }));
  origin = `http://127.0.0.1:${port}`;
  await startServer();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  await stopProxy();
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a fresh open with the server stopped, then behind a 502, shows the white screen and returns to the app on its own", async () => {
  await boardUp();
  const page = await installedApp();

  // (a) the server is gone: the phone would show its own error, the worker shows the screen
  await stopServer();
  const stopped = await page.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  assert.equal(stopped.status(), 503);
  const a = await screenState(page);
  assert.equal(a.present, true, `no white screen with the server stopped: ${a.text}`);
  assert.equal(a.shown, true);
  assert.equal(a.words, WORDS);
  assert.equal(a.screenStyle.backgroundColor, "rgb(255, 255, 255)", "plain white");
  assert.equal(a.onTop, true);
  assert.deepEqual(a.children, ["P"]);
  assert.equal(a.extras, 0, "no buttons, no explanation, no spinner");
  assert.equal(await page.evaluate(() => document.body.innerText.trim()), WORDS);

  // (b) a proxy in front answers 502 in plain text: the same screen, not the proxy's words
  await startProxy(502, "Bad Gateway");
  const proxied = await page.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  assert.equal(proxied.status(), 503, "the worker's own answer, not the proxy's");
  const b = await screenState(page);
  assert.equal(b.present, true, `the proxy's own text showed: ${b.text}`);
  assert.equal(b.words, WORDS);
  assert.equal(await page.evaluate(() => document.body.innerText.trim()), WORDS);
  assert.deepEqual(b.rects, a.rects, "the same place on the screen behind the proxy and with the server stopped");

  // it stays while the board stays gone, and does not reload itself into the proxy's text
  await page.evaluate(() => { window.__before = true; });
  await settle(7500);
  assert.equal(await page.evaluate(() => window.__before === true && !!document.getElementById("serverdown")), true,
    "the screen reloaded or went away while the proxy still answered 502");

  // an answer that refuses is the board answering: the page open passes through as it came
  await stopProxy();
  await startProxy(403, "refused");
  const refused = await page.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  assert.equal(refused.status(), 403);
  assert.equal((await screenState(page)).present, false, "a 403 is the board answering");

  // (c) the board is back: the screen reloads into the real app without a touch
  await stopProxy();
  await startProxy(502, "Bad Gateway");
  await page.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  assert.equal((await screenState(page)).present, true);
  await page.evaluate(() => { window.__before = true; });
  await stopProxy();
  await startServer();
  const started = Date.now();
  let back = false;
  while (Date.now() - started < 30000 && !back) {
    await settle(250);
    back = await page.evaluate(() => {
      const screen = document.getElementById("serverdown");
      return window.__before !== true && typeof lastState !== "undefined" && lastState !== null &&
        !!document.querySelector("article.box.sel") && (!screen || getComputedStyle(screen).display === "none");
    }).catch(() => false);
  }
  assert.equal(back, true, "the screen did not reload into the app once the board answered");
  assert.ok(Date.now() - started < 12000, `it took ${Date.now() - started} ms after the board answered`);
  assert.equal(await page.evaluate(() => document.body.classList.contains("down")), false);
  await page.close();
});

test("with the board up the page open is asked of the server every time and nothing of it is kept", async () => {
  await boardUp();
  const page = await installedApp();
  const marker = "fresh-open-network-check";
  const source = await readFile(path.join(fixtureDir, "m.html"), "utf8");
  await writeFile(path.join(fixtureDir, "m.html"), source.replace("<body>", `<body>\n<!-- ${marker} -->`));
  try {
    const before = await page.evaluate(() => document.documentElement.outerHTML.includes("fresh-open-network-check"));
    assert.equal(before, false);
    const answer = await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(answer.status(), 200);
    assert.equal(answer.fromServiceWorker(), true, "the worker did not see the page open");
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes("fresh-open-network-check")), true,
      "the page came from a kept copy, not the server");
    assert.equal(await page.evaluate(() => {
      const screen = document.getElementById("serverdown");
      return !!screen && getComputedStyle(screen).display !== "none";
    }), false, "the screen shows with the board up");
    const kept = await page.evaluate(async () => {
      const paths = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
      return paths;
    });
    assert.equal(kept.some(pathname => pathname === "/m" || pathname === "/m-down"), false, `the worker kept a page: ${kept}`);
    // and a second open sees a second change
    await writeFile(path.join(fixtureDir, "m.html"), source.replace("<body>", `<body>\n<!-- ${marker}-again -->`));
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.evaluate(() => document.documentElement.outerHTML.includes("fresh-open-network-check-again")), true);
  } finally {
    await writeFile(path.join(fixtureDir, "m.html"), source);
    await page.close();
  }
});

test("the fresh-open screen and the in-app screen are the same picture", async () => {
  await boardUp();
  // the in-app one: the board is up but every reading is refused, until the page raises its own screen
  const inApp = await newContext();
  await inApp.setRequestInterception(true);
  inApp.on("request", request => {
    if (request.url().includes("/m/state")) return request.abort("connectionrefused").catch(() => {});
    return request.continue().catch(() => {});
  });
  await inApp.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });
  await inApp.waitForFunction(() => document.body.classList.contains("down"), { timeout: 40000 });

  // the fresh-open one: the worker's, with the server stopped
  const app = await installedApp();
  await stopServer();
  await app.goto(origin + "/m?box=1.1", { waitUntil: "domcontentloaded" });

  // the web font sheet has come or has failed by now, on both
  await settle(4000);
  for (const page of [inApp, app]) await page.evaluate(() => document.fonts.ready);
  const [inAppState, freshState] = [await screenState(inApp), await screenState(app)];
  assert.equal(freshState.present, true);
  assert.deepEqual(freshState.viewport, inAppState.viewport);
  assert.equal(freshState.plexLoaded, inAppState.plexLoaded, "the two are not in the same face");
  for (const key of ["words", "shown", "onTop", "children", "extras", "screenStyle", "lineStyle", "iconStyle", "rects"]) {
    assert.deepEqual(freshState[key], inAppState[key], `${key} differs between the fresh-open screen and the in-app screen`);
  }
  const shots = [await inApp.screenshot({ type: "png" }), await app.screenshot({ type: "png" })];
  if (!shots[0].equals(shots[1])) {
    const probe = await newContext();
    const differing = await probe.evaluate(async images => {
      const load = data => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = "data:image/png;base64," + data;
      });
      const [one, two] = await Promise.all(images.map(load));
      const draw = image => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = [draw(one), draw(two)];
      let count = 0;
      for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) count++;
      return count;
    }, shots.map(shot => shot.toString("base64")));
    await probe.close();
    assert.equal(differing, 0, `${differing} device pixels differ between the two screens`);
  }
  await inApp.close();
  await app.close();
  await startServer();
});
