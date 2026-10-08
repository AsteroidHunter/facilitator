// The attachment rail on the desktop board: a file added by plus, paste or drop
// stands in the rail of squares over the typing row, as on the phone, instead of
// writing its /uploads/ address into the box. The rail's script and rules are
// shared (card-logic.js, card-tokens.css), so the real script is run here against
// a small stand-in for the page, and the desktop's own send and composer
// functions are cut out of index.html and run beside it. No browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = process.env.RAIL_SOURCE_ROOT || path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(ROOT, name), "utf8");
const tick = (ms = 8) => new Promise(resolve => setTimeout(resolve, ms));

// ---- a stand-in for the parts of the page the rail touches ---------------------
class Classes {
  constructor() { this.set = new Set(); }
  add(...names) { for (const n of names) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, on) { const want = on === undefined ? !this.set.has(name) : !!on; if (want) this.set.add(name); else this.set.delete(name); return want; }
}
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.parent = null; this.style = {}; this.attrs = {};
    this.handlers = {}; this.classList = new Classes(); this.textContent = ""; }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classList.set].join(" "); }
  append(...kids) { for (const kid of kids) { kid.remove(); kid.parent = this; this.children.push(kid); } }
  appendChild(kid) { this.append(kid); return kid; }
  insertBefore(kid, before) { kid.remove(); kid.parent = this; this.children.splice(this.children.indexOf(before), 0, kid); return kid; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === "class") this.className = value; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.handlers[type] || []) fn({ stopPropagation() {}, preventDefault() {} }); }
  set innerHTML(html) {
    this.children = [];
    for (const m of String(html).matchAll(/<circle class="(\w+)"/g)) { const c = new Node("circle"); c.className = m[1]; this.append(c); }
  }
  all(cls, out = []) { for (const c of this.children) { if (c.classList.contains(cls)) out.push(c); c.all(cls, out); } return out; }
  querySelector(sel) { return this.all(sel.slice(1))[0] || null; }
  querySelectorAll(sel) { return this.all(sel.slice(1)); }
  animate() { return { finished: Promise.resolve(), cancel() {} }; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 64, height: 64 }; }
  get offsetHeight() { return 72; }
}
class XHR {
  constructor() { this.upload = {}; XHR.all.push(this); }
  open(method, url) { this.method = method; this.url = url; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; }
  progress(loaded, total) { this.upload.onprogress({ loaded, total, lengthComputable: true }); }
  reply(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.onload(); }
  cut() { this.onerror(); }
}
XHR.all = [];

function page() {
  XHR.all = [];
  const ctx = vm.createContext({
    setTimeout, clearTimeout, Date, Promise, Set, Map, JSON, Math, URL: { createObjectURL: f => "blob:" + f.name, revokeObjectURL() {} },
    crypto: require("node:crypto").webcrypto, XMLHttpRequest: XHR, AbortSignal,
    Image: class extends Node { constructor() { super("img"); } },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: { createElement: tag => new Node(tag), createElementNS: (ns, tag) => new Node(tag),
      addEventListener() {} },
    window: { addEventListener() {} },
    getComputedStyle: () => ({ paddingTop: "8px", paddingBottom: "12px" }),
    ComposeFormat: { focused: () => false },
    els: {},
  });
  vm.runInContext(read("card-markdown.js"), ctx);
  vm.runInContext(read("card-logic.js"), ctx);
  ctx.backoffMs = () => 0;
  return ctx;
}
// a card with only what the rail reads off it
function card(ctx, id = "c1") {
  const el = { ta: { value: "" }, tray: new Node("div"), trayItems: [], trayHold: null, ticks: 0, tick() { this.ticks++; } };
  ctx.els[id] = el;
  return el;
}
const file = (name, size = 3000, type = "") => ({ name, size, type });
const squares = el => el.tray.children.filter(c => c.classList.contains("tsq"));
const OK = name => ({ url: "/uploads/17000-" + name });

