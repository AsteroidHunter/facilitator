// The phone page's typing row while the keyboard is up: the plus steps aside and
// the text slides over its place, on the keyboard's own clock, then comes back the
// same way. Headless Chrome cannot raise a keyboard, so a stand-in visual
// viewport is moved by the test, as phone-keyboard.test.cjs does. The row is read
// frame by frame through the rise, the typing and the close.
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
const KEYBOARD = 336;
const ACCESSORY = 54;
const MOVE = 36;              // the plus's width plus the gap after it: how far the text's left edge travels
const KB_ANIM_MS = 220;

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

async function create(title) {
  const response = await fetch(origin + "/create?owner=facilitator", { method: "POST", body: title });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  await fetch(origin + `/reply?box=${id}`, { method: "POST", body: "A reply to answer." });
  return id;
}

function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height; geom.offsetTop = offsetTop; geom.scale = scale;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
  window.__pickClicks = 0;
  const click = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type === "file") window.__pickClicks++; else return click.apply(this, arguments); };
}

async function openPhone(route, { editor = false } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.evaluateOnNewDocument(fakeViewport);
  await page.evaluateOnNewDocument(on => { try { localStorage.setItem("composeformat", on ? "1" : "0"); } catch {} }, editor);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
const keyboard = (page, height) => page.evaluate(h => window.__keyboard.set(h, 0), height);

// the row as it stands: the class words on the foot, the plus, the text's box and the send square
function rowShape() {
  const foot = document.querySelector("article.box.sel .bottombar");
  const clip = foot.querySelector(".clipbtn"), cs = getComputedStyle(clip);
  const field = foot.querySelector(".compose > textarea:not(.twin), .compose > .cffield");
  const inner = field.classList.contains("cffield") ? field.querySelector(".cm-content") : field;
  const matrix = tf => { const m = /matrix\(([^)]*)\)/.exec(tf); return m ? m[1].split(",").map(Number) : [1, 0, 0, 1, 0, 0]; };
  const f = field.getBoundingClientRect(), r = clip.getBoundingClientRect();
  return {
    t: performance.now(),
    cls: [...foot.classList].filter(x => x !== "bottombar").sort().join("+") || "-",
    kb: document.body.classList.contains("kb"),
    opacity: +cs.opacity, scale: matrix(cs.transform)[0], plusWidth: r.width, plusEvents: cs.pointerEvents,
    fieldLeft: f.left, fieldWidth: f.width,
    textLeft: inner.getBoundingClientRect().left + (parseFloat(getComputedStyle(inner).paddingLeft) || 0),
    caret: getComputedStyle(inner).caretColor,
    focused: !!document.activeElement && !!document.activeElement.closest(".compose"),
  };
}

async function startSampling(page) {
  await page.evaluate(src => {
    const read = new Function("return (" + src + ")")();
    window.__samples = [];
    window.__sampling = true;
    const step = () => { if (!window.__sampling) return; window.__samples.push(read()); requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }, rowShape.toString());
}
async function stopSampling(page) {
  await page.evaluate(() => { window.__sampling = false; });
  return page.evaluate(() => window.__samples);
}
async function tapField(page) {
  const box = await (await page.$("article.box.sel .compose > textarea:not(.twin), article.box.sel .compose > .cffield")).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-typing-row-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js",
                      "compose-format.js", "cm-markdown.js", "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone typing row test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." }],
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port), FACILITATOR_LOG_DIR: process.env.FACILITATOR_LOG_DIR || path.join(fixtureDir, "logs") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) { ready = true; break; } } catch {}
    await settle(25);
  }
  if (!ready) throw new Error(`fixture server did not start:\n${output}`);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

