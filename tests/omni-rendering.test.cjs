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
    assert.match(html,
      /const inner = h\("div", "trowin"\);\s*const omni = appendOmniRowArt\(r, inner, b\);\s*const ttl = h\("div", "ttl", b\.title\);\s*const num = ticketNum\(b\.id\);\s*if \(num && !omni\)[\s\S]*?inner\.appendChild\(ttl\);\s*const meta = h\("div", "tmeta"\);/,
      `${name} changed the art/title/meta order or restored Omni's internal id`);
    assert.match(html, /syncOmniCard\(els\[b\.id\], b\)/,
      `${name} does not decorate the initially built expanded card`);
    assert.match(html, /syncOmniCard\(el, b\)/,
      `${name} does not follow an inline title rename`);
  });
}

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
