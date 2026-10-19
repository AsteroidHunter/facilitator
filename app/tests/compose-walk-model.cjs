// What a card's typing box should do, for the walk to check it against.
//
// THIS IS NOT A TEST FILE. It is the reference the typing walk
// (compose-walk-browser.test.cjs) holds the row to, and its own checks are in
// compose-walk-model.test.cjs.
//
// For a document, a caret or a selection, and an edit, this answers what the
// row should hold afterwards, where its caret should be, and what each line
// should look like. It is written from the rules and not from the row's code,
// so a rule the row gets wrong shows up as a difference.
//
// The rule is Obsidian's editor in its live preview mode, with its two
// auto-pair settings off. Each rule below carries the source it comes from:
//
//   obsidian  Obsidian's help and its forum. A list is read a line at a time,
//             as CodeMirror 5's markdown mode reads it (HyperMD-list-line),
//             so a finished marker is a list item even right under a line of
//             text. Inline markup shows only while the caret touches its
//             span; a heading's hashes show while the caret is on its line.
//   cm        CodeMirror's markdown commands and default keymap (lang-markdown
//             6.5.2 and commands 6.11.0, the versions in cm-markdown.js), the
//             editor Obsidian is built on, for what its help does not say: how
//             a new line carries markup, Backspace after markup, word and line
//             motion and deletion. They are run here on the lines as Obsidian
//             reads them.
//   card      the sent card's drawing (card-markdown.js), where the row draws
//             a thing the way the card shows it.
//   box       a rule of the board's own that departs from Obsidian on purpose.
//             The report lists each one and why.
//
// The plain face (formatting off) is the browser's own text field, so its
// rules are a text field's: nothing is carried, nothing is drawn.
"use strict";

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const WORDS = new Intl.Segmenter("en", { granularity: "word" });

// ---- the document ------------------------------------------------------------

function splitLines(doc) {
  const out = [];
  let from = 0;
  for (const [n, text] of doc.split("\n").entries()) {
    out.push({ n, from, to: from + text.length, text });
    from += text.length + 1;
  }
  return out;
}

function lineAt(lines, pos) {
  for (const line of lines) if (pos <= line.to) return line;
  return lines[lines.length - 1];
}

// the grapheme cluster boundaries of one line
function clusterStarts(text) {
  const out = [];
  for (const piece of GRAPHEMES.segment(text)) out.push(piece.index);
  out.push(text.length);
  return out;
}
function clusterBefore(text, at) {
  let last = 0;
  for (const start of clusterStarts(text)) { if (start >= at) break; last = start; }
  return last;
}
function clusterAfter(text, at) {
  for (const start of clusterStarts(text)) if (start > at) return start;
  return text.length;
}

// cm: the editor's three kinds of character, for word motion and deletion
const WORD_CHAR = /[\p{Alphabetic}\p{Number}_]/u;
function category(ch) {
  if (!/\S/.test(ch)) return "space";
  if (WORD_CHAR.test(ch)) return "word";
  return "other";
}

// box: an emoji is taken whole by Backspace, as the plain field takes it
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
const EXTENDING = /^[\p{M}\ufe00-\ufe0f\u200d]$/u;

function columns(text) {
  let width = 0;
  for (const ch of text) width += ch === "\t" ? 4 - (width % 4) : 1;
  return width;
}

// ---- what each line is ---------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+/;                       // obsidian; box: once its space is typed
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_LIVE = /^ {0,3}(?:>[ \t]?)*>[ \t]/;          // box: the angles drawn as a bar
const ITEM = /^([-*+]|\d{1,9}[.)])([ \t]+)/;             // obsidian: a marker and its space
const BARE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])$/;            // a marker whose space is not typed yet

