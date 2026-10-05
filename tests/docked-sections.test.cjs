// The four sections and the two-page ticket header, without a browser or board.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');
const source = name => readFileSync(path.join(ROOT, name), 'utf8');
function node() {
  const classes = new Set(), attrs = new Map();
  return { style: {}, dataset: {}, hidden: false, listeners: {},
    classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)),
      remove: (...cs) => cs.forEach(c => classes.delete(c)),
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
    getAttribute: k => attrs.get(k), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    addEventListener(k, fn) { this.listeners[k] = fn; },
    getBoundingClientRect: () => ({ width: 300 }),
  };
}
function world() {
  const nodes = Object.fromEntries(['tv-todo', 'tv-docked', 'tv-deferred', 'tv-done', 'tik-page', 'tik-page-back', 'tiklabels', 'tiksheet'].map(k => [k, node()]));
  const requests = [], store = new Map(), timers = new Map(); let timer = 0;
  const ctx = vm.createContext({ Date, console, AbortSignal: { timeout: () => undefined },
    setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id),
    setInterval: () => 1, clearInterval() {},
    document: { getElementById: id => nodes[id], createElement: node, body: node() },
    localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
    window: {}, matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ transform: 'matrix(1, 0, 0, 1, 0, 0)' }),
    els: {}, lastState: { boxes: [], now: Date.now()/1000, fetchedAt: Date.now() }, activeOwner: 'lane', selectedId: null,
    fetch: url => { requests.push(url); return new Promise(() => {}); }, poll() {}, select() {}, deselect() {},
  });
  vm.runInContext(source('card-logic.js'), ctx);
  ctx.apply = state => { for (const b of state.boxes) {
    const el = ctx.els[b.id]; if (!el) continue;
    el.box.classList.toggle('docked', ctx.cardSection(b) === 'docked');
    el.box.classList.toggle('parked', ctx.cardState(b) === 'parked');
    el.box.classList.toggle('done', ctx.cardState(b) === 'done');
  } };
  return { ctx, nodes, requests, store };
}
const box = extra => ({ id: 'a', owner: 'lane', bucket: 'meta', state: 'yours', replies: 1, agentTs: 1,
  ts: 1, ball: 'you', done: false, parked: false, docked: false, pending: 0, ...extra });
const plain = v => JSON.parse(JSON.stringify(v));

test('four sections partition every card, with Done then Deferred taking precedence over Docked', () => {
  const { ctx } = world();
  assert.deepEqual(plain(vm.runInContext('TICKET_VIEWS', ctx)), ['todo', 'docked', 'deferred', 'done']);
  for (const [b, expected] of [[box(), 'todo'], [box({ docked: true }), 'docked'],
    [box({ docked: true, parked: true, state: 'parked' }), 'deferred'],
    [box({ docked: true, parked: true, done: true, state: 'done' }), 'done']]) {
    assert.equal(ctx.cardSection(b), expected);
    assert.deepEqual(['todo', 'docked', 'deferred', 'done'].filter(v => ctx.viewFilterFor(b, v)), [expected]);
  }
});

test('header shows the current pair and enables its outgoing arrow, including restored per-lane choices', () => {
  const { ctx, nodes, store } = world();
  for (const [view, visible, back] of [
    ['todo', ['todo', 'docked'], false], ['docked', ['todo', 'docked'], false],
    ['deferred', ['deferred', 'done'], true], ['done', ['deferred', 'done'], true],
  ]) {
    ctx.setTicketViewOf('lane', view); ctx.paintViewTabs();
    assert.deepEqual(['todo', 'docked', 'deferred', 'done'].filter(v => !nodes['tv-'+v].inert), visible);
    assert.equal(nodes['tik-page'].getAttribute('aria-disabled') === 'true', back);
    assert.equal(nodes['tik-page-back'].getAttribute('aria-disabled') === 'true', !back);
    assert.equal(nodes['tv-'+view].classList.contains('on'), true);
    assert.equal(nodes['tik-page'].tabIndex, back ? -1 : 0);
    assert.equal(nodes['tik-page-back'].tabIndex, back ? 0 : -1);
  }
  ctx.activeOwner = 'fresh'; ctx.paintViewTabs();
  assert.equal(ctx.curView(), 'todo');
  ctx.activeOwner = 'lane'; assert.equal(ctx.curView(), 'done');
  assert.ok([...store.values()].includes('done'));
});

