// The home page's left half holds the new tab's own project picker: the same
// markup and the same builder, centred in that half by layout, every row a way
// in, and the start button doing what it does on the new tab. The new tab, the
// token box and the limits box stay as they were.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { launch } = require("./resp-harness.cjs");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIZES = [{ width: 1512, height: 982 }, { width: 1280, height: 800 }, { width: 1920, height: 1080 }];
const LIMITS = {
  claude: { five_hour: { used: 23, resets: 4102444800 }, weekly: { used: 41, resets: 4102444800 } },
  codex: { five_hour: { used: 7, resets: 4102444800 }, weekly: { used: 88, resets: 4102444800 } },
};
const MORE = ["atlas-api", "birch-site", "cobalt-docs", "delta-sync", "ember-cli", "fjord-ui", "garnet-bot",
  "harvest-db", "indigo-lab", "juniper-kit", "kestrel-web", "lumen-app", "meadow-notes", "nimbus-core", "onyx-tools"];

test("one builder and one start handler serve both pages, and the home rows are not a copy", () => {
  assert.equal(HTML.match(/function renderHome\(/g).length, 1);
  assert.equal(HTML.match(/getElementById\("npstart"\)\.addEventListener/g).length, 1);
  assert.equal(HTML.match(/h\("div", "nprow"/g).length, 1, "one place builds a row");
  assert.equal(HTML.match(/id="nprows"/g).length, 1, "one set of markup");
  assert.match(HTML, /body\.focus\.home #newproj\{display:flex; flex-direction:column; align-items:center;\n\s+justify-content:center;/);
  assert.doesNotMatch(HTML, /body\.focus\.home #newproj\{[^}]*transform/, "centring is layout, not an offset");
  assert.match(HTML, /if \(\(draft && draft\.screen === "home"\) \|\| homeOpen\) renderHome\(state\);/);
});

let fx, ids, projects;
const state = async () => (await fetch(fx.origin + "/state")).json();
async function setTabs(closed) {
  const st = await state();
  const order = Object.keys(st.pwds).filter(o => o !== "qchat");
  await fx.post("/tabs", JSON.stringify({ order, closed }));
}
before(async () => {
  fx = await launch({
    files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true,
    // the server copy never opens the system chooser; each test also answers the page's request itself
    env: { FACILITATOR_PICKDIR_STUB: "/nonexistent-folder-for-the-stub" },
  });
  ids = [];
  for (const n of ["orchard", "harbor-notes", "ledger-app"]) ids.push(await fx.makeProject(n));
  await setTabs([ids[2]]);
});
after(async () => { if (fx) await fx.stop(); });

// the chooser answers with whatever the test last set; limits and counts are invented
async function openPage(view) {
  const { context, page } = await fx.openBoard(null, view);
  const stub = { answer: { cancelled: true }, asked: 0 };
  await page.setRequestInterception(true);
  page.on("request", request => {
    const p = new URL(request.url()).pathname;
    if (p === "/pickdir") {
      stub.asked++;
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(stub.answer) });
    } else if (p === "/limits") {
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(LIMITS) });
    } else if (p === "/tokens/daily") {
      const days = Array.from({ length: 371 }, (_, k) => ({ date: new Date(Date.parse("2026-09-30") - (370 - k) * 864e5).toISOString().slice(0, 10),
        total: 1e6 * (k % 9), input: 0, cache_write: 0, cache_read: 0, output: 0, claude: 1e6 * (k % 9), codex: 0 }));
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ days, found: { claude: true, codex: true } }) });
    } else request.continue();
  });
  return { context, page, stub };
}
async function goHome(page) {
  await page.click("#homeico", { delay: 10 });
  await page.waitForFunction(() => document.body.classList.contains("home") && document.querySelectorAll("#nprows .nprow").length);
  await sleep(500);   // the three pieces rise one beat apart
}
async function goPlus(page) {
  await page.click(".ptabplus", { delay: 10 });
  await page.waitForFunction(() => document.body.classList.contains("choosing"));
  await sleep(500);
}
const measure = page => page.evaluate(() => {
  const R = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
             cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
  };
  const q = s => document.querySelector(s);
  return {
    vw: innerWidth, vh: innerHeight, frame: R(q("#appframe")),
    stack: R(q("#nphome")), brand: R(q("#npbrand")), panel: R(q("#nppanel")), rows: R(q("#nprows")), button: R(q("#npstart")),
    rowRects: [...document.querySelectorAll(".nprow")].map(R),
    token: R(q("#home .tk-panel")), limits: R(q("#homelimits .tk-panel")),
    well: { client: q("#nprows").clientHeight, scroll: q("#nprows").scrollHeight },
    marked: document.querySelectorAll(".nprow.sel").length,
  };
});
const near = (a, b, why, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${why}: ${a} vs ${b}`);
const names = page => page.evaluate(() => [...document.querySelectorAll(".nprow")].map(r => r.querySelector(".npname").textContent
  + (r.classList.contains("shut") ? " (closed)" : "")));
async function clickRow(page, label) {
  const row = await page.evaluateHandle(l => [...document.querySelectorAll(".nprow")]
    .find(r => r.querySelector(".npname").textContent === l), label);
  await row.click({ delay: 10 });
}
const where = (page, id) => page.evaluate(i => ({ home: document.body.classList.contains("home"), choosing: document.body.classList.contains("choosing"),
  owner: activeOwner, draft: !!draft, saved: localStorage.getItem("activeproj"),
  closed: tabClosed(i, lastState), note: document.getElementById("projnote").textContent,
  tabs: [...document.querySelectorAll("#tabbar .ptab")].map(t => t.dataset.owner + (t.classList.contains("on") ? "*" : "")) }), id);

test("the stack stands at the centre of the frame's left half, both ways, at three sizes and after a resize", async () => {
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    for (const view of [...SIZES, SIZES[0]]) {
      await page.setViewport(view);
      await sleep(400);
      const m = await measure(page);
      const why = `${view.width}x${view.height}`;
      near(m.stack.cx, m.frame.left + (m.frame.right - m.frame.left) / 4, `${why}: across`);
      near(m.stack.cy, (m.frame.top + m.frame.bottom) / 2, `${why}: down`);
      assert.ok(m.stack.top >= m.frame.top && m.stack.bottom <= m.frame.bottom, `${why}: inside the frame`);
      assert.ok(m.stack.right <= (m.frame.left + m.frame.right) / 2, `${why}: in the left half`);
      assert.equal(m.marked, 0, `${why}: no row is marked on home`);
      // the two boxes on the right are one pair, centred in the right half and down the frame, picker or not
      assert.ok(m.limits, `${why}: the limits box is there`);
      near(m.token.cx, m.frame.left + 0.75 * (m.frame.right - m.frame.left), `${why}: token across`);
      near(m.limits.cx, m.token.cx, `${why}: limits across`);
      near((m.token.top + m.limits.bottom) / 2, (m.frame.top + m.frame.bottom) / 2, `${why}: pair down`);
      await page.addStyleTag({ content: "#newproj{display:none !important}" });
      const bare = await measure(page);
      assert.deepEqual([bare.token, bare.limits], [m.token, m.limits], `${why}: the picker moved a box on the right`);
      await page.evaluate(() => { document.head.lastElementChild.remove(); });
    }
  } finally { await context.close(); }
});

test("a reload that comes back to home shows the rows in place, and a new project joins them live", async () => {
  const { context, page } = await openPage(SIZES[1]);
  try {
    await goHome(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("home") && document.querySelectorAll("#nprows .nprow").length);
    await sleep(500);
    const m = await measure(page);
    near(m.stack.cx, m.frame.left + (m.frame.right - m.frame.left) / 4, "across");
    near(m.stack.cy, (m.frame.top + m.frame.bottom) / 2, "down");
    const before = m.rowRects.length;
    await fx.makeProject("late-arrival");
    await page.waitForFunction(n => document.querySelectorAll("#nprows .nprow").length > n, { timeout: 15000 }, before);
  } finally { await context.close(); }
});

test("the stack is the new tab's own, the same sizes and gaps", async () => {
  for (const view of SIZES) {
    const { context, page } = await openPage(view);
    try {
      await goHome(page);
      const home = await measure(page);
      await goPlus(page);
      const tab = await measure(page);
      const size = r => [r.width, r.height].map(x => Math.round(x * 100) / 100);
      for (const k of ["stack", "brand", "panel", "rows", "button"])
        assert.deepEqual(size(home[k]), size(tab[k]), `${view.width}x${view.height}: ${k}`);
      assert.deepEqual(home.rowRects.map(size), tab.rowRects.map(size));
      assert.equal(home.brand.bottom - home.stack.top, tab.brand.bottom - tab.stack.top);
      assert.equal(home.button.top - home.panel.bottom, tab.button.top - tab.panel.bottom);
    } finally { await context.close(); }
  }
});

test("a click on an open project's row leaves home and shows that board, as its tab would", async () => {
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    const rows = await names(page);
    assert.equal(rows.length, await page.evaluate(() => allRowsOf(lastState).length));
    for (const want of ["orchard", "harbor-notes", "ledger-app (closed)"]) assert.ok(rows.includes(want), want);
    await clickRow(page, "harbor-notes");
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    const at = await where(page, ids[1]);
    assert.equal(at.owner, ids[1]);
    assert.equal(at.saved, ids[1]);
    assert.ok(at.tabs.includes(ids[1] + "*"), "its tab is the seated one");
    assert.equal(at.draft, false);
    await sleep(300);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("stage")).visibility), "visible");
  } finally { await context.close(); }
});

test("a click on a closed project's row reopens its tab and shows its board", async () => {
  await setTabs([ids[2]]);
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    assert.equal((await where(page, ids[2])).closed, true);
    await clickRow(page, "ledger-app");
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    const at = await where(page, ids[2]);
    assert.equal(at.closed, false, "the tab is back");
    assert.equal(at.owner, ids[2]);
    assert.ok(at.tabs.includes(ids[2] + "*"));
    assert.deepEqual((await state()).tabs.closed, []);
  } finally { await context.close(); await setTabs([ids[2]]); }
});

test("the start button on home makes the new tab, names an open folder, reopens a closed one, and a cancel does nothing", async () => {
  await setTabs([ids[2]]);
  const st0 = await state();
  const { context, page, stub } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    // cancelled: still home, nothing made
    stub.answer = { cancelled: true };
    await page.click("#npstart", { delay: 10 });
    await sleep(500);
    assert.equal(stub.asked, 1);
    assert.equal((await where(page, ids[0])).home, true);
    // a folder already behind an open tab: named, not refused, still home, nothing made
    stub.answer = { path: st0.pwds[ids[0]] };
    await page.click("#npstart", { delay: 10 });
    await page.waitForFunction(() => document.getElementById("projnote").classList.contains("show"));
    let at = await where(page, ids[0]);
    assert.equal(at.note, "that folder is already open as orchard");
    assert.equal(at.home, true);
    assert.deepEqual(Object.keys((await state()).pwds).sort(), Object.keys(st0.pwds).sort());
    // a folder whose tab was closed: that tab comes back and its board shows
    await page.evaluate(() => document.getElementById("projnote").classList.remove("show"));
    stub.answer = { path: st0.pwds[ids[2]] };
    await page.click("#npstart", { delay: 10 });
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    at = await where(page, ids[2]);
    assert.equal(at.closed, false);
    assert.equal(at.owner, ids[2]);
    assert.deepEqual(Object.keys((await state()).pwds).sort(), Object.keys(st0.pwds).sort(), "no new project for a known folder");
    // a new folder: the project is made, home is left, its tab is the seated one
    await goHome(page);
    const fresh = path.join(fx.fixtureDir, "projects", "fresh-folder");
    fs.mkdirSync(fresh, { recursive: true });
    stub.answer = { path: fresh };
    await page.click("#npstart", { delay: 10 });
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    await page.waitForFunction(() => [...document.querySelectorAll("#tabbar .ptab")].some(t => t.dataset.owner === "fresh-folder" && t.classList.contains("on")));
    at = await where(page, "fresh-folder");
    assert.equal(at.owner, "fresh-folder");
    assert.equal(at.saved, "fresh-folder");
    assert.equal((await state()).pwds["fresh-folder"], fresh);
    assert.equal(await page.evaluate(() => document.querySelector("#nprows").children.length > 0), true);
  } finally { await context.close(); }
});

test("the new tab behaves as before: a marked row, an inert open row, a closed row that reopens, the button's note", async () => {
  await setTabs([ids[2]]);
  const st0 = await state();
  const { context, page, stub } = await openPage(SIZES[0]);
  try {
    await goPlus(page);
    const m = await measure(page);
    near(m.stack.cx, m.vw / 2, "new tab across the window");
    near(m.stack.top - m.frame.top, m.frame.bottom - m.stack.bottom, "new tab centred down the frame", 1.5);
    assert.equal(m.marked, 1, "the project it came from is the marked row");
    // an open project's row is plain information
    await clickRow(page, "harbor-notes");
    await sleep(300);
    let at = await where(page, ids[1]);
    assert.equal(at.draft, true);
    assert.equal(at.choosing, true);
    // the button names an open folder and stays on the new tab
    stub.answer = { path: st0.pwds[ids[1]] };
    await page.click("#npstart", { delay: 10 });
    await page.waitForFunction(() => document.getElementById("projnote").classList.contains("show"));
    at = await where(page, ids[1]);
    assert.equal(at.note, "that folder is already open as harbor-notes");
    assert.equal(at.draft, true);
    // a closed project's row reopens its tab and ends the new tab
    await clickRow(page, "ledger-app");
    await page.waitForFunction(() => !document.body.classList.contains("choosing"));
    at = await where(page, ids[2]);
    assert.equal(at.owner, ids[2]);
    assert.equal(at.closed, false);
    assert.equal(at.draft, false);
  } finally { await context.close(); await setTabs([ids[2]]); }
});

test("the plus pressed from home shows the new tab as from a board: its three pieces rise afresh", async () => {
  for (const viaHome of [false, true]) {
    const { context, page } = await openPage(SIZES[0]);
    try {
      if (viaHome) await goHome(page);
      await page.click(".ptabplus", { delay: 10 });
      const rising = await page.evaluate(() => document.getAnimations()
        .filter(a => a.animationName === "npmelt" && a.currentTime < 150).length);
      assert.equal(rising, 3, viaHome ? "from home" : "from a board");
    } finally { await context.close(); }
  }
});

test("the house on an unfinished new tab drops it, back on the tab it came from, and the picker shows the rows", async () => {
  await setTabs([ids[2]]);
  const { context, page } = await openPage(SIZES[0]);
  try {
    await page.click(`#tabbar .ptab[data-owner="${ids[1]}"]`, { delay: 10 });
    await page.waitForFunction(i => activeOwner === i, {}, ids[1]);
    await goPlus(page);
    await page.click("#homeico", { delay: 10 });
    await page.waitForFunction(() => document.body.classList.contains("home"));
    await sleep(400);
    const at = await where(page, ids[1]);
    assert.equal(at.draft, false);
    assert.equal(at.choosing, false);
    assert.equal(at.owner, ids[1], "the tab it came from");
    assert.equal(at.saved, ids[1], "the saved tab was not wiped");
    assert.ok(!at.tabs.some(t => t.startsWith("__new__")), "no new project tab left in the bar");
    const m = await measure(page);
    assert.equal(m.marked, 0);
    near(m.stack.cx, m.frame.left + (m.frame.right - m.frame.left) / 4, "across");
    near(m.stack.cy, (m.frame.top + m.frame.bottom) / 2, "down");
    assert.equal(m.rowRects.length, await page.evaluate(() => allRowsOf(lastState).length));
    // and the plus still makes a new tab from home, with the new tab's own marked row
    await goPlus(page);
    assert.equal((await measure(page)).marked, 1);
  } finally { await context.close(); }
});

