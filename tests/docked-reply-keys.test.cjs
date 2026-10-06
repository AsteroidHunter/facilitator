// Node-only regression: run the pages' send, delivery, list rendering and key
// actions with shared card logic. Transport and DOM painting are inert doubles.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const logic = read('card-logic.js');
function between(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const block = (source, start) => between(source, start, '\n}\n') + '\n}\n';
const modes = ['Mac', 'narrow Mac', 'phone'];
const card = (id, extra = {}) => ({ id, owner: 'one', ws: 'work', state: 'queued', ts: 10, ...extra });
function fixture(mode, extra = []) {
  const desktop = mode === 'Mac', html = read(desktop ? 'index.html' : 'm.html');
  const nodes = new Map(), stored = new Map(), timers = new Map(), panes = new Map(), keyListeners = [];
  let timer = 0, item, op, resolveSend, drawer = false, scrolled = null;
  function node() {
    const classes = new Set();
    return { dataset: {}, style: {}, inert: false,
      classList: { toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, contains: k => classes.has(k) },
      setAttribute() {}, getAttribute: () => null, removeAttribute() {}, querySelector: () => null,
      appendChild() {}, addEventListener() {}, value: '', tick() {},
      closest: () => null, focus() {} };
  }
  for (const id of ['tiksheet', 'chips', 'tiklabels', 'tik-page', 'tik-page-back', 'tv-todo', 'tv-docked', 'tv-deferred', 'tv-done']) nodes.set(id, node());
  for (const view of ['todo', 'docked', 'deferred', 'done']) {
    const pane = node(); pane.rows = []; pane.querySelectorAll = () => pane.rows;
    panes.set(view, pane);
  }
  const findPane = selector => panes.get(/data-view="([^"]+)"/.exec(selector)?.[1]) || null;
  if (!desktop) nodes.get('tiksheet').querySelector = findPane;
  const body = node(), composer = node(); composer.closest = () => composer;
  const ctx = vm.createContext({
    document: { getElementById: id => nodes.get(id), querySelector: findPane, body, activeElement: composer },
    window: {}, matchMedia: () => ({ matches: true }),
    addEventListener(type, fn) { if (type === 'keydown') keyListeners.push(fn); },
    homeOpen: false, drawerOpen: () => drawer, menuOut: () => drawer ? nodes.get('tiksheet') : null,
    localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v) },
    setTimeout(fn, ms) { timers.set(++timer, { fn, ms }); return timer; }, clearTimeout: id => timers.delete(id),
    FOCUS: true, macHost: mode === 'narrow Mac' ? {} : null, innerWidth: desktop ? 1440 : 390,
    selectedId: null, activeOwner: 'one', lastState: { boxes: [card('reply', { docked: true }), card('before', { ts: 30 }), card('after', { ts: 1 }), ...extra] },
    els: {}, hist: null, enterAgain: null, phoneEnterAgain: null, autoNext: null, AUTONEXT_MS: 0,
    curWs: () => ({ id: 'work' }), ticketsShown: () => true,
    tracePhone() {}, endPhoneTrace() {}, syncSpinner() {}, h: node,
    // The page's real renderTickets supplies each section's ordered pool.
    // Only row painting is doubled; drawerRows reads these through the DOM.
    paintPhonePane(pane, pool) {
      pane.rows = pool.map(b => {
        const row = node(); row.dataset.id = b.id;
        row.scrollIntoView = () => { scrolled = b.id; };
        return row;
      });
      return false;
    },
    sentLaunch() { item = {}; return item; }, sentTry: () => new Promise(resolve => { resolveSend = resolve; }),
    sentLanded() {}, sentFailed() {}, poll() {}, drawSent() {},
    ensureCard: id => ctx.els[id], traySendable: () => false, trayBusy: () => false,
    trayMessage: (_, text) => text, trayTake() {}, mintOp: (kind, fields) => (op = { kind, ...fields }),
    laneOf: () => 'send', runOps() {},
    select(id) { ctx.selectedId = id; }, browse(id) { ctx.selectedId = id; },
    focusBoxAtEnd(el) { ctx.document.activeElement = el.ta; }, boardMoveLive: () => true,
  });
  const doubles = Object.fromEntries(['sentLaunch', 'sentTry', 'sentLanded', 'sentFailed', 'syncSpinner', 'focusBoxAtEnd', 'h'].map(k => [k, ctx[k]]));
  vm.runInContext(logic, ctx);
  Object.assign(ctx, doubles);
  for (const b of ctx.lastState.boxes) ctx.els[b.id] = { ta: { ...composer }, tick() {}, send: {}, sentItems: [], meta: { textContent: '' } };
  if (desktop) {
    vm.runInContext('poolScope = state => b => b.ws === "work";', ctx);
    for (const name of ['nav', 'enterViewKey', 'doSend', 'renderCarousel', 'clearEnterAgain', 'scheduleDesktopAdvance', 'boardAdvance', 'askEnterAdvance']) vm.runInContext(block(html, `${name === 'doSend' ? 'async ' : ''}function ${name}(`), ctx);
    vm.runInContext(between(html, 'const boardShortcutTyping =', '\naddEventListener("keydown", e => {'), ctx);
  } else {
    for (const name of ['navigationPool', 'cardStepTarget', 'stepCard', 'phoneEnterViewKey', 'doSend', 'landSend', 'renderTickets', 'clearPhoneEnterAgain', 'schedulePhoneAdvance', 'phoneAdvance', 'askPhoneEnterAdvance']) vm.runInContext(block(html, `function ${name}(`), ctx);
    vm.runInContext(between(html, 'const phoneShortcutTyping =', '\n// while the home page'), ctx);
    // Includes the actual menu keydown listener, not just its action table.
    vm.runInContext(between(html, 'function drawerPane(){', '\n// a tap anywhere on the card on screen'), ctx);
  }
  const render = state => desktop ? ctx.renderCarousel(state) : ctx.renderTickets(state);
  ctx.setTicketViewOf('one', 'docked'); render(ctx.lastState);
  ctx.select('reply');
  function snapshot(extraFlags = {}) {
    return { boxes: ctx.lastState.boxes.map(b => b.id === 'reply' ? { ...b, docked: false, ...extraFlags } : { ...b }) };
  }
  return { ctx, nodes, stored, timers, desktop, body, composer, render, snapshot,
    openDrawer() { drawer = true; render(ctx.lastState); },
    scrolled: () => scrolled,
    menuKey(key, chord = false, typing = false) {
      assert.equal(keyListeners.length, 1, 'the actual menu key listener was registered');
      const e = { key, ctrlKey: chord, shiftKey: chord, target: typing ? composer : body,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; } };
      keyListeners[0](e);
      return e;
    },
    intent() {
      const value = { id: 'reply', source: 'enter', active: true, advance: false, deadline: Date.now() + 10000, view: desktop ? ctx.enterViewKey('reply') : ctx.phoneEnterViewKey('reply') };
      if (desktop) ctx.enterAgain = value; else ctx.phoneEnterAgain = value;
      return value;
    },
    advanceIntent() {
      assert.equal(desktop ? ctx.askEnterAdvance('reply') : ctx.askPhoneEnterAdvance('reply'), true);
      for (const [id, task] of [...timers]) if (task.ms === 0) { timers.delete(id); task.fn(); }
    },
    async send({ confirmed = true, beforeLand = () => {}, intent = null } = {}) {
      ctx.els.reply.ta.value = 'Please continue';
      const pending = ctx.doSend('reply', { advance: false, enterIntent: intent });
      if (!desktop && intent) intent.op = op;
      await beforeLand();
      if (desktop) { resolveSend(confirmed ? 'landed' : 'refused'); await pending; }
      else if (confirmed) ctx.landSend(op, {});
      return { item, op };
    },
    update(state = snapshot()) {
      // Desktop renders before replacing lastState; the phone replaces it first.
      if (!desktop) ctx.lastState = state;
      render(state);
      ctx.lastState = state;
    },
    command(key, typing = false) {
      const e = { key, ctrlKey: true, target: typing ? composer : body, preventDefault() { this.defaultPrevented = true; } };
      ctx.dispatchCardShortcut(e, vm.runInContext(desktop ? 'boardShortcutActions' : 'phoneShortcutActions', ctx));
      return e;
    },
    key(dir, chord = true, typing = true) {
      const e = { key: dir < 0 ? 'ArrowLeft' : 'ArrowRight', ctrlKey: chord, shiftKey: chord,
        target: typing ? composer : body, preventDefault() { this.defaultPrevented = true; } };
      ctx.dispatchCardShortcut(e, vm.runInContext(desktop ? 'boardShortcutActions' : 'phoneShortcutActions', ctx));
      return e;
    },
  };
}

