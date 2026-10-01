// Option+Enter on the Mac board, the phone page and the typed page, driven headless against their
// own fixture server. The key sends nothing and moves nothing: the page leaves it uncancelled, so the
// text box does with it what it does by default, a new line in a plain box. Enter, Shift+Enter,
// Command+Enter, Control+Enter and double Enter are checked beside it so they are seen unchanged.
//
// A synthetic key carries no operating system key binding, so Option+Enter is sent as a raw key
// event with the edit command the Mac gives that key attached ("insertNewline"). Whether the page
// cancelled the key is read from preventDefault.
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

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

async function clearLane() {
  const state = await (await fetch(origin + "/state")).json();
  for (const box of state.boxes) {
    if (box.owner === "facilitator" && !box.done && !box.parked && !STANDING.includes(box.id)) {
      await api(`/park?box=${box.id}&v=1`);
    }
  }
}

// two cards waiting on the reader (the oldest is where a move lands) and the source the reader types in
async function board(label) {
  await clearLane();
  const ids = {};
  ids.oldest = await create(`${label} oldest waiting`);
  await api(`/reply?box=${ids.oldest}`, "Oldest reply.");
  ids.newer = await create(`${label} newer waiting`);
  await api(`/reply?box=${ids.newer}`, "Newer reply.");
  ids.source = await create(`${label} source`);
  await api(`/reply?box=${ids.source}`, "Source reply.");
  return ids;
}

// every request that matters is kept, and so is every Enter keydown the page cancelled
async function open(viewport, route) {
  const page = await browser.newPage();
  page.problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;
    page.problems.push(message.text());
  });
  page.on("pageerror", error => page.problems.push("pageerror: " + error.message));
  page.posts = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && ["/send", "/create", "/title"].includes(url.pathname)) {
      page.posts.push({ path: url.pathname, box: url.searchParams.get("box"), via: url.searchParams.get("via"), body: request.postData() });
    }
  });
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => {
    try { localStorage.clear(); } catch (err) {}
    window.__cancelled = [];
    const real = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function () {
      if (this.type === "keydown" && this.key === "Enter") window.__cancelled.push(this.altKey ? "alt" : "plain");
      return real.call(this);
    };
  });
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  page.cdp = await page.createCDPSession();
  return page;
}

const posted = (page, from, kind) => page.posts.slice(from).filter(p => p.path === kind);

async function chord(page, key, ...mods) {
  for (const mod of mods) await page.keyboard.down(mod);
  await page.keyboard.press(key);
  for (const mod of [...mods].reverse()) await page.keyboard.up(mod);
}

// Option (1) with Control (2) or Command (4) when asked
async function optionEnter(page, extra = 0) {
  const base = { modifiers: 1 + extra, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, commands: ["insertNewline"] });
  await page.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

const cancelledByPage = page => page.evaluate(() => window.__cancelled.splice(0).includes("alt"));

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

