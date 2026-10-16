// Decode the actual embedded image without a browser or image-library dependency.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const vm = require('node:vm');
const page = readFileSync(path.join(__dirname, '..', 'm.html'), 'utf8');

function decodePNG(png, expect) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const data = [];
  let width, height;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      assert.deepEqual([...body.subarray(8)], [8, 6, 0, 0, 0], '8-bit RGBA, no interlace');
    }
    if (type === 'IDAT') data.push(body);
    offset += size + 12;
    if (type === 'IEND') { assert.equal(offset, png.length); break; }
  }
  assert.deepEqual([width, height], expect);
  const raw = inflateSync(Buffer.concat(data)), stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? pixels[at - 4] : 0;
      const up = y ? pixels[at - stride] : 0;
      const corner = y && x >= 4 ? pixels[at - stride - 4] : 0;
      const p = left + up - corner;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      const prediction = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[at] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return pixels;
}

// the squid's own bounds in the logo source: the first pixels that are more than faint noise
function inkBounds(pixels, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

test('the settings squid is an embedded PNG of the new logo cut to its bounds', () => {
  const button = /<button id="setbtn"[^>]*>([\s\S]*?)<\/button>/.exec(page);
  assert.ok(button);
  const images = [...button[1].matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)];
  assert.equal(images.length, 1);
  assert.match(images[0][1], /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.doesNotMatch(button[1], /srcset=|\/m-splash-squid\.png/);
  const pixels = decodePNG(Buffer.from(images[0][1].split(',')[1], 'base64'), [123, 120]);
  // assets/facilitator_logo_blank_v0.3.png cropped to the squid (15,29, 2103 by 2046) and
  // resized with Lanczos to 123x120, lossless: no redraw, recolouring or quantization. The
  // crop is checked here against an area average of the source, which a Lanczos resize
  // follows to within a few levels on average.
  const source = decodePNG(readFileSync(path.join(__dirname, '..', 'assets', 'facilitator_logo_blank_v0.3.png')), [2139, 2096]);
  const ink = inkBounds(source, 2139, 2096);
  assert.deepEqual(ink, { x: 15, y: 29, w: 2103, h: 2046 }, 'the squid\'s bounds in the source moved');
  let total = 0;
  for (let y = 0; y < 120; y++) for (let x = 0; x < 123; x++) {
    const sx0 = ink.x + Math.floor(x * ink.w / 123), sx1 = ink.x + Math.max(Math.floor((x + 1) * ink.w / 123), Math.floor(x * ink.w / 123) + 1);
    const sy0 = ink.y + Math.floor(y * ink.h / 120), sy1 = ink.y + Math.max(Math.floor((y + 1) * ink.h / 120), Math.floor(y * ink.h / 120) + 1);
    const sum = [0, 0, 0, 0]; let n = 0;
    for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
      const o = (yy * 2139 + xx) * 4, a = source[o + 3] / 255;
      sum[0] += source[o] * a; sum[1] += source[o + 1] * a; sum[2] += source[o + 2] * a; sum[3] += source[o + 3]; n++;
    }
    const o = (y * 123 + x) * 4, a = pixels[o + 3] / 255;
    total += Math.abs(pixels[o] * a - sum[0] / n) + Math.abs(pixels[o + 1] * a - sum[1] / n) + Math.abs(pixels[o + 2] * a - sum[2] / n) + Math.abs(pixels[o + 3] - sum[3] / n);
  }
  assert.ok(total / (123 * 120 * 4) < 3, 'the embedded squid is not the new logo: mean difference ' + total / (123 * 120 * 4));
  // and it is the squid cut to its bounds: ink touches all four edges
  const edge = inkBounds(pixels, 123, 120);
  assert.ok(edge.x <= 1 && edge.y <= 1 && edge.x + edge.w >= 122 && edge.y + edge.h >= 119, 'the cut leaves empty margin: ' + JSON.stringify(edge));
});

test('the settings squid keeps its size, accessible button and click action', () => {
  assert.match(page, /<button id="setbtn" class="dockbtn round qn-glass" type="button" title="Settings" aria-label="Settings"><span class="squidmark" aria-hidden="true">/);
  assert.match(page, /#dock \.squidmark\{[^}]*height:calc\(30 \* var\(--u\)\); aspect-ratio:123 \/ 120/);
  assert.match(page, /#dock \.squidmark img\{display:block; width:100%; height:100%\}/);
  let click, opened;
  const settings = {};
  const handler = page.split('\n').find(line => line.startsWith('document.getElementById("setbtn").addEventListener("click"'));
  assert.ok(handler);
  vm.runInNewContext(handler, {
    document: { getElementById(id) { assert.equal(id, 'setbtn'); return {
      addEventListener(type, fn) { assert.equal(type, 'click'); click = fn; }
    }; } }, settings, showMenu(menu) { opened = menu; }
  });
  click();
  assert.equal(opened, settings);
});
