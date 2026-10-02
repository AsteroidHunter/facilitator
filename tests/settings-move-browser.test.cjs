// The settings half of a move, end to end in a browser. A sandbox board is
// arranged on one port: some of it by an older browser whose own storage held
// a layout, a background, an outline width, typed page tasks and a Spotify
// sign-in before this code (handed to the board by the one-time copy on its
// first load), and the rest live, through the page's own controls: a box
// dragged with Option, a box put away with the pencil's cross, the background
// picked, formatting while typing turned on, a task heading typed on the typed
// page. Then something else takes the port, `facilitator run` moves the board,
// and the board is opened at the new address from a browser profile with
// nothing in it. Every box's place, size and visibility, the background, the
// outline width, the format setting, the typed page's tasks and the Spotify
// sign-in are the same, and nothing of it came from that browser's storage.
// Screenshots of both go to FACILITATOR_MOVE_SHOTS (a temporary folder when
// unset).
//
// Its own headless Chrome with its own profile; sandbox ports from the
// operating system; the fake tailscale first on PATH. No window is opened.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const puppeteer = require("puppeteer-core");
const box = require("./board-sandbox.cjs");

const execFileAsync = promisify(execFile);
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.FACILITATOR_MOVE_SHOTS || path.join(os.tmpdir(), "facilitator-settings-move-shots");
const VIEW = { width: 1440, height: 900 };
const REGIONS = ["main", "clockbox", "tickets", "rail", "magic1", "magic2", "magic3", "magic4", "goalbox"];
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing user-library-read user-library-modify";
// what an older browser had kept for this board in its own storage
const OLD = {
  "magicrename.1": "1", "layoutsync.1": "1", "layoutvisibility.1": "1", "layoutvisibility.2": "1",
  "pos.facilitator.main": JSON.stringify({ x: 547.2, y: 74.88 }),
  "size.facilitator.tickets": JSON.stringify({ w: 380.16, h: 541.44 }),
  "show.facilitator.magic1": "1",
  "show.facilitator.magic2": "1",
  "tocw": "300",
  "doc.tasks.facilitator": JSON.stringify([{ id: "k1", title: "task Plan the move", boxes: ["0"] }]),
  "spot.access": "AT-old-browser", "spot.refresh": "RT-old-browser",
  "spot.expires": String(Date.now() + 3600e3), "spot.scopes": SCOPES,
};

let place, base, browser, profile, other;

async function cli(lines) {
  const code = [
    "import importlib.machinery, importlib.util",
    `loader = importlib.machinery.SourceFileLoader("facilitator_cli", ${JSON.stringify(path.join(place.app, "facilitator"))})`,
    "spec = importlib.util.spec_from_loader(loader.name, loader)",
    "cli = importlib.util.module_from_spec(spec)",
    "loader.exec_module(cli)",
    "cli.open_app = lambda cfg, dry: None",
    ...lines,
  ].join("\n");
  const { stdout } = await execFileAsync(box.PYTHON, ["-c", code], { cwd: place.app, env: box.env(place), timeout: 90000 });
  return stdout.split("\n").filter(Boolean);
}