// ---- the rail, run for the desktop's card ----------------------------------------
test("a picture and a PDF added to a desktop card stand as squares and upload in turn", async () => {
  const ctx = page(), el = card(ctx);
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png"), file("brief.pdf", 9000, "application/pdf")]);
  assert.ok(el.tray.classList.contains("on"), "the rail stands over the row");
  assert.equal(squares(el).length, 2);
  assert.equal(el.ta.value, "", "nothing is written into the box");
  assert.equal(XHR.all.length, 1, "one file at a time");
  assert.match(XHR.all[0].url, /^\/upload\?name=shot\.png&op=/);
  // the first square wears the ring, the second waits its turn
  assert.deepEqual(el.trayItems.map(it => it.state), ["up", "queued"]);
  XHR.all[0].progress(1000, 4000);
  const arc = el.trayItems[0].arc;
  assert.equal(Number(arc.style.strokeDashoffset).toFixed(2), (65.97 * 0.75).toFixed(2), "the ring follows the bytes");
  XHR.all[0].reply(200, OK("shot.png"));
  assert.deepEqual(el.trayItems.map(it => it.state), ["done", "up"]);
  assert.match(XHR.all[1].url, /^\/upload\?name=brief\.pdf&op=/);
  XHR.all[1].reply(200, OK("brief.pdf"));
  assert.deepEqual(el.trayItems.map(it => it.state), ["done", "done"]);
  assert.equal(el.ta.value, "", "still nothing in the box once they have landed");
});

test("the rail says nothing in words: a square carries its kind, its size and a mark, nothing else", () => {
  const ctx = page(), el = card(ctx);
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png"), file("notes.txt", 10, "text/plain")]);
  const words = [];
  const walk = node => { if (node.textContent) words.push(node.textContent); node.children.forEach(walk); };
  walk(el.tray);
  assert.deepEqual(words.sort(), ["!", "!", "1 KB", "4 KB", "PNG", "TXT"], "a kind, a size and the mark's bang per square");
  assert.ok(el.tray.children.every(c => c.classList.contains("tsq")), "only squares stand in the rail");
});

test("a file the board would refuse wears the mark and is never sent", () => {
  const ctx = page(), el = card(ctx);
  ctx.trayAdd("c1", [file("notes.txt", 10, "text/plain")]);
  assert.equal(el.trayItems[0].state, "refused");
  assert.equal(XHR.all.length, 0);
  assert.ok(squares(el)[0].classList.contains("refused"), "the square wears the red mark's class");
});

test("an upload cut five times wears the mark and waits for a tap, then tries again on the tap", async () => {
  const ctx = page(), el = card(ctx);
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png")]);
  for (let i = 0; i < 5; i++) { await tick(); XHR.all.at(-1).cut(); }
  await tick();
  assert.equal(el.trayItems[0].state, "failed");
  assert.ok(squares(el)[0].classList.contains("failed"));
  const before = XHR.all.length;
  el.trayItems[0].face.fire("click");
  await tick();
  assert.ok(XHR.all.length > before, "a tap starts another round");
});

test("the cross takes a square out and lets its upload go", () => {
  const ctx = page(), el = card(ctx);
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png"), file("brief.pdf", 9000, "application/pdf")]);
  const first = el.trayItems[0];
  first.sq.children.find(c => c.classList.contains("tsqx")).fire("click");
  assert.equal(XHR.all[0].aborted, true);
  assert.deepEqual(el.trayItems.map(it => it.name), ["brief.pdf"]);
});

test("the message carries the uploaded files as the board keeps them, pictures on one line first", () => {
  const ctx = page(), el = card(ctx);
  el.trayItems = [
    { state: "done", kind: "image", url: "/uploads/1-a.png" },
    { state: "done", kind: "document", url: "/uploads/2-b.pdf" },
    { state: "done", kind: "image", url: "/uploads/3-c.jpg" },
    { state: "failed", kind: "image", url: "" },
  ];
  assert.equal(ctx.trayMessage(el, "see these"),
    "/uploads/1-a.png /uploads/3-c.jpg\n\n/uploads/2-b.pdf\n\nsee these");
  assert.equal(ctx.trayMessage(el, ""), "/uploads/1-a.png /uploads/3-c.jpg\n\n/uploads/2-b.pdf");
});

