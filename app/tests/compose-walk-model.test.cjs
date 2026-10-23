// The typing walk's reference, checked on its own: the rules it holds the row
// to (compose-walk-model.cjs), each pinned on the case it was written for, and
// the walk's matrix (compose-walk-matrix.cjs), every cell of which has to have
// an answer. No browser.
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const M = require("./compose-walk-model.cjs");
const W = require("./compose-walk-matrix.cjs");

const C = M.loadEditor();
const caret = p => [{ from: p, to: p }];
const lines = (doc, at) => M.drawn(C, doc, caret(at));
const nl = (doc, a, h = a) => M.newline(M.st(doc, a, h)).state;
const bs = (doc, at) => M.backspace(M.st(doc, at), "formatted").state;

test("a dash and a space under a line of text is a bullet at once, as on an empty first line", () => {
  for (const doc of ["text\n- ", "- "]) {
    const last = lines(doc, doc.length).pop();
    assert.equal(last.bullet, true, JSON.stringify(doc));
    assert.equal(last.item, true, JSON.stringify(doc));
    assert.equal(last.shown, "• ");
  }
  assert.deepEqual(lines("text\n* ", 7)[1].shown, "• ");
  assert.equal(lines("text\n2. a", 9)[1].item, true, "a number other than one starts a list under text too");
  assert.equal(lines("text\n-", 6)[1].bullet, false, "a dash without its space is still a dash");
  assert.deepEqual(nl("text\n- ", 7), M.st("text\n", 5), "a new line on it ends the list");
  assert.deepEqual(bs("text\n- ", 7), M.st("text\n", 5), "Backspace takes the whole marker");
});

test("inline markup shows only while the caret touches its span", () => {
  const doc = "**bold** and *it*";
  assert.deepEqual(lines(doc, 13)[0].shown, "bold and *it*");
  assert.deepEqual(lines(doc, 4)[0].shown, "**bold** and it");
  assert.deepEqual(lines(doc, 8)[0].runs, [["**bold**", "s"], ["it", "e"]], "the edge of a span counts as touching it");
  assert.deepEqual(lines("see `code` and [link](https://x.y)", 0)[0].shown, "see code and link");
});

test("a heading's hashes show while the caret is on its line", () => {
  assert.deepEqual(lines("# Title\nbody", 12).map(l => [l.shown, l.heading]), [["Title", 1], ["body", 0]]);
  assert.deepEqual(lines("# Title\nbody", 3)[0].shown, "# Title");
  assert.equal(lines("#Title", 0)[0].heading, 0, "a heading begins once its space is typed");
});

test("the quote's angles are never shown once their space is typed", () => {
  assert.deepEqual(lines("> said", 6)[0], { shown: "said", runs: [], quote: true, item: false, bullet: false, heading: 0 });
  assert.equal(lines(">said", 5)[0].quote, false);
});

test("a new line carries a list or a quote down and ends it on an empty one", () => {
  assert.deepEqual(nl("- a", 3), M.st("- a\n- ", 6));
  assert.deepEqual(nl("- hel lo", 6), M.st("- hel\n- lo", 8), "the space before the caret is not kept");
  assert.deepEqual(nl("1. a\n2. b\n3. c", 4), M.st("1. a\n2. \n3. b\n4. c", 8), "the numbers after it count on");
  assert.deepEqual(nl("1. a\n1. b", 4), M.st("1. a\n2. \n1. b", 8), "a list of ones is left as written");
  assert.deepEqual(nl("- a\n  - ", 8), M.st("- a\n- ", 6), "an empty nested item moves out a level");
  assert.deepEqual(nl("> said", 6), M.st("> said\n> ", 9));
  assert.deepEqual(nl("> said\n> ", 9), M.st("> said\n", 7), "an empty quoted line ends the quote");
  assert.deepEqual(nl("> - q", 5), M.st("> - q\n> - ", 10));
  assert.deepEqual(nl("> - ", 4), M.st("> ", 2), "the list inside a quote ends and the quote stays");
  assert.deepEqual(nl("- a", 1), M.st("-\n a", 2), "a break inside the marker carries nothing");
  assert.deepEqual(nl("```\n- x", 7), M.st("```\n- x\n", 8), "nothing is carried inside code");
  assert.deepEqual(nl("- one", 2, 5), M.st("- \n- ", 5), "picked words make way for the next item");
});

