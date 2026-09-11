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
      const files = {
        "/": "index.html",
        "/index.html": "index.html",
        "/page.html": "page.html",
        "/cm-markdown.js": "cm-markdown.js",
        "/card-markdown.js": "card-markdown.js",
        "/card-tokens.css": "card-tokens.css",
        "/card-logic.js": "card-logic.js",
        "/card-report.js": "card-report.js",
        "/compose-format.js": "compose-format.js",
      };
      const file = files[pathname];
      if (!file) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", file.endsWith(".js") ? "text/javascript; charset=utf-8"
        : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
      res.end(await readFile(path.join(ROOT, file)));
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(pageName, options = {}) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(disableSegmenter => {
    if (disableSegmenter)
      Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.__rafCalls = 0;
    window.requestAnimationFrame = callback => {
      window.__rafCalls++;
      return nativeRaf(callback);
    };
    const nativeSetEnd = Range.prototype.setEnd;
    window.__cursorRangeEnds = [];
    Range.prototype.setEnd = function(node, offset) {
      if (node?.parentElement?.id === "cursor-test-editable")
        window.__cursorRangeEnds.push(offset);
      return nativeSetEnd.call(this, node, offset);
    };
  }, !!options.disableSegmenter);
  await page.setViewport({ width: 1000, height: 720, deviceScaleFactor: 2 });
  const suffix = pageName === "page.html" ? "?mock=1" : "";
  await page.goto(`${origin}/${pageName}${suffix}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "cursor-test-host";
    host.style.cssText = "position:fixed;left:44px;top:72px;width:640px;height:260px;background:#fff";

    const textarea = document.createElement("textarea");
    textarea.id = "cursor-test-textarea";
    textarea.style.cssText = [
      "position:absolute", "left:0", "top:0", "width:600px", "height:82px",
      "min-height:0", "max-height:none", "padding:8px 10px", "border:1px solid #999",
      "border-radius:0", "overflow:auto", "resize:none", "background:#fff", "color:#111",
      "font:48px/1.2 Arial, sans-serif", "letter-spacing:0", "word-spacing:0",
    ].join(";");

    const input = document.createElement("input");
    input.id = "cursor-test-input";
    input.type = "text";
    input.style.cssText = [
      "position:absolute", "left:0", "top:100px", "width:600px", "height:66px",
      "padding:4px 10px", "border:1px solid #999", "background:#fff", "color:#111",
      "font:42px/1.2 Arial, sans-serif", "letter-spacing:0", "word-spacing:0",
    ].join(";");

    const editable = document.createElement("div");
    editable.id = "cursor-test-editable";
    editable.contentEditable = "plaintext-only";
    editable.style.cssText = [
      "position:absolute", "left:0", "top:184px", "width:600px", "height:64px",
      "padding:4px 10px", "border:1px solid #999", "background:#fff", "color:#111",
      "font:42px/1.2 Arial, sans-serif", "letter-spacing:0", "word-spacing:0",
      "white-space:pre-wrap", "outline:none",
    ].join(";");

    host.append(textarea, input, editable);
    document.body.appendChild(host);
  });
  return page;
}

async function fieldReading(page, selector, value, offset, options = {}) {
  return page.evaluate(async ({ selector, value, offset, options }) => {
    const el = document.querySelector(selector);
    if (options.fontFamily) el.style.fontFamily = options.fontFamily;
    if (options.zoom) el.style.zoom = options.zoom;
    el.value = value;
    el.focus();
    el.setSelectionRange(offset, offset);
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const cs = getComputedStyle(el);
    const probe = document.createElement("span");
    for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
      "fontVariant", "fontKerning", "fontFeatureSettings", "fontVariationSettings",
      "fontOpticalSizing", "letterSpacing", "wordSpacing", "textTransform", "tabSize", "zoom"])
      probe.style[prop] = cs[prop];
    probe.style.cssText += ";position:fixed;left:-8000px;top:0;visibility:hidden;white-space:pre";
    probe.textContent = value;
    document.body.appendChild(probe);

    let grapheme = "";
    if (offset < value.length && value[offset] !== "\n" && value[offset] !== "\r") {
      grapheme = new Intl.Segmenter(undefined, { granularity: "grapheme" })
        .segment(value.slice(offset))[Symbol.iterator]().next().value.segment;
    }
    let expected = null;
    if (grapheme) {
      const range = document.createRange();
      range.setStart(probe.firstChild, offset);
      range.setEnd(probe.firstChild, offset + grapheme.length);
      expected = range.getBoundingClientRect().width;
    }
    probe.remove();

    const caret = document.getElementById("fatcaret").getBoundingClientRect();
    const lift = document.getElementById("fatcaretlift")?.getBoundingClientRect() || null;
    const field = el.getBoundingClientRect();
    return {
      grapheme,
      expected,
      fallback: parseFloat(cs.fontSize) * 0.5,
      caret: { left: caret.left, right: caret.right, top: caret.top,
        width: caret.width, height: caret.height },
      lift: lift && { left: lift.left, top: lift.top, width: lift.width, height: lift.height },
      field: { left: field.left, top: field.top, width: field.width, height: field.height },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  }, { selector, value, offset, options });
}

async function editableReading(page, value, offset, knownLength = null) {
  return page.evaluate(async ({ value, offset, knownLength }) => {
    const el = document.getElementById("cursor-test-editable");
    el.textContent = value;
    el.focus();
    const caretRange = document.createRange();
    caretRange.setStart(el.firstChild, offset);
    caretRange.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(caretRange);
    window.__cursorRangeEnds = [];
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cursorRangeEnds = window.__cursorRangeEnds.slice();

    const grapheme = knownLength == null
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        .segment(value.slice(offset))[Symbol.iterator]().next().value.segment
      : value.slice(offset, offset + knownLength);
    const measured = document.createRange();
    measured.setStart(el.firstChild, offset);
    measured.setEnd(el.firstChild, offset + grapheme.length);
    const expected = measured.getBoundingClientRect().width;
    const caret = document.getElementById("fatcaret").getBoundingClientRect();
    return {
      grapheme,
      expected,
      cursorRangeEnds,
      caret: { left: caret.left, right: caret.right, width: caret.width },
    };
  }, { value, offset, knownLength });
}

async function editableInteriorReading(page, value, offset) {
  return page.evaluate(async ({ value, offset }) => {
    const el = document.getElementById("cursor-test-editable");
    el.textContent = value;
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild, offset);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    window.__cursorRangeEnds = [];
    document.dispatchEvent(new Event("selectionchange"));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const caret = document.getElementById("fatcaret").getBoundingClientRect();
    return { width: caret.width, fallback: parseFloat(getComputedStyle(el).fontSize) * 0.5,
      cursorRangeEnds: window.__cursorRangeEnds.slice() };
  }, { value, offset });
}

function assertAdvance(reading, label, tolerance = 0.8) {
  assert.ok(reading.expected > 0, `${label} has no rendered advance`);
  assert.ok(reading.caret.width >= reading.expected - tolerance,
    `${label} cursor ${reading.caret.width} does not cover ${reading.expected}`);
  assert.ok(reading.caret.right <= reading.caret.left + reading.expected + tolerance,
    `${label} cursor ${reading.caret.width} reaches into the next glyph`);
}

const boardState = boxes => ({
  boxes,
  pwd: "/tmp/lane", pwds: { facilitator: "/tmp/lane" },
  projects: [], busy: { facilitator: null }, queued: 0,
  end: false, paused: false, title: "facilitator",
  listening: { facilitator: false }, everListened: {}, workspaces: {},
  listenerGap: { facilitator: 0 },
  agents: { facilitator: { name: "claude", alive: false, away: false } },
});

const boardCard = (id, title) => ({
  id, bucket: "meta", title, reply: "", done: false, replies: 0,
  ball: "me", parked: false, ts: 1, context: "", owner: "facilitator",
  pending: 0, pendingTexts: [], pendingStamps: [], ws: null, task: null,
  worktree: "", agentTs: 0, engine: "claude", writing: false, bg: false,
  state: "new", queuePos: 0,
});

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} sizes field cursors from live glyphs`, async () => {
    const page = await fixture(pageName);
    try {
      const baseline = await page.evaluate(() => {
        const rect = id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        };
        return { host: rect("cursor-test-host"), textarea: rect("cursor-test-textarea"),
          input: rect("cursor-test-input"), editable: rect("cursor-test-editable"),
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight };
      });

      const narrow = await fieldReading(page, "#cursor-test-textarea", "iW", 0);
      const wide = await fieldReading(page, "#cursor-test-textarea", "iW", 1);
      assertAdvance(narrow, `${pageName} narrow glyph`);
      assertAdvance(wide, `${pageName} wide glyph`);
      assert.ok(wide.caret.width > narrow.caret.width * 2,
        `${pageName} kept a fixed cursor width for i and W`);

      const input = await fieldReading(page, "#cursor-test-input", "Wi", 0);
      assertAdvance(input, `${pageName} input glyph`);

      const arial = await fieldReading(page, "#cursor-test-textarea", "WQ", 0,
        { fontFamily: "Arial, sans-serif" });
      const courier = await fieldReading(page, "#cursor-test-textarea", "WQ", 0,
        { fontFamily: "'Courier New', monospace" });
      assertAdvance(arial, `${pageName} Arial glyph`);
      assertAdvance(courier, `${pageName} Courier glyph`);
      assert.ok(Math.abs(arial.caret.width - courier.caret.width) > 5,
        `${pageName} did not pick up the computed font change`);

      const zoomed = await fieldReading(page, "#cursor-test-textarea", "WQ", 0,
        { fontFamily: "Arial, sans-serif", zoom: "1.35" });
      assertAdvance(zoomed, `${pageName} zoomed glyph`, 1);
      assert.ok(zoomed.caret.width > arial.caret.width * 1.3,
        `${pageName} did not use the field's rendered zoom`);
      await page.evaluate(() => {
        document.getElementById("cursor-test-textarea").style.zoom = "";
        window.dispatchEvent(new Event("resize"));
      });

      const space = await fieldReading(page, "#cursor-test-textarea", " X", 0);
      assertAdvance(space, `${pageName} space`);
      const keycap = await fieldReading(page, "#cursor-test-textarea", "1\uFE0F\u20E3X", 0);
      assert.equal(keycap.grapheme, "1\uFE0F\u20E3",
        `${pageName} field split a keycap grapheme`);
      assertAdvance(keycap, `${pageName} field keycap grapheme`);
      const newline = await fieldReading(page, "#cursor-test-textarea", "\nX", 0);
      assert.ok(Math.abs(newline.caret.width - newline.fallback) < 0.8,
        `${pageName} newline did not keep the fallback cell`);
      const empty = await fieldReading(page, "#cursor-test-textarea", "", 0);
      assert.ok(Math.abs(empty.caret.width - empty.fallback) < 0.8,
        `${pageName} empty field did not keep the fallback cell`);
      const eol = await fieldReading(page, "#cursor-test-textarea", "X", 1);
      assert.ok(Math.abs(eol.caret.width - eol.fallback) < 0.8,
        `${pageName} end of line did not keep the fallback cell`);

      if (pageName === "index.html") {
        assert.deepEqual(wide.lift, {
          left: wide.caret.left, top: wide.caret.top,
          width: wide.caret.width, height: wide.caret.height,
        }, "the two blended cursor layers diverged");
      }

      const after = await page.evaluate(() => {
        const rect = id => {
          const r = document.getElementById(id).getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        };
        return { host: rect("cursor-test-host"), textarea: rect("cursor-test-textarea"),
          input: rect("cursor-test-input"), editable: rect("cursor-test-editable"),
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight };
      });
      assert.deepEqual(after, baseline, `${pageName} cursor geometry shifted the layout`);
    } finally {
      await page.close();
    }
  });
}