for (const mode of modes) {
  for (const dir of [-1, 1]) for (const chord of [false, true]) {
    test(`${mode}: Docked > open > reply > Doing > ${chord ? 'Control Shift ' : ''}${dir < 0 ? 'Left' : 'Right'}`, async () => {
      const f = fixture(mode);
      assert.equal(f.ctx.curView(), 'docked'); assert.equal(f.ctx.selectedId, 'reply');
      await f.send(); f.update();
      f.key(dir, chord, chord);
      assert.equal(f.ctx.selectedId, dir < 0 ? 'before' : 'after');
      assert.equal(f.ctx.curView(), 'todo');
      assert.equal(f.nodes.get('tiksheet').style.transform, 'translateX(0%)');
      assert.equal(f.stored.get('tikview.one'), 'todo');
    });
  }
  test(`${mode}: a nonempty Docked list cannot capture the reply's next key`, async () => {
    const f = fixture(mode, [card('other-docked', { docked: true }), card('foreign', { ws: 'elsewhere' }), card('other-project', { owner: 'two' })]);
    await f.send(); f.update(); f.key(1);
    assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: plain arrows keep editing, and the chord works from the cleared composer`, async () => {
    const f = fixture(mode); await f.send(); f.update();
    assert.equal(f.ctx.els.reply.ta.value, '');
    assert.equal(f.key(1, false, true).defaultPrevented, undefined);
    assert.equal(f.ctx.selectedId, 'reply');
    f.key(1); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: all four unchanged sections retain their order and wrap`, () => {
    for (const view of ['todo', 'docked', 'deferred', 'done']) {
      const f = fixture(mode);
      const flags = view === 'docked' ? { docked: true } : view === 'deferred' ? { parked: true, state: 'parked' } : view === 'done' ? { done: true, state: 'done' } : {};
      f.ctx.lastState = { boxes: ['a', 'b', 'c'].map(id => card(id, flags)) };
      f.ctx.setTicketViewOf('one', view); f.render(f.ctx.lastState);
      f.ctx.select('b'); f.key(1, false, false); assert.equal(f.ctx.selectedId, 'c');
      f.key(1, false, false); assert.equal(f.ctx.selectedId, 'a');
      f.key(-1, false, false); assert.equal(f.ctx.selectedId, 'c');
      assert.equal(f.ctx.curView(), view);
    }
  });
  test(`${mode}: choosing a different section intentionally still walks that list`, () => {
    const f = fixture(mode, [card('done-card', { done: true, state: 'done' })]);
    f.ctx.setTicketViewOf('one', 'done'); f.render(f.ctx.lastState);
    f.key(1, false, false); assert.equal(f.ctx.selectedId, 'done-card');
  });
  test(`${mode}: failed send and acknowledgement before state keep the existing snapshot`, async () => {
    const failed = fixture(mode); await failed.send({ confirmed: false }); failed.render(failed.ctx.lastState);
    assert.equal(failed.ctx.curView(), 'docked');
    const f = fixture(mode); await f.send(); f.render(f.ctx.lastState);
    assert.equal(f.ctx.curView(), 'docked'); assert.equal(f.ctx.lastState.boxes[0].docked, true);
    f.key(1); assert.equal(f.ctx.selectedId, 'reply');
    f.update(); f.key(1); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: a delayed confirmation cannot steal the chosen card, project or list`, async () => {
    for (const change of [f => f.ctx.select('before'), f => { f.ctx.activeOwner = 'two'; }, f => f.ctx.setTicketViewOf('one', 'done'), f => { f.ctx.setTicketViewOf('one', 'done'); f.ctx.setTicketViewOf('one', 'docked'); }]) {
      const f = fixture(mode);
      await f.send({ beforeLand: () => change(f) });
      const selected = f.ctx.selectedId, owner = f.ctx.activeOwner, view = f.ctx.curView();
      f.update(); assert.equal(f.ctx.selectedId, selected); assert.equal(f.ctx.activeOwner, owner); assert.equal(f.ctx.curView(), view);
    }
  });
  test(`${mode}: a live second-press intent survives the automatic list follow`, async () => {
    const f = fixture(mode), intent = f.intent();
    await f.send({ intent }); f.update();
    assert.equal(f.ctx.curView(), 'todo');
    assert.equal(intent.active, true);
    assert.equal(intent.view, f.desktop ? f.ctx.enterViewKey('reply') : f.ctx.phoneEnterViewKey('reply'));
    Object.assign(f.ctx.lastState.boxes.find(b => b.id === 'after'), { state: 'yours', ball: 'you' });
    f.advanceIntent(); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: state arriving before its confirmation follows immediately on acknowledgement`, async () => {
    const f = fixture(mode);
    await f.send({ beforeLand: () => f.update() });
    f.key(1); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: a late acknowledgement cannot follow a card that is Docked, Deferred or Done again`, async () => {
    for (const flags of [{ docked: true, dockedTs: 200 }, { parked: true, state: 'parked' }, { done: true, state: 'done' }]) {
      const f = fixture(mode);
      await f.send({ beforeLand() { f.update(); f.update(f.snapshot(flags)); } });
      f.render(f.ctx.lastState);
      assert.equal(f.ctx.curView(), 'docked');
      assert.equal(f.ctx.selectedId, 'reply');
    }
  });
  for (const key of ['r', 'Enter']) test(`${mode}: Control ${key} follows Doing after the reply`, async () => {
    const f = fixture(mode, [card('stay-docked', { docked: true, state: 'yours', ball: 'you' })]);
    await f.send(); f.update();
    Object.assign(f.ctx.lastState.boxes.find(b => b.id === 'after'), { state: 'yours', ball: 'you' });
    f.command(key); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: the name arrows and their thirty-second return do not change the followed list`, async () => {
    const f = fixture(mode);
    f.ctx.slideTicketNames(1);
    await f.send(); f.update();
    assert.equal(f.ctx.curView(), 'todo');
    f.ctx.slideTicketNames(1);
    for (const [id, task] of [...f.timers]) if (task.ms === 30000) { f.timers.delete(id); task.fn(); }
    assert.equal(f.ctx.curView(), 'todo');
    f.key(1); assert.equal(f.ctx.selectedId, 'after');
  });
  test(`${mode}: changing the list after acknowledgement cancels the pending follow`, async () => {
    const f = fixture(mode); await f.send();
    f.ctx.setTicketViewOf('one', 'done'); f.update();
    assert.equal(f.ctx.curView(), 'done');
  });
  test(`${mode}: an invalid second-press intent is not revived`, async () => {
    const f = fixture(mode), intent = f.intent(); intent.view = 'old context';
    await f.send({ intent }); f.update();
    assert.equal(f.ctx.curView(), 'todo'); assert.equal(intent.view, 'old context');
  });
  test(`${mode}: confirmed retry follows the original reply, and phone storage omits the callback`, async () => {
    const f = fixture(mode), result = await f.send({ confirmed: false });
    if (f.desktop) result.item.landed();
    else {
      assert.equal(JSON.parse(JSON.stringify(result.op)).followView, undefined);
      f.ctx.landSend(result.op, {});
    }
    f.update(); f.key(1); assert.equal(f.ctx.selectedId, 'after');
  });

}

for (const mode of ['narrow Mac', 'phone']) {
  for (const [key, chord, expected] of [
    ['ArrowUp', false, 'before'], ['ArrowDown', false, 'after'],
    ['ArrowLeft', true, 'before'], ['ArrowRight', true, 'after'],
  ]) test(`${mode}: Docked reply with drawer open dispatches ${chord ? 'Control Shift ' : ''}${key} through the menu`, async () => {
    const f = fixture(mode); f.openDrawer();
    assert.deepEqual(Array.from(f.ctx.drawerRows(), r => r.dataset.id), ['reply']);
    await f.send(); f.update();
    const event = f.menuKey(key, chord);
    assert.equal(f.ctx.selectedId, expected);
    assert.equal(f.ctx.curView(), 'todo');
    assert.deepEqual(Array.from(f.ctx.drawerRows(), r => r.dataset.id), ['before', 'reply', 'after']);
    assert.equal(f.scrolled(), expected);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.stopped, true, 'the menu listener must prevent a second card-handler step');
    assert.equal(f.ctx.document.activeElement, f.composer, 'menu navigation must not focus the next card');
    assert.equal(f.ctx.drawerOpen(), true);
  });
  test(`${mode}: drawer Up and Down keep typing and clamp at either end of each unchanged section`, () => {
    for (const view of ['todo', 'docked', 'deferred', 'done']) {
      const f = fixture(mode), flags = view === 'docked' ? { docked: true } : view === 'deferred' ? { parked: true, state: 'parked' } : view === 'done' ? { done: true, state: 'done' } : {};
      f.ctx.lastState = { boxes: ['a', 'b', 'c'].map(id => card(id, flags)) };
      f.ctx.setTicketViewOf('one', view); f.ctx.select('b'); f.openDrawer();
      const typing = f.menuKey('ArrowDown', false, true);
      assert.equal(typing.defaultPrevented, undefined); assert.equal(f.ctx.selectedId, 'b');
      f.menuKey('ArrowUp'); assert.equal(f.ctx.selectedId, 'a');
      f.menuKey('ArrowUp'); assert.equal(f.ctx.selectedId, 'a');
      f.menuKey('ArrowDown'); f.menuKey('ArrowDown'); assert.equal(f.ctx.selectedId, 'c');
      f.menuKey('ArrowDown'); assert.equal(f.ctx.selectedId, 'c');
      f.menuKey('ArrowRight', true); assert.equal(f.ctx.selectedId, 'a');
      f.menuKey('ArrowLeft', true); assert.equal(f.ctx.selectedId, 'c');
      assert.equal(f.ctx.curView(), view);
    }
  });
}