async function ready(page) {
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState,
                             { timeout: 20000 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
  await settled(page);
}

async function settled(page) {
  await page.waitForFunction(() => !globalThis.boardSettings || !boardSettings.busy, { timeout: 10000 });
  await new Promise(resolve => setTimeout(resolve, 300));
}

// what the board page shows, in stage pixels, and the settings it runs on
async function boardFacts(page) {
  return page.evaluate(ids => {
    const stage = document.getElementById("stage").getBoundingClientRect();
    const scale = stage.width / 1440;
    const round = v => Math.round(v * 100) / 100;
    const regions = {};
    for (const id of ids) {
      const el = document.querySelector(id === "main" ? "main" : "#" + id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      regions[id] = { hidden: el.classList.contains("region-off"),
                      x: round((r.x - stage.x) / scale), y: round((r.y - stage.y) / scale),
                      w: round(r.width / scale), h: round(r.height / scale) };
    }
    return { regions,
             paper: document.body.style.getPropertyValue("--paper"),
             picker: document.getElementById("bgpick").value,
             tocw: document.documentElement.style.getPropertyValue("--tocw"),
             format: ComposeFormat.enabled(),
             formatSwitch: document.getElementById("setformat").checked };
  }, REGIONS);
}

async function typedFacts(page) {
  return page.evaluate(() => ({
    tasks: docTasks.load("facilitator"),
    // the task headings drawn in the document flow
    headings: [...document.querySelectorAll(".doctask")].map(h => h.textContent.trim()),
    paper: document.body.style.getPropertyValue("--paper"),
    tocw: document.documentElement.style.getPropertyValue("--tocw"),
    format: ComposeFormat.enabled(),
  }));
}

// the typed page draws each card's folder line from its second reading on,
// so it is given two before anything is compared or pictured
async function openTyped(page, origin) {
  await page.goto(origin + "/page", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState && typeof docTasks === "object", { timeout: 20000 });
  await settled(page);
  await new Promise(resolve => setTimeout(resolve, 2600));
}

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (let attempt = 0; attempt < 100 && !base; attempt++) {
    const candidate = await box.freePortPair();
    const free = await Promise.all([0, 1, 2, 3].map(n => new Promise(resolve => {
      const probe = require("node:net").createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate + n, "127.0.0.1", () => probe.close(() => resolve(true)));
    })));
    if (free.every(Boolean)) base = candidate;
  }
  place = box.sandbox("settings-move", { config: { port: base }, seed: {
    title: "settings move board",
    items: [
      { id: "0", bucket: "meta", title: "Plan the move", owner: "facilitator" },
      { id: "1", bucket: "meta", title: "Try the board at its new address", owner: "facilitator" },
    ],
  } });
  fs.cpSync(path.join(box.ROOT, "assets"), path.join(place.app, "assets"), { recursive: true });
  assert.deepEqual(await cli(["cli.cmd_run(['run'])"]), [`Board up on http://127.0.0.1:${base}`, "Facilitator is live!"]);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "facilitator-settings-move-profile-"));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile,
    args: ["--no-first-run", "--disable-background-networking", "--no-sandbox"] });
});

