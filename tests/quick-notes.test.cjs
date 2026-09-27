// quick notes against a real board, with no browser. a temporary copy of the
// server on free ports answers the note routes (made, listed, saved, attached,
// detached, deleted, and all still there after a restart); the session in
// card-logic.js saves as the owner types against it; and index.html's own
// quick note wiring (the corner, the overlay, the card chip and the board's
// keys) is lifted out of the page and driven through a small DOM. last, the
// log and the transcript are read back to prove no note's words reached either.
// every card and every note below is invented
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { spawn } = require("node:child_process");
const { copyFile, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { copyBridgeFiles, freePortPair } = require("./fixture-auth.cjs");

const ROOT = path.resolve(__dirname, "..");
const LOGIC = fs.readFileSync(path.join(ROOT, "card-logic.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const TOKENS = fs.readFileSync(path.join(ROOT, "card-tokens.css"), "utf8");
// words typed into notes below, every one of which must stay out of the log
const WORDS = [];
const words = text => { WORDS.push(text); return text; };

let child, fixtureDir, logs, origin;
let cardA, cardB;   // two cards made the way the board makes them

const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, init){
  const response = await fetch(origin + route, init);
  return { status: response.status, body: await response.json() };
}
const post = (route, body) => api(route, { method: "POST", body });
const board = async () => (await fetch(origin + "/state")).json();
const listed = async () => (await api("/quicknotes")).body.notes;
const noteOnBoard = async id => (await listed()).find(n => n.id === id);
const persisted = async () => JSON.parse(await readFile(path.join(fixtureDir, "state.json"), "utf8"));
const figure = id => id.replace(/^m/, "");

async function startServer(){
  child = spawn("python3", [path.join(fixtureDir, "server.py")], {
    cwd: fixtureDir,
    env: { ...process.env, FACILITATOR_TEST_PORT: String(new URL(origin).port), FACILITATOR_LOG_DIR: logs },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline){
    if (child.exitCode !== null) throw new Error(`fixture server exited:\n${output}`);
    try { if ((await fetch(origin + "/state")).ok) return; } catch {}
    await wait();
  }
  throw new Error(`fixture server did not start:\n${output}`);
}
async function stopServer(){
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise(resolve => child.once("exit", resolve));
}

before(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "facilitator-quicknotes-"));
  logs = path.join(fixtureDir, "logs");
  origin = `http://127.0.0.1:${await freePortPair()}`;
  const source = await readFile(path.join(ROOT, "server.py"), "utf8");
  const patched = source.replace("PORT = 8877", "PORT = int(os.environ['FACILITATOR_TEST_PORT'])");
  assert.notEqual(patched, source, "test server port was not patched");
  await writeFile(path.join(fixtureDir, "server.py"), patched);
  copyBridgeFiles(fixtureDir);
  await copyFile(path.join(ROOT, "m-manifest.json"), path.join(fixtureDir, "m-manifest.json"));
  await writeFile(path.join(fixtureDir, "seed.json"), JSON.stringify({
    title: "Kettle Drum",
    items: [{ id: "0", bucket: "meta", title: "Standing note for the tool lane", owner: "facilitator" }],
  }));
  await startServer();
  cardA = (await post("/create?owner=facilitator", "Rope ladder, second rung")).body.id;
  cardB = (await post("/create?owner=facilitator", "Lantern shed roof")).body.id;
  assert.match(cardA, /^m\d+$/);
  assert.match(cardB, /^m\d+$/);
});