const centred = (m, why) => {
  near(m.stack.cy, (m.frame.top + m.frame.bottom) / 2, `${why}: down`);
  assert.ok(m.stack.top >= m.frame.top && m.stack.bottom <= m.frame.bottom, `${why}: inside the frame`);
};
const projectCount = async () => Object.keys((await state()).pwds).filter(o => o !== "qchat").length;
async function growTo(total) {
  for (let k = await projectCount(); k < total; k++) await fx.makeProject("grow-" + k);
}

test("with one project the stack stands centred, on home and on the new tab", async () => {
  const solo = await launch({ files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true });
  try {
    await solo.makeProject("only-one");
    const { context, page } = await solo.openBoard(null, SIZES[0]);
    try {
      await goHome(page);
      let m = await measure(page);
      assert.equal(m.rowRects.length, await page.evaluate(() => allRowsOf(lastState).length));
      assert.ok(m.rowRects.length <= 2, "a short list");
      centred(m, "home");
      near(m.stack.cx, m.frame.left + (m.frame.right - m.frame.left) / 4, "home across");
      await goPlus(page);
      m = await measure(page);
      centred(m, "new tab");
      near(m.stack.cx, m.vw / 2, "new tab across");
    } finally { await context.close(); }
  } finally { await solo.stop(); }
});

