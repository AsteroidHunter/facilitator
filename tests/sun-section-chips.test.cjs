// The sun chip and the three section chips, on every card surface, with no
// browser and no board. Each surface's own lines are cut out of the page that
// ships them (the chips' construction and the pass that paints them) and run
// with the real card-logic.js over a small DOM, and every request a click
// makes is caught by a recording fetch instead of going anywhere.
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ---- the small DOM -------------------------------------------------------------
function element(tag) {
  const attrs = new Map();
  const classes = new Set();
  const listeners = {};
  let text = "";
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [], parentNode: null, dataset: {}, style: {},
    innerHTML: "", title: "", type: "", tabIndex: -1,
    classList: {
      add(...names) { for (const name of names) classes.add(name); },
      remove(...names) { for (const name of names) classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, on) {
        const want = on === undefined ? !classes.has(name) : !!on;
        if (want) classes.add(name); else classes.delete(name);
        return want;
      },
    },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    removeAttribute(name) { attrs.delete(name); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    appendChild(node) { detach(node); el.children.push(node); node.parentNode = el; return node; },
    append(...nodes) { for (const node of nodes) el.appendChild(node); },
    insertBefore(node, ref) {
      detach(node);
      const at = el.children.indexOf(ref);
      if (at < 0) el.children.push(node); else el.children.splice(at, 0, node);
      node.parentNode = el;
      return node;
    },
    focus() {},
    click() {
      const event = { type: "click", target: el, currentTarget: el, stopPropagation() {}, preventDefault() {} };
      for (const fn of listeners.click || []) fn(event);
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set(value) { classes.clear(); for (const name of String(value).split(" ")) if (name) classes.add(name); },
  });
  Object.defineProperty(el, "textContent", {
    get: () => text,
    set(value) { text = value == null ? "" : String(value); },
  });
  return el;
}
function detach(node) {
  const parent = node.parentNode;
  if (parent) parent.children.splice(parent.children.indexOf(node), 1);
  node.parentNode = null;
}

