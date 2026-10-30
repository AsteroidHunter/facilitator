// The crossfade between projects copies only what is drawn. The board's
// boardFadeTake hands stillCopy every card that is not on show, and stillCopy
// leaves those cards out of the copy, never cloning them or reading their
// scroll, while the card on show keeps its markup, its typed text and its
// scroll positions, and every other part of the stage is copied as before.
// The phone copies one card with no cards left out, which is the old whole
// copy. The real stillCopy and boardFadeTake run in a VM over a small
// stand-in DOM; no browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const phone = readFileSync(path.join(root, "m.html"), "utf8");
const logic = readFileSync(path.join(root, "card-logic.js"), "utf8");
function slice(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
}

// ---- the stand-in dom -------------------------------------------------------
// elements and text nodes with children, attributes, classes, a deep or bare
// copy, a query for every element under one in page order, and scroll
// positions whose every read is counted per element
const counts = { clones: new Map(), scrollReads: new Map() };
function bump(map, node) { map.set(node, (map.get(node) || 0) + 1); }
class Node {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  replaceWith(other) {
    const p = this.parentNode;
    if (!p) return;
    p.childNodes[p.childNodes.indexOf(this)] = other;
    other.parentNode = p;
    this.parentNode = null;
  }
}
class Text extends Node {
  constructor(text) { super(); this.nodeType = 3; this.textContent = text; }
  cloneNode() { return new Text(this.textContent); }
}
class Element extends Node {
  constructor(tag, attrs = {}) {
    super();
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.style = { cssText: "" };
    this.value = "";
    this.checked = false;
    this.inert = false;
    this._top = 0; this._left = 0;
    const self = this;
    this.classList = {
      contains: c => (self.attrs.class || "").split(/\s+/).includes(c),
      add: c => { if (!self.classList.contains(c)) self.attrs.class = ((self.attrs.class || "") + " " + c).trim(); },
    };
  }
  get className() { return this.attrs.class || ""; }
  set className(v) { this.attrs.class = v; }
  get id() { return this.attrs.id || ""; }
  get scrollTop() { bump(counts.scrollReads, this); return this._top; }
  set scrollTop(v) { this._top = v; }
  get scrollLeft() { bump(counts.scrollReads, this); return this._left; }
  set scrollLeft(v) { this._left = v; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  cloneNode(deep) {
    bump(counts.clones, this);
    const b = new Element(this.tagName, this.attrs);
    b.style.cssText = this.style.cssText;
    if (deep) for (const c of this.childNodes) b.appendChild(c.cloneNode(true));
    return b;
  }
  querySelectorAll(sel) {
    assert.equal(sel, "*");
    const out = [];
    const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
function el(tag, attrs, ...kids) {
  const e = new Element(tag, attrs || {});
  for (const k of kids) e.appendChild(typeof k === "string" ? new Text(k) : k);
  return e;
}
function all(node) { return [node, ...node.querySelectorAll("*")]; }
function ids(node) { return all(node).map(e => e.id).filter(Boolean); }

function loadStillCopy() {
  const context = vm.createContext({ document: { createElement: tag => new Element(tag) } });
  vm.runInContext(slice(logic, "function stillCopy(", "\n// ---- the page turn"), context);
  return context.stillCopy;
}

// a stage like the board's: the bar, a magic box with a framed page, and the
// cards of every project in #sections, one of them on show (.sel) with a
// scrolled answer and words typed in its box
function board() {
  const card = (id, sel) => el("article", { id: "box-" + id, class: "box" + (sel ? " sel" : "") },
    el("div", { class: "topbar" }, "title " + id),
    el("div", { class: "replyview", id: "rv-" + id }, el("div", { class: "reply" }, "answer " + id)),
    el("textarea", { class: "ta" }));
  const cards = { a1: card("a1"), a2: card("a2"), b1: card("b1", true), b2: card("b2"), c1: card("c1") };
  const stage = el("div", { id: "stage" },
    el("div", { id: "leftcol" }, el("div", { id: "clockbox" }, "12:00")),
    el("div", { id: "tickets" }, el("div", { id: "tiklist" }, el("div", { class: "trow" }, "row"))),
    el("section", { id: "magicbox" }, el("div", { class: "mbbody" }, el("iframe", { class: "mbframe" }))),
    el("main", {},
      el("div", { id: "rail" }),
      el("div", { id: "sections" },
        el("div", { class: "bucket" }, cards.a1, "\n", cards.a2),
        el("div", { class: "bucket" }, cards.b1, cards.b2, cards.c1)),
      el("div", { id: "carousel" })));
  const shown = cards.b1;
  shown.childNodes[1].scrollTop = 340;
  shown.childNodes[1].scrollLeft = 12;
  shown.childNodes[2].value = "half a sentence";
  for (const k of ["a1", "a2", "b2", "c1"]) cards[k].childNodes[1].scrollTop = 99;
  return { stage, cards, shown };
}

test("the copy leaves the hidden cards out and keeps the card on show with its scroll", () => {
  const stillCopy = loadStillCopy();
  const { stage, cards, shown } = board();
  const hidden = [cards.a1, cards.a2, cards.b2, cards.c1];
  counts.clones.clear(); counts.scrollReads.clear();
  const { copy, settle } = stillCopy(stage, { leave: hidden });

  // the hidden cards are not in the copy, and nothing of them was cloned or read
  assert.deepEqual(ids(copy).filter(id => id.startsWith("box-")), ["box-b1"]);
  for (const c of hidden) for (const n of all(c)) {
    assert.equal(counts.clones.get(n) || 0, 0, "cloned " + n.tagName + " of a hidden card");
    assert.equal(counts.scrollReads.get(n) || 0, 0, "read the scroll of a hidden card");
  }
  // every other part of the stage is there, in its place
  assert.deepEqual(ids(copy), ["stage", "leftcol", "clockbox", "tickets", "tiklist", "magicbox",
    "rail", "sections", "box-b1", "rv-b1", "carousel"]);
  const buckets = copy.querySelectorAll("*").filter(e => e.className === "bucket");
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].childNodes.length, 1, "the text between the cards stays");
  assert.equal(buckets[1].childNodes.length, 1);
  // the card on show is the whole card, with its typed words
  const shownCopy = buckets[1].childNodes[0];
  assert.equal(shownCopy.id, "box-b1");
  assert.equal(all(shownCopy).length, all(shown).length);
  assert.equal(shownCopy.childNodes[2].value, "half a sentence");
  // its scroll is put back once the copy is on the page
  assert.equal(shownCopy.childNodes[1]._top, 0);
  settle();
  assert.equal(shownCopy.childNodes[1]._top, 340);
  assert.equal(shownCopy.childNodes[1]._left, 12);
  // a framed page is still a plain box in the copy, and the copy takes nothing
  assert.equal(copy.querySelectorAll("*").filter(e => e.tagName === "IFRAME").length, 0);
  assert.equal(copy.querySelectorAll("*").filter(e => e.className === "mbframe").length, 1);
  assert.equal(copy.inert, true);
  assert.equal(copy.getAttribute("aria-hidden"), "true");
  // and the live stage is untouched
  assert.equal(stage.querySelectorAll("*").filter(e => e.tagName === "ARTICLE").length, 5);
  assert.equal(shown.childNodes[1]._top, 340);
});

test("a copy with nothing left out is the whole copy it always was (the phone's card)", () => {
  const stillCopy = loadStillCopy();
  const { shown } = board();
  counts.clones.clear();
  const { copy, settle } = stillCopy(shown, { noIds: true });
  assert.equal(counts.clones.get(shown), 1, "one deep copy in one call");
  assert.equal(all(copy).length, all(shown).length);
  assert.deepEqual(ids(copy), [], "noIds takes every id off");
  assert.equal(copy.childNodes[2].value, "half a sentence");
  settle();
  assert.equal(copy.childNodes[1]._top, 340);
  // the same with an empty list
  const again = stillCopy(shown, { leave: [] }).copy;
  assert.equal(all(again).length, all(shown).length);
});

test("an element outside the copied one, or a hidden card the page no longer holds, changes nothing", () => {
  const stillCopy = loadStillCopy();
  const { stage } = board();
  const stray = el("article", { class: "box" }, el("div"));
  const whole = stillCopy(stage).copy;
  const withStray = stillCopy(stage, { leave: [stray] }).copy;
  assert.equal(all(withStray).length, all(whole).length);
});

test("the board hands stillCopy every card but the one on show", () => {
  const take = slice(html, "function boardFadeTake(){", "\n// the new project is drawn");
  const box = sel => ({ classList: { contains: c => c === "sel" && sel } });
  const els = { a1: { box: box(false) }, b1: { box: box(true) }, b2: { box: box(false) } };
  const calls = [];
  const stage = { id: "stage" };
  const context = vm.createContext({
    FOCUS: true, homeOpen: false, draft: false, activeOwner: "beta", els,
    matchMedia: () => ({ matches: false }),
    document: {
      hidden: false,
      body: { classList: { contains: c => c === "layout-ready" } },
      getElementById: id => (id === "stage" ? stage : null),
    },
    stillCopy: (el, opts) => { calls.push([el, opts]); return { copy: { classList: { add() {} } }, settle() {} }; },
  });
  vm.runInContext(take, context);
  const fade = context.boardFadeTake();
  assert.equal(fade.owner, "beta");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], stage);
  const leave = [...calls[0][1].leave];
  assert.equal(leave.length, 2);
  assert.equal(leave[0], els.a1.box);
  assert.equal(leave[1], els.b2.box);
  // reduced motion, or a page out of focus mode, takes no copy at all
  context.matchMedia = () => ({ matches: true });
  assert.equal(context.boardFadeTake(), null);
  context.matchMedia = () => ({ matches: false });
  context.FOCUS = false;
  assert.equal(context.boardFadeTake(), null);
  assert.equal(calls.length, 1);
});

test("a card that is not on show is not drawn on the board, and the phone copies its card whole", () => {
  // what leaving the cards out rests on: in focus mode only .sel is drawn
  assert.match(html, /body\.focus \.box\{display:none\}/);
  assert.match(html, /body\.focus \.box\.sel\{\s*display:flex/);
  // the phone copies the one card on show, with nothing left out
  assert.match(phone, /stillCopy\(card, \{ noIds: true \}\)/);
});
