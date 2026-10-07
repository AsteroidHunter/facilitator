const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// On a phone the copy button is always shown, 32 real pixels square. On a one
// line block its centre sits on the line's centre; on a longer block it stays
// at the top right. The renderer marks a one line block, and the touch only part
// of the shared sheet does the centring. No browser: the sheet is read as text
// and the offsets are worked out from its numbers.
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
// "calc(21.375 * var(--u) - 16px)" with --u at a real pixel, or at some other size
const px = (value, u) => {
  const m = value.match(/^calc\(\s*([\d.]+)\s*\*\s*var\(--u\)\s*(?:([+-])\s*([\d.]+)px)?\s*\)$/);
  assert.ok(m, `not a calc of units and pixels: ${value}`);
  return parseFloat(m[1]) * u + (m[2] ? (m[2] === "-" ? -1 : 1) * parseFloat(m[3]) : 0);
};

const BLOCK = '.cardmd .codeblockwrap[data-lines="1"] .codeblock';
const BLOCK_LANG = '.cardmd .codeblockwrap[data-lines="1"][data-language] .codeblock';
const BUTTON = '.cardmd .codeblockwrap[data-lines="1"] .copybtn';
const BUTTON_LANG = '.cardmd .codeblockwrap[data-lines="1"][data-language] .copybtn';
const LINE = 12.5 * 1.5;   // the code's line height in units, from the sheet's `font` shorthand
const BUTTON_SIDE = 32;

test("the sheet's code line is the height this rule counts on", () => {
  assert.match(rule(PLAIN, ".cardmd .codeblock").font, /^calc\(12\.5 \* var\(--u\)\)\/1\.5 /);
});

test("only a block of one line is marked", () => {
  assert.match(render("```\nnpm install\n```"), /<div class="codeblockwrap" data-lines="1">/);
  assert.match(render("```js\nconst a = 1;\n```"), /<div class="codeblockwrap" data-language="js" data-lines="1">/);
  assert.match(render("```\n\n```"), /data-lines="1"/, "an empty block is one line");
  assert.doesNotMatch(render("```\nnpm install\nnpm test\n```"), /data-lines/);
  assert.doesNotMatch(render("```js\na\nb\nc\n```"), /data-lines/);
});

test("the button's centre is the line's centre, at any size of unit", () => {
  for (const u of [1, 0.985, 0.9]) {
    for (const [block, button, lang] of [[BLOCK, BUTTON, false], [BLOCK_LANG, BUTTON_LANG, true]]) {
      const padTop = lang ? px(rule(TOUCH, BLOCK_LANG)["padding-top"], u) : px(rule(TOUCH, block)["padding-top"], u);
      const top = px(rule(TOUCH, button).top, u);
      assert.ok(Math.abs(top + BUTTON_SIDE / 2 - (padTop + LINE * u / 2)) < 0.01, `${lang ? "language " : ""}one line block at ${u}`);
    }
  }
});

test("a one line block leaves the button room above and below, and the same room", () => {
  for (const u of [1, 0.985]) {
    for (const [block, button, lang] of [[BLOCK, BUTTON, false], [BLOCK_LANG, BUTTON_LANG, true]]) {
      const padTop = px(rule(TOUCH, lang ? BLOCK_LANG : block)["padding-top"], u);
      const padBottom = px(rule(TOUCH, BLOCK)["padding-bottom"], u);
      const height = padTop + LINE * u + padBottom, top = px(rule(TOUCH, button).top, u);
      const above = top, below = height - top - BUTTON_SIDE;
      assert.ok(above >= 4 && below >= 4, `room ${above.toFixed(2)} above, ${below.toFixed(2)} below`);
      if (!lang) assert.ok(Math.abs(above - below) < 0.01, "the same room above and below");
    }
  }
});

test("the centring is on a touch screen only, and a longer block keeps the corner", () => {
  assert.doesNotMatch(PLAIN, /data-lines/);
  const corner = rule(TOUCH, ".cardmd .codeblockwrap .copybtn");
  assert.match(corner.top, /^calc\(4 \* var\(--u\)\)$/);
  assert.match(corner.right, /^calc\(4 \* var\(--u\)\)$/);
  assert.equal(rule(PLAIN, ".cardmd .codeblockwrap .copybtn").top, "calc(6 * var(--u))");
});
