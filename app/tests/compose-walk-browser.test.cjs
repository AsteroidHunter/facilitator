// The typing walk: every kind of caret position in a card's typing box, every
// kind of edit made from each, on the Mac board and the phone page, with the
// formatting on and off, each checked against what the edit should produce.
//
// BROWSER TEST. It connects to a Chrome already running with a remote
// debugging port (CHROME_CDP_URL, http://127.0.0.1:9222 by default) and makes
// every tab it needs in the background (compose-cdp-fixture.cjs). Nothing here
// launches, activates or closes a browser.
//
// The matrix is generated (compose-walk-matrix.cjs): document shapes, the
// positions each one has (line edges and middles, marker and span edges and
// insides, picks within a line, across lines, across formatting and over all
// of it), and the edits (typing, the markdown starters with Space and a new
// line after them, Backspace and Delete with Option and Command, the new line
// key, Tab, pastes, the arrows with Option, Command and Shift then typing).
// Every step is checked against the reference (compose-walk-model.cjs): the
// words, the caret, and on the formatted face what each line shows. Every edit
// that changes the words is then undone and redone.
//
// Keys are real key events through CDP, with the edit commands a Mac attaches
// to each (deleteWordBackward and the rest), so the browser's own handling
// runs where the page leaves a key to it. A paste is a paste event dispatched
// in the page with the walk's own data; the machine's clipboard is never
// touched. The phone page is played with touch on and its on-screen keyboard
// up (the fixture's stand-in visual viewport), typed with insertText as a
// phone's keyboard types.
//
//   COMPOSE_WALK_OUT    a folder: failures.jsonl and summary.json are written there
//   COMPOSE_WALK_ONLY   a pattern over "page face shape | edit": only matching cells run
//   COMPOSE_WALK_PAGES  a comma list of mac-formatted, phone-formatted, mac-plain, phone-plain
//   COMPOSE_WALK_TABS   background tabs each page's share of the matrix is split over (4)
"use strict";
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./compose-cdp-fixture.cjs");
const M = require("./compose-walk-model.cjs");
const W = require("./compose-walk-matrix.cjs");

const { DESKTOP, PHONE, ROW, settle, card, clearLane, open, pickDesktopCard, pickPhoneCard, editorOn, until } = fixture;
const OUT = process.env.COMPOSE_WALK_OUT || "";
const ONLY = process.env.COMPOSE_WALK_ONLY ? new RegExp(process.env.COMPOSE_WALK_ONLY) : null;
const PAGES = (process.env.COMPOSE_WALK_PAGES || "mac-formatted,phone-formatted,mac-plain,phone-plain").split(",");
const KEYBOARD = 336;   // the phone's on-screen keyboard, in the stand-in viewport
const TABS = Math.max(1, +process.env.COMPOSE_WALK_TABS || 4);   // background tabs per page
const C = M.loadEditor();

// ---- keys --------------------------------------------------------------------------