// ---- the desktop's own send, cut out of index.html ---------------------------------
function cut(source, header, end = "\n}\n") {
  const from = source.indexOf(header);
  assert.ok(from >= 0, `index.html must ship ${header}`);
  return source.slice(from, source.indexOf(end, from) + end.length);
}
function desk() {
  const ctx = page(), el = card(ctx), sent = [], calls = [];
  Object.assign(ctx, {
    boxDone: () => false, captureSentView: () => () => false, armSentMotion: () => null,
    sentLaunch: (_el, text, route) => { sent.push({ text, route }); return { landed() {} }; },
    sentTry: async () => "landed", sentLanded() {}, sentFailed() {}, undone() {}, poll() {}, cancelAutoNext() {},
    scheduleDesktopAdvance() {}, clearEnterAgain() {}, renderCarousel() {}, histExit() {},
    hist: null, lastState: {}, boardAdvance() {},
    arrowAgainFor: () => false, askEnterAdvance: () => false, armEnterAgain: () => ({ id: "c1" }), controlEnter: () => false,
  });
  el.send = { disabled: false };
  const source = read("index.html");
  vm.runInContext(cut(source, "function deskMessage(el, typed){"), ctx);
  vm.runInContext(cut(source, "async function doSend(id, opts){"), ctx);
  vm.runInContext(cut(source, "function composerArrow(id){"), ctx);
  vm.runInContext(cut(source, "function composerEnter(e, id){"), ctx);
  const send = ctx.doSend;
  ctx.doSend = (id, opts) => { calls.push(opts); return send(id, opts); };
  return { ctx, el, sent, calls };
}
const landed = async (xhr, name) => { xhr.reply(200, OK(name)); await tick(); };

test("sending words alone is what it always was", async () => {
  const { ctx, el, sent } = desk();
  el.ta.value = "  plain words \n";
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent.map(s => s.text), ["plain words"]);
  assert.equal(sent[0].route, "/send?box=c1");
  assert.equal(el.ta.value, "");
});

test("sending a picture and a PDF with words delivers their /uploads/ lines after the words, and clears the rail", async () => {
  const { ctx, el, sent } = desk();
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png"), file("brief.pdf", 9000, "application/pdf")]);
  await landed(XHR.all[0], "shot.png");
  await landed(XHR.all[1], "brief.pdf");
  el.ta.value = "have a look";
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent.map(s => s.text), ["have a look\n/uploads/17000-shot.png\n/uploads/17000-brief.pdf"]);
  assert.deepEqual(el.trayItems, [], "the files go with the words");
  assert.equal(el.ta.value, "");
});

test("files alone can be sent, with the box empty", async () => {
  const { ctx, el, sent } = desk();
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png")]);
  await landed(XHR.all[0], "shot.png");
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent.map(s => s.text), ["/uploads/17000-shot.png"]);
});

test("a send pressed while a file is still going waits for it, then goes by itself", async () => {
  const { ctx, el, sent, calls } = desk();
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png")]);
  el.ta.value = "on its way";
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent, [], "nothing goes without its file");
  assert.equal(el.ta.value, "on its way", "the words wait in the row");
  assert.ok(el.trayHold, "the send is held");
  await landed(XHR.all[0], "shot.png");
  assert.deepEqual(sent.map(s => s.text), ["on its way\n/uploads/17000-shot.png"]);
  assert.equal(calls.length, 2, "it was asked again by the rail");
  assert.equal(calls[1].advance, false, "and it does not move on to the next card");
});

test("the rail sends the very text the box used to carry once an address was written into it", async () => {
  // the old path is still in card-logic.js (attach): run it, and run the rail, on the same words and files
  const old = page(), box = { value: "have a look", selectionStart: 11, selectionEnd: 11, selectionDirection: "none",
    setSelectionRange() {}, dispatchEvent() {} };
  const names = ["shot.png", "brief.pdf", "second.jpg"];
  Object.assign(old, { uploadAttachment: async f => "/uploads/17000-" + f.name, attachmentNotice() {}, Event: class Event {} });
  await old.attach(names.map(n => file(n, 4000)), box);
  const was = box.value.trim();

  const { ctx, el, sent } = desk();
  ctx.trayAdd("c1", names.map(n => file(n, 4000)));
  for (let i = 0; i < names.length; i++) await landed(XHR.all[i], names[i]);
  el.ta.value = "have a look";
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent.map(s => s.text), [was]);
  assert.equal(was, "have a look\n/uploads/17000-shot.png\n/uploads/17000-brief.pdf\n/uploads/17000-second.jpg");
});

test("a file that did not upload stays in the rail when the rest is sent", async () => {
  const { ctx, el, sent } = desk();
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png"), file("notes.txt", 10, "text/plain")]);
  await landed(XHR.all[0], "shot.png");
  el.ta.value = "words";
  await ctx.doSend("c1", { advance: false });
  assert.deepEqual(sent.map(s => s.text), ["words\n/uploads/17000-shot.png"]);
  assert.deepEqual(el.trayItems.map(it => it.name), ["notes.txt"], "the refused square is not lost");
});