// A line's containers, outermost first, as the editor's own markdown commands
// read them (a quote's angle, a list item's marker), each with where it
// starts and ends in its own line and the space it ends with. `own` is a
// container whose marker is written on this line; one carried from a line
// above is the list item this line continues.
//
// Each line of the document, read the way Obsidian's live preview reads it: a
// line at a time, a marker with its space is a list item wherever it stands,
// a quote's lines are the ones carrying their own angle. Where several markers
// stand on one line ("- - a", "- > a"), they are read the way the card and the
// editor both read them: one inside the other.
function structure(doc) {
  const lines = splitLines(doc);
  const out = [];
  let fence = null;
  const stacks = new Map();       // quote depth -> the list items open at that depth
  let blankAbove = true;
  let openText = false;           // the line above was an item's words, which a lazy line may go on
  let lastDepth = 0;
  const stackAt = depth => {
    if (!stacks.has(depth)) stacks.set(depth, Object.assign([], { lastRoot: null }));
    return stacks.get(depth);
  };
  const reset = depth => stacks.set(depth, Object.assign([], { lastRoot: null }));
  for (const line of lines) {
    const rec = { ...line, kind: "plain", depth: 0, live: 0, quotes: [], items: [], inners: [],
                  heading: null, carried: [], inline: line.from, code: false, contexts: [] };
    out.push(rec);
    const text = line.text;
    if (fence) {
      rec.kind = "code"; rec.code = true; rec.inline = null;
      const close = new RegExp("^ {0,3}" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}[ \\t]*$");
      if (close.test(text)) { rec.kind = "fence"; fence = null; }
      continue;
    }
    const opened = FENCE.exec(text);
    if (opened) {
      rec.kind = "fence"; rec.code = true; rec.inline = null;
      fence = opened[1]; stacks.clear(); blankAbove = false; openText = false;
      continue;
    }
    if (!text.trim()) { rec.kind = "blank"; blankAbove = true; openText = false; rec.inline = null; continue; }
    // the angles at the head of the line, each with the space it owns
    let at = 0;
    for (let m; (m = /^ {0,3}>( ?)/.exec(text.slice(at)));) {
      const lead = /^ */.exec(text.slice(at))[0].length;
      rec.quotes.push({ quote: true, own: true, from: at + lead, to: at + m[0].length, space: m[1] });
      at += m[0].length;
    }
    // box: the angles drawn away as one run, from the line's head to the last
    // angle that has its space (an angle still waiting for one, after the
    // last finished one, stays on show); a new line carries the quote as far
    // as the angles run with one space at most between them
    let held = null;
    for (const q of rec.quotes) {
      const ready = !!q.space;
      if (!held) held = { to: q.to, ready };
      else if (ready || !held.ready) held.to = Math.max(held.to, q.to);
      held.ready = held.ready || ready;
    }
    rec.live = held && held.ready ? held.to : 0;
    const carry = QUOTE_LIVE.exec(text);
    rec.carry = carry ? carry[0].length : 0;
    rec.depth = rec.quotes.length;
    rec.inline = line.from + at;
    if (rec.depth !== lastDepth) {
      for (const depth of [...stacks.keys()]) if (depth > 0) stacks.delete(depth);
      openText = false;
      // a quote's first line is the start of what it holds, as a line after
      // a blank one is (four spaces there begin a block of code)
      if (rec.depth > lastDepth) blankAbove = true;
    }
    lastDepth = rec.depth;
    if (rec.depth) reset(0);   // a quote at the margin ends a list standing outside it
    const body = text.slice(at);
    const stack = stackAt(rec.depth);
    const indent = columns(/^[ \t]*/.exec(body)[0]);
    if (indent >= 4 && blankAbove && !stack.length) {
      rec.kind = "code"; rec.code = true; rec.inline = null; blankAbove = false; openText = false;
      // a quote holding the code is still a quote to the editor's commands
      for (const q of rec.quotes) q.live = rec.carry >= q.to;
      rec.contexts = [...rec.quotes];
      continue;
    }
    if (RULE.test(body)) {
      rec.kind = "rule"; rec.inline = null; reset(rec.depth); blankAbove = false; openText = false;
      continue;
    }
    // the list items whose marker is on this line, one inside the other, and
    // any quote standing inside one of them: the line's own chain
    let off = at + /^[ \t]*/.exec(body)[0].length;
    let next = ITEM.exec(text.slice(off));
    if (next || blankAbove) {
      while (stack.length && indent < stack[stack.length - 1].contentCol) stack.pop();
    }
    const chain = [];
    for (;;) {
      if (next) {
        const [whole, mark, gap] = next;
        const col = off - at;
        const parent = stack.length ? stack[stack.length - 1] : null;
        const ordered = /\d/.test(mark);
        const closer = ordered ? mark.slice(-1) : null;
        const prev = parent ? parent.children[parent.children.length - 1] : stack.lastRoot;
        const same = !!prev && prev.ordered === ordered && (ordered ? prev.closer === closer : prev.bullet === mark);
        const entry = {
          line: rec.n, markCol: col, contentCol: col + mark.length + gap.length, quoteLen: at,
          ordered, number: ordered ? parseInt(mark, 10) : null, closer, bullet: ordered ? null : mark,
          gap, children: [], parent, first: !same, prev: same ? prev : null,
        };
        if (parent) parent.children.push(entry); else stack.lastRoot = entry;
        stack.push(entry);
        const own = { item: entry, own: true, from: off, to: off + whole.length, space: gap,
                      markerFrom: line.from + off, markerTo: line.from + off + mark.length,
                      gapTo: line.from + off + whole.length };
        rec.items.push(own);
        chain.push(own);
        off += whole.length;
      } else {
        // a quote inside an item, after its marker (card: drawn as the card
        // draws it): its run of angles is drawn as one, the way a quote's at
        // the head of a line is
        const run = chain.length ? /^(?:>[ \t]?)+/.exec(text.slice(off)) : null;
        if (!run) break;
        const drawnTo = /^(?:>[ \t]?)*>[ \t]/.exec(run[0]);
        const start = off;
        for (let m; (m = /^>( ?)/.exec(text.slice(off)));) {
          const own = { quote: true, own: true, from: off, to: off + m[0].length, space: m[1],
                        live: !!drawnTo && off + m[0].length <= start + drawnTo[0].length };
          rec.inners.push(own);
          chain.push(own);
          off += m[0].length;
        }
      }
      next = ITEM.exec(text.slice(off));
    }
    if (rec.items.length) {
      rec.kind = "item";
      rec.inline = line.from + off;
      // an item's words are what a lazy line may go on; a heading is not words
      openText = !!text.slice(off).trim() && !HEADING.test(text.slice(off));
      blankAbove = false;
    } else if (stack.length && !BARE.test(body) &&
               (stack.some(entry => indent >= entry.contentCol) ||
                !(HEADING.test(body.trimStart()) || !openText || blankAbove))) {
      // a line inside a list that is not an item of its own: the item's (card).
      // Obsidian leaves a line written at the margin outside the list; the
      // card shows it as the item's, and so does the row. A line indented as
      // far as an item's words is that item's; one written short of every
      // item's words has to follow the item's own words to be theirs (a lazy
      // line), and a heading written there is the list's end instead
      let keep = stack.length;
      while (keep && indent < stack[keep - 1].contentCol) keep--;
      if (keep) stack.length = keep;
      const owner = stack[stack.length - 1];
      rec.kind = "cont";
      rec.carried = stack.slice();
      rec.cont = { owner, lazy: indent < owner.contentCol, indent };
      openText = true;
      blankAbove = false;
    } else {
      reset(rec.depth);
      openText = false;
      blankAbove = false;
    }
    if (rec.kind === "item" && rec.items.length) {
      // the items this line's first marker sits inside, carried from above
      const outer = rec.items[0].item.parent;
      for (let p = outer; p; p = p.parent) rec.carried.unshift(p);
    }
    // a heading, at the margin or inside a quote or an item
    const words = text.slice(rec.inline - line.from);
    const head = (rec.kind === "item" ? HEADING : /^[ \t]{0,3}(#{1,6})[ \t]+/).exec(rec.kind === "cont" ? words.trimStart() : words);
    if (head && (indent < 4 || rec.kind !== "plain")) {
      const lead = rec.kind === "cont" ? words.length - words.trimStart().length : 0;
      rec.heading = { level: head[1].length, from: rec.inline + lead, to: rec.inline + lead + head[0].length };
      if (rec.kind === "plain") rec.kind = "heading";
      rec.inline = rec.heading.to;
    }
    // the containers the editor's commands see, outermost first
    const carried = rec.carried.map(entry => ({
      item: entry, own: false, from: entry.quoteLen + entry.markCol,
      to: entry.quoteLen + entry.contentCol, space: entry.gap,
    }));
    rec.contexts = [...rec.quotes, ...carried, ...chain];
    for (const q of rec.quotes) q.live = rec.carry >= q.to;
  }
  return out;
}

// ---- what is drawn on each line --------------------------------------------------

// The spans of one line's own words: emphasis, strong, strike, code and links,
// with the markup each one hides. The card reads inline markup a line at a
// time, and a line's words are parsed on their own; a no-break space stands in
// front so the line's first word is read as a word and not as a block.
function inlineSpans(C, text) {
  if (!C || !text) return [];
  const tree = C.markdownLanguage.parser.parse("\u00a0" + text);
  const spans = [];
  const at = n => n - 1;
  tree.iterate({
    enter: node => {
      const name = node.name;
      if (name === "Emphasis" || name === "StrongEmphasis" || name === "Strikethrough" || name === "InlineCode") {
        const style = { Emphasis: "e", StrongEmphasis: "s", Strikethrough: "x", InlineCode: "c" }[name];
        const marks = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling)
          if (/Mark$/.test(child.name)) marks.push([at(child.from), at(child.to)]);
        spans.push({ style, from: at(node.from), to: at(node.to), marks, text: [at(node.from), at(node.to)] });
        return name !== "InlineCode";
      }
      if (name === "Link") {
        const kids = [];
        for (let child = node.node.firstChild; child; child = child.nextSibling) kids.push(child);
        const marksOnly = kids.filter(k => k.name === "LinkMark");
        // an inline link, [words](address); a bracket pair alone is words
        if (marksOnly.length < 4 || !kids.some(k => k.name === "URL")) return true;
        const textFrom = at(marksOnly[0].to), textTo = at(marksOnly[1].from);
        const marks = [[at(node.from), textFrom], [textTo, at(node.to)]];
        spans.push({ style: "l", from: at(node.from), to: at(node.to), marks, text: [textFrom, textTo] });
        return true;
      }
      if (name === "URL") {
        const parent = node.node.parent;
        if (parent && (parent.name === "Link" || parent.name === "Image" || parent.name === "Autolink")) return false;
        spans.push({ style: "l", from: at(node.from), to: at(node.to), marks: [], text: [at(node.from), at(node.to)] });
        return false;
      }
      return true;
    },
  });
  return spans;
}

// box: the quote angles the row hides, which the caret steps over whole and a
// deletion takes whole, as the editor does with an atomic range
function atoms(doc) {
  const out = [];
  for (const line of structure(doc)) {
    if (line.live) out.push([line.from, line.from + line.live]);
    const inner = line.inners.filter(q => q.live);
    if (inner.length) out.push([line.from + inner[0].from, line.from + inner[inner.length - 1].to]);
  }
  return out;
}
function outOfAtoms(doc, pos, forward) {
  for (const [a, b] of atoms(doc)) if (a < pos && pos < b) return forward ? b : a;
  return pos;
}

function touches(ranges, from, to) {
  return ranges.some(range => range.to >= from && range.from <= to);
}

// What each line should show: the characters left on show once the hidden
// markup is off it, each run with its styles, and the line's own kind.
//   bullet  a bullet marker is painted round (shown here as "•")
//   item    the line hangs on a list item's column
//   quote   the line carries the quote bar
//   heading the heading's level, 0 for none
function drawn(C, doc, ranges) {
  return drawing(C, doc, ranges).lines;
}
// the positions whose characters are not on show
function hiddenSet(C, doc, ranges) {
  return drawing(C, doc, ranges).hidden;
}
function drawing(C, doc, ranges) {
  const all = new Set();
  const lines = structure(doc).map(line => {
    const hidden = new Set();
    const styles = new Map();
    const paint = new Set();
    const hide = (from, to) => { for (let p = from; p < to; p++) hidden.add(p); };
    const mark = (from, to, style) => {
      for (let p = from; p < to; p++) styles.set(p, (styles.get(p) || "") + style);
    };
    const onLine = touches(ranges, line.from, line.to);
    let quote = false, heading = 0;
    // box: the angles never show once their space is typed
    if (line.live) { quote = true; hide(line.from, line.from + line.live); }
    for (const inner of line.inners)
      if (inner.live) { quote = true; hide(line.from + inner.from, line.from + inner.to); }
    for (const it of line.items) if (!it.item.ordered) paint.add(it.markerFrom);
    const item = line.kind === "item" || line.kind === "cont";
    if (line.heading) {
      heading = line.heading.level;
      if (!onLine) hide(line.heading.from, line.heading.to);                   // obsidian
    }
    if (line.inline != null && !line.code) {
      const start = line.inline;
      for (const span of inlineSpans(C, doc.slice(start, line.to))) {
        const from = start + span.from, to = start + span.to;
        if (span.style === "l") mark(start + span.text[0], start + span.text[1], "l");
        else mark(from, to, span.style);
        if (!touches(ranges, from, to)) for (const [a, b] of span.marks) hide(start + a, start + b);   // obsidian
      }
    }
    // a run is the characters on show next to each other in one style
    let shown = "", last = "";
    const runs = [];
    for (let p = line.from; p < line.to; p++) {
      if (hidden.has(p)) { all.add(p); continue; }
      const ch = paint.has(p) ? "•" : doc[p];
      const style = [...new Set(styles.get(p) || "")].sort().join("");
      shown += ch;
      if (style && style === last) runs[runs.length - 1][0] += ch;
      else if (style) runs.push([ch, style]);
      last = style;
    }
    return { shown, runs, quote, item, bullet: paint.size > 0, heading };
  });
  return { lines, hidden: all };
}

// ---- edits -------------------------------------------------------------------------

function st(doc, anchor, head = anchor) { return { doc, anchor, head }; }
const from = s => Math.min(s.anchor, s.head);
const to = s => Math.max(s.anchor, s.head);

function replace(s, a, b, text, caret) {
  const doc = s.doc.slice(0, a) + text + s.doc.slice(b);
  return st(doc, caret == null ? a + text.length : caret);
}

function typeText(s, text) { return replace(s, from(s), to(s), text); }

// the renumbering a new or moved item brings, written in after the change it
// follows, all of it later in the document than that change
function withFixes(state, changes, fixes) {
  if (!fixes.length) return state;
  const delta = changes.reduce((sum, c) => sum + c.insert.length - (c.to - c.from), 0);
  let doc = state.doc, shift = delta;
  for (const fix of fixes) {
    const a = fix.from + shift, b = fix.to + shift;
    doc = doc.slice(0, a) + fix.insert + doc.slice(b);
    shift += fix.insert.length - (fix.to - fix.from);
  }
  return st(doc, state.anchor, state.head);
}

// cm: the items after a numbered item in its list that count up one by one
// from it count on from where it now stands (renumberList): one on for an item
// put in after it, offset -2 when the item itself leaves the list. A list
// written all in ones stays so
function renumber(lines, entry, offset = 0) {
  const out = [];
  let count = entry.number;
  for (const l of lines) {
    if (l.n <= entry.line) continue;
    const own = l.items.find(it => it.item.parent === entry.parent && it.item.quoteLen === entry.quoteLen);
    if (!own) {
      if (l.kind === "blank" || l.kind === "cont") continue;
      if (l.kind === "item" && l.items.some(it => isInside(it.item, entry))) continue;
      break;
    }
    const it = own.item;
    if (it.first || !it.ordered || it.number !== count + 1 || count + 2 + offset > 999999999) break;
    count++;
    out.push({ from: own.markerFrom, to: own.markerFrom + String(it.number).length, insert: String(count + 1 + offset) });
  }
  return out;
}
function isInside(item, entry) {
  for (let p = item.parent; p; p = p.parent) if (p === entry) return true;
  return false;
}

// a container's marker as the next line carries it, and its blank: what a
// line inside it has in front of its words
function marker(c) {
  if (c.quote) return ">" + c.space;
  const it = c.item;
  return (it.ordered ? String(Math.min(it.number + 1, 999999999)) + it.closer : it.bullet) + c.space;
}
function blank(c, width) {
  let out = c.quote ? ">" : "";
  if (width != null) { while (out.length < width) out += " "; return out; }
  for (let r = c.to - c.from - out.length - c.space.length; r > 0; r--) out += " ";
  return out + c.space;
}

// ---- a new line (Obsidian's smart lists, cm's continuation) ----
function newline(s) {
  const picked = from(s) !== to(s);
  // box: with words picked, the new line is the one a caret at the pick's
  // start makes, read on the line as it stands, and it takes the pick's place
  const doc = s.doc, pos = from(s), end = to(s);
  const lines = structure(doc);
  const line = lineAt(lines, pos);
  const plain = rule => ({ state: replace(s, pos, end, "\n"), rule });
  const col = pos - line.from;
  // box: nothing is carried inside code; cm: a caret still at a quote's
  // angles, before the code it holds, carries the quote (only a fenced block
  // stops the editor's continuation)
  const angles = line.quotes.length ? line.quotes[line.quotes.length - 1].to : 0;
  if (line.code && !(line.kind === "code" && angles && col <= angles))
    return plain("box: nothing is carried inside code");
  // box: a quote is carried once its space is typed; and a line's own marker
  // is its first one, with what follows it the item's words, as Obsidian
  // reads a line (the drawing still shows a marker after it as the card does)
  const firstOwn = line.contexts.find(x => x.item && x.own);
  const c = line.contexts.filter(x => !(x.quote && !x.live) &&
    !(firstOwn && x.own && x !== firstOwn && x.from >= firstOwn.to));
  // cm: only the containers whose marker starts before the caret are its own
  while (c.length && c[c.length - 1].from >= col) c.pop();
  if (!c.length) return plain("plain");
  const d = c[c.length - 1];
  // box: the caret has to be past a marker's own space for the marker to go on
  if (col < d.to) return plain("box: a break inside a marker carries nothing");
  const empty = !/\S/.test(line.text.slice(d.to)) && (!picked || end <= line.to);
  if (d.item && empty) {
    if (!d.own && !/^[\s>]*$/.test(line.text.slice(0, d.to))) return plain("cm: plain");
    const b = c.length > 1 ? c[c.length - 2] : null;
    if (b && b.item) {
      // cm: an empty nested item moves out to its parent's level, with the
      // parent's marker, and the parent's numbers after it count on
      const at = line.from + b.from, head = marker(b);
      const fixes = [...(d.item.ordered ? renumber(lines, d.item, -2) : []),
                     ...(b.item.ordered ? renumber(lines, b.item) : [])].sort((x, y) => x.from - y.from);
      return { state: withFixes(replace(s, at, end, head), [{ from: at, to: end, insert: head }], fixes),
               rule: "cm: an empty nested item moves out a level" };
    }
    // obsidian: an empty item ends the list; cm: a quote around it stays
    const at = line.from + (b ? b.to : 0);
    const fixes = d.item.ordered ? renumber(lines, d.item, -2) : [];
    return { state: withFixes(replace(s, at, end, ""), [{ from: at, to: end, insert: "" }], fixes),
             rule: "obsidian: an empty item ends the list" };
  }
  if (d.quote && empty) {
    // box: an empty quoted line ends the quote, angles and all
    const at = c.every(x => x.quote) ? line.from : line.from + d.from;
    return { state: replace(s, at, Math.max(end, line.to), ""), rule: "box: an empty quoted line ends the quote" };
  }
  const inside = d.item && !d.own;           // a line of an item's own words, under its marker
  let h = "";
  if (!inside || /^[\s\d.)\-+*>]*/.exec(line.text)[0].length >= d.to) {
    for (let f = 0, last = c.length - 1; f <= last; f++)
      h += f === last && !inside ? marker(c[f]) : blank(c[f], f < last ? c[f + 1].from - h.length : null);
  }
  // box: the marker keeps its own space, where cm would trim it away
  const floor = line.from + (inside ? 0 : d.to);
  let g = pos;
  if (!picked) while (g > floor && /\s/.test(doc[g - 1])) g--;
  const insert = "\n" + h;
  const fixes = d.item && d.own && d.item.ordered && end <= line.to ? renumber(lines, d.item) : [];
  return { state: withFixes(replace(s, g, end, insert), [{ from: g, to: end, insert }], fixes),
           rule: d.quote ? "obsidian: a quote carries its angle" : inside ? "cm: a line inside an item stays in the item"
             : "obsidian: a list carries its marker" };
}

