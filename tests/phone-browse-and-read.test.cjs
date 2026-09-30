// browsing cards on the phone without selecting them, in a real page: a card
// only arrived at (a swipe, the keys, a tab, opening the app) is on screen
// level with the page and unread; a card that is used (a tap on it or into its
// reply box, Enter, typing) is selected, wears the drop shadow and is read.
// the desktop board's own version of this is in browse-and-read.test.cjs.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv/bin/python3");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PHONE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const SHOTS = process.env.PHONE_BROWSE_SHOTS || "";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// one card per test that reads, so what a test reads never reaches another
const CARDS = [
  ["0", "facilitator", "meta"], ["1.1", "facilitator", "now"], ["1.2", "facilitator", "now"],
  ["1.3", "facilitator", "now"], ["1.4", "facilitator", "now"], ["1.5", "facilitator", "now"],
  ["1.6", "facilitator", "now"], ["2.1", "pastureland", "now"], ["2.2", "pastureland", "now"],
];
const SELECTED_SHADOW = "rgba(60, 45, 20, 0.18) 0px 2px 18px 0px, rgba(60, 45, 20, 0.1) 0px 1px 3px 0px";

let browser, child, fixture, origin;

async function post(route, body = ""){ return fetch(origin + route, { method: "POST", body }); }
async function answer(id, n){
  const owner = CARDS.find(c => c[0] === id)[1];
  assert.equal((await post(`/send?box=${id}`, "a question")).status, 200);
  const claim = await (await fetch(`${origin}/wait?owner=${owner}&timeout=5`)).json();
  assert.equal(claim.box, id);
  assert.equal((await post(`/ack?owner=${owner}&token=${encodeURIComponent(claim.ack)}`)).status, 200);
  const reply = `**Answer ${n}.** The path is laid and the beds are marked out.\n\n` +
    "A narrow gravel path separates the beds. Keep its edges visible so visitors can see where each planting area begins and ends.\n\n" +
    "The tools belong on the low shelf beside the gate. Put the watering can near the tap and leave the hand fork within reach.";
  assert.equal((await post(`/reply?box=${id}&ctx=Invented+fixture`, reply)).status, 200);
}
async function seenOf(id){ return (await (await fetch(origin + "/state")).json()).boxes.find(b => b.id === id).seen || 0; }
async function until(check, ms = 6000){
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline){
    last = await check();
    if (last) return last;
    await pause(60);
  }
  throw new Error("the page never got there; last answer " + JSON.stringify(last));
}

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "phone-browse-"));
  const port = await freePortPair();
  const source = (await readFile(path.join(ROOT, "server.py"), "utf8")).replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  await writeFile(path.join(fixture, "server.py"), source);
  copyBridgeFiles(fixture);
  for (const name of ["m.html", "m-sw.js", "m-manifest.json", "sw.js", "manifest.json", "card-markdown.js", "card-tokens.css",
                      "card-logic.js", "card-report.js", "compose-format.js", "cm-markdown.js", "index.html", "page.html"])
    await copyFile(path.join(ROOT, name), path.join(fixture, name));
  await mkdir(path.join(fixture, "assets"));
  for (const name of await readdir(path.join(ROOT, "assets"))) await copyFile(path.join(ROOT, "assets", name), path.join(fixture, "assets", name));
  await writeFile(path.join(fixture, "seed.json"), JSON.stringify({
    title: "phone browse fixture",
    items: CARDS.map(([id, owner, bucket]) => ({ id, bucket, title: `Card ${id}`, owner, context: "" })),
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(PYTHON, [path.join(fixture, "server.py")], {
    cwd: fixture, env: { ...process.env, FACILITATOR_TEST_PORT: String(port) }, stdio: "ignore",
  });
  for (let i = 0; ; i++){
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    assert.ok(i < 400 && child.exitCode === null, "the fixture server did not start");
    await pause(25);
  }
  for (const [id] of CARDS) await answer(id, 1);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null){ child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

// the phone page in a browsing context of its own, so storage never carries over
async function openPhone(storage){
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", error => problems.push("pageerror: " + error.message));
  if (storage) await page.evaluateOnNewDocument(items => {
    if (location.protocol !== "http:") return;
    for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
  }, storage);
  await page.setViewport(PHONE);
  await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 15000 });
  await pause(400);
  const cdp = await page.createCDPSession();
  return { page, cdp, problems, close: () => context.close() };
}

// what the page shows now: the card, whether it is selected, what its pane wears
const look = p => p.page.evaluate(() => {
  const box = document.querySelector("#cards .box.sel");
  const ta = box && box.querySelector("textarea");
  const shadow = getComputedStyle(document.getElementById("pane")).boxShadow;
  return {
    shown: box ? box.id.replace(/^box-/, "") : null, selected: selectedId,
    browsing, bodyBrowsing: document.body.classList.contains("browsing"),
    shadow: shadow === "none" ? "flat" : shadow, typing: !!ta && document.activeElement === ta,
    read: Object.keys(seenTotals).filter(id => seenTotals[id] > 0 && (seenReplies[id] || 0) >= seenTotals[id]).sort(),
  };
});
function assertBrowsed(state, id, why){
  assert.equal(state.shown, id, why + ": card on screen");
  assert.equal(state.browsing, true, why + ": not browsing");
  assert.equal(state.bodyBrowsing, true, why + ": body not marked browsing");
  assert.equal(state.shadow, "flat", why + ": the card wears a shadow");
  assert.ok(!state.read.includes(id), why + ": the card was marked read");
}
function assertSelected(state, id, why){
  assert.equal(state.shown, id, why + ": card on screen");
  assert.equal(state.browsing, false, why + ": still browsing");
  assert.equal(state.shadow, SELECTED_SHADOW, why + ": the card has no drop shadow");
  assert.ok(state.read.includes(id), why + ": the card is not read");
}

async function touch(p, type, x, y){
  await p.cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
}
async function swipe(p, dir, { hold = false } = {}){
  const at = await p.page.$eval("article.box.sel .head", el => ({ x: innerWidth / 2, y: el.getBoundingClientRect().top + 12 }));
  await touch(p, "touchStart", at.x, at.y);
  await touch(p, "touchMove", at.x + dir * 130, at.y);
  if (hold) return at;
  await touch(p, "touchEnd", at.x + dir * 130, at.y);
  await pause(450);
  return at;
}
async function chord(p, mods, key){
  for (const m of mods) await p.page.keyboard.down(m);
  await p.page.keyboard.press(key);
  for (const m of [...mods].reverse()) await p.page.keyboard.up(m);
  await pause(400);
}
async function tap(p, selector){
  const at = await p.page.$eval(selector, el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) }; });
  await p.page.touchscreen.tap(at.x, at.y);
  await pause(400);
}
const READING = "article.box.sel .reply";
const REPLY_BOX = "article.box.sel textarea";

