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

// ---- drawn as the card draws it ------------------------------------------------
// The row draws its markdown so the reader sees the message the card will show.

// what the card the words are sent to makes of them
function cardDraws(page, source) {
  return page.evaluate(text => CardMarkdown.render(text), source);
}

test("a line under a quote that carries no angle of its own is drawn outside the quote", async () => {
  const { page, problems } = await desktopRow("A reply under a quote");
  try {
    // a reply written under a quoted line, with no angle of its own, is a
    // line of its own, and the card shows it outside the quote. A new line
    // carries the angle down, so the reply is laid in as written
    await lay(page, "> said\nmy reply");
    await caretTo(page, 15);
    await settle(150);
    const read = await rowRead(page);
    assert.equal(read.payload, "> said\nmy reply");
    assert.deepEqual(read.lines.map(line => [line.text, line.quote]), [["said", true], ["my reply", false]],
      "the reply under the quote was drawn inside the quote's bar");
    assert.equal(await cardDraws(page, read.payload), "<blockquote><p>said</p></blockquote><p>my reply</p>",
      "the card no longer draws the reply outside the quote, so this check asks the wrong thing");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a span that runs over a line break is drawn as the characters the card shows", async () => {
  const { page, problems } = await desktopRow("A span over a line break");
  const drawn = () => page.evaluate(where => {
    const content = document.querySelector(where).closest(".cffield").querySelector(".cm-content");
    const of = name => [...content.querySelectorAll(name)].map(node => node.textContent);
    return { lines: [...content.querySelectorAll(".cm-line")].map(line => line.textContent),
             em: of(".cf-em"), strong: of(".cf-strong"), strike: of(".cf-strike") };
  }, ROW);
  try {
    for (const text of ["x *one\ntwo* y", "x **bold\nacross** y", "x ~~cut\nacross~~ y"]) {
      await lay(page, text);
      await caretTo(page, text.length);
      await settle(150);
      const read = await drawn();
      assert.deepEqual(read.lines, text.split("\n"),
        `${JSON.stringify(text)}: the markers of a span over a line break were drawn away`);
      assert.deepEqual([read.em, read.strong, read.strike], [[], [], []],
        `${JSON.stringify(text)}: a span over a line break was drawn styled`);
      assert.doesNotMatch(await cardDraws(page, text), /<(em|b|del)>/,
        "the card now styles a span over a line break, so this check asks the wrong thing");
    }
    // a span inside each of two lines is still drawn on both
    await lay(page, "*one*\n**two** z");
    await caretTo(page, 15);
    await settle(150);
    const both = await drawn();
    assert.deepEqual([both.em, both.strong], [["one"], ["two"]],
      "a span inside one line stopped being drawn");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- return on a quoted line with nothing typed on it -------------------------
// A marker with nothing typed after it ends the list, and the editor's own
// return on a quoted line with nothing typed after its angle wrote the line
// above back as a bare angle, drawn as a stray ">" in the quote, and laid
// another quoted line under it, so the quote never ended.

test("return on a quoted line with nothing typed on it ends the quote", async () => {
  const phone = await phoneRow("Ending a quote on the phone", true);
  try {
    const { page } = phone;
    // An empty item in a quote ends the list first and leaves the quote, one
    // level a press, as an empty nested item moves out a level; the next
    // return ends the quote
    for (const [typed, ends] of [["> said", ["> said\n"]], ["> - item", ["> - item\n> ", "> - item\n"]]]) {
      await lay(page, "");
      await page.keyboard.type(typed);
      await page.keyboard.press("Enter");
      await settle(150);
      assert.equal(await payload(page), typed + "\n" + typed.replace(/[^>\- ].*$/, ""),
        "the return key did not carry the quote down");
      for (const ended of ends) {
        await page.keyboard.press("Enter");
        await settle(150);
        const read = await rowRead(page);
        assert.equal(read.payload, ended, "a return on the empty quoted line did not end the quote");
        assert.equal(read.angles, 0, "an angle was left standing in the drawn quote");
      }
    }
    assert.deepEqual(phone.problems, []);
  } finally {
    await phone.page.close();
  }
  const mac = await desktopRow("Ending a quote on the Mac");
  try {
    await lay(mac.page, "> said\n> ");
    await caretTo(mac.page, 9);
    await chord(mac.page, "Enter", "Shift");
    await settle(150);
    assert.equal(await payload(mac.page), "> said\n", "shift and return on an empty quoted line did not end it");
    assert.deepEqual(mac.problems, []);
  } finally {
    await mac.page.close();
  }
});

// ---- a new item inside a numbered list -----------------------------------------
// The phone's return numbers the items after a new one on, and the Mac's shift
// and return left them as they were, so the list read 1, 2, 2, 3.

test("a new item inside a numbered list numbers the items after it on", async () => {
  const { page, problems } = await desktopRow("A new numbered item");
  try {
    for (const [text, at, made] of [
      ["1. a\n2. b\n3. c", 4, "1. a\n2. \n3. b\n4. c"],
      ["1) a\n2) b", 4, "1) a\n2) \n3) b"],
      // a level inside keeps its own numbers, and the level's own go on
      ["1. a\n   1. x\n2. b", 4, "1. a\n2. \n   1. x\n3. b"],
      // a list that does not count up is left as it was written
      ["1. a\n1. b", 4, "1. a\n2. \n1. b"],
    ]) {
      await lay(page, text);
      await caretTo(page, at);
      await chord(page, "Enter", "Shift");
      await settle(120);
      assert.equal(await payload(page), made, `shift and return in ${JSON.stringify(text)}`);
      // and one undo takes the item and the new numbers back together
      await chord(page, "z", "Meta");
      await settle(120);
      assert.equal(await payload(page), text, `undo after ${JSON.stringify(text)}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- Backspace after an emoji --------------------------------------------------
// The plain field takes a whole emoji with one Backspace. The editor took the
// last piece of one: a skin tone off a hand, the keycap off a digit, a tag off
// a flag, leaving a different picture behind.

test("Backspace after an emoji takes all of it, as the plain field does", async () => {
  const { page, problems } = await desktopRow("Backspace after an emoji");
  try {
    for (const [name, text, left] of [
      ["a skin tone", "ok \u{1F44D}\u{1F3FD}", "ok "],
      ["a keycap", "ok 1️⃣", "ok "],
      ["a tagged flag", "ok \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}", "ok "],
      ["a family", "ok \u{1F468}‍\u{1F469}‍\u{1F467}", "ok "],
      // an accent written as a mark of its own is still taken on its own, as
      // the plain field takes it
      ["a combining accent", "ok é", "ok e"],
    ]) {
      await lay(page, text);
      await caretTo(page, text.length);
      await page.keyboard.press("Backspace");
      await settle(100);
      assert.equal(await payload(page), left, `Backspace after ${name}`);
    }
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// ---- a list line inside code ---------------------------------------------------
// A dash inside a code block is the code's own character, and the card shows
// it as code. A new line there carried it down as a list marker.

test("a new line inside a code block carries no list marker", async () => {
  const mac = await desktopRow("A list line inside code");
  try {
    for (const [text, made] of [
      ["```\n- in code", "```\n- in code\n"],
      ["```\n1. in code", "```\n1. in code\n"],
      ["words\n\n    - indented code", "words\n\n    - indented code\n"],
      // a marker alone inside code is not a list to end either
      ["```\n- ", "```\n- \n"],
    ]) {
      await lay(mac.page, text);
      await caretTo(mac.page, text.length);
      await chord(mac.page, "Enter", "Shift");
      await settle(120);
      assert.equal(await payload(mac.page), made, `shift and return in ${JSON.stringify(text)}`);
    }
    assert.deepEqual(mac.problems, []);
  } finally {
    await mac.page.close();
  }
  const phone = await phoneRow("A list line inside code on the phone", true);
  try {
    await lay(phone.page, "```\n- in code");
    await caretTo(phone.page, 13);
    await phone.page.keyboard.press("Enter");
    await settle(150);
    assert.equal(await payload(phone.page), "```\n- in code\n", "return inside code on the phone");
    assert.deepEqual(phone.problems, []);
  } finally {
    await phone.page.close();
  }
});

// ---- the field's own selection call --------------------------------------------
// A textarea's setSelectionRange takes a direction as well as two ends, and
// the page hands one over when it puts a pick back. The editor's face dropped
// it, so a pick made leftwards came back made rightwards.

test("the row's selection call keeps the direction it is given", async () => {
  const { page, problems } = await desktopRow("A pick made leftwards");
  try {
    await lay(page, "abcdefghij");
    const pick = (from, to, way) => page.evaluate(([where, a, b, w]) => {
      const row = document.querySelector(where);
      row.setSelectionRange(a, b, w);
      return [row.selectionStart, row.selectionEnd, row.selectionDirection];
    }, [ROW, from, to, way]);
    assert.deepEqual(await pick(2, 6, "backward"), [2, 6, "backward"]);
    await chord(page, "ArrowLeft", "Shift");
    await settle(80);
    const read = await rowRead(page);
    assert.deepEqual([read.from, read.to], [1, 6], "Shift and Left did not grow the pick at its start");
    assert.deepEqual(await pick(2, 6, "forward"), [2, 6, "forward"]);
    assert.deepEqual(await pick(2, 6), [2, 6, "forward"]);
    // an anchor past its head still reads as the pick made leftwards
    assert.deepEqual(await pick(6, 2), [2, 6, "backward"]);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
