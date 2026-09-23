// Deterministic, browser-free regression for the save transaction when two
// lanes share one file navigator host. It extracts the ACTUAL fileNavSave bytes from
// index.html and drives them with a mock fetch whose two awaits (the response
// and its json) are resolved by hand, so a project switch can be slipped in at
// either boundary. It proves a late answer for lane B never writes lane C's
// mtime, clean baseline or receipt, never paints B's warning onto C, and holds
// even across a B to C to B roundtrip where the lane name comes back the same
// but the editor is a fresh incarnation. The request itself must still carry its
// own lane. Every lane name here is invented.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function fnSource(signature) {
  const start = HTML.indexOf(signature);
  assert.ok(start >= 0, "function not found: " + signature);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + signature);
}

const FILENAV_SAVE = fnSource("async function fileNavSave()");

// one invented editor incarnation: a fresh view and open-file object every time,
// exactly as fileNavTearDown/fileNavMount make them in the page
function editor(lane, rel, text, mtime) {
  return {
    view: { state: { sliceDoc: () => text } },
    open: { lane, root: lane + "-internal", rel, mtime },
    clean: text,
  };
}

function build() {
  const preamble = `
    let fileNavView = null, fileNavOpen = null, fileNavClean = "", fileNavSig = "";
    let host = { _filenav: {} };
    const notes = [];
    const fetchCalls = [];
    let dirtyCalls = 0;
    let __fetchD = null, __jsonD = null;
    function deferred(){ let r; const p = new Promise(x => r = x); return { p, r }; }
    function fileNavHost(){ return host; }
    function fileNavNote(h, text, bad){ notes.push({ host: h, text, bad: !!bad }); }
    function fileNavDirty(){ dirtyCalls++; return fileNavView && fileNavOpen && fileNavView.state.sliceDoc() !== fileNavClean; }
    function fetch(url, opts){ fetchCalls.push({ url, opts }); __fetchD = deferred(); return __fetchD.p; }
  `;
  const tail = `
    ctl.save = () => fileNavSave();
    ctl.setEditor = e => { fileNavView = e ? e.view : null; fileNavOpen = e ? e.open : null; fileNavClean = e ? e.clean : ""; };
    ctl.setHost = h => { host = h; };
    ctl.state = () => ({ fileNavOpen, fileNavClean, fileNavSig, notes: notes.slice(), fetchCalls: fetchCalls.slice(), dirtyCalls });
    // resolve the response await; ok/status drive which branch fileNavSave takes
    ctl.resolveFetch = (status, ok) => { __jsonD = deferred(); __fetchD.r({ status, ok, json: () => __jsonD.p }); };
    ctl.resolveFetchNull = () => __fetchD.r(null);
    ctl.resolveJson = value => { __jsonD.r(value); };
    ctl.resolveJsonNull = () => { __jsonD.r(null); };
  `;
  const factory = new Function("ctl", preamble + "\n" + FILENAV_SAVE + "\n" + tail);
  const ctl = {};
  factory(ctl);
  return ctl;
}

// let the awaited continuation inside fileNavSave run
const tick = () => new Promise(r => setImmediate(r));

const B = "meridian", C = "orchard";

test("happy path: the live editor's own save updates its mtime, baseline and receipt", async () => {
  const m = build();
  const b = editor(B, "notes.md", "hello", "1");
  m.setEditor(b);
  const done = m.save();
  await tick();
  m.resolveFetch(200, true);
  await tick();
  m.resolveJson({ ok: true, mtime: "2" });
  await done;
  const s = m.state();
  assert.equal(b.open.mtime, "2", "the saved file's stamp should advance");
  assert.equal(s.fileNavClean, "hello", "the clean baseline should become the saved text");
  assert.deepEqual(s.notes.at(-1), { host: s.notes.at(-1).host, text: "saved", bad: false });
  assert.match(s.fetchCalls[0].url, /lane=meridian/);
  assert.equal(s.fetchCalls[0].opts.body, "hello");
});

