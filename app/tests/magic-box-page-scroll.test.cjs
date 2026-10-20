// Control+S scrolls an agent's page in the Mac board's box as it scrolls the card, whether the keys were
// put in the box by Control+Option+Right or by a click in the page. The page is sealed off from the board,
// so it scrolls itself when the board asks and says the keys typed in it; the board's own hold-to-scroll
// motion (card-logic.js) does the rest, so the speed and the hold are the card's. Run from the pages' own
// source, no browser: the page's script and the box's view are run in a bare context, and the wiring in
// index.html is read as written.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.MAGIC_BOX_SOURCE_ROOT || path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const HTML = read("index.html");
const cut = (from, to) => {
  const a = HTML.indexOf(from), b = HTML.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} ... ${to}`);
  return HTML.slice(a, b);
};
const fn = name => cut(`function ${name}(`, "\n}\n") + "\n}\n";
const MagicBox = (() => { const s = vm.createContext({}); vm.runInContext(read("magic-box.js"), s); return s.MagicBox; })();
const plain = value => JSON.parse(JSON.stringify(value));

// the page's side: its own script, with a window made of what it touches
function pageSide() {
  const hello = [...MagicBox.pageDoc("<p>x</p>", "w", true).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])[1];
  const posted = [], listeners = [], timers = [], went = [], animated = [];
  const root = { scrollTop: 40, scrollHeight: 5000, clientHeight: 650, scrollTo: o => { went.push(o); root.scrollTop = o.top; } };
  const parent = { postMessage: (...a) => posted.push(a) };
  const ctx = vm.createContext({ parent, setTimeout: f => timers.push(f),
    addEventListener: (type, f, capture) => listeners.push({ type, f, capture }),
    document: { addEventListener() {}, body: null, scrollingElement: root,
      documentElement: { animate: (...a) => { animated.push(a); return { cancel() {} }; } } } });
  ctx.window = ctx;
  ctx.MutationObserver = class { observe() {} };
  vm.runInContext(hello, ctx);
  return {
    listeners, root, went, animated, parent, ctx,
    send: (type, event) => listeners.filter(l => l.type === type).forEach(l => l.f(event)),
    said: () => posted.splice(0).map(p => p[0]).filter(m => m !== "w"),
    flush: () => timers.splice(0).forEach(f => f()),
  };
}

test("a page in the Mac's box scrolls to where the board asks, says where it stands, and ignores everyone else", () => {
  const f = pageSide();
  f.send("load", {});
  f.flush();
  assert.deepEqual(f.said().filter(m => m.startsWith("w scroll ")), ["w scroll 40 5000 650 0"], "its place and its height, once");
  f.flush();
  assert.deepEqual(f.said(), [], "nothing said again while nothing has changed");
  f.send("message", { source: f.parent, data: "w to 190.5 3" });
  assert.deepEqual(plain(f.went), [{ top: 190.5, behavior: "instant" }], "at once, whatever scroll-behavior the page asks for");
  f.flush();
  assert.deepEqual(f.said(), ["w scroll 191 5000 650 3"], "and the last ask it has done is said back");
  for (const stray of [{ source: {}, data: "w to 0 4" }, { source: f.parent, data: "other to 0 4" },
    { source: f.parent, data: "w to x 4" }, { source: f.parent, data: 7 }])
    f.send("message", stray);
  assert.equal(f.went.length, 1, "only the board, only with the page's word, only a number");
  const frames = [{ translate: "0 0" }, { translate: "0 -9px", offset: 0.4 }, { translate: "0 0" }];
  f.send("message", { source: f.parent, data: "w bounce " + JSON.stringify([frames, { duration: 260 }]) });
  assert.deepEqual(plain(f.animated), [[frames, { duration: 260 }]], "the page's own root gives at an end");
  f.send("message", { source: f.parent, data: "w bounce not json" });
  assert.equal(f.animated.length, 1);
});

test("a page in the Mac's box says control+S and its release, never what else is typed, and a field keeps its own S", () => {
  const f = pageSide();
  const key = (extra = {}) => ({ key: "s", ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false,
    target: { closest: () => null }, prevented: false, preventDefault() { this.prevented = true; }, ...extra });
  let e = key();
  f.send("keydown", e);
  assert.equal(e.prevented, true);
  assert.deepEqual(f.said(), ['w key ["down","s",true,false,false,false,false]']);
  f.send("keydown", key({ repeat: true }));
  assert.deepEqual(f.said(), ['w key ["down","s",true,false,false,false,true]'], "a held key's repeats are said as repeats");
  f.send("keyup", key());
  assert.deepEqual(f.said(), ['w key ["up","s",true,false,false,false,false]']);
  f.send("keyup", key({ key: "Control", ctrlKey: false }));
  assert.deepEqual(f.said(), ['w key ["up","Control",false,false,false,false,false]']);
  // any other key is said as no key at all: the board only needs to know that one was pressed
  e = key({ key: "p", ctrlKey: false });
  f.send("keydown", e);
  assert.equal(e.prevented, false);
  assert.deepEqual(f.said(), ['w key ["down","",false,false,false,false,false]']);
  // shift with it is not the chord: the page's own, said with what was held
  e = key({ shiftKey: true });
  f.send("keydown", e);
  assert.equal(e.prevented, false);
  assert.deepEqual(f.said(), ['w key ["down","s",true,true,false,false,false]']);
  // a field in the page keeps control+S: said as another key, which ends a motion and starts none
  e = key({ target: { closest: () => ({}) } });
  f.send("keydown", e);
  assert.equal(e.prevented, false);
  assert.deepEqual(f.said(), ['w key ["down","",false,false,false,false,false]']);
  // the page losing the window lets the motion go; a field in it losing its focus is not that
  f.send("blur", { target: vm.runInContext("window", f.ctx) });
  assert.deepEqual(f.said(), ['w key ["up","",false,false,false,false,false]']);
  f.send("blur", { target: {} });
  assert.deepEqual(f.said(), []);
  // all in capture, ahead of anything the agent wrote
  for (const type of ["keydown", "keyup", "blur", "scroll"])
    assert.ok(f.listeners.filter(l => l.type === type).every(l => l.capture === true), type);
});

// the board's side: the page as the thing the hold-to-scroll motion scrolls
function boardSide(hooks = {}) {
  const view = read("card-logic.js");
  let onMessage = null;
  const body = { style: { setProperty() {}, removeProperty() {} }, textContent: "", dataset: {}, append() {},
    addEventListener() {}, querySelector() { return null; } };
  const sent = [], heard = [];
  const win = { postMessage: (...a) => sent.push(a) };
  const vctx = vm.createContext({
    MagicBox: { pageDoc: () => "" }, getComputedStyle: () => ({ getPropertyValue: () => "0" }), setTimeout() {}, Date, JSON,
    document: { id: "document", body: { id: "body" } },
    addEventListener: (type, f) => { if (type === "message") onMessage = f; },
    h: () => ({ setAttribute() {}, addEventListener() {}, clientWidth: 398, contentWindow: win, isConnected: true }),
  });
  vm.runInContext(view.match(/function magicView\(el, hooks = \{\}\)\{[\s\S]*?\n  return view;\n\}/)[0] + ";this.magicView = magicView;", vctx);
  const el = { ownerDocument: vctx.document, querySelector: s => s === ".mbbody" ? body : null, lastElementChild: null };
  const v = vctx.magicView(el, { sized: true, placed() {}, key: e => heard.push(e), ...hooks });
  v.draw({ kind: "html", html: "<p>x</p>" });
  body.dataset.kind = "html";
  const run = v.page;
  return { v, run, win, sent, heard, body, el,
    tell: (text, source = win) => onMessage({ source, data: run.word + " " + text }),
    hear: message => onMessage(message) };
}

test("the board scrolls an agent's page through the page: it reads where the page stands, asks it to go, and a late report does not undo the ask", () => {
  const p = boardSide();
  const s = p.v.pageScroller();
  assert.ok(s && s === p.v.pageScroller(), "one scroller for one page");
  assert.equal(s.box, p.el);
  const view = s.replyview;
  assert.equal(view.clientHeight, 0, "nothing to scroll until the page has said how tall it is");
  p.tell("scroll 120 5000 650 0");
  assert.deepEqual([view.scrollTop, view.scrollHeight, view.clientHeight], [120, 5000, 650]);
  assert.equal(view.isConnected, true);
  assert.equal(view.ownerDocument.id, "document");
  // the motion writes its position each frame; each write is an ask, counted
  view.scrollTop = 150;
  view.scrollTop = 152.5;
  assert.deepEqual(p.sent.map(a => a[0]), [p.run.word + " to 150 1", p.run.word + " to 152.5 2"]);
  assert.ok(p.sent.every(a => a[1] === "*"));
  assert.equal(view.scrollTop, 152.5, "where it asked, at once");
  p.tell("scroll 150 5000 650 1");
  assert.equal(view.scrollTop, 152.5, "a report from before the last ask does not move it back");
  p.tell("scroll 152 5000 700 2");
  assert.deepEqual([view.scrollTop, view.clientHeight], [152, 700], "the one that follows the last ask does, and the window's height is always taken");
  // from the page alone, in its own words only, and only numbers
  p.tell("scroll 10 1 1 2", {});
  p.tell("scroll x 5000 650 2");
  p.tell("scroll 10 5000 650");
  assert.equal(view.scrollTop, 152);
  // the edge bounce is the page's: the box's keyframes go to it
  const [part] = view.children;
  const frames = [{ translate: "0 0" }, { translate: "0 -9px", offset: 0.4 }, { translate: "0 0" }];
  p.sent.length = 0;
  const kept = part.animate(frames, { duration: 260 });
  assert.equal(typeof kept.cancel, "function");
  assert.equal(p.sent[0][0], p.run.word + " bounce " + JSON.stringify([frames, { duration: 260 }]));
  // not the phone's page (it is laid out as tall as it is), and not what is not a page
  assert.equal(boardSide({ sized: false }).v.pageScroller(), null);
  p.body.dataset.kind = "markdown";
  assert.equal(p.v.pageScroller(), null);
});

test("the keys typed in an agent's page reach the board as keys it can read, from that page alone, and nothing else gets through", () => {
  const p = boardSide();
  p.tell('key ["down","s",true,false,false,false,false]');
  assert.equal(p.heard.length, 1);
  const e = p.heard[0];
  assert.deepEqual({ ...e, preventDefault: typeof e.preventDefault, target: e.target.id },
    { type: "keydown", key: "s", ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false,
      defaultPrevented: false, target: "body", preventDefault: "function" });
  assert.equal(e.preventDefault(), undefined);
  p.tell('key ["up","Control",false,false,false,false,false]');
  assert.deepEqual([p.heard[1].type, p.heard[1].key, p.heard[1].ctrlKey], ["keyup", "Control", false]);
  p.tell('key ["down","Enter",true,true,true,true,true]');
  assert.equal(p.heard[2].key, "", "no key but S and Control is ever passed on");
  assert.deepEqual([p.heard[2].ctrlKey, p.heard[2].shiftKey, p.heard[2].metaKey, p.heard[2].altKey, p.heard[2].repeat], [true, true, true, true, true]);
  const n = p.heard.length;
  p.tell('key ["down","s","yes",1,0,0,0]');
  assert.equal(p.heard[n].ctrlKey, false, "only a true is a true");
  p.tell('key ["down","s"]');
  p.tell("key not json");
  p.tell('key ["down","s",true,false,false,false,false]', {});
  p.hear({ source: p.win, data: 'other key ["down","s",true,false,false,false,false]' });
  assert.equal(p.heard.length, n + 1, "a short list, bad words, another window and another page's word are all left alone");
  // a board with nobody to hear it is not asked
  const mute = boardSide({ key: undefined });
  mute.tell('key ["down","s",true,false,false,false,false]');
  assert.equal(mute.heard.length, 0);
});

test("the Mac board follows control+S in a page whether the keys came by control+option+right or by a click in it", () => {
  // the held box's scroller is the page when it holds one, and the words as before when it does not
  const card = fn("boardMagicScrollCard");
  assert.match(card, /const page = MB\.view\.pageScroller\(\);\s*if \(page\) return \{ id: "magic:" \+ MB\.id, owner: card\.owner, el: page \};\s*if \(!MB\.scroller\)/);
  assert.match(card, /!card \|\| !boardMagicHeld\(\)/, "the runbook's rule: only when the keys are in the box");
  // what the page says of its keys is run through the same three the board's own listeners run
  const key = fn("magicPageKey");
  assert.match(key, /if \(ev\.type === "keyup"\) responseScrollKeyUp\(ev\);\s*else if \(responseScrollChord\(ev\)\) responseScrollKey\(ev, boardMagicScrollCard\);\s*else responseScrollOtherKey\(ev\);/);
  assert.match(key, /if \(!FOCUS \|\| !boardKeysLive\(\)\) return;/);
  assert.match(HTML, /create: \(\) => \{ if \(FOCUS && boardKeysLive\(\)\) newCardHere\(\); \},\s*key: ev => magicPageKey\(ev\),/);
  // and the card's own control+S is the same call as before, with the box in its place only while held
  // (and the response piped out beside the card in its place while that holds the keys, or while
  // it is out and the keys are still on the card)
  assert.match(cut("const boardShortcutActions = {", "\n};"),
    /responseScroll\(e\)\{\s*responseScrollKey\(e, pipeHeld\(\) \? pipeScrollCard : boardMagicHeld\(\) \? boardMagicScrollCard :\s*pipeScrollTyped\(\) \? pipeScrollTyped : boardResponseCard\);\s*\},/);
  // the phone is not given the page's scroll words, and does not ask for them
  assert.ok(/' scroll '|'scroll '/.test(MagicBox.pageDoc("<p>x</p>", "w", true)));
  assert.ok(!/' key '|' scroll '|'scroll '/.test(MagicBox.pageDoc("<p>x</p>", "w", false)));
  assert.ok(!/' key '|' scroll '|'scroll '/.test(MagicBox.pageDoc("<p>x</p>", "w", false, true)));
  assert.ok(!/pageScroller|magicPageKey/.test(read("m.html")), "the phone's box lays the page out as tall as it is and scrolls the box itself");
});