for (const pageName of ["index.html", "page.html"]) {
  test(`${pageName} contenteditable cursor measures complete graphemes`, async () => {
    const page = await fixture(pageName);
    try {
      const values = [
        [" X", "space"],
        ["e\u0301X", "combining sequence"],
        ["😀X", "surrogate pair"],
        ["1\uFE0F\u20E3X", "keycap emoji"],
        ["👨‍👩‍👧‍👦X", "ZWJ emoji"],
      ];
      for (const [value, label] of values) {
        const reading = await editableReading(page, value, 0);
        assertAdvance(reading, `${pageName} ${label}`, 0.8);
        assert.equal(reading.grapheme, value.slice(0, -1), `${label} was segmented early`);
        assert.ok(reading.cursorRangeEnds.includes(reading.grapheme.length),
          `${label} cursor range stopped before the grapheme boundary`);
      }
      const interior = await editableInteriorReading(page, "1\uFE0F\u20E3X", 1);
      assert.ok(Math.abs(interior.width - interior.fallback) < 0.8,
        "a programmatic interior position measured only part of a keycap grapheme");
      assert.ok(!interior.cursorRangeEnds.includes(2),
        "the cursor range stopped inside the keycap grapheme");
      for (const [value, offset, label] of [["\nX", 0, "newline"], ["X", 1, "end of line"]]) {
        const reading = await editableInteriorReading(page, value, offset);
        assert.ok(Math.abs(reading.width - reading.fallback) < 0.8,
          `${pageName} contenteditable ${label} did not keep the fallback cell`);
      }
    } finally {
      await page.close();
    }
  });
}

