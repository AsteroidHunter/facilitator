// Source geometry and real handlers in a VM. No browser or live board.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = process.env.DOCKED_ARROW_SOURCE || path.resolve(__dirname, '..');
const source = name => readFileSync(path.join(ROOT, name), 'utf8');
const html = source('m.html'), css = source('card-tokens.css');
const views = ['todo', 'docked', 'deferred', 'done'];
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source anchors: ${start}, ${end}`);
  return text.slice(a, b);
}
function rule(text, selector) {
  const body = between(text, selector + '{', '}').slice(selector.length + 1);
  return Object.fromEntries(body.split(';').filter(s => s.includes(':')).map(s => {
    const at = s.indexOf(':'); return [s.slice(0, at).trim(), s.slice(at + 1).trim()];
  }));
}
function element() {
  const classes = new Set(), attrs = new Map(), listeners = new Map();
  return { style: { setProperty(k, v) { this[k] = v; } }, animations: [], dataset: {}, inert: false,
    offsetLeft: 10, offsetWidth: 290, clientHeight: 800,
    classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle(c, on = !classes.has(c)) { on ? classes.add(c) : classes.delete(c); } },
    setAttribute(k, v) { attrs.set(k, v); }, getAttribute: k => attrs.get(k),
    addEventListener(k, fn) { const list = listeners.get(k) || []; list.push(fn); listeners.set(k, list); },
    fire(k, extra = {}) { for (const fn of listeners.get(k) || []) fn({ target: this, ...extra }); },
    getBoundingClientRect: () => ({ width: 300 }), getAnimations() { return this.animations; },
    querySelector: () => null,
  };
}
function header(page) {
  const nodes = Object.fromEntries([...views.map(v => 'tv-' + v), 'tik-page', 'tiklabels', 'tiksheet'].map(id => [id, element()]));
  const stored = new Map(), timers = new Map(), calls = []; let now = 0, serial = 0;
  const ctx = vm.createContext({
    document: { getElementById: id => nodes[id] }, window: {},
    localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) },
    setTimeout(fn, ms) { timers.set(++serial, { fn, due: now + ms }); return serial; },
    clearTimeout: id => timers.delete(id), activeOwner: 'one', selectedId: 'card', lastState: {},
    apply: () => calls.push('apply'), renderTickets: () => calls.push('render'),
    cancelAutoNext: () => calls.push('cancel-next'), dropResponseScroll: () => calls.push('stop-scroll'),
  });
  const logic = source('card-logic.js');
  vm.runInContext(between(logic, 'const TICKET_VIEWS =', '// the doing, docked, deferred and done sections filter'), ctx);
  const pageSource = source(page);
  const start = page === 'm.html' ? 'function setView(v){' : '  const setView = v => {';
  const handlers = between(pageSource, start, '// press feedback,');
  vm.runInContext(handlers, ctx);
  ctx.paintViewTabs(); ctx.moveTicketSheet('todo', false);
  return { ctx, nodes, stored, calls, timers,
    click: name => nodes[name === 'arrow' ? 'tik-page' : 'tv-' + name].fire('click'),
    page: () => nodes['tik-page'].classList.contains('back') ? 1 : 0,
    advance(ms) { now += ms; for (const [id, task] of [...timers]) if (task.due <= now) { timers.delete(id); task.fn(); } },
  };
}

for (const page of ['index.html', 'm.html']) {
  test(`${page}: names occupy the middle 80 percent and cannot hit either arrow`, () => {
    const markup = between(source(page), '<div id="tikhead">', '<div id="tiklist">');
    assert.match(markup, /id="tiknames"><div id="tiklabels"><div class="tikpair">/);
    assert.equal((markup.match(/class="tikpair"/g) || []).length, 2);
    assert.match(markup, /<\/div><\/div><\/div><button id="tik-page"/);
    const names = rule(css, '#tiknames'), pair = rule(css, '#tiklabels .tikpair');
    assert.equal(names.margin, '0 max(10%, var(--bar-mark))');
    assert.equal(names.overflow, 'clip'); assert.equal(names['min-width'], '0');
    assert.equal(pair.flex, '0 0 100%');
    assert.equal(rule(css, '#tikhead .tvb')['min-width'], '0');
    const mark = page === 'index.html' ? 10 : 9.85;
    for (const width of [100, 180, 289, 320, 390, 640, 1440]) {
      const inset = Math.max(width * .1, mark);
      assert.ok(Math.abs(width - 2 * inset - width * .8) < 1e-9);
      assert.ok(inset >= mark && width - inset <= width - mark);
    }
    assert.match(rule(css, '#tiklabels').transition, /transform \.24s var\(--gentle\)/);
    assert.match(css, /prefers-reduced-motion: reduce\)\{#tiklabels\{transition:none\}/);
  });

  test(`${page}: arrows move only the names from every selected list, including after polls`, () => {
    for (const view of views) {
      const f = header(page); f.ctx.setTicketViewOf('one', view); f.ctx.paintViewTabs(); f.ctx.moveTicketSheet(view, false);
      const originalPage = f.page(), transform = f.nodes.tiksheet.style.transform, saved = [...f.stored];
      f.click('arrow'); f.ctx.paintViewTabs();
      assert.equal(f.ctx.curView(), view); assert.equal(f.nodes.tiksheet.style.transform, transform);
      assert.equal(f.ctx.selectedId, 'card'); assert.deepEqual([...f.stored], saved); assert.deepEqual(f.calls, []);
      assert.equal(f.page(), 1 - originalPage);
      assert.equal(f.nodes.tiklabels.style.transform, `translateX(${-(1 - originalPage) * 100}%)`);
      for (const name of views) {
        assert.equal(f.nodes['tv-' + name].inert, (views.indexOf(name) >= 2 ? 1 : 0) !== f.page());
        assert.equal(f.nodes['tv-' + name].classList.contains('on'), name === view);
      }
      f.click('arrow'); assert.equal(f.page(), originalPage); assert.equal(f.ctx.curView(), view);
    }
  });

  test(`${page}: an unchosen right-arrow visit returns at 30 seconds and leaves the list alone`, () => {
    for (const view of views) {
      const f = header(page); f.ctx.setTicketViewOf('one', view); f.ctx.paintViewTabs(); f.ctx.moveTicketSheet(view, false);
      if (f.page()) f.click('arrow');
      const transform = f.nodes.tiksheet.style.transform;
      f.click('arrow'); f.advance(29999); f.ctx.paintViewTabs(); assert.equal(f.page(), 1);
      f.advance(1); assert.equal(f.page(), 0); assert.equal(f.nodes.tiklabels.style.transform, 'translateX(0%)');
      f.ctx.paintViewTabs(); assert.equal(f.page(), 0, 'a poll must not undo the automatic return');
      assert.equal(f.ctx.curView(), view); assert.equal(f.nodes.tiksheet.style.transform, transform);
      assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
    }
  });

  for (const name of ['deferred', 'done']) test(`${page}: choosing ${name} cancels the return, even when already selected`, () => {
    for (const initial of ['todo', name]) {
      const f = header(page); f.ctx.setTicketViewOf('one', initial); f.ctx.paintViewTabs();
      if (f.page()) f.click('arrow');
      f.click('arrow'); assert.equal(f.timers.size, 1, 'the unchosen visit has a pending return');
      f.advance(20000); f.click(name); assert.equal(f.timers.size, 0); f.advance(60000);
      assert.equal(f.ctx.curView(), name); assert.equal(f.page(), 1); assert.equal(f.timers.size, 0);
      assert.equal(f.nodes.tiksheet.style.transform, `translateX(${-views.indexOf(name) * 100}%)`);
    }
  });

  test(`${page}: left-arrow cancellation and a fresh visit use a fresh deadline`, () => {
    const f = header(page); f.click('arrow'); f.advance(20000); f.click('arrow');
    assert.equal(f.timers.size, 0); f.click('arrow'); f.advance(10000); assert.equal(f.page(), 1);
    f.advance(19999); assert.equal(f.page(), 1); f.advance(1); assert.equal(f.page(), 0);
  });

  test(`${page}: a project switch cancels the previous project's return`, () => {
    const f = header(page); f.click('arrow'); f.advance(10000);
    f.ctx.activeOwner = 'two'; f.ctx.setTicketViewOf('two', 'done'); f.ctx.paintViewTabs();
    f.advance(30000); assert.equal(f.ctx.curView(), 'done'); assert.equal(f.page(), 1); assert.equal(f.timers.size, 0);
  });
}

