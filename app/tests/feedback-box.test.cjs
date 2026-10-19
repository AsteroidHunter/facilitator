// The feedback box in Settings, Improvements, on the Mac board and the phone:
// where it stands, how it behaves (locked, the arrow, the three seconds to
// cancel, a send that went and one that did not), and how each page wires it
// (its gate from the profile, its Enter rule, POST /feedback). The shared logic
// is feedbackBox in card-logic.js, run in a vm with small fake elements and a
// fake clock; each page's own block is run the same way, with the profile and
// the board replaced by fakes. No browser and no server.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const MAC = readFileSync(path.join(ROOT, "index.html"), "utf8");
const PHONE = readFileSync(path.join(ROOT, "m.html"), "utf8");
const TOKENS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
const settle = async () => { for (let n = 0; n < 20; n++) await new Promise(resolve => setImmediate(resolve)); };

function between(source, from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} ... ${to} is not in the source`);
  return source.slice(start, end);
}

// the page's rules for Enter, from the real card-logic.js
const KEYS = between(LOGIC, "function controlShiftEnter(e){", "// The card on screen stands raised");
const FEEDBACK = between(LOGIC, "// ---- the feedback box", "// ---- a card's magic box");

// a clock the box's timer runs on, moved by hand
function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

function fakeElement(extra = {}) {
  const classes = new Set(), listeners = {};
  return {
    value: "", disabled: false, readOnly: false, dataset: {}, textContent: "", attrs: {}, props: {}, listeners,
    style: { setProperty(k, v) { this.props = { ...this.props, [k]: v }; }, props: {} },
    classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, add: c => classes.add(c),
                 remove: c => classes.delete(c), contains: c => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { listeners[type] = fn; },
    ...extra,
  };
}

function box({ ready = true, send, enter, wait, moved } = {}) {
  const time = clock();
  const sent = [];
  const els = { box: fakeElement(), ta: fakeElement(), send: fakeElement(), note: fakeElement() };
  const context = vm.createContext({ setTimeout: time.setTimeout, clearTimeout: time.clearTimeout, Promise });
  vm.runInContext(FEEDBACK, context);
  const api = vm.runInContext("feedbackBox", context)(els, {
    ready, wait, moved,
    send: send || (async text => { sent.push(text); return true; }),
    enter: enter || (e => e.key === "Enter" && !e.shiftKey),
  });
  return {
    els, api, time, sent,
    type(text) { els.ta.value = text; els.ta.listeners.input(); },
    press() { els.send.listeners.click(); },
    key(e) {
      const event = { key: "Enter", shiftKey: false, repeat: false, prevented: false, preventDefault() { this.prevented = true; }, ...e };
      els.ta.listeners.keydown(event);
      return event;
    },
    arrow: () => els.send.classList.contains("show"),
    state: () => els.box.dataset.state,
  };
}

test("greyed out while the profile has no name or no email: box and arrow cannot be used, one grey line says why", () => {
  const b = box({ ready: false });
  assert.equal(b.state(), "locked");
  assert.equal(b.els.ta.disabled, true);
  assert.equal(b.els.send.disabled, true);
  assert.equal(b.els.note.textContent, "Fill in your name and email in Profile to send feedback.");
  assert.equal(b.arrow(), false, "an arrow stands over an empty box");
  b.press();
  assert.equal(b.api.state(), "locked", "a greyed arrow started a send");
  assert.equal(b.time.pending(), 0);
});

test("it comes alive as soon as the profile is filled in, with no reload", () => {
  const b = box({ ready: false });
  b.api.setReady(true);
  assert.equal(b.state(), "idle");
  assert.equal(b.els.ta.disabled, false);
  assert.equal(b.els.send.disabled, false);
  assert.equal(b.els.note.textContent, "");
  b.api.setReady(false);
  assert.equal(b.state(), "locked");
});

test("the arrow appears once anything is typed and goes when the box is empty again", () => {
  const b = box();
  assert.equal(b.arrow(), false);
  b.type("   ");
  assert.equal(b.arrow(), false, "blanks alone show an arrow");
  b.type("a");
  assert.equal(b.arrow(), true);
  b.type("");
  assert.equal(b.arrow(), false);
});

test("pressing the arrow turns it into a cross with the bar filling for three seconds, then the message goes", async () => {
  const b = box();
  b.type("Make the bin say how old a card is");
  b.press();
  assert.equal(b.state(), "counting");
  assert.equal(b.els.box.style.props["--fb-ms"], "3000ms", "the bar does not run three seconds");
  assert.equal(b.els.send.attrs["aria-label"], "Cancel sending");
  assert.equal(b.els.ta.readOnly, true, "the words can change while they count down");
  assert.equal(b.arrow(), true, "the cross is not shown");
  b.time.tick(2999);
  await settle();
  assert.deepEqual(b.sent, [], "it went before the three seconds");
  assert.equal(b.state(), "counting");
  b.time.tick(1);
  await settle();
  assert.deepEqual(b.sent, ["Make the bin say how old a card is"]);
});

test("pressing the cross in the three seconds cancels: nothing is sent and the text stays", async () => {
  const b = box();
  b.type("Keep these words");
  b.press();
  b.time.tick(1500);
  b.press();
  assert.equal(b.state(), "idle");
  assert.equal(b.els.ta.readOnly, false);
  assert.equal(b.els.ta.value, "Keep these words");
  assert.equal(b.arrow(), true);
  assert.equal(b.els.send.attrs["aria-label"], "Send feedback");
  b.time.tick(10000);
  await settle();
  assert.deepEqual(b.sent, [], "a cancelled message went");
  assert.equal(b.time.pending(), 0);
  // and it can be sent after all
  b.press();
  b.time.tick(3000);
  await settle();
  assert.deepEqual(b.sent, ["Keep these words"]);
});

test("a message that went empties the box; one that did not leaves the words and says so in one grey line", async () => {
  const went = box();
  went.type("Thanks");
  went.press();
  went.time.tick(3000);
  await settle();
  assert.equal(went.els.ta.value, "");
  assert.equal(went.state(), "idle");
  assert.equal(went.arrow(), false);
  assert.equal(went.els.note.textContent, "Sent. Thank you.");
  went.type("again");
  assert.equal(went.els.note.textContent, "", "the line stays once typing starts again");

  for (const how of [async () => false, async () => { throw new Error("offline"); }, () => null]) {
    const lost = box({ send: how });
    lost.type("Do not lose me");
    lost.press();
    lost.time.tick(3000);
    await settle();
    assert.equal(lost.els.ta.value, "Do not lose me");
    assert.equal(lost.state(), "idle");
    assert.equal(lost.arrow(), true);
    assert.equal(lost.els.note.textContent, "Did not send. Try again.");
  }
});

// emptying the box from code fires no input, key or selection event, so the Mac
// board's block caret has to be told, and only once the box is already empty
// (the caret measures on the next frame)
test("the caret is told to measure once a sent message has emptied the box, and not otherwise", async () => {
  let measured = null, queued = false;
  const went = box({ moved: () => { queued = true; measured = { value: went.els.ta.value, state: went.state() }; } });
  went.type("test");
  went.press();
  went.time.tick(2999);
  await settle();
  assert.equal(queued, false, "the caret was told while the words still stood");
  went.time.tick(1);
  await settle();
  assert.equal(queued, true, "emptying the box did not tell the caret");
  assert.deepEqual(measured, { value: "", state: "idle" }, "the caret was told before the box was empty");

  // a send that did not go keeps its words where they are, and so does a cancel
  for (const how of [async () => false, async () => { throw new Error("offline"); }]) {
    let told = 0;
    const lost = box({ send: how, moved: () => { told++; } });
    lost.type("keep");
    lost.press();
    lost.time.tick(3000);
    await settle();
    assert.equal(told, 0, "the caret was told though the words stayed");
  }
  let told = 0;
  const cancelled = box({ moved: () => { told++; } });
  cancelled.type("keep");
  cancelled.press();
  cancelled.time.tick(1000);
  cancelled.press();
  assert.equal(told, 0);
  assert.equal(cancelled.els.ta.value, "keep");

  // a page with no caret of its own (the phone) hands in nothing and still works
  const plain = box();
  plain.type("test");
  plain.press();
  plain.time.tick(3000);
  await settle();
  assert.equal(plain.els.ta.value, "");
});

test("Enter follows the page's rule: it starts the send, a refused key does not, and Enter in the countdown does nothing", async () => {
  const b = box({ enter: e => e.key === "Enter" && !e.shiftKey });
  b.type("");
  assert.equal(b.key({}).prevented, true, "Enter in an empty box is not left to break a line");
  assert.equal(b.state(), "idle");
  b.type("words");
  assert.equal(b.key({ shiftKey: true }).prevented, false, "Shift+Enter did not break the line");
  assert.equal(b.state(), "idle");
  assert.equal(b.key({ key: "a" }).prevented, false);
  b.key({});
  assert.equal(b.state(), "counting");
  b.key({});
  assert.equal(b.state(), "counting", "a second Enter cancelled or restarted the count");
  b.key({ repeat: true });
  b.time.tick(3000);
  await settle();
  assert.deepEqual(b.sent, ["words"]);
});

test("losing the name or email during the countdown stops the send", async () => {
  const b = box();
  b.type("Cleared my email");
  b.press();
  b.time.tick(1000);
  b.api.setReady(false);
  assert.equal(b.state(), "locked");
  b.time.tick(5000);
  await settle();
  assert.deepEqual(b.sent, []);
  assert.equal(b.els.ta.value, "Cleared my email");
});

test("it is not the accent: the ring, the cross and the arrow wear the page's ink", () => {
  const rules = TOKENS.slice(TOKENS.indexOf("the feedback box (feedbackBox"), TOKENS.indexOf("/* an action is a button"));
  assert.ok(rules.includes(".fbring .fbprog"), "the bar's rule is missing");
  assert.doesNotMatch(rules, /--accent|purple|violet/i);
  assert.match(rules, /\.fbring \.fbprog\{stroke:var\(--ink\)/);
  assert.match(rules, /animation:fbfill var\(--fb-ms, 3000ms\) linear/);
});

// ---- where it stands on each page -----------------------------------------------

function improvements(source, from, to) {
  const setsrc = between(source, from, to);
  const start = setsrc.indexOf('<div data-section="improvements"');
  assert.ok(start >= 0, "no Improvements section");
  const rest = setsrc.slice(start);
  const next = rest.indexOf('<div data-section="', 10);
  return next < 0 ? rest : rest.slice(0, next);
}
const VIEWS = {
  mac: improvements(MAC, '<div id="setsrc"', '<div id="appframe"'),
  phone: improvements(PHONE, '<div id="setsrc">', '<div id="setfoot">'),
};

for (const [name, html] of Object.entries(VIEWS)) {
  test(`the ${name} settings put the feedback box above the usage switch, tall, with no send button of its own`, () => {
    const box = html.indexOf('id="fbbox"'), usage = html.indexOf('id="setusage"');
    assert.ok(box > 0 && usage > box, "the box is not above Share daily usage counts");
    assert.match(html, /<textarea id="fbta" class="fbta" maxlength="5000"/);
    assert.match(html, /<button id="fbsend" class="fbsend"[^>]*\bdisabled>/, "the arrow is not greyed before the profile is read");
    assert.match(html, /<textarea[^>]*\bdisabled>/, "the box is not greyed before the profile is read");
    assert.match(html, /data-state="locked"/);
    assert.equal((html.match(/<button/g) || []).length, 1, "there is more than the one arrow");
    // the same arrow as a card's typing box, the cross and the ring
    assert.ok(html.includes('d="M7 11.5V3.5M3.6 6.9 7 3.5l3.4 3.4"'));
    assert.match(html, /class="fbcross"/);
    assert.match(html, /class="fbring"/);
    assert.doesNotMatch(html, /accent/);
    assert.match(html, /<div class="setrow fbrow">/);
  });
}

test("the box is a tall one, with room under its words for the arrow", () => {
  assert.match(TOKENS, /\.fbta\{[^}]*height:190px/);
  assert.match(TOKENS, /\.fbta\{[^}]*padding:10px 12px 48px/);
  assert.match(TOKENS, /\.fbsend\{position:absolute; right:calc\(8 \* var\(--u, 1px\)\); bottom:calc\(8 \* var\(--u, 1px\)\)/);
});

// ---- the Mac page's wiring ---------------------------------------------------------

function macPage({ profile }) {
  const elements = new Map(), calls = [], gate = [], built = {}, caret = { queued: 0 };
  const element = id => {
    if (!elements.has(id)) elements.set(id, fakeElement({ id, checked: false, closest: () => element("fbrow") }));
    return elements.get(id);
  };
  let overlay = null;
  const sheet = { opened: 0, closed: 0, seated: 0, focused: 0, hooks: null, row: null };
  const context = vm.createContext({
    document: { getElementById: element, body: { classList: { add() {}, remove() {} } } },
    settingsStore: { getItem: () => null, setItem() {}, removeItem() {} },
    settingsOverlay: (host, source, opts) => { overlay = opts; return { open: () => opts.onOpen() }; },
    feedbackOverlay: (host, row, opts) => {
      sheet.row = row; sheet.hooks = opts;
      return { open: () => { sheet.opened++; opts.onOpen(); }, close: () => { sheet.closed++; opts.onClose(); },
               seat: () => { sheet.seated++; }, focus: () => { sheet.focused++; } };
    },
    ComposeFormat: { enabled: () => false, setEnabled() {}, onChange() {}, preload() {} },
    waitNewestFirst: () => false, lastState: null, renderCarousel() {},
    SETTINGS_PICTURES: {}, settingsZoneWords: () => "",
    // the board's block caret hands its queue over later (index.html), so the page must look it up when it is told
    queueFatCaret: () => { caret.queued++; },
    feedbackBox: (els, opts) => { Object.assign(built, { els, opts }); return { setReady: ready => gate.push(ready) }; },
    fetch: async (url, init = {}) => {
      calls.push([url, init.method || "GET", init.body ? JSON.parse(init.body) : null]);
      if (url === "/profile") return { ok: true, json: async () => ({ ...profile }) };
      if (url === "/feedback") return { ok: true };
      return { ok: false };
    },
  });
  vm.runInContext(KEYS, context);
  vm.runInContext(between(MAC, "// ---- settings ----", "function buildHandles()"), context);
  return { calls, gate, built, caret, element, sheet, open: () => element("setbtn").listeners.click() };
}

test("on the Mac page the box follows the profile when the page opens, and the fields as they are typed in", async () => {
  const page = macPage({ profile: { name: "Ada", email: "ada@example.org" } });
  assert.deepEqual(Object.keys(page.built.els), ["box", "ta", "send", "note"]);
  assert.equal(page.built.els.box.id, "fbbox");
  page.open();
  await settle();
  assert.deepEqual(page.gate, [true]);

  // the name or the email being typed away wakes or greys the box at once
  const name = page.element("setname"), email = page.element("setemail");
  name.value = "Ada"; email.value = "ada@example";
  email.listeners.input();
  assert.equal(page.gate.at(-1), false, "an email with no dot after the @ woke the box");
  email.value = "ada@example.org";
  email.listeners.input();
  assert.equal(page.gate.at(-1), true);
  name.value = "  ";
  name.listeners.input();
  assert.equal(page.gate.at(-1), false);

  const empty = macPage({ profile: { name: "Ada", email: null } });
  empty.open();
  await settle();
  assert.deepEqual(empty.gate, [false]);
});

test("the Mac sends through POST /feedback and answers whether it went; Enter sends and Shift+Enter breaks the line", async () => {
  const page = macPage({ profile: { name: "Ada", email: "ada@example.org" } });
  const { opts } = page.built;
  assert.equal(await opts.send("Hello there"), true);
  assert.deepEqual(page.calls.at(-1), ["/feedback", "POST", { message: "Hello there" }]);
  const key = e => opts.enter({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...e });
  assert.equal(key({}), true);
  assert.equal(key({ shiftKey: true }), false);
  assert.equal(key({ altKey: true }), false);
  assert.equal(key({ ctrlKey: true }), false, "Control+Enter alone is the system's");
  assert.equal(key({ ctrlKey: true, shiftKey: true }), true, "Control+Shift+Enter sends as plain Enter does");
  assert.equal(key({ isComposing: true }), false);
  assert.equal(key({ key: "a" }), false);
});

test("the Mac page has the block caret measure again when the box is emptied", () => {
  const page = macPage({ profile: { name: "Ada", email: "ada@example.org" } });
  assert.equal(typeof page.built.opts.moved, "function", "the Mac page does not hear that the box was emptied");
  assert.equal(page.caret.queued, 0);
  page.built.opts.moved();
  assert.equal(page.caret.queued, 1, "it did not reach the block caret's queue");
  assert.match(MAC, /let queueFatCaret = \(\) => \{\};/);
});

// ---- the phone's wiring --------------------------------------------------------------

function phonePage({ profile, keyboard = false, refuse = false }) {
  const elements = new Map(), calls = [], gate = [], built = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, fakeElement({ id }));
    return elements.get(id);
  };
  const item = fakeElement();
  const context = vm.createContext({
    document: {
      getElementById: element,
      querySelector: sel => (sel === '#setpage .sp-item[data-section="improvements"]' ? item : null),
      body: { classList: { contains: c => c === "kb" && keyboard } },
    },
    feedbackBox: (els, opts) => { Object.assign(built, { els, opts }); return { setReady: ready => gate.push(ready) }; },
    fetch: async (url, init = {}) => {
      calls.push([url, init.method || "GET", init.body ? JSON.parse(init.body) : null]);
      if (url === "/profile") return { ok: true, json: async () => ({ ...profile }) };
      if (url === "/feedback") return { ok: !refuse };
      return { ok: false };
    },
  });
  vm.runInContext(KEYS, context);
  vm.runInContext(between(PHONE, "// the feedback box (feedbackBox in card-logic.js", "const diagnosticButton"), context);
  return { calls, gate, built, profile, item };
}

test("on the phone the box follows the Mac's profile when the page starts and again when Improvements opens", async () => {
  const page = phonePage({ profile: { name: "Ada", email: null } });
  await settle();
  assert.deepEqual(page.gate, [false]);
  page.profile.email = "ada@example.org";   // filled in on the Mac
  page.item.listeners.click();
  await settle();
  assert.deepEqual(page.gate, [false, true], "opening Improvements did not wake the box");
  assert.deepEqual(page.calls.map(c => c[0]), ["/profile", "/profile"]);
});

test("the phone sends through the phone link's POST /feedback, and a refusal is a send that did not go", async () => {
  const page = phonePage({ profile: { name: "Ada", email: "ada@example.org" } });
  assert.equal(await page.built.opts.send("From the phone"), true);
  assert.deepEqual(page.calls.at(-1), ["/feedback", "POST", { message: "From the phone" }]);
  const refused = phonePage({ profile: {}, refuse: true });
  assert.equal(await refused.built.opts.send("x"), false);
});

test("on the phone Enter sends only while the on-screen keyboard is down, as a card's typing box does", () => {
  const key = (page, e) => page.built.opts.enter({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false,
                                                   metaKey: false, isComposing: false, ...e });
  const down = phonePage({ profile: {} }), up = phonePage({ profile: {}, keyboard: true });
  assert.equal(key(down, {}), true);
  assert.equal(key(up, {}), false, "the return key with the keyboard up must make a new line");
  assert.equal(key(up, { ctrlKey: true, shiftKey: true }), true, "Control+Shift+Enter answers whether or not the keyboard is up");
  assert.equal(key(down, { shiftKey: true }), false);
  assert.equal(key(down, { altKey: true }), false);
  assert.equal(key(down, { ctrlKey: true }), false);
  assert.equal(key(down, { isComposing: true }), false);
  assert.equal(key(down, { key: "a" }), false);
});

// ---- the wording ------------------------------------------------------------------------

for (const [name, html] of Object.entries(VIEWS)) {
  test(`the ${name} header reads Share Feedback, with the new grey line under it`, () => {
    assert.match(html, /<label class="setlabel" for="fbta"><span>Share Feedback<\/span>/);
    assert.ok(html.includes('<small class="sethelp">Encountered bugs? Have feature requests or questions? ' +
      'Please tell us how we can improve.</small>'), "the grey line is not the new one");
    assert.doesNotMatch(html, /Tell us what to improve/);
    assert.doesNotMatch(html, /<span>Send feedback<\/span>/);
  });
}

// ---- the Mac's pill and its sheet ---------------------------------------------------------

test("the bar has a bug pill between the speaker and the squid, labelled, with Lucide's bug at the bar's icon size and stroke", () => {
  const bar = between(MAC, '<div class="bar">', "<!-- the pill's list");
  const chime = bar.indexOf('id="chimebtn"'), pill = bar.indexOf('id="feedbackbtn"'), squid = bar.indexOf('id="setbtn"');
  assert.ok(chime > 0 && pill > chime && squid > pill, "the pill is not between the speaker and the squid");
  const tag = bar.slice(pill, bar.indexOf("</button>", pill));
  assert.match(tag, /class="qn-glass"/);
  assert.match(tag, /aria-label="Share feedback"/);
  assert.match(tag, /aria-haspopup="dialog" aria-expanded="false"/);
  const drawn = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"';
  assert.ok(tag.includes(drawn), "the bug is not drawn at the bar's icon size and stroke");
  assert.ok(bar.slice(chime, bar.indexOf("</button>", chime)).includes(drawn), "the speaker's size and stroke moved");
  for (const d of ["M12 20v-9", "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z", "M14.12 3.88 16 2",
    "M21 21a4 4 0 0 0-3.81-4", "M21 5a4 4 0 0 1-3.55 3.97", "M22 13h-4", "M3 21a4 4 0 0 1 3.81-4",
    "M3 5a4 4 0 0 0 3.55 3.97", "M6 13H2", "m8 2 1.88 1.88", "M9 7.13V6a3 3 0 1 1 6 0v1.13"])
    assert.ok(tag.includes(`d="${d}"`), `Lucide's bug is missing ${d}`);
  assert.equal((tag.match(/<path/g) || []).length, 11);
  assert.doesNotMatch(tag, /accent/);
});

