// The phone page's two drawers answer the keyboard: command+shift+comma shuts and
// opens the card list, command+shift+period the settings, from the card or from
// inside the composer; with the card list out, up and down walk its tickets one
// at a time (browsing each card, as left and right do), Enter picks the card the
// lifted ticket is on and shuts the drawer, and Escape shuts it and leaves the
// card browsed. while a drawer is out the old bindings do not reach the card.
//
// Headless, a real keyboard through puppeteer. The board is invented and lives in
// a temp directory; nothing here touches the real board or port 8877.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const SHOTS = process.env.DRAWER_KEYS_SHOTS || "";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const COPIED = ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                "index.html", "page.html"];

let browser = null;
let child = null;
let fixtureDir = "";
let origin = "";
const ids = { doing: [], deferred: [], done: [] };

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

const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function card(title, reply) {
  const made = await api("/create?owner=facilitator", title);
  assert.equal(made.status, 200);
  if (reply) await api(`/reply?box=${made.body.id}`, reply);
  return made.body.id;
}

async function openPhone(id) {
  const page = await browser.newPage();
  const problems = [];
  await page.setViewport(PHONE);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); localStorage.setItem("composeformat", "0"); } catch (error) {}
  });
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push("console: " + message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.goto(origin + "/m?box=" + id, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 8000 });
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 8000 });
  await settle(400);
  return { page, problems };
}

const read = page => page.evaluate(() => ({
  drawer: drawerOpen(),
  settings: document.getElementById("settings").classList.contains("open"),
  selected: selectedId,
  browsing,
  menuOut: document.body.classList.contains("menuout"),
  on: drawerRows().filter(r => r.classList.contains("on")).map(r => r.dataset.id),
  seen: [...document.querySelectorAll("#tiklist .trow.seen")].map(r => r.dataset.id),
  focus: document.activeElement ? document.activeElement.tagName : null,
  scale: document.getElementById("page").style.getPropertyValue("--page-scale"),
}));

const rows = page => page.evaluate(() => drawerRows().map(r => r.dataset.id));

async function press(page, ...keys) {
  for (const key of keys) {
    await page.keyboard.press(key);
    await settle(120);
  }
}

async function chord(page, code, modifiers = ["Meta", "Shift"], wait = 700) {
  for (const m of modifiers) await page.keyboard.down(m);
  await page.keyboard.press(code);
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m);
  await settle(wait);
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-drawer-keys-"));
  await mkdir(path.join(fixtureDir, "logs"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "fixture server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of COPIED) await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "drawer keys fixture",
    items: [{ id: "0", bucket: "meta", title: "A standing card", owner: "facilitator", context: "Invented content." }],
  }));

  origin = "http://127.0.0.1:" + port;
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
  }
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("fixture server exited:\n" + output);
    try { if ((await fetch(origin + "/state")).ok) { ready = true; break; } } catch (error) {}
    await settle(25);
  }
  if (!ready) throw new Error("fixture server did not start:\n" + output);

  for (let n = 1; n <= 16; n++) ids.doing.push(await card("Doing ticket " + n, "A reply to read " + n + "."));
  for (let n = 1; n <= 3; n++) {
    const id = await card("Deferred ticket " + n, "A reply to read.");
    await api(`/park?box=${id}&v=1`);
    ids.deferred.push(id);
  }
  for (let n = 1; n <= 3; n++) {
    const id = await card("Done ticket " + n, "A reply to read.");
    await api(`/done?box=${id}&v=1`);
    ids.done.push(id);
  }

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- the two keys ------------------------------------------------------------------

