// Deterministic unit tests for the Omni card's display name and its sweep:
// the card-versus-row names, the lane's next number, what a committed title
// asks for on Tab and on blur, reduced motion, and the frame the title and art
// change in. card-logic.js runs in a sandbox with a small DOM stub and a hand
// driven animation clock, so no browser is started.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");

const SRC = require("node:path").resolve(__dirname, "..", "card-logic.js");
const noop = () => {};
const RECT0 = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });

function makeSandbox(){
  const frames = [], posts = [];
  const layout = { frame: rect(0, 0, 600, 800), art: rect(20, 42, 40, 66) };
  const el = tag => {
    const node = { tagName: String(tag || "div").toUpperCase(), className: "", children: [], textContent: "",
      dataset: {}, parentNode: null, attributes: {}, rect: null, wordsRect: null };
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
    node.addEventListener = noop;
    node.focus = () => { sandbox.document.activeElement = node; };
    node.querySelector = selector => selector.startsWith(".")
      ? node.children.find(child => child.classList && child.classList.contains(selector.slice(1))) || null : null;
    node.querySelectorAll = () => [];
    node.getBoundingClientRect = () => {
      if (node.rect) return node.rect;
      if (node.classList.contains("omni-sweep")) return layout.frame;
      if (node.classList.contains("omni-card-art")) return layout.art;
      return RECT0;
    };
    return node;
  };
  const sandbox = {
    document: { createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: noop, body: el(), activeElement: null,
      createRange: () => ({ node: null, selectNodeContents(n){ this.node = n; },
        getBoundingClientRect(){ return this.node.wordsRect || this.node.getBoundingClientRect(); } }) },
    getSelection: () => ({ removeAllRanges: noop, addRange: noop }),
    setInterval: noop, clearInterval: noop, setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: cb => { frames.push(cb); return frames.length; }, cancelAnimationFrame: noop,
    reduced: false, matchMedia: () => ({ matches: sandbox.reduced }),
    fetch: (url, opts) => { posts.push({ url, body: opts && opts.body }); return Promise.resolve({ ok: true }); },
    poll: noop, console, localStorage: { getItem: () => null, setItem: noop }, navigator: {}, location: {},
    els: {}, lastState: null,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  vm.runInContext("keyboardTitle = true", sandbox);   // the desktop's Tab path
  // one frame of the page's animation clock at `now` ms
  const frame = now => { for (const cb of frames.splice(0)) cb(now); };
  return { sandbox, frames, posts, layout, frame, el };
}

// one desktop card in the sandbox: its box, head, title, composer and outline
// entry, in lane "facilitator" beside Omni tickets #1 and #2 and a #5 in another lane
function makeCard(env, title){
  const { sandbox, el } = env;
  const box = el("article"), head = el("div"), titleEl = el("span"), ta = el("div"), arc = el("button");
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
const hasArt = card => card.titleEl.parentNode.children.some(child => child.className === "omni-card-art");
const sweepOf = card => card.box.children.find(child => child.className === "omni-sweep") || null;
const bandAt = card => parseFloat(sweepOf(card).style["--omni-at"]) / 100;
const key = k => ({ key: k, shiftKey: false, preventDefault: noop, stopPropagation: noop });

test("the card reads Omni Card #N while the stored title and rows keep Omni Ticket #N", () => {
  const { sandbox } = makeSandbox();
  assert.equal(sandbox.omniCardTitle("Omni Ticket #1"), "Omni Card #1");
  assert.equal(sandbox.omniCardTitle("Omni Ticket #12"), "Omni Card #12");
  assert.equal(sandbox.omniCardTitle("Fix the login page"), "Fix the login page");
  assert.equal(sandbox.omniCardTitle("omni"), "omni");
  assert.equal(sandbox.omniCardTitle("Omni Card #3"), "Omni Card #3");
  assert.equal(sandbox.omniCardTitle(null), "");
  // identity still follows the canonical title only
  assert.equal(sandbox.omniTicket("Omni Card #3"), null);
  assert.equal(sandbox.omniTicket("Omni Ticket #3").number, 3);
});

test("the omni word is read forgivingly and the next number is the lane's highest plus one", () => {
  const { sandbox } = makeSandbox();
  for (const word of ["omni", "Omni", " OMNI ", "oMnI\n"]) assert.equal(sandbox.omniCommand(word), true, word);
  for (const word of ["omnibus", "omni ticket", "Omni Ticket #3", ""]) assert.equal(sandbox.omniCommand(word), false, word);
  const boxes = [
    { owner: "facilitator", title: "Omni Ticket #1" }, { owner: "facilitator", title: "Omni Ticket #4" },
    { owner: "facilitator", title: "Omni Card #9" }, { owner: "other", title: "Omni Ticket #7" },
    { title: "Omni Ticket #6" },   // no owner reads as the default lane, as on the server
  ];
  assert.equal(sandbox.omniNextNumber(boxes, "facilitator"), 7);   // gaps are never reused
  assert.equal(sandbox.omniNextNumber(boxes, "other"), 8);
  assert.equal(sandbox.omniNextNumber(boxes, "empty"), 1);
  assert.equal(sandbox.omniNextNumber([{ owner: "a", title: "Omni Ticket #40" }], "a"), 41);   // no cap
});

test("a committed title sweeps in, out or not at all, and reduced motion drops the sweep", () => {
  const { sandbox } = makeSandbox();
  const plan = (...args) => JSON.parse(JSON.stringify(sandbox.omniRetitle(...args)));
  assert.deepEqual(plan(false, "", "omni", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(false, "Old name", " OMNI ", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(false, "Old name", "Omni Ticket #8", false), { dir: "in", sweep: true });
  assert.deepEqual(plan(true, "Omni Card #3", "Fix login", false), { dir: "out", sweep: true });
  assert.deepEqual(plan(true, "Omni Card #3", "Omni Card #3 notes", false), { dir: "out", sweep: true });
  assert.deepEqual(plan(false, "", "omni", true), { dir: "in", sweep: false });
  assert.deepEqual(plan(true, "Omni Card #3", "Fix login", true), { dir: "out", sweep: false });
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "Omni Card #3", false), null);   // left as it was
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "omni", false), null);           // stays Omni, new number
  assert.equal(sandbox.omniRetitle(false, "Old name", "New name", false), null);           // ordinary both sides
  assert.equal(sandbox.omniRetitle(true, "Omni Card #3", "   ", false), null);             // emptied: the name is kept
});