test("the pill takes every rule the speaker and the squid take: glass, size, hover, press, spacing and the press script", () => {
  for (const rule of [
    "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn){",
    "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn):hover{",
    "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn) svg{",
    "body.focus :is(#homeico, #searchbtn, #chimebtn, #feedbackbtn, #setbtn, #projpill, #npstart).pressed{",
    "body.focus .bar :is(#chimebtn, #feedbackbtn, #setbtn){margin-left:3px}",
  ]) assert.ok(MAC.includes(rule), `${rule} is not in the Mac page`);
  assert.ok(MAC.includes('["homeico", "projpill", "searchbtn", "chimebtn", "feedbackbtn", "setbtn", "npstart"]'), "the press script skips the pill");
});

test("the phone has no bug pill and no sheet: its feedback box stays in Settings", () => {
  assert.doesNotMatch(PHONE, /feedbackbtn|feedbackOverlay|fb-sheet/);
});

// a small tree of fake elements, enough for the sheet to move its row about
function sheetDom() {
  const timers = [], active = { el: null }, docListeners = {};
  const make = (tag, cls = "", text = "") => {
    const n = {
      tag, text, parent: null, kids: [], attrs: {}, listeners: {}, tabIndex: -1, focused: 0,
      cls: new Set(String(cls).split(" ").filter(Boolean)),
      isConnected: true,
      classList: { add: c => n.cls.add(c), remove: c => n.cls.delete(c), contains: c => n.cls.has(c) },
      setAttribute(k, v) { n.attrs[k] = v; },
      addEventListener(type, fn) { (n.listeners[type] ||= []).push(fn); },
      appendChild(k) { if (k.parent) k.parent.kids.splice(k.parent.kids.indexOf(k), 1); k.parent = n; n.kids.push(k); return k; },
      before(k) { if (k.parent) k.parent.kids.splice(k.parent.kids.indexOf(k), 1); k.parent = n.parent; n.parent.kids.splice(n.parent.kids.indexOf(n), 0, k); },
      after(k) { if (k.parent) k.parent.kids.splice(k.parent.kids.indexOf(k), 1); k.parent = n.parent; n.parent.kids.splice(n.parent.kids.indexOf(n) + 1, 0, k); },
      contains(k) { for (let p = k; p; p = p.parent) if (p === n) return true; return false; },
      focus() { n.focused++; active.el = n; },
      blur() { if (active.el === n) active.el = null; },
    };
    Object.defineProperty(n, "textContent", { get: () => n.text, set: v => { n.text = v; } });
    Object.defineProperty(n, "parentNode", { get: () => n.parent });
    return n;
  };
  const fire = (n, type, event) => { for (const fn of n.listeners[type] || []) fn(event); };
  return { make, timers, active, docListeners, fire };
}

