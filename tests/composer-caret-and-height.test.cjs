// Regressions for the three confirmed composer defects:
//  1. a retained draft keeps its compose-box height when an async callback,
//     a web font settling or an attachment upload landing, runs the autosize
//     while the card is hidden, and the height is restored on return without a
//     keystroke. Covered for both the plain textarea and the formatted editor.
//  2. at a soft-wrap boundary the black block cursor follows the formatted
//     editor's actual visual row, on both pointer-selected affinities, matching
//     the owning EditorView's coordsAtPos rather than a browser range.
//  3. both fixed cursor overlay layers are clipped to the visible scroller, so
//     a partly scrolled caret row cannot paint a solid block over the top rule.
// A scaled-stage check guards the interaction with the parallel responsive work.
//
// Hermetic: serves only repository static files on an ephemeral loopback port,
// with a controllable slow font and a delayed /upload, and drives an owned
// private headless Chrome. Synthetic drafts, disposable state.
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { readFile, mkdir, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ROOT = path.resolve(__dirname, "..");
const CHROME = process.env.CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = process.env.COMPOSER_TEST_SHOTS || "";   // set to a dir to save screenshots
const UPLOAD_DELAY = 300;   // ms the server holds /upload so the switch wins
const FONT_DELAY = 1200;    // ms the slow font is held, keeping fonts.ready pending

const FILES = {
  "/": "index.html", "/index.html": "index.html", "/page.html": "page.html",
  "/cm-markdown.js": "cm-markdown.js", "/card-markdown.js": "card-markdown.js",
  "/card-tokens.css": "card-tokens.css", "/card-logic.js": "card-logic.js",
  "/card-report.js": "card-report.js", "/compose-format.js": "compose-format.js",
};

let browser, server, origin;

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // a slow font that never arrives keeps document.fonts.ready pending; it is
    // the only font in play because the page blocks the external Google Fonts
    if (url.pathname === "/slowfont.woff2") {
      setTimeout(() => { res.statusCode = 404; res.end("no font"); }, FONT_DELAY);
      return;
    }
    // an attachment upload that answers after a delay, so the reader can leave
    // the card before the url lands on its still-referenced field
    if (req.method === "POST" && url.pathname === "/upload") {
      req.on("data", () => {});
      req.on("end", () => setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ url: "/uploads/" + (url.searchParams.get("name") || "f.png") }));
      }, UPLOAD_DELAY));
      return;
    }
    try {
      const name = FILES[url.pathname];
      if (!name) { res.statusCode = 404; res.end("not found"); return; }
      res.setHeader("content-type", name.endsWith(".js") ? "text/javascript; charset=utf-8"
        : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
      res.end(await readFile(path.join(ROOT, name)));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--disable-background-networking", "--no-first-run", "--no-default-browser-check"],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

const boardCard = (id, title) => ({
  id, bucket: "meta", title, reply: "", done: false, replies: 0, ball: "me",
  parked: false, ts: 1, context: "", owner: "facilitator", pending: 0,
  pendingTexts: [], pendingStamps: [], ws: null, task: null, worktree: "",
  agentTs: 0, engine: "claude", writing: false, bg: false, state: "new", queuePos: 0,
});
const boardState = boxes => ({
  boxes, pwd: "/tmp/lane", pwds: { facilitator: "/tmp/lane" }, projects: [],
  busy: { facilitator: null }, queued: 0, end: false, paused: false,
  title: "facilitator", listening: { facilitator: false }, everListened: {},
  workspaces: {}, listenerGap: { facilitator: 0 },
  agents: { facilitator: { name: "claude", alive: false, away: false } },
});
const TWO = boardState([boardCard("m1", "card one"), boardCard("m2", "card two")]);

const settle = (page, n = 3) => page.evaluate(count => new Promise(resolve => {
  let i = 0;
  const step = () => (++i >= count ? resolve() : requestAnimationFrame(step));
  requestAnimationFrame(step);
}), n);

// what a composer row is showing, read through the field's public face so the
// formatted editor's own scroller is what is measured, not the hidden textarea
async function reading(page, id) {
  return page.evaluate(cardId => {
    const el = els[cardId], ta = el.ta;
    const field = globalThis.ComposeFormat && globalThis.ComposeFormat.fieldOf(ta);
    const box = (field && field.view && field.view.scrollDOM) || ta;
    const rect = box.getBoundingClientRect(), cs = getComputedStyle(box);
    return {
      formatted: !!(field && field.view),
      selected: el.box.classList.contains("sel"),
      displayed: cs.display !== "none" && box.offsetParent !== null,
      inlineHeight: box.style.height,
      rectHeight: Math.round(rect.height * 100) / 100,
      scrollHeight: ta.scrollHeight,
      valueLength: ta.value.length,
      selectionStart: ta.selectionStart, selectionEnd: ta.selectionEnd,
      scrollTop: ta.scrollTop,
    };
  }, id);
}

async function shoot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  const clip = await page.$eval("#box-m1 .bottombar", node => {
    const r = node.getBoundingClientRect();
    return { x: Math.max(0, r.left - 24), y: Math.max(0, r.top - 60),
      width: Math.min(innerWidth, r.right + 24) - Math.max(0, r.left - 24),
      height: Math.min(innerHeight, r.bottom + 24) - Math.max(0, r.top - 60) };
  }).catch(() => null);
  if (clip && clip.width > 0 && clip.height > 0)
    await page.screenshot({ path: path.join(SHOTS, name), clip });
}

// type a three-line draft the natural way, through the field's input path
async function typeTallDraft(page) {
  await page.evaluate(() => els.m1.ta.focus());
  const lines = ["first draft line of a retained message", "second line", "third line"];
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i]);
    if (i < lines.length - 1) {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    }
  }
}

