// The Mac board's top bar in the phone's glass: the house, the speaker, the plus
// and the squid as glass circles drawn as the phone's bottom row draws its
// buttons, every project's name on one glass oval with a glass seat under the
// open one that slides to the project chosen, and the workspace on a glass pane
// that keeps the old outline's rectangle with clear paper between it and the
// bar. Driven on a throwaway board at 1512 by 982; nothing reads the real board.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

const VIEW = { width: 1512, height: 982 };
const NEAR = 0.6;
let fx;
let garden;
let orchard;
let ledger;

before(async () => {
  fx = await launch();
  garden = await fx.makeProject("Garden Notes");
  orchard = await fx.makeProject("Orchard Plans");
  ledger = await fx.makeProject("Ledger");
});
after(async () => { if (fx) await fx.stop(); });

const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= NEAR, `${msg}: ${a} vs ${b}`);
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
// the seat's own motion has finished: a finished transition is no longer
// listed. the seat is placed at the start of the frame after a repaint, so a
// frame is let by first
const seatStill = async page => {
  await frame(page);
  await page.waitForFunction(() =>
    document.querySelector("#tabbar .tabseat").getAnimations({ subtree: true }).length === 0);
};

// where the seat's two ends are drawn, and the open name it should sit under
const seat = page => page.evaluate(() => {
  const [l, r] = [...document.querySelectorAll("#tabbar .seathalf > i")].map(i => i.getBoundingClientRect());
  const on = document.querySelector("#tabbar .ptab.on");
  const o = on && on.getBoundingClientRect();
  return { left: l.left, right: r.right, top: l.top, bottom: l.bottom,
    opacity: Number(getComputedStyle(document.querySelector("#tabbar .tabseat")).opacity),
    on: o && { left: o.left, right: o.right, top: o.top, bottom: o.bottom, owner: on.dataset.owner } };
});
function onName(s, label) {
  assert.ok(s.on, label + ": no name is open");
  near(s.left, s.on.left, label + ": the seat's left end is not the open name's");
  near(s.right, s.on.right, label + ": the seat's right end is not the open name's");
  near(s.top, s.on.top, label + ": the seat's top is not the name's");
  near(s.bottom, s.on.bottom, label + ": the seat's foot is not the name's");
  assert.equal(s.opacity, 1, label + ": the seat is not shown");
}
async function show(page, owner) {
  await page.click(`#tabbar .ptab[data-owner="${owner}"]`);
  await page.waitForFunction(o => activeOwner === o, {}, owner);
}

test("the house, the speaker, the plus and the squid are glass circles drawn as the phone's row draws them", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    const pieces = await page.evaluate(() => ["#homeico", "#chimebtn", "#tabbar .ptabplus", "#setbtn"].map(sel => {
      const el = document.querySelector(sel), cs = getComputedStyle(el), box = el.getBoundingClientRect();
      const mark = el.querySelector("svg, .squidmark").getBoundingClientRect();
      return { sel, glass: el.classList.contains("qn-glass"), w: box.width, h: box.height, top: box.top,
        mid: [box.left + box.width / 2, box.top + box.height / 2], markMid: [mark.left + mark.width / 2, mark.top + mark.height / 2],
        radius: cs.borderRadius, face: cs.backgroundColor, edge: cs.boxShadow };
    }));
    for (const p of pieces) {
      assert.equal(p.glass, true, p.sel + " is not on the glass");
      assert.equal(p.w, 32, p.sel + " is not 32px across");
      assert.equal(p.h, 32, p.sel + " is not 32px tall");
      assert.equal(p.radius, "50%", p.sel + " is not a circle");
      assert.equal(p.face, "rgba(255, 255, 255, 0.77)", p.sel + " does not wear the glass's face");
      assert.equal(p.edge, pieces[0].edge, p.sel + " is not drawn with the house's edge");
      near(p.markMid[0], p.mid[0], p.sel + ": the mark is not centred across");
      near(p.markMid[1], p.mid[1], p.sel + ": the mark is not centred down");
      near(p.top, 6, p.sel + ": the circle does not stand at the top of the bar");
    }
    // the phone row's edge: the grey ring is the top rim, with no white line or
    // dark band of the glass's own drawn over it, and the soft shadow under it
    const edge = pieces[0].edge;
    assert.match(edge, /rgb\(199, 199, 204\) 0px 0px 0px 1px inset/, "the grey ring is not drawn");
    assert.doesNotMatch(edge, /0px 1px 0px 0px inset/, "the glass's white top line is still drawn");
    assert.doesNotMatch(edge, /0px 2px 0px 0px inset/, "the glass's dark top band is still drawn");
    assert.match(edge, /0px 8px 20px 0px/, "the soft shadow is not drawn");
  } finally { await context.close(); }
});

