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
    // the light: a container with no z-index of its own, so its two layers blend
    // with the card, the warmth multiplied and the glare screened, each on the
    // card's diagonal with a sun riding it, all moved by the script's --omni-p
    const sweep = /\.omni-sweep\{([^}]*)\}/.exec(html)[1];
    assert.match(sweep, /position:absolute; inset:0; pointer-events:none; --omni-p:-1/);
    assert.doesNotMatch(sweep, /z-index|isolation|opacity|transform|filter/);
    const layer = which => (new RegExp(`^\\s*\\.omni-sweep::${which}\\{([^}]*)\\}`, "m").exec(html) || [])[1] || "";
    assert.match(layer("before"), /mix-blend-mode:multiply;[\s\S]*radial-gradient\(circle at var\(--omni-x\) var\(--omni-y\)[\s\S]*linear-gradient\(var\(--omni-dir\)/);
    assert.match(layer("after"), /mix-blend-mode:screen;[\s\S]*radial-gradient\(circle at var\(--omni-x\) var\(--omni-y\)[\s\S]*linear-gradient\(var\(--omni-dir\)/);
    // a card lays the light corner to corner; a row at 45 degrees with a smaller sun
    assert.match(sweep, /--omni-dir:to top right; --omni-sun:160px; --omni-core:50px;/);
    assert.match(html, /\.trow > \.omni-sweep\{--omni-dir:45deg; --omni-sun:56px; --omni-core:18px\}/);
    // less yellow: every colour in the light, the working shine and the glint's
    // edge is white with at most a trace of warmth, red over blue by no more than 25
    const block = html.slice(html.indexOf(".omni-sweep{"), html.indexOf("@keyframes omni-glint"));
    const rows = /\.trow\.omni-ticket\.working::before\{[\s\S]*?\.trow\.omni-ticket\.working::after\{[^}]*\}/.exec(html);
    for (const [, r, g, b] of [...(block + (rows ? rows[0] : "")).matchAll(/rgba\((\d+),(\d+),(\d+),/g)]){
      assert.ok(Number(r) - Number(b) <= 25 && Math.abs(Number(r) - Number(g)) <= 15, `rgb(${r},${g},${b}) is too warm`);
    }
    // no yellow or gold left: the warmth is warm white, the glare near white
    assert.doesNotMatch(html, /rgba\(224,176,64|rgba\(255,214,110/);
    // brighter: the glare's core and its sun are full white, and the warmth
    // stands at .58 across the diagonal and .7 at the sun
    assert.match(layer("after"), /rgba\(255,255,253,1\) 0,[\s\S]*rgba\(255,255,253,1\) var\(--omni-c\),/);
    assert.match(layer("before"), /rgba\(255,242,232,\.88\) 0,[\s\S]*rgba\(255,242,232,\.78\) var\(--omni-c\),/);
    // the old star and its halo are gone
    assert.doesNotMatch(html, /omni-star/);
    // the glint: fixed on the screen so the card's clip cannot cut it, a tiny
    // white core, a long thin cross of rays longer than its thin diagonals, and
    // a 300 ms pop, hold and shrink with a small turn
    const glint = /\.omni-glint\{([^}]*)\}/.exec(html)[1];
    assert.match(glint, /position:fixed; width:8px; height:8px; margin:-4px 0 0 -4px;/);
    assert.match(glint, /radial-gradient\(circle, #fff 0, #fff 34%/);
    assert.match(glint, /animation:omni-glint 300ms both/);
    const dims = which => /width:(\d+)px; height:(\d+)px/
      .exec(new RegExp(`^\\s*\\.omni-glint${which}\\{([^}]*)\\}`, "m").exec(html)[1]).slice(1).map(Number);
    const [across, thick] = dims("::before"), [thin, tall] = dims("::after"), [diagonal, fine] = dims(" i");
    assert.ok(across === tall && thick === thin && across >= 60 && thick <= 3, "the long cross");
    assert.ok(diagonal < across && fine < thick, "the diagonals are shorter and thinner");
    assert.match(html, /\.omni-glint i:first-child\{transform:rotate\(45deg\)\}\s*\.omni-glint i:last-child\{transform:rotate\(-45deg\)\}/);
    const keys = /@keyframes omni-glint\{([\s\S]*?)\}\}/.exec(html)[1];
    assert.match(keys, /^\s*0%\{transform:scale\(0\) rotate\(-?\d+deg\)/);
    assert.match(keys, /30%\{transform:scale\(1\) rotate\(0deg\)/);   // open by 90 of the 300 ms
    assert.match(keys, /55%\{transform:scale\(1\)/);                  // held
    assert.match(keys, /100%\{transform:scale\(0\)/);                 // and gone
  });
}

test("a working Omni row wears the same sunlight while ordinary rows keep the white shimmer", () => {
  const html = source("index.html");
  assert.match(html, /\.trow\.working::after\{[^}]*rgba\(255,255,255,\.55\) 50%/);
  const warmth = /\.trow\.omni-ticket\.working::before\{([^}]*)\}/.exec(html)[1];
  const glare = /\.trow\.omni-ticket\.working::after\{([^}]*)\}/.exec(html)[1];
  // matched to the card's light: the near neutral warmth at .85, glare full white at the centre
  assert.match(warmth, /mix-blend-mode:multiply;[\s\S]*rgba\(255,242,232,\.85\) 50%[\s\S]*animation:ticket-working-shimmer 1\.6s linear infinite/);
  assert.match(glare, /mix-blend-mode:screen;[\s\S]*rgba\(255,255,253,1\) 50%/);
  // bells, not bands: each layer peaks at exactly one stop
  for (const [layer, peak] of [[warmth, ".85"], [glare, "1"]]){
    const alphas = [...layer.matchAll(/rgba\(\d+,\d+,\d+,([.\d]+)\) [\d.]+%/g)].map(m => m[1]);
    assert.equal(alphas.filter(a => a === peak).length, 1);
    assert.ok(alphas.every(a => Number(a) <= Number(peak)));
  }
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
