// The composer's one drawing of a quote.
//
// The report pinned here: typing ">" drew a quote bar and left the literal
// angle standing beside it, and a prefix like "> alpha" kept its marker for as
// long as the caret stayed on the line. Bare, spaced, unspaced, indented,
// nested, quoted lists and a quote inside a list all did it, on every surface
// the row appears on, and the native iPhone row did it too. So a reader typing
// a quote saw the quote written twice, and watched the line's words step
// sideways every time the caret arrived on the line and again when it left.
//
// What is asked of the row is read apart everywhere below: what is DRAWN must
// be one quote and no angles, and what the row HOLDS and SENDS must be exactly
// the characters that were typed, angles and all. A build that fixed the
// drawing by editing the document would fail here.
//
// The angle inside a code span is the reader's own character and is checked to
// still be there. Lazy continuation and nested depth are checked as the limits
// they are and not as things being fixed.
//
// The harness is tests/compose-cdp-fixture.cjs, which connects to a browser
// that is already running and makes every tab in the background. Nothing here
// launches, activates or closes a browser.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fixture = require("./compose-cdp-fixture.cjs");

const { DESKTOP, PHONE, ROW, EDGE, settle, card, clearLane, sentTexts,
        open, shot, pickDesktopCard, pickPhoneCard, editorOn, lay, caretTo,
        rowRead, wordsAt } = fixture;

// Every quote shape the audit walks, and the one drawing each of them gets.
// `drawn` is what is left in each line of the row once the markup is off it.
const SHAPES = [
  { id: "quote-bare", raw: ">", drawn: [""], quotes: 1 },
  { id: "quote-space", raw: "> ", drawn: [""], quotes: 1 },
  { id: "quote-text", raw: "> alpha", drawn: ["alpha"], quotes: 1 },
  { id: "quote-no-space", raw: ">alpha", drawn: ["alpha"], quotes: 1 },
  { id: "quote-leading-spaces", raw: "  > alpha", drawn: ["alpha"], quotes: 1 },
  { id: "quote-nested-tight", raw: ">> alpha", drawn: ["alpha"], quotes: 1 },
  { id: "quote-nested-spaced", raw: "> > alpha", drawn: ["alpha"], quotes: 1 },
  { id: "quote-multiline", raw: "> alpha\n> beta", drawn: ["alpha", "beta"], quotes: 2 },
  { id: "quote-blank-line", raw: "> alpha\n>\n> beta", drawn: ["alpha", "", "beta"], quotes: 3 },
  { id: "quote-inline", raw: "> *alpha* and **beta** tail",
    drawn: ["alpha and beta tail"], quotes: 1, em: 1, strong: 1 },
  { id: "quote-bullet", raw: "> - alpha", drawn: ["- alpha"], quotes: 1, bullets: 1 },
  { id: "quote-ordered", raw: "> 1. alpha", drawn: ["1. alpha"], quotes: 1, bullets: 0 },
  { id: "list-containing-quote", raw: "- > alpha", drawn: ["- alpha"], quotes: 1, bullets: 1 },
  // the angle in the body of a code span is content and stays exactly there
  { id: "quote-code-angle", raw: "> `a > b`", drawn: ["`a > b`"], quotes: 1, angles: 1 },
  // a limit, not a fix: the bundled parser reads the unprefixed line as part of
  // the quote and the row draws a bar on it, while the sent card does not
  { id: "quote-lazy-continuation", raw: "> alpha\nbeta", drawn: ["alpha", "beta"], quotes: 2 },
];

// input that is not a quote and must keep every character it was typed with
const LITERAL = [
  "a > b",
  "\\> not a quote",
  "-> arrow",
  "",
  "    > indented code",
  "",
  "```",
  "> inside a fence",
  "```",
].join("\n");

const SURFACES = [
  { name: "desktop", viewport: DESKTOP, route: () => "/", pick: pickDesktopCard },
  { name: "phone", viewport: PHONE, route: id => `/m?box=${id}`, pick: pickPhoneCard },
];

async function openCard(surface, title) {
  await clearLane();
  const id = await card(title, "A reply to answer.");
  const opened = await open(surface.route(id), surface.viewport);
  await surface.pick(opened.page, id);
  await editorOn(opened.page);
  return { ...opened, id };
}