// ---- cutting the real lines out of a page -----------------------------------------
function between(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `start marker missing: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `end marker missing after ${start}: ${end}`);
  return source.slice(from, to + end.length);
}

// ---- one page's context: card-logic.js with the names a page declares --------------
async function context() {
  const requests = [];
  const store = new Map();
  const sandbox = {
    console, Date, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { createElement: element, body: element("body") },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    AbortSignal: { timeout: () => undefined },
    CardMarkdown: { render: text => String(text || "") },
    fetch: (url, init = {}) => {
      requests.push({ url: String(url), method: init.method || "GET" });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    },
    els: {}, lastState: null, selectedId: null, activeOwner: "facilitator", lastSel: {},
    poll() {}, select() {}, deselect() {}, growPend() {}, apply() {}, editTitle() {}, pasteIntoTitle() {},
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(await readFile(path.join(ROOT, "card-logic.js"), "utf8"), ctx, { filename: "card-logic.js" });
  return { ctx, requests };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

// one card in each section, and the one a board can hold both ways
const CARDS = {
  doing: { id: "m1", state: "yours", done: false, parked: false },
  deferred: { id: "m2", state: "parked", done: false, parked: true },
  done: { id: "m3", state: "done", done: true, parked: false },
  both: { id: "m4", state: "done", done: true, parked: true },
};
function card(kind) {
  return { bucket: "meta", owner: "facilitator", title: "card " + kind, ball: "you", replies: 1,
           agentTs: 1, ts: 1, pending: 0, ...CARDS[kind] };
}
function board(ctx) {
  ctx.lastState = { boxes: Object.keys(CARDS).map(card), now: Date.now() / 1000, fetchedAt: Date.now() };
  return ctx.lastState;
}
// what a request asked for, in the terms a reader cares about
function asked(request) {
  const url = new URL(request.url, "http://board");
  return { path: url.pathname, box: url.searchParams.get("box"), v: url.searchParams.get("v"), method: request.method };
}
function offOf(chips) {
  return Object.fromEntries(["sun", "arc", "x"].map(name => [name, chips[name].getAttribute("aria-disabled") === "true"]));
}
const EXPECTED_OFF = {
  doing: { sun: true, arc: false, x: false },
  deferred: { sun: false, arc: true, x: false },
  done: { sun: false, arc: false, x: true },
  both: { sun: false, arc: false, x: true },
};

// ---- the three surfaces, each built from its own page's lines ------------------------
async function desktopLarge() {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");
  const build = between(html, '    const x = h("button", "xbtn", "×");', "    topbar.insertBefore(sun, arc);");
  const paint = between(html, "    const cs = cardState(b);   // one state", "    paintSectionChips(el, b);");
  const env = await context();
  const makeChips = vm.runInContext(`(function(b, topbar, head, box){\n${build}\nreturn { sun, arc, x };\n})`, env.ctx);
  const paintCard = vm.runInContext(`(function(el, b){\n${paint}\n})`, env.ctx);
  return {
    name: "desktop large card", html, env,
    mount(b) {
      const topbar = element("div");
      topbar.appendChild(element("div"));   // the history control, first in the bar
      const chips = makeChips(b, topbar, element("div"), element("article"));
      const el = { box: element("article"), topbar, ...chips };
      env.ctx.els[b.id] = el;
      paintCard(el, b);
      return el;
    },
    order: el => el.topbar.children.filter(node => [el.sun, el.arc, el.x].includes(node)),
  };
}

async function desktopMini() {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");
  const build = between(html, '      const sun = sunChip("msun", b.id);', "        poll();\n      });");
  const paint = between(html, '    el.box.classList.toggle("mwait", !!b.pending);', "    paintSectionChips(el, b);");
  const env = await context();
  const makeChips = vm.runInContext(`(function(b){\n${build}\nreturn { sun, arc, x };\n})`, env.ctx);
  const paintCard = vm.runInContext(`(function(el, b){\n${paint}\n})`, env.ctx);
  return {
    name: "desktop small card", html, env,
    mount(b) {
      const chips = makeChips(b);
      const el = { box: element("div"), ...chips };
      // the small card shares the large card's entry for its flag taps
      env.ctx.els[b.id] = { box: element("article") };
      env.ctx.els[b.id].box.classList.toggle("done", env.ctx.cardState(b) === "done");
      env.ctx.els[b.id].box.classList.toggle("parked", env.ctx.cardState(b) === "parked");
      paintCard(el, b);
      return el;
    },
  };
}

async function phone() {
  const html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const icon = between(html, "const MOON_ICON = ", "</svg>';");
  const close = between(html, "async function closeCard(id){", "  poll();\n}");
  const build = between(html, '  const arc = h("button", "arcbtn");', "  topbar.append(histctl, sun, arc, x);");
  const paint = between(html, '  const cs = cardState(b);\n  el.box.classList.toggle("done", cs === "done");',
    "  paintSectionChips(el, b);");
  const env = await context();
  vm.runInContext(icon + "\n" + close, env.ctx);
  const makeChips = vm.runInContext(`(function(b, topbar, histctl){\n${build}\nreturn { sun, arc, x };\n})`, env.ctx);
  const paintCard = vm.runInContext(`(function(el, b){\n${paint}\n})`, env.ctx);
  return {
    name: "phone card", html, env,
    mount(b) {
      const topbar = element("div");
      const chips = makeChips(b, topbar, element("div"));
      const el = { box: element("article"), topbar, ...chips };
      env.ctx.els[b.id] = el;
      paintCard(el, b);
      return el;
    },
    order: el => el.topbar.children.filter(node => [el.sun, el.arc, el.x].includes(node)),
  };
}

// ---- the section rule ----------------------------------------------------------------
test("a card's section is read off the tabs' own filter, done ahead of parked", async () => {
  const { ctx } = await context();
  for (const [kind, section] of [["doing", "todo"], ["deferred", "deferred"], ["done", "done"], ["both", "done"]]) {
    const b = card(kind);
    assert.equal(ctx.cardSection(b), section, kind);
    for (const view of ["todo", "deferred", "done"])
      assert.equal(ctx.viewFilterFor(b, view), view === section, `${kind} listed under ${view}`);
  }
  // a card with no state from the board is read from its flags the same way
  assert.equal(ctx.cardSection({ ...card("both"), state: null }), "done");
  assert.equal(ctx.cardSection({ ...card("deferred"), state: null }), "deferred");
});

// ---- the sun on every surface -----------------------------------------------------------
for (const [name, make] of [["desktop large card", desktopLarge], ["desktop small card", desktopMini], ["phone card", phone]]) {
  test(`${name} carries a sun built like the moon, left of it`, async () => {
    const surface = await make();
    board(surface.env.ctx);
    const el = surface.mount(card("deferred"));
    assert.equal(el.sun.tagName, "BUTTON");
    assert.equal(el.sun.title, "move to doing\nControl + Shift + [, or [ when not typing");
    assert.equal(el.sun.getAttribute("aria-label"), "move to doing");
    // the same inline svg approach at the same glyph size as the moon beside it
    const size = svg => /viewBox="0 0 24 24" width="9" height="9"/.test(svg);
    if (name !== "desktop small card") {
      // the big card on either page sizes both glyphs in css, by the top row's one mark size, so
      // its moon carries no size of its own and the sun's shared one is overruled
      assert.doesNotMatch(/<svg [^>]*>/.exec(el.arc.innerHTML)?.[0] || "", /\s(width|height)=/, "the moon glyph carries a size of its own");
      const rule = name === "phone card"
        ? /\n  :is\(\.arcbtn, \.sunbtn\) svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/
        : /body\.focus \.box\.sel :is\(\.arcbtn, \.sunbtn\) svg\{width:var\(--bar-mark\); height:var\(--bar-mark\)\}/;
      assert.match(surface.html, rule);
    } else {
      assert.ok(size(el.arc.innerHTML), "the moon glyph changed size");
    }
    assert.ok(size(el.sun.innerHTML), "the sun glyph is not the moon's size");
    // the middle is a hollow ring: nothing fills it, and it is drawn by a stroke
    // of the same weight and round ends as the rays
    const svg = /<svg [^>]*>/.exec(el.sun.innerHTML)?.[0] || "";
    const ring = /<circle [^>]*>/.exec(el.sun.innerHTML)?.[0] || "";
    assert.match(ring, /cx="12" cy="12" r="4.35"/, "the sun has no ring in its middle");
    // the geometry itself: the hole, the ring's outer edge, and the air and
    // the box around the marks, all measured on the stroke the glyph carries
    const width = Number(/stroke-width="([\d.]+)"/.exec(svg)?.[1]);
    const radius = Number(/ r="([\d.]+)"/.exec(ring)?.[1]);
    const half = width / 2, outer = radius + half;
    assert.ok(Math.abs((radius - half) * 2 - 6.3) < 1e-9, "the hole is not 6.3 units across");
    const d = /<path d="([^"]+)"/.exec(el.sun.innerHTML)?.[1] || "";
    const marks = [...d.matchAll(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/g)]
      .map(m => [[+m[1], +m[2]], [+m[3], +m[4]]]);
    assert.equal(marks.length, 8, "the sun's marks are not eight plain segments");
    const from = ([x, y]) => Math.hypot(x - 12, y - 12);
    for (const [a, b] of marks) {
      const near = Math.min(from(a), from(b));
      assert.ok(near - half - outer > 1.7, `a mark comes within ${(near - half - outer).toFixed(2)} of the ring`);
      for (const value of [...a, ...b])
        assert.ok(value - half >= 0 && value + half <= 24, "a mark's round end leaves the 24 unit box");
      // each mark, round ends and all, is shorter than half the ring's width
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) + width < outer, "a mark is not short beside the ring");
    }
    assert.match(svg, /fill="none"/, "the sun's middle is filled");
    assert.doesNotMatch(ring, /fill="(?!none")/, "the ring fills its own centre");
    assert.doesNotMatch(el.sun.innerHTML, /fill="currentColor"/, "part of the sun is filled");
    assert.match(svg, /stroke="currentColor"/, "the ring and rays carry no stroke");
    assert.match(svg, /stroke-width="2.4"/, "the ring and rays are not one weight");
    assert.match(svg, /stroke-linecap="round"/, "the rays do not end round");
    assert.doesNotMatch(el.sun.innerHTML, /<(circle|path) [^>]*stroke/, "a part overrides the shared stroke");
    assert.equal((el.sun.innerHTML.match(/M/g) || []).length, 8, "the sun does not carry eight rays");
    if (surface.order) assert.deepEqual(surface.order(el), [el.sun, el.arc, el.x], "the chips are not sun, moon, cross");
  });

  test(`${name} fades the chip naming the card's own section`, async () => {
    const surface = await make();
    board(surface.env.ctx);
    for (const kind of Object.keys(CARDS)) {
      const el = surface.mount(card(kind));
      assert.deepEqual(offOf(el), EXPECTED_OFF[kind], `${kind} card`);
    }
    // and a later pass that moves the card moves the fade with it
    const el = surface.mount(card("deferred"));
    vm.runInContext("(function(el, b){ paintSectionChips(el, b); })", surface.env.ctx)(el, card("doing"));
    assert.deepEqual(offOf(el), EXPECTED_OFF.doing, "a deferred card woken to doing kept its old fade");
  });

  test(`${name}: the sun wakes a deferred card by clearing park and a done card by done v=0`, async () => {
    const surface = await make();
    const cases = [
      ["deferred", [{ path: "/park", box: "m2", v: "0", method: "POST" }]],
      ["done", [{ path: "/done", box: "m3", v: "0", method: "POST" }]],
      // shown as done, held parked too: both come off, so it lands in doing
      ["both", [{ path: "/park", box: "m4", v: "0", method: "POST" },
                { path: "/done", box: "m4", v: "0", method: "POST" }]],
    ];
    for (const [kind, want] of cases) {
      board(surface.env.ctx);
      surface.env.requests.length = 0;
      const el = surface.mount(card(kind));
      el.sun.click();
      await flush();
      assert.deepEqual(surface.env.requests.map(asked), want, `${kind} card`);
    }
  });

  test(`${name}: a faded chip's click sends nothing`, async () => {
    const surface = await make();
    for (const [kind, chip] of [["doing", "sun"], ["deferred", "arc"], ["done", "x"], ["both", "x"]]) {
      board(surface.env.ctx);
      surface.env.requests.length = 0;
      const el = surface.mount(card(kind));
      el[chip].click();
      await flush();
      assert.deepEqual(surface.env.requests, [], `${chip} on a ${kind} card`);
    }
  });

  test(`${name}: the live moon and cross do what they did before`, async () => {
    const surface = await make();
    const cases = [
      ["doing", "arc", { path: "/park", v: "1" }],
      ["done", "arc", { path: "/park", v: "1" }],
      // the cross always asks the board to close; the board itself deletes an
      // empty card rather than marking it done (done-card-close covers that)
      ["doing", "x", { path: "/close", v: null }],
      ["deferred", "x", { path: "/close", v: null }],
    ];
    for (const [kind, chip, want] of cases) {
      board(surface.env.ctx);
      surface.env.requests.length = 0;
      const el = surface.mount(card(kind));
      el[chip].click();
      await flush();
      assert.deepEqual(surface.env.requests.map(asked),
        [{ ...want, box: CARDS[kind].id, method: "POST" }], `${chip} on a ${kind} card`);
    }
  });

  // the section keys run through the surface's own move, cut out of its page:
  // each asks the board exactly what that section's chip asks, which is
  // nothing where the chip is faded
  test(`${name}: each section key asks what its chip asks, and nothing where the chip is faded`, async () => {
    const CHIP = { doing: "sun", deferred: "arc", done: "x" };
    const requestsOf = async (kind, act) => {
      const surface = await make();
      board(surface.env.ctx);
      const el = surface.mount(card(kind));
      act(surface, el);
      await flush();
      return surface.env.requests.map(asked);
    };
    for (const kind of Object.keys(CARDS)) {
      for (const section of ["doing", "deferred", "done"]) {
        const chip = CHIP[section];
        const byChip = await requestsOf(kind, (surface, el) => el[chip].click());
        let prevented = false;
        const byKey = await requestsOf(kind, (surface, el) =>
          pressSection(surface, CARDS[kind].id, el, section, () => { prevented = true; }));
        assert.deepEqual(byKey, byChip, `${section} key on a ${kind} card`);
        assert.equal(prevented, true, `${section} key on a ${kind} card left the key to the page`);
        if (EXPECTED_OFF[kind][chip]) assert.deepEqual(byKey, [], `${section} key on a ${kind} card sent something`);
        else assert.notDeepEqual(byKey, [], `${section} key on a ${kind} card sent nothing`);
      }
    }
  });
}

