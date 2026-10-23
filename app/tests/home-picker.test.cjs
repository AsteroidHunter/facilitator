// The home page's frame split a third and two thirds with nothing drawn
// between the parts (m1336): the list of open projects in the narrow part at
// the right, the pill's list's rows in a glass box, and the logo over the token box
// and the limits box centred in the wide part. "+ Open a new folder" at the
// list's foot does what the new tab's start button does. The new tab keeps its
// own picker, as it was.
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

test("the new tab's builder serves the new tab alone, and home's list is painted with the pill's", () => {
  assert.equal(HTML.match(/function renderHome\(/g).length, 1);
  assert.equal(HTML.match(/getElementById\("npstart"\)\.addEventListener/g).length, 1);
  assert.equal(HTML.match(/h\("div", "nprow"/g).length, 1, "one place builds a row");
  assert.equal(HTML.match(/id="nprows"/g).length, 1, "one set of markup");
  assert.doesNotMatch(HTML, /body\.focus\.home #newproj/, "the new tab's picker is not on home");
  assert.match(HTML, /if \(draft && draft\.screen === "home"\) renderHome\(state\);/);
  assert.match(HTML, /renderProjList\(st, owners\);\n  renderHomeList\(st, owners\);/, "both lists from the same projects in one paint");
  assert.doesNotMatch(HTML, /id="homeline"|#homeline/, "no line between the parts");
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
  });
  ids = [];
  for (const n of ["orchard", "harbor-notes", "ledger-app"]) ids.push(await fx.makeProject(n));
  await setTabs([ids[2]]);
});
after(async () => { if (fx) await fx.stop(); });

// limits and counts are invented
async function openPage(view) {
  const { context, page } = await fx.openBoard(null, view);
  await page.setRequestInterception(true);
  page.on("request", request => {
    const p = new URL(request.url()).pathname;
    if (p === "/limits") {
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(LIMITS) });
    } else if (p === "/tokens/daily") {
      const days = Array.from({ length: 371 }, (_, k) => ({ date: new Date(Date.parse("2026-09-30") - (370 - k) * 864e5).toISOString().slice(0, 10),
        total: 1e6 * (k % 9), input: 0, cache_write: 0, cache_read: 0, output: 0, claude: 1e6 * (k % 9), codex: 0 }));
      request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ days, found: { claude: true, codex: true } }) });
    } else request.continue();
  });
  return { context, page };
}
// the board's folder picker, as a reader works it: home's folder row opens it,
// a path typed in its field goes to that folder, and Choose answers it. no
// folder closes it with the cross instead. the copy's home is its own folder,
// so the picker lists nothing else
async function pick(page, folder, opener = "#homenew") {
  await page.click(opener, { delay: 10 });
  await page.waitForFunction(() => globalThis.FolderPicker?.isOpen() && document.querySelector(".fp-panel [data-f=path]"));
  if (folder == null) {
    await page.click(".fp-panel .fp-x", { delay: 10 });
    await page.waitForFunction(() => !FolderPicker.isOpen());
    return;
  }
  await page.evaluate(p => { const f = document.querySelector(".fp-panel [data-f=path]"); f.focus(); f.value = p; }, folder);
  await page.keyboard.press("Enter");
  await page.waitForFunction(name => document.querySelector(".fp-panel .fp-loc .fp-nm")?.textContent === name &&
    !document.querySelector(".fp-panel .fp-go").disabled, {}, path.basename(folder));
  await page.click(".fp-panel .fp-go", { delay: 10 });
  await page.waitForFunction(() => !FolderPicker.isOpen());
}
async function goHome(page) {
  await page.click("#homeico", { delay: 10 });
  await page.waitForFunction(() => document.body.classList.contains("home") && document.querySelectorAll("#homerows .homerow").length);
  await sleep(500);   // the page's fade has finished, and the sizes are fitted
  await page.evaluate(() => document.fonts.ready);   // sizes are read in the page's own faces
}
async function goPlus(page) {
  await page.click(".ptabplus", { delay: 10 });
  await page.waitForFunction(() => document.body.classList.contains("choosing"));
  await sleep(500);
  await page.evaluate(() => document.fonts.ready);
}
const measure = page => page.evaluate(() => {
  const R = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
             cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
  };
  const q = s => document.querySelector(s);
  const union = rs => {
    rs = rs.filter(r => r && r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const left = Math.min(...rs.map(r => r.left)), right = Math.max(...rs.map(r => r.right));
    const top = Math.min(...rs.map(r => r.top)), bottom = Math.max(...rs.map(r => r.bottom));
    return { left, right, top, bottom, width: right - left, height: bottom - top, cx: (left + right) / 2, cy: (top + bottom) / 2 };
  };
  const rows = document.getElementById("homerows");
  return {
    vw: innerWidth, vh: innerHeight, frame: R(q("#appframe")),
    side: R(q("#homeside")), part: R(q("#homelist")), list: R(q("#homelistbox")), folder: R(q("#homenew")),
    // what the logo and the charts show, which is what is centred
    ink: union(["#homemark", "#homebrandcopy", "#homeversion", "#home .tk-head", "#home .tk-stage", "#home .tk-status",
      "#homelimits .lm-title", "#homelimits .lm-rows", "#homelimits .tk-status"].map(s => R(q(s)))),
    names: [...document.querySelectorAll("#homelist .homename")].map(n => ({ text: n.textContent, cut: n.scrollWidth !== n.clientWidth })),
    rowNames: [...rows.querySelectorAll(".homerow")].map(r => r.querySelector(".homename").textContent),
    numbers: [...rows.querySelectorAll(".homerow")].map(r => r.querySelector(".homenum").textContent),
    menuNames: [...document.querySelectorAll("#projlist .projrow")].map(r => r.querySelector(".pname").textContent),
    well: { client: rows.clientHeight, scroll: rows.scrollHeight },
    line: !!document.getElementById("homeline"),
    // the new tab's picker, for the tests of the new tab
    stack: R(q("#nphome")), marked: document.querySelectorAll(".nprow.sel").length,
  };
});
const near = (a, b, why, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${why}: ${a} vs ${b}`);
// the two parts, the list in the narrow one and the logo and charts centred in the wide one
function placed(m, why) {
  near(m.part.right, m.frame.right, `${why}: the list's part at the frame's right edge`);
  near(m.side.left, m.frame.left, `${why}: the wide part at its left edge`);
  near(m.side.right, m.part.left, `${why}: the two parts meet`);
  near(m.part.width, m.frame.width / 3, `${why}: the list's part a third of the frame, whatever the names`);
  near(m.ink.cx, m.side.cx, `${why}: the logo and charts centred across their part`, 2);
  near(m.ink.cy, m.side.cy, `${why}: and down it`, 2);
  assert.ok(m.list.left >= m.part.left - 0.5 && m.list.right <= m.part.right + 0.5, `${why}: the list in its part`);
  assert.ok(m.list.left > m.ink.right, `${why}: the list clear of the logo and charts`);
  assert.ok(m.list.top >= m.frame.top && m.list.bottom <= m.frame.bottom, `${why}: inside the frame`);
  assert.deepEqual(m.names.filter(n => n.cut).map(n => n.text), [], `${why}: no name is cut`);
  assert.equal(m.line, false, `${why}: no line between the parts`);
}
const names = page => page.evaluate(() => [...document.querySelectorAll(".nprow")].map(r => r.querySelector(".npname").textContent
  + (r.classList.contains("shut") ? " (closed)" : "")));
