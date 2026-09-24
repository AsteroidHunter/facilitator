// Deterministic unit tests for the Omni card's display name, its entry rule and
// its light: the card-versus-row names, the word sets that ask for Omni (the
// same table tests/test_omni_entry.py holds the server to), the lane's next
// number, what a committed title asks for on Tab and on blur, the frame the
// title and art change in, the star at the end of the way in, and reduced
// motion. card-logic.js runs in a sandbox with a small DOM stub and a hand
// driven animation clock, so no browser is started.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = path.resolve(__dirname, "..", "card-logic.js");
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "omni-entry-cases.json"), "utf8"));
// <U+XXXX> is that character and <pad:N> is N spaces, as in the table
const decode = text => text
  .replace(/<U\+([0-9A-F]{4,6})>/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/<pad:(\d+)>/g, (_, n) => " ".repeat(Number(n)));
const noop = () => {};
const RECT0 = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

function makeSandbox(){
  const frames = [], posts = [], timers = [];
  const layout = { frame: rect(0, 0, 600, 800), art: rect(20, 42, 40, 66), rowArt: rect(8, 106, 38, 146) };
  const el = tag => {
    const node = { tagName: String(tag || "div").toUpperCase(), className: "", children: [], textContent: "",
      innerHTML: "", dataset: {}, parentNode: null, attributes: {}, listeners: {}, rect: null, wordsRect: null };
    node.style = { setProperty(name, value){ node.style[name] = String(value); } };
    const names = () => node.className.split(/\s+/).filter(Boolean);
    node.classList = {
      add: (...added) => { node.className = [...new Set([...names(), ...added])].join(" "); },
      remove: (...gone) => { node.className = names().filter(name => !gone.includes(name)).join(" "); },
      toggle: (name, force) => {
        const on = names().includes(name), want = force == null ? !on : !!force;
        if (want && !on) node.classList.add(name);
        if (!want && on) node.classList.remove(name);
        return want;
      },
      contains: name => names().includes(name),
    };
    Object.defineProperty(node, "isContentEditable", { get: () => "contenteditable" in node.attributes });
    Object.defineProperty(node, "firstChild", { get: () => (node.textContent ? {} : node.children[0] || null) });
    node.appendChild = child => { child.parentNode = node; node.children.push(child); return child; };
    node.insertBefore = (child, before) => {
      child.parentNode = node;
      const index = node.children.indexOf(before);
      if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      return child;
    };
    node.remove = () => {
      if (!node.parentNode) return;
      node.parentNode.children = node.parentNode.children.filter(child => child !== node);
      node.parentNode = null;
    };
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    node.removeAttribute = name => { delete node.attributes[name]; };
    node.addEventListener = (type, fn) => { (node.listeners[type] = node.listeners[type] || []).push(fn); };
    node.fire = type => { for (const fn of node.listeners[type] || []) fn({ type }); };
    node.focus = () => { sandbox.document.activeElement = node; };
    node.querySelector = selector => selector.startsWith(".")
      ? node.children.find(child => child.classList && child.classList.contains(selector.slice(1))) || null : null;
    node.querySelectorAll = () => [];
    node.closest = () => null;
    node.getBoundingClientRect = () => {
      if (node.rect) return node.rect;
      if (node.classList.contains("omni-sweep")) return layout.frame;
      if (node.classList.contains("omni-card-art")) return layout.art;
      if (node.classList.contains("omni-art")) return layout.rowArt;
      return RECT0;
    };
    return node;
  };
  const sandbox = {
    document: { createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: selector => (selector === ".trow" ? sandbox.rows : []),
      addEventListener: noop, body: el(), activeElement: null,
      createRange: () => ({ node: null, selectNodeContents(n){ this.node = n; },
        getBoundingClientRect(){ return this.node.wordsRect || this.node.getBoundingClientRect(); } }) },
    getSelection: () => ({ removeAllRanges: noop, addRange: noop }),
    getComputedStyle: node => ({ borderTopRightRadius: node.radius || "0px" }),
    setInterval: noop, clearInterval: noop, clearTimeout: noop,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; }, cancelAnimationFrame: noop,
    reduced: false, matchMedia: () => ({ matches: sandbox.reduced }),
    fetch: (url, opts) => { posts.push({ url, body: opts && opts.body }); return Promise.resolve({ ok: true }); },
    poll: noop, console, localStorage: { getItem: () => null, setItem: noop }, navigator: {}, location: {},
    els: {}, lastState: null, rows: [],
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  vm.runInContext("keyboardTitle = true", sandbox);   // the desktop's Tab path
  // one frame of the page's animation clock at `now` ms
  const frame = now => { for (const cb of frames.splice(0)) cb(now); };
  return { sandbox, frames, posts, timers, layout, frame, el };
}