// one key press through a surface's own section move, with the surface's
// selected card set the way its page sets it
function pressSection(surface, id, el, section, prevent) {
  const { ctx } = surface.env;
  const move = {
    "desktop large card": "function boardSectionMove(e, section){",
    "desktop small card": "function miniSectionMove(e, section){",
    "phone card": "function phoneSectionMove(e, section){",
  }[surface.name];
  // the large card's done is its keyboard close, declared just above the move
  if (surface.name === "desktop large card")
    vm.runInContext(between(surface.html, "async function boardCloseCard(id){", "\n}"), ctx);
  vm.runInContext(between(surface.html, move, "\n}"), ctx);
  ctx.miniFocused = false;
  ctx.selectedId = id;
  ctx.miniId = id;
  ctx.miniEls = { [id]: el };
  const event = { preventDefault: prevent, stopPropagation() {} };
  const fn = /function (\w+)/.exec(move)[1];
  ctx[fn](event, section);
}

// ---- the hop to the next doing card ---------------------------------------------------
// a key that takes the selected card out of doing lands on the same card its
// chip lands on, through the chip's own selectNextDoing, and a key that moves a
// card into doing, or changes nothing, stays. every key is a real key event sent
// through the page's own action table, cut out of the page as written
const HOP_KEYS = {
  doing: {
    "control+shift+[": { key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true },
    "[": { key: "[", code: "BracketLeft" },
  },
  deferred: {
    "control+shift+]": { key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true },
    "]": { key: "]", code: "BracketRight" },
  },
  done: {
    "control+shift+\\": { key: "|", code: "Backslash", ctrlKey: true, shiftKey: true },
    "\\": { key: "\\", code: "Backslash" },
  },
};
// keys that move, close and step nothing: the browser and the system keep them
const REMOVED_KEYS = {
  "control+n": { key: "n", code: "KeyN", ctrlKey: true },
  "control+l": { key: "l", code: "KeyL", ctrlKey: true },
  backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" },
  "command+shift+[": { key: "{", code: "BracketLeft", metaKey: true, shiftKey: true },
  "command+shift+]": { key: "}", code: "BracketRight", metaKey: true, shiftKey: true },
};
const HOP_CHIP = { doing: "sun", deferred: "arc", done: "x" };
// the page's own key handling: its action table and what it calls, from the
// first line to the table's end, and the scope its listener dispatches in
const TABLES = {
  "desktop large card": { from: "async function boardCloseCard(id){", to: "const boardShortcutActions = {",
                          table: "boardShortcutActions", scope: "card" },
  "desktop small card": { from: "const miniShortcutActions = {", to: "function miniSectionMove(e, section){",
                          table: "miniShortcutActions", scope: "mini" },
  "phone card": { from: "function phoneSectionMove(e, section){", to: "const phoneShortcutActions = {",
                  table: "phoneShortcutActions", scope: "card" },
};
function keyTable(surface) {
  const { from, to, table } = TABLES[surface.name];
  const start = surface.html.indexOf(from);
  const at = surface.html.indexOf(to, start);
  const end = surface.html.indexOf("\n}", at + to.length) + 2;
  assert.ok(start >= 0 && at >= start && end > at, `${surface.name}: key table not found`);
  // the small card's table closes with "};" and its move follows it
  vm.runInContext(surface.html.slice(start, end), surface.env.ctx);
  return vm.runInContext(table, surface.env.ctx);
}

