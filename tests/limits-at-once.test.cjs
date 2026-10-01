// the limits box is there at once, on the board and on the phone, in a real
// browser: the numbers last received are kept in the page's storage and drawn
// when home opens, before the route answers (the route is held for seconds
// here, so a drawing that comes sooner can only come from what was kept); the
// page asks the route once when it loads, not only when home opens; fresh
// numbers move the bars and the percents in place, over several frames, with the
// box's size unchanged; the faint "Last updated" line counts from the server's
// fetch and ticks while home is open. The route is replaced in the browser, so
// no codex is started. Every number is invented.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

const FUTURE = 4102444800;
const MAC = { width: 1512, height: 982 };
const PHONE_VIEW = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const win = used => ({ used, resets: FUTURE });
// the server's clock is arbitrary here: only the difference of now and fetched counts
const answerOf = ({ claude = [18, 47], codex = [32, 61], age = 0 } = {}) => ({
  claude: { five_hour: win(claude[0]), weekly: win(claude[1]) },
  codex: { five_hour: win(codex[0]), weekly: win(codex[1]) },
  fetched: 7000 - age, now: 7000, refreshing: false,
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fx;
before(async () => { fx = await launch({ files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true }); });
after(async () => { if (fx) await fx.stop(); });

// /limits answered from state.answer after state.hold milliseconds, and counted
async function control(page, state) {
  state.asked = [];
  await page.setRequestInterception(true);
  page.on("request", request => {
    if (new URL(request.url()).pathname !== "/limits") { request.continue(); return; }
    state.asked.push(Date.now());
    setTimeout(() => request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(state.answer) }), state.hold);
  });
}