const NAMED = {
  Backspace: [8, "Backspace"], Delete: [46, "Delete"], Enter: [13, "Enter", "\r"], Tab: [9, "Tab"],
  ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], z: [90, "KeyZ"],
};
function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { vk: ch.toUpperCase().charCodeAt(0), code: "Key" + ch.toUpperCase() };
  if (/^[0-9]$/.test(ch)) return { vk: 48 + +ch, code: "Digit" + ch };
  return {
    " ": { vk: 32, code: "Space" }, "-": { vk: 189, code: "Minus" }, "_": { vk: 189, code: "Minus", shift: true },
    "*": { vk: 56, code: "Digit8", shift: true }, "#": { vk: 51, code: "Digit3", shift: true },
    ".": { vk: 190, code: "Period" }, ">": { vk: 190, code: "Period", shift: true },
    "`": { vk: 192, code: "Backquote" },
  }[ch] || null;
}
// the edit commands a Mac sends with each key, as its key bindings give them
const MAC = {
  "Backspace": ["deleteBackward"], "Shift+Backspace": ["deleteBackward"], "Delete": ["deleteForward"],
  "Alt+Backspace": ["deleteWordBackward"], "Alt+Delete": ["deleteWordForward"],
  "Meta+Backspace": ["deleteToBeginningOfLine"], "Meta+Delete": ["deleteToEndOfLine"],
  "ArrowLeft": ["moveLeft"], "ArrowRight": ["moveRight"], "ArrowUp": ["moveUp"], "ArrowDown": ["moveDown"],
  "Shift+ArrowLeft": ["moveLeftAndModifySelection"], "Shift+ArrowRight": ["moveRightAndModifySelection"],
  "Shift+ArrowUp": ["moveUpAndModifySelection"], "Shift+ArrowDown": ["moveDownAndModifySelection"],
  "Alt+ArrowLeft": ["moveWordLeft"], "Alt+ArrowRight": ["moveWordRight"],
  "Shift+Alt+ArrowLeft": ["moveWordLeftAndModifySelection"], "Shift+Alt+ArrowRight": ["moveWordRightAndModifySelection"],
  "Alt+ArrowUp": ["moveBackward", "moveToBeginningOfParagraph"], "Alt+ArrowDown": ["moveForward", "moveToEndOfParagraph"],
  "Shift+Alt+ArrowUp": ["moveParagraphBackwardAndModifySelection"],
  "Shift+Alt+ArrowDown": ["moveParagraphForwardAndModifySelection"],
  "Meta+ArrowLeft": ["moveToLeftEndOfLine"], "Meta+ArrowRight": ["moveToRightEndOfLine"],
  "Meta+ArrowUp": ["moveToBeginningOfDocument"], "Meta+ArrowDown": ["moveToEndOfDocument"],
  "Shift+Meta+ArrowLeft": ["moveToLeftEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowRight": ["moveToRightEndOfLineAndModifySelection"],
  "Shift+Meta+ArrowUp": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+Meta+ArrowDown": ["moveToEndOfDocumentAndModifySelection"],
  "Home": ["scrollToBeginningOfDocument"], "End": ["scrollToEndOfDocument"],
  "Shift+Home": ["moveToBeginningOfDocumentAndModifySelection"],
  "Shift+End": ["moveToEndOfDocumentAndModifySelection"],
  "Meta+z": ["undo"], "Shift+Meta+z": ["redo"],
};
const MODS = { Alt: [1, 18, "AltLeft"], Ctrl: [2, 17, "ControlLeft"], Meta: [4, 91, "MetaLeft"], Shift: [8, 16, "ShiftLeft"] };

// One key, down and up, with its modifiers held: the event carries them, which
// is what the editor and the page read
async function press(cdp, combo) {
  const parts = combo.split("+");
  const name = parts.pop();
  let bits = 0;
  for (const m of parts) bits |= MODS[m][0];
  let vk, code, text;
  if (NAMED[name]) [vk, code, text] = NAMED[name];
  else { const k = charKey(name); vk = k.vk; code = k.code; text = name; }
  if (bits & (2 | 4)) text = undefined;
  const commands = (MAC[combo] || []).slice();
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: name, code,
    windowsVirtualKeyCode: vk, text, unmodifiedText: text, modifiers: bits, commands });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code, windowsVirtualKeyCode: vk, modifiers: bits });
}

// a character as the page's keyboard types it: a key with its text on the
// Mac, the phone keyboard's own insertion on the phone
async function typeChar(cdp, ch, phone) {
  const k = charKey(ch);
  if (phone || !k) { await cdp.send("Input.insertText", { text: ch }); return; }
  await press(cdp, (k.shift ? "Shift+" : "") + ch);
}

// ---- the page's side ---------------------------------------------------------------

