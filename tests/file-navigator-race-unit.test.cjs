// Deterministic, browser-free regression for the file navigator's async races.
// It extracts the ACTUAL fileNavBump / fileNavList / fileNavActivate / fileNavOpenFile /
// fileNavOpenImage / fileNavOpenInfo / fileNavInfoInto bytes from index.html and drives them
// with a hand-resolved fetch and a fake DOM, so the generation/context guard is
// proved against real production code: an old Internal listing landing after a
// Wiki switch, an old folder listing after navigation, a click on a stale row
// while a newer listing is pending, a delayed text open arriving after a newer
// open, and a stale image error firing after the view moved on. No browser.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// a named function's source by brace matching, so a nested block cannot cut it
function grab(name) {
  const re = new RegExp("(?:async\\s+)?function\\s+" + name + "\\s*\\(");
  const start = HTML.search(re);
  assert.ok(start >= 0, "function not found: " + name);
  let depth = 0, i = HTML.indexOf("{", start);
  for (; i < HTML.length; i++) {
    if (HTML[i] === "{") depth++;
    else if (HTML[i] === "}" && --depth === 0) return HTML.slice(start, i + 1);
  }
  throw new Error("unbalanced braces after " + name);
}

const REAL = ["fileNavBump", "fileNavList", "fileNavActivate", "fileNavOpenFile", "fileNavOpenImage",
  "fileNavOpenInfo", "fileNavInfoInto"].map(grab).join("\n");

const flush = () => new Promise(r => setImmediate(r));

function build() {
  const preamble = `
    let fileNavGen = 0, fileNavData = null, fileNavSig = "", fileNavOpen = null, fileNavShown = null,
        fileNavClean = "", fileNavFor = null, fileNavKind = "internal", activeOwner = null;
    let __browse = { dir: "", selected: "", scroll: 0 };
    const __els = [], __fetches = [], __notes = [], __info = [], __go = [], __mount = [];
    const FILENAV_KINDS = ["internal", "wiki"];
    function makeEl(tag, cls){
      const el = { tag, className: cls || "", _text: "", title: "", children: [], dataset: {},
        classList: { s: new Set(),
          add(...a){ a.forEach(x => this.s.add(x)); },
          remove(...a){ a.forEach(x => this.s.delete(x)); },
          toggle(c, on){ if (on === undefined) (this.s.has(c) ? this.s.delete(c) : this.s.add(c)); else (on ? this.s.add(c) : this.s.delete(c)); },
          contains(c){ return this.s.has(c); } },
        append(...ch){ this.children.push(...ch); },
        setAttribute(k, v){ this[k] = v; },
        set textContent(v){ this._text = v; this.children = []; },
        get textContent(){ return this._text; } };
      __els.push(el);
      return el;
    }
    function h(tag, cls, text){ const el = makeEl(tag, cls); if (text != null) el._text = text; return el; }
    const host = makeEl("div", "fnavpanel");
    host._filenav = { name: makeEl("span", "fnavname"), view: makeEl("div", "fnavview"),
                 edit: makeEl("div", "fnavedit"), list: makeEl("div", "fnavlist"),
                 note: makeEl("div", "fnavnote"), tabs: [] };
    function fileNavHost(){ return host; }
    function fileNavBrowseState(){ return __browse; }
    function fileNavRememberList(){}
    function fileNavNote(hh, t, b){ __notes.push({ t, bad: !!b }); }
    function fileNavDirty(){}
    function fileNavSelect(){}
    function fileNavTearDown(){ fileNavOpen = null; fileNavShown = null; fileNavClean = ""; }
    function fileNavMount(hh, text, crlf, seat, plain){ __mount.push({ text, plain: !!plain }); }
    function fileNavDrawList(){}
    function fileNavGo(dir){ __go.push(dir); }
    function fileNavBundle(){ return Promise.resolve(true); }
    function fileNavIsImage(ext){ return ["png","jpg","jpeg","gif","webp","svg"].includes(String(ext||"").toLowerCase()); }
    function fileNavIsMarkdown(rel){ return /\\.(md|markdown)$/i.test(String(rel)); }
    function fileNavBaseName(rel){ return String(rel).split("/").pop(); }
    function fileNavParentDir(rel){ const i = String(rel).lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); }
    function fileNavReasonWord(r){ return r || "unavailable"; }
    function fileNavSizeText(n){ return n + "B"; }
    function fileNavWhenText(){ return "when"; }
    function fetch(url){ let res; const p = new Promise(r => res = r); __fetches.push({ url, resolve: res }); return p; }
  `;
  const tail = `
    ctl.set = (o) => { for (const k of Object.keys(o)) {
      if (k === "fileNavGen") fileNavGen = o.fileNavGen; else if (k === "fileNavData") fileNavData = o.fileNavData;
      else if (k === "fileNavSig") fileNavSig = o.fileNavSig; else if (k === "fileNavOpen") fileNavOpen = o.fileNavOpen;
      else if (k === "fileNavShown") fileNavShown = o.fileNavShown; else if (k === "fileNavClean") fileNavClean = o.fileNavClean;
      else if (k === "fileNavFor") fileNavFor = o.fileNavFor; else if (k === "fileNavKind") fileNavKind = o.fileNavKind;
      else if (k === "activeOwner") activeOwner = o.activeOwner; } };
    ctl.setDir = (d) => { __browse.dir = d; };
    ctl.bump = () => fileNavBump();
    ctl.gen = () => fileNavGen;
    ctl.callList = () => fileNavList();
    ctl.callActivate = (entry, ctx) => fileNavActivate(entry, ctx);
    ctl.callOpenFile = (root, rel, meta, gen) => fileNavOpenFile(root, rel, meta, gen);
    ctl.callOpenImage = (root, rel, meta, gen) => fileNavOpenImage(root, rel, meta, gen);
    ctl.fetches = () => __fetches;
    ctl.resolveFetch = (i, status, ok, body) => __fetches[i].resolve(
      body === null ? null : { status, ok, json: () => Promise.resolve(body) });
    ctl.els = () => __els;
    ctl.imgEl = () => __els.find(e => e.className === "fnavimg");
    // the real fileNavInfoInto renders a card; the fallback sentence lands in an
    // element of class fnavunopenwhy, so its presence is proof the fallback ran
    ctl.info = () => __els.filter(e => e.className === "fnavunopenwhy").map(e => ({ reason: e._text }));
    // the list's own placeholder line (empty/old-server message), as rendered
    ctl.tempty = () => __els.filter(e => e.className === "tempty").map(e => e._text);
    ctl.state = () => ({ fileNavGen, fileNavData, fileNavOpen, fileNavShown });
  `;
  const factory = new Function("ctl", preamble + "\n" + REAL + "\n" + tail);
  const ctl = {};
  factory(ctl);
  return ctl;
}

