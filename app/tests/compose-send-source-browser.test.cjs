// What the return key sends, and what the card makes of it.
//
// Two reports are pinned here.
//
// The first: a real return key sent something other than what was in the row.
// Composing "> alpha" put "> alpha\n>" on the board, and composing an outer and
// an inner bullet put a third, empty marker under them. The editor's own
// markdown pack binds return to a continuation of its own, at a precedence
// above anything the row installs, so the key meant for the page's send wrote a
// marker into the row on its way there and the card was sent a line the reader
// never typed. It showed on a quote and on a list and nowhere else, because on
// an ordinary paragraph the continuation is a bare newline that the send then
// trims away.
//
// The continuation is kept: on the phone, a return on a quoted line carrying
// "> " down is what a reader of this row already has, and the native run says
// so. It is only asked later than the row's own two rules, which is why the
// send and the newline contracts are both checked here, in one file.
//
// The second: "***alpha*** tail" composes as bold and italic together and was
// sent as a card reading "*alpha* tail" in bold, with the stars showing. The
// closing run of three markers was being cut after two.
//
// Nothing in these checks reaches past the two: the source that leaves the row
// is compared byte for byte, and the shapes that were already right are checked
// to still be right.
//
// The harness is tests/compose-cdp-fixture.cjs: a browser that is already
// running, and every tab made in the background. Nothing here launches,
// activates or closes a browser.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fixture = require("./compose-cdp-fixture.cjs");

const { DESKTOP, PHONE, ROW, settle, until, card, clearLane, sentTexts, open, shot,
        pickDesktopCard, pickPhoneCard, editorOn, lay, caretTo, rowRead } = fixture;

const KEYBOARD = 336;   // an iPhone keyboard with its accessory bar, in css px

// every source the return key is pressed on, and the bytes the board must get
const SENDS = [
  { id: "quote", raw: "> alpha" },
  { id: "quote-nested", raw: ">> alpha" },
  { id: "quote-bullet", raw: "> - alpha" },
  { id: "list-nested", raw: "- outer\n  - inner" },
  { id: "list-ordered", raw: "1. alpha\n2. beta" },
  { id: "mixed-inline", raw: "*alpha* **beta** ~~gamma~~ ~delta~ tail" },
  { id: "literal-blocks", raw: "# Heading\n`*code*`\n[alpha](https://example.invalid)" },
];
// Nothing here ends in whitespace on purpose. The page trims what it sends, and
// that is the page's own rule and not this file's business: it is only because
// of it that a plain paragraph looked like it was sending its source while a
// quote and a list plainly were not.

async function openCard(surface, title, ...replies) {
  await clearLane();
  const id = await card(title, ...(replies.length ? replies : ["A reply to answer."]));
  const opened = await open(surface.route(id), surface.viewport, surface.opts);
  await surface.pick(opened.page, id);
  await editorOn(opened.page);
  return { ...opened, id };
}

const DESKTOP_CARD = { viewport: DESKTOP, route: () => "/", pick: pickDesktopCard };
const PHONE_CARD = { viewport: PHONE, route: id => `/m?box=${id}`, pick: pickPhoneCard,
                     opts: { fakeViewport: true } };

// what the card itself made of the words, read off the card and not off the
// renderer: everything drawn in the card that is not the row the reader types in
function sentDom(page) {
  return page.evaluate(() => {
    const box = document.querySelector("article.box.sel");
    const row = box.querySelector(".cffield") || box.querySelector("textarea");
    const outside = node => !(row && row.contains(node));
    const tagged = tags => [...box.querySelectorAll(tags)].filter(outside)
      .map(node => node.textContent);
    const text = [...box.childNodes].map(node => node.textContent).join("");
    return {
      text,
      em: tagged("em, i"),
      bold: tagged("b, strong"),
      struck: tagged("del, s"),
      code: tagged("code"),
      quote: tagged("blockquote").length,
      items: tagged("li"),
    };
  });
}

before(async () => { await fixture.start(); });
after(async () => { await fixture.stop(); });

// ---- the return key that sends ----------------------------------------------