function installHelper() {
  const ROW = "article.box.sel textarea";
  const row = () => document.querySelector(ROW);
  const view = () => { const f = ComposeFormat.fieldOf(row()); return f && f.view; };
  const STYLE = { "cf-em": "e", "cf-strong": "s", "cf-strike": "x", "cf-code": "c", "cf-link": "l" };
  // where a plain field's own rows wrap, read off a copy of it laid out the
  // same way
  let mirror = null;
  function plainRows(text) {
    const ta = row();
    if (!mirror) { mirror = document.createElement("div"); document.body.appendChild(mirror); }
    const cs = getComputedStyle(ta);
    for (const p of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingLeft",
                     "paddingRight", "borderLeftWidth", "borderRightWidth", "boxSizing", "tabSize", "wordSpacing"])
      mirror.style[p] = cs[p];
    Object.assign(mirror.style, { position: "absolute", left: "-9999px", top: "0", visibility: "hidden",
      whiteSpace: "pre-wrap", overflowWrap: "break-word", wordBreak: cs.wordBreak, width: ta.clientWidth + "px" });
    mirror.textContent = text + "\u200b";
    const node = mirror.firstChild, range = document.createRange();
    const tops = [];
    for (let p = 0; p < text.length; p++) {
      range.setStart(node, p); range.setEnd(node, p + 1);
      const r = range.getClientRects()[0];
      tops.push(r ? r.top : null);
    }
    return tops;
  }
  // An untouched text field laid out as the row is, with nothing of the page's
  // listening on it: what the browser itself does with a key in a plain field,
  // which the row's plain face is held to
  let reference = null;
  function ref() {
    if (reference) return reference;
    const ta = row(), cs = getComputedStyle(ta);
    reference = document.createElement("textarea");
    for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing",
                     "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth",
                     "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle", "boxSizing",
                     "whiteSpace", "overflowWrap", "wordBreak", "textIndent"])
      reference.style[p] = cs[p];
    Object.assign(reference.style, { position: "fixed", left: "0", top: "0", width: ta.offsetWidth + "px",
      height: Math.max(ta.offsetHeight, 200) + "px", opacity: "0", zIndex: "-1", resize: "none" });
    document.body.appendChild(reference);
    return reference;
  }
  window.__walk = {
    refSet(doc, anchor, head) {
      const r = ref();
      r.value = "\u2063";
      r.value = doc;
      r.focus();
      r.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
      return document.activeElement === r;
    },
    refRead() {
      return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          const r = ref(), back = r.selectionDirection === "backward";
          resolve({ doc: r.value, anchor: back ? r.selectionEnd : r.selectionStart,
                    head: back ? r.selectionStart : r.selectionEnd });
        };
        channel.port2.postMessage(0);
      });
    },
    set(doc, anchor, head, plain) {
      const r = row();
      r.value = "\u2063";
      r.value = doc;
      r.dispatchEvent(new Event("input", { bubbles: true }));
      if (!ComposeFormat.focused(r)) r.focus();
      if (plain) r.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor > head ? "backward" : "forward");
      else r.setSelectionRange(anchor, head);
      return ComposeFormat.focused(r);
    },
    // a task later, so a selection the browser itself moved (selectionchange
    // is a task of its own) has reached the editor first
    read(lines) {
      return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve(this.readNow(lines));
        channel.port2.postMessage(0);
      });
    },
    readNow(lines) {
      const r = row(), v = view();
      const out = { doc: r.value, focused: ComposeFormat.focused(r), formatted: !!v };
      if (v) { out.anchor = v.state.selection.main.anchor; out.head = v.state.selection.main.head; }
      else {
        const back = r.selectionDirection === "backward";
        out.anchor = back ? r.selectionEnd : r.selectionStart;
        out.head = back ? r.selectionStart : r.selectionEnd;
      }
      if (lines && v) out.lines = [...v.contentDOM.querySelectorAll(".cm-line")].map(line => {
        let shown = "", last = "";
        const runs = [];
        const painted = new Set();   // a bullet's own marker character is painted over once
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let n; (n = walker.nextNode());) {
          if (n.parentElement.closest(".cm-placeholder, [contenteditable=false]")) continue;
          let style = "";
          for (let el = n.parentElement; el && el !== line; el = el.parentElement)
            for (const [cls, s] of Object.entries(STYLE)) if (el.classList.contains(cls)) style += s;
          style = [...new Set(style)].sort().join("");
          const bullet = n.parentElement.closest(".cf-bullet");
          let text = n.data;
          if (bullet && !painted.has(bullet) && /[-*+]/.test(text)) { text = text.replace(/[-*+]/, "•"); painted.add(bullet); }
          // a run is the characters on show next to each other in one style
          for (const ch of text) {
            shown += ch;
            if (style && style === last) runs[runs.length - 1][0] += ch;
            else if (style) runs.push([ch, style]);
            last = style;
          }
        }
        const heading = /\bcf-h([1-6])\b/.exec(line.className);
        return { shown, runs, quote: line.classList.contains("cf-quote"), item: line.classList.contains("cf-li"),
                 bullet: !!line.querySelector(".cf-bullet"), heading: heading ? +heading[1] : 0 };
      });
      return out;
    },
    paste(plain, html) {
      const t = document.activeElement;
      const data = new DataTransfer();
      data.setData("text/plain", plain);
      if (html) data.setData("text/html", html);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      t.dispatchEvent(event);
      // a plain field puts the words in itself when nobody has taken the paste
      if (!event.defaultPrevented && t.tagName === "TEXTAREA") document.execCommand("insertText", false, plain.replace(/\r\n?/g, "\n"));
    },
    // the visual rows of the document: for each line, the positions its rows start at
    rows() {
      const r = row(), v = view(), doc = r.value;
      const out = [];
      let from = 0;
      const tops = v ? null : plainRows(doc);
      for (const text of doc.split("\n")) {
        const starts = [from];
        let last = null;
        for (let p = from; p < from + text.length; p++) {
          let top;
          if (v) { const c = v.coordsAtPos(p, 1); top = c ? Math.round(c.top) : null; }
          else top = tops[p] == null ? null : Math.round(tops[p]);
          if (top == null) continue;
          if (last != null && top > last + 2) starts.push(p);
          last = top;
        }
        out.push({ from, to: from + text.length, starts });
        from += text.length + 1;
      }
      return out;
    },
  };
}

