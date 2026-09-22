// Deterministic, browser-free regression for the file navigator's async races.
// It extracts the ACTUAL mdBump / mdList / mdActivate / mdOpenFile /
// mdOpenImage / mdOpenInfo / mdInfoInto bytes from index.html and drives them
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

const REAL = ["mdBump", "mdList", "mdActivate", "mdOpenFile", "mdOpenImage",
  "mdOpenInfo", "mdInfoInto"].map(grab).join("\n");

const flush = () => new Promise(r => setImmediate(r));

function build() {
  const preamble = `
    let mdGen = 0, mdData = null, mdSig = "", mdOpen = null, mdShown = null,
        mdClean = "", mdFor = null, mdKind = "internal", activeOwner = null;
    let __browse = { dir: "", selected: "", scroll: 0 };
    const __els = [], __fetches = [], __notes = [], __info = [], __go = [], __mount = [];
    const MD_KINDS = ["internal", "wiki"];
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
    const host = makeEl("div", "mdpanel");
    host._md = { name: makeEl("span", "mdname"), view: makeEl("div", "mdview"),
                 edit: makeEl("div", "mdedit"), list: makeEl("div", "mdlist"),
                 note: makeEl("div", "mdnote"), tabs: [] };
    function mdHost(){ return host; }
    function mdBrowseState(){ return __browse; }
    function mdRememberList(){}
    function mdNote(hh, t, b){ __notes.push({ t, bad: !!b }); }
    function mdDirty(){}
    function mdSelect(){}
    function mdTearDown(){ mdOpen = null; mdShown = null; mdClean = ""; }
    function mdMount(hh, text, crlf, seat, plain){ __mount.push({ text, plain: !!plain }); }
    function mdDrawList(){}
    function mdGo(dir){ __go.push(dir); }
    function mdBundle(){ return Promise.resolve(true); }
    function mdIsImage(ext){ return ["png","jpg","jpeg","gif","webp","svg"].includes(String(ext||"").toLowerCase()); }
    function mdIsMarkdown(rel){ return /\\.(md|markdown)$/i.test(String(rel)); }
    function mdBaseName(rel){ return String(rel).split("/").pop(); }
    function mdParentDir(rel){ const i = String(rel).lastIndexOf("/"); return i < 0 ? "" : rel.slice(0, i); }
    function mdReasonWord(r){ return r || "unavailable"; }
    function mdSizeText(n){ return n + "B"; }
    function mdWhenText(){ return "when"; }
    function fetch(url){ let res; const p = new Promise(r => res = r); __fetches.push({ url, resolve: res }); return p; }
  `;
  const tail = `
    ctl.set = (o) => { for (const k of Object.keys(o)) {
      if (k === "mdGen") mdGen = o.mdGen; else if (k === "mdData") mdData = o.mdData;
      else if (k === "mdSig") mdSig = o.mdSig; else if (k === "mdOpen") mdOpen = o.mdOpen;
      else if (k === "mdShown") mdShown = o.mdShown; else if (k === "mdClean") mdClean = o.mdClean;
      else if (k === "mdFor") mdFor = o.mdFor; else if (k === "mdKind") mdKind = o.mdKind;
      else if (k === "activeOwner") activeOwner = o.activeOwner; } };
    ctl.setDir = (d) => { __browse.dir = d; };
    ctl.bump = () => mdBump();
    ctl.gen = () => mdGen;
    ctl.callList = () => mdList();
    ctl.callActivate = (entry, ctx) => mdActivate(entry, ctx);
    ctl.callOpenFile = (root, rel, meta, gen) => mdOpenFile(root, rel, meta, gen);
    ctl.callOpenImage = (root, rel, meta, gen) => mdOpenImage(root, rel, meta, gen);
    ctl.fetches = () => __fetches;
    ctl.resolveFetch = (i, status, ok, body) => __fetches[i].resolve(
      body === null ? null : { status, ok, json: () => Promise.resolve(body) });
    ctl.els = () => __els;
    ctl.imgEl = () => __els.find(e => e.className === "mdimg");
    // the real mdInfoInto renders a card; the fallback sentence lands in an
    // element of class mdunopenwhy, so its presence is proof the fallback ran
    ctl.info = () => __els.filter(e => e.className === "mdunopenwhy").map(e => ({ reason: e._text }));
    ctl.state = () => ({ mdGen, mdData, mdOpen, mdShown });
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
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 1 });
  m.callList();                       // Internal, gen 1, fetch[0]
  m.set({ mdKind: "wiki" }); m.bump(); // tab switch to Wiki, gen 2
  m.callList();                       // Wiki, gen 2, fetch[1]
  assert.equal(m.fetches().length, 2);
  m.resolveFetch(1, 200, true, listing("wiki", "w", "", [{ name: "home.md", type: "file", avail: true }]));
  await flush();
  m.resolveFetch(0, 200, true, listing("internal", "i", "", [{ name: "README.md", type: "file", avail: true }]));
  await flush();
  assert.equal(m.state().mdData.kind, "wiki", "the late Internal result must not overwrite Wiki");
  assert.equal(m.state().mdData.root, "w");
});

test("an old folder listing that lands after navigation is dropped", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 1 });
  m.setDir("A"); m.callList();        // folder A, gen 1, fetch[0]
  m.setDir("B"); m.bump(); m.callList(); // navigate to B, gen 2, fetch[1]
  m.resolveFetch(1, 200, true, listing("internal", "i", "B", [{ name: "inB.md", type: "file", avail: true }]));
  await flush();
  m.resolveFetch(0, 200, true, listing("internal", "i", "A", [{ name: "inA.md", type: "file", avail: true }]));
  await flush();
  assert.equal(m.state().mdData.dir, "B", "the late folder-A result must not overwrite folder B");
});

test("clicking a stale row while a newer listing is pending does nothing", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 5 });
  const staleCtx = { lane: "lane1", root: "i", kind: "internal", dir: "guides", gen: 5 };
  m.bump();   // a navigation happened; the rendered rows are now stale (gen 6)
  m.callActivate({ type: "file", name: "intro.md", ext: "md", avail: true }, staleCtx);
  await flush();
  assert.equal(m.fetches().length, 0, "a stale row must not start an open");
  assert.equal(m.state().mdOpen, null);
});

test("a current row opens under its own captured context", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 3 });
  const ctx = { lane: "lane1", root: "i", kind: "internal", dir: "guides", gen: 3 };
  m.callActivate({ type: "file", name: "intro.md", ext: "md", avail: true }, ctx);
  await flush();
  assert.equal(m.fetches().length, 1);
  assert.ok(m.fetches()[0].url.includes("rel=guides%2Fintro.md"), "opens the row's own path");
  m.resolveFetch(0, 200, true, { text: "hi", mtime: "1", crlf: false });
  await flush();
  assert.equal(m.state().mdOpen.rel, "guides/intro.md");
});

test("a delayed earlier text open does not replace a newer open", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 1 });
  m.bump();                                   // gen 2 for open A
  m.callOpenFile("i", "a.md", {}, 2);
  await flush();                              // A past bundle, fetch[0] registered
  m.bump();                                   // gen 3 for open B
  m.callOpenFile("i", "b.md", {}, 3);
  await flush();                              // B past bundle, fetch[1] registered
  m.resolveFetch(0, 200, true, { text: "AAA", mtime: "1", crlf: false });
  await flush();
  assert.equal(m.state().mdOpen, null, "the older open A must not set the editor");
  m.resolveFetch(1, 200, true, { text: "BBB", mtime: "2", crlf: false });
  await flush();
  assert.equal(m.state().mdOpen.rel, "b.md", "only the newer open B lands");
});

test("a stale image error does not paint over newer content", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 1 });
  m.bump();                                   // gen 2 for image A
  m.callOpenImage("i", "pic.png", { size: 10, mtime: "1" }, 2);
  assert.equal(m.state().mdShown.rel, "pic.png");
  const img = m.imgEl();
  assert.ok(img, "an <img> was created");
  // the reader moves on: a newer view replaces the image
  m.bump();                                   // gen 3
  m.set({ mdShown: { lane: "lane1", root: "i", rel: "other.md", type: "info" } });
  img.onerror();                              // A's load fails late
  assert.equal(m.info().length, 0, "a stale image error must not overwrite the newer view");
  assert.equal(m.state().mdShown.rel, "other.md");
});

test("a current image error shows the fallback for that image", async () => {
  const m = build();
  m.set({ activeOwner: "lane1", mdFor: "lane1", mdKind: "internal", mdGen: 1 });
  m.bump();
  m.callOpenImage("i", "pic.png", { size: 10, mtime: "1" }, 2);
  const img = m.imgEl();
  img.onerror();                             // still current
  assert.equal(m.info().length, 1);
  assert.match(m.info()[0].reason, /could not be shown/);
});
