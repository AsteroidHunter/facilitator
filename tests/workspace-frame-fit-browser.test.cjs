// A height-bound fit must keep the lowest visible region clear of the rounded
// app frame's inner bottom. Use a populated player below the conversation to
// distinguish real frame clearance from mere viewport containment.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { launch } = require("./resp-harness.cjs");

let fx;

const ALBUM = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><rect width='120' height='120' fill='#413a49'/></svg>");

// Build the active (connected) player surface the way spotBuild does, with no
// network: the .filled class carries the box geometry and the drop shadow a
// skeleton player never has.
function fillPlayer(page, album) {
  return page.evaluate(albumUri => {
    const host = document.getElementById("magic1");
    host.textContent = "";
    host.classList.add("filled");
    host.classList.remove("empty");
    const h = (t, c, html) => { const e = document.createElement(t); if (c) e.className = c; if (html != null) e.innerHTML = html; return e; };
    const cover = h("div", "spcover");
    const art = document.createElement("img"); art.className = "spart on"; art.src = albumUri;
    cover.append(art, h("div", "spflash"));
    const wrap = h("div", "spwrap"), row = h("div", "sprow"), meta = h("div", "spmeta"), top = h("div", "sptop");
    top.append(h("div", "sptitle", "<i>Evening</i>"));
    meta.append(top, h("div", "spartist", "Example Ensemble"));
    row.append(meta);
    const ctl = h("div", "spctl");
    ctl.append(h("button", "spbtn", "&#9198;"), h("button", "spbtn play", "&#10074;&#10074;"), h("button", "spbtn", "&#9197;"));
    wrap.append(row, ctl);
    host.append(cover, wrap);
    host.dataset.ready = "1";
    fitStage();
  }, album);
}

async function geometry(page) {
  return page.evaluate(() => {
    const frame = document.getElementById("appframe");
    const fr = frame.getBoundingClientRect();
    const bB = parseFloat(getComputedStyle(frame).borderBottomWidth) || 0;
    const frameInnerBottom = fr.bottom - bB;
    const box = id => { const el = document.querySelector(id === "main" ? "main" : "#" + id); const r = el.getBoundingClientRect(); return { bottom: +r.bottom.toFixed(1) }; };
    const scale = Number(getComputedStyle(document.getElementById("stage")).transform.replace(/^matrix\(/, "").split(",")[0]);
    return {
      frameInnerBottom: +frameInnerBottom.toFixed(1),
      frameShown: getComputedStyle(frame).display !== "none" && fr.height > 1,
      player: box("magic1"), main: box("main"), ih: innerHeight, scale,
      stageLeft: document.getElementById("stage").getBoundingClientRect().left,
    };
  });
}

before(async () => { fx = await launch(); });
after(async () => { if (fx) await fx.stop(); });

test("an active player below the conversation stays inside the app frame", async () => {
  // A saved low position makes the player the lowest region in a window short
  // enough that the fit is height-bound. The player is off in the default layout,
  // so this browser has turned it on.
  const { context, page } = await fx.openBoard(
    { "magicrename.1": "1", "show.facilitator.magic1": "1",
      "pos.facilitator.magic1": JSON.stringify({ x: 90, y: 760 }) },
    { width: 1400, height: 900 });
  try {
    await fillPlayer(page, ALBUM);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const g = await geometry(page);
    assert.equal(g.frameShown, true, "the app frame should be present to fit inside");
    assert.ok(g.scale < 1, `the fit must be height-bound for this to bite, scale was ${g.scale}`);
    // the player is the lowest region, so it is what the fit binds on
    assert.ok(g.player.bottom > g.main.bottom, "the player should be the lowest region here");
    // the whole point: the player's box is inside the frame's inner bottom, with
    // real clearance. A viewport-only fit would seat the player below the frame.
    assert.ok(g.player.bottom <= g.frameInnerBottom - 4,
      `player bottom ${g.player.bottom} must clear the frame inner bottom ${g.frameInnerBottom}`);
    assert.ok(g.player.bottom < g.ih - 4, "the player must not sit on the window bottom");
    // the card, a higher region, obviously stays clear too
    assert.ok(g.main.bottom <= g.frameInnerBottom - 4, "the conversation stays inside the frame");
  } finally { await context.close(); }
});

test("the default board also fits inside the frame after a fullscreen-sized window shrinks", async () => {
  // no custom position, active player turned on: leaving a large window for a
  // shorter one (a width change drives the refit) must land every region inside
  // the frame
  const { context, page } = await fx.openBoard({ "show.facilitator.magic1": "1" },
    { width: 2400, height: 1500 });
  try {
    await fillPlayer(page, ALBUM);
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const g = await geometry(page);
    assert.equal(g.scale, 1, "already-fitting default content keeps its original scale");
    assert.equal(g.stageLeft, 0, "frame clearance must not shift a full-size board sideways");
    assert.ok(g.player.bottom <= g.frameInnerBottom - 4,
      `player bottom ${g.player.bottom} vs frame ${g.frameInnerBottom}`);
    assert.ok(g.main.bottom <= g.frameInnerBottom - 4, "the conversation stays inside the frame");
  } finally { await context.close(); }
});