async function clickRow(page, label) {
  const row = await page.evaluateHandle(l => [...document.querySelectorAll(".nprow")]
    .find(r => r.querySelector(".npname").textContent === l), label);
  await row.click({ delay: 10 });
}
async function clickHomeRow(page, label) {
  const row = await page.evaluateHandle(l => [...document.querySelectorAll("#homerows .homerow")]
    .find(r => r.querySelector(".homename").textContent === l).querySelector(".homename"), label);
  await row.click({ delay: 10 });
}
const where = (page, id) => page.evaluate(i => ({ home: document.body.classList.contains("home"), choosing: document.body.classList.contains("choosing"),
  owner: activeOwner, draft: !!draft, saved: localStorage.getItem("activeproj"),
  closed: tabClosed(i, lastState), note: document.getElementById("projnote").textContent,
  tabs: [...document.querySelectorAll("#tabbar .ptab")].map(t => t.dataset.owner + (t.classList.contains("on") ? "*" : "")) }), id);

test("home splits its frame at a third with no line: the list at the right, the logo and charts centred at the left, at three sizes and after a resize", async () => {
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    await page.waitForSelector("#homelimits .tk-panel", { timeout: 15000 });
    for (const view of [...SIZES, SIZES[0]]) {
      await page.setViewport(view);
      await sleep(400);
      placed(await measure(page), `${view.width}x${view.height}`);
    }
  } finally { await context.close(); }
});