// ---- one page ------------------------------------------------------------------------

async function openPage(name, tab) {
  const [surface, face] = name.split("-");
  // a card of its own for each tab, so no two tabs keep a draft for one card
  const id = await card(`Walk ${name} ${tab}`, "A reply to type under.");
  const setting = face === "formatted" ? "1" : "0";
  let opened;
  if (surface === "mac") {
    opened = await open("/", DESKTOP, { setting });
    await pickDesktopCard(opened.page, id);
  } else {
    opened = await open(`/m?box=${id}`, PHONE, { setting, fakeViewport: true });
    await pickPhoneCard(opened.page, id);
  }
  return { ...opened, surface, face, name, id };
}

// Every tab of a face is opened before any of them is walked: opening a tab
// clears the phone's storage, and a phone tab opened earlier would read the
// board's default face back out of it. The face is then set in each tab
// itself, and waited for.
async function readyPage(P) {
  const { page, surface, face } = P;
  const on = face === "formatted";
  await page.evaluate(want => ComposeFormat.setEnabled(want), on);
  await until(page, ([where, want]) => {
    const field = ComposeFormat.fieldOf(document.querySelector(where));
    return !!field && field.formatted() === want;
  }, "the row to wear its " + face + " face", 30000, [ROW, on]);
  await page.evaluate(installHelper);
  await page.evaluate(where => document.querySelector(where).focus(), ROW);
  P.sent = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/send") P.sent.push(request.postData());
  });
  P.cdp = await page.target().createCDPSession();
  if (surface === "phone") {
    await page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height - KEYBOARD);
    await until(page, () => document.body.classList.contains("kb"), "the phone's keyboard to be up", 5000);
  }
  return P;
}

