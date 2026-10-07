// The phone's Notifications switch must not read off while the phone still
// holds the subscription the board accepted, just because the check on open,
// return or settings could not reach the Mac or waited for it. October 7: the
// phone kept its subscription and showed every push, yet three return checks
// never reached the board over a dropping connection, and each left the switch
// off with "not ready". The phone's own code runs with browser APIs replaced by
// small fakes. No server or browser is started.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const source = readFileSync(process.env.PHONE_NOTIFY_SOURCE || path.join(__dirname, '..', 'm.html'), 'utf8');
const CHOICE = 'phoneNotifications', ENDPOINT = 'phoneNotificationEndpoint';
const ACCEPTED = 'https://push.test/private/accepted';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

// held: the endpoint the phone's push manager holds, or null.
// remembered: the endpoint the page saved after the board last accepted it.
// board: what each /push/subscribe answers. A deferred is waited on, an Error
// is thrown as a failed fetch, anything else is the response.
function page({ choice = 'on', permission = 'granted', held = ACCEPTED, remembered = ACCEPTED, board = () => ({ ok: true, status: 200 }) } = {}) {
  const storage = new Map();
  if (choice !== null) storage.set(CHOICE, choice);
  if (remembered) storage.set(ENDPOINT, remembered);
  const elements = new Map(), documentEvents = {}, windowEvents = {};
  const switchWrites = [], notes = [], calls = [];
  let sub = null, count = 0, observer, timers = [], drawer = false;
  const listen = events => (name, fn) => (events[name] ||= []).push(fn);
  function element(id) {
    if (!elements.has(id)) {
      let checked = false, text = '', hidden = true;
      elements.set(id, { disabled: false, events: {},
        get checked() { return checked; },
        set checked(value) { checked = value; if (id === 'notify') switchWrites.push(value); },
        get textContent() { return text; },
        set textContent(value) { text = value; if (value) notes.push([id, value]); },
        get hidden() { return hidden; },
        set hidden(value) { hidden = value; if (!value) notes.push([id, 'shown']); },
        addEventListener(name, fn) { this.events[name] = fn; } });
    }
    return elements.get(id);
  }
  const makeSub = endpoint => {
    const result = { endpoint, toJSON: () => ({ endpoint, keys: { auth: 'secret', p256dh: 'secret-key' } }),
      async unsubscribe() { calls.push(['phone-remove', endpoint]); if (sub === result) sub = null; return true; } };
    return result;
  };
  if (held) sub = makeSub(held);
  const reg = { pushManager: {
    async getSubscription() { return sub; },
    async subscribe() { calls.push(['subscribe']); sub = makeSub('https://push.test/private/new' + ++count); return sub; },
  } };
  const context = vm.createContext({
    console, Promise, AbortSignal, Set, macHost: null, swReg: reg, keyBytes: key => key,
    setTimeout: fn => timers.push(fn), clearTimeout: id => { if (id) timers[id - 1] = null; },
    settings: { classList: { contains: () => drawer } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    navigator: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: async () => reg } },
    Notification: { permission, requestPermission: async () => context.Notification.permission },
    PushManager: function() {},
    document: { hidden: false, getElementById: element, addEventListener: listen(documentEvents) },
    addEventListener: listen(windowEvents),
    fetch: async (url, init = {}) => {
      calls.push([url, init.body ? JSON.parse(init.body) : null]);
      if (url === '/push/key') return { ok: true, json: async () => ({ key: 'public-key' }) };
      if (url === '/push/subscribe') {
        const answer = board();
        if (answer instanceof Error) throw answer;
        return answer && answer.promise ? answer.promise : answer;
      }
      return { ok: true, status: 200 };
    },
  });
  context.window = context;
  const from = source.indexOf('const notifySwitch =');
  const to = source.indexOf('// each time the app starts or comes back', from);
  assert.ok(from > 0 && to > from);
  vm.runInContext(source.slice(from, to), context);
  return {
    context, calls, storage, switchWrites, notes, element,
    subscription: () => sub, lose: () => { sub = null; },
    later() { const due = timers; timers = []; for (const fn of due) fn?.(); },
    openSettings() { drawer = true; observer(); },
    closeSettings() { drawer = false; observer(); },
    return() { context.document.hidden = false; for (const fn of documentEvents.visibilitychange || []) fn(); },
  };
}

const posted = p => p.calls.filter(c => c[0] === '/push/subscribe');
const restoreShown = p => p.element('notifyrestore').hidden === false;

test('a start check reads on before the board answers when the phone holds the accepted link', async () => {
  const answer = deferred();
  const p = page({ board: () => answer });
  await settle();
  assert.equal(posted(p).length, 1, 'the link is still sent to the board again');
  assert.equal(p.element('notify').checked, true, 'the switch must not wait for the Mac to read on');
  assert.equal(p.element('notify').disabled, false);
  answer.resolve({ ok: true, status: 200 }); await settle();
  assert.equal(p.element('notify').checked, true);
});

