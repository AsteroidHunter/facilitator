// A successful turn-on of the phone's Notifications switch must show nothing
// beside the switch: no status words and no button that appears and vanishes.
// The phone's own code runs with browser APIs replaced by small fakes. No
// server or browser is started.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(process.env.PHONE_NOTIFY_SOURCE || path.join(__dirname, '..', 'm.html'), 'utf8');
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

function page({ choice, permission = 'granted', existing = false, saveFails = false }) {
  const storage = new Map(choice ? [['phoneNotifications', choice]] : []);
  const shown = [], elements = new Map();
  let sub = null, count = 0, timers = [], release, held = new Promise(resolve => { release = resolve; });
  // Every write to the note and every time a button is uncovered is kept.
  function element(id) {
    if (!elements.has(id)) {
      let text = '', hidden = true;
      elements.set(id, { checked: false, disabled: false, events: {},
        get textContent() { return text; },
        set textContent(value) { text = value; if (value) shown.push([id, value]); },
        get hidden() { return hidden; },
        set hidden(value) { hidden = value; if (!value) shown.push([id, 'shown']); },
        addEventListener(name, fn) { this.events[name] = fn; } });
    }
    return elements.get(id);
  }
  const makeSub = () => {
    const endpoint = 'https://push.test/' + ++count;
    return { endpoint, toJSON: () => ({ endpoint }), async unsubscribe() { return true; } };
  };
  if (existing) sub = makeSub();
  const reg = { pushManager: {
    async getSubscription() { return sub; },
    async subscribe() { sub = makeSub(); return sub; },
  } };
  const context = vm.createContext({
    console, Promise, AbortSignal, Set, macHost: null, swReg: reg, keyBytes: key => key,
    setTimeout: fn => timers.push(fn), clearTimeout: id => { if (id) timers[id - 1] = null; },
    settings: { classList: { contains: () => true } },
    MutationObserver: class { observe() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    navigator: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
    Notification: { permission, requestPermission: async () => (context.Notification.permission = 'granted') },
    PushManager: function() {},
    document: { hidden: false, getElementById: element, addEventListener() {} },
    addEventListener() {},
    fetch: async url => {
      if (url === '/push/key') return { ok: true, json: async () => ({ key: 'public-key' }) };
      if (url === '/push/subscribe') { await held; return { ok: !saveFails, status: saveFails ? 503 : 200 }; }
      return { ok: true, status: 200 };
    },
  });
  context.window = context;
  const from = source.indexOf('const notifySwitch =');
  const to = source.indexOf('// each time the app starts or comes back', from);
  assert.ok(from > 0 && to > from);
  vm.runInContext(source.slice(from, to), context);
  return { shown, element, release: () => release(),
    later() { const due = timers; timers = []; for (const fn of due) fn?.(); } };
}

test('turning the switch on shows no words or buttons while it works or after it succeeds', async () => {
  for (const permission of ['granted', 'default']) {
    const p = page({ choice: 'off', permission });
    await settle();
    const opening = p.shown.splice(0);
    const sw = p.element('notify');
    sw.checked = true;
    const work = sw.events.change();
    await settle();
    assert.deepEqual(p.shown, [], 'nothing is written while the board saves (' + permission + ')');
    p.release(); await work; await settle();
    p.later();
    assert.equal(sw.checked, true);
    assert.deepEqual(p.shown, [], 'nothing appeared at any point (' + permission + ')');
    assert.equal(p.element('notifynote').textContent, '');
    assert.deepEqual(opening, [], 'the settings page opens quietly');
  }
});

test('a quick restore when settings open with notifications on is silent too', async () => {
  const p = page({ choice: 'on', existing: true });
  p.release(); await settle(); p.later();
  assert.equal(p.element('notify').checked, true);
  assert.deepEqual(p.shown, []);
});

test('a failed turn-on still leaves its message and Restore button on screen', async () => {
  const p = page({ choice: 'off', saveFails: true });
  await settle();
  const sw = p.element('notify');
  sw.checked = true;
  p.release(); await sw.events.change(); await settle();
  assert.equal(sw.checked, false);
  assert.match(p.element('notifynote').textContent, /not ready\. Tap Restore notifications/);
  assert.equal(p.element('notifyrestore').hidden, false);
});
