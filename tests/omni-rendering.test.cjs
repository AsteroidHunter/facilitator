// Cross-surface wiring checks for the three shipped HTML renderers. Browser
// geometry is covered separately when an owned background Chrome window exists;
// these checks keep every surface on the same left-art/title/right-meta order.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync, statSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const source = name => readFileSync(path.join(ROOT, name), "utf8");

for (const name of ["index.html", "m.html", "page.html"]){
  test(`${name} renders Omni art before the normal title and right metadata`, () => {
    const html = source(name);
    assert.match(html, /\.trow\.omni-ticket\{background:#fff\}/);
    assert.match(html, /\.omni-art\{[^}]*object-fit:contain/s);
    assert.match(html, /\.box\.omni-card\{background:#fff !important\}/);
    assert.ok(
      /const inner = h\("div", "trowin"\);\s*const omni = appendOmniRowArt\(r, inner, b\);\s*const ttl = h\("div", "ttl", b\.title\);\s*inner\.appendChild\(ttl\);\s*const meta = h\("div", "tmeta"\);/.test(html),
      `${name} changed the art/title/meta order or restored a ticket number prefix`);
    assert.match(html, /syncOmniCard\(els\[b\.id\], b\)/,
      `${name} does not decorate the initially built expanded card`);
    assert.match(html, /syncOmniCard\(el, b\)/,
      `${name} does not follow an inline title rename`);
  });
}

// the card's own title and the art beside it, on the two pages that load the
// shared card logic: [page, the title's font size, the open card's selector
// prefix and its title size where the page has a separate open-card rule]
for (const [name, size, open] of [["index.html", "17.5px", ["body.focus .box.sel", "30px"]], ["m.html", "24px", null]]){
  test(`${name} names the card Omni Card, sizes its art to the title and sweeps it`, () => {
    const html = source(name);
    assert.match(html, /const titleEl = h\("span", "title", omniCardTitle\(b\.title\)\)/,
      `${name} builds the card title from its stored title`);
    assert.match(html, /!el\.titleEl\.isContentEditable && !el\.omniSweep/,
      `${name} lets a poll write the title over a running sweep`);
    assert.match(html, /omniCardTitle\(b\.title\)[\s\S]{0,400}syncOmniCard\(el, b\)/);
    // the art is one em of the title's own font size, at its natural width
    assert.match(html, new RegExp(`\\.title\\{[^}]*font:625 ${size.replace(".", "\\.")}/1\\.25`));
    const art = /\.omni-card-art\{([^}]*)\}/.exec(html)[1];
    assert.match(art, new RegExp(`font-size:${size.replace(".", "\\.")}`));
    assert.match(art, /width:auto; height:1em/);
    assert.doesNotMatch(art, /height:(44|66)px/);
    if (open){
      const [prefix, px] = open;
      assert.ok(html.includes(`${prefix} .title{`) && new RegExp(`${prefix.replace(/\./g, "\\.")} \\.title\\{[^}]*font:625 ${px}/1\\.25`).test(html));
      assert.match(html, new RegExp(`${prefix.replace(/\./g, "\\.")}\\.omni-card \\.omni-card-art\\{order:10; font-size:${px};`));
    }
    // the sweep's band lies on the card's diagonal and follows the script's --omni-at
    assert.match(html, /\.omni-sweep\{position:absolute; inset:0;[^}]*linear-gradient\(to top right,[^}]*var\(--omni-at\)/);
  });
}

test("a working Omni row shines gold while ordinary rows keep the white shimmer", () => {
  const html = source("index.html");
  assert.match(html, /\.trow\.working::after\{[^}]*rgba\(255,255,255,\.55\) 50%/);
  assert.match(html, /\.trow\.omni-ticket\.working::after\{\s*background:linear-gradient\(90deg, transparent 0%, rgba\(224,176,64,\.45\) 50%, transparent 100%\)\}/);
});

test("the three optimized supplied artworks are distinct WebP assets", () => {
  const bytes = [];
  for (let number = 1; number <= 3; number++){
    const file = path.join(ROOT, "assets", `ticket-${number}.webp`);
    const data = readFileSync(file);
    assert.equal(data.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(data.subarray(8, 12).toString("ascii"), "WEBP");
    assert.ok(statSync(file).size > 1000, `${file} is unexpectedly empty`);
    bytes.push(data.toString("base64"));
  }
  assert.equal(new Set(bytes).size, 3);
});
