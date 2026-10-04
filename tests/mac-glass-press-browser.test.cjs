// Ordinary short clicks, not long holds: measure actual painted growth and
// settling on the full board, and keep each button's normal action intact.
// Use the repository fixture's browser policy adapter for background CDP runs.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { launch } = require("./resp-harness.cjs");
const SHOTS = process.env.GLASS_PRESS_SHOTS || "";
let fx;
before(async () => { fx = await launch(); });
after(async () => { if (fx) await fx.stop(); });

for (const [name, selector, action] of [
  ["house", "#homeico", () => homeOpen],
  ["speaker", "#chimebtn", () => document.getElementById("chimebtn").getAttribute("aria-pressed") === "false"],
  ["plus", "#tabbar .ptabplus", () => document.body.classList.contains("choosing")],
  ["squid", "#setbtn", () => document.body.classList.contains("setopen")],
]) {
  test("a short click grows and settles the Mac " + name + " while preserving its action", async () => {
    const { context, page } = await fx.openBoard({ chimemuted: "0" }, { width: 1512, height: 982 });
    try {
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      const point = await page.$eval(selector, el => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.evaluate(sel => {
        const el = document.querySelector(sel);
        window.__pressFrames = [];
        window.__pressClicks = 0;
        el.addEventListener("click", () => window.__pressClicks++);
        el.addEventListener("pointerdown", () => {
          const start = performance.now(), cs = getComputedStyle(el);
          window.__pressTransition = {
            properties: cs.transitionProperty.split(", "),
            durations: cs.transitionDuration.split(", "),
            curves: cs.transitionTimingFunction.match(/cubic-bezier\([^)]*\)|[a-z-]+/g),
          };
          const sample = now => {
            const cs = getComputedStyle(el);
            const scale = cs.transform === "none" ? 1 : new DOMMatrixReadOnly(cs.transform).a;
            window.__pressFrames.push({ ms: now - start, scale, pressed: el.classList.contains("pressed") });
            if (now - start < 700) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
      }, selector);
      await page.mouse.click(point.x, point.y, { delay: 20 });
      await page.waitForFunction(() => window.__pressFrames.at(-1)?.ms >= 700);
      const result = await page.evaluate(sel => ({
        transition: window.__pressTransition, frames: window.__pressFrames,
        clicks: window.__pressClicks,
        returnDuration: getComputedStyle(document.querySelector(sel)).transitionDuration,
      }), selector);
      for (const property of ["transform", "--qn-tint", "--qn-edge"]) {
        const i = result.transition.properties.indexOf(property);
        assert.ok(i >= 0, property + " has no transition");
        assert.equal(result.transition.durations[i], "0.3s", property + " used the idle duration on press");
        assert.equal(result.transition.curves[i], "cubic-bezier(0.22, 0.7, 0.3, 1)");
      }
      assert.ok(result.frames.some(f => f.pressed && f.scale > 1.03),
        "the short click never visibly grew before release: " + JSON.stringify(result.frames));
      assert.ok(Math.abs(result.frames.at(-1).scale - 1) < 0.001, "the button did not settle back");
      assert.equal(result.frames.at(-1).pressed, false);
      assert.equal(result.clicks, 1, "feedback duplicated or swallowed the click");
      assert.equal(await page.evaluate(action), true, "the button's original action did not happen");
      assert.ok(result.returnDuration.includes("0.5s"));
      if (SHOTS) {
        await mkdir(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, name + "-after-short-click.png") });
      }
    } finally { await context.close(); }
  });
}