let made = 0;
async function rearm(page, ids) {
  ids.source = await create(`another source ${++made}`);
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

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-option-enter-"));
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
    title: "option enter test",
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
  // an untouched standing card is the reader's turn with the oldest stamp, so a move would land on
  // it before any reply; it is answered once here
  assert.equal((await api("/send?box=0", "A note on the standing card.")).status, 200);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 20000,
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

// ---- the card composer, on the Mac board and on the phone page ------------------------------
const COMPOSERS = [
  { name: "Mac board", viewport: DESKTOP, route: "/" },
  { name: "phone page", viewport: PHONE, route: "/m" },
];

for (const { name, viewport, route } of COMPOSERS) {
  for (const editor of ["formatted", "plain"]) {
    test(`${name}, ${editor} box: Option+Enter sends nothing, moves nothing and is left to the box`, async () => {
      const ids = await board(`${name}-${editor}`);
      const page = await open(viewport, route);
      try {
        await setEditor(page, editor === "formatted");
        await selectCard(page, ids.source);
        const held = () => page.evaluate(card => els[card].ta.value, ids.source);
        const shown = () => page.evaluate(() => selectedId);

        // between two words: a new line, nothing sent, the key not cancelled
        await rearm(page, ids);
        let from = page.posts.length;
        await type(page, "first");
        await optionEnter(page);
        await page.keyboard.type("second");
        await settle(1000);
        assert.equal(posted(page, from, "/send").length, 0, "Option+Enter sent");
        assert.equal(await held(), "first\nsecond");
        assert.equal(await cancelledByPage(page), false, "the page cancelled Option+Enter");
        assert.equal(await shown(), ids.source);

        // with words and a wait: still nothing sent
        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "words");
        await optionEnter(page);
        await settle(1500);
        assert.equal(posted(page, from, "/send").length, 0);
        assert.equal(await shown(), ids.source);

        // in an empty box: nothing sent and no move
        await rearm(page, ids);
        from = page.posts.length;
        await page.focus(SEL);
        await optionEnter(page);
        await settle(1000);
        assert.equal(posted(page, from, "/send").length, 0);
        assert.equal(await shown(), ids.source);

        // after an Enter send it does not make the move a second Enter makes
        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "sent by Enter");
        await page.keyboard.press("Enter");
        await optionEnter(page);
        await settle(1500);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["sent by Enter"]);
        assert.equal(await shown(), ids.source, "Option+Enter after Enter moved the board");

        // chords that carry Option stay out of it too
        for (const extra of [2, 4]) {
          await rearm(page, ids);
          from = page.posts.length;
          await type(page, "words");
          await optionEnter(page, extra);
          await settle(1000);
          assert.equal(posted(page, from, "/send").length, 0, `chord ${extra} sent`);
          assert.equal(await shown(), ids.source);
        }
        assert.deepEqual(page.problems, []);
      } finally {
        await page.close();
      }
    });

    test(`${name}, ${editor} box: Enter, Shift+Enter, Command+Enter, Control+Enter and double Enter are as they were`, async () => {
      const ids = await board(`${name}-${editor}-keys`);
      const page = await open(viewport, route);
      try {
        await setEditor(page, editor === "formatted");
        await selectCard(page, ids.source);
        const shown = () => page.evaluate(() => selectedId);

        await rearm(page, ids);
        let from = page.posts.length;
        await type(page, "plain Enter");
        await page.keyboard.press("Enter");
        await settle(1500);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["plain Enter"]);
        assert.equal(await shown(), ids.source, "Enter moved the board");

        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "one");
        await chord(page, "Enter", "Shift");
        await page.keyboard.type("two");
        await settle(600);
        assert.equal(posted(page, from, "/send").length, 0, "Shift+Enter sent");
        assert.equal(await page.evaluate(card => els[card].ta.value, ids.source), "one\ntwo");

        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "command");
        await chord(page, "Enter", "Meta");
        await settle(1200);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["command"]);
        assert.equal(await shown(), ids.source, "Command+Enter moved the board");

        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "control");
        await chord(page, "Enter", "Control");
        await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["control"]);

        await rearm(page, ids);
        from = page.posts.length;
        await type(page, "double");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
        await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["double"]);
        assert.deepEqual(page.problems, []);
      } finally {
        await page.close();
      }
    });
  }

  test(`${name}: Option+Enter in a card's title leaves it open and saves nothing, Enter saves`, async () => {
    const ids = await board(`${name}-title`);
    const page = await open(viewport, route);
    try {
      await selectCard(page, ids.source);
      await page.evaluate(card => editTitle(card), ids.source);
      await page.waitForFunction(card => els[card].titleEl.isContentEditable, { timeout: 3000 }, ids.source);
      const state = () => page.evaluate(card => ({ open: els[card].titleEl.isContentEditable, text: els[card].titleEl.textContent }), ids.source);
      let from = page.posts.length;
      await page.keyboard.type("Fresh");
      await optionEnter(page);
      await page.keyboard.type("name");
      await settle(500);
      assert.deepEqual(await state(), { open: true, text: "Fresh\nname" });
      assert.equal(posted(page, from, "/title").length, 0, "Option+Enter saved the title");
      assert.equal(await cancelledByPage(page), false);
      from = page.posts.length;
      await page.keyboard.press("Enter");
      await settle(700);
      assert.equal((await state()).open, false);
      assert.equal(posted(page, from, "/title").length, 1);
      assert.deepEqual(page.problems, []);
    } finally {
      await page.close();
    }
  });
}

