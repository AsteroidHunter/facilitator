// The draft store in card-logic.js: what a card's row holds and has not sent,
// kept in this browser's localStorage with the files that finished uploading
// for it. Loaded in a sandbox with DOM stubs and a real localStorage map, so
// the store and the tray paths that write it run under node without a browser.
const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const APP = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(APP, name), "utf8");
const noop = () => {};
const el = tag => {
  const node = { tagName: String(tag || "div").toUpperCase(), style: {}, className: "", children: [],
    textContent: "", dataset: {}, parentNode: null, attributes: {} };
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
  node.append = (...kids) => { for (const child of kids) node.appendChild(child); };
  node.appendChild = child => { child.parentNode = node; node.children.push(child); return child; };
  node.insertBefore = (child, before) => {
    child.parentNode = node;
    const index = node.children.indexOf(before);
    if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
    return child;
  };
  node.remove = noop;
  node.setAttribute = (name, value) => { node.attributes[name] = String(value); };
  node.addEventListener = noop;
  node.querySelector = () => el("circle");
  node.querySelectorAll = () => [];
  return node;
};

const store = new Map();
const sandbox = {
  document: { createElement: el, createElementNS: (ns, tag) => el(tag), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop, body: el() },
  setInterval: noop, setTimeout: noop, clearInterval: noop, clearTimeout: noop,
  requestAnimationFrame: noop, console, navigator: {}, location: {},
  crypto: { randomUUID: () => "op-" + Math.random().toString(16).slice(2) },
  Image: function Image(){ return el("img"); },
  localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("card-logic.js"), sandbox);
// the tray's own motion and the sent bubble's stills are not what is tested here
for (const name of ["trayLeave", "sentStillFor", "trayPump"]) sandbox[name] = noop;
const S = sandbox;

const PIC = { url: "/uploads/ab12/pic.png", name: "pic.png", kind: "image", ext: "PNG", total: 2048 };
const DOC = { url: "/uploads/cd34/notes.pdf", name: "notes.pdf", kind: "document", ext: "PDF", total: 9000 };

// a card as both pages build it, as far as the store reads one
function card(id, value = ""){
  const c = { ta: { value, selectionStart: 0, selectionEnd: 0,
    setSelectionRange(start, end){ this.selectionStart = start; this.selectionEnd = end; } },
    tray: el("div"), trayItems: [], trayHold: null, ticks: 0 };
  c.tick = () => { c.ticks++; };
  S.els[id] = c;
  return c;
}
const kept = () => JSON.parse(store.get("composedrafts") || "{}");
// the sandbox has arrays of its own, so its values are compared as plain data
const plain = value => JSON.parse(JSON.stringify(value));

// the sent panel's own passes, which a check may stub for itself
const REAL = { sentHeldOut: S.sentHeldOut, syncSent: S.syncSent };
beforeEach(() => {
  store.clear();
  S.els = {};
  S.macPhoneInactive = false;
  Object.assign(S, REAL);
});

test("typing is saved under its card, markdown and all, and nothing else", () => {
  const c = card("12");
  card("13");
  c.ta.value = "**bold** and *italic*\n- a list";
  S.draftSave("12");
  assert.deepEqual(kept(), { 12: { text: "**bold** and *italic*\n- a list", files: [] } });
  assert.deepEqual(plain(S.draftOf("12")), { text: "**bold** and *italic*\n- a list", files: [] });
  assert.equal(S.draftOf("13"), null);
});

test("a kept draft comes back on its own card with the caret at its end", () => {
  S.draftPut("7", "half a thought", [PIC]);
  const c = card("7"), other = card("8");
  S.draftRestore(c, "7");
  S.draftRestore(other, "8");
  assert.equal(c.ta.value, "half a thought");
  assert.equal(c.ta.selectionStart, "half a thought".length);
  assert.equal(c.ta.selectionEnd, "half a thought".length);
  assert.equal(c.trayItems.length, 1);
  const it = c.trayItems[0];
  assert.equal(it.state, "done");
  assert.equal(it.url, PIC.url);
  assert.equal(it.file, null, "no file bytes come back, only the board's address");
  assert.ok(c.tray.classList.contains("on"));
  assert.equal(S.traySendable(c), true);
  assert.ok(c.ticks > 0);
  assert.equal(other.ta.value, "");
  assert.equal(other.trayItems.length, 0);
});