after(async () => {
  await stopServer();
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

// ---- the routes ------------------------------------------------------------------

test("a board from before quick notes starts with none and its counter at one", async () => {
  const saved = await persisted();
  assert.deepEqual(saved.quicknotes, []);
  assert.equal(saved.next_qnid, 1);
  assert.deepEqual((await api("/quicknotes")).body.notes, []);
  assert.deepEqual((await board()).quicknotes, []);
});

test("a note is made as typed and listed, and /state carries it without its words", async () => {
  const text = words("  first thing: buy rope for the ladder\n\nthen the drum  \n");
  const made = await post("/quicknote/new", text);
  assert.equal(made.status, 200);
  assert.equal(made.body.ok, true);
  const note = made.body.note;
  assert.equal(note.id, "qn1");
  assert.equal(note.text, text, "the note was not kept exactly as typed");
  assert.equal(note.card, null, "a note made with no card is attached to one");
  assert.equal(note.created, note.updated);
  assert.equal(typeof made.body.rev, "number");
  assert.deepEqual(await noteOnBoard("qn1"), note);
  const reading = await board();
  assert.deepEqual(reading.quicknotes, [{ id: "qn1", card: null, created: note.created, updated: note.updated }]);
  assert.ok(!JSON.stringify(reading).includes("buy rope"), "/state carried a note's words");
});

test("saving new words moves updated; the same words again save nothing", async () => {
  const before = await noteOnBoard("qn1");
  const rev = (await board()).rev;
  const same = await post("/quicknote/save?id=qn1", before.text);
  assert.equal(same.status, 200);
  assert.equal((await board()).rev, rev, "saving the same words moved the board's revision");
  await wait(20);
  const text = words("buy rope, and nails");
  const saved = await post("/quicknote/save?id=qn1", text);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.note.text, text);
  assert.ok(saved.body.note.updated > before.updated, "updated did not move");
  assert.equal(saved.body.note.created, before.created, "created moved on a save");
  assert.ok(saved.body.rev > rev);
  for (const route of ["/quicknote/save?id=qn999", "/quicknote/save?id=", "/quicknote/save"]){
    const refused = await post(route, "stray words");
    assert.equal(refused.status, 400, `${route} was accepted`);
    assert.deepEqual(refused.body, { error: "unknown note" });
  }
  assert.equal((await noteOnBoard("qn1")).text, text, "a refused save changed the note");
});

test("a note attaches to a card, detaches, and an unknown card or note changes nothing", async () => {
  const attached = await post(`/quicknote/attach?id=qn1&card=${cardA}`);
  assert.equal(attached.status, 200);
  assert.equal(attached.body.note.card, cardA);
  assert.equal((await board()).quicknotes.find(n => n.id === "qn1").card, cardA);
  const unknownCard = await post("/quicknote/attach?id=qn1&card=m99999");
  assert.equal(unknownCard.status, 400);
  assert.deepEqual(unknownCard.body, { error: "unknown card" });
  assert.equal((await noteOnBoard("qn1")).card, cardA, "a refused attach moved the note");
  const unknownNote = await post(`/quicknote/attach?id=qn999&card=${cardA}`);
  assert.equal(unknownNote.status, 400);
  assert.deepEqual(unknownNote.body, { error: "unknown note" });
  const moved = await post(`/quicknote/attach?id=qn1&card=${cardB}`);
  assert.equal(moved.body.note.card, cardB);
  const detached = await post("/quicknote/attach?id=qn1");
  assert.equal(detached.status, 200);
  assert.equal(detached.body.note.card, null);
  assert.equal((await noteOnBoard("qn1")).card, null);
  const blank = await post(`/quicknote/attach?id=qn1&card=${cardA}`);
  assert.equal(blank.body.note.card, cardA);
  assert.equal((await post("/quicknote/attach?id=qn1&card=")).body.note.card, null, "a blank card did not detach");
});

test("a note can be made already attached, but never to a card the board does not have", async () => {
  const count = (await listed()).length;
  const refused = await post("/quicknote/new?card=m99999", words("never stored"));
  assert.equal(refused.status, 400);
  assert.deepEqual(refused.body, { error: "unknown card" });
  assert.equal((await listed()).length, count, "a refused note was stored");
  const made = await post(`/quicknote/new?card=${cardB}`, words("shed roof leaks at the north corner"));
  assert.equal(made.status, 200);
  assert.equal(made.body.note.id, "qn2", "a refused make used up an id");
  assert.equal(made.body.note.card, cardB);
});

test("a deleted note is gone for good and its id is never handed out again", async () => {
  const made = (await post("/quicknote/new", words("a note that will go"))).body.note;
  const gone = await post(`/quicknote/del?id=${made.id}`);
  assert.equal(gone.status, 200);
  assert.deepEqual({ ok: gone.body.ok, id: gone.body.id }, { ok: true, id: made.id });
  assert.equal(await noteOnBoard(made.id), undefined);
  const again = await post(`/quicknote/del?id=${made.id}`);
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, { error: "unknown note" });
  const next = (await post("/quicknote/new", words("the next one"))).body.note;
  assert.notEqual(next.id, made.id, "a deleted note's id came back");
  assert.ok(Number(next.id.slice(2)) > Number(made.id.slice(2)));
  assert.equal((await post(`/quicknote/del?id=${next.id}`)).status, 200);
});

