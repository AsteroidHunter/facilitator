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
// Resolve the layout declarations against several viewport widths and pixel
// densities. This compares the arrow vertices with the actual ticket border
// boxes, not merely with right:0 on a wider ancestor. It is not a browser layout.
const parsedStyles = new Map();
function declarations(text, selector) {
  if (!parsedStyles.has(text)) {
    const styles = text.includes('<style')
      ? [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') : text;
    parsedStyles.set(text, [...styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]);
  }
  const out = {};
  for (const match of parsedStyles.get(text)) {
    if (match[1].split(',').map(s => s.trim()).includes(selector)) Object.assign(out, rule(selector + '{' + match[2] + '}', selector));
  }
  return out;
}
function terms(value) {
  const result = []; let term = '', depth = 0;
  for (const char of value) {
    if (/\s/.test(char) && depth === 0) { if (term) result.push(term); term = ''; }
    else { term += char; if (char === '(') depth++; if (char === ')') depth--; }
  }
  if (term) result.push(term);
  return result;
}
function sides(value = '0') {
  const v = terms(value);
  return [v[0], v[1] || v[0], v[2] || v[0], v[3] || v[1] || v[0]];
}
const cssMath = vm.createContext({ max: Math.max });
function length(value, vars, viewport, percent = 0) {
  let expr = value.replace(/var\((--[\w-]+)\)/g, (_, key) => {
    assert.ok(key in vars, 'missing length token: ' + key);
    return '(' + length(vars[key], vars, viewport, percent) + ')';
  }).replace(/calc\(/g, '(').replace(/([\d.]+)vw/g, (_, n) => String(n * viewport / 100))
    .replace(/([\d.]+)%/g, (_, n) => String(n * percent / 100)).replace(/px/g, '');
  assert.match(expr, /^[\d\s.+*/(),-]+$|^max\([\d\s.+*/(),-]+\)$/);
  return vm.runInContext(expr, cssMath);
}
function geometry(page, viewport, width, edge) {
  const pageSource = source(page);
  const holder = declarations(pageSource, page === 'index.html' ? 'body.focus #tickets' : '#tickets');
  const vars = { '--u': page === 'index.html' ? '1px' : '.985px', '--ch': '900px',
    '--edge-drawn': edge + 'px', '--bar-mark': page === 'index.html' ? '10px' : '9.85px',
    ...Object.fromEntries(Object.entries(holder).filter(([key]) => key.startsWith('--'))),
    ...Object.fromEntries(Object.entries(declarations(pageSource, '#tiklist')).filter(([key]) => key.startsWith('--'))),
  };
  const px = (v, pct = width) => length(v, vars, viewport, pct);
  const list = sides(declarations(pageSource, '#tiklist').margin).map(v => px(v));
  const pane = sides(declarations(pageSource, '.tikpane').padding).map(v => px(v));
  const row = { left: list[3] + pane[3], right: width - list[1] - pane[1] };
  const head = { ...declarations(pageSource, '#tikhead'), ...declarations(css, '#tikhead') };
  const margin = sides(head.margin).map(v => px(v));
  const headLeft = margin[3], headRight = width - margin[1], headWidth = headRight - headLeft;
  const arrow = { ...declarations(css, '#tikhead #tik-page'), ...declarations(css, '#tikhead .tik-page') };
  const back = { ...arrow, ...declarations(css, '#tikhead #tik-page.back'), ...declarations(css, '#tikhead .tik-page.back') };
  const w = px(arrow.width), h = px(arrow.height);
  const right = headRight - px(arrow.right), left = headLeft + px(back.left);
  // The polygon's pointing vertex is at (w, h/2); scaleX(-1) mirrors it
  // around the centre of the left button, placing its pointing vertex at 0.
  assert.equal(arrow['clip-path'], 'polygon(0 0, 100% 50%, 0 100%)');
  assert.equal(back.transform, 'translateY(-50%) scaleX(-1)');
  const nameMargin = sides(declarations(css, '#tiknames').margin).map(v => px(v, headWidth));
  const topPad = px(sides(head.padding)[0]), nameHeight = 29 * px('var(--u)');
  const centre = px(arrow.top, topPad + nameHeight); // translateY(-h/2) cancels the tip's h/2
  return { row, left, right, w, h, centre, nameCentre: topPad + nameHeight / 2,
    names: { left: headLeft + nameMargin[3], right: headRight - nameMargin[1] } };
}
function element() {
  const classes = new Set(), attrs = new Map(), listeners = new Map();
  return { style: { setProperty(k, v) { this[k] = v; } }, animations: [], dataset: {}, inert: false,
    offsetLeft: 10, offsetWidth: 290, clientHeight: 800,
    classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle(c, on = !classes.has(c)) { on ? classes.add(c) : classes.delete(c); } },
    setAttribute(k, v) { attrs.set(k, v); }, getAttribute: k => attrs.get(k), removeAttribute: k => attrs.delete(k),
    addEventListener(k, fn) { const list = listeners.get(k) || []; list.push(fn); listeners.set(k, list); },
    fire(k, extra = {}) { for (const fn of listeners.get(k) || []) fn({ target: this, ...extra }); },
    getBoundingClientRect: () => ({ width: 300 }), getAnimations() { return this.animations; },
    querySelector: () => null,
  };
}
function header(page) {
  const nodes = Object.fromEntries([...views.map(v => 'tv-' + v), 'tik-page', 'tik-page-back', 'tiklabels', 'tiksheet', 'tickets'].map(id => [id, element()]));
  nodes.tickets.classList.add('open', 'drawer-settled');
  for (const match of source(page).matchAll(/<button id="(tik-page(?:-back)?)"([^>]*)>/g)) {
    for (const attr of match[2].matchAll(/([\w-]+)="([^"]*)"/g)) {
      nodes[match[1]].setAttribute(attr[1], attr[2]);
      if (attr[1] === 'class') nodes[match[1]].classList.add(...attr[2].split(' '));
    }
  }
  const stored = new Map(), timers = new Map(), calls = []; let now = 0, serial = 0;
  const ctx = vm.createContext({
    document: { getElementById: id => nodes[id] }, window: {},
    tickets: nodes.tickets, drawerOpen: () => nodes.tickets.classList.contains('open'),
    localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) },
    setTimeout(fn, ms) { timers.set(++serial, { fn, due: now + ms }); return serial; },
    clearTimeout: id => timers.delete(id), activeOwner: 'one', selectedId: 'card', lastState: {},
    apply: () => calls.push('apply'), renderTickets: () => calls.push('render'),
    cancelAutoNext: () => calls.push('cancel-next'), dropResponseScroll: () => calls.push('stop-scroll'),
  });
  const logic = source('card-logic.js');
  vm.runInContext(between(logic, 'function chipOff(', '// the sun, built'), ctx);
  vm.runInContext(between(logic, 'const TICKET_VIEWS =', '// the doing, docked, deferred and done sections filter'), ctx);
  const pageSource = source(page);
  const start = page === 'm.html' ? 'function setView(v){' : '  const setView = v => {';
  const handlers = between(pageSource, start, '// press feedback,');
  vm.runInContext(handlers, ctx);
  ctx.paintViewTabs(); ctx.moveTicketSheet('todo', false);
  return { ctx, nodes, stored, calls, timers,
    click: name => nodes[name === 'right' ? 'tik-page' : name === 'left' ? 'tik-page-back' : name === 'arrow'
      ? (nodes.tiklabels.style.transform === 'translateX(-100%)' ? 'tik-page-back' : 'tik-page') : 'tv-' + name].fire('click'),
    page: () => nodes.tiklabels.style.transform === 'translateX(-100%)' ? 1 : 0,
    advance(ms) { now += ms; for (const [id, task] of [...timers]) if (task.due <= now) { timers.delete(id); task.fn(); } },
  };
}