test("grapheme fallback keeps common ZWJ sequences intact", async () => {
  const page = await fixture("index.html", { disableSegmenter: true });
  try {
    const family = "👨‍👩‍👧‍👦";
    const reading = await editableReading(page, family + "X", 0, family.length);
    assertAdvance(reading, "fallback ZWJ emoji", 0.8);
    assert.ok(reading.cursorRangeEnds.includes(family.length),
      "fallback cursor range stopped inside the ZWJ sequence");
  } finally {
    await page.close();
  }
});

test("focused cursor has no continuous animation loop", async () => {
  const page = await fixture("index.html");
  try {
    await fieldReading(page, "#cursor-test-textarea", "Wi", 0);
    const burstFrames = await page.evaluate(() => {
      window.__rafCalls = 0;
      const field = document.getElementById("cursor-test-textarea");
      for (let i = 0; i < 200; i++) field.dispatchEvent(new Event("input", { bubbles: true }));
      return window.__rafCalls;
    });
    assert.equal(burstFrames, 1, "input burst was not coalesced into one caret frame");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { window.__rafCalls = 0; });
    await sleep(1400);
    const calls = await page.evaluate(() => window.__rafCalls);
    // A late web-font completion is one legitimate event-driven refresh. The
    // retired 300 ms caret timer would produce at least four frames here.
    assert.ok(calls <= 1, `idle focused cursor queued ${calls} animation frames`);
  } finally {
    await page.close();
  }
});

