// A card's picture opened full screen: the shipped page guard and picture code
// run against a small document model. Opening, fitting, closing, Escape, the
// menu's other ways in and the long press. No browser, no server.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Node, dispatch } = require('./page-event-model.cjs');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('card-logic.js');
// the settings' place, read out of the sheets: the desktop window's inset from
// every edge (card-tokens.css) and the phone drawer's width (m.html)
const INSET = Number(/:root\{--sp-inset:([\d.]+)%\}/.exec(read('card-tokens.css'))[1]) / 100;
const [VW, CAP] = /--settings-w:min\(([\d.]+)vw, ([\d.]+)px\)/.exec(read('m.html')).slice(1).map(Number);
// the room as the sheet lays it out (#picfull .picfull-room): INSET in from the
// top and the bottom, centred at the settings' width, which on the desktop is
// what the inset leaves and on the phone is the drawer's
function room(width, height, phone) {
  const w = phone ? Math.min(width * VW / 100, CAP) : width * (1 - 2 * INSET);
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
        cancel() { a.playState = 'idle'; }, finish() { a.playState = 'finished'; a.onfinish?.(); } };
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
  win.getComputedStyle = el => ({ borderRadius: '6px', transform: 'none', opacity: el.className === 'picfull-veil' ? '0' : '1', ...el.computed });
  const fake = {
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimeout: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const ctx = vm.createContext({ window: win, document: doc, navigator: win.navigator, URL, Date,
    addEventListener: win.addEventListener.bind(win), setInterval, clearInterval, ...fake,
    matchMedia: win.matchMedia, getComputedStyle: win.getComputedStyle });
  vm.runInContext(source, ctx);
  vm.runInContext('installCardPageGuard();', ctx);
  // the board's own key listener, after the guard as on both pages
  const boardKeys = [];
  win.addEventListener('keydown', e => boardKeys.push(e.key), true);
  win.addEventListener('keydown', e => boardKeys.push('bubble ' + e.key));
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
  return {
    win, doc, ctx, element, card, reply, msg, bubble, textarea, picture, boardKeys, docClicks, bubbleClicks,
    state, layer, screen,
    send: (target, over) => dispatch(target, { metaKey: false, ...over }),
    press(target, over = {}) {
      dispatch(target, { type: 'pointerdown', metaKey: false, ...over });
      // a press on something that takes no focus leaves the field, as a browser does
      if (doc.activeElement !== doc.body && !doc.activeElement.contains(target)) doc.activeElement = doc.body;
      return dispatch(target, { type: 'click', metaKey: false, button: 0, ...over });
    },
    key: key => dispatch(doc.activeElement, { type: 'keydown', key, code: key, metaKey: false }),
    menu: () => doc.body.children.find(n => n.className === 'app-link-menu'),
    advance(ms) { now += ms; for (const t of timers.filter(t => t.at <= now)) { fake.clearTimeout(t); t.fn(); } },
  };
}
const big = f => f.layer().children.find(n => n.className === 'picfull-img');
const veil = f => f.layer().children.find(n => n.className === 'picfull-veil');
// keyframes and timings are made inside the page's realm: compare them as plain data
const same = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
// where the copy stands: left, top, width, height
const at = f => ['left', 'top', 'width', 'height'].map(k => { assert.match(big(f).style[k], /px$/); return parseFloat(big(f).style[k]); });
function placed(f, expected) {
  at(f).forEach((v, i) => close(v, expected[i], ['left', 'top', 'width', 'height'][i]));
}
// a transform's numbers, in order
const numbers = t => t.match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number);
function over(actual, expected, msg) {
  const got = numbers(actual);
  assert.equal(got.length, expected.length, msg);
  got.forEach((v, i) => close(v, expected[i], msg));
}

test('the room is the settings window on the desktop and the drawer\'s width on the phone', () => {
  // the owner's Mac window: fifteen percent in from every edge
  const mac = room(1512, 982, false);
  close(mac.left, 226.8, 'left'); close(mac.top, 147.3, 'top'); close(mac.width, 1058.4, 'width'); close(mac.height, 687.4, 'height');
  // an iPhone 17: the drawer's 71.4% across, centred, and the desktop's fifteen percent top and bottom
  const phone = room(402, 874, true);
  close(phone.width, 402 * 0.714, 'drawer width'); close(phone.left, (402 - 402 * 0.714) / 2, 'centred');
  close(phone.top, 874 * 0.15, 'top'); close(phone.height, 874 * 0.7, 'height');
  // a larger phone, where the drawer stops at 289
  close(room(440, 956, true).width, 289, 'the drawer\'s cap');
});

