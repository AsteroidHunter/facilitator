// The phone page at /m, driven headless at an iPhone size against its own
// fixture server: the tabs, the one card with thin margins, the drawer off the
// left edge, the shared renderer, the composer, the close cross, the manifest
// and the service worker. Screenshots land under /tmp/m362-shots.
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
const SHOTS = "/tmp/m362-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
// a one pixel png, for the attach button
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");

let browser;
let child;
let fixtureDir;
let origin;
const uploaded = [];

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

async function savedBox(id) {
  const state = await (await fetch(origin + "/state")).json();
  return state.boxes.find(box => box.id === id);
}

async function openPhone(route, prepare) {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  if (prepare) await prepare(page);
  await page.goto(origin + route, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  return { page, problems };
}

async function settle(ms = 250) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require('./fixture-auth.cjs').copyBridgeFiles(require('node:path').dirname(path.join(fixtureDir, "server.py")));
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone page test",
    items: [
      { id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." },
      { id: "1.1", bucket: "now", title: "A pastureland card", owner: "pastureland", context: "Its own lane." },
    ],
  }));

  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.env.FACILITATOR_TEST_PYTHON || "python3", [path.join(fixtureDir, "server.py")], {
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
  // uploads land in the sibling internal folder of the fixture, outside it
  for (const name of uploaded) {
    await rm(path.join(fixtureDir, "..", "facilitator-internal", "uploads", name), { force: true });
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("the card fills the phone with thin margins, tabs on top, prose through the shared renderer", async () => {
  const id = await create("Phone page renders the shared markdown");
  const reply = "The phone card shows the **full** reply.\n\nSee [the runbook](https://example.com/runbook) and this block:\n\n" +
    "```python\nprint('hello from the card')\n```\n\n- one\n- two";
  assert.equal((await api(`/reply?box=${id}`, reply)).status, 200);
  assert.equal((await api(`/send?box=${id}`, "Please also handle the **second** case")).status, 200);

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    const shape = await page.evaluate(() => {
      const pane = document.getElementById("pane").getBoundingClientRect();
      const bar = document.querySelector(".bar").getBoundingClientRect();
      return {
        tabs: [...document.querySelectorAll("#tabbar .ptab")].map(t => t.textContent),
        activeTab: document.querySelector("#tabbar .ptab.on")?.dataset.owner,
        barTop: bar.top, barBottom: bar.bottom,
        left: pane.left, top: pane.top,
        right: innerWidth - pane.right, bottom: innerHeight - pane.bottom,
        width: innerWidth, height: innerHeight,
        visible: [...document.querySelectorAll("article.box")].filter(b => getComputedStyle(b).display !== "none").length,
        nothingElse: !document.querySelector("#magic1, #magic2, #magic3, #qchat, #clockbox"),
      };
    });
    assert.equal(shape.tabs.length, 2, "one tab per project lane");
    assert.ok(shape.tabs.every(label => label.trim().length > 0), "a tab without a label");
    assert.equal(shape.activeTab, "facilitator");
    assert.ok(shape.barTop >= 4 && shape.barTop <= 12, `tabs sit at the top with a thin margin (${shape.barTop})`);
    assert.ok(shape.left >= 4 && shape.left <= 12, `thin left margin (${shape.left})`);
    assert.ok(shape.right >= 4 && shape.right <= 12, `thin right margin (${shape.right})`);
    assert.ok(shape.bottom >= 4 && shape.bottom <= 12, `thin bottom margin (${shape.bottom})`);
    assert.ok(shape.top >= shape.barBottom && shape.top <= shape.barBottom + 12, "the card starts right under the tabs");
    assert.equal(shape.visible, 1, "exactly one card is shown");
    assert.ok(shape.nothingElse, "nothing but tabs, card and drawer");

    const prose = await page.evaluate(() => {
      const box = document.querySelector("article.box.sel");
      const reply = box.querySelector(".reply");
      const pend = box.querySelector(".pendmsg .pendcontent");
      return {
        sharedRenderer: typeof window.CardMarkdown?.render === "function",
        replyMatchesRenderer: (() => {
          const again = document.createElement("div");
          again.innerHTML = window.CardMarkdown.render(reply.dataset.raw);
          return again.innerHTML === reply.innerHTML;
        })(),
        replyIsCardmd: reply.classList.contains("cardmd"),
        link: reply.querySelector('a[href="https://example.com/runbook"]')?.textContent,
        code: reply.querySelector("pre.codeblock code")?.textContent,
        codeLanguage: reply.querySelector(".codeblockwrap")?.dataset.language,
        bold: reply.querySelector("b")?.textContent,
        listItems: reply.querySelectorAll("li").length,
        pendIsCardmd: pend?.classList.contains("cardmd"),
        pendBold: pend?.querySelector("b")?.textContent,
        pendWord: box.querySelector(".pendmsg .rcpt")?.textContent,
        title: box.querySelector(".title").textContent,
        replyFont: getComputedStyle(reply).fontSize,
        titleFamily: getComputedStyle(box.querySelector(".title")).fontFamily,
      };
    });
    assert.equal(prose.sharedRenderer, true);
    assert.equal(prose.replyMatchesRenderer, true, "the reply is not the shared renderer's output");
    assert.equal(prose.replyIsCardmd, true);
    assert.equal(prose.link, "the runbook");
    assert.equal(prose.code, "print('hello from the card')");
    assert.equal(prose.codeLanguage, "python");
    assert.equal(prose.bold, "full");
    assert.equal(prose.listItems, 2);
    assert.equal(prose.pendIsCardmd, true, "sent messages do not go through the shared renderer");
    assert.equal(prose.pendBold, "second");
    assert.equal(prose.pendWord, "Delivered");
    assert.equal(prose.title, "Phone page renders the shared markdown");
    assert.equal(prose.replyFont, "17px");
    assert.match(prose.titleFamily, /Inter/);
    await page.screenshot({ path: path.join(SHOTS, "test-phone-card.png") });

    await page.evaluate(() => document.querySelector("article.box.sel .pendhead").click());
    await settle();
    const open = await page.evaluate(() => ({
      open: document.querySelector("article.box.sel .pendlist").classList.contains("open"),
      stamp: document.querySelector("article.box.sel .pendstamp").textContent,
    }));
    assert.equal(open.open, true);
    assert.match(open.stamp, /\d{1,2}:\d{2} (AM|PM)$/);
    await page.screenshot({ path: path.join(SHOTS, "test-phone-card-sent-open.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a warm notification target survives stale state and switches projects when it arrives", async () => {
  const { page, problems } = await openPhone("/m");
  const stale = await (await fetch(origin + "/m/state")).json();
  let heldRequest = null;
  try {
    await page.setRequestInterception(true);
    let armed = true;
    page.on("request", request => {
      if (armed && new URL(request.url()).pathname === "/m/state") {
        armed = false;
        heldRequest = request;
      } else {
        request.continue();
      }
    });
    const deadline = Date.now() + 3000;
    while (!heldRequest && Date.now() < deadline) await settle(20);
    assert.ok(heldRequest, "no in-flight reading was captured");

    const made = await api("/create?owner=pastureland", "Notification target made during a reading");
    assert.equal(made.status, 200);
    const target = made.body.id;
    const before = await page.evaluate(() => selectedId);
    await page.evaluate(id => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { box: id } }));
    }, target);
    assert.deepEqual(await page.evaluate(() => ({ wantBox, lastRev, selectedId })),
      { wantBox: target, lastRev: null, selectedId: before });

    await heldRequest.respond({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
    heldRequest = null;
    await page.waitForFunction(id => selectedId === id && activeOwner === "pastureland" && wantBox === null,
      { timeout: 5000 }, target);
    const result = await page.evaluate(id => {
      wantBox = "older-pending-target";
      goToBox(id);
      return { selectedId, activeOwner, storedOwner: localStorage.getItem("activeproj"), wantBox };
    }, target);
    assert.deepEqual(result, {
      selectedId: target, activeOwner: "pastureland", storedOwner: "pastureland", wantBox: null,
    });
    await page.evaluate(() => {
      activeOwner = "facilitator";
      localStorage.setItem("activeproj", activeOwner);
    });
    assert.deepEqual(problems, []);
  } finally {
    if (heldRequest) await heldRequest.continue();
    await page.close();
  }
});

test("a full reading requested before create cannot erase the card being named", async () => {
  const { page, problems } = await openPhone("/m");
  const stale = await (await fetch(origin + "/m/state")).json();
  const standingTitle = stale.boxes.find(box => box.id === "0").title;
  const held = [];
  const stateQueries = [];
  let stateRequests = 0;
  let intercepting = false;
  const onRequest = request => {
    const url = new URL(request.url());
    if (url.pathname === "/m/state") stateQueries.push(url.searchParams.get("since"));
    if (url.pathname === "/m/state" && ++stateRequests <= 2) held.push(request);
    else request.continue();
  };
  try {
    await page.waitForFunction(() => pollRun === null, { timeout: 3000 });
    await page.evaluate(() => { clearTimeout(pollTimer); pollTimer = null; });
    const priorRev = await page.evaluate(() => lastRev);
    assert.equal(stale.rev, priorRev);
    await page.setRequestInterception(true);
    intercepting = true;
    page.on("request", onRequest);
    await page.evaluate(() => { poll(); });
    const deadline = Date.now() + 3000;
    while (held.length < 1 && Date.now() < deadline) await settle(20);
    assert.equal(held.length, 1, "no pre-create reading was captured");
    assert.equal(stateQueries[0], String(priorRev));

    assert.equal((await api("/title?box=0", "Changed while the old reading was held")).status, 200);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/create");
    await page.evaluate(() => createCard());
    const result = await (await created).json();
    await page.waitForFunction(id => document.querySelector(`#box-${id}.sel .title`)?.isContentEditable,
      { timeout: 3000 }, result.id);
    await page.keyboard.type("Naming during delayed reading");
    await held.shift().respond({ status: 200, contentType: "application/json", body: JSON.stringify(stale) });
    const freshDeadline = Date.now() + 3000;
    while (held.length < 1 && Date.now() < freshDeadline) await settle(20);
    assert.equal(held.length, 1, "no fresh reading followed the stale one");
    assert.deepEqual(await page.evaluate(id => ({
      present: !!document.getElementById(`box-${id}`),
      selected: selectedId === id,
      editing: !!els[id]?.titleEl.isContentEditable,
      focused: document.activeElement === els[id]?.titleEl,
      title: els[id]?.titleEl.textContent || "",
      createOps: ops.filter(op => op.kind === "create").length,
      drawerOpen: document.getElementById("drawer").classList.contains("open"),
    }), result.id), {
      present: true, selected: true, editing: true, focused: true,
      title: "Naming during delayed reading", createOps: 0, drawerOpen: false,
    });
    assert.equal(stateQueries[1], String(priorRev), "the create receipt was substituted for the last full-state revision");

    await held.shift().continue();
    await page.waitForFunction(({ id, rev }) => createRevFloor === null && lastRev >= rev &&
      lastState?.boxes.some(box => box.id === id) &&
      lastState?.boxes.find(box => box.id === "0")?.title === "Changed while the old reading was held",
      { timeout: 3000 }, { id: result.id, rev: result.rev });
    assert.deepEqual(await page.evaluate(id => ({
      selected: selectedId === id,
      editing: els[id]?.titleEl.isContentEditable,
      focused: document.activeElement === els[id]?.titleEl,
      title: els[id]?.titleEl.textContent,
    }), result.id), {
      selected: true, editing: true, focused: true, title: "Naming during delayed reading",
    });
    await page.evaluate(() => { clearTimeout(pollTimer); pollTimer = null; });
    page.off("request", onRequest);
    await page.setRequestInterception(false);
    intercepting = false;
    await page.keyboard.press("Enter");
    await page.waitForFunction(id => lastState?.boxes.find(box => box.id === id)?.title === "Naming during delayed reading",
      { timeout: 3000 }, result.id);
    assert.equal((await savedBox(result.id)).title, "Naming during delayed reading");

    const later = await api("/create?owner=facilitator", "");
    assert.equal(later.status, 200);
    await page.evaluate(() => { poll(); });
    await page.waitForFunction(id => !!els[id] && createRevFloor === null, { timeout: 3000 }, later.body.id);
    assert.equal((await api(`/close?box=${later.body.id}`)).status, 200);
    await page.evaluate(() => { poll(); });
    await page.waitForFunction(id => !els[id] && !lastState?.boxes.some(box => box.id === id),
      { timeout: 3000 }, later.body.id);
    assert.deepEqual(problems, []);
  } finally {
    if (intercepting){
      for (const request of held) if (!request.isInterceptResolutionHandled()) await request.continue();
      page.off("request", onRequest);
      await page.setRequestInterception(false);
    }
    await page.close();
    await api("/title?box=0", standingTitle);
  }
});

test("phone navigation waits for send confirmation, respects manual moves, and stays in the selected workspace", async () => {
  const { page, problems } = await openPhone("/m");
  try {
    const initial = await page.evaluate(() => {
      clearTimeout(pollTimer); pollTimer = null;
      const sample = lastState.boxes.find(box => box.owner === "facilitator");
      const card = (id, title, ws, state, ball, agentTs, ts) => ({
        ...sample, id, title, ws, state, ball, agentTs, ts,
        done: false, parked: false, writing: false, bg: false, pending: 0,
        pendingTexts: [], pendingStamps: [], replies: 1, reply: title, replyFull: title,
      });
      lastState.boxes = lastState.boxes.filter(box => box.owner !== "facilitator").concat([
        card("nav-a", "Selected newest", "ws-a", "yours", "you", 300, 300),
        card("nav-b", "Oldest awaiting", "ws-a", "yours", "you", 100, 100),
        card("nav-c", "Other workspace", "ws-b", "yours", "you", 200, 200),
        card("nav-d", "Queued", "ws-a", "queued", "me", 50, 250),
        card("nav-e", "Equal tie", "ws-a", "yours", "you", 100, 90),
      ]);
      // the view is one choice per project, so this lane is put on doing by name
      activeOwner = "facilitator"; setTicketViewOf(activeOwner, "todo");
      apply(lastState); select("nav-a");
      return { drawer: viewPool(lastState).map(box => box.id), navigation: navigationPool(lastState).map(box => box.id) };
    });
    assert.deepEqual(initial.navigation, ["nav-a", "nav-b", "nav-e", "nav-d"],
      "the selected workspace, comparator, and stable tie were not the laptop sequence");
    assert.deepEqual(initial.drawer, ["nav-a", "nav-c", "nav-b", "nav-e", "nav-d"],
      "workspace navigation hid the rest of the lane from the drawer");

    await page.keyboard.down("Control"); await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift"); await page.keyboard.up("Control");
    assert.equal(await page.evaluate(() => selectedId), "nav-b",
      "keyboard traversal entered another workspace or skipped list order");
    await page.evaluate(() => select("nav-d"));
    await page.keyboard.down("Control"); await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.up("Shift"); await page.keyboard.up("Control");
    assert.equal(await page.evaluate(() => selectedId), "nav-a", "workspace traversal did not wrap");

    // A held response proves that local durable drawing no longer moves first.
    await page.evaluate(() => {
      select("nav-a");
      window.__nativeFetch = window.fetch;
      window.__sendReplies = [];
      window.fetch = (...args) => {
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
        return new Promise(resolve => window.__sendReplies.push((status = 200) => resolve(new Response(
          JSON.stringify(status === 200 ? { ok: true, rev: lastRev } : { error: "fabricated refusal" }),
          { status, headers: { "Content-Type": "application/json" } }))));
      };
      els["nav-a"].ta.value = "fabricated slow send";
      doSend("nav-a");
    });
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.deepEqual(await page.evaluate(() => ({ selectedId, local: localSends("nav-a").length })),
      { selectedId: "nav-a", local: 1 });

    // A deliberate move while confirmation is outstanding owns selection.
    await page.evaluate(() => stepCard(1, false));
    assert.equal(await page.evaluate(() => selectedId), "nav-b");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => localSends("nav-a").length === 0);
    await settle(50);
    assert.equal(await page.evaluate(() => selectedId), "nav-b",
      "a delayed successful receipt stole a later manual selection");

    // With no intervening move, success advances to the oldest eligible card.
    await page.evaluate(() => {
      select("nav-a"); els["nav-a"].ta.value = "fabricated successful send"; doSend("nav-a");
    });
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    assert.equal(await page.evaluate(() => selectedId), "nav-a");
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => selectedId === "nav-b");

    // Changing the visible status filter is also deliberate navigation and a
    // late confirmation may not choose a card from the newly selected view.
    await page.evaluate(() => {
      lastState.boxes.push({ ...lastState.boxes.find(box => box.id === "nav-a"),
        id: "nav-f", title: "Deferred destination", state: "parked", parked: true });
      apply(lastState); select("nav-a");
      els["nav-a"].ta.value = "fabricated send before filter change"; doSend("nav-a");
    });
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await page.evaluate(() => setView("deferred"));
    await page.evaluate(() => window.__sendReplies.shift()());
    await page.waitForFunction(() => localSends("nav-a").length === 0);
    await settle(50);
    assert.equal(await page.evaluate(() => selectedId), "nav-a",
      "a delayed confirmation stole selection after a filter change");
    await page.evaluate(() => setView("todo"));

    // A board refusal never advances and leaves the take-back safeguard intact.
    await page.evaluate(() => {
      select("nav-a"); els["nav-a"].ta.value = "fabricated refused send"; doSend("nav-a");
    });
    await page.waitForFunction(() => window.__sendReplies.length === 1);
    await page.evaluate(() => window.__sendReplies.shift()(400));
    await page.waitForFunction(() => localSends("nav-a").some(op => op.state === "failed"));
    assert.equal(await page.evaluate(() => selectedId), "nav-a");
    assert.match(await page.evaluate(() => els["nav-a"].pend.textContent), /not sent/i);

    // A lost first response retries under the same operation id and advances only on recovery.
    await page.evaluate(() => {
      for (const op of [...localSends("nav-a")]) if (op.state === "failed") takeBack(op);
      window.fetch = (...args) => {
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/send")) return window.__nativeFetch(...args);
        window.__retryUrls = (window.__retryUrls || []).concat(String(args[0]));
        window.__retryCount = (window.__retryCount || 0) + 1;
        if (window.__retryCount === 1) return Promise.reject(new Error("fabricated offline"));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, rev: lastRev }),
          { status: 200, headers: { "Content-Type": "application/json" } }));
      };
      backoffMs = () => 0;
      select("nav-a"); els["nav-a"].ta.value = "fabricated recovered send"; doSend("nav-a");
    });
    await page.waitForFunction(() => window.__retryCount >= 2 && selectedId === "nav-b");
    assert.equal(await page.evaluate(() => localSends("nav-a").length), 0);
    assert.equal(await page.evaluate(() => new URL(__retryUrls[0], location.href).searchParams.get("op")),
      await page.evaluate(() => new URL(__retryUrls[1], location.href).searchParams.get("op")),
      "the offline retry changed the durable operation id");

    assert.deepEqual(problems.filter(problem => !/status of 400 \(Bad Request\)/.test(problem)), []);
  } finally {
    await page.close();
  }
});