test("Backspace after a marker takes the marker, as the editor's markdown commands do", () => {
  assert.deepEqual(bs("- a", 2), M.st("a", 0));
  assert.deepEqual(bs("- a\n- b", 6), M.st("- a\n  b", 6), "a later item's marker becomes its indent");
  assert.deepEqual(bs("> a", 2), M.st("a", 0));
  assert.deepEqual(bs("- a\n    b", 8), M.st("- a\n  b", 6));
  assert.deepEqual(bs("ok \u{1F44D}\u{1F3FD}", 7), M.st("ok ", 3), "an emoji goes whole");
});

test("Tab nests a list item and Shift+Tab brings it out; elsewhere Tab leaves the box", () => {
  assert.deepEqual(M.tab(M.st("- a\n- b", 7), false, "formatted").state, M.st("- a\n  - b", 9));
  assert.deepEqual(M.tab(M.st("1. a\n2. b", 9), false, "formatted").state, M.st("1. a\n   2. b", 12));
  assert.deepEqual(M.tab(M.st("- a\n  - b", 9), true, "formatted").state, M.st("- a\n- b", 7));
  assert.equal(M.tab(M.st("hello", 2), false, "formatted").blurred, true);
  assert.equal(M.tab(M.st("- a", 2), false, "plain").blurred, true);
});

test("the matrix places a caret at every kind of marker, angle, hash and span", () => {
  const labels = doc => W.positions(doc, C).map(p => p.label);
  for (const [doc, want] of [
    // (a place already made under another name keeps its first one)
    ["- one\n  - two", ["line 1 inside a marker", "line 1 after a marker", "line 2 before a marker", "line 2 inside the indent"]],
    ["1. one", ["line 1 inside a marker", "line 1 after a marker"]],
    ["> quoted", ["line 1 after an angle's space"]],
    ["text\n> q", ["line 2 after an angle's space"]],
    ["- > q", ["line 1 after an angle's space"]],
    ["# Title", ["line 1 inside the hashes", "line 1 after the hashes"]],
    ["**bold** x", ["bold marker start", "between the bold marker's characters", "the whole bold picked", "inside the bold"]],
    ["a `c` [l](https://x.y)", ["before the code", "before the link", "link marker end", "the link's words picked"]],
  ]) {
    const have = labels(doc);
    for (const label of want) assert.ok(have.includes(label), `${JSON.stringify(doc)} has no position "${label}": ${have.join(", ")}`);
  }
  // and no caret between angles drawn away, which nobody can reach
  assert.ok(!W.positions(">> deep", C).some(p => p.head === 1), "a caret between hidden angles");
});

test("every cell of the walk's matrix has an answer", () => {
  let cells = 0;
  for (const face of ["formatted", "plain"]) {
    for (const doc of Object.values(W.SHAPES)) {
      for (const at of W.positions(doc, C, new Set(), face)) {
        for (const edit of W.edits(face)) {
          let s = M.st(doc, at.anchor, at.head);
          for (const step of edit.steps) {
            const want = W.step(s, step, face, null);
            assert.ok(want && (want.state || want.vertical || want.paragraph || want.blurred), edit.name);
            if (!want.state || want.blurred) break;
            s = want.state;
            if (face === "formatted") M.drawn(C, s.doc, [{ from: Math.min(s.anchor, s.head), to: Math.max(s.anchor, s.head) }]);
          }
          cells++;
        }
      }
    }
  }
  assert.ok(cells > 50000, "the matrix holds " + cells + " cells");
});