test('fitting: in the settings\' place at its own shape, centred, clear of every edge, never past twice its size', () => {
  const screens = [['the owner\'s Mac window', 1512, 982, false], ['a small Mac window', 900, 600, false],
    ['an iPhone 17', 402, 874, true], ['a larger phone', 440, 956, true]];
  const pictures = [['wide', 2400, 600], ['tall', 600, 2000], ['small', 96, 64], ['photo', 1600, 1200]];
  for (const [where, W, H, phone] of screens) for (const [kind, w, h] of pictures) {
    const f = fixture({ width: W, height: H, phone }), box = room(W, H, phone), msg = kind + ' on ' + where;
    f.press(f.picture(f.reply, { w, h }));
    const [x, y, cw, ch] = at(f);
    close(cw / ch, w / h, msg + ': its shape');
    assert.ok(x >= box.left - 1e-9 && y >= box.top - 1e-9 && x + cw <= box.left + box.width + 1e-9 &&
      y + ch <= box.top + box.height + 1e-9, msg + ': inside the settings\' place');
    close(x - box.left, box.left + box.width - (x + cw), msg + ': centred across');
    close(y - box.top, box.top + box.height - (y + ch), msg + ': centred down');
    assert.ok(cw <= w * 2 + 1e-9, msg + ': at most twice its size');
    // it fills the place's width or its height, unless the cap stops it first
    if (cw < w * 2 - 1e-9) assert.ok(Math.abs(cw - box.width) < 1e-6 || Math.abs(ch - box.height) < 1e-6, msg + ': fills the place');
    assert.ok(x > 0 && y > 0 && x + cw < W && y + ch < H, msg + ': clear of every edge');
  }
  // the numbers the report gives, on the owner's Mac window and an iPhone 17
  const cases = [
    [1512, 982, false, 2400, 600, [226.8, 358.7, 1058.4, 264.6]],
    [1512, 982, false, 600, 2000, [652.89, 147.3, 206.22, 687.4]],
    [1512, 982, false, 96, 64, [660, 427, 192, 128]],
    [402, 874, true, 2400, 600, [57.486, 401.1215, 287.028, 71.757]],
    [402, 874, true, 600, 2000, [109.23, 131.1, 183.54, 611.8]],
    [402, 874, true, 96, 64, [105, 373, 192, 128]],
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
    // 800x600 in the settings window's place at 1512x982, 1058.4 by 687.4 from
    // (226.8, 147.3), is bound by its height
    const h = 687.4, w = h * 4 / 3, x = 226.8 + (1058.4 - w) / 2, y = 147.3;
    placed(f, [x, y, w, h]);
    assert.equal(copy.style.borderRadius, '6px', 'the card picture\'s own corners');
    assert.ok(img.classList.contains('picfull-from'), 'the card keeps its picture, hidden in place');
    assert.equal(img.parent, where === 'reply' ? f.reply : f.msg, 'the card picture never leaves the card');
    const [grow] = copy.animations, [dim] = veil(f).animations;
    over(grow.keyframes[0].transform, [100 - x, 200 - y, 400 / w, 300 / h], 'grows from the card picture');
    assert.equal(grow.keyframes[1].transform, 'none');
    same(dim.keyframes, [{ opacity: 0 }, { opacity: 0.62 }]);
    for (const a of [grow, dim]) same(a.timing, { duration: 300, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', fill: 'both' });
  });
}

test('a click or tap anywhere closes it back into the card, with focus as before', () => {
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
    assert.equal(f.doc.activeElement, f.textarea, 'focus is back in the closing press');
    const shrink = big(f).animations.at(-1);
    const [x, y, w, h] = at(f);
    over(shrink.keyframes[1].transform, [100 - x, 180 - y, 400 / w, 300 / h], 'lands on the card picture where it stands now');
    assert.equal(shrink.keyframes[1].opacity, 1);
    assert.equal(shrink.timing.duration, 300);
    same(veil(f).animations.at(-1).keyframes, [{ opacity: '0.62' }, { opacity: 0 }]);
    assert.ok(img.classList.contains('picfull-from'), 'hidden until the copy lands');
    assert.ok(f.state().closing);
    f.press(f.layer());   // a second click while it shrinks changes nothing
    assert.equal(big(f).animations.length, 2);
    shrink.finish();
    assert.equal(big(f), undefined, 'the copy is gone');
    assert.ok(!img.classList.contains('picfull-from'), 'the card picture shows again');
    assert.ok(!f.layer().classList.contains('on'));
    assert.equal(f.state(), null);
    // and the next click opens it again
    f.press(img); assert.ok(f.layer().classList.contains('on'));
  }
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
  big(f).animations.at(-1).finish();
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
  big(f).computed = { transform: 'matrix(0.6, 0, 0, 0.6, 50, 100)' };
  veil(f).computed = { opacity: '0.4' };
  f.key('Escape');
  const shrink = big(f).animations.at(-1);
  assert.equal(grow.playState, 'idle', 'the grow is let go');
  assert.equal(shrink.keyframes[0].transform, 'matrix(0.6, 0, 0, 0.6, 50, 100)');
  assert.equal(shrink.timing.duration, 150);
  same(veil(f).animations.at(-1).keyframes, [{ opacity: '0.4' }, { opacity: 0 }]);
});

test('reduced motion opens and closes at once', () => {
  const f = fixture({ reduced: true });
  const img = f.picture(f.reply);
  f.press(img);
  assert.equal(big(f).animations[0].timing.duration, 0);
  assert.equal(veil(f).animations[0].timing.duration, 0);
  f.key('Escape');
  assert.equal(big(f).animations.at(-1).timing.duration, 0);
});

test('a picture the card drew again while open has no place left, and the copy fades', () => {
  const f = fixture();
  const img = f.picture(f.reply);
  f.press(img);
  img.remove();
  f.key('Escape');
  assert.equal(big(f).animations.at(-1).keyframes[1].opacity, 0);
});

test('a resized window or a turned phone refits the open picture', () => {
  const f = fixture();
  const img = f.picture(f.reply, { w: 800, h: 600 });
  f.press(img);
  f.screen.width = 900; f.screen.height = 600;
  f.win.listeners.filter(l => l.type === 'resize').forEach(l => l.fn({}));
  // the settings window's place at 900x600 is 630 by 420 from (135, 90): height bound
  placed(f, [135 + (630 - 560) / 2, 90, 560, 420]);
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

test('the sheet: the board ink veil, over the board and under the menu, no accent', () => {
  const css = read('card-tokens.css');
  const block = css.slice(css.indexOf("/* a card's picture opened full screen"), css.indexOf('/* ---- the files picked'));
  assert.match(block, /#picfull\{display:none; position:fixed; inset:0; z-index:9000/);
  assert.match(block, /\.picfull-veil\{[^}]*background:var\(--ink\); opacity:0/);
  assert.match(block, /\.picfull-from\{visibility:hidden\}/);
  // the room and the settings read the same two names, so they never part
  assert.match(css, /:root\{--sp-inset:15%\}\n\.sp-veil \.sp-page\{position:absolute; inset:var\(--sp-inset\);/,
    'the settings window stands --sp-inset in from every edge');
  assert.match(block, /#picfull \.picfull-room\{position:absolute; top:var\(--sp-inset\); bottom:var\(--sp-inset\); left:0; right:0;\s+width:var\(--settings-w, calc\(100% - 2 \* var\(--sp-inset\)\)\); margin:0 auto\}/);
  assert.doesNotMatch(block, /safe-area|padding/, 'the room, not a padding, keeps the picture off the edges');
  assert.match(read('m.html'), /:root\{--settings-w:min\(71\.4vw, 289px\)\}\s+#settings\{\s+position:fixed; top:0; bottom:0; right:0; width:var\(--settings-w\);/,
    'the phone drawer and the room share one width');
  assert.doesNotMatch(read('index.html'), /--settings-w|--sp-inset/, 'the desktop room is the settings window, inset alike on every side');
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
