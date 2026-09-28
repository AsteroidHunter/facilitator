// the crease a ready-to-test ticket keeps once its fold is lowered, drawn as
// pixels. a gradient can only draw the same thing all along a line, and that is
// exactly what a drawn line is; a real crease changes as it goes. so the crease
// is baked into small images from a model of the paper: a height map of the
// pressed corner, lit by the board's own light, turned into ink.
//
// the model, from the owner's two photographs of real creases (see
// the crease measurements kept outside the repository) and the
// research beside them:
// - the corner that was folded never lies quite flat again: it stands off the
//   ticket by a few degrees and curls a little more toward its tip, so it is a
//   plane of its own, a little darker than the ticket under light from above;
// - the hinge is a groove of crushed fibre: dark at its bottom, its strength
//   changing all along it, all but gone in a few short breaks, doubled for a
//   short stretch, wandering a little off the straight, and running at full
//   strength into both edges;
// - on the ticket's side the paper swells a hair before it settles, so the
//   groove's lit wall is followed by a faint soft shade;
// - the edge kinks where the crease meets it: a small dark nick just inside;
// - a faint grain close to the hinge, where the fibres broke.
//
// works in node (module.exports) and in a page (window.CreaseDecal), with no
// dependencies, so the bake (tools/bake-crease.cjs), the tests and the crease
// mock all run this one file. everything is deterministic: the same numbers and
// seed give the same pixels everywhere.
(function (root) {
  "use strict";

  // the tuning, and what each number is
  const DEFAULTS = {
    lift: 4,            // degrees the pressed corner still stands off the ticket
    curl: .003,         // extra rise toward the tip, per px squared
    bumps: .025,        // px of unevenness over the corner, so its tone is not one smooth sweep
    depth: .22,         // the groove's depth, px
    width: .35,         // the groove's half width (its sigma), px
    cavity: .3,         // how much darker crushed fibre is at the groove's bottom
    swell: .07,         // the ticket side's swell, px high: its near side is the lit rim
    swellWidth: 1.1,    // and its half width (sigma), px
    vary: .35,          // how much the groove's strength changes along it
    breaks: 1,          // short stretches where the groove all but goes
    breakFloor: .35,    // what is left of the groove in a break
    doubled: 1,         // short stretches where a second groove runs beside it
    wander: .35,        // px the hinge wanders off the straight
    grain: .006,        // px of fibre grain near the hinge
    elevation: 40,      // the light's height above the ticket, degrees
    azimuth: 255,       // its direction: from above, a little to the left
    strength: 1,        // scales all the ink at the end
    nick: .4,           // the kink in the edge where the crease meets it
  };

  // ---- deterministic noise ------------------------------------------------------
  // a 32 bit hash of two integers and a seed, to a number in [-1, 1]
  function hash(i, j, seed) {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295 * 2 - 1;
  }
  const smooth = f => f * f * (3 - 2 * f);
  // one dimensional value noise, smooth, in [-1, 1]
  function noise1(x, seed) {
    const i = Math.floor(x), f = smooth(x - i);
    const a = hash(i, 0, seed), b = hash(i + 1, 0, seed);
    return a + (b - a) * f;
  }
  // two dimensional value noise, and a few octaves of it
  function noise2(x, y, seed) {
    const i = Math.floor(x), j = Math.floor(y), fx = smooth(x - i), fy = smooth(y - j);
    const a = hash(i, j, seed), b = hash(i + 1, j, seed), c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }
  function fbm(x, y, seed) {
    let s = 0, amp = .5, f = 1;
    for (let o = 0; o < 3; o++) { s += amp * noise2(x * f, y * f, seed + o * 31); amp *= .5; f *= 2; }
    return s / .875;
  }
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // ---- the paper's shape -------------------------------------------------------
  // the stretches along the crease (t, px from its top end) where the groove
  // breaks, or doubles, laid out from the seed: none within 2px of an end
  function events(fold, seed, p) {
    const len = fold * Math.SQRT2, out = { breaks: [], doubles: [] };
    const taken = [];
    const free = (a, b) => taken.every(([c, d]) => b < c - .6 || a > d + .6);
    let k = 0;
    for (let n = 0; n < p.breaks && k < 200; k++) {
      const half = .4 + .35 * (hash(k, 1, seed) + 1) / 2;
      const at = 2 + half + (len - 4 - 2 * half) * (hash(k, 2, seed) + 1) / 2;
      if (!free(at - half, at + half)) continue;
      taken.push([at - half, at + half]); out.breaks.push([at, half]); n++;
    }
    for (let n = 0; n < p.doubled && k < 400; k++) {
      const half = 1.5 + .5 * (hash(k, 3, seed) + 1) / 2;
      const at = 3 + half + (len - 6 - 2 * half) * (hash(k, 4, seed) + 1) / 2;
      if (!free(at - half, at + half)) continue;
      taken.push([at - half, at + half]); out.doubles.push([at, half]); n++;
    }
    return out;
  }
  // a window that is 1 inside [at - half, at + half] and eases to 0 over .3px
  function inside(t, [at, half]) {
    const d = Math.abs(t - at) - half;
    return d <= 0 ? 1 : d >= .3 ? 0 : 1 - smooth(d / .3);
  }

  // the height of the paper, px, at a point of the decal's box. the box is the
  // fold's square and 6px more to the left and below, anchored on the ticket's
  // top right; the crease runs from (6, 0) to (6 + fold, fold). s is the
  // distance from the crease, positive on the corner's side; t is along it
  function heightAt(x, y, fold, seed, p, ev) {
    const s0 = ((x - 6) - y) / Math.SQRT2, t = ((x - 6) + y) / Math.SQRT2;
    const s = s0 - p.wander * noise1(t / 8 + 5, seed + 11);
    // the groove's strength along the crease: a slow swing, a little flutter,
    // a break or two, and no taper toward the edges
    let d = clamp(.75 + p.vary * noise1(t / 5, seed + 3) + .08 * noise1(t / 1.3 + 17, seed + 5), .35, 1.3);
    for (const b of ev.breaks) d += (p.breakFloor - d) * inside(t, b);
    const depth = p.depth * d;
    const w = .5, lift = Math.tan(p.lift * Math.PI / 180);
    let h = lift * w * Math.log1p(Math.exp(s / w)) + p.curl * Math.max(0, s) ** 2;
    // the corner is not one smooth sweep: a little unevenness over it, none on the ticket
    if (s > 0) h += p.bumps * Math.min(1, s / 1.5) * fbm(x / 3, y / 3, seed + 29);
    const groove = -depth * Math.exp(-((s - .15) ** 2) / (2 * p.width * p.width));
    h += groove;
    for (const dbl of ev.doubles)
      h += -.35 * depth * inside(t, dbl) * Math.exp(-((s + .9) ** 2) / (2 * p.width * p.width));
    h += p.swell * Math.exp(-((s + 1) ** 2) / (2 * p.swellWidth * p.swellWidth));
    // grain where the fibres broke: full near the hinge, gone 4px out on the
    // ticket's side, half over the corner
    const near = s >= 0 ? (s < 1.5 ? 1 : Math.max(.5, 1 - (s - 1.5) / 3)) : (s > -1.5 ? 1 : Math.max(0, 1 - (-s - 1.5) / 2.5));
    h += p.grain * near * fbm(x * 1.1, y * 1.1, seed + 23);
    return { h, cavity: Math.max(0, -groove) / (p.depth || 1) };
  }

  // ---- lit, softened, down to pixels -------------------------------------------
  // one decal: fold (css px), scale (device px per css px), edge (the drawn
  // edge width, css px), seed, and any tuning. answers { size, rgba } with
  // straight (not premultiplied) alpha, size by size device pixels
  function render(opts) {
    const p = Object.assign({}, DEFAULTS, opts.params || {});
    const fold = opts.fold, scale = opts.scale, edge = opts.edge, seed = opts.seed | 0;
    const box = fold + 6, size = Math.round(box * scale), SS = 4, R = scale * SS, n = size * SS;
    const ev = events(fold, seed, p);
    const az = p.azimuth * Math.PI / 180, el = p.elevation * Math.PI / 180;
    const L = [Math.cos(az) * Math.cos(el), Math.sin(az) * Math.cos(el), Math.sin(el)];
    // heights on the fine grid, one sample of margin for the slopes
    const m = n + 2, H = new Float64Array(m * m), C = new Float64Array(m * m);
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const q = heightAt((i - .5) / R, (j - .5) / R, fold, seed, p, ev);
      H[j * m + i] = q.h; C[j * m + i] = q.cavity;
    }
    // how bright the paper is at each sample, flat paper being 1
    const tone = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j + 1) * m + i + 1;
      const hx = (H[o + 1] - H[o - 1]) * R / 2, hy = (H[o + m] - H[o - m]) * R / 2;
      const len = Math.hypot(hx, hy, 1);
      const lit = Math.max(0, (-hx * L[0] - hy * L[1] + L[2]) / len) / L[2];
      tone[j * n + i] = lit * (1 - p.cavity * Math.min(1, C[o]));
    }
    // the paper softens what light makes of it: a .25px blur, then each device
    // pixel is the average of its samples
    const soft = blur(tone, n, .25 * R);
    const rgba = new Uint8ClampedArray(size * size * 4);
    // the nicks: where the crease crosses the inside of the top edge and of the
    // right edge, a small dark kink 1px along the edge and half a px into the paper
    const nicks = [[6 + edge, edge + .25, .5, .25], [box - edge - .25, fold - edge, .25, .5]];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0;
      for (let b = 0; b < SS; b++) for (let a = 0; a < SS; a++) v += soft[(y * SS + b) * n + x * SS + a];
      v /= SS * SS;
      const cx = (x + .5) / scale, cy = (y + .5) / scale;
      for (const [nx, ny, rx, ry] of nicks) {
        const r2 = ((cx - nx) / rx) ** 2 + ((cy - ny) / ry) ** 2;
        if (r2 < 1) v *= 1 - p.nick * (1 - r2);
      }
      const o = (y * size + x) * 4, drop = (1 - v) * p.strength;
      if (drop > 0) {
        // shade and crushed fibre: a warm dark ink, as much of it as makes the
        // ticket's white that much darker
        const a = Math.min(.55, drop * 255 / (255 - INK_LIGHT));
        rgba[o] = INK[0]; rgba[o + 1] = INK[1]; rgba[o + 2] = INK[2]; rgba[o + 3] = Math.round(a * 255);
      } else if (drop < 0) {
        // a lit ridge: the most a near-white ticket can show is a warm cream
        const a = Math.min(.6, -drop * 1.2);
        rgba[o] = LIT[0]; rgba[o + 1] = LIT[1]; rgba[o + 2] = LIT[2]; rgba[o + 3] = Math.round(a * 255);
      }
    }
    return { size, rgba };
  }
  // the ink: the fold's crease colour family, darker (the photographs' grooves
  // are the paper's own buff, deepened), and the lit cream
  const INK = [96, 80, 56], LIT = [255, 252, 242];
  const INK_LIGHT = .2126 * INK[0] + .7152 * INK[1] + .0722 * INK[2];

  function blur(src, n, sigma) {
    if (sigma < .3) return src;
    const r = Math.ceil(sigma * 3), k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) { const w = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(w); sum += w; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const a = new Float64Array(n * n), b = new Float64Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[y * n + clamp(x + i, 0, n - 1)];
      a[y * n + x] = s;
    }
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * a[clamp(y + i, 0, n - 1) * n + x];
      b[y * n + x] = s;
    }
    return b;
  }

  // the decals the board carries: three seeds, so no two creased tickets in a
  // row wear the same mark, each for the desktop's 16px fold (1x and 2x
  // screens) and the phone's 12px fold (2x and 3x). the drawn edge is what
  // chrome draws a 0.8px border at on that screen
  const SEEDS = [7, 19, 42];
  const SETS = [
    { fold: 16, scale: 1, edge: 1 }, { fold: 16, scale: 2, edge: .5 },
    { fold: 12, scale: 2, edge: .5 }, { fold: 12, scale: 3, edge: 2 / 3 },
  ];

  const api = { DEFAULTS, SEEDS, SETS, INK, LIT, render, heightAt, events, noise1 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CreaseDecal = api;
})(typeof window !== "undefined" ? window : this);
