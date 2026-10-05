// Shared spinner rules, checked without a browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");

test("the spinner's sheet rules carry no pixel number, no colour of their own and no accent", async () => {
  const css = await readFile(path.join(ROOT, "card-tokens.css"), "utf8");
  const from = css.indexOf(".cardspin{");
  assert.notEqual(from, -1, "the .cardspin rule is missing");
  const fadeRule = ".topbar:has(> .cardspin.on) .sunbtn svg{opacity:0}";
  const last = css.indexOf(fadeRule, from);
  assert.notEqual(last, -1, "the sun's fade rule is missing");
  const rules = css.slice(from, last + fadeRule.length);
  assert.doesNotMatch(rules, /\d\s*px/, "a pixel number is written in the spinner's rules");
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/, "the spinner names a colour of its own");
  assert.doesNotMatch(rules, /--accent|purple|violet/i, "the spinner's rules use the accent");
  const used = new Set([...rules.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]));
  const allowed = new Set(["--cardspin-s", "--spin-fade", "--gentle", "--ink", "--mono"]);
  for (const name of used) assert.ok(allowed.has(name), `the spinner's rules use ${name}`);
  assert.match(rules, /\.cardspin\{[^}]*color:var\(--ink\)/, "the spinner is not in the ink colour");
  assert.match(rules, /\.cardspin::before\{[^}]*width:var\(--cardspin-s\); height:var\(--cardspin-s\);\s*font:600 var\(--cardspin-s\)\/var\(--cardspin-s\) var\(--mono\)/);
  assert.match(rules, /transition:opacity var\(--spin-fade\) var\(--gentle\)/);
  assert.match(rules, /\.topbar > \.cardspin\{grid-area:sun; place-self:center\}/, "the spinner does not stand in the sun's cell");
  assert.match(rules, /\.sunbtn svg\{transition:opacity var\(--spin-fade\) var\(--gentle\)\}/);
  assert.doesNotMatch(rules, /transform/, "the spinner's glyph is moved off the sun's mark");
  assert.doesNotMatch(css, /histrun/, "the run the spinner once stood in is still in the sheet");
});

test("the marks and the spinner are named once, in the sheet, and never again on a page", async () => {
  const css = await readFile(path.join(ROOT, "card-tokens.css"), "utf8");
  const count = pattern => (css.match(pattern) || []).length;
  assert.equal(count(/--bar-mark:\s*10px;/g), 1, "the marks are not 10px, written once");
  assert.equal(count(/--cardspin-s:\s*11px;/g), 1, "the spinner is not 11px, written once");
  assert.equal(count(/--cross-weight:\s*calc\(1\.2 \/ 9\);/g), 1, "the cross's proportion is not written once");
  assert.equal(count(/--cross-t:\s*calc\(var\(--bar-mark\) \* var\(--cross-weight\)\);/g), 1, "the cross's thickness is not worked out from the mark and its proportion");
  assert.doesNotMatch(css, /--cardspin-s:\s*var\(/, "the spinner's size is tied to another size");
  for (const name of ["index.html", "m.html"]) {
    const html = await readFile(path.join(ROOT, name), "utf8");
    // the phone page may draw the shared sizes at the rest scale, from the sheet's own number, and no more
    const own = html.replace(/--(bar-mark|cardspin-s):calc\(var\(--full-\1\) \* var\(--rest\)\);/g, "")
      .replace(/--cross-t:calc\(var\(--bar-mark\) \* var\(--cross-weight\)\);/g, "");
    assert.doesNotMatch(own, /--(bar-mark|cardspin-s|cross-t|cross-weight)\s*:/, `${name} sets one of the shared sizes itself`);
    assert.doesNotMatch(html, /\.cardspin\s*[{,:]/, `${name} carries a rule for the spinner of its own`);
    assert.doesNotMatch(html, /histrun/, `${name} still has the run the spinner once stood in`);
    assert.match(html, /:is\(\.arcbtn, \.sunbtn, \.dockbtn\) svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/, `${name}: the sun and the moon are not sized by the mark size`);
    assert.match(html, /width:var\(--bar-mark\); height:var\(--cross-t\);/, `${name}: the cross is not drawn from the mark size and its thickness`);
  }
});

test("both pages build the spinner after the sun and seat it in the sun's cell", async () => {
  const board = await readFile(path.join(ROOT, "index.html"), "utf8");
  assert.match(board, /topbar\.insertBefore\(sun, arc\);\s*const dock = dockChip\("dockbtn", b.id\);\s*topbar\.insertBefore\(dock, arc\);\s*(\/\/[^\n]*\n\s*)*topbar\.insertBefore\(cardSpin, arc\);/, "index.html: the spinner is not built after the sun");
  assert.match(board, /topbar\.appendChild\(histctl\);/, "index.html: the arrows are not an item of the bar");
  const phone = await readFile(path.join(ROOT, "m.html"), "utf8");
  assert.match(phone, /topbar\.append\(histctl, sun, dock, arc, x\);\s*(\/\/[^\n]*\n\s*)*const cardSpin = makeCardSpinner\(\);\s*topbar\.insertBefore\(cardSpin, arc\);/, "m.html: the spinner is not built after the sun");
  assert.match(phone, /grid-template-areas:"hist sun dock moon cross"/, "m.html: the bar has no cell for the sun");
  assert.match(board, /grid-template-areas:\s*"hist sun dock moon cross"/, "index.html: the bar has no cell for the sun");
  for (const [name, html] of [["index.html", board], ["m.html", phone]]) {
    assert.match(html, /setCardSpinner\(el\.cardSpin, cardSpinning\(b\)\)/, `${name}: the spinner is not driven by the shared rule`);
  }
  const page = await readFile(path.join(ROOT, "page.html"), "utf8");
  assert.doesNotMatch(page, /cardspin|cardSpin/, "page.html must not change");
});