async function codeMirrorFixture(source) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 720, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async text => {
    activeOwner = "pastureland";
    mdBoxes();
    const host = mdBuild(MD_MOUNTS.pastureland);
    host.style.left = "32px";
    host.style.top = "32px";
    host.style.width = "420px";
    host.style.height = "300px";
    if (!await mdBundle()) throw new Error("CodeMirror bundle did not load");
    mdFor = "pastureland";
    mdOpen = { lane: "pastureland", root: "fixture-internal", rel: "fixture.md", mtime: "1" };
    mdClean = text;
    mdMount(host, text, false);
    host.classList.add("editing");
    await document.fonts.ready;
    mdView.focus();
  }, source);
  return page;
}

test("CodeMirror cursor measures its next rendered grapheme", async () => {
  const page = await codeMirrorFixture("iW 1\uFE0F\u20E3X");
  try {
    const result = await page.evaluate(async () => {
      const source = mdView.state.sliceDoc();

      const read = async position => {
        mdView.dispatch({ selection: { anchor: position } });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const start = mdView.coordsAtPos(position, position === 0 ? 1 : -1);
        const segment = new Intl.Segmenter(undefined, { granularity: "grapheme" })
          .segment(source.slice(position))[Symbol.iterator]().next().value.segment;
        const end = mdView.coordsAtPos(position + segment.length, -1);
        const caret = document.getElementById("fatcaret").getBoundingClientRect();
        return { segment, expected: end.left - start.left,
          caret: { left: caret.left, right: caret.right, width: caret.width } };
      };
      return { narrow: await read(0), wide: await read(1), keycap: await read(3) };
    });
    assertAdvance(result.narrow, "CodeMirror narrow glyph", 1.2);
    assertAdvance(result.wide, "CodeMirror wide glyph", 1.2);
    assertAdvance(result.keycap, "CodeMirror keycap grapheme", 1.2);
    assert.ok(result.wide.caret.width > result.narrow.caret.width * 2,
      "CodeMirror kept a fixed cursor width for i and W");
    assert.equal(result.keycap.segment, "1\uFE0F\u20E3",
      "CodeMirror keycap was split before its grapheme boundary");
  } finally {
    await page.close();
  }
});

