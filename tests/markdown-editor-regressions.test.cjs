const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = process.env.FACILITATOR_TEST_ROOT
  ? path.resolve(process.env.FACILITATOR_TEST_ROOT)
  : path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let browser;
let server;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (pathname === "/" || pathname === "/index.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(await readFile(path.join(ROOT, "index.html")));
        return;
      }
      if (pathname === "/cm-markdown.js") {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(await readFile(path.join(ROOT, "cm-markdown.js")));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--disable-background-networking", "--no-first-run"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

async function mountedEditor(source, height = 520) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async (text, panelHeight) => {
    activeOwner = "triage";
    mdBoxes();
    const host = mdBuild(MD_MOUNTS.triage);
    host.style.left = "32px";
    host.style.top = "32px";
    host.style.width = "340px";
    host.style.height = panelHeight + "px";
    const loaded = await mdBundle();
    if (!loaded) throw new Error("CodeMirror bundle did not load");
    mdFor = "triage";
    mdOpen = { lane: "triage", root: "fixture-internal", rel: "fixture.md", mtime: "1" };
    mdClean = text;
    mdMount(host, text, false);
    host.classList.add("editing");
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, source, height);
  return page;
}

async function caretState(page) {
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const rect = value => value && ({
      left: value.left, top: value.top, right: value.right, bottom: value.bottom,
      width: value.width ?? value.right - value.left,
      height: value.height ?? value.bottom - value.top,
    });
    const selection = mdView.state.selection.main;
    const pos = selection.head;
    const caret = document.getElementById("fatcaret");
    const lift = document.getElementById("fatcaretlift");
    return {
      pos,
      assoc: selection.assoc,
      before: pos ? mdView.state.sliceDoc(pos - 1, pos) : null,
      after: pos < mdView.state.doc.length ? mdView.state.sliceDoc(pos, pos + 1) : null,
      source: mdView.state.sliceDoc(),
      minus: rect(mdView.coordsAtPos(pos, -1)),
      plus: rect(mdView.coordsAtPos(pos, 1)),
      caret: rect(caret.getBoundingClientRect()),
      lift: rect(lift.getBoundingClientRect()),
      line: rect(document.querySelector("#magic4 .cm-activeLine").getBoundingClientRect()),
      on: caret.classList.contains("on"),
      liftOn: lift.classList.contains("on"),
      formatting: Array.from(document.querySelectorAll(
        "#magic4 .cm-activeLine .cm-formatting-inline"
      )).map(mark => {
        const r = mark.getBoundingClientRect();
        const style = getComputedStyle(mark);
        return {
          text: mark.textContent,
          width: r.width,
          height: r.height,
          opacity: Number(style.opacity),
          textIndent: style.textIndent,
        };
      }),
    };
  });
}

async function setCursor(page, pos) {
  await page.evaluate(position => {
    mdView.focus();
    mdView.dispatch({ selection: { anchor: position } });
  }, pos);
  return caretState(page);
}

async function setCursorAssoc(page, pos, assoc) {
  await page.evaluate(({ position, association }) => {
    mdView.focus();
    const Selection = mdView.state.selection.constructor;
    mdView.dispatch({ selection: Selection.create([
      Selection.cursor(position, association),
    ]) });
    document.dispatchEvent(new Event("selectionchange"));
  }, { position: pos, association: assoc });
  return caretState(page);
}

async function arrowStates(page, start, key, count) {
  const states = [await setCursor(page, start)];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
    states.push(await caretState(page));
  }
  return states;
}

async function focusGeometry(source, needle) {
  const page = await mountedEditor(source);
  try {
    return await page.evaluate(async sought => {
      const position = mdView.state.sliceDoc().indexOf(sought) + 2;
      const read = {
        contentHeight: mdView.contentHeight,
        scrollHeight: mdView.scrollDOM.scrollHeight,
        gaps: document.querySelectorAll("#magic4 .md-gap").length,
      };
      mdView.focus();
      mdView.dispatch({ selection: { anchor: position } });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        read,
        focused: {
          contentHeight: mdView.contentHeight,
          scrollHeight: mdView.scrollDOM.scrollHeight,
          gaps: document.querySelectorAll("#magic4 .md-gap").length,
        },
      };
    }, needle);
  } finally {
    await page.close();
  }
}

