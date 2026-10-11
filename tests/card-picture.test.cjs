// A card's picture opened full screen: the shipped page guard and picture code
// run against a small document model. Opening, fitting, closing, Escape, the
// copy kept to the part of the picture the card shows, pinching, moving and
// double tapping, the wheel, the menu's other ways in and the long press. No
// browser, no server.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Node, dispatch } = require('./page-event-model.cjs');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('card-logic.js');
// the settings' place on the desktop, read out of the sheet: the window's inset
// from every edge (card-tokens.css)
const INSET = Number(/:root\{--sp-inset:([\d.]+)%\}/.exec(read('card-tokens.css'))[1]) / 100;
// the room as the sheet lays it out (#picfull .picfull-room): on the desktop
// INSET in from every edge; on the phone the whole screen inside its safe areas,
// which the model's screen has none of
function room(width, height, phone) {
  if (phone) return { left: 0, top: 0, width, height };
  const w = width * (1 - 2 * INSET);
  return { left: (width - w) / 2, top: height * INSET, width: w, height: height * (1 - 2 * INSET) };
}

// one compound selector: tag, classes, [attr] and [attr^="value"]
function compound(node, sel) {
  const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/.exec(sel);
  if (!m || !node.classList) return false;
  if (m[1] && node.tag !== m[1]) return false;
  for (const c of m[2].match(/\.[\w-]+/g) || []) if (!node.classList.contains(c.slice(1))) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
    const [, name, start] = /^\[([\w-]+)(?:\^="([^"]*)")?\]$/.exec(a);
    const value = node.getAttribute(name);
    if (value == null || (start != null && !value.startsWith(start))) return false;
  }
  return true;
}
function matches(node, selector) {
  return selector.split(',').some(one => {
    const parts = one.trim().split(/\s+/);
    if (!compound(node, parts.at(-1))) return false;
    let i = parts.length - 2;
    for (let n = node.parent; i >= 0 && n; n = n.parent) if (compound(n, parts[i])) i--;
    return i < 0;
  });
}

