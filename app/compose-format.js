/*
 * Format text while typing: the card composer draws its own Markdown as it is
 * written, and still sends the Markdown itself.
 *
 * On the two desktop pages the setting is one of the board's own settings,
 * kept beside the board (board-settings.js), so every address the board is
 * opened at types the same way; the phone keeps its own in its localStorage,
 * as every other phone choice is kept. A page that has stored no choice
 * starts as the board says, and a board that says nothing starts it off: see
 * boardDefault. Off, the
 * composer is the plain textarea it has always been and not one line of this
 * file runs on it.
 *
 * What it draws, and nothing else: one star is italic, two are bold, two tildes
 * on either side are a strike, a leading angle AND THE SPACE AFTER IT are a
 * quote bar, and a dash or star and a space is a bullet. A marker is a marker
 * once it is finished being typed and not before: a lone angle, like a lone
 * dash, is the character it was typed as until its space arrives. Each is
 * drawn as the card the row is sent to draws it: a span inside one line and
 * not one that runs over a line break, and a quote only on the lines that
 * carry their own angle. Inserting a new line inside a list carries the marker
 * down, moving the numbers after a new numbered item on, and the editor's own
 * continuation carries a quote's angle and its space down the same way; doing
 * it on a marker or an angle with nothing typed after it ends the list or the
 * quote. Inside a block of code nothing is carried.
 * Headings, tables, links, code fences and the rest of Markdown are left as
 * plain characters here: this is a message row, not a document editor.
 *
 * The editor is the CodeMirror 6 bundle already vendored beside the pages for
 * the markdown panel (/cm-markdown.js). Only its core, its markdown parser and
 * its history are used; the panel's live preview pack is deliberately not
 * loaded, because that pack draws a whole document's worth of Markdown and
 * this row wants five things drawn and everything else left alone. The layer
 * below is written out of the same primitives the board's own markdown layer
 * uses, so both surfaces are drawn the same way.
 *
 * One difference from the markdown panel is deliberate. The panel puts a
 * line's raw markers back whenever the cursor is anywhere on that line. In a
 * row that is usually one line long that would mean the words never format
 * while they are being typed, so here the raw markers come back for the one
 * span the cursor is actually in or beside. The quote angles are the one thing
 * that never comes back once they are drawn at all: the bar is the whole of a
 * quote here, and a line drawing the bar and the angles together would be one
 * quote written twice under the typist, with the words stepping sideways every
 * time the caret arrived. That holds wherever the quote starts, at the head of
 * the line or after a list marker, and however deep it is. The angles keep
 * their places in the document, so the caret, a picked out passage and the
 * markdown the row sends all go on counting them. Two kinds of angle are never
 * drawn away: one the parser did not call a marker, inside a code span or in
 * the middle of a sentence, and one whose space has not been typed yet.
 *
 * The textarea does not leave the page while the editor stands in for it. It
 * keeps the field's one public face: its value, its selection, its focus, its
 * box and its listeners all read and write through to the editor, so every
 * caller that has ever held a composer keeps working, and switching the
 * setting off hands the same text straight back to it.
 */
