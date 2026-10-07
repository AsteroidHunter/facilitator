const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// The Mac board and the phone draw a code block by one set of rules. On a one
// line block with no language the copy button's centre sits on the line's centre;
// on a longer block it stays at the top right. A block with a language draws the
// label at the top left, in a row of its own, and the button sits in that row with
// its centre on the label's centre. The renderer marks a one line block, and the
// shared sheet does the placing, padding and labelling outside any media query:
// only the shown-always button and its 32px tap area are touch only. The /page
// view does not load the sheet and repeats the rules. No browser: the sheets are
// read as text and the offsets are worked out from their numbers.
const ROOT = path.join(__dirname, "..");
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, "");
const SHEET = strip(readFileSync(path.join(ROOT, "card-tokens.css"), "utf8"));
const PAGE = strip(readFileSync(path.join(ROOT, "page.html"), "utf8"));
const BOARD = strip(readFileSync(path.join(ROOT, "index.html"), "utf8"));
const { render } = require(path.join(ROOT, "card-markdown.js"));

const MEDIA = /@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g;
const TOUCH = [...SHEET.matchAll(/@media\s*\(\s*hover\s*:\s*none\s*\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)].map(m => m[1]).join("\n");
const PLAIN = SHEET.replace(MEDIA, "");
const rule = (css, selector) => {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) => sel.trim() === selector);
  assert.ok(found, `no rule for ${selector}`);
  return Object.fromEntries(found[2].split(";").map(d => d.split(/:(.*)/s)).filter(d => d[1] !== undefined).map(([k, v]) => [k.trim(), v.trim()]));
};
// "calc(14.65 * var(--u))" with a unit of u real pixels
const px = (value, u) => {
  const m = value.match(/^calc\(\s*([\d.]+)\s*\*\s*var\(--u\)\s*\)$/);
  assert.ok(m, `not a calc of units: ${value}`);
  return parseFloat(m[1]) * u;
};

const BLOCK = '.cardmd .codeblockwrap[data-lines="1"] .codeblock';
const BLOCK_RIGHT = '.cardmd .codeblockwrap[data-lines="1"]:not([data-language]) .codeblock';
const BUTTON = '.cardmd .codeblockwrap[data-lines="1"]:not([data-language]) .copybtn';
const LANG_BLOCK = ".cardmd .codeblockwrap[data-language] .codeblock";
const LANG_LABEL = ".cardmd .codelang";
const LANG_BUTTON = ".cardmd .codeblockwrap[data-language] .copybtn";
const LINE = 12.5 * 1.5;        // the code's line height in units, from the sheet's `font` shorthand
const LABEL_LINE = 10.5 * 1.4;  // the label's, likewise
const BUTTON_SIDE = 32;         // the phone's tap area; the Mac's button is smaller and centres the same way

test("the sheet's line heights are the ones these rules count on", () => {
  assert.match(rule(PLAIN, ".cardmd .codeblock").font, /^calc\(12\.5 \* var\(--u\)\)\/1\.5 /);
  assert.match(rule(PLAIN, ".cardmd .codelang").font, /^calc\(10\.5 \* var\(--u\)\)\/1\.4 /);
});

test("only a block of one line is marked", () => {
  assert.match(render("```\nnpm install\n```"), /<div class="codeblockwrap" data-lines="1">/);
  assert.match(render("```js\nconst a = 1;\n```"), /<div class="codeblockwrap" data-language="js" data-lines="1">/);
  assert.match(render("```\n\n```"), /data-lines="1"/, "an empty block is one line");
  assert.doesNotMatch(render("```\nnpm install\nnpm test\n```"), /data-lines/);
  assert.doesNotMatch(render("```js\na\nb\nc\n```"), /data-lines/);
});

test("the placing, padding and label rules are shared, none of them touch only", () => {
  for (const selector of [BLOCK, BLOCK_RIGHT, BUTTON, LANG_BLOCK, LANG_LABEL, LANG_BUTTON])
    assert.ok(rule(PLAIN, selector), selector);
  assert.doesNotMatch(TOUCH, /data-lines|data-language|codelang|\btop\s*:|\bright\s*:|padding-(top|bottom|right)/);
  assert.doesNotMatch(TOUCH, /isolation|z-index/);
});