test("a new card's empty title matches the placeholder's first letter", async () => {
  // the reported miss: a just-created card focuses its empty title, and the
  // block stood at the title box's outer edge while the focused card's css
  // pads the words in, so the first keystroke landed a padding to the right
  // of the block. the board's own path runs here: apply() meets an unknown
  // box, makeBox + landFocus select it and start the rename.
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  try {
    const empty = await page.evaluate(async ({ first, both }) => {
      await document.fonts.ready;
      build(first); apply(first); lastState = first;
      // the create flow: the server grows a nameless box, focusbox remembers
      // it, and the next poll's apply() lands the cursor in its title
      localStorage.setItem("focusbox", "m2");
      apply(both); lastState = both;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = els.m2.titleEl;
      const caret = document.getElementById("fatcaret").getBoundingClientRect();
      return {
        selected: els.m2.box.classList.contains("sel"),
        editing: t.isContentEditable && document.activeElement === t,
        text: t.textContent,
        placeholder: getComputedStyle(t, "::before").content,
        caretOn: document.getElementById("fatcaret").classList.contains("on"),
        caretLeft: caret.left,
        caretWidth: caret.width,
      };
    }, { first: boardState([boardCard("m1", "an older card")]),
         both: boardState([boardCard("m1", "an older card"), boardCard("m2", "")]) });

    assert.ok(empty.selected, "the new card was not selected");
    assert.ok(empty.editing, "the new card's title did not take the rename cursor");
    assert.equal(empty.text, "", "the new card's title was not empty");
    assert.equal(empty.placeholder, '"Chat Name"', "the new card did not show its placeholder");
    assert.ok(empty.caretOn, "no block cursor stood on the empty title");

    await page.keyboard.type("C");
    const typed = await page.evaluate(async () => {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const t = els.m2.titleEl;
      const glyph = document.createRange();
      glyph.setStart(t.firstChild, 0);
      glyph.setEnd(t.firstChild, 1);
      const glyphRect = glyph.getBoundingClientRect();
      const endCaret = document.getElementById("fatcaret").getBoundingClientRect();
      const before = document.createRange();
      before.setStart(t.firstChild, 0);
      before.collapse(true);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(before);
      document.dispatchEvent(new Event("selectionchange"));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const beforeCaret = document.getElementById("fatcaret").getBoundingClientRect();
      return { text: t.textContent, firstCharLeft: glyphRect.left,
               firstCharWidth: glyphRect.width, endCaretLeft: endCaret.left,
               beforeCaretWidth: beforeCaret.width };
    });

    assert.equal(typed.text, "C", "the keystroke did not land in the title");
    assert.ok(Math.abs(empty.caretLeft - typed.firstCharLeft) < 1,
      `empty title cursor at ${empty.caretLeft} but the first letter landed at ${typed.firstCharLeft}`);
    assert.ok(Math.abs(typed.beforeCaretWidth - typed.firstCharWidth) < 1,
      "the live cursor did not measure the rendered C");
    assert.ok(Math.abs(empty.caretWidth - typed.beforeCaretWidth) < 1,
      `empty title cursor width ${empty.caretWidth} did not match C width ${typed.beforeCaretWidth}`);
    assert.ok(typed.endCaretLeft > typed.firstCharLeft,
      "the cursor did not advance past the typed letter");
  } finally {
    await page.close();
  }
});