// one surface with a card of the given kind selected in the doing view, a
// second doing card to land on, and every selection recorded. selected names
// the large card's selection, which the small card's own card is not
async function hopWorld(make, kind, selected) {
  const surface = await make();
  const { ctx } = surface.env;
  const state = board(ctx);
  state.boxes.push({ ...card("doing"), id: "m5", title: "the other doing card" });
  const el = surface.mount(card(kind));
  const landed = [];
  ctx.select = id => landed.push(id);
  ctx.deselect = () => landed.push(null);
  ctx.miniFocused = surface.name === "desktop small card";
  ctx.selectedId = selected || CARDS[kind].id;
  ctx.miniId = CARDS[kind].id;
  ctx.miniEls = { [CARDS[kind].id]: el };
  return { surface, ctx, el, landed };
}

async function byChip(make, kind, section, selected) {
  const w = await hopWorld(make, kind, selected);
  w.el[HOP_CHIP[section]].click();
  await flush();
  return { requests: w.surface.env.requests.map(asked), landed: w.landed };
}

async function byKey(make, kind, keyEvent, selected) {
  const w = await hopWorld(make, kind, selected);
  const actions = keyTable(w.surface);
  const e = { target: w.ctx.document.body, altKey: false, metaKey: false, ctrlKey: false, shiftKey: false,
              repeat: false, isComposing: false, defaultPrevented: false, ...keyEvent,
              preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} };
  w.ctx.dispatchCardShortcut(e, actions, TABLES[w.surface.name].scope);
  await flush();
  return { requests: w.surface.env.requests.map(asked), landed: w.landed, prevented: e.defaultPrevented };
}

