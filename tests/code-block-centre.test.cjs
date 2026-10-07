const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// On a phone the copy button is always shown, 32 real pixels square. On a one
// line block with no language its centre sits on the line's centre; on a longer
// block it stays at the top right. A block with a language draws the Mac's label
// at the top left, in a row of its own, and the button sits in that row with its
// centre on the label's centre. The renderer marks a one line block, and the
// touch only part of the shared sheet does the placing. No browser: the sheet is
// read as text and the offsets are worked out from its numbers.
const ROOT = path.join(__dirname, "..");
const SHEET = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const { render } = require(path.join(ROOT, "card-markdown.js"));

const TOUCH = [...SHEET.matchAll(/@media\s*\(\s*hover\s*:\s*none\s*\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)].map(m => m[1]).join("\n");
const PLAIN = SHEET.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
const rule = (css, selector) => {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, sel]) => sel.trim() === selector);
  assert.ok(found, `no rule for ${selector}`);
  return Object.fromEntries(found[2].split(";").map(d => d.split(/:(.*)/s)).filter(d => d[1] !== undefined).map(([k, v]) => [k.trim(), v.trim()]));
};
// "calc(21.375 * var(--u) - 16px)" with a unit of u real pixels
const px = (value, u) => {
  const m = value.match(/^calc\(\s*([\d.]+)\s*\*\s*var\(--u\)\s*(?:([+-])\s*([\d.]+)px)?\s*\)$/);
  assert.ok(m, `not a calc of units and pixels: ${value}`);
  return parseFloat(m[1]) * u + (m[2] ? (m[2] === "-" ? -1 : 1) * parseFloat(m[3]) : 0);
};

const BLOCK = '.cardmd .codeblockwrap[data-lines="1"] .codeblock';
const BUTTON = '.cardmd .codeblockwrap[data-lines="1"]:not([data-language]) .copybtn';
const LANG_BLOCK = ".cardmd .codeblockwrap[data-language] .codeblock";
const LANG_LABEL = ".cardmd .codeblockwrap[data-language] .codelang";
const LANG_BUTTON = ".cardmd .codeblockwrap[data-language] .copybtn";
const LINE = 12.5 * 1.5;        // the code's line height in units, from the sheet's `font` shorthand
const LABEL_LINE = 10.5 * 1.4;  // the label's, likewise
const BUTTON_SIDE = 32;

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

test("on a one line block with no language the button's centre is the line's centre", () => {
  for (const u of [1, 0.985, 0.9]) {
    const padTop = px(rule(TOUCH, BLOCK)["padding-top"], u), top = px(rule(TOUCH, BUTTON).top, u);
    assert.ok(Math.abs(top + BUTTON_SIDE / 2 - (padTop + LINE * u / 2)) < 0.01, `at ${u}`);
  }
});

test("that block leaves the button the same room above and below, at least 4px", () => {
  for (const u of [1, 0.985]) {
    const padTop = px(rule(TOUCH, BLOCK)["padding-top"], u), padBottom = px(rule(TOUCH, BLOCK)["padding-bottom"], u);
    const height = padTop + LINE * u + padBottom, above = px(rule(TOUCH, BUTTON).top, u), below = height - above - BUTTON_SIDE;
    assert.ok(above >= 4 && below >= 4, `room ${above.toFixed(2)} above, ${below.toFixed(2)} below`);
    assert.ok(Math.abs(above - below) < 0.01, "the same room above and below");
  }
});

test("with a language the label is shown, and the button's centre is the label's centre inside the block", () => {
  assert.equal(rule(TOUCH, LANG_LABEL)["z-index"], "1", "raised above the code like the button");
  for (const u of [1, 0.985, 0.9]) {
    const labelCentre = px(rule(TOUCH, LANG_LABEL).top, u) + LABEL_LINE * u / 2;
    const top = px(rule(TOUCH, LANG_BUTTON).top, u);
    assert.ok(Math.abs(top + BUTTON_SIDE / 2 - labelCentre) < 0.01, `at ${u}`);
    assert.ok(top >= 3, `the button is ${top.toFixed(2)}px from the top, inside the block`);
    const padTop = px(rule(TOUCH, LANG_BLOCK)["padding-top"], u);
    assert.ok(padTop - (top + BUTTON_SIDE) >= 0, "the row ends below the button, above the code");
  }
});

test("the label's place and the Mac's are the same until it is a touch screen", () => {
  assert.doesNotMatch(PLAIN, /data-lines/);
  assert.equal(rule(PLAIN, ".cardmd .codelang").top, "calc(7 * var(--u))");
  assert.equal(rule(PLAIN, ".cardmd .codelang").left, "calc(12 * var(--u))");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap[data-language] .codeblock")["padding-top"], "calc(29 * var(--u))");
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap .copybtn").top, "calc(6 * var(--u))");
});

test("a block with no language and more lines keeps the corner", () => {
  const corner = rule(TOUCH, ".cardmd .codeblockwrap .copybtn");
  assert.match(corner.top, /^calc\(4 \* var\(--u\)\)$/);
  assert.match(corner.right, /^calc\(4 \* var\(--u\)\)$/);
});