test("the stack stays centred as the list grows to 12 and 40, on home and the new tab, and when one is added while open", async () => {
  for (const total of [5, 12, 40]) {
    await growTo(total);
    for (const view of [SIZES[0], SIZES[1]]) {
      const { context, page } = await openPage(view);
      try {
        await goHome(page);
        const home = await measure(page);
        assert.equal(home.rowRects.length, await page.evaluate(() => allRowsOf(lastState).length), `${total}: every project has its row`);
        assert.ok(home.rowRects.length >= total, `${total}: at least that many rows`);
        centred(home, `${total} on home at ${view.width}x${view.height}`);
        await goPlus(page);
        centred(await measure(page), `${total} on the new tab at ${view.width}x${view.height}`);
      } finally { await context.close(); }
    }
  }
  for (const where of ["home", "new tab"]) {
    const { context, page } = await openPage(SIZES[0]);
    try {
      await goHome(page);
      if (where === "new tab") await goPlus(page);
      const before = await measure(page);
      await fx.makeProject("added-while-open-" + where.replace(" ", ""));
      await page.waitForFunction(n => document.querySelectorAll("#nprows .nprow").length > n, { timeout: 15000 }, before.rowRects.length);
      await sleep(700);
      const after = await measure(page);
      assert.equal(after.rowRects.length, before.rowRects.length + 1);
      centred(before, `${where} before the add`);
      centred(after, `${where} after the add`);
    } finally { await context.close(); }
  }
});