test('the triangle has a native-free mark-sized box on Mac and inherits the same scaled mark as the phone sun and moon', () => {
  const arrow = rule(css, '#tikhead #tik-page');
  assert.equal(arrow.appearance, 'none', 'Mac native button drawing must not alter the triangle');
  assert.equal(arrow['-webkit-appearance'], 'none'); assert.equal(arrow['box-sizing'], 'border-box');
  assert.equal(arrow.width, 'var(--bar-mark)'); assert.equal(arrow.height, 'var(--bar-mark)');
  for (const key of ['padding', 'margin', 'border', 'border-radius', 'min-width', 'min-height']) assert.equal(arrow[key], '0');
  assert.equal(arrow['clip-path'], 'polygon(0 0, 100% 50%, 0 100%)');
  assert.equal(arrow.right, '0'); assert.equal(arrow.left, 'auto');
  assert.equal(arrow.top, 'calc(50% + 3 * var(--u))'); assert.equal(arrow.transform, 'translateY(-50%)');
  const back = rule(css, '#tikhead #tik-page.back');
  assert.equal(back.left, '0'); assert.equal(back.right, 'auto'); assert.equal(back.transform, 'translateY(-50%) scaleX(-1)');
  const mark = Number(/--bar-mark:([\d.]+)px/.exec(css)[1]); assert.equal(mark, 10);
  assert.match(source('index.html'), /svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/);
  assert.match(html, /--full-bar-mark:var\(--bar-mark\)/);
  assert.match(html, /#page, #projmenu\{[^}]*--bar-mark:calc\(var\(--full-bar-mark\) \* var\(--rest\)\)/);
  assert.match(html, /svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/);
  assert.match(between(html, '<div id="page">', '<div id="tikhead">'), /<div id="tikwin"><aside id="tickets"/);
  assert.equal(mark * (1 - Number(/--sink:([\d.]+)/.exec(html)[1])), 9.85);
  assert.doesNotMatch(between(css, '#tiknames{', '/* ---- the owner'), /--accent|432BFF/);
});

function drawer() {
  const nodes = Object.fromEntries(['page', 'pane', 'tickets', 'tikwin', 'settings', 'scrim', 'tikbtn', 'setbtn', 'setpage', 'setsrc'].map(id => [id, element()]));
  nodes.tickets.dataset.side = 'left'; nodes.settings.dataset.side = 'right';
  const document = element(); document.body = element(); document.documentElement = element();
  document.getElementById = id => nodes[id];
  const ctx = vm.createContext({ document, macHost: null, homeOpen: false, lastState: null, lastTicketTap: null, innerWidth: 390,
    addEventListener() {}, getComputedStyle: () => ({ getPropertyValue: () => '.015' }),
    tracePhone() {}, endPhoneTrace() {}, traceFrameOpportunity() {}, dropResponseScroll() {}, closeProjects() {}, editing: () => false,
    settingsPage: () => ({ reset() {} }), performance: { now: () => 1 },
  });
  vm.runInContext(between(html, 'const page = document.getElementById("page");', "// the list's fades, the board's own:"), ctx);
  return { nodes, document, ctx, open: () => nodes.tikbtn.fire('click'), close: () => ctx.closeDrawer(),
    settled: () => nodes.tickets.classList.contains('drawer-settled'),
    move(x) { document.fire('mousedown', { button: 0, clientX: 200, clientY: 200, timeStamp: 100 });
      document.fire('mousemove', { clientX: x, clientY: 200, timeStamp: 200 }); },
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function moving(el) {
  let resolve, reject;
  const animation = { transitionProperty: 'transform', finished: new Promise((yes, no) => { resolve = yes; reject = no; }) };
  el.animations = [animation];
  return { finish() { el.animations = []; resolve(); }, cancel() { el.animations = []; reject(new Error('cancelled')); } };
}

test('phone and narrow Mac hide the arrow by default and reveal it only after every opening layer finishes', async () => {
  assert.equal(rule(html, '#tickets #tik-page').visibility, 'hidden');
  assert.equal(rule(html, '#tickets #tik-page')['pointer-events'], 'none');
  assert.equal(rule(html, '#tickets.open.drawer-settled #tik-page').visibility, 'visible');
  assert.equal(rule(html, '#tickets.open.drawer-settled #tik-page')['pointer-events'], 'auto');
  const f = drawer(), runs = ['tickets', 'tikwin', 'pane'].map(id => moving(f.nodes[id]));
  assert.equal(f.settled(), false); f.open(); await flush(); assert.equal(f.settled(), false);
  runs[0].finish(); await flush(); assert.equal(f.settled(), false);
  runs[1].finish(); await flush(); assert.equal(f.settled(), false);
  runs[2].finish(); await flush(); assert.equal(f.settled(), true);
  f.close(); assert.equal(f.settled(), false, 'closing must hide the arrow synchronously');
});

test('phone arrow hides at the first closing drag and returns after a fully open release without a transition', async () => {
  const f = drawer(); f.open(); await flush(); assert.equal(f.settled(), true);
  f.move(190); assert.equal(f.settled(), false);
  f.ctx.runMenu(f.nodes.tickets, 1, true); await flush(); assert.equal(f.settled(), true);
  f.ctx.homeOpen = true; f.ctx.syncMenuAvailability(); assert.equal(f.settled(), false);
});

test('a cancelled opening or an old completed opening cannot expose an arrow during a new run', async () => {
  const f = drawer(), old = moving(f.nodes.tickets); f.open();
  f.close(); const fresh = moving(f.nodes.tickets); f.open();
  old.finish(); await flush(); assert.equal(f.settled(), false);
  fresh.finish(); await flush(); assert.equal(f.settled(), true);
  f.close(); const cancelled = moving(f.nodes.tickets); f.open(); cancelled.cancel();
  await flush(); assert.equal(f.settled(), false);
});