function feedbackSheet({ disabled = false } = {}) {
  const d = sheetDom();
  const host = d.make("body"), settingsBox = d.make("div", "sp-box");
  const row = d.make("div", "setrow fbrow"), title = d.make("span", "", "Share Feedback"), ta = d.make("textarea");
  ta.disabled = disabled;
  row.querySelector = sel => (sel === ".setlabel span" ? title : sel === "textarea" ? ta : null);
  settingsBox.appendChild(row);
  const opened = [], closed = [];
  const context = vm.createContext({
    h: (tag, cls, text) => d.make(tag, cls, text),
    document: { createComment: () => d.make("#comment"), addEventListener: (t, fn) => { d.docListeners[t] = fn; } },
    setTimeout: (fn, ms) => { d.timers.push({ fn, ms }); return d.timers.length; },
    clearTimeout: id => { if (d.timers[id - 1]) d.timers[id - 1].fn = null; },
  });
  Object.defineProperty(context.document, "activeElement", { get: () => d.active.el });
  vm.runInContext(KEYS, context);   // the sheet's Escape asks imeKey
  vm.runInContext(FEEDBACK, context);
  const sheet = vm.runInContext("feedbackOverlay", context)(host, row, { onOpen: () => opened.push(1), onClose: () => closed.push(1) });
  const veil = sheet.root, dialog = veil.kids[0];
  const fadeEnded = () => { for (const t of d.timers.splice(0)) if (t.fn) t.fn(); };
  return { d, host, settingsBox, row, ta, title, sheet, veil, dialog, opened, closed, fadeEnded };
}