before(async () => { await fixture.start(); });
after(async () => { await fixture.stop(); });

// ---- every shape, with the caret on the line and away from it ---------------

for (const surface of SURFACES) {
  test(`${surface.name}: every quote shape is drawn once, wherever the caret is`, async t => {
    const { page, problems } = await openCard(surface, "Quote shapes");
    try {
      for (const shape of SHAPES) {
        await lay(page, shape.raw);
        const reads = {};
        for (const [where, at] of [["head", 0], ["end", shape.raw.length]]) {
          await caretTo(page, at);
          await settle(160);
          reads[where] = await rowRead(page);
        }
        t.diagnostic(JSON.stringify({ surface: surface.name, id: shape.id,
          head: reads.head.lines.map(line => line.text),
          end: reads.end.lines.map(line => line.text) }));
        for (const [where, read] of Object.entries(reads)) {
          const say = `${shape.id} (${JSON.stringify(shape.raw)}) with the caret at the ${where}`;
          assert.equal(read.payload, shape.raw, `${say}: the row changed the markdown in it`);
          assert.deepEqual(read.lines.map(line => line.text), shape.drawn,
            `${say}: the row drew something other than one quote`);
          assert.equal(read.lines.filter(line => line.quote).length, shape.quotes,
            `${say}: the wrong number of lines carry a bar`);
          assert.equal(read.angles, shape.angles || 0,
            `${say}: ${read.angles} angles are being drawn`);
          for (const line of read.lines.filter(line => line.quote))
            assert.ok(line.border >= 2, `${say}: a quoted line carries no bar: ` + line.border);
          if (shape.bullets !== undefined)
            assert.equal(read.lines.reduce((sum, line) => sum + line.bullets, 0), shape.bullets,
              `${say}: the wrong number of round markers`);
          if (shape.em !== undefined)
            assert.equal(read.italic.length, shape.em, `${say}: the emphasis was not drawn`);
          if (shape.strong !== undefined)
            assert.equal(read.strong.length, shape.strong, `${say}: the strong was not drawn`);
        }
      }
      await shot(page, surface.name + "-quote-shapes");
      assert.deepEqual(problems, []);
    } finally {
      await page.close();
    }
  });
}

// ---- typed, one key at a time, and taken apart again ------------------------

