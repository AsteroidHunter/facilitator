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
    return {
      pos,
      assoc: selection.assoc,
      before: pos ? mdView.state.sliceDoc(pos - 1, pos) : null,
      after: pos < mdView.state.doc.length ? mdView.state.sliceDoc(pos, pos + 1) : null,
      source: mdView.state.sliceDoc(),
      minus: rect(mdView.coordsAtPos(pos, -1)),
      plus: rect(mdView.coordsAtPos(pos, 1)),
      caret: rect(caret.getBoundingClientRect()),
      on: caret.classList.contains("on"),
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
