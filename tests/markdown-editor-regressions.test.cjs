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
      if (pathname === "/card-markdown.js") {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(await readFile(path.join(ROOT, "card-markdown.js")));
        return;
      }
      if (pathname === "/card-tokens.css") {
        res.setHeader("content-type", "text/css; charset=utf-8");
        res.end(await readFile(path.join(ROOT, "card-tokens.css")));
        return;
      }
      if (pathname === "/card-logic.js") {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(await readFile(path.join(ROOT, "card-logic.js")));
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
    activeOwner = "pastureland";
    mdBoxes();
    const host = mdBuild(MD_MOUNTS.pastureland);
    host.style.left = "32px";
    host.style.top = "32px";
    host.style.width = "340px";
    host.style.height = panelHeight + "px";
    const loaded = await mdBundle();
    if (!loaded) throw new Error("CodeMirror bundle did not load");
    mdFor = "pastureland";
    mdOpen = { lane: "pastureland", root: "fixture-internal", rel: "fixture.md", mtime: "1" };
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
    const source = mdView.state.sliceDoc();
    const lineDoc = mdView.state.doc.lineAt(pos);
    let grapheme = "";
    try {
      const tail = lineDoc.text.slice(pos - lineDoc.from);
      grapheme = new Intl.Segmenter(undefined, { granularity: "grapheme" })
        .segment(tail)[Symbol.iterator]().next().value?.segment || "";
    } catch (error) {
      grapheme = source.slice(pos, pos + 1);
    }
    let nextRange = null;
    if (grapheme && !/[\r\n]/.test(grapheme)) {
      try {
        const start = mdView.domAtPos(pos);
        const end = mdView.domAtPos(pos + grapheme.length);
        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);
        const visible = Array.from(range.getClientRects())
          .filter(value => value.width > 0 && value.height > 0)
          .map(rect);
        if (visible.length === 1) nextRange = visible[0];
      } catch (error) {}
    }
    const caret = document.getElementById("fatcaret");
    const lift = document.getElementById("fatcaretlift");
    return {
      pos,
      assoc: selection.assoc,
      before: pos ? mdView.state.sliceDoc(pos - 1, pos) : null,
      after: pos < mdView.state.doc.length ? mdView.state.sliceDoc(pos, pos + 1) : null,
      source,
      grapheme,
      nextRange,
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

async function listLayoutState(page, textStart, markerIndex = 0) {
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(({ position, index }) => {
    const rect = value => value && ({
      left: value.left, top: value.top, right: value.right, bottom: value.bottom,
      width: value.width ?? value.right - value.left,
      height: value.height ?? value.bottom - value.top,
    });
    const mark = document.querySelectorAll("#magic4 .md-li-mark")[index];
    if (!mark) return null;
    const marker = mark.getBoundingClientRect();
    const raw = mark.querySelector(".cm-formatting-block");
    const rawRect = rect(raw && raw.getBoundingClientRect());
    const gapBox = mark.querySelector(".md-li-gap");
    const text = mdView.coordsAtPos(position, 1);
    let ink;
    if (mark.classList.contains("md-li-dot")) {
      const pseudo = getComputedStyle(mark, "::before");
      const width = parseFloat(pseudo.width);
      const left = pseudo.left === "auto"
        ? marker.width - parseFloat(pseudo.right) - width
        : parseFloat(pseudo.left);
      ink = { left: marker.left + left, right: marker.left + left + width,
        width, top: marker.top + parseFloat(pseudo.top) + parseFloat(pseudo.marginTop) };
    } else {
      ink = rawRect;
    }
    const line = mark.closest(".cm-line").getBoundingClientRect();
    return {
      marker: rect(marker),
      raw: rawRect,
      gapBox: rect(gapBox && gapBox.getBoundingClientRect()),
      ink,
      text: rect(text),
      gap: text.left - ink.right,
      sourceGap: rawRect ? text.left - rawRect.right : null,
      line: rect(line),
      contentHeight: mdView.contentHeight,
    };
  }, { position: textStart, index: markerIndex });
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

test("list typing keeps one baseline and production marker air", async () => {
  const page = await mountedEditor("");
  try {
    await setCursor(page, 0);
    const typed = [];
    for (const character of ["-", " ", "S", "o", "m", "e"]) {
      await page.keyboard.type(character);
      typed.push(await caretState(page));
    }
    assert.equal(typed.at(-1).source, "- Some");
    for (const state of typed) {
      assert.ok(Math.abs(state.line.top - typed[0].line.top) < 0.25,
        `typing ${JSON.stringify(state.source)} moved the list row vertically`);
      assert.ok(Math.abs(state.line.height - typed[0].line.height) < 0.25,
        `typing ${JSON.stringify(state.source)} changed the list line height`);
      assert.ok(Math.abs(state.caret.top - typed[0].caret.top) < 0.25,
        `typing ${JSON.stringify(state.source)} shifted the block cursor vertically`);
      assert.ok(Math.abs(state.caret.height - typed[0].caret.height) < 0.25,
        `typing ${JSON.stringify(state.source)} changed the block cursor height`);
    }

    const right = await arrowStates(page, 0, "ArrowRight", 6);
    const left = [right.at(-1)];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowLeft");
      left.push(await caretState(page));
    }
    assert.deepEqual(right.map(state => state.pos), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(left.map(state => state.pos), [6, 5, 4, 3, 2, 1, 0]);
    for (const state of [...right, ...left]) {
      assert.ok(Math.abs(state.caret.top - typed[0].caret.top) < 0.25,
        `source stop ${state.pos} shifted the block cursor vertically`);
      assert.ok(Math.abs(state.line.height - typed[0].line.height) < 0.25,
        `source stop ${state.pos} changed the list line height`);
    }

    const layout = await listLayoutState(page, 2);
    assert.ok(Math.abs(layout.gap - 7) < 0.75,
      `bullet ink left ${layout.gap.toFixed(2)}px before text instead of 7px`);
  } finally {
    await page.close();
  }

  const fixtures = [
    { name: "star bullet", source: "* Some", textStart: 2 },
    { name: "plus bullet", source: "+ Some", textStart: 2 },
    { name: "ordered", source: "1. Some", textStart: 3 },
    { name: "multi-digit", source: "123. Some", textStart: 5 },
    // An active inline delimiter carries its established 1px reveal margin.
    { name: "leading bold", source: "- **Some**", textStart: 2, expectedGap: 8 },
    { name: "nested", source: "1. Parent\n   - Nested", textStart: 15, markerIndex: 1 },
  ];
  for (const fixture of fixtures) {
    const fixturePage = await mountedEditor(fixture.source);
    try {
      await setCursor(fixturePage, fixture.textStart);
      const layout = await listLayoutState(
        fixturePage, fixture.textStart, fixture.markerIndex || 0);
      assert.ok(layout, `${fixture.name} did not render a list marker`);
      const expectedGap = fixture.expectedGap || 7;
      assert.ok(Math.abs(layout.gap - expectedGap) < 0.75,
        `${fixture.name} left ${layout.gap.toFixed(2)}px before text instead of ${expectedGap}px`);
    } finally {
      await fixturePage.close();
    }
  }

  for (const fixture of [
    { name: "wrapped", source: `- ${"wide words ".repeat(18)}`, start: 0, count: 8, width: 210 },
    { name: "RTL", source: "- שלום עולם", start: 0, count: 7 },
  ]) {
    const fixturePage = await mountedEditor(fixture.source);
    try {
      if (fixture.width) await fixturePage.evaluate(width => {
        document.getElementById("magic4").style.width = width + "px";
        mdView.requestMeasure();
      }, fixture.width);
      const states = await arrowStates(
        fixturePage, fixture.start, "ArrowRight", fixture.count);
      for (const state of states) {
        assert.ok(Math.abs(state.caret.top - states[0].caret.top) < 0.25,
          `${fixture.name} source stop ${state.pos} shifted the cursor vertically`);
        assert.ok(Math.abs(state.line.top - states[0].line.top) < 0.25,
          `${fixture.name} source stop ${state.pos} left the first visual row`);
      }
    } finally {
      await fixturePage.close();
    }
  }
});

test("list syntax stays on the exact body-font baseline", async () => {
  for (const fixture of [
    { name: "bullet", source: "- **Some**" },
    { name: "ordered", source: "1. **Some**" },
    { name: "multi-digit", source: "123. **Some**" },
    { name: "nested", source: "1. Parent\n   - **Some**" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const lineStart = fixture.source.lastIndexOf("\n") + 1;
      const body = fixture.source.indexOf("Some", lineStart);
      await setCursor(page, body);
      await new Promise(resolve => setTimeout(resolve, 250));
      const forward = await arrowStates(
        page, lineStart, "ArrowRight", fixture.source.length - lineStart);
      assert.deepEqual(forward.map(state => state.pos),
        Array.from({ length: fixture.source.length - lineStart + 1 },
          (_, index) => lineStart + index),
        `${fixture.name} skipped a source position moving right`);
      const reference = forward[body - lineStart];
      for (const state of forward) {
        assert.ok(Math.abs(state.caret.top - reference.caret.top) <= 0.5,
          `${fixture.name} position ${state.pos} moved the block top by ` +
          `${(state.caret.top - reference.caret.top).toFixed(2)}px`);
        assert.ok(Math.abs(state.caret.bottom - reference.caret.bottom) <= 0.5,
          `${fixture.name} position ${state.pos} moved the block bottom by ` +
          `${(state.caret.bottom - reference.caret.bottom).toFixed(2)}px`);
        assert.ok(Math.abs(state.line.top - reference.line.top) <= 0.25 &&
          Math.abs(state.line.height - reference.line.height) <= 0.25,
        `${fixture.name} position ${state.pos} changed its visual row`);
      }

      const backward = [forward.at(-1)];
      for (let pos = fixture.source.length; pos > lineStart; pos--) {
        await page.keyboard.press("ArrowLeft");
        backward.push(await caretState(page));
      }
      assert.deepEqual(backward.map(state => state.pos),
        forward.map(state => state.pos).reverse(),
        `${fixture.name} skipped a source position moving left`);
      for (const state of backward) {
        assert.ok(Math.abs(state.caret.top - reference.caret.top) <= 0.5 &&
          Math.abs(state.caret.bottom - reference.caret.bottom) <= 0.5,
        `${fixture.name} position ${state.pos} changed baseline moving left`);
      }
    } finally {
      await page.close();
    }
  }
});

test("list marker source, paint, separator, and clicks share one slot", async () => {
  for (const marker of ["-", "*", "+"]) {
    const source = `${marker} Some`;
    const page = await mountedEditor(source);
    try {
      await setCursor(page, 2);
      const layout = await listLayoutState(page, 2);
      assert.ok(layout && layout.raw, `${marker} has no measurable source marker`);
      assert.ok(Math.abs(layout.raw.right - layout.ink.right) <= 0.75,
        `${marker} source ends ${Math.abs(layout.raw.right - layout.ink.right).toFixed(2)}px ` +
        "from its painted dot");
      assert.ok(Math.abs(layout.sourceGap - 7) <= 0.75,
        `${marker} source leaves ${layout.sourceGap.toFixed(2)}px before text`);

      const start = await setCursor(page, 0);
      const end = await setCursor(page, 1);
      assert.ok(Math.abs(start.caret.left - layout.raw.left) <= 1.5,
        `${marker} start caret does not meet the visible source slot`);
      assert.ok(Math.abs(end.caret.left - layout.raw.right) <= 1.5,
        `${marker} end caret does not meet the painted marker edge`);

      const y = (layout.raw.top + layout.raw.bottom) / 2;
      await page.mouse.click(layout.raw.left + 0.5, y);
      const clickedStart = await caretState(page);
      assert.equal(clickedStart.pos, 0, `${marker} source-start click missed position 0`);
      assert.ok(Math.abs(clickedStart.caret.left - layout.raw.left) <= 1.5);

      await page.mouse.click((layout.ink.left + layout.ink.right) / 2, y);
      const clickedInk = await caretState(page);
      assert.equal(clickedInk.pos, 1, `${marker} painted marker click missed its source end`);
      assert.ok(Math.abs(clickedInk.caret.left - layout.raw.right) <= 1.5);

      await page.mouse.click(layout.text.left + 0.5, y);
      const clickedText = await caretState(page);
      assert.equal(clickedText.pos, 2, `${marker} separator click missed the text edge`);
      assert.ok(Math.abs(clickedText.caret.left - layout.text.left) <= 1.5);
    } finally {
      await page.close();
    }
  }

  const mixedSource = "1. Short\n123. Long";
  const mixedPage = await mountedEditor(mixedSource);
  try {
    const short = await listLayoutState(mixedPage, mixedSource.indexOf("Short"), 0);
    const long = await listLayoutState(mixedPage, mixedSource.indexOf("Long"), 1);
    assert.ok(Math.abs(short.marker.width - long.marker.width) <= 0.25,
      "ordered siblings stopped sharing their widest marker column");
    for (const [name, layout] of [["1.", short], ["123.", long]]) {
      assert.ok(Math.abs(layout.sourceGap - 7) <= 0.75,
        `${name} leaves ${layout.sourceGap.toFixed(2)}px before text in a shared column`);
      assert.ok(Math.abs(layout.raw.right - layout.text.left + 7) <= 0.75,
        `${name} source is not right-aligned before the separator`);
    }
    assert.ok(Math.abs(short.raw.right - long.raw.right) <= 0.75,
      "ordered siblings do not end on one marker edge");
  } finally {
    await mixedPage.close();
  }

  const boldPage = await mountedEditor("- **Some**");
  try {
    await setCursor(boldPage, 2);
    const layout = await listLayoutState(boldPage, 2);
    assert.ok(Math.abs(layout.sourceGap - 8) <= 0.75,
      `leading bold leaves ${layout.sourceGap.toFixed(2)}px instead of its 7px air + 1px reveal`);
  } finally {
    await boldPage.close();
  }

  const nestedSource = "1. Parent\n   - Nested";
  const nestedPage = await mountedEditor(nestedSource);
  try {
    const lineStart = nestedSource.lastIndexOf("\n") + 1;
    const markerStart = nestedSource.indexOf("-", lineStart);
    const textStart = nestedSource.indexOf("Nested");
    await setCursor(nestedPage, textStart);
    const layout = await listLayoutState(nestedPage, textStart, 1);
    assert.ok(Math.abs(layout.raw.right - layout.ink.right) <= 0.75);
    assert.ok(Math.abs(layout.sourceGap - 7) <= 0.75);
    const indent = await arrowStates(
      nestedPage, lineStart, "ArrowRight", markerStart - lineStart);
    assert.equal(indent.at(-1).pos, markerStart);
    assert.ok(Math.abs(indent.at(-1).caret.left - layout.raw.left) <= 1.5,
      "nested indent endpoint does not reach the real marker start");
    for (let index = 1; index < indent.length; index++) {
      assert.ok(indent[index].caret.left > indent[index - 1].caret.left,
        `nested indent position ${indent[index].pos} did not advance`);
    }
  } finally {
    await nestedPage.close();
  }
});

test("RTL list blocks cover only the selected next grapheme", async () => {
  const plain = await mountedEditor("- שלום");
  try {
    for (const pos of [2, 3, 4, 5]) {
      const state = await setCursorAssoc(plain, pos, 1);
      assert.ok(state.nextRange, `plain RTL position ${pos} has no grapheme range`);
      assert.ok(Math.abs(state.plus.left - state.nextRange.right) <= 1.5,
        `plain RTL position ${pos} no longer has a right-edge logical start`);
      assert.ok(Math.abs(state.caret.left - state.nextRange.left) <= 1,
        `plain RTL position ${pos} starts outside its next grapheme`);
      assert.ok(Math.abs(state.caret.width - state.nextRange.width) <= 1,
        `plain RTL position ${pos} does not cover exactly one grapheme`);
      assert.ok(Math.abs(state.caret.right - state.plus.left) <= 1.5,
        `plain RTL position ${pos} lost its selected insertion edge`);
    }
  } finally {
    await plain.close();
  }

  for (const fixture of [
    { name: "RTL run", source: "- **שלום** tail" },
    { name: "one RTL grapheme", source: "1. **א** tail" },
  ]) {
    const page = await mountedEditor(fixture.source);
    try {
      const contentStart = fixture.source.indexOf("**") + 2;
      await setCursor(page, contentStart);
      await new Promise(resolve => setTimeout(resolve, 250));
      const preceding = await setCursorAssoc(page, contentStart, -1);
      const content = await setCursorAssoc(page, contentStart, 1);
      assert.ok(content.nextRange, `${fixture.name} has no next-grapheme range`);
      assert.ok(Math.abs(content.caret.left - content.nextRange.left) <= 1 &&
        Math.abs(content.caret.width - content.nextRange.width) <= 1,
      `${fixture.name} does not cover the selected RTL grapheme`);
      assert.ok(Math.abs(content.caret.right - content.plus.left) <= 1.5,
        `${fixture.name} lost the RTL grapheme's logical start edge`);
      assert.ok(Math.abs(preceding.caret.left - preceding.minus.left) <= 0.25,
        `${fixture.name} lost its distinct preceding affinity site`);
      assert.ok(preceding.caret.width <= 8,
        `${fixture.name} preceding site spans ${preceding.caret.width.toFixed(2)}px across bidi content`);

      const close = fixture.source.indexOf("**", contentStart);
      const beforeClose = await setCursorAssoc(page, close, -1);
      const onClose = await setCursorAssoc(page, close, 1);
      assert.ok(beforeClose.caret.width <= 8,
        `${fixture.name} closing seam spans ${beforeClose.caret.width.toFixed(2)}px`);
      assert.ok(onClose.nextRange &&
        Math.abs(onClose.caret.left - onClose.nextRange.left) <= 1 &&
        Math.abs(onClose.caret.width - onClose.nextRange.width) <= 1,
      `${fixture.name} closing delimiter does not cover one source grapheme`);
      assert.notEqual(preceding.caret.left, content.caret.right,
        `${fixture.name} collapsed two legitimate bidi sites`);
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
        const marker = document.querySelectorAll("#magic4 .md-li-mark")[1];
        const raw = marker.querySelector(".cm-formatting-block").getBoundingClientRect();
        return { left: r.left, right: r.right, markerStart: raw.left };
      });
      assert.ok(Math.abs(right[0].caret.left - indentBox.left) < 1.5);
      assert.ok(Math.abs(right[right.length - 1].caret.left - indentBox.markerStart) < 1.5);
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
      assert.ok(Math.abs(textHome.caret.left - indentBox.markerStart) < 1.5);
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
      assert.ok(after.nextRange &&
        Math.abs(after.caret.left - after.nextRange.left) <= 1 &&
        Math.abs(after.caret.right - after.plus.left) <= 1.5,
      `${fixture.name} lost its +1 visual affinity`);
      assert.notEqual(before.caret.left, after.caret.right,
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
