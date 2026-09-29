// The desktop board's two ways to the next unread card besides a second Enter:
// command+j, and the board moving on by itself after IDLE_JUMP_MS of no input
// following a send. Driven headless against a copy of the server in
// a temporary folder, at the size the board is used at. Every route ends in
// jumpNextYellow, which the page is asked to log, so each case can name the card
// and the moment it moved.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DESKTOP = { width: 1512, height: 982, deviceScaleFactor: 2 };
const SEL = "article.box.sel textarea";
const SHOTS = process.env.JUMP_SHOTS || "";

let browser;
let child;
let fixtureDir;
let origin;

async function api(route, body) {
  const response = await fetch(origin + route, { method: "POST", body });
  return { status: response.status, body: await response.json() };
}

async function create(title) {
  const result = await api("/create?owner=facilitator", title);
  assert.equal(result.status, 200);
  return result.body.id;
}

async function settle(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// every card a test before left is put out of the doing view
async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked) await api(`/park?box=${box.id}&v=1`);
  }
}

// The send happens on src. early was answered before late, and late was made
// first, so the card that has waited longest is neither the first nor the last
// in the list. busy is a card the agent is working on, which is never a target.
async function scene({ waiting = true } = {}) {
  await clearLane();
  const src = await create("Sends from here");
  const late = waiting ? await create("Answered second") : null;
  const early = waiting ? await create("Answered first") : null;
  const busy = await create("The agent is working");
  await api(`/reply?box=${src}`, "Waiting on the reader.");
  if (waiting) {
    await api(`/reply?box=${early}`, "Waiting on the reader, first.");
    await settle(150);
    await api(`/reply?box=${late}`, "Waiting on the reader, second.");
  }
  await api(`/send?box=${busy}`, "Working on it");
  return { src, late, early, busy };
}

// face is the shape of the typing row: "editor" is the formatted editor, on by
// default, and "plain" is the textarea it replaces
async function openDesktop(face = "editor") {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(DESKTOP);
  await page.evaluateOnNewDocument(plain => {
    try {
      localStorage.clear();
      if (plain) localStorage.setItem("composeformat", "0");
    } catch (err) {}
  }, face === "plain");
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  if (face === "editor") {
    await page.evaluate(() => ComposeFormat.settled());
    await page.waitForFunction(() => !!document.querySelector("article.box .cffield"), { timeout: 8000 });
  }
  return { page, problems };
}

async function assertFace(page, face) {
  const wearing = await page.evaluate(() => !!document.querySelector("article.box.sel .cffield"));
  assert.equal(wearing, face === "editor", `the typing row is not the ${face} face`);
}

async function selectDesktop(page, id) {
  await page.waitForFunction(cardId => !!els[cardId], { timeout: 5000 }, id);
  await page.evaluate(cardId => select(cardId), id);
  await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
}

// notes when each send was answered and each call of the jump, with what it was asked
async function watch(page) {
  await page.evaluate(() => {
    window.__sent = [];
    window.__jumps = [];
    const nativeFetch = window.fetch;
    window.fetch = async (...args) => {
      const answer = await nativeFetch(...args);
      if (new URL(String(args[0]), location.href).pathname === "/send" && answer.ok) window.__sent.push(performance.now());
      return answer;
    };
    const real = window.jumpNextYellow;
    window.jumpNextYellow = (...args) => {
      const to = real(...args);
      window.__jumps.push({ at: performance.now(), from: args[0], opts: args[1] || null, to: to || null });
      return to;
    };
  });
}

const sentAt = page => page.evaluate(() => window.__sent.slice());
const jumps = page => page.evaluate(() => window.__jumps.slice());
const shown = page => page.evaluate(() => selectedId);

// type a line into the selected card and send it with one Enter, then wait for
// the board to have the answer, which is when the wait begins
async function sendOne(page, text) {
  const before = (await sentAt(page)).length;
  await page.focus(SEL);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction(n => window.__sent.length > n, { timeout: 3000 }, before);
  return (await sentAt(page))[before];
}

// the ms left until t0 + span, as this page's clock counts them
function until(page, t0, span) {
  return page.evaluate(({ t0, span }) => Math.max(0, t0 + span - performance.now()), { t0, span });
}

async function shot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

// The card's typing row is a plain textarea, or the editor that takes its place
// when typed formatting is on; either is the row.
function activeRow(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const box = el && el.closest ? el.closest("article.box") : null;
    const row = !!el && (el.tagName === "TEXTAREA"
      ? !el.classList.contains("cfmirror")
      : !!(el.closest && el.closest(".cffield")));
    return { row, box: box ? box.id.replace(/^box-/, "") : null };
  });
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-jump-"));
  const logs = path.join(fixtureDir, "logs");
  await mkdir(logs);
  const port = await freePortPair();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "compose-format.js", "index.html", "page.html", "cm-markdown.js", "card-report.js"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "jump to unread test",
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
  const deadline = Date.now() + 8000;
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