test("soft source lines keep paragraph and list geometry on focus", async () => {
  const paragraph = [
    "This compact paragraph was wrapped in its source",
    "at several convenient editing columns even though",
    "Markdown renders those breaks as ordinary spaces.",
  ].join("\n");
  const list = [
    "- This list item was wrapped in its source at a",
    "  convenient editing column even though Markdown",
    "  renders the continuation as ordinary prose.",
  ].join("\n");
  const styledParagraph = [
    "This compact **paragraph** was wrapped in its source",
    "at several convenient editing columns even though",
    "Markdown renders those breaks as ordinary spaces.",
  ].join("\n");

  for (const [source, needle] of [
    [paragraph, "compact"], [list, "list item"], [styledParagraph, "paragraph"],
  ]) {
    const result = await focusGeometry(source, needle);
    assert.equal(result.focused.gaps, result.read.gaps,
      "focusing removed the soft-line join decorations");
    assert.ok(Math.abs(result.focused.contentHeight - result.read.contentHeight) < 0.5,
      `content height changed from ${result.read.contentHeight} to ${result.focused.contentHeight}`);
    assert.ok(Math.abs(result.focused.scrollHeight - result.read.scrollHeight) < 0.5,
      `scroll height changed from ${result.read.scrollHeight} to ${result.focused.scrollHeight}`);
  }
});

test("a joined soft break remains keyboard editable", async () => {
  const source = "The first source line\ncontinues on the second source line.";
  const page = await mountedEditor(source);
  try {
    const breakPosition = source.indexOf("\n");
    await page.evaluate(position => {
      mdView.focus();
      mdView.dispatch({ selection: { anchor: position + 1 } });
    }, breakPosition);
    await page.keyboard.press("Backspace");
    const edited = await page.evaluate(() => ({
      text: mdView.state.sliceDoc(),
      gaps: document.querySelectorAll("#magic4 .md-gap").length,
    }));
    assert.equal(edited.text, source.replace("\n", ""));
    assert.equal(edited.gaps, 0);
  } finally {
    await page.close();
  }
});

test("block caret uses CodeMirror coordinates at a bullet gap", async () => {
  const source = [
    "- alpha",
    "",
    ...Array.from({ length: 80 }, (_, i) =>
      `Padding paragraph ${i + 1} keeps the content taller than its scroller.`),
  ].join("\n\n");
  const page = await mountedEditor(source, 340);
  try {
    const result = await page.evaluate(async () => {
      mdView.focus();
      mdView.dispatch({ selection: { anchor: 1 } });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 350));
      const zeroSize = mdView.coordsAtPos(1);
      const expected = mdView.coordsAtPos(1, -1);
      const caret = document.getElementById("fatcaret");
      const drawn = caret.getBoundingClientRect();
      const clip = mdView.scrollDOM.getBoundingClientRect();
      const native = getSelection().rangeCount
        ? getSelection().getRangeAt(0).getBoundingClientRect()
        : null;
      return {
        on: caret.classList.contains("on"),
        expected: expected && {
          left: expected.left, top: expected.top,
          right: expected.right, bottom: expected.bottom,
        },
        zeroSizeHeight: zeroSize && zeroSize.bottom - zeroSize.top,
        drawn: { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height },
        clip: { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom },
        nativeHeight: native && native.height,
      };
    });

    assert.ok(result.expected && result.expected.bottom > result.expected.top,
      "CodeMirror did not return usable coordinates for the bullet gap");
    assert.equal(result.zeroSizeHeight, 0,
      "the fixture no longer exercises CodeMirror's zero-size default side");
    assert.equal(result.nativeHeight, 0,
      "the fixture no longer exercises Chrome's zero-height collapsed range");
    assert.equal(result.on, true, "the custom block caret is hidden");
    assert.ok(result.drawn.width > 0 && result.drawn.height > 0,
      "the custom block caret has no visible rectangle");
    assert.ok(Math.abs(result.drawn.left - result.expected.left) < 1.5,
      `caret x ${result.drawn.left} does not match CodeMirror x ${result.expected.left}`);
    assert.ok(result.drawn.top < result.clip.bottom &&
              result.drawn.top + result.drawn.height > result.clip.top,
      "the custom block caret falls outside the editor scroller");
  } finally {
    await page.close();
  }
});