// the owner's Mac window by default
function fixture({ reduced = false, width = 1512, height = 982, phone = false } = {}) {
  const win = new Node(null, 'window');
  const doc = new Node(win, 'document');
  doc.baseURI = 'http://127.0.0.1:32123/';
  doc.defaultView = win;
  const timers = [];
  let now = 0;
  const screen = { width, height, phone };
  function element(tag, parent = null, cls = '') {
    const node = new Node(parent, tag);
    node.tag = tag; node.tagName = tag.toUpperCase(); node.ownerDocument = doc;
    node.children = []; node.attrs = {}; node.style = {}; node.animations = [];
    const classes = new Set(cls.split(' ').filter(Boolean));
    node.classList = {
      add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)),
      contains: c => classes.has(c), toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
    };
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: v => { classes.clear(); v.split(' ').filter(Boolean).forEach(x => classes.add(x)); } });
    Object.defineProperty(node, 'parentElement', { get: () => node.parent?.tag ? node.parent : null });
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
    node.getAttribute = k => k === 'id' ? (node.id || null) : (node.attrs[k] ?? null);
    node.hasAttribute = k => node.getAttribute(k) != null;
    for (const attr of ['href', 'src', 'download']) Object.defineProperty(node, attr, {
      get: () => node.attrs[attr], set: v => { node.attrs[attr] = String(v); },
    });
    node.appendChild = child => {
      if (child.parent) child.remove();
      child.parent = node; node.children.push(child); return child;
    };
    node.append = (...kids) => kids.forEach(kid => node.appendChild(kid));
    node.remove = () => { if (node.parent) node.parent.children = node.parent.children.filter(n => n !== node); node.parent = null; };
    Object.defineProperty(node, 'isConnected', { get: () => { for (let n = node; n; n = n.parent) if (n === doc) return true; return false; } });
    node.focus = () => { doc.activeElement = node; };
    node.blur = () => { if (doc.activeElement === node) doc.activeElement = doc.body; };
    node.contains = child => { for (let n = child; n; n = n.parent) if (n === node) return true; return false; };
    node.matches = sel => matches(node, sel);
    node.closest = sel => { for (let n = node; n && n.tag; n = n.parent) if (n.matches(sel)) return n; return null; };
    node.querySelector = sel => node.querySelectorAll(sel)[0] || null;
    node.querySelectorAll = sel => {
      const out = [];
      const walk = n => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(node); return out;
    };
    node.rect = { left: 20, top: 30, width: 0, height: 0 };
    // the room is laid out by the sheet's rule, at the window's size of the moment
    node.getBoundingClientRect = () => {
      const r = classes.has('picfull-room') ? room(screen.width, screen.height, screen.phone) : node.rect;
      return { ...r, right: r.left + r.width, bottom: r.top + r.height };
    };
    node.offsetWidth = 160; node.offsetHeight = 100;
    node.computed = {};
    node.animate = (keyframes, timing) => {
      const a = { keyframes, timing, playState: 'running', currentTime: 0, onfinish: null,
        cancel() { a.playState = 'idle'; }, finish() { if (a.playState !== 'running') return; a.playState = 'finished'; a.onfinish?.(); } };
      node.animations.push(a); return a;
    };
    node.click = () => dispatch(node, { type: 'click', metaKey: false });
    if (parent) parent.children.push(node);
    return node;
  }
  doc.documentElement = element('html'); doc.documentElement.parent = doc;
  doc.body = element('body', doc.documentElement); doc.activeElement = doc.body;
  doc.createElement = tag => element(tag);
  doc.getElementById = id => {
    const walk = n => { for (const c of n.children) { if (c.id === id) return c; const f = walk(c); if (f) return f; } return null; };
    return walk(doc.documentElement);
  };
  win.document = doc;
  win.navigator = { platform: 'MacIntel', clipboard: { writeText: async () => {} } };
  win.location = new URL(doc.baseURI); win.innerWidth = width; win.innerHeight = height;
  win.matchMedia = q => ({ matches: reduced && /reduced-motion/.test(q) });
  win.getComputedStyle = el => ({ borderRadius: '6px', transform: 'none', clipPath: 'none', overflowX: 'visible', overflowY: 'visible',
    opacity: el.className === 'picfull-veil' ? '0' : '1', ...el.computed });
  const fake = {
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  // the page's clock is the model's, so a double tap's two taps are as far
  // apart as the test says
  class FakeDate extends Date { static now() { return now; } }
  const ctx = vm.createContext({ window: win, document: doc, navigator: win.navigator, URL, Date: FakeDate,
    addEventListener: win.addEventListener.bind(win), setInterval, clearInterval, ...fake,
    matchMedia: win.matchMedia, getComputedStyle: win.getComputedStyle });
  vm.runInContext(source, ctx);
  vm.runInContext('installCardPageGuard();', ctx);
  // the board's own listeners, after the guard as on both pages
  const boardKeys = [], boardHeard = [];
  win.addEventListener('keydown', e => boardKeys.push(e.key), true);
  win.addEventListener('keydown', e => boardKeys.push('bubble ' + e.key));
  for (const type of ['touchstart', 'touchmove', 'touchend', 'wheel', 'pointerdown', 'pointermove'])
    doc.addEventListener(type, e => boardHeard.push(type));
  // a card with a reply picture and a sent bubble with an attached picture
  const card = element('div', doc.body, 'box sel');
  const reply = element('div', card, 'reply cardmd');
  const sentwrap = element('div', card, 'sentwrap');
  const bubble = element('div', sentwrap, 'answered sent');
  const msg = element('div', element('div', element('div', bubble, 'answclip'), 'answstack'), 'answmsg cardmd');
  const textarea = element('textarea', card);
  const picture = (parent, { w = 800, h = 600, rect = { left: 100, top: 200, width: 400, height: 300 }, complete = true } = {}) => {
    const img = element('img', parent, 'shot');
    img.src = '/uploads/' + w + 'x' + h + '.png'; img.alt = '';
    img.naturalWidth = complete ? w : 0; img.naturalHeight = complete ? h : 0; img.complete = complete;
    img.rect = { ...rect };
    return img;
  };
  const docClicks = [], bubbleClicks = [];
  doc.addEventListener('click', e => docClicks.push(e.target));
  bubble.addEventListener('click', e => bubbleClicks.push(e.target));
  const state = () => vm.runInContext('cardPictureShown', ctx);
  const layer = () => doc.getElementById('picfull');
  const f = {
    win, doc, ctx, element, card, reply, msg, bubble, textarea, picture, boardKeys, boardHeard, docClicks, bubbleClicks,
    state, layer, screen,
    send: (target, over) => dispatch(target, { metaKey: false, ...over }),
    press(target, over = {}) {
      dispatch(target, { type: 'pointerdown', pointerType: 'mouse', button: 0, clientX: 700, clientY: 490, metaKey: false, ...over });
      // a press on something that takes no focus leaves the field, as a browser does
      if (doc.activeElement !== doc.body && !doc.activeElement.contains(target)) doc.activeElement = doc.body;
      return dispatch(target, { type: 'click', metaKey: false, button: 0, clientX: 700, clientY: 490, ...over });
    },
    // fingers on the open picture: each a list of [x, y]
    touch(type, points, changed = points) {
      const list = ps => ps.map(([x, y]) => ({ clientX: x, clientY: y }));
      return dispatch(big(f), { type, touches: list(points), changedTouches: list(changed) });
    },
    wheel(x, y, deltaX, deltaY, ctrlKey = false, deltaMode = 0) {
      return dispatch(big(f), { type: 'wheel', clientX: x, clientY: y, deltaX, deltaY, deltaMode, ctrlKey });
    },
    key: key => dispatch(doc.activeElement, { type: 'keydown', key, code: key, metaKey: false }),
    menu: () => doc.body.children.find(n => n.className === 'app-link-menu'),
    advance(ms) { now += ms; for (const t of timers.filter(t => t.at <= now)) { fake.clearTimeout(t); t.fn(); } },
  };
  return f;
}
const big = f => f.layer().children.find(n => n.className === 'picfull-img');
const veil = f => f.layer().children.find(n => n.className === 'picfull-veil');
// keyframes and timings are made inside the page's realm: compare them as plain data
const same = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
// where the copy stands: left, top, width, height
const at = f => ['left', 'top', 'width', 'height'].map(k => { assert.match(big(f).style[k], /px$/); return parseFloat(big(f).style[k]); });
function placed(f, expected, msg = '') {
  at(f).forEach((v, i) => close(v, expected[i], msg + ['left', 'top', 'width', 'height'][i]));
}
// a transform's or a clip's numbers, in order
const numbers = t => t.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
function over(actual, expected, msg) {
  const got = numbers(actual);
  assert.equal(got.length, expected.length, msg);
  got.forEach((v, i) => close(v, expected[i], msg));
}
// 800x600 in the settings window's place at 1512x982, 1058.4 by 687.4 from
// (226.8, 147.3), is bound by its height
const FIT = (() => { const h = 687.4, w = h * 4 / 3; return [226.8 + (1058.4 - w) / 2, 147.3, w, h]; })();
// opened, its motion run out, as a gesture finds it
function opened(options) {
  const f = fixture(options);
  const img = f.picture(f.reply, { w: 800, h: 600 });
  f.press(img);
  big(f).animations[0].finish(); veil(f).animations[0].finish();
  return { f, img };
}
// the copy's last motion run out, and the landing fade after it where there is one
function settle(f) {
  for (let i = 0; i < 3 && big(f); i++) big(f).animations.at(-1).finish();
}