// one desktop card in the sandbox: its box, head, title, composer and outline
// entry, in lane "facilitator" beside Omni tickets #1 and #2 and a #5 in another
// lane. the card's frame is a main with a 1px border round the light's box and
// the board's 7px corner, which is where a glint belongs
function makeCard(env, title){
  const { sandbox, el } = env;
  const box = el("article"), head = el("div"), titleEl = el("span"), ta = el("div"), arc = el("button");
  const main = env.main = el("main");
  main.rect = rect(-1, -1, 601, 801);
  main.radius = "7px";
  box.closest = selector => (selector === "main" ? main : null);
  box.className = "box sel";
  head.appendChild(el("span")); head.appendChild(titleEl); box.appendChild(head);
  titleEl.textContent = sandbox.omniCardTitle(title);
  titleEl.wordsRect = rect(50, 40, 200, 70);
  const tocTitle = el("span"); tocTitle.textContent = title;
  const record = { box, titleEl, ta, arc, tocTitle };
  sandbox.els.m9 = record;
  sandbox.lastState = { boxes: [
    { id: "m1", owner: "facilitator", title: "Omni Ticket #1" },
    { id: "m2", owner: "facilitator", title: "Omni Ticket #2" },
    { id: "m3", owner: "other", title: "Omni Ticket #5" },
    { id: "m9", owner: "facilitator", title },
  ] };
  sandbox.syncOmniCard(record, { title });
  return record;
}
// the card's row in the ticket list, drawn the way both pages draw it from a
// reading's title: a 300 by 52 row, art first when the title is Omni, then the
// title's words. `replace` stands in for the list redrawing the row
function makeRow(env, title, replace){
  const { sandbox, el } = env;
  const row = el("div"), inner = el("div"), ttl = el("div");
  row.className = "trow"; inner.className = "trowin"; ttl.className = "ttl";
  row.dataset.id = "m9";
  row.appendChild(inner);
  sandbox.appendOmniRowArt(row, inner, { title });
  ttl.textContent = title;
  ttl.wordsRect = rect(40, 115, 140, 137);
  inner.appendChild(ttl);
  row.rect = rect(0, 100, 300, 152);
  if (replace) sandbox.rows.splice(sandbox.rows.indexOf(replace), 1, row); else sandbox.rows.push(row);
  return row;
}
const rowTitle = row => row.children[0].children.find(child => child.className === "ttl").textContent;
const rowArt = row => row.children[0].children.some(child => child.className === "omni-art");
const rowLight = row => row.children.find(child => child.className === "omni-sweep") || null;
const hasArt = card => card.titleEl.parentNode.children.some(child => child.className === "omni-card-art");
const childOf = (card, cls) => card.box.children.find(child => child.className === cls) || null;
const lightAt = card => Number(childOf(card, "omni-sweep").style["--omni-p"]);
const glintOf = env => env.sandbox.document.body.children.find(child => child.className === "omni-glint") || null;
const key = k => ({ key: k, shiftKey: false, preventDefault: noop, stopPropagation: noop });
// name a card through the title field and leave it by `how`: Tab, or a blur
function commit(env, card, typed, how){
  env.sandbox.editTitle("m9", how === "blur" ? { fromClick: true } : undefined);
  card.titleEl.textContent = typed;
  if (how === "blur") card.titleEl.onblur(); else card.titleEl.onkeydown(key(how));
}

