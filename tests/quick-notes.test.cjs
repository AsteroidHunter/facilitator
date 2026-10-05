// quick notes against a real board, with no browser. a temporary copy of the
// server on free ports answers the note routes (made, listed, saved, attached,
// detached, deleted, and all still there after a restart); the session in
// card-logic.js saves as the owner types against it; and index.html's own
// quick note wiring (the corner, the overlay, the card chip and the board's
// keys) is lifted out of the page and driven through a small DOM. last, the
// log and the transcript are read back to prove no note's words reached either.
// every card and every note below is invented
const assert = require("node:assert/strict");
const { after, before, describe, test } = require("node:test");
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

// Hidden for v0: no page shows the quick note and the server answers 404 on its routes. The suite
// is kept whole, and skipped as a suite so its fixtures never start.
describe("the quick note", { skip: "feature hidden for v0" }, () => {
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
  // a note a test made is taken away again through the route, since the note
  // itself no longer carries a way to delete one
  async function drop(id){
    if (id) assert.equal((await post(`/quicknote/del?id=${id}`)).status, 200);
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
    await drop(s.id);
  });

  test("typing c, card or card and a space with a figure attaches the note", async () => {
    const realm = logicRealm();
    const s = await newSession(realm);
    await s.open();
    s.input(words("check the rope c" + figure(cardA)));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, cardA);
    assert.equal(s.card, cardA);
    // a figure no card carries moves nothing
    s.input(words("check the rope card99999"));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, cardA);
    assert.equal(s.status, "saved", "a figure no card carries was taken for a failure");
    // naming the other card moves it there
    s.input(words("check the roof card " + figure(cardB)));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, cardB);
    // and deleting the reference that attached it lets it go
    s.input(words("check the roof"));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, null);
    // a figure inside a word is never a reference
    s.input(words("check the roofc" + figure(cardA) + " and abc" + figure(cardB)));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, null, "a figure inside a word attached the note");
    await drop(s.id);
  });

  test("a note attached some other way stays on its card until its words name one", async () => {
    const realm = logicRealm();
    const s = await newSession(realm);
    await s.open();
    s.input(words("roof tiles"));
    await s.flush();
    // the way an agent would attach it later, through the route
    await post(`/quicknote/attach?id=${s.id}&card=${cardB}`);
    await s.open();
    assert.equal(s.card, cardB);
    s.input(words("roof tiles, and the gutter"));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, cardB, "words that never named a card let the note go");
    s.input(words("roof tiles, and the gutter, c" + figure(cardA)));
    await s.flush();
    assert.equal((await noteOnBoard(s.id)).card, cardA);
    await drop(s.id);
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
    await drop(again.id);
  });

  test("stepping: newer than the newest is a blank note, older walks back, and both ends hold", async () => {
    const realm = logicRealm();
    const s = await newSession(realm);
    await s.open();
    s.input(words("the step's older note"));
    await s.flush();
    const older = s.id;
    // newer than the newest note is a blank one, which is how a new note starts
    await s.step(-1);
    assert.equal(s.id, null);
    assert.equal(s.text, "");
    assert.equal(realm.ctx.localStorage.getItem("quicknote.current"), null);
    assert.ok(await noteOnBoard(older), "starting a new note took the earlier one away");
    // and there is nothing newer than a blank note
    await s.step(-1);
    assert.equal(s.id, null);
    s.input(words("the step's newer note"));
    await s.flush();
    const newer = s.id;
    assert.notEqual(newer, older);
    assert.deepEqual(Array.from(s.notes, n => n.id).slice(0, 1), [older], "the list was not read fresh");
    await s.step(1);
    assert.equal(s.id, older, "one older than the newest is not the note before it");
    assert.equal(s.text, "the step's older note");
    await s.step(-1);
    assert.equal(s.id, newer);
    // past the oldest nothing moves
    let last = null;
    for (let i = 0; i < 40 && last !== s.id; i++){ last = s.id; await s.step(1); }
    assert.equal(s.id, last, "stepping past the oldest note moved");
    assert.equal(last, Array.from(s.notes, n => n.id).at(-1), "the walk did not end on the oldest note");
    // a note emptied and stepped away from goes, like one emptied and put away
    await s.openNote(newer);
    s.input("");
    await s.step(1);
    assert.equal(await noteOnBoard(newer), undefined, "an emptied note was kept when stepped away from");
    // and words that cannot be saved hold the note where it is
    await s.openNote(older);
    realm.line.down = true;
    s.input(words("the step's older note, and more"));
    await s.step(-1);
    assert.equal(s.id, older, "a step walked away from words that were not saved");
    assert.equal(s.text, "the step's older note, and more");
    assert.equal(s.status, "failed");
    realm.line.down = false;
    await s.flush();
    assert.equal((await noteOnBoard(older)).text, "the step's older note, and more");
    await drop(older);
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
    await drop(s.id);
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
      // a glide that has already landed: what it was asked for is kept to read
      animate(frames, timing){ this.glides = (this.glides || []).concat([{ frames, timing }]); return { finished: Promise.resolve() }; }
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
      "let lastState = null, qnOpen = false, setOpen = false, editMode = false, pageWarn = null, pageMenu = null, p3Zoom = null, homeOpen = false;",
      "let caretPlaced = 0, queueFatCaret = () => { caretPlaced++; };",
      "function onBoardPage(){ return true; }",
      keysLive[0],
      block,
      "globalThis.page = { quickNote, qnPeek, syncQuickNoteChip, boardKeysLive,",
      "  get qnOpen(){ return qnOpen; }, get caretPlaced(){ return caretPlaced; },",
      "  set editMode(v){ editMode = v; }, set lastState(v){ lastState = v; } };",
    ].join("\n"), realm.ctx, { filename: "index.html#quick-note" });
    realm.ctx.page.lastState = await board();
    return { dom, page: realm.ctx.page, line: realm.line };
  }
  const move = (dom, x, y, more = {}) => dom.fire(dom.doc.body, "pointermove",
    { pointerType: "mouse", buttons: 0, clientX: x, clientY: y, ...more });
  const veilOf = page => page.quickNote.root;
  const cardOf = page => veilOf(page).children[0];
  const textareaOf = page => cardOf(page).children.find(n => n.tagName === "TEXTAREA");
  const chord = (dom, target, key) => dom.fire(target, "keydown",
    { key, ctrlKey: true, shiftKey: true, metaKey: false, altKey: false, repeat: false,
      isComposing: false, defaultPrevented: false });
  // every node under one, the one included
  const everyNode = node => [node, ...node.children.flatMap(everyNode)];

  test("the page's corner: the bottom right corner wakes the peek, and nothing else does", async () => {
    const { dom, page } = await quickNotePage();
    const out = () => page.qnPeek.classList.contains("out");
    assert.equal(out(), false, "the peek was out before the pointer went anywhere");
    assert.equal(page.qnPeek.parentNode, dom.doc.body);
    // a piece of the note's card and nothing more: its glass, no words, nothing in it
    assert.ok(page.qnPeek.classList.contains("qn-glass"), "the peek does not wear the note's glass");
    assert.deepEqual(page.qnPeek.children, [], "the peek holds something");
    assert.equal(page.qnPeek.textContent, "", "the peek carries words");
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

  test("the page's overlay: a press on the peek opens the note, types, attaches silently and closes on Escape", async () => {
    const { dom, page } = await quickNotePage();
    const card = cardOf(page), ta = textareaOf(page), veil = veilOf(page);
    // the card is the text area and nothing else: no title, no buttons, no
    // status, no hint, no words of its own
    assert.deepEqual(veil.children, [card]);
    assert.deepEqual(card.children, [ta], "the note holds more than its text area");
    assert.ok(card.classList.contains("qn-glass"), "the note does not wear the glass");
    assert.equal(card.textContent, "", "the note carries words of its own");
    assert.ok(!ta.placeholder, "the note shows a hint");
    assert.ok(!everyNode(veil).some(n => n.tagName === "BUTTON"), "the note carries a button");
    move(dom, 1439, 899);
    await wait(50);
    // the peek and the card stand where a browser would put them, so the glide
    // from the one to the other can be measured
    page.qnPeek.rect = { left: 1376, top: 852, width: 160, height: 120 };
    card.rect = { left: 480, top: 270, width: 480, height: 360 };
    dom.fire(page.qnPeek, "click");
    assert.ok(veil.classList.contains("open"), "the overlay did not open");
    assert.equal(page.qnOpen, true);
    assert.equal(page.boardKeysLive(), false, "the board's keys stayed live under the overlay");
    assert.equal(page.qnPeek.classList.contains("out"), false, "the peek stayed out over the open note");
    assert.equal((card.glides || []).length, 1, "the note did not glide in from the peek");
    // from the peek's centre (1456, 912) to the card's (720, 450), at a third of its size
    assert.match(card.glides[0].frames[0].transform, /^translate\(736px, 462px\) scale\(0\.333/);
    await page.quickNote.session.flush();
    await wait(20);
    assert.ok(page.caretPlaced >= 1, "the board's caret was not placed again once the note came to rest");
    assert.equal(dom.doc.activeElement, ta, "the note's field does not hold the keys");
    // typing goes to the board through the shared session, and names a card
    ta.value = words("the page's own note, card " + figure(cardA));
    dom.fire(ta, "input");
    await wait(900);
    await page.quickNote.session.flush();
    const id = page.quickNote.session.id;
    assert.ok(id, "typing in the page's overlay made no note");
    assert.equal((await noteOnBoard(id)).card, cardA);
    // and says nothing about it: the card is still only its text area
    assert.deepEqual(card.children, [ta], "attaching put something on the note");
    assert.equal(card.textContent, "");
    assert.equal(card.classList.contains("failed"), false);
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

  test("the page's overlay: control shift down starts a new note and up walks back, with nothing on screen", async () => {
    const { dom, page } = await quickNotePage();
    await page.quickNote.open();
    const ta = textareaOf(page), card = cardOf(page);
    let reachedBoard = false;
    dom.win.listeners.keydown = [() => { reachedBoard = true; }];
    ta.value = words("the chord's older note");
    dom.fire(ta, "input");
    await page.quickNote.session.flush();
    const older = page.quickNote.session.id;
    // down from the newest note: a blank one, which is how a new note starts
    const down = chord(dom, ta, "ArrowDown");
    assert.equal(down.defaultPrevented, true, "the chord was left to the text area");
    assert.equal(reachedBoard, false, "the chord reached the board's own reply history");
    await page.quickNote.session.flush();
    await wait(20);
    assert.equal(ta.value, "", "control shift down did not start a blank note");
    assert.equal(page.quickNote.session.id, null);
    assert.ok(await noteOnBoard(older), "starting a new note took the earlier one away");
    ta.value = words("the chord's newer note");
    dom.fire(ta, "input");
    await page.quickNote.session.flush();
    const newer = page.quickNote.session.id;
    assert.notEqual(newer, older);
    // up: the next older note, and down again: back to the newer one
    chord(dom, ta, "ArrowUp");
    await page.quickNote.session.flush();
    await wait(20);
    assert.equal(ta.value, "the chord's older note", "control shift up did not walk to the older note");
    assert.equal(page.quickNote.session.id, older);
    chord(dom, ta, "ArrowDown");
    await page.quickNote.session.flush();
    await wait(20);
    assert.equal(ta.value, "the chord's newer note");
    // the walk showed nothing: the card is its text area throughout
    assert.deepEqual(card.children, [ta]);
    assert.equal(card.textContent, "");
    // a plain arrow is the caret's, not a step
    const plain = dom.fire(ta, "keydown", { key: "ArrowUp", ctrlKey: false, shiftKey: false, metaKey: false, altKey: false });
    assert.equal(plain.defaultPrevented, false, "a plain arrow was taken from the caret");
    page.quickNote.close();
    await page.quickNote.session.flush();
    await drop(older);
    await drop(newer);
  });

  test("the page's overlay: words that could not be saved turn the rim red, on the note and the peek, until they are", async () => {
    const { dom, page, line } = await quickNotePage();
    await page.quickNote.open();
    const ta = textareaOf(page), card = cardOf(page);
    assert.equal(card.classList.contains("failed"), false);
    line.down = true;
    ta.value = words("typed while the page's board was away");
    dom.fire(ta, "input");
    await page.quickNote.session.flush();
    assert.equal(card.classList.contains("failed"), true, "the note shows nothing when its words are not saved");
    assert.equal(page.qnPeek.classList.contains("failed"), true, "the peek does not carry the warning");
    // the warning is the rim and never words
    assert.deepEqual(card.children, [ta]);
    assert.equal(card.textContent, "");
    // put away unsaved, the peek still says so
    page.quickNote.close();
    await page.quickNote.session.flush();
    assert.equal(page.qnPeek.classList.contains("failed"), true, "the peek let go of unsaved words");
    line.down = false;
    await page.quickNote.open();
    await page.quickNote.session.flush();
    assert.equal(ta.value, "typed while the page's board was away", "the unsaved words were lost");
    assert.equal(card.classList.contains("failed"), false, "the rim stayed red once the words were saved");
    assert.equal(page.qnPeek.classList.contains("failed"), false);
    const id = page.quickNote.session.id;
    assert.equal((await noteOnBoard(id)).text, "typed while the page's board was away");
    page.quickNote.close();
    await page.quickNote.session.flush();
    await drop(id);
  });

  test("the page's sheets: a four by three card of plain text, and the peek a small piece of it", () => {
    // the peek: the card's own shape at a third of its size, hidden past the corner at rest
    const peek = between(HTML, "  .qnpeek{", "}");
    assert.match(peek, /width:160px; height:120px/, "the peek is not a piece of the four by three card");
    assert.match(peek, /visibility:hidden/);
    assert.match(peek, /transform:translate\(100%, 100%\)/, "the peek is not wholly past the corner at rest");
    assert.match(peek, /z-index:85/);
    assert.match(between(HTML, "  .qnpeek.out{", "}"), /transform:translate\(40%, 40%\)/);
    // the card: four by three, 480 by 360 where there is room, the same shape where there is not
    const card = between(TOKENS, ".qn-card{", "}");
    assert.match(card, /aspect-ratio:4 \/ 3/);
    assert.match(card, /width:min\(480px, calc\(100vw - 32px\), calc\(\(100vh - 32px\) \* 4 \/ 3\)\)/);
    // the field wears nothing of its own, so the words sit on the glass
    const field = between(TOKENS, ".qn-text{", "}");
    for (const rule of ["border:none", "outline:none", "background:transparent", "min-height:0", "max-height:none", "resize:none"])
      assert.ok(field.includes(rule), "the note's field still wears a text box's " + rule.split(":")[0]);
    // and nothing of the old chrome is left anywhere: no title, buttons, status,
    // attach line, list, footer or hint
    for (const gone of ["qn-head", "qn-name", "qn-btn", "qn-status", "qn-attach", "qn-detach", "qn-list",
                        "qn-row", "qn-foot", "qn-notice", "qn-del", "qn-empty", "qnpeek-name", "qnpeek-line"])
      assert.ok(!TOKENS.includes(gone) && !LOGIC.includes(gone) && !HTML.includes(gone), gone + " is still drawn");
    const overlay = between(LOGIC, "function quickNoteOverlay(", "\n}\n");
    assert.ok(!/placeholder|textContent|"Earlier"|"New"|"Delete"/.test(overlay), "the note still writes words of its own");
    // the veil under the board's block caret, and the phone's card near the top
    assert.match(between(TOKENS, ".qn-veil{", "}"), /position:fixed; inset:0; z-index:90/);
    assert.match(between(HTML, "  #fatcaret, #fatcaretlift{", "}"), /z-index:99/, "the block caret no longer stands over the note");
    assert.match(TOKENS, /\.qn-veil\.open\{display:grid; place-items:center/);
    assert.match(between(TOKENS, "@media (max-width:600px){\n  .qn-veil.open", "\n}\n"), /place-items:start center/);
    // the board reads the notes off each reading and hands them to the chip
    assert.match(HTML, /const noteCards = quickNotesByCard\(state\.quicknotes\);/);
    assert.match(HTML, /syncQuickNoteChip\(el, noteCards\[b\.id\] \|\| \[\]\);/);
    assert.match(HTML, /function boardKeysLive\(\)\{ return !pageWarn && !pageMenu && !qnOpen && !setOpen && !homeOpen && onBoardPage\(\); \}/);
  });

  // the note's sheet read the way a browser reads it: comments out, one space,
  // and a declaration ending at its semicolon or at the brace when it is last
  const cleanCss = css => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
  const cssValue = (block, name) => {
    const m = new RegExp("(?:^|[;{ ])" + name + ":([^;}]+)[;}]").exec(block);
    assert.ok(m, "no " + name + " in the block");
    return m[1].trim();
  };
  const glassSheet = () => cleanCss(between(TOKENS, ".qn-glass{", ".qn-glass.failed"));
  // the tuning properties at the values the board ships them at. every white in
  // the lighting is the player's own value times --qn-edge, so it is read at an
  // edge of one, which is the player's own strength, to be set against the player
  const shipped = glass => {
    const vars = {};
    for (const name of glass.match(/--qn-[\w-]+(?=:)/g)) vars[name] = cssValue(glass, name);
    const resolve = text => text.replace(/var\((--qn-[\w-]+)\)/g, (_, name) => {
      assert.ok(name in vars, `missing glass token ${name}`);
      return resolve(vars[name]);
    });
    vars["--qn-edge"] = "1";
    return text => resolve(text).replace(/calc\(([\d.]+) \* 1\)/g, (_, n) => n);
  };

  test("the note's glass ships at the values the owner tuned in the mock", () => {
    const glass = glassSheet();
    assert.equal(cssValue(glass, "--qn-blur"), "15px");
    assert.equal(cssValue(glass, "--qn-sat"), "180%");
    assert.equal(cssValue(glass, "--qn-tint"), ".77");
    assert.equal(cssValue(glass, "--qn-edge"), "2");
    assert.equal(cssValue(cleanCss(between(TOKENS, ".qn-card{", "}")), "--qn-boost"), ".22");
    assert.equal(cssValue(cleanCss(between(TOKENS, ".qn-veil{", "}")), "--qn-veil"), "15%");
  });

  test("the note's glass: the spotify player's lighting, value for value, over a face that lets the board through", () => {
    const player = cleanCss(between(HTML, "  #magic1.filled{", "@keyframes spappear"));
    const glass = glassSheet();
    const resolve = shipped(glass);
    // the edge and the shadow: the player's nine lines, the ring read from --qn-ring
    assert.equal(resolve(cssValue(glass, "box-shadow")), cssValue(player, "box-shadow"),
      "the note's edge and shadow are not the player's");
    assert.equal(cssValue(glass, "--qn-ring"), "#c7c7cc");
    // the grain, the corner rim light and the sheen, in the player's order
    assert.equal(resolve(cssValue(glass, "background-image")), cssValue(player, "background-image"),
      "the note's surface layers are not the player's");
    assert.equal(cssValue(glass, "border-radius"), cssValue(player, "border-radius"));
    // the blur the player carried before its face went opaque, as its own note
    // records it and the board's chat glass still wears, as the owner tuned it
    assert.ok(HTML.includes("blur(16px) saturate(180%) brightness(.98)"), "the player's record of its blur is gone");
    assert.match(HTML, /--c3-glass:rgba\(120,120,128,\.03\)/);
    assert.equal(resolve(cssValue(glass, "backdrop-filter")), "blur(15px) saturate(180%)");
    assert.equal(resolve(cssValue(glass, "-webkit-backdrop-filter")), "blur(15px) saturate(180%)");
    // the face is glass and not a white card: a white tint that lets about a
    // fifth of what is behind come through
    const tint = Number(resolve(cssValue(glass, "background-color")).match(/^rgba\(255,255,255,([\d.]+)\)$/)[1]);
    assert.ok(tint <= .8, "the face is too white to be glass: " + tint);
    assert.ok(tint >= .5, "the face is too clear for words to sit on: " + tint);
    // the one warning: the rim, and nothing else
    assert.match(TOKENS, /\.qn-glass\.failed\{--qn-ring:var\(--must\)\}/);
  });

  test("the note's words stay dark on light over anything the board shows behind the glass", () => {
    const glass = glassSheet();
    const tint = Number(shipped(glass)(cssValue(glass, "background-color")).match(/,([\d.]+)\)$/)[1]);
    const card = cleanCss(between(TOKENS, ".qn-card{", "}"));
    const boost = Number(cssValue(card, "--qn-boost"));
    // the settings page is the same glass and takes the same boost, from the same rule
    const behindText = cleanCss(between(TOKENS, ".qn-card::before, .sp-page::before{", "}"));
    assert.equal(cssValue(behindText, "background"), "rgba(255,255,255,var(--qn-boost))");
    assert.match(cssValue(cleanCss(between(TOKENS, ".qn-text{", "}")), "position"), /relative/,
      "the field is not lifted over the text boost");
    const veilRule = cleanCss(between(TOKENS, ".qn-veil{", "}"));
    const veil = Number(cssValue(veilRule, "--qn-veil").replace("%", "")) / 100;
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const ink = hex(/--ink:(#[0-9A-Fa-f]{6})/.exec(TOKENS)[1]);
    const paper = hex(/--paper:(#[0-9A-Fa-f]{6})/.exec(TOKENS)[1]);
    const over = (top, a, under) => top.map((c, i) => a * c + (1 - a) * under[i]);
    const lum = rgb => rgb.map(c => { const s = c / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; })
                          .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
    // the middle of the card, where the words are, carries the face and the boost;
    // the rim carries the face alone
    const middle = 1 - (1 - tint) * (1 - boost);
    const white = [255, 255, 255], black = [0, 0, 0];
    const veiledBoard = over(ink, veil, paper);
    const everyday = contrast(over(white, middle, veiledBoard), ink);
    const overBlack = contrast(over(white, middle, black), ink);
    const rimOverBlack = contrast(over(white, tint, black), ink);
    assert.ok(everyday >= 13, "the words fall under 13 to 1 over the veiled board: " + everyday.toFixed(2));
    assert.ok(overBlack >= 7, "the words fall under 7 to 1 with black behind the note: " + overBlack.toFixed(2));
    assert.ok(rimOverBlack >= 4.5, "the rim falls under 4.5 to 1 with black behind it: " + rimOverBlack.toFixed(2));
  });

  test("the glass sees the board from its first frame, and turns solid when less transparency is asked for", () => {
    // the veil fades by its colour: an opacity fade would cut the card's blur off
    // from the board for as long as it ran
    const fade = between(TOKENS, "@keyframes qnveilin{", "}}");
    assert.ok(!/opacity/.test(fade), "the veil fades by opacity, which blinds the glass while it runs");
    assert.match(fade, /background-color:transparent/);
    // a reader who asks for less transparency gets a solid white card
    const reduced = cleanCss(between(TOKENS, "@media (prefers-reduced-transparency: reduce){", "\n}\n"));
    assert.match(reduced, /\.qn-glass\{background-color:#fff; backdrop-filter:none; -webkit-backdrop-filter:none\}/);
    assert.match(reduced, /\.qn-card::before, \.sp-page::before\{display:none\}/);
    // and a browser that cannot blur gets a nearly solid face
    const noBlur = cleanCss(between(TOKENS, "@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){", "\n}\n"));
    assert.match(noBlur, /\.qn-glass\{background-color:rgba\(255,255,255,\.94\)\}/);
    // the peek is the same glass: it wears the class, and nothing of its own
    // paints over the material
    const peek = between(HTML, "  .qnpeek{", "}");
    assert.ok(!/background|box-shadow|border:/.test(peek), "the peek paints over the glass it wears");
    assert.match(HTML, /h\("button", "qnpeek qn-glass"\)/);
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
});