test("the return key sends the source and writes nothing into the row", async t => {
  for (const item of SENDS) {
    const { page, problems, id } = await openCard(DESKTOP_CARD, "Sent source: " + item.id);
    try {
      await lay(page, item.raw);
      await caretTo(page, item.raw.length);
      await settle(160);
      assert.equal((await rowRead(page)).payload, item.raw,
        item.id + ": the row did not take the words to begin with");

      const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
      await page.keyboard.press("Enter");
      assert.equal((await sent).status(), 200, item.id + ": the return key did not send");
      await settle(400);
      const server = (await sentTexts(id)).slice(-1)[0];
      t.diagnostic(JSON.stringify({ id: item.id, composed: item.raw, server }));
      assert.equal(server, item.raw,
        item.id + ": the board was sent something other than the markdown in the row");
      assert.equal((await rowRead(page)).payload, "",
        item.id + ": the row kept something after the send");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  }
});

test("shift and return still make the row's own new line, and send nothing", async () => {
  const { page, problems } = await openCard(DESKTOP_CARD, "Shift and return");
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  const chord = async () => {
    await page.keyboard.down("Shift");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Shift");
    await settle(160);
  };
  try {
    await page.focus(ROW);
    await page.keyboard.type("- one");
    await chord();
    assert.equal((await rowRead(page)).payload, "- one\n- ",
      "shift and return did not carry the bullet down");
    await page.keyboard.type("two");
    await chord();
    assert.equal((await rowRead(page)).payload, "- one\n- two\n- ",
      "shift and return did not carry the bullet down a second time");
    await chord();
    assert.equal((await rowRead(page)).payload, "- one\n- two\n",
      "the empty bullet did not end the list");
    // A quoted line breaks plainly under this chord. Carrying a quote's angle
    // down is the editor's own continuation, and that answers a bare return;
    // the row's own new line is what a shifted one has always made, and it
    // carries a list marker and nothing else.
    await page.keyboard.type("> alpha");
    await chord();
    assert.equal((await rowRead(page)).payload, "- one\n- two\n> alpha\n",
      "shift and return stopped making the row's own plain new line");
    await page.keyboard.type("plain");
    await chord();
    assert.equal((await rowRead(page)).payload, "- one\n- two\n> alpha\nplain\n",
      "a new line after plain words started something nobody asked for");
    assert.deepEqual(sends, [], "shift and return sent the draft");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("under the phone's keyboard the return key makes a line, and sends once it is down", async () => {
  const { page, problems, id } = await openCard(PHONE_CARD, "Phone return");
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  try {
    await page.focus(ROW);
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height - KEYBOARD);
    await settle(600);
    assert.equal(await page.evaluate(() => document.body.classList.contains("kb")), true,
      "the on-screen keyboard was not read as up, so nothing here is being asked of it");

    await page.keyboard.type("- one");
    await page.keyboard.press("Enter");
    await settle(200);
    assert.equal((await rowRead(page)).payload, "- one\n- ",
      "the return key did not carry the bullet under the keyboard");
    await page.keyboard.type("two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await settle(200);
    assert.equal((await rowRead(page)).payload, "- one\n- two\n",
      "the empty bullet did not end the list under the keyboard");
    assert.deepEqual(sends, [], "the return key sent while the keyboard was up");

    // the keyboard goes down and the return key is the send again, and what it
    // sends is the source
    await lay(page, "> alpha");
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height);
    await settle(600);
    await page.focus(ROW);
    await caretTo(page, 7);
    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(400);
    assert.equal((await sentTexts(id)).slice(-1)[0], "> alpha",
      "the phone sent something other than the markdown in the row");
    assert.equal((await rowRead(page)).payload, "", "the phone row kept the words it sent");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("under the phone's keyboard a quote and a list carry their markers down", async t => {
  const { page, problems } = await openCard(PHONE_CARD, "Phone continuation");
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  const clear = async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await settle(160);
  };
  try {
    await page.focus(ROW);
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height - KEYBOARD);
    await settle(600);
    assert.equal(await page.evaluate(() => document.body.classList.contains("kb")), true,
      "the on-screen keyboard was not read as up, so nothing here is being asked of it");

    // a quoted line carries its angle down, which is the editor's own
    // continuation and what a reader of this row already has
    await page.keyboard.type("> alpha");
    await page.keyboard.press("Enter");
    await settle(220);
    const quoted = (await rowRead(page)).payload;
    t.diagnostic(JSON.stringify({ quoted }));
    assert.equal(quoted, "> alpha\n> ", "the return key did not carry the quote's angle down");

    // a list carries its marker down once, and the marker nobody typed after
    // ends the list rather than laying a third one out under a blank line
    await clear();
    await page.keyboard.type("- alpha");
    await page.keyboard.press("Enter");
    await settle(220);
    assert.equal((await rowRead(page)).payload, "- alpha\n- ",
      "the return key did not carry the bullet down");
    await page.keyboard.press("Enter");
    await settle(220);
    const ended = (await rowRead(page)).payload;
    t.diagnostic(JSON.stringify({ ended }));
    assert.equal(ended, "- alpha\n",
      "the marker nobody typed after did not end the list: " + JSON.stringify(ended));

    assert.deepEqual(sends, [], "a return under the keyboard sent the draft");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

// A held key is one keydown carrying the browser's auto-repeat flag, and a
// driver's press loop cannot make one: every press in a loop arrives with
// event.repeat false. The flag is asked for directly here, which is still a
// trusted key event. The shift case rides on the event's own modifier bit,
// which is what the row reads.
async function holdReturn(cdp, repeats, shift = false) {
  const key = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
                code: "Enter", key: "Enter", text: "\r" };
  const modifiers = shift ? 8 : 0;
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, ...key });
  for (let press = 0; press < repeats; press++) {
    await cdp.send("Input.dispatchKeyEvent",
      { type: "keyDown", modifiers, autoRepeat: true, ...key });
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...key });
}

test("a held return keeps the policy each line has always had", async t => {
  const { page, problems } = await openCard(PHONE_CARD, "Held return");
  const cdp = await page.target().createCDPSession();
  const sends = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/send") sends.push(request.url());
  });
  const clear = async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
    await page.keyboard.press("Backspace");
    await settle(160);
  };
  const after = async () => { await settle(240); return (await rowRead(page)).payload; };
  try {
    await page.focus(ROW);
    await page.evaluate(height => window.__keyboard.set(height, 0), PHONE.height - KEYBOARD);
    await settle(600);
    assert.equal(await page.evaluate(() => document.body.classList.contains("kb")), true,
      "the on-screen keyboard was not read as up, so nothing here is being asked of it");

    // A quoted line is the editor's own continuation, and a held return goes on
    // reaching it. What the editor makes of the second and third press is the
    // editor's business and is only recorded here; what is asked is that the
    // row's own pass has not quietly swallowed them.
    await page.keyboard.type("> alpha");
    await holdReturn(cdp, 0);
    const once = await after();
    assert.equal(once, "> alpha\n> ", "one press did not carry the quote's angle down");
    await clear();
    await page.keyboard.type("> alpha");
    await holdReturn(cdp, 2);
    const held = await after();
    t.diagnostic(JSON.stringify({ quoted: { once, held } }));
    assert.notEqual(held, once,
      "a held return on a quoted line was swallowed: the repeats never reached the editor");
    assert.ok(held.startsWith("> alpha"),
      "a held return on a quoted line lost the words that were typed: " + JSON.stringify(held));

    // A list ends once under a held return and the run stops there. This is the
    // one place a repeat does something, and it is the correction itself: the
    // first press carries the marker down, the second finishes with it, and the
    // third has an ordinary empty line under it and does nothing.
    await clear();
    await page.keyboard.type("- alpha");
    await holdReturn(cdp, 2);
    const list = await after();
    t.diagnostic(JSON.stringify({ list }));
    assert.equal(list, "- alpha\n",
      "a held return on a list did not end it once and stop: " + JSON.stringify(list));

    // A plain line makes one line and not a run of them, which is what a held
    // return has always done on the lines the row answers itself
    await clear();
    await page.keyboard.type("plain");
    await holdReturn(cdp, 2);
    const plain = await after();
    assert.equal(plain, "plain\n",
      "a held return on a plain line made a run of lines: " + JSON.stringify(plain));

    // and so does a held shift and return, on a list as much as anywhere
    await clear();
    await page.keyboard.type("- alpha");
    await holdReturn(cdp, 2, true);
    const shifted = await after();
    assert.equal(shifted, "- alpha\n- ",
      "a held shift and return made a run of lines: " + JSON.stringify(shifted));

    assert.deepEqual(sends, [], "a held return under the keyboard sent the draft");
    assert.deepEqual(problems, []);
  } finally {
    await cdp.detach();
    await page.close();
  }
});