test("arriving at a card only browses it: nothing is read and the card sits level with the page", async () => {
  // opening the app on the lane's own pick, and on a card the last visit left
  let p = await openPhone();
  const first = (await look(p)).shown;
  assertBrowsed(await look(p), first, "app open");
  assert.deepEqual(p.problems, []);
  await p.close();
  p = await openPhone({ selbox: "1.2" });
  assertBrowsed(await look(p), "1.2", "app open on a saved card");
  await p.close();
  // a swipe either way, each key that only moves between cards, a tab switch
  const walks = [
    ["swipe to the next card", p => swipe(p, -1)],
    ["swipe to the previous card", p => swipe(p, 1)],
    ["Control+Shift+Right", p => chord(p, ["Control", "Shift"], "ArrowRight")],
    ["Control+Shift+Left", p => chord(p, ["Control", "Shift"], "ArrowLeft")],
    ["Right arrow", p => chord(p, [], "ArrowRight")],
    ["Left arrow", p => chord(p, [], "ArrowLeft")],
  ];
  for (const [name, go] of walks){
    p = await openPhone();
    const from = (await look(p)).shown;
    await go(p);
    const now = await look(p);
    assert.notEqual(now.shown, from, name + ": the card did not change");
    assertBrowsed(now, now.shown, name);
    assert.equal(now.typing, false, name + ": the reply box took the caret");
    await p.close();
  }
  p = await openPhone();
  await tap(p, '#tabbar .ptab[data-owner="pastureland"]');
  const tab = await look(p);
  assert.ok(tab.shown && tab.shown.startsWith("2."), "the tab did not show its own card");
  assertBrowsed(tab, tab.shown, "tab switch");
  await p.close();
  for (const [id] of CARDS) assert.equal(await seenOf(id), 0, `card ${id} was read on the board by arriving`);
});