// ---- Backspace -----
// cm: deleteMarkupBackward, read on the lines as Obsidian reads them, then the
// editor's own one character
function backspace(s, face) {
  if (from(s) !== to(s)) return { state: replace(s, from(s), to(s), ""), rule: "delete the selection" };
  const pos = s.head, doc = s.doc;
  if (pos === 0) return { state: s, rule: "nothing before" };
  const lines = structure(doc);
  const line = lineAt(lines, pos);
  const col = pos - line.from;
  // cm: only a fenced block keeps its markup from Backspace; a quote holding
  // indented code is still a quote
  if (face === "formatted" && !(line.code && !line.quotes.length)) {
    const contexts = line.contexts.filter(x => x.from < col);
    if (contexts.length) {
      const c = contexts[contexts.length - 1];
      const d = c.to - c.space.length + (c.space ? 1 : 0);
      if (col > d && !/\S/.test(line.text.slice(d, col)))
        return { state: replace(s, line.from + d, pos, ""), rule: "cm: back to the marker's own space" };
      if (col === d && ((c.item && c.own) || /^[\s>]*$/.test(line.text.slice(0, c.to)))) {
        const p = line.from + c.from;
        if (c.item && !c.item.first && /\S/.test(line.text.slice(c.from, c.to))) {
          const fill = " ".repeat(c.to - c.from);
          return { state: replace(s, p, line.from + c.to, fill, p + fill.length),
                   rule: "cm: a later item's marker becomes its indent" };
        }
        if (p < pos) return { state: replace(s, p, pos, ""), rule: "cm: Backspace takes the marker" };
      }
    }
  }
  const target = charBackTarget(line, pos, face);
  return { state: replace(s, face === "formatted" ? outOfAtoms(doc, target, false) : target, pos, ""),
           rule: "one character" };
}