function listing(kind, root, dir, entries) {
  return { roots: [{ root: "i", kind: "internal", exists: true },
                    { root: "w", kind: "wiki", exists: true }],
           kind, root, dir, exists: true, entries: entries || [] };
}

test("an old Internal listing that lands after a Wiki switch is dropped", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1 });
  m.callList();                       // Internal, gen 1, fetch[0]
  m.set({ fileNavKind: "wiki" }); m.bump(); // tab switch to Wiki, gen 2
  m.callList();                       // Wiki, gen 2, fetch[1]
  assert.equal(m.fetches().length, 2);
  m.resolveFetch(1, 200, true, listing("wiki", "w", "", [{ name: "home.md", type: "file", avail: true }]));
  await flush();
  m.resolveFetch(0, 200, true, listing("internal", "i", "", [{ name: "README.md", type: "file", avail: true }]));
  await flush();
  assert.equal(m.state().fileNavData.kind, "wiki", "the late Internal result must not overwrite Wiki");
  assert.equal(m.state().fileNavData.root, "w");
});

test("an old folder listing that lands after navigation is dropped", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1 });
  m.setDir("A"); m.callList();        // folder A, gen 1, fetch[0]
  m.setDir("B"); m.bump(); m.callList(); // navigate to B, gen 2, fetch[1]
  m.resolveFetch(1, 200, true, listing("internal", "i", "B", [{ name: "inB.md", type: "file", avail: true }]));
  await flush();
  m.resolveFetch(0, 200, true, listing("internal", "i", "A", [{ name: "inA.md", type: "file", avail: true }]));
  await flush();
  assert.equal(m.state().fileNavData.dir, "B", "the late folder-A result must not overwrite folder B");
});