test("a press on a circle grows it and whitens its face, and lets go after the press", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    const box = await page.$eval("#chimebtn", el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.waitForFunction(() => document.getElementById("chimebtn").classList.contains("pressed"));
    await frame(page);
    await page.waitForFunction(() => document.getElementById("chimebtn").getAnimations().length === 0);
    const held = await page.$eval("#chimebtn", el => ({ t: getComputedStyle(el).transform, tint: getComputedStyle(el).getPropertyValue("--qn-tint").trim() }));
    assert.equal(held.t, "matrix(1.06, 0, 0, 1.06, 0, 0)", "the pressed circle did not grow by 6%");
    assert.equal(Number(held.tint), 0.95, "the pressed circle's face did not whiten");
    await page.mouse.move(box.x, box.y + 200);
    await page.mouse.up();
    await page.waitForFunction(() => !document.getElementById("chimebtn").classList.contains("pressed"));
  } finally { await context.close(); }
});

test("every name sits on one oval and the seat slides to the project chosen by transforms alone", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    const oval = await page.evaluate(() => {
      const o = document.querySelector("#tabbar .taboval"), r = o.getBoundingClientRect();
      return { glass: o.classList.contains("qn-glass"), h: r.height, radius: getComputedStyle(o).borderRadius,
        names: [...o.querySelectorAll(".ptab")].map(t => t.dataset.owner), order: rowsOf(lastState),
        plusAfter: o.nextElementSibling && o.nextElementSibling.classList.contains("ptabplus") };
    });
    assert.equal(oval.glass, true, "the oval is not on the glass");
    assert.equal(oval.h, 32, "the oval is not the circles' height");
    assert.equal(oval.radius, "16px", "the oval's ends are not round");
    assert.deepEqual(oval.names, oval.order, "the oval does not hold the board's names in its order");
    assert.equal(oval.plusAfter, true, "the plus is not its own circle right after the oval");

    await show(page, garden);
    await seatStill(page);
    onName(await seat(page), "on the first project");

    // the slide: only transforms move, and the halves keep their length
    await page.click(`#tabbar .ptab[data-owner="${ledger}"]`);
    await frame(page);
    const moving = await page.evaluate(() => {
      const s = document.querySelector("#tabbar .tabseat");
      return { props: s.getAnimations({ subtree: true }).map(a => a.transitionProperty),
        widths: [...s.querySelectorAll(".seathalf > i")].map(i => getComputedStyle(i).width),
        max: s.style.getPropertyValue("--smax") };
    });
    assert.ok(moving.props.length > 0, "the seat did not move");
    assert.deepEqual([...new Set(moving.props)], ["transform"], "something other than a transform moved: " + moving.props);
    assert.deepEqual(moving.widths, [moving.max, moving.max], "the seat's halves changed their length");
    await seatStill(page);
    const landed = await seat(page);
    assert.equal(landed.on.owner, ledger);
    onName(landed, "after the slide");

    // a repaint of the bar with nothing changed sets nothing moving
    await page.evaluate(() => renderTabs(lastState));
    await frame(page);
    assert.equal(await page.evaluate(() => document.querySelector("#tabbar .tabseat").getAnimations({ subtree: true }).length), 0,
      "a repaint replayed the slide");
  } finally { await context.close(); }
});

test("home fades the seat out where it stands and the next project gets it back in place", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await show(page, orchard);
    await seatStill(page);
    await page.click("#homeico");
    await page.waitForFunction(() => document.body.classList.contains("home"));
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#tabbar .tabseat")).opacity) === 0);
    assert.equal(await page.$eval("#homeico", el => getComputedStyle(el).color),
      await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--ink").trim()).then(hex => {
        const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16 & 255}, ${n >> 8 & 255}, ${n & 255})`; }),
      "the house is not in the ink while home is up");
    await show(page, garden);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("#tabbar .tabseat")).opacity) === 1);
    await seatStill(page);
    onName(await seat(page), "back from home");
  } finally { await context.close(); }
});

test("a name closed before the open one leaves the oval and the seat stays on its own name", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    await show(page, ledger);
    await seatStill(page);
    await page.evaluate(o => closeTab(o), garden);
    await page.waitForFunction(o => getComputedStyle(document.querySelector(`#tabbar .ptab[data-owner="${o}"]`)).display === "none", {}, garden);
    await frame(page);
    await seatStill(page);
    onName(await seat(page), "after a name before it closed");
    await page.evaluate(o => reopenTab(o), garden);
    await page.waitForFunction(o => getComputedStyle(document.querySelector(`#tabbar .ptab[data-owner="${o}"]`)).display !== "none", {}, garden);
  } finally { await context.close(); }
});

