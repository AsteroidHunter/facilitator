// Run the shipped head installer, action tables, link menu and upload handler.
// Native window creation and clipboard I/O are recorded, never performed.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Node, dispatch } = require('./page-event-model.cjs');
const root = process.env.PAGE_GUARD_SOURCE_ROOT || path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('card-logic.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ phone = false, state = 'board', platform = phone ? 'iPhone' : 'MacIntel' } = {}) {
  const win = new Node(null, 'window');
  const doc = new Node(win, 'document');
  doc.baseURI = 'http://127.0.0.1:32123/m';
  const opened = [], copied = [], requests = [], downloaded = [], calls = [];
  function element(tag, parent = null) {
    const node = new Node(parent, tag);
    node.tagName = tag.toUpperCase(); node.children = []; node.attrs = {}; node.style = {};
    node.classList = { add() {}, remove() {}, contains() { return false; } };
    node.setAttribute = (key, value) => { node.attrs[key] = value; };
    node.getAttribute = key => node.attrs[key] ?? null;
    node.hasAttribute = key => key in node.attrs;
    for (const attr of ['href', 'download']) Object.defineProperty(node, attr, {
      get: () => node.attrs[attr], set: value => { node.attrs[attr] = value; },
    });
    node.appendChild = child => { child.parent = node; node.children.push(child); return child; };
    node.remove = () => { node.parent.children = node.parent.children.filter(n => n !== node); node.parent = null; };
    Object.defineProperty(node, 'isConnected', { get: () => !!node.parent });
    node.focus = () => { doc.activeElement = node; };
    node.contains = child => { for (let n = child; n; n = n.parent) if (n === node) return true; return false; };
    node.getBoundingClientRect = () => ({ left: 20, bottom: 30 });
    node.offsetWidth = 160; node.offsetHeight = 100;
    node.matches = selector => selector.split(',').some(s => {
      s = s.trim();
      if (s === 'a[href]') return tag === 'a' && node.hasAttribute('href');
      if (s.startsWith('.cardmd ')) return node.cardmd && s.includes(tag + '[src]');
      if (s === '.cm-editor') return node.className === 'cm-editor';
      if (s === 'textarea') return tag === 'textarea';
      if (s.startsWith('input')) return tag === 'input';
      return false;
    });
    node.closest = selector => { for (let n = node; n && n !== doc; n = n.parent) if (n.matches(selector)) return n; return null; };
    node.querySelectorAll = () => node.children.filter(n => n.tagName === 'BUTTON' && !n.disabled);
    node.querySelector = selector => selector.startsWith('.cm-content') ? node.children.find(n => n.className === 'cm-content' && n.isContentEditable) : node.querySelectorAll()[0];
    node.click = () => {
      const e = dispatch(node, { type: 'click', metaKey: false });
      if (tag === 'a' && !e.defaultPrevented) downloaded.push(node.href);
    };
    if (parent) parent.children.push(node);
    return node;
  }
  doc.documentElement = element('html'); doc.documentElement.parent = doc;
  doc.body = element('body', doc.documentElement); doc.activeElement = doc.body;
  doc.createElement = tag => element(tag);
  win.document = doc;
  win.navigator = { platform, clipboard: { writeText: async url => copied.push(url) } };
  win.location = new URL(doc.baseURI); win.innerWidth = 390; win.innerHeight = 844;
  win.open = (...args) => opened.push(args);
  win.fetch = async (...args) => { requests.push(args); return { ok: true }; };
  const ctx = vm.createContext({ window: win, document: doc, navigator: win.navigator, URL,
    addEventListener: win.addEventListener.bind(win), Date, setTimeout, clearTimeout, setInterval, clearInterval,
    FOCUS: true, boardKeysLive: () => state === 'board', boardResponseCard: () => false,
    ownerReady: true, draft: false, activeOwner: 'one', selectedId: null, lastState: {}, LOCKED: false,
    newCard: () => calls.push('create'), createCard: () => calls.push('create'),
    homeOpen: state === 'home', phoneDeveloperMode: false,
    menuOut: () => state === 'drawer' || state === 'settings' ? 'drawer' : null,
    hideMenu: () => calls.push('close'), drawerOpen: () => state === 'drawer',
  });
  vm.runInContext(source, ctx);
  const html = read(phone ? 'm.html' : 'index.html');
  const installer = html.match(/<script>(installCardPageGuard\(\);)<\/script>/);
  if (installer) vm.runInContext(installer[1], ctx);
  // Run actual board/phone tables and the actual drawer immediate-stop listener.
  if (phone) {
    let start = html.indexOf('const phoneShortcutTyping =');
    let end = html.indexOf('// a tap anywhere on the card', start);
    vm.runInContext(html.slice(start, end), ctx);
    vm.runInContext('addEventListener("keydown", e => dispatchCardShortcut(e, homeOpen ? homeShortcutActions : phoneShortcutActions));', ctx);
  } else {
    const start = html.indexOf('const boardShortcutTyping =');
    const end = html.indexOf('listenResponseScroll();', start);
    vm.runInContext(html.slice(start, end), ctx);
  }
  return { win, doc, ctx, opened, copied, requests, downloaded, calls, element,
    send: (target, over = {}) => dispatch(target || doc.body, { metaKey: false, ...over }),
    menu: () => doc.body.children.find(n => n.className === 'app-link-menu'),
    link(tag = 'a', url = 'https://example.com/path') {
      const node = element(tag, doc.body); node.setAttribute(tag === 'a' ? 'href' : 'src', url);
      node.cardmd = true; return node;
    },
  };
}