test("the card reads Omni Card #N while the stored title and rows keep Omni Ticket #N", () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.omniCardTitle("Omni Ticket #1"), "Omni Card #1");
  assert.equal(sandbox.omniCardTitle("Omni Ticket #12"), "Omni Card #12");
  assert.equal(sandbox.omniCardTitle("Fix the login page"), "Fix the login page");
  assert.equal(sandbox.omniCardTitle("omni"), "omni");
  assert.equal(sandbox.omniCardTitle("Omni Card #3"), "Omni Card #3");
  assert.equal(sandbox.omniCardTitle(null), "");
});

test("the entry rule accepts exactly the word sets in the shared table", () => {
  const { sandbox } = makeSandbox();
  for (const raw of CASES.accept) assert.equal(sandbox.omniEntry(decode(raw)), true, JSON.stringify(raw));
  for (const raw of CASES.reject) assert.equal(sandbox.omniEntry(decode(raw)), false, JSON.stringify(raw));
  // the table itself covers what the rule promises: order, repeats, both
  // number spellings, extra words and non numbers
  for (const form of ["ticket omni", "omni omni", "omni card #3", "omni card 3", "omni ticket #12", "omni ticket 12"])
    assert.ok(CASES.accept.includes(form), form);
  for (const form of ["omni ticket please", "omni card ticket", "omni 3", "omni card three", "omni card 03"])
    assert.ok(CASES.reject.includes(form), form);
});

test("only the canonical title is an Omni ticket, as the server reads it", () => {
  const { sandbox } = makeSandbox();
  for (const [raw, number] of CASES.canonical){
    const info = sandbox.omniTicket(decode(raw));
    assert.equal(info ? info.number : null, number, raw);
  }
});

test("the next number is the lane's highest canonical number plus one", () => {
  const { sandbox } = makeSandbox();
  const boxes = [
    { owner: "facilitator", title: "Omni Ticket #1" }, { owner: "facilitator", title: "Omni Ticket #4" },
    { owner: "facilitator", title: "Omni Card #9" }, { owner: "other", title: "Omni Ticket #7" },
    { owner: "facilitator", title: "ticket omni" }, { title: "Omni Ticket #6" },
  ];
  assert.equal(sandbox.omniNextNumber(boxes, "facilitator"), 7);   // gaps are never reused
  assert.equal(sandbox.omniNextNumber(boxes, "other"), 8);
  assert.equal(sandbox.omniNextNumber(boxes, "empty"), 1);
  assert.equal(sandbox.omniNextNumber([{ owner: "a", title: "Omni Ticket #40" }], "a"), 41);   // no cap
});

test("a committed title lights the way in and the way out, and reduced motion lights nothing", () => {
  const { sandbox } = makeSandbox();
  const plan = (...args) => JSON.parse(JSON.stringify(sandbox.omniRetitle(...args)));
  assert.deepEqual(plan(false, "", "omni", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(false, "Old name", "ticket OMNI", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(false, "Old name", "Omni Ticket #8", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(true, "Omni Card #3", "Fix login", false), { dir: "out", sweep: true });
  assert.deepEqual(plan(true, "Omni Card #3", "Omni Card #3 notes", false), { dir: "out", sweep: true });
  assert.deepEqual(plan(false, "", "omni", true), { dir: "in", sweep: false });
  assert.deepEqual(plan(true, "Omni Card #3", "Fix login", true), { dir: "out", sweep: false });
  assert.equal(sandbox.omniRetitle(false, "Old name", "omni ticket please", false), null);   // not an Omni form
  assert.equal(sandbox.omniRetitle(false, "Old name", "omni 3", false), null);
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "Omni Card #3", false), null);       // left as it was
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "card omni", false), null);          // stays Omni
  assert.equal(sandbox.omniRetitle(false, "Old name", "New name", false), null);
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "   ", false), null);
});