// The plain composer, which is what this measures: the drawn block is placed
// from a mirror of the field's own text layout, and the mirror has to keep the
// field's fractional width or the wrap it lays out is not the wrap on screen.
// The typed-formatting setting is turned off for it, because with the setting
// on the row is an editor and the block is placed from the editor's own
// coordinates instead, which the case below this one measures.
test("focus composer keeps fractional wrap geometry", async () => {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("composeformat", "0"); } catch (error) {}
  });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  try {
    await page.evaluate(async state => {
      await document.fonts.ready;
      build(state); apply(state); lastState = state; select("m1");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, boardState([boardCard("m1", "fixture")]));

    const read = value => page.evaluate(async value => {
      const ta = els.m1.ta;
      ta.value = value;
      els.m1.tick();
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const cs = getComputedStyle(ta);
      const field = ta.getBoundingClientRect();
      let boxWidth = parseFloat(cs.width);
      if (cs.boxSizing !== "border-box") {
        boxWidth += parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
          + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      }
      const gutter = Math.max(0, ta.offsetWidth - ta.clientWidth
        - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth));
      const availableWidth = boxWidth - gutter;

      // An independent laid-out reference gives the last glyph's right edge
      // using the textarea's fractional line width rather than offsetWidth.
      const reference = document.createElement("div");
      for (const prop of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
        "fontVariant", "fontKerning", "fontFeatureSettings", "fontVariationSettings",
        "fontOpticalSizing", "lineHeight", "letterSpacing", "wordSpacing", "textTransform",
        "textIndent", "textAlign", "direction", "tabSize", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
        "borderBottomWidth", "borderLeftWidth"])
        reference.style[prop] = cs[prop];
      reference.style.cssText += ";position:fixed;left:-8000px;top:0;visibility:hidden;" +
        "box-sizing:border-box;border-style:solid;border-color:transparent;" +
        `width:${availableWidth}px;white-space:pre-wrap;overflow-wrap:break-word`;
      reference.textContent = value;
      document.body.appendChild(reference);
      const referenceRect = reference.getBoundingClientRect();
      const last = document.createRange();
      last.setStart(reference.firstChild, value.length - 1);
      last.setEnd(reference.firstChild, value.length);
      const lastRect = last.getClientRects()[0] || last.getBoundingClientRect();
      const scale = field.width / boxWidth;
      const expectedLeft = field.left + (lastRect.right - referenceRect.left) * scale
        - ta.scrollLeft * scale;
      reference.remove();

      const caret = document.getElementById("fatcaret").getBoundingClientRect();
      const internalMirror = [...document.body.children].find(node =>
        node.style.position === "fixed" && node.style.left === "-9999px" &&
        node.style.visibility === "hidden");
      return {
        availableWidth,
        mirrorWidth: parseFloat(internalMirror.style.width),
        expectedLeft,
        caret: { left: caret.left, top: caret.top, bottom: caret.bottom },
        field: { top: field.top, bottom: field.bottom },
        scrollHeight: ta.scrollHeight,
        clientHeight: ta.clientHeight,
      };
    }, value);

    const trailingWord = await read("hi that is a fairly long set of notes, maybe keep ones " +
      "that seem worth keeping (I think a few of these notes make the same point??)");
    assert.ok(Math.abs(trailingWord.mirrorWidth - trailingWord.availableWidth) < 0.02,
      "the composer mirror rounded away the field's fractional width");
    assert.ok(Math.abs(trailingWord.caret.left - trailingWord.expectedLeft) < 1,
      `the end cursor left a ${trailingWord.caret.left - trailingWord.expectedLeft}px gap`);

    const wrapEdge = await read("hi that is a fairly long set of notes, maybe keep one s");
    assert.ok(wrapEdge.scrollHeight <= wrapEdge.clientHeight + 1,
      "the textarea itself unexpectedly wrapped or scrolled");
    assert.ok(Math.abs(wrapEdge.caret.left - wrapEdge.expectedLeft) < 1,
      "the drawn cursor wrapped while the textarea's text still fit");
    assert.ok(wrapEdge.caret.top >= wrapEdge.field.top - 1 &&
      wrapEdge.caret.bottom <= wrapEdge.field.bottom + 1,
      "the drawn cursor escaped the unscrolled composer viewport");
  } finally {
    await page.close();
  }
});