test("command+shift+comma opens and shuts the card list, from the card and from the composer", async () => {
  const { page, problems } = await openPhone(ids.doing[5]);
  try {
    let s = await read(page);
    assert.equal(s.drawer, false);
    await chord(page, "Comma");
    s = await read(page);
    assert.equal(s.drawer, true, "the key did not open the card list");
    assert.equal(s.settings, false);
    assert.equal(s.menuOut, true);
    await shot(page, "cards-open-from-card");
    await chord(page, "Comma");
    s = await read(page);
    assert.equal(s.drawer, false, "the key did not shut the card list");
    assert.equal(s.menuOut, false);
    assert.equal(Number(s.scale), 1, "the page did not come back to full size");

    await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
    await page.keyboard.type("half a thought");
    await settle(120);
    assert.equal((await read(page)).focus, "TEXTAREA");
    await chord(page, "Comma");
    s = await read(page);
    assert.equal(s.drawer, true, "the key did nothing from inside the composer");
    assert.notEqual(s.focus, "TEXTAREA", "the caret stayed in the composer under the open list");
    assert.equal(await page.evaluate(() => els[selectedId].ta.value), "half a thought", "the key typed into the composer");
    await shot(page, "cards-open-from-composer");
    await chord(page, "Comma");
    assert.equal((await read(page)).drawer, false);
    assert.equal(await page.evaluate(() => els[selectedId].ta.value), "half a thought");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("command+shift+period opens and shuts the settings, from the card and from the composer", async () => {
  const { page, problems } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Period");
    let s = await read(page);
    assert.equal(s.settings, true, "the key did not open the settings");
    assert.equal(s.drawer, false);
    await shot(page, "settings-open-from-card");
    await chord(page, "Period");
    s = await read(page);
    assert.equal(s.settings, false, "the key did not shut the settings");
    assert.equal(s.menuOut, false);

    await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
    await page.keyboard.type("words");
    await chord(page, "Period");
    s = await read(page);
    assert.equal(s.settings, true, "the key did nothing from inside the composer");
    assert.notEqual(s.focus, "TEXTAREA");
    assert.equal(await page.evaluate(() => els[selectedId].ta.value), "words");
    await chord(page, "Period");
    assert.equal((await read(page)).settings, false);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("one drawer swaps for the other, and never both are out", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    await chord(page, "Period");
    let s = await read(page);
    assert.deepEqual([s.drawer, s.settings, s.menuOut], [false, true, true], "settings did not take the place of the list");
    assert.equal(Number(s.scale), 0.985, "the page is not drawn back for the one menu that is out");
    await chord(page, "Comma");
    s = await read(page);
    assert.deepEqual([s.drawer, s.settings, s.menuOut], [true, false, true], "the list did not take the place of settings");
    await chord(page, "Comma");
    s = await read(page);
    assert.deepEqual([s.drawer, s.settings, s.menuOut], [false, false, false]);
  } finally { await page.close(); }
});

test("the keys match the physical comma and period, whatever the page is told the key is", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    const send = (code, key, extra = {}) => page.evaluate((c, k, x) => {
      const e = new KeyboardEvent("keydown", { code: c, key: k, metaKey: true, shiftKey: true, bubbles: true, cancelable: true, ...x });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }, code, key, extra);
    for (const key of ["<", ",", "Dead"]) {
      assert.equal(await send("Comma", key), true, `Comma reading ${key} was not taken`);
      assert.equal((await read(page)).drawer, true);
      await send("Comma", key);
      assert.equal((await read(page)).drawer, false);
    }
    for (const key of [">", ".", "Dead"]) {
      assert.equal(await send("Period", key), true, `Period reading ${key} was not taken`);
      assert.equal((await read(page)).settings, true);
      await send("Period", key);
      assert.equal((await read(page)).settings, false);
    }
    // a held key does not flutter the drawer, and other modifiers are not the chord
    await send("Comma", "<", { repeat: true });
    assert.equal((await read(page)).drawer, false, "a repeat opened the list");
    for (const x of [{ ctrlKey: true }, { altKey: true }, { metaKey: false }, { shiftKey: false }]) {
      assert.equal(await send("Comma", ",", x), false, JSON.stringify(x) + " counted as the chord");
      assert.equal(await send("Period", ".", x), false, JSON.stringify(x) + " counted as the chord");
    }
    const s = await read(page);
    assert.deepEqual([s.drawer, s.settings], [false, false]);
    // the keys typed alone are the caret's
    await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
    await page.keyboard.type(",.<>");
    assert.equal(await page.evaluate(() => els[selectedId].ta.value), ",.<>");
    assert.deepEqual(await read(page).then(r => [r.drawer, r.settings]), [false, false]);
  } finally { await page.close(); }
});

// ---- walking the list ---------------------------------------------------------------

test("up and down walk the Doing tickets in the order the list shows, browsing each, stopping at the ends", async () => {
  const { page, problems } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    const list = await rows(page);
    assert.equal(list.length, 17, "the list does not hold the sixteen doing cards and the standing card");
    for (const id of ids.doing) assert.ok(list.includes(id), id + " is not in the list");
    assert.deepEqual(list, await page.evaluate(() => viewPool(lastState).map(b => b.id)),
      "the rows are not in the order the list is drawn from");
    let at = list.indexOf(ids.doing[5]);
    let s = await read(page);
    assert.deepEqual(s.on, [ids.doing[5]], "the shown card's ticket does not hold the lift");

    await press(page, "ArrowDown");
    at += 1;
    s = await read(page);
    assert.equal(s.selected, list[at], "down did not show the next card");
    assert.equal(s.browsing, true, "a step selected the card instead of browsing it");
    assert.deepEqual(s.on, [list[at]], "the lift did not move with the card");
    assert.equal(s.drawer, true, "a step shut the drawer");
    assert.equal(s.seen.includes(list[at]), false, "a step marked the card read");
    assert.equal(await page.evaluate(id => document.getElementById("box-" + id).classList.contains("sel"), list[at]), true);

    await press(page, "ArrowUp", "ArrowUp");
    at -= 2;
    s = await read(page);
    assert.equal(s.selected, list[at]);
    assert.deepEqual(s.on, [list[at]]);

    // all the way up, then once more: it stops
    for (let n = 0; n < 20; n++) await press(page, "ArrowUp");
    s = await read(page);
    assert.equal(s.selected, list[0], "up did not stop at the first ticket");
    assert.deepEqual(s.on, [list[0]]);
    const inView = () => page.evaluate(() => {
      const row = document.querySelector("#tiklist .trow.on");
      const pane = row.closest(".tikpane");
      const r = row.getBoundingClientRect(), p = pane.getBoundingClientRect();
      return { top: r.top - p.top, bottom: p.bottom - r.bottom, scrollTop: pane.scrollTop };
    });
    let v = await inView();
    assert.ok(v.top >= -1 && v.bottom >= -1, "the first ticket is out of view");
    assert.equal(v.scrollTop, 0);
    await shot(page, "walk-top");

    for (let n = 0; n < 20; n++) await press(page, "ArrowDown");
    s = await read(page);
    const last = list.length - 1;
    assert.equal(s.selected, list[last], "down did not stop at the last ticket");
    assert.deepEqual(s.on, [list[last]]);
    v = await inView();
    assert.ok(v.top >= -1 && v.bottom >= -1, "the last ticket is out of view: " + JSON.stringify(v));
    assert.ok(v.scrollTop > 0, "the list did not scroll to the last ticket");
    assert.ok(v.bottom >= 8, "the last ticket sits on the pane's edge, so its shadow is cut: " + JSON.stringify(v));
    await shot(page, "walk-bottom");

    // midway: one step at a time keeps the lifted ticket in view, clear of the edges
    for (let n = 0; n < 8; n++) {
      await press(page, "ArrowUp");
      v = await inView();
      assert.ok(v.top >= 8 && v.bottom >= 8, "a ticket stepped to from below sits on the pane's edge: " + JSON.stringify(v));
    }
    assert.equal((await read(page)).selected, list[last - 8]);
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("the Deferred and Done lists walk the same way, in their own order", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    for (const [view, group] of [["deferred", ids.deferred], ["done", ids.done]]) {
      await page.evaluate(v => document.getElementById("tv-" + v).click(), view);
      await settle(500);
      const list = await rows(page);
      assert.deepEqual([...list].sort(), [...group].sort(), view + " list holds other cards");
      assert.deepEqual(list, await page.evaluate(() => viewPool(lastState).map(b => b.id)));
      // the card on screen is a doing card, so there is no lifted ticket in this list yet
      assert.deepEqual((await read(page)).on, []);
      await press(page, "ArrowDown");
      let s = await read(page);
      assert.equal(s.selected, list[0], view + ": down from outside the list did not start at the top");
      assert.deepEqual(s.on, [list[0]]);
      await press(page, "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
      s = await read(page);
      assert.equal(s.selected, list[list.length - 1], view + ": down did not stop at the last ticket");
      await press(page, "ArrowUp");
      assert.equal((await read(page)).selected, list[list.length - 2]);
      await shot(page, "walk-" + view);
    }
  } finally { await page.close(); }
});

test("up from a card that is not in the open list starts at the last ticket", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    await page.evaluate(() => document.getElementById("tv-done").click());
    await settle(500);
    await press(page, "ArrowUp");
    const list = await rows(page);
    assert.equal((await read(page)).selected, list[list.length - 1]);
  } finally { await page.close(); }
});