async function open(kind) {
  const { context, page } = await fx.openBoard(null, MAC);
  if (kind === "phone") {
    await page.setViewport(PHONE_VIEW);
    await page.goto(fx.origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
    await page.waitForSelector("#tabbar .ptab.on", { timeout: 5000 });
  }
  // the page's own ask at load goes to the real board; let it land and be kept
  // before the test takes the route over
  await page.waitForFunction(() => localStorage.getItem("home.limits") !== null, { timeout: 8000 });
  return { context, page };
}
const reopen = (page, kind) => page.goto(fx.origin + (kind === "phone" ? "/m" : "/"), { waitUntil: "domcontentloaded" });
const press = (page, kind) => kind === "phone" ? page.tap("#homeico") : page.click("#homeico", { delay: 10 });
const kept = page => page.evaluate(() => localStorage.getItem("home.limits"));
const noteOf = page => page.evaluate(() => document.querySelector("#homelimits .lm-updated")?.textContent || "");

// from the click to the first frame with the box on screen and numbers in it
const arm = page => page.evaluate(() => {
  window.__press = new Promise(resolve => {
    document.getElementById("homeico").addEventListener("click", () => {
      const t0 = performance.now();
      let frames = 0;
      const look = () => {
        frames++;
        const spot = document.getElementById("homelimits");
        const pcts = [...spot.querySelectorAll(".lm-pct")].map(p => p.textContent);
        const shown = !spot.hidden && getComputedStyle(spot).display !== "none" && spot.getBoundingClientRect().height > 0;
        if (shown && pcts.length) resolve({ ms: performance.now() - t0, frames, pcts, note: spot.querySelector(".lm-updated").textContent });
        else if (performance.now() - t0 > 8000) resolve({ ms: null, frames, pcts });
        else requestAnimationFrame(look);
      };
      requestAnimationFrame(look);
    }, { once: true });
  });
});

for (const kind of ["board", "phone"]) {
  test(`${kind}: a fresh install shows nothing until the first answer, and then keeps it`, async () => {
    const { context, page } = await open(kind);
    try {
      const state = { answer: answerOf(), hold: 1200 };
      await control(page, state);
      await page.evaluate(() => localStorage.removeItem("home.limits"));
      await reopen(page, kind);
      await page.waitForSelector("#homeico");
      assert.equal(await kept(page), null, "nothing kept on a fresh install");
      await press(page, kind);
      await page.waitForFunction(() => document.body.classList.contains("home"));
      await sleep(500);
      assert.equal(await page.evaluate(() => document.getElementById("homelimits").hidden), true, "nothing to draw yet, so no box");
      await page.waitForFunction(() => !document.getElementById("homelimits").hidden, { timeout: 8000 });
      const stored = JSON.parse(await kept(page));
      assert.deepEqual(Object.keys(stored).sort(), ["answer", "at"]);
      assert.equal(stored.answer.codex.weekly.used, 61);
      assert.equal(typeof stored.at, "number");
    } finally { await context.close(); }
  });

  test(`${kind}: with numbers kept, the box is drawn in the frame of the press, before the route answers`, async () => {
    const { context, page } = await open(kind);
    try {
      const state = { answer: answerOf({ age: 20 }), hold: 300 };
      await control(page, state);
      await reopen(page, kind);
      await page.waitForSelector("#homeico");
      await press(page, kind);
      await page.waitForFunction(() => !document.getElementById("homelimits").hidden, { timeout: 8000 });
      await sleep(800);
      assert.ok(await kept(page), "the first visit kept its numbers");
      // a warm page: pressed again with the route held for seconds
      for (const when of ["warm", "cold"]) {
        await page.click("#tabbar .ptab:not(.ptabplus)", { delay: 10 }).catch(() => page.tap("#tabbar .ptab"));
        await page.waitForFunction(() => !document.body.classList.contains("home"));
        state.hold = 3500;
        state.asked.length = 0;
        if (when === "cold") { await reopen(page, kind); await page.waitForSelector("#homeico"); }
        await arm(page);
        const pressed = Date.now();
        await press(page, kind);
        const got = await page.evaluate(() => window.__press);
        assert.ok(got.ms !== null, `${when}: the box came`);
        assert.ok(got.frames <= 3 && got.ms < 400, `${when}: in the frame of the press, ${JSON.stringify(got)}`);
        assert.ok(Date.now() - pressed < 3000, `${when}: before the held answer could have arrived`);
        assert.deepEqual(got.pcts, ["18%", "47%", "32%", "61%"], when);
        assert.match(got.note, /^Last updated (just now|\d+ min ago)$/, when);
        await sleep(3800);
      }
    } finally { await context.close(); }
  });

  test(`${kind}: the page asks for the limits once when it loads, not only when home opens`, async () => {
    const { context, page } = await open(kind);
    try {
      const state = { answer: answerOf(), hold: 0 };
      await control(page, state);
      await reopen(page, kind);
      await page.waitForFunction(() => window.TokenWidgets && window.TokenWidgets.limits, { timeout: 8000 });
      await page.waitForFunction(() => !document.getElementById("homelimits").hidden, { timeout: 8000 });
      await sleep(500);
      assert.equal(state.asked.length, 1, "one ask, and home was never opened");
      assert.equal(await page.evaluate(() => document.body.classList.contains("home")), false);
      assert.deepEqual(JSON.parse(await kept(page)).answer.claude.five_hour.used, 18, "and kept what it got");
    } finally { await context.close(); }
  });

  test(`${kind}: fresh numbers move every bar over several frames, in place, with the box's size unchanged`, async () => {
    const { context, page } = await open(kind);
    try {
      const state = { answer: answerOf({ age: 100 }), hold: 0 };
      await control(page, state);
      await reopen(page, kind);
      await page.waitForSelector("#homeico");
      await press(page, kind);
      await page.waitForFunction(() => document.body.classList.contains("home"));
      await page.waitForSelector("svg.tk-heat, svg.tk-line", { timeout: 15000 });
      await page.waitForFunction(() => !document.getElementById("homelimits").hidden, { timeout: 8000 });
      await sleep(900);
      assert.equal(await noteOf(page), "Last updated 1 min ago");
      const before = await page.evaluate(() => {
        const box = document.querySelector("#homelimits .lm-box");
        window.__same = { box, fills: [...box.querySelectorAll(".lm-fill")] };
        return { height: box.getBoundingClientRect().height };
      });
      state.answer = answerOf({ claude: [30, 52], codex: [8, 90], age: 0 });
      await page.evaluate(() => {
        const box = document.querySelector("#homelimits .lm-box");
        window.__frames = [];
        window.__go = true;
        const t0 = performance.now();
        const look = () => {
          window.__frames.push({
            t: performance.now() - t0,
            w: [...box.querySelectorAll(".lm-fill")].map(f => f.getBoundingClientRect().width),
            bar: [...box.querySelectorAll(".lm-bar")].map(b => b.getBoundingClientRect().width),
            pct: [...box.querySelectorAll(".lm-pct")].map(p => p.textContent),
            h: box.getBoundingClientRect().height,
            note: box.querySelector(".lm-updated").textContent,
          });
          if (window.__go) requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
        homeLimits.refresh();
      });
      await sleep(1800);
      const out = await page.evaluate(() => {
        window.__go = false;
        const box = document.querySelector("#homelimits .lm-box");
        return { frames: window.__frames, kept: box === window.__same.box && [...box.querySelectorAll(".lm-fill")].every((f, i) => f === window.__same.fills[i]) };
      });
      assert.ok(out.kept, "the same box and the same fills, so their widths could be eased");
      const frames = out.frames;
      const last = frames[frames.length - 1];
      assert.deepEqual(last.pct, ["30%", "52%", "8%", "90%"], "the numbers are updated");
      assert.equal(last.note, "Last updated just now", "and the time with them");
      for (const f of frames) {
        assert.equal(f.h, before.height, "the box keeps its size in every frame");
        assert.ok(f.bar.every(b => b === frames[0].bar[0]), "the tracks do not move");
      }
      for (let i = 0; i < 4; i++) {
        const w = frames.map(f => f.w[i]);
        const start = w[0], end = w[w.length - 1];
        assert.notEqual(start, end, `row ${i} moved`);
        const dir = Math.sign(end - start);
        const steps = w.slice(1).map((v, k) => v - w[k]).filter(d => d !== 0);
        assert.ok(steps.every(d => Math.sign(d) === dir), `row ${i} goes one way: no flicker, no overshoot`);
        assert.ok(w.every(v => v >= Math.min(start, end) - 0.01 && v <= Math.max(start, end) + 0.01), `row ${i} stays between its two ends`);
        assert.ok(steps.length >= 8, `row ${i} took ${steps.length} frames, not a jump`);
        assert.ok(Math.max(...steps.map(Math.abs)) <= 0.35 * Math.abs(end - start), `row ${i}: no step is a third of the way`);
      }
      assert.ok(Math.abs(last.w[3] / last.bar[3] - 0.9) < 0.01, "and the widths come to the percents");
    } finally { await context.close(); }
  });
}

test("the faint line ticks while home is open, with no new request", async () => {
  const { context, page } = await open("board");
  try {
    const state = { answer: answerOf({ age: 50 }), hold: 0 };
    await control(page, state);
    await reopen(page, "board");
    await page.waitForSelector("#homeico");
    await press(page, "board");
    await page.waitForFunction(() => !document.getElementById("homelimits").hidden, { timeout: 8000 });
    await sleep(500);
    assert.equal(await noteOf(page), "Last updated just now");
    const asks = state.asked.length;
    // the browser's clock moves on 20 seconds, to 70 since the fetch; the page's own timer notices
    await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 20_000; });
    await page.waitForFunction(() => document.querySelector("#homelimits .lm-updated").textContent === "Last updated 1 min ago",
      { timeout: 20000, polling: 500 });
    assert.equal(state.asked.length, asks, "the line changed with no new fetch");
  } finally { await context.close(); }
});
