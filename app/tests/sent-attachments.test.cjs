// What a sent bubble that has no answer yet shows for its files, with no
// browser and no board: the real card-logic.js and card-markdown.js run in a
// sandbox over a small stand-in dom that keeps each element's tag, classes and
// attributes, and the sheet is read as text. three things are checked, each
// failing on the code before: the bubble lays its pictures and videos over its
// words whichever page sent them, it prints no file name under a player, and a
// file picked on the page shows its picture from the bubble's first draw, the
// send's flying copy included: a picture its own file, a video the frame its
// tray square drew. how it looks on screen is not claimed here; the recordings
// say that. every file and message below is invented.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const DESKTOP = readFileSync(path.join(ROOT, "index.html"), "utf8");
const TOKENS = readFileSync(path.join(ROOT, "card-tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const markdown = require("../card-markdown.js");

const PICTURE = "/uploads/1791398534302337010-garden.jpg";
const SECOND = "/uploads/1791398534302337011-porch.png";
const VIDEO = "/uploads/1791398534302337012-clip.mov";
const WORDS = "Here is the one from this morning";

// ---- the stand-in dom ---------------------------------------------------------
const VOID = new Set(["br", "img", "hr", "input", "source", "wbr"]);
const ENTITIES = { "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };
function textNode(text) {
  const node = { nodeType: 3, textContent: text, parentNode: null,
    remove() { const p = node.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(node), 1); node.parentNode = null; } } };
  return node;
}
function styleOf() {
  const style = {
    setProperty(name, value) { style[name] = String(value); },
    getPropertyValue(name) { return style[name] || ""; },
    removeProperty(name) { delete style[name]; },
  };
  return style;
}
function element(tag) {
  const attrs = new Map(), classes = new Set(), kids = [], listeners = {};
  let markup = "";
  const el = {
    tagName: String(tag).toUpperCase(), nodeType: 1, parentNode: null, dataset: {}, style: styleOf(), childNodes: kids,
    get parentElement() { return el.parentNode; },
    get children() { return kids.filter(k => k.nodeType === 1); },
    get className() { return [...classes].join(" "); },
    set className(value) { classes.clear(); for (const c of String(value).split(/\s+/).filter(Boolean)) classes.add(c); },
    classList: {
      add: (...n) => n.forEach(c => classes.add(c)), remove: (...n) => n.forEach(c => classes.delete(c)),
      contains: c => classes.has(c),
      toggle: (c, on) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    setAttribute(name, value) { if (name === "class") el.className = value; else attrs.set(name, String(value)); },
    getAttribute(name) { return name === "class" ? el.className : attrs.has(name) ? attrs.get(name) : null; },
    hasAttribute: name => attrs.has(name),
    removeAttribute: name => { attrs.delete(name); },
    appendChild(kid) { if (kid.parentNode) kid.remove(); kids.push(kid); kid.parentNode = el; return kid; },
    append: (...added) => added.forEach(kid => el.appendChild(kid)),
    insertBefore(kid, ref) {
      if (kid.parentNode) kid.remove();
      const at = kids.indexOf(ref);
      kids.splice(at < 0 ? kids.length : at, 0, kid);
      kid.parentNode = el;
      return kid;
    },
    remove() { const p = el.parentNode; if (p) { p.childNodes.splice(p.childNodes.indexOf(el), 1); el.parentNode = null; } },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter(f => f !== fn); },
    fire(type) { for (const fn of [...(listeners[type] || [])]) fn({ type, target: el }); },
    listening: type => (listeners[type] || []).length,
    get innerHTML() { return markup; },
    set innerHTML(html) { for (const kid of kids) kid.parentNode = null; kids.length = 0; markup = String(html); build(el, markup); },
    get textContent() { return kids.map(k => k.textContent).join(""); },
    set textContent(text) { kids.length = 0; el.appendChild(textNode(String(text))); },
    querySelectorAll: selector => all(el).filter(node => matches(node, selector)),
    querySelector: selector => all(el).find(node => matches(node, selector)) || null,
    closest(selector) { for (let at = el; at; at = at.parentNode) if (at.nodeType === 1 && matches(at, selector)) return at; return null; },
    cloneNode(deep) {
      const copy = element(tag);
      for (const [name, value] of attrs) copy.setAttribute(name, value);
      copy.className = el.className;
      Object.assign(copy.dataset, el.dataset);
      if (deep) for (const kid of kids) copy.appendChild(kid.nodeType === 3 ? textNode(kid.textContent) : kid.cloneNode(true));
      return copy;
    },
  };
  if (el.tagName === "VIDEO") Object.assign(el, { readyState: 0, currentTime: 0, videoWidth: 0, videoHeight: 0 });
  if (el.tagName === "CANVAS") Object.assign(el, {
    width: 300, height: 150, drawn: [],
    getContext: () => ({ drawImage: (source, x, y, w, h) => el.drawn.push({ source, w, h }) }),
    toBlob: (done, type, quality) => done({ type, quality, width: el.width, height: el.height }),
  });
  return el;
}
function all(node) {
  const out = [];
  for (const kid of node.children) out.push(kid, ...all(kid));
  return out;
}
// tags, classes, an attribute that is present, and a node under another
function matchesOne(node, part) {
  if (part === "*") return true;
  const wanted = [...part.matchAll(/\[([\w-]+)\]/g)].map(m => m[1]);
  const [tag, ...cls] = part.replace(/\[[^\]]*\]/g, "").split(".");
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  return cls.every(c => node.classList.contains(c)) && wanted.every(name => node.getAttribute(name) !== null);
}
function matches(node, selector) {
  return selector.split(",").map(s => s.trim()).some(part => {
    const chain = part.split(/\s+/);
    if (!matchesOne(node, chain.pop())) return false;
    let at = node.parentNode;
    for (let i = chain.length - 1; i >= 0; i--) {
      while (at && !matchesOne(at, chain[i])) at = at.parentNode;
      if (!at) return false;
      at = at.parentNode;
    }
    return true;
  });
}
// the tags of an html string, nested as written, with their attributes, and the
// text between them as text nodes
function build(parent, html) {
  const stack = [parent];
  const tags = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    if (m.index > last) stack.at(-1).appendChild(textNode(html.slice(last, m.index)));
    last = tags.lastIndex;
    const [, closing, tag, attrs, selfClosing] = m;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const node = element(tag);
    for (const a of attrs.matchAll(/([\w-]+)(?:\s*=\s*"([^"]*)")?/g))
      node.setAttribute(a[1], (a[2] || "").replace(/&amp;|&quot;|&#39;|&lt;|&gt;/g, e => ENTITIES[e]));
    stack.at(-1).appendChild(node);
    if (!selfClosing && !VOID.has(tag.toLowerCase())) stack.push(node);
  }
  if (last < html.length) stack.at(-1).appendChild(textNode(html.slice(last)));
}

// ---- the sandbox ------------------------------------------------------------------
// the shipped card-logic.js, and the desktop's own deskMessage beside it. object
// urls are numbered and every one let go is kept, and a picture decodes at once,
// 1600 by 1200
function sandbox() {
  const body = element("body");
  const urls = { made: 0, revoked: [] };
  const context = vm.createContext({
    console, Promise, Date, AbortSignal, crypto: require("node:crypto").webcrypto,
    CardMarkdown: markdown,
    document: { body, createElement: element, querySelectorAll: s => body.querySelectorAll(s), querySelector: s => body.querySelector(s) },
    URL: { createObjectURL: () => "blob:invented-" + (++urls.made), revokeObjectURL: url => urls.revoked.push(url) },
    Image: function Image() {
      const img = element("img");
      img.naturalWidth = 0;
      img.decode = () => { Object.assign(img, { naturalWidth: 1600, naturalHeight: 1200 }); return Promise.resolve(); };
      return img;
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => 0, matchMedia: () => ({ matches: false }),
  });
  vm.runInContext(LOGIC, context, { filename: "card-logic.js" });
  const at = DESKTOP.indexOf("function deskMessage(");
  assert.ok(at >= 0, "the desktop's message no longer has its own function");
  vm.runInContext(DESKTOP.slice(at, DESKTOP.indexOf("\n}\n", at) + 2), context, { filename: "index.html" });
  context.read = name => vm.runInContext(name, context);
  return { context, body, urls };
}
// a panel the way answeredPanel builds one, sent (a bubble at the card's foot)
// or not (the panel over the answer), standing in the page
function panelIn(s, sent) {
  const panel = element("div");
  panel.className = sent ? "answered sent" : "answered kept";
  const clip = element("div"); clip.className = "answclip";
  const stack = element("div"); stack.className = "answstack";
  clip.appendChild(stack); panel.appendChild(clip); s.body.appendChild(panel);
  return panel;
}
function draw(s, sent, text) {
  const panel = panelIn(s, sent);
  s.context.stackAnswered(panel, [{ text }]);
  return panel;
}
// what the panel's message shows, in the order it stands: picture, video and
// words, each run of one kind said once. a file's name is not words
function kinds(panel) {
  const out = [];
  const walk = node => {
    for (const kid of node.childNodes) {
      if (kid.nodeType === 3) {
        if (kid.textContent.trim() && !(kid.parentNode && kid.parentNode.closest(".attachment-name"))) out.push("words");
      } else if (kid.tagName === "IMG") out.push("picture");
      else if (kid.tagName === "VIDEO") out.push("video");
      else walk(kid);
    }
  };
  walk(panel.querySelector(".answmsg"));
  return out.filter((kind, i) => kind !== out[i - 1]);
}
const done = (...urls) => ({ trayItems: urls.map(url => ({ state: "done", url, kind: /\.(jpg|png)$/.test(url) ? "image" : "video" })) });

// ---- 1. one order for words and files ----------------------------------------------------
test("a sent bubble lays a picture and a video over the words, whichever page sent them", () => {
  const s = sandbox();
  for (const [file, kind] of [[PICTURE, "picture"], [VIDEO, "video"]]) {
    const mac = s.context.deskMessage(done(file), WORDS);
    const phone = s.context.trayMessage(done(file), WORDS);
    assert.equal(mac, WORDS + "\n" + file, "the desktop's message is not what it always sent");
    for (const [page, text] of [["the Mac", mac], ["the phone", phone]]) {
      const bubble = draw(s, true, text);
      assert.deepEqual(kinds(bubble), [kind, "words"], `${page}: a sent ${kind} does not stand over the words`);
      // what the message holds is what was sent, so the board and the bubble
      // still match it word for word
      assert.equal(bubble.querySelector(".answmsg").dataset.text, text, `${page}: the bubble's message is not the words sent`);
    }
    // the panel over the answer draws a message as it was sent: its look is not changed
    assert.deepEqual(kinds(draw(s, false, mac)), ["words", kind], `the panel over the answer laid the Mac's ${kind} out again`);
  }
});

test("the Mac's pictures stand as the card's grid, then the video, then the words, as the phone's do", () => {
  const s = sandbox();
  const mac = s.context.deskMessage(done(PICTURE, SECOND, VIDEO), WORDS);
  const phone = s.context.trayMessage(done(PICTURE, SECOND, VIDEO), WORDS);
  assert.equal(s.context.sentOrder(mac), phone, "the Mac's message is not laid out as the phone sends one");
  assert.equal(s.context.sentOrder(phone), phone, "the phone's message was laid out again");
  const bubble = draw(s, true, mac);
  assert.deepEqual(kinds(bubble), ["picture", "video", "words"]);
  assert.match(bubble.querySelector(".answmsg").innerHTML, /<span class="shotgrid" data-n="2">/, "the two pictures are not the card's grid");
});

test("only a line of nothing but uploaded files moves; words, links and code stay where they are", () => {
  const { context } = sandbox();
  const keep = [
    "Just words, no file at all",
    "See " + PICTURE + " for the garden",            // an address inside a sentence
    "![the garden](" + PICTURE + ")\n" + WORDS,       // a picture written as markdown
    "```\n" + PICTURE + "\n```\n" + WORDS,             // an address in a fenced block
    WORDS + "\n/uploads/\nthe end",                   // not a file's address
  ];
  for (const text of keep) assert.equal(context.sentOrder(text), text, "moved: " + JSON.stringify(text));
  // the words keep their own lines, indents and blank lines; only the blank
  // lines left at their ends by the files going are taken off
  const words = "First line\n\n    an indented line\nlast line";
  assert.equal(context.sentOrder(words + "\n" + VIDEO + "\n"), VIDEO + "\n\n" + words);
  assert.equal(context.sentOrder(VIDEO), VIDEO);
});

// ---- 2. no file name in a sent bubble ----------------------------------------------------
test("a sent bubble prints no name under a player; the panel over the answer and a document keep theirs", () => {
  // the sheet's rules that take a name away, read as text
  const hiding = [...TOKENS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector, body]) => /attachment-name/.test(selector) && /display\s*:\s*none/.test(body))
    .flatMap(([, selector]) => selector.split(",").map(one => one.trim()));
  assert.ok(hiding.length, "nothing in the sheet takes a file's name away");
  for (const selector of hiding) assert.match(selector, /^\.answered\.sent /, `a name is taken away outside a sent bubble: ${selector}`);
  const hidden = node => hiding.some(selector => matches(node, selector));
  const s = sandbox();
  const audio = "/uploads/1791398534302337013-memo.wav", pdf = "/uploads/1791398534302337014-report.pdf";
  for (const [file, kind] of [[VIDEO, "video"], [audio, "audio"], [pdf, "document"]]) {
    const text = WORDS + "\n" + file;
    const bubble = draw(s, true, text), panel = draw(s, false, text);
    const name = bubble.querySelector(".attachment-name");
    assert.ok(name, `${kind}: the renderer drew no name to take away`);
    if (kind === "document") assert.equal(hidden(name), false, "a document's name, its link, is taken away");
    else assert.equal(hidden(name), true, `${kind}: the sent bubble still prints the file's name`);
    assert.equal(hidden(panel.querySelector(".attachment-name")), false, `${kind}: the panel over the answer lost the name`);
  }
});

// ---- 3. what the bubble shows of a file picked on the page ---------------------------------
// a picture or a video picked into the tray, as trayAdd makes one, and the
// square's own picture or player
function picked(s, kind = "video") {
  const sq = element("div"), face = element("div"), veil = element("span"), arc = element("circle");
  face.appendChild(veil);
  const it = { key: "op-1", file: {}, name: kind === "video" ? "clip.mov" : "garden.jpg", kind, ext: "X", total: 5587872,
    sent: 0, tries: 1, measured: false, urls: [], state: "up", sq, face, veil, arc };
  s.context.trayPreview(it);
  const pic = face.querySelector(kind === "video" ? "video" : "img");
  assert.ok(pic, "the square has no " + (kind === "video" ? "player" : "picture"));
  return { it, pic, el: { trayItems: [it], tick() {}, trayHold: null } };
}
// the square has drawn its picture: a video's player its frame, a picture its file
function drawnSquare({ pic, it }, width = 1080, height = 1920) {
  if (it.kind === "video") { Object.assign(pic, { videoWidth: width, videoHeight: height, readyState: 2 }); pic.fire("loadeddata"); }
  else pic.onload();
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("what the square drew is kept once it has drawn it, out of the urls the tray lets go", async () => {
  const s = sandbox();
  const video = picked(s, "video");
  assert.match(video.pic.src, new RegExp("#t=" + s.context.read("TRAY_STILL_AT") + "$"), "the square's player is not sent to the still's frame");
  drawnSquare(video);
  const picture = picked(s, "image");
  drawnSquare(picture);
  await settle();
  assert.ok(video.it.still, "no still was made from the square's frame");
  assert.deepEqual([video.it.still.width, video.it.still.height], [1080, 1920], "the video's still is not in the video's shape");
  assert.ok(picture.it.still, "nothing was kept of the picture's file");
  assert.deepEqual([picture.it.still.width, picture.it.still.height], [1600, 1200], "the picture is not kept at its own size");
  for (const { it } of [video, picture]) {
    assert.ok(!it.urls.includes(it.still.url), it.kind + ": what was kept is among the urls the tray lets go when the square leaves");
    assert.ok(it.sq.classList.contains("drawn"), it.kind + ": the square no longer wears its picture");
  }
});

test("a file picked on the page shows its picture from the bubble's first draw, and so does the flying copy", async () => {
  const s = sandbox();
  const video = picked(s, "video"), picture = picked(s, "image");
  drawnSquare(video); drawnSquare(picture);
  await settle();
  s.context.trayLanded(video.el, video.it, 200, { url: VIDEO });
  s.context.trayLanded(picture.el, picture.it, 200, { url: PICTURE });
  // the sends: each bubble is drawn in the press's own task, before any frame
  const player = draw(s, true, s.context.trayMessage(video.el, WORDS)).querySelector("video");
  assert.equal(player.getAttribute("poster"), video.it.still.url, "the bubble's player has nothing to show until the board sends the file");
  assert.equal(player.style.aspectRatio, "1080 / 1920", "the bubble's player does not stand in the video's shape");
  const shot = draw(s, true, s.context.trayMessage(picture.el, WORDS)).querySelector("img");
  assert.equal(shot.getAttribute("srcset"), picture.it.still.url + " 1x", "the bubble's picture waits for the board's copy");
  assert.equal(shot.getAttribute("src"), PICTURE, "the picture's address is no longer the board's, which the link menu reads");
  for (const [node, attribute] of [[player, "poster"], [shot, "srcset"]]) {
    const copy = s.context.sentSnapshot(node.closest(".answered"));
    assert.equal(copy.querySelector(node.tagName.toLowerCase()).getAttribute(attribute), node.getAttribute(attribute),
      "the flight's copy flies with the " + node.tagName.toLowerCase() + "'s place empty");
  }
  // the panel over the answer is drawn as it always was
  assert.equal(draw(s, false, VIDEO).querySelector("video").getAttribute("poster"), null, "the panel over the answer was given the still");
  assert.equal(draw(s, false, PICTURE).querySelector("img").getAttribute("srcset"), null, "the panel over the answer was given the file");
});

test("a send pressed before the square had its picture wears it the moment it is kept", async () => {
  const s = sandbox();
  const video = picked(s, "video"), picture = picked(s, "image");
  s.context.trayLanded(video.el, video.it, 200, { url: VIDEO });
  s.context.trayLanded(picture.el, picture.it, 200, { url: PICTURE });
  const player = draw(s, true, s.context.trayMessage(video.el, WORDS)).querySelector("video");
  const shot = draw(s, true, s.context.trayMessage(picture.el, WORDS)).querySelector("img");
  assert.equal(player.getAttribute("poster"), null);
  assert.equal(shot.getAttribute("srcset"), null);
  drawnSquare(video, 1920, 1080); drawnSquare(picture);
  await settle();
  assert.equal(player.getAttribute("poster"), video.it.still.url, "the standing bubble's player did not take the still");
  assert.equal(player.style.aspectRatio, "1920 / 1080");
  assert.equal(shot.getAttribute("srcset"), picture.it.still.url + " 1x", "the standing bubble's picture did not take the file");
});

test("a sent player with no still on this page is sent to the square's frame once it knows the file, so WebKit draws one", () => {
  const s = sandbox();
  const at = s.context.read("TRAY_STILL_AT");
  // a bubble drawn after a reload, or sent from the other page: no still here
  const video = draw(s, true, VIDEO + "\n\n" + WORDS).querySelector("video");
  assert.equal(video.getAttribute("poster"), null);
  Object.assign(video, { readyState: 1 });
  video.fire("loadedmetadata");
  assert.equal(video.currentTime, at, "a player that has only the file's metadata is left with nothing to draw");
  // one that already has its frame is left where it is
  const ready = draw(s, true, VIDEO).querySelector("video");
  Object.assign(ready, { readyState: 2 });
  ready.fire("loadedmetadata");
  assert.equal(ready.currentTime, 0);
  // and the panel over the answer is not touched
  const panel = draw(s, false, VIDEO).querySelector("video");
  assert.equal(panel.listening("loadedmetadata"), 0, "the panel over the answer was changed");
});
