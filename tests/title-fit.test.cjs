// A card's big title keeps to two lines: past two lines at the sheet's size it
// shrinks to the largest size that keeps two, down to 20px, and once two lines at
// 20px are full a key adds nothing and a paste puts in the words that fit. A title
// the reader did not type is cut at the foot of its second line, its words kept.
// The shared fitTitle, the typing limit and editTitle run out of card-logic.js, and
// the Mac's pasteIntoTitle out of index.html, over a small document whose lines
// are broken by a fixed rule (a letter is 0.56em, a space 0.28em, words wrap
// greedily, a <br> breaks), so every size and line count here is exact.
// No browser, layout engine, server or live board is involved.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const logic = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const mac = readFileSync(path.join(ROOT, "index.html"), "utf8");
const phone = readFileSync(path.join(ROOT, "m.html"), "utf8");
const runbook = readFileSync(path.join(ROOT, "RUNBOOK.md"), "utf8");

function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b + end.length);
}

// the two big titles: the Mac's open card (30px on a 1.25 line) and the phone's
// (24 of its page pixels at 0.985, on a whole 30px line). widths are the words' room
const SHEETS = {
  mac: { fontSize: 30, lineHeight: 37.5, width: 480 },
  phone: { fontSize: 24 * 0.985, lineHeight: 30, width: 366 },
};
const LETTER = 0.56, SPACE = 0.28;

