// Control+Shift+Left and Right on the phone page, with the caret in a card's typing
// box, carry the caret to the next card's box. When that box holds words the caret
// lands after the last of them, wherever it was left in them before, and an empty box
// stays as it was. The same holds on the plain box and on the typed-formatting editor.
// The focus is still taken without scrolling, and the caret colour is still held back
// at once and released once the layout has settled, and the caret is then moved one place
// off and back (an empty box gets a transform for a frame) so the phone draws it before
// a key is pressed. A stand-in visual viewport stands
// for the keyboard, as phone-typing-row.test.cjs does.
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
const WORDS = "hello draft text";

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
  return (await response.json()).id;
}

function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, offsetTop: 0 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => window.innerWidth });
  Object.defineProperty(vv, "offsetTop", { get: () => geom.offsetTop });
  for (const key of ["offsetLeft", "pageTop", "pageLeft"]) Object.defineProperty(vv, key, { get: () => 0 });
  Object.defineProperty(vv, "scale", { get: () => 1 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0) {
      geom.height = height; geom.offsetTop = offsetTop;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
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

async function tapField(page) {
  const box = await (await page.$("article.box.sel .compose > textarea:not(.twin), article.box.sel .compose > .cffield")).boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}
async function chord(page, key) {
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}
const where = (page, id) => page.evaluate(i => {
  const ta = els[i].ta, active = document.activeElement;
  return {
    start: ta.selectionStart, end: ta.selectionEnd, length: ta.value.length, value: ta.value,
    inBox: !!active && !!active.closest && !!active.closest("#box-" + i + " .compose"),
    selected: selectedId,
  };
}, id);

// the keyboard is up with the caret in the first card's box; one step went on to the next card,
// where the words were typed if given and the caret left leftBy places from their end; one step
// came back to the first card, so the next step goes into the next card's box
async function prepare(editor, { words = "", leftBy = 0 } = {}) {
  const first = await create("Caret end first");
  await create("Caret end second");
  const { page, problems } = await openPhone(`/m?box=${first}`, { editor });
  await page.waitForSelector(`#box-${first}.sel`, { timeout: 5000 });
  const next = await page.evaluate(() => cardStepTarget(1).id);
  if (editor) {
    await page.waitForFunction(ids => ids.every(i => els[i].field.formatted()), { timeout: 8000 }, [first, next]);
  }
  await settle(300);
  await tapField(page);
  await settle(60);
  await keyboard(page, PHONE.height - KEYBOARD);
  await settle(900);
  assert.equal((await where(page, first)).inBox, true, "the caret was not in the first card's box");
  await chord(page, "ArrowRight");
  await settle(900);
  assert.equal((await where(page, next)).selected, next, "the step did not reach the next card");
  if (words) {
    await page.keyboard.type(words);
    for (let i = 0; i < leftBy; i++) await page.keyboard.press("ArrowLeft");
    await settle(200);
  }
  await chord(page, "ArrowLeft");
  await settle(900);
  assert.equal((await where(page, first)).selected, first, "the step back did not reach the first card");
  return { page, problems, first, next };
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-caret-end-"));
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
    title: "phone caret end test",
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

  test(`${face}: a step into a box with words puts the caret after the last one, from the middle of them`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS, leftBy: 5 });
    try {
      assert.equal((await where(page, next)).start, WORDS.length - 5, "the caret was not left in the middle of the words");
      await chord(page, "ArrowRight");
      await settle(700);
      const landed = await where(page, next);
      assert.equal(landed.inBox, true, "the caret did not arrive in the box");
      assert.deepEqual([landed.start, landed.end, landed.length], [WORDS.length, WORDS.length, WORDS.length]);
      await page.keyboard.type("!");
      assert.equal((await where(page, next)).value, WORDS + "!", "a typed mark did not land after the last word");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a step into a box with words puts the caret after the last one, from the start of them`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS, leftBy: WORDS.length });
    try {
      assert.equal((await where(page, next)).start, 0, "the caret was not left at the start of the words");
      await chord(page, "ArrowRight");
      await settle(700);
      const landed = await where(page, next);
      assert.equal(landed.inBox, true, "the caret did not arrive in the box");
      assert.deepEqual([landed.start, landed.end, landed.length], [WORDS.length, WORDS.length, WORDS.length]);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a step into an empty box leaves the caret at its start`, async () => {
    const { page, problems, next } = await prepare(editor);
    try {
      await chord(page, "ArrowRight");
      await settle(700);
      const landed = await where(page, next);
      assert.equal(landed.inBox, true, "the caret did not arrive in the box");
      assert.deepEqual([landed.start, landed.end, landed.length], [0, 0, 0]);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a caret sent back to the start while the colour is held goes to the end when the hold ends`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS });
    try {
      await chord(page, "ArrowRight");
      await settle(100);
      await page.evaluate(i => els[i].ta.setSelectionRange(0, 0), next);
      assert.equal((await where(page, next)).start, 0, "the stand-in for the phone's reset did not take");
      await settle(700);
      const landed = await where(page, next);
      assert.equal(landed.inBox, true);
      assert.deepEqual([landed.start, landed.end], [WORDS.length, WORDS.length]);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a caret move made by a key while the colour is held is kept`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS });
    try {
      await chord(page, "ArrowRight");
      await settle(100);
      await page.keyboard.press("Home");
      assert.equal((await where(page, next)).start, 0, "the Home key did not move the caret");
      await settle(700);
      const landed = await where(page, next);
      assert.equal(landed.inBox, true);
      assert.deepEqual([landed.start, landed.end], [0, 0], "the caret was moved when the hold ended");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: once the colour is back the caret is moved one place off and back, so the phone draws it`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS });
    try {
      await page.evaluate(i => {
        const ta = els[i].ta, foot = els[i].bottombar;
        window.__moves = [];
        window.__heldSeen = false;
        window.__styled = false;
        new MutationObserver(() => { if (foot.classList.contains("nocaret")) window.__heldSeen = true; })
          .observe(foot, { attributes: true, attributeFilter: ["class"] });
        new MutationObserver(records => {
          if (records.some(r => /translateZ/.test(r.target.style.transform))) window.__styled = true;
        }).observe(foot, { attributes: true, attributeFilter: ["style"], subtree: true });
        const original = ta.setSelectionRange;
        Object.defineProperty(ta, "setSelectionRange", {
          configurable: true, writable: true,
          value(...args) {
            window.__moves.push({ from: args[0], to: args[1], back: window.__heldSeen && !foot.classList.contains("nocaret") });
            return original.apply(this, args);
          },
        });
      }, next);
      await chord(page, "ArrowRight");
      await settle(900);
      const moves = (await page.evaluate(() => window.__moves)).filter(m => m.back).map(m => [m.from, m.to]);
      assert.deepEqual(moves.slice(0, 2), [[WORDS.length - 1, WORDS.length - 1], [WORDS.length, WORDS.length]],
        "the caret was not moved off its place and back once the colour returned");
      const landed = await where(page, next);
      assert.deepEqual([landed.start, landed.end], [WORDS.length, WORDS.length]);
      assert.equal(await page.evaluate(() => window.__styled), false, "a box with words was given a transform");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: a step into an empty box has the caret drawn again with a transform for one frame`, async () => {
    const { page, problems, next } = await prepare(editor);
    try {
      await page.evaluate(i => {
        window.__transforms = [];
        new MutationObserver(records => {
          for (const r of records) window.__transforms.push({ t: performance.now(), value: r.target.style.transform });
        }).observe(els[i].bottombar, { attributes: true, attributeFilter: ["style"], subtree: true });
      }, next);
      await chord(page, "ArrowRight");
      await settle(900);
      const seen = await page.evaluate(() => window.__transforms);
      const set = seen.find(s => /translateZ/.test(s.value));
      assert.ok(set, "no transform was applied to the empty box's field");
      const cleared = seen.find(s => s.t > set.t && s.value === "");
      assert.ok(cleared && cleared.t - set.t < 100, "the transform was not taken off again within a frame or two");
      const landed = await where(page, next);
      assert.deepEqual([landed.start, landed.end, landed.length], [0, 0, 0]);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });

  test(`${face}: the step still focuses without scrolling, holds the caret colour at once and releases it after the layout settles`, async () => {
    const { page, problems, next } = await prepare(editor, { words: WORDS });
    try {
      await page.evaluate(i => {
        window.__focusCalls = [];
        window.__hold = [];
        const focus = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (options) {
          const box = this.closest("article.box");
          window.__focusCalls.push({ t: performance.now(), preventScroll: !!(options && options.preventScroll), box: box && box.id });
          return focus.apply(this, arguments);
        };
        const foot = els[i].bottombar;
        const note = () => window.__hold.push({ t: performance.now(), classes: [...foot.classList].filter(x => x !== "bottombar") });
        new MutationObserver(note).observe(foot, { attributes: true, attributeFilter: ["class"] });
      }, next);
      await chord(page, "ArrowRight");
      await settle(900);
      const { calls, hold } = await page.evaluate(() => ({ calls: window.__focusCalls, hold: window.__hold }));
      const onNext = calls.filter(c => c.box === "box-" + next);
      assert.ok(onNext.length >= 1, "the next card's box was not focused");
      assert.ok(onNext.every(c => c.preventScroll), "a focus call on the next card's box allowed scrolling");
      const focusAt = onNext[0].t;
      const held = hold.find(h => h.classes.includes("nocaret"));
      assert.ok(held && held.t - focusAt < 50, "the caret colour was not held back at once");
      const wide = hold.find(h => h.classes.includes("wide"));
      assert.ok(wide && wide.t - focusAt > 150 && wide.t - focusAt < 500, `the layout switched at the wrong time (${wide && wide.t - focusAt} ms after the focus)`);
      const released = hold.find(h => h.t > held.t && !h.classes.includes("nocaret"));
      assert.ok(released && released.t >= wide.t, "the caret colour came back before the layout had settled");
      assert.ok(released.t - wide.t < 150, `the caret colour came back late (${released.t - wide.t} ms after the layout)`);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}