// the rows a position stands on, for the reference: its row's start and end
function rowsOf(table) {
  return pos => {
    const line = table.find(l => pos >= l.from && pos <= l.to) || table[table.length - 1];
    let start = line.from, end = line.to;
    for (let k = 0; k < line.starts.length; k++) {
      if (line.starts[k] <= pos) { start = line.starts[k]; end = k + 1 < line.starts.length ? line.starts[k + 1] : line.to; }
    }
    return { from: start, to: end };
  };
}
function rowIndex(table, pos) {
  let index = 0;
  for (const line of table) {
    if (pos >= line.from && pos <= line.to) {
      let k = 0;
      for (let j = 0; j < line.starts.length; j++) if (line.starts[j] <= pos) k = j;
      return index + k;
    }
    index += line.starts.length;
  }
  return index - 1;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = s => JSON.stringify(s.doc) + " @" + (s.anchor === s.head ? s.head : s.anchor + ".." + s.head);

// ---- one cell ----------------------------------------------------------------------------

// The plain face's reference: the same steps in the untouched field, each
// state it leaves, and where undo takes it. A new line goes in as the field's
// own line break, and Tab, which the board answers, stops it.
async function referenceRun(P, doc, at, edit) {
  const { page, cdp, surface } = P;
  await page.evaluate((d, a, h) => window.__walk.refSet(d, a, h), doc, at.anchor, at.head);
  const steps = [];
  let before = doc, base = null, changes = 0;
  for (const st of edit.steps) {
    if (st[0] === "key" && /Tab$/.test(st[1])) break;
    if (st[0] === "type") await typeChar(cdp, st[1], surface === "phone");
    else if (st[0] === "nl") await page.evaluate(() => document.execCommand("insertText", false, "\n"));
    else if (st[0] === "paste") await page.evaluate((a, b) => window.__walk.paste(a, b), st[1].plain, st[1].html || null);
    else await press(cdp, st[1]);
    const got = await page.evaluate(() => window.__walk.refRead());
    if (got.doc !== before) { if (base == null) base = before; changes++; }
    before = got.doc;
    steps.push(M.st(got.doc, got.anchor, got.head));
  }
  let undo = null, redo = null, undone = 0;
  for (let i = 0; base != null && i < changes + 1; i++) {
    await press(cdp, "Meta+z");
    undone++;
    undo = await page.evaluate(() => window.__walk.refRead());
    if (undo.doc === base) break;
  }
  if (undone) {
    for (let i = 0; i < undone; i++) await press(cdp, "Shift+Meta+z");
    redo = await page.evaluate(() => window.__walk.refRead());
  }
  return { steps, undo, redo };
}

async function runCell(P, shape, doc, at, edit, table) {
  const { page, cdp, face, surface } = P;
  const phone = surface === "phone";
  const plain = face === "plain";
  const layout = { rows: rowsOf(table) };
  const reference = plain ? await referenceRun(P, doc, at, edit) : null;
  await page.evaluate((d, a, h, p) => window.__walk.set(d, a, h, p), doc, at.anchor, at.head, plain);
  let model = M.st(doc, at.anchor, at.head);
  let base = null;           // the state the first change was made from, for undo
  let changes = 0;
  let blurred = false;
  const fail = (aspect, expected, actual, rule) => ({
    page: P.name, shape, doc, at: at.label, anchor: at.anchor, head: at.head, edit: edit.name, aspect, rule,
    expected, actual,
  });
  for (const [k, st] of edit.steps.entries()) {
    const want = reference && reference.steps[k] ? { state: reference.steps[k], rule: "the browser's own field" }
      : W.step(model, st, face, layout);
    const before = model;
    if (st[0] === "type") await typeChar(cdp, st[1], phone);
    else if (st[0] === "nl") await press(cdp, phone ? "Enter" : "Shift+Enter");
    else if (st[0] === "paste") await page.evaluate((a, b) => window.__walk.paste(a, b), st[1].plain, st[1].html || null);
    else await press(cdp, st[1]);
    const last = k === edit.steps.length - 1;
    const got = await page.evaluate(lines => window.__walk.read(lines), last && !plain);
    const now = M.st(got.doc, got.anchor, got.head);
    if (got.formatted !== !plain) return fail("face", face, got.formatted ? "formatted" : "plain", "the row's face");
    if (want.paragraph) {
      // the browser's own paragraph step: the next or the last line, or the
      // document's edge from its first or last line
      const lines = M.splitLines(before.doc);
      const start = M.lineAt(lines, before.head).n;
      const target = start + want.paragraph;
      const ok = got.doc === before.doc && got.anchor === before.anchor &&
        (target < 0 ? got.head === 0 : target >= lines.length ? got.head === doc.length
          : M.lineAt(lines, got.head).n === target);
      if (!ok) return fail("caret", "one paragraph " + (want.paragraph > 0 ? "down" : "up") + " from " + show(before), show(now), "paragraph move");
      model = now;
      continue;
    }
    if (want.vertical) {
      const shift = want.shift;
      const empty = before.anchor === before.head;
      let ok;
      if (!shift && !empty) {
        const head = want.vertical > 0 ? Math.max(before.anchor, before.head) : Math.min(before.anchor, before.head);
        ok = got.doc === before.doc && got.anchor === head && got.head === head;
      } else {
        const start = rowIndex(table, before.head);
        const rows = table.reduce((n, l) => n + l.starts.length, 0);
        const head = got.head;
        // cm: up on the first row goes to the start of the words, and from
        // there, where it cannot move, to where the row's words on show begin
        // (cursorLineUp); down on the last row the same way at the end
        const hidden = M.hiddenSet(C, before.doc, [{ from: Math.min(before.anchor, before.head), to: Math.max(before.anchor, before.head) }]);
        let shown0 = 0, shownEnd = doc.length;
        while (!shift && before.head === 0 && shown0 < table[0].to && hidden.has(shown0)) shown0++;
        while (!shift && before.head === doc.length && shownEnd > 0 && hidden.has(shownEnd - 1)) shownEnd--;
        const okRow = want.vertical < 0 && start === 0 ? head === shown0
          : want.vertical > 0 && start === rows - 1 ? head === shownEnd
          : rowIndex(table, head) === start + want.vertical;
        ok = got.doc === before.doc && okRow && (shift ? got.anchor === before.anchor : got.anchor === got.head);
      }
      if (!ok) return fail("caret", "one row " + (want.vertical > 0 ? "down" : "up") + " from " + show(before), show(now), "vertical move");
      model = now;
      continue;
    }
    if (want.blurred) {
      if (got.focused || got.doc !== before.doc) return fail("focus", "the box left, words unchanged", (got.focused ? "still in the box " : "") + show(now), want.rule);
      blurred = true;
      break;
    }
    if (got.doc !== want.state.doc) return fail("words", show(want.state), show(now), want.rule);
    if (got.anchor !== want.state.anchor || got.head !== want.state.head) return fail("caret", show(want.state), show(now), want.rule);
    // the editor's history holds an edit from the first character typed or
    // pasted, even one that writes the words back as they were
    const edits = got.doc !== before.doc || (!plain && (st[0] === "type" || st[0] === "paste"));
    if (edits) { if (!base) base = before; changes++; }
    model = want.state;
    if (last && !plain) {
      const expected = M.drawn(C, model.doc, [{ from: Math.min(model.anchor, model.head), to: Math.max(model.anchor, model.head) }]);
      const actual = got.lines;
      // an empty line hangs on an item's column or does not, and either way
      // there is nothing on it to see
      const alike = (e, a) => !!a && same({ ...e, item: e.shown ? e.item : null }, { ...a, item: e.shown ? a.item : null });
      if (expected.length !== actual.length || expected.some((line, i) => !alike(line, actual[i]))) {
        const n = expected.findIndex((line, i) => !alike(line, actual[i]));
        return fail("drawing", { line: n + 1, ...expected[n] }, { line: n + 1, ...(actual[n] || null) }, "drawn");
      }
    }
  }
  if (blurred || !base) return null;
  // undo brings the words back, and redo puts the edit back again
  // The formatted face's history is fresh for each cell, so undo is pressed
  // once more than there were edits and a press with nothing left does
  // nothing. The plain field's own history runs on from earlier cells, so
  // it is pressed until the words are back, as its reference was.
  let undone = 0, back = null;
  for (let i = 0; i < changes + 1; i++) {
    await press(cdp, "Meta+z");
    undone++;
    back = await page.evaluate(() => window.__walk.read(false));
    if (plain && back.doc === base.doc) break;
  }
  if (back.doc !== base.doc) return fail("undo", show(base), show(M.st(back.doc, back.anchor, back.head)), "undo");
  // the browser's own field picks out the words an undo puts back, so the
  // plain face is held to where its reference undo leaves the selection
  const undoTo = reference && reference.undo ? M.st(reference.undo.doc, reference.undo.anchor, reference.undo.head) : base;
  if (back.anchor !== undoTo.anchor || back.head !== undoTo.head)
    return fail("undo caret", show(undoTo), show(M.st(back.doc, back.anchor, back.head)), "undo");
  for (let i = 0; i < undone; i++) await press(cdp, "Shift+Meta+z");
  const again = await page.evaluate(() => window.__walk.read(false));
  // and the plain face is held to where its reference's redo leaves the words
  const redoTo = reference && reference.redo ? M.st(reference.redo.doc, reference.redo.anchor, reference.redo.head) : model;
  if (again.doc !== redoTo.doc) return fail("redo", show(redoTo), show(M.st(again.doc, again.anchor, again.head)), "redo");
  return null;
}

async function sendCell(P, shape, doc, at) {
  const { page, cdp, face } = P;
  const fail = (aspect, expected, actual) => ({ page: P.name, shape, doc, at: at.label, anchor: at.anchor,
    head: at.head, edit: "Return sends", aspect, rule: "box: Return sends the words as typed", expected, actual });
  await page.evaluate((d, a, h, p) => window.__walk.set(d, a, h, p), doc, at.anchor, at.head, face === "plain");
  P.sent.length = 0;
  await press(cdp, "Enter");
  for (let tries = 0; tries < 40 && !P.sent.length; tries++) await settle(50);
  const got = await page.evaluate(() => window.__walk.readNow(false));
  if (P.sent.length !== 1 || P.sent[0] !== doc.trim()) return fail("sent", [doc.trim()], P.sent.slice());
  if (got.doc !== "") return fail("words", "the row empty", show(M.st(got.doc, got.anchor, got.head)));
  await settle(300);   // the send lands before the next one, so no Return counts as its second
  return null;
}

// ---- the walk ----------------------------------------------------------------------------

// One tab's share of a page's matrix: every TABS-th position of every shape.
// The tabs of a page have the one layout, so they read the same positions.
async function walkTab(P, tab) {
  const name = P.name;
  const failures = [];
  let cells = 0, k = 0;
  try {
    for (const [shape, doc] of Object.entries(W.SHAPES)) {
      await P.page.evaluate((d) => window.__walk.set(d, 0, 0, false), doc);
      const table = await P.page.evaluate(() => window.__walk.rows());
      const wraps = new Set(table.flatMap(l => l.starts.slice(1)));
      for (const at of W.positions(doc, C, wraps, P.face)) {
        if (k++ % TABS !== tab) continue;
        for (const edit of W.edits(P.face)) {
          if (ONLY && !ONLY.test(`${name} ${shape} | ${edit.name}`)) continue;
          cells++;
          let failure;
          try { failure = await runCell(P, shape, doc, at, edit, table); }
          catch (error) { failure = { page: name, shape, doc, at: at.label, edit: edit.name, aspect: "error", actual: String(error && error.stack || error) }; }
          if (failure) failures.push(failure);
        }
      }
    }
    // Return sends, on the Mac board and on the phone with its own keyboard
    // down (a keyboard paired with it), from any place in the words: what
    // goes is the words exactly as they were typed, and the row is left
    // empty. Walked last, since a message sent changes the card under the
    // walk, and never on an empty row, where Return moves on to another card.
    if (!ONLY || ONLY.test(`${name} x | Return sends`)) {
      if (P.surface === "phone") {
        await P.page.evaluate(h => window.__keyboard.set(h, 0), PHONE.height);
        await until(P.page, () => !document.body.classList.contains("kb"), "the phone's keyboard to go down", 5000);
      }
      for (const [shape, doc] of Object.entries(W.SHAPES)) {
        if (!doc.trim()) continue;
        const middle = W.positions(doc, C, new Set(), P.face).find(at => at.label === "line 1 middle");
        for (const at of [{ anchor: doc.length, head: doc.length, label: "the end" }, middle]) {
          if (!at || k++ % TABS !== tab) continue;
          if (ONLY && !ONLY.test(`${name} ${shape} | Return sends`)) continue;
          cells++;
          let failure;
          try { failure = await sendCell(P, shape, doc, at); }
          catch (error) { failure = { page: name, shape, doc, at: at.label, edit: "Return sends", aspect: "error", actual: String(error && error.stack || error) }; }
          if (failure) failures.push(failure);
        }
      }
    }
  } finally {
    try { await P.cdp.detach(); } catch (error) {}
    try { await P.page.close(); } catch (error) {}
  }
  return { cells, failures, problems: P.problems };
}

async function walkPage(tabs) {
  const parts = await Promise.all(tabs.map((P, tab) => walkTab(P, tab)));
  return { cells: parts.reduce((n, p) => n + p.cells, 0), failures: parts.flatMap(p => p.failures),
           problems: parts.flatMap(p => p.problems) };
}

function summarise(name, result) {
  const groups = new Map();
  for (const f of result.failures) {
    const key = `${f.edit} | ${f.aspect} | ${f.rule || ""}`;
    if (!groups.has(key)) groups.set(key, { key, count: 0, example: f });
    groups.get(key).count++;
  }
  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name + "-failures.jsonl"), result.failures.map(f => JSON.stringify(f)).join("\n") + "\n");
    fs.writeFileSync(path.join(OUT, name + "-summary.json"), JSON.stringify({ cells: result.cells,
      failures: result.failures.length, problems: result.problems, groups: sorted }, null, 1));
  }
  return sorted;
}

