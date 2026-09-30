// The phone's card list against its own fixture server, driven headless at an
// iPhone size: the rows are drawn only while the drawer is on show, and every
// reading changes only the rows that differ. Each check compares the rows on
// screen with a list drawn from scratch out of the same reading. Screenshots
// land under FACILITATOR_TEST_SHOTS, or /tmp/phone-card-list-rows-shots.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  process.env.FACILITATOR_BROWSER_EXECUTABLE ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.FACILITATOR_TEST_SHOTS || "/tmp/phone-card-list-rows-shots";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

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

async function openPhone() {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/fonts\.g(oogleapis|static)\.com/.test(message.text())) return;   // the sandbox has no web fonts
    problems.push(message.text());
  });
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  await page.setViewport(PHONE);
  await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => lastState !== null, { timeout: 5000 });
  await page.waitForSelector("article.box.sel", { timeout: 5000 });
  return { page, problems };
}

// a finger pulled in from the left edge
async function pull(page) {
  await page.touchscreen.touchStart(6, 500);
  for (let x = 30; x <= 300; x += 30) await page.touchscreen.touchMove(x, 500);
  await page.touchscreen.touchEnd();
  await page.waitForFunction(() => document.getElementById("drawer").classList.contains("open"), { timeout: 3000 });
  await settle(300);
}

// the ids on screen in one section, top to bottom
const idsOf = (page, view) => page.evaluate(v =>
  [...document.querySelectorAll(`.tikpane[data-view="${v}"] .trow`)].map(r => r.dataset.id), view);

// what the page's own reading says each section should hold
const wantedIds = (page, view) => page.evaluate(v => viewPoolFor(lastState, v).map(b => b.id), view);

// differences between the list on screen and one drawn from scratch out of the
// same reading, row by row: classes, title, age, engine, art and element count
function compareWithFreshDraw() {
  const bad = [];
  const sheet = document.getElementById("tiksheet");
  const norm = pane => [...pane.children].map(r => {
    if (!r.classList.contains("trow")) return "EMPTY:" + r.textContent;
    const art = r.querySelector(".omni-art");
    const working = r.classList.contains("working");
    return [r.dataset.id, [...r.classList].filter(c => c !== "on").sort().join(" "),
            r.querySelector(".ttl").textContent, working ? "*" : r.querySelector(".tage").textContent,
            r.querySelector(".teng").textContent, art ? art.getAttribute("src") : "-",
            r.querySelector(".omni-sweep") ? "sweep" : "-", r.querySelectorAll("*").length].join("|");
  });
  const fresh = name => {
    const pane = document.createElement("div");
    for (const b of viewPoolFor(lastState, name)) {
      const s = queueState(b);
      const busy = s === "working" || (s === "done" && cardState({ ...b, done: false, parked: false, state: null }) === "working");
      const read = seenReplies[b.id] || 0;
      const isYours = s === "yours" || (s === "new" && b.ball === "you");
      const r = h("div", "trow" + (b.id === selectedId ? " on" : "") + (busy ? " working" : "") +
                  (s === "yours" && read >= (b.replies || 0) ? " seen" : "") + (isYours ? " yours" : "") +
                  (s === "queued" || (s === "new" && b.ball !== "you") ? " queuedc" : "") +
                  (s === "done" ? " donec" : "") + (testReady(b) ? " testc" : ""));
      const inner = h("div", "trowin");
      appendOmniRowArt(r, inner, b);
      inner.appendChild(h("div", "ttl", b.title));
      const meta = h("div", "tmeta");
      meta.appendChild(h("span", "tage", busy ? "*" : s === "done" ? "done" : shortAge(b.agentTs)));
      const ag = lastState.agents?.[b.owner];
      meta.appendChild(h("span", "teng", ag ? (ag.alive ? ag.name : "offline") : ""));
      inner.appendChild(meta);
      r.appendChild(inner);
      r.dataset.id = b.id;
      pane.appendChild(r);
    }
    if (!pane.children.length) pane.appendChild(h("div", "tempty", name === "done" ? "no done chats yet" : name === "deferred" ? "no deferred chats yet" : "no open chats here"));
    return pane;
  };
  for (const name of TICKET_VIEWS) {
    const pane = sheet.querySelector('.tikpane[data-view="' + name + '"]');
    const got = norm(pane), want = norm(fresh(name));
    if (got.length !== want.length) bad.push(`${name}: ${got.length} rows drawn, ${want.length} expected`);
    for (let i = 0; i < Math.min(got.length, want.length); i++) {
      if (got[i] !== want[i]) bad.push(`${name} #${i}: ${got[i]}  <>  ${want[i]}`);
    }
  }
  return bad;
}

