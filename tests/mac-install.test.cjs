// Installing the board page as a Chrome app of its own: the manifest and the
// worker the browser asks for before it will offer an install, the routes that
// serve them, the control in the bar that asks for Chrome's own box, and the
// line the phone page keeps between its worker and this one.
//
// What only a real Chrome can show, the beforeinstallprompt event itself and
// the install that follows it, is driven against a running browser by hand.
// Here the files, the routes, the registration's scope and the control's own
// comings and goings are pinned headless.
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
const DESKTOP = { width: 1440, height: 900 };
// where the two pictures of the bar are written, when they are asked for
const SHOTS = process.env.MAC_INSTALL_SHOTS || "";

let browser, child, fixtureDir, origin;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function settle(ms = 200) { await new Promise(resolve => setTimeout(resolve, ms)); }

// one offer of the kind Chrome sends, made by hand: the page holds it and asks
// for the browser's box through it, so the parts the page touches are all it
// needs to be. Whether Chrome really sends one is proven against a real browser.
function sendOffer() {
  const event = new Event("beforeinstallprompt");
  window.__asked = 0;
  event.prompt = () => { window.__asked += 1; return Promise.resolve({ outcome: "accepted" }); };
  dispatchEvent(event);
}

// The browser makes its own offer for this page, which is the point of the two
// new files; so a test about what the page does with an offer has to be able to
// hold the browser's own back. A listener added before the page's own scripts
// run is called first and stops the offer there, and counts it on the way.
function holdOffers() {
  window.__offers = 0;
  addEventListener("beforeinstallprompt", event => {
    if (!event.isTrusted) return;          // the made-up offers below are the test's own
    window.__offers += 1;
    event.preventDefault();
    event.stopImmediatePropagation();
  });
}

// Standing in for the installed app's display mode. The protocol has no
// override for it: Emulation.setEmulatedMedia carries the prefers-* features
// and ignores display-mode, which was tried against this browser both with and
// without a media of its own. So the browser's answer is replaced with the one
// an installed app gives, which is the answer the page reads.
function asInstalledApp() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = query => /display-mode:\s*standalone/.test(query)
    ? { matches: true, media: query, onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent: () => false }
    : real(query);
}

async function openBoard({ standalone = false, offers = false } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(DESKTOP);
  if (!offers) await page.evaluateOnNewDocument(holdOffers);
  if (standalone) await page.evaluateOnNewDocument(asInstalledApp);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await settle(400);
  return { page, problems };
}

// what the control looks like beside the button it was seated next to
async function barShape(page) {
  return page.evaluate(() => {
    const install = document.getElementById("installbtn");
    const edit = document.getElementById("editbtn");
    const seen = el => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        shown: !el.hidden && box.width > 0,
        top: Math.round(box.top), height: Math.round(box.height),
        font: style.font, colour: style.color, background: style.backgroundColor,
        radius: style.borderTopLeftRadius, padding: style.padding, border: style.borderStyle,
        text: el.textContent,
      };
    };
    return { install: seen(install), edit: seen(edit) };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-mac-install-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "m.html", "page.html", "manifest.json", "sw.js",
                      "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "install fixture",
    items: [{ id: "0", bucket: "meta", title: "Where the seedlings go", owner: "facilitator",
              context: "The east bed has room for the new rows." }],
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir, env: { ...process.env, FACILITATOR_TEST_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { const response = await fetch(origin + "/state"); if (response.ok) { ready = true; break; } } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- the two new files and their routes ---------------------------------------

test("the board's manifest is served as a manifest and describes the whole board", async () => {
  const response = await fetch(origin + "/manifest.json");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/manifest\+json/);
  const manifest = await response.json();
  assert.equal(manifest.name, "facilitator");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  // the phone app's manifest has the scope and the id of /m, so an id here is
  // what keeps Chrome holding the two as two apps
  assert.equal(manifest.id, "/");
  const phone = await (await fetch(origin + "/m-manifest.json")).json();
  assert.notEqual(manifest.id, phone.id ?? phone.start_url);
  // Chrome's install box wants both of these sizes
  const sizes = manifest.icons.map(icon => icon.sizes).sort();
  assert.deepEqual(sizes, ["192x192", "512x512"]);
  for (const icon of manifest.icons) {
    const picture = await fetch(origin + icon.src);
    assert.equal(picture.status, 200, `${icon.src} is not served`);
    assert.match(picture.headers.get("content-type"), /^image\/png/);
  }
});

test("the board's worker is served from the root as a script, and keeps nothing", async () => {
  const response = await fetch(origin + "/sw.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/javascript/);
  const source = await response.text();
  assert.match(source, /addEventListener\("fetch"/, "the worker has no fetch handler to install on");
  assert.doesNotMatch(source, /caches\./, "the worker keeps something");
});

test("the board page links its manifest and its icon", async () => {
  const source = await readFile(path.join(ROOT, "index.html"), "utf8");
  const head = source.slice(0, source.indexOf("</head>"));
  assert.match(head, /<link rel="manifest" href="\/manifest\.json">/);
  assert.match(head, /<link rel="icon" href="\/m-icon-192\.png">/);
  assert.doesNotMatch(head, /rel="icon" href="data:,"/, "the tab icon is still empty");
});

// ---- the workers, and the line between them -----------------------------------

test("the board's worker takes the root, and the phone page stays on its own", async () => {
  const { page, problems } = await openBoard();
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, script: (reg.active || reg.installing || reg.waiting).scriptURL };
  });
  assert.equal(new URL(registered.scope).pathname, "/", registered.scope);
  assert.match(registered.script, /\/sw\.js$/);

  // a second open is the one the worker controls, since it claims nothing
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(300);
  const controller = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || null);
  assert.match(controller || "", /\/sw\.js$/, "the board page is not controlled by its own worker");

  const phone = await browser.newPage();
  await phone.goto(origin + "/m", { waitUntil: "domcontentloaded" });
  await settle(600);
  await phone.reload({ waitUntil: "domcontentloaded" });
  await settle(600);
  const phoneController = await phone.evaluate(() => navigator.serviceWorker.controller?.scriptURL || null);
  assert.match(phoneController || "", /\/m-sw\.js$/,
    `the phone page is controlled by ${phoneController}, not its own worker`);
  await phone.close();
  assert.deepEqual(problems, []);
  await page.close();
});

