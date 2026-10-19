// The typing walk's matrix: document shapes, the caret and selection
// positions each shape is generated with, the edits made from each, and what
// each step of an edit should leave behind (compose-walk-model.cjs).
//
// THIS IS NOT A TEST FILE. compose-walk-browser.test.cjs walks it in a real
// browser and compose-walk-model.test.cjs checks it without one.
"use strict";
const M = require("./compose-walk-model.cjs");

const LONG = Array.from({ length: 40 }, (_, i) => "word" + i).join(" ");

// the document shapes, by name
const SHAPES = {
  "empty": "",
  "one line": "hello world",
  "several lines": "one two\nthree four\nfive",
  "text then an empty line": "hello\n\nworld",
  "a new line started": "hello\n",
  "bullets": "- one\n- two",
  "star and plus bullets": "* one\n+ two",
  "numbered": "1. one\n2. two\n3. three",
  "nested bullets": "- one\n  - two\n- three",
  "nested numbers": "1. one\n   1. two\n2. three",
  "list with text around": "intro\n- one\n- two\n\noutro",
  "list right under text": "intro\n- one",
  "empty item under text": "intro\n- ",
  "empty item": "- ",
  "empty number under text": "intro\n2. ",
  "line straight under a list": "- one\nafter",
  "item with a second line": "- one\n  more",
  "quote": "> quoted words",
  "quote lines": "> one\n> two",
  "quote then text": "> said\nreply",
  "quoted list": "> - item\n> - next",
  "nested quote": ">> deep",
  "heading": "# Title",
  "heading and body": "## Sub\nbody text",
  "text then heading": "intro\n# Head",
  "bold italic strike": "**bold** and *it* and ~~cut~~",
  "code and link": "`code` and [link](https://x.y) end",
  "formatting at line edges": "**bold**\n*it*",
  "bare address": "see https://x.y/a_b now",
  "long wrapped line": LONG,
  "long wrapped item": "- " + LONG,
  "emoji and accents": "café 👍🏽 naïve 1\ufe0f\u20e3 ok",
  "fenced code": "```\n- code\n```",
  "indented code": "    code line",
};

// ---- positions ---------------------------------------------------------------

function boundaries(doc) {
  const out = new Set();
  for (const line of M.splitLines(doc))
    for (const start of M.clusterStarts(line.text)) out.add(line.from + start);
  return out;
}

// a position inside the line's longest word, or its middle
function middleOf(line) {
  const words = [...new Intl.Segmenter("en", { granularity: "word" }).segment(line.text)]
    .filter(w => w.isWordLike);
  if (words.length) {
    const word = words[Math.floor(words.length / 2)];
    const starts = M.clusterStarts(word.segment);
    return line.from + word.index + starts[Math.floor(starts.length / 2)];
  }
  const starts = M.clusterStarts(line.text);
  return line.from + starts[Math.floor(starts.length / 2)];
}

