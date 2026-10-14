// the limits box on a page that has just been opened, with nothing replaced in
// the browser: the page asks the board's own GET /limits, which starts a fake
// `codex` that answers after a pause (a real one takes a second or two) and
// reads a claude-limits.json. A first press of the house with no reload, a press
// again after a project tab, and a load straight onto home each show every row,
// on the board and on the phone. Every number is invented.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { launch } = require("./resp-harness.cjs");
const { installCodex, codexReply, windowOf } = require("./limits-fixture.cjs");

const FUTURE = 4102444800;
const MAC = { width: 1512, height: 982 };
const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const ROWS = ["Claude 5-hour 18%", "Claude weekly 47%", "Codex 5-hour 32%", "Codex weekly 61%"];

// a board no one has asked /limits of yet, so the first answer is the one that
// starts codex
async function coldBoard() {
  const fx = await launch({ files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true });
  try {
    installCodex(fx.binDir, { reply: codexReply({ five: windowOf(32, 300, FUTURE), week: windowOf(61, 10080, FUTURE) }) });
    fs.renameSync(path.join(fx.binDir, "codex"), path.join(fx.binDir, "codex-real"));
    fs.writeFileSync(path.join(fx.binDir, "codex"),
      `#!/bin/sh\n/bin/sleep 1\nexec "${path.join(fx.binDir, "codex-real")}" "$@"\n`);
    fs.chmodSync(path.join(fx.binDir, "codex"), 0o755);
    fs.writeFileSync(path.join(fx.fixtureDir, "claude-limits.json"), JSON.stringify({
      five_hour: { used_percentage: 18, resets_at: FUTURE }, seven_day: { used_percentage: 47, resets_at: FUTURE } }));
    await fx.makeProject("second");
  } catch (err) { await fx.stop(); throw err; }
  return fx;
}

const rowsShown = page => page.evaluate(() => {
  const box = document.getElementById("homelimits");
  if (!box || box.hidden || getComputedStyle(box).display === "none") return [];
  return [...box.querySelectorAll(".lm-row")].map(row =>
    row.querySelector(".lm-name").textContent + " " + row.querySelector(".lm-pct").textContent);
});

async function untilRows(page, where) {
  const from = Date.now();
  let rows = [];
  while (Date.now() - from < 15000) {
    rows = await rowsShown(page);
    if (rows.length === ROWS.length) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.deepEqual(rows, ROWS, where);
}

// the phone's house and its projects are rows of the list the capsule in its
// row of buttons opens: a tap on the capsule, then on the row
async function viaList(page, row) {
  await page.tap("#projbtn");
  await page.waitForFunction(() => document.body.classList.contains("projopen"), { timeout: 3000 });
  await new Promise(r => setTimeout(r, 300));
  await page.tap(row);
}
const press = (page, touch) => touch ? viaList(page, "#homeico") : page.click("#homeico", { delay: 10 });
const pressTab = (page, touch) => touch ? viaList(page, "#projlist .projrow") : page.click("#tabbar .ptab", { delay: 10 });

async function openOn(fx, kind) {
  const { context, page } = await fx.openBoard(null, MAC);
  if (kind === "phone") {
    await page.setViewport(PHONE);
    await page.goto(fx.origin + "/m", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof lastState !== "undefined" && lastState !== null, { timeout: 15000 });
    await page.waitForSelector("#projlist .projrow.on", { timeout: 5000 });
  }
  return { context, page };
}

for (const kind of ["board", "phone"]) {
  const touch = kind === "phone";

  test(`${kind}: one press of the house shows the box with no reload, and again after a project tab`, async () => {
    const fx = await coldBoard();
    try {
      const { context, page } = await openOn(fx, kind);
      try {
        await press(page, touch);
        await untilRows(page, `${kind}: first press of the house`);
        await pressTab(page, touch);
        await page.waitForFunction(() => !document.body.classList.contains("home"), { timeout: 5000 });
        await press(page, touch);
        await page.waitForFunction(() => document.body.classList.contains("home"), { timeout: 5000 });
        await untilRows(page, `${kind}: the house pressed again after a project tab`);
      } finally { await context.close(); }
    } finally { await fx.stop(); }
  });

  test(`${kind}: a load straight onto home shows the box`, async () => {
    const fx = await coldBoard();
    try {
      const { context, page } = await openOn(fx, kind);
      try {
        await page.evaluate(() => localStorage.setItem("homeopen", "1"));
        await page.goto(fx.origin + (touch ? "/m" : "/"), { waitUntil: "domcontentloaded" });
        await untilRows(page, `${kind}: load straight onto home`);
      } finally { await context.close(); }
    } finally { await fx.stop(); }
  });
}
