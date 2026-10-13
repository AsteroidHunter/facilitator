// The ticket groups are four adjacent sections of one horizontal sheet under a
// fixed, clipped well: selecting a tab to the right moves the sheet left so the
// next section enters from the right, selecting one to the left reverses it, and
// a three-section jump travels visibly across the middle sections. These record the
// sheet's translateX in section units over time, driven by real pointer clicks,
// so a renamed incoming keyframe cannot pass as a continuous sheet. Reduced
// motion places the section with no traversal, and a reversal mid-travel returns
// without a reset jump.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;
const settle = ms => new Promise(r => setTimeout(r, ms));

async function revealTab(page, name) {
  if (await page.$eval("#tv-" + name, el => el.inert)) {
    // Paging slides only the names. Keep that 240ms out of the sheet sampler's
    // budget: the subsequent three-section journey can itself take 620ms.
    const selection = () => ({ view: curView(), card: selectedId,
      target: document.getElementById("tiksheet").style.transform });
    const before = await page.evaluate(selection);
    await clickHeaderControl(page, name === "todo" || name === "docked" ? "tik-page-back" : "tik-page");
    await page.$eval("#tiklabels", el => Promise.all(el.getAnimations().map(a => a.finished)));
    assert.deepEqual(await page.evaluate(selection), before, "paging the names changed the list or selected card");
  }
  assert.equal(await page.$eval("#tv-" + name, el => el.inert), false, `${name} is still on the hidden label page`);
  await headerControlPoint(page, "tv-" + name);
}
async function headerControlPoint(page, id) {
  const box = await page.evaluate(id => {
    const el = document.getElementById(id); const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    const names = document.getElementById("tiknames").getBoundingClientRect();
    return { x, y, width: r.width, height: r.height, inert: el.inert,
      hit: hit?.id, insideNames: x > names.left && x < names.right && y > names.top && y < names.bottom };
  }, id);
  assert.ok(box.width > 0 && box.height > 0 && !box.inert, `${id} has no active click area`);
  assert.equal(box.hit, id, `${id} centre (${box.x}, ${box.y}) hits ${box.hit}`);
  assert.equal(box.insideNames, !id.startsWith("tik-page"), `${id} is on the wrong side of the clipped names viewport`);
  return box;
}
async function clickHeaderControl(page, id) {
  const box = await headerControlPoint(page, id);
  await page.mouse.click(box.x, box.y);
}
async function realClickTab(page, name) {
  await clickHeaderControl(page, "tv-" + name);
  assert.equal(await page.evaluate(() => curView()), name, `the ${name} click did not select its list`);
}
// start a non-blocking rAF sampler of the sheet's section position for ms
async function startSampler(page, ms) {
  await page.evaluate(dur => {
    window.__sec = [];
    const sheet = document.getElementById("tiksheet");
    const read = () => {
      const t = getComputedStyle(sheet).transform;
      const m = t && t.match(/matrix\(([^)]+)\)/); if (!m) return 0;
      const tx = parseFloat(m[1].split(",")[4]) || 0;
      return -tx / (sheet.getBoundingClientRect().width || 1);
    };
    const t0 = performance.now();
    (function tick() { window.__sec.push(+read().toFixed(4)); if (performance.now() - t0 < dur) requestAnimationFrame(tick); })();
  }, ms);
}
const readSamples = page => page.evaluate(() => window.__sec);
function stats(s) {
  const dir = Math.sign(s[s.length - 1] - s[0]) || 1;
  let back = 0;
  for (let i = 1; i < s.length; i++) { const step = (s[i] - s[i - 1]) * dir; if (step < 0) back = Math.max(back, -step); }
  return { start: s[0], end: s[s.length - 1], min: Math.min(...s), max: Math.max(...s),
    middle: s.some(v => v >= 0.7 && v <= 1.3) && s.some(v => v >= 1.7 && v <= 2.3), back };
}
async function openSeeded() {
  const { context, page } = await fx.openBoard(null, { width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector('.tikpane[data-view="done"] .trow, .tikpane[data-view="done"] .tempty'));
  await page.$eval("#tiklabels", el => Promise.all(el.getAnimations().map(a => a.finished)));
  await settle(150);
  assert.equal(await page.evaluate(() => curView()), "todo", "fixture did not open on Doing");
  return { context, page };
}

before(async () => {
  fx = await launch({ seed: { title: "Sheet nav", items: [{ id: "0", bucket: "meta", owner: "facilitator", title: "Meta" }] } });
  for (const t of ["Doing a", "Doing b", "Doing c", "Doing d"]) await fx.post("/create?owner=facilitator", t);
  for (const t of ["Parked a", "Parked b"]) { const id = (await fx.post("/create?owner=facilitator", t)).id; await fx.post("/park?box=" + id + "&v=1"); }
  for (const t of ["Done a", "Done b"]) { const id = (await fx.post("/create?owner=facilitator", t)).id; await fx.post("/done?box=" + id + "&v=1"); }
});
after(async () => { if (fx) await fx.stop(); });

test("both header arrows slide names without moving the sheet or changing selection", async () => {
  const { context, page } = await openSeeded();
  try {
    await startSampler(page, 650);
    await revealTab(page, "done");
    await revealTab(page, "todo");
    await settle(700);
    const s = await readSamples(page);
    assert.ok(s.every(v => Math.abs(v) < 0.01), "an arrow moved the sheet away from Doing");
  } finally { await context.close(); }
});

test("doing to docked moves the sheet left, the next section entering from the right", async () => {
  const { context, page } = await openSeeded();
  try {
    await startSampler(page, 600);
    await realClickTab(page, "docked");
    await settle(650);
    const s = stats(await readSamples(page));
    assert.ok(s.start < 0.15, `started away from doing: ${s.start}`);
    assert.ok(s.end > 0.9 && s.end < 1.1, `did not settle on docked: ${s.end}`);
    assert.ok(s.back < 0.06, `moved backward against the direction: ${s.back}`);
    assert.equal(await page.evaluate(() => curView()), "docked");
  } finally { await context.close(); }
});

test("docked to doing reverses the sheet", async () => {
  const { context, page } = await openSeeded();
  try {
    await realClickTab(page, "docked"); await settle(360);
    await startSampler(page, 600);
    await realClickTab(page, "todo");
    await settle(650);
    const s = stats(await readSamples(page));
    assert.ok(s.start > 0.9, `did not start at docked: ${s.start}`);
    assert.ok(s.end < 0.1, `did not settle on doing: ${s.end}`);
    assert.ok(s.back < 0.06, `moved backward against the direction: ${s.back}`);
  } finally { await context.close(); }
});

test("doing to done travels visibly through Docked and Deferred", async () => {
  const { context, page } = await openSeeded();
  try {
    await revealTab(page, "done");
    await startSampler(page, 820);
    await realClickTab(page, "done");
    await settle(860);
    const s = stats(await readSamples(page));
    assert.ok(s.start < 0.15, `did not start at doing: ${s.start}`);
    assert.ok(s.end > 2.9, `did not settle on done: ${s.end}`);
    assert.ok(s.middle, "the sheet did not pass through Docked and Deferred");
    assert.ok(s.back < 0.06, `moved backward against the direction: ${s.back}`);
    assert.equal(await page.evaluate(() => curView()), "done");
  } finally { await context.close(); }
});

test("done to doing reverses the three-section jump through Docked and Deferred", async () => {
  const { context, page } = await openSeeded();
  try {
    await revealTab(page, "done");
    await realClickTab(page, "done"); await settle(700);
    await revealTab(page, "todo");
    await startSampler(page, 820);
    await realClickTab(page, "todo");
    await settle(860);
    const s = stats(await readSamples(page));
    assert.ok(s.start > 2.9, `did not start at done: ${s.start}`);
    assert.ok(s.end < 0.1, `did not settle on doing: ${s.end}`);
    assert.ok(s.middle, "the reverse jump did not pass through Docked and Deferred");
  } finally { await context.close(); }
});

test("a reversal mid-travel returns without a reset jump and without reaching done", async () => {
  const { context, page } = await openSeeded();
  try {
    await revealTab(page, "done");
    await startSampler(page, 900);
    await realClickTab(page, "done");
    // Reveal Doing while the sheet travels. Waiting another 120ms before
    // starting this label slide needlessly spends the reversal's time budget.
    await revealTab(page, "todo");
    const before = (await readSamples(page)).at(-1);
    assert.ok(before > 0.1 && before < 2.85, `not partway toward Done before reversal: ${before}`);
    await realClickTab(page, "todo");
    await settle(760);
    const s = await readSamples(page);
    const max = Math.max(...s), end = s[s.length - 1];
    assert.ok(max > 0.1, "the sheet never started toward Done");
    assert.ok(max < 2.85, `the reversal still snapped to done: max ${max}`);
    assert.ok(end < 0.08, `did not return to doing: ${end}`);
  } finally { await context.close(); }
});

test("reduced motion places the section with no visible traversal", async () => {
  const { context, page } = await openSeeded();
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await revealTab(page, "done");
    await startSampler(page, 260);
    await realClickTab(page, "done");
    await settle(300);
    const s = await readSamples(page);
    const betweenSections = s.some(v => Math.abs(v - Math.round(v)) > 0.01);
    assert.equal(await page.evaluate(() => curView()), "done");
    assert.ok(s[s.length - 1] > 2.9, `did not land on done: ${s[s.length - 1]}`);
    assert.ok(!betweenSections, "reduced motion showed a traversal instead of whole-section jumps");
  } finally { await context.close(); }
});