// ---- a small document -------------------------------------------------------
function world(sheet) {
  let body = null;
  const sel = { range: null, get rangeCount() { return this.range ? 1 : 0; }, getRangeAt() { return this.range; },
    removeAllRanges() { this.range = null; }, addRange(r) { this.range = r; },
    get focusNode() { return this.range && this.range.endContainer; }, get focusOffset() { return this.range && this.range.endOffset; } };
  const doc = { activeElement: null };

  class Node {
    get nextSibling() {
      const p = this.parentNode;
      return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null;
    }
    get isConnected() { for (let n = this; n; n = n.parentNode) if (n === body) return true; return false; }
    remove() {
      if (!this.parentNode) return;
      this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  class Text extends Node {
    constructor(data) { super(); this.nodeType = 3; this.data = data; this.parentNode = null; }
    get textContent() { return this.data; }
    cloneNode() { return new Text(this.data); }
  }
  class Frag {
    constructor() { this.nodeType = 11; this.childNodes = []; }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
  }
  const style = () => {
    const props = new Map();
    return {
      setProperty(k, v) { props.set(k, String(v)); }, removeProperty(k) { props.delete(k); },
      getPropertyValue(k) { return props.get(k) || ""; },
      get maxHeight() { return props.get("max-height") || ""; },
      get cssText() { return [...props].map(([k, v]) => `${k}:${v}`).join("; "); },
      set cssText(v) {
        props.clear();
        for (const part of String(v).split(";")) {
          const i = part.indexOf(":");
          if (i > 0) props.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
        }
      },
    };
  };
  class Elem extends Node {
    constructor(tag, sheetOf) {
      super();
      this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.childNodes = []; this.parentNode = null;
      this.attributes = {}; this.style = style(); this.sheet = sheetOf || null; this.listeners = {}; this.hidden = false;
      const names = new Set();
      this.classList = { contains: n => names.has(n), add: n => names.add(n), remove: n => names.delete(n),
        toggle: (n, on) => ((on ?? !names.has(n)) ? names.add(n) : names.delete(n), names.has(n)) };
    }
    get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
    set textContent(v) {
      for (const n of this.childNodes) n.parentNode = null;
      this.childNodes = [];
      if (v) this.appendChild(new Text(String(v)));
    }
    get firstChild() { return this.childNodes[0] || null; }
    get isContentEditable() { return "contenteditable" in this.attributes; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(n) { return this.insertBefore(n, null); }
    insertBefore(n, ref) {
      if (n.nodeType === 11) { for (const c of [...n.childNodes]) this.insertBefore(c, ref); n.childNodes = []; return n; }
      if (n.parentNode && n.parentNode.nodeType !== 11) n.remove();
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
      n.parentNode = this;
      return n;
    }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    cloneNode(deep) {
      const c = new Elem(this.tagName, this.sheet);
      Object.assign(c.attributes, this.attributes);
      c.style.cssText = this.style.cssText;
      if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
      return c;
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    getClientRects() {
      for (let n = this; n; n = n.parentNode) if (n.hidden) return [];
      return this.isConnected ? [{ top: 0, bottom: 1, height: 1, width: 1 }] : [];
    }
    focus() { doc.activeElement = this; }
  }

  const computed = el => {
    const s = el.style, sh = el.sheet || {};
    return {
      fontSize: s.getPropertyValue("font-size") || sh.fontSize + "px",
      lineHeight: s.getPropertyValue("line-height") || sh.lineHeight + "px",
      width: s.getPropertyValue("width") || sh.width + "px",
    };
  };
  // the line boxes of an element's words: runs split at <br>, words laid greedily.
  // each line also says where in the words it starts (from), for a caret
  function lineBoxes(el) {
    const runs = [""];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) runs[runs.length - 1] += c.data;
        else if (c.tagName === "BR") runs.push("");
        else walk(c);
      }
    })(el);
    if (runs.length > 1 && runs[runs.length - 1] === "") runs.pop();   // a closing break starts no line
    const cs = computed(el), size = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight), room = parseFloat(cs.width);
    const lines = [];
    let base = 0;
    for (const run of runs) {
      const words = [...run.matchAll(/[^ \t\n]+/g)];
      if (!words.length) { if (runs.length > 1) lines.push({ width: 0, from: base }); base += run.length + 1; continue; }
      let cur = null, from = 0;
      for (const m of words) {
        const ww = m[0].length * LETTER * size;
        if (cur === null) { cur = ww; from = m.index; }
        else if (cur + SPACE * size + ww <= room + 1e-9) cur += SPACE * size + ww;
        else { lines.push({ width: cur, from: base + from }); cur = ww; from = m.index; }
      }
      lines.push({ width: cur, from: base + from });
      base += run.length + 1;
    }
    // an engine may lay each line at its own rounding of the line height
    const pitch = sheet.round ? sheet.round(lh) : lh;
    return lines.map((l, i) => ({ top: i * pitch, bottom: i * pitch + 0.97 * size, height: 0.97 * size, ...l }));
  }

  class Range {
    constructor() { this.startContainer = this.endContainer = null; this.startOffset = this.endOffset = 0; }
    // as in the DOM, a start set past the end (or with no end yet) collapses the range there
    setStart(n, o) {
      this.startContainer = n; this.startOffset = o;
      if (!this.endContainer || (this.endContainer === n && this.endOffset < o)) this.setEnd(n, o);
    }
    setEnd(n, o) { this.endContainer = n; this.endOffset = o; }
    selectNodeContents(n) { this.setStart(n, 0); this.setEnd(n, n.nodeType === 3 ? n.data.length : n.childNodes.length); }
    same() { assert.equal(this.startContainer, this.endContainer, "the model keeps a range inside one node"); }
    toString() {
      this.same();
      const c = this.startContainer;
      return c.nodeType === 3 ? c.data.slice(this.startOffset, this.endOffset)
        : c.childNodes.slice(this.startOffset, this.endOffset).map(n => n.textContent).join("");
    }
    deleteContents() {
      this.same();
      const c = this.startContainer;
      if (c.nodeType === 3) c.data = c.data.slice(0, this.startOffset) + c.data.slice(this.endOffset);
      else for (const n of c.childNodes.slice(this.startOffset, this.endOffset)) n.remove();
      this.setEnd(c, this.startOffset);
    }
    insertNode(n) {
      const c = this.startContainer;
      if (c.nodeType === 3) {
        const rest = new Text(c.data.slice(this.startOffset));
        c.data = c.data.slice(0, this.startOffset);
        c.parentNode.insertBefore(rest, c.nextSibling);
        c.parentNode.insertBefore(n, rest);
      } else c.insertBefore(n, c.childNodes[this.startOffset] || null);
    }
    getClientRects() {
      const c = this.startContainer;
      if (c === this.endContainer && this.startOffset === this.endOffset) {
        // a caret in a title's words: the box of the line its offset stands on; a
        // caret between elements has none, as in the browsers
        if (c.nodeType !== 3) return [];
        let on = null;
        for (const l of lineBoxes(c.parentNode)) if (l.from <= this.startOffset) on = l;
        return on ? [on] : [];
      }
      return lineBoxes(c);
    }
    getBoundingClientRect() { return { top: 0, bottom: 0, height: 0, width: 0 }; }
  }

  // the editor's own insertion where the selection stands, the caret after it
  function put(text) {
    const r = sel.range;
    r.deleteContents();
    const c = r.startContainer;
    if (c.nodeType === 3) {
      c.data = c.data.slice(0, r.startOffset) + text + c.data.slice(r.startOffset);
      const o = r.startOffset + text.length;
      r.setStart(c, o); r.setEnd(c, o);
    } else {
      const n = c.insertBefore(new Text(text), c.childNodes[r.startOffset] || null);
      r.setStart(n, text.length); r.setEnd(n, text.length);
    }
  }
  function backspace() {
    const r = sel.range, c = r.startContainer;
    if (r.startOffset !== r.endOffset) { r.deleteContents(); return; }
    if (c.nodeType === 3 && r.startOffset > 0) {
      c.data = c.data.slice(0, r.startOffset - 1) + c.data.slice(r.startOffset);
      r.setStart(c, r.startOffset - 1); r.setEnd(c, r.startOffset);
    }
  }

  const observers = [];
  const posts = [];
  const execs = [];
  const context = vm.createContext({
    Date, setTimeout, clearTimeout, setInterval, clearInterval, console,
    document: {
      get activeElement() { return doc.activeElement; },
      createRange: () => new Range(),
      createElement: tag => new Elem(tag),
      createTextNode: data => new Text(data),
      createDocumentFragment: () => new Frag(),
      addEventListener() {},
      execCommand(cmd, ui, text) {
        execs.push(text);
        if (cmd === "insertText") put(text);
        if (doc.activeElement && doc.activeElement.oninput) doc.activeElement.oninput();
        return true;
      },
    },
    getComputedStyle: computed,
    getSelection: () => sel,
    ResizeObserver: class { constructor(cb) { this.cb = cb; this.watched = []; observers.push(this); } observe(n) { this.watched.push(n); } },
    fetch: (url, opts) => { posts.push({ url, body: opts && opts.body }); return Promise.resolve({}); },
    poll() {}, lastState: null, els: {}, selectedId: "7",
  });
  context.window = context;
  vm.runInContext(logic, context, { filename: "card-logic.js" });

  body = new Elem("body");
  const box = body.appendChild(new Elem("article"));
  const head = box.appendChild(new Elem("div"));
  const title = head.appendChild(new Elem("span", sheet));
  const ta = { focus() { doc.activeElement = ta; } };
  const el = { box, titleEl: title, ta };
  context.els["7"] = el;

  // the caret at a place in the title's one run of words, and where each line starts
  const caretAt = o => {
    const r = new Range(), n = title.childNodes[0];
    r.setStart(n, o); r.setEnd(n, o);
    sel.range = r;
  };
  const lineStarts = () => lineBoxes(title).map(l => l.from);
  const caretAtEnd = () => {
    const r = new Range(), last = title.childNodes[title.childNodes.length - 1];
    if (last && last.nodeType === 3) { r.setStart(last, last.data.length); r.setEnd(last, last.data.length); }
    else { r.setStart(title, title.childNodes.length); r.setEnd(title, title.childNodes.length); }
    sel.range = r;
  };
  // an input the reader makes: beforeinput to the title's listeners, then the
  // editor's own change and input unless a listener held it back
  function input(inputType, data, dataTransfer) {
    const r = sel.range;
    const e = {
      inputType, data: data === undefined ? null : data, dataTransfer, isComposing: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      getTargetRanges: () => [{ startContainer: r.startContainer, startOffset: r.startOffset,
        endContainer: r.endContainer, endOffset: r.endOffset }],
    };
    for (const fn of title.listeners.beforeinput || []) fn(e);
    if (e.defaultPrevented) return e;
    if (inputType === "deleteContentBackward") backspace();
    else put(data != null ? data : dataTransfer.getData("text/plain"));
    if (title.oninput) title.oninput();
    return e;
  }
  const type = text => { let kept = 0; for (const ch of text) if (!input("insertText", ch).defaultPrevented) kept++; return kept; };
  const key = (k, mods = {}) => {
    const e = { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false,
      defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, ...mods };
    title.onkeydown(e);
    return e;
  };
  // what the title shows: its size, its lines, whether it is cut
  const lines = () => lineBoxes(title).length;
  const size = () => parseFloat(computed(title).fontSize);
  const shown = () => ({
    size: size(), lines: lines(), inline: title.style.getPropertyValue("font-size") !== "",
    cut: title.style.getPropertyValue("max-height"), overflow: title.style.getPropertyValue("overflow"),
  });
  // the lines `text` takes at `px` in this title
  const linesAt = (text, px) => {
    const probe = title.cloneNode(false);
    probe.textContent = text;
    probe.style.cssText = `font-size:${px}px; line-height:${px * sheet.lineHeight / sheet.fontSize}px`;
    return lineBoxes(probe).length;
  };
  return { context, title, box, el, sel, caretAt, lineStarts, caretAtEnd, input, type, key, lines, size, shown, linesAt,
    observers, posts, execs, put, Text, Elem };
}