test('the room is the settings window on the desktop and the whole screen inside its safe areas on the phone', () => {
  // the owner's Mac window: fifteen percent in from every edge
  const mac = room(1512, 982, false);
  close(mac.left, 226.8, 'left'); close(mac.top, 147.3, 'top'); close(mac.width, 1058.4, 'width'); close(mac.height, 687.4, 'height');
  const css = read('card-tokens.css'), phone = read('m.html');
  assert.match(css, /#picfull \.picfull-room\{position:absolute; inset:var\(--picfull-inset, var\(--sp-inset\) 0\);\s+width:var\(--picfull-w, calc\(100% - 2 \* var\(--sp-inset\)\)\); margin:0 auto\}/);
  // the phone: every safe area in, and as wide as they leave
  assert.match(phone, /:root\{--picfull-inset:env\(safe-area-inset-top, 0px\) env\(safe-area-inset-right, 0px\) env\(safe-area-inset-bottom, 0px\) env\(safe-area-inset-left, 0px\);\s+--picfull-w:auto\}/);
  assert.doesNotMatch(read('index.html'), /--picfull-|--settings-w|--sp-inset/, 'the desktop room is the settings window, inset alike on every side');
  // it no longer borrows the phone's settings drawer's width, which made it small
  assert.doesNotMatch(css, /picfull[^}]*--settings-w/);
});

test('fitting: at its own shape, centred, as large as the room holds, never past twice its size', () => {
  const screens = [['the owner\'s Mac window', 1512, 982, false], ['a small Mac window', 900, 600, false],
    ['an iPhone 13 mini', 375, 812, true], ['an iPhone 17', 402, 874, true]];
  const pictures = [['wide', 2400, 600], ['tall', 600, 2000], ['small', 96, 64], ['photo', 1600, 1200]];
  for (const [where, W, H, phone] of screens) for (const [kind, w, h] of pictures) {
    const f = fixture({ width: W, height: H, phone }), box = room(W, H, phone), msg = kind + ' on ' + where;
    f.press(f.picture(f.reply, { w, h }));
    const [x, y, cw, ch] = at(f);
    close(cw / ch, w / h, msg + ': its shape');
    assert.ok(x >= box.left - 1e-9 && y >= box.top - 1e-9 && x + cw <= box.left + box.width + 1e-9 &&
      y + ch <= box.top + box.height + 1e-9, msg + ': inside the room');
    close(x - box.left, box.left + box.width - (x + cw), msg + ': centred across');
    close(y - box.top, box.top + box.height - (y + ch), msg + ': centred down');
    assert.ok(cw <= w * 2 + 1e-9, msg + ': at most twice its size');
    // it fills the room's width or its height, unless the cap stops it first
    if (cw < w * 2 - 1e-9) assert.ok(Math.abs(cw - box.width) < 1e-6 || Math.abs(ch - box.height) < 1e-6, msg + ': fills the room');
    if (!phone) assert.ok(x > 0 && y > 0 && x + cw < W && y + ch < H, msg + ': clear of every edge of the Mac window');
  }
  // the numbers the report gives, on the owner's Mac window and an iPhone 13 mini
  const cases = [
    [1512, 982, false, 2400, 600, [226.8, 358.7, 1058.4, 264.6]],
    [1512, 982, false, 600, 2000, [652.89, 147.3, 206.22, 687.4]],
    [1512, 982, false, 96, 64, [660, 427, 192, 128]],
    // the wide picture is the screen's width, 375, where the drawer's width gave it 267.75
    [375, 812, true, 2400, 600, [0, 359.125, 375, 93.75]],
    [375, 812, true, 600, 2000, [65.7, 0, 243.6, 812]],
    [375, 812, true, 96, 64, [91.5, 342, 192, 128]],
  ];
  for (const [W, H, phone, w, h, expected] of cases) {
    const f = fixture({ width: W, height: H, phone });
    f.press(f.picture(f.reply, { w, h }));
    placed(f, expected);
  }
});

