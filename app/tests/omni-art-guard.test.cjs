// A picture on a ticket, on an Omni card or in a card's words that the board
// could not hand over is not left as the browser's broken-image box for good.
// Run under node with DOM stubs, no browser: the stub document keeps the
// listeners watchPictures puts on it so an error, a load and a wake can be sent
// by hand, and the timers are held so the retries can be fired one by one.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const noop = () => {};

function build(){
  const timers = [];
  const heard = { document: {}, window: {} };
  const listen = side => (type, fn) => { (heard[side][type] = heard[side][type] || []).push(fn); };
  const el = tag => {
    const node = { tagName: String(tag || "div").toUpperCase(), style: {}, className: "", children: [],
      textContent: "", dataset: {}, parentNode: null, attributes: {}, isConnected: true, inWords: false };
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
    node.appendChild = child => { child.parentNode = node; node.children.push(child); return child; };
    node.insertBefore = (child, before) => {
      child.parentNode = node;
      const index = node.children.indexOf(before);
      if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      return child;
    };
    node.remove = () => { node.isConnected = false; };
    node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
    // src counts how many times it has been set: each one is a request to the board
    node.sets = 0;
    Object.defineProperty(node, "src", { get: () => node.address, set: value => { node.address = value; node.sets++; } });
    node.hasAttribute = name => name === "src" ? node.address !== undefined : name in node.attributes;
    node.getAttribute = name => name === "src" ? (node.address === undefined ? null : node.address) : (node.attributes[name] ?? null);
    node.removeAttribute = name => { if (name === "src") node.address = undefined; else delete node.attributes[name]; };
    node.addEventListener = noop;
    // just the three selectors the watcher asks with
    node.matches = selector => selector.split(",").some(part => {
      part = part.trim();
      if (part === ".cardmd img[src]") return node.tagName === "IMG" && node.inWords && node.address !== undefined;
      const cls = /^img\.([\w-]+)$/.exec(part);
      return !!cls && node.tagName === "IMG" && names().includes(cls[1]);
    });
    node.querySelector = selector => selector.startsWith(".")
      ? node.children.find(child => child.classList && child.classList.contains(selector.slice(1))) || null : null;
    node.querySelectorAll = () => [];
    return node;
  };
  const sandbox = {
    document: { createElement: el, getElementById: () => null, querySelector: () => null,
      querySelectorAll: () => [], addEventListener: listen("document"), hidden: false, body: el() },
    setInterval: noop, clearInterval: noop, clearTimeout: noop,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    requestAnimationFrame: noop, console, localStorage: { getItem: () => null, setItem: noop },
    navigator: {}, location: {}, addEventListener: listen("window"),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8"), sandbox);
  const send = (side, type, event = {}) => { for (const fn of heard[side][type] || []) fn(event); };
  // the elements of a page: a ticket row's art, an Omni card's art, a picture in a reply
  const art = title => {
    const row = el("div"), inner = el("div");
    sandbox.appendOmniRowArt(row, inner, { title });
    return inner.children[0];
  };
  const reply = src => { const image = el("img"); image.className = "shot"; image.inWords = true; image.src = src; return image; };
  const fail = image => send("document", "error", { target: image });
  const arrive = image => send("document", "load", { target: image });
  const wake = () => send("document", "visibilitychange");
  return { sandbox, el, timers, send, art, reply, fail, arrive, wake };
}

function watched(){ const ctx = build(); ctx.sandbox.watchPictures(); return ctx; }

test("a ticket's art that fails to load is hidden, not left as a broken box", () => {
  const ctx = watched();
  const art = ctx.art("Omni Ticket #4");
  assert.equal(art.src, "/assets/ticket-1.webp", "ticket 4 takes the first artwork");
  assert.equal(art.style.display, undefined, "art still on its way is left alone");
  ctx.fail(art);
  assert.equal(art.style.display, "none");
  ctx.arrive(art);
  assert.equal(art.style.display, "");
});

test("the Omni card's own art is hidden the same way", () => {
  const ctx = watched();
  const box = ctx.el("article"), head = ctx.el("div");
  const number = ctx.el("span"), titleEl = ctx.el("span");
  head.appendChild(number); head.appendChild(titleEl);
  ctx.sandbox.syncOmniCard({ box, titleEl }, { title: "Omni Ticket #4" });
  const art = head.children[1];
  assert.equal(art.className, "omni-card-art");
  ctx.fail(art);
  assert.equal(art.style.display, "none");
  ctx.arrive(art);
  assert.equal(art.style.display, "");
});

test("a picture in a reply stays where it is in the words, and is asked for again", () => {
  const ctx = watched();
  const image = ctx.reply("/uploads/1-a.png");
  const once = image.sets;
  ctx.fail(image);
  assert.equal(image.style.display, undefined, "never moved out of the text");
  assert.deepEqual(ctx.timers.map(timer => timer.ms), [3000]);
  ctx.timers.shift().fn();
  assert.equal(image.sets, once + 1, "asked for again");
  assert.equal(image.src, "/uploads/1-a.png", "the same address");
  ctx.arrive(image);
  assert.equal(ctx.timers.length, 0);
});

test("a picture is asked for three times, later each time, and then left", () => {
  const ctx = watched();
  const image = ctx.reply("/uploads/1-a.png");
  const waits = [];
  for (let n = 0; n < 5; n++){
    ctx.fail(image);
    const next = ctx.timers.shift();
    if (!next) break;
    waits.push(next.ms);
    next.fn();
  }
  assert.deepEqual(waits, [3000, 10000, 30000]);
  assert.equal(ctx.timers.length, 0);
});

test("a load gives the picture its asks back", () => {
  const ctx = watched();
  const image = ctx.reply("/uploads/1-a.png");
  ctx.fail(image); ctx.timers.shift().fn(); ctx.arrive(image);
  ctx.fail(image);
  assert.deepEqual(ctx.timers.map(timer => timer.ms), [3000]);
});

test("a picture that is not one of the board's is left alone", () => {
  const ctx = watched();
  const stray = ctx.el("img"); stray.src = "/elsewhere.png";
  ctx.fail(stray);
  assert.equal(stray.style.display, undefined);
  assert.equal(ctx.timers.length, 0);
  ctx.fail(ctx.el("div"));
  assert.equal(ctx.timers.length, 0);
});

test("the app coming back, or the phone coming online, asks again at once, even after the asks ran out", () => {
  for (const [side, type] of [["document", "visibilitychange"], ["window", "pageshow"], ["window", "online"]]){
    const ctx = watched();
    const image = ctx.reply("/uploads/1-a.png");
    for (let n = 0; n < 4; n++){ ctx.fail(image); const next = ctx.timers.shift(); if (next) next.fn(); }
    const before = image.sets;
    ctx.send(side, type);
    assert.equal(image.sets, before + 1, `${type} asked for it at once`);
    assert.equal(image.src, "/uploads/1-a.png");
    assert.equal(ctx.timers.length, 0, `${type} waited for nothing`);
    ctx.fail(image);
    assert.deepEqual(ctx.timers.map(timer => timer.ms), [3000], `${type} gave the asks back`);
  }
});

test("a picture that has loaded is not asked for when the app comes back", () => {
  const ctx = watched();
  const image = ctx.reply("/uploads/1-a.png");
  ctx.fail(image); ctx.timers.shift().fn(); ctx.arrive(image);
  const before = image.sets;
  ctx.wake();
  assert.equal(image.sets, before);
});

test("the app going to the back asks for nothing", () => {
  const ctx = watched();
  const image = ctx.reply("/uploads/1-a.png");
  ctx.fail(image); ctx.timers.shift();
  const before = image.sets;
  ctx.sandbox.document.hidden = true;
  ctx.wake();
  assert.equal(image.sets, before);
});

test("a picture whose row or reply has gone, or that shows its own file by srcset, is not asked for", () => {
  const ctx = watched();
  const gone = ctx.reply("/uploads/1-a.png");
  ctx.fail(gone);
  gone.remove();
  const goneSets = gone.sets;
  ctx.timers.shift().fn();
  ctx.wake();
  assert.equal(gone.sets, goneSets);
  const worn = ctx.reply("/uploads/2-b.png");
  worn.setAttribute("srcset", "blob:x 1x");
  const wornSets = worn.sets;
  ctx.fail(worn);
  ctx.timers.shift().fn();
  assert.equal(worn.sets, wornSets);
});

test("the pages start the watcher, and the typed page guards its own Omni art", () => {
  for (const name of ["m.html", "index.html"]){
    const html = fs.readFileSync(path.join(ROOT, name), "utf8");
    assert.ok(html.indexOf("<script>watchPictures();</script>") > html.indexOf("<script>installCardPageGuard();</script>"), name);
    assert.ok(html.indexOf("<script>watchPictures();</script>") < html.indexOf("</head>"), name);
  }
  const page = fs.readFileSync(path.join(ROOT, "page.html"), "utf8");
  assert.match(page, /function omniArt\(info, cls\)\{\s*const image = h\("img", cls\);\s*omniArtGuard\(image\);/);
});