before(async () => {
  await fixture.start();
  await clearLane();
});
after(async () => { await fixture.stop(); });

// The pages of one face are walked at once. The two faces are walked one after
// the other: opening a page writes the board's own formatting setting, which
// every desktop page reads, and the phone's, which every phone tab shares.
for (const face of ["formatted", "plain"]) {
  const names = PAGES.filter(name => name.endsWith("-" + face));
  if (!names.length) continue;
  test(`the typing walk with the formatting ${face === "formatted" ? "on" : "off"}`, { timeout: 4 * 60 * 60 * 1000 }, async t => {
    const opened = [];
    for (const name of names) for (let tab = 0; tab < TABS; tab++) opened.push(await openPage(name, tab));
    for (const P of opened) await readyPage(P);
    const results = await Promise.all(names.map(name => walkPage(opened.filter(P => P.name === name))));
    for (const [i, name] of names.entries()) {
      await t.test(name, () => {
        const result = results[i];
        const groups = summarise(name, result);
        const lines = groups.slice(0, 40).map(g => `${g.count} x ${g.key}\n    ${g.example.shape}: ${JSON.stringify(g.example.doc)} at ${g.example.at}` +
          `\n    expected ${JSON.stringify(g.example.expected)}\n    actual   ${JSON.stringify(g.example.actual)}`);
        assert.equal(result.failures.length, 0,
          `${result.failures.length} of ${result.cells} cells failed on ${name}\n` + lines.join("\n"));
        assert.deepEqual(result.problems, []);
      });
    }
  });
}