test("ordered marker traversal draws both sides of its source space", async () => {
  const source = "1. Some written stuff";
  const page = await mountedEditor(source);
  try {
    const forward = await arrowStates(page, 0, "ArrowRight", 4);
    assert.deepEqual(forward.map(state => state.pos), [0, 1, 2, 3, 4]);
    assert.deepEqual(forward.slice(1, 4).map(state => [state.before, state.after]), [
      ["1", "."], [".", " "], [" ", "S"],
    ]);
    assert.equal(forward[3].minus.height, 0,
      "the fixture no longer crosses the zero-size marker gap");
    assert.ok(Math.abs(forward[2].caret.left - forward[2].minus.left) < 1.5,
      "the caret before the source space left the ordered marker");
    assert.ok(Math.abs(forward[3].caret.left - forward[3].plus.left) < 1.5,
      "the caret after the source space did not reach the item text");
    assert.ok(forward[3].caret.left - forward[2].caret.left > 4,
      "one ArrowRight left both sides of the source space on the same pixel");
    assert.ok(Math.abs(forward[3].caret.top - forward[2].caret.top) < 0.5,
      "crossing the source space moved the caret off its row");

    await page.keyboard.press("ArrowLeft");
    const backwardText = await caretState(page);
    await page.keyboard.press("ArrowLeft");
    const backwardMarker = await caretState(page);
    assert.equal(backwardText.pos, 3);
    assert.equal(backwardMarker.pos, 2);
    assert.ok(Math.abs(backwardText.caret.left - forward[3].caret.left) < 1.5);
    assert.ok(Math.abs(backwardMarker.caret.left - forward[2].caret.left) < 1.5);

    const textEdge = await page.evaluate(() => mdView.coordsAtPos(3, 1));
    await page.mouse.click(textEdge.left + 1, (textEdge.top + textEdge.bottom) / 2);
    const clicked = await caretState(page);
    assert.equal(clicked.pos, 3, "clicking the first letter did not choose its leading edge");
    assert.ok(Math.abs(clicked.caret.left - textEdge.left) < 1.5,
      "the clicked caret did not draw on the selected text edge");
    assert.equal(clicked.source, source);
    await page.keyboard.press("Backspace");
    assert.equal(await page.evaluate(() => mdView.state.sliceDoc()),
      "Some written stuff", "CodeMirror's list-unwrapping edit stopped working");
  } finally {
    await page.close();
  }
});

test("bullet and ordered marker gaps traverse in either direction", async () => {
  const cases = [
    { name: "bullet", source: "- Bullet item", markerEnd: 1, textStart: 2 },
    { name: "multi-digit", source: "10. Tenth item", markerEnd: 3, textStart: 4 },
    { name: "start value", source: "42. Forty-second item", markerEnd: 3, textStart: 4 },
    { name: "parenthesis", source: "3) Third item", markerEnd: 2, textStart: 3 },
  ];
  for (const fixture of cases) {
    const page = await mountedEditor(fixture.source);
    try {
      assert.equal(fixture.source.slice(fixture.markerEnd, fixture.textStart), " ");
      const forward = await arrowStates(page, fixture.markerEnd, "ArrowRight", 1);
      assert.equal(forward[1].pos, fixture.textStart, `${fixture.name} skipped a source position`);
      assert.ok(forward[1].on, `${fixture.name} hid the custom caret`);
      assert.ok(Math.abs(forward[1].caret.left - forward[1].plus.left) < 1.5,
        `${fixture.name} did not reach the item text after its source space`);
      assert.ok(forward[1].caret.left - forward[0].caret.left > 4,
        `${fixture.name} left both space boundaries on the same pixel`);

      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      const backward = await caretState(page);
      assert.equal(backward.pos, fixture.textStart);
      assert.ok(Math.abs(backward.caret.left - forward[1].caret.left) < 1.5,
        `${fixture.name} drew different forward and backward text edges`);
      assert.equal(backward.source, fixture.source);
    } finally {
      await page.close();
    }
  }
});