test("a quote being typed is drawn once, and the angle is not drawn beside it", async () => {
  const { page, problems } = await openCard(SURFACES[0], "Quote while typing");
  try {
    await page.focus(ROW);
    await page.keyboard.type("> a *note*");
    await settle(220);
    const typed = await rowRead(page);
    const quoted = typed.lines.filter(line => line.quote);

    assert.equal(typed.payload, "> a *note*", "the row did not keep the markdown that was typed");
    assert.equal(quoted.length, 1, "the typed angle did not draw a quoted line");
    assert.ok(quoted[0].border >= 2, "the quoted line carries no bar: " + quoted[0].border);
    // the caret is on this line and beside the closing star, so the star is
    // showing. A row that was never awake would hide every marker there is and
    // would pass the check below for a reason that has nothing to do with it
    assert.deepEqual(typed.italic, ["*note*"],
      "the emphasis was not drawn, or its own markers did not come back beside the caret");
    assert.match(typed.lines[0].text, /\*note\*/,
      "the row was not awake, so nothing here is being asked of the line the caret is on: " +
      typed.lines[0].text);
    // and the angle, on that same awake line
    assert.equal(typed.lines[0].text, "a *note*",
      "the angle was drawn beside the bar on the line the caret is on: " + typed.lines[0].text);
    await shot(page, "desktop-quote-typed");

    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("the words of a quoted line do not move when the caret arrives on it", async () => {
  const { page, problems } = await openCard(SURFACES[0], "Quote under the caret");
  const text = "> a quoted line\n\nplain tail";
  try {
    await lay(page, text);
    await caretTo(page, 1);
    await settle(200);
    const hot = await wordsAt(page, "a quoted line");
    await caretTo(page, text.length);
    await settle(200);
    const cold = await wordsAt(page, "a quoted line");

    assert.ok(hot && cold, "the quoted line was not drawn at all");
    assert.ok(hot.width > 0 && hot.height > 0,
      "the drawn line was never laid out, so nothing was measured: " + JSON.stringify(hot));
    assert.ok(hot.quote && cold.quote, "the line lost its bar to the caret");
    assert.ok(hot.border >= 2 && cold.border >= 2,
      `the bar is ${hot.border}px with the caret on the line and ${cold.border}px without it`);
    assert.ok(!hot.source.startsWith(">"),
      "the raw angle came back under the caret: " + hot.source);
    assert.ok(Math.abs(hot.left - cold.left) <= EDGE,
      `the line's words start on ${hot.left.toFixed(2)} with the caret on the line and on ` +
      `${cold.left.toFixed(2)} without it, so the words step sideways under the caret`);
    for (const [where, read] of [["with the caret on it", hot], ["with the caret away", cold]])
      assert.ok(Math.abs(read.left - read.column) <= EDGE,
        `${where}: the words start on ${read.left.toFixed(2)} and the line's column is ` +
        `${read.column.toFixed(2)}`);
    assert.equal((await rowRead(page)).payload, text, "the row changed the markdown in it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("a quoted item's words keep one edge with the caret on the line", async () => {
  const { page, problems } = await openCard(SURFACES[1], "Quoted item under the caret");
  const text = "> - An ordinary quoted list item that wraps across several lines at this width.";
  try {
    await lay(page, text);
    await caretTo(page, 4);
    await settle(220);
    const item = await page.evaluate(() => {
      const line = document.querySelector("article.box.sel .cm-line");
      const words = line.querySelector(".cf-first");
      const rows = new Map();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let text; (text = walker.nextNode());) {
        if (text.parentElement.closest(".cf-mark")) continue;
        for (let index = 0; index < text.data.length; index++) {
          if (!text.data[index].trim()) continue;
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          for (const rect of range.getClientRects()) {
            if (rect.width < 0.01) continue;
            const row = Math.round(rect.top);
            if (!rows.has(row) || rect.left < rows.get(row)) rows.set(row, rect.left);
          }
        }
      }
      const style = getComputedStyle(line);
      const box = line.getBoundingClientRect();
      return {
        text: line.textContent,
        edges: [...rows.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]),
        column: box.left + (parseFloat(style.borderLeftWidth) || 0) +
          (parseFloat(style.paddingLeft) || 0),
        marker: line.querySelector(".cf-mark").getBoundingClientRect().toJSON(),
        firstWord: words ? words.textContent : null,
      };
    });
    assert.equal(item.text, "- An ordinary quoted list item that wraps across several lines " +
      "at this width.", "the angle was drawn beside the bar on the quoted item: " + item.text);
    assert.ok(item.edges.length >= 2,
      "the item did not wrap, so nothing was asked of the wrap: " + JSON.stringify(item.edges));
    for (const edge of item.edges.slice(1))
      assert.ok(Math.abs(edge - item.column) <= EDGE,
        `a wrapped row of the item starts at ${edge.toFixed(2)} and its column is ` +
        `${item.column.toFixed(2)}`);
    assert.ok(Math.abs(item.marker.left - (item.column - item.marker.width)) <= EDGE,
      "the marker is not seated on the column its words hang from");
    assert.equal(item.firstWord, "An", "the item's first word is not the one that may break");
    assert.equal((await rowRead(page)).payload, text, "the row changed the markdown in it");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});

test("an angle that is not a quote keeps every character it was typed with", async () => {
  const { page, problems } = await openCard(SURFACES[0], "Angles that are not quotes");
  try {
    await lay(page, LITERAL);
    await caretTo(page, 0);
    await settle(200);
    const read = await rowRead(page);
    assert.equal(read.payload, LITERAL, "the row changed the markdown in it");
    assert.equal(read.lines.filter(line => line.quote).length, 0,
      "something that is not a quote was drawn as one: " +
      JSON.stringify(read.lines.filter(line => line.quote).map(line => line.text)));
    assert.deepEqual(read.lines.map(line => line.text), LITERAL.split("\n"),
      "a character was taken out of a line nobody asked to format");
    assert.deepEqual(problems, []);
  } finally {
    await page.close();
  }
});