for (const surface of ['Mac', 'narrow Mac', 'phone']) {
  const phone = surface !== 'Mac', platform = surface === 'phone' ? 'iPhone' : 'MacIntel';
  for (const state of ['board', 'home', 'settings', 'drawer', 'blank', 'confirmation']) {
    test(`${surface} ${state}: T and Shift+T cancel before every propagation boundary`, () => {
      for (const kind of ['body', 'input', 'textarea', 'title', 'editor', 'note', 'workspace', 'signout']) {
        for (const stop of [null, 'stopPropagation', 'stopImmediatePropagation']) {
          const f = fixture({ phone, state, platform });
          // Blank/confirmation are inactive board states in the Mac table;
          // phone overlays stop at their field before its underlying table.
          const field = f.element(kind, f.doc.body);
          if (stop) field.addEventListener('keydown', e => e[stop](), true);
          for (const shiftKey of [false, true]) {
            const e = f.send(field, { key: shiftKey ? 'T' : 't', code: 'KeyT', metaKey: true, shiftKey });
            assert.equal(e.defaultPrevented, true, `${kind}/${stop}/${shiftKey}`);
          }
          if (!stop && state === 'board') assert.equal(f.calls.filter(x => x === 'create').length, 2);
          if (stop || ['home', 'settings', 'drawer'].includes(state)) assert.deepEqual(f.calls, []);
        }
      }
    });
  }
  test(`${surface} uses the same exact layout matcher for cancellation and card creation`, () => {
    const f = fixture({ phone, platform });
    for (const key of ['t', 'T', 'е', 'Unidentified'])
      assert.equal(f.send(null, { key, code: 'KeyT', metaKey: true }).defaultPrevented, true);
    assert.equal(f.calls.length, 4);
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: false }, { key: 'f' }]) {
      const e = f.send(null, { key: 't', code: 'KeyT', metaKey: true, ...extra });
      assert.equal(e.defaultPrevented, false);
    }
    assert.equal(f.calls.length, 4);
  });
}