test("the arrow and Enter send files alone, and press nothing with an empty box and rail", async () => {
  const { ctx, el, calls } = desk();
  ctx.composerArrow("c1");
  ctx.composerEnter({ key: "Enter", preventDefault() {} }, "c1");
  assert.equal(calls.length, 0, "nothing to send");
  ctx.trayAdd("c1", [file("shot.png", 4000, "image/png")]);
  await landed(XHR.all[0], "shot.png");
  ctx.composerArrow("c1");
  assert.equal(calls.length, 1);
  ctx.trayAdd("c1", [file("again.png", 4000, "image/png")]);
  await landed(XHR.all[1], "again.png");
  ctx.composerEnter({ key: "Enter", preventDefault() {} }, "c1");
  assert.equal(calls.length, 2);
});

// ---- the page, read as written -----------------------------------------------------
test("the desktop card seats the rail over the row and adds files through it from plus, paste and drop", () => {
  const html = read("index.html");
  assert.ok(html.includes('const tray = h("div", "tray");'));
  assert.ok(html.includes("pendwrap.append(meta, sentwrap, tray, bottombar);"));
  assert.ok(html.includes("wireAttachmentTransfer(ta, files => trayAdd(b.id, files));"), "paste and drop go to the rail");
  const change = html.slice(html.indexOf('clipfile.addEventListener("change"'), html.indexOf("head.addEventListener(\"click\"", html.indexOf('clipfile.addEventListener("change"')));
  assert.match(change, /trayAdd\(b\.id, files\)/, "the plus goes to the rail");
  assert.ok(!/\battach\(files, ta\)/.test(html), "no picker still writes the address into the box");
  assert.ok(!/wireAttachmentTransfer\(ta\);/.test(html), "no drop still writes the address into the box");
  assert.match(html, /tray, trayItems: \[\], trayHold: null/);
  assert.ok(html.includes("trayDrop(els[id]);"), "a card that goes takes its rail with it");
  assert.match(html, /traySendable\(els\[b\.id\]\) \|\| arrowAgainFor\(b\.id\)/, "the send square shows for files alone");
});

test("the rail's script and rules are the shared ones, kept once", () => {
  const logic = read("card-logic.js"), tokens = read("card-tokens.css"), phone = read("m.html"), desk = read("index.html");
  for (const name of ["trayAdd", "trayMessage", "trayTake", "trayDrop", "trayHoldSend", "backoffMs"])
    assert.ok(logic.includes(`function ${name}(`), `card-logic.js ships ${name}`);
  for (const name of ["trayAdd", "traySquare", "trayLeave", "trayDraw", "backoffMs"])
    for (const [where, text] of [["m.html", phone], ["index.html", desk]])
      assert.ok(!text.includes(`function ${name}(`), `${where} no longer carries its own ${name}`);
  assert.ok(!phone.includes("const TRAY_") && !desk.includes("const TRAY_"));
  for (const rule of [".tray{", ".tray.on{", ".tsq{", ".tsqface{", ".tsqring{", ".tsqbang{", ".tsqx{"])
    assert.ok(tokens.includes(rule), `card-tokens.css ships ${rule}`);
  for (const rule of [".tray{", ".tsq{", ".tsqface{", ".tsqx{", ".tsqbang{"])
    for (const [where, text] of [["m.html", phone], ["index.html", desk]])
      assert.ok(!new RegExp("^\\s*" + rule.replace(/[.{]/g, "\\$&"), "m").test(text), `${where} keeps no copy of ${rule}`);
});

test("the rail's rules add no accent, no purple and no text", () => {
  const tokens = read("card-tokens.css");
  const from = tokens.indexOf("/* ---- the files picked for the next message");
  assert.ok(from > 0, "the rail's rules stand under their own heading");
  const rules = tokens.slice(from);
  assert.ok(!/--accent/.test(rules), "no --accent");
  // every literal colour is a warm grey, white or the dark of the card's ink: none has green below both red and blue
  const colours = [...rules.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map(m => {
    const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  }).concat([...rules.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g)].map(m => m.slice(1, 4).map(Number)));
  assert.ok(colours.length >= 4, "the rail's own colours were found");
  for (const [r, g, b] of colours) assert.ok(!(g < r - 8 && g < b - 8), `rgb(${r},${g},${b}) leans purple`);
  assert.ok(!/purple|violet|indigo|lavender|magenta/i.test(rules), "no purple by name");
  const contents = [...rules.matchAll(/(?<![-\w])content\s*:\s*([^;}]*)/g)].map(m => m[1].trim());
  assert.deepEqual(contents, ['""'], "the only generated content is the cross's empty hit area");
});