// ---- the small card and the chat thread, on the Mac board ----------------------------------
test("Mac board small card: Option+Enter sends nothing and is left to the box, the other keys are as they were", async () => {
  const ids = await board("mini");
  const page = await open(DESKTOP, "/");
  try {
    await selectCard(page, ids.source);
    await page.waitForFunction(card => miniOrder.includes(card), { timeout: 5000 }, ids.newer);
    await page.evaluate(card => { miniGo(card); renderMiniCards(lastState); }, ids.newer);
    await page.evaluate(() => { localStorage.setItem("show.facilitator.magic2", "1"); applySavedLayout(); });
    await page.waitForFunction(() => !document.getElementById("magic2").classList.contains("region-off"));
    await settle(200);
    const field = "#magic2 .mbox:not(.off) textarea";
    const held = () => page.evaluate(sel => document.querySelector(sel).value, field);
    const empty = () => page.evaluate(sel => { document.querySelector(sel).value = ""; }, field);

    let from = page.posts.length;
    await page.click(field);
    await page.keyboard.type("first");
    await optionEnter(page);
    await page.keyboard.type("second");
    await settle(800);
    assert.equal(posted(page, from, "/send").length, 0, "Option+Enter sent from the small card");
    assert.equal(await held(), "first\nsecond");
    assert.equal(await cancelledByPage(page), false);

    await empty();
    await page.click(field);
    await page.keyboard.type("by Enter");
    from = page.posts.length;
    await page.keyboard.press("Enter");
    await settle(800);
    assert.deepEqual(posted(page, from, "/send").map(s => [s.via, s.body]), [["mini", "by Enter"]]);

    await page.click(field);
    await page.keyboard.type("one");
    await chord(page, "Enter", "Shift");
    await page.keyboard.type("two");
    assert.equal(await held(), "one\ntwo");

    await empty();
    await page.click(field);
    await page.keyboard.type("by Command");
    from = page.posts.length;
    await chord(page, "Enter", "Meta");
    await settle(800);
    assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["by Command"]);

    await selectCard(page, ids.source);
    await page.click(field);
    await page.keyboard.type("by Control");
    from = page.posts.length;
    await chord(page, "Enter", "Control");
    await page.waitForFunction(card => selectedId === card, { timeout: 4000 }, ids.oldest);
    assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["by Control"]);
    assert.deepEqual(page.problems, []);
  } finally {
    await page.close();
  }
});

test("Mac board chat thread: Option+Enter sends nothing and is left to the box, the other keys are as they were", async () => {
  const page = await open(DESKTOP, "/");
  try {
    await page.evaluate(() => {
      localStorage.setItem("show.facilitator.magic3", "1");
      applySavedLayout();
      chatOff = () => {};
      chatBuild();
    });
    const field = "#magic3 textarea";
    await page.waitForSelector(field, { timeout: 5000 });
    const held = () => page.evaluate(sel => document.querySelector(sel).value, field);
    const empty = () => page.evaluate(sel => { document.querySelector(sel).value = ""; }, field);

    let from = page.posts.length;
    await page.click(field);
    await page.keyboard.type("first");
    await optionEnter(page);
    await page.keyboard.type("second");
    await settle(800);
    assert.equal(posted(page, from, "/send").length, 0, "Option+Enter sent from the chat thread");
    assert.equal(await held(), "first\nsecond");
    assert.equal(await cancelledByPage(page), false);

    await empty();
    await page.click(field);
    await page.keyboard.type("by Enter");
    from = page.posts.length;
    await page.keyboard.press("Enter");
    await settle(800);
    assert.equal(posted(page, from, "/send").length, 1);

    await page.click(field);
    await page.keyboard.type("one");
    await chord(page, "Enter", "Shift");
    await page.keyboard.type("two");
    assert.equal(await held(), "one\ntwo");

    await empty();
    await page.click(field);
    await page.keyboard.type("by Command");
    from = page.posts.length;
    await chord(page, "Enter", "Meta");
    await settle(800);
    assert.equal(posted(page, from, "/send").length, 1);

    await page.click(field);
    await page.keyboard.type("by Control");
    from = page.posts.length;
    await chord(page, "Enter", "Control");
    await settle(800);
    assert.equal(posted(page, from, "/send").length, 1);
    // the fixture's chat box is not a real card, so the board answers each real send with a 400
    assert.deepEqual(page.problems.filter(p => !/status of 400 \(Bad Request\)/.test(p)), []);
  } finally {
    await page.close();
  }
});