test("a card taken off the board leaves its notes standing alone", async () => {
  const empty = (await post("/create?owner=facilitator", "A card nobody wrote in")).body.id;
  const note = (await post(`/quicknote/new?card=${empty}`, words("on the empty card"))).body.note;
  assert.equal(note.card, empty);
  const closed = await post(`/close?box=${empty}`);
  assert.equal(closed.body.action, "deleted", "the empty card was not removed");
  assert.equal((await noteOnBoard(note.id)).card, null, "the note still names a card the board no longer has");
  assert.equal((await post(`/quicknote/del?id=${note.id}`)).status, 200);
});

test("the notes, their cards and the id counter all outlive a restart", async () => {
  const before = await listed();
  assert.ok(before.length >= 2);
  await stopServer();
  await startServer();
  assert.deepEqual(await listed(), before, "the notes changed across the restart");
  assert.deepEqual((await board()).quicknotes.map(n => [n.id, n.card]), before.map(n => [n.id, n.card]));
  const next = (await post("/quicknote/new", words("after the restart"))).body.note;
  const highest = Math.max(...before.map(n => Number(n.id.slice(2))));
  assert.ok(Number(next.id.slice(2)) > highest, "the counter went back after the restart");
  assert.equal((await post(`/quicknote/del?id=${next.id}`)).status, 200);
});

// ---- the session, as a page runs it ----------------------------------------------

function storage(map = new Map()){
  return { map, getItem: k => (map.has(k) ? map.get(k) : null),
           setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}
// card-logic.js in a realm of its own, the way a page loads it. its fetch is
// the board's, unless a test cuts the line
function logicRealm(extra = {}){
  const line = { down: false };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: fn => setTimeout(fn, 0),
    localStorage: storage(), navigator: {}, location: {},
    document: { createElement: () => ({}), getElementById: () => null, querySelector: () => null,
                querySelectorAll: () => [], addEventListener: () => {}, body: {} },
    fetch: (url, init) => line.down ? Promise.reject(new TypeError("failed to fetch")) : fetch(origin + url, init),
    ...extra,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(LOGIC, sandbox, { filename: "card-logic.js" });
  return { ctx: sandbox, line };
}
async function newSession(realm, store){
  const boxes = (await board()).boxes;
  return realm.ctx.quickNoteSession({
    fetch: realm.ctx.fetch, storage: store || realm.ctx.localStorage, boxes: () => boxes,
    schedule: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id),
  });
}

test("nothing typed is never stored, and a pause in the typing saves the note", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  const count = (await listed()).length;
  s.input("   \n  ");
  await s.flush();
  assert.equal(s.id, null);
  assert.equal((await listed()).length, count, "a blank note was stored");
  const text = words("call about the ladder rungs");
  s.input(text.slice(0, 10));
  s.input(text);
  await wait(900);   // the save waits for a 600ms pause; nothing flushes it here
  await s.flush();
  assert.match(String(s.id), /^qn\d+$/, "the pause did not make the note");
  assert.equal((await noteOnBoard(s.id)).text, text);
  assert.equal(s.status, "saved");
  assert.equal(realm.ctx.localStorage.getItem("quicknote.current"), s.id);
  assert.equal((await listed()).length, count + 1, "typing made more than one note");
  await s.remove();
});

