// The phone composer's formatting editor and the keyboard, driven headless at
// an iPhone size against its own fixture server. Headless Chrome cannot raise a
// keyboard or run iOS's caret reveal, so the keyboard is played by a stand-in
// visual viewport the tests shrink and grow themselves, and these tests pin the
// wiring the page puts in the reveal's way: which element a tap focuses, that
// the tap's own default is refused and focus is taken by hand without a scroll,
// that the caret lands where the finger did, that the one-frame blink is on the
// focused content, that no scroll into view runs while the keyboard is opening,
// that the content's scroller is not a scroll container while the words fit, and
// that a keystroke in the editor resets the shove budget. Every card, reply and
// draft below is invented for the test.
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
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || "python3";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const KEYBOARD = 336;              // an iPhone keyboard with its accessory bar, in css px
const SEL = "article.box.sel textarea";
const CONTENT = "article.box.sel .cm-content";
const SCROLLER = "article.box.sel .cm-scroller";

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

// the stand-in visual viewport: the page reads window.visualViewport, and this
// puts an object the test moves in its place before the page's scripts run.
function fakeViewport() {
  const vv = new EventTarget();
  const geom = { height: null, width: null, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 };
  Object.defineProperty(vv, "height", { get: () => geom.height ?? window.innerHeight });
  Object.defineProperty(vv, "width", { get: () => geom.width ?? window.innerWidth });
  for (const key of ["offsetTop", "offsetLeft", "pageTop", "pageLeft", "scale"]) Object.defineProperty(vv, key, { get: () => geom[key] });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  window.__keyboard = {
    set(height, offsetTop = 0, scale = 1) {
      geom.height = height;
      geom.offsetTop = offsetTop;
      geom.scale = scale;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    },
  };
}

async function openPhone(route, { fake = false, viewport = PHONE } = {}) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(viewport);
  if (fake) await page.evaluateOnNewDocument(fakeViewport);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// the editor stands in for the field with formatting on, which is the default.
// wait for its content element to arrive, so a tap has something to land on
async function openEditor(id, opts) {
  const opened = await openPhone(`/m?box=${id}`, opts);
  await opened.page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
  await opened.page.waitForSelector(CONTENT, { timeout: 5000 });
  return opened;
}

// the lines are made with shift and return: with no on-screen keyboard the row
// reads a plain return as the send, so a new line is a shifted return
async function typeLines(page, count, from = 1) {
  for (let n = from; n <= count; n++) {
    if (n > 1) {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    }
    await page.keyboard.type(`line ${n}`);
  }
}

// which line the caret sits on, counted the way the page counts a plain field:
// the returns before the caret, plus one
function caretLine(page) {
  return page.evaluate(() => {
    const ta = document.querySelector("article.box.sel textarea");
    return ta.value.slice(0, ta.selectionEnd).split("\n").length;
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-editor-keyboard-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone editor keyboard test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(PYTHON, [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(port),
      FACILITATOR_LOG_DIR: process.env.FACILITATOR_LOG_DIR || path.join(fixtureDir, "logs") },
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

// watch one tap: the content's own focus call and its options, the tap's
// prevented state as a plain bystander sees it, and the window's own scroll
async function watchTap(page) {
  await page.evaluate(() => {
    const content = document.querySelector("article.box.sel .cm-content");
    window.__focusOpts = null;
    if (!content.__wrapped) {
      const native = content.focus.bind(content);
      content.focus = function (opts) {
        window.__focusOpts = { called: true, preventScroll: !!(opts && opts.preventScroll) };
        return native(opts);
      };
      content.__wrapped = true;
    }
    window.__defaultPrevented = null;
    if (!window.__mdWatch) {
      document.addEventListener("mousedown", e => { window.__defaultPrevented = e.defaultPrevented; }, false);
      window.__mdWatch = true;
    }
    window.__scrollAt = { x: window.scrollX, y: window.scrollY };
  });
}

async function tapContent(page, dx, dy) {
  const geo = await page.evaluate(() => {
    const content = document.querySelector("article.box.sel .cm-content");
    const rect = content.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(content).lineHeight) || 25.5;
    return { top: rect.top, left: rect.left, lh };
  });
  await page.touchscreen.tap(geo.left + dx, geo.top + (dy.line != null ? dy.line * geo.lh + geo.lh / 2 : dy.px));
  await settle(120);
  return page.evaluate(() => ({
    active: document.activeElement === document.querySelector("article.box.sel .cm-content"),
    focus: window.__focusOpts,
    prevented: window.__defaultPrevented,
    scrolled: window.scrollX !== window.__scrollAt.x || window.scrollY !== window.__scrollAt.y,
  }));
}

// ---- unit 1: the tap take-over on the editor content ---------------------------------
test("a tap on the formatted editor is refused its own focus and the caret is placed by hand", async () => {
  const id = await create("Editor tap take-over");
  await api(`/reply?box=${id}`, "A reply to answer.");
  const { page, problems } = await openEditor(id);
  try {
    // the empty row, fresh and unfocused: the tap is taken over and the caret
    // lands at its one position
    await watchTap(page);
    const empty = await tapContent(page, 20, { px: 8 });
    assert.equal(empty.active, true, "the empty row's tap did not focus the editor content");
    assert.equal(empty.prevented, true, "the empty row's tap default was not refused");
    assert.ok(empty.focus && empty.focus.preventScroll, "the empty row's focus did not carry preventScroll");
    assert.equal(await caretLine(page), 1, "the empty row's caret is not at its one position");
    assert.equal(empty.scrolled, false, "the empty row's take-over scrolled the window");

    // three lines, blurred, scrolled to the head: the tap under test lands on a
    // line that is not the first
    await typeLines(page, 3);
    await page.evaluate(() => { document.activeElement.blur(); document.querySelector("article.box.sel .cm-scroller").scrollTop = 0; });
    await settle(60);
    await watchTap(page);
    const held = await tapContent(page, 20, { line: 1 });   // the second line, zero based
    assert.equal(held.active, true, "the tap did not focus the editor content");
    assert.equal(held.prevented, true, "the tap's own default focus was not refused");
    assert.ok(held.focus && held.focus.called, "the content's focus was not called by hand");
    assert.equal(held.focus.preventScroll, true, "the hand made focus did not carry preventScroll");
    assert.equal(await caretLine(page), 2, "the caret did not land on the tapped line");
    assert.equal(held.scrolled, false, "the take-over scrolled the window");

    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