test("with the drawer shut, plain up and down are not the list's", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    const before = await read(page);
    await press(page, "ArrowDown", "ArrowUp");
    const after = await read(page);
    assert.equal(after.selected, before.selected);
    assert.equal(after.drawer, false);
    const taken = await page.evaluate(() => {
      const e = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    assert.equal(taken, false, "the page cancelled a plain arrow with no drawer out");
  } finally { await page.close(); }
});

// ---- Enter and Escape ---------------------------------------------------------------

test("Enter picks the card the lifted ticket is on, reads it, and shuts the drawer", async () => {
  const { page, problems } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    const list = await rows(page);
    const at = list.indexOf(ids.doing[5]);
    await press(page, "ArrowDown", "ArrowDown");
    let s = await read(page);
    assert.equal(s.selected, list[at + 2]);
    assert.equal(s.browsing, true);
    assert.equal(s.seen.includes(list[at + 2]), false);
    await press(page, "Enter");
    s = await read(page);
    assert.equal(s.drawer, false, "Enter did not shut the drawer");
    assert.equal(s.selected, list[at + 2], "Enter moved off the card the shadow was on");
    assert.equal(s.browsing, false, "Enter did not select the card");
    assert.equal(s.focus, "BODY", "Enter put the caret in a composer");
    assert.equal(await page.evaluate(id => {
      return document.querySelector(`#tiklist .trow[data-id="${id}"]`).classList.contains("seen");
    }, list[at + 2]), true, "the picked card did not count as read");
    await shot(page, "enter-landed");
    assert.deepEqual(problems, []);
  } finally { await page.close(); }
});