test("words already in the row win over the kept text, and a file is never doubled", () => {
  S.draftPut("7", "older words", [PIC]);
  const c = card("7", "shelf words");
  S.draftRestore(c, "7");
  S.draftRestore(c, "7");
  assert.equal(c.ta.value, "shelf words");
  assert.equal(c.trayItems.length, 1);
});

test("a send clears the draft", () => {
  card("3", "going now");
  S.draftSave("3");
  assert.ok(kept()["3"]);
  S.draftClear("3");
  assert.equal(kept()["3"], undefined);
  assert.equal(store.has("composedrafts"), false, "an empty store leaves nothing behind");
});

test("both pages clear the draft at the send, as the row is emptied", () => {
  for (const page of ["index.html", "m.html"]){
    const source = read(page);
    const send = source.slice(source.indexOf("function doSend(id, opts){"));
    const body = send.slice(0, send.indexOf("\n}\n"));
    const emptied = body.indexOf('el.ta.value = "";'), cleared = body.indexOf("draftClear(id);");
    assert.ok(emptied > 0 && cleared > emptied, page + " clears the draft after emptying the row");
    assert.match(source, /addEventListener\("input", \(\) => \{[^}]*draftSave\(b\.id\);/, page + " saves as it is typed");
    assert.match(source, /draftRestore\(\w+, b\.id\);/, page + " restores when a card is built");
    assert.match(source, /draftKeep\(onBoard\);/, page + " drops the drafts of gone cards");
  }
});

test("emptying the row clears the draft; whitespace alone is empty", () => {
  const c = card("4", "something");
  S.draftSave("4");
  c.ta.value = "  \n ";
  S.draftSave("4");
  assert.equal(kept()["4"], undefined);
});

test("an emptied row keeps a draft that still holds an uploaded file", () => {
  const c = card("4", "words");
  c.trayItems.push({ state: "done", url: PIC.url, name: PIC.name, kind: "image", ext: "PNG", total: 2048 });
  S.draftSave("4");
  c.ta.value = "";
  S.draftSave("4");
  assert.deepEqual(kept()["4"], { text: "", files: [PIC] });
});

test("only files that finished uploading are kept", () => {
  const c = card("5", "with files");
  c.trayItems.push(
    { state: "done", url: PIC.url, name: PIC.name, kind: "image", ext: "PNG", total: 2048 },
    { state: "up", name: "big.mov", kind: "video", ext: "MOV", total: 1e8 },
    { state: "queued", name: "next.png", kind: "image", ext: "PNG", total: 10 },
    { state: "failed", name: "lost.png", kind: "image", ext: "PNG", total: 10 },
    { state: "refused", name: "huge.zip", kind: "document", ext: "ZIP", total: 10 });
  S.draftSave("5");
  assert.deepEqual(kept()["5"].files, [PIC]);
});

test("a file is kept the moment its upload lands, and let go when it is taken out", () => {
  const c = card("6", "caption");
  const it = { key: "k", name: DOC.name, kind: "document", ext: "PDF", total: DOC.total, sent: 0,
    tries: 1, measured: false, urls: [], state: "up" };
  c.trayItems.push(it);
  S.traySquare(c, it);
  S.draftSave("6");
  assert.deepEqual(kept()["6"].files, [], "still uploading: not kept");
  S.trayLanded(c, it, 200, { url: DOC.url });
  assert.deepEqual(kept()["6"].files, [DOC]);
  S.trayRemove(c, it);
  assert.deepEqual(kept()["6"], { text: "caption", files: [] });
});

test("words a failed send gives back are kept", () => {
  const c = card("9", "");
  c.sentHeld = [{ text: "came back" }];
  S.syncSent = noop;
  S.sentBack(c, c.sentHeld[0]);
  assert.equal(kept()["9"].text, "came back");
});

test("a Mac send the board has not confirmed stays kept until it has", () => {
  // the Mac board's sends are held in the page alone (sentLaunch): one on its
  // way or one that did not get through would be lost to a reload
  S.syncSent = noop;
  const c = card("21", "first words");
  c.sentItems = [];
  S.draftSave("21");
  c.ta.value = "";
  S.draftClear("21");                                  // doSend, at the press
  const going = S.sentLaunch(c, "first words", "/send?box=21");
  assert.deepEqual(kept()["21"], { text: "first words", files: [] }, "kept while on its way");
  S.sentLanded(c, going);
  assert.equal(kept()["21"], undefined, "the board has it: nothing is kept");

  const lost = S.sentLaunch(c, "did not get through", "/send?box=21");
  S.sentFailed(c, lost, false);
  assert.deepEqual(kept()["21"], { text: "did not get through", files: [] }, "kept under its fail mark");
  c.ta.value = "and more";
  S.draftSave("21");
  assert.equal(kept()["21"].text, "did not get through\n\nand more", "the held words first, then the row's");
  S.sentHeldLanded(c, lost);
  assert.deepEqual(kept()["21"], { text: "and more", files: [] }, "it landed after all: only the row is kept");

  const again = S.sentLaunch(c, "retried", "/send?box=21");
  S.sentFailed(c, again, false);
  S.sentBack(c, again);
  assert.equal(c.ta.value, "and more\n\nretried");
  assert.deepEqual(kept()["21"], { text: "and more\n\nretried", files: [] }, "given back: kept once, in the row");
});

test("the phone's sends are its operations' and never the draft's", () => {
  // the phone keeps an unsent message in its own store and sends it again
  // after a reload; its sent list holds only what the board has confirmed
  const c = card("22", "");
  c.sentItems = [{ text: "on the board", stage: "sent" }];
  S.draftSave("22");
  assert.equal(kept()["22"], undefined);
});

test("a card that is gone from the board loses its draft", () => {
  card("1", "stays"); card("2", "goes");
  S.draftSave("1"); S.draftSave("2");
  S.draftKeep(new Set(["1", "99"]));
  assert.deepEqual(Object.keys(kept()), ["1"]);
});

test("the view that is not on screen writes nothing", () => {
  card("1", "on the Mac");
  S.draftSave("1");
  S.macPhoneInactive = true;
  S.els["1"].ta.value = "";
  S.draftSave("1");
  assert.equal(kept()["1"].text, "on the Mac");
});

test("a file this page never held stays kept while the words change", () => {
  // the Mac board's files are not handed to its phone view: typing there keeps them
  S.draftPut("1", "from the Mac", [PIC]);
  const c = card("1", "from the Mac, then the phone");
  S.draftSave("1");
  assert.deepEqual(kept()["1"], { text: "from the Mac, then the phone", files: [PIC] });
  // one this page did hold and has let go is gone
  c.trayHeld = new Set([PIC.url]);
  S.draftSave("1");
  assert.deepEqual(kept()["1"].files, []);
});

test("a store the other view emptied stays empty", () => {
  // the Mac board and its phone view share the store: a draft one of them
  // cleared must not come back from the other's memory of it
  card("5", "sent from the other view");
  card("6", "");
  S.draftSave("5");
  store.delete("composedrafts");
  S.els["6"].ta.value = "new words";
  S.draftSave("6");
  assert.deepEqual(Object.keys(kept()), ["6"]);
});

test("a stored entry that does not add up is not trusted", () => {
  store.set("composedrafts", JSON.stringify({ 1: { text: 5 }, 2: { text: "ok", files: [{ url: "https://elsewhere/x.png", name: "x" }, PIC] } }));
  assert.equal(S.draftOf("1"), null);
  assert.deepEqual(plain(S.draftOf("2").files), [PIC]);
  store.set("composedrafts", "not json");
  assert.equal(S.draftOf("2"), null);
});