test("the sweep runs 600 ms corner to corner, eased, and backward for out", () => {
  const { sandbox } = makeSandbox();
  const MS = vm.runInContext("OMNI_SWEEP_MS", sandbox), BAND = vm.runInContext("OMNI_SWEEP_BAND", sandbox);
  assert.ok(MS >= 500 && MS <= 700);
  const frame = rect(0, 0, 600, 800);
  assert.equal(sandbox.omniSweepSpot(frame, 0, 800), 0);     // bottom left
  assert.equal(sandbox.omniSweepSpot(frame, 600, 0), 1);     // top right
  assert.equal(sandbox.omniSweepSpot(frame, 0, 0), 0.5);     // the other diagonal
  assert.equal(sandbox.omniSweepSpot(frame, 600, 800), 0.5);
  assert.equal(sandbox.omniSweepAt(0, "in"), -BAND);         // wholly off the card at both ends
  assert.equal(sandbox.omniSweepAt(MS, "in"), 1 + BAND);
  assert.equal(sandbox.omniSweepAt(0, "out"), 1 + BAND);
  assert.equal(sandbox.omniSweepAt(MS, "out"), -BAND);
  assert.ok(Math.abs(sandbox.omniSweepAt(MS / 2, "in") - 0.5) < 1e-9);
  let last = -Infinity;
  for (let ms = 0; ms <= MS; ms += 10){   // eased and never past its end: no bounce
    const at = sandbox.omniSweepAt(ms, "in");
    assert.ok(at >= last && at <= 1 + BAND);
    last = at;
  }
  // soft at the ends, quick through the middle
  assert.ok(sandbox.omniSweepAt(60, "in") - sandbox.omniSweepAt(0, "in") <
            sandbox.omniSweepAt(330, "in") - sandbox.omniSweepAt(270, "in"));
});

test("Tab on a new card named omni sweeps it in, swapping title and art as the band passes", () => {
  const env = makeSandbox();
  const { sandbox, frames, posts } = env;
  const card = makeCard(env, "…");
  sandbox.editTitle("m9");
  card.titleEl.textContent = "omni";
  card.titleEl.wordsRect = rect(20, 40, 80, 70);
  card.titleEl.onkeydown(key("Tab"));
  assert.equal(sandbox.document.activeElement, card.ta);          // on to the composer
  assert.deepEqual(posts.map(p => p.body), ["omni"]);              // the stored title is the server's to make
  assert.ok(sweepOf(card), "a Tab into Omni starts the sweep");
  assert.equal(frames.length, 1);
  // a reading that lands before the band reaches the title is held for it
  sandbox.syncOmniCard(card, { title: "Omni Ticket #3" });
  assert.equal(hasArt(card), false);
  const spot = sandbox.omniSweepSpot(env.layout.frame, 50, 55);
  let swappedAt = null, before = null;
  for (let now = 0; now <= 640 && frames.length; now += 16){
    const was = card.titleEl.textContent;
    env.frame(now);
    if (swappedAt == null && card.titleEl.textContent !== was){
      swappedAt = now;
      // the title, the art and the white face change in the frame the band's centre passes the title
      assert.ok(bandAt(card) >= spot - 1e-4 && before < spot);
      assert.equal(card.titleEl.textContent, "Omni Card #3");
      assert.equal(hasArt(card), true);
      assert.equal(card.box.classList.contains("omni-card"), true);
    } else if (swappedAt == null){
      assert.equal(hasArt(card), false);
      before = bandAt(card);
    }
  }
  assert.ok(swappedAt > 250 && swappedAt < 350, `swapped at ${swappedAt} ms`);
  assert.equal(sweepOf(card), null);                              // the band is gone after 600 ms
  assert.equal(card.omniSweep, null);
  assert.equal(card.tocTitle.textContent, "Omni Ticket #3");      // the outline keeps the stored name
});