test("the pane keeps the outline's rectangle, with clear paper under the bar and nothing joining them", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    const g = await page.evaluate(() => {
      const f = document.getElementById("appframe"), cs = getComputedStyle(f), r = f.getBoundingClientRect();
      const pieces = [...document.querySelectorAll(".bar > *")].filter(el => el.getBoundingClientRect().width);
      const bar = getComputedStyle(document.querySelector(".bar"));
      const on = document.querySelector("#tabbar .ptab.on");
      const probe = document.createElement("div");
      probe.style.width = "var(--edge-drawn)";
      document.body.appendChild(probe);
      const drawn = probe.getBoundingClientRect().width;
      probe.remove();
      return { r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, w: innerWidth, h: innerHeight, drawn,
        glass: f.classList.contains("qn-glass"), z: cs.zIndex, pointer: cs.pointerEvents, borderColor: cs.borderTopColor,
        radius: cs.borderRadius, filter: cs.backdropFilter, face: cs.backgroundColor,
        foot: Math.max(...pieces.map(el => el.getBoundingClientRect().bottom)),
        barFace: bar.backgroundColor, barFilter: bar.backdropFilter, barLine: getComputedStyle(document.querySelector(".bar"), "::before").content,
        notch: on ? [getComputedStyle(on, "::before").content, getComputedStyle(on, "::after").content, getComputedStyle(on).borderTopStyle] : null };
    });
    // the old outline's rectangle: --app-inset in from three sides, its top on
    // the bar's bottom row
    near(g.r.left, 6, "the pane's left edge moved");
    near(g.w - g.r.right, 6, "the pane's right edge moved");
    near(g.h - g.r.bottom, 6, "the pane's foot moved");
    near(g.r.top, 6 + 41 - 1 - g.drawn, "the pane's top edge moved");
    assert.equal(g.glass, true, "the pane is not the glass");
    assert.equal(g.radius, "12px");
    assert.equal(g.borderColor, "rgba(0, 0, 0, 0)", "the pane still draws the outline's line");
    assert.equal(g.filter, "none", "the pane blurs the whole window");
    assert.equal(g.face, "rgba(255, 255, 255, 0.35)");
    assert.equal(g.z, "-1", "the pane is not under the canvas");
    assert.equal(g.pointer, "none", "the pane takes the pointer");
    assert.ok(g.r.top - g.foot >= 6, `less than 6px of paper under the bar's pieces: ${g.r.top - g.foot}`);
    // nothing joins the bar to the pane
    assert.equal(g.barFace, "rgba(0, 0, 0, 0)", "the bar still has a face");
    assert.equal(g.barFilter, "none", "the bar still blurs");
    assert.equal(g.barLine, "none", "the bar still draws the outline's top line");
    assert.deepEqual(g.notch, ["none", "none", "none"], "the open name still opens into the pane");
  } finally { await context.close(); }
});

test("the ticket list's names and the file navigator's tabs keep their own look", async () => {
  const { context, page } = await fx.openBoard(null, VIEW);
  try {
    const tvb = await page.evaluate(() => {
      const el = document.querySelector("#tikhead .tvb"), cs = getComputedStyle(el);
      return { radius: cs.borderRadius, size: cs.fontSize, padding: cs.padding, display: cs.display,
        on: getComputedStyle(document.querySelector("#tikhead .tvb.on")).backgroundColor };
    });
    assert.equal(tvb.radius, "7px");
    assert.equal(tvb.size, "14px");
    assert.equal(tvb.padding, "6px 0px 5px");
    assert.notEqual(tvb.display, "flex", "the bar's names' layout reached the ticket list");
    assert.equal(tvb.on, "rgba(0, 0, 0, 0)");
  } finally { await context.close(); }
});