async function openBoard(page, { formatted, awaitFonts = true, slowFont = false }) {
  await page.evaluateOnNewDocument((on, wantFont, base) => {
    try { localStorage.setItem("composeformat", on ? "1" : "0"); } catch (e) {}
    if (wantFont) {
      try {
        const ff = new FontFace("SlowProbe", `url(${base}/slowfont.woff2)`);
        document.fonts.add(ff);
        ff.load().catch(() => {});   // pends until the server answers
      } catch (e) {}
    }
  }, formatted, slowFont, origin);
  if (slowFont) {
    await page.setRequestInterception(true);
    page.on("request", r => {
      const u = r.url();
      if (u.includes("fonts.googleapis.com") || u.includes("fonts.gstatic.com")) {
        r.abort().catch(() => {}); return;
      }
      r.continue().catch(() => {});
    });
  }
  await page.setViewport({ width: 1512, height: 982, deviceScaleFactor: 2 });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof build === "function" && typeof select === "function",
    { timeout: 15000 });
  await page.evaluate(async (data, wait) => {
    if (wait) await document.fonts.ready;
    validateActiveOwner(data); seedTabsOnce(data); seedSeenOnce(data);
    build(data); apply(data); lastState = data; select("m1");
  }, TWO, awaitFonts);
  if (formatted)
    await page.waitForFunction(() => !!ComposeFormat.fieldOf(els.m1.ta) &&
      !!ComposeFormat.fieldOf(els.m1.ta).view, { timeout: 25000 });
  await settle(page);
}