test("a reload that comes back to home shows the rows in place, and a new project joins them live", async () => {
  const { context, page } = await openPage(SIZES[1]);
  try {
    await goHome(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.classList.contains("home") && document.querySelectorAll("#homerows .homerow").length);
    await sleep(500);
    const m = await measure(page);
    placed(m, "after a reload");
    const before = m.rowNames.length;
    await fx.makeProject("late-arrival");
    await page.waitForFunction(n => document.querySelectorAll("#homerows .homerow").length > n, { timeout: 15000 }, before);
  } finally { await context.close(); }
});

test("home's list holds the pill's list's projects in its order and numbers, and a closed project is in neither", async () => {
  await setTabs([ids[2]]);
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    const m = await measure(page);
    assert.deepEqual(m.rowNames, m.menuNames);
    assert.deepEqual(m.numbers, m.rowNames.map((_, i) => String(i + 1)));
    assert.equal(m.rowNames.length, await page.evaluate(() => rowsOf(lastState).length));
    assert.ok(m.rowNames.includes("orchard") && m.rowNames.includes("harbor-notes"));
    assert.ok(!m.rowNames.includes("ledger-app"), "the closed project is not on home's list, as it is not on the pill's");
  } finally { await context.close(); }
});

test("a click on a name in home's list leaves home and shows that board, as the pill's list does", async () => {
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    await clickHomeRow(page, "harbor-notes");
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    const at = await where(page, ids[1]);
    assert.equal(at.owner, ids[1]);
    assert.equal(at.saved, ids[1]);
    assert.equal(at.draft, false);
    await sleep(300);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("stage")).visibility), "visible");
  } finally { await context.close(); }
});

test("+ Open a new folder on home names an open folder, reopens a closed one, makes a new one, and a cancel does nothing", async () => {
  await setTabs([ids[2]]);
  const st0 = await state();
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    // closed with the cross: still home, nothing made
    await pick(page, null);
    await sleep(300);
    assert.equal((await where(page, ids[0])).home, true);
    assert.deepEqual(Object.keys((await state()).pwds).sort(), Object.keys(st0.pwds).sort());
    // a folder already behind an open tab: named, not refused, still home, nothing made
    await pick(page, st0.pwds[ids[0]]);
    await page.waitForFunction(() => document.getElementById("projnote").classList.contains("show"));
    let at = await where(page, ids[0]);
    assert.equal(at.note, "that folder is already open as orchard");
    assert.equal(at.home, true);
    assert.deepEqual(Object.keys((await state()).pwds).sort(), Object.keys(st0.pwds).sort());
    // a folder whose tab was closed: that tab comes back and its board shows
    await page.evaluate(() => document.getElementById("projnote").classList.remove("show"));
    await pick(page, st0.pwds[ids[2]]);
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    at = await where(page, ids[2]);
    assert.equal(at.closed, false);
    assert.equal(at.owner, ids[2]);
    assert.deepEqual(Object.keys((await state()).pwds).sort(), Object.keys(st0.pwds).sort(), "no new project for a known folder");
    // a new folder: the project is made, home is left, it is the open project
    await goHome(page);
    const fresh = path.join(fx.fixtureDir, "projects", "fresh-folder");
    fs.mkdirSync(fresh, { recursive: true });
    await pick(page, fresh);
    await page.waitForFunction(() => !document.body.classList.contains("home"));
    await page.waitForFunction(() => activeOwner === "fresh-folder");
    at = await where(page, "fresh-folder");
    assert.equal(at.owner, "fresh-folder");
    assert.equal(at.saved, "fresh-folder");
    assert.equal((await state()).pwds["fresh-folder"], fresh);
  } finally { await context.close(); await setTabs([ids[2]]); }
});

test("the new tab behaves as before: a marked row, an inert open row, a closed row that reopens, the button's note", async () => {
  await setTabs([ids[2]]);
  const st0 = await state();
  const { context, page } = await openPage(SIZES[0]);
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
    await pick(page, st0.pwds[ids[1]], "#npstart");
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
      const fading = await page.evaluate(() => document.getAnimations().filter(a => a.animationName === "homefade").length);
      assert.equal(fading, 0, "the home fade is not on the new tab");
    } finally { await context.close(); }
  }
});

