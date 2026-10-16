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
                accepted = null, creating = null, removeFails = false, lookupFails = false, phoneRemoveFails = false,
                logoutFails = false, noPush = false, noWorker = false } = {}) {
  if (choice !== null) storage.set(CHOICE, choice);
  const elements = new Map(), windowEvents = {}, documentEvents = {};
  const calls = [], closed = [], navigated = [];
  let gesture = false, sub = null, count = 0, observer, timers = [];
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  function element(id) {
    if (!elements.has(id)) elements.set(id, { checked: false, disabled: false, textContent: '', events: {},
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
    setTimeout: fn => timers.push(fn), clearTimeout: id => { if (id) timers[id - 1] = null; }, swReg: noWorker ? null : reg, keyBytes: key => key,
    settings: { classList: { contains: () => true } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    navigator: noWorker ? {} : { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
    Notification: { permission, requestPermission() { calls.push(['permission', gesture]); return Promise.resolve(context.Notification.permission); } },
    ...(noPush ? {} : { PushManager: function() {} }),
    document: { hidden: false, getElementById: element, addEventListener: listen(documentEvents) },
    addEventListener: listen(windowEvents),
    caches: { keys: async () => [], delete: async () => true },
    location: { replace: url => navigated.push(url) },
    fetch: async (url, init = {}) => {
      calls.push([url, init.body ? JSON.parse(init.body) : null]);
      if (url === '/push/key') return { ok: true, json: async () => ({ key: 'public-key' }) };
      if (url === '/push/subscribe' && accepted) return accepted.promise;
      if (url === '/push/unsubscribe' && removeFails) throw new Error('offline');
      if (url === '/auth/logout' && logoutFails) return { ok: false, status: 503 };
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
    context, calls, storage, closed, navigated, element, reg, observer: () => observer(), ids: () => [...elements.keys()],
    subscription: () => sub, lose: () => { sub = null; },
    later() { const due = timers; timers = []; for (const fn of due) fn?.(); },
    run: code => vm.runInContext(code, context),
    async tap(id, checked) {
      const el = element(id);
      if (checked !== undefined) el.checked = checked;
      gesture = true;
      let work;
      try { work = el.events[checked === undefined ? 'click' : 'change'](); }
      finally { gesture = false; }      await work;
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

test('a refused silent subscribe leaves the switch off, and a tap on the switch subscribes', async () => {
  const p = page({ gestureOnly: true });
  await settle();
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
  assert.equal(p.storage.get(CHOICE), 'on');
  await p.tap('notify', true);
  assert.deepEqual(subscribes(p).map(c => c[1]), [false, true]);
  assert.equal(p.element('notify').checked, true);
  assert.equal(posted(p).length, 1);
});

test('permission is never requested by recovery, but an enable tap requests it synchronously', async () => {
  const p = page({ permission: 'default' });
  await settle();
  assert.equal(p.calls.some(c => c[0] === 'permission'), false);
  assert.equal(subscribes(p).length, 0);
  assert.equal(p.element('notify').checked, false);
  await p.tap('notify', true);
  assert.deepEqual(p.calls.filter(c => c[0] === 'permission'), [['permission', true]]);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
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
    await p.observer(); await settle();
    assert.equal(p.element('notify').checked, false, 'drawer must not claim an unaccepted link is on');
    assert.equal(subscribes(p).length, existing ? 0 : 1);
    accepted.promise = Promise.resolve({ ok: true });
    await p.tap('notify', true);
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
  assert.equal(p.element('notify').disabled, true, 'the switch waits while the link is being made');
  const off = p.tap('notify', false);
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

test('a rejected gesture permission request leaves the switch off and ready for another tap', async () => {
  const p = page({ permission: 'default' }); await settle();
  p.context.Notification.requestPermission = () => Promise.reject(new Error('refused'));
  await p.tap('notify', true);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
});

test('a subscription lookup error is a repair failure and never claims success', async () => {
  const p = page({ lookupFails: true }); await settle();
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
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

test('the Notifications section is its title, its one line and the switch, with no button', () => {
  const from = source.indexOf('<div data-section="notifications"');
  const section = source.slice(from, source.indexOf('<div data-section="improvements"', from));
  assert.ok(from > 0 && section.length > 0);
  assert.match(section, /<span>Notifications<\/span>/);
  assert.match(section, /<input type="checkbox" role="switch" id="notify" aria-describedby="notifynote">/);
  assert.match(section, /<small id="notifynote" class="sethelp" role="status" aria-live="polite"><\/small>/);
  assert.doesNotMatch(section, /<button|<p[ >]/);
});

const PERMISSION_OFF = "Notifications are wanted, but permission is off in the phone's settings.";
const NO_PUSH = 'Add this page to the home screen first, then ask again from there';
const NO_WORKER = 'Notifications need the page served over https';

test('a failure writes no line except the three that tell the person something to act on', async () => {
  for (const options of [{ gestureOnly: true }, { lookupFails: true }, { permission: 'denied' },
                         { removeFails: true, choice: 'off', existing: true }]) {
    const p = page(options);
    await settle();
    await p.tap('notify', true);
    assert.equal(p.element('notifynote').textContent, options.permission ? PERMISSION_OFF : '', JSON.stringify(options));
    await p.tap('notify', false);
    assert.deepEqual(p.ids().sort(), ['notify', 'notifynote'], JSON.stringify(options));
  }
});

test('permission off in the phone shows its line with no button, and turning on clears it', async () => {
  const p = page({ permission: 'denied' });
  await settle();
  assert.equal(p.element('notifynote').textContent, PERMISSION_OFF);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.ids().includes('notifyrestore'), false);
  p.context.Notification.permission = 'granted';
  await p.tap('notify', true);
  assert.equal(p.element('notify').checked, true);
  assert.equal(p.element('notifynote').textContent, '');
});

test('a phone without push support keeps the switch off, says why and does nothing harmful', async () => {
  const p = page({ noPush: true });
  await settle();
  await p.tap('notify', true);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
  assert.equal(p.element('notifynote').textContent, NO_PUSH);
  assert.equal(subscribes(p).length, 0);
  assert.equal(posted(p).length, 0);
});

test('a page with no service worker keeps the switch off, says why and does nothing harmful', async () => {
  const p = page({ noWorker: true });
  await settle();
  await p.tap('notify', true);
  assert.equal(p.element('notify').checked, false);
  assert.equal(p.element('notify').disabled, false);
  assert.equal(p.element('notifynote').textContent, NO_WORKER);
  assert.equal(subscribes(p).length, 0);
  assert.equal(posted(p).length, 0);
});

test('a failed sign-out says so under the mark and gives the button back', async () => {
  const p = page({ logoutFails: true });
  await settle();
  await p.run('signOut()');
  assert.equal(p.element('signout').disabled, false);
  assert.deepEqual(p.navigated, []);
  assert.equal(p.element('signoutnote').textContent, 'Could not sign out. Check your connection and try again.');
});


test('permission or subscription loss during a server save cannot turn the switch on', async () => {
  for (const lost of ['permission', 'subscription']) {
    const accepted = deferred();
    const p = page({ accepted }); await settle();
    if (lost === 'permission') p.context.Notification.permission = 'denied';
    else p.lose();
    accepted.resolve({ ok: true }); await settle();
    assert.equal(p.element('notify').checked, false, lost);
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
  const tap = p.tap('notify', true);
  const off = p.tap('notify', false);
  creating.resolve(); await Promise.all([tap, off]); await settle();
  assert.equal(p.subscription(), null);
  assert.equal(posted(p).length, 0);
  assert.equal(p.storage.get(CHOICE), 'off');
});

// iPhone answers its prompt before its own notification settings hold the
// grant, and a subscription made in that moment is refused as denied although
// the permission already reads granted. The tap grants; the first refusals
// stand for that moment.
function grantOnTap(p, refusals, name = 'NotAllowedError') {
  p.context.Notification.requestPermission = () => {
    p.calls.push(['permission']);
    p.context.Notification.permission = 'granted';
    return Promise.resolve('granted');
  };
  const subscribe = p.reg.pushManager.subscribe;
  p.reg.pushManager.subscribe = function (...args) {
    if (refusals-- > 0) {
      p.calls.push(['subscribe', 'refused']);
      return Promise.reject(Object.assign(new Error('User denied push permission'), { name }));
    }
    return subscribe.apply(this, args);
  };
}
async function waitOut(p, rounds) { for (let n = 0; n < rounds; n++) { await settle(); p.later(); } await settle(); }

test('a subscription refused just after the prompt is granted is asked again, and the switch turns on with nothing else', async () => {
  const p = page({ choice: 'off', permission: 'default' }); await settle();
  grantOnTap(p, 2);
  const tap = p.tap('notify', true);
  await waitOut(p, 4); await tap;
  assert.deepEqual(p.calls.filter(c => c[0] === 'permission'), [['permission']]);
  assert.equal(subscribes(p).length, 3);
  assert.equal(posted(p).length, 1);
  assert.equal(p.element('notify').checked, true);
  assert.equal(p.element('notifynote').textContent, '');
});

test('a grant the phone takes in at once turns the switch on with one subscription', async () => {
  const p = page({ choice: 'off', permission: 'default' }); await settle();
  grantOnTap(p, 0);
  await p.tap('notify', true);
  assert.equal(subscribes(p).length, 1);
  assert.equal(p.element('notify').checked, true);
});

test('a refusal that outlasts the asking, or any other failure, shows the real state', async () => {
  for (const [name, asked] of [['NotAllowedError', 6], ['AbortError', 1]]) {
    const p = page({ choice: 'off', permission: 'default' }); await settle();
    grantOnTap(p, Infinity, name);
    const tap = p.tap('notify', true);
    await waitOut(p, 8); await tap;
    assert.equal(subscribes(p).length, asked, name);
    assert.equal(posted(p).length, 0, name);
    assert.equal(p.element('notify').checked, false, name);
    assert.equal(p.element('notify').disabled, false, name);
    assert.equal(p.element('notifynote').textContent, '', name);
  }
});

test('Off while a refused subscription waits to be asked again stops the asking', async () => {
  const p = page({ choice: 'off', permission: 'default' }); await settle();
  grantOnTap(p, 1);
  const tap = p.tap('notify', true);
  await settle();
  const off = p.tap('notify', false);
  await waitOut(p, 2); await Promise.all([tap, off]);
  assert.equal(subscribes(p).length, 1);
  assert.equal(posted(p).length, 0);
  assert.equal(p.subscription(), null);
  assert.equal(p.storage.get(CHOICE), 'off');
  assert.equal(p.element('notify').checked, false);
});
