// Two composers on one page, and where the caret and the pick end up.
//
// The report pinned here: with formatting turned off while several composers
// were mounted, the passage a reader had picked out in the field they were
// actually typing in was lost. A field the page writes in has no selection of
// its own; what it puts back when the editor comes off is the DOCUMENT's one
// selection, which belongs to whichever field the caret is in. Every field was
// writing that selection as it came down, so the last one taken down won, and a
// field nobody had touched could drop the reader's pick. With one field on the
// page there was nothing to lose it to, which is why the single-field checks
// were all passing.
//
// Both directions are asked here, because which field is taken down last is the
// order they were attached in and not something a reader can see: the pick is
// made in the new-card line once and in the reply line once, and both times it
// has to survive.
//
// The second thing checked here is the bridge a caller outside this file lands
// on: focusing the element itself, which is what a driven browser does, has to
// end with the caret in the editor and the pick where it was. No focus
// behaviour is being changed; this is the regression that says so.
//
// The harness is tests/compose-cdp-fixture.cjs: a browser that is already
// running, and every tab made in the background. Nothing here launches,
// activates or closes a browser.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fixture = require("./compose-cdp-fixture.cjs");

const { DESKTOP, ROW, settle, until, card, clearLane, open,
        pickDesktopCard, editorOn } = fixture;

before(async () => { await fixture.start(); });
after(async () => { await fixture.stop(); });

// the typed page carries two of the lines the page writes in: the reply line of
// the card that is open, and the line a new card is written on
async function openTypedPage(title) {
  await clearLane();
  const id = await card(title, "A reply to answer.");
  const opened = await open("/page", DESKTOP);
  const { page } = opened;
  await until(page, cardId => typeof docEls !== "undefined" && !!docEls[cardId],
    "the card to reach the typed page", 15000, id);
  await page.evaluate(cardId => docSelect(cardId), id);
  const reply = `.docsec[data-id="${id}"] .docreply`;
  await until(page, where => !!document.querySelector(where), "the reply line", 10000, reply);
  await formatting(page, [reply, "#docnew"], true);
  await settle(250);
  return { ...opened, id, reply };
}

// whether each of these fields is wearing an editor, asked of the handle the
// page keeps rather than of a class name the host page chose
function formatting(page, fields, want) {
  return until(page, ([list, on]) => list.every(where => {
    const node = document.querySelector(where);
    const field = node && window.ComposeFormat && ComposeFormat.fieldOf(node);
    return !!field && field.formatted() === on;
  }), `every field to be ${want ? "an editor" : "a plain field"}`, 30000, [fields, want]);
}

// what the page has picked out, whichever face the fields are wearing
function pickState(page, fields) {
  return page.evaluate(where => {
    const picked = getSelection();
    const inside = node => {
      const held = document.querySelector(node);
      const shell = held && (held.closest(".cffield") || held);
      return !!shell && picked.rangeCount > 0 &&
        shell.contains(picked.anchorNode) && shell.contains(picked.focusNode);
    };
    const read = node => {
      const held = document.querySelector(node);
      const field = window.ComposeFormat && ComposeFormat.fieldOf(held);
      const view = field && field.view;
      const at = view && view.state.selection.main;
      return {
        text: held.textContent,
        formatted: !!view,
        editorPick: view ? view.state.sliceDoc(at.from, at.to) : null,
        documentPick: inside(node) ? picked.toString() : null,
        holdsCaret: field ? field.focused()
          : document.activeElement === held || held.contains(document.activeElement),
      };
    };
    const out = {};
    for (const [name, node] of Object.entries(where)) out[name] = read(node);
    return out;
  }, fields);
}

// pick a run of characters out of one of the two lines, through the one public
// face a composer has always had
function pickOut(page, selector, from, to) {
  return page.evaluate(([where, a, b]) => {
    const node = document.querySelector(where);
    node.focus();
    node.setSelectionRange(a, b);
  }, [selector, from, to]);
}