test("a tap on the card's reading area selects it and reads it", async () => {
  const p = await openPhone({ selbox: "1.1" });
  assertBrowsed(await look(p), "1.1", "before the tap");
  await tap(p, READING);
  assertSelected(await look(p), "1.1", "after the tap");
  await until(async () => (await seenOf("1.1")) === 1);
  assert.equal(await seenOf("1.2"), 0, "a neighbour was read too");
  if (SHOTS){ await mkdir(SHOTS, { recursive: true }); await p.page.screenshot({ path: path.join(SHOTS, "selected.png") }); }
  assert.deepEqual(p.problems, []);
  await p.close();
});

test("a tap into the reply box, and typing there, select the card and read it", async () => {
  const p = await openPhone({ selbox: "1.2" });
  assertBrowsed(await look(p), "1.2", "before the tap");
  if (SHOTS){ await mkdir(SHOTS, { recursive: true }); await p.page.screenshot({ path: path.join(SHOTS, "browsed.png") }); }
  // every time the page reads a card is counted, so the key typed is told apart from the tap
  await p.page.evaluate(() => {
    window.readCalls = 0;
    const real = markSeen;
    markSeen = id => { window.readCalls++; return real(id); };
  });
  await tap(p, REPLY_BOX);
  const tapped = await look(p);
  assertSelected(tapped, "1.2", "after the tap into the box");
  assert.equal(tapped.typing, true, "the caret is not in the box");
  await until(async () => (await seenOf("1.2")) === 1);
  const before = await p.page.evaluate(() => window.readCalls);
  await p.page.keyboard.type("hi");
  await pause(200);
  assert.ok(await p.page.evaluate(() => window.readCalls) > before, "a key typed in the box did not count as using the card");
  assertSelected(await look(p), "1.2", "after typing");
  assert.deepEqual(p.problems, []);
  await p.close();
});

test("Enter selects the card and lands the caret in the reply box; Escape leaves the box, then unselects", async () => {
  const p = await openPhone({ selbox: "1.3" });
  assertBrowsed(await look(p), "1.3", "before Enter");
  await chord(p, [], "Enter");
  const entered = await look(p);
  assertSelected(entered, "1.3", "after Enter");
  assert.equal(entered.typing, true, "Enter did not land the caret in the box");
  await chord(p, [], "Escape");
  const left = await look(p);
  assertSelected(left, "1.3", "after the first Escape");
  assert.equal(left.typing, false, "the first Escape kept the caret in the box");
  await chord(p, [], "Escape");
  const off = await look(p);
  assert.equal(off.shown, "1.3");
  assert.equal(off.browsing, true, "the second Escape did not unselect");
  assert.equal(off.shadow, "flat", "the unselected card kept its shadow");
  assert.ok(off.read.includes("1.3"), "unselecting took the read mark back");
  await chord(p, [], "Enter");
  assertSelected(await look(p), "1.3", "Enter again");
  assert.deepEqual(p.problems, []);
  await p.close();
});

test("a step that carries the caret along selects the card it lands on", async () => {
  const p = await openPhone({ activeproj: "pastureland", selbox: "2.1" });
  assertBrowsed(await look(p), "2.1", "before");
  await tap(p, REPLY_BOX);
  assertSelected(await look(p), "2.1", "after the tap into the box");
  await chord(p, ["Control", "Shift"], "ArrowRight");
  const stepped = await look(p);
  assert.equal(stepped.shown, "2.2");
  assertSelected(stepped, "2.2", "after the step with the caret");
  assert.equal(stepped.typing, true, "the caret did not come along");
  await p.close();
});

test("a row tapped in the drawer is chosen, not browsed", async () => {
  const p = await openPhone({ selbox: "1.4" });
  assertBrowsed(await look(p), "1.4", "before");
  await p.page.evaluate(() => openDrawer());
  await pause(500);
  await p.page.evaluate(() => document.querySelector('#tiklist .trow[data-id="1.5"]').click());
  await pause(500);
  assertSelected(await look(p), "1.5", "after the row tap");
  await until(async () => (await seenOf("1.5")) === 1);
  assert.equal(await seenOf("1.4"), 0, "the card left behind was read");
  await p.close();
});