test("a long list scrolls inside its well and the stack stays in the frame, in a tall window and a short one", async () => {
  for (const name of MORE) await fx.makeProject(name);
  for (const view of [SIZES[0], SIZES[1], SIZES[2], { width: 1100, height: 480 }]) {
    const { context, page } = await openPage(view);
    try {
      await goHome(page);
      const m = await measure(page);
      const why = `${view.width}x${view.height}`;
      assert.equal(m.rowRects.length, await page.evaluate(() => allRowsOf(lastState).length), why);
      assert.ok(m.rowRects.length >= 19, why);
      assert.ok(m.well.scroll > m.well.client, `${why}: the list scrolls inside its well`);
      assert.ok(m.stack.top >= m.frame.top && m.stack.bottom <= m.frame.bottom, `${why}: inside the frame`);
      near(m.stack.cx, m.frame.left + (m.frame.right - m.frame.left) / 4, `${why}: across`);
      near(m.stack.cy, (m.frame.top + m.frame.bottom) / 2, `${why}: down`);
      if (view.height >= 800) assert.ok(m.well.client <= 0.56 * view.height + 1, `${why}: no taller than on the new tab`);
      // the last row can be reached by scrolling the well, not the page
      await page.evaluate(() => { const b = document.getElementById("nprows"); b.scrollTop = b.scrollHeight; });
      const last = await page.evaluate(() => { const b = document.getElementById("nprows").getBoundingClientRect(); const r = [...document.querySelectorAll(".nprow")].pop().getBoundingClientRect(); return r.bottom <= b.bottom + 1 && r.top >= b.top; });
      assert.equal(last, true, `${why}: the last row comes into view`);
    } finally { await context.close(); }
  }
});