test("turning formatting off keeps the pick in the field the reader is in", async t => {
  const { page, problems, reply } = await openTypedPage("Two composers");
  const fields = { newCard: "#docnew", reply };
  try {
    // both lines are editors, and both hold words of their own. A line the page
    // writes in keeps its words in textContent, which is the one name its face
    // answers to
    await page.evaluate(where => {
      document.querySelector(where).textContent = "gamma delta";
    }, reply);
    await page.evaluate(() => { document.querySelector("#docnew").textContent = "alpha beta"; });
    await settle(200);
    const both = await pickState(page, fields);
    assert.equal(both.newCard.formatted, true, "the new-card line is not an editor");
    assert.equal(both.reply.formatted, true, "the reply line is not an editor");

    // the reader is in the new-card line, with a word picked out
    await pickOut(page, "#docnew", 0, 5);
    await settle(150);
    const before = await pickState(page, fields);
    assert.equal(before.newCard.editorPick, "alpha",
      "the fixture could not pick a word out of the new-card line");

    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await formatting(page, ["#docnew", reply], false);
    await settle(250);
    const after = await pickState(page, fields);
    t.diagnostic(JSON.stringify({ where: "new-card line", before, after }));
    assert.equal(after.newCard.text, "alpha beta", "the new-card line lost its words");
    assert.equal(after.reply.text, "gamma delta", "the reply line lost its words");
    assert.equal(after.newCard.documentPick, "alpha",
      "the pick in the line the reader was in was lost when the editors came off");
    assert.equal(after.reply.documentPick, null,
      "the pick was moved into a line nobody was typing in");
    assert.equal(after.newCard.holdsCaret, true,
      "the caret did not come back to the line the reader was in");

    // and the other way round, because which line is taken down last is the
    // order they were attached in and not something a reader can see
    await page.evaluate(() => ComposeFormat.setEnabled(true));
    await formatting(page, ["#docnew", reply], true);
    await settle(250);
    await pickOut(page, reply, 0, 5);
    await settle(150);
    assert.equal((await pickState(page, fields)).reply.editorPick, "gamma",
      "the fixture could not pick a word out of the reply line");
    await page.evaluate(() => ComposeFormat.setEnabled(false));
    await formatting(page, ["#docnew", reply], false);
    await settle(250);
    const other = await pickState(page, fields);
    t.diagnostic(JSON.stringify({ where: "reply line", after: other }));
    assert.equal(other.reply.documentPick, "gamma",
      "the pick in the reply line was lost when the editors came off");
    assert.equal(other.newCard.documentPick, null,
      "the pick was moved into a line nobody was typing in");
    assert.equal(other.reply.holdsCaret, true,
      "the caret did not come back to the reply line");
    assert.equal(other.newCard.text, "alpha beta", "the new-card line lost its words");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a caller that focuses the element itself lands in the editor with its pick intact", async () => {
  await clearLane();
  const id = await card("Caller focus", "A reply to answer.");
  const { page, problems } = await open("/", DESKTOP);
  try {
    await pickDesktopCard(page, id);
    await editorOn(page);
    await page.focus(ROW);
    await page.keyboard.type("alpha beta gamma");
    await page.evaluate(() => {
      document.querySelector("article.box.sel textarea").setSelectionRange(6, 10);
    });
    await settle(200);
    const held = await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      return { from: row.selectionStart, to: row.selectionEnd,
               picked: row.value.slice(row.selectionStart, row.selectionEnd) };
    });
    assert.deepEqual(held, { from: 6, to: 10, picked: "beta" },
      "the fixture could not pick a word out of the row");

    // the face's own focus, which is what product code calls
    await page.evaluate(() => document.querySelector("article.box.sel textarea").focus());
    await settle(200);
    const viaFace = await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      const view = ComposeFormat.fieldOf(row).view;
      return { inEditor: document.activeElement === view.contentDOM,
               focused: ComposeFormat.focused(row),
               from: row.selectionStart, to: row.selectionEnd };
    });
    assert.deepEqual(viaFace, { inEditor: true, focused: true, from: 6, to: 10 },
      "focusing the field did not put the caret in the editor with its pick");

    // And a caller reaching past this file, which is what a driven browser
    // does: the element's own focus, and not the one the face put on it. The
    // browser answers that with a text control's own selection and puts it away
    // a turn later as a caret at the head of the row; the bridge is what takes
    // the reader's own pick back off it.
    await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      const native = HTMLElement.prototype.focus || Element.prototype.focus;
      native.call(row);
    });
    await settle(300);
    const viaElement = await page.evaluate(() => {
      const row = document.querySelector("article.box.sel textarea");
      const view = ComposeFormat.fieldOf(row).view;
      return { inEditor: document.activeElement === view.contentDOM,
               focused: ComposeFormat.focused(row),
               from: row.selectionStart, to: row.selectionEnd,
               payload: row.value };
    });
    assert.deepEqual(viaElement,
      { inEditor: true, focused: true, from: 6, to: 10, payload: "alpha beta gamma" },
      "a focus call on the element itself did not end in the editor with the pick intact");

    // and typing still lands where the pick was
    await page.keyboard.type("BETA");
    await settle(200);
    assert.equal(await page.$eval(ROW, row => row.value), "alpha BETA gamma",
      "typing after the caller's focus did not replace the picked out word");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