for (const formatted of [false, true]) {
  const mode = formatted ? "formatted" : "plain";

  test(`${mode}: a web font settling while the card is hidden keeps the retained draft height`, async () => {
    const page = await browser.newPage();
    try {
      await openBoard(page, { formatted, awaitFonts: false, slowFont: true });
      await typeTallDraft(page);
      await settle(page);
      const typed = await reading(page, "m1");
      assert.ok(typed.rectHeight > 60, `${mode} draft did not grow tall: ${typed.rectHeight}`);
      const tall = typed.inlineHeight;

      await page.evaluate(() => select("m2"));
      await settle(page, 2);
      const hidden = await reading(page, "m1");
      assert.equal(hidden.displayed, false, `${mode} m1 was not hidden`);

      // the slow font settles: the per-card document.fonts.ready.then(tick)
      // fires on the still-hidden m1
      await page.evaluate(() => document.fonts.ready);
      await settle(page, 4);
      const settled = await reading(page, "m1");
      assert.equal(settled.inlineHeight, tall,
        `${mode} hidden font-settle collapsed the height to ${settled.inlineHeight}`);
      assert.notEqual(settled.inlineHeight, "0px", `${mode} height was written as zero`);
      assert.equal(settled.valueLength, typed.valueLength, `${mode} draft text changed while hidden`);

      await page.evaluate(() => select("m1"));
      await settle(page, 4);
      const back = await reading(page, "m1");
      await shoot(page, `${mode}-font-returned.png`);
      assert.ok(Math.abs(back.rectHeight - typed.rectHeight) <= 1,
        `${mode} returned one-line-ish (${back.rectHeight}) instead of ${typed.rectHeight} before any keystroke`);
      assert.equal(back.valueLength, typed.valueLength, `${mode} draft lost on return`);
      assert.equal(back.selectionStart, typed.valueLength, `${mode} caret not preserved`);
    } finally {
      await page.close();
    }
  });

  test(`${mode}: an upload landing while the card is hidden keeps and re-measures the draft`, async () => {
    const page = await browser.newPage();
    try {
      await openBoard(page, { formatted, awaitFonts: true });
      await typeTallDraft(page);
      await settle(page);
      const typed = await reading(page, "m1");
      assert.ok(typed.rectHeight > 60, `${mode} draft did not grow tall`);
      const tall = typed.inlineHeight;

      await page.evaluate(() => {
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const file = new File([bytes], "shot.png", { type: "image/png" });
        window.attach([file], els.m1.ta);   // async; resolves after the server delay
      });
      await page.evaluate(() => select("m2"));
      await settle(page, 2);
      const leaving = await reading(page, "m1");
      assert.equal(leaving.displayed, false, `${mode} m1 not hidden during upload`);

      await page.waitForFunction(() => els.m1.ta.value.includes("/uploads/shot.png"), { timeout: 6000 });
      await settle(page, 3);
      const landed = await reading(page, "m1");
      assert.notEqual(landed.inlineHeight, "0px",
        `${mode} hidden upload collapsed the height to zero`);
      assert.equal(landed.inlineHeight, tall, `${mode} height moved while hidden`);
      assert.ok(landed.valueLength > typed.valueLength, `${mode} url was not appended to the draft`);

      await page.evaluate(() => select("m1"));
      await settle(page, 4);
      const back = await reading(page, "m1");
      await shoot(page, `${mode}-upload-returned.png`);
      // the draft grew by the url while hidden, so the re-measure on return must
      // be taller than the pre-upload draft, not one line and not the old height
      assert.ok(back.rectHeight > typed.rectHeight + 10,
        `${mode} return did not re-measure the grown draft: ${back.rectHeight} vs ${typed.rectHeight}`);
      assert.equal(back.valueLength, landed.valueLength, `${mode} draft lost the url on return`);
    } finally {
      await page.close();
    }
  });
}

// The wrap URL used for the affinity and clipping cases: it soft-wraps inside
// the composer at a known boundary the tests find from the editor's own layout.
const WRAP_URL = "/uploads/1789973161883012000-Screenshot-2026-09-20-at-11.45.57PM-longenough.png";