const sameAsFreshDraw = async page => assert.deepEqual(await page.evaluate(compareWithFreshDraw), []);

// the page's next reading has come and gone
const nextReading = page => page.evaluate(() => new Promise(resolve => {
  const was = lastState.fetchedAt;
  const timer = setInterval(() => { if (lastState.fetchedAt !== was) { clearInterval(timer); resolve(); } }, 50);
}));

before(async () => {
  await mkdir(SHOTS, { recursive: true });
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-phone-rows-"));
  const port = await freePort();
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  require("./fixture-auth.cjs").copyBridgeFiles(fixtureDir);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css", "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js",
                      "index.html", "page.html"]) {
    await copyFile(path.join(ROOT, name), path.join(fixtureDir, name));
  }
  await mkdir(path.join(fixtureDir, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) {
    await copyFile(path.join(ROOT, "assets", name), path.join(fixtureDir, "assets", name));
  }
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "phone card list rows test",
    items: [{ id: "0", bucket: "meta", title: "Standing meta card", owner: "facilitator", context: "Drop meta thoughts here." }],
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
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

test("a closed card list draws no rows, and a pull from the edge draws every current one", async () => {
  const waiting = await create("Waiting for an answer");
  await api(`/reply?box=${waiting}`, "A reply that waits");
  const parked = await create("Parked for later");
  await api(`/reply?box=${parked}`, "Parked reply");
  await api(`/park?box=${parked}&v=1`);
  const finished = await create("Finished long ago");
  await api(`/reply?box=${finished}`, "Finished reply");
  await api(`/close?box=${finished}`);

  const { page, problems } = await openPhone();
  try {
    await nextReading(page);
    await nextReading(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#tiksheet .trow").length), 0,
      "rows were drawn for a list nobody is looking at");

    // the board moves while the list is away
    const late = await create("Arrived while the list was away");
    await nextReading(page);
    await nextReading(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#tiksheet .trow").length), 0,
      "a new card drew rows into a closed list");

    await pull(page);
    const todo = await idsOf(page, "todo");
    assert.ok(todo.includes(late) && todo.includes(waiting), "the open list misses a card that arrived while it was closed");
    assert.deepEqual(todo, await wantedIds(page, "todo"));
    assert.deepEqual(await idsOf(page, "deferred"), [parked]);
    assert.deepEqual(await idsOf(page, "done"), [finished]);
    await sameAsFreshDraw(page);
    await page.screenshot({ path: path.join(SHOTS, "1-pulled-open.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("an open card list changes only the rows that changed, and shows every change", async () => {
  const first = await create("Row that stays put");
  await api(`/reply?box=${first}`, "First reply");
  const second = await create("Row that gets a reply");
  const third = await create("Row that gets a new title");
  const fourth = await create("Row that is parked");

  const { page, problems } = await openPhone();
  try {
    await page.evaluate(() => openDrawer());
    await settle(400);
    await sameAsFreshDraw(page);
    // every drawn row is tagged, so a row that was rebuilt shows as untagged
    await page.evaluate(() => { for (const row of document.querySelectorAll("#tiksheet .trow")) row.dataset.kept = "1"; });
    const kept = id => page.evaluate(i => {
      const row = document.querySelector(`#tiksheet .trow[data-id="${i}"]`);
      return !!row && row.dataset.kept === "1" && row.isConnected;
    }, id);

    // a reading with nothing new changes nothing on the sheet
    const quiet = await page.evaluate(() => new Promise(resolve => {
      let records = 0;
      const watch = new MutationObserver(list => { records += list.length; });
      watch.observe(document.getElementById("tiksheet"), { subtree: true, childList: true, attributes: true, characterData: true });
      const was = lastState.fetchedAt;
      const timer = setInterval(() => {
        if (lastState.fetchedAt === was) return;
        clearInterval(timer);
        setTimeout(() => { watch.disconnect(); resolve(records); }, 100);
      }, 50);
    }));
    assert.equal(quiet, 0, "a reading with no news wrote to the list");

    // a new card
    const fresh = await create("Brand new card");
    await page.waitForFunction(id => !!document.querySelector(`#tiksheet .trow[data-id="${id}"]`), { timeout: 6000 }, fresh);
    const afterNew = await page.evaluate(() => document.querySelector('.tikpane[data-view="todo"] .trow').dataset.id);
    assert.equal(afterNew, fresh, "a card nobody has answered goes first");
    for (const id of [first, second, third, fourth]) assert.ok(await kept(id), `row ${id} was rebuilt for a new card`);
    await sameAsFreshDraw(page);

    // a reply moves a card between the groups; its row is the same row
    await api(`/reply?box=${second}`, "A fresh reply");
    await page.waitForFunction(id => document.querySelector(`#tiksheet .trow[data-id="${id}"]`)?.classList.contains("yours"), { timeout: 6000 }, second);
    assert.ok(await kept(second), "the row that got a reply was rebuilt");
    assert.deepEqual(await idsOf(page, "todo"), await wantedIds(page, "todo"));
    await sameAsFreshDraw(page);

    // a new title is written into the same row
    await api(`/title?box=${third}`, "Retitled in place");
    await page.waitForFunction(id => document.querySelector(`#tiksheet .trow[data-id="${id}"] .ttl`)?.textContent === "Retitled in place", { timeout: 6000 }, third);
    assert.ok(await kept(third), "the retitled row was rebuilt");
    await sameAsFreshDraw(page);

    // parking a card takes its row out of doing and puts one in deferred
    await api(`/park?box=${fourth}&v=1`);
    await page.waitForFunction(id => !document.querySelector(`.tikpane[data-view="todo"] .trow[data-id="${id}"]`) &&
      !!document.querySelector(`.tikpane[data-view="deferred"] .trow[data-id="${id}"]`), { timeout: 6000 }, fourth);
    assert.ok(await kept(first) && await kept(second) && await kept(third), "a parked card rebuilt the rows around it");
    await sameAsFreshDraw(page);

    // closing a card moves it to done
    await api(`/close?box=${first}`);
    await page.waitForFunction(id => !!document.querySelector(`.tikpane[data-view="done"] .trow[data-id="${id}"]`), { timeout: 6000 }, first);
    assert.equal(await page.evaluate(id => !!document.querySelector(`.tikpane[data-view="todo"] .trow[data-id="${id}"]`), first), false);
    await sameAsFreshDraw(page);

    // minutes ago move in the same rows as time passes
    const before = await page.evaluate(id => document.querySelector(`#tiksheet .trow[data-id="${id}"] .tage`).textContent, second);
    assert.equal(before, "now");
    await page.evaluate(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 3 * 60 * 1000; });
    await page.waitForFunction(id => document.querySelector(`#tiksheet .trow[data-id="${id}"] .tage`).textContent === "3m", { timeout: 6000 }, second);
    assert.ok(await kept(second), "the age was written by rebuilding the row");
    await sameAsFreshDraw(page);
    await page.evaluate(() => { Date.now = window.__realNow; });

    await page.screenshot({ path: path.join(SHOTS, "2-after-changes.png") });
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a working card shows the spinner in its row, and a list that was away catches up when opened", async () => {
  const job = await create("A job running behind a card");
  const idle = await create("A card that waits");
  await api(`/reply?box=${idle}`, "Waiting reply");

  const { page, problems } = await openPhone();
  try {
    await page.evaluate(() => openDrawer());
    await settle(400);
    await api(`/working?box=${job}&v=1`);
    await page.waitForFunction(id => document.querySelector(`#tiksheet .trow[data-id="${id}"]`)?.classList.contains("working"), { timeout: 6000 }, job);
    const frames = new Set();
    for (let i = 0; i < 8; i++) {
      frames.add(await page.evaluate(id => document.querySelector(`#tiksheet .trow[data-id="${id}"] .tage`).textContent, job));
      await settle(120);
    }
    assert.ok(frames.size > 1, `the spinner did not turn (${[...frames]})`);
    await sameAsFreshDraw(page);
    await page.screenshot({ path: path.join(SHOTS, "3-working.png") });

    // the list goes away; the board changes; the list comes back with the changes in it
    await page.evaluate(() => closeDrawer());
    await settle(500);
    await api(`/working?box=${job}&v=0`);
    await api(`/title?box=${idle}`, "Retitled while the list was away");
    const added = await create("Added while the list was away");
    await nextReading(page);
    await nextReading(page);
    assert.equal(await page.evaluate(id => !!document.querySelector(`#tiksheet .trow[data-id="${id}"]`), added), false,
      "a closed list drew a new card");
    await page.evaluate(() => openDrawer());
    await settle(400);
    assert.equal(await page.evaluate(id => document.querySelector(`#tiksheet .trow[data-id="${id}"] .ttl`).textContent, idle),
      "Retitled while the list was away");
    assert.equal(await page.evaluate(id => document.querySelector(`#tiksheet .trow[data-id="${id}"]`).classList.contains("working"), job), false,
      "a card that stopped working still shows green");
    assert.deepEqual(await idsOf(page, "todo"), await wantedIds(page, "todo"));
    await sameAsFreshDraw(page);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a long list keeps its place when rows arrive, and a tap on a row opens that card", async () => {
  const ids = [];
  for (let i = 0; i < 36; i++) {
    const id = await create(`List card number ${i + 1}`);
    await api(`/reply?box=${id}`, `Reply ${i + 1}`);
    ids.push(id);
  }
  const { page, problems } = await openPhone();
  try {
    await pull(page);
    await sameAsFreshDraw(page);
    const scrolled = await page.evaluate(() => {
      const pane = document.querySelector('.tikpane[data-view="todo"]');
      pane.scrollTop = 500;
      return { top: pane.scrollTop, room: pane.scrollHeight - pane.clientHeight };
    });
    assert.ok(scrolled.room > 500, "the list is too short to scroll");
    await page.screenshot({ path: path.join(SHOTS, "4-scrolled.png") });

    const arrival = await create("Arrived while the list was scrolled");
    await api(`/reply?box=${ids[0]}`, "Another reply while scrolled");
    await page.waitForFunction(id => !!document.querySelector(`#tiksheet .trow[data-id="${id}"]`), { timeout: 6000 }, arrival);
    await settle(300);
    const after = await page.evaluate(() => document.querySelector('.tikpane[data-view="todo"]').scrollTop);
    assert.equal(after, scrolled.top, "the list moved while it was scrolled");
    await sameAsFreshDraw(page);

    const target = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.tikpane[data-view="todo"] .trow')];
      const row = rows[rows.length - 3];
      row.scrollIntoView({ block: "center" });
      return { id: row.dataset.id, title: row.querySelector(".ttl").textContent };
    });
    const point = await page.evaluate(id => {
      const box = document.querySelector(`#tiksheet .trow[data-id="${id}"] .ttl`).getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, target.id);
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForFunction(id => selectedId === id && !document.getElementById("drawer").classList.contains("open"), { timeout: 3000 }, target.id);
    await settle(800);
    assert.equal(await page.evaluate(() => document.querySelector("article.box.sel .title").textContent), target.title);
    await page.screenshot({ path: path.join(SHOTS, "5-picked.png") });

    // the row of the card now on show wears the mark when the list is next opened
    await page.evaluate(() => openDrawer());
    await settle(400);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#tiksheet .trow.on")].map(r => r.dataset.id)), [target.id]);
    await sameAsFreshDraw(page);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