const WORDS = ("the reply about the board keeps its title on two lines while the owner types more words into it " +
  "and every word after that waits for a shorter name so nothing runs on to a third line").split(" ");
const words = n => Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ");
// the shortest run of WORDS that takes `want` lines at `px` on this sheet
function wordsFor(w, want, px) {
  for (let n = 1; n < 200; n++) if (w.linesAt(words(n), px) >= want) return words(n);
  throw new Error("no text found");
}

for (const [name, sheet] of Object.entries(SHEETS)) {
  test(`${name}: one line and two lines at the sheet's size stand exactly as the sheet draws them`, () => {
    for (const want of [1, 2]) {
      const w = world(sheet);
      let text = "";
      for (let n = 1; w.linesAt(words(n), sheet.fontSize) <= want; n++) text = words(n);
      w.title.textContent = text;
      w.context.fitTitle(w.title);
      assert.equal(w.lines(), want);
      assert.equal(w.title.style.cssText, "", `${want} line(s) carry no size of their own`);
      assert.equal(w.size(), sheet.fontSize);
    }
  });

  test(`${name}: a title that would take a third line takes the largest size that keeps two, measured`, () => {
    const w = world(sheet);
    const text = wordsFor(w, 3, sheet.fontSize);
    w.title.textContent = text;
    w.context.fitTitle(w.title);
    const s = w.size();
    assert.ok(s > 20 && s < sheet.fontSize, `size ${s}`);
    assert.equal(w.lines(), 2);
    assert.ok(w.linesAt(text, s + 0.05) > 2, "a twentieth of a pixel larger takes a third line");
    // the line keeps the sheet's own proportion to the letters
    const lh = parseFloat(w.title.style.getPropertyValue("line-height"));
    assert.ok(Math.abs(lh / s - sheet.lineHeight / sheet.fontSize) < 1e-9);
    assert.equal(w.shown().cut, "", "a title that fits is not cut");
  });

  test(`${name}: typing shrinks the title a little at a time down to 20px, then letters add nothing`, () => {
    const w = world(sheet);
    w.title.textContent = wordsFor(w, 2, sheet.fontSize);
    w.context.editTitle("7");
    w.caretAtEnd();
    const sizes = [w.size()];
    let refused = 0;
    for (const ch of " " + words(60)) {
      const e = w.input("insertText", ch);
      if (e.defaultPrevented) { refused++; continue; }
      sizes.push(w.size());
      assert.ok(w.lines() <= 2, `a third line after ${JSON.stringify(w.title.textContent)}`);
    }
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] <= sizes[i - 1] + 1e-9, "the title never grows while words are added");
      assert.ok(sizes[i - 1] - sizes[i] < 2, `one key moved the size by ${sizes[i - 1] - sizes[i]}`);
    }
    // the size moves where the words' own breaks put it, measured, and not along a
    // few fixed steps: it holds while letters fill the second line and gives way as
    // a word can move up, so the phone's shorter run has fewer stops than the Mac's
    const between20 = [...new Set(sizes.map(s => s.toFixed(3)))].map(Number).filter(s => s > 20 && s < sheet.fontSize);
    assert.ok(between20.length >= 3, "measured sizes on the way down: " + between20.join(" "));
    assert.ok(between20.some(s => Math.abs(s * 4 - Math.round(s * 4)) > 0.01), "not a grid of fixed steps: " + between20.join(" "));
    assert.ok(refused > 0, "letters past the limit were refused");
    const full = w.title.textContent;
    // full: one more letter would need less than 20px, so it stands within a letter's worth of 20
    assert.ok(w.size() >= 20 && w.size() < 21, `the smallest size is 20, got ${w.size()}`);
    assert.ok(w.linesAt(full.trimEnd() + "x", 20) > 2, "one more letter does not fit at 20px");
    assert.equal(w.lines(), 2);
    // more letters change nothing, and no message is added anywhere
    assert.equal(w.type("xyz"), 0);
    assert.equal(w.title.textContent, full);
    assert.equal(w.posts.length, 0);
    assert.deepEqual(w.execs, []);
  });

  test(`${name}: at the limit Backspace, arrows, selection and the card's keys still work, and words grow back`, () => {
    const w = world(sheet);
    w.title.textContent = wordsFor(w, 2, sheet.fontSize);
    const start = w.title.textContent;
    w.context.editTitle("7");
    w.caretAtEnd();
    w.type(" " + words(60));
    assert.ok(w.size() < 21);
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      const e = w.key(k);
      assert.equal(e.defaultPrevented, false, k);
    }
    // a section chord goes on to the page as before (pageChord)
    assert.equal(w.key("]", { ctrlKey: true, shiftKey: true }).stopped, false);
    // Backspace is never held back, and each one lets the title grow again
    let last = w.size();
    while (w.title.textContent.length > start.length) {
      const e = w.input("deleteContentBackward");
      assert.equal(e.defaultPrevented, false);
      assert.ok(w.size() >= last - 1e-9, "deleting never shrinks the title");
      last = w.size();
    }
    assert.equal(w.title.textContent, start);
    assert.equal(w.title.style.getPropertyValue("font-size"), "", "back to the sheet's own size");
    // a selection typed over with a shorter word goes in
    w.type(" " + words(60));
    const r = w.sel.range, c = r.startContainer;
    r.setStart(c, c.data.length - 10);
    const e = w.input("insertText", "a");
    assert.equal(e.defaultPrevented, false);
    // Enter keeps the name as the title shows it
    w.key("Enter");
    assert.equal(w.title.isContentEditable, false);
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0].body, w.title.textContent);
  });

  test(`${name}: a paste puts in the words that fit and stops at a whole word`, () => {
    const w = world(sheet);
    w.title.textContent = "Short name";
    w.context.editTitle("7");
    w.caretAtEnd();
    const paste = " " + words(40);
    const e = w.input("insertFromPaste", null, { getData: () => paste });
    assert.equal(e.defaultPrevented, true);
    const text = w.title.textContent;
    assert.ok(text.length > "Short name".length + 10, "the words that fit went in");
    assert.ok(paste.startsWith(text.slice("Short name".length)), "nothing but the paste's own start went in");
    const next = paste.slice(text.length - "Short name".length);
    assert.match(next, /^ \S/, "the cut falls between two words");
    assert.equal(w.lines(), 2);
    assert.ok(w.linesAt(text + next.match(/^ \S+/)[0], 20) > 2, "the next word would not fit at 20px");
    // a paste that fits goes in by the editor's own hand
    const v = world(sheet);
    v.title.textContent = "Short";
    v.context.editTitle("7");
    v.caretAtEnd();
    assert.equal(v.input("insertFromPaste", null, { getData: () => " name" }).defaultPrevented, false);
    assert.equal(v.title.textContent, "Short name");
  });

  test(`${name}: a title set by an agent past two lines at 20px is cut at the foot of the second line, its words kept`, () => {
    const w = world(sheet);
    const long = words(70);
    w.title.textContent = long;
    w.context.fitTitle(w.title);
    const s = w.shown();
    const twoLines = 2 * 20 * sheet.lineHeight / sheet.fontSize;
    assert.equal(s.size, 20);
    assert.ok(Math.abs(parseFloat(s.cut) - twoLines) < 1e-9, `cut after exactly two lines, ${s.cut}`);
    assert.equal(s.overflow, "hidden");
    assert.equal(w.title.textContent, long, "the stored title is not changed");
    assert.ok(!/…|\.\.\./.test(w.title.textContent), "no ellipsis is written");
    // renamed, it keeps the very same two line box at the same size: no third line
    // shows, and nothing in the title's own style moves as the rename starts
    const style = () => w.title.style.cssText.split("; ").sort().join("; ");
    const atRest = style();
    w.context.editTitle("7");
    assert.equal(w.title.isContentEditable, true);
    assert.equal(style(), atRest);
    assert.deepEqual(w.shown(), s);
    // scrolled a line down to the caret, a fit while it is renamed keeps that line
    const line = 20 * sheet.lineHeight / sheet.fontSize;
    w.title.scrollTop = line;
    w.context.fitTitle(w.title);
    assert.equal(w.title.scrollTop, line);
    w.caretAtEnd();
    assert.equal(w.type("more"), 0, "nothing can be added to it");
    assert.equal(w.input("deleteContentBackward").defaultPrevented, false, "but it can be cut down");
    assert.equal(w.title.scrollTop, line, "a letter taken out keeps the lines in view");
    assert.equal(style(), atRest);
    // Escape puts the stored title back, cut again, at its first two lines
    w.key("Escape");
    assert.equal(w.title.textContent, long);
    assert.equal(style(), atRest);
    assert.equal(w.title.scrollTop, 0);
    assert.equal(w.posts.length, 0);
  });

  test(`${name}: renaming a cut title, words taken out let the rest come up until it fits two lines uncut`, () => {
    const w = world(sheet);
    const long = words(70);
    w.title.textContent = long;
    w.context.fitTitle(w.title);
    w.context.editTitle("7");
    w.caretAtEnd();
    w.title.scrollTop = 20 * sheet.lineHeight / sheet.fontSize;
    while (w.linesAt(w.title.textContent, 20) > 2) {
      assert.equal(w.shown().cut !== "", true, "cut while it still takes more than two lines at 20px");
      assert.equal(w.size(), 20);
      w.input("deleteContentBackward");
    }
    // the words left take two lines: the cut is gone and they all show, at 20px or more
    const now = w.shown();
    assert.equal(now.cut, "");
    assert.equal(now.overflow, "");
    assert.equal(now.lines, 2);
    assert.ok(now.size >= 20);
    // Enter keeps the shorter name, which then stands uncut at rest
    w.key("Enter");
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0].body, w.title.textContent.trim());
    assert.equal(w.shown().cut, "");
  });

  test(`${name}: a renamed cut title shows whole lines and moves only as the caret goes past the two in view`, () => {
    const w = world(sheet);
    w.title.textContent = wordsFor(w, 4, 20);
    w.context.fitTitle(w.title);
    const line = 20 * sheet.lineHeight / sheet.fontSize;
    const starts = w.lineStarts();
    assert.equal(starts.length, 4, "four lines at 20px, two of them past the cut");
    // the browser leaves the box somewhere; the title's own listener answers
    const scrolled = top => {
      w.title.scrollTop = top;
      for (const fn of w.title.listeners.scroll || []) fn();
      return w.title.scrollTop;
    };
    const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} for ${b}`);
    // at rest no scroll listener is on it yet
    assert.equal(w.title.listeners.scroll, undefined);
    w.context.editTitle("7");
    assert.equal((w.title.listeners.scroll || []).length, 1);
    // the caret on the second line in view and the browser a pixel past it (WebKit
    // does this): the box goes back, since that line was in view all along
    w.caretAt(starts[1] + 2);
    near(scrolled(1), 0, "a nudge with the caret's line in view");
    // the caret on to the third line: stopped a little short, or a little past, of a
    // whole line, the box stands on the whole line that shows it
    w.caretAt(starts[2] + 2);
    near(scrolled(line - 2), line, "short of the line");
    near(scrolled(line + 1.5), line, "past the line");
    // the caret at the very end: the last two lines
    w.caretAt(w.title.textContent.length);
    near(scrolled(2 * line - 3), 2 * line, "the end");
    // back at the start: the first two lines
    w.caretAt(1);
    near(scrolled(4), 0, "the start");
    // a title not being renamed is never moved by it
    w.key("Escape");
    assert.equal(w.title.scrollTop, 0);
    assert.equal(scrolled(7), 7);
  });

  test(`${name}: a card not on show keeps its title as it is, and fits it as the card shows`, () => {
    const w = world(sheet);
    w.context.watchTitle(w.el);
    w.box.hidden = true;
    w.title.textContent = wordsFor(w, 3, sheet.fontSize);
    w.context.fitTitle(w.title);
    assert.equal(w.title.style.cssText, "", "nothing is measured on a card with no layout");
    w.box.hidden = false;
    const [ro] = w.observers;
    assert.deepEqual(ro.watched, [w.box], "the card, whose size never follows its title, is watched");
    ro.cb([{ target: w.box }]);
    assert.ok(w.size() < sheet.fontSize && w.lines() === 2);
  });
}

test("the phone starts from its own title size, the Mac from 30px, and both stop at 20px", () => {
  for (const [name, sheet] of Object.entries(SHEETS)) {
    const w = world(sheet);
    const text = wordsFor(w, 3, sheet.fontSize);
    w.title.textContent = text;
    w.context.fitTitle(w.title);
    assert.ok(w.size() < sheet.fontSize, name);
    w.title.textContent = words(80);
    w.context.fitTitle(w.title);
    assert.equal(w.size(), 20, name);
  }
});

test("the cut and the scroll go by the lines as laid out, where an engine rounds a line (WebKit: 25.38px at 25px)", () => {
  const w = world({ ...SHEETS.phone, round: Math.floor });
  w.title.textContent = words(70);
  w.context.fitTitle(w.title);
  assert.equal(w.size(), 20);
  assert.ok(Math.abs(parseFloat(w.title.style.getPropertyValue("line-height")) - 25.3807) < 1e-3, "the line height asked for");
  assert.equal(w.shown().cut, "50px", "two lines as they stand, not 50.76px, so no sliver of the third shows");
  w.context.editTitle("7");
  w.title.scrollTop = 23;
  for (const fn of w.title.listeners.scroll) fn();
  assert.equal(w.title.scrollTop, 25, "a whole laid out line down");
});

test("the rename asks the keyboard for no grey guess at the word, before the title takes the focus", () => {
  // iOS draws its inline guess at the rest of a word inside the line, after the fit
  // has measured, and it carried a word on to a third line in the simulator
  const w = world(SHEETS.phone);
  w.title.textContent = "Short";
  let atFocus = null;
  const focus = w.title.focus;
  w.title.focus = function () { atFocus = { ...this.attributes }; return focus.call(this); };
  w.context.editTitle("7");
  assert.equal(atFocus.writingsuggestions, "false");
  assert.equal(atFocus.contenteditable, "plaintext-only");
});

test("an Option+Enter break counts as a line, and another past two lines adds nothing", () => {
  const w = world(SHEETS.mac);
  w.title.textContent = "First";
  w.context.editTitle("7");
  w.caretAtEnd();
  assert.equal(w.context.titleRoomAt(w.title, "\n"), "\n", "one line may break to two");
  // the editor puts a <br> in, as in WebKit; the title is then two lines
  const r = w.sel.range;
  r.insertNode(new w.Elem("br"));
  w.title.appendChild(new w.Text("Second"));
  w.caretAtEnd();
  assert.equal(w.lines(), 2);
  assert.equal(w.context.titleRoomAt(w.title, "\n"), "", "a break that starts a third line is held back");
  const e = w.input("insertLineBreak");
  assert.equal(e.defaultPrevented, true);
});

test("the fit and the room are plain rules: continuous to a twentieth of a pixel, whole words for a paste", () => {
  const { context } = world(SHEETS.mac);
  // lines as a width over a room: 900 units of words at 1px into a 480 room
  const linesAt = need => size => Math.ceil(need * size / 480);
  assert.deepEqual({ ...context.titleFitSize(linesAt(30), 30) }, { size: 30, over: false });
  const fit = context.titleFitSize(linesAt(40), 30);
  assert.equal(fit.over, false);
  assert.ok(Math.abs(fit.size - 24) <= 0.05 && Math.ceil(40 * fit.size / 480) <= 2, String(fit.size));
  assert.deepEqual({ ...context.titleFitSize(linesAt(60), 30) }, { size: 20, over: true });
  // the room: a key goes in whole or not at all
  const fits = max => part => part.length <= max;
  assert.equal(context.titleRoom(fits(5), "a", 0), "a");
  assert.equal(context.titleRoom(fits(0), "a", 0), "");
  assert.equal(context.titleRoom(fits(12), "alpha beta gamma", 0), "alpha beta");
  assert.equal(context.titleRoom(fits(3), "abcdefgh", 0), "abc", "one long word is cut where it stops fitting");
  // a title already past two lines may be cut down, never added to
  const over = () => false;
  assert.equal(context.titleRoom(over, "ab", 5), "ab");
  assert.equal(context.titleRoom(over, "abc", 0), "");
});

test("the Mac's paste cuts a long paste at the last whole word that fits", () => {
  const w = world(SHEETS.mac);
  vm.runInContext(between(mac, "function pasteIntoTitle(e){", "\n}\n"), w.context);
  w.title.textContent = "Short name ";
  w.context.editTitle("7");
  w.caretAtEnd();
  const paste = "\n" + words(40) + "\n";
  let prevented = false;
  w.context.pasteIntoTitle({ currentTarget: w.title, clipboardData: { getData: () => paste }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(w.execs.length, 1);
  const put = w.execs[0];
  assert.ok(words(40).startsWith(put) && put.length > 10 && put.length < words(40).length, put);
  const next = words(40).slice(put.length);
  assert.match(next, /^ \S/, "the cut falls between two words");
  assert.equal(w.title.textContent, "Short name " + put);
  assert.equal(w.lines(), 2);
  assert.ok(w.size() >= 20);
  assert.ok(w.linesAt(w.title.textContent + next.match(/^ \S+/)[0], 20) > 2, "the next word would not fit at 20px");
});

test("both pages fit the title where its words or its card change, and the RUNBOOK asks for two lines", () => {
  // the Mac: the snap fits the title before it measures the head; a reading that
  // renames the card fits it; every card is watched as it is made
  const snap = between(mac, "function snapCard(){", "\n}\n");
  assert.ok(snap.indexOf("fitTitle(el.titleEl)") > 0 && snap.indexOf("fitTitle(el.titleEl)") < snap.indexOf("getBoundingClientRect"));
  assert.match(mac, /el\.titleEl\.textContent = shown; fitTitle\(el\.titleEl\);/);
  assert.match(mac, /quietStops\(els\[b\.id\]\);\n\s*watchTitle\(els\[b\.id\]\);/);
  assert.match(between(mac, "function pasteIntoTitle(e){", "\n}\n"), /titleRoomAt\(e\.currentTarget, line\)/);
  // the cut title's air is measured over the words left showing, wherever the
  // rename has scrolled them
  const air = between(mac, "function tiltTitleAir(el, first){", "\n}\n");
  assert.match(air, /title\.style\.maxHeight/);
  assert.match(air, /q\.bottom > cut\.top && q\.top < cut\.bottom/);
  // the phone: a reading that renames it, the card as it shows, the web faces
  assert.match(phone, /el\.titleEl\.textContent = omniCardTitle\(b\.title\);\n\s*fitTitle\(el\.titleEl\);/);
  assert.match(phone, /watchTitle\(card\);\n\s*webFacesLanded\(\)\.then\(\(\) => fitTitle\(titleEl\)\);/);
  // the shared rename fits as it opens, on every input and as it closes, and holds the limit
  const edit = between(logic, "function editTitle(id, opts){", "\n}\n");
  assert.equal((edit.match(/fitTitle\(t\)/g) || []).length, 4);
  assert.match(edit, /addEventListener\("beforeinput", e => titleLimit\(e, t\)\)/);
  assert.match(edit, /addEventListener\("scroll", \(\) => titleScrolled\(t\), \{ passive: true \}\)/);
  // the floor and the two lines
  assert.match(logic, /const TITLE_LINES = 2, TITLE_MIN = 20, TITLE_STEP = 0\.05;/);
  const titles = between(runbook, "## Titles", "\n## ");
  assert.match(titles, /Never set one longer than two lines/);
});
