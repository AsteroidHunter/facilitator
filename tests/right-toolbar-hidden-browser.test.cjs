// The right toolbar and its Notes drawer are hidden in this version: nothing of them is
// in the page, the right margin matches the other three sides, the gear sits in the top
// right corner as the house sits in the top left, and a stored choice opens nothing.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;
let projectId;

const VIEW = { width: 1512, height: 982 };
const NEAR = 0.6;

before(async () => {
  fx = await launch();
  projectId = await fx.makeProject("Garden Notes");
});
after(async () => { if (fx) await fx.stop(); });

const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= NEAR, `${msg}: ${a} vs ${b}`);

async function settled(page) {
  await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
  await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
  await page.waitForFunction(() => document.getAnimations()
    .every(a => !(a instanceof CSSTransition) || a.playState === "finished"));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const look = page => page.evaluate(() => {
  const $ = s => document.querySelector(s);
  const R = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
  const glyph = sel => R($(sel).querySelector("svg"));
  return {
    absent: ["#toolbar", "#tool-notes", "#railpanel", "#railnotes"].filter(s => $(s)),
    toolButtons: document.querySelectorAll(".tool").length,
    railTool: typeof window.railTool,
    rail: document.documentElement.dataset.rail || "",
    wide: innerWidth, tall: innerHeight,
    frame: R($("#appframe")), bar: R($(".bar")),
    house: glyph("#homeico"), gear: glyph("#setbtn"),
    pen: R($("#editbtn")), gearBox: R($("#setbtn")),
  };
});

function expectHidden(g, label) {
  assert.deepEqual(g.absent, [], label + ": no toolbar, notes button or drawer in the page");
  assert.equal(g.toolButtons, 0, label + ": no tool buttons");
  assert.equal(g.railTool, "undefined", label + ": no railTool entry point");
  assert.equal(g.rail, "", label + ": no drawer state on the page");
  near(g.frame.x, g.wide - g.frame.right, label + ": the right margin equals the left");
  near(g.frame.x, g.bar.y, label + ": the margin equals the top");
  near(g.frame.x, g.tall - g.frame.bottom, label + ": the margin equals the bottom");
  near(g.wide - g.gear.right, g.house.x, label + ": the gear mirrors the house");
  near(g.gear.y, g.house.y, label + ": the gear and the house share a top inset");
  near(g.pen.x + g.pen.w + 14, g.gearBox.x, label + ": the pen sits 14px left of the gear");
}

test("the page has no toolbar or Notes drawer on a project tab or on the home page", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await settled(page);
    expectHidden(await look(page), "facilitator tab");
    await page.click(`#tabbar .ptab[data-owner="${projectId}"]`);
    await page.waitForFunction(o => activeOwner === o, {}, projectId);
    await settled(page);
    expectHidden(await look(page), "project tab");
    await page.click("#homeico");
    await page.waitForFunction(() => document.body.classList.contains("home"));
    await settled(page);
    expectHidden(await look(page), "home page");
  } finally { await context.close(); }
});

test("a stored toolbar choice opens nothing", async () => {
  const plain = await fx.openBoard(null, VIEW);
  let without;
  try { await settled(plain.page); without = await look(plain.page); } finally { await plain.context.close(); }
  const { context, page } = await fx.openBoard({ railtool: "notes" }, VIEW);
  try {
    await settled(page);
    const g = await look(page);
    expectHidden(g, "stored choice");
    assert.deepEqual(g.frame, without.frame, "the frame is where it is without the stored choice");
    await page.keyboard.press("Escape");
    await settled(page);
    assert.deepEqual((await look(page)).frame, without.frame, "Escape changes nothing");
  } finally { await context.close(); }
});
