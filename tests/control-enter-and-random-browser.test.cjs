// Control+Enter and Control+R on the Mac board and the phone page, driven
// headless against their own fixture server. Control+Enter is a double Enter
// pressed at once: it sends what the box holds, then moves to the card that has
// waited longest, and with nothing typed, or outside a box, it only moves.
// Control+R jumps to a random card in the list whose ticket is not green.
// Every landing is read against what a double Enter does on the same board.
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
const DESKTOP = { width: 1440, height: 900 };
const SEL = "article.box.sel textarea";
const STANDING = ["0", "t0"];

let browser;
let child;
let fixtureDir;
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

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const result = await api("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// every card an earlier test left is put out of the doing view, the standing
// card excepted, so each test walks only the cards it made itself
async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked && !STANDING.includes(box.id)) {
      await api(`/park?box=${box.id}&v=1`);
    }
  }
}

// four cards the reader can answer or open, two that Control+R must skip. The
// oldest turn is the one a move has to land on; the source is the newest, where
// the reader types. Done cards are in the list's last section and never green.
async function board(label) {
  await clearLane();
  const ids = {};
  ids.oldest = await create(`${label} oldest waiting`);
  await api(`/reply?box=${ids.oldest}`, "Oldest reply.");
  ids.newer = await create(`${label} newer waiting`);
  await api(`/reply?box=${ids.newer}`, "Newer reply.");
  ids.source = await create(`${label} source`);
  await api(`/reply?box=${ids.source}`, "Source reply.");
  ids.queued = await create(`${label} queued`);
  await api(`/send?box=${ids.queued}`, "A message in line.");
  ids.working = await create(`${label} working`);
  await api(`/working?box=${ids.working}&v=1`);
  ids.done = await create(`${label} done`);
  await api(`/done?box=${ids.done}&v=1`);
  return ids;
}

async function open(viewport) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (err) {} });
  await page.goto(origin + (viewport === PHONE ? "/m" : "/"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function chord(page, key, ...mods) {
  for (const mod of mods) await page.keyboard.down(mod);
  await page.keyboard.press(key);
  for (const mod of [...mods].reverse()) await page.keyboard.up(mod);
}

function watchSends(page) {
  const sends = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/send" && request.method() === "POST") {
      sends.push({ box: url.searchParams.get("box"), via: url.searchParams.get("via"), body: request.postData() });
    }
  });
  return sends;
}

// the card on screen, whether it is selected or only browsed, and whether the
// caret sits in a card's typing row (the plain field or the formatted editor)
function landing(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest ? el.closest("article.box") : null;
    const row = !!el && (el.tagName === "TEXTAREA"
      ? !el.classList.contains("cfmirror")
      : !!(el.closest && el.closest(".cffield")));
    return {
      shown: (document.querySelector("article.box.sel") || {}).id?.replace(/^box-/, "") || null,
      selected: selectedId,
      browsing,
      caretIn: row && box ? box.id.replace(/^box-/, "") : null,
    };
  });
}

async function setEditor(page, on) {
  await page.evaluate(value => ComposeFormat.setEnabled(value), on);
  await page.evaluate(() => ComposeFormat.settled());
  await settle(150);
}

async function selectCard(page, id) {
  await page.waitForFunction(card => !!els[card], { timeout: 5000 }, id);
  await page.evaluate(card => select(card), id);
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
}

// a new card holding an answer to read, the newest turn on the board, becomes
// the source, since the one just typed in is now waiting on the agent
async function rearm(page, ids) {
  ids.source = await create("another source");
  await api(`/reply?box=${ids.source}`, "Another reply.");
  await page.evaluate(() => poll());
  await page.waitForFunction(card => {
    const box = lastState.boxes.find(b => b.id === card);
    return box && box.ball === "you" && !!els[card];
  }, { timeout: 4000 }, ids.source);
  await selectCard(page, ids.source);
}

async function type(page, words) {
  await page.focus(SEL);
  await page.keyboard.type(words);
}

async function noMoveFor(page, id, ms = 900) {
  await settle(ms);
  assert.equal((await landing(page)).selected, id, "the card moved when it should have stayed");
}