test("the sheet holds the box's row and nothing else, on the settings page's veil and look", () => {
  const f = feedbackSheet();
  assert.ok(f.veil.cls.has("sp-veil") && f.veil.cls.has("qn-veil"), "not the settings veil");
  assert.ok(f.dialog.cls.has("sp-page") && f.dialog.cls.has("sp-mac"), "not the settings page's look");
  assert.equal(f.dialog.attrs.role, "dialog");
  assert.equal(f.dialog.attrs["aria-modal"], "true");
  assert.equal(f.dialog.attrs["aria-label"], "Share Feedback");
  assert.equal(f.sheet.isOpen(), false);
  assert.equal(f.row.parent, f.settingsBox, "the row left Settings before the sheet opened");
  f.sheet.open();
  const pane = f.dialog.kids[0];
  assert.equal(f.dialog.kids.length, 1);
  assert.deepEqual(pane.kids, [f.row], "the sheet holds something besides the row");
  assert.ok(f.veil.cls.has("open"));
  assert.equal(f.veil.attrs["aria-hidden"], "false");
  assert.equal(f.opened.length, 1);
  assert.equal(f.d.active.el, f.ta, "the box is not focused on opening");
});

test("a greyed box cannot take focus, so the sheet itself does", () => {
  const f = feedbackSheet({ disabled: true });
  f.sheet.open();
  assert.equal(f.d.active.el, f.dialog);
});

