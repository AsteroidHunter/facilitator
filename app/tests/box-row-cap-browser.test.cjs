// The Mac board's typing row at its cap, written at its end.
//
// Past its cap the row scrolls inside itself. The field's own reveal of the
// caret stops at the caret's line and leaves the row's bottom padding scrolled
// out below it, so the line being written sat pressed on the card's edge, cut
// by a pixel or two, and the send square, which is seated for a row scrolled to
// its foot (seatSquare), stood a padding's height above that line: about 11px
// on the plain field and 6px on the formatted one. The phone's row already
// brings its foot along with a caret on its last line (revealCaret in m.html).
//
// Played in a background tab of a browser that is already running
// (box-typing-fixture.cjs), on both faces of the row.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

const ROW = "article.box.sel textarea:not(.twin)";
let plain, formatted;
before(async () => {
  plain = await F.start({ formatted: false });
  formatted = await F.start({ formatted: true });
});
after(async () => {
  if (plain) await plain.stop();
  if (formatted) await formatted.stop();
});

// the row's scroll, and the middle of the line holding the caret against the
// middle of the send square, read off what is drawn
function measure(page) {
  return page.evaluate(sel => {
    const box = document.querySelector("article.box.sel");
    const ta = box.querySelector(sel.replace("article.box.sel ", ""));
    const f = ComposeFormat.fieldOf(ta);
    const scroller = f && f.view ? f.view.scrollDOM : ta;
    const r = scroller.getBoundingClientRect();
    let line;
    if (f && f.view) {
      const c = f.view.coordsAtPos(f.view.state.selection.main.head);
      const lh = parseFloat(getComputedStyle(ta).lineHeight);
      const mid = (c.top + c.bottom) / 2;
      line = { top: mid - lh / 2, bottom: mid + lh / 2 };
    } else {
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight), pt = parseFloat(cs.paddingTop);
      const lines = ta.value.slice(0, ta.selectionEnd).split("\n").length;
      const top = r.top + pt + (lines - 1) * lh - ta.scrollTop;
      line = { top, bottom: top + lh };
    }
    const send = box.querySelector(".sendbtn").getBoundingClientRect();
    return {
      foot: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
      capped: scroller.scrollHeight > scroller.clientHeight + 1,
      lineBottom: line.bottom, rowBottom: r.bottom,
      seat: Math.round(((send.top + send.bottom) / 2 - (line.top + line.bottom) / 2) * 10) / 10,
    };
  }, ROW);
}

async function walk(fx) {
  const id = await fx.card("Cap " + Date.now().toString(36));
  const { page, problems } = await fx.open("/", F.DESKTOP);
  try {
    await F.pickDesktop(page, id);
    if (fx === formatted) await F.editorOn(page);
    await F.focusRow(page);
    await page.keyboard.type("first line");
    const seen = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
      await page.keyboard.type("line " + i);
      await settle(120);
      const m = await measure(page);
      if (m.capped) seen.push(m);
    }
    assert.ok(seen.length >= 3, "the row reached its cap");
    for (const m of seen) {
      assert.ok(m.foot <= 1, "the row was left short of its foot: " + JSON.stringify(m));
      assert.ok(m.lineBottom <= m.rowBottom + 0.5, "the line being written was cut at the row's edge: " + JSON.stringify(m));
      assert.ok(Math.abs(m.seat) <= 1.5, "the send square stood off the line being written: " + JSON.stringify(m));
    }
    // the caret moved up into the words is left where the field puts it
    await page.keyboard.down("Meta");
    await page.keyboard.press("ArrowUp", { commands: ["moveToBeginningOfDocument"] });
    await page.keyboard.up("Meta");
    await page.keyboard.type("x");
    await settle(200);
    const top = await page.evaluate(sel => {
      const ta = document.querySelector(sel), f = ComposeFormat.fieldOf(ta);
      return (f && f.view ? f.view.scrollDOM : ta).scrollTop;
    }, ROW);
    assert.ok(top < 12, "typing at the head of a capped row scrolled away from it: " + top);
    assert.deepEqual(problems, []);
  } finally { await fx.close(page); }
}

test("plain: written at its end past the cap, the row shows its foot and the square stands on the line", () => walk(plain));
test("formatted: written at its end past the cap, the row shows its foot and the square stands on the line", () => walk(formatted));