// what double Enter does on this board, from the same source with the same words
async function doubleEnterLanding(page, ids, words) {
  await rearm(page, ids);
  await type(page, words);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
  await settle(150);
  return landing(page);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-ctrl-keys-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "compose-format.js", "index.html", "page.html", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  try {
    await copyFile(path.join(ROOT, "card-report.js"), path.join(fixtureDir, "card-report.js"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "run.config.json"), JSON.stringify({ compose_format_default: true }));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "control keys test",
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try {
      const response = await fetch(origin + "/state");
      if (response.ok) { ready = true; break; }
    } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);
  // an untouched standing card is the reader's turn with the oldest stamp, so a
  // move would land on it before any reply. It is answered here and stays in the
  // list, which is where Control+R has to skip it
  assert.equal((await api("/send?box=0", "A note on the standing card.")).status, 200);

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
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

const PAGES = [
  { name: "desktop", viewport: DESKTOP, caretFollows: true },
  { name: "phone", viewport: PHONE, caretFollows: false },
];

for (const { name, viewport, caretFollows } of PAGES) {
  for (const editor of ["formatted", "plain"]) {
    test(`${name} ${editor} row: control+enter with words sends once and lands where double Enter lands`, async () => {
      const ids = await board(`${name} ${editor} words`);
      const { page, problems } = await open(viewport);
      const sends = watchSends(page);
      try {
        await setEditor(page, editor === "formatted");
        await selectCard(page, ids.source);
        await type(page, "words for the agent");
        await chord(page, "Enter", "Control");
        await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
        await settle(250);
        const control = await landing(page);
        assert.equal(sends.length, 1, "control+enter did not send exactly once");
        assert.deepEqual([sends[0].box, sends[0].body], [ids.source, "words for the agent"]);
        assert.equal(control.browsing, false, "control+enter left the card browsed");
        assert.equal(control.shown, ids.oldest);
        assert.equal(control.caretIn, caretFollows ? ids.oldest : null, "the caret did not land as double Enter's does");

        const double = await doubleEnterLanding(page, ids, "words for the double Enter");
        assert.deepEqual(control, double, "control+enter and double Enter landed differently");
        assert.equal(sends.length, 2);
        assert.equal(await page.evaluate(card => els[card].ta.value, ids.source), "", "the sent words stayed in the box");
        assert.deepEqual(problems, []);
      } finally {
        await page.close();
      }
    });
  }

  test(`${name}: control+enter with an empty box, or no box, only moves, as double Enter's second press does`, async () => {
    const ids = await board(`${name} empty`);
    const { page, problems } = await open(viewport);
    const sends = watchSends(page);
    try {
      await selectCard(page, ids.source);
      const double = await doubleEnterLanding(page, ids, "to make the double Enter");
      sends.length = 0;

      await selectCard(page, ids.source);
      await page.focus(SEL);
      await chord(page, "Enter", "Control");
      await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
      await settle(250);
      assert.deepEqual(await landing(page), double, "an empty box's control+enter landed differently from double Enter");

      await selectCard(page, ids.source);
      await page.focus(SEL);
      await page.keyboard.type("   ");
      await chord(page, "Enter", "Control");
      await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
      assert.equal(sends.length, 0, "an empty or blank box sent something");

      await selectCard(page, ids.source);
      assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "a box still held the caret");
      await chord(page, "Enter", "Control");
      await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
      await settle(250);
      const outside = await landing(page);
      assert.equal(outside.browsing, false);
      assert.equal(outside.caretIn, double.caretIn);
      assert.equal(sends.length, 0);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${name}: a held control+enter moves once`, async () => {
    const ids = await board(`${name} held`);
    const { page, problems } = await open(viewport);
    try {
      await selectCard(page, ids.source);
      await page.focus(SEL);
      await page.keyboard.down("Control");
      await page.keyboard.down("Enter");
      await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
      await page.keyboard.down("Enter");
      await page.keyboard.down("Enter");
      await page.keyboard.up("Enter");
      await page.keyboard.up("Control");
      await settle(300);
      assert.equal((await landing(page)).selected, ids.oldest, "a repeat of the held key moved on again");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${name}: with nobody else waiting control+enter sends and stays, and empty it does nothing`, async () => {
    const ids = await board(`${name} alone`);
    await api(`/send?box=${ids.oldest}`, "Answered, so no longer waiting.");
    await api(`/send?box=${ids.newer}`, "Answered, so no longer waiting.");
    const { page, problems } = await open(viewport);
    const sends = watchSends(page);
    try {
      await page.evaluate(() => poll());
      await selectCard(page, ids.source);
      await type(page, "nobody to move to");
      await chord(page, "Enter", "Control");
      await page.waitForFunction(() => document.querySelector("article.box.sel textarea").value === "", { timeout: 3000 });
      await noMoveFor(page, ids.source);
      assert.equal(sends.length, 1);
      await rearm(page, ids);
      await chord(page, "Enter", "Control");
      await noMoveFor(page, ids.source, 400);
      assert.equal(sends.length, 1, "an empty control+enter sent");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${name}: a refused control+enter send keeps the reader on the card`, async () => {
    const ids = await board(`${name} refused`);
    const { page, problems } = await open(viewport);
    try {
      await selectCard(page, ids.source);
      await page.evaluate(() => {
        window.__nativeFetch = window.fetch;
        window.fetch = (...args) => {
          if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
          return Promise.resolve(new Response(JSON.stringify({ error: "refused" }),
            { status: 400, headers: { "Content-Type": "application/json" } }));
        };
      });
      await type(page, "this send is refused");
      await chord(page, "Enter", "Control");
      await settle(1200);
      const at = await landing(page);
      assert.equal(at.selected, ids.source, "a refused send moved the reader away from it");
      if (caretFollows) {
        assert.match(await page.$eval(SEL, field => field.value), /this send is refused/, "the refused words were not given back");
      } else {
        assert.equal(await page.evaluate(card => localSends(card).some(op => op.state === "failed"), ids.source), true,
          "the refused send was not marked");
      }
      await page.evaluate(() => { window.fetch = window.__nativeFetch; });
      assert.deepEqual(problems.filter(problem => !/status of 400/.test(problem)), []);
    } finally {
      await page.close();
    }
  });

  test(`${name}: command+enter sends and stays, shift+enter breaks the line, enter sends and stays, double Enter moves`, async () => {
    const ids = await board(`${name} plain keys`);
    const { page, problems } = await open(viewport);
    const sends = watchSends(page);
    try {
      await selectCard(page, ids.source);
      await type(page, "by command");
      await chord(page, "Enter", "Meta");
      await page.waitForFunction(() => document.querySelector("article.box.sel textarea").value === "", { timeout: 3000 });
      await noMoveFor(page, ids.source);
      assert.deepEqual(sends.map(send => send.body), ["by command"], "command+enter did not send once");

      await rearm(page, ids);
      await type(page, "line one");
      await chord(page, "Enter", "Shift");
      await page.keyboard.type("line two");
      assert.equal(await page.$eval(SEL, field => field.value), "line one\nline two", "shift+enter did not break the line");
      assert.equal(sends.length, 1, "shift+enter sent");
      await page.$eval(SEL, field => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); });

      await rearm(page, ids);
      await type(page, "by enter");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("article.box.sel textarea").value === "", { timeout: 3000 });
      await noMoveFor(page, ids.source);
      assert.deepEqual(sends.map(send => send.body).slice(1), ["by enter"]);

      const double = await doubleEnterLanding(page, ids, "by double Enter");
      assert.equal(double.selected, ids.oldest, "double Enter did not move");
      assert.equal(sends.length, 3);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  for (const editor of ["formatted", "plain"]) {
    test(`${name} ${editor} row: control+r lands on ten random cards, never green, never the one on screen, never a standing box`, async () => {
      const ids = await board(`${name} ${editor} random`);
      const { page, problems } = await open(viewport);
      try {
        await setEditor(page, editor === "formatted");
        await selectCard(page, ids.source);
        await page.evaluate(() => {
          window.__rKeys = [];
          addEventListener("keydown", event => {
            if (event.key === "r") window.__rKeys.push(event.defaultPrevented);
          });
        });
        const pool = await page.evaluate(() => viewPool(lastState).map(b => b.id));
        assert.ok(pool.includes("0"), "the standing card is not in the list, so skipping it proves nothing");
        assert.ok(pool.includes(ids.working), "the green card is not in the list, so skipping it proves nothing");
        const allowed = [ids.oldest, ids.newer, ids.source, ids.queued];
        const landed = [];
        let before = ids.source;
        for (let press = 0; press < 10; press++) {
          if (press % 2) await page.focus(SEL);
          else await page.evaluate(() => document.activeElement && document.activeElement.blur());
          await chord(page, "r", "Control");
          const now = await landing(page);
          assert.notEqual(now.shown, before, `press ${press + 1} stayed on the card on screen`);
          assert.ok(allowed.includes(now.shown), `press ${press + 1} landed on ${now.shown}, which is not an open card`);
          assert.equal(now.browsing, true, `press ${press + 1} selected the card instead of browsing it`);
          assert.equal(now.selected, now.shown);
          landed.push(now.shown);
          before = now.shown;
        }
        assert.ok(new Set(landed).size > 1, "ten presses landed on the same card");
        assert.deepEqual(await page.evaluate(() => window.__rKeys), Array(10).fill(true), "the browser was not stopped");
        assert.deepEqual(problems, []);
      } finally {
        await page.close();
      }
    });
  }

  test(`${name}: control+r does nothing with no open card to go to, and ignores a held key`, async () => {
    const ids = await board(`${name} no card`);
    const { page, problems } = await open(viewport);
    try {
      await selectCard(page, ids.source);
      await page.keyboard.down("Control");
      await page.keyboard.down("r");
      const first = (await landing(page)).shown;
      assert.notEqual(first, ids.source, "the first press did not move");
      await page.keyboard.down("r");
      await page.keyboard.down("r");
      await page.keyboard.up("r");
      await page.keyboard.up("Control");
      await settle(200);
      assert.equal((await landing(page)).shown, first, "the repeat of a held key moved again");

      for (const card of [ids.oldest, ids.newer, ids.queued]) await api(`/park?box=${card}&v=1`);
      await page.evaluate(() => poll());
      const left = [ids.source, ids.working, "0"].sort();
      await page.waitForFunction(
        want => JSON.stringify(viewPool(lastState).map(b => b.id).sort()) === JSON.stringify(want),
        { timeout: 4000 }, left);
      await selectCard(page, ids.source);
      await page.evaluate(() => {
        window.__rSeen = null;
        addEventListener("keydown", event => { if (event.key === "r") window.__rSeen = event.defaultPrevented; });
      });
      await chord(page, "r", "Control");
      const still = await landing(page);
      assert.equal(still.shown, ids.source, "control+r moved with nowhere to go");
      assert.equal(still.browsing, false);
      assert.equal(await page.evaluate(() => window.__rSeen), true, "the key was left to the browser");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

// the small card is hidden in the default layout, so it is shown for this lane
async function showMini(page) {
  await page.evaluate(() => {
    localStorage.setItem("show.facilitator.magic2", "1");
    applySavedLayout();
  });
  await page.waitForFunction(() => !document.getElementById("magic2").classList.contains("region-off"));
  await settle(200);
}

test("desktop small card: control+enter sends from it, hands the keys back and moves the board", async () => {
  const ids = await board("mini");
  const { page, problems } = await open(DESKTOP);
  const sends = watchSends(page);
  try {
    await selectCard(page, ids.source);
    await page.waitForFunction(card => miniOrder.includes(card), { timeout: 5000 }, ids.newer);
    await page.evaluate(card => { miniGo(card); renderMiniCards(lastState); }, ids.newer);
    await showMini(page);
    const field = "#magic2 .mbox:not(.off) textarea";
    await page.click(field);
    await page.keyboard.type("typed in the small card");
    assert.equal(await page.evaluate(() => miniFocused), true);
    await chord(page, "Enter", "Control");
    await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
    await settle(250);
    assert.equal(sends.length, 1);
    assert.deepEqual([sends[0].box, sends[0].via, sends[0].body], [ids.newer, "mini", "typed in the small card"]);
    assert.equal(await page.evaluate(() => miniFocused), false, "the small card kept the keys");
    const at = await landing(page);
    assert.equal(at.browsing, false);
    assert.equal(at.caretIn, ids.oldest);

    // a plain Enter in the small card sends and stays, and an empty one moves
    await selectCard(page, ids.source);
    await page.click(field);
    await page.keyboard.type("only sent");
    await page.keyboard.press("Enter");
    await settle(500);
    assert.equal((await landing(page)).selected, ids.source, "a plain Enter in the small card moved the board");
    assert.equal(sends.length, 2);

    await page.click(field);
    await chord(page, "Enter", "Control");
    await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
    assert.equal(sends.length, 2, "an empty control+enter in the small card sent");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