test("zero-size list whitespace keeps every editable cursor stop visible", async () => {
  const gapSource = "1.   Some written stuff";
  const gapPage = await mountedEditor(gapSource);
  try {
    const gaps = await arrowStates(gapPage, 2, "ArrowRight", 3);
    assert.deepEqual(gaps.map(state => state.pos), [2, 3, 4, 5]);
    assert.equal(gapSource.slice(2, 5), "   ");
    for (let i = 1; i < gaps.length; i++) {
      assert.ok(gaps[i].caret.left > gaps[i - 1].caret.left,
        `separator stop ${gaps[i].pos} did not advance`);
      assert.ok(Math.abs(gaps[i].caret.top - gaps[0].caret.top) < 0.5,
        `separator stop ${gaps[i].pos} left its row`);
    }
    assert.ok(Math.abs(gaps[0].caret.left - gaps[0].minus.left) < 1.5);
    assert.ok(Math.abs(gaps[3].caret.left - gaps[3].plus.left) < 1.5);
    assert.equal(gaps[3].source, gapSource);
  } finally {
    await gapPage.close();
  }

  const nestedCases = [
    { source: "1. Parent item\n   7. Nested item", lineStart: 15, indent: 3 },
    { source: "- Parent item\n  - Nested item", lineStart: 14, indent: 2 },
  ];
  for (const fixture of nestedCases) {
    const page = await mountedEditor(fixture.source);
    try {
      const right = await arrowStates(page, fixture.lineStart, "ArrowRight", fixture.indent);
      assert.deepEqual(right.map(state => state.pos),
        Array.from({ length: fixture.indent + 1 }, (_, i) => fixture.lineStart + i));
      const indentBox = await page.evaluate(() => {
        const r = document.querySelector("#magic4 .md-li-ind").getBoundingClientRect();
        return { left: r.left, right: r.right };
      });
      assert.ok(Math.abs(right[0].caret.left - indentBox.left) < 1.5);
      assert.ok(Math.abs(right[right.length - 1].caret.left - indentBox.right) < 1.5);
      for (let i = 1; i < right.length; i++) {
        assert.ok(right[i].caret.left > right[i - 1].caret.left,
          `nested indent stop ${right[i].pos} did not advance`);
        assert.ok(Math.abs(right[i].caret.top - right[0].caret.top) < 0.5,
          `nested indent stop ${right[i].pos} left its row`);
      }

      const left = [await caretState(page)];
      for (let i = 0; i < fixture.indent; i++) {
        await page.keyboard.press("ArrowLeft");
        left.push(await caretState(page));
      }
      assert.deepEqual(left.map(state => state.pos), right.map(state => state.pos).reverse());
      assert.deepEqual(left.map(state => state.caret.left),
        right.map(state => state.caret.left).reverse());

      const textStart = fixture.source.indexOf("Nested");
      await setCursor(page, textStart + 2);
      await page.keyboard.press("Home");
      const textHome = await caretState(page);
      await page.keyboard.press("Home");
      const lineHome = await caretState(page);
      await page.keyboard.press("End");
      const lineEnd = await caretState(page);
      assert.equal(textHome.pos, fixture.lineStart + fixture.indent);
      assert.equal(lineHome.pos, fixture.lineStart);
      assert.equal(lineEnd.pos, fixture.source.length);
      assert.ok(Math.abs(textHome.caret.left - indentBox.right) < 1.5);
      assert.ok(Math.abs(lineHome.caret.left - indentBox.left) < 1.5);
      assert.ok(Math.abs(lineEnd.caret.top - lineHome.caret.top) < 0.5);
      assert.equal(lineEnd.source, fixture.source);
    } finally {
      await page.close();
    }
  }
});