test("a box that wakes after the sheet opened is given the focus, unless something in the sheet already has it or the sheet is shut", () => {
  const f = feedbackSheet({ disabled: true });
  f.sheet.focus();
  assert.equal(f.d.active.el, null, "a shut sheet took the focus");
  f.sheet.open();
  f.ta.disabled = false;   // the profile has been read
  f.sheet.focus();
  assert.equal(f.d.active.el, f.ta);
  const other = f.d.make("button");
  f.dialog.appendChild(other);
  other.focus();
  f.sheet.focus();
  assert.equal(f.d.active.el, other, "the focus was taken from something in the sheet");
});

test("a press on the veil outside the sheet puts it away; a press inside, or a drag out of it, does not", () => {
  const f = feedbackSheet();
  f.sheet.open();
  f.d.fire(f.veil, "pointerdown", { target: f.ta });
  f.d.fire(f.veil, "click", { target: f.ta });
  assert.equal(f.sheet.isOpen(), true, "a click inside closed it");
  f.d.fire(f.veil, "pointerdown", { target: f.dialog });   // a selection starts in the sheet...
  f.d.fire(f.veil, "click", { target: f.veil });           // ...and lets go on the veil
  assert.equal(f.sheet.isOpen(), true, "a drag out of the box closed it");
  f.d.fire(f.veil, "pointerdown", { target: f.veil });
  f.d.fire(f.veil, "click", { target: f.veil });
  assert.equal(f.sheet.isOpen(), false, "a click outside did not close it");
  assert.equal(f.veil.attrs["aria-hidden"], "true");
  assert.equal(f.veil.cls.has("open"), false);
  assert.equal(f.closed.length, 1);
});