test('opening settings never draws the switch off while the board is slow to answer', async () => {
  let answer = { ok: true, status: 200 };
  const p = page({ board: () => answer });
  await settle();
  assert.equal(p.element('notify').checked, true);
  const slow = deferred();
  answer = slow;
  p.switchWrites.length = 0;
  p.openSettings(); await settle();
  assert.equal(posted(p).length, 2, 'opening settings sends the link again');
  assert.ok(!p.switchWrites.includes(false), 'the switch was drawn off during the check: ' + JSON.stringify(p.switchWrites));
  assert.equal(p.element('notify').checked, true);
  assert.equal(p.element('notify').disabled, false);
  slow.resolve({ ok: true, status: 200 }); await settle();
  assert.ok(!p.switchWrites.includes(false));
  assert.equal(p.element('notify').checked, true);
});

test('a return check that cannot reach the Mac leaves the switch on and quiet', async () => {
  let answer = { ok: true, status: 200 };
  const p = page({ board: () => answer });
  await settle();
  // the three October 7 returns: a dropped connection, an abort, a refusal
  for (const failure of [new TypeError('Load failed'), new Error('Fetch is aborted'), { ok: false, status: 502 }]) {
    answer = failure;
    p.switchWrites.length = 0; p.notes.length = 0;
    p.return(); await settle(); p.later();
    assert.ok(!p.switchWrites.includes(false), 'switch drawn off after ' + JSON.stringify(String(failure.message || failure.status)));
    assert.equal(p.element('notify').checked, true);
    assert.equal(p.element('notify').disabled, false);
    assert.equal(restoreShown(p), false, 'Restore is for a link that needs a tap, not a Mac out of reach');
    assert.equal(p.element('notifyoff').hidden, true);
    assert.deepEqual(p.notes, [], 'no words or buttons appear');
  }
  assert.equal(p.subscription().endpoint, ACCEPTED, 'the phone link is untouched');
  assert.equal(p.calls.some(c => c[0] === 'phone-remove' || c[0] === '/push/unsubscribe' || c[0] === 'subscribe'), false);
  assert.equal(p.storage.get(CHOICE), 'on');
  answer = { ok: true, status: 200 };
  p.return(); await settle();
  assert.equal(p.element('notify').checked, true);
});

test('a start check that times out still reads on', async () => {
  const answer = deferred();
  const p = page({ board: () => answer });
  await settle();
  answer.reject(new Error('The operation timed out.')); await settle();
  assert.equal(p.element('notify').checked, true);
  assert.equal(restoreShown(p), false);
  assert.equal(p.element('notifynote').textContent, '');
});

test('a new link still waits for the board, and a failed save still reads off with Restore', async () => {
  for (const remembered of [null, 'https://push.test/private/older']) {
    const answer = deferred();
    const p = page({ remembered, board: () => answer });
    await settle();
    assert.equal(p.element('notify').checked, false, 'unaccepted link read on (' + remembered + ')');
    answer.resolve({ ok: false, status: 503 }); await settle();
    assert.equal(p.element('notify').checked, false);
    assert.equal(restoreShown(p), true);
  }
});

test('a missing link with a remembered endpoint is still a repair that waits for the board', async () => {
  const answer = deferred();
  const p = page({ held: null, board: () => answer });
  await settle();
  assert.equal(p.calls.filter(c => c[0] === 'subscribe').length, 1);
  assert.equal(p.element('notify').checked, false);
  answer.resolve({ ok: true, status: 200 }); await settle();
  assert.equal(p.element('notify').checked, true);
});

test('lost permission and a lost link still read off on the next check', async () => {
  const p = page();
  await settle();
  assert.equal(p.element('notify').checked, true);
  p.context.Notification.permission = 'denied';
  p.return(); await settle();
  assert.equal(p.element('notify').checked, false);
  assert.equal(restoreShown(p), true);
  p.context.Notification.permission = 'granted';
  const answer = deferred();
  const q = page({ board: () => answer });
  await settle();
  q.lose();
  answer.resolve({ ok: true, status: 200 }); await settle();
  assert.equal(q.element('notify').checked, false, 'a link gone after the save reads off');
  assert.equal(restoreShown(q), true);
});

test('an off choice is never shown on, even with the accepted link still held', async () => {
  const p = page({ choice: 'off' });
  await settle();
  assert.equal(p.element('notify').checked, false);
  assert.equal(posted(p).length, 0);
});

test('Off while a kept link is being sent again still turns notifications off', async () => {
  const answer = deferred();
  const p = page({ board: () => answer });
  await settle();
  assert.equal(p.element('notify').checked, true);
  const sw = p.element('notify');
  sw.checked = false;
  const off = sw.events.change();
  assert.equal(p.storage.get(CHOICE), 'off');
  answer.resolve({ ok: true, status: 200 }); await off; await settle();
  assert.equal(p.subscription(), null);
  assert.equal(sw.checked, false);
  p.return(); await settle();
  assert.equal(sw.checked, false);
});