test("on home both parts come in at the same moment on one plain fade, with no rise and no stagger", async () => {
  for (const view of SIZES.slice(0, 2)) {
    const { context, page } = await openPage(view);
    try {
      await sleep(800);
      await page.click("#homeico", { delay: 10 });
      const seen = await page.evaluate(async () => {
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const running = document.getAnimations().filter(a => a.animationName);
        const keys = a => [...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)))]
          .filter(k => !["offset", "easing", "composite", "computedOffset"].includes(k));
        const stage = getComputedStyle(document.getElementById("stage"));
        return {
          fades: running.filter(a => a.animationName === "homefade").map(a => ({
            id: a.effect.target.id, start: a.startTime, ms: a.effect.getTiming().duration, delay: a.effect.getTiming().delay,
            ease: a.effect.getKeyframes()[0].easing, props: keys(a) })),
          rises: running.filter(a => a.animationName === "npmelt").length,
          stage: { ms: stage.transitionDuration.split(",")[0].trim(), ease: stage.transitionTimingFunction.split(",")[0].trim() },
        };
      });
      const why = `${view.width}x${view.height}`;
      assert.deepEqual(seen.fades.map(f => f.id).sort(), ["homelist", "homeside"], `${why}: the list's part and the wide part`);
      assert.equal(new Set(seen.fades.map(f => f.start)).size, 1, `${why}: one start for both`);
      assert.deepEqual(seen.fades.map(f => [f.ms, f.delay, f.ease]), Array(2).fill([180, 0, "ease"]), `${why}: one length, no delay, one curve`);
      assert.deepEqual(seen.fades.map(f => f.props), Array(2).fill(["opacity"]), `${why}: opacity and nothing else, so nothing moves`);
      assert.equal(seen.rises, 0, `${why}: no rise on home`);
      assert.deepEqual(seen.stage, { ms: "0.18s", ease: "ease" }, `${why}: the board's dissolve has the same length and curve`);
    } finally { await context.close(); }
  }
});

