// Run the phone's own notification and sign-out code with browser APIs replaced
// by small fakes. No server or browser is started.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(process.env.PHONE_NOTIFY_SOURCE || path.join(__dirname, '..', 'm.html'), 'utf8');
const CHOICE = 'phoneNotifications', ENDPOINT = 'phoneNotificationEndpoint';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

function page({ choice = 'on', existing = false, permission = 'granted', storage = new Map(), gestureOnly = false,
                accepted = null, creating = null, removeFails = false, lookupFails = false, phoneRemoveFails = false } = {}) {
  if (choice !== null) storage.set(CHOICE, choice);
  const elements = new Map(), windowEvents = {}, documentEvents = {};
  const calls = [], closed = [], navigated = [];
  let gesture = false, sub = null, count = 0, observer, timers = [];
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  function element(id) {
    if (!elements.has(id)) elements.set(id, { checked: false, disabled: false, hidden: true, textContent: '', events: {},
      addEventListener(name, fn) { this.events[name] = fn; } });
    return elements.get(id);
  }
  const makeSub = () => {
    const endpoint = 'https://push.test/private/' + ++count;
    const result = { endpoint, toJSON: () => ({ endpoint, keys: { auth: 'secret', p256dh: 'secret-key' } }),
      async unsubscribe() { calls.push(['phone-remove', endpoint]); if (phoneRemoveFails) throw new Error('phone refused'); if (sub === result) sub = null; return true; } };
    return result;
  };
  if (existing) sub = makeSub();
  const reg = { getNotifications: async () => [
    { tag: 'facilitator-m1', close: () => closed.push('ours') },
    { tag: 'other', close: () => closed.push('other') },
  ], pushManager: {
    async getSubscription() { if (lookupFails) throw new Error('lookup failed'); return sub; },
    subscribe() {
      calls.push(['subscribe', gesture]);
      if (gestureOnly && !gesture) return Promise.reject(new Error('tap required'));
      const made = makeSub();
      return (creating ? creating.promise : Promise.resolve()).then(() => { sub = made; return made; });
    },
  } };
  const context = vm.createContext({
    console, Promise, AbortSignal, Set, macHost: null,
    setTimeout: fn => timers.push(fn), clearTimeout: id => { if (id) timers[id - 1] = null; }, swReg: reg, keyBytes: key => key,
    settings: { classList: { contains: () => true } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    navigator: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
    Notification: { permission, requestPermission() { calls.push(['permission', gesture]); return Promise.resolve(context.Notification.permission); } },
    PushManager: function() {},
    document: { hidden: false, getElementById: element, addEventListener: listen(documentEvents) },
    addEventListener: listen(windowEvents),
    caches: { keys: async () => [], delete: async () => true },
    location: { replace: url => navigated.push(url) },
    fetch: async (url, init = {}) => {
      calls.push([url, init.body ? JSON.parse(init.body) : null]);
      if (url === '/push/key') return { ok: true, json: async () => ({ key: 'public-key' }) };
      if (url === '/push/subscribe' && accepted) return accepted.promise;
      if (url === '/push/unsubscribe' && removeFails) throw new Error('offline');
      return { ok: true, status: 200 };
    },
  });
  context.window = context;
  const from = source.indexOf('const notifySwitch =');
  const to = source.indexOf('// each time the app starts or comes back', from);
  assert.ok(from > 0 && to > from);
  vm.runInContext(source.slice(from, to), context);
  const outFrom = source.indexOf('async function signOut(){');
  vm.runInContext(source.slice(outFrom, source.indexOf('// Developer mode', outFrom)), context);
  return {
    context, calls, storage, closed, navigated, element, reg, observer: () => observer(),
    subscription: () => sub, lose: () => { sub = null; },
    later() { const due = timers; timers = []; for (const fn of due) fn?.(); },
    run: code => vm.runInContext(code, context),
    async tap(id, checked) {
      const el = element(id);
      if (checked !== undefined) el.checked = checked;
      gesture = true;
      let work;
      try { work = el.events[checked === undefined ? 'click' : 'change'](); }
      finally { gesture = false; }
      await work;
    },
    return() { context.document.hidden = false; for (const fn of documentEvents.visibilitychange || []) fn(); },
    pageshow() { for (const fn of windowEvents.pageshow || []) fn({ persisted: true }); },
  };
}

const posted = p => p.calls.filter(c => c[0] === '/push/subscribe');
const subscribes = p => p.calls.filter(c => c[0] === 'subscribe');

test('a wanted missing subscription is made and posted at start, and turns on only after acceptance', async () => {
  const accepted = deferred();
  const p = page({ accepted });
  await settle();
  assert.equal(subscribes(p).length, 1);
  assert.equal(posted(p).length, 1);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notifynote').textContent, '');
  accepted.resolve({ ok: true });
  await settle();
  assert.equal(p.element('notify').checked, true);
});

test('return and restored-page events repair missing links, even soon after startup', async () => {
  const p = page();
  await settle();
  p.lose(); p.return(); p.pageshow();
  await settle();
  assert.equal(subscribes(p).length, 2, 'overlapping returns must share one repair');
  assert.equal(posted(p).length, 2);
  p.lose(); p.pageshow();
  await settle();
  assert.equal(subscribes(p).length, 3);
  assert.equal(p.element('notify').checked, true);
});

test('an off tap is saved and remains off after return and a fresh page', async () => {
  const p = page({ existing: true });
  await settle();
  await p.tap('notify', false);
  assert.equal(p.storage.get(CHOICE), 'off');
  p.return(); await settle();
  assert.equal(subscribes(p).length, 0);
  assert.equal(p.subscription(), null);
  const reopened = page({ choice: null, storage: p.storage });
  await settle();
  assert.equal(subscribes(reopened).length, 0);
  assert.equal(posted(reopened).length, 0);
  assert.equal(reopened.element('notify').checked, false);
});

test('a saved off choice never reposts even a surviving subscription', async () => {
  const p = page({ choice: 'off', existing: true });
  await settle();
  assert.equal(posted(p).length, 0);
  assert.equal(subscribes(p).length, 0);
  assert.equal(p.subscription(), null);
});

test('a refused silent subscribe offers Restore, which subscribes on that one tap', async () => {
  const p = page({ gestureOnly: true });
  await settle();
  assert.equal(p.element('notifyrestore').hidden, false);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.storage.get(CHOICE), 'on');
  await p.tap('notifyrestore');
  assert.deepEqual(subscribes(p).map(c => c[1]), [false, true]);
  assert.equal(p.element('notify').checked, true);
  assert.equal(p.element('notifyrestore').hidden, true);
  assert.equal(posted(p).length, 1);
});