function charBackTarget(line, pos, face) {
  const before = line.text.slice(0, pos - line.from);
  if (pos === line.from) return pos - 1;
  // cm: inside the indentation Backspace goes back to the last indent stop
  if (face === "formatted" && !/[^ \t]/.test(before) && pos < line.from + 200) {
    if (before.endsWith("\t")) return pos - 1;
    const width = columns(before), drop = width % 2 || 2;
    let r = pos;
    for (let d = 0; d < drop && before[before.length - 1 - d] === " "; d++) r--;
    return r;
  }
  const start = clusterBefore(line.text, pos - line.from);
  const cluster = line.text.slice(start, pos - line.from);
  const points = [...cluster];
  // box: an emoji goes whole; a letter with a mark of its own loses the mark
  if (cluster.length > 1 && EMOJI.test(cluster)) return line.from + start;
  if (points.length > 1 && EXTENDING.test(points[points.length - 1]))
    return pos - points[points.length - 1].length;
  return line.from + start;
}

function deleteForward(s, face) {
  if (from(s) !== to(s)) return replace(s, from(s), to(s), "");
  const line = lineAt(splitLines(s.doc), s.head);
  if (s.head === line.to) return s.head === s.doc.length ? s : replace(s, s.head, s.head + 1, "");
  const target = line.from + clusterAfter(line.text, s.head - line.from);
  return replace(s, s.head, face === "formatted" ? outOfAtoms(s.doc, target, true) : target, "");
}