async function placeCaretAndRead(page, screenX, screenY) {
  await page.mouse.click(screenX, screenY);
  await settle(page, 2);
  return page.evaluate(() => {
    const ta = els.m1.ta;
    const view = ComposeFormat.fieldOf(ta).view;
    const pos = view.state.selection.main.head;
    const before = view.coordsAtPos(pos, -1);
    const after = view.coordsAtPos(pos, 1);
    const fc = document.getElementById("fatcaret").getBoundingClientRect();
    const lift = document.getElementById("fatcaretlift").getBoundingClientRect();
    const box = view.scrollDOM.getBoundingClientRect();
    return {
      pos, assoc: view.state.selection.main.assoc,
      before: before && { left: before.left, top: before.top, bottom: before.bottom },
      after: after && { left: after.left, top: after.top, bottom: after.bottom },
      caret: { left: fc.left, top: fc.top, width: fc.width, height: fc.height },
      lift: { left: lift.left, top: lift.top, width: lift.width, height: lift.height },
      caretOn: document.getElementById("fatcaret").classList.contains("on"),
      field: { top: box.top, bottom: box.bottom },
    };
  });
}

test("formatted: the block follows the pointer-selected side of a soft wrap", async () => {
  const page = await browser.newPage();
  try {
    await openBoard(page, { formatted: true, awaitFonts: true });
    // load the wrapping url, place the caret at the soft-wrap boundary
    const bounds = await page.evaluate(url => {
      const ta = els.m1.ta;
      ta.value = url;
      els.m1.tick();
      const view = ComposeFormat.fieldOf(ta).view;
      // find the first document position whose -1 and +1 coords are on two rows
      let boundary = -1;
      for (let p = 1; p < view.state.doc.length; p++) {
        const b = view.coordsAtPos(p, -1), a = view.coordsAtPos(p, 1);
        if (b && a && a.top - b.top > 6) { boundary = p; break; }
      }
      const b = view.coordsAtPos(boundary, -1), a = view.coordsAtPos(boundary, 1);
      return { boundary,
        line1: { x: b.left - 2, y: (b.top + b.bottom) / 2, top: b.top },
        line2: { x: a.left + 2, y: (a.top + a.bottom) / 2, top: a.top } };
    }, WRAP_URL);
    assert.ok(bounds.boundary > 0, "no soft-wrap boundary was found in the url");

    // click the start of visual line two: CodeMirror records assoc +1, the block
    // must sit on line two, not line one
    const two = await placeCaretAndRead(page, bounds.line2.x, bounds.line2.y);
    assert.ok(two.caretOn, "no block was drawn after clicking line two");
    assert.equal(two.assoc, 1, "clicking line two did not select the +1 affinity");
    assert.ok(Math.abs(two.caret.top - two.after.top) < 3,
      `block sat ${two.caret.top - two.after.top}px off line two`);
    assert.ok(two.caret.top - two.before.top > 10,
      "block stayed on line one after a line-two click (the reported defect)");

    // click the end of visual line one: assoc -1, the block must sit on line one
    const one = await placeCaretAndRead(page, bounds.line1.x, bounds.line1.y);
    assert.ok(one.caretOn, "no block was drawn after clicking line one");
    assert.ok(Math.abs(one.caret.top - one.before.top) < 3,
      `block sat ${one.caret.top - one.before.top}px off line one`);
    assert.ok(one.after.top - one.caret.top > 10, "block dropped to line two after a line-one click");

    // the two clicks put the block on two different rows at one document position
    assert.ok(two.caret.top - one.caret.top > 10,
      "the two wrap affinities drew the block on the same row");

    // both blended layers stay on the one rectangle
    assert.deepEqual(
      { left: two.lift.left, top: two.lift.top, width: two.lift.width, height: two.lift.height },
      { left: two.caret.left, top: two.caret.top, width: two.caret.width, height: two.caret.height },
      "the two cursor layers diverged at the wrap boundary");
  } finally {
    await page.close();
  }
});