// Every kind of place a caret or a selection can be in this document: the
// start, middle and end of each line, the edges and insides of each marker and
// span, and selections within a line, across lines, across formatting and
// over all of it. `wraps` leaves out the wrap points of a wrapped line, where
// a caret is on two rows at once. On the formatted face a caret cannot stand
// between a quote's hidden angles, so no position is made there.
function positions(doc, C, wraps = new Set(), face = "formatted") {
  const ok = boundaries(doc);
  if (face === "formatted") for (const [a, b] of M.atoms(doc)) for (let p = a + 1; p < b; p++) ok.delete(p);
  const out = new Map();
  const add = (anchor, head, label) => {
    if (!ok.has(anchor) || !ok.has(head) || wraps.has(anchor) || wraps.has(head)) return;
    const key = anchor + ":" + head;
    if (!out.has(key)) out.set(key, { anchor, head, label });
  };
  const lines = M.structure(doc);
  const nonEmpty = lines.filter(l => l.text.trim());
  for (const line of lines) {
    add(line.from, line.from, `line ${line.n + 1} start`);
    add(middleOf(line), middleOf(line), `line ${line.n + 1} middle`);
    add(line.to, line.to, `line ${line.n + 1} end`);
    // either side of a character written in more than one code unit
    const starts = M.clusterStarts(line.text);
    for (let k = 0; k + 1 < starts.length; k++) {
      const piece = line.text.slice(starts[k], starts[k + 1]);
      if (piece.length < 2 && piece.charCodeAt(0) < 128) continue;
      add(line.from + starts[k], line.from + starts[k], `before "${piece}"`);
      add(line.from + starts[k + 1], line.from + starts[k + 1], `after "${piece}"`);
    }
    if (line.item) {
      const it = line.item;
      add(it.markerFrom, it.markerFrom, `line ${line.n + 1} before the marker`);
      add(it.markerTo, it.markerTo, `line ${line.n + 1} inside the marker`);
      add(it.gapTo, it.gapTo, `line ${line.n + 1} after the marker`);
      if (it.indent > 1) add(line.from + 1, line.from + 1, `line ${line.n + 1} inside the indent`);
    }
    if (line.quote) for (let p = line.quote.from; p <= line.quote.to; p++)
      add(p, p, `line ${line.n + 1} angle ${p - line.from}`);
    if (line.heading) {
      add(line.from + 1, line.from + 1, `line ${line.n + 1} inside the hashes`);
      add(line.heading.to, line.heading.to, `line ${line.n + 1} after the hashes`);
    }
    if (line.inline != null && C) {
      const base = line.inline;
      for (const span of M.inlineSpans(C, doc.slice(base, line.to))) {
        const name = { e: "italic", s: "bold", x: "strike", c: "code", l: "link" }[span.style];
        add(base + span.from, base + span.from, `before the ${name}`);
        add(base + span.to, base + span.to, `after the ${name}`);
        for (const [a, b] of span.marks) {
          add(base + a, base + a, `${name} marker start`);
          add(base + b, base + b, `${name} marker end`);
          if (b - a === 2) add(base + a + 1, base + a + 1, `between the ${name} marker's characters`);
        }
        const mid = base + Math.floor((span.text[0] + span.text[1]) / 2);
        add(mid, mid, `inside the ${name}`);
        add(base + span.from, base + span.to, `the whole ${name} picked`);
        add(base + span.text[0], base + span.text[1], `the ${name}'s words picked`);
        if (span.from > 0) add(base + span.from - 1, mid, `a pick into the ${name}`);
      }
    }
  }
  if (nonEmpty.length) {
    const line = nonEmpty[0];
    const word = [...new Intl.Segmenter("en", { granularity: "word" }).segment(line.text)].find(w => w.isWordLike);
    if (word) {
      add(line.from + word.index, line.from + word.index + word.segment.length, "a word picked");
      add(line.from + word.index + word.segment.length, line.from + word.index, "a word picked backward");
    }
  }
  if (nonEmpty.length > 1) {
    const a = middleOf(nonEmpty[0]), b = middleOf(nonEmpty[1]);
    add(a, b, "a pick across lines");
    add(b, a, "a pick across lines, backward");
  }
  if (doc.length) {
    add(0, doc.length, "all of it picked");
    add(doc.length, 0, "all of it picked, backward");
  }
  return [...out.values()];
}

// ---- edits -----------------------------------------------------------------------

const STARTERS = ["- ", "* ", "1. ", "> ", "# "];
const SHORTCUTS = ["**", "_", "`"];
const MOVES = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Alt+ArrowLeft", "Alt+ArrowRight",
               "Alt+ArrowUp", "Alt+ArrowDown", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+ArrowUp",
               "Meta+ArrowDown", "Home", "End"];
const PASTES = {
  "plain words": { plain: "pasted" },
  "several lines": { plain: "one\r\ntwo" },
  "a list": { plain: "- a\n- b" },
  "rich text": { plain: "Plain bold and it", html: "<p>Plain <b>bold</b> and <i>it</i></p>",
                 markdown: "Plain **bold** and *it*" },
  "a rich list": { plain: "a\nb", html: "<ul><li>a</li><li>b</li></ul>", markdown: "- a\n- b" },
  "an address": { plain: "https://example.com/x" },
};

const typed = text => [...text].map(ch => ["type", ch]);

// The edits, each a list of steps. A step is a typed character, a key, the
// row's new line key (Shift+Enter on the Mac, return on the phone's keyboard)
// or a paste.
function edits(face) {
  const out = [];
  out.push({ name: "type a letter", steps: typed("x") });
  for (const s of STARTERS) {
    out.push({ name: `type "${s}"`, steps: typed(s) });
    out.push({ name: `type "${s}" then Space`, steps: [...typed(s), ["type", " "]] });
    out.push({ name: `type "${s}" then a new line`, steps: [...typed(s), ["nl"]] });
  }
  for (const s of SHORTCUTS) out.push({ name: `type "${s}"`, steps: typed(s) });
  for (const k of ["Backspace", "Alt+Backspace", "Meta+Backspace", "Delete", "Alt+Delete", "Meta+Delete"])
    out.push({ name: k, steps: [["key", k]] });
  out.push({ name: "a new line", steps: [["nl"]] });
  out.push({ name: "two new lines", steps: [["nl"], ["nl"]] });
  out.push({ name: "Tab", steps: [["key", "Tab"]] });
  out.push({ name: "Shift+Tab", steps: [["key", "Shift+Tab"]] });
  for (const [name, data] of Object.entries(PASTES)) out.push({ name: `paste ${name}`, steps: [["paste", data]] });
  for (const k of MOVES) {
    out.push({ name: `${k} then type`, steps: [["key", k], ["type", "x"]] });
    out.push({ name: `Shift+${k} then type`, steps: [["key", "Shift+" + k], ["type", "x"]] });
  }
  return out;
}

// ---- what each step should leave ----------------------------------------------

const from = s => Math.min(s.anchor, s.head);
const to = s => Math.max(s.anchor, s.head);