test("a pull from the left edge brings in the card list with the desktop's three groups", async () => {
  const parked = await create("Parked on the phone");
  await api(`/reply?box=${parked}`, "Parked reply");
  await api(`/park?box=${parked}&v=1`);
  const done = await create("Done on the phone");
  await api(`/reply?box=${done}`, "Done reply");
  await api(`/close?box=${done}`);
  const working = await create("Working on the phone");
  await api(`/working?box=${working}&v=1`);

  const { page, problems } = await openPhone("/m");
  try {
    await page.waitForSelector("article.box.sel", { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById("drawer").classList.contains("open")), false);
    await page.touchscreen.touchStart(6, 500);
    for (let x = 30; x <= 300; x += 30) await page.touchscreen.touchMove(x, 500);
    await page.touchscreen.touchEnd();
    await settle(400);
    const drawer = await page.evaluate(() => {
      const rect = document.getElementById("drawer").getBoundingClientRect();
      return {
        open: document.getElementById("drawer").classList.contains("open"),
        left: rect.left,
        labels: [...document.querySelectorAll("#tikhead .tvb")].map(b => b.textContent),
        // the sheet draws all three sections; the shown one is the doing pane
        rows: [...document.querySelectorAll('.tikpane[data-view="todo"] .trow')].map(r => ({
          title: r.querySelector(".ttl").textContent, cls: r.className,
        })),
      };
    });
    assert.equal(drawer.open, true, "the pull did not open the drawer");
    assert.equal(drawer.left, 0);
    assert.deepEqual(drawer.labels, ["Doing", "Deferred", "Done"], "labels differ from the desktop list, or carry counts");
    const titles = drawer.rows.map(r => r.title);
    assert.ok(titles.includes("Working on the phone"));
    assert.ok(!titles.includes("Parked on the phone") && !titles.includes("Done on the phone"), "doing shows parked or done cards");
    const workingRow = drawer.rows.find(r => r.title === "Working on the phone");
    assert.match(workingRow.cls, /\bworking\b/, "a working card is not painted green");
    const colours = await page.evaluate(() => {
      const bg = sel => getComputedStyle(document.querySelector(sel)).backgroundColor;
      return { working: bg("#tiklist .trow.working"), yours: bg("#tiklist .trow.yours") };
    });
    assert.equal(colours.working, "rgb(240, 250, 235)", "working green differs from the desktop's #F0FAEB");
    assert.equal(colours.yours, "rgb(255, 251, 232)", "yours yellow differs from the desktop's #FFFBE8");
    await page.screenshot({ path: path.join(SHOTS, "test-phone-drawer.png") });

    await page.evaluate(() => document.getElementById("tv-deferred").click());
    await settle();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tikpane[data-view="deferred"] .trow .ttl')].map(t => t.textContent)),
      ["Parked on the phone"]);
    await page.evaluate(() => document.getElementById("tv-done").click());
    await settle();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.tikpane[data-view="done"] .trow .ttl')].map(t => t.textContent)),
      ["Done on the phone"]);
    await page.evaluate(() => document.querySelector('.tikpane[data-view="done"] .trow').click());
    await settle(300);
    const picked = await page.evaluate(() => ({
      open: document.getElementById("drawer").classList.contains("open"),
      title: document.querySelector("article.box.sel .title").textContent,
      titleColour: getComputedStyle(document.querySelector("article.box.sel .title")).color,
    }));
    assert.equal(picked.open, false, "picking a card left the drawer open");
    assert.equal(picked.title, "Done on the phone");
    assert.equal(picked.titleColour, "rgb(47, 107, 60)", "a done card's title is not the desktop's green");
    await page.screenshot({ path: path.join(SHOTS, "test-phone-done-card.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api(`/working?box=${working}&v=0`);
  }
});

test("the composer sends through /send, the plus attaches a picture, the cross closes through /close", async () => {
  // a send moves on to the next card waiting on him, the way the board does, so
  // the seeded card is put out of the doing view and this card stays on screen
  // for the rest of the test. the move itself has its own test
  await api("/park?box=0&v=1");
  const id = await create("Composer on the phone");
  await api(`/reply?box=${id}`, "Reply to answer");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").classList.contains("show")), false);
    await page.type("article.box.sel textarea", "A message typed on the phone");
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").classList.contains("show")), true,
      "the send square did not appear with the words");
    await page.screenshot({ path: path.join(SHOTS, "test-phone-typing.png") });
    const sent = page.waitForResponse(r => new URL(r.url()).pathname === "/send");
    await page.evaluate(() => document.querySelector("article.box.sel .sendbtn").click());
    assert.equal((await sent).status(), 200);
    await settle(300);
    const saved = await savedBox(id);
    assert.equal(saved.pending, 1);
    assert.deepEqual(saved.pendingTexts, ["A message typed on the phone"]);
    const afterSend = await page.evaluate(() => ({
      field: document.querySelector("article.box.sel textarea").value,
      rows: [...document.querySelectorAll("article.box.sel .pendmsg .pendcontent")].map(r => r.textContent),
    }));
    assert.equal(afterSend.field, "");
    assert.deepEqual(afterSend.rows, ["A message typed on the phone"]);

    const clip = await page.$("article.box.sel .clipfile");
    const accept = await page.evaluate(() => document.querySelector("article.box.sel .clipfile").getAttribute("accept"));
    for (const ext of [".png", ".gif", ".mp4", ".mp3", ".pdf", ".doc", ".docx"])
      assert.ok(accept.split(",").includes(ext), `picker is missing ${ext}`);
    const picture = path.join(fixtureDir, "phone-shot.png");
    await writeFile(picture, PIXEL_PNG);
    const upload = page.waitForResponse(r => new URL(r.url()).pathname === "/upload");
    await clip.uploadFile(picture);
    assert.equal((await upload).status(), 200);
    await page.waitForFunction(() => document.querySelector("article.box.sel textarea").value.includes("/uploads/"), { timeout: 3000 });
    const field = await page.evaluate(() => document.querySelector("article.box.sel textarea").value);
    assert.match(field, /^\/uploads\/\d+-phone-shot\.png\n$/, "the picture's address did not join the message the way the desktop does");
    const url = field.trim();
    uploaded.push(path.basename(url));
    const served = await fetch(origin + url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");

    const closed = page.waitForResponse(r => new URL(r.url()).pathname === "/close");
    await page.evaluate(() => document.querySelector("article.box.sel .xbtn").click());
    assert.equal((await closed).status(), 200);
    const after = await savedBox(id);
    assert.equal(after.done, true, "the cross did not mark the card done");
    assert.equal(after.pending, 1, "the cross lost the sent message");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
    await api("/park?box=0&v=0");
  }
});