// ---- the typed page --------------------------------------------------------------------------
for (const editor of ["formatted", "plain"]) {
  test(`typed page, ${editor} box: Option+Enter sends nothing from a reply line and creates nothing from the new card line`, async () => {
    await clearLane();
    const card = await create(`typed-${editor}`);
    await api(`/reply?box=${card}`, "A reply.");
    const page = await open(DESKTOP, "/page");
    try {
      await page.evaluate(value => ComposeFormat.setEnabled(value), editor === "formatted");
      await page.evaluate(() => ComposeFormat.settled());
      await page.evaluate(() => poll());
      await page.waitForFunction(id => typeof docEls !== "undefined" && !!docEls[id], { timeout: 6000 }, card);
      await settle(200);
      const line = `.docsec[data-id="${card}"] .docreply`;
      const lineText = () => page.evaluate(id => docEls[id].line.textContent, card);
      const lineEmpty = async () => {
        await page.evaluate(id => { docEls[id].line.textContent = ""; }, card);
        await page.click(line);
      };
      const nlText = () => page.evaluate(() => document.getElementById("docnew").textContent);
      const nlEmpty = async () => {
        await page.evaluate(() => { document.getElementById("docnew").textContent = ""; });
        await page.click("#docnew");
      };

      // the reply line
      await page.click(line);
      let from = page.posts.length;
      await page.keyboard.type("first");
      await optionEnter(page);
      await page.keyboard.type("second");
      await settle(800);
      assert.equal(posted(page, from, "/send").length, 0, "Option+Enter sent from the reply line");
      assert.equal(await lineText(), "first\nsecond");
      assert.equal(await cancelledByPage(page), false);

      await lineEmpty();
      await page.keyboard.type("by Enter");
      from = page.posts.length;
      await page.keyboard.press("Enter");
      await settle(800);
      assert.deepEqual(posted(page, from, "/send").map(s => s.body), ["by Enter"]);

      await lineEmpty();
      await page.keyboard.type("one");
      await chord(page, "Enter", "Shift");
      await page.keyboard.type("two");
      assert.equal(await lineText(), "one\ntwo");

      for (const [label, mod] of [["by Command", "Meta"], ["by Control", "Control"]]) {
        await lineEmpty();
        await page.keyboard.type(label);
        from = page.posts.length;
        await chord(page, "Enter", mod);
        await settle(800);
        assert.deepEqual(posted(page, from, "/send").map(s => s.body), [label]);
      }

      // the new card line
      await page.click("#docnew");
      from = page.posts.length;
      await page.keyboard.type("first");
      await optionEnter(page);
      await page.keyboard.type("second");
      await settle(800);
      assert.equal(posted(page, from, "/create").length + posted(page, from, "/send").length, 0, "Option+Enter made a card");
      assert.equal(await nlText(), "first\nsecond");
      assert.equal(await cancelledByPage(page), false);

      await nlEmpty();
      await page.keyboard.type("One");
      await chord(page, "Enter", "Shift");
      await page.keyboard.type("two");
      assert.equal(await nlText(), "One\ntwo");

      for (const [label, mod] of [[`Name by Enter ${editor}`, null], [`Name by Command ${editor}`, "Meta"], [`Name by Control ${editor}`, "Control"]]) {
        await nlEmpty();
        await page.keyboard.type(label);
        from = page.posts.length;
        if (mod) await chord(page, "Enter", mod); else await page.keyboard.press("Enter");
        await settle(900);
        assert.deepEqual(posted(page, from, "/create").map(s => s.body), [label]);
      }
      assert.deepEqual(page.problems, []);
    } finally {
      await page.close();
    }
  });
}

test("typed page: Option+Enter in a chat title leaves it open and saves nothing, Enter saves", async () => {
  await clearLane();
  const card = await create("typed-title");
  await api(`/reply?box=${card}`, "A reply.");
  const page = await open(DESKTOP, "/page");
  try {
    await page.evaluate(() => poll());
    await page.waitForFunction(id => typeof docEls !== "undefined" && !!docEls[id], { timeout: 6000 }, card);
    await settle(200);
    await page.evaluate(id => docEditTitle(id), card);
    await page.waitForFunction(id => docEls[id].title.isContentEditable, { timeout: 3000 }, card);
    await page.evaluate(id => {
      const t = docEls[id].title;
      t.focus();
      const range = document.createRange();
      range.selectNodeContents(t);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, card);
    const state = () => page.evaluate(id => ({ open: docEls[id].title.isContentEditable, text: docEls[id].title.textContent }), card);
    let from = page.posts.length;
    await page.keyboard.type("Fresh");
    await optionEnter(page);
    await page.keyboard.type("name");
    await settle(500);
    assert.deepEqual(await state(), { open: true, text: "Fresh\nname" });
    assert.equal(posted(page, from, "/title").length, 0, "Option+Enter saved the title");
    assert.equal(await cancelledByPage(page), false);
    from = page.posts.length;
    await page.keyboard.press("Enter");
    await settle(700);
    assert.equal((await state()).open, false);
    assert.equal(posted(page, from, "/title").length, 1);
    assert.deepEqual(page.problems, []);
  } finally {
    await page.close();
  }
});