for (const editor of [false, true]) {
  const face = editor ? "the typed-formatting editor" : "the plain box";

  test(`${face}: the plus fades and shrinks while the text slides over its place, on the keyboard's clock`, async () => {
    const id = await create("Typing row motion");
    const { page, problems } = await openPhone(`/m?box=${id}`, { editor });
    try {
      await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
      await settle(300);
      const rest = await page.evaluate(rowShape);
      assert.equal(rest.cls, "-");
      assert.equal(rest.opacity, 1);
      assert.equal(rest.plusWidth, 28);
      assert.equal(rest.plusEvents, "auto");

      await startSampling(page);
      await tapField(page);
      await settle(60);
      await keyboard(page, PHONE.height - KEYBOARD);
      await settle(900);
      const rise = await stopSampling(page);

      const first = rise.findIndex(s => s.kb);
      assert.ok(first > 0, "the keyboard never read as up");
      // the motion leaves on the frame the keyboard is proven, not before
      assert.ok(rise.slice(0, first).every(s => s.opacity === 1 && Math.abs(s.textLeft - rest.textLeft) <= 0.1), "the row moved before the keyboard was proven");
      const moving = rise.filter((s, i) => i >= first && s.opacity > 0 && s.opacity < 1);
      assert.ok(moving.length >= 8, `too few frames inside the motion (${moving.length})`);
      const span = moving[moving.length - 1].t - rise[first].t;
      assert.ok(span >= KB_ANIM_MS - 40 && span <= KB_ANIM_MS + 60, `the motion took ${span.toFixed(0)} ms, not about ${KB_ANIM_MS}`);
      for (let i = 1; i < moving.length; i++) {
        assert.ok(moving[i].opacity <= moving[i - 1].opacity + 0.001, "the plus's opacity came back up during the fade");
        assert.ok(moving[i].textLeft <= moving[i - 1].textLeft + 0.5, "the text moved right during the slide");
        assert.ok(moving[i].scale <= moving[i - 1].scale + 0.001, "the plus grew during the shrink");
      }
      const grew = moving.filter(s => Math.abs(s.fieldWidth - rest.fieldWidth) > 0.1);
      assert.equal(grew.length, 0, `the box changed width while the motion ran: ${JSON.stringify(grew.slice(0, 2))} from ${rest.fieldWidth}`);
      assert.ok(moving.every(s => s.plusEvents === "none"), "the plus still took taps during the motion");

      const up = await page.evaluate(rowShape);
      assert.equal(up.cls, "typing+wide", "the layout did not switch once the motion had landed");
      assert.equal(up.opacity, 0);
      assert.equal(up.plusWidth, 0);
      assert.equal(up.plusEvents, "none");
      assert.ok(Math.abs(up.fieldWidth - rest.fieldWidth - MOVE) <= 0.1, `the box is ${up.fieldWidth} wide, not ${rest.fieldWidth + MOVE}`);
      assert.ok(Math.abs(rest.textLeft - up.textLeft - MOVE) <= 0.5, `the text travelled ${rest.textLeft - up.textLeft}, not ${MOVE}`);
      assert.notEqual(up.caret, "rgba(0, 0, 0, 0)", "the caret was left hidden");
      // the switch to the wide layout moves no pixel
      const at = rise.findIndex(s => /wide/.test(s.cls));
      assert.ok(at > 0, "the wide layout never switched on");
      assert.ok(Math.abs(rise[at].textLeft - rise[at - 1].textLeft) <= 0.5, "the text jumped when the layout switched");
      assert.ok(rise.slice(0, at).some(s => s.caret === "rgba(0, 0, 0, 0)"), "the caret was not held through the rise");

      // typing changes nothing about the row's left side
      await page.keyboard.type("typed with the keyboard up");
      await settle(200);
      const typed = await page.evaluate(rowShape);
      assert.equal(typed.cls, "typing+wide");
      assert.ok(Math.abs(typed.fieldLeft - up.fieldLeft) <= 0.1, "typing moved the box's left edge");
      assert.equal(typed.opacity, 0);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a tap where the plus stood opens no picker while typing, and the close brings the plus back on the same clock`, async () => {
    const id = await create("Typing row close");
    const { page, problems } = await openPhone(`/m?box=${id}`, { editor });
    try {
      await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
      await settle(300);
      const rest = await page.evaluate(rowShape);
      const plusBox = await (await page.$("article.box.sel .clipbtn")).boundingBox();
      await tapField(page);
      await settle(60);
      await keyboard(page, PHONE.height - KEYBOARD);
      await settle(1000);
      const foot = await (await page.$("article.box.sel .compose")).boundingBox();
      await page.touchscreen.tap(plusBox.x + plusBox.width / 2, foot.y + foot.height / 2);
      await settle(300);
      assert.equal(await page.evaluate(() => window.__pickClicks), 0, "a tap on the hidden plus's place opened the picker");
      assert.equal((await page.evaluate(rowShape)).focused, true, "the tap took the box's focus away");

      await startSampling(page);
      await page.evaluate(() => document.activeElement.blur());
      await settle(40);
      await keyboard(page, PHONE.height);
      await settle(800);
      const back = await stopSampling(page);
      const start = back.findIndex(s => s.cls !== "typing+wide");
      assert.ok(start >= 0, "the row never left the wide look");
      assert.ok(back[start].textLeft <= rest.textLeft - MOVE + 6, `the close did not start from the wide look (${back[start].textLeft})`);
      assert.ok(/returning/.test(back[start].cls), "the way back was not on its own clock");
      const moving = back.filter(s => s.opacity > 0 && s.opacity < 1);
      assert.ok(moving.length >= 8, `too few frames inside the return (${moving.length})`);
      const span = moving[moving.length - 1].t - back[start].t;
      assert.ok(span >= KB_ANIM_MS - 40 && span <= KB_ANIM_MS + 60, `the return took ${span.toFixed(0)} ms`);
      for (let i = 1; i < moving.length; i++) {
        assert.ok(moving[i].opacity >= moving[i - 1].opacity - 0.001, "the plus faded out again during the return");
        assert.ok(moving[i].textLeft >= moving[i - 1].textLeft - 0.5, "the text moved left during the return");
      }
      const end = await page.evaluate(rowShape);
      assert.equal(end.cls, "-");
      assert.equal(end.opacity, 1);
      assert.equal(end.plusWidth, 28);
      assert.equal(end.plusEvents, "auto");
      assert.ok(Math.abs(end.fieldWidth - rest.fieldWidth) <= 0.1, "the box did not return to its resting width");
      assert.ok(Math.abs(end.textLeft - rest.textLeft) <= 0.5);

      const clicks = await page.evaluate(() => window.__pickClicks);
      await page.touchscreen.tap(plusBox.x + plusBox.width / 2, plusBox.y + plusBox.height / 2);
      await settle(200);
      assert.equal(await page.evaluate(() => window.__pickClicks), clicks + 1, "the plus did not open the picker after the close");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

test("a hardware keyboard or an accessory bar alone leaves the plus in place, and a keyboard that leaves with the box still focused gives it back", async () => {
  const id = await create("Typing row other keyboards");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    await settle(300);
    // focus with no viewport report: the caret is held for a beat, the plus never moves
    await tapField(page);
    await settle(120);
    const held = await page.evaluate(rowShape);
    assert.equal(held.caret, "rgba(0, 0, 0, 0)");
    assert.equal(held.opacity, 1);
    assert.equal(held.plusEvents, "auto");
    await settle(700);
    const freed = await page.evaluate(rowShape);
    assert.equal(freed.cls, "-");
    assert.notEqual(freed.caret, "rgba(0, 0, 0, 0)");
    assert.equal(freed.plusWidth, 28);

    // a small obstruction is the accessory strip, not the keyboard
    await keyboard(page, PHONE.height - ACCESSORY);
    await settle(900);
    const strip = await page.evaluate(rowShape);
    assert.equal(strip.kb, false);
    assert.equal(strip.cls, "-");
    assert.equal(strip.opacity, 1);

    // the keyboard up, then away while the box keeps focus: the plus returns, and steps aside again
    await keyboard(page, PHONE.height - KEYBOARD);
    await settle(1200);
    assert.equal((await page.evaluate(rowShape)).cls, "typing+wide");
    await keyboard(page, PHONE.height);
    await settle(700);
    const away = await page.evaluate(rowShape);
    assert.equal(away.focused, true);
    assert.equal(away.cls, "-");
    assert.equal(away.opacity, 1);
    await keyboard(page, PHONE.height - KEYBOARD);
    await settle(1200);
    assert.equal((await page.evaluate(rowShape)).cls, "typing+wide");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the tray above the row stands still while the plus steps aside, and only the card in use wears the typing row", async () => {
  const a = await create("Typing row tray A");
  await create("Typing row tray B");
  const { page, problems } = await openPhone(`/m?box=${a}`);
  try {
    await page.waitForSelector(`#box-${a}.sel`, { timeout: 5000 });
    await settle(300);
    await page.evaluate(id => trayAdd(id, [new File(["hello"], "note.txt", { type: "text/plain" })]), a);
    await page.waitForFunction(id => els[id].trayItems.length === 1 && els[id].trayItems.every(i => !["up", "queued", "wait"].includes(i.state)), { timeout: 15000 }, a);
    await settle(400);
    const tray = id => page.evaluate(id => {
      const t = els[id].tray.getBoundingClientRect(), f = document.querySelector("article.box.sel .bottombar").getBoundingClientRect();
      const sq = els[id].tray.querySelector(".tsq").getBoundingClientRect();
      return { on: els[id].tray.classList.contains("on"), gap: f.top - t.bottom, width: t.width, left: t.left, squareWidth: sq.width, squareLeft: sq.left };
    }, id);
    const rest = await tray(a);
    assert.equal(rest.on, true);
    await tapField(page);
    await settle(60);
    await keyboard(page, PHONE.height - KEYBOARD);
    await settle(1200);
    const up = await tray(a);
    assert.equal(up.on, true);
    for (const key of ["gap", "width", "left", "squareWidth", "squareLeft"]) {
      assert.ok(Math.abs(up[key] - rest[key]) <= 0.5, `the tray's ${key} went from ${rest[key]} to ${up[key]} when the plus stepped aside`);
    }

    await page.evaluate(() => stepCard(1, true));
    await settle(1100);
    const worn = await page.evaluate(() => [...document.querySelectorAll("article.box .bottombar")]
      .map(f => ({ sel: f.closest("article.box").classList.contains("sel"), cls: [...f.classList].filter(x => x !== "bottombar").sort().join("+") || "-" }))
      .filter(f => f.cls !== "-"));
    assert.deepEqual(worn, [{ sel: true, cls: "typing+wide" }], "the typing row is not on exactly the card in use");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the typing row's css sets no colour and its script has no em dash", async () => {
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  const start = source.indexOf(".bottombar.typing .clipbtn");
  const end = source.indexOf(".bottombar.nocaret");
  assert.ok(start > 0 && end > start, "the typing row's css was not found");
  const css = source.slice(start, end);
  assert.ok(!/accent|purple|#[0-9a-f]{3,8}\b|rgb\(/i.test(css), "the typing row's css sets a colour");
  assert.ok(!/\u2014/.test(source.slice(source.indexOf("the typing row: the plus steps aside"), source.indexOf("a keyboard plugged into the phone"))), "an em dash in the typing row's script");
});