// ---- and what the card makes of what it was sent ----------------------------

test("bold and italic together reach the card as bold and italic", async t => {
  const { page, problems, id } = await openCard(DESKTOP_CARD, "Nested emphasis", "A reply to answer.");
  try {
    await page.focus(ROW);
    await page.keyboard.type("***alpha*** tail");
    await settle(200);
    const composed = await rowRead(page);
    assert.equal(composed.payload, "***alpha*** tail", "the row changed the markdown in it");
    assert.deepEqual(composed.italic, ["alpha"], "the row did not draw it italic");
    assert.deepEqual(composed.strong, ["alpha"], "the row did not draw it bold");

    const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
    await page.keyboard.press("Enter");
    assert.equal((await sent).status(), 200);
    await settle(400);
    assert.equal((await sentTexts(id)).slice(-1)[0], "***alpha*** tail",
      "the board was sent something other than the markdown in the row");
    await until(page, () => /alpha/.test(document.querySelector("article.box.sel").textContent),
      "the card to draw what it was sent", 10000);
    const drawn = await sentDom(page);
    t.diagnostic(JSON.stringify(drawn));
    await shot(page, "desktop-triple-emphasis-sent");
    assert.ok(drawn.bold.includes("alpha"),
      "the card did not draw the words bold: " + JSON.stringify(drawn.bold));
    assert.ok(drawn.em.includes("alpha"),
      "the card did not draw the words italic: " + JSON.stringify(drawn.em));
    assert.equal(/\*/.test(drawn.text), false,
      "the card drew a marker as one of its own characters: " + JSON.stringify(drawn.text));
    assert.match(drawn.text, /alpha tail/, "the card lost the words: " + drawn.text);
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the shapes the card already drew right are drawn right still", async t => {
  const cases = [
    { id: "strong-inside-emphasis", raw: "**_alpha_** tail", em: "alpha", bold: "alpha" },
    { id: "emphasis-inside-strong", raw: "*__alpha__* tail", em: "alpha", bold: "alpha" },
    { id: "strong-only", raw: "**alpha** tail", bold: "alpha" },
    { id: "emphasis-only", raw: "*alpha* tail", em: "alpha" },
  ];
  for (const item of cases) {
    const { page, problems, id } = await openCard(DESKTOP_CARD, "Card nesting: " + item.id);
    try {
      await page.focus(ROW);
      await page.keyboard.type(item.raw);
      const sent = page.waitForResponse(response => new URL(response.url()).pathname === "/send");
      await page.keyboard.press("Enter");
      assert.equal((await sent).status(), 200);
      await settle(400);
      assert.equal((await sentTexts(id)).slice(-1)[0], item.raw,
        item.id + ": the board was sent something other than the markdown in the row");
      await until(page, () => /alpha/.test(document.querySelector("article.box.sel").textContent),
        "the card to draw what it was sent", 10000);
      const drawn = await sentDom(page);
      t.diagnostic(JSON.stringify({ id: item.id, drawn }));
      if (item.em) assert.ok(drawn.em.includes(item.em),
        item.id + ": the card did not draw it italic: " + JSON.stringify(drawn.em));
      if (item.bold) assert.ok(drawn.bold.includes(item.bold),
        item.id + ": the card did not draw it bold: " + JSON.stringify(drawn.bold));
      assert.equal(/[*_]/.test(drawn.text), false,
        item.id + ": the card drew a marker as one of its own characters: " + drawn.text);
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  }
});