for (const page of ['index.html', 'm.html']) {
  test(`${page}: the real header listeners page names without changing the list`, () => {
    const html = source(page), { ctx, nodes } = world();
    assert.deepEqual([...html.matchAll(/<div class="tikpane" data-view="([^"]+)"/g)].map(m => m[1]), ['todo', 'docked', 'deferred', 'done']);
    assert.match(html, /id="tik-page" class="qn-glass tik-page" type="button"/);
    assert.match(html, /id="tv-deferred" inert/); assert.match(html, /id="tv-done" inert/);
    ctx.cancelAutoNext = () => {}; ctx.dropResponseScroll = () => {}; ctx.renderTickets = () => {};
    const from = html.indexOf(page === 'm.html' ? 'function setView(v){' : '  const setView = v => {');
    const end = html.indexOf('document.getElementById("tv-done").addEventListener', from);
    const through = html.indexOf('\n', end);
    vm.runInContext(html.slice(from, through), ctx);
    ctx.paintViewTabs(); ctx.moveTicketSheet('todo', false);
    nodes['tik-page'].listeners.click();
    assert.equal(ctx.curView(), 'todo');
    assert.equal(nodes.tiksheet.style.transform, 'translateX(0%)');
    assert.equal(nodes.tiklabels.style.transform, 'translateX(-100%)');
    assert.equal(nodes['tv-todo'].inert, true); assert.equal(nodes['tik-page'].getAttribute('aria-disabled'), 'true');
    nodes['tv-done'].listeners.click();
    assert.equal(nodes.tiksheet.style.transform, 'translateX(-300%)');
    nodes['tik-page-back'].listeners.click();
    assert.equal(ctx.curView(), 'done'); assert.equal(nodes.tiksheet.style.transform, 'translateX(-300%)');
    assert.equal(nodes.tiklabels.style.transform, 'translateX(0%)');
    nodes['tv-docked'].listeners.click();
    assert.equal(nodes.tiksheet.style.transform, 'translateX(-100%)');
  });
}

test('the slide redirects from its live position and reduced motion cancels traversal', () => {
  const { ctx, nodes } = world(); let frames, options, cancelled = 0;
  nodes.tiksheet.animate = (f, o) => { frames = f; options = o; return { cancel() { cancelled++; }, addEventListener() {} }; };
  ctx.getComputedStyle = () => ({ transform: 'matrix(1, 0, 0, 1, -450, 0)' });
  ctx.moveTicketSheet('done', true);
  assert.deepEqual(plain(frames), [{ transform: 'translateX(-150%)' }, { transform: 'translateX(-300%)' }]);
  assert.equal(options.duration, 360); assert.equal(options.easing, 'cubic-bezier(.42,.06,.38,1)');
  ctx.window.matchMedia = ctx.matchMedia = () => ({ matches: true });
  ctx.moveTicketSheet('docked', true);
  assert.equal(cancelled, 1); assert.equal(nodes.tiksheet.style.transform, 'translateX(-100%)');
});

test('glass triangle has only its own hit area, mark size, edge tangent, centred row, and mirrored return', () => {
  const css = source('card-tokens.css');
  const rule = /#tikhead \.tik-page\{([^}]+)\}/.exec(css)?.[1]; assert.ok(rule);
  for (const part of ['right:0; left:auto', 'width:var(--bar-mark); height:var(--bar-mark)',
    'padding:0; margin:0; border:0', 'clip-path:polygon(0 0, 100% 50%, 0 100%)',
    'top:calc(50% + 3 * var(--u))', 'transform:translateY(-50%)', '--qn-face:rgba(30,30,30,.77)']) assert.ok(rule.includes(part), part);
  assert.match(css, /#tikhead \.tik-page\.back\{left:0; right:auto; transform:translateY\(-50%\) scaleX\(-1\)\}/);
  assert.match(css, /#tiknames\{[^}]*overflow:clip/);
  assert.match(css, /\.qn-glass\{[^}]*background-image:var\(--qn-light\);[^}]*backdrop-filter:blur\(var\(--qn-blur\)\)/);
  assert.doesNotMatch(rule, /--accent|432BFF|purple/i);
});

test('Docked keeps working and reply colours and spinner while Deferred hides them', () => {
  const { ctx } = world();
  for (const state of ['working', 'yours', 'queued', 'new']) {
    const b = box({ state, docked: true });
    assert.equal(ctx.cardState(b), state); assert.equal(ctx.queueState(b), state);
    assert.equal(ctx.cardSpinning(b), state === 'working'); assert.equal(ctx.cardSection(b), 'docked');
    assert.equal(ctx.cardSpinning({ ...b, state: 'parked', parked: true }), false);
  }
  const css = source('card-tokens.css');
  assert.match(css, /\.topbar:has\(> \.dockbtn\[aria-disabled="true"\]\) > \.cardspin\{grid-area:dock\}/);
  assert.match(css, /\.topbar:has\(> \.dockbtn\[aria-disabled="true"\]\) \.sunbtn svg\{opacity:1\}/);
});

test('Docked uses the sun stroke and a covering cloud, with no added colour', () => {
  const { ctx } = world();
  const [sun, dock] = plain(vm.runInContext('[SUN_ICON, DOCK_ICON]', ctx));
  for (const icon of [sun, dock]) {
    assert.match(icon, /viewBox="0 0 24 24" width="9" height="9"/);
    assert.match(icon, /stroke-width="2.4" stroke-linecap="round"/);
    assert.match(icon, /fill="none" stroke="currentColor"/);
    assert.doesNotMatch(icon, /--accent|#[0-9a-f]{3,8}/i);
  }
  assert.match(dock, /M9 21h10a3\.5/); // closed cloud outline covers lower-right sun arc
  assert.match(dock, /a4\.35 4\.35/); // sun keeps the existing ring radius
});

test('done chord uses physical Backspace and Delete; plain deletion never moves a card', () => {
  const { ctx } = world();
  for (const code of ['Backspace', 'Delete']) {
    for (const key of [code, 'Unidentified']) assert.equal(ctx.sectionChordOf({ code, key }), 'done');
    assert.equal(ctx.sectionChordOf({ key: code }), 'done');
    assert.equal(ctx.sectionKeyOf({ code, key: code }), null);
    assert.equal(ctx.cardShortcut({ code, key: code }), null);
    assert.equal(ctx.cardShortcut({ code, key: code, ctrlKey: true, shiftKey: true }).value, 'done');
  }
});

test('pending destinations replace each other and closing uses the same increasing stream', () => {
  const { ctx, requests } = world();
  const b = box(); ctx.lastState.boxes = [b]; ctx.els.a = { box: node() };
  ctx.setFlag('a', 'dock', true);
  assert.equal(ctx.cardSection(b), 'docked'); assert.equal(b.state, 'yours');
  ctx.setFlag('a', 'park', true);
  assert.equal(ctx.cardSection(b), 'deferred'); assert.equal(b.docked, false);
  ctx.setFlag('a', 'dock', true);
  assert.equal(ctx.cardSection(b), 'docked'); assert.equal(b.parked, false);
  const urls = [...requests, ctx.closeCardUrl('a')].map(u => new URL(u, 'http://fixture'));
  assert.deepEqual(urls.map(u => u.pathname), ['/dock', '/park', '/dock', '/close']);
  assert.deepEqual(urls.map(u => Number(u.searchParams.get('seq'))), [1, 2, 3, 4]);
  assert.equal(new Set(urls.map(u => u.searchParams.get('sid'))).size, 1);
  assert.equal(vm.runInContext('Object.keys(flagHolds).length', ctx), 0);
});

test('optimistic docking and undocking preserve server work states absent from the legacy flags', () => {
  for (const state of ['note', 'deferred', 'rest', 'working', 'yours']) {
    const { ctx } = world();
    const b = box({ state }); ctx.lastState.boxes = [b]; ctx.els.a = { box: node() };
    const before = ctx.cardState(b);
    ctx.setFlag('a', 'dock', true);
    assert.equal(ctx.cardState(b), before, `${state} changed colour when docked`);
    assert.equal(ctx.cardSection(b), 'docked');
    ctx.setFlag('a', 'dock', false);
    assert.equal(ctx.cardState(b), before, `${state} changed colour when undocked`);
    assert.equal(ctx.cardSection(b), 'todo');
  }
});

test('deferring a selected Docked card picks its Docked neighbour, then the next section when empty', () => {
  for (const hasNeighbour of [true, false]) {
    const { ctx } = world(); const picked = [];
    ctx.lastState.boxes = [box({ id: 'doing' }), box({ id: 'a', docked: true, dockedTs: 3 }),
      ...(hasNeighbour ? [box({ id: 'b', docked: true, dockedTs: 2 })] : []),
      box({ id: 'later', parked: true, state: 'parked', parkedTs: 1 }), box({ id: 'done', done: true, state: 'done' })];
    ctx.els.a = { box: node() }; ctx.apply(ctx.lastState);
    ctx.selectedId = 'a'; ctx.setTicketViewOf('lane', 'docked'); ctx.select = (id, opts) => picked.push([id, opts.hop]);
    ctx.setCardDestination('a', 'deferred');
    assert.deepEqual(picked, [[hasNeighbour ? 'b' : 'later', true]]);
    assert.equal(ctx.curView(), hasNeighbour ? 'docked' : 'deferred');
    assert.equal(ctx.cardSection(ctx.lastState.boxes.find(b => b.id === 'a')), 'deferred');
  }
});

test('a Doing departure keeps its previous neighbour before crossing to Docked; all sections skip standing cards', () => {
  const { ctx } = world(); const picked = [];
  ctx.lastState.boxes = [box({ id: 'first' }), box({ id: 'a', agentTs: 2 }),
    box({ id: '0', docked: true }), box({ id: 't0', docked: true }), box({ id: 'dock', docked: true })];
  ctx.selectedId = 'a'; ctx.select = (id, opts) => picked.push([id, opts.hop]);
  const departure = ctx.cardDeparture(ctx.lastState, 'a');
  ctx.lastState.boxes.find(b => b.id === 'a').docked = true;
  ctx.selectNextCard('a', departure.order, departure.section);
  assert.deepEqual(picked, [['first', true]]); assert.equal(ctx.curView(), 'todo');
  ctx.lastState.boxes = ctx.lastState.boxes.filter(b => b.id !== 'first'); picked.length = 0;
  ctx.selectNextCard('a', departure.order, departure.section);
  assert.deepEqual(picked, [['dock', true]]); assert.equal(ctx.curView(), 'docked');
});