// cm: deleteGroupBackward and deleteGroupForward
function groupTarget(doc, pos, forward) {
  const lines = splitLines(doc);
  const line = lineAt(lines, pos);
  let i = pos;
  for (let cat = null;;) {
    if (i === (forward ? line.to : line.from)) {
      if (i === pos && line.n !== (forward ? lines.length - 1 : 0)) i += forward ? 1 : -1;
      break;
    }
    const off = i - line.from;
    const next = (forward ? clusterAfter(line.text, off) : clusterBefore(line.text, off)) + line.from;
    const piece = line.text.slice(Math.min(i, next) - line.from, Math.max(i, next) - line.from);
    const c = category(piece);
    if (cat != null && c !== cat) break;
    if (piece !== " " || i !== pos) cat = c;
    i = next;
  }
  return i;
}

// the Mac text field's own word steps: over what is not a word, then over a word
function nativeWordTarget(doc, pos, forward) {
  const pieces = [...WORDS.segment(doc)];
  if (forward) {
    for (const piece of pieces) {
      const end = piece.index + piece.segment.length;
      if (end > pos && piece.isWordLike) return end;
    }
    return doc.length;
  }
  for (let k = pieces.length - 1; k >= 0; k--) {
    const piece = pieces[k];
    if (piece.index < pos && piece.isWordLike) return piece.index;
  }
  return 0;
}

