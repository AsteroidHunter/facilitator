// The card's own spinner: the | / - \ twin of the green ticket's, in the top bar.
// On both pages it stands in the sun's square, centred on the sun's mark, and
// cross-fades with that mark.
//
// It shows exactly when the card's ticket is green (never on a done or deferred
// card), fades in and out with the board's own fade, turns on the ticket's
// clock, and showing or hiding it moves nothing else on the card. It is sized by
// its own named size, 11px, and the sun, the moon and the cross by the top row's
// mark size, 10px; both names are written once, in the shared sheet.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");
const { REST } = require("./phone-rest-geometry.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const FRAMES = ["|", "/", "-", "\\"];

let browser;
let child;
let fixtureDir;
let origin;

async function api(route, body = "") {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title, owner = "facilitator") {
  const result = await api("/create?owner=" + encodeURIComponent(owner), title);
  assert.equal(result.status, 200);
  return result.body.id;
}

// the card a test before left held by the agent is answered, so the lane is free
// to claim again, and every card it left is put out of the doing view
async function clearLane(owner = "facilitator") {
  const held = ((await (await fetch(origin + "/state")).json()).busy || {})[owner];
  if (held) await api(`/reply?box=${held}`, "Released.");
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === owner && box.bg) await api(`/working?box=${box.id}&v=0`);
    if (box.owner === owner && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// a card with two answered rounds, so it has history and its arrows are drawn
async function answeredCard(title) {
  const id = await create(title);
  for (let round = 1; round <= 2; round++) {
    assert.equal((await api(`/send?box=${id}`, `Owner message ${round}.`)).status, 200);
    assert.equal((await api(`/reply?box=${id}`, `Reply ${round}.\n\n- one point\n- another point`)).status, 200);
  }
  return id;
}

// the agent picks the waiting message up and confirms it: the card turns green
async function claimWaiting(id) {
  const claim = await (await fetch(origin + "/wait?owner=facilitator&timeout=5")).json();
  assert.equal(claim.box, id, "the claim was for another card");
  const ack = await api(`/ack?owner=facilitator&token=${encodeURIComponent(claim.ack)}`);
  assert.equal(ack.status, 200);
}

async function turnGreen(id) {
  assert.equal((await api(`/send?box=${id}`, "Please do more.")).status, 200);
  await claimWaiting(id);
}

async function reply(id) {
  assert.equal((await api(`/reply?box=${id}`, "Here is the answer.")).status, 200);
}

function installSampler() {
  window.__seatSamples = [];
  const tick = () => {
    const seat = document.querySelector("article.box.sel .cardspin");
    const sun = document.querySelector("article.box.sel .sunbtn");
    if (seat && sun) {
      window.__seatSamples.push({
        t: performance.now(),
        opacity: Number(getComputedStyle(seat).opacity),
        on: seat.classList.contains("on"),
        sunMark: Number(getComputedStyle(sun.querySelector("svg")).opacity),
        sunButton: Number(getComputedStyle(sun).opacity),
      });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// the bar on either page, in the page's design px: the spinner stands in the
// sun's square, so its box is read against the sun's mark, the other marks and
// the squares' own size, each named size read through a probe
function readBar() {
  const box = document.querySelector("article.box.sel");
  const stage = document.getElementById("stage");
  const scale = stage ? stage.getBoundingClientRect().width / stage.offsetWidth : 1;
  const bar = box.querySelector(".topbar");
  const seat = box.querySelector(".cardspin");
  const sun = box.querySelector(".sunbtn");
  const dock = box.querySelector(".dockbtn");
  const moon = box.querySelector(".arcbtn");
  const cross = box.querySelector(".xbtn");
  const mark = sun.querySelector("svg");
  const named = {};
  for (const [key, name] of [["square", "--bar-sq"], ["mark", "--bar-mark"], ["spinner", "--cardspin-s"]]) {
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute; visibility:hidden; width:var(${name})`;
    bar.appendChild(probe);
    named[key] = parseFloat(getComputedStyle(probe).width);
    probe.remove();
  }
  const centre = r => [(r.left + r.right) / 2, (r.top + r.bottom) / 2];
  const seatRect = seat.getBoundingClientRect(), markRect = mark.getBoundingClientRect(), sunRect = sun.getBoundingClientRect();
  const moonRect = moon.querySelector("svg").getBoundingClientRect();
  const before = getComputedStyle(seat, "::before");
  const line = getComputedStyle(cross, "::before");
  const squares = [...box.querySelectorAll(".histbtn"), sun, dock, moon, cross]
    .map(el => { const r = el.getBoundingClientRect(); return [r.width / scale, r.height / scale]; });
  return {
    named,
    squares,
    order: [...bar.children].map(c => String(c.className).split(" ")[0]),
    hasRun: !!box.querySelector(".histrun"),
    spinnerWidth: parseFloat(before.width),
    spinnerHeight: parseFloat(before.height),
    spinnerFont: parseFloat(before.fontSize),
    markWidth: markRect.width / scale,
    markHeight: markRect.height / scale,
    dockWidth: dock.querySelector("svg").getBoundingClientRect().width / scale,
    dockHeight: dock.querySelector("svg").getBoundingClientRect().height / scale,
    moonWidth: moonRect.width / scale,
    moonHeight: moonRect.height / scale,
    crossLength: parseFloat(line.width),
    crossThickness: parseFloat(line.height),
    seatOffset: [(centre(seatRect)[0] - centre(markRect)[0]) / scale, (centre(seatRect)[1] - centre(markRect)[1]) / scale],
    inSun: seatRect.left >= sunRect.left - 0.01 && seatRect.right <= sunRect.right + 0.01 &&
      seatRect.top >= sunRect.top - 0.01 && seatRect.bottom <= sunRect.bottom + 0.01,
    color: getComputedStyle(seat).color,
    titleColor: getComputedStyle(box.querySelector(".title")).color,
  };
}

// every rect in the bar and the title, in screen px
function readPositions() {
  const box = document.querySelector("article.box.sel");
  const rect = el => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const buttons = [...box.querySelectorAll(".histbtn")];
  return {
    topbar: rect(box.querySelector(".topbar")),
    histctl: rect(box.querySelector(".histctl")),
    olderBtn: rect(buttons[0]),
    newerBtn: rect(buttons[1]),
    sun: rect(box.querySelector(".sunbtn")),
    sunMark: rect(box.querySelector(".sunbtn svg")),
    arc: rect(box.querySelector(".arcbtn")),
    x: rect(box.querySelector(".xbtn")),
    title: rect(box.querySelector(".title")),
  };
}

// every element of the card and of the ticket list except the spinner itself
function readEverything() {
  const roots = ["article.box.sel", "#tiklist"].map(sel => document.querySelector(sel)).filter(Boolean);
  const out = [];
  for (const root of roots) {
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (el.closest(".cardspin")) continue;
      const r = el.getBoundingClientRect();
      out.push([el.tagName + "." + String(el.className), r.left, r.top, r.right, r.bottom]);
    }
  }
  return out;
}

function moved(before, after, keys = Object.keys(before)) {
  const out = [];
  for (const key of keys) {
    before[key].forEach((value, i) => { if (Math.abs(value - after[key][i]) > 0.01) out.push(`${key}[${i}] ${value} -> ${after[key][i]}`); });
  }
  return out;
}

function movedEverything(before, after) {
  if (before.length !== after.length) return [`element count ${before.length} -> ${after.length}`];
  const out = [];
  before.forEach((row, i) => {
    for (let k = 1; k <= 4; k++) if (Math.abs(row[k] - after[i][k]) > 0.01) { out.push(`${row[0]} edge ${k}: ${row[k]} -> ${after[i][k]}`); break; }
  });
  return out;
}

// what the card's spinner and its ticket say, and what the shared rule says
function readSeat(id) {
  const el = els[id];
  const box = lastState.boxes.find(b => b.id === id);
  const row = [...document.querySelectorAll("#tiklist .trow")].find(r => r.dataset && r.dataset.id === id);
  return {
    on: !!el && el.cardSpin.classList.contains("on"),
    opacity: el ? Number(getComputedStyle(el.cardSpin).opacity) : null,
    ariaHidden: el ? el.cardSpin.getAttribute("aria-hidden") : null,
    rule: cardSpinning(box),
    green: ticketGreen(box),
    rowFound: !!row,
    rowWorking: !!row && row.classList.contains("working"),
    state: cardState(box),
  };
}

function freeze(frame) {
  clearInterval(spinTimer);
  spinTimer = -1;
  for (const seat of document.querySelectorAll(".cardspin.on")) seat.dataset.f = frame;
  const age = document.querySelector("#tiklist .trow.working .tage");
  if (age) age.textContent = frame;
}

function unfreeze() {
  spinTimer = null;
  syncSpinner();
}

function countIntervals() {
  const live = new Set();
  window.__tickers = live;
  const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...rest) => {
    const timer = set(fn, ms, ...rest);
    if (ms === 180) live.add(timer);
    return timer;
  };
  window.clearInterval = timer => { live.delete(timer); return clear(timer); };
}

async function openCard(kind, id, init) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(kind === "phone" ? PHONE : DESKTOP);
  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (err) {} });
  await page.evaluateOnNewDocument(installSampler);
  if (init) await page.evaluateOnNewDocument(init);
  await page.goto(origin + (kind === "phone" ? `/m?box=${id}` : "/"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  if (kind === "desktop") await page.evaluate(cardId => select(cardId), id);
  await page.waitForFunction(cardId => {
    const box = document.querySelector("article.box.sel");
    return !!box && box.id === "box-" + cardId;
  }, { timeout: 5000 }, id);
  await settle(700);
  return { page, problems };
}

function seatIs(page, id, on) {
  return page.waitForFunction((cardId, want) => {
    const el = els[cardId];
    return el ? el.cardSpin.classList.contains("on") === want : !want;
  }, { timeout: 5000 }, id, on);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-card-spinner-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js",
                      "index.html", "page.html", "cm-markdown.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "card spinner test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Meta notes." }],
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
    await new Promise(resolve => child.once("exit", resolve));
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: the spinner stands in the sun's square, centred on the sun's mark, 11px against the marks' 10px`, async () => {
    await clearLane();
    const id = await answeredCard(`Spinner position on the ${kind}`);
    await turnGreen(id);
    const { page, problems } = await openCard(kind, id);
    await seatIs(page, id, true);
    await settle(400);
    // the phone lays out at rest scale, so its marks stand REST of the design size
    const rest = kind === "phone" ? REST : 1, MARK = 10 * rest, SPIN = 11 * rest;
    const near = (a, b) => Math.abs(a - b) <= 0.02;
    const measure = async what => {
      const bar = await page.evaluate(readBar);
      assert.equal(bar.hasRun, false, `${what}: the spinner stands in a run after the arrows`);
      assert.deepEqual(bar.order, ["histctl", "sunbtn", "dockbtn", "cardspin", "arcbtn", "xbtn"], `${what}: the bar's order`);
      assert.equal(bar.squares.length, 6, `${what}: the top row has ${bar.squares.length} squares`);
      for (const [width, height] of bar.squares) {
        assert.ok(near(width, bar.named.square) && near(height, bar.named.square),
          `${what}: a square is ${width} by ${height}, not the named ${bar.named.square}`);
      }
      assert.ok(near(bar.named.mark, MARK), `${what}: the named mark size is ${bar.named.mark}`);
      assert.ok(near(bar.named.spinner, SPIN), `${what}: the named spinner size is ${bar.named.spinner}`);
      assert.ok(near(bar.markWidth, MARK) && near(bar.markHeight, MARK), `${what}: the sun's mark is ${bar.markWidth} by ${bar.markHeight}`);
      assert.ok(near(bar.dockWidth, MARK) && near(bar.dockHeight, MARK), `${what}: the dock mark is ${bar.dockWidth} by ${bar.dockHeight}`);
      assert.ok(near(bar.moonWidth, MARK) && near(bar.moonHeight, MARK), `${what}: the moon is ${bar.moonWidth} by ${bar.moonHeight}`);
      assert.ok(near(bar.crossLength, MARK), `${what}: the cross is ${bar.crossLength} long`);
      assert.ok(Math.abs(bar.crossThickness / bar.crossLength - 1.2 / 9) <= 0.001,
        `${what}: the cross is ${bar.crossThickness} thick over ${bar.crossLength}, not the proportion it had`);
      assert.ok(near(bar.spinnerWidth, SPIN) && near(bar.spinnerHeight, SPIN) && near(bar.spinnerFont, SPIN),
        `${what}: the spinner is ${bar.spinnerWidth} by ${bar.spinnerHeight} in ${bar.spinnerFont}px type, not ${SPIN}`);
      assert.ok(Math.abs(bar.seatOffset[0]) <= 0.01 && Math.abs(bar.seatOffset[1]) <= 0.01,
        `${what}: the spinner's centre is ${bar.seatOffset} off the sun's mark`);
      assert.ok(bar.inSun, `${what}: the spinner is not inside the sun's square`);
      assert.equal(bar.color, bar.titleColor, `${what}: the spinner is not in the title's colour`);
    };
    await measure("opened");
    // the window is resized with the card open: nothing is fixed to a pixel
    const sizes = kind === "phone" ? [[320, 640], [430, 932], [390, 844]] : [[1100, 720], [1920, 1080], [1440, 900]];
    for (const [width, height] of sizes) {
      await page.setViewport({ ...(kind === "phone" ? PHONE : DESKTOP), width, height });
      await settle(500);
      await measure(`resized to ${width}x${height}`);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: the spinner shows when the ticket is green and never on a deferred or done card`, async () => {
    await clearLane();
    const id = await answeredCard(`Spinner showing on the ${kind}`);
    const { page, problems } = await openCard(kind, id);
    const seat = () => page.evaluate(readSeat, id);
    const agrees = (s, what) => {
      assert.equal(s.on, s.green, `${what}: the card ${s.on ? "shows" : "hides"} it while its ticket is ${s.green ? "green" : "not green"}`);
      assert.equal(s.rule, s.green, `${what}: the rule disagrees with the ticket's`);
      if (s.rowFound) assert.equal(s.on, s.rowWorking, `${what}: the card and its row differ`);
      assert.equal(s.ariaHidden, s.on ? "false" : "true", `${what}: aria-hidden is wrong`);
    };

    let s = await seat();
    agrees(s, "answered");
    assert.equal(s.on, false);
    assert.equal(s.opacity, 0);

    assert.equal((await api(`/send?box=${id}`, "Please do more.")).status, 200);
    await page.waitForFunction(cardId => ticketQueued(lastState.boxes.find(b => b.id === cardId)), { timeout: 5000 }, id);
    await settle(300);
    s = await seat();
    agrees(s, "queued, not yet claimed");
    assert.equal(s.on, false);
    assert.equal(s.opacity, 0);

    await claimWaiting(id);
    await seatIs(page, id, true);
    await settle(500);
    s = await seat();
    agrees(s, "green");
    assert.equal(s.on, true);
    assert.equal(s.opacity, 1);
    if (s.rowFound) assert.equal(s.rowWorking, true);

    await reply(id);
    await seatIs(page, id, false);
    await settle(500);
    s = await seat();
    agrees(s, "answered again");
    assert.equal(s.opacity, 0);

    // deferred while the agent still holds the card
    await turnGreen(id);
    await seatIs(page, id, true);
    assert.equal((await api(`/park?box=${id}&v=1`)).status, 200);
    await page.waitForFunction(cardId => lastState.boxes.find(b => b.id === cardId).parked, { timeout: 5000 }, id);
    await seatIs(page, id, false);
    await settle(500);
    s = await seat();
    assert.equal(s.state, "parked");
    assert.equal(s.rule, false, "a deferred card must never take the spinner");
    assert.equal(s.on, false);
    assert.equal(s.opacity, 0);
    assert.equal((await api(`/park?box=${id}&v=0`)).status, 200);

    // done while the agent still holds the card: its ticket may pulse, the card does not
    await page.waitForFunction(cardId => !lastState.boxes.find(b => b.id === cardId).parked, { timeout: 5000 }, id);
    await reply(id);
    await turnGreen(id);
    await seatIs(page, id, true);
    assert.equal((await api(`/close?box=${id}`)).status, 200);
    await page.waitForFunction(cardId => lastState.boxes.find(b => b.id === cardId).done, { timeout: 5000 }, id);
    await seatIs(page, id, false);
    await settle(500);
    s = await seat();
    assert.equal(s.state, "done");
    assert.equal(s.rule, false, "a done card must never take the spinner");
    assert.equal(s.on, false);
    assert.equal(s.opacity, 0);
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: showing or hiding the spinner moves nothing else`, async () => {
    await clearLane();
    const id = await answeredCard(`Spinner stillness on the ${kind}`);
    const { page, problems } = await openCard(kind, id);
    const idle = await page.evaluate(readPositions);

    await turnGreen(id);
    await seatIs(page, id, true);
    await settle(500);
    const green = await page.evaluate(readPositions);
    assert.deepEqual(moved(idle, green), [], "the bar moved when the spinner showed");

    // the same state with the spinner taken out of the layout altogether
    await page.evaluate(freeze, "|");
    const withSpinner = await page.evaluate(readEverything);
    await page.addStyleTag({ content: ".cardspin{display:none !important}" });
    await settle(150);
    const without = await page.evaluate(readEverything);
    assert.ok(withSpinner.length > 40, "too few elements were compared");
    assert.deepEqual(movedEverything(withSpinner, without), [], "something moved when the spinner was left out");
    await page.evaluate(() => { for (const el of document.querySelectorAll("style")) if (/cardspin\{display:none/.test(el.textContent)) el.remove(); });
    await page.evaluate(unfreeze);

    await reply(id);
    await seatIs(page, id, false);
    await settle(500);
    const back = await page.evaluate(readPositions);
    assert.deepEqual(moved(idle, back, Object.keys(idle).filter(key => key !== "title")), [],
      "the bar moved when the spinner left");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: the spinner fades in when the card turns green and out when the reply comes back`, async () => {
    await clearLane();
    const id = await answeredCard(`Spinner fade on the ${kind}`);
    const { page, problems } = await openCard(kind, id);

    const duration = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const first = el => getComputedStyle(el).transitionDuration.split(",")[0].trim();
      return { seat: first(box.querySelector(".cardspin")), arrows: first(box.querySelector(".histctl")),
        property: getComputedStyle(box.querySelector(".cardspin")).transitionProperty,
        easing: getComputedStyle(box.querySelector(".cardspin")).transitionTimingFunction,
        arrowsEasing: getComputedStyle(box.querySelector(".histctl")).transitionTimingFunction.split("), ")[0] + ")" };
    });
    assert.equal(duration.seat, "0.26s");
    assert.equal(duration.property, "opacity");
    if (kind === "desktop") {
      assert.equal(duration.seat, duration.arrows, "the fade is not the history arrows' own");
      assert.equal(duration.easing, duration.arrowsEasing, "the easing is not the history arrows' own");
    }

    const from = await page.evaluate(() => window.__seatSamples.length);
    await turnGreen(id);
    await seatIs(page, id, true);
    await settle(900);
    const mid = await page.evaluate(() => window.__seatSamples.length);
    const sunGreen = await page.evaluate(() => {
      const sun = document.querySelector("article.box.sel .sunbtn");
      const probe = document.createElement("div");
      probe.style.opacity = "var(--chipoff)";
      document.body.appendChild(probe);
      const off = Number(getComputedStyle(probe).opacity);
      probe.remove();
      return { aria: sun.getAttribute("aria-disabled"), tab: sun.tabIndex, off };
    });
    await reply(id);
    await seatIs(page, id, false);
    await settle(900);
    const samples = await page.evaluate(start => window.__seatSamples.slice(start), from);
    const split = mid - from;

    const rise = samples.slice(0, split), fall = samples.slice(split);
    const riseFrom = rise.findIndex(s => s.on);
    assert.ok(riseFrom > 0, "the spinner was already on, or never came on");
    assert.ok(rise.slice(0, riseFrom).every(s => s.opacity === 0), "the spinner showed before the card turned green");
    const full = rise.findIndex((s, i) => i >= riseFrom && s.opacity >= 0.999);
    assert.ok(full > riseFrom + 3, "the spinner popped in rather than fading");
    const riseMs = rise[full].t - rise[riseFrom].t;
    assert.ok(riseMs >= 150 && riseMs <= 500, `fade in took ${riseMs} ms`);
    for (let i = riseFrom + 1; i <= full; i++) {
      assert.ok(rise[i].opacity >= rise[i - 1].opacity - 1e-6, "the fade in stepped back");
      assert.ok(rise[i].opacity - rise[i - 1].opacity < 0.3, "the fade in jumped");
    }

    const fallFrom = fall.findIndex(s => !s.on);
    assert.ok(fallFrom >= 0, "the spinner never went off");
    const gone = fall.findIndex((s, i) => i >= fallFrom && s.opacity <= 0.001);
    assert.ok(gone > fallFrom + 3, "the spinner popped out rather than fading");
    const fallMs = fall[gone].t - fall[fallFrom].t;
    assert.ok(fallMs >= 150 && fallMs <= 500, `fade out took ${fallMs} ms`);
    for (let i = fallFrom + 1; i <= gone; i++) {
      assert.ok(fall[i].opacity <= fall[i - 1].opacity + 1e-6, "the fade out stepped back");
      assert.ok(fall[i - 1].opacity - fall[i].opacity < 0.3, "the fade out jumped");
    }
    assert.ok(fall.slice(gone).every(s => s.opacity === 0), "the spinner came back after the reply");

    // the sun's mark and the spinner cross-fade: on every frame their strengths add to one
    for (const s of samples) {
      assert.ok(Math.abs(s.sunMark + s.opacity - 1) <= 0.02, `the sun's mark ${s.sunMark} and the spinner ${s.opacity} do not cross-fade`);
      assert.ok(Math.abs(s.sunButton - sunGreen.off) <= 0.001, `the sun's button left its off fade: ${s.sunButton}`);
    }
    assert.equal(samples[0].sunMark, 1, "the sun's mark was not shown before the card turned green");
    assert.equal(samples[split - 1].sunMark, 0, "the sun's mark is still shown on the green card");
    assert.equal(samples[samples.length - 1].sunMark, 1, "the sun's mark did not come back after the reply");
    assert.equal(sunGreen.aria, "true", "the sun is not inert on the green card");
    assert.equal(sunGreen.tab, 0, "the sun left the keyboard path on the green card");
    const sunSteps = samples.slice(1).map((s, i) => Math.abs(s.sunMark - samples[i].sunMark));
    assert.ok(Math.max(...sunSteps) < 0.3, "the sun's mark jumped rather than fading");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: the spinner turns on the same four frames as the ticket's`, async () => {
    await clearLane();
    const id = await answeredCard(`Spinner clock on the ${kind}`);
    await turnGreen(id);
    const { page, problems } = await openCard(kind, id);
    await seatIs(page, id, true);
    const reads = await page.evaluate(() => new Promise(resolve => {
      const out = [];
      const seat = document.querySelector("article.box.sel .cardspin");
      const timer = setInterval(() => {
        const age = document.querySelector("#tiklist .trow.working .tage");
        out.push([seat.dataset.f, age ? age.textContent : null]);
        if (out.length >= 40) { clearInterval(timer); resolve(out); }
      }, 50);
    }));
    const seen = reads.map(r => r[0]);
    assert.ok(seen.every(f => FRAMES.includes(f)), `a frame outside the four: ${seen.join("")}`);
    assert.deepEqual([...new Set(seen)].sort(), [...FRAMES].sort(), "not all four frames were shown");
    const steps = seen.filter((f, i) => i === 0 || f !== seen[i - 1]);
    steps.slice(1).forEach((f, i) => assert.equal(FRAMES.indexOf(f), (FRAMES.indexOf(steps[i]) + 1) % 4, `the frames skipped: ${steps.join("")}`));
    for (const [frame, age] of reads) if (age !== null) assert.equal(age, frame, "the card and its ticket show different frames");
    if (kind === "desktop") assert.ok(reads.some(r => r[1] !== null), "the green ticket's row was never read");
    assert.deepEqual(problems, []);
    await page.close();
  });
}

// the frame each of two cards and their rows show, read together in one instant
function samplePhases(a, b, count, gap) {
  return new Promise(resolve => {
    const out = [];
    const row = id => {
      const age = document.querySelector(`#tiklist .trow.working[data-id="${id}"] .tage`);
      return age ? age.textContent : null;
    };
    // the frame the card's own last-message time says it should show at the
    // clock of the timer's last tick: whole 180 ms steps, four to a turn
    const should = id => {
      const ts = lastState.boxes.find(x => x.id === id).ts;
      const step = Math.floor((spinNow - ts * 1000) / 180);
      return ["|", "/", "-", "\\"][((step % 4) + 4) % 4];
    };
    const timer = setInterval(() => {
      try {
        out.push({
          cardA: els[a].cardSpin.dataset.f, cardB: els[b].cardSpin.dataset.f,
          rowA: row(a), rowB: row(b),
          shouldA: should(a), shouldB: should(b),
        });
      } catch (err) { clearInterval(timer); resolve([{ error: String(err) }]); return; }
      if (out.length >= count) { clearInterval(timer); resolve(out); }
    }, gap);
  });
}

function sampleTimers(count, gap) {
  return new Promise(resolve => {
    const out = [];
    const timer = setInterval(() => {
      out.push(window.__tickers.size);
      if (out.length >= count) { clearInterval(timer); resolve(out); }
    }, gap);
  });
}

const working = (id, on) => api(`/working?box=${id}&v=${on ? 1 : 0}`);

async function workingCard(title) {
  const id = await create(title);
  assert.equal((await api(`/reply?box=${id}`, "Earlier answer.")).status, 200);
  return id;
}

for (const kind of ["desktop", "phone"]) {
  test(`${kind}: working cards with different last-message times show different frames right after a load, and a reload keeps them`, async () => {
    await clearLane();
    const a = await workingCard(`Phase first on the ${kind}`);
    await settle(350);   // between one and three steps, so the two frames can never coincide
    const b = await workingCard(`Phase second on the ${kind}`);
    assert.equal((await working(a, true)).status, 200);
    assert.equal((await working(b, true)).status, 200);
    const { page, problems } = await openCard(kind, a);
    if (kind === "phone") await page.evaluate(() => openDrawer());
    await seatIs(page, a, true);
    await seatIs(page, b, true);
    const stamps = await page.evaluate(ids => ids.map(id => lastState.boxes.find(x => x.id === id).ts), [a, b]);
    const apart = (stamps[1] - stamps[0]) * 1000;
    assert.ok(apart > 200 && apart < 520, `the two cards' last-message times are ${apart} ms apart`);

    const check = async what => {
      const samples = await page.evaluate(samplePhases, a, b, 30, 40);
      assert.equal(samples[0].error, undefined, `${what}: reading the frames failed: ${samples[0].error}`);
      for (const s of samples) {
        assert.equal(s.cardA, s.shouldA, `${what}: a card is not on the frame its last-message time gives`);
        assert.equal(s.cardB, s.shouldB, `${what}: a card is not on the frame its last-message time gives`);
        assert.notEqual(s.cardA, s.cardB, `${what}: cards with different last-message times show the same frame`);
        if (s.rowA !== null) assert.equal(s.rowA, s.cardA, `${what}: a ticket and its card show different frames`);
        if (s.rowB !== null) assert.equal(s.rowB, s.cardB, `${what}: a ticket and its card show different frames`);
        if (kind === "desktop") assert.ok(s.rowA !== null && s.rowB !== null, `${what}: a working ticket was not in the list`);
      }
    };
    await check("first load");

    for (let again = 1; again <= 2; again++) {
      await settle(500 + again * 130);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
      if (kind === "phone") await page.evaluate(() => openDrawer());
      await seatIs(page, a, true);
      await seatIs(page, b, true);
      assert.deepEqual(await page.evaluate(ids => ids.map(id => lastState.boxes.find(x => x.id === id).ts), [a, b]), stamps, "a last-message time moved");
      await check(`reload ${again}`);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: a card keeps the frame its last-message time gives through polls, re-renders and a new message, and lets go when it stops`, async () => {
    await clearLane();
    const a = await workingCard(`Phase kept on the ${kind}`);
    await settle(350);
    const b = await workingCard(`Phase kept beside it on the ${kind}`);
    assert.equal((await working(a, true)).status, 200);
    assert.equal((await working(b, true)).status, 200);
    const { page, problems } = await openCard(kind, a);
    if (kind === "phone") await page.evaluate(() => openDrawer());
    await seatIs(page, a, true);
    await seatIs(page, b, true);

    const agree = async what => {
      const samples = await page.evaluate(samplePhases, a, b, 40, 50);
      assert.equal(samples[0].error, undefined, `${what}: reading the frames failed: ${samples[0].error}`);
      for (const s of samples) {
        assert.equal(s.cardA, s.shouldA, `${what}: a card left the frame its last-message time gives`);
        assert.equal(s.cardB, s.shouldB, `${what}: a card left the frame its last-message time gives`);
        if (s.rowA !== null) assert.equal(s.rowA, s.cardA, `${what}: a ticket and its card show different frames`);
        if (s.rowB !== null) assert.equal(s.rowB, s.cardB, `${what}: a ticket and its card show different frames`);
      }
    };
    await agree("at first");

    // a new card on the board and several polls redraw the cards and the list
    const other = await create(`Phase bystander on the ${kind}`);
    assert.equal((await api(`/reply?box=${other}`, "Answer.")).status, 200);
    await page.waitForFunction(id => lastState.boxes.some(x => x.id === id), { timeout: 5000 }, other);
    await settle(1500);
    await agree("after polls and a redraw");

    // a message on a working card moves its last-message time, and its frame follows it
    assert.equal((await api(`/send?box=${a}`, "One more thing.")).status, 200);
    await page.waitForFunction(id => lastState.boxes.find(x => x.id === id).pending > 0, { timeout: 5000 }, a);
    await settle(400);
    await agree("after a new message");

    assert.equal((await working(a, false)).status, 200);
    await seatIs(page, a, false);
    await page.waitForFunction(id => !spinTs.has(id), { timeout: 5000 }, a);
    assert.equal(await page.evaluate(id => spinTs.has(id), b), true, "the other card lost its time");
    assert.deepEqual(problems, []);
    await page.close();
  });

  test(`${kind}: one 180 ms timer turns every spinner, and none runs when nothing works`, async () => {
    await clearLane();
    const a = await workingCard(`Timer first on the ${kind}`);
    const b = await workingCard(`Timer second on the ${kind}`);
    const { page, problems } = await openCard(kind, a, countIntervals);
    assert.equal(await page.evaluate(() => window.__tickers.size), 0, "a timer ran with nothing working");
    assert.equal((await working(a, true)).status, 200);
    await seatIs(page, a, true);
    assert.equal((await working(b, true)).status, 200);
    await seatIs(page, b, true);
    const counts = await page.evaluate(sampleTimers, 30, 100);
    assert.deepEqual([...new Set(counts)], [1], `timers alive while two cards worked: ${counts}`);
    assert.equal((await working(a, false)).status, 200);
    assert.equal((await working(b, false)).status, 200);
    await page.waitForFunction(() => window.__tickers.size === 0, { timeout: 5000 });
    assert.deepEqual(problems, []);
    await page.close();
  });
}