for (const page of ['index.html', 'm.html']) {
  for (const direction of ['right', 'left']) test(`${page}: the ${direction} arrow tip meets the ticket box edge and its whole triangle stays inside`, () => {
    for (const viewport of [320, 390, 640, 1024, 1440, 2560]) {
      for (const width of [100, 180, 289, 390]) for (const edge of [1, .5, 2 / 3]) {
        const g = geometry(page, viewport, width, edge);
        assert.ok(Math.abs(g[direction] - g.row[direction]) < 1e-9,
          `${direction} tip ${g[direction]} must meet ticket ${direction} ${g.row[direction]} at viewport ${viewport}`);
        assert.ok(g.right - g.w >= g.row.left && g.left + g.w <= g.row.right);
        assert.ok(g.names.left >= g.left + g.w && g.names.right <= g.right - g.w);
        const inset = Math.max((g.row.right - g.row.left) * .1, g.w);
        assert.ok(Math.abs(g.names.left - g.row.left - inset) < 1e-9);
        assert.ok(Math.abs(g.row.right - g.names.right - inset) < 1e-9);
        assert.ok(Math.abs(g.centre - g.nameCentre) < 1e-9);
      }
    }
  });

  test(`${page}: both fixed arrows remain present on both name pages and the inactive arrow skips focus`, () => {
    const markup = between(source(page), '<div id="tikhead">', '<div id="tiklist">');
    for (const [id, label] of [['tik-page-back', 'Doing and Docked'], ['tik-page', 'Deferred and Done']]) {
      const buttons = [...markup.matchAll(new RegExp(`<button id="${id}"([^>]*)>`, 'g'))];
      assert.equal(buttons.length, 1, id + ' must be present exactly once');
      assert.match(buttons[0][1], /class="[^"]*\btik-page\b/);
      assert.ok(buttons[0][1].includes(`aria-label="show ${label}"`));
      assert.doesNotMatch(buttons[0][1], /\s(?:hidden|inert)(?:\s|=|$)/);
    }
    assert.match(markup, /id="tik-page-back"[^>]*aria-disabled="true" tabindex="-1"/);
    const f = header(page);
    for (const target of [0, 1, 0, 1]) {
      if (target !== f.page()) f.click(target ? 'right' : 'left');
      for (const [id, off] of [['tik-page-back', target === 0], ['tik-page', target === 1]]) {
        const arrow = f.nodes[id];
        assert.equal(arrow.getAttribute('aria-disabled') === 'true', off);
        assert.equal(arrow.tabIndex, off ? -1 : 0);
        assert.equal(arrow.inert, false, 'disabled arrows still remain visible');
        assert.notEqual(arrow.hidden, true);
        assert.notEqual(arrow.style.display, 'none');
        assert.equal(arrow.classList.contains('back'), id === 'tik-page-back', 'direction must stay fixed');
      }
    }
  });

  test(`${page}: clicking either inactive arrow changes no state and cannot cancel or extend the return`, () => {
    const f = header(page);
    f.click('left');
    assert.equal(f.page(), 0); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls, []);
    f.click('right'); f.advance(20000);
    const timers = [...f.timers], saved = [...f.stored], sheet = f.nodes.tiksheet.style.transform;
    f.click('right'); f.click('right');
    assert.equal(f.page(), 1); assert.deepEqual([...f.timers], timers);
    assert.deepEqual([...f.stored], saved); assert.equal(f.nodes.tiksheet.style.transform, sheet);
    assert.equal(f.ctx.selectedId, 'card'); assert.deepEqual(f.calls, []);
    f.advance(9999); assert.equal(f.page(), 1); f.advance(1); assert.equal(f.page(), 0);
    assert.equal(f.nodes['tik-page-back'].tabIndex, -1); assert.equal(f.nodes['tik-page'].tabIndex, 0);
    f.click('left'); assert.equal(f.page(), 0); assert.equal(f.timers.size, 0);
  });

  test(`${page}: names occupy the middle 80 percent and cannot hit either arrow`, () => {
    const markup = between(source(page), '<div id="tikhead">', '<div id="tiklist">');
    assert.match(markup, /id="tiknames"><div id="tiklabels"><div class="tikpair">/);
    assert.equal((markup.match(/class="tikpair"/g) || []).length, 2);
    assert.match(markup, /<\/div><\/div><\/div><button id="tik-page-back"/);
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

test('inactive arrows reuse the sun fade and cursor, with no hover or press feedback', () => {
  const off = rule(css, '#tikhead .tik-page[aria-disabled="true"]');
  assert.equal(Number(/--chipoff:([\d.]+);/.exec(css)[1]), .28);
  for (const [page, selector] of [
    ['index.html', 'body.focus .box.sel :is(.sunbtn, .dockbtn, .arcbtn, .xbtn)[aria-disabled="true"]'],
    ['m.html', '.box :is(.sunbtn, .dockbtn, .arcbtn, .xbtn)[aria-disabled="true"]'],
  ]) {
    const sun = rule(source(page), selector);
    assert.equal(off.opacity, sun.opacity); assert.equal(off.cursor, sun.cursor);
  }
  assert.equal(off.opacity, 'var(--chipoff)'); assert.equal(off.cursor, 'default');
  const arrowRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].includes('.tik-page'));
  for (const match of arrowRules) {
    assert.doesNotMatch(match[2], /(?:display\s*:\s*none|visibility\s*:\s*hidden)/);
    if (/:hover|:active|:focus/.test(match[1])) assert.match(match[1], /:not\(\[aria-disabled="true"\]\)/);
  }
  assert.equal(rule(css, '#tikhead .tik-page')['--qn-edge'], '.6');
  assert.equal(rule(css, '#tikhead .tik-page:not([aria-disabled="true"]):active')['--qn-edge'], '.35');
  assert.match(between(source('card-logic.js'), 'function slideTicketNames(', 'const TICKET_VIEW_KEY'), /if \(chipOff\(arrow\)\) return;/);
});