for (const [name, make] of [["desktop large card", desktopLarge], ["phone card", phone]]) {
  test(`${name}: a key taking the card out of doing hops exactly where its chip hops, and a key into doing stays`, async () => {
    for (const kind of Object.keys(CARDS)) {
      for (const [section, keys] of Object.entries(HOP_KEYS)) {
        const chip = await byChip(make, kind, section);
        // where the chip hops: out of doing to deferred, and a done that is not already done
        const hops = (section === "deferred" && kind === "doing") ||
          (section === "done" && (kind === "doing" || kind === "deferred"));
        assert.equal(chip.landed.length, hops ? 1 : 0, `${HOP_CHIP[section]} on a ${kind} card`);
        if (hops) assert.ok(["m1", "m5"].includes(chip.landed[0]) && chip.landed[0] !== CARDS[kind].id,
          `${HOP_CHIP[section]} on a ${kind} card landed on ${chip.landed[0]}`);
        for (const [keyName, keyEvent] of Object.entries(keys)) {
          const key = await byKey(make, kind, keyEvent);
          const what = `${keyName} on a ${kind} card`;
          assert.deepEqual(key.landed, chip.landed, `${what} did not land where the ${HOP_CHIP[section]} lands`);
          assert.deepEqual(key.requests, chip.requests, `${what} asked something other than its chip`);
        }
      }
    }
  });

  test(`${name}: control+n, control+l, backspace, delete and command+shift+[ and ] move, close and hop nothing`, async () => {
    for (const kind of Object.keys(CARDS)) {
      for (const [keyName, keyEvent] of Object.entries(REMOVED_KEYS)) {
        const key = await byKey(make, kind, keyEvent);
        assert.deepEqual(key.requests, [], `${keyName} on a ${kind} card asked the board`);
        assert.deepEqual(key.landed, [], `${keyName} on a ${kind} card moved the selection`);
        assert.equal(key.prevented, false, `${keyName} on a ${kind} card was cancelled`);
      }
    }
  });

  test(`${name}: outside the doing view the keys hop exactly where the chips do, and typed keys hop nothing`, async () => {
    // the moon's own rule, which every deferred key shares: only a doing card
    // looked at in doing hops. the cross, and so every done key, hops wherever
    // it closes a card. both read the same view the page is showing
    const inDeferredView = async () => {
      const surface = await make();
      surface.env.ctx.setTicketViewOf(surface.env.ctx.activeOwner, "deferred");
      assert.equal(surface.env.ctx.curView(), "deferred");
      return surface;
    };
    for (const [section, keys] of [["deferred", HOP_KEYS.deferred], ["done", HOP_KEYS.done]]) {
      const chip = await byChip(inDeferredView, "doing", section);
      assert.equal(chip.landed.length, section === "done" ? 1 : 0, `${HOP_CHIP[section]} outside the doing view`);
      for (const [keyName, keyEvent] of Object.entries(keys)) {
        const key = await byKey(inDeferredView, "doing", keyEvent);
        assert.deepEqual(key.landed, chip.landed, `${keyName} outside the doing view`);
      }
    }
    // a key alone typed in a field is text, and moves and hops nothing
    const typed = await hopWorld(make, "doing");
    const actions = keyTable(typed.surface);
    const field = { closest: () => field };
    for (const key of ["]", "\\"]) {
      const e = { target: field, key, code: key === "]" ? "BracketRight" : "Backslash", ctrlKey: false,
                  metaKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false,
                  defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} };
      typed.ctx.dispatchCardShortcut(e, actions);
      assert.equal(e.defaultPrevented, false, key);
    }
    await flush();
    assert.deepEqual(typed.landed, []);
    assert.deepEqual(typed.surface.env.requests, []);
  });
}