test("home's folder row is in the list's own type, and the new tab's start button keeps the card's dress", async () => {
  const { context, page } = await openPage(SIZES[0]);
  try {
    const dress = () => page.evaluate(() => {
      const b = document.getElementById("npstart"), s = getComputedStyle(b);
      const probe = document.createElement("i");
      document.body.appendChild(probe);
      const colour = v => { probe.style.color = v; return getComputedStyle(probe).color; };
      const line = colour("var(--line)"), ink = colour("var(--ink)"), card = colour("var(--card)");
      probe.remove();
      const r = b.getBoundingClientRect();
      return { bg: s.backgroundColor, color: s.color, border: s.borderTopStyle + " " + s.borderTopColor, radius: s.borderTopLeftRadius,
        shadow: s.boxShadow, weight: s.fontWeight, family: s.fontFamily, line, ink, card, width: r.width, height: r.height };
    });
    const rowFill = async () => {
      await page.hover("#nprows .nprow.shut");
      await sleep(100);
      const fill = await page.evaluate(() => getComputedStyle(document.querySelector("#nprows .nprow.shut")).backgroundColor);
      await page.mouse.move(2, 2);
      return fill;
    };
    // home: the folder row is a row of the list, the plus in the numbers' column and face, the words in the names'
    await goHome(page);
    const row = await page.evaluate(() => {
      const look = el => { const s = getComputedStyle(el); return [s.fontFamily, s.fontSize, s.fontWeight, s.color].join("|"); };
      const folder = document.getElementById("homenew"), first = document.querySelector("#homerows .homerow");
      const r = el => el.getBoundingClientRect();
      return { glass: folder.classList.contains("qn-glass"), plus: folder.querySelector(".homenum").textContent,
        plusLook: look(folder.querySelector(".homenum")), numLook: look(first.querySelector(".homenum")),
        nameLook: look(folder.querySelector(".homename")), firstNameLook: look(first.querySelector(".homename")),
        plusRight: r(folder.querySelector(".homenum")).right, numRight: r(first.querySelector(".homenum")).right,
        nameLeft: r(folder.querySelector(".homename")).left, firstNameLeft: r(first.querySelector(".homename")).left,
        bg: getComputedStyle(folder).backgroundColor, shadow: getComputedStyle(folder).boxShadow };
    });
    assert.equal(row.glass, false, "home: no glass");
    assert.equal(row.plus, "+");
    assert.equal(row.plusLook, row.numLook, "home: the plus in the numbers' face and ink");
    assert.equal(row.nameLook, row.firstNameLook, "home: the words in the names' face and ink");
    near(row.plusRight, row.numRight, "home: the plus in the numbers' column");
    near(row.nameLeft, row.firstNameLeft, "home: the words where the names start");
    assert.equal(row.bg, "rgba(0, 0, 0, 0)", "home: no fill");
    assert.equal(row.shadow, "none", "home: no shadow");
    // the new tab can no longer be reached from the bar (its plus is gone), so its
    // look is read with the page put back to that state: choosing, not home
    await page.evaluate(() => {
      document.body.classList.remove("home");
      document.body.classList.add("choosing");
    });
    await sleep(300);
    const d = await dress();
    assert.equal(await page.evaluate(() => document.getElementById("npstart").classList.contains("qn-glass")), false, "new tab: no glass");
    assert.equal(d.bg, d.card, "new tab: the card's white");
    assert.equal(d.color, d.ink, "new tab: the board's ink");
    assert.equal(d.border, `solid ${d.line}`, "new tab: a thin border in the line colour");
    assert.equal(d.radius, "7px", "new tab: the card's corner radius");
    assert.equal(d.shadow, "none", "new tab: no shadow");
    assert.match(d.family, /^Inter\b/, "new tab");
    assert.ok(Math.abs(d.width - 175) <= 2 && Math.abs(d.height - 41) <= 0.5, `new tab: the old size or close, ${d.width} x ${d.height}`);
    const fill = await rowFill();
    assert.notEqual(fill, "rgba(0, 0, 0, 0)", "new tab: the row has a fill under the pointer");
    assert.notEqual(fill, d.card, "new tab: the row fill is not the card's white");
    await page.hover("#npstart");
    await sleep(100);
    assert.equal((await dress()).bg, fill, "new tab: a project row's fill under the pointer");
    await page.mouse.down();
    await sleep(50);
    assert.equal((await dress()).bg, fill, "new tab: and the same while pressed");
    assert.equal(await page.evaluate(() => document.getElementById("npstart").classList.contains("pressed")), false, "new tab: no glass press");
    await page.mouse.move(2, 2);
    await page.mouse.up();
  } finally { await context.close(); }
  const rule = (HTML.match(/body:not\(\.home\) #npstart\{[^}]*\}/) || [""])[0];
  assert.ok(rule, "the new tab's button rule is there");
  assert.doesNotMatch(rule, /FFF1E0|3A2E20|inset|border-radius:0|--accent|432BFF/i, "no cream, bevel or purple");
  assert.doesNotMatch(HTML, /#npstart:active\{[^}]*inset/);
  assert.match(HTML, /:root\{--row-hover:#FFF8EF\}/, "one named fill");
  assert.match(HTML, /body:not\(\.home\) #npstart:hover, body:not\(\.home\) #npstart:active\{background:var\(--row-hover\)\}/, "the new tab's button reads it");
  assert.match(HTML, /\.nprow\.shut:hover\{background:var\(--row-hover\)\}/, "the new tab's closed row reads it");
  assert.doesNotMatch(HTML, /#npstart\.qn-glass|getElementById\("npstart"\)\?\.classList\.toggle/, "the start button takes no glass");
});

test("the house on an unfinished new tab drops it, back on the tab it came from, and home shows its list", async () => {
  await setTabs([ids[2]]);
  const { context, page } = await openPage(SIZES[0]);
  try {
    await page.evaluate(i => setTab(i), ids[1]);
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
    const m = await measure(page);
    placed(m, "home after the new tab");
    assert.equal(m.rowNames.length, await page.evaluate(() => rowsOf(lastState).length));
    // and the plus still makes a new tab from home, with the new tab's own marked row
    await goPlus(page);
    assert.equal((await measure(page)).marked, 1);
  } finally { await context.close(); }
});

const projectCount = async () => Object.keys((await state()).pwds).filter(o => o !== "qchat").length;
async function growTo(total) {
  for (let k = await projectCount(); k < total; k++) await fx.makeProject("grow-" + k);
}

test("with one project home stands as with many: the list in its part, the logo and charts centred in theirs", async () => {
  const solo = await launch({ files: ["home-widgets.js", "home-widgets.css", "tokens.py", "limits.py"], onlyBin: true });
  try {
    await solo.makeProject("only-one");
    const { context, page } = await solo.openBoard(null, SIZES[0]);
    try {
      await goHome(page);
      const m = await measure(page);
      assert.equal(m.rowNames.length, await page.evaluate(() => rowsOf(lastState).length));
      assert.ok(m.rowNames.length <= 2, "a short list");
      placed(m, "one project");
      assert.equal(m.well.scroll, m.well.client, "nothing to scroll");
    } finally { await context.close(); }
  } finally { await solo.stop(); }
});

test("as the list grows to 12 and 40 every project has its row, whole, and one added while home is open joins it", async () => {
  for (const total of [5, 12, 40]) {
    await growTo(total);
    for (const view of [SIZES[0], SIZES[1]]) {
      const { context, page } = await openPage(view);
      try {
        await goHome(page);
        const m = await measure(page);
        assert.equal(m.rowNames.length, await page.evaluate(() => rowsOf(lastState).length), `${total}: every open project has its row`);
        placed(m, `${total} at ${view.width}x${view.height}`);
      } finally { await context.close(); }
    }
  }
  const { context, page } = await openPage(SIZES[0]);
  try {
    await goHome(page);
    const before = await measure(page);
    await fx.makeProject("added-while-open");
    await page.waitForFunction(n => document.querySelectorAll("#homerows .homerow").length > n, { timeout: 15000 }, before.rowNames.length);
    await sleep(700);
    const after = await measure(page);
    assert.equal(after.rowNames.length, before.rowNames.length + 1);
    assert.deepEqual(after.rowNames, after.menuNames, "the pill's list has it too, in the same place");
    placed(after, "after the add");
  } finally { await context.close(); }
});

test("a long list scrolls inside home's list between soft ends, the folder row stays put, in a tall window and a short one", async () => {
  for (const name of MORE) await fx.makeProject(name);
  for (const view of [SIZES[0], SIZES[1], SIZES[2], { width: 1100, height: 480 }]) {
    const { context, page } = await openPage(view);
    try {
      await goHome(page);
      const m = await measure(page);
      const why = `${view.width}x${view.height}`;
      assert.ok(m.rowNames.length >= 19, why);
      assert.ok(m.well.scroll > m.well.client, `${why}: the list scrolls inside itself`);
      placed(m, why);
      const room = await page.evaluate(() => ["homeglass", "homerows", "homenew"].map(id => {
        const r = document.getElementById(id).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
      assert.ok(room[1].top >= room[0].top - 0.5 && room[1].bottom <= room[0].bottom + 0.5, `${why}: the rows scroll inside the glass box`);
      assert.ok(room[2].top >= room[0].bottom, `${why}: the folder row stands under the box`);
      const bands = () => page.evaluate(() => { const s = document.getElementById("homerows").style;
        return [s.getPropertyValue("--upband"), s.getPropertyValue("--downband")]; });
      const [up, down] = await bands();
      assert.ok(up === "0px" && parseFloat(down) > 0, `${why}: at the top only the foot fades, ${up} ${down}`);
      // the last row can be reached by scrolling the list, not the page, and the folder row does not move
      await page.evaluate(() => { const b = document.getElementById("homerows"); b.scrollTop = b.scrollHeight; });
      await sleep(300);
      const after = await measure(page);
      const last = await page.evaluate(() => { const b = document.getElementById("homerows").getBoundingClientRect();
        const r = [...document.querySelectorAll("#homerows .homerow")].pop().getBoundingClientRect(); return r.bottom <= b.bottom + 1 && r.top >= b.top; });
      assert.equal(last, true, `${why}: the last row comes into view`);
      assert.deepEqual([after.folder.left, after.folder.top], [m.folder.left, m.folder.top], `${why}: + Open a new folder stays put`);
      const [upEnd, downEnd] = await bands();
      assert.ok(parseFloat(upEnd) > 0 && downEnd === "0px", `${why}: at the end only the head fades, ${upEnd} ${downEnd}`);
    } finally { await context.close(); }
  }
});
