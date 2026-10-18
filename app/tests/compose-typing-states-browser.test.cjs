// Typing states in the card's formatted row, each one pinned after it was found
// doing something other than what the plain field does, or drawing something
// other than what the card the words are sent to draws.
//
// Every check types, clicks or presses the way a reader does on the Mac board
// or the phone page, and reads back both what the row holds and what is drawn.
//
// The harness is tests/compose-cdp-fixture.cjs: a browser that is already
// running, and every tab made in the background. Nothing here launches,
// activates or closes a browser.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fixture = require("./compose-cdp-fixture.cjs");

const { DESKTOP, PHONE, ROW, settle, until, card, clearLane, open,
        pickDesktopCard, pickPhoneCard, editorOn, lay, caretTo, rowRead } = fixture;

const KEYBOARD = 336;   // an iPhone keyboard with its accessory bar, in css px

before(async () => { await fixture.start(); });
after(async () => { await fixture.stop(); });

async function chord(page, key, ...modifiers) {
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  await page.keyboard.press(key);
  for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
}

async function desktopRow(title) {
  await clearLane();
  const id = await card(title, "A reply to answer.");
  const opened = await open("/", DESKTOP);
  await pickDesktopCard(opened.page, id);
  await editorOn(opened.page);
  return { ...opened, id };
}

async function phoneRow(title, keyboard) {
  await clearLane();
  const id = await card(title, "A reply to answer.");
  const opened = await open(`/m?box=${id}`, PHONE, { fakeViewport: true });
  await pickPhoneCard(opened.page, id);
  await editorOn(opened.page);
  if (keyboard) {
    await opened.page.focus(ROW);
    await opened.page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height - KEYBOARD);
    await until(opened.page, () => document.body.classList.contains("kb"),
      "the on-screen keyboard to be read as up", 5000);
  }
  return { ...opened, id };
}

function payload(page) {
  return page.$eval(ROW, row => row.value);
}

// ---- the reader's own keyboard and spelling ----------------------------------
// The plain field checks spelling on the Mac, and on the phone it corrects words
// and capitalises the start of a sentence. The editor standing in for it turned
// all three off on its content, so the same row typed differently once
// formatting was on.

function typingAttributes(page) {
  return page.evaluate(where => {
    const row = document.querySelector(where);
    const content = ComposeFormat.fieldOf(row).view.contentDOM;
    const plain = document.createElement("textarea");
    return {
      spellcheck: content.spellcheck, plainSpellcheck: plain.spellcheck,
      autocorrect: content.getAttribute("autocorrect"),
      autocapitalize: content.getAttribute("autocapitalize"),
    };
  }, ROW);
}

test("the formatted row checks spelling, corrects and capitalises as the plain field does", async () => {
  for (const surface of ["desktop", "phone"]) {
    const { page, problems } = surface === "desktop"
      ? await desktopRow("Spelling on the Mac") : await phoneRow("Spelling on the phone");
    try {
      const read = await typingAttributes(page);
      assert.equal(read.spellcheck, read.plainSpellcheck,
        `${surface}: the formatted row does not check spelling the way the plain field does`);
      assert.notEqual(read.autocorrect, "off", `${surface}: the formatted row turned word correction off`);
      assert.notEqual(read.autocapitalize, "off", `${surface}: the formatted row turned capitals off`);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  }
});