// ---- motion -----
// cm: moveByChar with an optional test, across line ends as one "\n"
function moveByChar(doc, pos, forward, by) {
  const lines = splitLines(doc);
  let line = lineAt(lines, pos);
  let cur = pos, check = null;
  for (;;) {
    let next, ch;
    const off = cur - line.from;
    if (forward ? off < line.text.length : off > 0) {
      const t = forward ? clusterAfter(line.text, off) : clusterBefore(line.text, off);
      ch = forward ? line.text.slice(off, t) : line.text.slice(t, off);
      next = line.from + t;
    } else {
      if (line.n === (forward ? lines.length - 1 : 0)) return cur;
      ch = "\n";
      line = lines[line.n + (forward ? 1 : -1)];
      next = forward ? line.from : line.to;
    }
    if (check) { if (!check(ch)) return cur; }
    else { if (!by) return next; check = by(ch); }
    cur = next;
  }
}
function byGroup(initial) {
  let cat = category(initial);
  return ch => { const c = category(ch); if (cat === "space") cat = c; return cat === c; };
}

// cm: Home, End and Command with the side arrows. rows answers where the visual
// row a position stands on starts and ends; a line that does not wrap is its
// own one row
function lineBoundary(doc, head, forward, rows) {
  const line = lineAt(splitLines(doc), head);
  const row = rows ? rows(head) : { from: line.from, to: line.to };
  let r = forward ? row.to : row.from;
  if (r === head && r !== (forward ? line.to : line.from)) r = forward ? line.to : line.from;
  if (!forward && r === line.from && line.text.length) {
    const space = /^\s*/.exec(line.text.slice(0, 100))[0].length;
    if (space && head !== line.from + space) r = line.from + space;
  }
  return r;
}

