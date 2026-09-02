// The phone page's motion, driven headless at an iPhone size against its own
// fixture server: the card's two fades, the sent box's arrival, the send that
// lands at once and moves on, the two drawers opening the way the reference
// drawer does, the tab bar keeping its scroll, and the settings panel.
// Screenshots land under /tmp/m362-motion-shots.
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
const SHOTS = "/tmp/m362-motion-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const LONG_REPLY = Array.from({ length: 16 }, (_, i) =>
  `Paragraph ${i + 1}. The answer runs on for long enough to scroll under the title and to end against the sent box at the foot of the card.`).join("\n\n");

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
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

// every part of a menu's motion, read off the page and the menu itself
async function readMenu(page, sel) {
  return page.evaluate(one => {
    const panel = document.querySelector(one);
    const surface = document.getElementById("page");
    const p = getComputedStyle(surface), q = getComputedStyle(panel);
    return {
      open: panel.classList.contains("open"),
      slide: Math.round(new DOMMatrix(p.transform).m41),
      radius: p.borderTopLeftRadius,
      shade: p.boxShadow,
      width: Math.round(panel.getBoundingClientRect().width),
      left: Math.round(panel.getBoundingClientRect().left),
      right: Math.round(innerWidth - panel.getBoundingClientRect().right),
      corners: [q.borderTopLeftRadius, q.borderTopRightRadius, q.borderBottomRightRadius, q.borderBottomLeftRadius],
      lift: Math.round(new DOMMatrix(q.transform).m42),
      fade: Number(q.opacity).toFixed(2),
      scrim: Number(getComputedStyle(document.getElementById("scrim")).opacity).toFixed(2),
      ms: p.transitionDuration,
      curve: p.transitionTimingFunction,
      panelMs: q.transitionDuration,
    };
  }, sel);
}