test("the touch only part is the always shown button and its tap area, nothing else", () => {
  const touch = rule(TOUCH, ".cardmd .codeblockwrap .copybtn");
  assert.deepEqual(Object.keys(touch).sort(), ["height", "justify-content", "opacity", "padding", "pointer-events", "width"]);
  assert.equal(touch.width, "32px");
  assert.equal(touch.height, "32px");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap .copybtn").opacity, "0", "hidden until hover on the Mac");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap:hover .copybtn").opacity, "1");
});

test("on a one line block with no language the button centres on the block, which is the line", () => {
  const button = rule(PLAIN, BUTTON);
  assert.equal(button.top, "50%");
  assert.equal(button.transform, "translateY(-50%)");
  for (const u of [1, 0.985, 0.9])
    assert.equal(px(rule(PLAIN, BLOCK)["padding-top"], u), px(rule(PLAIN, BLOCK)["padding-bottom"], u), "the line is in the block's middle");
});

test("that block leaves the 32px button the same room above and below, at least 4px", () => {
  for (const u of [1, 0.985]) {
    const padTop = px(rule(PLAIN, BLOCK)["padding-top"], u), padBottom = px(rule(PLAIN, BLOCK)["padding-bottom"], u);
    const room = (padTop + LINE * u + padBottom - BUTTON_SIDE) / 2;
    assert.ok(room >= 4, `room ${room.toFixed(2)}`);
  }
});

test("that block's right border, where the code stops scrolling, is clear of the button, so a long line never runs under it", () => {
  const border = rule(PLAIN, BLOCK_RIGHT)["border-right"];
  assert.match(border, /^calc\(46 \* var\(--u\)\) solid #EFF1F4$/, "drawn in the block's own grey");
  assert.equal(rule(PLAIN, ".cardmd .codeblock").background, "#EFF1F4");
  assert.doesNotMatch(JSON.stringify(rule(PLAIN, BLOCK_RIGHT)), /padding-right/, "padding does not clip a scroller's code");
  const edge = px(border.split(" solid")[0], 1);
  const buttonReach = px(rule(PLAIN, ".cardmd .codeblockwrap .copybtn").right, 1) + BUTTON_SIDE;
  assert.ok(edge >= buttonReach + 4, `the code stops ${edge} in from the edge, the button reaches ${buttonReach}`);
});

test("with a language the label is shown, and the button's centre is the label's centre", () => {
  assert.equal(rule(PLAIN, LANG_LABEL)["z-index"], "1", "raised above the code like the button");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap .copybtn")["z-index"], "1");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap").isolation, "isolate");
  assert.equal(rule(PLAIN, LANG_BUTTON).transform, "translateY(-50%)");
  for (const u of [1, 0.985, 0.9]) {
    const labelCentre = px(rule(PLAIN, LANG_LABEL).top, u) + LABEL_LINE * u / 2;
    assert.ok(Math.abs(px(rule(PLAIN, LANG_BUTTON).top, u) - labelCentre) < 0.01, `at ${u}`);
    const padTop = px(rule(PLAIN, LANG_BLOCK)["padding-top"], u);
    assert.ok(padTop - (labelCentre + BUTTON_SIDE / 2) >= 0, "the row ends below the button, above the code");
    assert.ok(labelCentre - BUTTON_SIDE / 2 >= 3, "the button is inside the block");
  }
});

test("a block with more lines keeps the corner", () => {
  const corner = rule(PLAIN, ".cardmd .codeblockwrap .copybtn");
  assert.equal(corner.top, "calc(6 * var(--u))");
  assert.equal(corner.right, "calc(8 * var(--u))");
});

test("the board keeps no code block rules of its own, so it draws the shared sheet's", () => {
  assert.doesNotMatch(BOARD, /\.codeblockwrap|\.copybtn\s*[{,:]|\.reply \.codeblock|\.codelang/);
});

test("the /page view repeats the shared numbers, one pixel a unit", () => {
  assert.equal(rule(PAGE, BLOCK)["padding-top"], "12px");
  assert.equal(rule(PAGE, BLOCK)["padding-bottom"], "12px");
  assert.equal(rule(PAGE, BLOCK_RIGHT)["border-right"], "46px solid #EFF1F4");
  assert.equal(rule(PAGE, LANG_BLOCK)["padding-top"], "40px");
  assert.equal(rule(PAGE, LANG_LABEL).top, "14.65px");
  assert.equal(rule(PAGE, LANG_BUTTON).top, "22px");
  assert.equal(rule(PAGE, BUTTON).top, "50%");
  assert.equal(rule(PAGE, ".cardmd .codeblockwrap .copybtn").top, "6px");
});