test("leading bold list syntax traverses every source position symmetrically", async () => {
  const cases = [
    { name: "ordered", source: "1. **Some written stuff**" },
    { name: "bullet", source: "- **Some written stuff**" },
    { name: "multi-digit", source: "123. **Some written stuff**" },
    { name: "nested", source: "1. Parent\n   - **Some written stuff**", lineStart: 10 },
  ];

  for (const fixture of cases) {
    const page = await mountedEditor(fixture.source);
    try {
      const lineStart = fixture.lineStart || 0;
      const boldStart = fixture.source.indexOf("**", lineStart);
      const boldClose = fixture.source.indexOf("**", boldStart + 2);
      const parsed = await page.evaluate(() => Array.from(document.querySelectorAll(
        "#magic4 .cm-formatting-inline"
      )).map(mark => mark.textContent));
      assert.deepEqual(parsed, ["**", "**"],
        `${fixture.name} did not parse one strong construct`);

      await setCursor(page, lineStart);
      await new Promise(resolve => setTimeout(resolve, 250));
      const forward = [await caretState(page)];
      for (let pos = lineStart; pos < fixture.source.length; pos++) {
        await page.keyboard.press("ArrowRight");
        forward.push(await caretState(page));
      }
      assert.deepEqual(forward.map(state => state.pos),
        Array.from({ length: fixture.source.length - lineStart + 1 },
          (_, i) => lineStart + i),
        `${fixture.name} skipped an editable source position moving right`);

      for (let i = 0; i < forward.length; i++) {
        const state = forward[i];
        assert.equal(state.source, fixture.source,
          `${fixture.name} traversal changed the Markdown source`);
        assert.equal(state.formatting.length, 2,
          `${fixture.name} did not reveal both delimiters as one active construct`);
        assert.ok(state.formatting.every(mark => mark.text === "**" &&
          mark.width > 8 && mark.height > 0 && mark.opacity === 1 &&
          mark.textIndent === "0px"),
        `${fixture.name} left a strong delimiter collapsed inside the hanging indent`);
        assert.equal(state.on, true, `${fixture.name} hid the primary block cursor`);
        assert.equal(state.liftOn, true, `${fixture.name} hid the lifted block cursor`);
        for (const edge of ["left", "top", "width", "height"])
          assert.ok(Math.abs(state.caret[edge] - state.lift[edge]) < 0.1,
            `${fixture.name} cursor layers disagree at ${state.pos}`);
        if (i) {
          assert.ok(state.caret.left > forward[i - 1].caret.left + 0.2,
            `${fixture.name} source stop ${state.pos} did not advance to the right`);
          const rowOverlap = Math.min(state.caret.bottom, forward[0].caret.bottom) -
            Math.max(state.caret.top, forward[0].caret.top);
          assert.ok(rowOverlap > Math.min(state.caret.height,
            forward[0].caret.height) * 0.75,
          `${fixture.name} source stop ${state.pos} left its row`);
        }
        assert.ok(state.caret.top >= state.line.top - 0.5 &&
          state.caret.bottom <= state.line.bottom + 0.5,
        `${fixture.name} source stop ${state.pos} crossed its line bounds`);
      }

      const syntaxStops = [boldStart, boldStart + 1, boldStart + 2,
        boldClose, boldClose + 1, boldClose + 2];
      for (const pos of syntaxStops) {
        const state = forward[pos - lineStart];
        assert.ok(state.minus && state.plus &&
          Math.max(state.minus.height, state.plus.height) > 0,
        `${fixture.name} source stop ${pos} has no two-sided CodeMirror rectangle`);
        if (pos !== boldStart)
          assert.ok(state.minus.height > 0 && state.plus.height > 0,
            `${fixture.name} delimiter interior ${pos} lost a full-height side`);
      }

      const backward = [forward.at(-1)];
      for (let pos = fixture.source.length; pos > lineStart; pos--) {
        await page.keyboard.press("ArrowLeft");
        backward.push(await caretState(page));
      }
      assert.deepEqual(backward.map(state => state.pos),
        forward.map(state => state.pos).reverse(),
        `${fixture.name} skipped an editable source position moving left`);
      for (let i = 0; i < backward.length; i++) {
        const matching = forward[forward.length - 1 - i];
        assert.ok(Math.abs(backward[i].caret.left - matching.caret.left) < 1.5,
          `${fixture.name} draws position ${backward[i].pos} differently by direction`);
        if (syntaxStops.includes(backward[i].pos))
          assert.deepEqual(backward[i].caret, matching.caret,
            `${fixture.name} changes the block at syntax seam ${backward[i].pos}`);
        assert.equal(backward[i].source, fixture.source);
      }
    } finally {
      await page.close();
    }
  }
});