test('Mac View Source and New Tab Group cancel even at immediate stops; adjacent chords stay available', () => {
  const f = fixture({ state: 'home' });
  const input = f.element('input', f.doc.body);
  input.addEventListener('keydown', e => e.stopImmediatePropagation(), true);
  for (const chord of [{ key: 'Dead', code: 'KeyU', altKey: true }, { key: 'p', code: 'KeyP', ctrlKey: true }]) {
    assert.equal(f.send(input, { metaKey: true, ...chord }).defaultPrevented, true);
    assert.equal(f.send(input, { metaKey: true, ...chord, shiftKey: true }).defaultPrevented, false);
  }
  for (const key of ['f', 'r', 'w', 'q', 'h', 'm', 'c', 'v', 'z'])
    assert.equal(f.send(input, { key, code: 'Key' + key.toUpperCase(), metaKey: true }).defaultPrevented, false);
});

test('drawer Escape cancels before its immediate stop and still closes or blurs', () => {
  for (const state of ['drawer', 'settings']) {
    const f = fixture({ phone: true, state });
    assert.equal(f.send(null, { key: 'Escape' }).defaultPrevented, true);
    assert.deepEqual(f.calls, ['close']);
    const field = f.element('textarea', f.doc.body);
    assert.equal(f.send(field, { key: 'Escape' }).defaultPrevented, true);
    assert.equal(field.blurs, 1);
    assert.deepEqual(f.calls, ['close']);
  }
});

const activations = [
  { type: 'click' }, { type: 'keydown', key: 'Enter' }, { type: 'keydown', key: 'Enter', metaKey: true },
  ...[{ metaKey: true }, { metaKey: true, shiftKey: true }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }].map(x => ({ type: 'click', ...x })),
  { type: 'auxclick', button: 1 }, { type: 'auxclick', button: 1, shiftKey: true },
  { type: 'auxclick', button: 2 }, { type: 'contextmenu' }, { type: 'dragstart' },
];
for (const phone of [false, true]) {
  for (const kind of ['reply', 'attachment', 'editor', 'license', 'image']) {
    test(`${phone ? 'phone' : 'Mac'} ${kind}: every activation cancels and shows only app actions`, () => {
      for (const event of activations) {
        const f = fixture({ phone, state: 'home' }), link = f.link(kind === 'image' ? 'img' : 'a');
        if (kind === 'attachment') link.setAttribute('download', '');
        link.addEventListener(event.type, () => assert.fail('activation reached a link handler'));
        const e = f.send(link, event);
        assert.equal(e.defaultPrevented, true, JSON.stringify(event));
        const menu = f.menu(); assert.ok(menu, JSON.stringify(event));
        assert.deepEqual(menu.children.filter(n => n.tagName === 'BUTTON').map(n => n.textContent), ['Copy link', 'Open in browser']);
        assert.deepEqual(f.opened, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.downloaded, []);
      }
    });
  }
}

test('copy, Mac external window, phone handoff and attachment download require a menu choice', async () => {
  for (const phone of [false, true]) {
    const f = fixture({ phone, state: 'home' }), link = f.link();
    f.send(link, { type: 'click' }); f.menu().children[0].click(); await tick();
    assert.deepEqual(f.copied, ['https://example.com/path']); assert.deepEqual(f.opened, []);
    f.send(link, { type: 'click' }); f.menu().children[1].click(); await tick();
    if (phone) { assert.deepEqual(f.opened, [['https://example.com/path', '_blank', 'noopener,noreferrer']]); assert.equal(f.requests.length, 0); }
    else { assert.equal(f.opened.length, 0); assert.equal(f.requests[0][0], '/open-in-browser'); assert.equal(f.requests[0][1].body, 'https://example.com/path'); }
    const attachment = f.link('a', '/uploads/example.pdf?download=1'); attachment.setAttribute('download', '');
    f.send(attachment, { type: 'click', altKey: true });
    assert.equal(f.downloaded.length, 0);
    assert.equal(f.menu().children[2].textContent, 'Download');
    f.menu().children[2].click(); await tick();
    assert.deepEqual(f.downloaded, ['http://127.0.0.1:32123/uploads/example.pdf?download=1']);
  }
});