function nativeLineBoundary(doc, head, forward, rows) {
  const line = lineAt(splitLines(doc), head);
  const row = rows ? rows(head) : { from: line.from, to: line.to };
  return forward ? row.to : row.from;
}

// A move key: the selection it leaves, or null for one this file cannot place
// without the page's own layout (up and down).
function move(s, key, shift, face, rows) {
  const native = face === "plain";
  const empty = from(s) === to(s);
  const collapse = forward => st(s.doc, forward ? to(s) : from(s));
  const go = head => (shift ? st(s.doc, s.anchor, head) : st(s.doc, head));
  const h = s.head;
  switch (key) {
    case "ArrowLeft": case "ArrowRight": {
      const forward = key === "ArrowRight";
      if (!shift && !empty) return collapse(forward);
      const next = moveByChar(s.doc, h, forward);
      return go(native ? next : outOfAtoms(s.doc, next, forward));
    }
    case "Alt+ArrowLeft": case "Alt+ArrowRight": {
      const forward = key === "Alt+ArrowRight";
      if (native) return go(nativeWordTarget(s.doc, shift ? h : forward ? to(s) : from(s), forward));
      if (!shift && !empty) return collapse(forward);
      return go(outOfAtoms(s.doc, moveByChar(s.doc, h, forward, byGroup), forward));
    }
    case "Meta+ArrowLeft": case "Meta+ArrowRight": case "Home": case "End": {
      const forward = key === "Meta+ArrowRight" || key === "End";
      if (native && (key === "Home" || key === "End"))
        return shift ? st(s.doc, s.anchor, forward ? s.doc.length : 0) : s;   // the Mac's field scrolls and leaves the caret
      if (native) return go(nativeLineBoundary(s.doc, shift ? h : forward ? to(s) : from(s), forward, rows));
      return go(lineBoundary(s.doc, h, forward, rows));
    }
    case "Meta+ArrowUp": return go(0);
    case "Meta+ArrowDown": return go(s.doc.length);
    default: return null;
  }
}