test("typing c, card or card and a space with a figure attaches the note, with a confirmation", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  s.input(words("check the rope c" + figure(cardA)));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, cardA);
  assert.equal(s.card, cardA);
  assert.equal(s.notice.kind, "attached");
  assert.equal(realm.ctx.quickNoteNoticeText(s.notice, (await board()).boxes), "attached to card " + figure(cardA));
  // a figure no card carries says so and moves nothing
  s.input(words("check the rope card99999"));
  await s.flush();
  assert.equal(s.notice.kind, "missing");
  assert.equal(realm.ctx.quickNoteNoticeText(s.notice, []), "no card 99999 on the board");
  assert.equal((await noteOnBoard(s.id)).card, cardA);
  // naming the other card moves it there
  s.input(words("check the roof card " + figure(cardB)));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, cardB);
  // and deleting the reference that attached it lets it go
  s.input(words("check the roof"));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, null);
  assert.equal(s.notice.kind, "detached");
  // a figure inside a word is never a reference
  s.input(words("check the roofc" + figure(cardA) + " and abc" + figure(cardB)));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, null, "a figure inside a word attached the note");
  await s.remove();
});

test("a note detached by hand stays detached while its words still name the card", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  s.input(words("roof tiles, card" + figure(cardB)));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, cardB);
  await s.detach();
  assert.equal((await noteOnBoard(s.id)).card, null);
  s.input(words("roof tiles, card" + figure(cardB) + ", and the gutter"));
  await s.flush();
  assert.equal((await noteOnBoard(s.id)).card, null, "the words took the note back after a hand detach");
  await s.remove();
});

test("opening again returns to the note being written, in this page and after a reload", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  const text = words("the note being written");
  s.input(text);
  await s.close();
  const id = s.id;
  assert.ok(id);
  await s.open();
  assert.equal(s.id, id);
  assert.equal(s.text, text);
  // a reload: a new realm holding only what the browser kept
  const reloaded = logicRealm();
  const again = await newSession(reloaded, storage(new Map(realm.ctx.localStorage.map)));
  await again.open();
  assert.equal(again.id, id, "a reload did not come back to the note being written");
  assert.equal(again.text, text);
  // and a change made to it elsewhere while it was put away is what shows
  const elsewhere = words("changed from somewhere else");
  await post(`/quicknote/save?id=${id}`, elsewhere);
  await again.open();
  assert.equal(again.text, elsewhere);
  await again.remove();
});

test("New starts a blank note, the earlier one stays, and the list is newest first", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  s.input(words("the earlier note"));
  await s.flush();
  const earlier = s.id;
  await s.startNew();
  assert.equal(s.id, null);
  assert.equal(s.text, "");
  assert.equal(realm.ctx.localStorage.getItem("quicknote.current"), null);
  s.input(words("the newer note"));
  await s.flush();
  const newer = s.id;
  assert.notEqual(newer, earlier);
  await s.load();
  assert.deepEqual(Array.from(s.notes, n => n.id).slice(0, 2), [newer, earlier]);
  await s.openNote(earlier);
  assert.equal(s.id, earlier);
  assert.equal(s.text, "the earlier note");
  await s.remove();
  await s.openNote(newer);
  await s.remove();
});

test("a note emptied and put away is removed rather than kept blank", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  s.input(words("about to be emptied"));
  await s.flush();
  const id = s.id;
  s.input("");
  await s.close();
  assert.equal(await noteOnBoard(id), undefined, "an emptied note was kept");
  assert.equal(s.id, null);
});

test("words that could not be saved are kept on screen and go with the next save", async () => {
  const realm = logicRealm();
  const s = await newSession(realm);
  await s.open();
  realm.line.down = true;
  const text = words("typed while the board was away");
  s.input(text);
  await s.flush();
  assert.equal(s.status, "failed");
  await s.open();
  assert.equal(s.text, text, "an opening while away threw the typed words out");
  realm.line.down = false;
  await s.open();
  assert.equal(s.status, "saved");
  assert.equal((await noteOnBoard(s.id)).text, text);
  await s.remove();
});

// ---- the page's own wiring, lifted out of index.html -----------------------------