after(async () => {
  if (browser) await browser.close();
  if (other) await new Promise(resolve => other.close(resolve));
  if (place) await box.cleanup(place);
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

test("a board arranged on one port shows the same at the port it moved to, from an empty browser", async () => {
  const oldOrigin = `http://127.0.0.1:${base}`;
  // the older browser: its own storage holds this board's settings from before
  const page = await browser.newPage();
  await page.setViewport(VIEW);
  await page.evaluateOnNewDocument(entries => {
    if (location.pathname !== "/" || sessionStorage.getItem("planted")) return;
    sessionStorage.setItem("planted", "1");
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, OLD);
  await page.goto(oldOrigin + "/", { waitUntil: "domcontentloaded" });
  await ready(page);
  const copied = (await (await fetch(oldOrigin + "/settings")).json()).values;
  for (const key of Object.keys(OLD).filter(k => !k.startsWith("spot.")))
    assert.equal(copied[key], OLD[key], `the one-time copy did not hand over ${key}`);

  // and the rest arranged live, through the page's own controls
  const clock = await page.$eval("#clockbox", el => { const r = el.getBoundingClientRect(); return { x: r.x + 30, y: r.y + 20 }; });
  await page.keyboard.down("Alt");
  await page.mouse.move(clock.x, clock.y);
  await page.mouse.down();
  await page.mouse.move(clock.x + 150, clock.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.click("#editbtn");
  await page.waitForSelector('.rkill[data-region="magic1"]', { visible: true });
  await page.click('.rkill[data-region="magic1"]');
  await page.click("#editbtn");
  await page.$eval("#bgpick", el => { el.value = "#e9efe4"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click("#setbtn");
  await page.waitForSelector(".sp-veil.open");
  await page.click('.sp-item[data-section="editor"]');
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.click("#setformat");
  await page.keyboard.press("Escape");
  await settled(page);
  const before = await boardFacts(page);
  assert.equal(before.regions.magic1.hidden, true, "the cross did not put magic box 1 away");
  assert.equal(before.regions.magic2.hidden, false);
  assert.equal(before.paper, "#e9efe4");
  assert.equal(before.format, true);
  const dragged = JSON.parse((await (await fetch(oldOrigin + "/settings")).json()).values["pos.facilitator.clockbox"]);
  assert.ok(dragged.x > 100, "the drag did not reach the board: " + JSON.stringify(dragged));
  await page.screenshot({ path: path.join(SHOTS, `board-before-move-port-${base}.png`) });

  // the typed page, same address, same browser: one more task heading typed
  await openTyped(page, oldOrigin);
  await page.click("#docnew");
  await page.keyboard.type("task Ship the settings");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => docTasks.load("facilitator").length === 2, { timeout: 10000 });
  await settled(page);
  const typedBefore = await typedFacts(page);
  assert.deepEqual(typedBefore.tasks.map(t => t.title), ["task Plan the move", "task Ship the settings"]);
  assert.deepEqual(typedBefore.headings, ["task Plan the move", "task Ship the settings"], "the headings are not drawn");
  await page.screenshot({ path: path.join(SHOTS, `typed-page-before-move-port-${base}.png`) });
  const keptBefore = (await (await fetch(oldOrigin + "/settings")).json()).values;
  await page.close();

  // something else takes the port while the board is down; run moves it
  process.kill(JSON.parse(fs.readFileSync(path.join(place.app, "server.lock"), "utf8")).pid, "SIGTERM");
  await box.waitFree(base);
  other = http.createServer((req, res) => res.end("another program")).listen(base, "127.0.0.1");
  await new Promise(resolve => other.once("listening", resolve));
  const said = await cli(["cli.cmd_run(['run'])"]);
  const moved = base + 2;
  assert.equal(said[0], `Board moved to port ${moved}: something else is using ${base} or ${base + 1}. ` +
                        `It stays on ${moved}, and run.config.json now says so.`);
  const newOrigin = `http://127.0.0.1:${moved}`;

  // a browser profile with nothing in it, at the new address
  const fresh = await browser.createBrowserContext();
  const page2 = await fresh.newPage();
  await page2.setViewport(VIEW);
  await page2.goto(newOrigin + "/", { waitUntil: "domcontentloaded" });
  await ready(page2);
  const after = await boardFacts(page2);
  assert.deepEqual(after, before, "the board at the new address does not show what was arranged at the old one");
  const local = await page2.evaluate(() => Object.keys(localStorage));
  assert.ok(!local.some(k => /^(pos|size|hide|show)\.|^(bgcolor|tocw|composeformat|doc\.tasks)/.test(k)),
            "the new address read settings out of its own browser storage: " + local.join(", "));
  // the Spotify sign-in came with the board, and the return address follows it
  await page2.evaluate(() => spotLoaded);
  const spot = await page2.evaluate(() => ({ refresh: spotSession.refresh, redirect: SPOT_REDIRECT }));
  assert.deepEqual(spot, { refresh: "RT-old-browser", redirect: newOrigin + "/" });
  await page2.screenshot({ path: path.join(SHOTS, `board-after-move-port-${moved}.png`) });

  await openTyped(page2, newOrigin);
  const typedAfter = await typedFacts(page2);
  assert.deepEqual(typedAfter, typedBefore, "the typed page at the new address differs");
  await page2.screenshot({ path: path.join(SHOTS, `typed-page-after-move-port-${moved}.png`) });
  assert.deepEqual((await (await fetch(newOrigin + "/settings")).json()).values, keptBefore);
  fs.writeFileSync(path.join(SHOTS, "facts.json"), JSON.stringify({ base, moved, said, before, after, typedBefore, typedAfter }, null, 2));
  await fresh.close();
});