// ---- Tab in a list -----
// obsidian: Tab nests a list item under the one above it and Shift+Tab brings
// it back out; anywhere else the board's own Tab steps out of the box (box).
// The nesting is written in spaces as wide as the marker above, which reads
// as the same level to Obsidian, the card and the editor alike.
function tab(s, shift, face) {
  if (face === "plain") return { blurred: true, state: s, rule: "box: Tab steps out of the box" };
  const lines = structure(s.doc);
  const touched = lines.filter(l => l.to >= from(s) && l.from <= to(s) && l.items.length);
  if (!touched.length) return { blurred: true, state: s, rule: "box: Tab steps out of the box" };
  const edits = [];
  for (const l of touched) {
    const own = l.items[0], it = own.item;
    const at = l.from + it.quoteLen;            // where the item's indent starts
    if (!shift) {
      // as wide as the marker of the item above it in its list, or its own
      const above = it.prev;
      const width = above ? above.contentCol - above.markCol : it.contentCol - it.markCol;
      edits.push({ from: at, to: at, insert: " ".repeat(width) });
    } else if (it.parent) {
      edits.push({ from: at + it.parent.markCol, to: at + it.markCol, insert: "" });
    }
  }
  if (!edits.length) return { state: s, rule: "obsidian: Shift+Tab on an item at the margin does nothing" };
  // a position at an insertion moves on with the words after it, and one in a
  // removed indent lands where the indent was
  const map = p => {
    let out = p;
    for (const e of edits) {
      if (e.insert) { if (p >= e.from) out += e.insert.length; }
      else if (p >= e.to) out -= e.to - e.from;
      else if (p > e.from) out -= p - e.from;
    }
    return out;
  };
  let doc = s.doc;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) doc = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
  return { state: st(doc, map(s.anchor), map(s.head)),
           rule: shift ? "obsidian: Shift+Tab brings the item out" : "obsidian: Tab nests the item" };
}

// ---- paste ------
const URLISH = /^(https?:\/\/|mailto:|xmpp:|www\.)/;
function paste(s, data, face, C) {
  const plain = String(data.plain || "").replace(/\r\n?/g, "\n");
  if (face === "formatted" && data.markdown != null) return typeText(s, data.markdown);   // obsidian: html arrives as markdown
  if (face === "formatted" && from(s) !== to(s) && URLISH.test(plain) && linkable(s, C)) {
    // cm and obsidian: a link pasted over words in one run makes them its text
    const url = /^www\./.test(plain) ? "https://" + plain : plain;
    const a = from(s), b = to(s);
    const doc = s.doc.slice(0, a) + "[" + s.doc.slice(a, b) + "](" + url + ")" + s.doc.slice(b);
    return s.anchor <= s.head ? st(doc, a + 1, b + 1) : st(doc, b + 1, a + 1);
  }
  return typeText(s, plain);
}

// cm: only words with no markup of their own in the pick or at its edges, and
// no block starting or ending inside it (pasteURLAsLink), read on the parse
// the editor makes, where a list marker ends a line of text above it
let parser = null;
function docParser(C) {
  if (!parser) parser = C.markdownLanguage.parser.configure({ parseBlock: [{ name: "ListBreak",
    endLeaf: (cx, line) => /^(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line.text.slice(line.pos)) }] });
  return parser;
}
function linkable(s, C) {
  const a = from(s), b = to(s);
  let blocked = false;
  docParser(C).parse(s.doc).iterate({ from: a, to: b,
    enter: n => { if (n.from > a || /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i.test(n.name)) blocked = true; },
    leave: n => { if (n.to < b) blocked = true; } });
  return !blocked;
}

// The vendored editor bundle, read in node for its markdown parser alone: the
// inline spans above are the parser's, the lines are this file's own.
let editor = null;
function loadEditor() {
  if (editor) return editor;
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "cm-markdown.js"), "utf8");
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + ";globalThis.CM6 = CM6;", sandbox);
  editor = sandbox.CM6;
  return editor;
}

module.exports = {
  loadEditor,
  splitLines, lineAt, structure, inlineSpans, drawn, hiddenSet, atoms, outOfAtoms, columns,
  st, typeText, newline, backspace, deleteForward, groupTarget, nativeWordTarget,
  moveByChar, byGroup, lineBoundary, move, tab, paste, clusterStarts, category,
};
