// Real shared transition and page navigation handlers, driven by a fake
// animation clock. These checks exercise selection ordering, not rendering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const logic = fs.readFileSync(path.join(root, 'card-logic.js'), 'utf8');
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
function block(text, from, to) { return text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from))); }
function events() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { for (const fn of listeners.get(type) || []) fn(); },
    count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
  };
}
function fixture() {
  let time = 0, seq = 0;
  const timers = new Map(), calls = [];
  const document = { ...events(), hidden: false }, window = events(), media = { ...events(), matches: false };
  const elements = new Map();
  function element(id) {
    const names = new Set(), animations = [];
    const el = { id, style: {}, animations,
      classList: { add: (...items) => items.forEach(x => names.add(x)), remove: x => names.delete(x), contains: x => names.has(x), toggle(x, on) { if (on) names.add(x); else names.delete(x); } },
      animate(frames, options) {
        calls.push({ id, frames, options, at: time });
        const animation = { start: time, frames, options, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation); return animation;
      },
      opacity() {
        const a = animations.findLast(a => !a.cancelled);
        if (!a) return '1';
        const t = Math.min(1, (time - a.start) / a.options.duration);
        return String(Number(a.frames[0].opacity) * (1 - t) + Number(a.frames[1].opacity) * t);
      },
    };
    elements.set(id, el); return el;
  }
  for (const id of ['stage', 'newproj', 'homepair', 'homeline', 'pane', 'tikwin', 'tabbar', 'dock']) element(id);
  document.getElementById = id => elements.get(id);
  const ctx = vm.createContext({ document, window, matchMedia: () => media,
    getComputedStyle: el => ({ opacity: el.opacity() }),
    setTimeout(fn, delay) { timers.set(++seq, { fn, at: time + delay }); return seq; },
    clearTimeout: id => timers.delete(id), console,
  });
  vm.runInContext(logic, ctx);
  return { ctx, document, window, media, elements, calls, timers,
    tick(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      time = end;
    },
    controller(options = {}) { return ctx.workspaceTransition({ current: () => ctx.place, roots: () => [elements.get('stage')], ...options }); },
  };
}
test('fade out, commit only at zero, then fade in with the same 180ms ease timing', () => {
  const f = fixture(); f.ctx.place = 'a';
  const t = f.controller();
  t.request('b', () => { assert.equal(f.elements.get('stage').opacity(), '0'); f.ctx.place = 'b'; });
  f.tick(179); assert.equal(f.ctx.place, 'a');
  f.tick(1); assert.equal(f.ctx.place, 'b');
  assert.equal(f.elements.get('stage').opacity(), '0');
  f.tick(180); assert.equal(f.elements.get('stage').opacity(), '1');
  assert.equal(f.timers.size, 0);
  assert.equal(f.elements.get('stage').classList.contains('workspace-fading'), false);
  assert.equal(f.elements.get('stage').classList.contains('workspace-fade-ready'), true);
  assert.deepEqual(f.calls.filter(c => c.options.duration !== 1).map(c => [c.options.duration, c.options.easing]), [[180, 'ease'], [180, 'ease']]);
});
test('rapid requests keep the first fade deadline and commit only the latest destination', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller(), landed = [];
  const go = key => t.request(key, () => { landed.push(key); f.ctx.place = key; });
  go('b'); f.tick(80); go('c'); f.tick(80); go('c');
  f.tick(20); assert.deepEqual(landed, ['c']);
  f.tick(180); assert.equal(f.ctx.place, 'c'); assert.equal(f.timers.size, 0);
});
test('returning to the current destination cancels the pending swap without a flash', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('b', () => { f.ctx.place = 'b'; }); f.tick(90);
  const opacity = f.elements.get('stage').opacity();
  t.request('a', () => { throw Error('same-place swap'); });
  assert.equal(f.elements.get('stage').opacity(), opacity);
  f.tick(400); assert.equal(f.ctx.place, 'a'); assert.equal(f.timers.size, 0);
});
test('navigation during fade-in reverses from its current opacity and swaps after fading out', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('b', () => { f.ctx.place = 'b'; }); f.tick(240);
  const opacity = f.elements.get('stage').opacity();
  t.request('c', () => { f.ctx.place = 'c'; }); assert.equal(f.elements.get('stage').opacity(), opacity);
  f.tick(179); assert.equal(f.ctx.place, 'b'); f.tick(1); assert.equal(f.ctx.place, 'c');
  f.tick(180); assert.equal(f.timers.size, 0);
});
test('requesting the visible destination during fade-in does not restart its timer', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('b', () => { f.ctx.place = 'b'; }); f.tick(220);
  const count = f.calls.length;
  t.request('b', () => { throw Error('same destination swapped'); });
  assert.equal(f.calls.length, count); f.tick(140); assert.equal(f.timers.size, 0);
});
test('same destination and ordinary state updates do not start a fade', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('a', () => { throw Error('same place'); });
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
});
test('hidden pages, reduced motion and unsupported animations select immediately', () => {
  for (const mode of ['hidden', 'reduced', 'unsupported', 'disabled']) {
    const f = fixture(); f.ctx.place = 'a';
    if (mode === 'hidden') f.document.hidden = true;
    if (mode === 'reduced') f.media.matches = true;
    if (mode === 'unsupported') f.elements.get('stage').animate = undefined;
    const t = f.controller({ enabled: () => mode !== 'disabled' });
    t.request('b', () => { f.ctx.place = 'b'; });
    assert.equal(f.ctx.place, 'b', mode); assert.equal(f.timers.size, 0, mode);
  }
});
test('visibility, pagehide and reduced-motion changes settle pending selection and release timers', () => {
  for (const mode of ['hidden', 'pagehide', 'reduced']) {
    const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
    t.request('b', () => { f.ctx.place = 'b'; }); f.tick(50);
    if (mode === 'hidden') { f.document.hidden = true; f.document.emit('visibilitychange'); }
    if (mode === 'pagehide') f.window.emit('pagehide');
    if (mode === 'reduced') { f.media.matches = true; f.media.emit('change'); }
    assert.equal(f.ctx.place, 'b'); assert.equal(f.timers.size, 0);
    assert.equal(f.elements.get('stage').classList.contains('workspace-fading'), false);
    f.tick(1000); assert.equal(f.ctx.place, 'b');
  }
});
test('immediate selection supersedes queued navigation; controller teardown removes listeners', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('b', () => { throw Error('stale swap'); }); f.tick(20);
  t.cancel(); f.ctx.place = 'notification'; f.tick(1000);
  assert.equal(f.ctx.place, 'notification'); assert.equal(f.timers.size, 0);
  t.destroy(); assert.equal(f.document.count() + f.window.count() + f.media.count(), 0);
});
test('selection setters can cancel external work without cancelling their own fade commit', () => {
  const f = fixture(); f.ctx.place = 'a'; const t = f.controller();
  t.request('b', () => { t.cancel(); f.ctx.place = 'b'; });
  f.tick(180); assert.equal(f.ctx.place, 'b'); assert.equal(f.timers.size, 1);
  f.tick(180); assert.equal(f.timers.size, 0);
});
for (const [page, mac] of [['index.html', true], ['m.html', false]]) {
  function pageFixture() {
    const f = fixture(), html = source(page), selected = [], rendered = [];
    Object.assign(f.ctx, { activeOwner: 'a', homeOpen: false, FOCUS: true, ownerReady: true,
      validActiveOwnerIds: new Set(['a', 'b', 'c']), validOwners: new Set(['a', 'b', 'c']), LOCKED: null,
      lastState: { boxes: [] }, draft: null, DRAFT: '__draft__',
      localStorage: { setItem() {} },
      pickInRow: (_st, owner) => ({ id: owner + '-card' }), browse: id => selected.push(id), deselect() {},
      applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {}, endDraft() {},
      renderTabs() {}, apply: () => rendered.push(f.ctx.activeOwner), tracePhone() {}, endPhoneTrace() {},
    });
    vm.runInContext(block(html, 'let workspaceFade = null;', mac ? '// clear the selection entirely:' : "// the board's tabs, in the board's order"), f.ctx);
    vm.runInContext('function setHome(on){ workspaceFade?.cancel(); homeOpen = on; }', f.ctx);
    return { ...f, html, selected, rendered };
  }
  if (!mac) test('PWA project row and capsule follow the pending destination while card selection waits', () => {
    const f = pageFixture(), owners = ['a', 'b', 'c'];
    const rows = owners.map((owner, i) => {
      const el = f.elements.get(['newproj', 'homepair', 'homeline'][i]);
      el.dataset = { owner }; el.setAttribute = () => {}; return el;
    });
    const house = f.elements.get('stage'); house.setAttribute = () => {};
    const label = { textContent: 'a' }; f.elements.set('projname', label);
    Object.assign(f.ctx, { projCarry: null, barOwners: () => owners,
      projList: { dataset: { sig: 'a:a,b:b,c:c' }, querySelectorAll: () => rows },
      projBtn: { setAttribute() {} }, house, laneUnread: () => false,
      labelOf: (_st, owner) => owner, closeProjects() {}, selectedId: null, browsing: true,
    });
    vm.runInContext(block(f.html, 'function renderTabs(st){', 'function projOpen(){'), f.ctx);
    vm.runInContext(block(f.html, 'function chooseRow(row){', "// the list's own taps."), f.ctx);
    f.ctx.chooseRow(rows[1]);
    assert.equal(label.textContent, 'b'); assert.equal(f.ctx.activeOwner, 'a');
    assert.equal(rows[1].classList.contains('on'), true);
    f.tick(90); f.ctx.renderTabs(f.ctx.lastState); assert.equal(label.textContent, 'b');
    f.tick(90); assert.equal(f.ctx.activeOwner, 'b'); f.tick(180);
    f.ctx.navigateWorkspace('home', () => f.ctx.setHome(true));
    assert.equal(label.textContent, 'Home'); assert.equal(f.ctx.homeOpen, false);
    f.tick(180); assert.equal(f.ctx.homeOpen, true); f.tick(180);
    assert.deepEqual(f.selected, ['b-card']);
  });
  if (mac) test('Mac lens release keeps its destination through the fade-out, polls and content swap', () => {
    const f = pageFixture(), targets = ['a', 'b', 'c'], transforms = [];
    const tabs = targets.map((owner, i) => {
      const el = f.elements.get(['newproj', 'homepair', 'homeline'][i]);
      el.dataset = { owner };
      const label = { textContent: owner, dataset: {} };
      el.querySelector = selector => selector === '.plabel' ? label : null;
      el.getBoundingClientRect = () => ({ left: i * 100, right: (i + 1) * 100, width: 100, top: 0, bottom: 32 });
      return el;
    });
    const oval = { querySelector: () => tabs.find(t => t.classList.contains('on')),
      getBoundingClientRect: () => ({ left: 0 }) };
    const el = f.elements.get('dock');
    el.parentNode = oval; el.getBoundingClientRect = () => ({ width: 100 });
    el.style = new Proxy({}, { set(obj, name, value) { obj[name] = value; if (name === 'transform') transforms.push(value); return true; } });
    const bar = f.elements.get('tabbar');
    bar.dataset = { sig: 'a,b,c' }; bar.querySelectorAll = () => tabs;
    Object.assign(f.ctx, { homeChecked: true, tabGlide: null,
      tabDrag: { mode: 'select', tabs, rects: tabs.map(t => t.getBoundingClientRect()) },
      tabSeat: { el, face: { style: {} }, owner: 'a', x: 0, w: 100, drawn: true },
      allRowsOf: () => targets, rowsOf: () => targets, tabClosed: () => false,
      labelOf: (_st, owner) => owner, laneUnread: () => false,
      seatSoon: () => f.ctx.placeSeat(),
      apply: st => f.ctx.renderTabs(st),
    });
    vm.runInContext(block(f.html, 'function renderTabs(st){', '// ---- the seat ---'), f.ctx);
    vm.runInContext(block(f.html, 'function placeSeat(){', '// the bar is painted'), f.ctx);
    vm.runInContext(block(f.html, 'function finishTabSelection(e){', 'addEventListener("mousemove", e => {'), f.ctx);
    // No selection while a drag is in progress: ordinary polling respects it.
    f.ctx.renderTabs(f.ctx.lastState); assert.equal(f.ctx.activeOwner, 'a'); assert.equal(f.timers.size, 0);
    f.ctx.finishTabSelection({ clientX: 150, clientY: 16 });
    assert.equal(f.ctx.activeOwner, 'a', 'workspace changed before fade-out');
    assert.equal(f.ctx.tabSeat.owner, 'b', 'released pill did not settle at its destination');
    f.tick(90); f.ctx.renderTabs(f.ctx.lastState);
    assert.equal(f.ctx.tabSeat.owner, 'b', 'poll returned the pill to the old project');
    f.tick(90); assert.equal(f.ctx.activeOwner, 'b');
    assert.equal(f.ctx.tabSeat.owner, 'b');
    f.tick(180);
    assert.deepEqual(transforms, ['translateX(100px)'], 'the pill travelled back before the content swap');
    assert.deepEqual(f.selected, ['b-card']);
  });
  test(`${page}: actual navigation handlers fade home/project and project/project; preserve synchronous selection`, () => {
    const f = pageFixture();
    f.ctx.homeOpen = true;
    f.ctx.navigateTab('b'); f.tick(179); assert.equal(f.ctx.homeOpen, true); assert.deepEqual(f.selected, []);
    f.tick(1); assert.equal(f.ctx.homeOpen, false); assert.equal(f.ctx.activeOwner, 'b'); assert.deepEqual(f.selected, ['b-card']);
    f.tick(180); f.ctx.navigateTab('c'); f.tick(360);
    assert.deepEqual(f.selected, ['b-card', 'c-card']); assert.deepEqual(f.rendered, ['b', 'c']);
    const roots = new Set(f.calls.map(c => c.id));
    assert.deepEqual([...roots].sort(), (mac ? ['stage', 'newproj', 'homepair', 'homeline'] : ['pane', 'tikwin']).sort());
    assert.ok(!roots.has('tabbar') && !roots.has('dock'));
    f.ctx.navigateWorkspace('home', () => f.ctx.setHome(true)); f.tick(180); assert.equal(f.ctx.homeOpen, true);
    f.tick(180); assert.equal(f.timers.size, 0);
  });
  test(`${page}: invalid destination at midpoint cannot select a removed project`, () => {
    const f = pageFixture(); f.ctx.navigateTab('b');
    f.ctx.validActiveOwnerIds.delete('b'); f.ctx.validOwners.delete('b'); f.tick(360);
    assert.equal(f.ctx.activeOwner, 'a'); assert.deepEqual(f.selected, []);
  });
  test(`${page}: direct poll/restore selection cancels a pending user navigation`, () => {
    const f = pageFixture(); f.ctx.navigateTab('b'); f.tick(30); f.ctx.setTab('c'); f.tick(1000);
    assert.equal(f.ctx.activeOwner, 'c'); assert.deepEqual(f.selected, ['c-card']); assert.equal(f.timers.size, 0);
  });
}
