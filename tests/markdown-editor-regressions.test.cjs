const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
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