test("delayed fetch, same-host switch B->C: C's editor is left untouched", async () => {
  const m = build();
  m.setEditor(editor(B, "b.md", "text of B", "1"));
  const done = m.save();
  await tick();
  // the switch to C happens while the save is still in the air: same DOM host,
  // a fresh view and open-file object
  const c = editor(C, "c.md", "text of C", "9");
  m.setEditor(c);
  m.resolveFetch(200, true);
  await tick();
  m.resolveJson({ ok: true, mtime: "2" });
  await done;
  const s = m.state();
  assert.equal(c.open.mtime, "9", "C's mtime must not move on B's late answer");
  assert.equal(s.fileNavClean, "text of C", "C's clean baseline must not be overwritten");
  assert.equal(s.notes.length, 0, "no receipt or warning may be painted onto C");
  // the request still went to B's own lane and file
  assert.match(s.fetchCalls[0].url, /lane=meridian/);
  assert.match(s.fetchCalls[0].url, /rel=b\.md/);
  assert.equal(s.fetchCalls[0].opts.body, "text of B");
});

test("delayed json, switch after the response but before its body: C is untouched", async () => {
  const m = build();
  m.setEditor(editor(B, "b.md", "text of B", "1"));
  const done = m.save();
  await tick();
  m.resolveFetch(200, true);   // the response arrives while B is still live
  await tick();
  const c = editor(C, "c.md", "text of C", "9");
  m.setEditor(c);              // then the switch happens before json() resolves
  m.resolveJson({ ok: true, mtime: "2" });
  await done;
  const s = m.state();
  assert.equal(c.open.mtime, "9");
  assert.equal(s.fileNavClean, "text of C");
  assert.equal(s.notes.length, 0, "a late json body must not update or notify C");
});

test("B->C->B roundtrip: the returned-to B editor is a new incarnation and stays clean", async () => {
  const m = build();
  m.setEditor(editor(B, "b.md", "old B text", "1"));
  const done = m.save();
  await tick();
  m.setEditor(editor(C, "c.md", "C text", "5"));          // away to C
  const b2 = editor(B, "b.md", "new B text", "7");         // back to B, rebuilt fresh
  m.setEditor(b2);
  m.resolveFetch(200, true);
  await tick();
  m.resolveJson({ ok: true, mtime: "2" });
  await done;
  const s = m.state();
  // a lane-only guard would have accepted this, since the lane name is B again
  assert.equal(b2.open.mtime, "7", "the rebuilt B editor's mtime must not move");
  assert.equal(s.fileNavClean, "new B text", "the rebuilt B editor's baseline must not be overwritten");
  assert.equal(s.notes.length, 0, "no receipt may land on the rebuilt B editor");
});

test("a stale 409 cannot paint another project's warning", async () => {
  const m = build();
  m.setEditor(editor(B, "b.md", "text of B", "1"));
  const done = m.save();
  await tick();
  const c = editor(C, "c.md", "text of C", "9");
  m.setEditor(c);
  m.resolveFetch(409, false);   // the conflict is B's, arriving after the switch
  await tick();
  m.resolveJsonNull();
  await done;
  const s = m.state();
  assert.equal(s.notes.length, 0, "an old 409 must not warn on C");
  assert.equal(c.open.mtime, "9");
});

test("a live 409 still warns the editor that is actually open, without moving its baseline", async () => {
  const m = build();
  const b = editor(B, "b.md", "text of B", "1");
  m.setEditor(b);
  const done = m.save();
  await tick();
  m.resolveFetch(409, false);
  await tick();
  m.resolveJsonNull();
  await done;
  const s = m.state();
  assert.deepEqual(s.notes.at(-1), { host: s.notes.at(-1).host, text: "changed on disk, so this was not saved", bad: true });
  assert.equal(b.open.mtime, "1", "a refused save must not advance the stamp");
  assert.equal(s.fileNavClean, "text of B", "a refused save must not move the baseline");
});

test("a live error is reported on the open editor and leaves its state intact", async () => {
  const m = build();
  const b = editor(B, "b.md", "text of B", "1");
  m.setEditor(b);
  const done = m.save();
  await tick();
  m.resolveFetch(500, false);
  await tick();
  m.resolveJson({ ok: false, error: "disk full" });
  await done;
  const s = m.state();
  assert.deepEqual(s.notes.at(-1), { host: s.notes.at(-1).host, text: "disk full", bad: true });
  assert.equal(b.open.mtime, "1");
  assert.equal(s.fileNavClean, "text of B");
});