test("Enter in the list, on a card already selected, shuts the drawer and changes nothing else", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    await press(page, "Enter");
    const s = await read(page);
    assert.equal(s.drawer, false);
    assert.equal(s.selected, ids.doing[5]);
  } finally { await page.close(); }
});

test("Enter with no lifted ticket in the open list only shuts the drawer", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    await page.evaluate(() => document.getElementById("tv-done").click());
    await settle(500);
    await press(page, "Enter");
    const s = await read(page);
    assert.equal(s.drawer, false);
    assert.equal(s.selected, ids.doing[5]);
  } finally { await page.close(); }
});

test("Escape shuts the drawer and leaves the card as it was, browsed", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await chord(page, "Comma");
    const list = await rows(page);
    const at = list.indexOf(ids.doing[5]);
    await press(page, "ArrowUp");
    await press(page, "Escape");
    const s = await read(page);
    assert.equal(s.drawer, false, "Escape did not shut the drawer");
    assert.equal(s.selected, list[at - 1], "Escape moved the card");
    assert.equal(s.browsing, true, "Escape selected the card");
    assert.deepEqual(s.on, [list[at - 1]]);
    await shot(page, "escape-closed");
  } finally { await page.close(); }
});

test("Escape on the first press shuts a drawer and does not also unselect the card", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await page.evaluate(() => els[selectedId].ta.focus({ preventScroll: true }));
    await chord(page, "Comma");
    await press(page, "Escape");
    const s = await read(page);
    assert.equal(s.drawer, false);
    assert.equal(s.browsing, false, "the same Escape unselected the card behind the drawer");
    assert.equal(s.selected, ids.doing[5]);
  } finally { await page.close(); }
});

