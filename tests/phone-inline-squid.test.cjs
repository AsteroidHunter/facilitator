// Decode the actual embedded image without a browser or image-library dependency.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { inflateSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const page = readFileSync(path.join(__dirname, '..', 'm.html'), 'utf8');

function decodePNG(png) {
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
  assert.deepEqual([width, height], [98, 120]);
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

test('the settings squid is an embedded PNG of the original cropped artwork', () => {
  const button = /<button id="setbtn"[^>]*>([\s\S]*?)<\/button>/.exec(page);
  assert.ok(button);
  const images = [...button[1].matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)];
  assert.equal(images.length, 1);
  assert.match(images[0][1], /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.doesNotMatch(button[1], /srcset=|\/m-splash-squid\.png/);
  const pixels = decodePNG(Buffer.from(images[0][1].split(',')[1], 'base64'));
  // RGBA hash of assets/m-splash-squid.png cropped at (165,69), 917x1126,
  // resized with Pillow Lanczos to 98x120. No redraw, recolouring or quantization.
  assert.equal(createHash('sha256').update(pixels).digest('hex'),
    'c7324cd7e5d566068a547823504ff458794d9a6cf0f988cb4915b985ee0d8a94');
});

test('the settings squid keeps its size, accessible button and click action', () => {
  assert.match(page, /<button id="setbtn" class="dockbtn round qn-glass" type="button" title="Settings" aria-label="Settings"><span class="squidmark" aria-hidden="true">/);
  assert.match(page, /#dock \.squidmark\{[^}]*height:calc\(30 \* var\(--u\)\); aspect-ratio:917 \/ 1126/);
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