test("the light runs 600 ms corner to corner, eased, off the card at both ends, and backward on the way out", () => {
  const { sandbox } = makeSandbox();
  const MS = vm.runInContext("OMNI_SWEEP_MS", sandbox), REACH = vm.runInContext("OMNI_SWEEP_REACH", sandbox);
  assert.ok(MS >= 500 && MS <= 700);
  const frame = rect(0, 0, 600, 800);
  assert.equal(sandbox.omniSweepSpot(frame, 0, 800), 0);     // bottom left
  assert.equal(sandbox.omniSweepSpot(frame, 600, 0), 1);     // top right
  assert.equal(sandbox.omniSweepSpot(frame, 0, 0), 0.5);     // the other diagonal
  assert.equal(sandbox.omniSweepSpot(frame, 600, 800), 0.5);
  assert.equal(sandbox.omniSweepAt(0, "in"), -REACH);
  assert.equal(sandbox.omniSweepAt(MS, "in"), 1 + REACH);
  assert.equal(sandbox.omniSweepAt(0, "out"), 1 + REACH);     // the way out starts past the top right
  assert.equal(sandbox.omniSweepAt(MS, "out"), -REACH);       // and ends past the bottom left
  assert.ok(Math.abs(sandbox.omniSweepAt(MS / 2, "in") - 0.5) < 1e-9);
  let up = -Infinity, down = Infinity;
  for (let ms = 0; ms <= MS; ms += 10){   // eased and never past its end: no bounce
    const a = sandbox.omniSweepAt(ms, "in"), b = sandbox.omniSweepAt(ms, "out");
    assert.ok(a >= up && a <= 1 + REACH && b <= down && b >= -REACH);
    up = a; down = b;
  }
  assert.ok(sandbox.omniSweepAt(60, "in") - sandbox.omniSweepAt(0, "in") <
            sandbox.omniSweepAt(330, "in") - sandbox.omniSweepAt(270, "in"));
  // the page's widest falloff is the reach the script counts on
  for (const page of ["index.html", "m.html"]){
    const css = fs.readFileSync(path.resolve(__dirname, "..", page), "utf8");
    assert.match(css, new RegExp(`rgba\\(255,242,232,0\\) calc\\(var\\(--omni-c\\) - ${REACH * 100}%\\)`), page);
  }
});

test("the glint sits on the card's rounded top right corner, on its edge", () => {
  const { sandbox } = makeSandbox();
  const card = rect(10, 20, 410, 620);
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.omniGlintPoint(card, 0))), { x: 410, y: 20 });
  const at = sandbox.omniGlintPoint(card, 7);
  const inset = 7 * (1 - Math.SQRT1_2);   // where a 7px corner's curve crosses the diagonal
  assert.equal(at.x, 410 - inset);
  assert.equal(at.y, 20 + inset);
  // on the curve: its distance from the curve's centre is the radius
  assert.ok(Math.abs(Math.hypot(at.x - (410 - 7), at.y - (20 + 7)) - 7) < 1e-9);
});

test("Tab on a card named ticket omni lights it in, swaps title and art as the light passes, then glints", () => {
  const env = makeSandbox();
  const { sandbox, frames, posts, timers } = env;
  const card = makeCard(env, "…");
  sandbox.editTitle("m9");
  card.titleEl.textContent = "ticket omni";
  card.titleEl.wordsRect = rect(20, 40, 110, 70);
  card.titleEl.onkeydown(key("Tab"));
  assert.equal(sandbox.document.activeElement, card.ta);          // on to the composer
  assert.deepEqual(posts.map(p => p.body), ["ticket omni"]);       // the stored title is the server's to make
  assert.ok(childOf(card, "omni-sweep"), "a Tab into Omni starts the light");
  assert.equal(frames.length, 1);
  // a reading that lands before the light reaches the title is held for it
  sandbox.syncOmniCard(card, { title: "Omni Ticket #3" });
  assert.equal(hasArt(card), false);
  const spot = sandbox.omniSweepSpot(env.layout.frame, 65, 55);
  let swappedAt = null, glintAt = null, before = null, glint = null;
  for (let now = 0; now <= 640 && frames.length; now += 16){
    const was = card.titleEl.textContent;
    env.frame(now);
    if (!glint && glintOf(env)){
      glintAt = now; glint = glintOf(env);
      // the glint fires in the frame the light's centre reaches the top right corner
      assert.ok(lightAt(card) >= 1 && before < 1, `light at ${lightAt(card)}`);
      // on the card's own corner, on its edge: the frame's top right, moved in onto the 7px curve,
      // and hung off the body rather than inside the card's clip
      const inset = 7 * (1 - Math.SQRT1_2);
      assert.equal(glint.style.left, (601 - inset) + "px");
      assert.equal(glint.style.top, (-1 + inset) + "px");
      assert.equal(childOf(card, "omni-glint"), null);
      assert.equal(glint.innerHTML, "<i></i><i></i>");   // the diagonals; the long cross is ::before and ::after
    }
    if (swappedAt == null && card.titleEl.textContent !== was){
      swappedAt = now;
      // the title, the art and the white face change in the frame the light's centre passes the title
      assert.ok(lightAt(card) >= spot && before < spot);
      assert.equal(card.titleEl.textContent, "Omni Card #3");
      assert.equal(hasArt(card), true);
      assert.equal(card.box.classList.contains("omni-card"), true);
    } else if (swappedAt == null) assert.equal(hasArt(card), false);
    if (childOf(card, "omni-sweep")) before = lightAt(card);
  }
  assert.ok(swappedAt > 250 && swappedAt < 350, `swapped at ${swappedAt} ms`);
  assert.ok(glintAt > 400 && glintAt < 500, `glint at ${glintAt} ms`);
  assert.equal(childOf(card, "omni-sweep"), null);                 // the light is gone after 600 ms
  assert.equal(card.omniSweep, null);
  assert.equal(card.tocTitle.textContent, "Omni Ticket #3");       // the outline keeps the stored name
  // the glint outlives the light by its own ting and then takes itself away
  assert.equal(glintOf(env), glint);
  const glintMs = vm.runInContext("OMNI_GLINT_MS", sandbox);
  assert.equal(glintMs, 300);
  assert.ok(timers.some(t => t.ms === glintMs + 200));
  glint.fire("animationend");
  assert.equal(glintOf(env), null);
});

