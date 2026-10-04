// Project selection stays synchronous; its optional entrance copies Home's
// existing CSS. These are behavior/source checks, not rendered visual proof.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const logic = read('card-logic.js'), desktop = read('index.html'), phone = read('m.html');
const fn = (text, name) => { const from = text.indexOf('function ' + name + '('); return text.slice(from, text.indexOf('\n}\n', from) + 2); };
function fixture(mac) {
  const events = [], classes = new Set();
  const element = { style: Object.freeze({}),
    classList: { remove: c => { classes.delete(c); events.push(['remove', c]); }, add: c => { classes.add(c); events.push(['add', c, ctx.activeOwner]); } },
    get offsetWidth() { events.push(['measure', ctx.activeOwner]); return 100; },
  };
  const context = { console, activeOwner: 'a', homeOpen: false, ownerReady: true,
    validActiveOwnerIds: new Set(['a', 'b', 'c']), validOwners: new Set(['a', 'b', 'c']), LOCKED: null,
    draft: null, lastState: { boxes: [] }, selectedId: null, browsing: true,
    document: { hidden: false, getElementById: () => element },
    reduced: false, matchMedia: () => ({ matches: ctx.reduced }),
    setTimeout() { throw Error('navigation must not schedule a delayed swap'); },
    localStorage: { setItem() {} },
    pickInRow: (_st, owner) => ({ id: owner + '-card' }), browse: id => events.push(['browse', id]), deselect() {},
    applySavedLayout() {}, panelPoll() {}, chatPoll() {}, fileNavPoll() {},
    apply: () => events.push(['apply', ctx.activeOwner]),
    endDraft() { ctx.draft = null; }, setHome(on) { ctx.homeOpen = on; },
    tracePhone() {}, endPhoneTrace() {}, closeProjects() {}, unselectShown() { ctx.browsing = true; },
  };
  const ctx = vm.createContext(context);
  vm.runInContext(logic, ctx);
  ctx.pickInRow = (_st, owner) => ({ id: owner + '-card' });
  vm.runInContext(fn(mac ? desktop : phone, 'setTab'), ctx);
  if (!mac) vm.runInContext(fn(phone, 'chooseRow'), ctx);
  return { ctx, events, element, classes };
}
test('project roots use the original Mac Home keyframe, duration, easing and fill', () => {
  assert.match(desktop, /@keyframes homefade\{from\{opacity:0\}\}/);
  const home = /body\.focus\.home :is\(#newproj, #homepair, #homeline\)\{animation:([^}]+)\}/.exec(desktop)[1];
  assert.equal(home, 'homefade .18s ease both');
  assert.equal(/#stage\.project-enter\{animation:([^}]+)\}/.exec(desktop)[1], home);
  assert.equal(/:is\(#pane, #tikwin\)\.project-enter\{animation:([^}]+)\}/.exec(phone)[1], home);
  assert.match(phone, /@keyframes homefade\{from\{opacity:0\}\}/);
  assert.doesNotMatch(phone, /body\.home[^{}]*\{[^}]*animation:/);
  assert.doesNotMatch(logic + desktop + phone + read('card-tokens.css'), /workspaceTransition|workspaceFade|workspace-fading|workspace-fade-ready|navigateWorkspace/);
});
for (const mac of [true, false]) {
  const name = mac ? 'Mac' : 'PWA';
  test(`${name}: project content changes before the entrance is requested, with no scheduled navigation`, () => {
    const f = fixture(mac);
    if (mac) f.ctx.setTab('b', true); else f.ctx.chooseRow({ dataset: { owner: 'b' } });
    assert.equal(f.ctx.activeOwner, 'b');
    const firstMeasure = f.events.findIndex(e => e[0] === 'measure');
    assert.ok(firstMeasure > f.events.findIndex(e => e[0] === 'apply'));
    assert.equal(f.events[firstMeasure][1], 'b');
    assert.ok(f.classes.has('project-enter'));
    assert.deepEqual(f.element.style, {}, 'entrance must not change input or layout styles');
  });
  test(`${name}: rapid project clicks synchronously select the latest project`, () => {
    const f = fixture(mac);
    for (const owner of ['b', 'c', 'a']) {
      if (mac) f.ctx.setTab(owner, true); else f.ctx.chooseRow({ dataset: { owner } });
      assert.equal(f.ctx.activeOwner, owner);
    }
    assert.deepEqual(f.events.filter(e => e[0] === 'browse').map(e => e[1]), ['b-card', 'c-card', 'a-card']);
  });
  test(`${name}: restore/poll selection and a same-project click do not replay the entrance`, () => {
    const f = fixture(mac);
    f.ctx.setTab('b'); assert.equal(f.events.filter(e => e[0] === 'add').length, 0);
    if (mac) f.ctx.setTab('b', true); else f.ctx.chooseRow({ dataset: { owner: 'b' } });
    assert.equal(f.events.filter(e => e[0] === 'add').length, 0);
  });
  test(`${name}: leaving Home selects immediately and plays only the project entrance`, () => {
    const f = fixture(mac); f.ctx.homeOpen = true;
    if (mac) f.ctx.setTab('a', true); else f.ctx.chooseRow({ dataset: { owner: 'a' } });
    assert.equal(f.ctx.homeOpen, false); assert.equal(f.ctx.activeOwner, 'a');
    assert.ok(f.events.some(e => e[0] === 'add'));
  });
}
test('new-project flow keeps its existing entrance without adding a project fade', () => {
  const f = fixture(true); f.ctx.draft = { from: 'a' }; f.ctx.activeOwner = '__draft__';
  f.ctx.setTab('b', true); assert.equal(f.ctx.activeOwner, 'b');
  assert.equal(f.events.filter(e => e[0] === 'add').length, 0);
});
test('reduced motion and hidden pages skip the entrance without delaying selection', () => {
  for (const mode of ['reduced', 'hidden']) {
    const f = fixture(true);
    if (mode === 'reduced') f.ctx.reduced = true; else f.ctx.document.hidden = true;
    f.ctx.setTab('b', true); assert.equal(f.ctx.activeOwner, 'b');
    assert.equal(f.events.filter(e => e[0] === 'add').length, 0);
  }
});