(function installComposeFormat(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ComposeFormat = api;
})(typeof globalThis === "object" ? globalThis : this, function composeFormatFactory() {
  "use strict";

  const STORE_KEY = "composeformat";   // "1" on, "0" off, absent means the board's default
  const BUNDLE_URL = "/cm-markdown.js";

  const fields = new Set();
  const watchers = new Set();
  let bundleLoad = null;
  let bundleFailed = false;

  // ---- the handshake a page that must not show itself half built waits on ----
  // A composer takes its final face for this load in three ways, and all three
  // are endings: the editor mounts, the setting is off, or the editor cannot be
  // had at all. settled() answers when every field attached so far has reached
  // one of them, so a page holding a curtain over its start can hold it until
  // the row the reader will see is the row it is going to stay.
  //
  // THERE IS NO CLOCK IN THIS. A wait that gave up after so many milliseconds
  // would answer a question about the editor with the time of day, and it would
  // answer wrongly in exactly the case it exists for: a slow file still on its
  // way. A bundle that neither arrives nor fails therefore leaves this
  // unanswered, which is the same rule the phone's own gate already keeps for a
  // picture that never decodes. A bundle that FAILS is an answer: the row stays
  // the plain field it already was and the page carries on.
  let settling = 0;
  let settleWaiters = [];
  function noteSettling(step) {
    settling += step;
    if (settling > 0) return;
    const waiting = settleWaiters;
    settleWaiters = [];
    for (const resolve of waiting) resolve(true);
  }
  function settled() {
    if (settling === 0) return Promise.resolve(true);
    return new Promise(resolve => settleWaiters.push(resolve));
  }
  // False once the editor has been asked for and could not be had. A page can
  // say so; nothing here draws anything about it.
  function available() { return !bundleFailed; }

  // ---- the setting ----------------------------------------------------------
  // The server writes the board's choice in front of this file when it serves
  // it (compose_format_default in run.config.json), so it is known before the
  // first composer is built. A copy loaded any other way carries none, and that
  // is off.
  function boardDefault() {
    return globalThis.COMPOSE_FORMAT_DEFAULT === true;
  }

  // the board's settings store on a desktop page, this browser's own storage
  // anywhere else (the phone loads no store)
  function store() {
    return globalThis.boardSettings || localStorage;
  }

  function enabled() {
    try {
      const raw = store().getItem(STORE_KEY);
      return raw == null ? boardDefault() : raw !== "0";
    } catch (error) { return boardDefault(); }
  }

  function setEnabled(on) {
    const want = !!on;
    if (want === enabled()) return want;
    try { store().setItem(STORE_KEY, want ? "1" : "0"); } catch (error) {}
    for (const field of fields) applyMode(field);
    for (const watcher of watchers) { try { watcher(want); } catch (error) {} }
    return want;
  }

  function onChange(fn) { if (typeof fn === "function") watchers.add(fn); }

  // ---- the vendored editor --------------------------------------------------
  // Fetched once per page and never blocking: the row is a working textarea
  // from the first paint and puts the editor on when the bundle lands. A server
  // from before the route answers 404 and every composer simply stays plain.
  function bundle() {
    if (window.CM6) return Promise.resolve(true);
    if (bundleFailed) return Promise.resolve(false);
    if (bundleLoad) return bundleLoad;
    bundleLoad = new Promise(resolve => {
      const tag = document.createElement("script");
      tag.src = BUNDLE_URL;
      tag.onload = () => resolve(!!window.CM6);
      tag.onerror = () => { bundleFailed = true; bundleLoad = null; resolve(false); };
      document.head.append(tag);
    });
    return bundleLoad;
  }

  // ---- what the editor draws ------------------------------------------------
  let layerExtension = null;
  let hideDeco = null;          // the drawing's one way of taking markup out of sight
  let awakeEffect = null;
  let holdEffect = null;
  let themeExtension = null;

  // A press of the pointer holds what is drawn still until the gesture is over.
  // The markers of the span the caret arrives in come back on show, and when a
  // click is what put the caret there, the words would move under the pointer
  // before the second press of a double click or the far end of a drag came
  // down on them. The hold is let go this long after the pointer comes up,
  // which is the time a second press takes to arrive, or at once by a key or
  // a change to the words.
  const HOLD_MS = 500;

  // ---- a list's own column --------------------------------------------------
  // Give the marker and its separator the same width as the hanging indent.
  // Proportional-font character advances differ from ch units; document
  // positions stay intact. The column is the marker plus one ch.
  const MARK_STEP = 1;

  // How much of a line the angles of a top level quote take, for the arithmetic
  // an item's column is worked out with: the item's own indent begins after
  // them. Where the angles are DRAWN is a different question, and the parse
  // answers that one, by its own QuoteMark nodes; see the walk below.
  const QUOTE_ANGLES = /^[ \t]*(?:>[ \t]?)+/;
  function quoteWidth(text) {
    const angles = QUOTE_ANGLES.exec(text);
    return angles ? angles[0].length : 0;
  }

  // a run of the document's own characters given an exact width. the width is
  // written on the span because it is different on every line
  function box(D, cls, width) {
    return D.mark({ class: cls, attributes: { style: "--cf-w:" + width + "ch" } });
  }

  // The one walk over the tree, collecting what to draw. Written as a state
  // field and not a view plugin for the reason the board's markdown layer is:
  // the state is what the editor measures its own height from.
  function layer(C) {
    if (layerExtension) return layerExtension;
    const D = C.Decoration;
    awakeEffect = C.StateEffect.define();
    holdEffect = C.StateEffect.define();
    const hide = hideDeco = D.replace({});            // markup and nothing else
    const emphasis = D.mark({ class: "cf-em" });
    const strong = D.mark({ class: "cf-strong" });
    const strike = D.mark({ class: "cf-strike" });
    const code = D.mark({ class: "cf-code" });
    const link = D.mark({ class: "cf-link" });
    const breakable = D.mark({ class: "cf-first" });
    const INLINE = { Emphasis: emphasis, StrongEmphasis: strong, Strikethrough: strike, InlineCode: code };
    const INLINE_MARK = { EmphasisMark: true, StrikethroughMark: true, CodeMark: true };

    function build(state, awake, picked) {
      const doc = state.doc, out = [], atoms = [];   // atoms: the hidden angles the caret steps over
      // The raw characters come back around the cursor and nowhere else, and
      // only while the row is being typed in: a row nobody is in is a row to
      // read. A range counts as touched at either edge, so the markers are
      // already there when the caret arrives rather than one keystroke later.
      // The cursor read is the one a pointer's hold kept, if one is held.
      const hot = (from, to) => awake &&
        picked.ranges.some(range => range.to >= from && range.from <= to);
      const quote = new Map();   // line number -> how deep the quote is
      const angles = new Map();  // line number -> the run its quote markers take
      const hang = new Map();    // line number -> the column its text hangs on
      const pull = new Map();    // line number -> how far its first line is pulled back
      const marker = new Set();  // the lines a marker is actually written on
      const itemHang = new Map();   // list item -> the column its own text hangs on
      const listMark = new Map();   // list -> the widest marker written in it
      // a run given a column's width, counted into what stands in front of the
      // line's words. the first line is pulled back by exactly that sum, so a
      // line with nothing standing there is not pulled back at all
      const headEnd = new Map();    // line number -> where its head boxes end
      const headBox = (line, cls, width, from, to) => {
        if (to <= from) return;
        out.push(box(D, cls, width).range(from, to));
        pull.set(line.number, (pull.get(line.number) || 0) + width);
        headEnd.set(line.number, Math.max(headEnd.get(line.number) || 0, to));
      };
      // the card draws a span inside one line and leaves one that runs over a
      // line break as the characters it was typed as, so this does too; a span
      // inside it that stays on one line is still drawn
      const oneLine = (from, to) => doc.lineAt(from).number === doc.lineAt(to).number;
      const heading = new Map();   // line number -> its heading's level
      C.syntaxTree(state).iterate({
        enter: node => {
          if (INLINE[node.name]) {
            if (oneLine(node.from, node.to)) out.push(INLINE[node.name].range(node.from, node.to));
            return;
          }
          if (INLINE_MARK[node.name]) {
            // a fence's backticks are a block's and not a span's, and stay
            const owner = node.node.parent;
            if (owner && INLINE[owner.name] && oneLine(owner.from, owner.to) && !hot(owner.from, owner.to))
              out.push(hide.range(node.from, node.to));
            return;
          }
          // A link written out, [words](address), is drawn as its words, and
          // its brackets and address come back while the caret touches it. A
          // bare address is drawn as a link and has nothing to hide. The card
          // links both the same way.
          if (node.name === "Link") {
            const marks = node.node.getChildren("LinkMark");
            if (marks.length < 4 || !node.node.getChild("URL") || !oneLine(node.from, node.to)) return;
            if (marks[1].from > marks[0].to) out.push(link.range(marks[0].to, marks[1].from));
            if (!hot(node.from, node.to)) {
              out.push(hide.range(node.from, marks[0].to));
              out.push(hide.range(marks[1].from, node.to));
            }
            return;   // the walk carries on inside it, so its words still format
          }
          if (node.name === "URL") {
            // an address inside a link over a line break is a bare one, as
            // the card reads that link: a line at a time, so the address runs
            // as far as its own line's reading of it does
            const owner = node.node.parent;
            if (owner && owner.name === "Link" && !oneLine(owner.from, owner.to)) {
              const line = doc.lineAt(node.from), at = node.from - line.from;
              C.markdownLanguage.parser.parse(line.text).iterate({ enter: bare => {
                if (bare.name === "URL" && bare.from === at && bare.to > bare.from &&
                    !/^(Link|Image|Autolink)$/.test(bare.node.parent.name))
                  out.push(link.range(node.from, line.from + bare.to));
              } });
              return;
            }
            if (!owner || !/^(Link|Image|Autolink)$/.test(owner.name)) out.push(link.range(node.from, node.to));
            return;
          }
          // A heading is drawn at its size once its space is typed, as the card
          // draws it, and its hashes show while the caret is on its line, as in
          // Obsidian. A heading's underline (a line of dashes under words) is
          // left as typed: it is half of a list's marker while it is typed.
          if (/^ATXHeading[1-6]$/.test(node.name)) {
            const mark = node.node.firstChild, line = doc.lineAt(node.from);
            if (!mark || mark.name !== "HeaderMark") return;
            const gap = /^[ \t]+/.exec(line.text.slice(mark.to - line.from));
            if (!gap) return;
            heading.set(line.number, +node.name.slice(-1));
            if (!hot(line.from, line.to)) out.push(hide.range(mark.from, mark.to + gap[0].length));
            return;
          }
          if (node.name === "Blockquote") {
            const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) quote.set(n, (quote.get(n) || 0) + 1);
            return;   // the walk carries on inside it, so quoted words still format
          }
          if (node.name === "QuoteMark") {
            // Where a line's quote markers actually stand, taken from the parse
            // and never from the look of the line: an angle in the middle of a
            // sentence, or inside a code span, is one of the reader's own
            // characters and is not one of these. They are the markup the bar
            // is drawn from, so the drawing leaves them out, on the line being
            // typed as much as on any other. Whatever their depth, and whether
            // the line begins with them or carries a list marker first, one run
            // per line is written down here and taken off the line below.
            const line = doc.lineAt(node.from);
            let from = node.from, to = node.to;
            // The one space the marker owns, and the whole of what makes it a
            // marker to look at. An angle with an ordinary space after it is
            // finished being typed and is markup; an angle with anything else
            // after it, or with nothing at all, is a character the reader has
            // put there and is still being written. An unfinished nested
            // angle stays visible inside any already completed outer quote.
            const live = line.text[to - line.from] === " ";
            if (live) to++;
            // and the indent it stands on, when that indent is the line's own
            // and not room another marker has already been given
            while (from > line.from && /[ \t]/.test(line.text[from - 1 - line.from])) from--;
            if (from > line.from) from = node.from;
            const held = angles.get(line.number);
            angles.set(line.number, held
              ? { from: Math.min(held.from, from),
                  to: live || !held.live ? Math.max(held.to, to) : held.to,
                  live: held.live || live }
              : { from, to, live });
            return;
          }
          if (node.name === "ListItem") {
            const line = doc.lineAt(node.from), mark = node.node.firstChild;
            const list = node.node.parent;
            if (!mark || mark.name !== "ListMark" || !list) return;
            const source = line.text.slice(mark.from - line.from, mark.to - line.from);
            // one marker column per list, off its widest marker, so 9. and 10.
            // put their words on one column instead of two
            let widest = listMark.get(list.from);
            if (widest === undefined) {
              widest = 1;
              for (const item of list.getChildren("ListItem")) {
                const own = item.firstChild;
                if (own && own.name === "ListMark") widest = Math.max(widest, own.to - own.from);
              }
              listMark.set(list.from, widest);
            }
            // a nested item's marker stands where its parent's words start, so
            // a level is the level above it and one column more, and the two
            // can never cross whatever the indent was typed as
            const owner = list.parent;
            const base = owner && owner.name === "ListItem" ? (itemHang.get(owner.from) || 0) : 0;
            const column = base + widest + MARK_STEP;
            itemHang.set(node.from, column);
            // A marker is only a marker once its separator is typed: a bare
            // dash is still a dash. Only that first separator joins the column;
            // any space after it is the reader's own and keeps its own width.
            if (!/[ \t]/.test(line.text[mark.to - line.from] || "")) return;
            const text = mark.to + 1;
            // the marker and its separator, given the column they stand for.
            // a dash, a star or a plus is a bullet and wears a round marker; a
            // number is the list's own and keeps standing as it is
            const dot = /^[-*+]$/.test(source);
            headBox(line, dot ? "cf-col cf-mark cf-bullet" : "cf-col cf-mark",
                    widest + MARK_STEP, mark.from, text);
            // and the line's own indent, which is spaces, and spaces are
            // narrower than the level they are written for. it starts past any
            // angles, which belong to the quote and not to the item
            const angle = angles.get(line.number);
            const head = angle && angle.live ? angle.to : line.from;
            const lead = line.text.slice(head - line.from, mark.from - line.from);
            if (!/\S/.test(lead)) headBox(line, "cf-col", base, head, mark.from);
            const last = doc.lineAt(node.to).number;
            marker.add(line.number);
            // an item inside a quote ends where the quote does, at the first
            // line without an angle of its own, as the card draws it
            let quoted = false;
            for (let up = list.parent; up && !quoted; up = up.parent) quoted = up.name === "Blockquote";
            for (let n = line.number; n <= last; n++) {
              if (quoted && n > line.number && !/^ {0,3}>/.test(doc.line(n).text)) break;
              hang.set(n, Math.max(hang.get(n) || 0, column));
            }
            return;
          }
        },
      });

      // Which quoted lines are drawn as quotes. A quote begins at the space and
      // not at the angle: until an ordinary space completes a quote prefix,
      // the angle stays visible and the line keeps its ordinary layout. A line
      // the parser puts inside a quote but which carries no angle of its own,
      // which is a lazily continued one, is an ordinary line as well: the card
      // the row is sent to ends a quote at the first line without an angle.
      const barred = new Set();
      for (const n of quote.keys()) {
        const angle = angles.get(n);
        if (angle && angle.live) barred.add(n);
      }

      // one line decoration per line the walk marked, and the quote angles
      // taken off every line that is drawn as a quote
      for (const n of new Set([...quote.keys(), ...hang.keys(), ...heading.keys()])) {
        const line = doc.line(n), classes = [], attributes = {};
        if (heading.has(n)) classes.push("cf-h" + heading.get(n));
        if (hang.has(n)) {
          classes.push("cf-li");
          // a line further down an item starts on the item's column as well,
          // and its own indent is a handful of spaces that do not reach it. a
          // line carrying nothing there is left unpulled instead
          if (!marker.has(n)) {
            const angle = angles.get(n);
            const at = barred.has(n) && angle ? angle.to - line.from : 0;
            const lead = /^[ \t]+/.exec(line.text.slice(at));
            if (lead) headBox(line, "cf-col", hang.get(n),
                              line.from + at, line.from + at + lead[0].length);
          }
          attributes.style = "--cf-hang:" + hang.get(n) + "ch;" +
            "--cf-pull:" + (pull.get(n) || 0) + "ch";
          // A head box is an inline block, and a box is a break opportunity. A
          // first word with no room left beside it would take that break and
          // move down whole, leaving the marker alone on its row. Only that one
          // word is allowed to break inside itself; the rest wrap as ever.
          if (headEnd.has(n)) {
            let start = headEnd.get(n);
            // an item's own quote angles are not its first word when they are
            // not drawn, so they neither share the marker's row nor strand it.
            // An angle still waiting for its space is a word like any other
            const mark = barred.has(n) ? angles.get(n) : null;
            if (mark && start >= mark.from && start < mark.to) start = mark.to;
            while (start < line.to && /[ \t]/.test(line.text[start - line.from])) start++;
            let stop = start;
            while (stop < line.to && !/[ \t]/.test(line.text[stop - line.from])) stop++;
            if (stop > start) out.push(breakable.range(start, stop));
          }
        }
        if (barred.has(n)) {
          classes.push("cf-quote");
          // The bar is the quote, on the line being typed as much as on any
          // other. Drawing the bar and the angles together would be one quote
          // written twice, and it would move the line's words sideways under a
          // caret that only arrived to read them. The characters stay in the
          // document, so a pick still carries them and the markdown the row
          // sends still has them. The caret steps over them whole: a caret
          // standing between two angles nobody can see typed its words
          // somewhere else (">> deep" took an x at its start as ">> xdeep"),
          // or broke the quote it was in.
          const mark = angles.get(n);
          if (mark) {
            out.push(hide.range(mark.from, mark.to));
            atoms.push(hide.range(mark.from, mark.to));
          }
        }
        // a quoted line that is not drawn as one is an ordinary line, and is
        // left the ordinary line it already is
        if (classes.length || attributes.style)
          out.push(D.line({ class: classes.join(" "), attributes }).range(line.from));
      }
      return { deco: D.set(out, true), atoms: D.set(atoms, true) };
    }

    layerExtension = C.StateField.define({
      create: state => ({ awake: false, held: false, shown: false, picked: state.selection,
                          ...build(state, false, state.selection) }),
      update: (value, tr) => {
        let awake = value.awake, held = value.held;
        for (const effect of tr.effects) {
          if (effect.is(awakeEffect)) awake = effect.value;
          if (effect.is(holdEffect)) held = effect.value;
        }
        // a change to the words lets go of a pointer's hold, since what is
        // drawn has to go with them. until then the cursor and the focus are
        // read as they stood when the press came down (HOLD_MS)
        if (tr.docChanged) held = false;
        const shown = held ? value.shown : awake;
        const picked = held ? value.picked : tr.state.selection;
        // the document, the cursor, the focus and the parse are the four things
        // any of this reads; a scroll is on none of them
        if (shown === value.shown && picked.eq(value.picked) && !tr.docChanged &&
            C.syntaxTree(tr.state) === C.syntaxTree(tr.startState))
          return awake === value.awake && held === value.held ? value : { ...value, awake, held };
        return { awake, held, shown, picked, ...build(tr.state, shown, picked) };
      },
      provide: field => [C.EditorView.decorations.from(field, value => value.deco),
                         C.EditorView.atomicRanges.of(view => view.state.field(field).atoms)],
    });
    return layerExtension;
  }

  const QUOTE_PAD = "calc(9 * var(--u, 1px))";   // the room the quote bar keeps to the left of its words

  // The editor wears the row it stands in and not CodeMirror: every face,
  // colour and measure is inherited from the element each page styles, so a
  // page that moves its composer moves this with it. Only what the five drawn
  // things need is written out here.
  function theme(C) {
    if (themeExtension) return themeExtension;
    themeExtension = C.EditorView.theme({
      "&": {
        color: "inherit", backgroundColor: "transparent", fontFamily: "inherit",
        fontSize: "inherit", lineHeight: "inherit", flex: "1", minWidth: "0",
      },
      "&.cm-focused": { outline: "none" },
      // the scroller is the textarea's stand-in: the page dresses this one
      // element with the row's border, padding, floor and cap, so its box, its
      // scroll and its computed face read the way the field's always have
      ".cm-scroller": {
        fontFamily: "inherit", fontSize: "inherit", lineHeight: "inherit",
        overflowX: "hidden", overscrollBehavior: "none",
      },
      ".cm-content": { padding: "0" },
      ".cm-line": { padding: "0" },
      ".cf-em": { fontStyle: "italic" },
      ".cf-strong": { fontWeight: "650" },
      ".cf-strike": { textDecoration: "line-through" },
      // a code span, a link and a heading, at the card's own sizes and faces
      ".cf-code": { fontFamily: "var(--mono, ui-monospace, monospace)", background: "var(--paper, #F2EFE8)",
                    borderRadius: "var(--sq, 3px)" },
      ".cf-link": { textDecoration: "underline", textUnderlineOffset: "2px" },
      ".cf-h1": { fontSize: "1.55em", fontWeight: "650" },
      ".cf-h2": { fontSize: "1.35em", fontWeight: "650" },
      ".cf-h3": { fontSize: "1.2em", fontWeight: "650" },
      ".cf-h4": { fontSize: "1.1em", fontWeight: "650" },
      ".cf-h5": { fontSize: "1em", fontWeight: "650" },
      ".cf-h6": { fontSize: ".92em", fontWeight: "650" },
      // a run of the line's own characters given the width of the column it
      // stands for: the indent, and the marker with its air. text-indent is put
      // back because an inline block inherits the line's negative one
      ".cf-col": {
        display: "inline-block", boxSizing: "border-box", width: "var(--cf-w, 0)",
        textIndent: "0", whiteSpace: "pre",
      },
      // the marker is seated against the words, with its own separator as the
      // air, so a short marker ends on the same edge as a long one in its list.
      // the empty anchor keeps that separator from hanging past the column, so
      // the caret after it lands exactly where the words begin
      ".cf-mark": { textAlign: "right" },
      ".cf-mark::after": { content: '""', display: "inline-block", width: "0" },
      // the one word that may break inside itself, so it can share the row its
      // marker is on instead of moving down and stranding it
      ".cf-first": { wordBreak: "break-all" },
      // the source dash keeps its place in the document and a round marker is
      // painted over its column, so the caret and a selection stay exactly on
      // the characters
      ".cf-bullet": { WebkitTextFillColor: "transparent", position: "relative" },
      ".cf-bullet::before": {
        content: '"\\2022"', position: "absolute", left: "0", right: "0",
        textAlign: "center", textIndent: "0", WebkitTextFillColor: "currentColor",
      },
      // the item's own text column. the pull is what stands in front of the
      // first line's words, which is the column on a line that carries a marker
      // or an indent and nothing at all on a line that carries neither
      ".cf-li": {
        paddingLeft: "var(--cf-hang, 2ch)",
        textIndent: "calc(-1 * var(--cf-pull, 0px))",
      },
      // the same bar the card's own quoted prose is drawn with
      ".cf-quote": {
        borderLeft: "calc(3 * var(--u, 1px)) solid var(--line, #CACACA)",
        paddingLeft: QUOTE_PAD, color: "var(--sub, #75695A)",
      },
      // a quoted list is both, and one padding cannot be two: the bar's own
      // room and the item's column are one sum
      ".cf-quote.cf-li": {
        paddingLeft: "calc(" + QUOTE_PAD + " + var(--cf-hang, 2ch))",
      },
    });
    return themeExtension;
  }

  // ---- a list marker under a line of text -----------------------------------
  // A dash, a star, a plus or a number with its space is a list item at the
  // head of any line, right under a line of text as much as on an empty first
  // line. That is how Obsidian reads a list, a line at a time, and how the
  // sent card draws one. The parser follows CommonMark, which lets an item
  // break into a paragraph only once it has words and, numbered, only from 1:
  // under a line of text "- " read as that line's heading underline and "2. b"
  // as more of its words, so the bullet came only with the next character and
  // Backspace and a new line on it did what they do to text. A marker like
  // that ends the paragraph above it here, and the list it starts is read as
  // any list is.
  const LIST_BREAK = { parseBlock: [{ name: "ListBreak",
    endLeaf: (cx, line) => /^(?:[-*+]|\d{1,9}[.)])[ \t]/.test(line.text.slice(line.pos)) }] };

  // ---- a new line ------------------------------------------------------------
  // What a new line carries down is read off the containers the caret's line
  // stands in, outermost first: the quote angles at its head and the list
  // items the parse puts it in. That is the editor's own markdown continuation
  // (insertNewlineContinueMarkup in the vendored pack), worked out here so that
  // both pages make a new line the one way, Shift and return on the Mac and
  // the phone's return alike, with the row's own rules on top of it:
  //   - a quote is carried once its angle has its space, as it is drawn;
  //   - a line's own marker is its first one, and a marker typed after it is
  //     the item's words, as Obsidian reads a line;
  //   - the caret has to be past a marker's space for the marker to go on, and
  //     inside a block of code nothing is carried;
  //   - an item with nothing typed in it ends the list, or moves out a level
  //     when it is nested, and an empty quoted line ends the quote;
  //   - the spaces before the caret are not kept, but a marker keeps its own;
  //   - picked words make way for the new line, which is read off the line as
  //     it stands.
  // A new numbered item moves the numbers after it on, and an item leaving a
  // list moves them back, for the items that count up one by one: a list
  // written all in ones is left the way it was written.

  // A quote's angles at the head of a line, the last of them finished by its
  // space, which is where a quote begins in this row
  const QUOTED = /^ {0,3}(?:>[ \t]?)*>[ \t]/;
  const ANGLE = / {0,3}>( ?)/y;

  // The containers in front of a position, each with where its marker starts
  // and ends, its space included, on its own first line. Null inside code,
  // where a dash, a number or an angle is the code's own character.
  function containers(C, state, pos) {
    const doc = state.doc, line = doc.lineAt(pos), quotes = [], items = [];
    const live = QUOTED.exec(line.text), liveTo = live ? live[0].length : 0;
    for (let at = 0;;) {
      ANGLE.lastIndex = at;
      const m = ANGLE.exec(line.text);
      if (!m) break;
      quotes.push({ quote: true, from: at + m[0].indexOf(">"), to: at + m[0].length, space: m[1],
                    live: at + m[0].length <= liveTo });
      at += m[0].length;
    }
    for (let node = C.syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
      if (node.name === "FencedCode" || node.name === "CodeBlock") return null;
      if (node.name !== "ListItem") continue;
      const first = doc.lineAt(node.from), at = node.from - first.from;
      // a marker still waiting for its space is the character it was typed as
      const m = /^(?:(\d{1,9})([.)])|([-+*]))([ \t]+)/.exec(first.text.slice(at));
      if (m) items.unshift({ item: node, own: first.from === line.from, from: at, to: at + m[0].length,
                             space: m[4], number: m[1] ? +m[1] : null, mark: m[2] || m[3] });
    }
    return { line, quotes, items };
  }

  // a container's marker as the line under it carries it, and its blank: what
  // a line inside it, under its marker, has in front of its words
  function marker(c) {
    if (c.quote) return ">" + c.space;
    return (c.number == null ? c.mark : String(Math.min(c.number + 1, 999999999)) + c.mark) + c.space;
  }
  function blank(c, width) {
    const angle = c.quote ? ">" : "";
    if (width != null) return angle.padEnd(width, " ");
    return angle.padEnd(c.to - c.from - c.space.length, " ") + c.space;
  }

  // the numbers after a numbered item, counted on from where it now stands:
  // offset 0 for a new item after it, -2 for the item itself leaving the list
  function renumber(state, c, offset, changes) {
    let count = c.number;
    for (let next = c.item.nextSibling; next; next = next.nextSibling) {
      if (next.name !== "ListItem") continue;
      const mark = next.firstChild;
      const digits = mark && mark.name === "ListMark" && /^\d+/.exec(state.sliceDoc(mark.from, mark.to));
      if (!digits || +digits[0] !== count + 1 || count + 2 + offset > 999999999) return;
      count++;
      changes.push({ from: mark.from, to: mark.from + digits[0].length, insert: String(count + 1 + offset) });
    }
  }

  // The change a new line makes, and whether it carries or ends any markup:
  // a held return goes on only where it does (enterKey)
  function newlineChange(C, state) {
    const range = state.selection.main, pos = range.from, end = range.to, picked = !range.empty;
    const plain = { changes: { from: pos, to: end, insert: "\n" }, selection: { anchor: pos + 1 }, carries: false };
    const found = containers(C, state, pos);
    if (!found) return plain;
    const { line, quotes, items } = found;
    const col = pos - line.from;
    const first = items.find(it => it.own);
    const c = [...quotes.filter(q => q.live), ...items.filter(it => !it.own || it === first)]
      .sort((a, b) => a.from - b.from);
    // a marker standing right at the caret goes down whole with the words
    // after it, and only the ones before the caret are carried
    while (c.length && c[c.length - 1].from >= col) c.pop();
    const d = c[c.length - 1];
    if (!d || col < d.to) return plain;
    const take = (changes, anchor) => ({ changes, selection: { anchor }, carries: true });
    const empty = !/\S/.test(line.text.slice(d.to)) && end <= line.to;
    if (d.item && empty) {
      if (!d.own && !/^[\s>]*$/.test(line.text.slice(0, d.to))) return plain;
      const b = c.length > 1 ? c[c.length - 2] : null;
      if (b && b.item) {
        // a nested item moves out to its parent's level, with its marker
        const at = line.from + b.from, head = marker(b), changes = [{ from: at, to: end, insert: head }];
        if (d.number != null) renumber(state, d, -2, changes);
        if (b.number != null) renumber(state, b, 0, changes);
        return take(changes, at + head.length);
      }
      // the list is over, inside any quote it stands in
      const at = line.from + (b ? b.to : 0), changes = [{ from: at, to: end, insert: "" }];
      if (d.number != null) renumber(state, d, -2, changes);
      return take(changes, at);
    }
    if (d.quote && empty) {
      const at = c.every(x => x.quote) ? line.from : line.from + d.from;
      return take([{ from: at, to: Math.max(end, line.to), insert: "" }], at);
    }
    // a line of an item's own words, under its marker, stays in the item when
    // it is indented as one, and is an ordinary line when it is not
    const inside = d.item && !d.own;
    let head = "";
    if (!inside || /^[\s\d.)\-+*>]*/.exec(line.text)[0].length >= d.to)
      for (let f = 0, last = c.length - 1; f <= last; f++)
        head += f === last && !inside ? marker(c[f]) : blank(c[f], f < last ? c[f + 1].from - head.length : null);
    let g = pos;
    if (!picked) {
      const floor = line.from + (inside ? 0 : d.to);
      while (g > floor && /\s/.test(state.sliceDoc(g - 1, g))) g--;
    }
    const changes = [{ from: g, to: end, insert: "\n" + head }];
    if (d.own && d.number != null && end <= line.to) renumber(state, d, 0, changes);
    return { changes, selection: { anchor: g + 1 + head.length }, carries: head !== "" };
  }

  function insertNewline(C, view) {
    const spec = newlineChange(C, view.state);
    view.dispatch(view.state.update({
      changes: spec.changes, selection: spec.selection, scrollIntoView: true, userEvent: "input",
    }));
    return true;
  }

  // ---- who answers the return key -------------------------------------------
  // Two things can answer a return in this row and only one of them may, so
  // the choice is made here, once, before any of them has seen the key.
  //
  //   the page's send        the row keeps nothing back and writes nothing
  //   the row's own line     a shifted return here, and the phone's return in
  //                          the editor's own key pass, both one new line
  //                          (insertNewline)
  //
  // The page's send is the one that once went wrong: the vendored markdown
  // pack binds the return key to a continuation of its own, and a return meant
  // for the send wrote a marker into the row on its way out, so the card was
  // sent a line the reader never typed ("> alpha" arrived as "> alpha\n>").
  // The pack's binding is now left out altogether (extensions), and the row
  // makes the continuation itself, the same on both pages.
  //
  // This runs in the CAPTURE phase on the editor's outer element, which stands
  // above the content every editor binding is hung on, so it is answered first
  // whatever precedence those bindings were given. Preventing the default is
  // how the editor is told to keep its hands off: it skips an event that has
  // already been prevented, both before its handlers and between them. The key
  // still travels on to the listener the page hung on this same element, which
  // is what sends, and what it sends is the source exactly as it was typed.
  function noteEnter(field, step, event, branch) {
    try { field.enterTrace?.(step, event, branch); } catch (_) {}
  }
  function enterKey(C, field, view, event) {
    if (event.key !== "Enter") {
      if (event.code === "Enter" || event.code === "NumpadEnter" || event.keyCode === 13)
        noteEnter(field, "format", event, "other-key");
      return;
    }
    if (event.isComposing || event.keyCode === 229) {
      noteEnter(field, "format", event, "composition"); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) {
      noteEnter(field, "format", event, "modifier"); return;
    }
    // the page's own send: nothing writes in the row on the way out, neither
    // the editor's continuation nor the browser's own line break
    if (!field.newline(event)) {
      event.preventDefault(); noteEnter(field, "format", event, "send"); return;
    }
    // A shifted return is made here. Held, it makes one line and not a run
    // of them, on a list as much as anywhere.
    if (event.shiftKey) {
      event.preventDefault();
      if (event.repeat) { noteEnter(field, "format", event, "repeat"); return; }
      insertNewline(C, view);
      noteEnter(field, "format", event, "row-line");
      return;
    }
    // and the phone's return goes on to the editor's own key pass, which makes
    // the same line (extensions)
    noteEnter(field, "format", event, "editor");
  }

  // ---- the chords the page owns and the editor must not ---------------------
  // Reserve these page shortcuts before the editor's Mac/iOS selection
  // bindings. Returning true prevents editor handling while the event still
  // bubbles to card/history listeners. Command keeps its editor selection.
  // Control+Shift with [, ] or \ moves the card to doing, deferred or done.
  // The editor reaches a shifted bracket under its unshifted name, and outside
  // a Mac its stock keymap has control+shift+\ for the matching bracket, which
  // this shadows; they are claimed so no editor update can take them either.
  // Control+Option with Up or Down steps between the card's title, response and
  // row (cardPlace in card-logic.js); outside a Mac the stock keymap adds a caret
  // above or below on it, which this shadows.
  const PAGE_CHORDS = ["Shift-Ctrl-ArrowUp", "Shift-Ctrl-ArrowDown",
                       "Shift-Ctrl-ArrowLeft", "Shift-Ctrl-ArrowRight",
                       "Shift-Ctrl-[", "Shift-Ctrl-]", "Shift-Ctrl-\\",
                       "Alt-Ctrl-ArrowUp", "Alt-Ctrl-ArrowDown"]
    .map(key => ({ key, run: () => true }));

  // Option/Alt with Up/Down is caret movement and selection, as in a plain
  // field. The stock bindings move or copy whole logical lines; exclude them
  // without changing Left/Right word navigation (see paragraphEdge for what
  // the keys do instead).
  const MOVES_TEXT = /^(Shift-)?Alt-Arrow(Up|Down)$/;

  // The Mac's paragraph keys, made here the way the browser makes them in a
  // plain field: Option and Up go to the start of the paragraph (a line of
  // the message), or from its start to the start of the one above, and Option
  // and Down to its end, or the end of the one below; a pick closes up at its
  // near end first. With Shift the pick's head goes a paragraph up or down,
  // keeping its place across the line. Left to the browser, the marker drawn
  // at a list line's head stopped them: on a list's first line Option and Up
  // did nothing at all.
  function paragraphEdge(view, forward) {
    const doc = view.state.doc, range = view.state.selection.main;
    // a line's start is where its words start: past a quote's hidden angles,
    // where Home stops as well and a character typed stays in the quote
    const atoms = view.state.field(layerExtension).atoms;
    const start = line => {
      let at = line.from;
      atoms.between(line.from, line.from, (from, to) => { if (from === line.from) at = to; });
      return at;
    };
    let head = range.head;
    if (!forward && range.empty && head === start(doc.lineAt(head))) head = doc.lineAt(head).from;
    const p = !range.empty ? (forward ? range.to : range.from)
      : forward ? Math.min(doc.length, head + 1) : Math.max(0, head - 1);
    const line = doc.lineAt(p);
    view.dispatch({ selection: { anchor: forward ? line.to : start(line) }, scrollIntoView: true, userEvent: "select" });
    return true;
  }
  function paragraphStep(view, forward) {
    const doc = view.state.doc, range = view.state.selection.main, line = doc.lineAt(range.head);
    let head = forward ? doc.length : 0;
    if (line.number !== (forward ? doc.lines : 1)) {
      const next = doc.line(line.number + (forward ? 1 : -1));
      // the row of the next paragraph that meets this one: its first going
      // down, its last going up
      const here = view.coordsAtPos(range.head), row = view.coordsAtPos(forward ? next.from : next.to);
      const found = here && row ? view.posAtCoords({ x: here.left, y: (row.top + row.bottom) / 2 }) : null;
      head = Math.max(next.from, Math.min(next.to, found == null ? next.from : found));
    }
    view.dispatch({ selection: { anchor: range.anchor, head }, scrollIntoView: true, userEvent: "select" });
    return true;
  }

  // ---- Backspace after an emoji ---------------------------------------------
  // The plain field takes a whole emoji with one Backspace: a skin tone, a
  // keycap or a flag's tags go with the picture they belong to. The editor's
  // own Backspace takes the last piece of a cluster, which is right for an
  // accent written as a mark of its own and wrong for these, so an emoji is
  // taken whole here and everything else is left to the editor.
  const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;   // the last is a keycap
  let graphemes = null;
  function deleteEmojiBackward(view) {
    const state = view.state, range = state.selection.main;
    if (state.selection.ranges.length > 1 || !range.empty) return false;
    if (typeof Intl !== "object" || !Intl.Segmenter) return false;
    const line = state.doc.lineAt(range.head);
    const before = line.text.slice(Math.max(0, range.head - line.from - 64), range.head - line.from);
    graphemes = graphemes || new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let last = "";
    for (const piece of graphemes.segment(before)) last = piece.segment;
    if (last.length < 2 || !EMOJI.test(last)) return false;
    view.dispatch(state.update({
      changes: { from: range.head - last.length, to: range.head },
      scrollIntoView: true,
      userEvent: "delete.backward",
    }));
    return true;
  }

  // ---- the reader's own keyboard and spelling --------------------------------
  // The editor turns the browser's spelling check, the phone's word correction
  // and its capital at the start of a sentence off on its content. The plain
  // field keeps all three unless the page says otherwise, and the row is one
  // row whichever face it wears, so the content is given what the field has.
  // Read once, from the field as the page made it, before the editor is on.
  function typingAttributes(ta) {
    return {
      spellcheck: ta.spellcheck ? "true" : "false",
      autocorrect: ta.getAttribute("autocorrect") || "on",
      autocapitalize: ta.getAttribute("autocapitalize") || "sentences",
    };
  }

  // ---- Backspace after a marker ---------------------------------------------
  // The pack's own Backspace, which takes a list marker or a quote's angle off
  // whole when the caret stands right after it (deleteMarkupBackward). Its
  // keymap is left out of this row for the sake of its return key, so its
  // Backspace is taken from that keymap and put in the row's own.
  let markupBack = null;
  function deleteMarkupBackward(C) {
    if (markupBack) return markupBack;
    const probe = C.EditorState.create({ extensions: C.markdown() });
    for (const set of probe.facet(C.keymap))
      for (const binding of set) if (binding.key === "Backspace" && !markupBack) markupBack = binding.run;
    return markupBack || (() => false);
  }

  // ---- deleting to the row's edge -------------------------------------------
  // Command with Backspace or Delete takes the words up to the row's edge. The
  // editor finds that edge where the row's first or last character on show
  // stands, so a span's marker hidden there was left behind and came back as
  // a stray character: Command and Backspace after "`code` and more" left a
  // lone backtick in the row. Markup hidden at the edge goes with the words
  // here. A quote's angles stay: they are the quote, and not words in it. A
  // pick is the editor's to delete.
  function deleteToRowEdge(C, view, forward) {
    const state = view.state, range = state.selection.main;
    if (state.selection.ranges.length > 1 || !range.empty) return false;
    const line = state.doc.lineAt(range.head), drawn = state.field(layerExtension).deco;
    let edge = view.moveToLineBoundary(range, forward).head;
    for (let moved = true; moved;) {
      moved = false;
      drawn.between(Math.max(line.from, edge - 1), Math.min(line.to, edge + 1), (from, to, value) => {
        if (value !== hideDeco) return;
        if (!forward && to === edge && from < edge) { edge = from; moved = true; }
        if (forward && from === edge && to > edge) { edge = to; moved = true; }
      });
    }
    if (!forward) state.field(layerExtension).atoms.between(line.from, line.from, (from, to) => {
      if (from === line.from) edge = Math.max(edge, to);
    });
    const head = range.head;
    const target = forward ? (head < edge ? edge : Math.min(state.doc.length, head + 1))
      : (head > edge ? edge : Math.max(0, head - 1));
    if (target === head) return true;
    view.dispatch(state.update({
      changes: { from: Math.min(head, target), to: Math.max(head, target) },
      selection: { anchor: Math.min(head, target) },
      scrollIntoView: true, userEvent: forward ? "delete.forward" : "delete.backward",
    }));
    return true;
  }

  // ---- Tab in a list ---------------------------------------------------------
  // Tab nests a list item under the one above it and Shift+Tab brings it back
  // out a level, as in Obsidian, on every line of the pick that has a marker
  // of its own. The nesting is written in spaces as wide as the marker above,
  // or the item's own with nothing above it, which the parser and the card
  // read as the next level down. On a line with no marker the key is left to
  // the page, whose Tab steps out of the box (cardTab in card-logic.js).
  const MARKER = /^(?:\d{1,9}[.)]|[-+*])[ \t]+/;
  function markerWidth(state, node) {
    const found = MARKER.exec(state.sliceDoc(node.from, state.doc.lineAt(node.from).to));
    return found ? found[0].length : 0;
  }
  // the outermost list item whose marker, with its space, is on this line
  function ownItem(C, state, line) {
    let found = null;
    C.syntaxTree(state).iterate({ from: line.from, to: line.to, enter: node => {
      if (found || node.name === "FencedCode" || node.name === "CodeBlock") return false;
      if (node.name === "ListItem" && node.from >= line.from && markerWidth(state, node)) {
        found = node.node;
        return false;
      }
    } });
    return found;
  }
  function listIndent(C, view, outward) {
    const state = view.state, doc = state.doc, range = state.selection.main, changes = [];
    let listed = false;
    for (let n = doc.lineAt(range.from).number, last = doc.lineAt(range.to).number; n <= last; n++) {
      const line = doc.line(n), item = ownItem(C, state, line);
      if (!item) continue;
      listed = true;
      if (!outward) {
        // after the quote's angles, where the item's own indent starts
        const at = line.from + /^(?: {0,3}> ?)*/.exec(line.text)[0].length;
        const above = item.prevSibling && item.prevSibling.name === "ListItem" ? item.prevSibling : null;
        changes.push({ from: at, insert: " ".repeat((above && markerWidth(state, above)) || markerWidth(state, item)) });
        continue;
      }
      const parent = item.parent && item.parent.parent;
      if (!parent || parent.name !== "ListItem") continue;
      const from = line.from + (parent.from - doc.lineAt(parent.from).from);
      if (from < item.from) changes.push({ from, to: item.from });
    }
    if (!listed) return false;
    if (!changes.length) return true;   // an item at the margin has nowhere further out to go
    const set = state.changes(changes);
    view.dispatch({ changes: set, selection: { anchor: set.mapPos(range.anchor, 1), head: set.mapPos(range.head, 1) },
                    scrollIntoView: true, userEvent: outward ? "delete.dedent" : "input.indent" });
    return true;
  }

  // ---- pasting words with their formatting ----------------------------------
  // Words copied from a page arrive as markdown, as Obsidian takes them in
  // (its "Convert pasted HTML to Markdown"): bold, italic, struck and code
  // words, links, headings, quotes and lists keep their form. A paste with no
  // formatting in it is left to the editor, which takes its plain words, and
  // so is one carrying files, which the page puts in the tray.
  function htmlMarkdown(html) {
    const body = new DOMParser().parseFromString(html, "text/html").body;
    let formatted = false;
    const BLOCK = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|FIGURE|UL|OL|LI|BLOCKQUOTE|H[1-6]|PRE|HR|TABLE|TBODY|THEAD|TR)$/;
    const inline = node => {
      if (node.nodeType === 3) return node.data.replace(/[ \t\r\n]+/g, " ");
      if (node.nodeType !== 1) return "";
      const words = () => [...node.childNodes].map(inline).join("");
      // the marker hugs the words and the spaces around them stay outside it
      const wrap = mark => {
        const [, lead, kept, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(words());
        if (!kept) return lead + tail;
        formatted = true;
        return lead + mark + kept + mark + tail;
      };
      switch (node.tagName) {
        case "B": case "STRONG": return wrap("**");
        case "I": case "EM": return wrap("*");
        case "S": case "DEL": case "STRIKE": return wrap("~~");
        case "CODE": {
          const code = node.textContent;
          if (!code) return "";
          formatted = true;
          return "`" + code + "`";
        }
        case "A": {
          const href = node.getAttribute("href") || "", text = words();
          if (!/^(https?:|mailto:)/i.test(href) || !text.trim()) return text;
          formatted = true;
          return "[" + text.trim() + "](" + href + ")";
        }
        case "BR": return "\n";
        case "IMG": return "";
        default: return words();
      }
    };
    // a run of nodes as blocks, a blank line between them, or one line apart
    // inside a list item
    const blocks = (nodes, tight) => {
      const out = [];
      let line = "";
      const flush = () => { const done = line.replace(/^ +| +$/gm, ""); if (done.trim()) out.push(done.trim()); line = ""; };
      for (const node of nodes) {
        if (node.nodeType !== 1 || !BLOCK.test(node.tagName)) { line += inline(node); continue; }
        flush();
        const tag = node.tagName;
        if (/^H[1-6]$/.test(tag)) {
          formatted = true;
          out.push("#".repeat(+tag[1]) + " " + blocks(node.childNodes, true).replace(/\n+/g, " "));
        } else if (tag === "BLOCKQUOTE") {
          formatted = true;
          out.push(blocks(node.childNodes, false).split("\n").map(l => (l ? "> " + l : ">")).join("\n"));
        } else if (tag === "UL" || tag === "OL") {
          formatted = true;
          let number = +node.getAttribute("start") || 1;
          const items = [];
          for (const li of node.children) {
            if (li.tagName !== "LI") continue;
            const mark = tag === "OL" ? (number++) + ". " : "- ";
            const [first, ...rest] = blocks(li.childNodes, true).split("\n");
            items.push(mark + first, ...rest.map(l => (l ? " ".repeat(mark.length) + l : l)));
          }
          out.push(items.join("\n"));
        } else if (tag === "PRE") {
          formatted = true;
          out.push("```\n" + node.textContent.replace(/\n$/, "") + "\n```");
        } else if (tag === "HR") {
          formatted = true;
          out.push("---");
        } else {
          const inner = blocks(node.childNodes, tight);
          if (inner) out.push(inner);
        }
      }
      flush();
      return out.join(tight ? "\n" : "\n\n");
    };
    const text = blocks(body.childNodes, false);
    return formatted && text ? text : null;
  }
  function pasteMarkdown(event, view) {
    const data = event.clipboardData;
    if (!data || (data.files && data.files.length)) return false;
    const html = data.getData("text/html");
    if (!html) return false;
    let text = null;
    try { text = htmlMarkdown(html); } catch (error) { text = null; }
    if (text == null) return false;
    view.dispatch(view.state.replaceSelection(text), { userEvent: "input.paste", scrollIntoView: true });
    return true;
  }

  // ---- the editor a field puts on ------------------------------------------
  function extensions(C, field) {
    const keys = [
      ...PAGE_CHORDS,
      ...C.historyKeymap,
      { key: "Backspace", run: deleteMarkupBackward(C) },
      { key: "Backspace", run: deleteEmojiBackward, shift: deleteEmojiBackward },
      { key: "Tab", run: view => listIndent(C, view, false), shift: view => listIndent(C, view, true) },
      { mac: "Mod-Backspace", run: view => deleteToRowEdge(C, view, false) },
      { mac: "Mod-Delete", run: view => deleteToRowEdge(C, view, true) },
      { key: "Alt-ArrowUp", run: view => paragraphEdge(view, false), shift: view => paragraphStep(view, false) },
      { key: "Alt-ArrowDown", run: view => paragraphEdge(view, true), shift: view => paragraphStep(view, true) },
      // The editor's stock return bindings are not among the two things that
      // may answer a return in this row, so they are left out. Which of the two
      // does answer it is decided in enterKey. The line moves and copies are
      // left out as well; see MOVES_TEXT.
      ...C.defaultKeymap.filter(binding =>
        !/Enter/.test(binding.key || "") && !MOVES_TEXT.test(binding.key || "")),
    ];
    return [
      // The strike is the bundle's own GitHub one, two tildes on either side,
      // which is the form the sent card reads. Nothing is put on top of it, so
      // a lone pair stays the characters it was typed as. The pack's keymap is
      // left out: the row makes its own new line (insertNewline) and keeps the
      // pack's Backspace in its own keymap above.
      C.markdown({ base: C.markdownLanguage, extensions: LIST_BREAK, addKeymap: false }),
      C.history(),
      // the editor writes its own class attribute on every update, so the name
      // the page styles the row by is handed to it rather than set on the node
      C.EditorView.editorAttributes.of({ class: field.shellClass }),
      C.EditorView.contentAttributes.of(field.typing),
      // What is left of the return key once enterKey has had it: the phone's
      // return, which makes the row's new line here. Anything enterKey already
      // decided has been prevented and never arrives here at all. A held
      // return goes on carrying a quote or a list down and ends a list once;
      // on a line with neither it makes one line and no more.
      C.EditorView.domEventHandlers({
        paste: pasteMarkdown,
        // A character typed with the caret between a quote's hidden angles,
        // or over a pick that starts or ends at them, goes in where the
        // editor's own caret is. The browser can only stand its caret beside
        // the hidden run: typed there, ">> one" took the character after its
        // angles, and a pick starting right after them broke its line in two.
        beforeinput: (event, view) => {
          if (event.inputType !== "insertText" || event.isComposing || event.data == null) return false;
          const range = view.state.selection.main;
          let near = false;
          view.state.field(layerExtension).atoms.between(range.from, range.to, (from, to) => {
            if (from < range.head && range.head < to) near = true;
            if (!range.empty && ((range.from >= from && range.from <= to) || (range.to >= from && range.to <= to))) near = true;
          });
          if (!near) return false;
          event.preventDefault();
          view.dispatch(view.state.replaceSelection(event.data), { userEvent: "input.type", scrollIntoView: true });
          return true;
        },
        keydown: (event, view) => {
          if (event.key !== "Enter") {
            if (event.code === "Enter" || event.code === "NumpadEnter" || event.keyCode === 13)
              noteEnter(field, "editor", event, "other-key");
            return false;
          }
          if (event.isComposing || event.keyCode === 229) {
            noteEnter(field, "editor", event, "composition"); return false;
          }
          if (event.altKey || event.ctrlKey || event.metaKey) {
            noteEnter(field, "editor", event, "modifier"); return false;
          }
          if (!field.newline(event)) {
            noteEnter(field, "editor", event, "send"); return true;
          }
          if (event.repeat && !newlineChange(C, view.state).carries) {
            noteEnter(field, "editor", event, "repeat"); return true;
          }
          insertNewline(C, view);
          noteEnter(field, "editor", event, "row-line");
          return true;
        },
      }),
      C.keymap.of(keys),
      layer(C),
      theme(C),
      // asked each time the editor draws its placeholder, so the row shows the
      // page's line as it is then
      ...(field.placeholder ? [C.placeholder(() => {
        const line = document.createElement("span");
        line.textContent = field.placeholder();
        return line;
      })] : []),
      C.EditorView.lineWrapping,
      C.EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        field.edited = true;
        // the page is told inside the editor's own update, so anything it does
        // in answer must not reach back into the editor's measuring
        field.inUpdate = true;
        try { field.changed(); } finally { field.inUpdate = false; }
      }),
    ];
  }

  // `at` is either a single position or the pair a field hands over: what was
  // selected is carried whole, so turning the setting on under a reader who has
  // words picked out does not quietly collapse the pick to its first character
  function freshState(C, field, text, at) {
    const state = C.EditorState.create({ doc: text, extensions: extensions(C, field) });
    const inside = n => Math.max(0, Math.min(n == null ? text.length : n, text.length));
    const range = typeof at === "object" && at
      ? { anchor: inside(at.anchor), head: inside(at.head) }
      : { anchor: inside(at) };
    return state.update({ selection: range }).state;
  }

  // ---- the one public face -------------------------------------------------
  // Everything a composer has ever been asked for goes on reading and writing
  // the same names while the editor stands in for the field. The field itself
  // stays in the page, laid over the editor and out of sight, holding the
  // computed face the row is measured by and catching a focus call made on it
  // from outside this file.
  const FACE = [
    "selectionStart", "selectionEnd", "selectionDirection", "scrollTop", "scrollHeight",
    "clientHeight", "clientWidth", "offsetWidth", "offsetHeight", "style",
    "classList", "focus", "blur", "select", "setSelectionRange",
    "getBoundingClientRect", "animate",
  ];

  // A textarea keeps its words in value; a line the page writes in keeps them
  // in textContent. One name each, and the face is otherwise the same.
  function textProp(field) { return field.textValue ? "textContent" : "value"; }
  function hostText(field) {
    const raw = field.ta[textProp(field)];
    return raw == null ? "" : String(raw);
  }

  // Whether the caret is in this editor, asked the way it is asked of a plain
  // field: which element the document has active. The editor's own hasFocus
  // says no as well whenever the WINDOW is not the active one, which is a true
  // answer to a different question and the wrong one for a page asking where
  // its own caret is.
  function hasCaret(view) {
    const root = view.root || document;
    return root.activeElement === view.contentDOM;
  }

  // ---- carrying a reader's selection between the two faces -------------------
  // A textarea keeps a selection of its own, in characters. A line the page
  // writes in has no selection of its own at all: what is picked out in it is
  // the document's one selection, held as a pair of nodes and offsets. Both are
  // counted here in the same characters the field's text is counted in, so a
  // passage picked out before the editor arrives, or before the setting is
  // turned off, is the same passage afterwards, the same way round.

  // how many characters of this field's own text stand before a point in it
  function pointOffset(root, node, offset) {
    if (!node || !root.contains(node)) return null;
    if (node.nodeType !== 3 && offset >= node.childNodes.length && node === root)
      return (root.textContent || "").length;
    const stop = node.nodeType === 3 ? null : (node.childNodes[offset] || null);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0, text;
    while ((text = walk.nextNode())) {
      if (node.nodeType === 3) { if (text === node) return seen + offset; }
      else if (stop && (text === stop || stop.contains(text))) return seen;
      seen += text.data.length;
    }
    return seen;
  }

  // and the point that many characters in, for putting one back
  function offsetPoint(root, offset) {
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let seen = 0, text;
    while ((text = walk.nextNode())) {
      if (offset <= seen + text.data.length) return { node: text, offset: offset - seen };
      seen += text.data.length;
    }
    return { node: root, offset: root.childNodes.length };
  }

  // what the field has picked out right now, as an anchor and a head. A line
  // with nothing of the document's selection in it answers with its own end,
  // which is where a caret with nowhere else to be belongs.
  function hostSelection(field) {
    const ta = field.ta;
    if (!field.textValue) {
      const back = ta.selectionDirection === "backward";
      return { anchor: back ? ta.selectionEnd : ta.selectionStart,
               head: back ? ta.selectionStart : ta.selectionEnd };
    }
    const end = { anchor: hostText(field).length };
    let picked = null;
    try { picked = document.getSelection(); } catch (error) { return end; }
    if (!picked || picked.rangeCount === 0) return end;
    const anchor = pointOffset(ta, picked.anchorNode, picked.anchorOffset);
    const head = pointOffset(ta, picked.focusNode, picked.focusOffset);
    if (anchor == null || head == null) return end;
    return { anchor, head };
  }

  // and back the other way, once the field is the one on show again
  function restoreHostSelection(field, from, to, backward) {
    const ta = field.ta;
    if (!field.textValue) {
      ta.setSelectionRange(from, to, backward ? "backward" : "forward");
      return;
    }
    const start = offsetPoint(ta, from), stop = offsetPoint(ta, to);
    const picked = document.getSelection();
    if (!picked) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(stop.node, stop.offset);
    picked.removeAllRanges();
    picked.addRange(range);
    // the way round the reader made it, where the browser can say so
    if (backward && from !== to && typeof picked.extend === "function") {
      picked.collapse(stop.node, stop.offset);
      picked.extend(start.node, start.offset);
    }
  }

  function wearFace(field) {
    const ta = field.ta, view = field.view;
    const props = {
      [textProp(field)]: {
        get: () => view.state.doc.toString(),
        // a field forgets its undo history when its words are written into it,
        // so this does too: a send that empties the row leaves nothing behind
        set(next) {
          const text = next == null ? "" : String(next);
          if (text === view.state.doc.toString()) return;
          view.setState(freshState(field.C, field, text, text.length));
          field.edited = false;
          // a fresh state starts asleep, as a row nobody is in should. the
          // caret staying in it through the write is no focus event, so the
          // layer is told here that the row is still being typed in
          if (hasCaret(view)) view.dispatch({ effects: awakeEffect.of(true) });
        },
      },
      selectionStart: { get: () => view.state.selection.main.from },
      selectionEnd: { get: () => view.state.selection.main.to },
      // the editor knows which end the reader dragged from, so the field says so
      selectionDirection: {
        get: () => {
          const pick = view.state.selection.main;
          if (pick.empty) return "none";
          return pick.anchor > pick.head ? "backward" : "forward";
        },
      },
      scrollTop: {
        get: () => view.scrollDOM.scrollTop,
        // The editor can still owe a scroll of its own, scheduled from the last
        // change and applied on a frame of its own rather than in the change.
        // The row's scroll is the page's to decide, though: the phone works out
        // which line the caret is on and puts the row where that line is in
        // view, and it has done that since long before there was an editor in
        // here. So whatever the editor had already queued is finished first,
        // the number the caller asked for is written, and it is written once
        // more on the next frame in case the editor was still going to move it.
        // A later call supersedes an earlier one, and a scroll the reader makes
        // with a finger or a wheel comes through neither of them and is left
        // entirely alone.
        set(px) {
          const scroller = view.scrollDOM;
          if (!field.inUpdate) { try { view.measure(); } catch (error) {} }
          scroller.scrollTop = px;
          const asked = ++field.scrollAsk;
          requestAnimationFrame(() => {
            if (field.view !== view || field.scrollAsk !== asked) return;
            if (Math.abs(scroller.scrollTop - px) > 0.5) scroller.scrollTop = px;
          });
        },
      },
      scrollHeight: { get: () => view.scrollDOM.scrollHeight },
      clientHeight: { get: () => view.scrollDOM.clientHeight },
      clientWidth: { get: () => view.scrollDOM.clientWidth },
      offsetWidth: { get: () => view.scrollDOM.offsetWidth },
      offsetHeight: { get: () => view.scrollDOM.offsetHeight },
      style: { get: () => view.scrollDOM.style },
      classList: { get: () => view.scrollDOM.classList },
      focus: { value: () => view.focus() },
      blur: { value: () => view.contentDOM.blur() },
      select: {
        value: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
      },
      // an anchor and a head, which is how a caller holding the editor's own
      // pick hands it back, or a start, an end and a direction, as a field
      // takes them: backward puts the head at the start
      setSelectionRange: {
        value: (from, to, direction) => {
          const length = view.state.doc.length;
          let anchor = Math.max(0, Math.min(from == null ? 0 : from, length));
          let head = Math.max(0, Math.min(to == null ? anchor : to, length));
          if (direction === "backward" && anchor < head) [anchor, head] = [head, anchor];
          view.dispatch({ selection: { anchor, head } });
        },
      },
      getBoundingClientRect: { value: () => view.scrollDOM.getBoundingClientRect() },
      animate: { value: (...args) => view.scrollDOM.animate(...args) },
    };
    for (const name of FACE.concat(textProp(field)))
      Object.defineProperty(ta, name, { configurable: true, ...props[name] });
  }

  function dropFace(field) {
    const text = field.text();
    for (const name of FACE.concat(textProp(field))) delete field.ta[name];
    field.ta[textProp(field)] = text;
  }

  // ---- where a listener the page put on the row actually goes ---------------
  // focus and blur do not travel, so they go on the content itself; a scroll
  // does not travel either and belongs to the scroller. Everything else is put
  // on the editor's outer element, which every one of them reaches, and which
  // is after the editor has had the key itself.
  function host(field, type) {
    if (type === "focus" || type === "blur") return field.view.contentDOM;
    if (type === "scroll") return field.view.scrollDOM;
    return field.view.dom;
  }

  function moveListeners(field, on) {
    for (const entry of field.listeners) {
      const from = on ? field.ta : host(field, entry.type);
      const to = on ? host(field, entry.type) : field.ta;
      Element.prototype.removeEventListener.call(from, entry.type, entry.fn, entry.opts);
      Element.prototype.addEventListener.call(to, entry.type, entry.fn, entry.opts);
    }
  }

  function trackListeners(field) {
    const ta = field.ta;
    ta.addEventListener = function (type, fn, opts) {
      if (fn) field.listeners.push({ type, fn, opts });
      const target = field.view ? host(field, type) : ta;
      Element.prototype.addEventListener.call(target, type, fn, opts);
    };
    ta.removeEventListener = function (type, fn, opts) {
      const at = field.listeners.findIndex(e => e.type === type && e.fn === fn);
      if (at >= 0) field.listeners.splice(at, 1);
      const target = field.view ? host(field, type) : ta;
      Element.prototype.removeEventListener.call(target, type, fn, opts);
    };
  }

  // ---- putting the editor on and taking it off ------------------------------
  // The field stays a real, focusable element while the editor stands in for
  // it. It is moved inside the editor and laid exactly over it, invisible and
  // deaf to the pointer: a caller that reaches past this file and focuses or
  // clicks the element itself, which is what a driven browser does, then lands
  // in the editor and nowhere else, and a focus call scrolls to the row rather
  // than to some corner. It keeps the row's own type and padding, so anything
  // measuring the field's computed face goes on reading the same numbers.
  const HIDE_STYLE = "position:absolute;left:0;top:0;right:0;bottom:0;width:auto;" +
    "height:auto;min-height:0;margin:0;opacity:0;pointer-events:none;z-index:-1;" +
    "overflow:hidden;resize:none";

  function mount(field) {
    const C = window.CM6, ta = field.ta;
    if (!C || field.view || !ta.parentNode) return false;
    field.C = C;
    const text = hostText(field);
    // the whole pick, in the order the field had it, from whichever of the two
    // kinds of selection this field keeps
    const caret = hostSelection(field);
    const hadFocus = document.activeElement === ta;
    const parent = ta.parentNode;
    const view = new C.EditorView({ state: resumedState(C, field, text, caret), parent });
    parent.insertBefore(view.dom, ta.nextSibling);   // the row's own seat
    field.view = view;
    // the editor content is the field the reader actually focuses now, so it
    // carries the same owned-focus mark the plain field does, and a page keying a
    // caret-reveal lock to that mark covers this content the same way
    view.contentDOM.setAttribute("data-owned-focus", "");
    field.seat = ta.nextSibling;   // where the field goes back to
    field.heldStyle = ta.getAttribute("style") || "";
    field.heldEditable = ta.getAttribute("contenteditable");
    ta.setAttribute("style", field.heldStyle + ";" + HIDE_STYLE);
    view.dom.appendChild(ta);
    ta.classList.add("cfmirror");
    ta.setAttribute("aria-hidden", "true");
    ta.tabIndex = -1;
    // the words live in the editor now. a line that writes in place would
    // otherwise keep its own editable text and its own browser selection, and
    // a focus landing there would fight the editor's for the caret
    if (field.textValue) ta.setAttribute("contenteditable", "false");
    ta[textProp(field)] = "";
    // A caller reaching past this file and focusing the element itself lands
    // here. Product code never does: it calls focus on the field and the face
    // hands that straight to the editor. What does is a driven browser, whose
    // focus call runs in a world of its own where the face is not visible.
    //
    // Focusing the element first leaves the browser holding a text control's
    // own selection, and it puts that away one turn later as a caret at the
    // head of the editor. The editor's selection is the one that counts, so it
    // is written back once the browser has finished with its own. Nothing the
    // reader does can run in between: a click never reaches the element at all.
    field.bridge = () => {
      const view = field.view;
      if (!view || document.activeElement !== ta) return;
      const keep = view.state.selection;
      const words = view.state.doc;
      view.focus();
      // The words are the test of whether this is still the same moment. A
      // caret put back after something has been typed would be a caret jumping
      // backwards under the typist, which is worse than the stray selection
      // this is here to undo, so an untouched document is the condition.
      const restore = () => {
        if (field.view !== view || !hasCaret(view)) return;
        if (view.state.doc !== words) return;
        if (!view.state.selection.eq(keep)) view.dispatch({ selection: keep, scrollIntoView: true });
      };
      Promise.resolve().then(restore);
      setTimeout(restore, 0);
    };
    Element.prototype.addEventListener.call(ta, "focus", field.bridge);
    // The return key, asked here before any of the editor's own bindings and
    // before any listener the page hangs on this same element: this is the
    // capture pass on the element they all sit under. See enterKey. The caret
    // being in the editor is the same condition those bindings are answered
    // under, so this pass is exactly as wide as they are and no wider.
    field.enter = event => {
      if (field.view === view && hasCaret(view)) enterKey(C, field, view, event);
      else if (event.key === "Enter") noteEnter(field, "format", event, "no-caret");
    };
    view.dom.addEventListener("keydown", field.enter, true);
    // the two the layer cannot read off the state on its own, put on the
    // element so the dispatch lands outside the editor's own update
    for (const event of ["focus", "blur"])
      view.contentDOM.addEventListener(event, () => {
        if (field.view === view) view.dispatch({ effects: awakeEffect.of(event === "focus") });
      });
    // A pointer's hold (HOLD_MS), taken in the capture pass on the editor's
    // outer element so it is in place before the editor reads where the press
    // landed, and let go a beat after the pointer comes up, or by any key
    const hold = on => {
      if (field.view !== view) return;
      if (view.state.field(layerExtension).held !== on) view.dispatch({ effects: holdEffect.of(on) });
    };
    view.dom.addEventListener("pointerdown", () => {
      clearTimeout(field.holdTimer);
      hold(true);
      const up = () => {
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        clearTimeout(field.holdTimer);
        field.holdTimer = setTimeout(() => hold(false), HOLD_MS);
      };
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
    }, true);
    view.dom.addEventListener("keydown", () => { clearTimeout(field.holdTimer); hold(false); }, true);
    // one input event per change and never two: the browser's own is kept
    // inside the editor and the page is told once, whether the change came
    // from a keystroke, a paste, a command or a line inserted above
    view.contentDOM.addEventListener("input", event => event.stopPropagation());
    wearFace(field);
    moveListeners(field, true);
    if (hadFocus) view.focus();
    return true;
  }

  // The state a row put aside when its editor came off (unmount with keep),
  // taken up again when the words are still the ones it was put aside with.
  // The caret and pick come with it, unless something has moved the field's own
  // selection since. Anything else starts afresh, as a field whose words were
  // written into it always has.
  function resumedState(C, field, text, caret) {
    const parked = field.parked;
    field.parked = null;
    if (!parked || parked.state.doc.toString() !== text) {
      field.edited = false;
      return freshState(C, field, text, caret);
    }
    const held = parked.pick;
    if (held.anchor === caret.anchor && held.head === caret.head) return parked.state;
    const inside = n => Math.max(0, Math.min(n == null ? text.length : n, text.length));
    return parked.state.update({
      selection: { anchor: inside(caret.anchor), head: inside(caret.head) },
    }).state;
  }

  // keep: the editor is coming off a row that will want it back (want(false)).
  // Its state is put aside for that, and the page is not told the words
  // changed, because they did not.
  function unmount(field, keep) {
    if (!field.view) return;
    const view = field.view, hadFocus = hasCaret(view);
    const pick = view.state.selection.main;
    // Only a row holding something to come back to keeps its state: words, or
    // an edit that undo could bring back. An untouched empty row is the same
    // row afresh, and several hundred of those are not held for nothing.
    const parked = keep && (view.state.doc.length > 0 || field.edited)
      ? view.state.update({ effects: [awakeEffect.of(false), holdEffect.of(false)] }).state : null;
    clearTimeout(field.holdTimer);
    field.parked = null;
    moveListeners(field, false);
    dropFace(field);
    field.view = null;
    // out of the editor before the editor goes, or the field goes with it
    if (view.dom.parentNode) view.dom.parentNode.insertBefore(field.ta, view.dom);
    view.destroy();
    Element.prototype.removeEventListener.call(field.ta, "focus", field.bridge);
    field.bridge = null;
    field.enter = null;   // it was hung on the editor's own element, which goes
    if (field.heldStyle) field.ta.setAttribute("style", field.heldStyle);
    else field.ta.removeAttribute("style");
    if (field.heldEditable == null) field.ta.removeAttribute("contenteditable");
    else field.ta.setAttribute("contenteditable", field.heldEditable);
    field.ta.classList.remove("cfmirror");
    field.ta.removeAttribute("aria-hidden");
    field.ta.removeAttribute("tabindex");
    // the focus goes back first and the pick after it: a line the page writes
    // in holds the document's one selection, and focusing it afterwards would
    // put a caret of its own where the pick was
    if (hadFocus) field.ta.focus({ preventScroll: true });
    // A textarea keeps a selection of its own and can put one back whenever it
    // likes. A line the page writes in has no such thing: what it would put
    // back is the document's ONE selection, which belongs to whichever field
    // the reader is actually in. With several of these lines on a page, every
    // one of them writing that selection meant the last one to be taken down
    // won, and the words a reader had picked out in the line they were typing
    // in were dropped by a line nobody had touched. A line without the caret
    // leaves the document's selection where it is.
    if (hadFocus || !field.textValue) {
      try {
        restoreHostSelection(field, pick.from, pick.to, pick.anchor > pick.head);
      } catch (error) {}
    }
    // what the field itself says is picked out once the editor is off, which is
    // how a later mount tells a pick moved in between from one left alone
    if (parked) field.parked = { state: parked, pick: hostSelection(field) };
    if (!keep) field.changed();
  }

  // Putting the editor on is always one turn later than the call that asked
  // for it, even when the bundle is already here, so a page that builds a row
  // and then hangs its listeners on it has finished before anything moves.
  // The one exception is want(true) on a held row, which a page asks for long
  // after the row and its listeners are in place.
  const MOUNT_TRIES = 120;
  function applyMode(field) {
    if (!enabled()) { field.parked = null; unmount(field); return; }   // an ending, and an immediate one
    // a held row that has not been asked for its editor has no face to reach,
    // and settled() owes nothing for it
    if (field.view || !field.wanted) return;
    // this field is now on its way to a face, and settled() owes an answer for
    // it until it gets there. every path out of the work below gives that answer
    // back exactly once
    noteSettling(1);
    bundle().then(ok => {
      if (!ok) { noteSettling(-1); return; }
      let tries = 0;
      const go = () => {
        if (!enabled() || field.dropped || field.view || !field.wanted) { noteSettling(-1); return; }
        if (!field.ta.parentNode && tries++ < MOUNT_TRIES) { requestAnimationFrame(go); return; }
        if (mount(field)) field.changed();
        noteSettling(-1);
      };
      go();
    });
  }

  // ---- the handle a page keeps ---------------------------------------------
  function attach(ta, options) {
    const opts = options || {};
    const field = {
      ta,
      view: null,
      C: null,
      dropped: false,
      listeners: [],
      bridge: null,
      enter: null,
      heldStyle: "",
      heldEditable: null,
      seat: null,
      inUpdate: false,     // the editor is in the middle of its own update
      scrollAsk: 0,        // which of the page's scroll writes is the latest
      holdTimer: 0,        // lets go of a pointer's hold (HOLD_MS)
      // a row attached held puts the editor on only once it is wanted (want)
      wanted: !opts.held,
      parked: null,        // the state a held row's editor put aside as it came off
      edited: false,       // the editor changed the words since they were written in
      shellClass: opts.className || "cffield",
      typing: typingAttributes(ta),   // spelling, correction and capitals, as the field has them
      // a line the page writes in keeps its words in textContent, not in value
      textValue: !!opts.textValue,
      // what an empty row shows, built fresh for each editor that asks
      placeholder: typeof opts.placeholder === "function" ? opts.placeholder : null,
      newline: typeof opts.newline === "function" ? opts.newline : event => event.shiftKey,
      enterTrace: typeof opts.enterTrace === "function" ? opts.enterTrace : null,
      // one place a page is told the words changed, whichever face is on
      changed() {
        const target = this.view ? this.view.dom : this.ta;
        target.dispatchEvent(new Event("input", { bubbles: true }));
      },
      text() { return this.view ? this.view.state.doc.toString() : hostText(this); },
      formatted() { return !!this.view; },
      // the page's line changed while the row stood empty: the plain field and
      // the editor's placeholder, if one is showing, both take it
      refreshPlaceholder() {
        if (!this.placeholder) return;
        const line = this.placeholder();
        this.ta.placeholder = line;
        const shown = this.view && this.view.dom.querySelector(".cm-placeholder > span");
        if (shown) shown.textContent = line;
      },
      focused() {
        return this.view ? hasCaret(this.view) : document.activeElement === this.ta;
      },
      // the element the reader's caret actually sits in, for a page keying a
      // focus lock to it: the editor content while the editor is on, else the field
      focusEl() {
        return this.view ? this.view.contentDOM : this.ta;
      },
      // the row's own height from its words, which is the two lines every
      // composer wrote by hand before there was a second face to write them on
      autosize() {
        const box = this.view ? this.view.scrollDOM : this.ta;
        box.style.height = "auto";
        box.style.height = box.scrollHeight + "px";
      },
      // what the words actually take. the height goes back to auto to be read,
      // exactly as a textarea has to be, or a row that has just lost a line
      // reports the height it already had
      contentHeight() {
        const box = this.view ? this.view.scrollDOM : this.ta;
        const held = box.style.height;
        box.style.height = "auto";
        const want = box.scrollHeight;
        box.style.height = held;
        return want;
      },
      // Where the caret's own line stands inside the scrolled content, in the
      // scroller's own pixels, so a page that brings a line into view by hand
      // can go on doing exactly that arithmetic on the row it can see. Null
      // when the row is plain and the page's own measuring applies.
      caretBand() {
        if (!this.view) return null;
        const view = this.view, head = view.state.selection.main.head;
        let coords = null;
        try { coords = view.coordsAtPos(head); } catch (error) { return null; }
        if (!coords) return null;
        const box = view.scrollDOM.getBoundingClientRect();
        const scrolled = view.scrollDOM.scrollTop;
        return {
          top: coords.top - box.top + scrolled,
          bottom: coords.bottom - box.top + scrolled,
          last: head >= view.state.doc.length,
        };
      },
      // For a row attached held: a page holding many rows and showing a few of
      // them puts the editor on only those. want(true) puts it on in this same
      // turn when the editor is already loaded, so a row can be shown or focused
      // straight after and is already wearing its final face; while the editor
      // is still on its way the row puts it on when it lands, and says so, as
      // any row does. want(false) takes it off again, keeping the words in the
      // field and the caret, pick and undo for the next want(true). Neither the
      // same-turn mount nor the taking off tells the page the words changed.
      // Answers whether the row is wearing the editor now.
      want(on) {
        this.wanted = !!on;
        if (this.dropped) return false;
        if (!on) { unmount(this, true); return false; }
        if (this.view || !enabled()) return !!this.view;
        if (window.CM6 && this.ta.parentNode) mount(this);
        else applyMode(this);
        return !!this.view;
      },
      detach() {
        this.dropped = true;
        this.parked = null;
        fields.delete(this);
        unmount(this);
      },
    };
    trackListeners(field);
    fields.add(field);
    applyMode(field);
    return field;
  }

  // The handle a row was attached with, for a caller holding only the field.
  function fieldOf(ta) {
    for (const field of fields) if (field.ta === ta) return field;
    return null;
  }

  // True while the caret is in this composer, whichever face it is wearing.
  function focused(ta) {
    const field = fieldOf(ta);
    return field ? field.focused() : document.activeElement === ta;
  }

  return {
    STORE_KEY, enabled, setEnabled, onChange, attach, focused, fieldOf,
    settled, available,
    // the pages use this to start the fetch early, so the row is already
    // wearing the editor by the time anybody types in it
    preload: bundle,
    // the state a composer's editor is created with, so a check can read the
    // keymap a composer really carries without a page around it
    freshState,
  };
});