test("history arrows ignore progress notes and appear when an older final reply exists", async () => {
  const id = await create("Only final replies belong in history");
  for (const note of ["Preparing the change", "Checking the change", "Finishing the change"])
    assert.equal((await api(`/note?box=${id}`, note)).status, 200);
  assert.equal((await api(`/reply?box=${id}`, "First final reply")).status, 200);
  const saved = await savedBox(id);
  assert.ok(saved.replies > 1, "the fixture must include the progress-note counter");
  assert.equal(saved.olderReplies, 0);
  assert.deepEqual((await (await fetch(origin + `/history?box=${id}`)).json()).replies, []);

  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel`);
    await page.waitForSelector("#loading", { hidden: true, timeout: 10000 });
    const visibility = () => page.evaluate(id => {
      const box = document.getElementById("box-" + id);
      const controls = box.querySelector(".histctl");
      const style = getComputedStyle(controls);
      return { marked: box.classList.contains("hashist"), visibility: style.visibility };
    }, id);
    const shots = process.env.PHONE_HISTORY_SHOTS;
    if (shots) {
      await mkdir(shots, { recursive: true });
      await page.screenshot({ path: path.join(shots, "one-final-reply.png") });
    }
    assert.deepEqual(await visibility(), { marked: false, visibility: "hidden" },
      "progress notes exposed history controls with no older final reply");

    assert.equal((await api(`/reply?box=${id}`, "Second final reply")).status, 200);
    assert.equal((await savedBox(id)).olderReplies, 1);
    await page.waitForFunction(id => {
      const box = document.getElementById("box-" + id);
      return box?.classList.contains("hashist") &&
        document.querySelector(`#box-${id} .reply`)?.dataset.raw === "Second final reply";
    }, { timeout: 6000 }, id);
    assert.deepEqual(await visibility(), { marked: true, visibility: "visible" },
      "the first genuine older reply did not expose the controls");
    await page.evaluate(id => document.querySelector(`#box-${id} .histbtn.older`).click(), id);
    await page.waitForFunction(id =>
      document.querySelector(`#box-${id} .reply`)?.textContent.trim() === "First final reply",
      { timeout: 5000 }, id);
    assert.equal(await page.$eval(`#box-${id} .histpos`, el => el.textContent), "1 of 2");
    if (shots) await page.screenshot({ path: path.join(shots, "older-final-reply.png") });
    await page.evaluate(id => document.querySelector(`#box-${id} .histbtn.newer`).click(), id);
    await page.waitForFunction(id =>
      document.querySelector(`#box-${id} .reply`)?.textContent.trim() === "Second final reply",
      { timeout: 5000 }, id);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("legacy phone history retries a failed read and refreshes for identical final text", async () => {
  const id = await create("Identical final replies still have history");
  await api(`/note?box=${id}`, "Checking the change");
  await api(`/reply?box=${id}`, "Same final reply");
  const { page, problems } = await openPhone(`/m?box=${id}`, page =>
    page.evaluateOnNewDocument(() => {
      const realFetch = window.fetch;
      window.historyReads = [];
      window.fetch = async (...args) => {
        const url = new URL(args[0], location.href);
        if (url.pathname === "/history") {
          historyReads.push(url.searchParams.get("box"));
          if (historyReads.length === 1) return new Response("{}", { status: 503 });
        }
        const response = await realFetch(...args);
        if (url.pathname !== "/m/state") return response;
        const state = await response.json();
        for (const box of state.boxes || []) delete box.olderReplies;
        return new Response(JSON.stringify(state), { status: response.status });
      };
    }));
  try {
    await page.waitForFunction(id => historyReads.length === 2 && els[id]?.historyCount === 0,
      { timeout: 6000 }, id);
    assert.equal(await page.$eval(`#box-${id}`, el => el.classList.contains("hashist")), false);
    assert.equal(await page.evaluate(id => lastState.boxes.find(b => b.id === id).olderReplies, id), undefined);
    await api(`/reply?box=${id}`, "Same final reply");
    await page.waitForSelector(`#box-${id}.hashist`, { timeout: 6000 });
    await page.evaluate(id => document.querySelector(`#box-${id} .histbtn.older`).click(), id);
    await page.waitForFunction(id => document.querySelector(`#box-${id} .histpos`).textContent === "1 of 2",
      { timeout: 5000 }, id);
    assert.equal(await page.$eval(`#box-${id} .reply`, el => el.textContent.trim()), "Same final reply");
    const reads = await page.evaluate(() => historyReads.slice());
    assert.deepEqual(reads, [id, id, id], "only the selected card should need a history read");
    await settle(2600);
    assert.deepEqual(await page.evaluate(() => historyReads), reads, "unchanged polls should reuse known history");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the defer chip parks, the history steps back, the plus makes a card to name", async () => {
  const id = await create("History on the phone");
  await api(`/reply?box=${id}`, "First reply.");
  await api(`/reply?box=${id}`, "Second reply, the live one.");
  const { page, problems } = await openPhone(`/m?box=${id}`);
  try {
    await page.waitForSelector(`#box-${id}.sel.hashist`, { timeout: 5000 });
    await page.evaluate(() => document.querySelector("article.box.sel .histbtn.older").click());
    await page.waitForFunction(() => document.querySelector("article.box.sel .histpos").textContent === "1 of 2", { timeout: 3000 });
    const older = await page.evaluate(() => ({
      text: document.querySelector("article.box.sel .reply").textContent,
      olderDisabled: document.querySelector("article.box.sel .histbtn.older").disabled,
      dim: document.querySelector("article.box.sel").classList.contains("histview"),
    }));
    assert.equal(older.text, "First reply.");
    assert.equal(older.olderDisabled, true);
    assert.equal(older.dim, true);
    await page.screenshot({ path: path.join(SHOTS, "test-phone-history.png") });
    await page.evaluate(() => document.querySelector("article.box.sel .histbtn.newer").click());
    await page.waitForFunction(() => document.querySelector("article.box.sel .reply").textContent === "Second reply, the live one.", { timeout: 3000 });

    const parked = page.waitForResponse(r => new URL(r.url()).pathname === "/park");
    await page.evaluate(() => document.querySelector("article.box.sel .arcbtn").click());
    assert.equal(new URL((await parked).url()).searchParams.get("v"), "1");
    await page.waitForFunction(() => document.querySelector("article.box.sel").classList.contains("parked"), { timeout: 3000 });
    assert.equal((await savedBox(id)).parked, true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("article.box.sel .title")).color), "rgb(90, 100, 115)",
      "a parked card's title is not the desktop's later colour");
    // a deferred card's moon is switched off; the sun is what brings it back
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .arcbtn").getAttribute("aria-disabled")), "true");
    const unparked = page.waitForResponse(r => new URL(r.url()).pathname === "/park");
    await page.evaluate(() => document.querySelector("article.box.sel .sunbtn").click());
    assert.equal(new URL((await unparked).url()).searchParams.get("v"), "0");

    await page.evaluate(() => openDrawer());
    const created = page.waitForResponse(r => new URL(r.url()).pathname === "/create");
    await page.evaluate(() => document.getElementById("tikadd").click());
    const newId = (await (await created).json()).id;
    await page.waitForFunction(cardId => document.querySelector(`#box-${cardId}.sel .title`)?.isContentEditable, { timeout: 3000 }, newId);
    const naming = await page.evaluate(() => ({
      drawerOpen: document.getElementById("drawer").classList.contains("open"),
      placeholder: getComputedStyle(document.querySelector("article.box.sel .title"), "::before").content,
    }));
    assert.equal(naming.drawerOpen, false);
    assert.equal(naming.placeholder, '"Chat Name"');
    await page.keyboard.type("Named on the phone");
    await page.keyboard.press("Enter");
    await page.waitForFunction(cardId => lastState?.boxes.find(b => b.id === cardId)?.title === "Named on the phone", { timeout: 3000 }, newId);
    assert.equal((await savedBox(newId)).title, "Named on the phone");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the manifest, icons and service worker are served and the worker registers", async () => {
  const manifest = await fetch(origin + "/m-manifest.json");
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /manifest\+json/);
  const body = await manifest.json();
  assert.equal(body.display, "standalone");
  assert.equal(body.start_url, "/m");
  assert.equal(body.scope, "/m");
  for (const icon of body.icons) {
    const served = await fetch(origin + icon.src);
    assert.equal(served.status, 200, icon.src);
    assert.equal(served.headers.get("content-type"), "image/png");
  }
  assert.equal((await fetch(origin + "/m-icon-180.png")).status, 200);
  const worker = await fetch(origin + "/m-sw.js");
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get("content-type"), /javascript/);
  const source = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.match(source, /viewport-fit=cover/);
  assert.match(source, /apple-mobile-web-app-capable/);
  assert.match(source, /rel="apple-touch-icon"/);
  assert.match(source, /rel="manifest" href="\/m-manifest.json"/);
  assert.doesNotMatch(source, /\u2014/, "an em dash in the phone page");
  // the markup and styles carry no ellipsis; the script compares one title
  // against the server's old placeholder, which is data and not the page's words
  assert.doesNotMatch(source.split("<script")[0], /\u2026/, "an ellipsis in the phone page's own text");

  const { page, problems } = await openPhone("/m");
  try {
    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { scope: reg.scope, script: reg.active?.scriptURL };
    });
    assert.equal(new URL(registration.scope).pathname, "/m");
    assert.equal(new URL(registration.script).pathname, "/m-sw.js");
    assert.equal(await page.evaluate(() => document.getElementById("notify").textContent), "Notifications");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a replayed receipt after reload settles the durable send without moving cards", async () => {
  const source = await create("Receipt source");
  const destination = await create("Receipt destination");
  assert.equal((await api(`/reply?box=${source}`, "Source answer")).status, 200);
  assert.equal((await api(`/reply?box=${destination}`, "Destination answer")).status, 200);
  const { page, problems } = await openPhone("/m");
  try {
    const kept = await page.evaluate(sourceId => {
      select(sourceId);
      const nativeFetch = window.fetch;
      window.fetch = (...args) => new URL(String(args[0]), location.href).pathname.endsWith("/send")
        ? Promise.reject(new Error("fabricated lost response")) : nativeFetch(...args);
      backoffMs = () => 60000;
      const field = els[sourceId].ta;
      field.value = "fabricated receipt recovery";
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      const op = localSends(sourceId)[0];
      return { id: op.id, text: op.text, advance: op.advance,
        stored: JSON.parse(localStorage.getItem(OPS_KEY))[0] };
    }, source);
    assert.equal(kept.advance, true, "the second Enter did not request a move before reload");
    assert.equal(kept.stored.advance, undefined, "transient navigation intent reached durable storage");
    assert.equal((await api(`/send?box=${source}&op=${encodeURIComponent(kept.id)}`, kept.text)).status, 200);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(id => lastState !== null && localSends(id).length === 0, { timeout: 5000 }, source);
    assert.equal(await page.evaluate(() => selectedId), source,
      "the replayed receipt moved selection after reload");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
