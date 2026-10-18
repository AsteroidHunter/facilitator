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

// ---- words the page writes into a row the reader is in -----------------------
// A message taken back after a failed send, or a file's address, is written
// into the row while the caret can still be in it. The span the caret is beside
// shows its markers while the row is being typed in, so a Backspace there is
// never taken out of sight; a row written into went on drawing them away.

test("words written into the row under the caret keep the caret's markers on show", async () => {
  const { page, problems } = await desktopRow("Words written under the caret");
  try {
    await lay(page, "draft");
    await caretTo(page, 5);
    // what taking a failed message back writes (sentBack in card-logic.js)
    await page.evaluate(where => {
      const row = document.querySelector(where);
      row.value = row.value + "\n\ntaken **back**";
    }, ROW);
    await settle(150);
    const read = await rowRead(page);
    assert.equal(read.payload, "draft\n\ntaken **back**");
    assert.equal(read.to, read.payload.length, "the caret did not go to the end of the words");
    assert.deepEqual(read.strong, ["**back**"],
      "the span beside the caret was drawn without its markers while the row was being typed in");
    // and the next key takes the character the reader can see
    await page.keyboard.press("Backspace");
    await settle(120);
    assert.equal(await payload(page), "draft\n\ntaken **back*");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- the pointer on drawn words ----------------------------------------------
// The markers of the span the caret arrives in come back on show. When a click
// was what put the caret there, the words moved under the pointer before the
// rest of the gesture: the second press of a double click, or the far end of a
// drag, landed on the characters that had slid under it instead.

// where the character `at` places into `word` stands on screen right now
function charPoint(page, word, at) {
  return page.evaluate(([where, text, offset]) => {
    const shell = document.querySelector(where).closest(".cffield");
    const walk = document.createTreeWalker(shell.querySelector(".cm-content"), NodeFilter.SHOW_TEXT);
    for (let node; (node = walk.nextNode());) {
      const found = node.data.indexOf(text);
      if (found < 0) continue;
      const range = document.createRange();
      range.setStart(node, found + offset);
      range.setEnd(node, found + offset + 1);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2, mid: box.left + box.width / 2 };
    }
    return null;
  }, [ROW, word, at]);
}

test("a double click or a drag on drawn words picks the words under the pointer", async () => {
  const { page, problems } = await desktopRow("The pointer on drawn words");
  try {
    for (const [text, word] of [["a **bold** b", "bold"], ["x **one two three** y", "two"],
                                ["a *slant* b", "slant"], ["a ~~cut~~ b", "cut"]]) {
      await lay(page, text);
      await caretTo(page, 0);
      await settle(120);
      const spot = await charPoint(page, word, 1);
      assert.ok(spot, `${word} was not drawn in ${JSON.stringify(text)}`);
      await page.mouse.click(spot.mid, spot.y, { count: 2 });
      await settle(150);
      const read = await rowRead(page);
      assert.equal(read.picked, word,
        `a double click on ${word} in ${JSON.stringify(text)} picked ${JSON.stringify(read.picked)}`);
    }

    // a drag from inside one drawn word to inside another
    const text = "x **one two three** y";
    await lay(page, text);
    await caretTo(page, 0);
    await settle(120);
    const from = await charPoint(page, "one", 1);     // before the n
    const to = await charPoint(page, "three", 2);     // before the r
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, to.y, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
    await settle(150);
    const dragged = await rowRead(page);
    assert.equal(dragged.picked, "ne two th", "a drag across drawn words picked " +
      JSON.stringify(dragged.picked));
    assert.equal(dragged.payload, text);
    // once the gesture is over the span the pick is in shows its markers again
    await settle(800);
    assert.deepEqual((await rowRead(page)).strong, ["**one two three**"],
      "the markers of the picked span never came back once the pointer let go");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
