// bakes the crease decals (tools/crease-decal.js) into the sheets that draw
// them: every seed at every size, as png data uris, written between the crease
// decal markers in card-tokens.css (the desktop's 16px fold and the phone's
// 12px) and in page.html (the typed page, which does not load card-tokens.css
// and only ever draws the 16px fold). run it after changing the generator or
// its numbers; tests/ticket-unfold.test.cjs checks the baked pixels are the
// generator's own.
// usage: node tools/bake-crease.cjs [--sizes]
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const D = require("./crease-decal.js");

const ROOT = path.resolve(__dirname, "..");
const START = "/* crease decals: written by tools/bake-crease.cjs from tools/crease-decal.js, not by hand */";
const END = "/* end of the crease decals */";

// ---- png, colour type 6 (rgba), each row filtered the way that packs best ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(kind, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(kind, 4, "ascii"); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const stride = size * 4, raw = Buffer.alloc(size * (stride + 1));
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < size; y++) {
    const row = i => rgba[y * stride + i], up = i => (y ? rgba[(y - 1) * stride + i] : 0);
    const left = i => (i >= 4 ? row(i - 4) : 0), upLeft = i => (i >= 4 && y ? rgba[(y - 1) * stride + i - 4] : 0);
    const kinds = [
      i => row(i), i => row(i) - left(i), i => row(i) - up(i),
      i => row(i) - ((left(i) + up(i)) >> 1), i => row(i) - paeth(left(i), up(i), upLeft(i)),
    ];
    let best = 0, bestCost = Infinity, bestBytes = null;
    kinds.forEach((f, k) => {
      const bytes = Buffer.alloc(stride);
      let cost = 0;
      for (let i = 0; i < stride; i++) { const v = f(i) & 255; bytes[i] = v; cost += v < 128 ? v : 256 - v; }
      if (cost < bestCost) { best = k; bestCost = cost; bestBytes = bytes; }
    });
    raw[y * (stride + 1)] = best;
    bestBytes.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// every decal, keyed by fold and variant: [{ fold, variant, scale, bytes }]
function bake(params) {
  const out = [];
  for (const set of D.SETS) D.SEEDS.forEach((seed, i) => {
    const { size, rgba } = D.render({ ...set, seed, params });
    out.push({ fold: set.fold, variant: i + 1, scale: set.scale, size, bytes: png(size, rgba) });
  });
  return out;
}

// the css block: one image-set per fold and variant, then the desktop's set as
// the one drawn unless a page says otherwise (the phone points these at its 12px)
function block(decals, folds, indent) {
  const lines = [START, ":root{"];
  for (const fold of folds) for (const v of D.SEEDS.map((_, i) => i + 1)) {
    const set = decals.filter(d => d.fold === fold && d.variant === v)
      .map(d => `url("data:image/png;base64,${d.bytes.toString("base64")}") ${d.scale}x`);
    lines.push(`  --crease-${fold}-${v}:image-set(${set.join(", ")});`);
  }
  lines.push("  " + D.SEEDS.map((_, i) => `--crease-${i + 1}:var(--crease-16-${i + 1});`).join(" "));
  lines.push("}", END);
  return lines.map(l => indent + l).join("\n");
}
function write(file, text) {
  const src = fs.readFileSync(file, "utf8");
  const a = src.indexOf(START), b = src.indexOf(END);
  if (a < 0 || b < a) throw new Error(`no crease decal markers in ${file}`);
  const lineStart = src.lastIndexOf("\n", a) + 1;
  const out = src.slice(0, lineStart) + text + src.slice(b + END.length);
  if (out !== src) fs.writeFileSync(file, out);
  return out !== src;
}

if (require.main === module) {
  const decals = bake();
  if (process.argv.includes("--sizes")) {
    for (const d of decals) console.log(`${d.fold}px variant ${d.variant} at ${d.scale}x: ${d.size}px square, ${d.bytes.length} bytes`);
    console.log(`in all ${decals.reduce((s, d) => s + d.bytes.length, 0)} bytes of png`);
  }
  const tokens = write(path.join(ROOT, "card-tokens.css"), block(decals, [16, 12], ""));
  const page = write(path.join(ROOT, "page.html"), block(decals, [16], "  "));
  console.log(`card-tokens.css ${tokens ? "rewritten" : "unchanged"}, page.html ${page ? "rewritten" : "unchanged"}`);
}

module.exports = { png, bake, block, START, END };