test('permission is never requested by recovery, but an enable tap requests it synchronously', async () => {
  const p = page({ permission: 'default' });
  await settle();
  assert.equal(p.calls.some(c => c[0] === 'permission'), false);
  assert.equal(subscribes(p).length, 0);
  assert.equal(p.element('notifyrestore').hidden, false);
  await p.tap('notifyrestore');
  assert.deepEqual(p.calls.filter(c => c[0] === 'permission'), [['permission', true]]);
  assert.equal(p.element('notify').checked, false);
});

test('existing and newly created links survive a failed server save, and are reused on retry', async () => {
  for (const existing of [true, false]) {
    const accepted = deferred();
    const p = page({ existing, accepted });
    await settle();
    const held = p.subscription();
    accepted.resolve({ ok: false, status: 503 });
    await settle();
    assert.equal(p.subscription(), held);
    assert.equal(p.element('notify').checked, false);
    assert.equal(p.element('notifyrestore').hidden, false);
    await p.observer(); await settle();
    assert.equal(p.element('notify').checked, false, 'drawer must not claim an unaccepted link is on');
    assert.equal(subscribes(p).length, existing ? 0 : 1);
    accepted.promise = Promise.resolve({ ok: true });
    await p.tap('notifyrestore');
    assert.equal(p.subscription(), held);
    assert.equal(p.element('notify').checked, true);
  }
});

test('an enabled existing link is reposted and the old unsaved choice is adopted', async () => {
  const p = page({ existing: true, choice: null });
  await settle();
  assert.equal(p.storage.get(CHOICE), 'on');
  assert.equal(posted(p).length, 1);
  assert.equal(subscribes(p).length, 0);
  assert.equal(p.element('notify').checked, true);
});

test('permission alone does not invent a choice for an older phone with no link', async () => {
  const p = page({ choice: null });
  await settle();
  assert.equal(p.storage.has(CHOICE), false);
  assert.equal(subscribes(p).length, 0);
});

