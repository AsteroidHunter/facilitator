// A restored draft past the Mac row's cap shows its caret when the keys put
// the caret in the row.
//
// A reload gives a card its draft back with the caret at the end of the words
// (draftRestore), in a row that opens scrolled to its head. Enter on the card,
// Tab and the place keys focus the row from script, and a focus moves no
// scroll inside the field, so the caret stood below the row's view and the
// first thing the reader saw of it was the words jumping on the first key. The
// phone's row brings the caret's line into view on focus (revealCaret); now the
// Mac's does too, a frame later, once a click has put the caret where it fell.
//
// Played in a background tab of a browser that is already running
// (box-typing-fixture.cjs), on both faces of the row.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

const ROW = "article.box.sel textarea:not(.twin)";
const DRAFT = ["start", ...Array.from({ length: 14 }, (_, i) => "line " + i)].join("\n");
let plain, formatted;
before(async () => {
  plain = await F.start({ formatted: false });
  formatted = await F.start({ formatted: true });
});
after(async () => {
  if (plain) await plain.stop();
  if (formatted) await formatted.stop();
});

function view(page) {
  return page.evaluate(sel => {
    const ta = document.querySelector(sel), f = ComposeFormat.fieldOf(ta);
    const s = f && f.view ? f.view.scrollDOM : ta;
    return { scrollTop: s.scrollTop, foot: s.scrollHeight - s.clientHeight - s.scrollTop,
      capped: s.scrollHeight > s.clientHeight + 1, start: ta.selectionStart, len: ta.value.length,
      focused: ComposeFormat.focused(ta) };
  }, ROW);
}

// a card with a capped draft kept, opened afresh as a reload opens it
async function restored(fx) {
  const id = await fx.card("Restored " + Date.now().toString(36));
  const { page, problems } = await fx.open("/", F.DESKTOP);
  // the store is written once the page has settled: an editor that puts itself
  // on later says its row changed, and the empty row would be kept over it
  await F.pickDesktop(page, id);
  if (fx === formatted) await F.editorOn(page);
  await page.evaluate(([cardId, text]) => {
    localStorage.setItem("composedrafts", JSON.stringify({ [cardId]: { text, files: [] } }));
  }, [id, DRAFT]);
  await fx.reload(page);
  await F.pickDesktop(page, id);
  if (fx === formatted) await F.editorOn(page);
  await settle(300);
  const v = await view(page);
  assert.ok(v.capped && v.scrollTop < 1 && !v.focused, "the restored draft opened at its head: " + JSON.stringify(v));
  return { page, problems, id };
}

for (const [label, pick] of [["plain", () => plain], ["formatted", () => formatted]]) {
  test(`${label}: Enter on the card shows the caret at the end of a restored draft`, async () => {
    const fx = pick();
    const { page, problems } = await restored(fx);
    try {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press("Enter");
      await settle(300);
      const v = await view(page);
      assert.ok(v.focused && v.start === v.len, "the caret is at the end: " + JSON.stringify(v));
      assert.ok(v.foot <= 1, "the caret's line was left out of the row's view: " + JSON.stringify(v));
      assert.deepEqual(problems, []);
    } finally { await fx.close(page); }
  });

  test(`${label}: a click into a restored draft keeps the caret where it fell`, async () => {
    const fx = pick();
    const { page, problems } = await restored(fx);
    try {
      // the second line from the top of the row, as it opened
      const at = await page.evaluate(sel => {
        const ta = document.querySelector(sel), f = ComposeFormat.fieldOf(ta);
        const r = (f && f.view ? f.view.scrollDOM : ta).getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(ta).lineHeight), pt = parseFloat(getComputedStyle(ta).paddingTop);
        return { x: r.left + 20, y: r.top + pt + lh * 1.5 };
      }, ROW);
      await page.mouse.click(at.x, at.y);
      await settle(300);
      const v = await view(page);
      const line = await page.evaluate(sel => {
        const ta = document.querySelector(sel);
        return ta.value.slice(0, ta.selectionStart).split("\n").length;
      }, ROW);
      assert.ok(v.focused, "the click focused the row");
      assert.equal(line, 2, "the caret is on the line clicked: " + JSON.stringify(v));
      assert.ok(v.scrollTop < 1, "the row moved under the click: " + JSON.stringify(v));
      assert.deepEqual(problems, []);
    } finally { await fx.close(page); }
  });
}