test('the triangle has a native-free mark-sized box on Mac and inherits the same scaled mark as the phone sun and moon', () => {
  const arrow = rule(css, '#tikhead .tik-page');
  assert.equal(arrow.appearance, 'none', 'Mac native button drawing must not alter the triangle');
  assert.equal(arrow['-webkit-appearance'], 'none'); assert.equal(arrow['box-sizing'], 'border-box');
  assert.equal(arrow.width, 'var(--bar-mark)'); assert.equal(arrow.height, 'var(--bar-mark)');
  for (const key of ['padding', 'margin', 'border', 'border-radius', 'min-width', 'min-height']) assert.equal(arrow[key], '0');
  assert.equal(arrow['clip-path'], 'polygon(0 0, 100% 50%, 0 100%)');
  assert.equal(arrow.right, '0'); assert.equal(arrow.left, 'auto');
  assert.equal(arrow.top, 'calc(50% + 3 * var(--u))'); assert.equal(arrow.transform, 'translateY(-50%)');
  const back = rule(css, '#tikhead .tik-page.back');
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

test('phone and narrow Mac fade both arrows while keeping them unclickable until every opening layer finishes', async () => {
  assert.notEqual(declarations(html, '#tickets .tik-page').visibility, 'hidden');
  assert.equal(rule(html, '#tickets #tikhead .tik-page')['pointer-events'], 'none');
  assert.equal(rule(html, '#tickets.open.drawer-settled #tikhead .tik-page')['pointer-events'], 'auto');
  for (const id of ['tik-page', 'tik-page-back']) {
    assert.match(html, new RegExp(`id="${id}" class="[^"]*\\btik-page\\b`));
  }
  const f = drawer(), runs = ['tickets', 'tikwin', 'pane'].map(id => moving(f.nodes[id]));
  assert.equal(f.settled(), false); f.open(); await flush(); assert.equal(f.settled(), false);
  runs[0].finish(); await flush(); assert.equal(f.settled(), false);
  runs[1].finish(); await flush(); assert.equal(f.settled(), false);
  runs[2].finish(); await flush(); assert.equal(f.settled(), true);
  f.close(); assert.equal(f.settled(), false, 'closing must disable the arrows synchronously');
});

test('phone arrows disable at the first closing drag and enable after a fully open release without a transition', async () => {
  const f = drawer(); f.open(); await flush(); assert.equal(f.settled(), true);
  f.move(190); assert.equal(f.settled(), false);
  f.ctx.runMenu(f.nodes.tickets, 1, true); await flush(); assert.equal(f.settled(), true);
  f.ctx.homeOpen = true; f.ctx.syncMenuAvailability(); assert.equal(f.settled(), false);
});

test('a cancelled opening or an old completed opening cannot enable arrows during a new run', async () => {
  const f = drawer(), old = moving(f.nodes.tickets); f.open();
  f.close(); const fresh = moving(f.nodes.tickets); f.open();
  old.finish(); await flush(); assert.equal(f.settled(), false);
  fresh.finish(); await flush(); assert.equal(f.settled(), true);
  f.close(); const cancelled = moving(f.nodes.tickets); f.open(); cancelled.cancel();
  await flush(); assert.equal(f.settled(), false);
});

test('both arrow strengths follow the actual painted drawer fraction in either direction, ending at the sun strengths', () => {
  const f = drawer(), holder = declarations(html, '#tickets');
  const active = declarations(html, '#tickets #tikhead .tik-page');
  const inactive = declarations(html, '#tickets #tikhead .tik-page[aria-disabled="true"]');
  assert.equal(holder['--drawer-arrow-v'], 'var(--list-v)');
  const off = rule(html, '.box :is(.sunbtn, .dockbtn, .arcbtn, .xbtn)[aria-disabled="true"]').opacity;
  const vars = { '--chipoff': /--chipoff:([\d.]+);/.exec(css)[1] };
  for (const fraction of [0, .125, .25, .5, .875, 1, .875, .5, .25, .125, 0]) {
    f.ctx.paintMenu(f.nodes.tickets, fraction);
    vars['--list-v'] = f.nodes.tickets.style['--list-v'];
    vars['--drawer-arrow-v'] = holder['--drawer-arrow-v'];
    for (const id of ['tickets', 'pane', 'tikwin']) assert.equal(Number(f.nodes[id].style['--list-v']), fraction);
    assert.equal(length(active.opacity, vars, 390), fraction);
    assert.equal(length(inactive.opacity, vars, 390), fraction * length(off, vars, 390));
  }
});

test('the inherited arrow fade has the drawer transform clock for taps, keys, releases and reversals, and no drag delay', () => {
  const registered = rule(html, '@property --drawer-arrow-v');
  assert.equal(registered.syntax, '"<number>"'); assert.equal(registered.inherits, 'true');
  assert.equal(registered['initial-value'], '0');
  for (const mode of ['', 'body.menurelease ']) {
    const transition = rule(html, mode + '#tickets').transition;
    // split on the commas outside brackets: the clock is a var() with a var() fallback
    const entries = [''];
    let depth = 0;
    for (const c of transition) {
      if (c === ',' && !depth) { entries.push(''); continue; }
      depth += c === '(' ? 1 : c === ')' ? -1 : 0;
      entries[entries.length - 1] += c;
    }
    const clock = property => entries.find(t => t.trim().startsWith(property + ' ')).trim().slice(property.length + 1);
    assert.equal(clock('--drawer-arrow-v'), clock('transform'));
    for (const id of ['tikwin', 'pane']) assert.ok(declarations(html, mode + '#' + id).transition.includes('transform ' + clock('transform')));
  }
  assert.doesNotMatch(rule(html, 'body.menudrag #tickets').transition, /--drawer-arrow-v|transform/);
  for (const selector of ['#tikhead .tik-page', '#tickets #tikhead .tik-page', '#tickets #tikhead .tik-page[aria-disabled="true"]']) {
    assert.equal(declarations(html, selector).transition, undefined, 'the arrows must not add a second fade');
    assert.equal(declarations(css, selector).transition, undefined);
  }
});

test('direct and keyboard-generated arrow clicks cannot page a closed, opening or dragged drawer', () => {
  const f = header('m.html');
  for (const open of [false, true]) {
    f.nodes.tickets.classList.toggle('open', open);
    f.nodes.tickets.classList.remove('drawer-settled');
    f.click('right'); assert.equal(f.page(), 0); assert.equal(f.timers.size, 0);
  }
  f.nodes.tickets.classList.add('drawer-settled');
  f.click('right'); assert.equal(f.page(), 1);
  f.nodes.tickets.classList.remove('drawer-settled');
  f.click('left'); assert.equal(f.page(), 1);
  f.nodes.tickets.classList.add('drawer-settled');
  f.click('left'); assert.equal(f.page(), 0);
});