test("the board's own number wins over the page's count, and a stale reading is ignored", () => {
  for (const [latest, shown] of [["Omni Ticket #4", "Omni Card #4"], ["…", "Omni Card #3"]]){
    const env = makeSandbox();
    const card = makeCard(env, "…");
    commit(env, card, "omni card #9", "Tab");   // a typed number is not the number given
    env.sandbox.syncOmniCard(card, { title: latest });
    for (let now = 0; now <= 640; now += 16) env.frame(now);
    assert.equal(card.titleEl.textContent, shown, latest);
    assert.equal(hasArt(card), true);
  }
});

test("blurring an Omni card whose name was changed sweeps it out from the top right, with no glint", () => {
  const env = makeSandbox();
  const { sandbox, frames, posts } = env;
  const card = makeCard(env, "Omni Ticket #3");
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(hasArt(card), true);
  commit(env, card, "Fix login", "blur");
  assert.deepEqual(posts.map(p => p.body), ["Fix login"]);
  assert.ok(childOf(card, "omni-sweep"), "leaving Omni starts the light");
  assert.equal(frames.length, 1);
  // a reading that lands before the light reaches the title is held for it
  sandbox.syncOmniCard(card, { title: "Fix login" });
  assert.equal(hasArt(card), true);
  // the words and the art together are the title area the light is timed to
  const spot = sandbox.omniSweepSpot(env.layout.frame, (20 + 200) / 2, (40 + 70) / 2);
  let swappedAt = null, before = null, first = null;
  for (let now = 0; now <= 640 && frames.length; now += 16){
    env.frame(now);
    if (first == null) first = lightAt(card);
    if (swappedAt == null && !hasArt(card)){
      swappedAt = now;
      // the art and the white face go in the frame the light's centre passes the title
      assert.ok(lightAt(card) <= spot && before > spot);
      assert.equal(card.box.classList.contains("omni-card"), false);
      assert.equal(card.titleEl.textContent, "Fix login");
    } else if (swappedAt == null) assert.equal(card.box.classList.contains("omni-card"), true);
    if (childOf(card, "omni-sweep")) before = lightAt(card);
    assert.equal(glintOf(env), null, "the way out never glints");
  }
  assert.ok(first > 1, "the light starts past the top right corner");
  assert.ok(before < 0, "and leaves past the bottom left");
  assert.ok(swappedAt > 200 && swappedAt < 350, `swapped at ${swappedAt} ms`);
  assert.equal(childOf(card, "omni-sweep"), null);
  assert.equal(card.omniSweep, null);
  assert.equal(hasArt(card), false);
  for (let now = 656; now <= 1200; now += 16) env.frame(now);
  assert.equal(glintOf(env), null);
});