test("plain: the block already follows the pointer-selected wrapped row", async () => {
  const page = await browser.newPage();
  try {
    await openBoard(page, { formatted: false, awaitFonts: true });
    const bounds = await page.evaluate(url => {
      const ta = els.m1.ta;
      ta.value = url;
      els.m1.tick();
      ta.focus();
      // measure the wrap from a mirror of the field's own text layout
      const cs = getComputedStyle(ta);
      const probe = document.createElement("div");
      for (const p of ["fontFamily","fontSize","fontWeight","fontStyle","lineHeight",
        "letterSpacing","wordSpacing","paddingLeft","paddingRight","borderLeftWidth","borderRightWidth"])
        probe.style[p] = cs[p];
      probe.style.cssText += ";position:fixed;left:-9999px;top:0;visibility:hidden;" +
        "white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box";
      probe.style.width = ta.clientWidth + "px";
      const r = ta.getBoundingClientRect();
      return { r: { left: r.left, top: r.top }, lh: parseFloat(cs.lineHeight),
        pt: parseFloat(cs.paddingTop), pl: parseFloat(cs.paddingLeft) };
    }, WRAP_URL);
    // click near the start of the second visual row of the textarea
    const y2 = bounds.r.top + bounds.pt + bounds.lh * 1.5;
    await page.mouse.click(bounds.r.left + bounds.pl + 2, y2);
    await settle(page, 2);
    const read = await page.evaluate(() => {
      const ta = els.m1.ta;
      const fc = document.getElementById("fatcaret").getBoundingClientRect();
      const r = ta.getBoundingClientRect();
      const cs = getComputedStyle(ta);
      return { caretTop: fc.top, caretOn: document.getElementById("fatcaret").classList.contains("on"),
        rowOneTop: r.top + parseFloat(cs.paddingTop), lh: parseFloat(cs.lineHeight) };
    });
    assert.ok(read.caretOn, "no block was drawn in the plain composer");
    assert.ok(read.caretTop > read.rowOneTop + read.lh * 0.5,
      "the plain block did not land on the wrapped second row");
  } finally {
    await page.close();
  }
});