test("the home page unselects the card, so a tab brings it back browsed", async () => {
  const p = await openPhone({ selbox: "1.6" });
  await tap(p, READING);
  assertSelected(await look(p), "1.6", "after the tap");
  await p.page.evaluate(() => house.click());
  await pause(400);
  assert.equal((await look(p)).browsing, true, "the home page left the card selected");
  await tap(p, '#tabbar .ptab[data-owner="facilitator"]');
  const back = await look(p);
  assert.ok(back.shown, "the tab showed no card");
  assertBrowsed(back, back.shown, "coming back from home");
  await p.close();
});

test("a reply that lands counts as read only for a card with the caret in its reply box", async () => {
  // the caret is in the box: the answer is read as it lands
  let p = await openPhone({ selbox: "0" });
  await tap(p, REPLY_BOX);
  assertSelected(await look(p), "0", "in the box");
  await answer("0", 2);
  await p.page.waitForFunction(() => seenTotals["0"] >= 2, { timeout: 15000 });
  await until(async () => (await seenOf("0")) === 2);
  assert.ok((await look(p)).read.includes("0"), "the reply that landed under the caret is unread");
  await p.close();
  // the card is only browsed: the answer waits
  p = await openPhone({ selbox: "1.4" });
  assertBrowsed(await look(p), "1.4", "browsed");
  await answer("1.4", 2);
  await p.page.waitForFunction(() => seenTotals["1.4"] >= 2, { timeout: 15000 });
  await pause(1500);
  assertBrowsed(await look(p), "1.4", "after the reply landed");
  assert.equal(await seenOf("1.4"), 0, "a reply landing on a browsed card was read");
  await p.close();
});

test("the card swiped away keeps the drop shadow only while selected; the card swiped to is level", async () => {
  const p = await openPhone({ selbox: "1.1" });
  const faces = () => p.page.evaluate(() => [...document.querySelectorAll(".box.cardswipe")].map(el => ({
    incoming: el.classList.contains("cardswipe-in"), shadow: getComputedStyle(el).boxShadow,
  })));
  const pane = () => p.page.evaluate(() => getComputedStyle(document.getElementById("pane")).boxShadow);
  // browsed: both faces are level
  await swipe(p, -1, { hold: true });
  let now = await faces();
  assert.equal(now.length, 2);
  assert.ok(now.every(f => f.shadow === "none"), "a face is shadowed while the card is browsed: " + JSON.stringify(now));
  await touch(p, "touchCancel", 0, 0);
  await pause(450);
  // selected: the face leaving carries the drop shadow, the one arriving does not
  await tap(p, READING);
  assertSelected(await look(p), "1.1", "before the swipe");
  await swipe(p, -1, { hold: true });
  now = await faces();
  assert.equal(now.length, 2);
  assert.equal(now.find(f => !f.incoming).shadow, SELECTED_SHADOW, "the face leaving lost its shadow");
  assert.equal(now.find(f => f.incoming).shadow, "none", "the face arriving wears a shadow");
  assert.equal(await pane(), "none", "the pane's own shadow shows between the faces");
  if (SHOTS){ await mkdir(SHOTS, { recursive: true }); await p.page.screenshot({ path: path.join(SHOTS, "swipe-from-selected.png") }); }
  await touch(p, "touchEnd", 0, 0);
  await pause(500);
  const landed = await look(p);
  assert.equal(landed.browsing, true, "the swipe selected the card it landed on");
  assert.equal(landed.shadow, "flat");
  assert.equal(await pane(), "none");
  await p.close();
});

test("the selected shadow is the board's own, and the page adds no ring", async () => {
  const board = await readFile(path.join(ROOT, "index.html"), "utf8");
  const phone = await readFile(path.join(ROOT, "m.html"), "utf8");
  const values = "box-shadow:0 2px 18px rgba(60,45,20,.18), 0 1px 3px rgba(60,45,20,.10)";
  assert.ok(board.includes(values), "the board's selected shadow moved");
  assert.ok(phone.includes(values), "the phone's selected shadow differs from the board's");
  assert.match(phone, /body\.browsing main\{box-shadow:none\}/);
  const rules = phone.match(/body\.browsing[^{]*\{[^}]*\}/g) || [];
  for (const rule of rules) assert.ok(!/outline|ring|--accent/.test(rule), "a browsing rule adds more than the shadow: " + rule);
});