for (const where of ['reply', 'sent message']) {
  test(`a plain click on a picture in a ${where} opens it over the dimmed board`, () => {
    const f = fixture();
    const img = f.picture(where === 'reply' ? f.reply : f.msg, { w: 800, h: 600 });
    f.textarea.focus();
    const e = f.press(img);
    assert.equal(e.defaultPrevented, true);
    assert.equal(f.menu(), undefined, 'no menu');
    assert.deepEqual(f.bubbleClicks, [], 'the bubble does not fold');
    assert.deepEqual(f.docClicks, [], 'nothing else hears the click');
    const layer = f.layer();
    assert.ok(layer.classList.contains('on'));
    const copy = big(f);
    assert.equal(copy.src, img.src); assert.equal(copy.draggable, false);
    const [x, y, w, h] = FIT;
    placed(f, FIT);
    assert.equal(copy.style.borderRadius, '6px', 'the card picture\'s own corners');
    assert.ok(img.classList.contains('picfull-from'), 'the card keeps its picture, hidden in place');
    assert.equal(img.parent, where === 'reply' ? f.reply : f.msg, 'the card picture never leaves the card');
    const [grow] = copy.animations, [dim] = veil(f).animations;
    over(grow.keyframes[0].transform, [100 - x, 200 - y, 400 / w, 300 / h], 'grows from the card picture');
    assert.equal(grow.keyframes[0].clipPath, 'inset(0px 0px 0px 0px)', 'a picture the card shows whole grows whole');
    assert.equal(grow.keyframes[1].transform, 'none');
    same(dim.keyframes, [{ opacity: 0 }, { opacity: 0.62 }]);
    for (const a of [grow, dim]) same(a.timing, { duration: 300, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', fill: 'both' });
  });
}

test('a click or tap at its fitted size closes it back into the card, once a second tap can no longer come', () => {
  for (const on of ['veil', 'picture']) {
    const f = fixture();
    const img = f.picture(f.reply);
    f.textarea.focus();
    f.press(img);
    assert.equal(f.doc.activeElement, f.doc.body, 'the press took focus off the field');
    big(f).animations[0].finish();
    veil(f).computed = { opacity: '0.62' };
    img.rect = { left: 100, top: 180, width: 400, height: 300 };   // the card moved under it
    const e = f.press(on === 'veil' ? veil(f) : big(f));
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(f.docClicks, [], 'the closing click reaches nothing behind');
    f.advance(299);
    assert.ok(!f.state().closing, 'not while a second tap could still make it a double');
    f.advance(1);
    assert.ok(f.state().closing);
    assert.equal(f.doc.activeElement, f.textarea, 'focus is back as it closes');
    const shrink = big(f).animations.at(-1);
    const [x, y, w, h] = at(f);
    over(shrink.keyframes[1].transform, [100 - x, 180 - y, 400 / w, 300 / h], 'lands on the card picture where it stands now');
    assert.equal(shrink.keyframes[1].clipPath, 'inset(0px 0px 0px 0px)', 'shown whole, it lands whole');
    assert.equal(shrink.keyframes[1].opacity, 1);
    assert.equal(shrink.timing.duration, 300);
    same(veil(f).animations.at(-1).keyframes, [{ opacity: '0.62' }, { opacity: 0 }]);
    assert.ok(img.classList.contains('picfull-from'), 'hidden until the copy lands');
    f.press(f.layer()); f.advance(400);   // a second click while it shrinks changes nothing
    assert.equal(big(f).animations.length, 2);
    shrink.finish();
    // landed, the card's own picture shows under the copy, which fades off it
    assert.ok(!img.classList.contains('picfull-from'), 'the card picture shows again as the copy lands');
    const fade = big(f).animations.at(-1);
    same(fade.keyframes, [{ opacity: 1 }, { opacity: 0 }]);
    same(fade.timing, { duration: 120, fill: 'both' });
    assert.ok(f.layer().classList.contains('on'), 'the layer holds until the fade is out');
    fade.finish();
    assert.equal(big(f), undefined, 'the copy is gone');
    assert.ok(!f.layer().classList.contains('on'));
    assert.equal(f.state(), null);
    // and the next click opens it again
    f.press(img); assert.ok(f.layer().classList.contains('on'));
  }
});

test('the copy covers only the part of the picture the card shows, opening and closing', () => {
  // the answer's scroller cuts the picture's top 50px off, under the card's
  // title, and the card's own edge cuts nothing more
  const f = fixture();
  f.reply.computed = { overflowY: 'auto' };
  f.reply.rect = { left: 50, top: 250, width: 600, height: 500 };
  f.card.computed = { overflowX: 'hidden', overflowY: 'hidden' };
  f.card.rect = { left: 0, top: 0, width: 1512, height: 982 };
  const img = f.picture(f.reply);
  f.press(img);
  const [x, y, w, h] = FIT;
  const grow = big(f).animations[0];
  // the copy's pixels are its fitted ones, h / 300 of the card picture's
  over(grow.keyframes[0].clipPath, [50 * h / 300, 0, 0, 0], 'it leaves the card cut where the card cuts it');
  assert.equal(grow.keyframes[1].clipPath, 'inset(0px 0px 0px 0px)', 'and stands whole once out');
  grow.finish();
  f.key('Escape');
  const shrink = big(f).animations.at(-1);
  over(shrink.keyframes[1].transform, [100 - x, 200 - y, 400 / w, 300 / h], 'onto the whole picture\'s place');
  over(shrink.keyframes[1].clipPath, [50 * h / 300, 0, 0, 0], 'cut down to what the card shows, never over the title');
  // zoomed, the cut is counted in the zoomed copy's own pixels
  const g = fixture();
  g.reply.computed = { overflowY: 'auto' };
  g.reply.rect = { left: 0, top: 0, width: 1512, height: 400 };   // the foot cut: 100 of 300 show
  const pic = g.picture(g.reply);
  g.press(pic); big(g).animations[0].finish();
  g.wheel(700, 490, 0, -60, true);
  const zw = at(g)[2], zh = at(g)[3];
  g.key('Escape');
  const back = big(g).animations.at(-1);
  over(back.keyframes[1].clipPath, [0, 0, 100 * zh / 300, 0], 'the foot\'s cut, at the zoom');
  over(back.keyframes[1].transform, [100 - at(g)[0], 200 - at(g)[1], 400 / zw, 300 / zh], 'from the zoom onto its place');
  // a picture the card has scrolled wholly out of sight has no place to come
  // to, and the copy fades where it is
  const k = fixture();
  k.reply.computed = { overflowY: 'auto' };
  k.reply.rect = { left: 0, top: 600, width: 1512, height: 300 };
  const out = k.picture(k.reply);
  k.press(out); big(k).animations[0].finish();
  k.key('Escape');
  const fade = big(k).animations.at(-1);
  assert.equal(fade.keyframes[1].opacity, 0);
  fade.finish();
  assert.equal(big(k), undefined, 'gone, with no landing fade');
  assert.equal(k.state(), null);
});

test('two fingers pinch it about their middle, from its fitted size to four times that', () => {
  const { f } = opened();
  const [x, y, w, h] = FIT;
  f.boardHeard.length = 0;
  assert.equal(f.touch('touchstart', [[650, 490], [750, 490]]).defaultPrevented, true);
  const moved = f.touch('touchmove', [[600, 490], [800, 490]]);
  assert.equal(moved.defaultPrevented, true, 'the page does not zoom or scroll');
  // twice, the picture's point under (700, 490) kept there
  placed(f, [700 - (700 - x) * 2, 490 - (490 - y) * 2, w * 2, h * 2], 'twice: ');
  // the middle moving carries the picture with it
  f.touch('touchmove', [[620, 520], [820, 520]]);
  placed(f, [720 - (700 - x) * 2, 520 - (490 - y) * 2, w * 2, h * 2], 'carried: ');
  // never past four times, and never below its fitted size
  f.touch('touchmove', [[0, 490], [1500, 490]]);
  close(at(f)[2], w * 4, 'four times at most');
  f.touch('touchmove', [[699, 490], [701, 490]]);
  placed(f, FIT, 'fitted at least: ');
  f.touch('touchend', [], [[699, 490], [701, 490]]);
  assert.deepEqual(f.boardHeard, [], 'the board hears none of it');
  f.advance(1000);
  assert.ok(!f.state().closing, 'a pinch is not a tap');
});

test('zoomed, one finger moves it, never so far that an edge comes in past the room\'s', () => {
  const { f } = opened();
  const [x, y, w, h] = FIT;
  f.touch('touchstart', [[650, 490], [750, 490]]);
  f.touch('touchmove', [[600, 490], [800, 490]]);
  // a finger lifted, the other goes on moving it from where it is
  f.touch('touchend', [[800, 490]], [[600, 490]]);
  f.touch('touchmove', [[830, 470]]);
  const zx = 700 - (700 - x) * 2, zy = 490 - (490 - y) * 2;
  placed(f, [zx + 30, zy - 20, w * 2, h * 2], 'moved: ');
  f.touch('touchend', [], [[830, 470]]);
  // a long way right: its left edge stops at the room's left; and down
  f.touch('touchstart', [[700, 490]]);
  f.touch('touchmove', [[3700, 2490]]);
  placed(f, [226.8, 147.3, w * 2, h * 2], 'held at the top left: ');
  f.touch('touchmove', [[-3000, -3000]]);
  placed(f, [226.8 + 1058.4 - w * 2, 147.3 + 687.4 - h * 2, w * 2, h * 2], 'held at the bottom right: ');
  f.touch('touchend', [], [[-3000, -3000]]);
  f.advance(1000);
  assert.ok(!f.state().closing, 'a drag is not a tap');
  // at its fitted size one finger moves nothing and closes nothing
  const g = opened().f;
  g.touch('touchstart', [[700, 490]]);
  g.touch('touchmove', [[760, 560]]);
  g.touch('touchend', [], [[760, 560]]);
  placed(g, FIT);
  g.advance(1000);
  assert.ok(!g.state().closing);
});

test('a tap: at its fitted size it closes, zoomed it does not, and Escape always does', () => {
  const tap = (f, x, y) => { f.touch('touchstart', [[x, y]]); return f.touch('touchend', [], [[x, y]]); };
  const { f } = opened();
  const end = tap(f, 700, 490);
  assert.equal(end.defaultPrevented, true, 'no click follows the touch, so the tap counts once');
  f.advance(300);
  assert.ok(f.state().closing, 'a tap at its fitted size puts it back');
  const g = opened().f;
  g.wheel(700, 490, 0, -30, true);
  tap(g, 700, 490);
  g.advance(1000);
  assert.ok(!g.state().closing, 'a tap on a zoomed picture leaves it open');
  g.press(g.layer()); g.advance(1000);
  assert.ok(!g.state().closing, 'and so does a click');
  g.key('Escape');
  assert.ok(g.state().closing, 'Escape puts it back zoomed');
});

test('a double tap or double click zooms to twice at that point, and back', () => {
  const tap = (f, x, y) => { f.touch('touchstart', [[x, y]]); f.touch('touchend', [], [[x, y]]); };
  const [x, y, w, h] = FIT;
  const { f } = opened();
  tap(f, 500, 300); f.advance(200); tap(f, 510, 305);
  // the second tap's point, 510 by 305, is kept where it is
  placed(f, [510 - (510 - x) * 2, 305 - (305 - y) * 2, w * 2, h * 2], 'twice: ');
  const glide = big(f).animations.at(-1);
  over(glide.keyframes[0].transform, [x - (510 - (510 - x) * 2), y - (305 - (305 - y) * 2), 0.5, 0.5], 'it glides there from fitted');
  assert.equal(glide.keyframes[1].transform, 'none');
  f.advance(1000);
  assert.ok(!f.state().closing, 'a double tap does not close it');
  tap(f, 700, 490); f.advance(100); tap(f, 700, 490);
  placed(f, FIT, 'back: ');
  f.advance(1000);
  assert.ok(!f.state().closing);
  // taps too far apart in time or place are two single taps
  const g = opened().f;
  tap(g, 500, 300); g.advance(310);
  assert.ok(g.state().closing);
  const k = opened().f;
  tap(k, 500, 300); k.advance(100); tap(k, 600, 300);
  placed(k, FIT, 'far apart: ');
  // the Mac's double click is two clicks
  const m = opened().f;
  m.press(m.layer(), { clientX: 500, clientY: 300 }); m.advance(150); m.press(m.layer(), { clientX: 500, clientY: 300, detail: 2 });
  placed(m, [500 - (500 - x) * 2, 300 - (300 - y) * 2, w * 2, h * 2], 'double click: ');
  m.advance(1000);
  assert.ok(!m.state().closing);
});

test('the wheel: a trackpad pinch zooms about the pointer, and zoomed a two-finger scroll moves it', () => {
  const [x, y, w, h] = FIT;
  const { f } = opened();
  f.boardHeard.length = 0;
  // Chrome's trackpad pinch: a wheel with ctrlKey, deltaY -20 to spread
  const e = f.wheel(700, 490, 0, -20, true);
  assert.equal(e.defaultPrevented, true, 'the page does not zoom');
  const s = Math.exp(0.2);
  placed(f, [700 - (700 - x) * s, 490 - (490 - y) * s, w * s, h * s], 'zoomed: ');
  // a mouse wheel with control held counts for no more than 60
  f.wheel(700, 490, 0, -400, true);
  close(at(f)[2], w * s * Math.exp(0.6), 'one step at most');
  // a two-finger scroll moves it the way a page scrolls
  const [zx, zy, zw, zh] = at(f);
  f.wheel(700, 490, 30, 40);
  placed(f, [zx - 30, zy - 40, zw, zh], 'moved: ');
  // and lines count sixteen pixels
  f.wheel(700, 490, 0, -1, false, 1);
  close(at(f)[1], zy - 40 + 16, 'a line');
  for (let i = 0; i < 40; i++) f.wheel(700, 490, 0, 300, true);
  placed(f, FIT, 'pinched back to fitted: ');
  // at its fitted size a scroll moves nothing
  const fit = f.wheel(700, 490, 30, 40);
  assert.equal(fit.defaultPrevented, true, 'and the board does not scroll');
  placed(f, FIT);
  assert.deepEqual(f.boardHeard, [], 'the board hears no wheel');
});

test('the mouse: dragged it moves a zoomed picture, and the click that ends a drag does not close', () => {
  const { f } = opened();
  f.wheel(700, 490, 0, -60, true);
  const [zx, zy, zw, zh] = at(f);
  f.send(big(f), { type: 'pointerdown', pointerType: 'mouse', button: 0, clientX: 700, clientY: 490 });
  f.send(big(f), { type: 'pointermove', pointerType: 'mouse', buttons: 1, clientX: 705, clientY: 490 });
  placed(f, [zx, zy, zw, zh], 'within the slop it does not move: ');
  f.send(big(f), { type: 'pointermove', pointerType: 'mouse', buttons: 1, clientX: 760, clientY: 470 });
  placed(f, [zx + 55, zy - 20, zw, zh], 'dragged: ');
  f.send(big(f), { type: 'click', button: 0, clientX: 760, clientY: 470 });
  f.send(big(f), { type: 'click', button: 0, clientX: 760, clientY: 470 });
  placed(f, [zx + 55, zy - 20, zw, zh], 'the click after the drag is no double click');
  // a finger's pointer events are left to the touches
  f.send(big(f), { type: 'pointerdown', pointerType: 'touch', button: 0, clientX: 700, clientY: 490 });
  f.send(big(f), { type: 'pointermove', pointerType: 'touch', buttons: 1, clientX: 900, clientY: 490 });
  placed(f, [zx + 55, zy - 20, zw, zh], 'a touch pointer moves nothing');
});

test('Escape closes it, and no key reaches the board while it is open', () => {
  const f = fixture();
  const img = f.picture(f.msg);
  f.press(img);
  f.boardKeys.length = 0;
  for (const key of ['ArrowRight', 'Enter', 'Tab', ' ']) assert.equal(f.key(key).defaultPrevented, true, key);
  assert.deepEqual(f.boardKeys, [], 'the board heard nothing');
  const e = f.key('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(f.boardKeys, []);
  assert.ok(f.state().closing);
  settle(f);
  assert.equal(f.state(), null);
  f.key('ArrowRight');
  assert.deepEqual(f.boardKeys, ['ArrowRight', 'bubble ArrowRight'], 'keys reach the board again once it is shut');
});

test('caught halfway out it turns round from where it is, in the time spent', () => {
  const f = fixture();
  const img = f.picture(f.reply);
  f.press(img);
  const grow = big(f).animations[0];
  grow.currentTime = 150;
  big(f).computed = { transform: 'matrix(0.6, 0, 0, 0.6, 50, 100)', clipPath: 'inset(10px 0px 0px 0px)' };
  veil(f).computed = { opacity: '0.4' };
  f.key('Escape');
  const shrink = big(f).animations.at(-1);
  assert.equal(grow.playState, 'idle', 'the grow is let go');
  assert.equal(shrink.keyframes[0].transform, 'matrix(0.6, 0, 0, 0.6, 50, 100)');
  assert.equal(shrink.keyframes[0].clipPath, 'inset(10px 0px 0px 0px)');
  assert.equal(shrink.timing.duration, 150);
  same(veil(f).animations.at(-1).keyframes, [{ opacity: '0.4' }, { opacity: 0 }]);
  // a double tap's glide is not an opening: closing from it takes the whole time
  const { f: g } = opened();
  const tap = (x, y) => { g.touch('touchstart', [[x, y]]); g.touch('touchend', [], [[x, y]]); };
  tap(700, 490); g.advance(100); tap(700, 490);
  big(g).animations.at(-1).currentTime = 100;
  g.key('Escape');
  assert.equal(big(g).animations.at(-1).timing.duration, 300);
});

test('reduced motion opens, zooms and closes at once', () => {
  const f = fixture({ reduced: true });
  const img = f.picture(f.reply);
  f.press(img);
  assert.equal(big(f).animations[0].timing.duration, 0);
  assert.equal(veil(f).animations[0].timing.duration, 0);
  const tap = (x, y) => { f.touch('touchstart', [[x, y]]); f.touch('touchend', [], [[x, y]]); };
  tap(700, 490); f.advance(100); tap(700, 490);
  assert.equal(big(f).animations.at(-1).timing.duration, 0);
  f.key('Escape');
  assert.equal(big(f).animations.at(-1).timing.duration, 0);
  big(f).animations.at(-1).finish();
  assert.equal(big(f).animations.at(-1).timing.duration, 0, 'the landing fade too');
});

test('a picture the card drew again while open has no place left, and the copy fades', () => {
  const f = fixture();
  const img = f.picture(f.reply);
  f.press(img);
  img.remove();
  f.key('Escape');
  assert.equal(big(f).animations.at(-1).keyframes[1].opacity, 0);
});

test('a resized window or a turned phone refits the open picture, and lets go of a zoom', () => {
  const { f } = opened();
  f.wheel(700, 490, 0, -60, true);
  f.screen.width = 900; f.screen.height = 600;
  f.win.listeners.filter(l => l.type === 'resize').forEach(l => l.fn({}));
  // the settings window's place at 900x600 is 630 by 420 from (135, 90): height bound
  placed(f, [135 + (630 - 560) / 2, 90, 560, 420]);
  f.touch('touchstart', [[450, 300]]); f.touch('touchend', [], [[450, 300]]);
  f.advance(300);
  assert.ok(f.state().closing, 'fitted again, a tap closes it');
});

test('the menu keeps its other ways in, and pictures with nothing to open keep the click', () => {
  const ways = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }];
  for (const over of ways) {
    const f = fixture(); const img = f.picture(f.reply);
    f.press(img, over);
    assert.ok(f.menu(), JSON.stringify(over)); assert.equal(f.state(), null);
  }
  for (const type of ['contextmenu', 'auxclick', 'dragstart']) {
    const f = fixture(); const img = f.picture(f.msg);
    const e = f.send(img, { type, button: type === 'auxclick' ? 1 : 2 });
    assert.equal(e.defaultPrevented, true); assert.ok(f.menu(), type); assert.equal(f.state(), null);
  }
  // not drawn yet, in a magic box, or a picture outside the card's reply and messages
  const f = fixture();
  const magic = f.element('div', f.doc.body); magic.id = 'magic2';
  const mini = f.element('div', f.element('div', magic, 'answered'), 'answmsg cardmd');
  const other = f.element('div', f.doc.body, 'qb cardmd');
  for (const img of [f.picture(f.reply, { complete: false }), f.picture(mini), f.picture(other)]) {
    f.menu()?.remove();
    f.press(img);
    assert.ok(f.menu()); assert.equal(f.state(), null);
  }
});

test('a finger held still on a picture brings the menu, and its click opens nothing', () => {
  const f = fixture();
  const img = f.picture(f.reply);
  const touch = (type, x = 120, y = 220, n = 1) => f.send(img, { type, touches: n ? Array.from({ length: n }, () => ({ clientX: x, clientY: y })) : [] });
  touch('touchstart'); f.advance(499);
  assert.equal(f.menu(), undefined, 'not before half a second');
  f.advance(1);
  const menu = f.menu();
  assert.ok(menu, 'the menu');
  assert.deepEqual([menu.style.left, menu.style.top], ['120px', '220px']);
  touch('touchend', 120, 220, 0);
  // the click a lifted finger may still send: a compatibility click, no new pointerdown
  const e = f.send(img, { type: 'click', button: 0 });
  assert.equal(e.defaultPrevented, true);
  assert.equal(f.state(), null, 'the lifted finger opens nothing');
  assert.equal(f.menu(), menu, 'and the menu stays');
  // a moved finger is a scroll; a short one is a tap; two fingers are neither
  for (const [moves, n] of [[30, 1], [0, 2]]) {
    const g = fixture(); const pic = g.picture(g.reply);
    g.send(pic, { type: 'touchstart', touches: Array(n).fill({ clientX: 120, clientY: 220 }) });
    if (moves) g.send(pic, { type: 'touchmove', touches: [{ clientX: 120, clientY: 220 + moves }] });
    g.advance(800);
    assert.equal(g.menu(), undefined);
  }
  const g = fixture(); const pic = g.picture(g.reply);
  g.send(pic, { type: 'touchstart', touches: [{ clientX: 120, clientY: 220 }] });
  g.advance(150); g.send(pic, { type: 'touchend', touches: [] }); g.advance(800);
  assert.equal(g.menu(), undefined);
  g.press(pic);
  assert.ok(g.state(), 'the tap opens the picture');
});

test('the sheet: the board ink veil, over the board and under the menu, the touches its own, no accent', () => {
  const css = read('card-tokens.css');
  const block = css.slice(css.indexOf("/* a card's picture opened full screen"), css.indexOf('/* ---- the files picked'));
  assert.match(block, /#picfull\{display:none; position:fixed; inset:0; z-index:9000/);
  assert.match(block, /\.picfull-veil\{[^}]*background:var\(--ink\); opacity:0/);
  assert.match(block, /\.picfull-from\{visibility:hidden\}/);
  // the phone's page sets touch-action:manipulation on everything; the layer's
  // id outweighs it, so a pinch or a double tap on it is never the page's
  assert.match(block, /#picfull, #picfull \*\{touch-action:none\}/);
  assert.match(read('m.html'), /\*\{touch-action:manipulation\}/);
  // the room and the settings read the same inset on the desktop, so they never part
  assert.match(css, /:root\{--sp-inset:15%\}\n\.sp-veil \.sp-page\{position:absolute; inset:var\(--sp-inset\);/,
    'the settings window stands --sp-inset in from every edge');
  assert.doesNotMatch(block, /padding/, 'the room, not a padding, keeps the picture off the edges');
  assert.match(block, /:is\(\.reply, \.answmsg\)\.cardmd img\.shot:not\(\[id\^="magic"\] \*\)\{cursor:zoom-in\}/);
  assert.doesNotMatch(block, /--accent|purple|#432BFF/i);
  const menu = Number(/\.app-link-menu\{[^}]*z-index:(\d+)/.exec(css)[1]);
  assert.ok(menu > 9000);
  for (const name of ['index.html', 'm.html']) {
    const html = read(name);
    assert.ok(html.includes('<link rel="stylesheet" href="/card-tokens.css">'), name);
    assert.ok(html.includes('<script>installCardPageGuard();</script>'), name);
  }
});
