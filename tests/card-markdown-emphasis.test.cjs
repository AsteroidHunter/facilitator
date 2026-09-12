// The card renderer's emphasis, read straight off the module. No browser, no
// board, no network: this is the pure function the card views call, and these
// are the exact strings it returns.
//
// The report pinned here: "***alpha*** tail" came out as "<p><b>*alpha</b>*
// tail</p>". The closing run of three markers was being cut after two, so the
// third was left standing in the middle of the reader's words and the italic
// never happened. The composer had drawn it bold and italic while it was being
// typed, so the card disagreed with the row it was sent from.
//
// Everything else here is a shape that was already right, pinned so the cut in
// the right place stays narrow. Two of them are pinned as they are and not as
// they ought to be: an unbalanced run and an intraword underscore are the
// renderer's own long-standing laxness, and neither is being changed.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { render } = require("../card-markdown.js");

// what was reported, and its counterpart
test("bold and italic together are bold and italic", () => {
  assert.equal(render("***alpha*** tail"), "<p><em><b>alpha</b></em> tail</p>");
  assert.equal(render("___alpha___ tail"), "<p><em><b>alpha</b></em> tail</p>");
  assert.equal(render("tail ***alpha***"), "<p>tail <em><b>alpha</b></em></p>");
  assert.equal(render("a ***b*** c ***d*** e"),
    "<p>a <em><b>b</b></em> c <em><b>d</b></em> e</p>");
});

test("the nesting that already worked works the same way", () => {
  assert.equal(render("*alpha* tail"), "<p><em>alpha</em> tail</p>");
  assert.equal(render("_alpha_ tail"), "<p><em>alpha</em> tail</p>");
  assert.equal(render("**alpha** tail"), "<p><b>alpha</b> tail</p>");
  assert.equal(render("__alpha__ tail"), "<p><b>alpha</b> tail</p>");
  assert.equal(render("**_alpha_** tail"), "<p><b><em>alpha</em></b> tail</p>");
  assert.equal(render("*__alpha__* tail"), "<p><em><b>alpha</b></em> tail</p>");
  assert.equal(render("**alpha *beta* gamma**"), "<p><b>alpha <em>beta</em> gamma</b></p>");
  assert.equal(render("~~alpha~~ tail"), "<p><del>alpha</del> tail</p>");
  assert.equal(render("~alpha~ tail"), "<p>~alpha~ tail</p>");
  assert.equal(render("snake_case_word"), "<p>snake_case_word</p>");
});

test("markers that are content stay content", () => {
  assert.equal(render("\\*alpha\\*"), "<p>*alpha*</p>");
  assert.equal(render("\\*\\*\\*alpha\\*\\*\\*"), "<p>***alpha***</p>");
  assert.equal(render("`***alpha***`"), '<p><code class="inlinecode">***alpha***</code></p>');
  assert.equal(render("***"), "<hr>");
  assert.equal(render("* * *"), "<hr>");
  assert.equal(render("*alpha"), "<p>*alpha</p>");
  assert.equal(render("**alpha"), "<p>**alpha</p>");
});

test("a triple inside a block is the same triple", () => {
  assert.equal(render("> ***alpha***"), "<blockquote><p><em><b>alpha</b></em></p></blockquote>");
  assert.equal(render("- ***alpha***"), "<ul><li><em><b>alpha</b></em></li></ul>");
  assert.equal(render("# ***alpha***"), "<h1><em><b>alpha</b></em></h1>");
});

// Pinned as they are and not as they ought to be. An unbalanced run has always
// left a marker standing where a stricter reader would have left none, and this
// renderer has always read an underscore in the middle of a word as a marker.
// The first three lines are untouched by the fix above. The fourth is the one
// place the fix is visible in this laxness rather than beside it: the triple
// form now does what the pair form has always done in the middle of a word.
test("the renderer's own long-standing laxness is pinned", () => {
  assert.equal(render("***alpha** tail*"), "<p><b>*alpha</b> tail*</p>");
  assert.equal(render("***alpha"), "<p><em>*</em>alpha</p>");
  assert.equal(render("a__b__c"), "<p>a<b>b</b>c</p>");
  assert.equal(render("a___b___c"), "<p>a<em><b>b</b></em>c</p>");
});