// ---- the control in the bar ----------------------------------------------------

test("the browser offers an install for the page as it stands, and the control comes up", async () => {
  // this is the whole point of the manifest and the worker: a page that meets
  // the browser's install rules gets the offer the control is there to use
  const { page, problems } = await openBoard({ offers: true });
  await page.waitForSelector("#installbtn:not([hidden])", { timeout: 10000 });
  assert.equal(await page.evaluate(() => document.getElementById("installbtn").textContent),
    "Install app");
  assert.deepEqual(problems, []);
  await page.close();
});

test("no offer, no control: the bar is as it was", async () => {
  const { page, problems } = await openBoard();
  const shape = await barShape(page);
  assert.equal(shape.install.shown, false, "the install control stands there with nothing to install");
  assert.deepEqual(problems, []);
  await page.close();
});

test("an offer puts the control in the bar, dressed as the button beside it", async () => {
  const { page, problems } = await openBoard();
  await page.evaluate(sendOffer);
  const shape = await barShape(page);
  assert.equal(shape.install.shown, true, "the offer left the bar unchanged");
  assert.equal(shape.install.text, "Install app");
  // the same dress as its neighbour, and the same seat in the row
  assert.equal(shape.install.font, shape.edit.font);
  assert.equal(shape.install.colour, shape.edit.colour);
  assert.equal(shape.install.background, shape.edit.background);
  assert.equal(shape.install.radius, shape.edit.radius);
  assert.equal(shape.install.padding, shape.edit.padding);
  assert.equal(shape.install.border, shape.edit.border);
  assert.equal(shape.install.height, shape.edit.height);
  assert.equal(shape.install.top, shape.edit.top);

  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "mac-install-button.png") });
  assert.deepEqual(problems, []);
  await page.close();
});

test("a press asks the browser for its box, once, and the control steps back", async () => {
  const { page, problems } = await openBoard();
  await page.evaluate(sendOffer);
  await page.click("#installbtn");
  await settle(150);
  assert.equal(await page.evaluate(() => window.__asked), 1, "the press did not ask for the box");
  assert.equal((await barShape(page)).install.shown, false,
    "the control stayed after the offer it held was spent");
  // a spent offer cannot be asked for twice, and nothing is thrown trying
  await page.evaluate(() => document.getElementById("installbtn").click());
  assert.equal(await page.evaluate(() => window.__asked), 1);
  assert.deepEqual(problems, []);
  await page.close();
});

test("inside the installed app the control never appears", async () => {
  const { page, problems } = await openBoard({ standalone: true });
  assert.equal(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches), true,
    "the display mode was not emulated");
  await page.evaluate(sendOffer);
  assert.equal((await barShape(page)).install.shown, false,
    "the installed app offers to install itself again");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "mac-install-button-hidden.png") });
  assert.deepEqual(problems, []);
  await page.close();
});

test("an install finished elsewhere takes the control away", async () => {
  const { page, problems } = await openBoard();
  await page.evaluate(sendOffer);
  assert.equal((await barShape(page)).install.shown, true);
  await page.evaluate(() => dispatchEvent(new Event("appinstalled")));
  assert.equal((await barShape(page)).install.shown, false, "the control stayed after the install");
  assert.deepEqual(problems, []);
  await page.close();
});