// a pull from an edge, held at a fraction of the menu's width so the frame it
// stands on can be looked at, and then let go
async function pull(page, side, fraction, hold) {
  const width = await page.evaluate(one => document.querySelector(one).getBoundingClientRect().width,
    side === "right" ? "#settings" : "#drawer");
  const from = side === "right" ? 384 : 6;
  const travel = Math.round(width * fraction) * (side === "right" ? -1 : 1);
  await page.touchscreen.touchStart(from, 500);
  for (let step = 1; step <= 8; step++) await page.touchscreen.touchMove(from + Math.round(travel * step / 8), 500);
  if (hold) await hold();
  await page.touchscreen.touchEnd();
  await settle(750);
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-motion-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone motion test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port) },
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
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the answer dissolves under the title as it scrolls and into the sent box at its foot", async () => {
  const id = await create("The card wears both fades");
  await api(`/reply?box=${id}`, LONG_REPLY);
  await api(`/send?box=${id}`, "A line sent and waiting");

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel .pendlist`, { timeout: 5000 });
    await settle(300);
    const rest = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const reply = box.querySelector(".reply");
      const wrap = box.querySelector(".pendwrap");
      const cs = getComputedStyle(reply);
      return {
        wrapPosition: getComputedStyle(wrap).position,
        overlap: reply.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top,
        band: cs.getPropertyValue("--boxband").trim(),
        wrapHeight: Math.round(wrap.getBoundingClientRect().height),
        up: cs.getPropertyValue("--upband").trim(),
        fade: cs.getPropertyValue("--replyfade").trim(),
        air: cs.getPropertyValue("--replyair").trim(),
        mask: cs.webkitMaskImage,
        composite: cs.webkitMaskComposite || cs.maskComposite,
        runout: cs.paddingBottom,
        scrolls: reply.scrollHeight > reply.clientHeight + 1,
      };
    });
    assert.equal(rest.wrapPosition, "absolute", "the sent box is not laid over the answer");
    assert.ok(rest.overlap > 40, `the answer does not run on under the box (${rest.overlap})`);
    assert.equal(rest.fade, "22px", "the ramp is not the desktop's depth");
    assert.equal(rest.air, "3.5px", "the clear air over the box is not the desktop's");
    assert.equal(rest.band, rest.wrapHeight + "px", "the ramp's top edge is not the box's top edge");
    assert.ok(rest.up === "" || rest.up === "0px", `an answer at rest carries a band under the title (${rest.up})`);
    assert.match(rest.mask, /linear-gradient/, "the answer carries no mask");
    assert.equal(rest.mask.match(/linear-gradient/g).length, 3, "the mask is not the desktop's three layers");
    assert.match(rest.composite, /intersect/);
    assert.equal(rest.runout, (parseFloat(rest.band) + 22).toFixed(0) + "px", "the scroll's run-out is not the band plus the ramp");
    assert.equal(rest.scrolls, true, "the answer under test does not scroll");
    await shot(page, "fade-rest");

    // one pixel of scroll buys one pixel of ramp, and the ramp stops at its depth
    const scrolled = await page.evaluate(async () => {
      const reply = document.querySelector("article.box.sel .reply");
      const read = () => getComputedStyle(reply).getPropertyValue("--upband").trim();
      const step = async to => {
        reply.scrollTop = to;
        await new Promise(r => setTimeout(r, 60));
        return read();
      };
      return { small: await step(7), deep: await step(400) };
    });
    assert.equal(scrolled.small, "7px", "the band under the title does not follow the scroll");
    assert.equal(scrolled.deep, "22px", "the band under the title is not capped at the ramp's depth");
    await shot(page, "fade-scrolled");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the sent line lands on the tap, the box rises into it, and the poll reconciles", async () => {
  // the seeded card is put out of the doing view so nothing else is waiting on
  // him and the send stays on the card it was sent from, which is the card this
  // test watches. the move to the next card has its own test below
  await api("/park?box=0&v=1");
  const id = await create("The send answers at once");
  await api(`/reply?box=${id}`, LONG_REPLY);

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await page.type("article.box.sel textarea", "Landed before the server answered");
    // the click and the reading of the card happen in one turn of the event
    // loop, so nothing the server says can have arrived in between
    const atOnce = await page.evaluate(() => {
      document.querySelector("article.box.sel .sendbtn").click();
      const box = document.querySelector("article.box.sel");
      const pend = box.querySelector(".pendlist");
      return {
        rows: [...box.querySelectorAll(".pendmsg")].map(r => r.dataset.text),
        rising: pend.classList.contains("rising"),
        timed: pend.classList.contains("timed"),
        height: pend.style.height,
        moving: getComputedStyle(pend).transitionProperty,
        field: box.querySelector("textarea").value,
        square: box.querySelector(".sendbtn").classList.contains("show"),
      };
    });
    assert.deepEqual(atOnce.rows, ["Landed before the server answered"], "the line waited on the server");
    assert.equal(atOnce.rising, true, "the box did not arrive on the shared rising dress");
    assert.equal(atOnce.timed, true, "the arrival was not put on the clock");
    assert.match(atOnce.moving, /height/, "the arrival is not a timed run");
    assert.notEqual(atOnce.height, "0px", "the box was left at no height");
    assert.equal(atOnce.field, "", "the words were left in the row he types on");
    assert.equal(atOnce.square, false, "the send square stayed up with nothing to send");
    // a burst over the arrival: the room opening under the answer, then the box
    // coming up in it
    await shot(page, "send-mid-1");
    await settle(120);
    await shot(page, "send-mid-2");
    await settle(140);
    await shot(page, "send-mid-3");

    // the box is still on its way up a beat later, and standing on its own at the end
    const mid = await page.evaluate(() => {
      const pend = document.querySelector("article.box.sel .pendlist");
      return { height: pend.getBoundingClientRect().height, rising: pend.classList.contains("rising") };
    });
    assert.ok(mid.height > 0, "the box never left the floor");
    await settle(500);
    const settled = await page.evaluate(() => {
      const pend = document.querySelector("article.box.sel .pendlist");
      const cs = getComputedStyle(pend);
      return {
        classes: pend.className,
        inlineHeight: pend.style.height,
        height: Math.round(pend.getBoundingClientRect().height),
        bar: Math.round(parseFloat(cs.getPropertyValue("--pend-bar"))),
        opacity: cs.opacity,
        rows: [...document.querySelectorAll("article.box.sel .pendmsg")].map(r => r.dataset.text),
        word: document.querySelector("article.box.sel .pendmsg .rcpt").textContent,
      };
    });
    assert.equal(settled.classes, "pendlist", "the arrival left its dress on the box");
    assert.equal(settled.inlineHeight, "", "the arrival left an inline height on the box");
    assert.equal(settled.opacity, "1");
    assert.ok(Math.abs(settled.height - settled.bar) <= 2, `the box did not land on its own folded height (${settled.height})`);
    assert.deepEqual(settled.rows, ["Landed before the server answered"], "the poll doubled the sent line");
    assert.equal(settled.word, "Delivered");
    const saved = await (await fetch(origin + "/state")).json();
    assert.deepEqual(saved.boxes.find(b => b.id === id).pendingTexts, ["Landed before the server answered"]);
    const stamp = await page.evaluate(() => document.querySelector("article.box.sel .pendstamp").textContent);
    assert.match(stamp, /\d{1,2}:\d{2} (AM|PM)$/, "the run's time was not taken over by the server's");
    await shot(page, "send-settled");
    assert.equal(await page.evaluate(() => selectedId), id, "the send left the card it was sent from");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("a send moves on to the card that has waited longest, on the desktop's wait", async () => {
  const board = await readFile(path.join(ROOT, "index.html"), "utf8");
  const phone = await readFile(path.join(ROOT, "m.html"), "utf8");
  const wait = source => source.match(/const AUTONEXT_MS = (\d+)/)[1];
  assert.equal(wait(phone), wait(board), "the phone waits a different time than the board before moving on");

  // the seeded card also waits on him and was made before either of these, so it
  // is put out of the doing view and the two under test are the only ones left
  await api("/park?box=0&v=1");
  const waiting = await create("The card that waits");
  await api(`/reply?box=${waiting}`, "Waiting on him");
  const from = await create("The card he sends from");
  await api(`/reply?box=${from}`, "Also waiting on him");

  const { page, problems } = await openPhone(`/m?box=${from}`);
  try {
    await page.waitForSelector(`#box-${from}.sel`, { timeout: 5000 });
    await page.type("article.box.sel textarea", "Off you go");
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, waiting);
    const landed = await page.evaluate(() => ({
      selected: selectedId,
      shown: document.querySelector("article.box.sel")?.id,
      only: document.querySelectorAll("article.box.sel").length,
    }));
    assert.equal(landed.selected, waiting, "the send did not move on to the waiting card");
    assert.equal(landed.shown, "box-" + waiting, "the card on screen is not the one it moved to");
    assert.equal(landed.only, 1);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("the card list is uncovered by the page sliding off it, on the reference drawer's run", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    const shut = await readMenu(page, "#drawer");
    assert.equal(shut.open, false);
    assert.equal(shut.slide, 0, "the page does not start square on the screen");
    assert.equal(shut.radius, "0px", "the page starts with rounded corners");
    assert.equal(shut.shade, "none", "the page carries a shade with nothing out");
    assert.equal(shut.scrim, "0.00");
    assert.equal(shut.lift, 20, "the menu does not wait below its place");
    assert.equal(shut.fade, "0.40", "the menu does not wait at four tenths of its strength");
    assert.equal(shut.left, 0, "the card list is not against the left edge");
    // the two corners the page's edge stops against are rounded, the two at the
    // screen's own edge are square
    assert.deepEqual(shut.corners, ["0px", "7px", "7px", "0px"], "the card list's visible corners are not the board's 7px");
    assert.match(shut.ms, /0\.55s/, "the run is not 550ms");
    assert.match(shut.curve, /cubic-bezier\(0\.445, 0\.05, 0\.55, 0\.95\)/, "a tap does not open on the ease in and out");
    assert.match(shut.panelMs, /0\.55s/, "the menu itself is on another clock than the page");
    await shot(page, "drawer-closed");

    await page.evaluate(() => openDrawer());
    await settle(250);
    const half = await readMenu(page, "#drawer");
    assert.ok(half.slide > 0 && half.slide < half.width, `the page did not travel over time (${half.slide})`);
    assert.ok(Number(half.fade) > 0.4 && Number(half.fade) < 1, `the menu did not come up over time (${half.fade})`);
    await shot(page, "drawer-half");

    await settle(500);
    const out = await readMenu(page, "#drawer");
    assert.equal(out.open, true);
    assert.equal(out.slide, out.width, "the page did not move over by the menu's width");
    assert.equal(out.radius, "24px", "the page's corners did not round to the reference drawer's 24px");
    assert.match(out.shade, /rgba\(0, 0, 0, 0\.15\)/, "the page carries no shade on its moving edge");
    assert.match(out.shade, /-4px 0px 12px/, "the shade is not on the edge the page moved away from");
    assert.equal(out.lift, 0, "the menu did not rise into place");
    assert.equal(out.fade, "1.00", "the menu did not come up to its full strength");
    assert.equal(out.scrim, "1.00");
    await shot(page, "drawer-open");

    await page.evaluate(() => closeDrawer());
    await settle(750);
    const back = await readMenu(page, "#drawer");
    assert.equal(back.open, false);
    assert.equal(back.slide, 0, "the page did not come back");
    assert.equal(back.radius, "0px", "the page kept its rounded corners");
    assert.equal(back.shade, "none");
    assert.equal(back.lift, 20);
    assert.equal(back.fade, "0.40");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a pull past the middle opens the card list and one short of it goes back", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    await pull(page, "left", 0.4);
    const shy = await readMenu(page, "#drawer");
    assert.equal(shy.open, false, "a pull short of the middle opened the menu");
    assert.equal(shy.slide, 0);

    let midway = null;
    await pull(page, "left", 0.6, async () => {
      midway = await readMenu(page, "#drawer");
      await shot(page, "drawer-dragged");
    });
    assert.ok(midway.slide > 0 && midway.slide < midway.width, "the page does not follow the finger");
    assert.equal(midway.ms, "0s", "the page is on a clock while the finger holds it");
    const held = await readMenu(page, "#drawer");
    assert.equal(held.open, true, "a pull past the middle did not open the menu");
    assert.equal(held.slide, held.width);
    assert.match(held.curve, /cubic-bezier\(0\.215, 0\.61, 0\.355, 1\)/, "a released drag does not finish on the ease out");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the tab bar stays where he scrolled it, across a poll and a tap", async () => {
  // enough lanes to fill the bar past the width of the screen. the folder each
  // lane is given is only a name to the page, and nothing is written in it
  const home = require("node:os").homedir();
  for (const name of ["Lane two", "Lane three", "Lane four", "Lane five", "Lane six"]) {
    const made = await fetch(`${origin}/project?name=${encodeURIComponent(name)}`, { method: "POST", body: home });
    assert.equal(made.status, 200, "the fixture could not add a lane");
  }
  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tabbar .ptab").length >= 7, { timeout: 5000 });
    const room = await page.evaluate(() => {
      const lane = document.querySelector(".bar");
      return lane.scrollWidth - lane.clientWidth;
    });
    assert.ok(room > 60, `the bar under test does not overflow (${room})`);

    await page.evaluate(() => { document.querySelector(".bar").scrollLeft = 120; });
    await page.evaluate(() => poll());
    await settle(1600);   // a hand-run poll and the clock's own one behind it
    const afterPoll = await page.evaluate(() => ({
      at: document.querySelector(".bar").scrollLeft,
      polls: !!lastState,
    }));
    assert.equal(afterPoll.polls, true);
    assert.equal(afterPoll.at, 120, "a poll yanked the bar back to the start");
    await shot(page, "tabbar-scrolled");

    // a tap on a tab standing in view leaves the bar exactly where it is
    const tapped = await page.evaluate(() => {
      const lane = document.querySelector(".bar").getBoundingClientRect();
      const tab = [...document.querySelectorAll("#tabbar .ptab")].find(t => {
        const r = t.getBoundingClientRect();
        return r.left >= lane.left + 2 && r.right <= lane.right - 2 && !t.classList.contains("on");
      });
      tab.click();
      return tab.dataset.owner;
    });
    await settle(300);
    const afterTap = await page.evaluate(() => ({
      at: document.querySelector(".bar").scrollLeft,
      owner: activeOwner,
      on: document.querySelector("#tabbar .ptab.on").dataset.owner,
    }));
    assert.equal(afterTap.owner, tapped, "the tap did not change lane");
    assert.equal(afterTap.on, tapped);
    assert.equal(afterTap.at, 120, "a tap yanked the bar back to the start");

    // and the bar keeps its place when the lanes themselves are drawn again
    await page.evaluate(() => { document.getElementById("tabbar").dataset.sig = ""; renderTabs(lastState); });
    assert.equal(await page.evaluate(() => document.querySelector(".bar").scrollLeft), 120,
      "a rebuild of the tabs lost the place he scrolled to");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
