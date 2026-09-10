// Where the page switcher sits when the window changes shape. It belongs to the
// foot of the workspace and has to stay there: leaving fullscreen for a smaller
// window, resizing again and again, and adding, switching or deleting a page
// after any of that. The rule this covers used to hop the switcher up by
// whatever it took to clear the card under it, so a window short enough for the
// card to reach the foot threw the switcher to the top of the screen. Every
// case below samples through the change rather than looking once when it is
// over, because a seat that is wrong only while the window is settling is still
// wrong on the screen.
const assert = require("node:assert/strict");
const { after, before, beforeEach, test } = require("node:test");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { copyFile, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// tall enough to hold the whole 1440x900 stage, which is what the app is drawn for
const BIG = { width: 1440, height: 1000 };
// the shape the complaint came from: a window short enough that the card runs
// past the bottom of it
const SHORT = { width: 1280, height: 800 };
const GAP = 8;   // the number seatPagePill seats against

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

const settle = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));

async function post(route) {
  const response = await fetch(origin + route, { method: "POST" });
  return { status: response.status, body: await response.json() };
}

async function pagesOf(owner) {
  return (await (await fetch(origin + "/state")).json()).pages[owner];
}

async function until(check, ms = 4000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await settle(50);
  }
  throw new Error("the page never got there; last answer " + JSON.stringify(last));
}

// one reading of where the switcher is, and of everything the answer depends on
const SEAT_PROBE = `(() => {
  const el = document.getElementById("pagepill");
  if (!el || el.classList.contains("off")) return null;
  const pill = el.getBoundingClientRect();
  const stage = document.getElementById("stage").getBoundingClientRect();
  const rail = document.getElementById("rail").getBoundingClientRect();
  const card = document.querySelector("main").getBoundingClientRect();
  const foot = Math.min(stage.bottom, innerHeight);
  const hits = o => pill.right > o.left && pill.left < o.right &&
                    pill.bottom > o.top && pill.top < o.bottom;
  return {
    w: innerWidth, h: innerHeight,
    top: +pill.top.toFixed(1), bottom: +pill.bottom.toFixed(1),
    left: +pill.left.toFixed(1), right: +pill.right.toFixed(1),
    height: +pill.height.toFixed(1), width: +pill.width.toFixed(1),
    foot: +foot.toFixed(1), fromFoot: +(foot - pill.bottom).toFixed(1),
    onScreen: pill.top >= 0 && pill.bottom <= innerHeight &&
              pill.left >= 0 && pill.right <= innerWidth,
    lowerHalf: pill.top > innerHeight / 2,
    centred: Math.abs((pill.left + pill.right) / 2 - innerWidth / 2) <= 2,
    onRail: hits(rail), onCard: hits(card),
    // the room the switcher is given at the foot: how far the card and the
    // rail stop short of it. Negative is an overlap
    cardClear: +(pill.top - card.bottom).toFixed(1),
    railClear: +(pill.top - rail.bottom).toFixed(1),
    cardOnScreen: card.top < innerHeight && card.bottom > 0,
    railOnScreen: rail.top < innerHeight && rail.bottom > 0,
    cardHeight: +card.height.toFixed(1),
  };
})()`;

const seat = page => page.evaluate(SEAT_PROBE);

// every frame for a stretch, so a seat that is only wrong while the window
// settles is caught as well as one that is wrong when it stops
async function through(page, ms, act) {
  await page.evaluate(probe => {
    window.__seatWatch = [];
    const tick = () => {
      const s = eval(probe);
      if (s) window.__seatWatch.push(s);
      window.__seatRaf = requestAnimationFrame(tick);
    };
    tick();
  }, SEAT_PROBE);
  if (act) await act();
  await settle(ms);
  const samples = await page.evaluate(() => {
    cancelAnimationFrame(window.__seatRaf);
    const out = window.__seatWatch;
    window.__seatWatch = [];
    return out;
  });
  assert.ok(samples.length > 3, "the watch caught almost no frames: " + samples.length);
  return samples;
}

// the seat contract, in one place
function seated(s, where) {
  assert.ok(s, `${where}: there was no switcher to look at`);
  assert.ok(s.onScreen, `${where}: the switcher left the window ${JSON.stringify(s)}`);
  assert.ok(s.lowerHalf,
    `${where}: the switcher left the lower half of the window ${JSON.stringify(s)}`);
  assert.ok(s.centred, `${where}: the switcher is off centre ${JSON.stringify(s)}`);
  // at the foot means at the foot: on the seat, or at most far enough above it
  // to have stepped over the rail, which is the one strip it steps over
  assert.ok(s.fromFoot >= -2 && s.fromFoot <= s.height + RAIL_H + 2 * GAP + 1,
    `${where}: the switcher is not at the foot of the workspace ${JSON.stringify(s)}`);
  // and the room it is given is real room: neither the card nor the rail is
  // under it, at any window shape and at any frame of a width animation
  assert.equal(s.onCard, false, `${where}: the switcher covers the card ${JSON.stringify(s)}`);
  assert.equal(s.onRail, false, `${where}: the switcher covers the rail ${JSON.stringify(s)}`);
  if (s.cardOnScreen) assert.ok(s.cardHeight >= 150,
    `${where}: the card was squeezed past being a card ${JSON.stringify(s)}`);
}
const RAIL_H = 23;   // the rail's own height, the most the switcher ever steps

