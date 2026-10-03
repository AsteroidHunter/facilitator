// The right toolbar: icon buttons in the margin right of the workspace frame.
// Clicking one moves the frame's inner right edge inward to reveal that tool's
// panel between the frame and the toolbar; clicking again, or Escape from inside
// the panel, moves it back. The open tool is remembered across reloads.
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

// Hidden for v0: the toolbar and its Notes drawer are not in the page. The suite is kept
// whole, and skipped as a suite so its fixtures never start.
describe("the right toolbar", { skip: "feature hidden for v0" }, () => {
  let fx;
  let projectId;

  const VIEW = { width: 1512, height: 982 };
  const NEAR = 0.6;

  before(async () => {
    fx = await launch();
    projectId = await fx.makeProject("Garden Notes");
  });
  after(async () => { if (fx) await fx.stop(); });

  const raf2 = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  // wait for the running transitions to finish, then let the refit land
  async function settled(page) {
    await page.waitForFunction(() => document.getAnimations()
      .every(a => !(a instanceof CSSTransition) || a.playState === "finished"));
    await raf2(page);
  }

  const geo = page => page.evaluate(() => {
    const $ = s => document.querySelector(s);
    const R = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const root = getComputedStyle(document.documentElement);
    const scale = Number(getComputedStyle($("#stage")).transform.replace(/^matrix\(/, "").split(",")[0]);
    return {
      rail: document.documentElement.dataset.rail || "",
      frame: R($("#appframe")), panel: R($("#railpanel")), toolbar: R($("#toolbar")), button: R($("#tool-notes")),
      panelW: parseFloat(root.getPropertyValue("--panel-w")),
      inset: parseFloat(root.getPropertyValue("--app-inset")),
      bar: { house: R($("#homeico")), tabs: R($("#tabbar")), pen: R($("#editbtn")), gear: R($("#setbtn")) },
      scale, main: R($("main")),
      pressed: $("#tool-notes").getAttribute("aria-expanded"),
      on: $("#tool-notes").classList.contains("on"),
      stored: localStorage.getItem("railtool"),
    };
  });

  const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= NEAR, `${msg}: ${a} vs ${b}`);

  async function ready(page) {
    await page.waitForFunction(() => document.body.classList.contains("layout-ready") && typeof lastState !== "undefined" && lastState);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("stage")).visibility === "visible");
    await settled(page);
  }

  test("the toolbar sits right of the frame on every tab and on the home page", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      const check = async label => {
        const g = await geo(page);
        const shown = await page.evaluate(() => {
          const t = document.getElementById("toolbar"), b = document.getElementById("tool-notes");
          const r = b.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { display: getComputedStyle(t).display, visibility: getComputedStyle(t).visibility,
            reachable: !!(top && top.closest("#tool-notes")), text: t.textContent.trim(),
            title: b.getAttribute("title"), label: b.getAttribute("aria-label"), buttons: t.querySelectorAll("button").length };
        });
        assert.notEqual(shown.display, "none", label + ": the toolbar is shown");
        assert.equal(shown.visibility, "visible", label);
        assert.equal(shown.reachable, true, label + ": nothing covers the button");
        assert.ok(g.button.x >= g.frame.right, `${label}: the button sits outside the frame`);
        assert.ok(g.button.right <= VIEW.width, `${label}: the button is inside the window`);
        assert.ok(g.button.y > g.bar.gear.bottom, `${label}: the button is under the top bar's items`);
        near(g.bar.gear.x + g.bar.gear.w / 2, g.button.x + g.button.w / 2, `${label}: the gear is centred over the toolbar's icon column`);
        near(g.bar.pen.x + g.bar.pen.w + 14, g.bar.gear.x, `${label}: the pen sits 14px left of the gear`);
        assert.equal(shown.buttons, 1, label + ": the notes button is the only one");
        assert.equal(shown.text, "", label + ": the toolbar carries no text");
        assert.equal(shown.title, null, label + ": no tooltip");
        return g;
      };
      const first = await check("facilitator tab");
      await page.click(`#tabbar .ptab[data-owner="${projectId}"]`);
      await page.waitForFunction(o => activeOwner === o, {}, projectId);
      await settled(page);
      const project = await check("project tab");
      await page.click("#homeico");
      await page.waitForFunction(() => document.body.classList.contains("home"));
      await settled(page);
      const home = await check("home page");
      for (const g of [project, home]) {
        near(g.button.x, first.button.x, "the button stays put from tab to tab");
        near(g.button.y, first.button.y, "the button stays put from tab to tab");
        near(g.frame.right, first.frame.right, "the frame's right edge is the same on every tab");
      }
    } finally { await context.close(); }
  });

  test("the button matches the pen and gear in size and stroke", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      const look = await page.evaluate(() => {
        const one = sel => {
          const b = document.querySelector(sel), s = b.querySelector("svg"), cs = getComputedStyle(b);
          return { w: s.getAttribute("width"), h: s.getAttribute("height"), sw: s.getAttribute("stroke-width"),
            cap: s.getAttribute("stroke-linecap"), join: s.getAttribute("stroke-linejoin"), fill: s.getAttribute("fill"),
            color: cs.color, padding: cs.padding, box: b.getBoundingClientRect().width };
        };
        return { pen: one("#editbtn"), gear: one("#setbtn"), notes: one("#tool-notes") };
      });
      assert.deepEqual(look.notes, look.gear, "the notes button and the gear share size, stroke, colour and padding");
      assert.deepEqual(look.notes, look.pen, "the notes button and the pen share size, stroke, colour and padding");
    } finally { await context.close(); }
  });

  test("opening narrows the workspace by the panel and closing gives it back", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await ready(page);
      const closed = await geo(page);
      assert.equal(closed.rail, "");
      near(closed.panel.w, 0, "no panel width while closed");
      assert.equal(closed.pressed, "false");

      await page.click("#tool-notes");
      await settled(page);
      const open = await geo(page);
      assert.equal(open.rail, "notes");
      assert.equal(open.pressed, "true");
      assert.equal(open.on, true, "the open tool's button is marked");
      assert.equal(open.panelW, 400, "the panel is phone width by default");
      near(open.panel.w, open.panelW, "the panel is as wide as its variable says");
      near(closed.frame.right - open.frame.right, open.panelW + open.inset, "the frame's right edge moves in by the panel and one gap");
      near(open.panel.x - open.frame.right, open.inset, "the panel sits one gap right of the frame");
      near(open.panel.right, closed.frame.right, "the panel ends where the closed frame ended");
      near(open.panel.y, open.frame.y, "the panel starts at the frame's top");
      near(open.panel.h, open.frame.h, "the panel is as tall as the workspace");
      near(open.toolbar.x, closed.toolbar.x, "the toolbar does not move");
      near(open.button.y, closed.button.y, "the button does not move");
      for (const k of ["house", "tabs", "pen", "gear"]) {
        near(open.bar[k].x, closed.bar[k].x, "top bar " + k + " x");
        near(open.bar[k].y, closed.bar[k].y, "top bar " + k + " y");
      }
      assert.ok(open.main.right <= open.frame.right, "the conversation stays inside the narrower frame");

      await page.click("#tool-notes");
      await settled(page);
      const back = await geo(page);
      assert.equal(back.rail, "");
      assert.equal(back.pressed, "false");
      near(back.frame.right, closed.frame.right, "the frame returns to its closed edge");
      near(back.panel.w, 0, "the panel closes to nothing");
      near(back.scale, closed.scale, "the board returns to its closed fit");
    } finally { await context.close(); }
  });

  test("the board refits into the narrower workspace in a smaller window", async () => {
    const { context, page } = await fx.openBoard(null, { width: 1200, height: 800 });
    try {
      await ready(page);
      const closed = await geo(page);
      await page.click("#tool-notes");
      await settled(page);
      const open = await geo(page);
      near(closed.frame.right - open.frame.right, open.panelW + open.inset, "the frame narrows by the panel and one gap");
      assert.ok(open.scale < closed.scale, `the board scales down to fit (${open.scale} vs ${closed.scale})`);
      assert.ok(open.main.right <= open.frame.right, "the conversation stays inside the narrower frame");
      await page.click("#tool-notes");
      await settled(page);
      const back = await geo(page);
      near(back.frame.right, closed.frame.right, "the frame returns");
      near(back.scale, closed.scale, "the fit returns");
    } finally { await context.close(); }
  });

  test("the move uses the app's panel timing and eases the frame edge", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await ready(page);
      const t = await page.evaluate(() => {
        const cs = getComputedStyle(document.documentElement);
        const probe = document.createElement("div");
        probe.style.transitionTimingFunction = "var(--gentle)";
        document.body.append(probe);
        const gentle = getComputedStyle(probe).transitionTimingFunction;
        probe.remove();
        return { prop: cs.transitionProperty, dur: cs.transitionDuration, fn: cs.transitionTimingFunction, gentle };
      });
      assert.equal(t.prop, "--rail-x");
      assert.equal(t.dur, "0.33s");
      assert.equal(t.fn, t.gentle, "the shared gentle curve");

      // mid-move the frame edge is strictly between its closed and open places
      const closed = await geo(page);
      const mid = await page.evaluate(() => new Promise(resolve => {
        document.getElementById("tool-notes").click();
        setTimeout(() => resolve(document.getElementById("appframe").getBoundingClientRect().right), 150);
      }));
      await settled(page);
      const open = await geo(page);
      assert.ok(mid < closed.frame.right - 2 && mid > open.frame.right + 2,
        `mid-move edge ${mid} is between ${open.frame.right} and ${closed.frame.right}`);
    } finally { await context.close(); }
  });

  test("the open panel and the closed state both survive a reload", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await ready(page);
      const closed = await geo(page);
      await page.click("#tool-notes");
      await settled(page);
      assert.equal((await geo(page)).stored, "notes");

      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      const open = await geo(page);
      assert.equal(open.rail, "notes", "the panel is open after the reload");
      assert.equal(open.on, true);
      assert.equal(open.pressed, "true");
      near(open.panel.w, open.panelW, "the panel has its width");
      near(closed.frame.right - open.frame.right, open.panelW + open.inset, "the workspace is narrowed");

      await page.click("#tool-notes");
      await settled(page);
      assert.equal((await geo(page)).stored, null, "closing forgets the tool");
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      const shut = await geo(page);
      assert.equal(shut.rail, "");
      near(shut.frame.right, closed.frame.right, "the workspace is full width after the reload");
      near(shut.panel.w, 0, "no panel after the reload");
    } finally { await context.close(); }
  });

  test("Escape from inside the panel closes it, and Escape elsewhere leaves it", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await ready(page);
      const closed = await geo(page);
      await page.click("#tool-notes");
      await settled(page);
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "railnotes",
        "opening puts focus in the panel's room");

      await page.keyboard.press("Escape");
      await settled(page);
      const shut = await geo(page);
      assert.equal(shut.rail, "", "Escape closes the panel");
      near(shut.frame.right, closed.frame.right, "the frame returns");
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "tool-notes",
        "focus goes back to the button");

      // focus outside the panel and toolbar: Escape is not the toolbar's key
      await page.evaluate(() => window.railTool.open("notes"));
      await settled(page);
      await page.evaluate(() => { document.activeElement.blur(); });
      await page.keyboard.press("Escape");
      await settled(page);
      assert.equal((await geo(page)).rail, "notes", "Escape with focus elsewhere leaves the panel open");
    } finally { await context.close(); }
  });

  test("the panel is an empty room with a hook to open it from code", async () => {
    const { context, page } = await fx.openBoard(null, VIEW);
    try {
      await ready(page);
      const info = await page.evaluate(() => {
        const room = document.getElementById("railnotes");
        return { inPanel: room.parentElement.id, tool: room.dataset.tool, children: room.children.length,
          text: room.textContent.trim(), hidden: room.hidden, glass: document.getElementById("railpanel").classList.contains("qn-glass") };
      });
      assert.equal(info.inPanel, "railpanel");
      assert.equal(info.tool, "notes");
      assert.equal(info.children, 0, "nothing is drawn inside yet");
      assert.equal(info.text, "");
      assert.equal(info.hidden, true, "the room is hidden while closed");
      assert.equal(info.glass, true, "the panel reuses the quick note glass");

      await page.evaluate(() => window.railTool.open("notes"));
      await settled(page);
      let g = await geo(page);
      assert.equal(g.rail, "notes");
      assert.equal(await page.evaluate(() => window.railTool.current), "notes");
      assert.equal(await page.evaluate(() => document.getElementById("railnotes").hidden), false);
      near(g.panel.w, g.panelW, "opened from code");

      await page.evaluate(() => window.railTool.toggle("notes"));
      await settled(page);
      g = await geo(page);
      assert.equal(g.rail, "", "toggle closes an open tool");
      assert.equal(await page.evaluate(() => window.railTool.current), "");

      await page.evaluate(() => window.railTool.open("notes"));
      await page.evaluate(() => window.railTool.close());
      await settled(page);
      assert.equal((await geo(page)).rail, "", "close() closes");
    } finally { await context.close(); }
  });
});
