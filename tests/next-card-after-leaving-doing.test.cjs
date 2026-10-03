// which card the board opens when the card on screen leaves Doing, deferred or
// done: the card that slides up into its spot, the one right below it in the
// list; the one right above it when it was the last; nothing when Doing is now
// empty. the pure rule is run on its own, then both pages are driven in a real
// browser against a copy of the board server holding five Doing cards: the Mac
// board at 1512 by 982 and the phone at 390 by 844. a card that is not the one
// on screen leaving Doing moves nothing on screen.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const puppeteer = require("puppeteer-core");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const PYTHON = process.env.FACILITATOR_TEST_PYTHON || path.join(ROOT, ".venv/bin/python3");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- the rule, on its own ---------------------------------------------------------
function logicWith(state, selected) {
  const calls = [];
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: () => ({}), body: {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) }),
    els: {}, lastState: state, selectedId: selected, activeOwner: "lane", lastSel: {},
    select: (id, opts) => calls.push({ select: id, hop: !!(opts && opts.hop) }),
    deselect: () => calls.push({ deselect: true }),
  };
  vm.createContext(sandbox);
  vm.runInContext(require("node:fs").readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), sandbox, { filename: "card-logic.js" });
  return { sandbox, calls };
}
const card = (id, extra) => ({ id, owner: "lane", bucket: "meta", title: "card " + id, ball: "you", state: "yours",
  replies: 1, agentTs: 1, ts: 1, pending: 0, done: false, parked: false, ...extra });

test("the card below takes the screen, else the card above, else nothing", () => {
  const { sandbox } = logicWith(null, null);
  const next = (id, order) => sandbox.doingNeighbour(id, order);
  const list = ["a", "b", "c", "d", "e"];
  assert.equal(next("a", list), "b", "the top card");
  assert.equal(next("c", list), "d", "a middle card");
  assert.equal(next("d", list), "e", "the second to last card");
  assert.equal(next("e", list), "d", "the last card");
  assert.equal(next("a", ["a"]), null, "the only card");
});

test("the standing boxes are never landed on, and a card outside the list opens the top of it", () => {
  const { sandbox } = logicWith(null, null);
  const next = (id, order) => sandbox.doingNeighbour(id, order);
  assert.equal(next("a", ["a", "0", "c"]), "c", "the box below is passed over");
  assert.equal(next("c", ["a", "0", "c"]), "a", "the box above is passed over");
  assert.equal(next("a", ["a", "0", "t0"]), null, "a list of standing boxes alone");
  assert.equal(next("z", ["a", "b"]), "a", "a card that was not in Doing");
  assert.equal(next("z", ["0", "b"]), "b", "a card that was not in Doing, past a standing box");
  assert.equal(next("z", []), null, "no Doing list at all");
});

test("the list is taken in the order the lists draw it, before the card leaves", () => {
  const state = { boxes: [
    card("old", { agentTs: 1 }), card("mid", { agentTs: 5 }), card("new", { agentTs: 9 }),
    card("gone", { agentTs: 7, parked: true, state: "parked" }),
    card("finished", { agentTs: 8, done: true, state: "done" }),
  ] };
  const { sandbox } = logicWith(state, null);
  assert.deepEqual([...sandbox.doingOrder(state)], ["old", "mid", "new"]);
  assert.deepEqual([...sandbox.doingOrder(null)], []);
});