const allSeated = (samples, where) => samples.forEach((s, i) => seated(s, `${where} frame ${i}`));

async function openBoard() {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [];
  page.on("console", m => {
    if (m.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(m.text())) return;
    problems.push(m.text());
  });
  page.on("pageerror", e => problems.push("pageerror: " + e.message));
  await page.setViewport(BIG);
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null,
    { timeout: 8000 });
  await settle(500);
  return { page, problems, context };
}

async function addPage(page) {
  await page.click("#pagepill .pageadd");
  await until(async () => (await page.evaluate(() => pageBusy)) === false);
  await settle(350);
}

async function startServer(port) {
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
           FACILITATOR_LOG_DIR: path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", c => { output += c; });
  child.stderr.on("data", c => { output += c; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await settle(40);
  }
  throw new Error(`fixture server did not start:\n${output}`);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-seat-"));
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["index.html", "page.html", "m.html", "m-manifest.json", "m-sw.js",
                      "card-markdown.js", "card-logic.js", "card-report.js", "card-tokens.css"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [
      { id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" },
      { id: "m40", bucket: "meta", title: "Sanding the oar handle", owner: "facilitator" },
      { id: "t0", bucket: "meta", title: "Standing note for the project lane", owner: "pastureland" },
    ],
  }));
  await startServer(port);
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise(r => child.once("exit", r));
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const [owner, list] of Object.entries(
    (await (await fetch(origin + "/state")).json()).pages)) {
    for (const p of list) if (p.id !== "pg1") await post(`/pages/del?owner=${owner}&id=${p.id}`);
  }
});