test("shared inline delimiter seams have direction-independent block geometry", async () => {
  for (const fixture of [
    { name: "emphasis", source: "- *emphasis*", delimiter: "*" },
    { name: "strikethrough", source: "1. ~~struck~~", delimiter: "~~" },
    { name: "after-closing", source: "- **bold** after", delimiter: "**" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const syntaxStart = fixture.source.indexOf(fixture.delimiter);
      const syntaxClose = fixture.source.indexOf(fixture.delimiter,
        syntaxStart + fixture.delimiter.length);
      await setCursor(page, 0);
      await new Promise(resolve => setTimeout(resolve, 250));
      const forward = [await caretState(page)];
      for (let pos = 0; pos < fixture.source.length; pos++) {
        await page.keyboard.press("ArrowRight");
        forward.push(await caretState(page));
      }
      const backward = [forward.at(-1)];
      for (let pos = fixture.source.length; pos > 0; pos--) {
        await page.keyboard.press("ArrowLeft");
        backward.push(await caretState(page));
      }
      const reverseAt = new Map(backward.map(state => [state.pos, state]));
      const seams = [];
      for (let i = 0; i <= fixture.delimiter.length; i++) {
        seams.push(syntaxStart + i, syntaxClose + i);
      }
      for (const pos of new Set(seams)) {
        const right = forward[pos];
        const left = reverseAt.get(pos);
        assert.deepEqual(left.caret, right.caret,
          `${fixture.name} changes the block at syntax seam ${pos}`);
        assert.equal(left.source, fixture.source);
        assert.equal(right.source, fixture.source);
        assert.ok(right.formatting.every(mark => mark.width > 4 &&
          mark.textIndent === "0px"),
        `${fixture.name} delimiter stayed collapsed in its list hang`);
      }
    } finally {
      await page.close();
    }
  }
});

test("inline delimiter seams preserve horizontally separate bidi affinity", async () => {
  for (const fixture of [
    { name: "one RTL grapheme", source: "1. **א** tail" },
    { name: "RTL run", source: "- **שלום** tail" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const contentStart = fixture.source.indexOf("**") + 2;
      await setCursor(page, contentStart);
      await new Promise(resolve => setTimeout(resolve, 250));
      const before = await setCursorAssoc(page, contentStart, -1);
      const after = await setCursorAssoc(page, contentStart, 1);
      const overlap = Math.min(before.minus.bottom, before.plus.bottom) -
        Math.max(before.minus.top, before.plus.top);
      assert.ok(overlap > Math.min(before.minus.height, before.plus.height) * 0.5,
        `${fixture.name} no longer exercises same-row bidi sites`);
      assert.ok(Math.abs(before.plus.left - before.minus.left) > 2.5,
        `${fixture.name} no longer exercises horizontally separate bidi sites`);
      assert.equal(before.assoc, -1);
      assert.equal(after.assoc, 1);
      assert.equal(before.caret.left, before.minus.left,
        `${fixture.name} lost its -1 visual affinity`);
      assert.equal(after.caret.left, after.plus.left,
        `${fixture.name} lost its +1 visual affinity`);
      assert.notEqual(before.caret.left, after.caret.left,
        `${fixture.name} bidi sites were incorrectly merged`);
      assert.equal(before.source, fixture.source);
      assert.equal(after.source, fixture.source);
    } finally {
      await page.close();
    }
  }
});

test("split-row delimiter seams retain wrap affinity and in-flow reveal", async () => {
  const page = await mountedEditor("1. **WWWW**");
  try {
    await setCursor(page, 0);
    await new Promise(resolve => setTimeout(resolve, 250));
    const fixture = await page.evaluate(async () => {
      const host = document.getElementById("magic4");
      host.style.width = "210px";
      mdView.requestMeasure();
      const settle = () => new Promise(resolve => setTimeout(resolve, 60));
      await settle();
      for (let count = 4; count <= 50; count++) {
        const source = `1. **${"W".repeat(count)}**`;
        mdView.dispatch({
          changes: { from: 0, to: mdView.state.doc.length, insert: source },
          selection: { anchor: 0 },
        });
        await settle();
        const seam = source.lastIndexOf("**");
        const minus = mdView.coordsAtPos(seam, -1);
        const plus = mdView.coordsAtPos(seam, 1);
        const overlap = Math.min(minus.bottom, plus.bottom) -
          Math.max(minus.top, plus.top);
        if (minus.bottom > minus.top && plus.bottom > plus.top && overlap <= 0)
          return { source, seam };
      }
      return null;
    });
    assert.ok(fixture, "could not place a formatting seam across a real wrap");

    await setCursor(page, fixture.seam - 1);
    await page.keyboard.press("ArrowRight");
    const forward = await caretState(page);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    const backward = await caretState(page);
    assert.equal(forward.pos, fixture.seam);
    assert.equal(backward.pos, fixture.seam);
    assert.equal(forward.assoc, -1);
    assert.equal(backward.assoc, 1);
    const rowOverlap = Math.min(forward.minus.bottom, forward.plus.bottom) -
      Math.max(forward.minus.top, forward.plus.top);
    assert.ok(rowOverlap <= 0, "the fixture no longer has two wrapped caret rows");
    assert.equal(forward.caret.left, forward.minus.left,
      "forward traversal lost the delimiter's preceding-row affinity");
    assert.equal(backward.caret.left, backward.plus.left,
      "backward traversal lost the delimiter's following-row affinity");
    assert.notEqual(forward.caret.top, backward.caret.top,
      "a true wrapped boundary was incorrectly collapsed to one row");

    const reveal = await page.evaluate(async () => {
      const settle = () => new Promise(resolve => setTimeout(resolve, 250));
      const source = mdView.state.sliceDoc();
      const line = () => document.querySelector("#magic4 .cm-activeLine")
        .getBoundingClientRect().height;
      const shown = line();
      const suppress = document.createElement("style");
      suppress.textContent = "#magic4 .cm-formatting-inline{" +
        "max-width:0!important;opacity:0!important;margin:0!important}";
      document.head.appendChild(suppress);
      mdView.requestMeasure();
      await settle();
      const hidden = line();
      suppress.remove();
      mdView.requestMeasure();
      await settle();
      return { source, shown, hidden, restored: line() };
    });
    assert.equal(reveal.source, fixture.source,
      "revealing wrapped syntax changed the Markdown source");
    assert.ok(reveal.shown - reveal.hidden > 10,
      "the fixture no longer records the accepted in-flow reveal row");
    assert.ok(Math.abs(reveal.restored - reveal.shown) < 0.5,
      "active delimiter geometry did not restore after the reveal check");
  } finally {
    await page.close();
  }
});

test("leading bold list clicks resolve delimiter and text boundaries", async () => {
  for (const fixture of [
    { name: "ordered", source: "1. **Some written stuff**" },
    { name: "bullet", source: "- **Some written stuff**" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const boldStart = fixture.source.indexOf("**");
      const firstLetter = boldStart + 2;
      const boldClose = fixture.source.indexOf("**", firstLetter);
      await setCursor(page, firstLetter);
      await new Promise(resolve => setTimeout(resolve, 250));

      for (const pos of [boldStart, boldStart + 1, firstLetter,
        boldClose, boldClose + 1, boldClose + 2]) {
        const target = await page.evaluate(position => {
          const end = mdView.state.doc.length;
          const side = position === end ? -1 : 1;
          const r = mdView.coordsAtPos(position, side);
          return { x: r.left + (position === end ? -0.5 : 0.5),
            y: (r.top + r.bottom) / 2 };
        }, pos);
        await page.mouse.click(target.x, target.y);
        const clicked = await caretState(page);
        assert.equal(clicked.pos, pos,
          `${fixture.name} click missed source position ${pos}`);
        assert.equal(clicked.source, fixture.source,
          `${fixture.name} click changed the Markdown source`);
        assert.ok(Math.abs(clicked.caret.left -
          (pos === fixture.source.length ? target.x + 0.5 : target.x - 0.5)) < 1.5,
        `${fixture.name} block cursor did not follow click ${pos}`);
      }
    } finally {
      await page.close();
    }
  }
});

test("leading bold list delimiters remain ordinary editable source", async () => {
  for (const fixture of [
    { name: "ordered", source: "1. **Some written stuff**" },
    { name: "bullet", source: "- **Some written stuff**" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const boldStart = fixture.source.indexOf("**");
      const firstLetter = boldStart + 2;
      const boldClose = fixture.source.indexOf("**", firstLetter);
      const operations = [
        { pos: boldStart, key: "Delete", removed: boldStart },
        { pos: boldStart + 1, key: "Backspace", removed: boldStart },
        { pos: firstLetter, key: "Backspace", removed: firstLetter - 1 },
        { pos: boldClose, key: "Delete", removed: boldClose },
        { pos: boldClose + 1, key: "Backspace", removed: boldClose },
        { pos: boldClose + 2, key: "Backspace", removed: boldClose + 1 },
      ];

      for (const operation of operations) {
        await setCursor(page, operation.pos);
        await page.keyboard.press(operation.key);
        const expected = fixture.source.slice(0, operation.removed) +
          fixture.source.slice(operation.removed + 1);
        assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), expected,
          `${fixture.name} ${operation.key} did not edit delimiter source normally`);
        await page.keyboard.down("Meta");
        await page.keyboard.press("z");
        await page.keyboard.up("Meta");
        assert.equal(await page.evaluate(() => mdView.state.sliceDoc()), fixture.source,
          `${fixture.name} undo did not restore delimiter source`);
      }
    } finally {
      await page.close();
    }
  }
});