test("the waiting group runs oldest turn first and the other groups keep their order", () => {
  const state = { boxes: [
    card("late", { agentTs: 9 }),
    card("fresh", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 50 }),
    card("bare", { agentTs: 0, ts: 0 }),
    card("tie-a", { agentTs: 5 }),
    card("tie-b", { agentTs: 5 }),
    card("early", { agentTs: 2 }),
    card("ts-only", { agentTs: 0, ts: 7 }),
    card("q1", { state: "queued", ball: "me", ts: 30 }), card("q2", { state: "queued", ball: "me", ts: 40 }),
    card("w1", { state: "working", ball: "me", ts: 10 }), card("w2", { state: "working", ball: "me", ts: 20 }),
    card("d1", { state: "done", done: true, ts: 1 }), card("d2", { state: "done", done: true, ts: 2 }),
    card("newer", { state: "new", ball: "me", replies: 0, agentTs: 0, ts: 60 }),
  ] };
  const { sandbox, calls } = logicWith(state, null);
  const order = [...sandbox.poolOf(state).map(b => b.id)];
  assert.deepEqual(order, ["newer", "fresh", "early", "tie-a", "tie-b", "ts-only", "late", "bare", "q2", "q1", "w2", "w1", "d2", "d1"]);
  // the jump after a send reads the same measure, so it lands on the top of the group
  const list = sandbox.viewPoolFor(state, "todo");
  assert.equal(sandbox.jumpNextYellow("late", null, list), "early");
  assert.equal(sandbox.jumpNextYellow("early", null, list), "tie-a");
  assert.equal(sandbox.jumpNextYellow("tie-a", null, list), "early");
  assert.deepEqual(calls.map(c => c.select), ["early", "tie-a", "early"]);
});

test("the hop lands from the list taken at the tap, whatever the page has repainted since", () => {
  const state = { boxes: ["a", "b", "c", "d"].map(id => card(id, { agentTs: 10 + "abcd".indexOf(id) })) };
  const { sandbox, calls } = logicWith(state, "b");
  const order = sandbox.doingOrder(state);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
  // the card has already been painted out of Doing by the time the hop runs
  state.boxes.find(b => b.id === "b").parked = true;
  state.boxes.find(b => b.id === "b").state = "parked";
  sandbox.selectNextDoing("b", order);
  assert.deepEqual(calls, [{ select: "c", hop: true }]);
  // the card below left Doing while the close was on its way: the next one down takes it
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "c").done = true;
  state.boxes.find(b => b.id === "c").state = "done";
  sandbox.selectNextDoing("b", order);
  assert.deepEqual(calls, [{ select: "d", hop: true }]);
  // nothing below is left: the card above
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "d").parked = true;
  state.boxes.find(b => b.id === "d").state = "parked";
  sandbox.selectNextDoing("b", order);
  assert.deepEqual(calls, [{ select: "a", hop: true }]);
  // Doing is empty: nothing is opened
  calls.length = 0;
  sandbox.selectedId = "b";
  state.boxes.find(b => b.id === "a").done = true;
  state.boxes.find(b => b.id === "a").state = "done";
  sandbox.selectNextDoing("b", order);
  assert.deepEqual(calls, [{ deselect: true }]);
});

test("a card that is not the one on screen leaving Doing moves nothing on screen", () => {
  const state = { boxes: ["a", "b", "c"].map(id => card(id)) };
  const { sandbox, calls } = logicWith(state, "c");
  sandbox.selectNextDoing("a", sandbox.doingOrder(state));
  assert.deepEqual(calls, []);
});

test("no page asks for the next card without the list from before the card left", async () => {
  const pages = ["index.html", "m.html", "card-logic.js"];
  for (const name of pages) {
    const source = await readFile(path.join(ROOT, name), "utf8");
    assert.doesNotMatch(source, /selectNextDoing\([^,)]*\)/, name);
  }
});

// ---- both pages, in a browser -----------------------------------------------------
const CARDS = ["1.1", "1.2", "1.3", "1.4", "1.5"];
const WHERE = { top: "1.1", middle: "1.3", last: "1.5" };
let browser, child, fixture, origin;

const post = (route, body = "") => fetch(origin + route, { method: "POST", body });

// every card back in Doing, then park the ones not named in keep
async function reset(keep) {
  for (const id of CARDS) {
    await post(`/park?box=${id}&v=0`);
    await post(`/done?box=${id}&v=0`);
  }
  if (keep) for (const id of CARDS) if (!keep.includes(id)) await post(`/park?box=${id}&v=1`);
}