test("titles outside the word sets never light or change the card", () => {
  for (const typed of ["omni ticket please", "omni 3", "omnibus", "the omni card", "omni card #0"]){
    const env = makeSandbox();
    const card = makeCard(env, "…");
    commit(env, card, typed, "Tab");
    assert.equal(childOf(card, "omni-sweep"), null, typed);
    assert.equal(env.frames.length, 0, typed);
    assert.equal(hasArt(card), false, typed);
    assert.equal(card.titleEl.textContent, typed);
  }
});

test("reduced motion changes the card at once both ways, with no light and no glint", () => {
  const env = makeSandbox();
  const { sandbox, frames } = env;
  sandbox.reduced = true;
  const card = makeCard(env, "…");
  commit(env, card, " Omni Ticket ", "Tab");
  assert.equal(childOf(card, "omni-sweep"), null);
  assert.equal(glintOf(env), null);
  assert.equal(frames.length, 0);
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(hasArt(card), true);
  commit(env, card, "Plain again", "blur");
  assert.equal(childOf(card, "omni-sweep"), null);
  assert.equal(glintOf(env), null);
  assert.equal(frames.length, 0);
  assert.equal(hasArt(card), false);
  assert.equal(card.box.classList.contains("omni-card"), false);
});

test("an unchanged name, Escape and a card not laid out never light", () => {
  const env = makeSandbox();
  const { sandbox, frames, posts } = env;
  const card = makeCard(env, "Omni Ticket #3");
  sandbox.editTitle("m9", { fromClick: true });
  card.titleEl.onblur();                                    // left as it was
  commit(env, card, "Something else", "Escape");            // Escape puts the old name back
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(frames.length, 0);
  assert.deepEqual(posts, []);
  const plain = makeCard(env, "Plain");
  env.layout.frame = RECT0;                                 // a hidden card lands at once
  commit(env, plain, "omni", "Tab");
  assert.equal(childOf(plain, "omni-sweep"), null);
  assert.equal(frames.length, 0);
  assert.equal(hasArt(plain), true);
  assert.equal(plain.titleEl.textContent, "Omni Card #3");
});

test("a row's light runs corner to corner along the row's own diagonal, like the card's", () => {
  const { sandbox } = makeSandbox();
  const row = rect(0, 100, 300, 152);
  assert.equal(sandbox.omniSweepSpot(row, 0, 152), 0);      // bottom left corner
  assert.equal(sandbox.omniSweepSpot(row, 300, 100), 1);    // top right corner
  // the light's line is the row's other diagonal, top left to bottom right,
  // and the centre of the row lies on it halfway through
  assert.equal(sandbox.omniSweepSpot(row, 0, 100), 0.5);
  assert.equal(sandbox.omniSweepSpot(row, 300, 152), 0.5);
  assert.equal(sandbox.omniSweepSpot(row, 150, 126), 0.5);
  assert.equal(sandbox.omniSweepSpot(row, 75, 113), 0.5);
  // the light's centre rides the bottom left to top right diagonal: a quarter of
  // the way along it stands at a quarter of the sweep
  assert.equal(sandbox.omniSweepSpot(row, 75, 139), 0.25);
  assert.equal(sandbox.omniRowSpot, undefined, "no separate 45 degree measure is left");
});