test("the board's own number wins over the page's count, and a stale reading is ignored", () => {
  for (const [latest, shown] of [["Omni Ticket #4", "Omni Card #4"], ["…", "Omni Card #3"]]){
    const env = makeSandbox();
    const card = makeCard(env, "…");
    env.sandbox.editTitle("m9");
    card.titleEl.textContent = "omni";
    card.titleEl.onkeydown(key("Tab"));
    env.sandbox.syncOmniCard(card, { title: latest });
    for (let now = 0; now <= 640; now += 16) env.frame(now);
    assert.equal(card.titleEl.textContent, shown, latest);
    assert.equal(hasArt(card), true);
  }
});

test("blurring an Omni card whose name was changed sweeps it out from the top right", () => {
  const env = makeSandbox();
  const { sandbox, posts } = env;
  const card = makeCard(env, "Omni Ticket #3");
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(hasArt(card), true);
  sandbox.editTitle("m9", { fromClick: true });
  card.titleEl.textContent = "Fix login";
  card.titleEl.onblur();
  assert.deepEqual(posts.map(p => p.body), ["Fix login"]);
  assert.ok(sweepOf(card));
  // the words and the art together are the title area the band is timed to
  const spot = sandbox.omniSweepSpot(env.layout.frame, (20 + 200) / 2, (40 + 70) / 2);
  let swappedAt = null, before = null;
  for (let now = 0; now <= 640; now += 16){
    env.frame(now);
    if (swappedAt == null && !hasArt(card)){
      swappedAt = now;
      assert.ok(bandAt(card) <= spot + 1e-4 && before > spot);
      assert.equal(card.box.classList.contains("omni-card"), false);
      assert.equal(card.titleEl.textContent, "Fix login");
    } else if (swappedAt == null){
      before = bandAt(card);
      assert.ok(before <= 1.14 + 1e-9);
      assert.equal(card.box.classList.contains("omni-card"), true);
    }
  }
  assert.ok(swappedAt > 200 && swappedAt < 350, `swapped at ${swappedAt} ms`);
  assert.equal(sweepOf(card), null);
});

test("reduced motion changes the card at once in both directions, with no sweep", () => {
  const env = makeSandbox();
  const { sandbox, frames } = env;
  sandbox.reduced = true;
  const card = makeCard(env, "…");
  sandbox.editTitle("m9");
  card.titleEl.textContent = " Omni ";
  card.titleEl.onkeydown(key("Tab"));
  assert.equal(sweepOf(card), null);
  assert.equal(frames.length, 0);
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(hasArt(card), true);
  sandbox.editTitle("m9", { fromClick: true });
  card.titleEl.textContent = "Plain again";
  card.titleEl.onblur();
  assert.equal(sweepOf(card), null);
  assert.equal(frames.length, 0);
  assert.equal(hasArt(card), false);
  assert.equal(card.box.classList.contains("omni-card"), false);
});

test("an unchanged name, Escape and a card not laid out never sweep", () => {
  const env = makeSandbox();
  const { sandbox, frames, posts } = env;
  const card = makeCard(env, "Omni Ticket #3");
  sandbox.editTitle("m9", { fromClick: true });
  card.titleEl.onblur();                                    // left as it was
  sandbox.editTitle("m9");
  card.titleEl.textContent = "Something else";
  card.titleEl.onkeydown(key("Escape"));                    // Escape puts the old name back
  assert.equal(card.titleEl.textContent, "Omni Card #3");
  assert.equal(frames.length, 0);
  assert.deepEqual(posts, []);
  env.layout.frame = RECT0;                                 // a hidden card lands at once
  sandbox.editTitle("m9");
  card.titleEl.textContent = "Hidden rename";
  card.titleEl.onkeydown(key("Tab"));
  assert.equal(sweepOf(card), null);
  assert.equal(frames.length, 0);
  assert.equal(hasArt(card), false);
});