before(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "next-card-"));
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
    title: "next card fixture",
    items: CARDS.map(id => ({ id, bucket: "meta", title: `Card ${id}`, owner: "facilitator", context: "" })),
  }));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(PYTHON, [path.join(fixture, "server.py")], {
    cwd: fixture, env: { ...process.env, FACILITATOR_TEST_PORT: String(port) }, stdio: "ignore",
  });
  for (let i = 0; ; i++) {
    try { if ((await fetch(origin + "/state")).ok) break; } catch {}
    assert.ok(i < 400 && child.exitCode === null, "the fixture server did not start");
    await pause(25);
  }
  // answered first card first, so the oldest reply is on top and the list reads 1.1 down to 1.5
  for (const id of CARDS) {
    assert.equal((await post(`/send?box=${id}`, "a question")).status, 200);
    const claim = await (await fetch(`${origin}/wait?owner=facilitator&timeout=5`)).json();
    assert.equal(claim.box, id);
    assert.equal((await post(`/ack?owner=facilitator&token=${encodeURIComponent(claim.ack)}`)).status, 200);
    assert.equal((await post(`/reply?box=${id}&ctx=Invented+fixture`, `Answer for card ${id}. The beds are marked out.`)).status, 200);
    await pause(30);
  }
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});

after(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

const SURFACES = {
  "Mac board": {
    viewport: { width: 1512, height: 982, deviceScaleFactor: 1 },
    shown: ".box.sel",
    closeFn: "boardCloseCard",
    // the card the hop lands on is shown browsed, whatever the card it left was
    landsAfter: () => "browsed",
    async open(id, mode) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport(this.viewport);
      await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof ownerReady !== "undefined" && ownerReady && activeOwner === "facilitator" && lastState !== null, { timeout: 8000 });
      await pause(600);
      await page.evaluate((cardId, how) => { if (how === "selected") select(cardId); else browse(cardId); }, id, mode);
      await pause(300);
      return { page, context, tap: (x, y) => page.mouse.click(x, y) };
    },
  },
  "phone": {
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
    shown: "#cards .box.sel",
    closeFn: "closeCard",
    landsAfter: () => "browsed",
    async open(id, mode) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.evaluateOnNewDocument(cardId => {
        if (location.protocol === "http:") localStorage.setItem("selbox", cardId);
      }, id);
      await page.setViewport(this.viewport);
      await page.goto(origin + "/m", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 10000 });
      await page.waitForFunction(() => !document.getElementById("loading"), { timeout: 15000 });
      await pause(600);
      if (mode === "selected") {
        const at = await page.$eval("article.box.sel .reply", el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 40) }; });
        await page.touchscreen.tap(at.x, at.y);
        await pause(500);
      }
      return { page, context, tap: (x, y) => page.touchscreen.tap(x, y) };
    },
  },
};

const MOVES = {
  "the moon chip": { how: "chip", chip: "arc", gone: "parked" },
  "the cross": { how: "chip", chip: "x", gone: "done" },
  "the ] key": { how: "key", key: "]", gone: "parked" },
  "the \\ key": { how: "key", key: "\\", gone: "done" },
};

const look = (p, surface) => p.page.evaluate(sel => ({
  shown: document.querySelector(sel)?.id.replace(/^box-/, "") ?? null,
  browsing,
  list: viewPoolFor(lastState, "todo").map(b => b.id),
}), surface.shown);

// listen to the hop, so a card that is merely there afterwards is told apart from one the hop opened
async function listen(p) {
  await p.page.evaluate(() => {
    window.hopped = []; window.emptied = 0;
    const realSelect = select, realDeselect = deselect;
    select = (id, opts) => { if (opts && opts.hop) window.hopped.push(id); return realSelect(id, opts); };
    deselect = () => { window.emptied++; return realDeselect(); };
  });
}

async function move(p, id, how) {
  if (how.chip) {
    const at = await p.page.evaluate((cardId, name) => {
      const r = els[cardId][name].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
    }, id, how.chip);
    assert.ok(at.w > 0, `the ${how.chip} chip has no size`);
    await p.tap(at.x, at.y);
  } else {
    await p.page.keyboard.press(how.key);
  }
}