function deleteTo(s, target) {
  if (from(s) !== to(s)) return M.st(s.doc.slice(0, from(s)) + s.doc.slice(to(s)), from(s));
  const a = Math.min(s.head, target), b = Math.max(s.head, target);
  return M.st(s.doc.slice(0, a) + s.doc.slice(b), a);
}

// one step from a state: { state, rule } with blurred when the key leaves the
// box, or { vertical } for an up or down move this file cannot place itself
function step(s, st, face, layout) {
  const [kind, arg] = st;
  if (kind === "type") return { state: M.typeText(s, arg), rule: "typed" };
  if (kind === "paste") return { state: M.paste(s, arg, face, M.loadEditor()), rule: "pasted" };
  if (kind === "nl") {
    if (face === "plain") return { state: M.typeText(s, "\n"), rule: "plain: a text field's new line" };
    return M.newline(s);
  }
  const key = arg;
  const shift = key.startsWith("Shift+");
  const bare = shift ? key.slice(6) : key;
  const rows = layout && layout.rows;
  if (bare === "Tab") return M.tab(s, shift, face);
  if (bare === "Backspace") return M.backspace(s, face);
  if (bare === "Delete") return { state: M.deleteForward(s, face), rule: "one character" };
  if (bare === "Alt+Backspace" || bare === "Alt+Delete") {
    const forward = bare === "Alt+Delete";
    const target = face === "plain" ? M.nativeWordTarget(s.doc, s.head, forward)
      : M.outOfAtoms(s.doc, M.groupTarget(s.doc, s.head, forward), forward);
    return { state: deleteTo(s, target), rule: face === "plain" ? "plain: a word" : "cm: a group" };
  }
  if (bare === "Meta+Backspace" || bare === "Meta+Delete") {
    // to the row's edge, hidden markup and all, but not a quote's angles,
    // which are the quote itself and not words in it (box)
    const forward = bare === "Meta+Delete";
    const lines = M.structure(s.doc);
    const line = M.lineAt(lines, s.head);
    const row = rows ? rows(s.head) : { from: line.from, to: line.to };
    if (face === "formatted" && row.from === line.from && line.live) row.from = line.from + line.live;
    const edge = forward ? row.to : row.from;
    const target = forward ? (s.head < edge ? edge : Math.min(s.doc.length, s.head + 1))
      : (s.head > edge ? edge : Math.max(0, s.head - 1));
    return { state: deleteTo(s, target), rule: "cm: to the row's edge" };
  }
  if (bare === "ArrowUp" || bare === "ArrowDown") return { vertical: bare === "ArrowDown" ? 1 : -1, shift };
  if (bare === "Alt+ArrowUp" || bare === "Alt+ArrowDown") {
    // box: the Mac's own paragraph keys, which the row leaves to the browser.
    // With Shift the browser steps a paragraph at a time keeping the caret's
    // place across the line, which only the page's layout can place
    if (shift) return { paragraph: bare === "Alt+ArrowDown" ? 1 : -1, shift };
    const forward = bare === "Alt+ArrowDown";
    const lines = M.splitLines(s.doc);
    // box: on the formatted face a line starts where its words start, past a
    // quote's hidden angles, where Home stops as well
    const hidden = face === "formatted" ? M.atoms(s.doc) : [];
    const startOf = line => { const at = hidden.find(([a]) => a === line.from); return at ? at[1] : line.from; };
    const empty = from(s) === to(s);
    let head = s.head;
    if (!forward && empty && head === startOf(M.lineAt(lines, head))) head = M.lineAt(lines, head).from;
    // one character on (a pick is only closed up by it), then the line's edge
    const p = !empty ? (forward ? to(s) : from(s))
      : forward ? Math.min(s.doc.length, head + 1) : Math.max(0, head - 1);
    const line = M.lineAt(lines, p);
    const target = forward ? line.to : startOf(line);
    return { state: M.st(s.doc, target), rule: "mac: to the paragraph's edge" };
  }
  // cm: Home, End and Command with the side arrows find the row's edge where
  // its first and last characters on show stand, so hidden markup there is
  // stepped over (a quote's angles, or a span's markers the caret is away from)
  let seen = rows;
  if (face === "formatted" && /^(Meta\+ArrowLeft|Meta\+ArrowRight|Home|End)$/.test(bare)) {
    const hidden = M.hiddenSet(M.loadEditor(), s.doc, [{ from: from(s), to: to(s) }]);
    seen = pos => {
      const line = M.lineAt(M.splitLines(s.doc), pos);
      const row = rows ? rows(pos) : { from: line.from, to: line.to };
      let a = row.from, b = row.to;
      while (a < b && hidden.has(a)) a++;
      while (b > a && hidden.has(b - 1)) b--;
      return { from: a, to: b };
    };
  }
  const moved = M.move(s, bare, shift, face, seen);
  return { state: moved, rule: face === "plain" ? "mac: the field's own move" : "cm: the editor's move" };
}

module.exports = { SHAPES, positions, edits, step, STARTERS, MOVES, PASTES };