test("the wait is five seconds and command j is a recognised card chord of the desktop only", async () => {
  const { page, problems } = await openDesktop();
  try {
    assert.equal(await page.evaluate(() => IDLE_JUMP_MS), 5000);
    const chords = await page.evaluate(() => {
      const ev = (key, over = {}) => ({
        key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        defaultPrevented: false, isComposing: false, repeat: false, ...over,
      });
      const name = e => { const s = cardShortcut(e); return s ? s.action : null; };
      return {
        j: name(ev("j", { metaKey: true })),
        capital: name(ev("J", { metaKey: true })),
        mini: cardShortcut(ev("j", { metaKey: true }), "mini"),
        plain: name(ev("j")),
        control: name(ev("j", { ctrlKey: true })),
        shift: name(ev("j", { metaKey: true, shiftKey: true })),
        option: name(ev("j", { metaKey: true, altKey: true })),
        held: name(ev("j", { metaKey: true, repeat: true })),
        composing: name(ev("j", { metaKey: true, isComposing: true })),
        cancelled: name(ev("j", { metaKey: true, defaultPrevented: true })),
        create: name(ev("t", { metaKey: true })),
      };
    });
    assert.deepEqual(chords, {
      j: "jumpUnread", capital: "jumpUnread", mini: null, plain: null, control: null,
      shift: null, option: null, held: null, composing: null, cancelled: null, create: "create",
    });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

for (const face of ["editor", "plain"]) test(`command j from the typing box lands on the card a second Enter lands on (${face} typing row)`, async () => {
  const s = await scene();
  const { page, problems } = await openDesktop(face);
  try {
    await selectDesktop(page, s.src);
    await assertFace(page, face);
    await watch(page);
    await page.focus(SEL);
    await page.keyboard.type("first message");
    if (face === "editor") await shot(page, "01-before-double-enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, s.early);
    if (face === "editor") await shot(page, "02-after-double-enter");
    const byEnter = await jumps(page);

    await selectDesktop(page, s.src);
    await page.focus(SEL);
    await page.keyboard.type("a thought still being typed");
    if (face === "editor") await shot(page, "03-before-command-j");
    await page.keyboard.down("Meta");
    await page.keyboard.press("j");
    await page.keyboard.up("Meta");
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, s.early);
    if (face === "editor") await shot(page, "04-after-command-j");
    const all = await jumps(page);

    assert.equal(byEnter.length, 1, "a second Enter did not make exactly one jump");
    assert.equal(all.length, 2, "command j did not make exactly one jump");
    const [viaEnter, viaKey] = all;
    assert.equal(viaEnter.to, s.early, "a second Enter did not land on the card that has waited longest");
    assert.equal(viaKey.to, viaEnter.to, "command j landed on another card than a second Enter");
    assert.equal(viaKey.from, viaEnter.from);
    assert.deepEqual(viaKey.opts, viaEnter.opts, "command j asked the jump for something else");
    assert.deepEqual(await activeRow(page), { row: true, box: s.early },
      "the caret did not land in the composer of the card jumped to");
    assert.equal(await page.evaluate(id => els[id].ta.value, s.src), "a thought still being typed",
      "the draft left behind was changed, or the j was typed into it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("command j works with nothing focused, and other j chords do nothing", async () => {
  const s = await scene();
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);
    await page.focus(SEL);
    for (const mods of [["Control"], ["Meta", "Shift"], ["Meta", "Alt"]]) {
      for (const mod of mods) await page.keyboard.down(mod);
      await page.keyboard.press("j");
      for (const mod of [...mods].reverse()) await page.keyboard.up(mod);
    }
    await page.$eval(SEL, field => field.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j", metaKey: true, repeat: true, bubbles: true, cancelable: true,
    })));
    await settle(400);
    assert.equal(await shown(page), s.src, "a chord that is not command j moved the board");
    assert.deepEqual(await jumps(page), []);

    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.down("Meta");
    await page.keyboard.press("j");
    await page.keyboard.up("Meta");
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, s.early);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

for (const face of ["editor", "plain"]) test(`five quiet seconds after a send land on the card a second Enter lands on (${face} typing row)`, async () => {
  const s = await scene();
  const { page, problems } = await openDesktop(face);
  try {
    await selectDesktop(page, s.src);
    await assertFace(page, face);
    await watch(page);
    const t0 = await sendOne(page, "then I go quiet");
    await settle(4000);
    assert.equal(await shown(page), s.src, "the board moved before the wait was over");
    assert.deepEqual(await jumps(page), []);
    if (face === "editor") await shot(page, "05-before-idle-jump");
    await page.waitForFunction(id => selectedId === id, { timeout: 3000 }, s.early);
    const [jump] = await jumps(page);
    const waited = jump.at - t0;
    assert.ok(waited >= 4900 && waited <= 5900, `the board moved ${Math.round(waited)}ms after the send`);
    assert.deepEqual({ from: jump.from, opts: jump.opts, to: jump.to },
      { from: s.src, opts: { focus: true }, to: s.early },
      "the idle jump asked for something other than a second Enter asks for");
    assert.deepEqual(await activeRow(page), { row: true, box: s.early });
    if (face === "editor") await shot(page, "06-after-idle-jump");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("typing, a click or a turn of the wheel within the wait cancels it", async () => {
  const s = await scene();
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);

    let t0 = await sendOne(page, "quiet, then a key");
    await settle(2000);
    await page.keyboard.type("x");
    await settle(await until(page, t0, 6500));
    assert.equal(await shown(page), s.src, "typing did not cancel the wait");
    assert.deepEqual(await jumps(page), []);
    assert.equal(await page.$eval(SEL, field => field.value), "x");
    await page.$eval(SEL, field => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); });

    t0 = await sendOne(page, "quiet, then a click");
    await settle(2000);
    await page.click(SEL);
    await settle(await until(page, t0, 6500));
    assert.equal(await shown(page), s.src, "a click did not cancel the wait");
    assert.deepEqual(await jumps(page), []);

    t0 = await sendOne(page, "quiet, then the wheel");
    await settle(2000);
    const box = await (await page.$("article.box.sel")).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel({ deltaY: 240 });
    await settle(await until(page, t0, 6500));
    assert.equal(await shown(page), s.src, "scrolling did not cancel the wait");
    assert.deepEqual(await jumps(page), []);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("switching card within the wait cancels it", async () => {
  const s = await scene();
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);
    const t0 = await sendOne(page, "quiet, then another card and back");
    await settle(1500);
    await page.evaluate(id => select(id), s.busy);
    await page.evaluate(id => select(id), s.src);
    await settle(await until(page, t0, 6500));
    assert.equal(await shown(page), s.src, "switching card did not cancel the wait");
    assert.deepEqual(await jumps(page), []);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a second send restarts the wait from that send", async () => {
  const s = await scene();
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);
    const first = await sendOne(page, "the first of two");
    await settle(await until(page, first, 3000));
    const second = await sendOne(page, "the second of two");
    assert.ok(second - first >= 3000, "the second send came too soon to tell the waits apart");
    await settle(await until(page, first, 5800));
    assert.equal(await shown(page), s.src, "the wait ran on from the first send");
    assert.deepEqual(await jumps(page), []);
    await page.waitForFunction(id => selectedId === id, { timeout: 5000 }, s.early);
    const [jump] = await jumps(page);
    const waited = jump.at - second;
    assert.ok(waited >= 4900 && waited <= 5900, `the board moved ${Math.round(waited)}ms after the second send`);
    assert.ok(jump.at - first >= 7900, "the board moved in step with the first send");
    assert.equal((await jumps(page)).length, 1);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a send that fails starts no wait", async () => {
  const s = await scene();
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);
    await page.evaluate(() => {
      const before = window.fetch;
      window.fetch = (...args) => new URL(String(args[0]), location.href).pathname === "/send"
        ? Promise.resolve(new Response("", { status: 500 })) : before(...args);
    });
    await page.focus(SEL);
    await page.keyboard.type("this one is refused");
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => els[id].metaNote.textContent.includes("send failed"), { timeout: 3000 }, s.src);
    await settle(6000);
    assert.equal(await shown(page), s.src);
    assert.deepEqual(await jumps(page), []);
    assert.deepEqual(problems.filter(problem => !/status of 500/.test(problem)), []);
  } finally {
    await page.close();
  }
});

test("with no unread card a send and the jump key leave the board where it is", async () => {
  const s = await scene({ waiting: false });
  const { page, problems } = await openDesktop();
  try {
    await selectDesktop(page, s.src);
    await watch(page);
    const t0 = await sendOne(page, "nobody else is waiting");
    await shot(page, "07-no-unread-before");
    await settle(await until(page, t0, 6200));
    assert.equal(await shown(page), s.src, "the wait moved the board with no unread card");
    assert.ok((await jumps(page)).every(jump => !jump.to), "the wait landed somewhere");
    await page.keyboard.down("Meta");
    await page.keyboard.press("j");
    await page.keyboard.up("Meta");
    await settle(400);
    assert.equal(await shown(page), s.src, "command j moved the board with no unread card");
    assert.ok((await jumps(page)).every(jump => !jump.to), "command j landed somewhere");
    await shot(page, "08-no-unread-after");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