test('menu keyboard navigation, dismissal, unsafe addresses and external-open failure', async () => {
  const f = fixture({ state: 'home' }), link = f.link();
  link.focus(); f.send(link, { type: 'keydown', key: 'Enter' });
  const first = f.doc.activeElement;
  f.send(first, { key: 'ArrowDown' }); assert.equal(f.doc.activeElement.textContent, 'Open in browser');
  f.send(f.doc.activeElement, { key: 'Escape' }); assert.equal(f.menu(), undefined); assert.equal(f.doc.activeElement, link);
  f.send(link, { type: 'click' }); f.send(f.doc.body, { type: 'pointerdown' }); assert.equal(f.menu(), undefined);
  f.send(f.link('a', 'javascript:alert(1)'), { type: 'click' });
  assert.equal(f.menu().children[0].disabled, true); assert.equal(f.opened.length, 0);
  f.win.fetch = async () => ({ ok: false, json: async () => ({ error: 'Could not open Chrome. Try Copy link.' }) });
  f.send(link, { type: 'click' }); f.menu().children[1].click(); await tick();
  assert.match(f.menu().children.at(-1).textContent, /Could not open Chrome/);
});

for (const phone of [false, true]) {
  test(`${phone ? 'phone' : 'Mac'} cancels unhandled navigation drops but keeps real attachment and text workflows`, () => {
    const f = fixture({ phone, state: 'home' });
    for (const types of [['Files'], ['text/uri-list'], ['text/plain'], ['text/html']]) {
      const target = f.element('div', f.doc.body);
      target.addEventListener('drop', e => e.stopImmediatePropagation());
      for (const type of ['dragover', 'drop']) assert.equal(f.send(target, { type, dataTransfer: { types } }).defaultPrevented, true);
    }
    for (const kind of ['textarea', 'input', 'formatted', 'file-editor']) {
      const field = f.element(kind, f.doc.body);
      field.isContentEditable = ['formatted', 'file-editor'].includes(kind);
      for (const type of ['dragover', 'drop'])
        assert.equal(f.send(field, { type, dataTransfer: { types: ['text/plain', 'text/uri-list'] } }).defaultPrevented, false);
      let picked;
      f.ctx.wireAttachmentTransfer(field, files => { picked = files; });
      const file = { name: 'picture.png' };
      const e = f.send(field, { type: 'drop', dataTransfer: { types: ['Files'], files: [file] } });
      assert.equal(e.defaultPrevented, true); assert.equal(picked[0], file);
    }
    const editor = f.element('div', f.doc.body); editor.className = 'cm-editor';
    const content = f.element('div', editor); content.className = 'cm-content'; content.isContentEditable = true;
    const gutter = f.element('div', editor);
    assert.equal(f.send(gutter, { type: 'drop', dataTransfer: { types: ['text/plain'] } }).defaultPrevented, false);
    content.isContentEditable = false;
    assert.equal(f.send(gutter, { type: 'drop', dataTransfer: { types: ['text/plain'] } }).defaultPrevented, true);
    const rich = f.element('div', f.doc.body); rich.isContentEditable = true;
    const noneditable = f.element('div', rich);
    assert.equal(f.send(noneditable, { type: 'drop', dataTransfer: { types: ['text/plain'] } }).defaultPrevented, true);
    const readonly = f.element('textarea', f.doc.body); readonly.readOnly = true;
    assert.equal(f.send(readonly, { type: 'drop', dataTransfer: { types: ['text/plain'] } }).defaultPrevented, true);
  });
}

test('both documents install before body handlers, and phone roots suppress overscroll', () => {
  for (const name of ['index.html', 'm.html']) {
    const html = read(name);
    assert.ok(html.indexOf('installCardPageGuard();') > 0);
    assert.ok(html.indexOf('installCardPageGuard();') < html.indexOf('</head>'));
    assert.equal((html.match(/src="\/card-logic.js"/g) || []).length, 1);
  }
  assert.match(read('m.html'), /html, body\s*\{overscroll-behavior:\s*none/);
  const css = read('card-tokens.css').split('/* The link menu')[1];
  assert.match(css, /-webkit-touch-callout:none/);
  assert.doesNotMatch(css, /--accent|432BFF/i);
});
