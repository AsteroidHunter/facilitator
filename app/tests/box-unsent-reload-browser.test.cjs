// A message the Mac board could not get to the board is still there after a
// reload.
//
// The Mac board's sends live in the page alone: the words leave the row at the
// press, stand in the sent panel under a fail mark when they do not get
// through, and the cross gives them back. The row's saved draft was cleared at
// the press, so a reload or an app restart while the board was unreachable
// lost the message for good: not in the row, not in the panel, not on the
// board. Now the draft keeps every send the board has not confirmed until it
// has, and a reload puts those words back in the row, ahead of anything typed
// after them. A send that lands keeps nothing.
//
// Played in a background tab of a browser that is already running
// (box-typing-fixture.cjs); the failure is a send the tab is not let make.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

let fx;
before(async () => { fx = await F.start({ formatted: false }); });
after(async () => { if (fx) await fx.stop(); });

async function blockSends(page) {
  await page.setRequestInterception(true);
  const stop = req => {
    if (new URL(req.url()).pathname === "/send") req.abort("connectionrefused"); else req.continue();
  };
  page.on("request", stop);
  return async () => { page.off("request", stop); await page.setRequestInterception(false); };
}

async function backOn(page, id) {
  await fx.reload(page);
  await F.until(page, cardId => typeof els !== "undefined" && !!els[cardId], "the card back", 10000, id);
  if ((await page.evaluate(() => selectedId)) !== id) await F.pickDesktop(page, id);
  await settle(400);
}

test("a send that did not get through comes back in the row after a reload", async () => {
  const id = await fx.card("Unsent " + Date.now().toString(36));
  const { page, problems } = await fx.open("/", F.DESKTOP);
  try {
    await F.pickDesktop(page, id);
    await F.focusRow(page);
    const unblock = await blockSends(page);
    await page.keyboard.type("the board was away");
    await page.keyboard.press("Enter");
    await F.until(page, cardId => (els[cardId].sentHeld || []).length === 1, "the send held under its mark", 15000, id);
    let row = await F.row(page);
    assert.equal(row.value, "", "the words left the row at the press");
    // and something typed after it is kept with it
    await page.keyboard.type("and a second thought");
    await unblock();
    await backOn(page, id);
    row = await F.row(page);
    assert.deepEqual(await fx.sentTexts(id), [], "nothing reached the board");
    assert.equal(row.value, "the board was away\n\nand a second thought", "the unsent words came back in the row");
    assert.ok(row.sendShown, "the row can send them");
    // sent now, it lands, and a reload brings nothing back
    await F.focusRow(page);
    await page.keyboard.press("Enter");
    await F.until(page, cardId => !els[cardId].sendsOut, "the send landed", 15000, id);
    await settle(300);
    assert.deepEqual(await fx.sentTexts(id), ["the board was away\n\nand a second thought"]);
    await backOn(page, id);
    row = await F.row(page);
    assert.equal(row.value, "", "a send that landed came back in the row");
    assert.equal(row.draft, null);
    assert.deepEqual(problems.filter(p => !/\/send\?/.test(p)), []);
  } finally { await fx.close(page); }
});

test("a held send the cross gives back is kept once, in the row", async () => {
  const id = await fx.card("Crossed " + Date.now().toString(36));
  const { page } = await fx.open("/", F.DESKTOP);
  try {
    await F.pickDesktop(page, id);
    await F.focusRow(page);
    const unblock = await blockSends(page);
    await page.keyboard.type("give it back");
    await page.keyboard.press("Enter");
    await F.until(page, cardId => (els[cardId].sentHeld || []).length === 1, "the send held under its mark", 15000, id);
    await unblock();
    // the cross asks the board first; the board has no record of it
    await page.evaluate(cardId => { const el = els[cardId]; sentCross(el, el.sentHeld[0]); }, id);
    await F.until(page, cardId => els[cardId].ta.value === "give it back", "the words back in the row", 10000, id);
    await backOn(page, id);
    const row = await F.row(page);
    assert.equal(row.value, "give it back", "the words came back once");
  } finally { await fx.close(page); }
});
