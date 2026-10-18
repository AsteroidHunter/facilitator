// A card's name typed through an input method keeps its Enter and Escape for
// the input method.
//
// The name commits on Enter and goes back to what it was on Escape. Pressed to
// confirm or cancel a word an input method was building, those keys did the
// same: Enter saved the name with the unconverted word in it and left the
// title, and Escape threw the whole new name away. Chrome sends those keys with
// isComposing set; WebKit sends keyCode 229 once the composition has ended
// (imeKey in card-logic.js). A plain Enter still saves the name.
//
// Played in a background tab of a browser that is already running
// (box-typing-fixture.cjs), on the Mac board and the phone.
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const F = require("./box-typing-fixture.cjs");
const { settle } = F;

let fx;
before(async () => { fx = await F.start({ formatted: false }); });
after(async () => { if (fx) await fx.stop(); });

const naming = id => ({ editing: els[id].titleEl.isContentEditable,
  focused: document.activeElement === els[id].titleEl, text: els[id].titleEl.textContent });

async function walk(surface) {
  const id = await fx.card("Named " + surface);
  const phone = surface === "phone";
  const { page, problems } = await fx.open(phone ? `/m?box=${id}` : "/", phone ? F.PHONE : F.DESKTOP,
    phone ? { fakeViewport: true } : {});
  const cdp = await page.target().createCDPSession();
  try {
    if (phone) await F.pickPhone(page, id); else await F.pickDesktop(page, id);
    await F.until(page, cardId => {
      if (!els[cardId].titleEl.isContentEditable) editTitle(cardId);
      return document.activeElement === els[cardId].titleEl && els[cardId].titleEl.isContentEditable;
    }, "the name being typed", 8000, id);
    await page.keyboard.press("End");
    await page.keyboard.type(" and");
    for (const key of ["Enter", "Escape"]) {
      await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
      await settle(60);
      await page.keyboard.press(key);
      await settle(250);
      let s = await page.evaluate(naming, id);
      assert.ok(s.editing && s.focused, `${surface}: ${key} in a composition ended the name: ` + JSON.stringify(s));
      await cdp.send("Input.insertText", { text: "日本" });
      await settle(60);
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key,
        windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key,
        windowsVirtualKeyCode: key === "Enter" ? 13 : 27, nativeVirtualKeyCode: key === "Enter" ? 13 : 27 });
      await settle(250);
      s = await page.evaluate(naming, id);
      assert.ok(s.editing && s.focused, `${surface}: WebKit's ${key} after a composition ended the name: ` + JSON.stringify(s));
    }
    // a plain Enter saves the name with the confirmed words
    await page.keyboard.press("Enter");
    await F.until(page, cardId => !els[cardId].titleEl.isContentEditable, "the name saved", 5000, id);
    await settle(600);
    const title = (await fx.state()).boxes.find(b => b.id === id).title;
    assert.equal(title, `Named ${surface} and日本日本`, surface + ": the saved name");
    assert.deepEqual(problems, []);
  } finally { await cdp.detach().catch(() => {}); await fx.close(page); }
}

test("the Mac board's card name keeps an input method's Enter and Escape", () => walk("mac"));
test("the phone's card name keeps an input method's Enter and Escape", () => walk("phone"));