test("Escape shuts the settings too", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    const was = await read(page);
    await chord(page, "Period");
    await press(page, "Escape");
    const s = await read(page);
    assert.deepEqual([s.settings, s.drawer, s.menuOut], [false, false, false]);
    assert.equal(s.browsing, was.browsing, "the Escape that shut the settings also acted on the card");
    assert.equal(s.selected, was.selected);
  } finally { await page.close(); }
});

// ---- what stays off while a drawer is out -----------------------------------------------

const SPIED = ["stepCard", "histStep", "createCard", "phoneAdvance", "pickRandomCard", "responseScrollKey",
               "phoneSectionMove", "unfoldSelected", "unselectShown", "setTab"];

async function spy(page) {
  await page.evaluate(names => {
    window.__calls = [];
    for (const name of names) {
      const real = window[name];
      window[name] = function () { window.__calls.push(name); return name === "pickRandomCard" ? null : undefined; };
      window[name].real = real;
    }
  }, SPIED);
}

const calls = page => page.evaluate(() => { const c = window.__calls; window.__calls = []; return c; });

const OLD_KEYS = [
  ["ArrowRight", []], ["ArrowLeft", []],
  ["ArrowRight", ["Control", "Shift"]], ["ArrowUp", ["Control", "Shift"]],
  ["KeyT", ["Meta"]], ["Digit1", ["Meta"]], ["Enter", ["Control"]], ["KeyR", ["Control"]], ["KeyS", ["Control"]],
  ["KeyU", ["Control"]], ["BracketLeft", []],
];

test("the old bindings reach the card with no drawer out, and none of them does with one out", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); });
    await spy(page);
    for (const [code, modifiers] of OLD_KEYS) await chord(page, code, modifiers, 120);
    await press(page, "Escape");
    const reached = new Set(await calls(page));
    for (const name of SPIED)
      assert.ok(reached.has(name), name + " was never reached with no drawer out, so this test proves nothing");

    for (const key of ["Comma", "Period"]) {
      await chord(page, key);
      await calls(page);
      for (const [code, modifiers] of OLD_KEYS) await chord(page, code, modifiers, 120);
      assert.deepEqual(await calls(page), [], "a key reached the card behind the open " + key);
      assert.equal((await read(page)).selected, ids.doing[5]);
      await chord(page, key);
    }
  } finally { await page.close(); }
});

test("a drawer left open takes no typing for the card behind it", async () => {
  const { page } = await openPhone(ids.doing[5]);
  try {
    const stays = (panel) => page.evaluate(sel => !!document.activeElement.closest(sel), panel);
    for (const [key, panel] of [["Comma", "#drawer"], ["Period", "#settings"]]) {
      await chord(page, key);
      await page.keyboard.type("abc");
      assert.equal(await page.evaluate(() => els[selectedId].ta.value), "", "words reached the composer under " + panel);
      for (let n = 0; n < 60; n++) {
        await page.keyboard.press("Tab");
        assert.equal(await stays(panel), true, "Tab " + (n + 1) + " left " + panel);
      }
      for (let n = 0; n < 60; n++) {
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
        assert.equal(await stays(panel), true, "Shift+Tab " + (n + 1) + " left " + panel);
      }
      await page.keyboard.type("def");
      assert.equal(await page.evaluate(() => els[selectedId].ta.value), "", "words reached the composer under " + panel);
      await chord(page, key);
    }
  } finally { await page.close(); }
});