test("the ticket sweeps in with the card and turns into Omni Ticket #N as the light passes its title, with no glint", () => {
  const env = makeSandbox();
  const { sandbox, frames } = env;
  const card = makeCard(env, "…");
  let row = makeRow(env, "…");
  commit(env, card, "ticket omni", "Tab");
  const spot = sandbox.omniSweepSpot(row.rect, 90, 126);   // the middle of the row title's words
  let crossedAt = null, before = null, redrawn = false;
  for (let now = 0; now <= 640 && frames.length; now += 16){
    env.frame(now);
    if (childOf(card, "omni-sweep")){
      // one light, one clock: the row's light stands where the card's does in every frame
      assert.ok(rowLight(row), `the row has its light at ${now} ms`);
      assert.equal(rowLight(row).style["--omni-p"], childOf(card, "omni-sweep").style["--omni-p"]);
    }
    assert.equal(row.children.some(child => child.className === "omni-glint"), false);
    if (crossedAt == null && rowTitle(row) !== "…"){
      crossedAt = now;
      assert.ok(Number(rowLight(row).style["--omni-p"]) >= spot && before < spot);
      assert.equal(rowTitle(row), "Omni Ticket #3");   // the row reads the ticket's name, not the card's
      assert.equal(rowArt(row), true);
      assert.equal(row.classList.contains("omni-ticket"), true);
    } else if (crossedAt == null){
      assert.equal(rowArt(row), false);
      assert.equal(row.classList.contains("omni-ticket"), false);
      before = Number(rowLight(row).style["--omni-p"]);
      // the list redraws the row from the board's new title before the light reaches it:
      // the next frame lays the light back on and keeps the old face until it passes
      if (!redrawn && now >= 96){
        redrawn = true;
        sandbox.syncOmniCard(card, { title: "Omni Ticket #3" });
        row = makeRow(env, "Omni Ticket #3", row);
        assert.equal(rowLight(row), null);
      }
    }
  }
  assert.ok(redrawn);
  assert.ok(crossedAt > 150 && crossedAt < 350, `row crossed at ${crossedAt} ms`);
  assert.equal(rowLight(row), null);   // the light leaves with the card's
  assert.equal(rowTitle(row), "Omni Ticket #3");
  assert.equal(env.sandbox.document.body.children.filter(child => child.className === "omni-glint").length, 1,
    "only the card glints");
});

test("the ticket sweeps out from the top right and swaps back as the light passes, with no glint", () => {
  const env = makeSandbox();
  const { sandbox, frames } = env;
  const card = makeCard(env, "Omni Ticket #3");
  const row = makeRow(env, "Omni Ticket #3");
  commit(env, card, "Fix login", "blur");
  // the words and the art together are the row's title area
  const spot = sandbox.omniSweepSpot(row.rect, (8 + 140) / 2, (106 + 146) / 2);
  let crossedAt = null, before = null, first = null;
  for (let now = 0; now <= 640 && frames.length; now += 16){
    env.frame(now);
    if (first == null) first = Number(rowLight(row).style["--omni-p"]);
    if (crossedAt == null && !rowArt(row)){
      crossedAt = now;
      assert.ok(Number(rowLight(row).style["--omni-p"]) <= spot && before > spot);
      assert.equal(rowTitle(row), "Fix login");
      assert.equal(row.classList.contains("omni-ticket"), false);
    } else if (crossedAt == null){
      assert.equal(rowTitle(row), "Omni Ticket #3");
      before = Number(rowLight(row).style["--omni-p"]);
    }
  }
  assert.ok(first > 1, "the light starts past the row's top right corner");
  assert.ok(crossedAt > 150 && crossedAt < 400, `row crossed at ${crossedAt} ms`);
  assert.equal(rowLight(row), null);
  assert.equal(sandbox.document.body.children.some(child => child.className === "omni-glint"), false);
});

test("reduced motion changes the ticket at once both ways, with no light", () => {
  const env = makeSandbox();
  const { sandbox, frames } = env;
  sandbox.reduced = true;
  const card = makeCard(env, "…");
  const row = makeRow(env, "…");
  commit(env, card, "omni", "Tab");
  assert.equal(frames.length, 0);
  assert.equal(rowLight(row), null);
  assert.equal(rowTitle(row), "Omni Ticket #3");
  assert.equal(rowArt(row), true);
  commit(env, card, "Plain again", "blur");
  assert.equal(rowLight(row), null);
  assert.equal(rowTitle(row), "Plain again");
  assert.equal(rowArt(row), false);
});

test("a row with no size takes its final face at once, with no light", () => {
  const env = makeSandbox();
  const card = makeCard(env, "…");
  const row = makeRow(env, "…");
  row.rect = RECT0;   // not laid out: the drawer is shut or the list is not shown
  commit(env, card, "omni", "Tab");
  env.frame(0);
  assert.equal(rowLight(row), null);
  assert.equal(rowTitle(row), "Omni Ticket #3");
  assert.equal(rowArt(row), true);
  for (let now = 16; now <= 640; now += 16) env.frame(now);
  assert.equal(rowTitle(row), "Omni Ticket #3");
});