test("Escape puts the sheet away, and no key goes on to the board", () => {
  const f = feedbackSheet();
  const key = k => ({ key: k, stopped: 0, prevented: 0, stopPropagation() { this.stopped++; }, preventDefault() { this.prevented++; } });
  f.sheet.open();
  const other = key("a");
  f.d.fire(f.veil, "keydown", other);
  assert.equal(other.stopped, 1, "a key reached the board under the sheet");
  assert.equal(f.sheet.isOpen(), true);
  const esc = key("Escape");
  f.d.fire(f.veil, "keydown", esc);
  assert.equal(esc.stopped, 1);
  assert.equal(f.sheet.isOpen(), false);
});

test("closing keeps the typed words and leaves the box alone; the row goes home after the fade", () => {
  const f = feedbackSheet();
  f.ta.value = "half a thought";
  f.sheet.open();
  f.sheet.close();
  assert.equal(f.ta.value, "half a thought", "closing touched the words");
  assert.equal(f.row.parent, f.dialog.kids[0], "the row left before the fade out ran");
  f.fadeEnded();
  assert.equal(f.row.parent, f.settingsBox, "the row did not go back into Settings");
  f.sheet.open();
  assert.equal(f.ta.value, "half a thought", "the words were gone on the next opening");
  assert.equal(f.row.parent, f.dialog.kids[0]);
  f.sheet.close();
  f.sheet.open();   // reopened inside the fade: the pending move home must not take the row from the sheet
  f.fadeEnded();
  assert.equal(f.row.parent, f.dialog.kids[0], "a late move home took the row out of an open sheet");
});