test('Off during subscription creation cancels the repair and removes its late link', async () => {
  const creating = deferred();
  const p = page({ creating });
  await settle();
  assert.equal(p.element('notifyoff').hidden, true, 'Off waits a moment so a quick success shows nothing');
  p.later();
  assert.equal(p.element('notifyoff').hidden, false);
  const off = p.tap('notifyoff');
  assert.equal(p.storage.get(CHOICE), 'off');
  creating.resolve(); await off; await settle();
  assert.equal(p.subscription(), null);
  assert.equal(posted(p).length, 0);
  assert.equal(p.element('notify').checked, false);
});

test('sign-out cancels a pending save, removes the link and choice, and closes our notifications', async () => {
  const accepted = deferred();
  const p = page({ accepted });
  await settle();
  const out = p.run('signOut()');
  assert.equal(p.storage.has(CHOICE), false);
  accepted.resolve({ ok: true }); await out; await settle();
  assert.equal(p.subscription(), null);
  assert.equal(p.storage.has(ENDPOINT), false);
  assert.deepEqual(p.closed, ['ours']);
  assert.deepEqual(p.navigated, ['/m']);
  p.return(); await settle();
  assert.equal(posted(p).length, 1);
  assert.equal(p.element('notify').checked, false);
});

test('sign-out still removes the phone subscription when the Mac removal fails', async () => {
  const p = page({ existing: true, removeFails: true });
  await settle();
  await p.run('signOut()');
  assert.equal(p.subscription(), null);
  assert.equal(p.storage.has(CHOICE), false);
  assert.ok(p.calls.some(c => c[0] === '/auth/logout'));
});

test('a rejected gesture permission request leaves a clear restore action', async () => {
  const p = page({ permission: 'default' }); await settle();
  p.context.Notification.requestPermission = () => Promise.reject(new Error('refused'));
  await p.tap('notifyrestore');
  assert.equal(p.element('notifyrestore').hidden, false);
  assert.equal(p.element('notify').checked, false);
});

test('a subscription lookup error is a repair failure and never claims success', async () => {
  const p = page({ lookupFails: true }); await settle();
  assert.equal(p.element('notifyrestore').hidden, false);
  assert.match(p.element('notifynote').textContent, /not ready/);
  assert.equal(subscribes(p).length, 0);
});

test('replacement removes only this phone known old endpoint after the board accepts the new one', async () => {
  const storage = new Map([[ENDPOINT, 'https://push.test/private/old']]);
  const p = page({ storage }); await settle();
  const added = p.calls.findIndex(c => c[0] === '/push/subscribe');
  const removed = p.calls.findIndex(c => c[0] === '/push/unsubscribe');
  assert.ok(added >= 0 && removed > added);
  assert.deepEqual(p.calls[removed][1], { endpoint: 'https://push.test/private/old' });
  assert.equal(storage.get(ENDPOINT), p.subscription().endpoint);
});

test('repair controls have clear names and status is announced', () => {
  assert.match(source, /id="notifyrestore"[^>]*>Restore notifications<\/button>/);
  assert.match(source, /id="notifynote"[^>]*role="status"/);
});


test('permission or subscription loss during a server save cannot turn the switch on', async () => {
  for (const lost of ['permission', 'subscription']) {
    const accepted = deferred();
    const p = page({ accepted }); await settle();
    if (lost === 'permission') p.context.Notification.permission = 'denied';
    else p.lose();
    accepted.resolve({ ok: true }); await settle();
    assert.equal(p.element('notify').checked, false, lost);
    assert.equal(p.element('notifyrestore').hidden, false, lost);
  }
});

test('a phone link that resists sign-out is not adopted as wanted on the next sign-in', async () => {
  const p = page({ existing: true, phoneRemoveFails: true }); await settle();
  await p.run('signOut()');
  assert.equal(p.storage.has(CHOICE), false);
  assert.ok(p.subscription());
  const next = page({ choice: null, existing: true, storage: p.storage }); await settle();
  assert.equal(posted(next).length, 0);
  assert.equal(next.storage.has(CHOICE), false);
  assert.equal(next.element('notify').checked, false);
});

test('Off while a gesture subscription is pending also removes the late result', async () => {
  const creating = deferred();
  const p = page({ creating, gestureOnly: true }); await settle();
  const tap = p.tap('notifyrestore');
  const off = p.tap('notifyoff');
  creating.resolve(); await Promise.all([tap, off]); await settle();
  assert.equal(p.subscription(), null);
  assert.equal(posted(p).length, 0);
  assert.equal(p.storage.get(CHOICE), 'off');
});