// The same row with the setting on, which is how it stands by default. The
// block is no longer placed from a mirror of a textarea, so what is asked here
// is the thing the mirror existed to get right: the block sits on the caret,
// stays inside the row, and follows the caret when the words wrap.
test("the formatted composer keeps the block cursor on its caret", async () => {
  const page = await browser.newPage();
  // the setting is written out rather than left to the default, because the
  // case above this one turns it off in the same browser's storage
  await page.evaluateOnNewDocument(() => {
    try { localStorage.setItem("composeformat", "1"); } catch (error) {}
  });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto(`${origin}/index.html`, { waitUntil: "domcontentloaded" });
  try {
    await page.evaluate(async state => {
      await document.fonts.ready;
      build(state); apply(state); lastState = state; select("m1");
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, boardState([boardCard("m1", "fixture")]));
    await page.waitForFunction(() => !!document.querySelector("#box-m1 .cffield"), { timeout: 25000 });

    const read = value => page.evaluate(async value => {
      const ta = els.m1.ta;
      ta.value = value;
      els.m1.tick();
      ta.focus();
      ta.setSelectionRange(value.length, value.length);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const view = ComposeFormat.fieldOf(ta).view;
      const at = view.coordsAtPos(view.state.selection.main.head, -1);
      const box = view.scrollDOM.getBoundingClientRect();
      const caret = document.getElementById("fatcaret").getBoundingClientRect();
      return {
        formatted: !!ComposeFormat.fieldOf(ta).formatted(),
        expectedLeft: at ? at.left : null, expectedTop: at ? at.top : null,
        caret: { left: caret.left, top: caret.top, bottom: caret.bottom, width: caret.width },
        field: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
        lines: view.state.doc.lines, text: view.state.doc.toString(),
      };
    }, value);

    const long = await read("hi that is a fairly long set of notes, maybe keep ones " +
      "that seem worth keeping (I think a few of these notes make the same point??)");
    assert.equal(long.formatted, true, "the row never put its editor on");
    assert.ok(Math.abs(long.caret.left - long.expectedLeft) < 1.2,
      `the block sat ${long.caret.left - long.expectedLeft}px off the caret`);
    assert.ok(Math.abs(long.caret.top - long.expectedTop) < 2.5,
      `the block sat ${long.caret.top - long.expectedTop}px off the caret's row`);
    assert.ok(long.caret.top >= long.field.top - 1 && long.caret.bottom <= long.field.bottom + 1,
      "the drawn cursor escaped the row it belongs to");
    assert.ok(long.caret.left >= long.field.left - 1 && long.caret.left <= long.field.right + 1,
      "the drawn cursor left the row sideways");

    // the same words one character shorter, which is where the wrap turns over
    const edge = await read("hi that is a fairly long set of notes, maybe keep one s");
    assert.ok(Math.abs(edge.caret.left - edge.expectedLeft) < 1.2,
      "the block left the caret at the wrap edge");
    assert.ok(edge.caret.top >= edge.field.top - 1 && edge.caret.bottom <= edge.field.bottom + 1,
      "the drawn cursor escaped the unscrolled row");
  } finally {
    await page.close();
  }
});

test("list traversal and dynamic CodeMirror widths coexist", async () => {
  const source = "1.   aiW";
  const page = await codeMirrorFixture(source);
  try {
    const result = await page.evaluate(async positions => {
      const read = async position => {
        mdView.dispatch({ selection: { anchor: position } });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const line = mdView.state.doc.lineAt(position);
        const side = position === line.from ? 1 : -1;
        let start = mdView.coordsAtPos(position, side);
        if (!start || start.bottom <= start.top) start = mdView.coordsAtPos(position, -side);
        const caret = document.getElementById("fatcaret").getBoundingClientRect();
        const text = mdView.state.sliceDoc();
        const segment = position < line.to
          ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
            .segment(line.text.slice(position - line.from))[Symbol.iterator]().next().value.segment
          : "";
        const end = segment ? mdView.coordsAtPos(position + segment.length, -1) : null;
        return {
          position,
          segment,
          start: start && { left: start.left, top: start.top,
            width: start.right - start.left, height: start.bottom - start.top },
          expected: end && end.bottom > end.top ? end.left - start.left : null,
          caret: { left: caret.left, right: caret.right, top: caret.top,
            width: caret.width, height: caret.height },
          text,
        };
      };
      const content = mdView.contentDOM;
      const cs = getComputedStyle(content);
      const rect = content.getBoundingClientRect();
      const scale = content.offsetWidth ? rect.width / content.offsetWidth : 1;
      const readings = [];
      for (const position of positions) readings.push(await read(position));
      return { fallback: parseFloat(cs.fontSize) * 0.5 * scale, readings };
    }, [2, 3, 4, 5, 6, 7]);

    const gaps = result.readings.slice(0, 4);
    assert.deepEqual(gaps.map(reading => reading.position), [2, 3, 4, 5]);
    for (let i = 0; i < gaps.length; i++) {
      assert.ok(Math.abs(gaps[i].caret.width - result.fallback) < 0.8,
        `decorated list stop ${gaps[i].position} lost its fallback width`);
      if (i) {
        assert.ok(gaps[i].caret.left > gaps[i - 1].caret.left,
          `decorated list stop ${gaps[i].position} did not advance`);
        assert.ok(Math.abs(gaps[i].caret.top - gaps[0].caret.top) < 0.5,
          `decorated list stop ${gaps[i].position} left its row`);
      }
    }

    const [narrow, wide] = result.readings.slice(4);
    assert.equal(narrow.segment, "i");
    assert.equal(wide.segment, "W");
    for (const [reading, label] of [[narrow, "list narrow glyph"], [wide, "list wide glyph"]]) {
      assert.ok(reading.start.height > 0, `${label} did not use a full-height coordinate`);
      assert.ok(Math.abs(reading.caret.left - reading.start.left) < 1.2,
        `${label} mixed coordinates from different CodeMirror sides`);
      assertAdvance(reading, label, 1.2);
      assert.equal(reading.text, source);
    }
    assert.ok(wide.caret.width > narrow.caret.width * 2,
      "list text kept a fixed cursor width after traversing its source gap");
  } finally {
    await page.close();
  }
});