test("formatted: both cursor layers are clipped to the scroller when the caret row is scrolled under the top rule", async () => {
  const page = await browser.newPage();
  try {
    await openBoard(page, { formatted: true, awaitFonts: true });
    // an over-cap draft so the field scrolls inside itself
    await page.evaluate(() => {
      const ta = els.m1.ta;
      ta.value = Array.from({ length: 14 }, (_, i) => "line " + (i + 1) + " of a long retained draft").join("\n");
      els.m1.tick();
      ta.focus();
    });
    await settle(page, 2);

    // put the caret on an early line, then scroll that line partly above the top
    const scrolled = await page.evaluate(() => {
      const ta = els.m1.ta;
      const view = ComposeFormat.fieldOf(ta).view;
      const pos = view.state.doc.line(3).from;   // start of the third line
      view.dispatch({ selection: { anchor: pos } });
      const box = view.scrollDOM.getBoundingClientRect();
      const at = view.coordsAtPos(pos, 1);
      // scroll so this row's top sits ~8px above the field's top edge
      view.scrollDOM.scrollTop += (at.top - box.top) + 8;
      riseBand(ta);
      document.dispatchEvent(new Event("selectionchange"));
      return { pos };
    });
    assert.ok(scrolled.pos >= 0);
    await settle(page, 3);

    const clip = await page.evaluate(() => {
      const ta = els.m1.ta;
      const view = ComposeFormat.fieldOf(ta).view;
      const fc = document.getElementById("fatcaret");
      const lift = document.getElementById("fatcaretlift");
      const cr = fc.getBoundingClientRect();
      const box = view.scrollDOM.getBoundingClientRect();
      const insetTop = css => {
        const m = /inset\(([-\d.]+)px/.exec(css);
        return m ? parseFloat(m[1]) : null;
      };
      return {
        upfade: view.scrollDOM.classList.contains("upfade"),
        caretOn: fc.classList.contains("on"),
        fcClip: fc.style.clipPath, liftClip: lift.style.clipPath,
        fcInsetTop: insetTop(fc.style.clipPath), liftInsetTop: insetTop(lift.style.clipPath),
        boxTop: box.top, caretTop: cr.top, caretBottom: cr.bottom,
      };
    });
    await shoot(page, "formatted-clip-scrolled.png");
    assert.ok(clip.upfade, "the over-cap draft did not scroll and fade");
    assert.ok(clip.caretOn, "no block was drawn on the scrolled row");
    // the block box reaches above the field, and both layers clip that overhang
    assert.ok(clip.caretTop < clip.boxTop,
      "the caret row was not scrolled above the top rule for this check");
    assert.ok(clip.fcClip.startsWith("inset("), `#fatcaret was not clipped: ${clip.fcClip}`);
    assert.equal(clip.liftClip, clip.fcClip, "the two layers were clipped differently");
    assert.ok(clip.fcInsetTop > 0, `#fatcaret top inset was not positive: ${clip.fcInsetTop}`);
    // the clipped-away top equals the overhang above the field, within a pixel
    assert.ok(Math.abs(clip.fcInsetTop - (clip.boxTop - clip.caretTop)) < 1.5,
      `top inset ${clip.fcInsetTop} does not match the overhang ${clip.boxTop - clip.caretTop}`);

    // and a caret on a fully visible row keeps the block unclipped
    const unclipped = await page.evaluate(() => {
      const ta = els.m1.ta;
      const view = ComposeFormat.fieldOf(ta).view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      riseBand(ta);
      document.dispatchEvent(new Event("selectionchange"));
      return true;
    });
    assert.ok(unclipped);
    await settle(page, 3);
    const clean = await page.evaluate(() => ({
      fcClip: document.getElementById("fatcaret").style.clipPath,
      caretOn: document.getElementById("fatcaret").classList.contains("on"),
    }));
    assert.ok(clean.caretOn, "no block on the last visible row");
    assert.equal(clean.fcClip, "none", `a fully visible caret was clipped: ${clean.fcClip}`);
  } finally {
    await page.close();
  }
});

test("formatted: the block tracks the caret under a scaled stage", async () => {
  const page = await browser.newPage();
  try {
    await openBoard(page, { formatted: true, awaitFonts: true });
    const off = await page.evaluate(url => {
      // the responsive build scales #stage; emulate that and confirm the fixed
      // overlay, which reads screen coordinates, still lands on the caret
      const stage = document.getElementById("stage");
      stage.style.transformOrigin = "top left";
      stage.style.transform = "scale(0.8)";
      const ta = els.m1.ta;
      ta.value = url;
      els.m1.tick();
      ta.focus();
      const view = ComposeFormat.fieldOf(ta).view;
      const pos = Math.floor(view.state.doc.length / 2);
      view.dispatch({ selection: { anchor: pos } });
      document.dispatchEvent(new Event("selectionchange"));
      return pos;
    }, WRAP_URL);
    assert.ok(off >= 0);
    await settle(page, 3);
    const read = await page.evaluate(() => {
      const ta = els.m1.ta;
      const view = ComposeFormat.fieldOf(ta).view;
      const at = view.coordsAtPos(view.state.selection.main.head,
        view.state.selection.main.assoc || -1);
      const fc = document.getElementById("fatcaret").getBoundingClientRect();
      return { caretOn: document.getElementById("fatcaret").classList.contains("on"),
        dx: fc.left - at.left, dy: fc.top - at.top };
    });
    assert.ok(read.caretOn, "no block under a scaled stage");
    assert.ok(Math.abs(read.dx) < 1.5, `scaled block sat ${read.dx}px off the caret horizontally`);
    assert.ok(Math.abs(read.dy) < 3, `scaled block sat ${read.dy}px off the caret row`);
  } finally {
    await page.close();
  }
});