// a small DOM: elements with classes, children, attributes and listeners, events
// that bubble to the document and then the window and can be stopped on the way
function smallDom(){
  const doc = { listeners: {}, activeElement: null };
  const win = { listeners: {} };
  const fire = (target, type, props = {}) => {
    const ev = { type, target, defaultPrevented: false, stopped: false,
                 preventDefault(){ this.defaultPrevented = true; },
                 stopPropagation(){ this.stopped = true; }, ...props };
    for (let node = target; node && !ev.stopped; node = node.parentNode)
      for (const fn of (node.listeners && node.listeners[type]) || []) fn.call(node, ev);
    for (const holder of [doc, win]){
      if (ev.stopped) break;
      for (const fn of holder.listeners[type] || []) fn(ev);
    }
    return ev;
  };
  class Node {
    constructor(tag){
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.listeners = {}; this.attributes = {};
      this.dataset = {}; this.style = {}; this.hidden = false; this.value = ""; this.own = "";
      this.classes = new Set(); this.rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    }
    get className(){ return [...this.classes].join(" "); }
    set className(v){ this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get classList(){
      const set = this.classes;
      return { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
               contains: c => set.has(c),
               toggle: (c, force) => { const on = force === undefined ? !set.has(c) : !!force;
                                       if (on) set.add(c); else set.delete(c); return on; } };
    }
    get textContent(){ return this.own + this.children.map(c => c.textContent).join(""); }
    set textContent(v){ for (const c of this.children) c.parentNode = null; this.children = []; this.own = v == null ? "" : String(v); }
    appendChild(child){
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child);
      child.parentNode = this; this.children.push(child); return child;
    }
    append(...nodes){ for (const n of nodes) this.appendChild(n); }
    insertBefore(child, ref){
      this.appendChild(child);
      this.children.pop();
      const at = this.children.indexOf(ref);
      if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
      return child;
    }
    contains(node){ for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
    get isConnected(){ let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
    setAttribute(k, v){ this.attributes[k] = String(v); }
    getAttribute(k){ return k in this.attributes ? this.attributes[k] : null; }
    addEventListener(type, fn){ (this.listeners[type] = this.listeners[type] || []).push(fn); }
    getBoundingClientRect(){ return this.rect; }
    setSelectionRange(a, b){ this.selectionStart = a; this.selectionEnd = b; }
    focus(){ if (doc.activeElement === this) return; doc.activeElement = this; fire(this, "focusin"); }
    blur(){ if (doc.activeElement === this) doc.activeElement = doc.body; }
  }
  doc.createElement = tag => new Node(tag);
  doc.body = new Node("body");
  doc.activeElement = doc.body;
  doc.documentElement = { clientWidth: 1440, clientHeight: 900 };
  doc.addEventListener = (type, fn) => (doc.listeners[type] = doc.listeners[type] || []).push(fn);
  doc.getElementById = () => null;
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  return { doc, win, fire, Node };
}
function between(source, start, end){
  const from = source.indexOf(start);
  assert.ok(from >= 0, "index.html no longer holds: " + start);
  const to = source.indexOf(end, from);
  assert.ok(to > from, "index.html no longer holds: " + end);
  return source.slice(from, to);
}
// the page as far as the quick note reaches: card-logic.js, the few names of
// the board's own the block reads, boardKeysLive as the page writes it, and
// the quick note block itself, word for word
async function quickNotePage(){
  const dom = smallDom();
  const realm = logicRealm({
    document: dom.doc,
    addEventListener: (type, fn) => (dom.win.listeners[type] = dom.win.listeners[type] || []).push(fn),
  });
  const keysLive = HTML.match(/^function boardKeysLive\(\)\{.*\}$/m);
  assert.ok(keysLive, "boardKeysLive is gone from index.html");
  const block = between(HTML, "// ---- the quick note ----", "\nrenameMagicLayouts();");
  vm.runInContext([
    "let lastState = null, qnOpen = false, editMode = false, pageWarn = null, pageMenu = null, p3Zoom = null;",
    "function onBoardPage(){ return true; }",
    keysLive[0],
    block,
    "globalThis.page = { quickNote, qnPeek, syncQuickNoteChip, boardKeysLive,",
    "  get qnOpen(){ return qnOpen; }, set editMode(v){ editMode = v; }, set lastState(v){ lastState = v; } };",
  ].join("\n"), realm.ctx, { filename: "index.html#quick-note" });
  realm.ctx.page.lastState = await board();
  return { dom, page: realm.ctx.page };
}
const move = (dom, x, y, more = {}) => dom.fire(dom.doc.body, "pointermove",
  { pointerType: "mouse", buttons: 0, clientX: x, clientY: y, ...more });
const veilOf = page => page.quickNote.root;
const textareaOf = page => veilOf(page).children[0].children.find(n => n.tagName === "TEXTAREA");

test("the page's corner: the bottom right corner wakes the peek, and nothing else does", async () => {
  const { dom, page } = await quickNotePage();
  const out = () => page.qnPeek.classList.contains("out");
  assert.equal(out(), false, "the peek was out before the pointer went anywhere");
  assert.equal(page.qnPeek.parentNode, dom.doc.body);
  move(dom, 1439, 899, { pointerType: "touch" });
  assert.equal(out(), false, "a touch woke the peek");
  move(dom, 1439, 899, { buttons: 1 });
  assert.equal(out(), false, "a drag into the corner woke the peek");
  page.editMode = true;
  move(dom, 1439, 899);
  assert.equal(out(), false, "the corner woke while the layout was being edited");
  page.editMode = false;
  move(dom, 1400, 899);
  assert.equal(out(), false, "a point outside the corner woke the peek");
  move(dom, 1439, 899);
  assert.equal(out(), true, "the corner did not wake the peek");
  await wait(50);
  // leaving the peek lets it go after a short grace
  move(dom, 700, 400);
  assert.equal(out(), true, "the peek went at once instead of after its grace");
  await wait(550);
  assert.equal(out(), false, "the peek stayed out after the pointer left it");
});

test("the page's overlay: a press on the peek opens the note, types, attaches and closes on Escape", async () => {
  const { dom, page } = await quickNotePage();
  move(dom, 1439, 899);
  await wait(50);
  dom.fire(page.qnPeek, "click");
  const veil = veilOf(page), ta = textareaOf(page);
  assert.ok(veil.classList.contains("open"), "the overlay did not open");
  assert.equal(page.qnOpen, true);
  assert.equal(page.boardKeysLive(), false, "the board's keys stayed live under the overlay");
  assert.equal(page.qnPeek.classList.contains("out"), false, "the peek stayed out over the open note");
  await page.quickNote.session.flush();
  await wait(20);
  assert.equal(dom.doc.activeElement, ta, "the note's field does not hold the keys");
  // typing goes to the board through the shared session, and names a card
  ta.value = words("the page's own note, card " + figure(cardA));
  dom.fire(ta, "input");
  await wait(900);
  await page.quickNote.session.flush();
  const id = page.quickNote.session.id;
  assert.ok(id, "typing in the page's overlay made no note");
  assert.equal((await noteOnBoard(id)).card, cardA);
  const attachLine = veil.children[0].children.find(n => n.classList.contains("qn-attach"));
  assert.equal(attachLine.hidden, false, "the overlay does not show the card the note is on");
  assert.match(attachLine.textContent, new RegExp("on card " + figure(cardA)));
  const notice = veil.children[0].children.find(n => n.classList.contains("qn-foot")).children[0];
  assert.equal(notice.textContent, "attached to card " + figure(cardA));
  // Escape puts it away and goes no further than the note
  let reachedBoard = false;
  dom.win.listeners.keydown = [() => { reachedBoard = true; }];
  const esc = dom.fire(ta, "keydown", { key: "Escape" });
  assert.equal(esc.defaultPrevented, true);
  assert.equal(reachedBoard, false, "a key typed in the note reached the board");
  assert.equal(veil.classList.contains("open"), false, "Escape did not close the note");
  assert.equal(page.qnOpen, false);
  assert.equal(page.boardKeysLive(), true, "the board's keys stayed off after the note closed");
  await page.quickNote.session.flush();
  // opening again comes back to the same note
  await page.quickNote.open();
  assert.equal(page.quickNote.session.id, id);
  assert.equal(ta.value, "the page's own note, card " + figure(cardA));
  page.quickNote.close();
  await page.quickNote.session.flush();
  await post(`/quicknote/del?id=${id}`);
});

test("the page's overlay: a click on the veil closes it, a drag out of the card does not", async () => {
  const { dom, page } = await quickNotePage();
  await page.quickNote.open();
  const veil = veilOf(page), ta = textareaOf(page);
  dom.fire(ta, "pointerdown");
  dom.fire(veil, "click");
  assert.ok(veil.classList.contains("open"), "a selection dragged out of the card closed the note");
  dom.fire(veil, "pointerdown");
  dom.fire(veil, "click");
  assert.equal(veil.classList.contains("open"), false, "a click outside the card did not close the note");
  // and focus sent to the board while it is open comes back to the note
  await page.quickNote.open();
  const elsewhere = dom.doc.createElement("textarea");
  dom.doc.body.appendChild(elsewhere);
  elsewhere.focus();
  assert.equal(dom.doc.activeElement, ta, "focus wandered onto the board behind the note");
  page.quickNote.close();
  await page.quickNote.session.flush();
});

test("the page's chip: a card with a note says so left of its section chips and opens that note", async () => {
  const { dom, page } = await quickNotePage();
  const made = (await post(`/quicknote/new?card=${cardB}`, words("the chip's own note"))).body.note;
  const topbar = dom.doc.createElement("div");
  const [hist, sun, arc, x] = ["div", "button", "button", "button"].map(t => dom.doc.createElement(t));
  topbar.append(hist, sun, arc, x);
  const el = { topbar, sun };
  page.syncQuickNoteChip(el, []);
  assert.equal(el.qnchip, undefined, "a card with no note was given a chip");
  page.syncQuickNoteChip(el, [made]);
  const chip = el.qnchip;
  assert.equal(chip.textContent, "note");
  assert.equal(chip.hidden, false);
  assert.deepEqual(topbar.children.map(n => n === chip ? "chip" : n === sun ? "sun" : n === arc ? "moon" : n === x ? "cross" : "history"),
    ["history", "chip", "sun", "moon", "cross"], "the chip is not just left of the section chips");
  page.syncQuickNoteChip(el, [made, { id: "qn9999", card: cardB }]);
  assert.equal(chip.textContent, "2 notes");
  assert.equal(chip.dataset.note, made.id, "the chip does not open the newest note");
  page.syncQuickNoteChip(el, [made]);
  dom.fire(chip, "click");
  await page.quickNote.session.flush();
  await wait(20);
  assert.ok(veilOf(page).classList.contains("open"), "the chip did not open the overlay");
  assert.equal(page.quickNote.session.id, made.id, "the chip opened some other note");
  assert.equal(textareaOf(page).value, "the chip's own note");
  page.quickNote.close();
  await page.quickNote.session.flush();
  page.syncQuickNoteChip(el, []);
  assert.equal(chip.hidden, true, "the chip stayed on a card whose note went");
  await post(`/quicknote/del?id=${made.id}`);
});

test("the page's overlay: Earlier lists the notes, a row opens one, New starts blank, Delete asks first", async () => {
  const { dom, page } = await quickNotePage();
  await page.quickNote.open();
  const card = veilOf(page).children[0];
  const [, , earlierBtn, newBtn] = card.children[0].children;
  const ta = textareaOf(page), list = card.children.find(n => n.classList.contains("qn-list"));
  const del = card.children.find(n => n.classList.contains("qn-foot")).children[1];
  ta.value = words("the list's older note");
  dom.fire(ta, "input");
  await page.quickNote.session.flush();
  const older = page.quickNote.session.id;
  dom.fire(newBtn, "click");
  await page.quickNote.session.flush();
  await wait(20);
  assert.equal(ta.value, "", "New did not start a blank note");
  assert.equal(page.quickNote.session.id, null);
  ta.value = words("the list's newer note");
  dom.fire(ta, "input");
  await page.quickNote.session.flush();
  const newer = page.quickNote.session.id;
  dom.fire(earlierBtn, "click");
  await page.quickNote.session.flush();
  await wait(50);
  assert.equal(list.hidden, false, "Earlier did not show the list");
  assert.equal(ta.hidden, true);
  assert.equal(earlierBtn.textContent, "Back");
  const rows = list.children.filter(n => n.classList.contains("qn-row"));
  assert.deepEqual(rows.slice(0, 2).map(r => r.dataset.id), [newer, older], "the list is not newest first");
  assert.equal(rows[0].children[0].textContent, "the list's newer note");
  dom.fire(rows[1], "click");
  await page.quickNote.session.flush();
  await wait(20);
  assert.equal(list.hidden, true);
  assert.equal(ta.value, "the list's older note", "a row did not open its note");
  assert.equal(page.quickNote.session.id, older);
  // the first press only asks; the second deletes
  dom.fire(del, "click");
  assert.equal(del.textContent, "Delete this note?");
  assert.ok(await noteOnBoard(older), "one press deleted the note");
  dom.fire(del, "click");
  await page.quickNote.session.flush();
  await wait(20);
  assert.equal(await noteOnBoard(older), undefined, "the second press did not delete the note");
  assert.equal(ta.value, "");
  assert.equal(del.textContent, "Delete");
  page.quickNote.close();
  await page.quickNote.session.flush();
  await post(`/quicknote/del?id=${newer}`);
});

test("the page's sheets: the peek covers nothing at rest, the note sits under the caret, the phone size is drawn", () => {
  const peek = between(HTML, "  .qnpeek{", "}");
  assert.match(peek, /visibility:hidden/);
  assert.match(peek, /transform:translate\(100%, 100%\)/, "the peek is not wholly past the corner at rest");
  assert.match(peek, /z-index:85/);
  const veil = between(TOKENS, ".qn-veil{", "}");
  assert.match(veil, /position:fixed; inset:0; z-index:90/);
  assert.match(between(HTML, "  #fatcaret, #fatcaretlift{", "}"), /z-index:99/, "the block caret no longer stands over the note");
  assert.match(TOKENS, /\.qn-veil\.open\{display:grid; place-items:center/);
  const phone = between(TOKENS, "@media (max-width:600px){\n  .qn-veil.open", "\n}\n");
  assert.match(phone, /place-items:start center/);
  assert.match(phone, /width:calc\(100vw - 20px\)/);
  // the board reads the notes off each reading and hands them to the chip
  assert.match(HTML, /const noteCards = quickNotesByCard\(state\.quicknotes\);/);
  assert.match(HTML, /syncQuickNoteChip\(el, noteCards\[b\.id\] \|\| \[\]\);/);
  assert.match(HTML, /function boardKeysLive\(\)\{ return !pageWarn && !pageMenu && !qnOpen && onBoardPage\(\); \}/);
});

// ---- last: what the log and the transcript were told ------------------------------

test("no note's words ever reached the log or the transcript", async () => {
  await stopServer();
  const files = [];
  for (const name of await readdir(logs)) files.push(path.join(logs, name));
  const transcript = path.join(fixtureDir, "transcript.jsonl");
  if (fs.existsSync(transcript)) files.push(transcript);
  const lines = [];
  for (const file of files){
    const text = await readFile(file, "utf8");
    for (const typed of WORDS){
      const probe = typed.trim().split("\n")[0].slice(0, 24);
      if (probe.length < 8) continue;
      assert.ok(!text.includes(probe), `${path.basename(file)} holds a note's words: ${probe}`);
    }
    if (path.basename(file).startsWith("server-"))
      for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
  }
  const events = lines.filter(l => String(l.kind).startsWith("quicknote"));
  for (const kind of ["quicknote+", "quicknote@", "quicknote-"])
    assert.ok(events.some(e => e.kind === kind), `no ${kind} line was written`);
  for (const event of events){
    assert.match(event.note, /^qn\d+$/, "a note line does not name its note");
    assert.ok(!("text" in event), "a note line carried a text field");
    if (event.kind === "quicknote+") assert.equal(typeof event.length, "number");
  }
  await startServer();   // left running for after(), which stops it
});
