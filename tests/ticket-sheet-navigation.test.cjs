// The ticket groups are four adjacent sections of one horizontal sheet under a
// fixed, clipped well: selecting a tab to the right moves the sheet left so the
// next section enters from the right, selecting one to the left reverses it, and
// a two-section jump travels visibly across the middle section. These record the
// sheet's translateX in section units over time, driven by real pointer clicks,
// so a renamed incoming keyframe cannot pass as a continuous sheet. Reduced
// motion places the section with no traversal, and a reversal mid-travel returns
// without a reset jump.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;
const settle = ms => new Promise(r => setTimeout(r, ms));

async function realClickTab(page, name) {
  if (await page.$eval("#tv-" + name, el => el.hidden)) await page.click("#tik-page");
  const box = await page.evaluate(id => {
    const el = document.getElementById(id); const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, "tv-" + name);
  await page.mouse.click(box.x, box.y);
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
  await settle(150);
  return { context, page };
}

before(async () => {
  fx = await launch({ seed: { title: "Sheet nav", items: [{ id: "0", bucket: "meta", owner: "facilitator", title: "Meta" }] } });
  for (const t of ["Doing a", "Doing b", "Doing c", "Doing d"]) await fx.post("/create?owner=facilitator", t);
  for (const t of ["Parked a", "Parked b"]) { const id = (await fx.post("/create?owner=facilitator", t)).id; await fx.post("/park?box=" + id + "&v=1"); }
  for (const t of ["Done a", "Done b"]) { const id = (await fx.post("/create?owner=facilitator", t)).id; await fx.post("/done?box=" + id + "&v=1"); }
});
after(async () => { if (fx) await fx.stop(); });

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
    await realClickTab(page, "done"); await settle(700);
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
    await startSampler(page, 900);
    await realClickTab(page, "done");
    await settle(120);   // partway toward done
    await realClickTab(page, "todo");
    await settle(760);
    const s = await readSamples(page);
    const max = Math.max(...s), end = s[s.length - 1];
    assert.ok(max < 2.85, `the reversal still snapped to done: max ${max}`);
    assert.ok(end < 0.08, `did not return to doing: ${end}`);
  } finally { await context.close(); }
});

test("reduced motion places the section with no visible traversal", async () => {
  const { context, page } = await openSeeded();
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
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