test("a tall window becoming a short one leaves the switcher at the foot", async () => {
  const { page, problems, context } = await openBoard();
  try {
    seated(await seat(page), "the tall window");
    // the shape the complaint came from: short enough that the card runs past
    // the bottom of the window, which is what the old rule hopped over
    const going = await through(page, 700, () => page.setViewport(SHORT));
    allSeated(going, "shrinking");
    const there = await seat(page);
    seated(there, "the short window");
    assert.ok(there.top > SHORT.height * 0.75,
      "the switcher is nowhere near the foot: " + JSON.stringify(there));

    const back = await through(page, 700, () => page.setViewport(BIG));
    allSeated(back, "growing back");
    seated(await seat(page), "back in the tall window");
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test("many window shapes, and the same shapes again, all seat the same way", async () => {
  const { page, problems, context } = await openBoard();
  const shapes = [
    { width: 1440, height: 1000 }, { width: 1280, height: 800 },
    { width: 1024, height: 760 },  { width: 1600, height: 1200 },
    { width: 1120, height: 900 },  { width: 900,  height: 700 },
    { width: 1440, height: 1000 },
  ];
  try {
    const seen = {};
    for (let round = 0; round < 2; round++) {
      for (const shape of shapes) {
        const samples = await through(page, 420, () => page.setViewport(shape));
        allSeated(samples, `${shape.width}x${shape.height} round ${round}`);
        const rest = await seat(page);
        seated(rest, `${shape.width}x${shape.height} round ${round} at rest`);
        const key = shape.width + "x" + shape.height;
        // the same window shape has to give the same seat every time it comes
        // round, or the switcher is drifting rather than being placed
        if (seen[key] !== undefined) {
          assert.equal(rest.bottom, seen[key],
            `${key} seated differently the second time round`);
        }
        seen[key] = rest.bottom;
      }
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(BIG);
    await context.close();
  }
});

test("fullscreen, entered and left, keeps the switcher at the foot", async () => {
  const { page, problems, context } = await openBoard();
  const notes = {};
  try {
    // the real thing, if this browser will do it. The API needs a gesture, so
    // it is asked for from inside a real click
    await page.evaluate(() => {
      const b = document.createElement("button");
      b.id = "fsprobe";
      b.style.cssText = "position:fixed;left:2px;top:2px;z-index:99999;width:20px;height:20px";
      b.addEventListener("click", () => {
        document.documentElement.requestFullscreen().then(
          () => { window.__fs = "entered"; }, e => { window.__fs = "refused: " + e.name; });
      });
      document.body.appendChild(b);
    });
    await page.click("#fsprobe");
    await settle(700);
    notes.entering = await page.evaluate(() => window.__fs || "no answer");
    notes.reallyFullscreen = await page.evaluate(() => !!document.fullscreenElement);
    if (notes.reallyFullscreen) {
      seated(await seat(page), "in real fullscreen");
      const leaving = await through(page, 800, () => page.evaluate(() => document.exitFullscreen()));
      allSeated(leaving, "leaving real fullscreen");
      seated(await seat(page), "out of real fullscreen");
    }
    await page.evaluate(() => document.getElementById("fsprobe")?.remove());

    // and the event on its own, which is the signal the page actually answers.
    // A window that changes shape and fires this is the reported case; firing
    // it without a resize proves the page does not depend on the resize alone
    const onEvent = await through(page, 500, async () => {
      await page.setViewport(SHORT);
      await page.evaluate(() => document.dispatchEvent(new Event("fullscreenchange")));
    });
    allSeated(onEvent, "on fullscreenchange");
    seated(await seat(page), "after fullscreenchange");

    // the event alone, with no shape change at all, must not move it either
    const bare = await seat(page);
    await page.evaluate(() => document.dispatchEvent(new Event("fullscreenchange")));
    await settle(250);
    assert.equal((await seat(page)).bottom, bare.bottom,
      "a bare fullscreenchange moved the switcher");
    notes.problems = problems;
    assert.deepEqual(problems, []);
  } finally {
    console.log("      fullscreen notes: " + JSON.stringify(notes));
    await page.setViewport(BIG);
    await context.close();
  }
});

test("adding, switching and deleting a page after a resize all keep the foot", async () => {
  const { page, problems, context } = await openBoard();
  try {
    for (const shape of [SHORT, { width: 1024, height: 720 }, BIG]) {
      await page.setViewport(shape);
      await settle(350);
      const adding = await through(page, 700, () => addPage(page));
      allSeated(adding, `adding at ${shape.width}x${shape.height}`);

      const dots = await page.$$("#pagepill .pdot");
      await dots[0].click();
      await settle(350);
      seated(await seat(page), `switching at ${shape.width}x${shape.height}`);

      // and the same after one goes
      const row = await pagesOf("facilitator");
      const doomed = row[row.length - 1].id;
      const at = await page.$$eval("#pagepill .pdot", (ds, id) => {
        const d = ds.find(x => x.dataset.page === id).getBoundingClientRect();
        return { x: d.x + d.width / 2, y: d.y + d.height / 2 };
      }, doomed);
      await page.mouse.click(at.x, at.y, { button: "right" });
      await settle(200);
      await page.click("#pagemenu .pagemenuitem");
      await settle(200);
      await page.click("#pagewarnyes");
      await until(async () => (await pagesOf("facilitator")).length === 1);
      await settle(400);
      seated(await seat(page), `deleting at ${shape.width}x${shape.height}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(BIG);
    await context.close();
  }
});

test("the rail under the card is not covered where there is room to clear it", async () => {
  const { page, problems, context } = await openBoard();
  try {
    let checked = 0;
    for (const shape of [BIG, { width: 1440, height: 960 }, { width: 1120, height: 900 }]) {
      await page.setViewport(shape);
      await settle(400);
      const s = await seat(page);
      seated(s, `${shape.width}x${shape.height}`);
      if (!s.railOnScreen) continue;
      checked++;
      assert.equal(s.onRail, false,
        `the switcher covers the rail at ${shape.width}x${shape.height} ${JSON.stringify(s)}`);
    }
    assert.ok(checked > 0, "no window shape in this run actually showed the rail");
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(BIG);
    await context.close();
  }
});

// the room at the foot is not taken by moving the switcher out of the way, it
// is given by the one region that can reach down there. This is that trade,
// measured: the card gives height back in a window too short to hold it all,
// and takes it straight back when the window can hold it again
test("the card gives up the footer room in a short window and takes it back", async () => {
  const { page, problems, context } = await openBoard();
  try {
    const tall = await seat(page);
    seated(tall, "the tall window");
    const short = await through(page, 600, () => page.setViewport(SHORT));
    allSeated(short, "shrinking");
    const low = await seat(page);
    seated(low, "the short window");
    assert.ok(low.cardHeight < tall.cardHeight,
      `the card kept its whole height in a window that cannot hold it ${JSON.stringify(low)}`);
    assert.ok(low.cardClear >= GAP - 1,
      `the card does not stop short of the switcher ${JSON.stringify(low)}`);
    assert.ok(low.cardHeight > 400,
      `the card gave up far more than the footer room ${JSON.stringify(low)}`);

    const back = await through(page, 600, () => page.setViewport(BIG));
    allSeated(back, "growing back");
    const again = await seat(page);
    assert.equal(again.cardHeight, tall.cardHeight,
      "the card did not take its height back when the window could hold it");
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(BIG);
    await context.close();
  }
});

test("a narrow window keeps the whole switcher inside it", async () => {
  const { page, problems, context } = await openBoard();
  try {
    await addPage(page);
    await addPage(page);
    for (const shape of [{ width: 900, height: 820 }, { width: 760, height: 700 },
                         { width: 640, height: 620 }]) {
      const samples = await through(page, 420, () => page.setViewport(shape));
      allSeated(samples, `${shape.width}x${shape.height}`);
      const s = await seat(page);
      assert.ok(s.left >= 0 && s.right <= shape.width,
        `the switcher hangs out of a ${shape.width}px window ${JSON.stringify(s)}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.setViewport(BIG);
    await context.close();
  }
});