test("Settings can take the row back at once, even inside the fade out, but never from an open sheet", () => {
  const f = feedbackSheet();
  f.sheet.open();
  f.sheet.close();
  f.sheet.seat();
  assert.equal(f.row.parent, f.settingsBox);
  f.sheet.open();
  f.sheet.seat();
  assert.equal(f.row.parent, f.dialog.kids[0], "seat took the row from an open sheet");
});

test("focus cannot wander onto the board while the sheet is open", () => {
  const f = feedbackSheet();
  const board = f.d.make("div");
  f.d.docListeners.focusin({ target: board });
  assert.equal(f.d.active.el, null, "focus was pulled while the sheet was shut");
  f.sheet.open();
  f.d.active.el = board;
  f.d.docListeners.focusin({ target: board });
  assert.equal(f.d.active.el, f.ta);
});

test("a send already counting down carries on after the sheet is closed", async () => {
  // the sheet never calls into the box, so the box's own timer is all there is
  const body = between(LOGIC, "function feedbackOverlay(host, row, opts){", "// ---- a card's magic box");
  assert.doesNotMatch(body, /cancel\(|setReady|\.value\s*=/, "the sheet reaches into the box");
  const f = feedbackSheet();
  const b = box();
  b.type("please look at this");
  b.press();
  assert.equal(b.state(), "counting");
  f.sheet.open();
  f.sheet.close();
  b.time.tick(3000);
  await settle();
  assert.deepEqual(b.sent, ["please look at this"]);
  assert.equal(b.els.ta.value, "");
});

test("the Mac wiring: the pill opens the sheet, the sheet holds the board's keys while open, Settings shuts it", async () => {
  const page = macPage({ profile: { name: "Ada", email: "ada@example.org" } });
  assert.equal(page.sheet.row, page.element("fbrow"), "the sheet is not given the box's row");
  const pill = page.element("feedbackbtn");
  assert.deepEqual(page.gate, [], "the profile was read before anything opened");
  pill.listeners.click();
  assert.equal(page.sheet.opened, 1);
  await settle();
  // the pill may be the first thing opened since the page loaded, so the sheet reads the profile that
  // wakes the box, and then asks for the focus the greyed box could not take
  assert.deepEqual(page.gate, [true], "opening the sheet did not wake the box from the profile");
  assert.equal(page.sheet.focused, 1, "the woken box was not given the focus");
  assert.equal(pill.attrs["aria-expanded"], "true");
  page.sheet.hooks.onClose();
  assert.equal(pill.attrs["aria-expanded"], "false");
  page.open();
  assert.equal(page.sheet.closed, 1, "opening Settings left the sheet open");
  assert.equal(page.sheet.seated, 1, "opening Settings did not take the row back");
  const wiring = between(MAC, "feedbackSheet = feedbackOverlay(", "feedbackBtn.addEventListener");
  assert.match(wiring, /setOpen = true;[\s\S]*classList\.add\("setopen"\)/);
  assert.match(wiring, /setOpen = false;[\s\S]*classList\.remove\("setopen"\)/);
});

test("the sheet's rules: 4:3 and narrower than the settings page, in the middle of the window, only the row in it, no accent", () => {
  const rules = TOKENS.slice(TOKENS.indexOf("the feedback sheet (feedbackOverlay"));
  assert.match(rules, /\.sp-veil\.fb-veil\{display:flex; align-items:center; justify-content:center\}/);
  // a share of the window (the veil is fixed over all of it), never pixels, and the height its width's three quarters
  const sheetRule = /\.fb-sheet\{([^}]*)\}/.exec(rules);
  assert.ok(sheetRule, "the sheet has no rule");
  const share = /(?:^|[\s;])width:(\d+(?:\.\d+)?)%/.exec(sheetRule[1]);
  assert.ok(share, "the sheet's width is not a share of the window");
  assert.ok(Number(share[1]) < 52.5, "the sheet is not narrower than the settings page");
  assert.match(sheetRule[1], /aspect-ratio:\s*4 \/ 3/);
  assert.doesNotMatch(sheetRule[1], /(?:^|[\s;])(?:height|max-height|min-height|min-width|max-width):/, "something besides the ratio sets the sheet's height");
  // the box takes what the title and the line leave, so the sheet keeps its shape
  assert.match(rules, /\.fb-sheet \.fbbox\{flex:1; min-height:0; display:flex\}/);
  assert.match(rules, /\.fb-sheet \.fbta\{flex:1; height:auto; min-height:0; max-height:none;/);
  assert.match(TOKENS, /\.sp-veil \.sp-page\.sp-mac\{left:23\.75%; right:23\.75%/, "the settings page's width moved");
  assert.doesNotMatch(rules, /--accent|purple|violet/i);
});

test("the sheet's width is Akash's pick, 40.9% of the window, and everything in it is tied to that width, not to pixels", () => {
  const rules = TOKENS.slice(TOKENS.indexOf("the feedback sheet (feedbackOverlay"), TOKENS.indexOf("The link menu uses"));
  const sheetRule = /\.fb-sheet\{([^}]*)\}/.exec(rules)[1];
  assert.match(sheetRule, /(?:^|[\s;])width:40\.9%/);
  // the sheet is a size container, so its children's cqw are shares of its own width
  assert.match(sheetRule, /container-type:\s*inline-size/);
  assert.match(sheetRule, /--fb-ts:1\.3;/, "the type is not 1.3 times today's");
  assert.match(sheetRule, /--fb-pad:4;/, "the spacing is not 4% of the sheet's width");
  assert.match(sheetRule, /--fb-ref:calc\(1512 \* \.409\)/);
  assert.match(sheetRule, /--fb-unit:calc\(100cqw \* var\(--fb-ts\) \/ var\(--fb-ref\)\)/);
  // today's 17, 12, 14 and 18 are multiples of that unit; the padding is a share of the width, 28/32 of it down the page
  assert.match(rules, /\.fb-sheet \.setlabel > span\{font:625 calc\(17 \* var\(--fb-unit\)\)\/1\.25 var\(--inter\)/);
  assert.match(rules, /\.fb-sheet \.setlabel \.sethelp\{font-size:calc\(12 \* var\(--fb-unit\)\)\}/);
  assert.match(rules, /\.fb-sheet \.fbta\{[^}]*font-size:calc\(14 \* var\(--fb-unit\)\)/);
  assert.match(rules, /\.fb-sheet #fbnote:empty\{display:block; min-height:calc\(18 \* var\(--fb-unit\)\)\}/);
  assert.match(rules, /\.fb-sheet \.sp-pane\{padding:calc\(var\(--fb-pad\) \* 1cqw \* 28 \/ 32\) calc\(var\(--fb-pad\) \* 1cqw\)\}/);
  // no pixel size is left in the sheet's own type or spacing rules
  const own = rules.slice(rules.indexOf(".sp-veil.fb-veil{"));
  for (const rule of own.split("}")) {
    if (/\.fb-sheet \.(?:sp-pane\{|setlabel > span|setlabel \.sethelp|fbta|#fbnote)|#fbnote:empty/.test(rule)) {
      assert.doesNotMatch(rule.replace(/gap:4px/, ""), /(?:^|[\s:(*])\d+(?:\.\d+)?px/, "a fixed pixel size is left in: " + rule.trim());
    }
  }
});

// ---- the phone's zoom ---------------------------------------------------------------------

test("the phone's feedback box is set at 16px, so iOS does not zoom the page when it is tapped; the Mac's stays 14px", () => {
  assert.match(TOKENS, /\.fbta\{[^}]*font:14px\/1\.35 var\(--sans\)/, "the shared box moved off its 14px");
  const css = PHONE.slice(0, PHONE.indexOf("</style>"));
  const rule = /(?:^|[\s}])#fbta\{([^}]*)\}/.exec(css);
  assert.ok(rule, "the phone has no rule for the box");
  const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(rule[1]);
  assert.ok(size && Number(size[1]) >= 16, "the phone's box is under 16px");
  assert.doesNotMatch(rule[1], /width|height|padding|border|margin|transform|zoom/, "more than the type's size changed");
  assert.doesNotMatch(MAC.slice(0, MAC.indexOf("</style>")), /#fbta\{/);
  // as a card's typing box is: a textarea set in --u at 17
  assert.match(css, /textarea\{\s*flex:1; min-width:0; resize:none; font:calc\(17 \* var\(--u\)\)/);
});