test("clicking a stale row while a newer listing is pending does nothing", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 5 });
  const staleCtx = { lane: "lane1", root: "i", kind: "internal", dir: "guides", gen: 5 };
  m.bump();   // a navigation happened; the rendered rows are now stale (gen 6)
  m.callActivate({ type: "file", name: "intro.md", ext: "md", avail: true }, staleCtx);
  await flush();
  assert.equal(m.fetches().length, 0, "a stale row must not start an open");
  assert.equal(m.state().fileNavOpen, null);
});

test("a current row opens under its own captured context", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 3 });
  const ctx = { lane: "lane1", root: "i", kind: "internal", dir: "guides", gen: 3 };
  m.callActivate({ type: "file", name: "intro.md", ext: "md", avail: true }, ctx);
  await flush();
  assert.equal(m.fetches().length, 1);
  assert.ok(m.fetches()[0].url.includes("rel=guides%2Fintro.md"), "opens the row's own path");
  m.resolveFetch(0, 200, true, { text: "hi", mtime: "1", crlf: false });
  await flush();
  assert.equal(m.state().fileNavOpen.rel, "guides/intro.md");
});

test("a delayed earlier text open does not replace a newer open", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1 });
  m.bump();                                   // gen 2 for open A
  m.callOpenFile("i", "a.md", {}, 2);
  await flush();                              // A past bundle, fetch[0] registered
  m.bump();                                   // gen 3 for open B
  m.callOpenFile("i", "b.md", {}, 3);
  await flush();                              // B past bundle, fetch[1] registered
  m.resolveFetch(0, 200, true, { text: "AAA", mtime: "1", crlf: false });
  await flush();
  assert.equal(m.state().fileNavOpen, null, "the older open A must not set the editor");
  m.resolveFetch(1, 200, true, { text: "BBB", mtime: "2", crlf: false });
  await flush();
  assert.equal(m.state().fileNavOpen.rel, "b.md", "only the newer open B lands");
});

test("a stale image error does not paint over newer content", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1 });
  m.bump();                                   // gen 2 for image A
  m.callOpenImage("i", "pic.png", { size: 10, mtime: "1" }, 2);
  assert.equal(m.state().fileNavShown.rel, "pic.png");
  const img = m.imgEl();
  assert.ok(img, "an <img> was created");
  // the reader moves on: a newer view replaces the image
  m.bump();                                   // gen 3
  m.set({ fileNavShown: { lane: "lane1", root: "i", rel: "other.md", type: "info" } });
  img.onerror();                              // A's load fails late
  assert.equal(m.info().length, 0, "a stale image error must not overwrite the newer view");
  assert.equal(m.state().fileNavShown.rel, "other.md");
});

test("a current image error shows the fallback for that image", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1 });
  m.bump();
  m.callOpenImage("i", "pic.png", { size: 10, mtime: "1" }, 2);
  const img = m.imgEl();
  img.onerror();                             // still current
  assert.equal(m.info().length, 1);
  assert.match(m.info()[0].reason, /could not be shown/);
});

test("an old {roots:[...files]} response shows the restart message, not a blank panel", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", fileNavFor: "lane1", fileNavKind: "internal", fileNavGen: 1, fileNavData: null,
          fileNavOpen: { rel: "draft.md" } });   // pretend an editor holds unsaved work
  m.callList();
  // a running server still on the pre-navigator shape: valid JSON, roots+files,
  // but no top-level entries/kind/dir
  m.resolveFetch(0, 200, true, { roots: [{ root: "i", kind: "internal", exists: true,
    files: [{ rel: "README.md", name: "README.md", mtime: "1" }] }] });
  await flush();
  assert.equal(m.state().fileNavData, null, "an unreadable old shape must not become fileNavData");
  const msgs = m.tempty();
  assert.equal(msgs.length, 1, "the restart message is shown instead of a blank list");
  assert.match(msgs[0], /restart the board/);
  assert.deepEqual(m.state().fileNavOpen, { rel: "draft.md" }, "the open editor is left untouched");
});