const neighbour = (list, id) => list[list.indexOf(id) + 1] ?? list[list.indexOf(id) - 1] ?? null;

for (const [name, surface] of Object.entries(SURFACES)) {
  test(`${name}: the card that leaves Doing is replaced by the one below it, or the one above it if it was last`, async () => {
    for (const [moveName, how] of Object.entries(MOVES)) {
      for (const [whereName, id] of Object.entries(WHERE)) {
        for (const mode of how.how === "key" ? ["browsed", "selected"] : ["selected"]) {
          const what = `${name}, ${moveName}, ${whereName} card ${id}, ${mode}`;
          await reset();
          const p = await surface.open(id, mode);
          try {
            const was = await look(p, surface);
            assert.equal(was.shown, id, `${what}: the card was not on screen to begin with`);
            assert.equal(was.browsing, mode === "browsed", `${what}: wrong mode to begin with`);
            assert.deepEqual(was.list, CARDS, `${what}: the Doing list`);
            await listen(p);
            await move(p, id, how);
            await p.page.waitForFunction(cardId => hopped.length > 0 || emptied > 0 || selectedId !== cardId, { timeout: 5000 }, id);
            await pause(500);
            const want = neighbour(CARDS, id);
            const now = await look(p, surface);
            assert.deepEqual(await p.page.evaluate(() => window.hopped), [want], `${what}: the hop`);
            assert.equal(now.shown, want, `${what}: the card on screen after`);
            assert.equal(now.browsing, surface.landsAfter(how.how, mode) === "browsed", `${what}: browsed or selected after`);
            assert.ok(!now.list.includes(id), `${what}: the card is still in Doing`);
          } finally {
            await p.context.close();
          }
        }
      }
    }
  });

  test(`${name}: nothing is opened when Doing is empty after the card leaves`, async () => {
    for (const [moveName, how] of Object.entries(MOVES)) {
      for (const mode of how.how === "key" ? ["browsed", "selected"] : ["selected"]) {
        const what = `${name}, ${moveName}, the only card left, ${mode}`;
        await reset(["1.3"]);
        const p = await surface.open("1.3", mode);
        try {
          const was = await look(p, surface);
          assert.deepEqual(was.list, ["1.3"], `${what}: the Doing list`);
          await listen(p);
          await move(p, "1.3", how);
          await p.page.waitForFunction(() => emptied > 0, { timeout: 5000 });
          assert.deepEqual(await p.page.evaluate(() => window.hopped), [], `${what}: a card was hopped to`);
          assert.deepEqual((await look(p, surface)).list, [], `${what}: Doing is not empty`);
        } finally {
          await p.context.close();
        }
      }
    }
  });

  test(`${name}: a card that is not on screen leaving Doing moves nothing on screen`, async () => {
    const OFF = {
      "parked from outside": { gone: "1.1", run: () => post("/park?box=1.1&v=1") },
      "closed from outside": { gone: "1.5", run: () => post("/close?box=1.5") },
      "deferred through the page's own moon handler": { gone: "1.1", inPage: () => toggleFlag("1.1", "park") },
      "closed through the page's own close": { gone: "1.1", inPage: fn => window[fn]("1.1") },
    };
    for (const mode of ["browsed", "selected"]) {
      for (const [label, off] of Object.entries(OFF)) {
        const what = `${name}, ${mode}, ${label}`;
        await reset();
        const p = await surface.open("1.3", mode);
        try {
          const was = await look(p, surface);
          await listen(p);
          if (off.run) await off.run();
          else await p.page.evaluate(off.inPage, surface.closeFn);
          await pause(1800);
          const now = await look(p, surface);
          assert.ok(!now.list.includes(off.gone), `${what}: ${off.gone} is still in Doing`);
          assert.equal(now.shown, "1.3", `${what}: the card on screen moved`);
          assert.equal(now.browsing, was.browsing, `${what}: browsed or selected changed`);
          assert.deepEqual(await p.page.evaluate(() => [window.hopped, window.emptied]), [[], 0], `${what}: a hop ran`);
        } finally {
          await p.context.close();
        }
      }
    }
  });
}