// the small card's chips never hop: its cross closes and polls, and its moon
// parks through setFlag, whose hop belongs to the large card's own selection.
// its keys do the same, and never move the large card's selection either
test("desktop small card: its section keys land exactly where its chips land, which is nowhere", async () => {
  for (const kind of Object.keys(CARDS)) {
    for (const section of ["doing", "deferred", "done"]) {
      const chip = await byChip(desktopMini, kind, section, "m9");
      for (const [keyName, keyEvent] of Object.entries(HOP_KEYS[section])) {
        const key = await byKey(desktopMini, kind, keyEvent, "m9");
        assert.deepEqual(key.landed, chip.landed, `${keyName} on a small ${kind} card`);
        assert.deepEqual(key.landed, [], `${keyName} on a small ${kind} card hopped`);
        assert.deepEqual(key.requests, chip.requests, `${keyName} on a small ${kind} card`);
      }
    }
    for (const [keyName, keyEvent] of Object.entries(REMOVED_KEYS)) {
      const key = await byKey(desktopMini, kind, keyEvent, "m9");
      assert.deepEqual([key.requests, key.landed, key.prevented], [[], [], false], `${keyName} on a small ${kind} card`);
    }
  }
});

// ---- where each surface draws its chips ---------------------------------------------------
test("the desktop bar lays the chips out sun, moon, cross", async () => {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");
  // each chip has its own column of the bar's grid, sun then moon then cross, and every
  // square is the one named size
  assert.match(html, /grid-template-areas:"hist sun moon cross"/);
  assert.match(html, /body\.focus \.box\.sel \.sunbtn\{grid-area:sun\}/);
  assert.match(html, /body\.focus \.box\.sel \.arcbtn\{grid-area:moon\}/);
  assert.match(html, /body\.focus \.box\.sel \.xbtn\{\s*grid-area:cross; position:relative;/);
  assert.match(html, /body\.focus \.box\.sel \.xbtn\{[^}]*width:var\(--bar-sq\); height:var\(--bar-sq\)/);
  assert.equal(html.match(/--bar-sq:/g).length, 1, "the top row's square is named in more than one place");
  const chipRule = between(html, "  body.focus .box.sel .arcbtn, body.focus .box.sel .sunbtn{", "}");
  assert.doesNotMatch(chipRule, /[\s;{]order:/);
  assert.match(chipRule, /width:var\(--bar-sq\); height:var\(--bar-sq\); border-radius:var\(--sq\)/);
  // the focus ring runs cross, moon, sun, and a shift tab out of the title lands on the sun
  assert.match(html, /const ring = \[titleEl, ta, clip, send, x, arc, sun\];/);
  const logic = await readFile(path.join(ROOT, "card-logic.js"), "utf8");
  assert.match(logic, /\(e\.shiftKey \? \(el\.sun \|\| el\.arc\) : el\.ta\)\.focus\(\)/);
});

test("the small card seats the round yellow sun one seat left of the moon", async () => {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");
  const right = cls => Number(new RegExp(`#magic2 \\.${cls}\\{position:absolute; top:9px; right:(\\d+)px`).exec(html)?.[1]);
  assert.ok(right("msun") > right("marc") && right("marc") > right("mx"), "the small card's chips are not sun, moon, cross");
  assert.equal(right("msun") - right("marc"), right("marc") - right("mx"), "the sun is not one seat along");
  const sun = between(html, "  #magic2 .msun{", "}");
  const moon = between(html, "  #magic2 .marc{", "}");
  for (const part of ["width:16px; height:16px; border-radius:50%", "color:#000", "display:inline-flex"]) {
    assert.ok(sun.includes(part) && moon.includes(part), `the sun is not built like the moon: ${part}`);
  }
  assert.match(sun, /background:#F7E187/);
  // the entry the pass paints carries all three chips, and only doing cards are listed
  assert.match(html, /miniEls\[b\.id\] = \{ box, title, reply, ta, sun, arc, x,/);
  const pick = vm.runInNewContext(`(state => { ${between(html, "  const cards = state.boxes.filter(", ");")} return cards; })`);
  const listed = pick({ boxes: Object.keys(CARDS).map(card) }).map(b => b.id);
  assert.deepEqual(listed, ["m1"], "the small card lists a card outside doing");
});

test("the phone bar and its entry carry the sun", async () => {
  const html = await readFile(path.join(ROOT, "m.html"), "utf8");
  const chipRule = between(html, "  .sunbtn, .arcbtn, .xbtn{", "}");
  assert.match(chipRule, /width:var\(--bar-sq\); height:var\(--bar-sq\)/);
  assert.equal(html.match(/--bar-sq:/g).length, 1, "the top row's square is named in more than one place");
  assert.match(html, /grid-template-areas:"hist sun moon cross"/);
  assert.match(html, /\.sunbtn\{grid-area:sun\}\s*\.arcbtn\{grid-area:moon\}\s*\.xbtn\{grid-area:cross\}/);
  assert.doesNotMatch(chipRule, /[\s;{]order:/);
  assert.match(html, /els\[b\.id\] = \{ box, body, reply, replyview, meta, ta, twin, send, tick, titleEl, sun, arc, x,/);
});

test("a faded chip is lighter than a waiting one, keeps no hover, and is off for assistive technology", async () => {
  const tokens = await readFile(path.join(ROOT, "card-tokens.css"), "utf8");
  const off = Number(/--chipoff:([.\d]+);/.exec(tokens)?.[1]);
  assert.ok(off > 0 && off < 0.5, "the fade is not visibly apart from the half fade of a waiting tap");
  const desk = await readFile(path.join(ROOT, "index.html"), "utf8");
  const phonePage = await readFile(path.join(ROOT, "m.html"), "utf8");
  // the waiting state itself is left as it was
  assert.ok(desk.includes(".box.flagwait .arcbtn{opacity:.5}"));
  assert.ok(phonePage.includes(".box.flagwait .arcbtn{opacity:.5}"));
  assert.ok(desk.includes('body.focus .box.sel :is(.sunbtn, .arcbtn, .xbtn)[aria-disabled="true"]{opacity:var(--chipoff); cursor:default}'));
  assert.ok(desk.includes('body.focus .box.sel :is(.sunbtn, .arcbtn, .xbtn)[aria-disabled="true"]:hover{background:var(--card)}'));
  assert.ok(desk.includes('#magic2 :is(.msun, .marc, .mx)[aria-disabled="true"]{opacity:var(--chipoff); cursor:default}'));
  for (const [cls, rest] of [["msun", "#F7E187"], ["marc", "#F6C08A"], ["mx", "#FF9F98"]])
    assert.ok(desk.includes(`#magic2 .${cls}[aria-disabled="true"]:hover{background:${rest}}`), `${cls} changes on hover while off`);
  assert.ok(phonePage.includes('.box :is(.sunbtn, .arcbtn, .xbtn)[aria-disabled="true"]{opacity:var(--chipoff); cursor:default}'));
  assert.ok(phonePage.includes('.box :is(.sunbtn, .arcbtn, .xbtn)[aria-disabled="true"]:active{background:var(--card)}'));
});
