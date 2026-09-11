/*
 * Format text while typing: the card composer draws its own Markdown as it is
 * written, and still sends the Markdown itself.
 *
 * The setting is on by default and lives in localStorage, the way every other
 * per-browser choice on the board does. Off, the composer is the plain
 * textarea it has always been and not one line of this file runs on it.
 *
 * What it draws, and nothing else: one star is italic, two are bold, two tildes
 * on either side are a strike, a leading angle is a quote bar, and a dash or
 * star and a space is a bullet. Inserting a new line inside a list carries the
 * marker down; doing it on a bullet with nothing typed after it ends the list.
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
 * span the cursor is actually in or beside. Block markers, the quote angles,
 * still come back by the line, because a caret at the head of a line has to
 * have somewhere to stand.
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

  const STORE_KEY = "composeformat";   // "1" on, "0" off, absent means on
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
  function enabled() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw == null ? true : raw !== "0";
    } catch (error) { return true; }
  }

  function setEnabled(on) {
    const want = !!on;
    if (want === enabled()) return want;
    try { localStorage.setItem(STORE_KEY, want ? "1" : "0"); } catch (error) {}
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
  let awakeEffect = null;
  let themeExtension = null;

  // ---- a list's own column --------------------------------------------------
  // Give the marker and its separator the same width as the hanging indent.
  // Proportional-font character advances differ from ch units; document
  // positions stay intact. The column is the marker plus one ch.
  const MARK_STEP = 1;

  // the angles a quoted line opens with. markup, so they take no room while
  // they are hidden, and the line's own prefix begins after them
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
    const hide = D.replace({});                       // markup and nothing else
    const emphasis = D.mark({ class: "cf-em" });
    const strong = D.mark({ class: "cf-strong" });
    const strike = D.mark({ class: "cf-strike" });
    const breakable = D.mark({ class: "cf-first" });
    const INLINE = { Emphasis: emphasis, StrongEmphasis: strong, Strikethrough: strike };
    const INLINE_MARK = { EmphasisMark: true, StrikethroughMark: true };

    function build(state, awake) {
      const doc = state.doc, out = [];
      // The raw characters come back around the cursor and nowhere else, and
      // only while the row is being typed in: a row nobody is in is a row to
      // read. A range counts as touched at either edge, so the markers are
      // already there when the caret arrives rather than one keystroke later.
      const hot = (from, to) => awake &&
        state.selection.ranges.some(range => range.to >= from && range.from <= to);
      const quote = new Map();   // line number -> how deep the quote is
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
      C.syntaxTree(state).iterate({
        enter: node => {
          if (INLINE[node.name]) {
            out.push(INLINE[node.name].range(node.from, node.to));
            return;
          }
          if (INLINE_MARK[node.name]) {
            const owner = node.node.parent;
            if (owner && !hot(owner.from, owner.to)) out.push(hide.range(node.from, node.to));
            return;
          }
          if (node.name === "Blockquote") {
            const first = doc.lineAt(node.from).number, last = doc.lineAt(node.to).number;
            for (let n = first; n <= last; n++) quote.set(n, (quote.get(n) || 0) + 1);
            return;   // the walk carries on inside it, so quoted words still format
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
            const head = line.from + (quote.has(line.number) ? quoteWidth(line.text) : 0);
            const lead = line.text.slice(head - line.from, mark.from - line.from);
            if (!/\S/.test(lead)) headBox(line, "cf-col", base, head, mark.from);
            const last = doc.lineAt(node.to).number;
            marker.add(line.number);
            for (let n = line.number; n <= last; n++)
              hang.set(n, Math.max(hang.get(n) || 0, column));
            return;
          }
        },
      });

      // one line decoration per line the walk marked, and the quote angles
      // taken off any quoted line the cursor is not on
      for (const n of new Set([...quote.keys(), ...hang.keys()])) {
        const line = doc.line(n), classes = [], attributes = {};
        if (hang.has(n)) {
          classes.push("cf-li");
          // a line further down an item starts on the item's column as well,
          // and its own indent is a handful of spaces that do not reach it. a
          // line carrying nothing there is left unpulled instead
          if (!marker.has(n)) {
            const at = quote.has(n) ? quoteWidth(line.text) : 0;
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
            while (start < line.to && /[ \t]/.test(line.text[start - line.from])) start++;
            let stop = start;
            while (stop < line.to && !/[ \t]/.test(line.text[stop - line.from])) stop++;
            if (stop > start) out.push(breakable.range(start, stop));
          }
        }
        if (quote.has(n)) {
          classes.push("cf-quote");
          if (!hot(line.from, line.to)) {
            const angles = quoteWidth(line.text);
            if (angles) out.push(hide.range(line.from, line.from + angles));
          }
        }
        out.push(D.line({ class: classes.join(" "), attributes }).range(line.from));
      }
      return D.set(out, true);
    }

    layerExtension = C.StateField.define({
      create: state => ({ awake: false, deco: build(state, false) }),
      update: (value, tr) => {
        let awake = value.awake;
        for (const effect of tr.effects) if (effect.is(awakeEffect)) awake = effect.value;
        // the document, the cursor, the focus and the parse are the four things
        // any of this reads; a scroll is on none of them
        if (awake === value.awake && !tr.docChanged && !tr.selection &&
            C.syntaxTree(tr.state) === C.syntaxTree(tr.startState)) return value;
        return { awake, deco: build(tr.state, awake) };
      },
      provide: field => C.EditorView.decorations.from(field, value => value.deco),
    });
    return layerExtension;
  }

  const QUOTE_PAD = "9px";   // the room the quote bar keeps to the left of its words

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
      ".cf-bullet": { color: "transparent", position: "relative" },
      ".cf-bullet::before": {
        content: '"\\2022"', position: "absolute", left: "0", right: "0",
        textAlign: "center", textIndent: "0", color: "var(--sub, #75695A)",
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
        borderLeft: "3px solid var(--line-strong, #D8CFBE)",
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

  // ---- inserting a line inside a list --------------------------------------
  const LIST_LINE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(.*)$/;

  // What the new line starts with, given the line the caret is on. Null means
  // this is not a list line and a plain break is all that is wanted.
  function listContinuation(text) {
    const found = LIST_LINE.exec(text);
    if (!found) return null;
    const [, indent, dash, digits, closer, gap, rest] = found;
    return {
      empty: !rest.trim(),
      head: indent + (dash ? dash : String(Math.min(+digits + 1, 999999999)) + closer) + gap,
      markerEnd: indent.length + (dash ? 1 : digits.length + 1) + gap.length,
      indent,
    };
  }

  // Inserting a new line: a list carries its marker down, and a marker with
  // nothing typed after it ends the list instead of laying another one out.
  function insertNewline(C, view) {
    const state = view.state, range = state.selection.main;
    const line = state.doc.lineAt(range.from);
    const list = listContinuation(line.text);
    if (list && list.empty && range.from >= line.from + list.markerEnd &&
        range.to <= line.to) {
      // the empty bullet goes, the caret stays on the line it was on, and the
      // list is over
      view.dispatch(state.update({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
        scrollIntoView: true,
        userEvent: "input",
      }));
      return true;
    }
    const head = list && range.from >= line.from + list.markerEnd ? list.head : "";
    view.dispatch(state.update({
      changes: { from: range.from, to: range.to, insert: "\n" + head },
      selection: { anchor: range.from + 1 + head.length },
      scrollIntoView: true,
      userEvent: "input",
    }));
    return true;
  }

  // ---- the four chords the page owns and the editor must not ---------------
  // Reserve these page shortcuts before the editor's Mac/iOS selection
  // bindings. Returning true prevents editor handling while the event still
  // bubbles to card/history listeners. Command keeps its editor selection.
  const PAGE_CHORDS = ["Shift-Ctrl-ArrowUp", "Shift-Ctrl-ArrowDown",
                       "Shift-Ctrl-ArrowLeft", "Shift-Ctrl-ArrowRight"]
    .map(key => ({ key, run: () => true }));

  // ---- the editor a field puts on ------------------------------------------
  function extensions(C, field) {
    const keys = [
      ...PAGE_CHORDS,
      ...C.historyKeymap,
      // Enter belongs to the row and not to the editor: what it does is the
      // page's own command, and what is left of it is handled below
      ...C.defaultKeymap.filter(binding => !/Enter/.test(binding.key || "")),
    ];
    return [
      // the strike is the bundle's own GitHub one, two tildes on either side,
      // which is the form the sent card reads. Nothing is put on top of it, so
      // a lone pair stays the characters it was typed as
      C.markdown({ base: C.markdownLanguage }),
      C.history(),
      // the editor writes its own class attribute on every update, so the name
      // the page styles the row by is handed to it rather than set on the node
      C.EditorView.editorAttributes.of({ class: field.shellClass }),
      // this runs on the content, before the key ever reaches a listener the
      // page put on the row, so the two can never both answer one press
      C.EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
          if (event.altKey || event.ctrlKey || event.metaKey) return false;
          if (!field.newline(event)) return false;   // the page's own send
          if (event.repeat) return true;
          return insertNewline(C, view);
        },
      }),
      C.keymap.of(keys),
      layer(C),
      theme(C),
      ...(field.placeholder ? [C.placeholder(field.placeholder())] : []),
      C.EditorView.lineWrapping,
      C.EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
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
      setSelectionRange: {
        value: (from, to) => {
          const length = view.state.doc.length;
          const anchor = Math.max(0, Math.min(from == null ? 0 : from, length));
          const head = Math.max(0, Math.min(to == null ? anchor : to, length));
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
    const view = new C.EditorView({ state: freshState(C, field, text, caret), parent });
    parent.insertBefore(view.dom, ta.nextSibling);   // the row's own seat
    field.view = view;
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
    // the two the layer cannot read off the state on its own, put on the
    // element so the dispatch lands outside the editor's own update
    for (const event of ["focus", "blur"])
      view.contentDOM.addEventListener(event, () => {
        if (field.view === view) view.dispatch({ effects: awakeEffect.of(event === "focus") });
      });
    // one input event per change and never two: the browser's own is kept
    // inside the editor and the page is told once, whether the change came
    // from a keystroke, a paste, a command or a line inserted above
    view.contentDOM.addEventListener("input", event => event.stopPropagation());
    wearFace(field);
    moveListeners(field, true);
    if (hadFocus) view.focus();
    return true;
  }

  function unmount(field) {
    if (!field.view) return;
    const view = field.view, hadFocus = hasCaret(view);
    const pick = view.state.selection.main;
    moveListeners(field, false);
    dropFace(field);
    field.view = null;
    // out of the editor before the editor goes, or the field goes with it
    if (view.dom.parentNode) view.dom.parentNode.insertBefore(field.ta, view.dom);
    view.destroy();
    Element.prototype.removeEventListener.call(field.ta, "focus", field.bridge);
    field.bridge = null;
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
    try {
      restoreHostSelection(field, pick.from, pick.to, pick.anchor > pick.head);
    } catch (error) {}
    field.changed();
  }

  // Putting the editor on is always one turn later than the call that asked
  // for it, even when the bundle is already here, so a page that builds a row
  // and then hangs its listeners on it has finished before anything moves.
  const MOUNT_TRIES = 120;
  function applyMode(field) {
    if (!enabled()) { unmount(field); return; }   // an ending, and an immediate one
    if (field.view) return;
    // this field is now on its way to a face, and settled() owes an answer for
    // it until it gets there. every path out of the work below gives that answer
    // back exactly once
    noteSettling(1);
    bundle().then(ok => {
      if (!ok) { noteSettling(-1); return; }
      let tries = 0;
      const go = () => {
        if (!enabled() || field.dropped || field.view) { noteSettling(-1); return; }
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
      heldStyle: "",
      heldEditable: null,
      seat: null,
      inUpdate: false,     // the editor is in the middle of its own update
      scrollAsk: 0,        // which of the page's scroll writes is the latest
      shellClass: opts.className || "cffield",
      // a line the page writes in keeps its words in textContent, not in value
      textValue: !!opts.textValue,
      // what an empty row shows, built fresh for each editor that asks
      placeholder: typeof opts.placeholder === "function" ? opts.placeholder : null,
      newline: typeof opts.newline === "function" ? opts.newline : event => event.shiftKey,
      // one place a page is told the words changed, whichever face is on
      changed() {
        const target = this.view ? this.view.dom : this.ta;
        target.dispatchEvent(new Event("input", { bubbles: true }));
      },
      text() { return this.view ? this.view.state.doc.toString() : hostText(this); },
      formatted() { return !!this.view; },
      focused() {
        return this.view ? hasCaret(this.view) : document.activeElement === this.ta;
      },
      // the row's own height from its words, which is the two lines every
      // composer wrote by hand before there was a second face to write them on
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
      detach() {
        this.dropped = true;
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
  };
});
